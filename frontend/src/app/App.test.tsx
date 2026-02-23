// @vitest-environment jsdom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App';
import type { Job } from '../api/client';

const apiMock = vi.hoisted(() => ({
  health: vi.fn(),
  remotes: vi.fn(),
  list: vi.fn(),
  fileContentUrl: vi.fn(),
  startSearch: vi.fn(),
  searchEvents: vi.fn(),
  cancelSearch: vi.fn(),
  jobs: vi.fn(),
  job: vi.fn(),
  copy: vi.fn(),
  move: vi.fn(),
  del: vi.fn(),
  cancel: vi.fn(),
  settings: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock('../api/client', () => ({
  api: apiMock,
}));

async function flush(ms = 0) {
  await act(async () => {
    if (ms > 0) {
      if (vi.isFakeTimers()) {
        vi.advanceTimersByTime(ms);
      } else {
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
      return;
    }
    await Promise.resolve();
  });
}

async function waitFor(check: () => void, timeoutMs = 1200) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      check();
      return;
    } catch {
      await flush(25);
    }
  }
  check();
}

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function tabButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === label) as HTMLButtonElement | undefined;
}

function job(status: Job['status']): Job {
  return {
    id: `job-${status}`,
    operation: 'copy',
    destination_dir: 'dst:/path',
    sources: ['src:/file.txt'],
    status,
    created_at: '2026-02-23T00:00:00.000Z',
    logs: [],
    results: [],
  };
}

describe('App image preview', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    mockMatchMedia(true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    apiMock.remotes.mockResolvedValue({ remotes: ['photos:'] });
    apiMock.jobs.mockResolvedValue({ jobs: [] });
    apiMock.settings.mockResolvedValue({
      staging_path: '/tmp/rclone-hub',
      staging_cap_bytes: 1024,
      concurrency: 1,
      verify_mode: 'strict',
    });
    apiMock.list.mockResolvedValue({
      items: [{ name: 'cat.jpg', path: 'photos:cat.jpg', is_dir: false, size: 12 }],
    });
    apiMock.fileContentUrl.mockImplementation((path: string, disposition: 'inline' | 'attachment' = 'inline') =>
      `/api/files/content?remote_path=${encodeURIComponent(path)}&disposition=${disposition}`
    );

    await act(async () => {
      root.render(<App />);
    });
    await flush();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  test('browse mode opens image preview, and select mode keeps selection behavior', async () => {
    const remoteButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'photos:');
    expect(remoteButton).toBeTruthy();
    remoteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    await waitFor(() => {
      expect(container.textContent).toContain('cat.jpg');
    });

    const secondEntryButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('cat.jpg'));
    expect(secondEntryButton).toBeTruthy();
    secondEntryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    const image = container.querySelector('.image-preview-body img') as HTMLImageElement | null;
    expect(image).toBeTruthy();
    expect(image?.src).toContain('disposition=inline');

    const download = Array.from(container.querySelectorAll('a')).find((link) => link.textContent?.includes('Download')) as HTMLAnchorElement | undefined;
    expect(download).toBeTruthy();
    expect(download?.href).toContain('disposition=attachment');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flush();
    expect(container.querySelector('.image-preview-body img')).toBeNull();

    const selectModeBtn = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Select');
    expect(selectModeBtn).toBeTruthy();
    selectModeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    const entryButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('cat.jpg'));
    expect(entryButton).toBeTruthy();
    entryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(container.querySelector('.image-preview-body img')).toBeNull();
    const selectedRow = Array.from(container.querySelectorAll('.file-row')).find((row) => row.classList.contains('is-selected'));
    expect(selectedRow).toBeTruthy();
  });
});

describe('App selection mode interactions', () => {
  let container: HTMLDivElement;
  let root: Root;

  function paneAt(index: number): HTMLElement {
    const panes = Array.from(container.querySelectorAll('.pane'));
    return panes[index] as HTMLElement;
  }

  function buttonByText(scope: ParentNode, label: string): HTMLButtonElement | undefined {
    return Array.from(scope.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === label) as HTMLButtonElement | undefined;
  }

  function rowByName(scope: ParentNode, name: string): HTMLElement | undefined {
    return Array.from(scope.querySelectorAll('.file-row'))
      .find((row) => row.textContent?.includes(name)) as HTMLElement | undefined;
  }

  function createDndEvent(type: 'dragstart' | 'drop', dataTransfer: {
    setData?: (format: string, data: string) => void;
    getData?: (format: string) => string;
    effectAllowed?: string;
  }) {
    const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: typeof dataTransfer };
    Object.defineProperty(event, 'dataTransfer', {
      value: dataTransfer,
      configurable: true,
    });
    return event;
  }

  beforeEach(async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    mockMatchMedia(true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    apiMock.remotes.mockResolvedValue({ remotes: ['src:', 'dst:'] });
    apiMock.jobs.mockResolvedValue({ jobs: [] });
    apiMock.settings.mockResolvedValue({
      staging_path: '/tmp/rclone-hub',
      staging_cap_bytes: 1024,
      concurrency: 1,
      verify_mode: 'strict',
    });
    apiMock.list.mockImplementation(async (path: string) => {
      if (path.startsWith('src:')) {
        return {
          items: [
            { name: 'a.txt', path: 'src:a.txt', is_dir: false, size: 11 },
            { name: 'b.txt', path: 'src:b.txt', is_dir: false, size: 12 },
            { name: 'c.txt', path: 'src:c.txt', is_dir: false, size: 13 },
          ],
        };
      }
      return { items: [{ name: 'incoming', path: 'dst:incoming', is_dir: true, size: 0 }] };
    });
    apiMock.fileContentUrl.mockImplementation((path: string, disposition: 'inline' | 'attachment' = 'inline') =>
      `/api/files/content?remote_path=${encodeURIComponent(path)}&disposition=${disposition}`
    );
    apiMock.del.mockResolvedValue({ id: 'job-delete' });
    apiMock.job.mockResolvedValue(job('success'));
    apiMock.copy.mockResolvedValue({ id: 'job-copy' });
    apiMock.move.mockResolvedValue({ id: 'job-move' });

    await act(async () => {
      root.render(<App />);
    });
    await flush();

    const srcButton = buttonByText(container, 'src:');
    expect(srcButton).toBeTruthy();
    srcButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    const addPane = buttonByText(container, 'Add pane');
    expect(addPane).toBeTruthy();
    addPane?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    const dstButton = buttonByText(container, 'dst:');
    expect(dstButton).toBeTruthy();
    dstButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  test('removes select toolbar controls and applies compact selection mode class', async () => {
    const sourcePane = paneAt(0);
    const selectModeBtn = buttonByText(sourcePane, 'Select');
    expect(selectModeBtn).toBeTruthy();
    selectModeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    const aButton = Array.from(sourcePane.querySelectorAll('.entry-btn')).find((btn) => btn.textContent?.includes('a.txt'));
    expect(aButton).toBeTruthy();
    aButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(container.querySelector('.ops-row')).toBeNull();
    expect(container.querySelector('.target-pane-select')).toBeNull();
    expect(sourcePane.querySelector('.file-list')?.classList.contains('selection-mode')).toBe(true);
  });

  test('context delete uses selection-first behavior', async () => {
    const sourcePane = paneAt(0);
    const selectModeBtn = buttonByText(sourcePane, 'Select');
    selectModeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    const aButton = Array.from(sourcePane.querySelectorAll('.entry-btn')).find((btn) => btn.textContent?.includes('a.txt'));
    const bButton = Array.from(sourcePane.querySelectorAll('.entry-btn')).find((btn) => btn.textContent?.includes('b.txt'));
    expect(aButton).toBeTruthy();
    expect(bButton).toBeTruthy();

    aButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    bButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    const aRow = rowByName(sourcePane, 'a.txt');
    expect(aRow).toBeTruthy();
    aRow?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    await flush();
    buttonByText(container, 'Delete')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    buttonByText(container, 'Confirm')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(apiMock.del).toHaveBeenCalledTimes(1);
    expect(apiMock.del.mock.calls[0][0]).toEqual(expect.arrayContaining(['src:a.txt', 'src:b.txt']));
    expect(apiMock.del.mock.calls[0][0]).toHaveLength(2);

    const cRowAfterReload = rowByName(sourcePane, 'c.txt');
    expect(cRowAfterReload).toBeTruthy();
    cRowAfterReload?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    await flush();
    buttonByText(container, 'Delete')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    buttonByText(container, 'Confirm')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(apiMock.del).toHaveBeenCalledTimes(2);
    expect(apiMock.del.mock.calls[1][0]).toEqual(['src:c.txt']);
  });

  test('drag in select mode uses selected set when dragging selected row', async () => {
    const sourcePane = paneAt(0);
    buttonByText(sourcePane, 'Select')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    const aButton = Array.from(sourcePane.querySelectorAll('.entry-btn')).find((btn) => btn.textContent?.includes('a.txt'));
    const bButton = Array.from(sourcePane.querySelectorAll('.entry-btn')).find((btn) => btn.textContent?.includes('b.txt'));
    expect(aButton).toBeTruthy();
    expect(bButton).toBeTruthy();
    aButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    bButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    const aRow = rowByName(sourcePane, 'a.txt');
    const cRow = rowByName(sourcePane, 'c.txt');
    expect(aRow).toBeTruthy();
    expect(cRow).toBeTruthy();

    const setDataSelected = vi.fn();
    aRow?.dispatchEvent(createDndEvent('dragstart', { setData: setDataSelected, effectAllowed: '' }));
    const selectedPayload = JSON.parse(
      String(setDataSelected.mock.calls.find((call) => call[0] === 'application/x-rclone-paths')?.[1] ?? '{}')
    ) as { sources: string[] };
    expect(selectedPayload.sources).toEqual(expect.arrayContaining(['src:a.txt', 'src:b.txt']));
    expect(selectedPayload.sources).toHaveLength(2);

    const setDataSingle = vi.fn();
    cRow?.dispatchEvent(createDndEvent('dragstart', { setData: setDataSingle, effectAllowed: '' }));
    const singlePayload = JSON.parse(
      String(setDataSingle.mock.calls.find((call) => call[0] === 'application/x-rclone-paths')?.[1] ?? '{}')
    ) as { sources: string[] };
    expect(singlePayload.sources).toEqual(['src:c.txt']);
  });

  test('cross-pane drop prompts for action and clears source selection after copy', async () => {
    const sourcePane = paneAt(0);
    const targetPane = paneAt(1);
    buttonByText(sourcePane, 'Select')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    const aButton = Array.from(sourcePane.querySelectorAll('.entry-btn')).find((btn) => btn.textContent?.includes('a.txt'));
    const bButton = Array.from(sourcePane.querySelectorAll('.entry-btn')).find((btn) => btn.textContent?.includes('b.txt'));
    aButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    bButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(sourcePane.querySelectorAll('.file-row.is-selected').length).toBe(2);

    const aRow = rowByName(sourcePane, 'a.txt');
    const setData = vi.fn();
    aRow?.dispatchEvent(createDndEvent('dragstart', { setData, effectAllowed: '' }));
    const payload = String(setData.mock.calls.find((call) => call[0] === 'application/x-rclone-paths')?.[1] ?? '');
    expect(payload).toContain('"sourcePaneId"');
    const targetList = targetPane.querySelector('.file-list');
    expect(targetList).toBeTruthy();
    targetList?.dispatchEvent(createDndEvent('drop', {
      getData: (format: string) => (format === 'application/x-rclone-paths' ? payload : ''),
    }));
    await flush();

    expect(container.textContent).toContain('Choose transfer action');
    expect(container.textContent).toContain('2 item(s) dropped.');
    buttonByText(container, 'Copy')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(apiMock.copy).toHaveBeenCalledWith(['src:a.txt', 'src:b.txt'], 'dst:');
    expect(sourcePane.querySelectorAll('.file-row.is-selected').length).toBe(0);
  });
});

describe('App queue drawer behavior', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function renderAppWithJobsSequence(sequence: Job[][], desktopWide: boolean) {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    mockMatchMedia(desktopWide);
    vi.useFakeTimers();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    apiMock.remotes.mockResolvedValue({ remotes: [] });
    apiMock.settings.mockResolvedValue({
      staging_path: '/tmp/rclone-hub',
      staging_cap_bytes: 1024,
      concurrency: 1,
      verify_mode: 'strict',
    });
    apiMock.list.mockResolvedValue({ items: [] });
    apiMock.fileContentUrl.mockImplementation((path: string, disposition: 'inline' | 'attachment' = 'inline') =>
      `/api/files/content?remote_path=${encodeURIComponent(path)}&disposition=${disposition}`
    );
    sequence.forEach((jobs) => apiMock.jobs.mockResolvedValueOnce({ jobs }));
    apiMock.jobs.mockResolvedValue({ jobs: sequence[sequence.length - 1] ?? [] });

    await act(async () => {
      root.render(<App />);
    });
    await flush();
  }

  async function tickJobsPoll() {
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    await flush();
  }

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  test('desktop: starts collapsed, auto-opens on active transfer, auto-hides when transfers finish', async () => {
    await renderAppWithJobsSequence([[], [job('running')], [job('success')]], true);

    const queueTab = tabButton(container, 'Queue');
    const drawer = container.querySelector('.right-drawer');
    expect(queueTab).toBeTruthy();
    expect(drawer).toBeTruthy();
    expect(queueTab?.classList.contains('active')).toBe(false);
    expect(drawer?.classList.contains('open')).toBe(false);

    await tickJobsPoll();
    expect(queueTab?.classList.contains('active')).toBe(true);
    expect(drawer?.classList.contains('open')).toBe(true);

    await tickJobsPoll();
    expect(queueTab?.classList.contains('active')).toBe(false);
    expect(drawer?.classList.contains('open')).toBe(false);
  });

  test('desktop: active transfer forces queue tab to foreground', async () => {
    await renderAppWithJobsSequence([[], [job('running')]], true);

    const queueTab = tabButton(container, 'Queue');
    const settingsTab = tabButton(container, 'Settings');
    expect(queueTab).toBeTruthy();
    expect(settingsTab).toBeTruthy();

    settingsTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(settingsTab?.classList.contains('active')).toBe(true);
    expect(queueTab?.classList.contains('active')).toBe(false);

    await tickJobsPoll();
    expect(queueTab?.classList.contains('active')).toBe(true);
    expect(settingsTab?.classList.contains('active')).toBe(false);
  });

  test('mobile: does not auto-open or auto-close queue tab', async () => {
    await renderAppWithJobsSequence([[], [job('running')], [job('success')]], false);

    const queueTab = tabButton(container, 'Queue');
    expect(queueTab).toBeTruthy();
    expect(queueTab?.classList.contains('active')).toBe(false);

    await tickJobsPoll();
    expect(queueTab?.classList.contains('active')).toBe(false);

    queueTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(queueTab?.classList.contains('active')).toBe(true);

    await tickJobsPoll();
    expect(queueTab?.classList.contains('active')).toBe(true);
  });
});
