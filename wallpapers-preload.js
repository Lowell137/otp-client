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
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target || e.target.id !== 'otp-shell-search') return;
  const v = e.target.value.trim();
  if (v) ipcRenderer.send('otp:open-champ', v);
});
document.addEventListener('change', (e) => {
  if (!e.target || e.target.id !== 'otp-shell-search') return;
  const v = e.target.value.trim();
  const opts = [...document.querySelectorAll('#otp-shell-champs option')].map((o) => o.value);
  if (opts.includes(v)) ipcRenderer.send('otp:open-champ', v);
});
window.addEventListener('DOMContentLoaded', () => {
  try { ipcRenderer.send('otp:caption', { color: '#212324', height: 56 }); } catch {}
});
