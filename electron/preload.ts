import { contextBridge, ipcRenderer } from 'electron';

const electronAPI = {
  health: () => ipcRenderer.invoke('health'),
  remotes: () => ipcRenderer.invoke('list-remotes'),
  list: (remotePath: string, recursive = false) => ipcRenderer.invoke('list-files', remotePath, recursive),
  fileContentUrl: (remotePath: string, disposition: 'inline' | 'attachment' = 'inline') =>
    `rclone-file://${encodeURIComponent(remotePath)}?disposition=${disposition}`,
  startSearch: (payload: unknown) => ipcRenderer.invoke('start-search', payload),
  searchEvents: (searchId: string, afterSeq: number) => ipcRenderer.invoke('search-events', searchId, afterSeq),
  cancelSearch: (searchId: string) => ipcRenderer.invoke('cancel-search', searchId),
  startSize: (payload: unknown) => ipcRenderer.invoke('start-size', payload),
  sizeEvents: (sizeId: string, afterSeq: number) => ipcRenderer.invoke('size-events', sizeId, afterSeq),
  cancelSize: (sizeId: string) => ipcRenderer.invoke('cancel-size', sizeId),
  rename: (sourcePath: string, newName: string) => ipcRenderer.invoke('rename-path', sourcePath, newName),
  jobs: () => ipcRenderer.invoke('list-jobs'),
  job: (jobId: string) => ipcRenderer.invoke('get-job', jobId),
  copy: (sources: string[], destinationDir: string) => ipcRenderer.invoke('job-copy', sources, destinationDir),
  move: (sources: string[], destinationDir: string) => ipcRenderer.invoke('job-move', sources, destinationDir),
  del: (sources: string[]) => ipcRenderer.invoke('job-delete', sources),
  cancel: (jobId: string) => ipcRenderer.invoke('job-cancel', jobId),
  settings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('save-settings', settings),
  remoteTypes: () => ipcRenderer.invoke('remote-types'),
  remotesDetails: () => ipcRenderer.invoke('remotes-details'),
  remoteConfig: (name: string) => ipcRenderer.invoke('remote-config', name),
  createRemote: (payload: unknown) => ipcRenderer.invoke('create-remote', payload),
  updateRemote: (name: string, payload: unknown) => ipcRenderer.invoke('update-remote', name, payload),
  deleteRemote: (name: string) => ipcRenderer.invoke('delete-remote', name),
  startRemoteConfigSession: (payload: unknown) => ipcRenderer.invoke('config-session-start', payload),
  continueRemoteConfigSession: (payload: unknown) => ipcRenderer.invoke('config-session-continue', payload),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

export { electronAPI };
