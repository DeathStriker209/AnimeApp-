const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const VIDEO_EXT = ['mp4', 'mkv', 'webm', 'm4v', 'mov'];
const SUB_EXT = ['.vtt', '.srt'];

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 880,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0a101a',
    title: 'Anime Stream+',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Any link that tries to open a new window goes to the system browser instead
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Look for a subtitle file sitting next to the video with the same name
function findSidecarSub(videoPath) {
  const base = videoPath.slice(0, -path.extname(videoPath).length);
  for (const ext of SUB_EXT) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
  return null;
}

ipcMain.handle('pick-videos', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose episode files',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video files', extensions: VIDEO_EXT }]
  });
  if (result.canceled) return [];
  return result.filePaths.map((p) => ({
    name: path.basename(p),
    path: p,
    url: pathToFileURL(p).href,
    sub: findSidecarSub(p)
  }));
});

ipcMain.handle('pick-subtitle', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a subtitle file',
    properties: ['openFile'],
    filters: [{ name: 'Subtitles', extensions: ['vtt', 'srt'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const p = result.filePaths[0];
  return { name: path.basename(p), text: fs.readFileSync(p, 'utf8') };
});

ipcMain.handle('read-subtitle', async (_e, p) => {
  try {
    if (!p || !SUB_EXT.includes(path.extname(p).toLowerCase())) return null;
    return { name: path.basename(p), text: fs.readFileSync(p, 'utf8') };
  } catch {
    return null;
  }
});

ipcMain.handle('file-exists', async (_e, p) => {
  try { return !!p && fs.existsSync(p); } catch { return false; }
});

ipcMain.handle('open-external', async (_e, url) => {
  if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
