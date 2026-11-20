const { ipcRenderer, contextBridge } = require('electron');

// Assistant side panel (ai.html in its own view): chat, models, settings,
// panel resize/close and window drag. API keys stay in main.
contextBridge.exposeInMainWorld('otpAI', {
  status: () => ipcRenderer.invoke('otp:ai-status'),
  config: () => ipcRenderer.invoke('otp:ai-config-get'),
  setConfig: (patch) => ipcRenderer.invoke('otp:ai-config-set', patch),
  models: () => ipcRenderer.invoke('otp:ai-models'),
  test: (draft) => ipcRenderer.invoke('otp:ai-test', draft),
  tools: () => ipcRenderer.invoke('otp:ai-tools'),
  chat: (q) => ipcRenderer.invoke('otp:ai-chat', q),
  stop: (id) => ipcRenderer.send('otp:ai-stop', id),
  onEvent: (fn) => ipcRenderer.on('otp:ai-event', (_e, ev) => { try { fn(ev); } catch {} }),
  chats: () => ipcRenderer.invoke('otp:ai-chats-list'),
  chatGet: (id) => ipcRenderer.invoke('otp:ai-chats-get', id),
  chatSave: (c) => ipcRenderer.invoke('otp:ai-chats-save', c),
  chatDelete: (id) => ipcRenderer.invoke('otp:ai-chats-delete', id),
  close: () => ipcRenderer.send('otp:ai-sidebar-close'),
  resize: (screenX) => ipcRenderer.send('otp:ai-resize', screenX),
  resizeEnd: () => ipcRenderer.send('otp:ai-resize-end'),
  winDrag: (phase) => ipcRenderer.send('otp:win-drag', phase),
});
