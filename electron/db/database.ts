import fs from 'node:fs';
import DatabaseDriver from 'better-sqlite3';
import { APP_DIR, DB_PATH, DEFAULT_STAGING_PATH } from '../config';
import type { Job, Settings } from '../../shared/src/types';

type DBLike = {
  exec: (sql: string) => void;
  pragma: (sql: string) => void;
  prepare: (sql: string) => {
    all: (...args: unknown[]) => unknown[];
    get: (...args: unknown[]) => unknown;
    run: (...args: unknown[]) => unknown;
  };
};

export class Database {
  private readonly db: DBLike;

  constructor(dbPath: string = DB_PATH, db?: DBLike) {
    fs.mkdirSync(APP_DIR, { recursive: true });
    this.db = db ?? new DatabaseDriver(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);

    if (!this.getSettings()) {
      this.setSettings({
        staging_path: DEFAULT_STAGING_PATH,
        staging_cap_bytes: 20 * 1024 * 1024 * 1024,
        concurrency: 2,
        verify_mode: 'strict',
      });
    }
  }

  getSettings(): Settings | null {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
    if (!rows.length) {
      return null;
    }
    const asRecord = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
    return asRecord as Settings;
  }

  setSettings(settings: Settings): void {
    const del = this.db.prepare('DELETE FROM settings');
    const insert = this.db.prepare('INSERT INTO settings(key, value) VALUES (?, ?)');
    del.run();
    for (const [key, value] of Object.entries(settings)) {
      insert.run(key, JSON.stringify(value));
    }
  }

  upsertJob(job: Job): void {
    const stmt = this.db.prepare(`
      INSERT INTO jobs(id, status, payload) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload
    `);
    stmt.run(job.id, job.status, JSON.stringify(job));
  }

  listJobs(): Job[] {
    const rows = this.db.prepare('SELECT payload FROM jobs ORDER BY rowid DESC').all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as Job);
  }

  getJob(jobId: string): Job | null {
    const row = this.db.prepare('SELECT payload FROM jobs WHERE id = ?').get(jobId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as Job) : null;
  }

  markRunningJobsInterrupted(): void {
    for (const job of this.listJobs()) {
      if (job.status === 'running') {
        job.status = 'interrupted';
        this.upsertJob(job);
      }
    }
  }
}
