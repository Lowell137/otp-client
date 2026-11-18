const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tb', {
  go: (where) => ipcRenderer.send('tb:go', where),
  champs: () => ipcRenderer.invoke('tb:champs'),
  onState: (cb) => ipcRenderer.on('tb:state', (_e, s) => cb(s)),
  onFocusSearch: (cb) => ipcRenderer.on('tb:focus-search', () => cb()),
  ready: () => ipcRenderer.send('tb:ready'),
});
