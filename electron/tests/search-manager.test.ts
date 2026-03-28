import { describe, expect, test } from 'vitest';
import { SearchManager } from '../services/search-manager';

class FakeRclone {
  tree = {
    'r:root': [
      { name: 'small.txt', path: 'r:root/small.txt', is_dir: false, size: 128, hashes: {} },
      { name: 'sub', path: 'r:root/sub', is_dir: true, size: 0, hashes: {} },
    ],
    'r:root/sub': [
      { name: 'big.bin', path: 'r:root/sub/big.bin', is_dir: false, size: 4 * 1024 * 1024, hashes: {} },
      { name: 'nested.txt', path: 'r:root/sub/nested.txt', is_dir: false, size: 256, hashes: {} },
    ],
  } as Record<string, any[]>;

  matchesPattern(name: string, query: string) {
    const normalized = name.toLowerCase();
    const q = query.toLowerCase();
    if (q.includes('*')) {
      const re = new RegExp(`^${q.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
      return re.test(normalized);
    }
    return normalized === q;
  }

  async listCancellable(remotePath: string) {
    return this.tree[remotePath] ?? [];
  }
}

async function collectEvents(manager: SearchManager, searchId: string) {
  let cursor = 0;
  const events = [];
  while (true) {
    const payload = await manager.poll(searchId, cursor);
    events.push(...payload.events);
    cursor = payload.next_seq;
    if (payload.done) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('SearchManager', () => {
  test('streams progress and results', async () => {
    const manager = new SearchManager(new FakeRclone() as any);
    const searchId = await manager.create('r:root', '*.txt', null);
    const events = await collectEvents(manager, searchId);
    const resultPaths = events.filter((event: any) => event.type === 'result').map((event: any) => event.entry.path);
    expect(resultPaths).toContain('r:root/small.txt');
    expect(resultPaths).toContain('r:root/sub/nested.txt');
    expect(events.at(-1)?.type).toBe('done');
  });
});
