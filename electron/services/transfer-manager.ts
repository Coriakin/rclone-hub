import fs from 'node:fs';
import path from 'node:path';
import type {
  DeleteRequest,
  FallbackMode,
  Job,
  JobItemResult,
  JobLog,
  JobOperation,
  Settings,
  TransferRequest,
} from '../../shared/src/types';
import { Database } from '../db/database';
import { RcloneClient } from './rclone-client';
import { verifyStrict } from './verify';

type QueueItem = { job_id: string };

export class TransferManager {
  readonly jobs = new Map<string, Job>();
  readonly queue: QueueItem[] = [];
  readonly cancelled = new Set<string>();
  stagingInUseBytes = 0;
  private workerRunning = false;

  constructor(
    readonly db: Database,
    readonly client: Pick<
      RcloneClient,
      | 'copy'
      | 'copyto'
      | 'deletePath'
      | 'fromLocalCopy'
      | 'fromLocalCopyto'
      | 'list'
      | 'pathBasename'
      | 'stat'
      | 'toLocalCopy'
      | 'toLocalCopyto'
    >,
  ) {
    for (const job of db.listJobs()) {
      this.jobs.set(job.id, job);
    }
  }

  start(): void {
    this.db.markRunningJobsInterrupted();
    this.jobs.clear();
    for (const job of this.db.listJobs()) {
      this.jobs.set(job.id, job);
    }
    if (!this.workerRunning) {
      this.workerRunning = true;
      void this.worker();
    }
  }

  submitTransfer(req: TransferRequest): Job {
    const job = this.newJob(req.operation, req.sources, req.destination_dir, req.fallback_mode);
    job.verify_mode = req.verify_mode;
    this.db.upsertJob(job);
    this.queue.push({ job_id: job.id });
    return job;
  }

  submitDelete(req: DeleteRequest): Job {
    const job = this.newJob('delete', req.sources, undefined);
    this.queue.push({ job_id: job.id });
    return job;
  }

  cancel(jobId: string): Job | null {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }
    this.cancelled.add(jobId);
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.completed_at = nowIso();
      this.db.upsertJob(job);
    }
    return job;
  }

  listJobs(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  getJob(jobId: string): Job | null {
    return this.jobs.get(jobId) ?? null;
  }

  private async worker(): Promise<void> {
    while (this.workerRunning) {
      const item = this.queue.shift();
      if (!item) {
        await sleep(50);
        continue;
      }
      const job = this.jobs.get(item.job_id);
      if (!job) {
        continue;
      }
      if (this.cancelled.has(job.id)) {
        job.status = 'cancelled';
        job.completed_at = nowIso();
        this.db.upsertJob(job);
        continue;
      }
      try {
        await this.runJob(job);
      } catch (error) {
        job.status = 'failed';
        job.completed_at = nowIso();
        this.log(job, 'error', `job crashed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
        this.db.upsertJob(job);
      }
    }
  }

  private async runJob(job: Job): Promise<void> {
    const settings = this.db.getSettings() ?? {
      staging_path: '/tmp/rclone-hub-staging',
      staging_cap_bytes: 20 * 1024 * 1024 * 1024,
      concurrency: 2,
      verify_mode: 'strict',
    };

    job.status = 'running';
    job.started_at = nowIso();
    this.db.upsertJob(job);

    if (job.operation === 'delete') {
      await this.runDelete(job);
      return;
    }
    await this.runTransfer(job, settings);
  }

  private async runDelete(job: Job): Promise<void> {
    let failures = false;
    for (const source of job.sources) {
      if (this.cancelled.has(job.id)) {
        job.status = 'cancelled';
        break;
      }
      const result = await this.client.deletePath(source);
      this.log(job, 'debug', this.formatResult('delete', source, result));
      if (result.returncode !== 0) {
        failures = true;
        job.results.push({
          source,
          status: 'failed',
          direct_attempted: false,
          fallback_used: false,
          verify_passed: false,
          error: result.stderr.trim() || 'delete failed',
        });
        this.log(job, 'error', `delete failed for ${source}: ${result.stderr.trim()}`);
      } else {
        job.results.push({
          source,
          status: 'success',
          direct_attempted: false,
          fallback_used: false,
          verify_passed: false,
        });
        this.log(job, 'info', `deleted ${source}`);
      }
    }
    if (job.status !== 'cancelled') {
      job.status = failures ? 'failed' : 'success';
    }
    job.completed_at = nowIso();
    this.db.upsertJob(job);
  }

  private async runTransfer(job: Job, settings: Settings): Promise<void> {
    const destinationDir = job.destination_dir ?? '';
    let anyFailures = false;

    for (const source of job.sources) {
      if (this.cancelled.has(job.id)) {
        job.status = 'cancelled';
        break;
      }

      const base = this.client.pathBasename(source);
      const destination = RcloneClient.joinRemote(destinationDir, base);
      const item: JobItemResult = {
        source,
        destination,
        status: 'running',
        direct_attempted: true,
        fallback_used: false,
        verify_passed: false,
      };
      this.log(job, 'info', `starting ${job.operation}: ${source} -> ${destination}`);

      const direct = await this.copyItem(job, source, destination);
      this.log(job, 'debug', this.formatResult('direct-copy', source, direct));
      if (this.cancelled.has(job.id) || direct.returncode === 130) {
        job.status = 'cancelled';
        this.log(job, 'info', `cancelled ${job.operation}: ${source}`);
        break;
      }
      if (direct.returncode !== 0) {
        this.log(job, 'warning', `direct copy failed for ${source}, trying fallback`);
        const [ok, error] = await this.fallbackCopy(job, source, destination, settings);
        item.fallback_used = true;
        if (this.cancelled.has(job.id)) {
          job.status = 'cancelled';
          this.log(job, 'info', `cancelled ${job.operation}: ${source}`);
          break;
        }
        if (!ok) {
          item.status = 'failed';
          item.error = error ?? 'fallback failed';
          job.results.push(item);
          anyFailures = true;
          continue;
        }
      }

      const verify = await verifyStrict(this.client, source, destination);
      if (!verify.passed) {
        item.status = 'failed';
        item.error = `verification failed: ${verify.reason}`;
        job.results.push(item);
        anyFailures = true;
        this.log(job, 'error', item.error);
        continue;
      }
      item.verify_passed = true;

      if (job.operation === 'move') {
        const deleteResult = await this.client.deletePath(source);
        this.log(job, 'debug', this.formatResult('post-verify-delete', source, deleteResult));
        if (deleteResult.returncode !== 0) {
          item.status = 'failed';
          item.error = `copy verified but source delete failed: ${deleteResult.stderr.trim()}`;
          job.results.push(item);
          anyFailures = true;
          this.log(job, 'error', item.error);
          continue;
        }
      }

      item.status = 'success';
      job.results.push(item);
      this.log(job, 'info', `completed ${job.operation}: ${source}`);
    }

    if (job.status !== 'cancelled') {
      job.status = anyFailures ? 'failed' : 'success';
    }
    job.completed_at = nowIso();
    this.db.upsertJob(job);
  }

  private progressCallback(job: Job, source: string, stage: string): (raw: string) => void {
    let lastLine = '';
    return (raw: string) => {
      const line = raw.trim().replace(/\s+/g, ' ');
      if (!line || line === lastLine) {
        return;
      }
      if (!line.includes('%') && !line.includes('Transferred:')) {
        return;
      }
      lastLine = line;
      this.log(job, 'info', `progress [${stage}] ${source} ${line}`);
    };
  }

  private async copyItem(job: Job, source: string, destination: string) {
    const entry = await this.client.stat(source);
    const progress = this.progressCallback(job, source, 'direct');
    const shouldCancel = () => this.cancelled.has(job.id);
    return entry.is_dir
      ? this.client.copy(source, destination, progress, shouldCancel)
      : this.client.copyto(source, destination, progress, shouldCancel);
  }

  private async fallbackCopy(job: Job, source: string, destination: string, settings: Settings): Promise<[boolean, string | null]> {
    fs.mkdirSync(settings.staging_path, { recursive: true });
    const estimate = await this.estimateSourceSize(source);
    while (this.stagingInUseBytes + estimate > settings.staging_cap_bytes) {
      this.log(job, 'debug', `staging cap wait: estimate=${estimate} in_use=${this.stagingInUseBytes} cap=${settings.staging_cap_bytes}`);
      await sleep(500);
    }

    this.stagingInUseBytes += estimate;
    const localPath = path.join(settings.staging_path, crypto.randomUUID().replace(/-/g, ''), this.client.pathBasename(source));
    try {
      const entry = await this.client.stat(source);
      const pullProgress = this.progressCallback(job, source, 'fallback-pull');
      const shouldCancel = () => this.cancelled.has(job.id);
      const pull = entry.is_dir
        ? await this.client.toLocalCopy(source, localPath, pullProgress, shouldCancel)
        : await this.client.toLocalCopyto(source, localPath, pullProgress, shouldCancel);
      this.log(job, 'debug', this.formatResult('fallback-pull', source, pull));
      if (pull.returncode !== 0) {
        return [false, this.cancelled.has(job.id) || pull.returncode === 130 ? 'cancelled' : `fallback download failed: ${pull.stderr.trim()}`];
      }

      const pushProgress = this.progressCallback(job, source, 'fallback-push');
      const push = entry.is_dir
        ? await this.client.fromLocalCopy(localPath, destination, pushProgress, shouldCancel)
        : await this.client.fromLocalCopyto(localPath, destination, pushProgress, shouldCancel);
      this.log(job, 'debug', this.formatResult('fallback-push', source, push));
      if (push.returncode !== 0) {
        return [false, this.cancelled.has(job.id) || push.returncode === 130 ? 'cancelled' : `fallback upload failed: ${push.stderr.trim()}`];
      }
      return [true, null];
    } finally {
      this.stagingInUseBytes = Math.max(0, this.stagingInUseBytes - estimate);
    }
  }

  private async estimateSourceSize(source: string): Promise<number> {
    try {
      const entries = await this.client.list(source, true);
      return entries.filter((entry) => !entry.is_dir).reduce((total, entry) => total + entry.size, 0);
    } catch {
      return 0;
    }
  }

  private formatResult(stage: string, source: string, result: { returncode: number; stderr: string; stdout: string; duration_ms: number; timed_out: boolean }): string {
    return `${stage} source=${source} rc=${result.returncode} timed_out=${result.timed_out} duration_ms=${result.duration_ms} stdout='${result.stdout.trim().slice(0, 300)}' stderr='${result.stderr.trim().slice(0, 500)}'`;
  }

  private newJob(operation: JobOperation, sources: string[], destinationDir?: string, fallback?: FallbackMode): Job {
    const job: Job = {
      id: crypto.randomUUID(),
      operation,
      status: 'queued',
      created_at: nowIso(),
      sources,
      destination_dir: destinationDir,
      fallback_mode: fallback,
      results: [],
      logs: [],
    };
    this.jobs.set(job.id, job);
    this.db.upsertJob(job);
    return job;
  }

  private log(job: Job, level: string, message: string): void {
    const log: JobLog = { ts: nowIso(), level, message };
    job.logs.push(log);
    this.db.upsertJob(job);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
