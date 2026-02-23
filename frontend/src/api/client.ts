export type Entry = {
  name: string;
  path: string;
  parent_path?: string;
  is_dir: boolean;
  size: number;
  mod_time?: string;
};

export type Job = {
  id: string;
  operation: 'copy' | 'move' | 'delete';
  status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted';
  sources: string[];
  destination_dir?: string;
  created_at: string;
  results: Array<{
    source: string;
    destination?: string;
    status: string;
    fallback_used: boolean;
    error?: string;
  }>;
  logs: Array<{
    ts: string;
    level: string;
    message: string;
  }>;
};

export type SearchProgressEvent = {
  seq: number;
  type: 'progress';
  current_dir: string;
  scanned_dirs: number;
  matched_count: number;
};

export type SearchResultEvent = {
  seq: number;
  type: 'result';
  entry: Entry;
};

export type SearchDoneEvent = {
  seq: number;
  type: 'done';
  status: 'success' | 'cancelled' | 'failed';
  scanned_dirs: number;
  matched_count: number;
  error?: string;
};

export type SearchEvent = SearchProgressEvent | SearchResultEvent | SearchDoneEvent;

export type SizeProgressEvent = {
  seq: number;
  type: 'progress';
  current_dir: string;
  scanned_dirs: number;
  files_count: number;
  bytes_total: number;
};

export type SizeDoneEvent = {
  seq: number;
  type: 'done';
  status: 'success' | 'cancelled' | 'failed';
  scanned_dirs: number;
  files_count: number;
  bytes_total: number;
  error?: string;
};

export type SizeEvent = SizeProgressEvent | SizeDoneEvent;

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8000/api';
const DEFAULT_TIMEOUT_MS = 45000;

async function json<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  health: () => json<{ ok: boolean }>(`${API_BASE}/health`),
  remotes: () => json<{ remotes: string[] }>(`${API_BASE}/remotes`),
  list: (remotePath: string) => json<{ items: Entry[] }>(`${API_BASE}/list?remote_path=${encodeURIComponent(remotePath)}&recursive=false`),
  fileContentUrl: (remotePath: string, disposition: 'inline' | 'attachment' = 'inline') =>
    `${API_BASE}/files/content?remote_path=${encodeURIComponent(remotePath)}&disposition=${disposition}`,
  startSearch: (payload: { root_path: string; filename_query: string; min_size_mb: number | null; search_mode?: 'standard' | 'empty_dirs' }) =>
    json<{ search_id: string }>(`${API_BASE}/searches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  searchEvents: (searchId: string, afterSeq: number) =>
    json<{ events: SearchEvent[]; done: boolean; next_seq: number }>(
      `${API_BASE}/searches/${encodeURIComponent(searchId)}/events?after_seq=${afterSeq}`
    ),
  cancelSearch: (searchId: string) =>
    json<{ ok: boolean }>(`${API_BASE}/searches/${encodeURIComponent(searchId)}/cancel`, {
      method: 'POST',
    }),
  startSize: (payload: { root_path: string }) =>
    json<{ size_id: string }>(`${API_BASE}/sizes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  sizeEvents: (sizeId: string, afterSeq: number) =>
    json<{ events: SizeEvent[]; done: boolean; next_seq: number }>(
      `${API_BASE}/sizes/${encodeURIComponent(sizeId)}/events?after_seq=${afterSeq}`
    ),
  cancelSize: (sizeId: string) =>
    json<{ ok: boolean }>(`${API_BASE}/sizes/${encodeURIComponent(sizeId)}/cancel`, {
      method: 'POST',
    }),
  rename: (sourcePath: string, newName: string) =>
    json<{ ok: boolean; updated_path: string }>(`${API_BASE}/paths/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_path: sourcePath, new_name: newName }),
    }),
  jobs: () => json<{ jobs: Job[] }>(`${API_BASE}/jobs`),
  job: (jobId: string) => json<Job>(`${API_BASE}/jobs/${encodeURIComponent(jobId)}`),
  copy: (sources: string[], destination_dir: string) =>
    json<Job>(`${API_BASE}/jobs/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources, destination_dir, operation: 'copy', fallback_mode: 'auto', verify_mode: 'strict' }),
    }),
  move: (sources: string[], destination_dir: string) =>
    json<Job>(`${API_BASE}/jobs/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources, destination_dir, operation: 'move', fallback_mode: 'auto', verify_mode: 'strict' }),
    }),
  del: (sources: string[]) =>
    json<Job>(`${API_BASE}/jobs/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources }),
    }),
  cancel: (job_id: string) =>
    json<Job>(`${API_BASE}/jobs/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id }),
    }),
  settings: () => json<{ staging_path: string; staging_cap_bytes: number; concurrency: number; verify_mode: string }>(`${API_BASE}/settings`),
  saveSettings: (payload: { staging_path: string; staging_cap_bytes: number; concurrency: number; verify_mode: 'strict' }) =>
    json(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
};
