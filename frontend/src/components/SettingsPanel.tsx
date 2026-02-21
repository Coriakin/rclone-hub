import React, { useState } from 'react';

type Props = {
  initial: {
    staging_path: string;
    staging_cap_bytes: number;
    concurrency: number;
    verify_mode: 'strict';
  };
  onSave: (v: { staging_path: string; staging_cap_bytes: number; concurrency: number; verify_mode: 'strict' }) => Promise<void>;
};

export function SettingsPanel({ initial, onSave }: Props) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await onSave(value);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-panel">
      <h3>Settings</h3>
      <label>
        Staging path
        <input
          value={value.staging_path}
          onChange={(e) => setValue({ ...value, staging_path: e.target.value })}
        />
      </label>
      <label>
        Staging cap (bytes)
        <input
          type="number"
          value={value.staging_cap_bytes}
          onChange={(e) => setValue({ ...value, staging_cap_bytes: Number(e.target.value) })}
        />
      </label>
      <label>
        Concurrency
        <input
          type="number"
          value={value.concurrency}
          onChange={(e) => setValue({ ...value, concurrency: Number(e.target.value) })}
        />
      </label>
      <button onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save settings'}</button>
    </section>
  );
}
