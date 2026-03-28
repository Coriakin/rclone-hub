import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import picomatch from 'picomatch';
import { RCLONE_MAX_RETRIES, RCLONE_TIMEOUT_SECONDS } from '../config';
import type { CommandResult, ConfigSessionQuestion, Entry } from '../../shared/src/types';

const execFileAsync = promisify(execFile);

export class RcloneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RcloneError';
  }
}

export type BinaryStreamHandle = {
  args: string[];
  process: ChildProcessByStdio<null, Readable, Readable>;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  close: () => void;
};

export class RcloneClient {
  readonly binary: string;
  readonly timeoutSeconds: number;
  readonly maxRetries: number;
  readonly baseFlags: string[];

  constructor(binary = 'rclone') {
    this.binary = binary;
    this.timeoutSeconds = RCLONE_TIMEOUT_SECONDS;
    this.maxRetries = RCLONE_MAX_RETRIES;
    this.baseFlags = splitShellWords(process.env.RCLONE_HUB_RCLONE_FLAGS ?? '');
  }

  async run(args: string[], timeout?: number, retries?: number): Promise<CommandResult> {
    const timeoutSeconds = timeout ?? this.timeoutSeconds;
    const attempts = (retries ?? this.maxRetries) + 1;
    const command = [this.binary, ...this.baseFlags, ...args];

    let last: CommandResult | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const started = performance.now();
      try {
        const { stdout, stderr } = await execFileAsync(command[0], command.slice(1), {
          timeout: timeoutSeconds * 1000,
          maxBuffer: 50 * 1024 * 1024,
        });
        return {
          args: command,
          returncode: 0,
          stdout,
          stderr,
          duration_ms: elapsedMs(started),
          timed_out: false,
        };
      } catch (error) {
        const err = error as NodeJS.ErrnoException & {
          killed?: boolean;
          stdout?: string;
          stderr?: string;
          code?: string | number;
          signal?: string;
        };
        last = {
          args: command,
          returncode: err.killed || err.signal === 'SIGTERM' ? 124 : Number(err.code ?? 1),
          stdout: err.stdout ?? '',
          stderr: err.stderr ?? '',
          duration_ms: elapsedMs(started),
          timed_out: Boolean(err.killed || err.signal === 'SIGTERM'),
        };
      }
    }

    return last ?? {
      args: command,
      returncode: 1,
      stdout: '',
      stderr: 'unknown failure',
      duration_ms: 0,
      timed_out: false,
    };
  }

  async runChecked(args: string[]): Promise<CommandResult> {
    const result = await this.run(args);
    if (result.returncode !== 0) {
      throw new RcloneError(`command failed: ${RcloneClient.asCmd(result.args)}\n${result.stderr.trim()}`);
    }
    return result;
  }

  async runWithProgress(
    args: string[],
    onProgress: (line: string) => void,
    shouldCancel?: () => boolean,
    timeout?: number,
  ): Promise<CommandResult> {
    const timeoutSeconds = timeout ?? this.timeoutSeconds;
    const command = [this.binary, ...this.baseFlags, ...args];
    const started = performance.now();
    const proc = spawn(command[0], command.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrRemainder = '';
    let timedOut = false;
    let cancelled = false;

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      const text = stderrRemainder + chunk.toString('utf8');
      const lines = text.split(/\r?\n/);
      stderrRemainder = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          onProgress(trimmed);
        }
      }
    });

    const exitPromise = new Promise<number>((resolve) => {
      proc.on('close', (code) => resolve(code ?? 1));
    });

    const deadline = Date.now() + timeoutSeconds * 1000;
    const watcher = setInterval(() => {
      if (shouldCancel?.()) {
        cancelled = true;
        proc.kill('SIGKILL');
        return;
      }
      if (Date.now() > deadline) {
        timedOut = true;
        proc.kill('SIGKILL');
      }
    }, 50);

    const returncode = await exitPromise;
    clearInterval(watcher);

    if (stderrRemainder.trim()) {
      onProgress(stderrRemainder.trim());
    }

    let stderr = Buffer.concat(stderrChunks).toString('utf8');
    if (timedOut) {
      stderr = `${stderr}\nTimed out after ${timeoutSeconds}s`.trim();
    }
    if (cancelled) {
      stderr = `${stderr}\nCancelled by user`.trim();
    }

    return {
      args: command,
      returncode: cancelled ? 130 : timedOut ? 124 : returncode,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr,
      duration_ms: elapsedMs(started),
      timed_out: timedOut,
    };
  }

  static asCmd(args: string[]): string {
    return args.map((arg) => JSON.stringify(arg)).join(' ');
  }

  async version(): Promise<string> {
    const result = await this.runChecked(['version', '--check=false']);
    return result.stdout.trim().split(/\r?\n/)[0] ?? 'unknown';
  }

  async configFile(): Promise<string> {
    const result = await this.runChecked(['config', 'file']);
    const out = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    return out[out.length - 1] ?? '';
  }

  async listRemotes(): Promise<string[]> {
    const result = await this.runChecked(['listremotes']);
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  async listRemotesLongJson(): Promise<Array<Record<string, unknown>>> {
    const result = await this.runChecked(['listremotes', '--json']);
    const payload = JSON.parse(result.stdout || '[]');
    if (!Array.isArray(payload)) {
      throw new RcloneError('invalid response from rclone listremotes --json');
    }
    return payload as Array<Record<string, unknown>>;
  }

  async configProviders(): Promise<Array<Record<string, unknown>>> {
    const result = await this.runChecked(['config', 'providers']);
    const payload = JSON.parse(result.stdout || '[]');
    if (!Array.isArray(payload)) {
      throw new RcloneError('invalid response from rclone config providers');
    }
    return payload as Array<Record<string, unknown>>;
  }

  async configDump(): Promise<Record<string, Record<string, unknown>>> {
    const result = await this.runChecked(['config', 'dump']);
    const payload = JSON.parse(result.stdout || '{}');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new RcloneError('invalid response from rclone config dump');
    }
    return payload as Record<string, Record<string, unknown>>;
  }

  async configRedacted(remote?: string): Promise<Record<string, string> | Record<string, Record<string, string>>> {
    const args = ['config', 'redacted'];
    if (remote) {
      args.push(remote);
    }
    const result = await this.runChecked(args);
    const parsed = RcloneClient.parseIniLikeConfig(result.stdout || '');
    return remote ? parsed[remote] ?? {} : parsed;
  }

  async configCreate(name: string, remoteType: string, values: Record<string, unknown>): Promise<void> {
    const result = await this.run(['config', 'create', name, remoteType, ...RcloneClient.toKeyValueArgs(values), '--obscure']);
    if (result.returncode !== 0) {
      throw new RcloneError(`command failed: ${RcloneClient.asCmd(result.args)}\n${result.stderr.trim()}`);
    }
  }

  async configUpdate(name: string, values: Record<string, unknown>): Promise<void> {
    const result = await this.run(['config', 'update', name, ...RcloneClient.toKeyValueArgs(values), '--obscure']);
    if (result.returncode !== 0) {
      throw new RcloneError(`command failed: ${RcloneClient.asCmd(result.args)}\n${result.stderr.trim()}`);
    }
  }

  async configDelete(name: string): Promise<void> {
    await this.runChecked(['config', 'delete', name]);
  }

  async configCreateNonInteractive(
    name: string,
    remoteType: string,
    values: Record<string, unknown>,
    state?: string,
    resultValue?: string,
    askAll = false,
  ): Promise<ConfigSessionQuestion | null> {
    const args = ['config', 'create', name, remoteType, ...RcloneClient.toKeyValueArgs(values), '--non-interactive', '--obscure'];
    if (askAll) {
      args.push('--all');
    }
    if (state) {
      args.push('--continue', '--state', state, '--result', resultValue ?? '');
    }
    const result = await this.run(args);
    if (result.returncode !== 0) {
      throw new RcloneError(`command failed: ${RcloneClient.asCmd(result.args)}\n${result.stderr.trim()}`);
    }
    return RcloneClient.parseConfigQuestion(result.stdout);
  }

  async configUpdateNonInteractive(
    name: string,
    values: Record<string, unknown>,
    state?: string,
    resultValue?: string,
    askAll = false,
  ): Promise<ConfigSessionQuestion | null> {
    const args = ['config', 'update', name, ...RcloneClient.toKeyValueArgs(values), '--non-interactive', '--obscure'];
    if (askAll) {
      args.push('--all');
    }
    if (state) {
      args.push('--continue', '--state', state, '--result', resultValue ?? '');
    }
    const result = await this.run(args);
    if (result.returncode !== 0) {
      throw new RcloneError(`command failed: ${RcloneClient.asCmd(result.args)}\n${result.stderr.trim()}`);
    }
    return RcloneClient.parseConfigQuestion(result.stdout);
  }

  async list(remotePath: string, recursive = false): Promise<Entry[]> {
    const args = ['lsjson', remotePath, '--hash', '--metadata', '--files-only=false'];
    if (recursive) {
      args.push('--recursive');
    }
    const result = await this.runChecked(args);
    return RcloneClient.parseEntries(remotePath, result.stdout);
  }

  async listCancellable(
    remotePath: string,
    recursive = false,
    shouldCancel?: () => boolean,
    timeout?: number,
  ): Promise<Entry[]> {
    const args = ['lsjson', remotePath, '--hash', '--metadata', '--files-only=false'];
    if (recursive) {
      args.push('--recursive');
    }
    const result = await this.runWithProgress(args, () => undefined, shouldCancel, timeout);
    if (result.returncode !== 0) {
      throw new RcloneError(`command failed: ${RcloneClient.asCmd(result.args)}\n${result.stderr.trim()}`);
    }
    return RcloneClient.parseEntries(remotePath, result.stdout);
  }

  async stat(remotePath: string): Promise<Entry> {
    const result = await this.runChecked(['lsjson', remotePath, '--stat', '--hash', '--metadata']);
    const item = JSON.parse(result.stdout || '{}') as Record<string, unknown>;
    return {
      name: String(item.Name ?? ''),
      path: remotePath,
      is_dir: Boolean(item.IsDir),
      size: Number(item.Size ?? 0),
      mod_time: RcloneClient.parseTime(item.ModTime),
      hashes: (item.Hashes as Record<string, string> | undefined) ?? {},
    };
  }

  static parseTime(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value) {
      return undefined;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }

  static splitRemote(remotePath: string): [string, string] {
    const idx = remotePath.indexOf(':');
    if (idx === -1) {
      throw new RcloneError(`invalid remote path: ${remotePath}`);
    }
    return [remotePath.slice(0, idx), remotePath.slice(idx + 1).replace(/^\/+/, '')];
  }

  static joinRemote(base: string, child: string): string {
    const [remote, currentPath] = RcloneClient.splitRemote(base);
    const normalizedChild = child.replace(/^\/+|\/+$/g, '');
    let joined = '';
    if (!currentPath) {
      joined = normalizedChild;
    } else if (!normalizedChild) {
      joined = currentPath;
    } else {
      joined = `${currentPath.replace(/\/+$/g, '')}/${normalizedChild}`;
    }
    return joined ? `${remote}:${joined}` : `${remote}:`;
  }

  pathBasename(remotePath: string): string {
    const [, rel] = RcloneClient.splitRemote(remotePath);
    return path.posix.basename(rel);
  }

  pathDirname(remotePath: string): string {
    const [remote, rel] = RcloneClient.splitRemote(remotePath);
    const normalized = rel.replace(/^\/+|\/+$/g, '');
    if (!normalized) {
      return `${remote}:`;
    }
    const dirname = path.posix.dirname(normalized);
    return dirname === '.' ? `${remote}:` : `${remote}:${dirname}`;
  }

  async renameWithinParent(sourcePath: string, newName: string): Promise<string> {
    const currentName = this.pathBasename(sourcePath);
    if (!currentName) {
      throw new RcloneError('cannot rename remote root');
    }
    if (currentName === newName) {
      return sourcePath;
    }
    const parentPath = this.pathDirname(sourcePath);
    const destination = RcloneClient.joinRemote(parentPath, newName);
    await this.runChecked(['moveto', sourcePath, destination]);
    return destination;
  }

  async copy(
    source: string,
    destinationDir: string,
    onProgress?: (line: string) => void,
    shouldCancel?: () => boolean,
  ): Promise<CommandResult> {
    if (onProgress) {
      return this.runWithProgress(
        ['copy', source, destinationDir, '--stats=1s', '--stats-one-line', '--stats-log-level', 'NOTICE'],
        onProgress,
        shouldCancel,
      );
    }
    return this.run(['copy', source, destinationDir, '--progress=false']);
  }

  async copyto(
    source: string,
    destination: string,
    onProgress?: (line: string) => void,
    shouldCancel?: () => boolean,
  ): Promise<CommandResult> {
    if (onProgress) {
      return this.runWithProgress(
        ['copyto', source, destination, '--stats=1s', '--stats-one-line', '--stats-log-level', 'NOTICE'],
        onProgress,
        shouldCancel,
      );
    }
    return this.run(['copyto', source, destination, '--progress=false']);
  }

  async deletePath(source: string): Promise<CommandResult> {
    try {
      const entry = await this.stat(source);
      return entry.is_dir ? this.run(['delete', source, '--rmdirs']) : this.run(['deletefile', source]);
    } catch {
      return this.run(['delete', source, '--rmdirs']);
    }
  }

  async toLocalCopyto(
    sourceRemote: string,
    destinationLocal: string,
    onProgress?: (line: string) => void,
    shouldCancel?: () => boolean,
  ): Promise<CommandResult> {
    fs.mkdirSync(path.dirname(destinationLocal), { recursive: true });
    if (onProgress) {
      return this.runWithProgress(
        ['copyto', sourceRemote, destinationLocal, '--stats=1s', '--stats-one-line', '--stats-log-level', 'NOTICE'],
        onProgress,
        shouldCancel,
      );
    }
    return this.run(['copyto', sourceRemote, destinationLocal, '--progress=false']);
  }

  async fromLocalCopyto(
    sourceLocal: string,
    destinationRemote: string,
    onProgress?: (line: string) => void,
    shouldCancel?: () => boolean,
  ): Promise<CommandResult> {
    if (onProgress) {
      return this.runWithProgress(
        ['copyto', sourceLocal, destinationRemote, '--stats=1s', '--stats-one-line', '--stats-log-level', 'NOTICE'],
        onProgress,
        shouldCancel,
      );
    }
    return this.run(['copyto', sourceLocal, destinationRemote, '--progress=false']);
  }

  async toLocalCopy(
    sourceRemote: string,
    destinationLocalDir: string,
    onProgress?: (line: string) => void,
    shouldCancel?: () => boolean,
  ): Promise<CommandResult> {
    fs.mkdirSync(destinationLocalDir, { recursive: true });
    if (onProgress) {
      return this.runWithProgress(
        ['copy', sourceRemote, destinationLocalDir, '--stats=1s', '--stats-one-line', '--stats-log-level', 'NOTICE'],
        onProgress,
        shouldCancel,
      );
    }
    return this.run(['copy', sourceRemote, destinationLocalDir, '--progress=false']);
  }

  async fromLocalCopy(
    sourceLocalDir: string,
    destinationRemoteDir: string,
    onProgress?: (line: string) => void,
    shouldCancel?: () => boolean,
  ): Promise<CommandResult> {
    if (onProgress) {
      return this.runWithProgress(
        ['copy', sourceLocalDir, destinationRemoteDir, '--stats=1s', '--stats-one-line', '--stats-log-level', 'NOTICE'],
        onProgress,
        shouldCancel,
      );
    }
    return this.run(['copy', sourceLocalDir, destinationRemoteDir, '--progress=false']);
  }

  openCatStream(remotePath: string): BinaryStreamHandle {
    const args = [this.binary, ...this.baseFlags, 'cat', remotePath];
    const proc = spawn(args[0], args.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      args,
      process: proc,
      stdout: proc.stdout,
      stderr: proc.stderr,
      close: () => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      },
    };
  }

  static toKeyValueArgs(values: Record<string, unknown>): string[] {
    const args: string[] = [];
    for (const key of Object.keys(values).sort()) {
      const value = values[key];
      if (value === undefined || value === null) {
        continue;
      }
      args.push(key, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value));
    }
    return args;
  }

  static parseConfigQuestion(stdout: string): ConfigSessionQuestion | null {
    const text = stdout.trim();
    if (!text) {
      return null;
    }
    try {
      const payload = JSON.parse(text) as Record<string, unknown>;
      if (!payload || typeof payload !== 'object') {
        return null;
      }
      const state = typeof payload.State === 'string' ? payload.State : '';
      const option = payload.Option;
      if (!state || !option || typeof option !== 'object' || Array.isArray(option)) {
        return null;
      }
      return {
        state,
        option: option as ConfigSessionQuestion['option'],
        error: typeof payload.Error === 'string' ? payload.Error : '',
      };
    } catch {
      return null;
    }
  }

  static parseIniLikeConfig(contents: string): Record<string, Record<string, string>> {
    const sections: Record<string, Record<string, string>> = {};
    let current: string | null = null;
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) {
        continue;
      }
      if (line.startsWith('[') && line.endsWith(']') && line.length >= 3) {
        current = line.slice(1, -1).trim() || null;
        if (current) {
          sections[current] = sections[current] ?? {};
        }
        continue;
      }
      if (!current || !line.includes('=')) {
        continue;
      }
      const [key, value] = line.split('=', 2);
      sections[current][key.trim()] = value.trim();
    }
    return sections;
  }

  matchesPattern(name: string, query: string): boolean {
    const candidate = name.toLowerCase();
    const pattern = query.toLowerCase();
    const hasWildcard = /[*?[\\]/.test(query);
    return hasWildcard ? picomatch(pattern, { nocase: true })(candidate) : candidate === pattern;
  }

  private static parseEntries(remotePath: string, stdout: string): Entry[] {
    const payload = JSON.parse(stdout || '[]');
    if (!Array.isArray(payload)) {
      throw new RcloneError('invalid response from rclone lsjson');
    }
    return payload.map((item) => ({
      name: String(item.Name ?? ''),
      path: RcloneClient.joinRemote(remotePath, String(item.Path ?? item.Name ?? '')),
      is_dir: Boolean(item.IsDir),
      size: Number(item.Size ?? 0),
      mod_time: RcloneClient.parseTime(item.ModTime),
      hashes: (item.Hashes as Record<string, string> | undefined) ?? {},
    }));
  }
}

function splitShellWords(raw: string): string[] {
  if (!raw.trim()) {
    return [];
  }
  return raw.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"(.*)"$/, '$1')) ?? [];
}

function elapsedMs(started: number): number {
  return Math.round(performance.now() - started);
}
