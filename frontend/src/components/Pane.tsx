import React, { useEffect, useState } from 'react';
import type { Entry } from '../api/client';
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
  onStartEmptyDirSearch: () => void;
  onCancelSearch: () => void;
  onToggleSelect: (path: string) => void;
  onFileClick: (path: string) => void;
  onContextAction: (entry: Entry, x: number, y: number) => void;
  highlighted: Set<string>;
  onDropTarget: (targetPath: string | null, sources: string[], move: boolean, sourcePaneId?: string) => void;
  onRegisterDragPayload: (sources: string[], sourcePaneId: string) => void;
  getRegisteredDragPayload: () => { sources: string[]; sourcePaneId?: string } | null;
  onClearRegisteredDragPayload: () => void;
  onClose: () => void;
  interactionsDisabled?: boolean;
  onCancelSizeCalculation: () => void;
  onDismissSizeResult: () => void;
  formatSize: (bytes: number) => string;
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
  onStartEmptyDirSearch,
  onCancelSearch,
  onToggleSelect,
  onFileClick,
  onContextAction,
  highlighted,
  onDropTarget,
  onRegisterDragPayload,
  getRegisteredDragPayload,
  onClearRegisteredDragPayload,
  onClose,
  interactionsDisabled = false,
  onCancelSizeCalculation,
  onDismissSizeResult,
  formatSize,
}: Props) {
  const hasSizeOverlay = pane.sizeCalc.running || !!pane.sizeCalc.doneStatus || !!pane.sizeCalc.error;
  const hasSearchOverlay = pane.search.running;
  const [pathDraft, setPathDraft] = useState(pane.currentPath);

  useEffect(() => {
    setPathDraft(pane.currentPath);
  }, [pane.currentPath]);

  return (
    <section
      className={`pane ${isActive ? 'active' : ''} ${interactionsDisabled || hasSizeOverlay || hasSearchOverlay ? 'pane-locked' : ''}`}
      onClick={onActivate}
      onDragOver={(e) => {
        if (interactionsDisabled) return;
        e.preventDefault();
      }}
      onDrop={(e) => {
        if (interactionsDisabled) return;
        e.preventDefault();
        const payload = getRegisteredDragPayload();
        if (!payload) return;
        onDropTarget(null, payload.sources, e.altKey, payload.sourcePaneId);
        onClearRegisteredDragPayload();
      }}
    >
      <div className="pane-toolbar">
        <div className="pane-toolbar-main">
          <button className="close-icon-btn" onClick={onClose} aria-label="Close pane" title="Close pane" disabled={interactionsDisabled}>X</button>
          <button className="ghost-btn" onClick={onBack} disabled={pane.historyIndex <= 0 || interactionsDisabled}>Back</button>
          <button className="ghost-btn" onClick={onForward} disabled={pane.historyIndex >= pane.history.length - 1 || interactionsDisabled}>Forward</button>
          <form onSubmit={(e) => {
            e.preventDefault();
            if (interactionsDisabled) return;
            const nextPath = pathDraft.trim();
            if (!nextPath) return;
            onPathSubmit(nextPath);
          }}>
            <input
              name="path"
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              disabled={interactionsDisabled}
            />
          </form>
          <button
            className="refresh-icon-btn"
            onClick={onRefresh}
            disabled={!pane.currentPath || pane.loading || interactionsDisabled}
            aria-label="Refresh pane"
            title="Refresh pane"
          >
            ↻
          </button>
        </div>
        <div className="pane-toolbar-modes">
          <div className="mode-group" role="group" aria-label="Pane mode">
            <button className={pane.mode === 'browse' ? 'mode-btn active' : 'mode-btn'} onClick={() => onSetMode('browse')} disabled={interactionsDisabled}>
              Browse
            </button>
            <button className={pane.mode === 'select' ? 'mode-btn active' : 'mode-btn'} onClick={() => onSetMode('select')} disabled={interactionsDisabled}>
              Select
            </button>
            <button className={pane.mode === 'search' ? 'mode-btn active' : 'mode-btn'} onClick={() => onSetMode('search')} disabled={interactionsDisabled}>
              Search
            </button>
          </div>
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
                disabled={interactionsDisabled}
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
                disabled={interactionsDisabled}
              />
            </label>
            {!pane.search.running ? (
              <button className="primary-btn" onClick={onStartSearch} disabled={!pane.currentPath || interactionsDisabled}>Start search</button>
            ) : (
              <button className="danger-btn" onClick={onCancelSearch} disabled={interactionsDisabled}>Stop search</button>
            )}
          </div>
          <details className="search-advanced">
            <summary>Advanced</summary>
            <div className="search-advanced-body">
              <button
                className="ghost-btn"
                onClick={onStartEmptyDirSearch}
                disabled={!pane.currentPath || interactionsDisabled || pane.search.running}
              >
                Find empty directories
              </button>
              <div className="search-advanced-note">
                Runs a dedicated empty-directory scan and ignores filename and min-size filters.
              </div>
            </div>
          </details>
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
        directorySizes={pane.directorySizes}
        interactionsDisabled={interactionsDisabled}
        selectionMode={pane.mode === 'select'}
        showPathColumn={pane.mode === 'search'}
        selected={pane.selected}
        highlighted={highlighted}
        onToggleSelect={onToggleSelect}
        onFileClick={onFileClick}
        onNavigate={onNavigate}
        onContextAction={onContextAction}
        onDropTarget={onDropTarget}
        onRegisterDragPayload={onRegisterDragPayload}
        getRegisteredDragPayload={getRegisteredDragPayload}
        onClearRegisteredDragPayload={onClearRegisteredDragPayload}
      />
      {hasSizeOverlay && (
        <div className="pane-operation-overlay" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <div className="pane-operation-card">
            <h4>Calculating folder size</h4>
            <p>
              Current directory:
              {' '}
              {pane.sizeCalc.currentDir ?? pane.currentPath}
            </p>
            <p>
              Scanned directories:
              {' '}
              {pane.sizeCalc.scannedDirs}
              {' '}
              | Files:
              {' '}
              {pane.sizeCalc.filesCount}
              {' '}
              | Total:
              {' '}
              {formatSize(pane.sizeCalc.bytesTotal)}
            </p>
            {pane.sizeCalc.error && <div className="pane-error">{pane.sizeCalc.error}</div>}
            {pane.sizeCalc.doneStatus && !pane.sizeCalc.running && !pane.sizeCalc.error && (
              <div className="pane-status">
                {pane.sizeCalc.doneStatus === 'success' ? 'Calculation complete.' : 'Calculation cancelled.'}
              </div>
            )}
            <div className="dialog-actions">
              {pane.sizeCalc.running ? (
                <button className="danger-btn" onClick={onCancelSizeCalculation}>Cancel</button>
              ) : (
                <button onClick={onDismissSizeResult}>Close</button>
              )}
            </div>
          </div>
        </div>
      )}
      {hasSearchOverlay && (
        <div className="pane-operation-overlay" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <div className="pane-operation-card">
            <h4>{pane.search.mode === 'empty_dirs' ? 'Finding empty directories' : 'Searching'}</h4>
            <p>
              Current directory:
              {' '}
              {pane.search.currentDir ?? pane.currentPath}
            </p>
            <p>
              Scanned directories:
              {' '}
              {pane.search.scannedDirs}
              {' '}
              | Matches:
              {' '}
              {pane.search.matchedCount}
            </p>
            {pane.search.error && <div className="pane-error">{pane.search.error}</div>}
            <div className="dialog-actions">
              <button className="danger-btn" onClick={onCancelSearch}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
