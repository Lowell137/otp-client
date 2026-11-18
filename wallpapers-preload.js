const { ipcRenderer, contextBridge } = require('electron');

contextBridge.exposeInMainWorld('otpWall', {
  champs: () => ipcRenderer.invoke('otp:wall-champs'),
  skins: (id) => ipcRenderer.invoke('otp:wall-skins', id),
});

// Shared header (shell.js): route [data-go] clicks to main.
document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest && e.target.closest('#otp-shell-header [data-go]');
  if (!a) return;
  e.preventDefault();
  ipcRenderer.send('otp:go', a.dataset.go);
});
