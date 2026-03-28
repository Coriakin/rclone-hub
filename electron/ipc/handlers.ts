import type { BrowserWindow, IpcMain } from 'electron';
import type {
  ConfigSessionContinueRequest,
  ConfigSessionQuestion,
  ConfigSessionResponse,
  ConfigSessionStartRequest,
  DeleteRequest,
  HealthResponse,
  RemoteConfigField,
  RemoteConfigSchema,
  RemoteConfigView,
  RemoteSummary,
  RenamePathResponse,
  SearchCreateRequest,
  SearchEventsResponse,
  Settings,
  SizeCreateRequest,
  SizeEventsResponse,
  TransferRequest,
} from '../../shared/src/types';
import { Database } from '../db/database';
import { RcloneClient, RcloneError } from '../services/rclone-client';
import { SearchManager } from '../services/search-manager';
import { SizeManager } from '../services/size-manager';
import { TransferManager } from '../services/transfer-manager';

type Services = {
  db: Database;
  rclone: RcloneClient;
  transfers: TransferManager;
  searches: SearchManager;
  sizes: SizeManager;
  getMainWindow?: () => BrowserWindow | null;
};

type Handlers = ReturnType<typeof createHandlers>;

export function createHandlers({ db, rclone, transfers, searches, sizes }: Services) {
  const imageContentTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
  };
  const supportedRemoteTypes = new Set(['b2', 'drive', 'smb', 'crypt']);
  let providerCache: Record<string, RemoteConfigSchema> | null = null;

  function toConfigField(option: Record<string, unknown>): RemoteConfigField {
    const examples = Array.isArray(option.Examples)
      ? option.Examples.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
        .map((item) => ({
          value: String(item.Value ?? ''),
          help: String(item.Help ?? ''),
        }))
      : [];
    return {
      name: String(option.Name ?? ''),
      type: String(option.Type ?? 'string'),
      required: Boolean(option.Required),
      advanced: Boolean(option.Advanced),
      is_password: Boolean(option.IsPassword),
      sensitive: Boolean(option.Sensitive),
      exclusive: Boolean(option.Exclusive),
      default: String(option.DefaultStr ?? ''),
      help: String(option.Help ?? ''),
      examples,
    };
  }

  async function providerSchemas(): Promise<Record<string, RemoteConfigSchema>> {
    if (providerCache) {
      return providerCache;
    }
    providerCache = {};
    for (const provider of await rclone.configProviders()) {
      const remoteType = String(provider.Prefix ?? '');
      if (!supportedRemoteTypes.has(remoteType)) {
        continue;
      }
      const fields = Array.isArray(provider.Options)
        ? provider.Options.filter((opt): opt is Record<string, unknown> => Boolean(opt) && typeof opt === 'object' && !Array.isArray(opt)).map(toConfigField)
        : [];
      providerCache[remoteType] = {
        type: remoteType,
        description: String(provider.Description ?? ''),
        fields,
      };
    }
    return providerCache;
  }

  async function remoteSummaries(): Promise<RemoteSummary[]> {
    const remotes: RemoteSummary[] = [];
    for (const row of await rclone.listRemotesLongJson()) {
      const name = String(row.name ?? '');
      const type = String(row.type ?? '');
      if (!name || !supportedRemoteTypes.has(type)) {
        continue;
      }
      remotes.push({
        name,
        type,
        source: String(row.source ?? ''),
        description: String(row.description ?? ''),
      });
    }
    return remotes;
  }

  async function getRemoteSummary(name: string): Promise<RemoteSummary> {
    const found = (await remoteSummaries()).find((remote) => remote.name === name);
    if (!found) {
      throw new Error(`remote not found: ${name}`);
    }
    return found;
  }

  function isEmpty(value: unknown): boolean {
    return value == null || (typeof value === 'string' && value.trim() === '');
  }

  async function normalizeValues(remoteType: string, values: Record<string, unknown>, requireRequired: boolean): Promise<Record<string, unknown>> {
    const schema = (await providerSchemas())[remoteType];
    if (!schema) {
      throw new Error(`unsupported remote type: ${remoteType}`);
    }
    const allowed = new Map(schema.fields.map((field) => [field.name, field]));
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      const field = allowed.get(key);
      if (!field) {
        throw new Error(`unsupported option for ${remoteType}: ${key}`);
      }
      if (field.is_password && isEmpty(value)) {
        continue;
      }
      normalized[key] = value;
    }
    if (requireRequired) {
      const missing = schema.fields.filter((field) => field.required && isEmpty(normalized[field.name])).map((field) => field.name);
      if (missing.length) {
        throw new Error(`missing required options: ${missing.join(', ')}`);
      }
    }
    return normalized;
  }

  async function health(): Promise<HealthResponse> {
    try {
      const [version, configFile] = await Promise.all([rclone.version(), rclone.configFile()]);
      return { ok: true, rclone_available: true, rclone_version: version, rclone_config_file: configFile };
    } catch {
      return { ok: false, rclone_available: false };
    }
  }

  return {
    health,
    remotes: async () => ({ remotes: await rclone.listRemotes() }),
    remoteTypes: async () => ({ types: Object.values(await providerSchemas()).sort((a, b) => a.type.localeCompare(b.type)) }),
    remotesDetails: async () => ({ remotes: await remoteSummaries() }),
    remoteConfig: async (name: string): Promise<RemoteConfigView> => {
      const remote = await getRemoteSummary(name);
      const schema = (await providerSchemas())[remote.type];
      if (!schema) {
        throw new Error(`unsupported remote type: ${remote.type}`);
      }
      const redacted = await rclone.configRedacted(name);
      const configValues = !Array.isArray(redacted) && redacted && typeof redacted === 'object' ? redacted as Record<string, string> : {};
      return {
        name: remote.name,
        type: remote.type,
        fields: schema.fields.map((field) => ({
          ...field,
          value: field.name in configValues ? String(configValues[field.name]) : undefined,
        })),
      };
    },
    createRemote: async (req: { name: string; type: string; values: Record<string, unknown> }) => {
      const name = req.name.trim();
      const remoteType = req.type.trim();
      if (!name) {
        throw new Error('name is required');
      }
      if (!remoteType) {
        throw new Error('type is required');
      }
      if (remoteType === 'drive') {
        throw new Error('drive must be configured through config-session');
      }
      const values = await normalizeValues(remoteType, req.values ?? {}, true);
      await rclone.configCreate(name, remoteType, values);
      return { ok: true };
    },
    updateRemote: async (name: string, req: { values: Record<string, unknown> }) => {
      const trimmed = name.trim();
      if (!trimmed) {
        throw new Error('name is required');
      }
      const remote = await getRemoteSummary(trimmed);
      if (remote.type === 'drive') {
        throw new Error('drive must be updated through config-session');
      }
      const values = await normalizeValues(remote.type, req.values ?? {}, false);
      if (Object.keys(values).length) {
        await rclone.configUpdate(trimmed, values);
      }
      return { ok: true };
    },
    deleteRemote: async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) {
        throw new Error('name is required');
      }
      await getRemoteSummary(trimmed);
      const config = await rclone.configDump();
      for (const [remoteName, values] of Object.entries(config)) {
        if (remoteName === trimmed || !values || typeof values !== 'object') {
          continue;
        }
        if (String(values.type ?? '') !== 'crypt') {
          continue;
        }
        const wrappedRemote = String(values.remote ?? '');
        if (wrappedRemote.startsWith(`${trimmed}:`)) {
          throw new Error(`cannot delete ${trimmed}: referenced by crypt remote ${remoteName}`);
        }
      }
      await rclone.configDelete(trimmed);
      return { ok: true };
    },
    configSessionStart: async (req: ConfigSessionStartRequest): Promise<ConfigSessionResponse> => {
      const name = req.name.trim();
      if (!name) {
        throw new Error('name is required');
      }
      const question = req.operation === 'create'
        ? await rclone.configCreateNonInteractive(
          name,
          (req.type ?? '').trim(),
          await normalizeValues((req.type ?? '').trim(), req.values ?? {}, false),
          undefined,
          undefined,
          req.ask_all ?? false,
        )
        : await rclone.configUpdateNonInteractive(
          name,
          await normalizeValues((await getRemoteSummary(name)).type, req.values ?? {}, false),
          undefined,
          undefined,
          req.ask_all ?? false,
        );
      return { done: !question, question };
    },
    configSessionContinue: async (req: ConfigSessionContinueRequest): Promise<ConfigSessionResponse> => {
      const name = req.name.trim();
      const state = req.state.trim();
      if (!name) {
        throw new Error('name is required');
      }
      if (!state) {
        throw new Error('state is required');
      }
      const question = req.operation === 'create'
        ? await rclone.configCreateNonInteractive(
          name,
          (req.type ?? '').trim(),
          await normalizeValues((req.type ?? '').trim(), req.values ?? {}, false),
          state,
          req.result,
          req.ask_all ?? false,
        )
        : await rclone.configUpdateNonInteractive(
          name,
          await normalizeValues((await getRemoteSummary(name)).type, req.values ?? {}, false),
          state,
          req.result,
          req.ask_all ?? false,
        );
      return { done: !question, question };
    },
    listFiles: async (remotePath: string, recursive = false) => ({ items: await rclone.list(remotePath, recursive) }),
    getFilePreviewMeta: async (remotePath: string, disposition: 'inline' | 'attachment' = 'inline') => {
      const entry = await rclone.stat(remotePath);
      if (entry.is_dir) {
        throw new Error('remote_path must reference a file');
      }
      const suffix = `.${(entry.name || rclone.pathBasename(remotePath)).split('.').pop() ?? ''}`.toLowerCase();
      const mediaType = imageContentTypes[suffix] ?? 'application/octet-stream';
      if (disposition === 'inline' && mediaType === 'application/octet-stream') {
        throw new Error('inline preview is only supported for jpg/jpeg/png/gif');
      }
      const filename = entry.name || rclone.pathBasename(remotePath) || 'file';
      return { filename, mediaType };
    },
    renamePath: async (sourcePath: string, newName: string): Promise<RenamePathResponse> => {
      const source = sourcePath.trim();
      const next = newName.trim();
      if (!source) {
        throw new Error('source_path is required');
      }
      if (!next) {
        throw new Error('new_name is required');
      }
      if (next.includes('/') || next.includes(':')) {
        throw new Error("new_name cannot contain '/' or ':'");
      }
      if (next === '.' || next === '..') {
        throw new Error('new_name is invalid');
      }
      return { ok: true, updated_path: await rclone.renameWithinParent(source, next) };
    },
    startSearch: async (req: SearchCreateRequest) => searches.create(req.root_path, req.filename_query, req.min_size_mb, req.search_mode),
    pollSearch: async (searchId: string, afterSeq: number): Promise<SearchEventsResponse> => searches.poll(searchId, afterSeq),
    cancelSearch: async (searchId: string) => {
      const found = await searches.cancel(searchId);
      if (!found) {
        throw new Error('search not found');
      }
      return { ok: true };
    },
    startSize: async (req: SizeCreateRequest) => sizes.create(req.root_path),
    pollSize: async (sizeId: string, afterSeq: number): Promise<SizeEventsResponse> => sizes.poll(sizeId, afterSeq),
    cancelSize: async (sizeId: string) => {
      const found = await sizes.cancel(sizeId);
      if (!found) {
        throw new Error('size session not found');
      }
      return { ok: true };
    },
    createCopy: async (req: TransferRequest) => transfers.submitTransfer(req),
    createMove: async (req: TransferRequest) => transfers.submitTransfer(req),
    createDelete: async (req: DeleteRequest) => transfers.submitDelete(req),
    cancelJob: async (jobId: string) => {
      const job = transfers.cancel(jobId);
      if (!job) {
        throw new Error('job not found');
      }
      return job;
    },
    listJobs: async () => ({ jobs: transfers.listJobs() }),
    getJob: async (jobId: string) => {
      const job = transfers.getJob(jobId);
      if (!job) {
        throw new Error('job not found');
      }
      return job;
    },
    getSettings: async (): Promise<Settings> => {
      const settings = db.getSettings();
      if (!settings) {
        throw new Error('settings not initialized');
      }
      return settings;
    },
    saveSettings: async (settings: Settings) => {
      db.setSettings(settings);
      return settings;
    },
  };
}

export function registerIpcHandlers(ipcMain: IpcMain, services: Services): Handlers {
  const handlers = createHandlers(services);

  register(ipcMain, 'health', handlers.health);
  register(ipcMain, 'list-remotes', handlers.remotes);
  register(ipcMain, 'remote-types', handlers.remoteTypes);
  register(ipcMain, 'remotes-details', handlers.remotesDetails);
  register(ipcMain, 'remote-config', (_event, name: string) => handlers.remoteConfig(name));
  register(ipcMain, 'create-remote', (_event, payload) => handlers.createRemote(payload));
  register(ipcMain, 'update-remote', (_event, name: string, payload) => handlers.updateRemote(name, payload));
  register(ipcMain, 'delete-remote', (_event, name: string) => handlers.deleteRemote(name));
  register(ipcMain, 'config-session-start', (_event, payload) => handlers.configSessionStart(payload));
  register(ipcMain, 'config-session-continue', (_event, payload) => handlers.configSessionContinue(payload));
  register(ipcMain, 'list-files', (_event, remotePath: string, recursive?: boolean) => handlers.listFiles(remotePath, recursive));
  register(ipcMain, 'rename-path', (_event, sourcePath: string, newName: string) => handlers.renamePath(sourcePath, newName));
  register(ipcMain, 'start-search', async (_event, payload: SearchCreateRequest) => ({ search_id: await handlers.startSearch(payload) }));
  register(ipcMain, 'search-events', (_event, searchId: string, afterSeq: number) => handlers.pollSearch(searchId, afterSeq));
  register(ipcMain, 'cancel-search', (_event, searchId: string) => handlers.cancelSearch(searchId));
  register(ipcMain, 'start-size', async (_event, payload: SizeCreateRequest) => ({ size_id: await handlers.startSize(payload) }));
  register(ipcMain, 'size-events', (_event, sizeId: string, afterSeq: number) => handlers.pollSize(sizeId, afterSeq));
  register(ipcMain, 'cancel-size', (_event, sizeId: string) => handlers.cancelSize(sizeId));
  register(ipcMain, 'job-copy', (_event, sources: string[], destinationDir: string) => handlers.createCopy({
    sources,
    destination_dir: destinationDir,
    operation: 'copy',
    fallback_mode: 'auto',
    verify_mode: 'strict',
  }));
  register(ipcMain, 'job-move', (_event, sources: string[], destinationDir: string) => handlers.createMove({
    sources,
    destination_dir: destinationDir,
    operation: 'move',
    fallback_mode: 'auto',
    verify_mode: 'strict',
  }));
  register(ipcMain, 'job-delete', (_event, sources: string[]) => handlers.createDelete({ sources }));
  register(ipcMain, 'job-cancel', (_event, jobId: string) => handlers.cancelJob(jobId));
  register(ipcMain, 'list-jobs', handlers.listJobs);
  register(ipcMain, 'get-job', (_event, jobId: string) => handlers.getJob(jobId));
  register(ipcMain, 'get-settings', handlers.getSettings);
  register(ipcMain, 'save-settings', (_event, settings: Settings) => handlers.saveSettings(settings));

  return handlers;
}

function register(ipcMain: IpcMain, channel: string, handler: (...args: any[]) => Promise<unknown>) {
  ipcMain.handle(channel, async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      const message = error instanceof RcloneError ? error.message : error instanceof Error ? error.message : String(error);
      throw new Error(message);
    }
  });
}
