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

// Shared header: champion search -> build page; native caption buttons take the
// header's color/height (#212324, 56 px) like on the site's inner pages.
// shell.js fires 'otp-open-champ' with the champion name when a suggestion is picked.
document.addEventListener('otp-open-champ', (e) => {
  const id = e && e.detail;
  if (typeof id === 'string' && id) ipcRenderer.send('otp:open-champ', id);
});
window.addEventListener('DOMContentLoaded', () => {
  try { ipcRenderer.send('otp:caption', { color: '#00000000', height: 56 }); } catch {}
});

// shell.js header drag (no CSS drag region on local pages): forward to main.
document.addEventListener('otp-win-drag', (e) => {
  const phase = e && e.detail;
  if (typeof phase === 'string') ipcRenderer.send('otp:win-drag', phase);
});

// Update progress badge (shell.js draws it): forward main's update state to the page
// and the page's "install" click back to main.
const fwdUpdate = (s) => { try { window.dispatchEvent(new CustomEvent('otp-update-state', { detail: JSON.stringify(s || {}) })); } catch {} };
ipcRenderer.on('otp:update-state', (_e, s) => fwdUpdate(s));
window.addEventListener('DOMContentLoaded', () => { ipcRenderer.invoke('otp:update-get').then(fwdUpdate).catch(() => {}); });
window.addEventListener('otp-update-install', () => ipcRenderer.send('otp:update-install'));
