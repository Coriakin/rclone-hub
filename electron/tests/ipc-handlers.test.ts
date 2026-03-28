import { describe, expect, test } from 'vitest';
import { createHandlers } from '../ipc/handlers';

function buildServices() {
  const fakeRclone = {
    version: async () => 'rclone vtest',
    configFile: async () => '~/.config/rclone/rclone.conf',
    listRemotes: async () => ['b2r:', 'drv:'],
    listRemotesLongJson: async () => [
      { name: 'b2r', type: 'b2', source: 'file', description: '' },
      { name: 'drv', type: 'drive', source: 'file', description: '' },
      { name: 'legacy', type: 's3', source: 'file', description: '' },
      { name: 'cryptwrap', type: 'crypt', source: 'file', description: '' },
    ],
    configProviders: async () => [
      { Prefix: 'b2', Description: 'Backblaze B2', Options: [{ Name: 'account', Type: 'string', Required: true, Sensitive: true }] },
      { Prefix: 'drive', Description: 'Google Drive', Options: [] },
      { Prefix: 'crypt', Description: 'Crypt', Options: [] },
      { Prefix: 'smb', Description: 'SMB', Options: [] },
      { Prefix: 's3', Description: 'S3', Options: [] },
    ],
    configRedacted: async () => ({ type: 'b2', account: 'XXX' }),
    configCreate: async () => undefined,
    configUpdate: async () => undefined,
    configDelete: async () => undefined,
    configDump: async () => ({ cryptwrap: { type: 'crypt', remote: 'b2r:secure' } }),
    configCreateNonInteractive: async () => ({ state: 'oauth', option: { Name: 'config_is_local', Type: 'bool' }, error: '' }),
    configUpdateNonInteractive: async () => null,
    list: async () => [],
    stat: async (remotePath: string) => ({ name: 'f.txt', path: remotePath, is_dir: false, size: 1, hashes: {} }),
    pathBasename: (remotePath: string) => remotePath.split('/').pop() ?? remotePath,
    renameWithinParent: async (sourcePath: string, newName: string) => `${sourcePath.split('/').slice(0, -1).join('/') || 'r:'}/${newName}`.replace('r://', 'r:'),
  };
  return createHandlers({
    db: {
      getSettings: () => ({ staging_path: '/tmp/rclone-hub', staging_cap_bytes: 1024, concurrency: 1, verify_mode: 'strict' }),
      setSettings: () => undefined,
    } as any,
    rclone: fakeRclone as any,
    searches: {
      create: async () => 'search-1',
      poll: async () => ({ events: [], done: true, next_seq: 0 }),
      cancel: async () => true,
    } as any,
    sizes: {
      create: async () => 'size-1',
      poll: async () => ({ events: [], done: true, next_seq: 0 }),
      cancel: async () => true,
    } as any,
    transfers: {
      submitTransfer: (req: any) => ({ id: 'job-1', status: 'queued', operation: req.operation, sources: req.sources, destination_dir: req.destination_dir, created_at: '2026-03-28T00:00:00.000Z', results: [], logs: [] }),
      submitDelete: () => ({ id: 'job-2', status: 'queued', operation: 'delete', sources: ['a:x'], created_at: '2026-03-28T00:00:00.000Z', results: [], logs: [] }),
      cancel: () => null,
      listJobs: () => [],
      getJob: () => null,
    } as any,
  });
}

describe('IPC handlers', () => {
  test('remote types only expose supported types', async () => {
    const handlers = buildServices();
    const payload = await handlers.remoteTypes();
    expect(payload.types.map((entry) => entry.type)).toEqual(['b2', 'crypt', 'drive', 'smb']);
  });

  test('rename validates invalid names', async () => {
    const handlers = buildServices();
    await expect(handlers.renamePath('r:dir/old.txt', 'bad/name')).rejects.toThrow();
  });

  test('config session start returns question shape', async () => {
    const handlers = buildServices();
    const response = await handlers.configSessionStart({ operation: 'create', name: 'drv2', type: 'drive', values: {}, ask_all: false });
    expect(response.done).toBe(false);
    expect(response.question?.state).toBe('oauth');
  });
});
