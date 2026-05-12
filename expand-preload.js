const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('expandAPI', {
  onUpdate: (cb) => ipcRenderer.on('expand:update', (_e, payload) => cb(payload)),
  reportSize: (width, height) => ipcRenderer.send('expand:save-size', { width, height }),
});
