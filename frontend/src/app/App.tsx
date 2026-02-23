import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Entry, type Job, type SearchEvent, type SizeEvent } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DiagnosticsPanel, type DiagnosticsLog } from '../components/DiagnosticsPanel';
import { Pane } from '../components/Pane';
import { SettingsPanel } from '../components/SettingsPanel';
import { TransferQueuePanel } from '../components/TransferQueuePanel';
import type { PaneState } from '../state/types';

let paneCounter = 0;
const APPEARANCE_KEY = 'rcloneHub.appearance';
type Appearance = 'light' | 'dark';
const PREVIEWABLE_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif']);

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
      mode: 'standard',
      running: false,
      scannedDirs: 0,
      matchedCount: 0,
      eventCursor: 0,
    },
    sizeCalc: {
      running: false,
      targetPath: undefined,
      scannedDirs: 0,
      filesCount: 0,
      bytesTotal: 0,
      eventCursor: 0,
    },
    directorySizes: {},
    lockedOperation: null,
    selected: new Set<string>(),
    loading: false,
  };
}

export function App() {
  const initialPane = useMemo(() => newPane(''), []);
  const [isDesktopWide, setIsDesktopWide] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
    return window.matchMedia('(min-width: 1281px)').matches;
  });
  const [appearance, setAppearance] = useState<Appearance>(() => {
    try {
      const saved = window.localStorage.getItem(APPEARANCE_KEY);
      return saved === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  const [openTabs, setOpenTabs] = useState<{ queue: boolean; settings: boolean; diagnostics: boolean }>({
    queue: false,
    settings: false,
    diagnostics: false,
  });
  const [remotes, setRemotes] = useState<string[]>([]);
  const [panes, setPanes] = useState<PaneState[]>([initialPane]);
  const [activePaneId, setActivePaneId] = useState<string>(initialPane.id);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [diagnosticsLogs, setDiagnosticsLogs] = useState<DiagnosticsLog[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ open: boolean; paneId: string | null; sources?: string[] }>({ open: false, paneId: null });
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
  const [imagePreview, setImagePreview] = useState<{ open: boolean; remotePath: string; fileName: string; paneId: string | null }>({
    open: false,
    remotePath: '',
    fileName: '',
    paneId: null,
  });
  const [imagePreviewLoading, setImagePreviewLoading] = useState<boolean>(false);
  const [imagePreviewError, setImagePreviewError] = useState<string | null>(null);
  const [targetPaneBySourcePane, setTargetPaneBySourcePane] = useState<Record<string, string>>({});
  const [highlightedByPane, setHighlightedByPane] = useState<Record<string, string[]>>({});
  const [contextMenu, setContextMenu] = useState<{ open: boolean; paneId: string | null; entry: Entry | null; x: number; y: number }>({
    open: false,
    paneId: null,
    entry: null,
    x: 0,
    y: 0,
  });
  const [renameDialog, setRenameDialog] = useState<{
    open: boolean;
    paneId: string | null;
    sourcePath: string;
    currentName: string;
    nextName: string;
    error?: string;
    saving: boolean;
  }>({
    open: false,
    paneId: null,
    sourcePath: '',
    currentName: '',
    nextName: '',
    saving: false,
  });
  const pendingTransferTargetsRef = useRef<Record<string, { targetPaneId: string }>>({});
  const processedTransferJobsRef = useRef<Set<string>>(new Set());
  const highlightTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const panesRef = useRef<PaneState[]>(panes);
  const hasActiveTransfers = useMemo(
    () => jobs.some((job) => job.status === 'queued' || job.status === 'running'),
    [jobs]
  );
  const prevHasActiveTransfersRef = useRef<boolean>(hasActiveTransfers);

  async function refreshRemotes() {
    const r = await api.remotes();
    setRemotes(r.remotes);
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
    if (!panes.length) return;
    if (!panes.some((pane) => pane.id === activePaneId)) {
      setActivePaneId(panes[0].id);
    }
  }, [panes, activePaneId]);

  useEffect(() => {
    document.documentElement.dataset.theme = appearance;
    try {
      window.localStorage.setItem(APPEARANCE_KEY, appearance);
    } catch {
      // Ignore storage failures.
    }
  }, [appearance]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(min-width: 1281px)');
    setIsDesktopWide(media.matches);
    const onChange = (event: MediaQueryListEvent) => {
      setIsDesktopWide(event.matches);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const hadActiveTransfers = prevHasActiveTransfersRef.current;
    if (isDesktopWide && !hadActiveTransfers && hasActiveTransfers) {
      setOpenTabs({ queue: true, settings: false, diagnostics: false });
    } else if (isDesktopWide && hadActiveTransfers && !hasActiveTransfers) {
      setOpenTabs((prev) => ({ ...prev, queue: false }));
    }
    prevHasActiveTransfersRef.current = hasActiveTransfers;
  }, [hasActiveTransfers, isDesktopWide]);

  useEffect(() => {
    return () => {
      for (const pane of panesRef.current) {
        if (pane.search.searchId) {
          api.cancelSearch(pane.search.searchId).catch(() => undefined);
        }
        if (pane.sizeCalc.sizeId) {
          api.cancelSize(pane.sizeCalc.sizeId).catch(() => undefined);
        }
      }
      Object.values(highlightTimersRef.current).forEach((timer) => clearTimeout(timer));
    };
  }, []);

  useEffect(() => {
    if (!imagePreview.open && !contextMenu.open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (contextMenu.open) {
          setContextMenu({ open: false, paneId: null, entry: null, x: 0, y: 0 });
          return;
        }
        if (imagePreview.open) {
          setImagePreview({ open: false, remotePath: '', fileName: '', paneId: null });
          setImagePreviewLoading(false);
          setImagePreviewError(null);
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [contextMenu.open, imagePreview.open]);

  useEffect(() => {
    if (!contextMenu.open) return;
    function onPointerDown() {
      setContextMenu({ open: false, paneId: null, entry: null, x: 0, y: 0 });
    }
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [contextMenu.open]);

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
      lockedOperation: p.lockedOperation === 'search' ? null : p.lockedOperation,
      search: {
        ...p.search,
        running: false,
        searchId: undefined,
        currentDir: undefined,
        scannedDirs: 0,
        matchedCount: 0,
        eventCursor: 0,
        error,
      },
    } : p));
  }

  function clearPaneSizeRuntime(
    paneId: string,
    patch?: Partial<{
      error: string | undefined;
      doneStatus: 'success' | 'cancelled' | 'failed' | undefined;
      keepResult: boolean;
    }>
  ) {
    const keepResult = patch?.keepResult ?? false;
    setPanes((prev) => prev.map((p) => p.id === paneId ? {
      ...p,
      lockedOperation: null,
      sizeCalc: {
        running: false,
        sizeId: undefined,
        targetPath: keepResult ? p.sizeCalc.targetPath : undefined,
        currentDir: keepResult ? p.sizeCalc.currentDir : undefined,
        scannedDirs: keepResult ? p.sizeCalc.scannedDirs : 0,
        filesCount: keepResult ? p.sizeCalc.filesCount : 0,
        bytesTotal: keepResult ? p.sizeCalc.bytesTotal : 0,
        eventCursor: keepResult ? p.sizeCalc.eventCursor : 0,
        error: patch?.error,
        doneStatus: patch?.doneStatus,
      },
    } : p));
  }

  async function cancelPaneSize(paneId: string) {
    const pane = getPane(paneId);
    if (!pane?.sizeCalc.sizeId) {
      clearPaneSizeRuntime(paneId);
      return;
    }
    const sizeId = pane.sizeCalc.sizeId;
    clearPaneSizeRuntime(paneId, { doneStatus: 'cancelled' });
    try {
      await api.cancelSize(sizeId);
      pushDiagnostics('warning', `SIZE/${sizeId.slice(0, 8)}`, `pane=${paneId} cancel requested`);
    } catch {
      // Ignore cancel races when session was already completed/removed.
    }
  }

  function applySizeEvents(paneId: string, events: SizeEvent[], nextSeq: number) {
    setPanes((prev) => prev.map((p) => {
      if (p.id !== paneId) return p;
      let currentDir = p.sizeCalc.currentDir;
      let scannedDirs = p.sizeCalc.scannedDirs;
      let filesCount = p.sizeCalc.filesCount;
      let bytesTotal = p.sizeCalc.bytesTotal;
      let running = p.sizeCalc.running;
      let error = p.sizeCalc.error;
      let doneStatus = p.sizeCalc.doneStatus;
      let directorySizes = p.directorySizes;
      let items = p.items;
      for (const event of events) {
        if (event.type === 'progress') {
          currentDir = event.current_dir;
          scannedDirs = event.scanned_dirs;
          filesCount = event.files_count;
          bytesTotal = event.bytes_total;
          continue;
        }
        scannedDirs = event.scanned_dirs;
        filesCount = event.files_count;
        bytesTotal = event.bytes_total;
        running = false;
        doneStatus = event.status;
        error = event.status === 'failed' ? (event.error ?? 'Size calculation failed') : undefined;
        if (event.status === 'success' && p.sizeCalc.targetPath) {
          directorySizes = { ...directorySizes, [p.sizeCalc.targetPath]: event.bytes_total };
          items = items.map((item) => item.path === p.sizeCalc.targetPath
            ? { ...item, size: event.bytes_total }
            : item);
        }
      }
      return {
        ...p,
        directorySizes,
        items,
        lockedOperation: running ? 'size_calc' : null,
        sizeCalc: {
          ...p.sizeCalc,
          currentDir,
          scannedDirs,
          filesCount,
          bytesTotal,
          running,
          error,
          doneStatus,
          eventCursor: nextSeq,
        },
      };
    }));
  }

  async function pollSize(paneId: string, sizeId: string) {
    let cursor = 0;
    const source = `SIZE/${sizeId.slice(0, 8)}`;
    while (true) {
      const pane = getPane(paneId);
      if (!pane) {
        try {
          await api.cancelSize(sizeId);
        } catch {
          // Ignore cancellation races.
        }
        return;
      }
      const hasDifferentSizeId = !!pane.sizeCalc.sizeId && pane.sizeCalc.sizeId !== sizeId;
      if (pane.lockedOperation !== 'size_calc' || hasDifferentSizeId) {
        try {
          await api.cancelSize(sizeId);
        } catch {
          // Ignore cancellation races.
        }
        return;
      }

      try {
        const payload = await api.sizeEvents(sizeId, cursor);
        const latest = getPane(paneId);
        if (!latest || latest.sizeCalc.sizeId !== sizeId) {
          return;
        }
        for (const event of payload.events) {
          if (event.type === 'progress') {
            pushDiagnostics('info', source, `pane=${paneId} scanning=${event.current_dir} scanned_dirs=${event.scanned_dirs} files=${event.files_count} bytes=${event.bytes_total}`);
          } else if (event.status === 'failed') {
            pushDiagnostics('error', source, `pane=${paneId} size failed scanned_dirs=${event.scanned_dirs} files=${event.files_count} bytes=${event.bytes_total} error=${event.error ?? 'unknown'}`);
          } else if (event.status === 'cancelled') {
            pushDiagnostics('warning', source, `pane=${paneId} size cancelled scanned_dirs=${event.scanned_dirs} files=${event.files_count} bytes=${event.bytes_total}`);
          } else {
            pushDiagnostics('info', source, `pane=${paneId} size complete scanned_dirs=${event.scanned_dirs} files=${event.files_count} bytes=${event.bytes_total}`);
          }
        }
        applySizeEvents(paneId, payload.events, payload.next_seq);
        cursor = payload.next_seq;
        if (payload.done) {
          return;
        }
      } catch (error) {
        pushDiagnostics('error', source, `pane=${paneId} size poll error: ${String(error)}`);
        clearPaneSizeRuntime(paneId, { error: String(error), doneStatus: 'failed', keepResult: true });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 220));
    }
  }

  async function startPaneSizeCalculation(paneId: string, rootPath: string) {
    const pane = getPane(paneId);
    if (!pane || pane.lockedOperation) return;
    setPanes((prev) => prev.map((p) => p.id === paneId ? {
      ...p,
      lockedOperation: 'size_calc',
      sizeCalc: {
        running: true,
        sizeId: undefined,
        targetPath: rootPath,
        currentDir: rootPath,
        scannedDirs: 0,
        filesCount: 0,
        bytesTotal: 0,
        eventCursor: 0,
        error: undefined,
        doneStatus: undefined,
      },
    } : p));

    try {
      const created = await api.startSize({ root_path: rootPath });
      pushDiagnostics('info', `SIZE/${created.size_id.slice(0, 8)}`, `pane=${paneId} size started root=${rootPath}`);
      setPanes((prev) => prev.map((p) => p.id === paneId ? {
        ...p,
        lockedOperation: 'size_calc',
        sizeCalc: { ...p.sizeCalc, running: true, sizeId: created.size_id, targetPath: rootPath, currentDir: rootPath },
      } : p));
      pollSize(paneId, created.size_id).catch(console.error);
    } catch (error) {
      pushDiagnostics('error', `SIZE/${paneId}`, `pane=${paneId} failed to start size calculation: ${String(error)}`);
      clearPaneSizeRuntime(paneId, { error: String(error), doneStatus: 'failed', keepResult: true });
    }
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
        lockedOperation: running ? 'search' : (p.lockedOperation === 'search' ? null : p.lockedOperation),
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
      if (!pane || pane.mode !== 'search' || !pane.search.running || hasDifferentSearchId) {
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

  async function startPaneSearch(paneId: string, searchMode: 'standard' | 'empty_dirs' = 'standard') {
    const pane = getPane(paneId);
    if (!pane?.currentPath || pane.search.running || pane.sizeCalc.running) return;
    await cancelPaneSearch(paneId);

    let minSizeMb: number | null = null;
    if (searchMode !== 'empty_dirs') {
      const minSizeRaw = pane.search.minSizeMb.trim();
      const parsedMinSizeMb = minSizeRaw ? Number(minSizeRaw) : Number.NaN;
      if (minSizeRaw && (!Number.isFinite(parsedMinSizeMb) || parsedMinSizeMb < 0)) {
        clearPaneSearchRuntime(paneId, 'Min size must be a non-negative number.');
        return;
      }
      minSizeMb = minSizeRaw ? parsedMinSizeMb : null;
    }

    setPanes((prev) => prev.map((p) => p.id === paneId ? {
      ...p,
      items: [],
      error: undefined,
      lockedOperation: 'search',
      search: {
        ...p.search,
        mode: searchMode,
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
        filename_query: searchMode === 'empty_dirs' ? '*' : (pane.search.filenameQuery || '*'),
        min_size_mb: minSizeMb,
        search_mode: searchMode,
      });
      pushDiagnostics(
        'info',
        `SEARCH/${created.search_id.slice(0, 8)}`,
        `pane=${paneId} search started root=${pane.currentPath} mode=${searchMode} query=${searchMode === 'empty_dirs' ? '(ignored)' : (pane.search.filenameQuery || '*')} min_size_mb=${searchMode === 'empty_dirs' ? '(ignored)' : (minSizeMb ?? 'none')}`
      );
      setPanes((prev) => prev.map((p) => p.id === paneId ? {
        ...p,
        lockedOperation: 'search',
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
      setPanes((prev) => prev.map((p) => {
        if (p.id !== paneId) return p;
        const items = data.items.map((item) => {
          if (!item.is_dir) return item;
          if (!Object.prototype.hasOwnProperty.call(p.directorySizes, item.path)) return item;
          return { ...item, size: p.directorySizes[item.path] };
        });
        return { ...p, loading: false, items, currentPath: path };
      }));
    } catch (error) {
      setPanes((prev) => prev.map((p) => p.id === paneId ? { ...p, loading: false, error: String(error) } : p));
    }
  }

  async function navigatePane(paneId: string, path: string, pushHistory = true) {
    const pane = getPane(paneId);
    if (pane?.lockedOperation) return;
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
    if (!sourcePane || sourcePane.lockedOperation) return;
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
    if (!pane || pane.lockedOperation) return;

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
    const targetPane =
      panes.find((pane) => pane.id === activePaneId)
      ?? panes.find((pane) => !pane.currentPath)
      ?? panes[0];
    if (targetPane) {
      if (targetPane.lockedOperation) return;
      if (activePaneId !== targetPane.id) {
        setActivePaneId(targetPane.id);
      }
      navigatePane(targetPane.id, path).catch(console.error);
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
    cancelPaneSize(paneId).catch(console.error);
    setPanes((prev) => prev.filter((p) => p.id !== paneId));
    if (activePaneId === paneId) {
      const next = panes.find((p) => p.id !== paneId);
      if (next) setActivePaneId(next.id);
    }
  }

  function toggleRightTab(tab: 'queue' | 'settings' | 'diagnostics') {
    setOpenTabs((prev) => ({ ...prev, [tab]: !prev[tab] }));
  }

  function basename(path: string): string {
    if (!path.includes(':')) {
      const segments = path.split('/').filter(Boolean);
      return segments.length ? segments[segments.length - 1] : path;
    }
    const [, rel] = path.split(':', 2);
    const normalized = rel.replace(/\/+$/g, '');
    if (!normalized) return path;
    const segments = normalized.split('/');
    return segments.length ? segments[segments.length - 1] : path;
  }

  function isPreviewableImage(path: string): boolean {
    const name = basename(path).toLowerCase();
    const extParts = name.split('.');
    const ext = name.includes('.') && extParts.length ? extParts[extParts.length - 1] : '';
    return PREVIEWABLE_IMAGE_EXTENSIONS.has(ext);
  }

  function openImagePreview(remotePath: string, paneId: string) {
    setImagePreviewLoading(true);
    setImagePreviewError(null);
    setImagePreview({
      open: true,
      remotePath,
      fileName: basename(remotePath),
      paneId,
    });
  }

  function closeImagePreview() {
    setImagePreview({ open: false, remotePath: '', fileName: '', paneId: null });
    setImagePreviewLoading(false);
    setImagePreviewError(null);
  }

  function handleFileClick(paneId: string, path: string) {
    const pane = panesRef.current.find((p) => p.id === paneId);
    if (pane?.mode === 'browse' && isPreviewableImage(path)) {
      openImagePreview(path, paneId);
      return;
    }
    setPanes((prev) => prev.map((p) => {
      if (p.id !== paneId) return p;
      if (p.mode === 'browse' || p.mode === 'search') {
        return { ...p, mode: 'select', selected: new Set<string>([path]) };
      }
      const next = new Set(p.selected);
      if (next.has(path)) next.delete(path); else next.add(path);
      return { ...p, selected: next };
    }));
  }

  function formatSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '-';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = bytes / 1024;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    const precision = size >= 100 ? 0 : size >= 10 ? 1 : 2;
    return `${size.toFixed(precision)} ${units[unitIndex]}`;
  }

  function closeContextMenu() {
    setContextMenu({ open: false, paneId: null, entry: null, x: 0, y: 0 });
  }

  function openContextMenu(paneId: string, entry: Entry, x: number, y: number) {
    const pane = getPane(paneId);
    if (!pane || pane.lockedOperation) return;
    setContextMenu({ open: true, paneId, entry, x, y });
  }

  async function copyPathToClipboard(path: string) {
    if (!navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(path);
  }

  function triggerFileDownload(path: string) {
    const link = document.createElement('a');
    link.href = api.fileContentUrl(path, 'attachment');
    link.download = basename(path);
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function openRenameDialog(paneId: string, entry: Entry) {
    setRenameDialog({
      open: true,
      paneId,
      sourcePath: entry.path,
      currentName: entry.name || basename(entry.path),
      nextName: entry.name || basename(entry.path),
      saving: false,
    });
  }

  async function runContextAction(action: 'open' | 'open_new_pane' | 'copy_path' | 'download' | 'preview' | 'rename' | 'delete' | 'calculate_size') {
    const paneId = contextMenu.paneId;
    const entry = contextMenu.entry;
    closeContextMenu();
    if (!paneId || !entry) return;

    if (action === 'open') {
      if (entry.is_dir) {
        navigatePane(paneId, entry.path).catch(console.error);
      } else {
        handleFileClick(paneId, entry.path);
      }
      return;
    }
    if (action === 'open_new_pane') {
      openPathInNewPane(entry.path);
      return;
    }
    if (action === 'copy_path') {
      copyPathToClipboard(entry.path).catch(console.error);
      return;
    }
    if (action === 'download') {
      if (!entry.is_dir) {
        triggerFileDownload(entry.path);
      }
      return;
    }
    if (action === 'preview') {
      if (!entry.is_dir && isPreviewableImage(entry.path)) {
        openImagePreview(entry.path, paneId);
      }
      return;
    }
    if (action === 'rename') {
      openRenameDialog(paneId, entry);
      return;
    }
    if (action === 'calculate_size') {
      if (entry.is_dir) {
        startPaneSizeCalculation(paneId, entry.path).catch(console.error);
      }
      return;
    }
    if (action === 'delete') {
      const pane = getPane(paneId);
      const useSelection = !!pane && pane.mode === 'select' && pane.selected.size > 0;
      const sources = useSelection ? Array.from(pane!.selected) : [entry.path];
      setConfirmDelete({ open: true, paneId, sources });
    }
  }

  async function confirmRename() {
    if (!renameDialog.paneId) return;
    const nextName = renameDialog.nextName.trim();
    if (!nextName) {
      setRenameDialog((prev) => ({ ...prev, error: 'Name is required.' }));
      return;
    }
    if (nextName.includes('/') || nextName.includes(':')) {
      setRenameDialog((prev) => ({ ...prev, error: "Name cannot contain '/' or ':'." }));
      return;
    }
    if (nextName === renameDialog.currentName) {
      setRenameDialog((prev) => ({ ...prev, error: 'Name is unchanged.' }));
      return;
    }

    setRenameDialog((prev) => ({ ...prev, saving: true, error: undefined }));
    try {
      const result = await api.rename(renameDialog.sourcePath, nextName);
      const paneId = renameDialog.paneId;
      setPanes((prev) => prev.map((p) => {
        if (p.id !== paneId) return p;
        const nextSelected = new Set<string>();
        for (const path of p.selected) {
          if (path === renameDialog.sourcePath) {
            nextSelected.add(result.updated_path);
          } else {
            nextSelected.add(path);
          }
        }
        const nextDirectorySizes: Record<string, number> = {};
        for (const [key, size] of Object.entries(p.directorySizes)) {
          if (key === renameDialog.sourcePath || key.startsWith(`${renameDialog.sourcePath}/`)) {
            const suffix = key.slice(renameDialog.sourcePath.length);
            nextDirectorySizes[`${result.updated_path}${suffix}`] = size;
            continue;
          }
          nextDirectorySizes[key] = size;
        }
        return { ...p, selected: nextSelected, directorySizes: nextDirectorySizes };
      }));
      setRenameDialog({
        open: false,
        paneId: null,
        sourcePath: '',
        currentName: '',
        nextName: '',
        saving: false,
      });
      const pane = getPane(paneId);
      if (pane?.currentPath) {
        await loadPane(pane.currentPath, paneId);
      }
    } catch (error) {
      setRenameDialog((prev) => ({ ...prev, saving: false, error: String(error) }));
    }
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
                if (current?.search.running) return;
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
              onStartSearch={() => startPaneSearch(pane.id, 'standard').catch(console.error)}
              onStartEmptyDirSearch={() => startPaneSearch(pane.id, 'empty_dirs').catch(console.error)}
              onCancelSearch={() => cancelPaneSearch(pane.id).catch(console.error)}
              onToggleSelect={(path) => setPanes((prev) => prev.map((p) => {
                if (p.id !== pane.id) return p;
                const next = new Set(p.selected);
                if (next.has(path)) next.delete(path); else next.add(path);
                return { ...p, selected: next };
              }))}
              onFileClick={(path) => handleFileClick(pane.id, path)}
              onContextAction={(entry, x, y) => openContextMenu(pane.id, entry, x, y)}
              onCopySelected={(targetId) => transferSelected(pane.id, targetId, false).catch(console.error)}
              onMoveSelected={(targetId) => transferSelected(pane.id, targetId, true).catch(console.error)}
              onDeleteSelected={() => setConfirmDelete({ open: true, paneId: pane.id, sources: Array.from(pane.selected) })}
              onDropTarget={(targetPath, sources, move, sourcePaneId) =>
                handleDrop(pane.id, targetPath, sources, move, sourcePaneId)}
              onClose={() => closePane(pane.id)}
              interactionsDisabled={pane.search.running || pane.sizeCalc.running}
              onCancelSizeCalculation={() => cancelPaneSize(pane.id).catch(console.error)}
              onDismissSizeResult={() => clearPaneSizeRuntime(pane.id)}
              formatSize={formatSize}
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

      {contextMenu.open && contextMenu.entry && (
        <div
          className="context-menu"
          style={{
            left: `${Math.max(8, Math.min(contextMenu.x, window.innerWidth - 220))}px`,
            top: `${Math.max(8, Math.min(contextMenu.y, window.innerHeight - 320))}px`,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button onClick={() => runContextAction('open')}>Open</button>
          {contextMenu.entry.is_dir && (
            <button onClick={() => runContextAction('open_new_pane')}>Open in new pane</button>
          )}
          {!contextMenu.entry.is_dir && isPreviewableImage(contextMenu.entry.path) && (
            <button onClick={() => runContextAction('preview')}>Preview image</button>
          )}
          {!contextMenu.entry.is_dir && (
            <button onClick={() => runContextAction('download')}>Download</button>
          )}
          <button onClick={() => runContextAction('copy_path')}>Copy path</button>
          <button onClick={() => runContextAction('rename')}>Rename</button>
          {contextMenu.entry.is_dir && (
            <button onClick={() => runContextAction('calculate_size')}>Calculate size</button>
          )}
          <button className="danger" onClick={() => runContextAction('delete')}>Delete</button>
        </div>
      )}

      {renameDialog.open && (
        <div className="dialog-backdrop" onClick={() => setRenameDialog({
          open: false,
          paneId: null,
          sourcePath: '',
          currentName: '',
          nextName: '',
          saving: false,
        })}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Rename</h3>
            <p>Rename {renameDialog.currentName}</p>
            <input
              value={renameDialog.nextName}
              onChange={(e) => setRenameDialog((prev) => ({ ...prev, nextName: e.target.value, error: undefined }))}
              autoFocus
            />
            {renameDialog.error && <div className="pane-error">{renameDialog.error}</div>}
            <div className="dialog-actions">
              <button onClick={() => setRenameDialog({
                open: false,
                paneId: null,
                sourcePath: '',
                currentName: '',
                nextName: '',
                saving: false,
              })}>
                Cancel
              </button>
              <button onClick={() => confirmRename().catch(console.error)} disabled={renameDialog.saving}>Save</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete.open}
        title="Confirm delete"
        message="Delete selected items? This cannot be undone."
        onCancel={() => setConfirmDelete({ open: false, paneId: null, sources: [] })}
        onConfirm={async () => {
          const pane = panes.find((p) => p.id === confirmDelete.paneId);
          if (!pane) return;
          const sources = confirmDelete.sources && confirmDelete.sources.length
            ? confirmDelete.sources
            : Array.from(pane.selected);
          if (!sources.length) return;
          const deleteJob = await api.del(sources);
          await waitForJobTerminal(deleteJob.id);
          setConfirmDelete({ open: false, paneId: null, sources: [] });
          setPanes((prev) => prev.map((p) => p.id === pane.id ? {
            ...p,
            selected: new Set<string>(Array.from(p.selected).filter((path) => !sources.includes(path))),
          } : p));
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

      {imagePreview.open && (
        <div className="dialog-backdrop" onClick={closeImagePreview}>
          <div className="dialog image-preview-dialog" onClick={(event) => event.stopPropagation()}>
            <h3>{imagePreview.fileName}</h3>
            <div className="image-preview-body">
              {imagePreviewLoading && (
                <div className="image-preview-loading" role="status" aria-live="polite">
                  <div className="progressbar indeterminate" aria-hidden="true">
                    <span />
                  </div>
                  <div className="search-progress-text">Loading image...</div>
                </div>
              )}
              {imagePreviewError && (
                <div className="pane-error image-preview-error">
                  {imagePreviewError}
                </div>
              )}
              <img
                className={imagePreviewLoading ? 'is-loading' : ''}
                src={api.fileContentUrl(imagePreview.remotePath, 'inline')}
                alt={imagePreview.fileName}
                onLoad={() => {
                  setImagePreviewLoading(false);
                  setImagePreviewError(null);
                }}
                onError={() => {
                  setImagePreviewLoading(false);
                  setImagePreviewError('Failed to load image preview.');
                }}
              />
            </div>
            <div className="dialog-actions">
              <button onClick={closeImagePreview}>Close</button>
              <a className="button-link" href={api.fileContentUrl(imagePreview.remotePath, 'attachment')} download={imagePreview.fileName}>
                Download
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
