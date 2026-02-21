import React from 'react';
import type { Entry } from '../api/client';

type Props = {
  paneId: string;
  entries: Entry[];
  selectionMode: boolean;
  selected: Set<string>;
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
  onToggleSelect,
  onFileClick,
  onNavigate,
  onOpenInNewPane,
  onDropTarget,
}: Props) {
  return (
    <div className="file-list" onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
      e.preventDefault();
      const raw = e.dataTransfer.getData('application/x-rclone-paths');
      if (!raw) return;
      const payload = JSON.parse(raw) as { sources: string[]; sourcePaneId?: string };
      onDropTarget(null, payload.sources, e.altKey, payload.sourcePaneId);
    }}>
      {entries.map((entry) => (
        <div
          key={entry.path}
          className={`file-row ${entry.is_dir ? 'is-dir' : 'is-file'} ${selected.has(entry.path) ? 'is-selected' : ''}`}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-rclone-paths', JSON.stringify({ sources: [entry.path], sourcePaneId: paneId }));
            e.dataTransfer.effectAllowed = 'copyMove';
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const raw = e.dataTransfer.getData('application/x-rclone-paths');
            if (!raw) return;
            const payload = JSON.parse(raw) as { sources: string[]; sourcePaneId?: string };
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
          </button>
        </div>
      ))}
    </div>
  );
}
