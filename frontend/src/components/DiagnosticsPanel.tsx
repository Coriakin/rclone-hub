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
  const [selectedJobId, setSelectedJobId] = useState<string>('');

  useEffect(() => {
    if (!jobs.length) {
      setSelectedJobId('');
      return;
    }
    const exists = jobs.some((job) => job.id === selectedJobId);
    if (!exists) {
      setSelectedJobId(jobs[0].id);
    }
  }, [jobs, selectedJobId]);

  const selected = useMemo(() => jobs.find((job) => job.id === selectedJobId), [jobs, selectedJobId]);

  return (
    <aside className="diagnostics-panel">
      <div className="diagnostics-header">
        <h3>Diagnostics</h3>
        <select
          value={selectedJobId}
          onChange={(e) => setSelectedJobId(e.target.value)}
          disabled={!jobs.length}
        >
          {jobs.map((job) => (
            <option key={job.id} value={job.id}>
              {job.operation.toUpperCase()} {job.id.slice(0, 8)} {job.status}
            </option>
          ))}
        </select>
      </div>

      {!selected && <div className="diag-empty">No jobs yet. Run a copy/move/delete to see logs.</div>}

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
