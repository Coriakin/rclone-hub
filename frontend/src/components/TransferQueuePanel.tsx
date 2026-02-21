import React from 'react';
import type { Job } from '../api/client';

type Props = {
  jobs: Job[];
  onCancel: (jobId: string) => void;
};

export function TransferQueuePanel({ jobs, onCancel }: Props) {
  return (
    <aside className="queue-panel">
      <h3>Transfer Queue</h3>
      <div className="queue-items">
        {jobs.map((job) => (
          <div key={job.id} className="queue-item">
            <div className="queue-top">
              <span>{job.operation.toUpperCase()}</span>
              <span className={`status status-${job.status}`}>{job.status}</span>
            </div>
            <div className="queue-meta">{job.sources.length} item(s)</div>
            <div className="queue-meta">{job.destination_dir || 'n/a'}</div>
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
