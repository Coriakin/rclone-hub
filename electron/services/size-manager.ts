import { SIZE_DIR_TIMEOUT_SECONDS, SIZE_HEARTBEAT_SECONDS } from '../config';
import type { Entry, SizeDoneEvent, SizeEvent, SizeEventsResponse } from '../../shared/src/types';
import { RcloneClient, RcloneError } from './rclone-client';

type SizeSession = {
  id: string;
  root_path: string;
  created_at: number;
  last_polled_at: number;
  seq: number;
  scanned_dirs: number;
  files_count: number;
  bytes_total: number;
  cancel_requested: boolean;
  done: boolean;
  events: SizeEvent[];
  done_at?: number;
  task?: Promise<void>;
};

export class SizeManager {
  readonly sessions = new Map<string, SizeSession>();
  readonly progressHeartbeatSeconds = SIZE_HEARTBEAT_SECONDS;
  readonly perDirTimeoutSeconds = SIZE_DIR_TIMEOUT_SECONDS;
  unpolledTimeoutSeconds = 30;
  terminalRetentionSeconds = 300;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(readonly client: Pick<RcloneClient, 'listCancellable'>) {}

  start(): void {
    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => this.cleanup(), 2000);
    }
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    const tasks = [...this.sessions.values()].map((session) => {
      session.cancel_requested = true;
      return session.task;
    }).filter(Boolean) as Promise<void>[];
    await Promise.allSettled(tasks);
    this.sessions.clear();
  }

  async create(rootPath: string): Promise<string> {
    const id = crypto.randomUUID();
    const session: SizeSession = {
      id,
      root_path: rootPath,
      created_at: Date.now(),
      last_polled_at: Date.now(),
      seq: 0,
      scanned_dirs: 0,
      files_count: 0,
      bytes_total: 0,
      cancel_requested: false,
      done: false,
      events: [],
    };
    session.task = this.runSize(session);
    this.sessions.set(id, session);
    return id;
  }

  async poll(sizeId: string, afterSeq: number): Promise<SizeEventsResponse> {
    const session = this.sessions.get(sizeId);
    if (!session) {
      throw new Error('size session not found');
    }
    session.last_polled_at = Date.now();
    return {
      events: session.events.filter((event) => event.seq > afterSeq),
      done: session.done,
      next_seq: session.seq,
    };
  }

  async cancel(sizeId: string): Promise<boolean> {
    const session = this.sessions.get(sizeId);
    if (!session) {
      return false;
    }
    session.cancel_requested = true;
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (!session.done && now - session.last_polled_at > this.unpolledTimeoutSeconds * 1000) {
        session.cancel_requested = true;
      }
      if (session.done && session.done_at && now - session.done_at > this.terminalRetentionSeconds * 1000) {
        this.sessions.delete(id);
      }
    }
  }

  private emitProgress(session: SizeSession, currentDir: string): void {
    if (session.done) {
      return;
    }
    session.seq += 1;
    session.events.push({
      seq: session.seq,
      type: 'progress',
      current_dir: currentDir,
      scanned_dirs: session.scanned_dirs,
      files_count: session.files_count,
      bytes_total: session.bytes_total,
    });
  }

  private emitDone(session: SizeSession, status: SizeDoneEvent['status'], error?: string): void {
    if (session.done) {
      return;
    }
    session.done = true;
    session.done_at = Date.now();
    session.seq += 1;
    session.events.push({
      seq: session.seq,
      type: 'done',
      status,
      scanned_dirs: session.scanned_dirs,
      files_count: session.files_count,
      bytes_total: session.bytes_total,
      error,
    });
  }

  private async runSize(session: SizeSession): Promise<void> {
    const dirs: string[] = [session.root_path];
    while (dirs.length) {
      if (session.cancel_requested) {
        this.emitDone(session, 'cancelled');
        return;
      }

      const currentDir = dirs.shift()!;
      session.scanned_dirs += 1;
      this.emitProgress(session, currentDir);

      let items: Entry[];
      try {
        items = await this.runListWithHeartbeat(session, currentDir);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (session.cancel_requested || message.includes('Cancelled by user')) {
          this.emitDone(session, 'cancelled');
          return;
        }
        this.emitDone(session, 'failed', error instanceof RcloneError ? error.message : `size calculation failed: ${message}`);
        return;
      }

      for (const entry of items) {
        if (session.cancel_requested) {
          this.emitDone(session, 'cancelled');
          return;
        }
        if (entry.is_dir) {
          dirs.push(entry.path);
          continue;
        }
        session.files_count += 1;
        session.bytes_total += Math.max(entry.size, 0);
      }
    }
    this.emitDone(session, 'success');
  }

  private async runListWithHeartbeat(session: SizeSession, currentDir: string): Promise<Entry[]> {
    let interval: NodeJS.Timeout | undefined;
    const task = this.client.listCancellable(
      currentDir,
      false,
      () => session.cancel_requested,
      this.perDirTimeoutSeconds,
    );
    const heartbeat = new Promise<never>((_resolve, _reject) => {
      interval = setInterval(() => {
        if (!session.cancel_requested) {
          this.emitProgress(session, currentDir);
        }
      }, this.progressHeartbeatSeconds * 1000);
    });
    try {
      return await Promise.race([task, heartbeat]);
    } finally {
      if (interval) {
        clearInterval(interval);
      }
    }
  }
}
