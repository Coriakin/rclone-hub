import React from 'react';
import type { PaneState } from '../state/types';
import { FileList } from './FileList';

type Props = {
  pane: PaneState;
  isActive: boolean;
  onActivate: () => void;
  onPathSubmit: (path: string) => void;
  onNavigate: (path: string) => void;
  onBack: () => void;
  onForward: () => void;
  onToggleSelectionMode: () => void;
  onToggleSelect: (path: string) => void;
  onCopySelected: () => void;
  onMoveSelected: () => void;
  onDeleteSelected: () => void;
  onDropTarget: (targetPath: string | null, sources: string[], move: boolean) => void;
  onClose: () => void;
};

export function Pane({
  pane,
  isActive,
  onActivate,
  onPathSubmit,
  onNavigate,
  onBack,
  onForward,
  onToggleSelectionMode,
  onToggleSelect,
  onCopySelected,
  onMoveSelected,
  onDeleteSelected,
  onDropTarget,
  onClose,
}: Props) {
  return (
    <section className={`pane ${isActive ? 'active' : ''}`} onClick={onActivate}>
      <div className="pane-toolbar">
        <button onClick={onBack} disabled={pane.historyIndex <= 0}>Back</button>
        <button onClick={onForward} disabled={pane.historyIndex >= pane.history.length - 1}>Forward</button>
        <form onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          onPathSubmit(String(data.get('path') || pane.currentPath));
        }}>
          <input name="path" defaultValue={pane.currentPath} />
        </form>
        <button onClick={onToggleSelectionMode}>{pane.selectionMode ? 'Selection On' : 'Select'}</button>
        {pane.selectionMode && (
          <>
            <button onClick={onCopySelected}>Copy</button>
            <button onClick={onMoveSelected}>Move</button>
            <button onClick={onDeleteSelected}>Delete</button>
          </>
        )}
        <button onClick={onClose}>Close</button>
      </div>
      {pane.loading && <div className="pane-status">Loading...</div>}
      {pane.error && <div className="pane-error">{pane.error}</div>}
      <FileList
        entries={pane.items}
        selectionMode={pane.selectionMode}
        selected={pane.selected}
        onToggleSelect={onToggleSelect}
        onNavigate={onNavigate}
        onDropTarget={onDropTarget}
      />
    </section>
  );
}
