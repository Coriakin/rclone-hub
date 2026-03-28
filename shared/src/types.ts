export type Entry = {
  name: string;
  path: string;
  parent_path?: string;
  is_dir: boolean;
  size: number;
  mod_time?: string;
  hashes: Record<string, string>;
};

export type VerifyMode = 'strict';
export type FallbackMode = 'auto';
export type JobOperation = 'copy' | 'move' | 'delete';
export type JobStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted';

export type TransferRequest = {
  sources: string[];
  destination_dir: string;
  operation: Extract<JobOperation, 'copy' | 'move'>;
  fallback_mode: FallbackMode;
  verify_mode: VerifyMode;
};

export type DeleteRequest = {
  sources: string[];
};

export type CancelRequest = {
  job_id: string;
};

export type RenamePathRequest = {
  source_path: string;
  new_name: string;
};

export type RenamePathResponse = {
  ok: boolean;
  updated_path: string;
};

export type JobLog = {
  ts: string;
  level: string;
  message: string;
};

export type JobItemResult = {
  source: string;
  destination?: string;
  status: JobStatus;
  direct_attempted: boolean;
  fallback_used: boolean;
  verify_passed: boolean;
  error?: string;
};

export type Job = {
  id: string;
  operation: JobOperation;
  status: JobStatus;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  sources: string[];
  destination_dir?: string;
  fallback_mode?: FallbackMode;
  verify_mode?: VerifyMode;
  results: JobItemResult[];
  logs: JobLog[];
};

export type Settings = {
  staging_path: string;
  staging_cap_bytes: number;
  concurrency: number;
  verify_mode: VerifyMode;
};

export type HealthResponse = {
  ok: boolean;
  rclone_available: boolean;
  rclone_version?: string;
  rclone_config_file?: string;
};

export type SearchCreateRequest = {
  root_path: string;
  filename_query: string;
  min_size_mb: number | null;
  search_mode?: 'standard' | 'empty_dirs';
};

export type SearchCreateResponse = {
  search_id: string;
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

export type SearchEventsResponse = {
  events: SearchEvent[];
  done: boolean;
  next_seq: number;
};

export type SizeCreateRequest = {
  root_path: string;
};

export type SizeCreateResponse = {
  size_id: string;
};

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

export type SizeEventsResponse = {
  events: SizeEvent[];
  done: boolean;
  next_seq: number;
};

export type RemoteSummary = {
  name: string;
  type: string;
  source: string;
  description: string;
};

export type RemoteConfigExample = {
  value: string;
  help: string;
};

export type RemoteConfigField = {
  name: string;
  type: string;
  required: boolean;
  advanced: boolean;
  is_password: boolean;
  sensitive: boolean;
  exclusive: boolean;
  default: string;
  help: string;
  examples: RemoteConfigExample[];
  value?: string;
};

export type RemoteConfigSchema = {
  type: string;
  description: string;
  fields: RemoteConfigField[];
};

export type RemoteConfigView = {
  name: string;
  type: string;
  fields: RemoteConfigField[];
};

export type RemoteUpsertRequest = {
  name: string;
  type: string;
  values: Record<string, unknown>;
};

export type RemoteUpdateRequest = {
  values: Record<string, unknown>;
};

export type ConfigSessionQuestion = {
  state: string;
  option: {
    Name?: string;
    Help?: string;
    Default?: unknown;
    Examples?: Array<{ Value: string; Help: string }>;
    Required?: boolean;
    IsPassword?: boolean;
    Type?: string;
    Exclusive?: boolean;
  };
  error: string;
};

export type ConfigSessionStartRequest = {
  operation: 'create' | 'update';
  name: string;
  type?: string;
  values: Record<string, unknown>;
  ask_all?: boolean;
};

export type ConfigSessionContinueRequest = ConfigSessionStartRequest & {
  state: string;
  result: string;
};

export type ConfigSessionResponse = {
  done: boolean;
  question: ConfigSessionQuestion | null;
};

export type CommandResult = {
  args: string[];
  returncode: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
};
