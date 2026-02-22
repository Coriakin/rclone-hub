import type { Entry } from '../api/client';

export type PaneMode = 'browse' | 'select' | 'search';

export type PaneSearchState = {
  filenameQuery: string;
  literal: boolean;
  minSizeMb: string;
  running: boolean;
  searchId?: string;
  currentDir?: string;
  scannedDirs: number;
  matchedCount: number;
  eventCursor: number;
  error?: string;
};

export type PaneState = {
  id: string;
  currentPath: string;
  history: string[];
  historyIndex: number;
  items: Entry[];
  mode: PaneMode;
  search: PaneSearchState;
  selected: Set<string>;
  loading: boolean;
  error?: string;
};
