const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('otpOverlayAPI', {
  onPlayersUpdate: (callback) => {
    const handler = (_e, players) => callback(players);
    ipcRenderer.on('otp:overlay-players', handler);
    return () => ipcRenderer.removeListener('otp:overlay-players', handler);
  },
  requestClose: () => ipcRenderer.send('otp:overlay-close'),
  // Window region = these rects (the panel); everything else passes to the game.
  setShape: (rects) => ipcRenderer.send('otp:overlay-shape', rects),
});
