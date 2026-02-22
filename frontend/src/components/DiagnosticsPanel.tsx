import React, { useMemo, useState } from 'react';
import type { Job } from '../api/client';

export type DiagnosticsLog = {
  ts: string;
  level: 'info' | 'warning' | 'error' | 'debug';
  source: string;
  message: string;
};

type Props = {
  jobs: Job[];
  logs?: DiagnosticsLog[];
};

const DIAG_CLEAR_KEY = 'rcloneHub.diagnostics.clearAfterKey';

function prettyTs(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString();
}

type ConsoleRow = {
  ts: string;
  orderKey: string;
  line: string;
  level: 'info' | 'warning' | 'error' | 'debug';
};

function normalizeLevel(level?: string): 'info' | 'warning' | 'error' | 'debug' {
  if (level === 'warning' || level === 'error' || level === 'debug') return level;
  return 'info';
}

function toConsoleRows(jobs: Job[]): ConsoleRow[] {
  const rows: ConsoleRow[] = [];
  for (const job of jobs) {
    const op = job.operation.toUpperCase();
    const id = job.id.slice(0, 8);
    rows.push({
      ts: job.created_at,
      orderKey: `${job.created_at}-000-${job.id}`,
      line: `[${prettyTs(job.created_at)}] [INFO] [${op}/${id}] job created sources=${job.sources.length}${job.destination_dir ? ` destination=${job.destination_dir}` : ''}`,
      level: 'info',
    });

    for (const [idx, log] of job.logs.entries()) {
      const level = normalizeLevel(log.level);
      rows.push({
        ts: log.ts,
        orderKey: `${log.ts}-${String(idx).padStart(4, '0')}-${job.id}`,
        line: `[${prettyTs(log.ts)}] [${level.toUpperCase()}] [${op}/${id}] ${log.message}`,
        level,
      });
    }

    if (job.status !== 'queued' && job.status !== 'running') {
      const failures = job.results.filter((r) => r.status !== 'success').length;
      const success = job.results.length - failures;
      const terminalLevel = failures > 0 || job.status === 'failed' ? 'error' : 'info';
      const lastTs = job.logs[job.logs.length - 1]?.ts ?? job.created_at;
      rows.push({
        ts: lastTs,
        orderKey: `${lastTs}-999-${job.id}`,
        line: `[${prettyTs(lastTs)}] [${terminalLevel.toUpperCase()}] [${op}/${id}] job ${job.status} success=${success} failed=${failures}`,
        level: terminalLevel,
      });
    }
  }
  return rows.sort((a, b) => a.orderKey.localeCompare(b.orderKey));
}

function toSearchRows(logs: DiagnosticsLog[]): ConsoleRow[] {
  return logs.map((log, idx) => ({
    ts: log.ts,
    orderKey: `${log.ts}-${String(idx).padStart(4, '0')}-search-${log.source}`,
    line: `[${prettyTs(log.ts)}] [${log.level.toUpperCase()}] [${log.source}] ${log.message}`,
    level: log.level,
  }));
}

export function DiagnosticsPanel({ jobs, logs = [] }: Props) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [clearAfterKey, setClearAfterKey] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(DIAG_CLEAR_KEY);
    } catch {
      return null;
    }
  });
  const allRows = useMemo(
    () => [...toConsoleRows(jobs), ...toSearchRows(logs)].sort((a, b) => a.orderKey.localeCompare(b.orderKey)),
    [jobs, logs]
  );
  const rows = useMemo(() => {
    if (!clearAfterKey) return allRows;
    return allRows.filter((row) => row.orderKey > clearAfterKey);
  }, [allRows, clearAfterKey]);
  const fullText = useMemo(() => rows.map((row) => row.line).join('\n'), [rows]);

  async function onCopyAll() {
    try {
      await navigator.clipboard.writeText(fullText);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    } finally {
      window.setTimeout(() => setCopyState('idle'), 1400);
    }
  }

  function onClear() {
    const last = allRows[allRows.length - 1];
    if (!last) return;
    setClearAfterKey(last.orderKey);
    try {
      window.localStorage.setItem(DIAG_CLEAR_KEY, last.orderKey);
    } catch {
      // Ignore storage failures and keep in-memory behavior.
    }
    setCopyState('idle');
  }

  return (
    <aside className="diagnostics-panel">
      <div className="panel-head">
        <h3>Diagnostics Console</h3>
        <div className="diag-actions">
          <button onClick={onClear} disabled={!allRows.length}>Clear</button>
          <button onClick={onCopyAll} disabled={!rows.length}>
            {copyState === 'idle' && 'Copy all'}
            {copyState === 'copied' && 'Copied'}
            {copyState === 'error' && 'Copy failed'}
          </button>
        </div>
      </div>
      <div className="diag-summary">{rows.length} lines across {jobs.length} jobs and {logs.length} search events</div>
      <div className="diag-logs" role="log" aria-live="polite">
        {rows.length === 0 && <div className="diag-empty">No operations yet.</div>}
        {rows.map((row, idx) => (
          <div key={`${row.orderKey}-${idx}`} className={`diag-line diag-level-${row.level}`}>
            {row.line}
          </div>
        ))}
      </div>
    </aside>
  );
}
