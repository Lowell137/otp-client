const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

let win = null;

function initAdblock(sess) {
  // Block common tracking and advertising hosts at the network request level
  const AD = /googletagmanager|googlesyndication|doubleclick|clarity\.ms|vntsm\.com|smilewanted|csync|adservice|criteo|outbrain|taboola|popads|adnxs|rubicon|pubmatic/i;
  try {
    sess.webRequest.onBeforeRequest((details, cb) => {
      cb({ cancel: AD.test(details.url) });
    });
    console.log('[otp] adblock enabled');
  } catch (e) {
    console.log('[otp] adblock init failed:', String(e?.message ?? e));
  }
}

let ddragonCache = null;
async function champIdToName(id) {
  try {
    if (!ddragonCache) {
      let version = '15.1.1';
      try {
        const vRes = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
        const vJson = await vRes.json();
        if (vJson?.[0]) version = vJson[0];
      } catch {}
      const r = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`);
      ddragonCache = (await r.json()).data;
    }
    for (const k of Object.keys(ddragonCache)) {
      if (ddragonCache[k].key === String(id)) return ddragonCache[k].id;
    }
  } catch {}
  return null;
}

let lastSentChamp = null;
const flags = { follow: true, autoBuild: false, autoAccept: false, autoSpell: true };

function startLcuLoops() {
  // champ takip (3 sn)
  setInterval(async () => {
    try {
      if (!win || win.isDestroyed()) return;
      const { authenticate, request } = require('league-connect');
      const creds = await authenticate({ awaitConnection: false });
      const res = await request({ method: 'GET', url: '/lol-champ-select/v1/session' }, creds);
      if (res.status !== 200) { lastSentChamp = null; return; }
      const s = await res.json();
      const me = (s.myTeam || []).find((p) => p.cellId === s.localPlayerCellId);
      const champId = me?.championId || me?.championPickIntent || 0;
      if (!champId) return;
      if (champId === lastSentChamp) return;
      lastSentChamp = champId;
      const name = await champIdToName(champId);
      if (name) win.webContents.send('otp:auto-champ', name);
    } catch {}
  }, 3000);

  // oto maç kabul (2 sn)
  setInterval(async () => {
    try {
      if (!flags.autoAccept) return;
      const { authenticate, request } = require('league-connect');
      const creds = await authenticate({ awaitConnection: false });
      const res = await request({ method: 'GET', url: '/lol-gameflow/v1/gameflow-phase' }, creds);
      if (res.status !== 200) return;
      const phase = await res.json();
      if (phase === 'ReadyCheck') {
        await request({ method: 'POST', url: '/lol-matchmaking/v1/ready-check/accept' }, creds);
      }
    } catch {}
  }, 2000);
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await initAdblock(win.webContents.session);
  win.loadURL('https://www.onetricks.gg');

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://www.onetricks.gg')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  await createWindow();
  const lcu = require('./lcu.js');
  lcu.registerIpc(ipcMain);
  ipcMain.on('otp:settings', (_e, s) => {
    Object.assign(flags, s || {});
    lcu.setFlags(flags);
  });
  startLcuLoops();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
