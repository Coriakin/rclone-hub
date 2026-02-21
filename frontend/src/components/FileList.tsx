import React from 'react';
import type { Entry } from '../api/client';

type Props = {
  entries: Entry[];
  selectionMode: boolean;
  selected: Set<string>;
  onToggleSelect: (path: string) => void;
  onNavigate: (path: string) => void;
  onDropTarget: (targetPath: string | null, sources: string[], move: boolean) => void;
};

export function FileList({ entries, selectionMode, selected, onToggleSelect, onNavigate, onDropTarget }: Props) {
  return (
    <div className="file-list" onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
      e.preventDefault();
      const raw = e.dataTransfer.getData('application/x-rclone-paths');
      if (!raw) return;
      const payload = JSON.parse(raw) as { sources: string[] };
      onDropTarget(null, payload.sources, e.altKey);
    }}>
      {entries.map((entry) => (
        <div
          key={entry.path}
          className="file-row"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-rclone-paths', JSON.stringify({ sources: [entry.path] }));
            e.dataTransfer.effectAllowed = 'copyMove';
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const raw = e.dataTransfer.getData('application/x-rclone-paths');
            if (!raw) return;
            const payload = JSON.parse(raw) as { sources: string[] };
            onDropTarget(entry.is_dir ? entry.path : null, payload.sources, e.altKey);
          }}
          onDragOver={(e) => {
            if (entry.is_dir) {
              e.preventDefault();
            }
          }}
        >
          {selectionMode && (
            <input
              type="checkbox"
              checked={selected.has(entry.path)}
              onChange={() => onToggleSelect(entry.path)}
            />
          )}
          <button className="entry-btn" onClick={() => entry.is_dir && onNavigate(entry.path)}>
            <span>{entry.is_dir ? '[DIR]' : '[FILE]'}</span>
            <span>{entry.name || entry.path}</span>
          </button>
        </div>
      ))}
    </div>
  );
}
