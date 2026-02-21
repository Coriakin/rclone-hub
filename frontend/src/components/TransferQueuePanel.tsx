import React, { useMemo, useState } from 'react';
import type { Job } from '../api/client';

type Props = {
  jobs: Job[];
  onCancel: (jobId: string) => void;
};

function transferRoute(job: Job): { label: string; kind: 'direct' | 'fallback' | 'pending' } {
  const logMessages = job.logs.map((log) => log.message.toLowerCase());
  const fallbackSeen = logMessages.some((msg) =>
    msg.includes('trying fallback') || msg.includes('fallback-pull') || msg.includes('fallback-push'));
  const directSeen = logMessages.some((msg) => msg.includes('direct-copy'));
  const fallbackInResults = job.results.some((result) => result.fallback_used);

  if (fallbackSeen || fallbackInResults) {
    return { label: 'Fallback (via local staging)', kind: 'fallback' };
  }
  if (job.status === 'queued' && !directSeen) {
    return { label: 'Pending', kind: 'pending' };
  }
  return { label: 'Direct', kind: 'direct' };
}

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
            {(() => {
              const route = transferRoute(job);
              return (
                <div className={`queue-route queue-route-${route.kind}`}>
                  {route.label}
                </div>
              );
            })()}
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
            {(job.status === 'queued' || job.status === 'running') && (
              <button onClick={() => onCancel(job.id)}>Cancel</button>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
