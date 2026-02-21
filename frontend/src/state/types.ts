import type { Entry } from '../api/client';

export type PaneState = {
  id: string;
  currentPath: string;
  history: string[];
  historyIndex: number;
  items: Entry[];
  selectionMode: boolean;
  selected: Set<string>;
  loading: boolean;
  error?: string;
};
