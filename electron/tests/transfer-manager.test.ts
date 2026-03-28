import { describe, expect, test } from 'vitest';
import { Database } from '../db/database';
import { TransferManager } from '../services/transfer-manager';

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

class FakeRclone {
  firstCopy = true;

  joinRemote(base: string, child: string) {
    return base.endsWith(':') ? `${base}${child}` : `${base}/${child}`;
  }

  pathBasename(source: string) {
    return source.split(':').pop()!.split('/').pop()!;
  }

  async copy() {
    if (this.firstCopy) {
      this.firstCopy = false;
      return { returncode: 1, stderr: 'failed', stdout: '', duration_ms: 0, timed_out: false, args: [] };
    }
    return { returncode: 0, stderr: '', stdout: '', duration_ms: 0, timed_out: false, args: [] };
  }

  async copyto() {
    return this.copy();
  }

  async stat(source: string) {
    return { name: 'f', path: source, is_dir: false, size: 1, hashes: { md5: 'a' }, mod_time: new Date().toISOString() };
  }

  async toLocalCopyto() {
    return { returncode: 0, stderr: '', stdout: '', duration_ms: 0, timed_out: false, args: [] };
  }

  async fromLocalCopyto() {
    return { returncode: 0, stderr: '', stdout: '', duration_ms: 0, timed_out: false, args: [] };
  }

  async toLocalCopy() {
    return { returncode: 0, stderr: '', stdout: '', duration_ms: 0, timed_out: false, args: [] };
  }

  async fromLocalCopy() {
    return { returncode: 0, stderr: '', stdout: '', duration_ms: 0, timed_out: false, args: [] };
  }

  async list(source: string) {
    return [{ name: 'f', path: `${source.replace(/\/$/, '')}/f.txt`, is_dir: false, size: 1, hashes: { md5: 'a' }, mod_time: new Date().toISOString() }];
  }

  async deletePath() {
    return { returncode: 0, stderr: '', stdout: '', duration_ms: 0, timed_out: false, args: [] };
  }
}

describe('TransferManager', () => {
  test('fallback runs after failed direct copy', async () => {
    const db = new Database(':memory:', createMemoryDriver() as any);
    const manager = new TransferManager(db, new FakeRclone() as any);
    const job = manager.submitTransfer({
      operation: 'copy',
      sources: ['a:src'],
      destination_dir: 'b:dst',
      fallback_mode: 'auto',
      verify_mode: 'strict',
    });
    const settings = db.getSettings()!;
    await (manager as any).runTransfer(job, settings);
    expect(manager.getJob(job.id)?.results[0]?.fallback_used).toBe(true);
  });
});
