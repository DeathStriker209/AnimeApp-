const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const VIDEO_EXT = ['mp4', 'mkv', 'webm', 'm4v', 'mov'];
const SUB_EXT = ['.vtt', '.srt'];

/* ---------- Zoom (Ctrl +/-, Ctrl 0, Ctrl + mouse wheel) ---------- */
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const settingsFile = () => path.join(app.getPath('userData'), 'window-settings.json');
function loadZoom() {
  try { const z = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).zoom; return ZOOM_STEPS.includes(z) ? z : 1; }
  catch { return 1; }
}
function saveZoom(z) {
  try { fs.writeFileSync(settingsFile(), JSON.stringify({ zoom: z })); } catch { /* ignore */ }
}
function applyZoom(wc, z, announce = true) {
  wc.setZoomFactor(z);
  saveZoom(z);
  if (announce) wc.send('zoom-changed', Math.round(z * 100));
}
function stepZoom(wc, dir) {
  const cur = wc.getZoomFactor();
  let i = ZOOM_STEPS.findIndex((s) => Math.abs(s - cur) < 0.01);
  if (i === -1) i = ZOOM_STEPS.indexOf(1);
  const next = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + dir))];
  applyZoom(wc, next);
}

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

  const wc = win.webContents;
  wc.on('did-finish-load', () => applyZoom(wc, loadZoom(), false));

  // Keyboard zoom. preventDefault also stops the built-in menu shortcuts so it never zooms twice.
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const k = input.key, c = input.code;
    if (k === '=' || k === '+' || c === 'NumpadAdd') { event.preventDefault(); stepZoom(wc, 1); }
    else if (k === '-' || k === '_' || c === 'NumpadSubtract') { event.preventDefault(); stepZoom(wc, -1); }
    else if (k === '0' || c === 'Numpad0') { event.preventDefault(); applyZoom(wc, 1); }
  });

  // Ctrl + mouse wheel (and touchpad pinch)
  wc.on('zoom-changed', (_e, direction) => stepZoom(wc, direction === 'in' ? 1 : -1));

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
