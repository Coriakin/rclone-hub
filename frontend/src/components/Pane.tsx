import React, { useEffect, useState } from 'react';
import type { PaneMode, PaneSearchState, PaneState } from '../state/types';
import { FileList } from './FileList';

type Props = {
  pane: PaneState;
  isActive: boolean;
  onActivate: () => void;
  onPathSubmit: (path: string) => void;
  onRefresh: () => void;
  onNavigate: (path: string) => void;
  onBack: () => void;
  onForward: () => void;
  onSetMode: (mode: PaneMode) => void | Promise<void>;
  onSearchChange: (patch: Partial<PaneSearchState>) => void;
  onStartSearch: () => void;
  onCancelSearch: () => void;
  onToggleSelect: (path: string) => void;
  onFileClick: (path: string) => void;
  onOpenInNewPane: (path: string) => void;
  highlighted: Set<string>;
  targetOptions: Array<{ id: string; path: string }>;
  selectedTargetPaneId: string;
  onSelectTargetPane: (paneId: string) => void;
  onCopySelected: (targetPaneId: string) => void;
  onMoveSelected: (targetPaneId: string) => void;
  onDeleteSelected: () => void;
  onDropTarget: (targetPath: string | null, sources: string[], move: boolean, sourcePaneId?: string) => void;
  onClose: () => void;
};

export function Pane({
  pane,
  isActive,
  onActivate,
  onPathSubmit,
  onRefresh,
  onNavigate,
  onBack,
  onForward,
  onSetMode,
  onSearchChange,
  onStartSearch,
  onCancelSearch,
  onToggleSelect,
  onFileClick,
  onOpenInNewPane,
  highlighted,
  targetOptions,
  selectedTargetPaneId,
  onSelectTargetPane,
  onCopySelected,
  onMoveSelected,
  onDeleteSelected,
  onDropTarget,
  onClose,
}: Props) {
  const hasSelection = pane.selected.size > 0;
  const [pathDraft, setPathDraft] = useState(pane.currentPath);
  const canTransfer = !!selectedTargetPaneId;

  useEffect(() => {
    setPathDraft(pane.currentPath);
  }, [pane.currentPath]);

  return (
    <section className={`pane ${isActive ? 'active' : ''}`} onClick={onActivate}>
      <div className="pane-toolbar">
        <div className="pane-toolbar-main">
          <button className="close-icon-btn" onClick={onClose} aria-label="Close pane" title="Close pane">X</button>
          <button className="ghost-btn" onClick={onBack} disabled={pane.historyIndex <= 0}>Back</button>
          <button className="ghost-btn" onClick={onForward} disabled={pane.historyIndex >= pane.history.length - 1}>Forward</button>
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
          <button
            className="refresh-icon-btn"
            onClick={onRefresh}
            disabled={!pane.currentPath || pane.loading}
            aria-label="Refresh pane"
            title="Refresh pane"
          >
            ↻
          </button>
        </div>
        <div className="pane-toolbar-modes">
          <div className="mode-group" role="group" aria-label="Pane mode">
            <button className={pane.mode === 'browse' ? 'mode-btn active' : 'mode-btn'} onClick={() => onSetMode('browse')}>
              Browse
            </button>
            <button className={pane.mode === 'select' ? 'mode-btn active' : 'mode-btn'} onClick={() => onSetMode('select')}>
              Select
            </button>
            <button className={pane.mode === 'search' ? 'mode-btn active' : 'mode-btn'} onClick={() => onSetMode('search')}>
              Search
            </button>
          </div>
          {pane.mode === 'select' && hasSelection && (
            <div className="ops-row">
              <select
                className="target-pane-select"
                value={selectedTargetPaneId}
                onChange={(e) => onSelectTargetPane(e.target.value)}
                aria-label="Target pane"
              >
                <option value="">{targetOptions.length ? 'Choose target pane...' : 'No target pane open'}</option>
                {targetOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.path}</option>
                ))}
              </select>
              <div className="ops-group" role="group" aria-label="Selection operations">
                <button disabled={!canTransfer} onClick={() => onCopySelected(selectedTargetPaneId)}>Copy</button>
                <button disabled={!canTransfer} onClick={() => onMoveSelected(selectedTargetPaneId)}>Move</button>
              </div>
              <button className="danger-btn" onClick={onDeleteSelected}>Delete</button>
            </div>
          )}
        </div>
      </div>
      {pane.mode === 'search' && (
        <div className="search-panel">
          <div className="search-row">
            <label className="search-field">
              <span>Filename</span>
              <input
                value={pane.search.filenameQuery}
                onChange={(e) => onSearchChange({ filenameQuery: e.target.value })}
                placeholder="*"
              />
            </label>
            <label className="search-field search-size">
              <span>Min size (MB)</span>
              <input
                type="number"
                min={0}
                step="0.1"
                value={pane.search.minSizeMb}
                onChange={(e) => onSearchChange({ minSizeMb: e.target.value })}
                placeholder="1"
              />
            </label>
            {!pane.search.running ? (
              <button className="primary-btn" onClick={onStartSearch} disabled={!pane.currentPath}>Start search</button>
            ) : (
              <button className="danger-btn" onClick={onCancelSearch}>Stop search</button>
            )}
          </div>
          {(pane.search.running || pane.search.currentDir) && (
            <div className="search-progress">
              {pane.search.running && (
                <div className="progressbar indeterminate" aria-hidden="true">
                  <span />
                </div>
              )}
              <div className="search-progress-text">
                <strong>Currently searching in:</strong> {pane.search.currentDir ?? pane.currentPath}
              </div>
              <div className="search-progress-meta">
                Scanned directories: {pane.search.scannedDirs} | Matches: {pane.search.matchedCount}
              </div>
            </div>
          )}
          {pane.search.error && <div className="pane-error">{pane.search.error}</div>}
        </div>
      )}
      {pane.loading && <div className="pane-status">Loading...</div>}
      {pane.error && <div className="pane-error">{pane.error}</div>}
      <FileList
        paneId={pane.id}
        entries={pane.items}
        selectionMode={pane.mode === 'select'}
        showPathColumn={pane.mode === 'search'}
        selected={pane.selected}
        highlighted={highlighted}
        onToggleSelect={onToggleSelect}
        onFileClick={onFileClick}
        onNavigate={onNavigate}
        onOpenInNewPane={onOpenInNewPane}
        onDropTarget={onDropTarget}
      />
    </section>
  );
}
