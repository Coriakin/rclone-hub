import { describe, expect, test } from 'vitest';
import { RcloneClient } from '../services/rclone-client';

describe('RcloneClient path helpers', () => {
  test('joinRemote handles root', () => {
    expect(RcloneClient.joinRemote('s3:', 'folder')).toBe('s3:folder');
  });

  test('joinRemote handles nested', () => {
    expect(RcloneClient.joinRemote('s3:base/path', 'child')).toBe('s3:base/path/child');
  });

  test('pathDirname handles root child', () => {
    const client = new RcloneClient('rclone');
    expect(client.pathDirname('s3:file.txt')).toBe('s3:');
  });
});
