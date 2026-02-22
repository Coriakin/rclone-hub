import React, { useMemo, useState } from 'react';
import type { Entry } from '../api/client';

type Props = {
  paneId: string;
  entries: Entry[];
  selectionMode: boolean;
  showPathColumn?: boolean;
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
  showPathColumn = false,
  selected,
  highlighted,
  onToggleSelect,
  onFileClick,
  onNavigate,
  onOpenInNewPane,
  onDropTarget,
}: Props) {
  const [sortKey, setSortKey] = useState<'size' | 'mod_time' | 'path' | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

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

  function toggleSort(nextKey: 'size' | 'mod_time' | 'path') {
    if (sortKey !== nextKey) {
      setSortKey(nextKey);
      setSortDir('asc');
      return;
    }
    setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
  }

  const sortedEntries = useMemo(() => {
    if (!sortKey) return entries;
    const direction = sortDir === 'asc' ? 1 : -1;
    return [...entries].sort((a, b) => {
      if (sortKey === 'size') {
        const av = a.is_dir ? null : a.size;
        const bv = b.is_dir ? null : b.size;
        if (av === null && bv === null) return a.name.localeCompare(b.name);
        if (av === null) return 1;
        if (bv === null) return -1;
        if (av !== bv) return (av - bv) * direction;
        return a.name.localeCompare(b.name);
      }
      if (sortKey === 'path') {
        const ap = parentPath(a).toLowerCase();
        const bp = parentPath(b).toLowerCase();
        if (ap !== bp) return ap.localeCompare(bp) * direction;
        return a.name.localeCompare(b.name);
      }
      const at = a.mod_time ? Date.parse(a.mod_time) : Number.NaN;
      const bt = b.mod_time ? Date.parse(b.mod_time) : Number.NaN;
      const aMissing = Number.isNaN(at);
      const bMissing = Number.isNaN(bt);
      if (aMissing && bMissing) return a.name.localeCompare(b.name);
      if (aMissing) return 1;
      if (bMissing) return -1;
      if (at !== bt) return (at - bt) * direction;
      return a.name.localeCompare(b.name);
    });
  }, [entries, sortDir, sortKey]);

  function parentPath(entry: Entry): string {
    if (entry.parent_path) return entry.parent_path;
    if (!entry.path.includes(':')) return '';
    const [remote, rel] = entry.path.split(':', 2);
    const normalized = rel.replace(/^\/+|\/+$/g, '');
    if (!normalized) return `${remote}:`;
    const parts = normalized.split('/');
    if (parts.length <= 1) return `${remote}:`;
    return `${remote}:${parts.slice(0, -1).join('/')}`;
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
      <div className="file-header">
        {selectionMode && <span className="file-header-check" />}
        <div className={`file-header-main ${showPathColumn ? 'with-path' : ''}`}>
          <span className="file-header-icon" />
          <span className="file-header-name">Name</span>
          {showPathColumn && (
            <button className="file-header-btn file-header-path" onClick={() => toggleSort('path')}>
              Path{sortKey === 'path' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
            </button>
          )}
          <span className="file-header-kind">Type</span>
          <button className="file-header-btn" onClick={() => toggleSort('size')}>
            Size{sortKey === 'size' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
          </button>
          <button className="file-header-btn" onClick={() => toggleSort('mod_time')}>
            Modified{sortKey === 'mod_time' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
          </button>
        </div>
      </div>
      {sortedEntries.map((entry) => (
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
          <button className={`entry-btn ${showPathColumn ? 'with-path' : ''}`} onClick={() => (entry.is_dir ? onNavigate(entry.path) : onFileClick(entry.path))}>
            <span className={`entry-icon ${entry.is_dir ? 'dir' : 'file'}`} aria-hidden="true" />
            <span className="entry-name">{entry.name || entry.path}</span>
            {showPathColumn && <span className="entry-path" title={parentPath(entry)}>{parentPath(entry)}</span>}
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
