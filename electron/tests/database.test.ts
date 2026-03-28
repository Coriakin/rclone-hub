import { describe, expect, test } from 'vitest';
import { Database } from '../db/database';

function createMemoryDriver() {
  const settings = new Map<string, string>();
  const jobs = new Map<string, { status: string; payload: string }>();
  return {
    exec() {
      return undefined;
    },
    pragma() {
      return undefined;
    },
    prepare(sql: string) {
      if (sql.startsWith('SELECT key, value FROM settings')) {
        return { all: () => [...settings.entries()].map(([key, value]) => ({ key, value })) };
      }
      if (sql.startsWith('DELETE FROM settings')) {
        return { run: () => settings.clear() };
      }
      if (sql.startsWith('INSERT INTO settings')) {
        return { run: (key: string, value: string) => settings.set(key, value) };
      }
      if (sql.includes('INSERT INTO jobs')) {
        return { run: (id: string, status: string, payload: string) => jobs.set(id, { status, payload }) };
      }
      if (sql.startsWith('SELECT payload FROM jobs ORDER BY rowid DESC')) {
        return { all: () => [...jobs.values()].reverse() };
      }
      if (sql.startsWith('SELECT payload FROM jobs WHERE id = ?')) {
        return { get: (id: string) => jobs.get(id) ? { payload: jobs.get(id)!.payload } : undefined };
      }
      throw new Error(`unsupported SQL in test driver: ${sql}`);
    },
  };
}

describe('Database', () => {
  test('stores settings and jobs in memory', () => {
    const db = new Database(':memory:', createMemoryDriver() as any);

    const settings = db.getSettings();
    expect(settings?.verify_mode).toBe('strict');

    db.upsertJob({
      id: 'job-1',
      operation: 'copy',
      status: 'queued',
      created_at: '2026-03-28T00:00:00.000Z',
      sources: ['a:src'],
      destination_dir: 'b:dst',
      fallback_mode: 'auto',
      verify_mode: 'strict',
      results: [],
      logs: [],
    });

    expect(db.listJobs()).toHaveLength(1);
    expect(db.getJob('job-1')?.id).toBe('job-1');
  });
});
