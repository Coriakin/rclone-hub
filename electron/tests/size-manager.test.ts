import { describe, expect, test } from 'vitest';
import { SizeManager } from '../services/size-manager';

class FakeRclone {
  tree = {
    'r:root': [
      { name: 'a.txt', path: 'r:root/a.txt', is_dir: false, size: 10, hashes: {} },
      { name: 'sub', path: 'r:root/sub', is_dir: true, size: 0, hashes: {} },
    ],
    'r:root/sub': [{ name: 'b.bin', path: 'r:root/sub/b.bin', is_dir: false, size: 20, hashes: {} }],
  } as Record<string, any[]>;

  async listCancellable(remotePath: string) {
    return this.tree[remotePath] ?? [];
  }
}

async function collectEvents(manager: SizeManager, sizeId: string) {
  let cursor = 0;
  const events = [];
  while (true) {
    const payload = await manager.poll(sizeId, cursor);
    events.push(...payload.events);
    cursor = payload.next_seq;
    if (payload.done) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('SizeManager', () => {
  test('streams progress and done', async () => {
    const manager = new SizeManager(new FakeRclone() as any);
    const sizeId = await manager.create('r:root');
    const events = await collectEvents(manager, sizeId);
    const done = events.at(-1) as any;
    expect(done.type).toBe('done');
    expect(done.status).toBe('success');
    expect(done.bytes_total).toBe(30);
  });
});
