import { describe, expect, test } from 'vitest';
import { verifyStrict } from '../services/verify';

describe('verifyStrict', () => {
  test('prefers hashes when available', async () => {
    const now = new Date().toISOString();
    const client = {
      list: async (target: string) => target === 'a:src'
        ? [{ name: 'f', path: 'a:src/f.txt', is_dir: false, size: 5, mod_time: now, hashes: { md5: 'x' } }]
        : [{ name: 'f', path: 'b:dst/f.txt', is_dir: false, size: 5, mod_time: now, hashes: { md5: 'x' } }],
    };
    const result = await verifyStrict(client, 'a:src', 'b:dst');
    expect(result.passed).toBe(true);
  });

  test('fails on size mismatch without hashes', async () => {
    const now = new Date().toISOString();
    const client = {
      list: async (target: string) => target === 'a:src'
        ? [{ name: 'f', path: 'a:src/f.txt', is_dir: false, size: 5, mod_time: now, hashes: {} }]
        : [{ name: 'f', path: 'b:dst/f.txt', is_dir: false, size: 6, mod_time: now, hashes: {} }],
    };
    const result = await verifyStrict(client, 'a:src', 'b:dst');
    expect(result.passed).toBe(false);
  });
});
