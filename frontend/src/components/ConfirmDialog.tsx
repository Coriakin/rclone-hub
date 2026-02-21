import React from 'react';

type Props = {
  open: boolean;
  title: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({ open, title, message, onCancel, onConfirm }: Props) {
  if (!open) return null;
  return (
    <div className="dialog-backdrop">
      <div className="dialog">
        <h3>{title}</h3>
        <p>{message}</p>
        <div className="dialog-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="danger" onClick={onConfirm}>Confirm</button>
        </div>
      </div>
    </div>
  );
}
