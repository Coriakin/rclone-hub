import React, { useEffect, useMemo, useState } from 'react';
import {
  api,
  type ConfigSessionQuestion,
  type RemoteConfigField,
  type RemoteConfigSchema,
  type RemoteConfigView,
  type RemoteSummary,
} from '../api/client';

type Mode = 'create' | 'edit';

type Props = {
  onRemotesChanged: () => Promise<void>;
};

type PendingSession = {
  operation: 'create' | 'update';
  name: string;
  type?: string;
  values: Record<string, unknown>;
  question: ConfigSessionQuestion;
};

function normalizeInitialValue(field: RemoteConfigField, raw: string | undefined, forCreate = false): string {
  if (raw !== undefined) return raw;
  if (forCreate && field.sensitive) return '';
  if (field.type === 'bool' && field.default === '') return 'false';
  return field.default ?? '';
}

function coerceFieldValue(field: RemoteConfigField, value: string): unknown {
  if (field.type === 'bool') return value === 'true';
  return value;
}

function buildCreatePayload(fields: RemoteConfigField[], values: Record<string, string>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.name] ?? '';
    if (field.is_password && raw === '') continue;
    if (raw === '') continue;
    payload[field.name] = coerceFieldValue(field, raw);
  }
  return payload;
}

function buildUpdatePayload(fields: RemoteConfigField[], current: Record<string, string>, initial: Record<string, string>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    const next = current[field.name] ?? '';
    const before = initial[field.name] ?? '';
    if (field.is_password) {
      if (next !== '') {
        payload[field.name] = next;
      }
      continue;
    }
    if (next !== before) {
      payload[field.name] = coerceFieldValue(field, next);
    }
  }
  return payload;
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: RemoteConfigField;
  value: string;
  onChange: (next: string) => void;
}) {
  const hasExamples = field.examples.length > 0;
  if (field.type === 'bool') {
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  if (hasExamples) {
    const exampleValues = new Set(field.examples.map((example) => example.value));
    const freeTextAllowed = !field.exclusive;
    const valueIsKnown = exampleValues.has(value);
    return (
      <div className="remote-field-input-with-select">
        <select
          value={valueIsKnown ? value : ''}
          onChange={(event) => {
            const next = event.target.value;
            if (next !== '') onChange(next);
          }}
        >
          <option value="">{freeTextAllowed ? 'Custom value' : 'Select value'}</option>
          {field.examples.map((example) => (
            <option key={example.value} value={example.value}>{example.value}</option>
          ))}
        </select>
        {freeTextAllowed && (
          <input
            type={field.is_password ? 'password' : 'text'}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={field.default || field.name}
          />
        )}
      </div>
    );
  }

  return (
    <input
      type={field.is_password ? 'password' : 'text'}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={field.default || field.name}
    />
  );
}

export function RemoteConfigPanel({ onRemotesChanged }: Props) {
  const [remoteTypes, setRemoteTypes] = useState<RemoteConfigSchema[]>([]);
  const [remotes, setRemotes] = useState<RemoteSummary[]>([]);
  const [activeMode, setActiveMode] = useState<Mode>('edit');
  const [selectedRemoteName, setSelectedRemoteName] = useState<string>('');
  const [selectedRemoteConfig, setSelectedRemoteConfig] = useState<RemoteConfigView | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [editInitialValues, setEditInitialValues] = useState<Record<string, string>>({});
  const [createName, setCreateName] = useState('');
  const [createType, setCreateType] = useState<'b2' | 'drive' | 'smb' | 'crypt'>('b2');
  const [createValues, setCreateValues] = useState<Record<string, string>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [createShowAdvanced, setCreateShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingSession, setPendingSession] = useState<PendingSession | null>(null);
  const [sessionResult, setSessionResult] = useState('');

  const createSchema = useMemo(
    () => remoteTypes.find((entry) => entry.type === createType) ?? null,
    [remoteTypes, createType]
  );

  async function refreshData() {
    setLoading(true);
    setError(null);
    try {
      const [typesRes, remotesRes] = await Promise.all([api.remoteTypes(), api.remotesDetails()]);
      const allowedTypes = ['b2', 'drive', 'smb', 'crypt'];
      const nextTypes = typesRes.types.filter((item) => allowedTypes.includes(item.type));
      const nextRemotes = remotesRes.remotes.filter((item) => allowedTypes.includes(item.type));
      setRemoteTypes(nextTypes);
      setRemotes(nextRemotes);
      if (!selectedRemoteName && nextRemotes.length > 0) {
        setSelectedRemoteName(nextRemotes[0].name);
      } else if (selectedRemoteName && !nextRemotes.some((item) => item.name === selectedRemoteName)) {
        setSelectedRemoteName(nextRemotes[0]?.name ?? '');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshData().catch(console.error);
  }, []);

  useEffect(() => {
    if (!createSchema) return;
    const defaults: Record<string, string> = {};
    for (const field of createSchema.fields) {
      defaults[field.name] = normalizeInitialValue(field, undefined, true);
      if (field.is_password) defaults[field.name] = '';
    }
    setCreateValues(defaults);
  }, [createSchema]);

  useEffect(() => {
    if (!selectedRemoteName) {
      setSelectedRemoteConfig(null);
      setEditValues({});
      setEditInitialValues({});
      return;
    }
    setError(null);
    api.remoteConfig(selectedRemoteName)
      .then((config) => {
        setSelectedRemoteConfig(config);
        const initial: Record<string, string> = {};
        for (const field of config.fields) {
          initial[field.name] = normalizeInitialValue(field, field.value);
          if (field.is_password) initial[field.name] = '';
        }
        setEditInitialValues(initial);
        setEditValues(initial);
      })
      .catch((err) => setError(String(err)));
  }, [selectedRemoteName]);

  async function afterMutation(successMessage: string) {
    setMessage(successMessage);
    await Promise.all([refreshData(), onRemotesChanged()]);
  }

  async function createRemote() {
    if (!createSchema) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const payload = buildCreatePayload(createSchema.fields, createValues);
      if (createType === 'drive') {
        const result = await api.startRemoteConfigSession({
          operation: 'create',
          name: createName,
          type: createType,
          values: payload,
        });
        if (result.done) {
          setCreateName('');
          await afterMutation(`Created remote ${createName}`);
          return;
        }
        if (!result.question) {
          throw new Error('Drive configuration session did not return a question.');
        }
        setPendingSession({
          operation: 'create',
          name: createName,
          type: createType,
          values: payload,
          question: result.question,
        });
        const defaultValue = result.question.option.Default;
        setSessionResult(defaultValue === undefined || defaultValue === null ? '' : String(defaultValue));
        return;
      }
      await api.createRemote({
        name: createName,
        type: createType,
        values: payload,
      });
      setCreateName('');
      await afterMutation(`Created remote ${createName}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function updateRemote() {
    if (!selectedRemoteConfig) return;
    const payload = buildUpdatePayload(selectedRemoteConfig.fields, editValues, editInitialValues);
    if (Object.keys(payload).length === 0) {
      setMessage('No changes to save.');
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      if (selectedRemoteConfig.type === 'drive') {
        const result = await api.startRemoteConfigSession({
          operation: 'update',
          name: selectedRemoteConfig.name,
          values: payload,
        });
        if (result.done) {
          await afterMutation(`Updated remote ${selectedRemoteConfig.name}`);
          return;
        }
        if (!result.question) {
          throw new Error('Drive configuration session did not return a question.');
        }
        setPendingSession({
          operation: 'update',
          name: selectedRemoteConfig.name,
          values: payload,
          question: result.question,
        });
        const defaultValue = result.question.option.Default;
        setSessionResult(defaultValue === undefined || defaultValue === null ? '' : String(defaultValue));
        return;
      }
      await api.updateRemote(selectedRemoteConfig.name, { values: payload });
      await afterMutation(`Updated remote ${selectedRemoteConfig.name}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function deleteRemote() {
    if (!selectedRemoteConfig) return;
    if (!window.confirm(`Delete remote ${selectedRemoteConfig.name}?`)) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await api.deleteRemote(selectedRemoteConfig.name);
      await afterMutation(`Deleted remote ${selectedRemoteConfig.name}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function continueSession() {
    if (!pendingSession) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.continueRemoteConfigSession({
        operation: pendingSession.operation,
        name: pendingSession.name,
        type: pendingSession.type,
        values: pendingSession.values,
        state: pendingSession.question.state,
        result: sessionResult,
      });
      if (result.done) {
        setPendingSession(null);
        setSessionResult('');
        if (pendingSession.operation === 'create') {
          setCreateName('');
          await afterMutation(`Created remote ${pendingSession.name}`);
        } else {
          await afterMutation(`Updated remote ${pendingSession.name}`);
        }
        return;
      }
      if (!result.question) {
        throw new Error('Configuration session did not return a question.');
      }
      setPendingSession({ ...pendingSession, question: result.question });
      const defaultValue = result.question.option.Default;
      setSessionResult(defaultValue === undefined || defaultValue === null ? '' : String(defaultValue));
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="config-mode-shell">
      <div className="config-mode-toolbar">
        <div className="mode-group">
          <button className={activeMode === 'edit' ? 'active' : ''} onClick={() => setActiveMode('edit')}>Configured remotes</button>
          <button className={activeMode === 'create' ? 'active' : ''} onClick={() => setActiveMode('create')}>Create remote</button>
        </div>
        <button className="ghost-btn" onClick={() => refreshData().catch(console.error)} disabled={loading || saving}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {error && <div className="pane-error">{error}</div>}
      {message && <div className="pane-success">{message}</div>}

      {pendingSession && (
        <div className="config-session-card">
          <h3>Configuration question</h3>
          <div className="config-session-help">{pendingSession.question.option.Help || 'Provide a value to continue.'}</div>
          {pendingSession.question.error && <div className="pane-error">{pendingSession.question.error}</div>}
          {pendingSession.question.option.Examples && pendingSession.question.option.Examples.length > 0 ? (
            <select value={sessionResult} onChange={(event) => setSessionResult(event.target.value)}>
              {pendingSession.question.option.Examples.map((example) => (
                <option key={example.Value} value={example.Value}>{example.Value}</option>
              ))}
            </select>
          ) : (
            <input
              type={pendingSession.question.option.IsPassword ? 'password' : 'text'}
              value={sessionResult}
              onChange={(event) => setSessionResult(event.target.value)}
              placeholder={pendingSession.question.option.Name || 'value'}
            />
          )}
          <div className="dialog-actions">
            <button onClick={() => setPendingSession(null)} disabled={saving}>Cancel session</button>
            <button onClick={() => continueSession().catch(console.error)} disabled={saving}>Continue</button>
          </div>
        </div>
      )}

      <div className="config-mode-grid">
        <aside className="config-remote-list">
          <h3>Configured remotes</h3>
          {remotes.length === 0 && <div className="config-muted">No supported remotes configured.</div>}
          {remotes.map((remote) => (
            <button
              key={remote.name}
              className={`config-remote-item ${selectedRemoteName === remote.name ? 'active' : ''}`}
              onClick={() => {
                setActiveMode('edit');
                setSelectedRemoteName(remote.name);
              }}
            >
              <span>{remote.name}</span>
              <small>{remote.type}</small>
            </button>
          ))}
        </aside>

        <div className="config-editor">
          {activeMode === 'create' && (
            <div className="config-card">
              <h3>Create remote</h3>
              <label className="config-field">
                <span>Name</span>
                <input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="my-remote" />
              </label>
              <label className="config-field">
                <span>Type</span>
                <select value={createType} onChange={(event) => setCreateType(event.target.value as 'b2' | 'drive' | 'smb' | 'crypt')}>
                  {remoteTypes.map((type) => (
                    <option key={type.type} value={type.type}>{type.type}</option>
                  ))}
                </select>
              </label>
              <div className="config-advanced-toggle">
                <label>
                  <input
                    type="checkbox"
                    checked={createShowAdvanced}
                    onChange={(event) => setCreateShowAdvanced(event.target.checked)}
                  />
                  Show advanced
                </label>
              </div>
              <div className="config-fields">
                {createSchema?.fields
                  .filter((field) => createShowAdvanced || !field.advanced)
                  .map((field) => (
                    <label key={field.name} className="config-field">
                      <span>
                        {field.name}
                        {field.required ? ' *' : ''}
                      </span>
                      <FieldInput
                        field={field}
                        value={createValues[field.name] ?? ''}
                        onChange={(next) => setCreateValues((prev) => ({ ...prev, [field.name]: next }))}
                      />
                      {field.help && <small>{field.help}</small>}
                    </label>
                  ))}
              </div>
              <div className="dialog-actions">
                <button onClick={() => createRemote().catch(console.error)} disabled={saving || !createName.trim()}>
                  {saving ? 'Creating...' : 'Create remote'}
                </button>
              </div>
            </div>
          )}

          {activeMode === 'edit' && (
            <div className="config-card">
              <h3>{selectedRemoteConfig ? `Edit ${selectedRemoteConfig.name}` : 'Select a remote'}</h3>
              {selectedRemoteConfig && (
                <>
                  <div className="config-muted">Type: {selectedRemoteConfig.type}</div>
                  <div className="config-advanced-toggle">
                    <label>
                      <input type="checkbox" checked={showAdvanced} onChange={(event) => setShowAdvanced(event.target.checked)} />
                      Show advanced
                    </label>
                  </div>
                  <div className="config-fields">
                    {selectedRemoteConfig.fields
                      .filter((field) => showAdvanced || !field.advanced)
                      .map((field) => (
                        <label key={field.name} className="config-field">
                          <span>
                            {field.name}
                            {field.required ? ' *' : ''}
                          </span>
                          <FieldInput
                            field={field}
                            value={editValues[field.name] ?? ''}
                            onChange={(next) => setEditValues((prev) => ({ ...prev, [field.name]: next }))}
                          />
                          {field.help && <small>{field.help}</small>}
                        </label>
                      ))}
                  </div>
                  <div className="dialog-actions">
                    <button onClick={() => updateRemote().catch(console.error)} disabled={saving}>
                      {saving ? 'Saving...' : 'Save changes'}
                    </button>
                    <button className="danger" onClick={() => deleteRemote().catch(console.error)} disabled={saving}>
                      Delete remote
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
