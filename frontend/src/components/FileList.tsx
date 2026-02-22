import React from 'react';
import type { Entry } from '../api/client';

type Props = {
  paneId: string;
  entries: Entry[];
  selectionMode: boolean;
  selected: Set<string>;
  highlighted: Set<string>;
  onToggleSelect: (path: string) => void;
  onFileClick: (path: string) => void;
  onNavigate: (path: string) => void;
  onOpenInNewPane: (path: string) => void;
  onDropTarget: (targetPath: string | null, sources: string[], move: boolean, sourcePaneId?: string) => void;
};

export function FileList({
  paneId,
  entries,
  selectionMode,
  selected,
  highlighted,
  onToggleSelect,
  onFileClick,
  onNavigate,
  onOpenInNewPane,
  onDropTarget,
}: Props) {
  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  function formatSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '-';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = bytes / 1024;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    const precision = size >= 100 ? 0 : size >= 10 ? 1 : 2;
    return `${size.toFixed(precision)} ${units[unitIndex]}`;
  }

  function formatModTime(value?: string): string {
    if (!value) return '-';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '-';
    return dateFormatter.format(parsed);
  }

  function readDropPayload(event: React.DragEvent): { sources: string[]; sourcePaneId?: string } | null {
    const custom = event.dataTransfer.getData('application/x-rclone-paths');
    const fallback = event.dataTransfer.getData('text/plain');
    const raw = custom || fallback;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { sources?: string[]; sourcePaneId?: string };
      if (!Array.isArray(parsed.sources) || parsed.sources.length === 0) return null;
      return { sources: parsed.sources, sourcePaneId: parsed.sourcePaneId };
    } catch {
      return null;
    }
  }

  return (
    <div className="file-list" onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
      e.preventDefault();
      const payload = readDropPayload(e);
      if (!payload) return;
      onDropTarget(null, payload.sources, e.altKey, payload.sourcePaneId);
    }}>
      {entries.map((entry) => (
        <div
          key={entry.path}
          className={`file-row ${entry.is_dir ? 'is-dir' : 'is-file'} ${selected.has(entry.path) ? 'is-selected' : ''} ${highlighted.has(entry.path) ? 'is-arrival' : ''}`}
          draggable
          onDragStart={(e) => {
            const payload = JSON.stringify({ sources: [entry.path], sourcePaneId: paneId });
            e.dataTransfer.setData('application/x-rclone-paths', payload);
            e.dataTransfer.setData('text/plain', payload);
            e.dataTransfer.effectAllowed = 'copyMove';
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const payload = readDropPayload(e);
            if (!payload) return;
            onDropTarget(entry.is_dir ? entry.path : null, payload.sources, e.altKey, payload.sourcePaneId);
          }}
          onDragOver={(e) => {
            if (entry.is_dir) {
              e.preventDefault();
            }
          }}
          onContextMenu={(e) => {
            if (!entry.is_dir) return;
            e.preventDefault();
            onOpenInNewPane(entry.path);
          }}
        >
          {selectionMode && (
            <input
              type="checkbox"
              className="file-checkbox"
              checked={selected.has(entry.path)}
              onChange={() => onToggleSelect(entry.path)}
            />
          )}
          <button className="entry-btn" onClick={() => (entry.is_dir ? onNavigate(entry.path) : onFileClick(entry.path))}>
            <span className={`entry-icon ${entry.is_dir ? 'dir' : 'file'}`} aria-hidden="true" />
            <span className="entry-name">{entry.name || entry.path}</span>
            <span className="entry-kind">{entry.is_dir ? 'Folder' : 'File'}</span>
            <span className="entry-size" title={entry.is_dir ? '' : `${entry.size} bytes`}>
              {entry.is_dir ? '-' : formatSize(entry.size)}
            </span>
            <span className="entry-modified" title={entry.mod_time ?? ''}>
              {formatModTime(entry.mod_time)}
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}
