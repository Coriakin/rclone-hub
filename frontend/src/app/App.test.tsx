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
  remoteTypes: vi.fn(),
  remotesDetails: vi.fn(),
  remoteConfig: vi.fn(),
  createRemote: vi.fn(),
  updateRemote: vi.fn(),
  deleteRemote: vi.fn(),
  startRemoteConfigSession: vi.fn(),
  continueRemoteConfigSession: vi.fn(),
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
    apiMock.remoteTypes.mockResolvedValue({ types: [] });
    apiMock.remotesDetails.mockResolvedValue({ remotes: [] });
    apiMock.remoteConfig.mockResolvedValue({ name: '', type: 'b2', fields: [] });

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
    apiMock.remoteTypes.mockResolvedValue({ types: [] });
    apiMock.remotesDetails.mockResolvedValue({ remotes: [] });
    apiMock.remoteConfig.mockResolvedValue({ name: '', type: 'b2', fields: [] });
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

describe('App configuration mode', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    mockMatchMedia(true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    apiMock.remotes.mockResolvedValue({ remotes: [] });
    apiMock.jobs.mockResolvedValue({ jobs: [] });
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
    apiMock.remoteTypes.mockResolvedValue({
      types: [{ type: 'b2', description: 'Backblaze B2', fields: [] }],
    });
    apiMock.remotesDetails.mockResolvedValue({
      remotes: [{ name: 'b2r', type: 'b2', source: 'file', description: '' }],
    });
    apiMock.remoteConfig.mockResolvedValue({
      name: 'b2r',
      type: 'b2',
      fields: [],
    });

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

  test('switches to configuration mode and loads remote data', async () => {
    const configTab = tabButton(container, 'Configuration');
    expect(configTab).toBeTruthy();
    configTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    await waitFor(() => {
      expect(container.textContent).toContain('Configured remotes');
      expect(container.textContent).toContain('Create remote');
      expect(container.textContent).toContain('b2r');
    });

    expect(apiMock.remoteTypes).toHaveBeenCalled();
    expect(apiMock.remotesDetails).toHaveBeenCalled();
  });
});
