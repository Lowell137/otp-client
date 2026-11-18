const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('otpOverlayAPI', {
  onPlayersUpdate: (callback) => {
    const handler = (_e, players) => callback(players);
    ipcRenderer.on('otp:overlay-players', handler);
    return () => ipcRenderer.removeListener('otp:overlay-players', handler);
  },
  requestClose: () => ipcRenderer.send('otp:overlay-close'),
  // Panel rect: main takes mouse input only while the cursor is inside it.
  setShape: (rects) => ipcRenderer.send('otp:overlay-shape', rects),
  // Keep mouse input while the panel is being dragged (cursor may leave the panel).
  setDragging: (on) => ipcRenderer.send('otp:overlay-dragging', !!on),
});
