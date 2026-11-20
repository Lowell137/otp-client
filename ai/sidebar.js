// Assistant side panel: a WebContentsView docked on the right of the main window,
// on every page. The page keeps working and is laid out narrower: Chromium device
// emulation gives it a viewport that ends where the panel starts (the main
// BrowserWindow's own web contents can't be resized or moved into a view).
// Emulation is reset by navigation, so it is applied again after each one and on
// every window resize. Width is dragged from the panel's left edge and saved.
const path = require('path');
const { WebContentsView } = require('electron');

const MIN_W = 300;
const DEF_W = 380;

function createSidebar({ getWin, readState, writeState }) {
  let view = null;
  let open = false;
  let width = Number(readState().aiSidebarWidth) || DEF_W;

  const maxW = (w) => Math.max(MIN_W, Math.floor(w * 0.6));

  function layout() {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    const [cw, ch] = win.getContentSize();
    if (!open || !view) {
      try { wc.disableDeviceEmulation(); } catch {}
      return;
    }
    width = Math.min(Math.max(width, MIN_W), maxW(cw));
    const pageW = cw - width;
    try {
      wc.enableDeviceEmulation({
        screenPosition: 'desktop', screenSize: { width: pageW, height: ch },
        viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 0, viewSize: { width: pageW, height: ch }, scale: 1,
      });
    } catch {}
    view.setBounds({ x: pageW, y: 0, width, height: ch });
  }

  function ensureView() {
    const win = getWin();
    if (view || !win || win.isDestroyed()) return;
    view = new WebContentsView({
      // Own session: the main window's session-wide page preloads (site buttons,
      // settings gear...) must not run inside the panel.
      webPreferences: { preload: path.join(__dirname, '..', 'ai-preload.js'), contextIsolation: true, sandbox: true, partition: 'persist:otp-ai' },
    });
    view.setBackgroundColor('#181a1b');
    view.webContents.loadFile(path.join(__dirname, '..', 'ai.html'));
    // Links in answers open in the browser, never inside the panel.
    view.webContents.setWindowOpenHandler(({ url }) => { require('electron').shell.openExternal(url); return { action: 'deny' }; });
    view.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); require('electron').shell.openExternal(url); } });
    const wc = win.webContents;
    // Navigation drops the emulated viewport: put it back at once.
    for (const ev of ['did-start-navigation', 'did-navigate', 'dom-ready', 'did-finish-load']) wc.on(ev, () => { if (open) layout(); });
    win.on('resize', layout);
    win.on('maximize', layout);
    win.on('unmaximize', layout);
  }

  function setOpen(v) {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    ensureView();
    open = !!v;
    if (open) win.contentView.addChildView(view);
    else win.contentView.removeChildView(view);
    layout();
    const st = readState(); st.aiSidebarOpen = open; writeState(st);
    try { win.webContents.send('otp:ai-sidebar', { open }); } catch {}
    if (open) view.webContents.focus();
  }

  // Drag from the panel's left edge: the panel reports the cursor's screen x.
  function resizeTo(screenX) {
    const win = getWin();
    if (!win || win.isDestroyed() || !open) return;
    const b = win.getContentBounds();
    width = Math.round(b.x + b.width - screenX);
    layout();
  }
  function resizeEnd() { const st = readState(); st.aiSidebarWidth = width; writeState(st); }

  return {
    toggle: () => setOpen(!open),
    setOpen,
    isOpen: () => open,
    restore: () => { if (readState().aiSidebarOpen) setOpen(true); },
    resizeTo,
    resizeEnd,
    webContents: () => (view ? view.webContents : null),
  };
}

module.exports = { createSidebar };
