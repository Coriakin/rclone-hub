import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Job } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DiagnosticsPanel } from '../components/DiagnosticsPanel';
import { Pane } from '../components/Pane';
import { SettingsPanel } from '../components/SettingsPanel';
import { TransferQueuePanel } from '../components/TransferQueuePanel';
import type { PaneState } from '../state/types';

let paneCounter = 0;

function newPane(path = ''): PaneState {
  paneCounter += 1;
  return {
    id: `pane-${paneCounter}`,
    currentPath: path,
    history: path ? [path] : [],
    historyIndex: path ? 0 : -1,
    items: [],
    mode: 'browse',
    selected: new Set<string>(),
    loading: false,
  };
}

export function App() {
  const [openTabs, setOpenTabs] = useState<{ queue: boolean; settings: boolean; diagnostics: boolean }>({
    queue: true,
    settings: false,
    diagnostics: true,
  });
  const [remotes, setRemotes] = useState<string[]>([]);
  const [panes, setPanes] = useState<PaneState[]>([newPane('')]);
  const [activePaneId, setActivePaneId] = useState<string>('pane-1');
  const [jobs, setJobs] = useState<Job[]>([]);
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

  const activePane = useMemo(() => panes.find((p) => p.id === activePaneId), [panes, activePaneId]);

  async function refreshRemotes() {
    const r = await api.remotes();
    setRemotes(r.remotes);
    if (!activePane?.currentPath && r.remotes[0]) {
      navigatePane(activePaneId, r.remotes[0]);
    }
  }

  async function refreshJobs() {
    const j = await api.jobs();
    setJobs(j.jobs);
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
    return () => {
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

  async function loadPane(path: string, paneId: string) {
    setPanes((prev) => prev.map((p) => p.id === paneId ? { ...p, loading: true, error: undefined } : p));
    try {
      const data = await api.list(path);
      setPanes((prev) => prev.map((p) => p.id === paneId ? { ...p, loading: false, items: data.items, currentPath: path } : p));
    } catch (error) {
      setPanes((prev) => prev.map((p) => p.id === paneId ? { ...p, loading: false, error: String(error) } : p));
    }
  }

  function navigatePane(paneId: string, path: string, pushHistory = true) {
    setPanes((prev) => prev.map((p) => {
      if (p.id !== paneId) return p;
      const nextHistory = pushHistory ? [...p.history.slice(0, p.historyIndex + 1), path] : p.history;
      const nextIndex = pushHistory ? nextHistory.length - 1 : p.historyIndex;
      return { ...p, currentPath: path, history: nextHistory, historyIndex: nextIndex, selected: new Set<string>() };
    }));
    loadPane(path, paneId).catch(console.error);
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
      navigatePane(active.id, path);
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
        <h1>rclone hub</h1>
        <button onClick={addPane}>Add pane</button>
        <div className="remotes">
          {remotes.map((remote) => (
            <button key={remote} className="remote-btn" onClick={() => openRemoteInActivePane(remote)}>
              {remote}
            </button>
          ))}
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
              onPathSubmit={(path) => navigatePane(pane.id, path)}
              onNavigate={(path) => navigatePane(pane.id, path)}
              onBack={() => {
                if (pane.historyIndex <= 0) return;
                const idx = pane.historyIndex - 1;
                const path = pane.history[idx];
                setPanes((prev) => prev.map((p) => p.id === pane.id ? { ...p, historyIndex: idx } : p));
                loadPane(path, pane.id).catch(console.error);
              }}
              onForward={() => {
                if (pane.historyIndex >= pane.history.length - 1) return;
                const idx = pane.historyIndex + 1;
                const path = pane.history[idx];
                setPanes((prev) => prev.map((p) => p.id === pane.id ? { ...p, historyIndex: idx } : p));
                loadPane(path, pane.id).catch(console.error);
              }}
              onToggleSelectionMode={() => setPanes((prev) => prev.map((p) => p.id === pane.id ? {
                ...p,
                mode: p.mode === 'select' ? 'browse' : 'select',
                selected: new Set<string>(),
              } : p))}
              onToggleSelect={(path) => setPanes((prev) => prev.map((p) => {
                if (p.id !== pane.id) return p;
                const next = new Set(p.selected);
                if (next.has(path)) next.delete(path); else next.add(path);
                return { ...p, selected: next };
              }))}
              onFileClick={(path) => setPanes((prev) => prev.map((p) => {
                if (p.id !== pane.id) return p;
                if (p.mode === 'browse') {
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
            <button className={openTabs.queue ? 'active' : ''} onClick={() => toggleRightTab('queue')}>Queue</button>
            <button className={openTabs.settings ? 'active' : ''} onClick={() => toggleRightTab('settings')}>Settings</button>
            <button className={openTabs.diagnostics ? 'active' : ''} onClick={() => toggleRightTab('diagnostics')}>Diagnostics</button>
          </div>
          {(openTabs.queue || openTabs.settings || openTabs.diagnostics) && (
            <div className="drawer-content">
              {openTabs.queue && (
                <TransferQueuePanel jobs={jobs} onCancel={(id) => api.cancel(id).then(refreshJobs).catch(console.error)} />
              )}
              {openTabs.settings && settings && (
                <SettingsPanel initial={settings} onSave={async (s) => {
                  await api.saveSettings(s);
                  await loadSettings();
                }} />
              )}
              {openTabs.diagnostics && <DiagnosticsPanel jobs={jobs} />}
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
