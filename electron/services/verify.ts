import type { Entry } from '../../shared/src/types';
import { RcloneClient, RcloneError } from './rclone-client';

export type VerifyResult = {
  passed: boolean;
  reason: string;
};

function normalizePath(sourceRoot: string, itemPath: string, destinationRoot: string): string {
  const [, srcPrefix] = RcloneClient.splitRemote(sourceRoot);
  const [remote, dstPrefix] = RcloneClient.splitRemote(destinationRoot);
  const [, itemRelPath] = RcloneClient.splitRemote(itemPath);

  const rel = srcPrefix && itemRelPath.startsWith(srcPrefix)
    ? itemRelPath.slice(srcPrefix.length).replace(/^\/+/, '')
    : itemRelPath.replace(/^\/+/, '');
  const mapped = dstPrefix ? `${dstPrefix.replace(/\/+$/g, '')}${rel ? `/${rel}` : ''}` : rel;
  return mapped ? `${remote}:${mapped}` : `${remote}:`;
}

export async function verifyStrict(
  client: Pick<RcloneClient, 'list'>,
  source: string,
  destination: string,
): Promise<VerifyResult> {
  let srcEntries: Entry[];
  let dstEntries: Entry[];
  try {
    [srcEntries, dstEntries] = await Promise.all([
      client.list(source, true),
      client.list(destination, true),
    ]);
  } catch (error) {
    const message = error instanceof RcloneError ? error.message : String(error);
    return { passed: false, reason: `unable to list for verification: ${message}` };
  }

  const srcFiles = srcEntries.filter((entry) => !entry.is_dir);
  const dstFiles = dstEntries.filter((entry) => !entry.is_dir);

  if (srcFiles.length !== dstFiles.length) {
    return { passed: false, reason: 'file count mismatch' };
  }

  const dstMap = new Map(dstFiles.map((entry) => [entry.path, entry]));
  for (const src of srcFiles) {
    const expectedDstPath = normalizePath(source, src.path, destination);
    const dst = dstMap.get(expectedDstPath);
    if (!dst) {
      return { passed: false, reason: `missing destination file: ${expectedDstPath}` };
    }
    if (src.size !== dst.size) {
      return { passed: false, reason: `size mismatch: ${src.path}` };
    }

    const commonHashes = Object.keys(src.hashes).filter((hash) => hash in dst.hashes);
    if (commonHashes.length) {
      const mismatch = commonHashes.filter((hash) => src.hashes[hash] !== dst.hashes[hash]);
      if (mismatch.length) {
        return { passed: false, reason: `checksum mismatch (${mismatch.sort().join(',')}): ${src.path}` };
      }
      continue;
    }

    if (src.mod_time && dst.mod_time) {
      const delta = Math.abs(new Date(src.mod_time).getTime() - new Date(dst.mod_time).getTime()) / 1000;
      if (delta > 2) {
        return { passed: false, reason: `modtime mismatch without checksum: ${src.path}` };
      }
    }
  }

  return { passed: true, reason: 'strict verification passed' };
}
