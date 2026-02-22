// @vitest-environment jsdom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App';

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
    await new Promise((resolve) => setTimeout(resolve, ms));
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

describe('App image preview', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
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
