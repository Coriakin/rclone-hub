import React, { useMemo, useState } from 'react';
import type { Job } from '../api/client';

type Props = {
  jobs: Job[];
  onCancel: (jobId: string) => void;
};

export function TransferQueuePanel({ jobs, onCancel }: Props) {
  const [showHistory, setShowHistory] = useState(false);
  const visibleJobs = useMemo(() => {
    if (showHistory) return jobs;
    return jobs.filter((job) => job.status === 'queued' || job.status === 'running');
  }, [jobs, showHistory]);

  return (
    <aside className="queue-panel">
      <div className="panel-head">
        <h3>Transfer Queue</h3>
        <label className="panel-toggle">
          <input
            type="checkbox"
            checked={showHistory}
            onChange={(e) => setShowHistory(e.target.checked)}
          />
          Show history
        </label>
      </div>
      <div className="queue-items">
        {visibleJobs.length === 0 && (
          <div className="diag-empty">No active transfers.</div>
        )}
        {visibleJobs.map((job) => (
          <div key={job.id} className="queue-item">
            <div className="queue-top">
              <span>{job.operation.toUpperCase()}</span>
              <span className={`status status-${job.status}`}>{job.status}</span>
            </div>
            <div className="queue-meta">{job.sources.length} item(s)</div>
            <div className="queue-meta">{job.destination_dir || 'n/a'}</div>
            {(() => {
              const progressLog = [...job.logs].reverse().find((log) => log.message.startsWith('progress '));
              if (!progressLog) return null;
              const pctMatch = progressLog.message.match(/(\d{1,3})%/);
              const pct = pctMatch ? Number(pctMatch[1]) : null;
              return (
                <div className="queue-progress">
                  <div className="queue-progress-text">{progressLog.message}</div>
                  {pct !== null && (
                    <div className="queue-progress-bar" aria-label={`Progress ${pct}%`}>
                      <div className="queue-progress-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
                    </div>
                  )}
                </div>
              );
            })()}
            {job.results.some((r) => r.fallback_used) && <div className="fallback">fallback used</div>}
            {(job.status === 'queued' || job.status === 'running') && (
              <button onClick={() => onCancel(job.id)}>Cancel</button>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
