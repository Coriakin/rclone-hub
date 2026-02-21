import React, { useEffect, useMemo, useState } from 'react';
import type { Job } from '../api/client';

type Props = {
  jobs: Job[];
};

function prettyTs(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

export function DiagnosticsPanel({ jobs }: Props) {
  const [showHistory, setShowHistory] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string>('');
  const visibleJobs = useMemo(() => {
    if (showHistory) return jobs;
    return jobs.filter((job) => job.status === 'queued' || job.status === 'running');
  }, [jobs, showHistory]);

  useEffect(() => {
    if (!visibleJobs.length) {
      setSelectedJobId('');
      return;
    }
    const exists = visibleJobs.some((job) => job.id === selectedJobId);
    if (!exists) {
      setSelectedJobId(visibleJobs[0].id);
    }
  }, [visibleJobs, selectedJobId]);

  const selected = useMemo(() => visibleJobs.find((job) => job.id === selectedJobId), [visibleJobs, selectedJobId]);

  return (
    <aside className="diagnostics-panel">
      <div className="diagnostics-header">
        <div className="panel-head">
          <h3>Diagnostics</h3>
          <label className="panel-toggle">
            <input
              type="checkbox"
              checked={showHistory}
              onChange={(e) => setShowHistory(e.target.checked)}
            />
            Show history
          </label>
        </div>
        <select
          value={selectedJobId}
          onChange={(e) => setSelectedJobId(e.target.value)}
          disabled={!visibleJobs.length}
        >
          {visibleJobs.map((job) => (
            <option key={job.id} value={job.id}>
              {job.operation.toUpperCase()} {job.id.slice(0, 8)} {job.status}
            </option>
          ))}
        </select>
      </div>

      {!selected && <div className="diag-empty">No active diagnostics. Enable history to inspect past jobs.</div>}

      {selected && (
        <>
          <div className="diag-meta">
            <div>Job: {selected.id}</div>
            <div>Status: <span className={`status status-${selected.status}`}>{selected.status}</span></div>
            <div>Items: {selected.sources.length}</div>
          </div>
          <div className="diag-logs">
            {selected.logs.length === 0 && <div className="diag-empty">No logs recorded for this job.</div>}
            {selected.logs.map((log, idx) => (
              <div key={`${selected.id}-${idx}`} className="diag-row">
                <span className="diag-ts">{prettyTs(log.ts)}</span>
                <span className={`diag-level diag-level-${log.level}`}>{log.level}</span>
                <span className="diag-msg">{log.message}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
