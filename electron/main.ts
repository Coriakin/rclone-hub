import path from 'node:path';
import { app, BrowserWindow, protocol, ipcMain } from 'electron';
import { Database } from './db/database';
import { registerIpcHandlers, createHandlers } from './ipc/handlers';
import { RcloneClient } from './services/rclone-client';
import { SearchManager } from './services/search-manager';
import { SizeManager } from './services/size-manager';
import { TransferManager } from './services/transfer-manager';

let mainWindow: BrowserWindow | null = null;

async function createMainWindow(): Promise<void> {
  const db = new Database();
  const rclone = new RcloneClient();
  const searches = new SearchManager(rclone);
  const sizes = new SizeManager(rclone);
  const transfers = new TransferManager(db, rclone);
  const handlers = createHandlers({ db, rclone, searches, sizes, transfers });

  searches.start();
  sizes.start();
  transfers.start();
  registerIpcHandlers(ipcMain, { db, rclone, searches, sizes, transfers, getMainWindow: () => mainWindow });

  protocol.handle('rclone-file', async (request) => {
    const remotePath = decodeURIComponent(request.url.replace(/^rclone-file:\/\//, '').split('?')[0] ?? '');
    const disposition = new URL(request.url).searchParams.get('disposition') === 'attachment' ? 'attachment' : 'inline';
    const meta = await handlers.getFilePreviewMeta(remotePath, disposition);
    const streamHandle = rclone.openCatStream(remotePath);
    const headers = new Headers();
    headers.set('content-type', meta.mediaType);
    headers.set('content-disposition', `${disposition}; filename="${meta.filename.replace(/"/g, '')}"`);
    return new Response(streamHandle.stdout as unknown as ReadableStream, { headers });
  });

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.NODE_ENV === 'development') {
    await mainWindow.loadURL('http://127.0.0.1:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../../frontend/dist/index.html'));
  }
}

app.whenReady().then(createMainWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow();
  }
});
