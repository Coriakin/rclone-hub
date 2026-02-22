import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Job, type SearchEvent } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DiagnosticsPanel, type DiagnosticsLog } from '../components/DiagnosticsPanel';
import { Pane } from '../components/Pane';
import { SettingsPanel } from '../components/SettingsPanel';
import { TransferQueuePanel } from '../components/TransferQueuePanel';
import type { PaneState } from '../state/types';

let paneCounter = 0;
const APPEARANCE_KEY = 'rcloneHub.appearance';
type Appearance = 'light' | 'dark';

function newPane(path = ''): PaneState {
  paneCounter += 1;
  return {
    id: `pane-${paneCounter}`,
    currentPath: path,
    history: path ? [path] : [],
    historyIndex: path ? 0 : -1,
    items: [],
    mode: 'browse',
    search: {
      filenameQuery: '*',
      minSizeMb: '',
      running: false,
      scannedDirs: 0,
      matchedCount: 0,
      eventCursor: 0,
    },
    selected: new Set<string>(),
    loading: false,
  };
}

export function App() {
  const [appearance, setAppearance] = useState<Appearance>(() => {
    try {
      const saved = window.localStorage.getItem(APPEARANCE_KEY);
      return saved === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  const [openTabs, setOpenTabs] = useState<{ queue: boolean; settings: boolean; diagnostics: boolean }>({
    queue: true,
    settings: false,
    diagnostics: false,
  });
  const [remotes, setRemotes] = useState<string[]>([]);
  const [panes, setPanes] = useState<PaneState[]>([newPane('')]);
  const [activePaneId, setActivePaneId] = useState<string>('pane-1');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [diagnosticsLogs, setDiagnosticsLogs] = useState<DiagnosticsLog[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ open: boolean; paneId: string | null }>({ open: false, paneId: null });
  const [confirmDrop, setConfirmDrop] = useState<{
    open: boolean;
    targetPaneId: string | null;
    targetPath: string | null;
    sources: string[];
  }>({
    open: false,
    targetPaneId: null,
    targetPath: null,
    sources: [],
  });
  const [settings, setSettings] = useState<{ staging_path: string; staging_cap_bytes: number; concurrency: number; verify_mode: 'strict' } | null>(null);
  const [targetPaneBySourcePane, setTargetPaneBySourcePane] = useState<Record<string, string>>({});
  const [highlightedByPane, setHighlightedByPane] = useState<Record<string, string[]>>({});
  const pendingTransferTargetsRef = useRef<Record<string, { targetPaneId: string }>>({});
  const processedTransferJobsRef = useRef<Set<string>>(new Set());
  const highlightTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const panesRef = useRef<PaneState[]>(panes);

  const activePane = useMemo(() => panes.find((p) => p.id === activePaneId), [panes, activePaneId]);

  async function refreshRemotes() {
    const r = await api.remotes();
    setRemotes(r.remotes);
    if (!activePane?.currentPath && r.remotes[0]) {
      navigatePane(activePaneId, r.remotes[0]).catch(console.error);
    }
  }

  async function refreshJobs() {
    const j = await api.jobs();
    setJobs(j.jobs);
  }

  function pushDiagnostics(level: DiagnosticsLog['level'], source: string, message: string) {
    const item: DiagnosticsLog = {
      ts: new Date().toISOString(),
      level,
      source,
      message,
    };
    setDiagnosticsLogs((prev) => {
      const next = [...prev, item];
      if (next.length > 1200) {
        return next.slice(next.length - 1200);
      }
      return next;
    });
  }

  async function loadSettings() {
    const s = await api.settings();
    setSettings(s as { staging_path: string; staging_cap_bytes: number; concurrency: number; verify_mode: 'strict' });
  }

  useEffect(() => {
    refreshRemotes().catch(console.error);
    refreshJobs().catch(console.error);
    loadSettings().catch(console.error);
    const id = setInterval(() => {
      refreshJobs().catch(console.error);
    }, 1500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    panesRef.current = panes;
  }, [panes]);

  useEffect(() => {
    document.documentElement.dataset.theme = appearance;
    try {
      window.localStorage.setItem(APPEARANCE_KEY, appearance);
    } catch {
      // Ignore storage failures.
    }
  }, [appearance]);

  useEffect(() => {
    return () => {
      for (const pane of panesRef.current) {
        if (pane.search.searchId) {
          api.cancelSearch(pane.search.searchId).catch(() => undefined);
        }
      }
      Object.values(highlightTimersRef.current).forEach((timer) => clearTimeout(timer));
    };
  }, []);

  useEffect(() => {
    for (const job of jobs) {
      const pending = pendingTransferTargetsRef.current[job.id];
      if (!pending) continue;
      if (processedTransferJobsRef.current.has(job.id)) continue;
      if (job.status === 'queued' || job.status === 'running') continue;

      processedTransferJobsRef.current.add(job.id);
      const targetPane = panes.find((pane) => pane.id === pending.targetPaneId);
      if (targetPane?.currentPath) {
        loadPane(targetPane.currentPath, targetPane.id).catch(console.error);
      }

      const arrivedPaths = job.results
        .filter((result) => result.status === 'success' && !!result.destination)
        .map((result) => result.destination as string);

      if (arrivedPaths.length > 0) {
        setHighlightedByPane((prev) => {
          const existing = prev[pending.targetPaneId] ?? [];
          const merged = Array.from(new Set([...existing, ...arrivedPaths]));
          return { ...prev, [pending.targetPaneId]: merged };
        });

        for (const path of arrivedPaths) {
          const timerKey = `${pending.targetPaneId}|${path}`;
          const existingTimer = highlightTimersRef.current[timerKey];
          if (existingTimer) {
            clearTimeout(existingTimer);
          }
          highlightTimersRef.current[timerKey] = setTimeout(() => {
            setHighlightedByPane((prev) => {
              const current = prev[pending.targetPaneId] ?? [];
              const next = current.filter((item) => item !== path);
              if (next.length === current.length) return prev;
              if (!next.length) {
                const { [pending.targetPaneId]: _removed, ...rest } = prev;
                return rest;
              }
              return { ...prev, [pending.targetPaneId]: next };
            });
            delete highlightTimersRef.current[timerKey];
          }, 4500);
        }
      }

      delete pendingTransferTargetsRef.current[job.id];
    }
  }, [jobs, panes]);

  async function waitForJobTerminal(jobId: string, timeoutMs = 30000): Promise<Job | null> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const job = await api.job(jobId);
      if (job.status !== 'queued' && job.status !== 'running') {
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    return null;
  }

  function getPane(paneId: string) {
    return panesRef.current.find((p) => p.id === paneId);
  }

  function setPaneMode(paneId: string, mode: 'browse' | 'select' | 'search') {
    setPanes((prev) => prev.map((p) => p.id === paneId ? {
      ...p,
      mode,
      selected: mode === 'select' ? p.selected : new Set<string>(),
    } : p));
  }

  function clearPaneSearchRuntime(paneId: string, error?: string) {
    setPanes((prev) => prev.map((p) => p.id === paneId ? {
      ...p,
      search: {
        ...p.search,
        running: false,
        searchId: undefined,
        currentDir: undefined,
        scannedDirs: 0,
        eventCursor: 0,
        error,
      },
    } : p));
  }

  async function cancelPaneSearch(paneId: string) {
    const pane = getPane(paneId);
    if (!pane?.search.searchId) {
      clearPaneSearchRuntime(paneId);
      return;
    }
    const searchId = pane.search.searchId;
    clearPaneSearchRuntime(paneId);
    try {
      await api.cancelSearch(searchId);
      pushDiagnostics('warning', `SEARCH/${searchId.slice(0, 8)}`, `pane=${paneId} cancel requested`);
    } catch {
      // Ignore cancel races when search was already completed/removed.
    }
  }

  function applySearchEvents(paneId: string, events: SearchEvent[], nextSeq: number) {
    function parentPath(path: string): string {
      if (!path.includes(':')) return '';
      const [remote, rel] = path.split(':', 2);
      const normalized = rel.replace(/^\/+|\/+$/g, '');
      if (!normalized) return `${remote}:`;
      const parts = normalized.split('/');
      if (parts.length <= 1) return `${remote}:`;
      return `${remote}:${parts.slice(0, -1).join('/')}`;
    }

    setPanes((prev) => prev.map((p) => {
      if (p.id !== paneId) return p;
      const nextItems = [...p.items];
      let currentDir = p.search.currentDir;
      let scannedDirs = p.search.scannedDirs;
      let matchedCount = p.search.matchedCount;
      let running = p.search.running;
      let error = p.search.error;
      for (const event of events) {
        if (event.type === 'progress') {
          currentDir = event.current_dir;
          scannedDirs = event.scanned_dirs;
          matchedCount = event.matched_count;
          continue;
        }
        if (event.type === 'result') {
          nextItems.push(event.entry);
          currentDir = event.entry.parent_path ?? parentPath(event.entry.path);
          continue;
        }
        scannedDirs = event.scanned_dirs;
        matchedCount = event.matched_count;
        running = false;
        if (event.status === 'failed') {
          error = event.error ?? 'Search failed';
        } else {
          error = undefined;
        }
      }
      return {
        ...p,
        items: nextItems,
        search: {
          ...p.search,
          currentDir,
          scannedDirs,
          matchedCount,
          running,
          error,
          eventCursor: nextSeq,
        },
      };
    }));
  }

  async function pollSearch(paneId: string, searchId: string) {
    let cursor = 0;
    const source = `SEARCH/${searchId.slice(0, 8)}`;
    while (true) {
      const pane = getPane(paneId);
      const hasDifferentSearchId = !!pane?.search.searchId && pane.search.searchId !== searchId;
      if (!pane || pane.mode !== 'search' || hasDifferentSearchId) {
        try {
          await api.cancelSearch(searchId);
        } catch {
          // Ignore cancellation races.
        }
        return;
      }

      try {
        const payload = await api.searchEvents(searchId, cursor);
        const latest = getPane(paneId);
        if (!latest || latest.search.searchId !== searchId) {
          return;
        }
        for (const event of payload.events) {
          if (event.type === 'progress') {
            pushDiagnostics('info', source, `pane=${paneId} scanning=${event.current_dir} scanned_dirs=${event.scanned_dirs} matched=${event.matched_count}`);
          } else if (event.type === 'result') {
            pushDiagnostics('debug', source, `pane=${paneId} match=${event.entry.path}`);
          } else if (event.status === 'failed') {
            pushDiagnostics('error', source, `pane=${paneId} search failed scanned_dirs=${event.scanned_dirs} matched=${event.matched_count} error=${event.error ?? 'unknown'}`);
          } else if (event.status === 'cancelled') {
            pushDiagnostics('warning', source, `pane=${paneId} search cancelled scanned_dirs=${event.scanned_dirs} matched=${event.matched_count}`);
          } else {
            pushDiagnostics('info', source, `pane=${paneId} search complete scanned_dirs=${event.scanned_dirs} matched=${event.matched_count}`);
          }
        }
        applySearchEvents(paneId, payload.events, payload.next_seq);
        cursor = payload.next_seq;
        if (payload.done) {
          return;
        }
      } catch (error) {
        pushDiagnostics('error', source, `pane=${paneId} search poll error: ${String(error)}`);
        clearPaneSearchRuntime(paneId, String(error));
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 220));
    }
  }

  async function startPaneSearch(paneId: string) {
    const pane = getPane(paneId);
    if (!pane?.currentPath) return;
    await cancelPaneSearch(paneId);

    const minSizeRaw = pane.search.minSizeMb.trim();
    const parsedMinSizeMb = minSizeRaw ? Number(minSizeRaw) : Number.NaN;
    if (minSizeRaw && (!Number.isFinite(parsedMinSizeMb) || parsedMinSizeMb < 0)) {
      clearPaneSearchRuntime(paneId, 'Min size must be a non-negative number.');
      return;
    }
    const minSizeMb = minSizeRaw ? parsedMinSizeMb : null;

    setPanes((prev) => prev.map((p) => p.id === paneId ? {
      ...p,
      items: [],
      error: undefined,
      search: {
        ...p.search,
        running: true,
        scannedDirs: 0,
        matchedCount: 0,
        currentDir: undefined,
        error: undefined,
        eventCursor: 0,
      },
    } : p));

    try {
      const created = await api.startSearch({
        root_path: pane.currentPath,
        filename_query: pane.search.filenameQuery || '*',
        min_size_mb: minSizeMb,
      });
      pushDiagnostics(
        'info',
        `SEARCH/${created.search_id.slice(0, 8)}`,
        `pane=${paneId} search started root=${pane.currentPath} query=${pane.search.filenameQuery || '*'} min_size_mb=${minSizeMb ?? 'none'}`
      );
      setPanes((prev) => prev.map((p) => p.id === paneId ? {
        ...p,
        search: { ...p.search, searchId: created.search_id, running: true },
      } : p));
      pollSearch(paneId, created.search_id).catch(console.error);
    } catch (error) {
      pushDiagnostics('error', `SEARCH/${paneId}`, `pane=${paneId} failed to start search: ${String(error)}`);
      clearPaneSearchRuntime(paneId, String(error));
    }
  }

  async function loadPane(path: string, paneId: string) {
    setPanes((prev) => prev.map((p) => p.id === paneId ? { ...p, loading: true, error: undefined } : p));
    try {
      const data = await api.list(path);
      setPanes((prev) => prev.map((p) => p.id === paneId ? { ...p, loading: false, items: data.items, currentPath: path } : p));
    } catch (error) {
      setPanes((prev) => prev.map((p) => p.id === paneId ? { ...p, loading: false, error: String(error) } : p));
    }
  }

  async function navigatePane(paneId: string, path: string, pushHistory = true) {
    await cancelPaneSearch(paneId);
    setPanes((prev) => prev.map((p) => {
      if (p.id !== paneId) return p;
      const nextHistory = pushHistory ? [...p.history.slice(0, p.historyIndex + 1), path] : p.history;
      const nextIndex = pushHistory ? nextHistory.length - 1 : p.historyIndex;
      return { ...p, mode: 'browse', currentPath: path, history: nextHistory, historyIndex: nextIndex, selected: new Set<string>() };
    }));
    await loadPane(path, paneId);
  }

  async function transferSelected(sourcePaneId: string, targetPaneId: string, move: boolean) {
    const sourcePane = panes.find((p) => p.id === sourcePaneId);
    if (!sourcePane) return;
    const targetPane = panes.find((p) => p.id === targetPaneId);
    if (!targetPane?.currentPath) return;

    const sources = Array.from(sourcePane.selected);
    if (!sources.length) return;

    const job = move
      ? await api.move(sources, targetPane.currentPath)
      : await api.copy(sources, targetPane.currentPath);
    pendingTransferTargetsRef.current[job.id] = { targetPaneId };
    await refreshJobs();
  }

  function handleDrop(targetPaneId: string, targetPath: string | null, sources: string[], _move: boolean, dragSourcePaneId?: string) {
    const pane = panes.find((p) => p.id === targetPaneId);
    if (!pane) return;

    const samePaneDrop = dragSourcePaneId === targetPaneId;
    if (samePaneDrop && !targetPath) {
      return;
    }

    const dest = targetPath ?? pane.currentPath;
    if (!dest) return;
    if (samePaneDrop && sources.includes(dest)) {
      return;
    }

    setConfirmDrop({ open: true, targetPaneId, targetPath, sources });
  }

  async function executeDrop(move: boolean) {
    if (!confirmDrop.targetPaneId) return;
    const pane = panes.find((p) => p.id === confirmDrop.targetPaneId);
    if (!pane) return;
    const dest = confirmDrop.targetPath ?? pane.currentPath;
    if (!dest || confirmDrop.sources.length === 0) return;

    const job = move ? await api.move(confirmDrop.sources, dest) : await api.copy(confirmDrop.sources, dest);
    const targetPaneId = confirmDrop.targetPaneId;
    pendingTransferTargetsRef.current[job.id] = { targetPaneId };
    setConfirmDrop({ open: false, targetPaneId: null, targetPath: null, sources: [] });
    await refreshJobs();
  }

  function addPane() {
    const pane = newPane(remotes[0] || '');
    setPanes((prev) => [...prev, pane]);
    setActivePaneId(pane.id);
    if (pane.currentPath) {
      loadPane(pane.currentPath, pane.id).catch(console.error);
    }
  }

  function openRemoteInActivePane(path: string) {
    const active = panes.find((pane) => pane.id === activePaneId);
    if (active) {
      navigatePane(active.id, path).catch(console.error);
      return;
    }
    const pane = newPane(path);
    setPanes((prev) => [...prev, pane]);
    setActivePaneId(pane.id);
    loadPane(path, pane.id).catch(console.error);
  }

  function openPathInNewPane(path: string) {
    const pane = newPane(path);
    setPanes((prev) => [...prev, pane]);
    setActivePaneId(pane.id);
    loadPane(path, pane.id).catch(console.error);
  }

  function closePane(paneId: string) {
    cancelPaneSearch(paneId).catch(console.error);
    setPanes((prev) => prev.filter((p) => p.id !== paneId));
    if (activePaneId === paneId) {
      const next = panes.find((p) => p.id !== paneId);
      if (next) setActivePaneId(next.id);
    }
  }

  function toggleRightTab(tab: 'queue' | 'settings' | 'diagnostics') {
    setOpenTabs((prev) => ({ ...prev, [tab]: !prev[tab] }));
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-title">
          <h1>rclone hub</h1>
        </div>
        <div className="topbar-controls">
          <button className="primary-btn" onClick={addPane}>Add pane</button>
          <div className="remotes">
            {remotes.map((remote) => (
              <button key={remote} className="remote-btn" onClick={() => openRemoteInActivePane(remote)}>
                {remote}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="main-grid">
        <section className={`panes-row ${openTabs.queue || openTabs.settings || openTabs.diagnostics ? 'with-drawer' : ''}`}>
          {panes.map((pane) => (
            <Pane
              key={pane.id}
              pane={pane}
              isActive={pane.id === activePaneId}
              highlighted={new Set(highlightedByPane[pane.id] ?? [])}
              targetOptions={panes
                .filter((p) => p.id !== pane.id && !!p.currentPath)
                .map((p) => ({ id: p.id, path: p.currentPath }))}
              selectedTargetPaneId={(() => {
                const options = panes
                  .filter((p) => p.id !== pane.id && !!p.currentPath)
                  .map((p) => p.id);
                const selected = targetPaneBySourcePane[pane.id];
                if (selected && options.includes(selected)) return selected;
                if (options.length === 1) return options[0];
                return '';
              })()}
              onSelectTargetPane={(targetId) => setTargetPaneBySourcePane((prev) => ({ ...prev, [pane.id]: targetId }))}
              onActivate={() => setActivePaneId(pane.id)}
              onPathSubmit={(path) => navigatePane(pane.id, path).catch(console.error)}
              onRefresh={async () => {
                if (!pane.currentPath) return;
                await cancelPaneSearch(pane.id);
                setPaneMode(pane.id, 'browse');
                await loadPane(pane.currentPath, pane.id);
              }}
              onNavigate={(path) => navigatePane(pane.id, path).catch(console.error)}
              onBack={async () => {
                if (pane.historyIndex <= 0) return;
                const idx = pane.historyIndex - 1;
                const path = pane.history[idx];
                await cancelPaneSearch(pane.id);
                setPanes((prev) => prev.map((p) => p.id === pane.id ? { ...p, historyIndex: idx } : p));
                setPaneMode(pane.id, 'browse');
                await loadPane(path, pane.id);
              }}
              onForward={async () => {
                if (pane.historyIndex >= pane.history.length - 1) return;
                const idx = pane.historyIndex + 1;
                const path = pane.history[idx];
                await cancelPaneSearch(pane.id);
                setPanes((prev) => prev.map((p) => p.id === pane.id ? { ...p, historyIndex: idx } : p));
                setPaneMode(pane.id, 'browse');
                await loadPane(path, pane.id);
              }}
              onSetMode={async (mode) => {
                const current = getPane(pane.id);
                if (current?.mode === mode) return;
                if (mode !== 'search') {
                  await cancelPaneSearch(pane.id);
                }
                setPaneMode(pane.id, mode);
                if (current?.mode === 'search' && current.currentPath && mode !== 'search') {
                  await loadPane(current.currentPath, pane.id);
                }
              }}
              onSearchChange={(patch) => setPanes((prev) => prev.map((p) => p.id === pane.id ? {
                ...p,
                search: { ...p.search, ...patch },
              } : p))}
              onStartSearch={() => startPaneSearch(pane.id).catch(console.error)}
              onCancelSearch={() => cancelPaneSearch(pane.id).catch(console.error)}
              onToggleSelect={(path) => setPanes((prev) => prev.map((p) => {
                if (p.id !== pane.id) return p;
                const next = new Set(p.selected);
                if (next.has(path)) next.delete(path); else next.add(path);
                return { ...p, selected: next };
              }))}
              onFileClick={(path) => setPanes((prev) => prev.map((p) => {
                if (p.id !== pane.id) return p;
                if (p.mode === 'browse' || p.mode === 'search') {
                  return { ...p, mode: 'select', selected: new Set<string>([path]) };
                }
                const next = new Set(p.selected);
                if (next.has(path)) next.delete(path); else next.add(path);
                return { ...p, selected: next };
              }))}
              onOpenInNewPane={(path) => openPathInNewPane(path)}
              onCopySelected={(targetId) => transferSelected(pane.id, targetId, false).catch(console.error)}
              onMoveSelected={(targetId) => transferSelected(pane.id, targetId, true).catch(console.error)}
              onDeleteSelected={() => setConfirmDelete({ open: true, paneId: pane.id })}
              onDropTarget={(targetPath, sources, move, sourcePaneId) =>
                handleDrop(pane.id, targetPath, sources, move, sourcePaneId)}
              onClose={() => closePane(pane.id)}
            />
          ))}
        </section>
        <aside className={`right-drawer ${openTabs.queue || openTabs.settings || openTabs.diagnostics ? 'open' : ''}`}>
          <div className="drawer-tabs">
            <button className={openTabs.queue ? 'active' : ''} onClick={() => toggleRightTab('queue')}>
              <span>Queue</span>
            </button>
            <button className={openTabs.settings ? 'active' : ''} onClick={() => toggleRightTab('settings')}>
              <span>Settings</span>
            </button>
            <button className={openTabs.diagnostics ? 'active' : ''} onClick={() => toggleRightTab('diagnostics')}>
              <span>Diagnostics</span>
            </button>
          </div>
          {(openTabs.queue || openTabs.settings || openTabs.diagnostics) && (
            <div className="drawer-content">
              {openTabs.queue && (
                <TransferQueuePanel jobs={jobs} onCancel={(id) => api.cancel(id).then(refreshJobs).catch(console.error)} />
              )}
              {openTabs.settings && settings && (
                <SettingsPanel
                  initial={settings}
                  appearance={appearance}
                  onAppearanceChange={setAppearance}
                  onSave={async (s) => {
                    await api.saveSettings(s);
                    await loadSettings();
                  }}
                />
              )}
              {openTabs.diagnostics && <DiagnosticsPanel jobs={jobs} logs={diagnosticsLogs} />}
            </div>
          )}
        </aside>
      </main>

      <ConfirmDialog
        open={confirmDelete.open}
        title="Confirm delete"
        message="Delete selected items? This cannot be undone."
        onCancel={() => setConfirmDelete({ open: false, paneId: null })}
        onConfirm={async () => {
          const pane = panes.find((p) => p.id === confirmDelete.paneId);
          if (!pane) return;
          const deleteJob = await api.del(Array.from(pane.selected));
          await waitForJobTerminal(deleteJob.id);
          setConfirmDelete({ open: false, paneId: null });
          setPanes((prev) => prev.map((p) => p.id === pane.id ? { ...p, selected: new Set<string>() } : p));
          await loadPane(pane.currentPath, pane.id);
          await refreshJobs();
        }}
      />

      {confirmDrop.open && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <h3>Choose transfer action</h3>
            <p>
              {confirmDrop.sources.length} item(s) dropped.
              {' '}
              Destination:
              {' '}
              {(confirmDrop.targetPath ?? panes.find((p) => p.id === confirmDrop.targetPaneId)?.currentPath) || 'unknown'}
            </p>
            <div className="dialog-actions">
              <button onClick={() => setConfirmDrop({ open: false, targetPaneId: null, targetPath: null, sources: [] })}>
                Cancel
              </button>
              <button onClick={() => executeDrop(false).catch(console.error)}>Copy</button>
              <button onClick={() => executeDrop(true).catch(console.error)}>Move</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
