import type {
  ConfigSessionContinueRequest,
  ConfigSessionResponse,
  ConfigSessionStartRequest,
  DeleteRequest,
  HealthResponse,
  Job,
  RemoteConfigSchema,
  RemoteConfigView,
  RemoteSummary,
  RenamePathResponse,
  SearchCreateRequest,
  SearchCreateResponse,
  SearchEventsResponse,
  Settings,
  SizeCreateRequest,
  SizeCreateResponse,
  SizeEventsResponse,
  TransferRequest,
} from '../../../shared/src/types';

export interface ElectronAPI {
  health: () => Promise<HealthResponse>;
  remotes: () => Promise<{ remotes: string[] }>;
  list: (remotePath: string, recursive?: boolean) => Promise<{ items: import('../../../shared/src/types').Entry[] }>;
  fileContentUrl: (remotePath: string, disposition?: 'inline' | 'attachment') => string;
  startSearch: (payload: SearchCreateRequest) => Promise<SearchCreateResponse>;
  searchEvents: (searchId: string, afterSeq: number) => Promise<SearchEventsResponse>;
  cancelSearch: (searchId: string) => Promise<{ ok: boolean }>;
  startSize: (payload: SizeCreateRequest) => Promise<SizeCreateResponse>;
  sizeEvents: (sizeId: string, afterSeq: number) => Promise<SizeEventsResponse>;
  cancelSize: (sizeId: string) => Promise<{ ok: boolean }>;
  rename: (sourcePath: string, newName: string) => Promise<RenamePathResponse>;
  jobs: () => Promise<{ jobs: Job[] }>;
  job: (jobId: string) => Promise<Job>;
  copy: (sources: string[], destinationDir: string) => Promise<Job>;
  move: (sources: string[], destinationDir: string) => Promise<Job>;
  del: (sources: string[]) => Promise<Job>;
  cancel: (jobId: string) => Promise<Job>;
  settings: () => Promise<Settings>;
  saveSettings: (settings: Settings) => Promise<Settings>;
  remoteTypes: () => Promise<{ types: RemoteConfigSchema[] }>;
  remotesDetails: () => Promise<{ remotes: RemoteSummary[] }>;
  remoteConfig: (name: string) => Promise<RemoteConfigView>;
  createRemote: (payload: { name: string; type: string; values: Record<string, unknown> }) => Promise<{ ok: boolean }>;
  updateRemote: (name: string, payload: { values: Record<string, unknown> }) => Promise<{ ok: boolean }>;
  deleteRemote: (name: string) => Promise<{ ok: boolean }>;
  startRemoteConfigSession: (payload: ConfigSessionStartRequest) => Promise<ConfigSessionResponse>;
  continueRemoteConfigSession: (payload: ConfigSessionContinueRequest) => Promise<ConfigSessionResponse>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
