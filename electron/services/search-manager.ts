import { SEARCH_DIR_TIMEOUT_SECONDS, SEARCH_HEARTBEAT_SECONDS } from '../config';
import type { Entry, SearchDoneEvent, SearchEvent, SearchEventsResponse } from '../../shared/src/types';
import { RcloneClient, RcloneError } from './rclone-client';

type SearchSession = {
  id: string;
  root_path: string;
  filename_query: string;
  min_size_bytes: number | null;
  search_mode: 'standard' | 'empty_dirs';
  created_at: number;
  last_polled_at: number;
  seq: number;
  scanned_dirs: number;
  matched_count: number;
  cancel_requested: boolean;
  done: boolean;
  events: SearchEvent[];
  done_at?: number;
  task?: Promise<void>;
};

export class SearchManager {
  readonly sessions = new Map<string, SearchSession>();
  readonly progressHeartbeatSeconds = SEARCH_HEARTBEAT_SECONDS;
  readonly perDirTimeoutSeconds = SEARCH_DIR_TIMEOUT_SECONDS;
  unpolledTimeoutSeconds = 30_000 / 1000;
  terminalRetentionSeconds = 300;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(readonly client: Pick<RcloneClient, 'listCancellable' | 'matchesPattern'>) {}

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

  async create(rootPath: string, filenameQuery: string, minSizeMb: number | null, searchMode: string = 'standard'): Promise<string> {
    const id = crypto.randomUUID();
    const session: SearchSession = {
      id,
      root_path: rootPath,
      filename_query: filenameQuery.trim() || '*',
      min_size_bytes: minSizeMb == null || searchMode === 'empty_dirs' ? null : Math.trunc(minSizeMb * 1024 * 1024),
      search_mode: searchMode === 'empty_dirs' ? 'empty_dirs' : 'standard',
      created_at: Date.now(),
      last_polled_at: Date.now(),
      seq: 0,
      scanned_dirs: 0,
      matched_count: 0,
      cancel_requested: false,
      done: false,
      events: [],
    };
    session.task = this.runSearch(session);
    this.sessions.set(id, session);
    return id;
  }

  async poll(searchId: string, afterSeq: number): Promise<SearchEventsResponse> {
    const session = this.sessions.get(searchId);
    if (!session) {
      throw new Error('search not found');
    }
    session.last_polled_at = Date.now();
    return {
      events: session.events.filter((event) => event.seq > afterSeq),
      done: session.done,
      next_seq: session.seq,
    };
  }

  async cancel(searchId: string): Promise<boolean> {
    const session = this.sessions.get(searchId);
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

  private emitProgress(session: SearchSession, currentDir: string): void {
    if (session.done) {
      return;
    }
    session.seq += 1;
    session.events.push({
      seq: session.seq,
      type: 'progress',
      current_dir: currentDir,
      scanned_dirs: session.scanned_dirs,
      matched_count: session.matched_count,
    });
  }

  private emitResult(session: SearchSession, entry: Entry): void {
    if (session.done) {
      return;
    }
    session.matched_count += 1;
    session.seq += 1;
    session.events.push({
      seq: session.seq,
      type: 'result',
      entry,
    });
  }

  private emitDone(session: SearchSession, status: SearchDoneEvent['status'], error?: string): void {
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
      matched_count: session.matched_count,
      error,
    });
  }

  private async runSearch(session: SearchSession): Promise<void> {
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
        this.emitDone(session, 'failed', error instanceof RcloneError ? error.message : `search failed: ${message}`);
        return;
      }

      for (const entry of items) {
        if (session.cancel_requested) {
          this.emitDone(session, 'cancelled');
          return;
        }
        if (entry.is_dir) {
          dirs.push(entry.path);
        }
        if (session.search_mode === 'empty_dirs') {
          continue;
        }
        if (!this.matches(session, entry)) {
          continue;
        }
        entry.parent_path = parentPath(entry.path);
        this.emitResult(session, entry);
      }

      if (session.search_mode === 'empty_dirs' && items.length === 0) {
        this.emitResult(session, {
          name: basename(currentDir),
          path: currentDir,
          parent_path: parentPath(currentDir),
          is_dir: true,
          size: 0,
          hashes: {},
        });
      }
    }
    this.emitDone(session, 'success');
  }

  private matches(session: SearchSession, entry: Entry): boolean {
    if (!this.client.matchesPattern(entry.name, session.filename_query)) {
      return false;
    }
    if (session.min_size_bytes == null) {
      return true;
    }
    if (entry.is_dir) {
      return true;
    }
    return entry.size >= session.min_size_bytes;
  }

  private async runListWithHeartbeat(session: SearchSession, currentDir: string): Promise<Entry[]> {
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

function parentPath(pathValue: string): string {
  if (!pathValue.includes(':')) {
    return '';
  }
  const [remote, rel] = pathValue.split(':', 2);
  const normalized = rel.replace(/^\/+|\/+$/g, '');
  if (!normalized) {
    return `${remote}:`;
  }
  const parts = normalized.split('/');
  return parts.length <= 1 ? `${remote}:` : `${remote}:${parts.slice(0, -1).join('/')}`;
}

function basename(pathValue: string): string {
  if (!pathValue.includes(':')) {
    const normalized = pathValue.replace(/^\/+|\/+$/g, '');
    return normalized ? normalized.split('/').pop() ?? pathValue : pathValue;
  }
  const [remote, rel] = pathValue.split(':', 2);
  const normalized = rel.replace(/^\/+|\/+$/g, '');
  return normalized ? normalized.split('/').pop() ?? normalized : `${remote}:`;
}
