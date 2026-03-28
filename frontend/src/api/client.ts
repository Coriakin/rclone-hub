export type {
  ConfigSessionQuestion,
  ConfigSessionResponse,
  Entry,
  Job,
  RemoteConfigField,
  RemoteConfigSchema,
  RemoteConfigView,
  RemoteSummary,
  SearchDoneEvent,
  SearchEvent,
  SearchProgressEvent,
  SearchResultEvent,
  SizeDoneEvent,
  SizeEvent,
  SizeProgressEvent,
} from '../../../shared/src/types';

export const api = {
  health: () => window.electronAPI.health(),
  remotes: () => window.electronAPI.remotes(),
  list: (remotePath: string) => window.electronAPI.list(remotePath, false),
  fileContentUrl: (remotePath: string, disposition: 'inline' | 'attachment' = 'inline') =>
    window.electronAPI.fileContentUrl(remotePath, disposition),
  startSearch: (payload: { root_path: string; filename_query: string; min_size_mb: number | null; search_mode?: 'standard' | 'empty_dirs' }) =>
    window.electronAPI.startSearch(payload),
  searchEvents: (searchId: string, afterSeq: number) => window.electronAPI.searchEvents(searchId, afterSeq),
  cancelSearch: (searchId: string) => window.electronAPI.cancelSearch(searchId),
  startSize: (payload: { root_path: string }) => window.electronAPI.startSize(payload),
  sizeEvents: (sizeId: string, afterSeq: number) => window.electronAPI.sizeEvents(sizeId, afterSeq),
  cancelSize: (sizeId: string) => window.electronAPI.cancelSize(sizeId),
  rename: (sourcePath: string, newName: string) => window.electronAPI.rename(sourcePath, newName),
  jobs: () => window.electronAPI.jobs(),
  job: (jobId: string) => window.electronAPI.job(jobId),
  copy: (sources: string[], destination_dir: string) => window.electronAPI.copy(sources, destination_dir),
  move: (sources: string[], destination_dir: string) => window.electronAPI.move(sources, destination_dir),
  del: (sources: string[]) => window.electronAPI.del(sources),
  cancel: (job_id: string) => window.electronAPI.cancel(job_id),
  settings: () => window.electronAPI.settings(),
  saveSettings: (payload: { staging_path: string; staging_cap_bytes: number; concurrency: number; verify_mode: 'strict' }) =>
    window.electronAPI.saveSettings(payload),
  remoteTypes: () => window.electronAPI.remoteTypes(),
  remotesDetails: () => window.electronAPI.remotesDetails(),
  remoteConfig: (name: string) => window.electronAPI.remoteConfig(name),
  createRemote: (payload: { name: string; type: string; values: Record<string, unknown> }) => window.electronAPI.createRemote(payload),
  updateRemote: (name: string, payload: { values: Record<string, unknown> }) => window.electronAPI.updateRemote(name, payload),
  deleteRemote: (name: string) => window.electronAPI.deleteRemote(name),
  startRemoteConfigSession: (payload: {
    operation: 'create' | 'update';
    name: string;
    type?: string;
    values: Record<string, unknown>;
    ask_all?: boolean;
  }) => window.electronAPI.startRemoteConfigSession(payload),
  continueRemoteConfigSession: (payload: {
    operation: 'create' | 'update';
    name: string;
    type?: string;
    values: Record<string, unknown>;
    state: string;
    result: string;
    ask_all?: boolean;
  }) => window.electronAPI.continueRemoteConfigSession(payload),
};
