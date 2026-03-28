import { describe, expect, test } from 'vitest';
import type { Entry } from '../../shared/src/types';
import { RcloneClient, RcloneError } from '../services/rclone-client';

class StubRclone extends RcloneClient {
  calls: string[][] = [];
  private readonly entry?: Entry;
  private readonly statRaises: boolean;

  constructor(entry?: Entry, statRaises = false) {
    super('rclone');
    this.entry = entry;
    this.statRaises = statRaises;
  }

  override async stat(_remotePath: string): Promise<Entry> {
    if (this.statRaises) {
      throw new RcloneError('stat failed');
    }
    return this.entry!;
  }

  override async run(args: string[]) {
    this.calls.push(args);
    return { args, returncode: 0, stdout: '', stderr: '', duration_ms: 0, timed_out: false };
  }
}

describe('deletePath', () => {
  test('uses deletefile for files', async () => {
    const client = new StubRclone({ name: 'f', path: 'a:f.txt', is_dir: false, size: 1, hashes: {} });
    await client.deletePath('a:f.txt');
    expect(client.calls.at(-1)).toEqual(['deletefile', 'a:f.txt']);
  });

  test('uses delete --rmdirs for dirs', async () => {
    const client = new StubRclone({ name: 'd', path: 'a:dir', is_dir: true, size: 0, hashes: {} });
    await client.deletePath('a:dir');
    expect(client.calls.at(-1)).toEqual(['delete', 'a:dir', '--rmdirs']);
  });

  test('falls back when stat fails', async () => {
    const client = new StubRclone(undefined, true);
    await client.deletePath('a:unknown');
    expect(client.calls.at(-1)).toEqual(['delete', 'a:unknown', '--rmdirs']);
  });
});
