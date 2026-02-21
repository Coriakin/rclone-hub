import type { Entry } from '../api/client';

export type PaneMode = 'browse' | 'select';

export type PaneState = {
  id: string;
  currentPath: string;
  history: string[];
  historyIndex: number;
  items: Entry[];
  mode: PaneMode;
  selected: Set<string>;
  loading: boolean;
  error?: string;
};
