import type { Entry } from '../api/client';

export type PaneMode = 'browse' | 'select' | 'search';

export type PaneSearchState = {
  filenameQuery: string;
  minSizeMb: string;
  running: boolean;
  searchId?: string;
  currentDir?: string;
  scannedDirs: number;
  matchedCount: number;
  eventCursor: number;
  error?: string;
};

export type PaneSizeCalcState = {
  running: boolean;
  sizeId?: string;
  targetPath?: string;
  currentDir?: string;
  scannedDirs: number;
  filesCount: number;
  bytesTotal: number;
  eventCursor: number;
  error?: string;
  doneStatus?: 'success' | 'cancelled' | 'failed';
};

export type PaneState = {
  id: string;
  currentPath: string;
  history: string[];
  historyIndex: number;
  items: Entry[];
  mode: PaneMode;
  search: PaneSearchState;
  sizeCalc: PaneSizeCalcState;
  directorySizes: Record<string, number>;
  lockedOperation: null | 'size_calc';
  selected: Set<string>;
  loading: boolean;
  error?: string;
};
