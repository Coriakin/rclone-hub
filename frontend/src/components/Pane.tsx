import React, { useEffect, useState } from 'react';
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
  onFileClick: (path: string) => void;
  onCopySelected: () => void;
  onMoveSelected: () => void;
  onDeleteSelected: () => void;
  onDropTarget: (targetPath: string | null, sources: string[], move: boolean, sourcePaneId?: string) => void;
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
  onFileClick,
  onCopySelected,
  onMoveSelected,
  onDeleteSelected,
  onDropTarget,
  onClose,
}: Props) {
  const hasSelection = pane.selected.size > 0;
  const [pathDraft, setPathDraft] = useState(pane.currentPath);

  useEffect(() => {
    setPathDraft(pane.currentPath);
  }, [pane.currentPath]);

  return (
    <section className={`pane ${isActive ? 'active' : ''}`} onClick={onActivate}>
      <div className="pane-toolbar">
        <div className="pane-toolbar-main">
          <button onClick={onBack} disabled={pane.historyIndex <= 0}>Back</button>
          <button onClick={onForward} disabled={pane.historyIndex >= pane.history.length - 1}>Forward</button>
          <form onSubmit={(e) => {
            e.preventDefault();
            const nextPath = pathDraft.trim();
            if (!nextPath) return;
            onPathSubmit(nextPath);
          }}>
            <input
              name="path"
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
            />
          </form>
          <button className="ghost-btn" onClick={onClose}>Close</button>
        </div>
        <div className="pane-toolbar-modes">
          <div className="mode-group" role="group" aria-label="Pane mode">
            <button className={pane.mode === 'browse' ? 'mode-btn active' : 'mode-btn'} onClick={() => pane.mode === 'select' && onToggleSelectionMode()}>
              Browse
            </button>
            <button className={pane.mode === 'select' ? 'mode-btn active' : 'mode-btn'} onClick={() => pane.mode === 'browse' && onToggleSelectionMode()}>
              Select
            </button>
          </div>
          {pane.mode === 'select' && hasSelection && (
            <div className="ops-group" role="group" aria-label="Selection operations">
              <button onClick={onCopySelected}>Copy</button>
              <button onClick={onMoveSelected}>Move</button>
              <button className="danger-btn" onClick={onDeleteSelected}>Delete</button>
            </div>
          )}
        </div>
      </div>
      {pane.loading && <div className="pane-status">Loading...</div>}
      {pane.error && <div className="pane-error">{pane.error}</div>}
      <FileList
        paneId={pane.id}
        entries={pane.items}
        selectionMode={pane.mode === 'select'}
        selected={pane.selected}
        onToggleSelect={onToggleSelect}
        onFileClick={onFileClick}
        onNavigate={onNavigate}
        onDropTarget={onDropTarget}
      />
    </section>
  );
}
