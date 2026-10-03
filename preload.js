const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickVideos: () => ipcRenderer.invoke('pick-videos'),
  pickSubtitle: () => ipcRenderer.invoke('pick-subtitle'),
  readSubtitle: (p) => ipcRenderer.invoke('read-subtitle', p),
  fileExists: (p) => ipcRenderer.invoke('file-exists', p),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  anilistLogin: (clientId) => ipcRenderer.invoke('anilist-login', clientId),
  onZoom: (cb) => ipcRenderer.on('zoom-changed', (_e, pct) => cb(pct))
});
