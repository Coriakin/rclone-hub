import React, { useEffect, useMemo, useState } from 'react';
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
    selectionMode: false,
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
  const [settings, setSettings] = useState<{ staging_path: string; staging_cap_bytes: number; concurrency: number; verify_mode: 'strict' } | null>(null);

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

  function targetPaneIdFrom(sourcePaneId: string): string | null {
    const other = panes.find((p) => p.id !== sourcePaneId);
    return other?.id ?? null;
  }

  async function transferSelected(sourcePaneId: string, move: boolean) {
    const sourcePane = panes.find((p) => p.id === sourcePaneId);
    if (!sourcePane) return;
    const targetId = targetPaneIdFrom(sourcePaneId);
    if (!targetId) return;
    const targetPane = panes.find((p) => p.id === targetId);
    if (!targetPane?.currentPath) return;

    const sources = Array.from(sourcePane.selected);
    if (!sources.length) return;

    if (move) {
      await api.move(sources, targetPane.currentPath);
    } else {
      await api.copy(sources, targetPane.currentPath);
    }
    await refreshJobs();
  }

  async function handleDrop(sourcePaneId: string, targetPath: string | null, sources: string[], move: boolean) {
    const pane = panes.find((p) => p.id === sourcePaneId);
    if (!pane) return;
    const dest = targetPath ?? pane.currentPath;
    if (!dest) return;
    if (move) await api.move(sources, dest);
    else await api.copy(sources, dest);
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

  function addPaneWithPath(path: string) {
    const reusable = panes.find((pane) => !pane.currentPath && pane.history.length === 0);
    if (reusable) {
      setActivePaneId(reusable.id);
      navigatePane(reusable.id, path);
      return;
    }
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
            <button key={remote} className="remote-btn" onClick={() => addPaneWithPath(remote)}>
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
              onToggleSelectionMode={() => setPanes((prev) => prev.map((p) => p.id === pane.id ? { ...p, selectionMode: !p.selectionMode, selected: new Set<string>() } : p))}
              onToggleSelect={(path) => setPanes((prev) => prev.map((p) => {
                if (p.id !== pane.id) return p;
                const next = new Set(p.selected);
                if (next.has(path)) next.delete(path); else next.add(path);
                return { ...p, selected: next };
              }))}
              onCopySelected={() => transferSelected(pane.id, false).catch(console.error)}
              onMoveSelected={() => transferSelected(pane.id, true).catch(console.error)}
              onDeleteSelected={() => setConfirmDelete({ open: true, paneId: pane.id })}
              onDropTarget={(targetPath, sources, move) => handleDrop(pane.id, targetPath, sources, move).catch(console.error)}
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
          await api.del(Array.from(pane.selected));
          setConfirmDelete({ open: false, paneId: null });
          await refreshJobs();
        }}
      />
    </div>
  );
}
