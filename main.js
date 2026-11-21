const { app, BrowserWindow, ipcMain, shell, screen, dialog } = require('electron');
const path = require('path');

// Every ipcMain.handle handler is also kept here so the AI assistant's tools can
// reuse them (deeplol, onetricks, op.gg, LCU import...) without a second copy.
const ipcHandlers = new Map();
{
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (ch, fn) => { ipcHandlers.set(ch, fn); return handle(ch, fn); };
}
const callIpc = async (ch, arg) => {
  const fn = ipcHandlers.get(ch);
  if (!fn) throw new Error('no handler ' + ch);
  return fn({ sender: null }, arg);
};

// Disable transparent window hardware acceleration issues on Windows that can freeze DWM / DirectX
app.commandLine.appendSwitch('disable-gpu-process-crash-limit');

let win = null;
let overlayWin = null;

// ---- Start with League (Settings) ----
// On: a tiny watcher (build/otp-watch.cs, a few MB in memory) is registered to run
// at Windows sign-in and started right away. It starts OTP Client when the League
// client starts. The app itself is never added to Windows startup and quits
// normally when closed. (0.1.15/0.1.16 registered the whole app hidden at sign-in;
// that entry is removed on every start.)
const WATCH_NAME = 'OTP Client League Watch';
let quitting = false;
let autoStartApplied = null;
// One instance (installed app only, so a dev run can sit next to it): a second
// launch (e.g. by the watcher) brings the running window back instead.
const gotLock = !app.isPackaged || app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => showMain());
app.on('before-quit', () => {
  quitting = true;
  // Update restart: leave at once. The silent installer (already spawned by
  // electron-updater) waits 1-3 s and force-kills if "OTP Client.exe" is still
  // running, so a normal multi-process shutdown only made the restart slower.
  if (updatingNow) setImmediate(() => app.exit(0));
});
let updatingNow = false;
// Before quitAndInstall: hide everything right away (instant feedback) and flush
// cookies / storage, since app.exit skips the normal shutdown.
function prepareUpdateRestart() {
  updatingNow = true;
  try { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy(); } catch {}
  try { if (win && !win.isDestroyed()) { win.hide(); win.webContents.session.flushStorageData(); } } catch {}
}
function showMain() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function watcherPath() {
  return app.isPackaged ? path.join(process.resourcesPath, 'otp-watch.exe') : path.join(__dirname, 'build', 'otp-watch.exe');
}
// Old versions put the app itself in Windows startup ("electron.app.OTP Client").
function removeOldAppStartup() {
  if (!app.isPackaged) return;
  try { app.setLoginItemSettings({ openAtLogin: false }); } catch {}
}
function applyAutoStart(on) {
  if (autoStartApplied === on) return;
  autoStartApplied = on;
  const st = readState();
  if (!!st.autoStart !== on) { st.autoStart = on; writeState(st); }
  if (!app.isPackaged) return; // dev: never touch Windows startup
  const w = watcherPath();
  const { spawn, execFile } = require('child_process');
  try { app.setLoginItemSettings({ openAtLogin: on, path: w, args: [process.execPath], name: WATCH_NAME }); } catch (e) { console.warn('[otp] login item:', e?.message || e); }
  if (on) {
    // Start watching now too; the watcher exits by itself if one is already running.
    try { spawn(w, [process.execPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (e) { console.warn('[otp] watcher:', e?.message || e); }
  } else {
    execFile('taskkill', ['/IM', 'otp-watch.exe', '/F'], { windowsHide: true }, () => {});
  }
}


function initAdblock(sess) {
  // Block common tracking and advertising hosts at the network request level
  // Hosts seen loading on onetricks.gg (2026-11-18): ad exchanges, header bidding,
  // ad-recovery / anti-adblock loaders (html-load.cc, btloader, ad-delivery, dns-finder),
  // the Intergi/Playwire wrapper, consent banners for ads, and ID-sync trackers.
  const AD = /googletagmanager|googlesyndication|googletagservices|doubleclick|adtrafficquality|fundingchoicesmessages|imasdk\.googleapis|clarity\.ms|vntsm\.com|venatus|adnuntius|browsiprod|pubmine|adpushup|nitropay|connatix|playwire|smilewanted|csync|adservice|criteo|outbrain|taboola|popads|adnxs|rubicon|pubmatic|amazon-adsystem|hotjar|fullstory|segment|mixpanel|amplitude|scorecardresearch|quantserve|crwdcntrl|demdex|mathtag|html-load\.cc|btloader\.com|ad-delivery\.net|dns-finder\.com|intergient\.com|intergi\.com|durationmedia|ccgateway\.net|adsrvr\.org|3lift\.com|smartadserver|casalemedia|indexww|liadm\.com|id5-sync|rlcdn\.com|hadronid|33across|seedtag|openx\.net|gumgum|richaudience|eyeota|dotomi|agkn\.com|fastclick\.net|privacymanager\.io|pubgw\.yahoo|analytics\.yahoo|carbonads|buysellads/i;
  // The ad-recovery loader rotates its domain (html-load.cc, *.stg.cafe.vividtomato.com, ...)
  // but keeps the URL shape: https://N.stg.<host>/session/xxx/xxx/xx/www.onetricks.gg/...
  const AD_PATH = /^https:\/\/[^/]*\.stg\.[^/]+\/session\/|\/session\/[a-z0-9]{3}\/[a-z0-9]{3}\/[a-z0-9]{2,3}\/www\.onetricks\.gg\//i;
  try {
    sess.webRequest.onBeforeRequest((details, cb) => {
      cb({ cancel: AD.test(details.url) || AD_PATH.test(details.url) });
    });
    console.log('[otp] adblock enabled');
  } catch (e) {
    console.log('[otp] adblock init failed:', String(e?.message ?? e));
  }
}

let ddragonCache = null;
let spellCache = null;
let runeCache = null;
let ddVersionCache = null;
async function getDdVersion() {
  if (ddVersionCache) return ddVersionCache;
  let version = '16.1.1';
  try {
    const vRes = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
    const vJson = await vRes.json();
    if (vJson?.[0]) version = vJson[0];
  } catch {}
  ddVersionCache = version;
  return version;
}
async function champIdToName(id) {
  try {
    const version = await getDdVersion();
    if (!ddragonCache) {
      const r = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`);
      ddragonCache = (await r.json()).data;
    }
    for (const k of Object.keys(ddragonCache)) {
      if (ddragonCache[k].key === String(id)) return ddragonCache[k].id;
    }
  } catch {}
  return null;
}
async function getSpellIcon(key) {
  try {
    const version = await getDdVersion();
    if (!spellCache) {
      const r = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/summoner.json`);
      const j = await r.json();
      spellCache = {};
      for (const k in j.data) {
        spellCache[String(j.data[k].key)] = `https://ddragon.leagueoflegends.com/cdn/${version}/img/spell/${j.data[k].image.full}`;
      }
    }
    return spellCache[String(key)] || null;
  } catch {}
  return null;
}
async function getRuneIcon(id) {
  try {
    const version = await getDdVersion();
    if (!runeCache) {
      const r = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/runesReforged.json`);
      const list = await r.json();
      runeCache = {};
      list.forEach((tree) => {
        runeCache[String(tree.id)] = `https://ddragon.leagueoflegends.com/cdn/img/${tree.icon}`;
        (tree.slots || []).forEach((slot) => {
          (slot.runes || []).forEach((rune) => {
            runeCache[String(rune.id)] = `https://ddragon.leagueoflegends.com/cdn/img/${rune.icon}`;
          });
        });
      });
    }
    return runeCache[String(id)] || null;
  } catch {}
  return null;
}

let lastSentChamp = null;
let lastAutoBuildId = null;
let champDebounceTimer = null;
const flags = { follow: true, autoBuild: true, autoAccept: false, autoSpell: true, overlay: false, winChance: false, helper: false, assistantOverlay: false, flashSlot: 'D' };
// The in-game overlay shows when either part is on: spell timers or win chance.
const overlayWanted = () => !!(flags.overlay || flags.winChance || flags.helper || flags.assistantOverlay) || process.env.OTP_OVERLAY_DEMO === '1';

let lobbyWatch = null;
let postGame = null;
ipcMain.handle('otp:postgame-get', () => (postGame ? postGame.current() : null));
ipcMain.on('otp:postgame-dismiss', (_e, id) => { if (postGame) postGame.dismiss(id); });
ipcMain.handle('otp:lobby-get', () => (lobbyWatch ? lobbyWatch.current() : null));

function startLcuLoops() {
  // Champ tracking loop (1.2s smooth poll)
  const lcu = require('./lcu.js');
  setInterval(async () => {
    try {
      if (!win || win.isDestroyed()) return;
      const { request } = require('league-connect');
      const creds = await lcu.getCreds();
      const res = await request({ method: 'GET', url: '/lol-champ-select/v1/session' }, creds);
      if (res.status !== 200) {
        lastSentChamp = null;
        lastAutoBuildId = null;
        if (champDebounceTimer) { clearTimeout(champDebounceTimer); champDebounceTimer = null; }
        return;
      }
      const s = await res.json();
      const me = (s.myTeam || []).find((p) => p.cellId === s.localPlayerCellId);
      const champId = me?.championId || me?.championPickIntent || 0;
      if (!champId) return;
      // Assigned lane (draft/ranked); onetricks role values: top, jungle, mid, bot, supp.
      const role = ({ top: 'top', jungle: 'jungle', middle: 'mid', bottom: 'bot', utility: 'supp' })[String(me?.assignedPosition || '').toLowerCase()] || '';
      const pickKey = champId + '|' + role;

      if (pickKey !== lastSentChamp) {
        lastSentChamp = pickKey;
        const name = await champIdToName(champId);
        if (!name) return;

        // Debounce by 700ms: if player quickly scrolls through champions, don't spam LCU/requests
        if (champDebounceTimer) clearTimeout(champDebounceTimer);
        champDebounceTimer = setTimeout(async () => {
          try {
            console.log(`[otp] Champ selected/hovered: ${name} (id: ${champId})`);

            // 1. Follow in browser window first or sync URL
            if (win && !win.isDestroyed()) {
              view.webContents.send('otp:auto-champ', name);
              if (flags.follow) {
                const curUrl = (view.webContents.getURL() || '').toLowerCase();
                const targetSlug = encodeURIComponent(name).toLowerCase();
                const onChamp = curUrl.includes(`/champions/builds/${targetSlug}`);
                const onRole = !role || new RegExp(`[?&]role=${role}(&|$)`).test(curUrl);
                if (!onChamp || !onRole) {
                  view.webContents.session.setPreloads([path.join(__dirname, 'preload.js')]);
                  await view.webContents.loadURL(`https://www.onetricks.gg/champions/builds/${encodeURIComponent(name)}${role ? `?role=${role}` : ''}`).catch(() => {});
                }
              }
            }

            // 2. Instant Auto-Import (Blitz/Mobalytics style)
            if (flags.autoBuild && lastAutoBuildId !== pickKey) {
              lastAutoBuildId = pickKey;
              let build = null;

              // Try extracting build from open browser window first (bypasses Cloudflare / 429 rate limits)
              if (win && !win.isDestroyed()) {
                try {
                  build = await view.webContents.executeJavaScript(`
                    (async () => {
                      try {
                        if (window.otp?.parseBuild) {
                          const b = await window.otp.parseBuild();
                          if (b && !b.error) return b;
                        }
                      } catch {}
                      return null;
                    })()
                  `);
                } catch {}
              }

              // Fallback to lcu.fetchOtpBuild if not on page or extraction failed
              if (!build || build.error) {
                try {
                  build = await lcu.fetchOtpBuild(name);
                } catch (fetchErr) {
                  console.warn(`[otp] Background fetch fallback warning:`, fetchErr?.message || fetchErr);
                }
              }

              if (build && build.runes?.selectedPerkIds) {
                build.flashSlot = flags.flashSlot || 'D';
                const creds = await lcu.getCreds();
                const [runeRes, itemRes, spellRes] = await Promise.allSettled([
                  lcu.importRunes(creds, build),
                  lcu.importItems(creds, build),
                  (flags.autoSpell !== false) ? lcu.importSpells(creds, build) : Promise.resolve(null)
                ]);
                const rOk = runeRes.status === 'fulfilled';
                const sOk = spellRes.status === 'fulfilled' && !!spellRes.value;
                console.log(`[otp] Instant hover import finished for ${name}: runes=${rOk} spells=${sOk}`);
                if (win && !win.isDestroyed()) {
                  view.webContents.send('otp:auto-imported', {
                    name,
                    spells: sOk,
                    rate: build.rate
                  });
                }
              } else {
                console.warn(`[otp] Could not retrieve build for ${name}`);
              }
            }
          } catch (e) {
            console.warn('[otp] debounce auto-import error:', e);
          }
        }, 700);
      }
    } catch {}
  }, 1200);

  // auto accept matches (1s)
  setInterval(async () => {
    try {
      if (!flags.autoAccept) return;
      const lcu = require('./lcu.js');
      const creds = await lcu.getCreds();
      const { request } = require('league-connect');
      const res = await request({ method: 'GET', url: '/lol-gameflow/v1/gameflow-phase' }, creds);
      if (res.status !== 200) return;
      const phase = await res.json();
      if (phase === 'ReadyCheck') {
        await request({ method: 'POST', url: '/lol-matchmaking/v1/ready-check/accept' }, creds);
        console.log('[otp] Match automatically accepted!');
      }
    } catch {}
  }, 1000);
}

// Frameless window: the page's own header is the title bar (drag region injected
// by the preloads), Windows keeps native min/max/close via titleBarOverlay, tinted
// to match the onetricks header so the app reads as one surface.
const CAPTION = { color: '#141415', symbolColor: '#e8e6e3', height: 66 };
let aiSidebar = null;
let applyCaption = () => {};
let view = null; // { webContents } alias kept so older call sites read the same
function pageKind(url) {
  const u = String(url || '');
  if (u.endsWith('tierlist.html')) return 'tier';
  if (u.endsWith('summoner.html')) return 'summoner';
  if (u.endsWith('wallpapers.html')) return 'wallpapers';
  if (/onetricks\.gg\/champions\/builds\//i.test(u)) return 'build';
  if (/onetricks\.gg/i.test(u)) return 'home';
  return 'other';
}
// Electron 31 keeps the site's header drag regions after navigating to a local
// file page and never applies the local page's own regions, so parts of our header
// (search box, icons) acted as a window drag area. Before leaving the site, switch
// its header to no-drag (leaving a 1 px drag anchor so a non-empty list is
// reported) and wait two frames. No-op when not on the site.
async function clearSiteDrag(wc) {
  if (!wc || wc.isDestroyed() || !/^https?:/i.test(wc.getURL())) return;
  try {
    await Promise.race([
      wc.executeJavaScript(`(() => {
        const s = document.createElement('style'); s.id = 'otp-leave-nodrag';
        s.textContent = 'header, header * { -webkit-app-region: no-drag !important; }';
        document.head.appendChild(s);
        const a = document.createElement('div'); a.id = 'otp-leave-anchor';
        a.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;-webkit-app-region:drag;pointer-events:none';
        document.body.appendChild(a);
        return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 40))));
      })()`, true),
      new Promise((r) => setTimeout(r, 400)),
    ]);
  } catch {}
}

function preloadFor(url) {
  const k = pageKind(url);
  if (k === 'tier') return path.join(__dirname, 'tier-preload.js');
  if (k === 'summoner') return path.join(__dirname, 'summoner-preload.js');
  if (k === 'wallpapers') return path.join(__dirname, 'wallpapers-preload.js');
  return path.join(__dirname, 'preload.js');
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    show: true,
    autoHideMenuBar: true,
    backgroundColor: '#181a1b',
    icon: path.join(__dirname, 'assets/icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: CAPTION,
    webPreferences: {
      // No fixed preload: the session preload is chosen per navigation (preloadFor),
      // so back/forward between the site and local pages get the right script, once.
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  view = { webContents: win.webContents };
  win.webContents.session.setPreloads([preloadFor('https://www.onetricks.gg')]);
  win.webContents.on('did-start-navigation', (d) => {
    if (d && d.isMainFrame === false) return;
    const url = d && d.url;
    if (url) win.webContents.session.setPreloads([preloadFor(url)]);
  });
  win.on('closed', () => { view = null; });
  // Shortcuts: Alt+Left/Right, F5.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const wc = win.webContents;
    // History may land on a local page: clear the site's drag regions first (see clearSiteDrag).
    if (input.alt && input.key === 'ArrowLeft') { e.preventDefault(); if (wc.canGoBack()) clearSiteDrag(wc).then(() => wc.goBack()); }
    else if (input.alt && input.key === 'ArrowRight') { e.preventDefault(); if (wc.canGoForward()) clearSiteDrag(wc).then(() => wc.goForward()); }
    else if (input.key === 'F5') { wc.reload(); e.preventDefault(); }
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  // Hide the Electron tag: some WAFs challenge non-standard UAs (error pages in-app while fetch works)
  view.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

  await initAdblock(view.webContents.session);
  view.webContents.loadURL('https://www.onetricks.gg').catch(e => {
    console.error('[otp] Failed to load onetricks.gg:', e);
  });

  view.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.warn(`[otp] did-fail-load: ${errorCode} (${errorDescription}) for ${validatedURL}`);
  });

  view.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://www.onetricks.gg')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---- OVERLAY WINDOW (auto-shown while a live game is detected) ----
// The overlay only appears while the League game window is in front, sized to that
// window (so it follows the game across monitors). Its window region is cut down
// to the panel (setShape): the panel always takes clicks, everything else is
// outside the window and goes straight to the game.
let leagueFg = null; // lazily created foreground-window probe (koffi -> user32/kernel32)
function leagueProbe() {
  if (leagueFg !== null) return leagueFg;
  try {
    const koffi = require('koffi');
    const u = koffi.load('user32.dll');
    const k = koffi.load('kernel32.dll');
    const RECT = koffi.struct('OTP_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
    const GetForegroundWindow = u.func('void* __stdcall GetForegroundWindow()');
    const GetWindowThreadProcessId = u.func('uint32 __stdcall GetWindowThreadProcessId(void* h, _Out_ uint32* pid)');
    const GetWindowRect = u.func('bool __stdcall GetWindowRect(void* h, _Out_ OTP_RECT* r)');
    const IsIconic = u.func('bool __stdcall IsIconic(void* h)');
    const OpenProcess = k.func('void* __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
    const QueryName = k.func('bool __stdcall QueryFullProcessImageNameW(void* h, uint32 flags, _Out_ uint16* buf, _Inout_ uint32* size)');
    const CloseHandle = k.func('bool __stdcall CloseHandle(void* h)');
    const names = new Map(); // pid -> exe basename
    leagueFg = () => {
      const h = GetForegroundWindow();
      if (!h || IsIconic(h)) return null;
      const pid = [0];
      GetWindowThreadProcessId(h, pid);
      let name = names.get(pid[0]);
      if (name === undefined) {
        name = '';
        const ph = OpenProcess(0x1000, false, pid[0]); // PROCESS_QUERY_LIMITED_INFORMATION
        if (ph) {
          const buf = new Uint16Array(520), size = [520];
          if (QueryName(ph, 0, buf, size)) name = String.fromCharCode(...buf.slice(0, size[0])).split(/[\\/]/).pop();
          CloseHandle(ph);
        }
        names.set(pid[0], name);
      }
      if (name.toLowerCase() !== 'league of legends.exe') return null;
      const r = {};
      if (!GetWindowRect(h, r)) return null;
      return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
    };
  } catch (e) {
    console.warn('[otp] foreground probe unavailable, overlay follows the primary display:', e?.message || e);
    leagueFg = () => ({ fallback: true });
  }
  return leagueFg;
}

function createOverlayWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  const { width, height } = screen.getPrimaryDisplay().bounds;
  overlayWin = new BrowserWindow({
    x: 0, y: 0, width, height,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: true,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // own session: the main window's session-wide page preloads must not run here
      partition: 'persist:otp-overlay'
    }
  });
  // Click-through by default; overlayHoverLoop turns input on only while the cursor is
  // over the panel. (setShape did not cut input on this transparent window on Windows
  // and the whole game became unclickable.)
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.webContents.on('console-message', (_e, _lvl, msg) => console.log('[otp] ov-console:', msg));
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWin.on('closed', () => { overlayWin = null; });
  // Typing ends when the overlay loses the keyboard (alt-tab, click into the game
  // or another app); otherwise it would stay on top outside the game.
  overlayWin.on('blur', () => { if (overlayTyping) overlayType(false); });
  return overlayWin;
}

// Called by the live loop while a game is running and the overlay is enabled.
let overlayBoundsKey = '';
function showOverlay() {
  const ow = createOverlayWindow();
  const game = process.env.OTP_OVERLAY_ANYWHERE === '1' ? { fallback: true } : leagueProbe()(); // test flag: show over anything
  if (!game) { if (overlayTyping) return; if (ow.isVisible()) ow.hide(); return; } // League not in front: hide (not while typing in the overlay)
  if (!game.fallback) {
    const dip = screen.screenToDipRect(null, game);
    const key = [dip.x, dip.y, dip.width, dip.height].map(Math.round).join(',');
    if (key !== overlayBoundsKey) { overlayBoundsKey = key; ow.setBounds({ x: Math.round(dip.x), y: Math.round(dip.y), width: Math.round(dip.width), height: Math.round(dip.height) }); }
  }
  ow.setAlwaysOnTop(true, 'screen-saver');
  if (!ow.isVisible()) ow.showInactive();
}

// Typing in the overlay (assistant chat): the overlay window normally never takes
// the keyboard; while typing it does, then gives it back to the game.
let overlayTyping = false;
function overlayType(on) {
  const ow = overlayWin;
  if (!ow || ow.isDestroyed()) return;
  overlayTyping = !!on;
  if (on) {
    ow.setFocusable(true);
    ow.setIgnoreMouseEvents(false);
    ow.focus();
    ow.webContents.send('otp:overlay-focus-chat');
  } else {
    ow.setFocusable(false);
    ow.blur();
  }
}
// Hotkey to start typing, only while in a game with the in-game assistant on.
const CHAT_KEY = 'CommandOrControl+Shift+Space';
let chatKeyOn = false;
function syncChatKey(want) {
  const { globalShortcut } = require('electron');
  if (want && !chatKeyOn) { try { chatKeyOn = globalShortcut.register(CHAT_KEY, () => overlayType(true)); } catch {} }
  else if (!want && chatKeyOn) { try { globalShortcut.unregister(CHAT_KEY); } catch {} chatKeyOn = false; }
}

function hideOverlay() {
  if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) {
    overlayWin.hide();
  }
}

// ---- LIVE CLIENT DATA (direct HTTPS, no LCU auth needed) ----
const httpsLive = require('https');
let ddragonBaseCache = null;
async function ddragonBase() {
  if (ddragonBaseCache) return ddragonBaseCache;
  let v = '16.1.1';
  try {
    const j = await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json();
    if (j?.[0]) v = j[0];
  } catch {}
  ddragonBaseCache = `https://ddragon.leagueoflegends.com/cdn/${v}`;
  return ddragonBaseCache;
}
function liveGet(pathname, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = httpsLive.request({
      hostname: '127.0.0.1', port: 2999, path: pathname,
      method: 'GET', rejectUnauthorized: false, timeout: timeoutMs
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('live HTTP ' + res.statusCode)); return; }
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// Fallback spell data (displayName -> [icon, baseCd]) if ddragon summoner.json is unreachable
const SPELL_FALLBACK = {
  Flash: ['SummonerFlash', 300], Teleport: ['SummonerTeleport', 360],
  Ignite: ['SummonerDot', 180], Exhaust: ['SummonerExhaust', 210],
  Heal: ['SummonerHeal', 270], Barrier: ['SummonerBarrier', 180],
  Ghost: ['SummonerHaste', 210], Cleanse: ['SummonerBoost', 210],
  Smite: ['SummonerSmite', 15], Mark: ['SummonerSnowball', 80],
  'Clarity': ['SummonerMana', 240]
};
let sumSpellMap = null;

// Current in-game spell art and cooldowns come from CommunityDragon (Data Dragon still
// ships the old icons and some old cooldowns, e.g. Heal/Exhaust). Falls back to
// summonerSpellInfo (Data Dragon) if CommunityDragon can't be reached.
const CDRAGON = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default';
let cdSpellMap = null;
async function spellInfoCurrent(displayName, ddragon) {
  try {
    if (!cdSpellMap) {
      const j = await (await fetch(`${CDRAGON}/v1/summoner-spells.json`)).json();
      const m = {};
      for (const s of j || []) {
        if (!(s.gameModes || []).includes('CLASSIC') || !s.iconPath) continue;
        const url = CDRAGON + '/' + s.iconPath.replace(/^\/lol-game-data\/assets\//i, '').toLowerCase();
        m[s.name] = { url, cd: Number(s.cooldown) || 180 };
      }
      if (Object.keys(m).length) cdSpellMap = m;
    }
    if (cdSpellMap) {
      // Upgraded forms ("Unleashed Teleport", "Primal Smite") map to the base spell.
      const names = Object.keys(cdSpellMap);
      const base = names.find((n) => n === displayName) || names.find((n) => String(displayName || '').includes(n));
      if (base) return cdSpellMap[base];
    }
  } catch {}
  const old = await summonerSpellInfo(displayName, ddragon);
  return { url: `${ddragon}/img/spell/${old.icon}.png`, cd: old.cd };
}

async function summonerSpellInfo(displayName, ddragon) {
  try {
    if (!sumSpellMap) {
      const j = await (await fetch(`${ddragon}/data/en_US/summoner.json`)).json();
      sumSpellMap = {};
      for (const v of Object.values(j.data || {})) {
        sumSpellMap[v.name] = { icon: String(v.image?.full || '').replace(/\.png$/i, ''), cd: parseInt(v.cooldownBurn, 10) || 180 };
      }
    }
    if (displayName && sumSpellMap[displayName]) return sumSpellMap[displayName];
  } catch {}
  const fb = SPELL_FALLBACK[displayName];
  return fb ? { icon: fb[0], cd: fb[1] } : { icon: 'SummonerFlash', cd: 180 };
}

// Enemy summoner spell timers only. Riot banned enemy ultimate timers in third-party
// apps (13 March 2025, manual or automatic), so the overlay has none.
// Ionian Boots of Lucidity (3158) give 10 summoner spell haste; items are public (Tab).
const SUMMONER_HASTE_ITEMS = { 3158: 10 };
async function buildOverlayPayload(data) {
  const ddragon = await ddragonBase();
  const meName = data.activePlayer?.riotId || data.activePlayer?.summonerName;
  const me = (data.allPlayers || []).find((p) => (p.riotId || p.summonerName) === meName);
  const myTeam = me?.team || 'ORDER';
  const players = [];
  for (const p of data.allPlayers || []) {
    if (!p.championName || p.team === myTeam) continue;
    const id = p.riotId || p.summonerName || p.championName;
    const haste = (p.items || []).reduce((h, it) => h + (SUMMONER_HASTE_ITEMS[it.itemID] || 0), 0);
    const s1 = p.summonerSpells?.summonerSpellOne?.displayName || 'Flash';
    const s2 = p.summonerSpells?.summonerSpellTwo?.displayName || 'Teleport';
    const [i1, i2] = await Promise.all([spellInfoCurrent(s1, ddragon), spellInfoCurrent(s2, ddragon)]);
    const cd = (base) => Math.round(base * 100 / (100 + haste));
    const champKey = String(p.rawChampionName || '').replace(/^.*_displayname_/, '') || p.championName.replace(/[^A-Za-z]/g, '');
    players.push({
      id, name: p.riotIdGameName || p.summonerName || id, champ: p.championName, champKey, level: p.level || null,
      position: p.position || '', haste,
      icon: `${ddragon}/img/champion/${champKey}.png`,
      spells: [
        { slot: 'D', name: s1, icon: i1.url, cd: cd(i1.cd) },
        { slot: 'F', name: s2, icon: i2.url, cd: cd(i2.cd) },
      ],
    });
  }
  const order = { TOP: 0, JUNGLE: 1, MIDDLE: 2, BOTTOM: 3, UTILITY: 4 };
  players.sort((a, b) => (order[a.position] ?? 9) - (order[b.position] ?? 9));
  return { players, gameTime: data.gameData?.gameTime ?? null };
}

// OTP_OVERLAY_DEMO=1: fake in-game data to work on the overlay without a game.
const DEMO_T0 = Date.now();
function demoGameData() {
  const P = (riotId, championName, team, position, s1, s2, items = []) => ({
    riotId, summonerName: riotId, riotIdGameName: riotId.split('#')[0], championName, team, position, level: 9,
    rawChampionName: 'game_character_displayname_' + championName.replace(/[^A-Za-z]/g, ''),
    items: items.map((itemID) => ({ itemID })),
    summonerSpells: { summonerSpellOne: { displayName: s1 }, summonerSpellTwo: { displayName: s2 } },
  });
  return {
    activePlayer: { riotId: 'Me#TR1', summonerName: 'Me#TR1' },
    allPlayers: [
      P('Me#TR1', 'Lucian', 'ORDER', 'BOTTOM', 'Flash', 'Heal'),
      P('TopGuy#EUW', 'Darius', 'CHAOS', 'TOP', 'Flash', 'Teleport'),
      P('Jgl#EUW', 'Hecarim', 'CHAOS', 'JUNGLE', 'Smite', 'Flash'),
      P('Mid#EUW', 'Ahri', 'CHAOS', 'MIDDLE', 'Flash', 'Ignite', [3158]),
      P('Adc#EUW', 'Jinx', 'CHAOS', 'BOTTOM', 'Flash', 'Cleanse'),
      P('Sup#EUW', 'Thresh', 'CHAOS', 'UTILITY', 'Flash', 'Exhaust'),
    ],
    gameData: { gameTime: 734 + (Date.now() - DEMO_T0) / 1000 },
  };
}

// Live win chance (winprob.js + winmodel.json, fitted by tools/winrate/fit.js).
// Worked out every poll, shown in steps of 3 game minutes (from 3:00) with the
// change since the last step; for my team.
let winItemValues = null;
let winShown = null; // { step, pct, prev }
async function liveWinChance(data) {
  const wp = require('./winprob.js');
  const model = require('./winmodel.json');
  if (!winItemValues) {
    const base = await ddragonBase();
    winItemValues = wp.itemValues(await (await fetch(`${base}/data/en_US/item.json`)).json());
  }
  const st = wp.fromLiveClient(data, winItemValues);
  const meName = data.activePlayer?.riotId || data.activePlayer?.summonerName;
  const me = (data.allPlayers || []).find((p) => (p.riotId || p.summonerName) === meName);
  const blue = wp.predict(st, model);
  const pct = Math.round((me?.team === 'CHAOS' ? 1 - blue : blue) * 100);
  const step = Math.floor(st.t / 3);
  if (st.t < 3) { winShown = null; return { pct: null, nextIn: Math.ceil((3 - st.t) * 60) }; }
  if (!winShown || step !== winShown.step) winShown = { step, pct, prev: winShown ? winShown.pct : null };
  return { pct: winShown.pct, prev: winShown.prev, nextIn: Math.ceil(((step + 1) * 3 - st.t) * 60) };
}

// Poll the Live Client: auto-show overlay in game, auto-hide when the game ends
let liveInGame = false;
let liveDbgCount = 0;
async function liveTick() {
  liveDbgCount++;
  try {
    const data = process.env.OTP_OVERLAY_DEMO === '1' ? demoGameData() : await liveGet('/liveclientdata/allgamedata');
    if (!data?.allPlayers?.length) throw new Error('no game');
    liveInGame = true;
    if (liveDbgCount % 10 === 1) {
      try {
        const dbgP = await buildOverlayPayload(data);
        console.log(`[otp] liveDBG inGame ov=${!!flags.overlay} win=${overlayWin ? (overlayWin.isDestroyed() ? 'dead' : (overlayWin.isVisible() ? 'visible' : 'hidden')) : 'none'} n=${data.allPlayers.length} enemies=${dbgP.players.length} me=${data.activePlayer?.riotId || data.activePlayer?.summonerName || '?'}`);
      } catch (e) { console.log('[otp] liveDBG payload err: ' + (e?.message || e)); }
    }
    syncChatKey(!!flags.assistantOverlay && process.env.OTP_NO_OVERLAY !== '1');
    if (process.env.OTP_NO_OVERLAY === '1' || !overlayWanted()) { hideOverlay(); return; } // OTP_NO_OVERLAY: dev runs while a game is open
    showOverlay();
    if (overlayWin && !overlayWin.isDestroyed()) {
      const payload = await buildOverlayPayload(data);
      // Spell timers off: no spells; the enemy rows stay (ranks) only with the helper on.
      if (!flags.overlay && process.env.OTP_OVERLAY_DEMO !== '1') payload.players = flags.helper ? payload.players.map((p) => ({ ...p, spells: [] })) : [];
      payload.win = flags.winChance || process.env.OTP_OVERLAY_DEMO === '1' ? await liveWinChance(data).catch(() => null) : null;
      payload.chat = flags.assistantOverlay ? { key: 'Ctrl+Shift+Space', mode: data.gameData?.gameMode || '' } : null;
      if (flags.helper || process.env.OTP_OVERLAY_DEMO === '1') {
        payload.helper = await require('./overlay-info.js').helper(data, await ddragonBase()).catch(() => null);
        // Enemy ranks / one-trick mark from the lobby scouting (Porofessor-style).
        const lob = lobbyWatch ? lobbyWatch.current() : null;
        const key = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
        const scout = {};
        for (const e of lob?.enemies || []) if (e.champ) scout[key(e.champ)] = e;
        for (const p of payload.players) {
          const e = scout[key(p.champKey)] || scout[key(p.champ)];
          if (e) p.scout = { tier: e.rank ? `${String(e.rank.tier).charAt(0)}${e.rank.division ? { I: 1, II: 2, III: 3, IV: 4 }[e.rank.division] || '' : ''}` : 'U', otp: !!e.recent?.otp, games: e.recent?.games ?? null, total: e.recent?.total ?? null };
        }
      }
      overlayWin.webContents.send('otp:overlay-players', payload);
    }
  } catch {
    if (liveInGame) { liveInGame = false; hideOverlay(); overlayTyping = false; }
    syncChatKey(false);
  }
}

function startLiveClientLoop() {
  liveTick();
  setInterval(liveTick, 3000);
  // Follow the game window quickly (alt-tab, move, resize) between the 3 s data polls.
  setInterval(() => {
    if (!liveInGame || process.env.OTP_NO_OVERLAY === '1' || !overlayWanted()) return;
    try { showOverlay(); } catch {}
  }, 300);
}

function registerOverlayIpc() {
  ipcMain.on('otp:overlay-close', () => { hideOverlay(); });
  // The overlay page reports the panel rectangle (page coordinates, DIP).
  ipcMain.on('otp:overlay-shape', (_e, rects) => {
    overlayPanelRects = Array.isArray(rects) ? rects.filter((r) => r && r.width > 0 && r.height > 0) : [];
  });
  // While the overlay is visible: take mouse input only when the cursor is over the
  // panel (checked every 50 ms from the real cursor position), otherwise ignore it so
  // every click goes to the game.
  setInterval(() => {
    if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) {
      if (overlayTakesInput && overlayWin && !overlayWin.isDestroyed()) overlayWin.setIgnoreMouseEvents(true);
      overlayTakesInput = false;
      return;
    }
    const c = screen.getCursorScreenPoint();
    const b = overlayWin.getBounds();
    const x = c.x - b.x, y = c.y - b.y;
    const inside = overlayPanelRects.some((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
    if (inside !== overlayTakesInput || overlayDragging) {
      if (overlayDragging && !inside) return; // keep input while dragging the panel
      overlayTakesInput = inside;
      overlayWin.setIgnoreMouseEvents(!inside);
    }
  }, 50);
  ipcMain.on('otp:overlay-dragging', (_e, on) => { overlayDragging = !!on; });
  ipcMain.on('otp:overlay-type', (_e, on) => overlayType(!!on));
  // In-game assistant: read the augment choice on screen (augments.js).
  ipcMain.handle('otp:augment-ask', async () => {
    try {
      const all = await liveGet('/liveclientdata/allgamedata');
      return await require('./augments.js').ask({ all, bounds: overlayWin && !overlayWin.isDestroyed() ? overlayWin.getBounds() : null });
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
}
let overlayPanelRects = [];
let overlayTakesInput = false;
let overlayDragging = false;

// ---- Auto update (GitHub releases of Lowell137/otp-client via electron-updater) ----
// Packaged builds only. Checks on start and every 4 hours, downloads in the
// background, then asks to restart; "Later" installs on the next quit. Installs are
// silent (isSilent=true): no installer window, the app just restarts on the new version.
// The state is pushed to the pages ('otp:update-state') for the settings menu
// ("Check for updates") and the round progress badge.
let updState = { state: 'idle' };
let updater = null;
function setUpdState(s) {
  updState = { ...s, current: app.getVersion() };
  if (win && !win.isDestroyed()) win.webContents.send('otp:update-state', updState);
}
ipcMain.handle('otp:update-get', () => ({ ...updState, current: app.getVersion() }));
ipcMain.handle('otp:update-check', async () => {
  if (!updater) { setUpdState({ state: app.isPackaged ? 'error' : 'dev', message: app.isPackaged ? 'Updater unavailable' : 'Updates work in the installed app only' }); return updState; }
  if (updState.state === 'downloading' || updState.state === 'ready') return updState;
  try { await updater.checkForUpdates(); } catch (e) { setUpdState({ state: 'error', message: String(e?.message || e).slice(0, 120) }); }
  return updState;
});
ipcMain.on('otp:update-install', () => { if (updater && updState.state === 'ready') { prepareUpdateRestart(); setImmediate(() => updater.quitAndInstall(true, true)); } });

function setupAutoUpdate() {
  if (!app.isPackaged) {
    // OTP_UPDATE_DEMO=1 (dev only): fake checking -> downloading 0..100% -> ready.
    if (process.env.OTP_UPDATE_DEMO === '1') {
      setTimeout(() => setUpdState({ state: 'checking' }), 3000);
      let p = 0;
      setTimeout(() => {
        const t = setInterval(() => {
          p += 7;
          if (p >= 100) { clearInterval(t); setUpdState({ state: 'ready', version: '9.9.9', percent: 100 }); }
          else setUpdState({ state: 'downloading', version: '9.9.9', percent: p });
        }, 400);
      }, 5000);
    }
    return;
  }
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) {
    console.warn('[otp] updater unavailable:', e?.message || e);
    return;
  }
  updater = autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => { if (updState.state !== 'downloading' && updState.state !== 'ready') setUpdState({ state: 'checking' }); });
  autoUpdater.on('update-not-available', () => setUpdState({ state: 'none', checkedAt: Date.now() }));
  autoUpdater.on('error', (e) => {
    console.warn('[otp] update error:', e?.message || e);
    if (updState.state !== 'ready') setUpdState({ state: 'error', message: String(e?.message || e).slice(0, 120) });
  });
  autoUpdater.on('update-available', (i) => { console.log('[otp] update available:', i?.version); setUpdState({ state: 'downloading', version: i?.version, percent: 0 }); });
  autoUpdater.on('download-progress', (p) => setUpdState({ state: 'downloading', version: updState.version, percent: Math.max(0, Math.min(100, Math.round(p?.percent || 0))) }));
  autoUpdater.on('update-downloaded', (info) => setUpdState({ state: 'ready', version: info?.version || updState.version, percent: 100 }));
  let asked = false;
  autoUpdater.on('update-downloaded', async (info) => {
    if (asked || !win || win.isDestroyed()) return;
    asked = true;
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'OTP Client',
      message: `Update ${info?.version || ''} is ready`,
      detail: 'Restart now to install it, or it will be installed when you close the app.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) { prepareUpdateRestart(); setImmediate(() => autoUpdater.quitAndInstall(true, true)); }
  });
  const check = () => autoUpdater.checkForUpdates().catch((e) => console.warn('[otp] update check failed:', e?.message || e));
  setTimeout(check, 5000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

// ---- "What's new" after an update ----
// userData/otp-state.json keeps the last version the user opened. When the running
// version differs, show changelog.json entries newer than that (just the current
// one on a first run) in a small modal window. OTP_WHATSNEW=1 forces it for testing.
const fsMod = require('fs');
const statePath = () => path.join(app.getPath('userData'), 'otp-state.json');
function readState() { try { return JSON.parse(fsMod.readFileSync(statePath(), 'utf8')); } catch { return {}; } }
function writeState(s) { try { fsMod.writeFileSync(statePath(), JSON.stringify(s, null, 2)); } catch {} }
function cmpVer(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}
// Shown inside the page (whatsnew.js). The version is only marked as seen once the
// user dismisses it; if the page navigates first, it is shown again on the next load.
let whatsNewPending = null;
function computeWhatsNew() {
  const current = app.getVersion();
  const last = readState().lastVersion || null;
  const force = process.env.OTP_WHATSNEW === '1';
  if (last === current && !force) return null;
  let log = [];
  try { log = JSON.parse(fsMod.readFileSync(path.join(__dirname, 'changelog.json'), 'utf8')); } catch {}
  let entries = log
    .filter((e) => cmpVer(e.version, current) <= 0 && (!last || force || cmpVer(e.version, last) > 0))
    .sort((a, b) => cmpVer(b.version, a.version));
  if (!last || force) entries = entries.filter((e) => e.version === current);
  if (!entries.length) { writeState({ ...readState(), lastVersion: current }); return null; }
  return { version: current, entries };
}
let whatsNewShowing = false;
function showWhatsNew() {
  if (!whatsNewPending || whatsNewShowing || !win || win.isDestroyed()) return;
  whatsNewShowing = true;
  const { overlayScript } = require('./whatsnew.js');
  win.webContents.executeJavaScript(overlayScript(whatsNewPending), true)
    .then((done) => {
      if (done) {
        writeState({ ...readState(), lastVersion: whatsNewPending.version });
        whatsNewPending = null;
      }
    })
    .catch(() => {})
    .finally(() => { whatsNewShowing = false; });
}

app.whenReady().then(async () => {
  if (!gotLock) return;
  await createWindow();
  removeOldAppStartup();
  if (readState().autoStart) { autoStartApplied = null; applyAutoStart(true); }
  setupAutoUpdate();
  whatsNewPending = computeWhatsNew();
  // Navigating away drops the pop-up (and its pending promise); show it again on the next page.
  win.webContents.on('did-start-navigation', (d) => { if (!d || d.isMainFrame !== false) whatsNewShowing = false; });
  win.webContents.on('did-finish-load', () => setTimeout(showWhatsNew, 1200));
  const lcu = require('./lcu.js');
  lcu.registerIpc(ipcMain);
  registerOverlayIpc();
  startLcuLoops();
  // Lobby scouting panel on build pages (players' rank, recent games on their pick).
  lobbyWatch = require('./lobby.js').createLobbyWatch({
    getCreds: () => require('./lcu.js').getCreds(),
    request: (...a) => require('league-connect').request(...a),
    champIdToName,
    liveGet,
    send: (st) => { if (win && !win.isDestroyed()) win.webContents.send('otp:lobby-state', st); },
  });
  lobbyWatch.start();
  // Post-game card (build page): result, LP change, stats and items vs the OTP build.
  postGame = require('./postgame.js').createPostGameWatch({
    getCreds: () => require('./lcu.js').getCreds(),
    request: (...a) => require('league-connect').request(...a),
    champIdToName,
    getLobby: () => (lobbyWatch ? lobbyWatch.current() : null),
    readState, writeState,
    send: (c) => { if (win && !win.isDestroyed()) win.webContents.send('otp:postgame', c); },
  });
  postGame.start();
  // AI assistant (ai/): chat page + tool-calling agent over the app's own data.
  require('./ai/index.js').register({
    ipcMain,
    ctx: { call: callIpc, getLobby: () => (lobbyWatch ? lobbyWatch.current() : null), liveGet },
  });
  // ...shown as a resizable panel on the right of every page.
  aiSidebar = require('./ai/sidebar.js').createSidebar({ getWin: () => win, readState, writeState, onToggle: () => applyCaption() });
  ipcMain.on('otp:ai-sidebar-toggle', () => aiSidebar.toggle());
  ipcMain.on('otp:ai-sidebar-close', () => aiSidebar.setOpen(false));
  ipcMain.on('otp:ai-resize', (_e, x) => aiSidebar.resizeTo(Number(x)));
  ipcMain.on('otp:ai-resize-end', () => aiSidebar.resizeEnd());
  ipcMain.handle('otp:ai-sidebar-get', () => aiSidebar.isOpen());
  aiSidebar.restore();
  startLiveClientLoop();
  // Pre-warm champion and ddragon caches in background for instant lookup
  champIdToName(1).catch(() => {});
  lcu.getChampId('Annie').catch(() => {});

  ipcMain.on('otp:win-min', () => { if (win && !win.isDestroyed()) win.minimize(); });
  ipcMain.on('otp:win-max', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
  });
  ipcMain.on('otp:win-close', () => { if (win && !win.isDestroyed()) win.close(); });
  ipcMain.handle('otp:win-is-max', () => (win && !win.isDestroyed()) ? win.isMaximized() : false);
  // Back / forward / reload buttons in the onetricks header (preload.js). Leaving
  // the site for a local page needs clearSiteDrag first (see loadLocal).
  ipcMain.on('otp:nav-back', () => { const wc = win && !win.isDestroyed() && view.webContents; if (wc && wc.canGoBack()) clearSiteDrag(wc).then(() => wc.goBack()); });
  ipcMain.on('otp:nav-forward', () => { const wc = win && !win.isDestroyed() && view.webContents; if (wc && wc.canGoForward()) clearSiteDrag(wc).then(() => wc.goForward()); });
  ipcMain.on('otp:nav-reload', () => { if (win && !win.isDestroyed()) view.webContents.reload(); });
  ipcMain.handle('otp:nav-state', () => {
    const wc = win && !win.isDestroyed() && view.webContents;
    return wc ? { back: wc.canGoBack(), forward: wc.canGoForward() } : { back: false, forward: false };
  });
  // Current-champion chip on local pages: open a build path on the site.
  ipcMain.on('otp:go-build', (_e, p) => {
    if (!win || win.isDestroyed()) return;
    const s = String(p || '');
    if (/^\/champions\/builds\/[A-Za-z]+(\?[A-Za-z0-9=&]*)?$/.test(s)) win.webContents.loadURL('https://www.onetricks.gg' + s);
  });

  // Wallpapers page: champion list and each champion's skins (Data Dragon).
  ipcMain.handle('otp:wall-champs', async () => {
    try {
      const base = await ddBase();
      const j = await (await fetch(`${base}/data/en_US/champion.json`)).json();
      return Object.values(j.data)
        .map((c) => ({ id: c.id, name: c.name, icon: `${base}/img/champion/${c.id}.png` }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch { return []; }
  });
  ipcMain.handle('otp:wall-skins', async (_e, id) => {
    try {
      if (!/^[A-Za-z]+$/.test(String(id))) return [];
      const base = await ddBase();
      const j = await (await fetch(`${base}/data/en_US/champion/${id}.json`)).json();
      return (j.data[id].skins || []).map((s) => ({ num: s.num, name: s.num === 0 ? 'Default' : s.name }));
    } catch { return []; }
  });

  // Native caption buttons follow the page header: same color (home #141415,
  // inner pages #212324) and same height so they sit on the nav row.
  // With the assistant panel open the buttons sit on the panel's top bar instead
  // (#212324, 56 px), whatever page is on the left.
  let lastCaption = '';
  let pageCaption = { color: CAPTION.color, height: CAPTION.height };
  applyCaption = () => {
    if (!win || win.isDestroyed()) return;
    const { color, height } = aiSidebar && aiSidebar.isOpen() ? { color: '#212324', height: 56 } : pageCaption;
    const key = color + height;
    if (key === lastCaption) return;
    lastCaption = key;
    try { win.setTitleBarOverlay({ color, symbolColor: CAPTION.symbolColor, height }); } catch {}
  };
  ipcMain.on('otp:caption', (_e, c) => {
    if (!win || win.isDestroyed() || !c) return;
    // #rrggbb, or #rrggbbaa (e.g. #00000000) so local pages can show the wallpaper behind the buttons.
    const color = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c.color) ? c.color : CAPTION.color;
    const height = Math.max(32, Math.min(72, Math.round(Number(c.height) || CAPTION.height)));
    pageCaption = { color, height };
    applyCaption();
  });
  // Window moving for local pages (their header has no CSS drag region; see shell.css).
  // Uses the real cursor position in DIPs, so scaling and multi-monitor stay right.
  let drag = null;
  ipcMain.on('otp:win-drag', (_e, phase) => {
    if (!win || win.isDestroyed()) return;
    const cur = screen.getCursorScreenPoint();
    if (phase === 'max') { win.isMaximized() ? win.unmaximize() : win.maximize(); return; }
    if (phase === 'start') {
      if (win.isMaximized()) {
        // Like a native title bar: restore under the cursor, keeping its relative x.
        const [mw] = win.getSize();
        const rel = Math.max(0, Math.min(1, (cur.x - win.getBounds().x) / mw));
        win.unmaximize();
        const [w] = win.getSize();
        win.setPosition(Math.round(cur.x - rel * w), Math.round(cur.y - 20));
      }
      const [x, y] = win.getPosition();
      drag = { dx: cur.x - x, dy: cur.y - y };
      return;
    }
    if (phase === 'move' && drag) { win.setPosition(cur.x - drag.dx, cur.y - drag.dy); return; }
    if (phase === 'end') drag = null;
  });
  // Champion search in the local pages' header -> onetricks build page.
  ipcMain.on('otp:open-champ', (_e, name) => {
    if (!win || win.isDestroyed()) return;
    const slug = String(name || '').replace(/[^A-Za-z]/g, '');
    if (slug) win.webContents.loadURL(`https://www.onetricks.gg/champions/builds/${encodeURIComponent(slug)}`);
  });

  // Local pages' header nav (same items as the onetricks header).
  // Electron 31 keeps the site's header drag regions after navigating to a local
  // file page and never applies the local page's own regions, so parts of our
  // header (search box, icons) acted as a window drag area. Before leaving the
  // site, switch its header to no-drag (leaving a 1 px drag anchor so a non-empty
  // list is reported), wait two frames, then navigate.
  async function loadLocal(file) {
    if (!win || win.isDestroyed()) return;
    await clearSiteDrag(win.webContents);
    if (!win || win.isDestroyed()) return;
    win.webContents.loadFile(path.join(__dirname, file));
  }

  ipcMain.on('otp:go', (_e, where) => {
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    const site = { home: '', guides: '/guides', discover: '/discover' };
    if (where in site) wc.loadURL('https://www.onetricks.gg' + site[where]);
    else if (where === 'tier') loadLocal('tierlist.html');
    else if (where === 'summoner') loadLocal('summoner.html');
    else if (where === 'wallpapers') loadLocal('wallpapers.html');
    else if (where === 'ai') { if (aiSidebar) aiSidebar.toggle(); }
    else if (where === 'back') { if (wc.canGoBack()) wc.goBack(); }
  });

  ipcMain.on('otp:settings', (_e, s) => {
    Object.assign(flags, s || {});
    if (s && 'autoStart' in s) applyAutoStart(!!s.autoStart);
    lcu.setFlags(flags);
    if (!overlayWanted()) hideOverlay();
  });
  ipcMain.on('otp:open-tier', () => {
    if (!win || win.isDestroyed()) return;
    loadLocal('tierlist.html');
  });
  ipcMain.on('otp:open-summoner', () => {
    if (!win || win.isDestroyed()) return;
    loadLocal('summoner.html');
  });
  ipcMain.on('otp:go-home', () => {
    if (!win || win.isDestroyed()) return;
    view.webContents.session.setPreloads([path.join(__dirname, 'preload.js')]);
    view.webContents.loadURL('https://www.onetricks.gg');
  });
  ipcMain.handle('otp:open-build', async (_e, slug) => {
    try {
      if (win && !win.isDestroyed()) {
        view.webContents.session.setPreloads([path.join(__dirname, 'preload.js')]);
        await view.webContents.loadURL(`https://www.onetricks.gg/champions/builds/${encodeURIComponent(slug)}`);
        if (win.isMinimized()) win.restore();
        win.focus();
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
  // Shared LCU player-data builder (no Riot key needed)
  let ddBaseCache = null;
  async function ddBase() {
    if (ddBaseCache) return ddBaseCache;
    let v = '16.1.1';
    try {
      const j = await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json();
      if (j?.[0]) v = j[0];
    } catch {}
    ddBaseCache = `https://ddragon.leagueoflegends.com/cdn/${v}`;
    return ddBaseCache;
  }
  const lcuNum = (o, ...ks) => { for (const k of ks) { const v = o?.[k]; if (typeof v === 'number') return v; } return 0; };
  const lcuBool = (o, ...ks) => { for (const k of ks) { const v = o?.[k]; if (typeof v === 'boolean') return v; } return false; };

  async function buildPlayerData(creds, puuid, ident) {
    const { request } = require('league-connect');
    const rj = async (method, url, body) => {
      const r = await request({ method, url, body }, creds);
      if (!r.ok && r.status !== 200) throw new Error('LCU ' + r.status);
      return r.json();
    };
    const base = await ddBase();
    let ranks = [];
    try {
      const rs = await rj('GET', `/lol-ranked/v1/ranked-stats/${puuid}`);
      const qm = rs?.queueMap || {};
      for (const [q, e] of Object.entries(qm)) {
        if (!e || !e.tier || e.tier === 'NONE') continue;
        ranks.push({ queueType: q, tier: e.tier, rank: e.division, leaguePoints: e.leaguePoints, wins: e.wins, losses: e.losses });
      }
    } catch {}
    let matches = [];
    try {
      const mh = await rj('GET', `/lol-match-history/v1/products/lol/${puuid}/matches?begIndex=0&endIndex=4`);
      const games = mh?.games?.games || mh?.games || [];
      for (const g of games.slice(0, 5)) {
        const st = g.stats || {};
        const cid = g.championId ?? 0;
        const cname = (cid && await champIdToName(cid)) || 'Unknown';
        matches.push({
          id: g.gameId, champ: cname,
          kills: lcuNum(st, 'kills', 'championsKilled', 'CHAMPIONS_KILLED'),
          deaths: lcuNum(st, 'deaths', 'numDeaths', 'NUM_DEATHS'),
          assists: lcuNum(st, 'assists', 'ASSISTS'),
          win: lcuBool(st, 'win', 'WIN'),
          queue: g.queueId, mode: g.gameMode,
          cs: lcuNum(st, 'minionsKilled', 'MINIONS_KILLED') + lcuNum(st, 'neutralMinionsKilled', 'NEUTRAL_MINIONS_KILLED')
        });
      }
    } catch {}
    let w = 0, k = 0, d = 0, a = 0;
    matches.forEach((m) => { if (m.win) w++; k += m.kills; d += m.deaths; a += m.assists; });
    const n = matches.length || 1;
    const wr = Math.round((w / n) * 100);
    const kda = ((k + a) / Math.max(1, d)).toFixed(2);
    const champs = {};
    matches.forEach((m) => {
      const c = (champs[m.champ] = champs[m.champ] || { champ: m.champ, icon: `${base}/img/champion/${m.champ}.png`, g: 0, w: 0, k: 0, d: 0, a: 0 });
      c.g++; if (m.win) c.w++; c.k += m.kills; c.d += m.deaths; c.a += m.assists;
    });
    return {
      ok: true,
      profile: { name: ident.name, tag: ident.tag || '', level: ident.level, iconUrl: `${base}/img/profileicon/${ident.iconId}.png` },
      ranks,
      matches: matches.map((m) => ({ ...m, icon: `${base}/img/champion/${m.champ}.png` })),
      champs: Object.values(champs).sort((x, y) => y.g - x.g),
      score: { value: Math.min(9999, Math.round(wr * 50 + ((k + a) / Math.max(1, d)) * 120)), wr, kda, games: n }
    };
  }

  // My account: everything via LCU, no key, no typing
  ipcMain.handle('otp:myaccount', async () => {
    try {
      const { request } = require('league-connect');
      const { getCreds } = require('./lcu-creds');
      const creds = await getCreds();
      const r = await request({ method: 'GET', url: '/lol-summoner/v1/current-summoner' }, creds);
      const sum = await r.json();
      return await buildPlayerData(creds, sum.puuid, {
        name: sum.displayName || sum.gameName, tag: sum.tagLine || '', level: sum.summonerLevel, iconId: sum.profileIconId
      });
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  // Lobby scouting: whole team in champ select, no key, no typing
  ipcMain.handle('otp:lobby', async () => {
    try {
      const { request } = require('league-connect');
      const { getCreds } = require('./lcu-creds');
      const creds = await getCreds();
      const r = await request({ method: 'GET', url: '/lol-champ-select/v1/session' }, creds);
      if (r.status !== 200) throw new Error('Not in champion select');
      const s = await r.json();
      const team = [];
      for (const p of s.myTeam || []) {
        if (!p.summonerId) continue;
        try {
          const sr = await request({ method: 'GET', url: `/lol-summoner/v1/summoners/${p.summonerId}` }, creds);
          const si = await sr.json();
          const data = await buildPlayerData(creds, si.puuid, {
            name: si.displayName || si.gameName, tag: si.tagLine || '', level: si.summonerLevel, iconId: si.profileIconId
          });
          const cid = p.championId || p.championPickIntent || 0;
          data.pick = cid ? await champIdToName(cid) : null;
          team.push(data);
        } catch {}
      }
      const foes = [];
      for (const p of s.theirTeam || []) {
        const cid = p.championId || p.championPickIntent || 0;
        if (cid) foes.push(await champIdToName(cid));
      }
      if (!team.length) throw new Error('Lobby is empty');
      return { ok: true, team, foes };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
  // deeplol lookup: keyless, via their internal CDN API (matches + per-match AI score)
  const DL = 'https://b2c-api-cdn.deeplol.gg';
  const DL_H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://www.deeplol.gg/' };
  // deeplol DNS'i her seferde farklı edge IP veriyor, bazıları yanıt vermiyor.
  // curl gibi davran: tüm IP'leri çöz, kısa timeout'la tek tek dene.
  const dnsP = require('dns').promises;
  const httpsMod = require('https');
  // One pooled keep-alive agent: every deeplol call used to open a fresh TLS
  // connection (~150-700 ms each). Reuse sockets instead.
  const dlAgent = new httpsMod.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 30000 });
  function dlFetchText(url, timeoutMs = 4000) {
    const fast = new Promise((resolve, reject) => {
      const req = httpsMod.request(url, { headers: DL_H, agent: dlAgent, timeout: Math.min(timeoutMs, 3500) }, (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error('deeplol HTTP ' + res.statusCode)); return; }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
    return fast.catch((e) => {
      if (/HTTP 4\d\d/.test(String(e?.message))) throw e;
      return dlFetchTextSlow(url, timeoutMs);
    });
  }
  // Fallback: some edge IPs hang, so resolve all of them and try each with a short timeout.
  function dlFetchTextSlow(url, timeoutMs = 4000) {
    const u = new URL(url);
    const standardFetch = () => new Promise((resolve, reject) => {
      const req = httpsMod.request(url, { headers: DL_H, timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error('deeplol HTTP ' + res.statusCode)); return; }
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });

    return dnsP.resolve4(u.hostname).catch(() => []).then(async (ips) => {
      ips = (ips || []).sort(() => Math.random() - 0.5).slice(0, 4);
      if (!ips.length) return await standardFetch();
      const tryIp = (ip) => new Promise((resolve, reject) => {
        const req = httpsMod.request(url, {
          headers: DL_H,
          lookup: (h, o, cb) => {
            const callback = typeof o === 'function' ? o : cb;
            const wantAll = o && typeof o === 'object' && o.all;
            if (wantAll) callback(null, [{ address: ip, family: 4 }]);
            else callback(null, ip, 4);
          },
          family: 4,
          autoSelectFamily: false,
          servername: u.hostname,
          timeout: timeoutMs,
        }, (res) => {
          if (res.statusCode !== 200) { res.resume(); reject(new Error('deeplol HTTP ' + res.statusCode)); return; }
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve(data));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
      });
      for (const ip of ips) {
        try { return await tryIp(ip); } catch {}
      }
      return await standardFetch();
    });
  }
  ipcMain.handle('otp:deeplol', async (_e, q) => {
    try {
      const platform = (q?.region || 'tr1').toUpperCase();
      const gameName = (q?.gameName || '').trim();
      const tagLine = (q?.tagLine || '').trim();
      if (!gameName || !tagLine) throw new Error('Type Name#TAG');
      const get = async (url, step, tries = 2, timeout = 5000, sleep = 400) => {
        let lastErr = null;
        for (let attempt = 0; attempt < tries; attempt++) {
          try {
            return JSON.parse(await dlFetchText(url, timeout));
          } catch (e) {
            lastErr = e;
            await new Promise((res) => setTimeout(res, sleep));
          }
        }
        throw new Error(`${step}: ${lastErr?.message ?? lastErr}`);
      };
      const matchesUrl = (puu) => `${DL}/match/matches?puu_id=${encodeURIComponent(puu)}&platform_id=${platform}&offset=0&count=30&queue_type=ALL&champion_id=-1&only_list=1&last_updated_at=1`;
      const listP = get(`${DL}/summoner/list?platform_id=${platform}&riot_id_name=${encodeURIComponent(gameName)}`, 'search');
      const profP = get(`${DL}/summoner/summoner?riot_id_name=${encodeURIComponent(gameName)}&riot_id_tag_line=${encodeURIComponent(tagLine)}&platform_id=${platform}`, 'profile');
      // Don't wait for the account list: once the profile has a puuid, start the
      // match list right away (and warm the first match details) in parallel.
      let earlyMl = null;
      if (!q?.fresh) {
        earlyMl = profP.then((p) => {
          const puu = p?.summoner_basic_info_dict?.puu_id;
          if (!puu) return null;
          return get(matchesUrl(puu), 'matches').then((ml) => {
            dlPrefetch(puu, platform, ml);
            return { puu, ml };
          });
        }).catch(() => null);
      }
      const [list, profDirect] = await Promise.all([listP.catch((e) => ({ _err: e })), profP.catch((e) => ({ _err: e }))]);
      if (list._err) throw list._err;
      const entry = ((list || {}).lists || []).find((e) => String(e.riot_id_tag_line || '').toLowerCase() === tagLine.toLowerCase());
      if (!entry) throw new Error('Account not found on deeplol');
      let prof = profDirect._err ? null : profDirect;
      if (!prof || prof?.summoner_basic_info_dict?.puu_id == null) {
        prof = await get(`${DL}/summoner/summoner?riot_id_name=${encodeURIComponent(entry.riot_id_name)}&riot_id_tag_line=${encodeURIComponent(entry.riot_id_tag_line)}&platform_id=${platform}`, 'profile');
      }
      const puu = prof?.summoner_basic_info_dict?.puu_id;
      if (!puu) throw new Error('No match data for this account');
      if (q?.fresh) {
        // deeplol's own update flow + drop local cache
        dlMatchCache.clear();
        try {
          await dlPostJson('https://renew.deeplol.gg/match/check-refresh', { puu_id: puu, platform_id: platform });
          await dlPostJson('https://renew.deeplol.gg/match/refresh-matches', { puu_id: puu, platform_id: platform, queue_type: 'ALL', start_idx: 0, count: 30 }, 25000);
        } catch {}
      }
      const basP = ddBase();
      const early = earlyMl ? await earlyMl : null;
      const ml = (early && early.puu === puu) ? early.ml : await get(matchesUrl(puu), 'matches');
      if (!early || early.puu !== puu) dlPrefetch(puu, platform, ml);
      const base = await basP;
      const pendingIds = ((ml || {}).match_id_list || []).slice(0, 30).map((x) => ({ id: x.match_id, ts: x.match_creation_time }));
      const parts = String(entry.tier || '').split(' ');
      return {
        ok: true, source: 'deeplol', puuid: puu, platform, pendingIds,
        summonerId: prof?.summoner_basic_info_dict?.summoner_id || '',
        profile: { name: entry.riot_id_name, tag: entry.riot_id_tag_line, level: entry.summoner_level, iconUrl: `${base}/img/profileicon/${entry.profile_id}.png` },
        ranks: [{ queueType: 'Ranked', tier: parts[0] || '?', rank: parts[1] || '', leaguePoints: entry.lp ?? 0, wins: null, losses: null }]
      };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  // Everything deeplol's own profile page shows that the match list doesn't:
  // live ranks (solo/flex with W/L and peak), the LP history, season champion
  // stats and deeplol's last update time.
  ipcMain.handle('otp:deeplol-extra', async (_e, q) => {
    const platform = String(q?.platform || 'TR1').toUpperCase();
    const puu = encodeURIComponent(String(q?.puuid || ''));
    const sid = encodeURIComponent(String(q?.summonerId || ''));
    const j = (u) => dlFetchText(u, 6000).then((t) => JSON.parse(t)).catch(() => null);
    let season = 27;
    try { const s = await j(`${DL}/common/season-list`); if (s?.season_list?.[0]) season = s.season_list[0]; } catch {}
    const [rt, chart, cs, up] = await Promise.all([
      // summoner_id is empty for newer accounts; the endpoint only needs the key present.
      j(`${DL}/summoner/summoner-realtime?puu_id=${puu}&platform_id=${platform}&summoner_id=${sid}`),
      j(`${DL}/summoner/tier-chart?puu_id=${puu}&platform_id=${platform}&last_match_id=0`),
      j(`${DL}/summoner/champion-stat?puu_id=${puu}&season=${season}&platform_id=${platform}`),
      j(`${DL}/summoner/updated-time?puu_id=${puu}&platform_id=${platform}`),
    ]);
    const conv = (x) => (x && x.tier ? { tier: x.tier, division: x.division, lp: x.league_points, wins: x.wins, losses: x.losses, peak: x.high_tier || '', peakLp: x.high_lp ?? null } : null);
    const champStats = {};
    for (const [qk, block] of Object.entries(cs?.counter_champion_stats || {})) {
      const list = block?.enemy_champion_stats?.All || [];
      champStats[qk] = [];
      for (const c of list) {
        if (!c || !c.champion_id) continue;
        champStats[qk].push({
          champ: (await champIdToName(c.champion_id)) || String(c.champion_id), games: c.games, wins: c.wins, losses: c.losses,
          wr: c.win_rate, kda: c.kda, k: c.kills, d: c.deaths, a: c.assists, cspm: c.cs_per_min,
          dpm: c.damage_dealt_per_min, gd15: c.gold_diff_15, ai: c.ai_score,
        });
      }
      champStats[qk].sort((a, b) => b.games - a.games);
    }
    return {
      ranks: { solo: conv(rt?.season_tier_info_dict?.ranked_solo_5x5), flex: conv(rt?.season_tier_info_dict?.ranked_flex_sr) },
      lpHistory: { solo: chart?.ranked_solo_5x5 || [], flex: chart?.ranked_flex_sr || [] },
      champStats,
      updatedAt: up?.updated_timestamp || null,
    };
  });

  // ---- Summoner page start screen: your account + best one-tricks of your mains ----
  const REGION_PLATFORM = { TR: 'tr1', EUW: 'euw1', EUNE: 'eun1', NA: 'na1', BR: 'br1', LAN: 'la1', LAS: 'la2', KR: 'kr', JP: 'jp1', OCE: 'oc1', OC1: 'oc1', RU: 'ru', ME: 'me1', SG: 'sg2', TW: 'tw2', VN: 'vn2' };
  // Account logged in to the League client (remembered for when the client is closed).
  ipcMain.handle('otp:my-account', async () => {
    try {
      const { request } = require('league-connect');
      const creds = await require('./lcu.js').getCreds();
      const j = async (u) => { const r = await request({ method: 'GET', url: u }, creds); return r.status === 200 ? r.json() : null; };
      const [me, rl] = await Promise.all([j('/lol-summoner/v1/current-summoner'), j('/riotclient/region-locale')]);
      if (!me || !me.gameName) throw new Error('no summoner');
      const acc = {
        name: me.gameName, tag: me.tagLine || '', level: me.summonerLevel, iconId: me.profileIconId,
        region: REGION_PLATFORM[String(rl?.region || '').toUpperCase()] || '', live: true,
      };
      const st = readState();
      st.myAccount = { ...acc, live: false };
      writeState(st);
      return acc;
    } catch {
      return readState().myAccount || null;
    }
  });
  // Most played champions this season for an account (deeplol champion-stat).
  ipcMain.handle('otp:my-mains', async (_e, q) => {
    try {
      const platform = String(q?.region || 'tr1').toUpperCase();
      const prof = JSON.parse(await dlFetchText(`${DL}/summoner/summoner?riot_id_name=${encodeURIComponent(q?.name || '')}&riot_id_tag_line=${encodeURIComponent(q?.tag || '')}&platform_id=${platform}`, 6000));
      const puu = prof?.summoner_basic_info_dict?.puu_id;
      if (!puu) return [];
      let season = 27;
      try { const s = JSON.parse(await dlFetchText(`${DL}/common/season-list`, 5000)); if (s?.season_list?.[0]) season = s.season_list[0]; } catch {}
      const cs = JSON.parse(await dlFetchText(`${DL}/summoner/champion-stat?puu_id=${encodeURIComponent(puu)}&season=${season}&platform_id=${platform}`, 8000));
      const list = (cs?.counter_champion_stats?.total?.enemy_champion_stats?.All || []).filter((c) => c && c.champion_id).sort((a, b) => b.games - a.games).slice(0, 3);
      const out = [];
      for (const c of list) out.push({ champ: (await champIdToName(c.champion_id)) || '', games: c.games, wr: c.win_rate });
      return out.filter((c) => c.champ);
    } catch { return []; }
  });
  // A champion's best one-tricks from onetricks' Ranking page, read with the app's
  // own browser session (the same one the build pages use).
  const otpRankCache = new Map();
  ipcMain.handle('otp:otp-ranking', async (_e, champ) => {
    const c = String(champ || '').replace(/[^A-Za-z]/g, '');
    if (!c || !win || win.isDestroyed()) return [];
    const hit = otpRankCache.get(c);
    if (hit && Date.now() - hit.ts < 30 * 60 * 1000) return hit.list;
    try {
      const r = await win.webContents.session.fetch(`https://www.onetricks.gg/champions/ranking/${c}`, {
        headers: { 'User-Agent': win.webContents.getUserAgent() },
      });
      if (!r.ok) return [];
      const html = await r.text();
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      const rk = m ? JSON.parse(m[1])?.props?.pageProps?.rankings : null;
      const key = rk ? Object.keys(rk).find((k) => /^S\d/.test(k)) || Object.keys(rk)[0] : null;
      const list = ((key && rk[key]?.mainsData) || []).slice(0, 10).map((p) => {
        const [name, tag] = String(p.player || '').split(' #');
        return {
          name: (name || '').trim(), tag: (tag || '').trim(), region: String(p.region || '').toLowerCase(),
          tier: p.tier, lp: p.lp, games: p.mainGames, wr: p.winrate, kda: p.kda, iconId: p.profileIconId, otp: !!p.otp,
        };
      }).filter((p) => p.name && p.tag);
      otpRankCache.set(c, { ts: Date.now(), list });
      return list;
    } catch (e) {
      console.warn('[otp] ranking fetch:', e?.message || e);
      return [];
    }
  });
  // op.gg ARAM Mayhem / Arena: build + augment stats for a champion (opgg.js).
  ipcMain.handle('otp:opgg-mode', async (_e, q) => {
    try { return await require('./opgg.js').modeData(q?.mode, q?.champ); }
    catch (e) { return { error: String(e?.message || e) }; }
  });
  // deeplol's "Update" button: refresh matches, ranks and champion stats.
  ipcMain.handle('otp:deeplol-renew', async (_e, q) => {
    const platform = String(q?.platform || 'TR1').toUpperCase();
    const puu = String(q?.puuid || '');
    if (!puu) return { ok: false };
    dlMatchCache.clear();
    const body = { puu_id: puu, platform_id: platform };
    try { await dlPostJson('https://renew.deeplol.gg/match/check-refresh', body); } catch {}
    const r = await Promise.allSettled([
      dlPostJson('https://renew.deeplol.gg/match/refresh-matches', { ...body, queue_type: 'ALL', start_idx: 0, count: 30 }, 25000),
      dlPostJson('https://renew.deeplol.gg/match/refresh_tier', body, 15000),
      dlPostJson('https://renew.deeplol.gg/match/refresh-champion-stat', body, 25000),
    ]);
    return { ok: r[0].status === 'fulfilled', parts: r.map((x) => x.status) };
  });
  function dlPostJson(url, body, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = httpsMod.request(url, {
        method: 'POST',
        headers: { ...DL_H, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: timeoutMs,
      }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error('renew HTTP ' + res.statusCode)); return; }
          try { resolve(JSON.parse(out)); } catch { resolve(out); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(data);
    });
  }
  const dlMatchCache = new Map();
  // In-flight detail requests, keyed by match+player, so the prefetch started during
  // the profile lookup and the renderer's request share one network call.
  const dlInflight = new Map();
  function dlPrefetch(puu, platform, ml) {
    const ids = ((ml || {}).match_id_list || []).slice(0, 10).map((x) => x.match_id);
    if (!ids.length) return;
    ddBase().then((base) => runPool(ids, 6, (id) => dlMatchDetail(id, platform, puu, base))).catch(() => {});
  }
  async function runPool(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { err: String(e?.message ?? e) }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }
  function dlMatchDetail(matchId, platform, puu, base) {
    const hit = dlMatchCache.get(matchId);
    if (hit && hit.puu === puu && Date.now() - hit.ts < 10 * 60 * 1000) return Promise.resolve({ m: hit.m });
    const key = matchId + '|' + puu;
    if (dlInflight.has(key)) return dlInflight.get(key);
    const p = dlMatchDetailFetch(matchId, platform, puu, base).finally(() => dlInflight.delete(key));
    dlInflight.set(key, p);
    return p;
  }
  async function dlMatchDetailFetch(matchId, platform, puu, base) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const det = JSON.parse(await dlFetchText(`${DL}/match/match-cached?match_id=${matchId}&platform_id=${platform}`, 6000));
        const plist = (det || {}).participants_list || [];
        const p = plist.find((x) => x.puu_id === puu);
        if (!p) return null;
        const fs = p.final_stat_dict || {};
        const cname = (p.champion_id && await champIdToName(p.champion_id)) || ('#' + p.champion_id);
        const blueWin = det?.match_basic_dict?.blue_win;

        // Player spells & runes
        const mySpells = [
          await getSpellIcon(p.spell_id_dict?.spell_1),
          await getSpellIcon(p.spell_id_dict?.spell_2),
        ].filter(Boolean);
        const myRunes = [
          await getRuneIcon(p.rune_detail_dict?.perk_0),
          await getRuneIcon(p.rune_detail_dict?.perk_sub_style),
        ].filter(Boolean);

        // Compute match fate diff (my team avg AI vs opp team avg AI)
        const myTeamList = plist.filter((x) => x.side === p.side && x.puu_id !== puu);
        const oppTeamList = plist.filter((x) => x.side !== p.side);
        const myTeamAvg = myTeamList.reduce((s, x) => s + (x.final_stat_dict?.ai_score || 0), 0) / (myTeamList.length || 1);
        const oppTeamAvg = oppTeamList.reduce((s, x) => s + (x.final_stat_dict?.ai_score || 0), 0) / (oppTeamList.length || 1);
        const teamDiff = myTeamAvg - oppTeamAvg;

        const teams = [];
        for (const x of plist) {
          const xfs = x.final_stat_dict || {};
          const xc = (x.champion_id && await champIdToName(x.champion_id)) || ('#' + x.champion_id);
          const fi = x.final_item_dict || {};
          const xitems = [0, 1, 2, 3, 4, 5].map((k) => {
            const id = fi['item_' + k] ?? 0;
            return id ? { id, icon: `${base}/img/item/${id}.png` } : null;
          });
          const trinketId = fi['item_6'] ?? 0;
          const xtrinket = trinketId ? { id: trinketId, icon: `${base}/img/item/${trinketId}.png` } : null;
          const xspells = [
            await getSpellIcon(x.spell_id_dict?.spell_1),
            await getSpellIcon(x.spell_id_dict?.spell_2),
          ].filter(Boolean);
          const xrunes = [
            await getRuneIcon(x.rune_detail_dict?.perk_0),
            await getRuneIcon(x.rune_detail_dict?.perk_sub_style),
          ].filter(Boolean);

          teams.push({
            name: x.riot_id_name || x.summoner_name || '?', tag: x.riot_id_tag_line || '',
            champ: xc, icon: `${base}/img/champion/${xc}.png`,
            kills: xfs.kills ?? 0, deaths: xfs.deaths ?? 0, assists: xfs.assists ?? 0,
            ai: xfs.ai_score ?? null, lvl: xfs.champion_level ?? null,
            dmg: x.total_damage_dealt ?? 0,
            cs: xfs.cs ?? 0,
            gold: x.total_gold ?? 0, items: [...xitems, xtrinket], trinket: xtrinket,
            spells: xspells, runes: xrunes,
            tier: [x.tier, x.division].filter(Boolean).join(' '),
            side: x.side, win: blueWin == null ? !!x.is_win : ((x.side === 'BLUE') === !!blueWin),
            mvp: !!x.mvp, ace: !!x.ace, position: x.position || ''
          });
        }
        const m = {
          id: matchId, champ: cname, icon: `${base}/img/champion/${cname}.png`,
          kills: fs.kills ?? 0, deaths: fs.deaths ?? 0, assists: fs.assists ?? 0,
          win: !!p.is_win, queue: det?.match_basic_dict?.queue_id, mode: '',
          dur: det?.match_basic_dict?.game_duration ?? null,
          ts: det?.match_basic_dict?.creation_timestamp ?? null,
          cs: fs.cs ?? 0, ai: fs.ai_score ?? null,
          spells: mySpells, runes: myRunes,
          mvp: !!p.mvp, ace: !!p.ace, position: p.position || '',
          teamDiff,
          teams,
          // Match detail tabs (summoner page): this player's purchase timeline, skill
          // order and full rune page, and the team's win chance over time.
          build: {
            items: (() => {
              const out = [];
              for (const e of p.item_seq_list || []) {
                if (e.type !== 'ITEM_PURCHASED' || !e.item_id) continue;
                const last = out[out.length - 1];
                const it = { id: e.item_id, icon: `${base}/img/item/${e.item_id}.png` };
                if (last && last.min === e.minute) last.items.push(it); else out.push({ min: e.minute, items: [it] });
              }
              return out;
            })(),
            skills: (p.skill_seq_list || []).filter((e) => e.type === 'NORMAL' || !e.type).map((e) => e.skill_id).slice(0, 18),
            runes: await (async () => {
              const rd = p.rune_detail_dict || {};
              const icon = async (id) => (id ? await getRuneIcon(id) : null);
              return {
                primary: await Promise.all([rd.perk_0, rd.perk_1, rd.perk_2, rd.perk_3].map(icon)),
                secondary: await Promise.all([rd.perk_4, rd.perk_5].map(icon)),
                primaryStyle: await icon(rd.perk_primary_style),
                subStyle: await icon(rd.perk_sub_style),
              };
            })(),
          },
          winChance: (() => {
            // time_analysis win_rate: blue side's lead in percentage points over 50.
            const ev = det?.time_analysis?.concat_events_dict || {};
            // Each minute holds numbered kill events plus other keys (tower_plate,
            // building); every entry that carries a win_rate is a point on the curve.
            const pts = [];
            for (const minute of Object.keys(ev)) {
              for (const e of Object.values(ev[minute] || {})) {
                if (!e || typeof e.win_rate !== 'number') continue;
                const blue = Math.max(0, Math.min(100, 50 + e.win_rate));
                pts.push({ t: typeof e.time === 'number' ? e.time : Number(minute), wr: p.side === 'BLUE' ? blue : 100 - blue });
              }
            }
            pts.sort((a, b) => a.t - b.t);
            if (pts.length) pts.unshift({ t: 0, wr: 50 });
            return pts;
          })(),
        };
        dlMatchCache.set(matchId, { ts: Date.now(), m, puu });
        return { m };
      } catch (e) {
        lastErr = e;
        await new Promise((res) => setTimeout(res, 700 * (attempt + 1)));
      }
    }
    return { err: String(lastErr?.message ?? lastErr).slice(0, 80) };
  }
  ipcMain.handle('otp:deeplol-matches', async (_e, q) => {
    try {
      const platform = (q?.platform || 'TR1').toUpperCase();
      const puu = q?.puuid || '';
      const ids = (q?.ids || []).slice(0, 10);
      if (!puu || !ids.length) return { ok: true, matches: [], failed: [] };
      const base = await ddBase();
      const matches = [], failed = [];
      // Pool of 6 (no batch barrier: a slow match no longer holds up the next ones).
      // Usually already in flight or cached from the prefetch in otp:deeplol.
      const rs = await runPool(ids, 6, (id) => dlMatchDetail(id, platform, puu, base));
      rs.forEach((r, k) => {
        if (r?.m) matches.push(r.m);
        else failed.push({ id: ids[k], reason: r?.err || 'unknown' });
      });
      if (failed.length) {
        const reasons = {};
        failed.forEach((f) => { reasons[f.reason] = (reasons[f.reason] || 0) + 1; });
        console.log(`[otp] matches: ${matches.length} ok, ${failed.length} failed`, JSON.stringify(reasons));
      }
      return { ok: true, matches, failed };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
  // The raw event timeline of one finished game (kills with positions, objectives,
  // win chance per event) for the assistant's game review. Main process only.
  ipcMain.handle('otp:deeplol-timeline', async (_e, q) => {
    const platform = String(q?.platform || 'TR1').toUpperCase();
    const id = encodeURIComponent(String(q?.matchId || ''));
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const det = JSON.parse(await dlFetchText(`${DL}/match/match-cached?match_id=${id}&platform_id=${platform}`, 8000));
        return { ok: true, det };
      } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 600 * (attempt + 1))); }
    }
    return { ok: false, error: String(lastErr?.message ?? lastErr).slice(0, 80) };
  });
  // deeplol older matches (pagination for months back)
  ipcMain.handle('otp:deeplol-more', async (_e, q) => {
    try {
      const platform = (q?.platform || 'TR1').toUpperCase();
      const puu = q?.puuid || '';
      const offset = q?.offset || 0;
      const lastTs = q?.lastTs || 1;
      if (!puu) throw new Error('no puuid');
      let lastErr = null;
      for (let a = 0; a < 2; a++) {
        try {
          const txt = await dlFetchText(`${DL}/match/matches?puu_id=${encodeURIComponent(puu)}&platform_id=${platform}&offset=${offset}&count=30&queue_type=ALL&champion_id=-1&only_list=1&last_updated_at=${lastTs}`, 6000);
          const ml = JSON.parse(txt);
          const ids = ((ml || {}).match_id_list || []).map((x) => ({ id: x.match_id, ts: x.match_creation_time }));
          console.log(`[otp] more: offset=${offset} lastTs=${lastTs} -> ${ids.length} ids`);
          return { ok: true, ids };
        } catch (e) { lastErr = e; }
      }
      throw new Error('matches-more: ' + String(lastErr?.message ?? lastErr));
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
  ipcMain.handle('otp:deeplol-list', async (_e, q) => {
    try {
      const platform = (q?.region || 'tr1').toUpperCase();
      const gameName = (q?.gameName || '').trim();
      if (!gameName) throw new Error('Type a name');
      const d = JSON.parse(await dlFetchText(`${DL}/summoner/list?platform_id=${platform}&riot_id_name=${encodeURIComponent(gameName)}`, 5000));
      return {
        ok: true,
        lists: ((d || {}).lists || []).map((e) => ({
          name: e.riot_id_name, tag: e.riot_id_tag_line, tier: e.tier, lp: e.lp, level: e.summoner_level
        }))
      };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
  const PLAT2REG = { na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas', oc1: 'sea', kr: 'asia', jp1: 'asia', euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe' };
  ipcMain.handle('otp:summoner', async (_e, q) => {
    try {
      const apiKey = (q?.apiKey || '').trim();
      const platform = (q?.region || 'tr1').toLowerCase();
      const gameName = (q?.gameName || '').trim();
      const tagLine = (q?.tagLine || '').trim();
      if (!apiKey) throw new Error('No Riot API key (add it in settings)');
      if (!gameName || !tagLine) throw new Error('Type Name#TAG');
      const regional = PLAT2REG[platform] || 'europe';
      const H = { 'X-Riot-Token': apiKey };
      const get = async (url) => {
        const r = await fetch(url, { headers: H });
        if (r.status === 401 || r.status === 403) throw new Error('API key invalid/expired');
        if (r.status === 404) throw new Error('Account not found');
        if (r.status === 429) throw new Error('Rate limited, wait 1 min');
        if (!r.ok) throw new Error('Riot HTTP ' + r.status);
        return r.json();
      };
      const acc = await get(`https://${regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
      const base = await ddBase();
      const [sum, entries, ids] = await Promise.all([
        get(`https://${platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${acc.puuid}`),
        get(`https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${acc.puuid}`),
        get(`https://${regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${acc.puuid}/ids?count=10`)
      ]);
      const matches = [];
      for (const id of ids || []) {
        try {
          const m = await get(`https://${regional}.api.riotgames.com/lol/match/v5/matches/${id}`);
          const p = (m.info.participants || []).find((x) => x.puuid === acc.puuid);
          if (!p) continue;
          matches.push({
            id, champ: p.championName, kills: p.kills, deaths: p.deaths, assists: p.assists,
            win: p.win, queue: m.info.queueId, mode: m.info.gameMode, cs: (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0)
          });
        } catch {}
      }
      // own transparent score from last 10 games (NOT deeplol AI score)
      let w = 0, k = 0, d = 0, a = 0;
      matches.forEach((m) => { if (m.win) w++; k += m.kills; d += m.deaths; a += m.assists; });
      const n = matches.length || 1;
      const wr = Math.round((w / n) * 100);
      const kda = ((k + a) / Math.max(1, d)).toFixed(2);
      const score = Math.min(9999, Math.round(wr * 50 + (k + a) / Math.max(1, d) * 120));
      const champs = {};
      matches.forEach((m) => {
        const c = (champs[m.champ] = champs[m.champ] || { champ: m.champ, g: 0, w: 0, k: 0, d: 0, a: 0 });
        c.g++; if (m.win) c.w++; c.k += m.kills; c.d += m.deaths; c.a += m.assists;
      });
      return {
        ok: true, profile: { name: acc.gameName, tag: acc.tagLine, level: sum.summonerLevel, icon: sum.profileIconId, iconUrl: `${base}/img/profileicon/${sum.profileIconId}.png` },
        ranks: entries,
        matches: matches.map((m) => ({ ...m, icon: `${base}/img/champion/${m.champ}.png` })),
        champs: Object.values(champs).sort((x, y) => y.g - x.g).map((c) => ({ ...c, icon: `${base}/img/champion/${c.champ}.png` })),
        score: { value: score, wr, kda, games: n }
      };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
  const tierCache = new Map();
  ipcMain.handle('otp:tierlist', async (_e, f) => {
    try {
      const flt = (typeof f === 'string') ? { lane: f } : (f || {});
      const lane = flt.lane || 'all';
      const tier = flt.tier || 'emerald_plus';
      const patch = flt.patch || '';
      const region = flt.region || 'all';
      const key = `${lane}|${tier}|${patch}|${region}`;
      const hit = tierCache.get(key);
      if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return { ok: true, html: hit.html, cached: true };
      const qs = [];
      if (lane !== 'all') qs.push(`lane=${encodeURIComponent(lane)}`);
      if (tier && tier !== 'emerald_plus') qs.push(`tier=${encodeURIComponent(tier)}`);
      if (patch) qs.push(`patch=${encodeURIComponent(patch)}`);
      if (region && region !== 'all') qs.push(`region=${encodeURIComponent(region)}`);
      const url = 'https://lolalytics.com/lol/tierlist/' + (qs.length ? '?' + qs.join('&') : '');
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const html = await r.text();
      tierCache.set(key, { ts: Date.now(), html });
      return { ok: true, html };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
