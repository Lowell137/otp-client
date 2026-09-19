const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

let win = null;

function initAdblock(sess) {
  // Block common tracking and advertising hosts at the network request level
  const AD = /googletagmanager|googlesyndication|googletagservices|doubleclick|clarity\.ms|vntsm\.com|venatus|adnuntius|browsiprod|pubmine|adpushup|nitropay|connatix|playwire|smilewanted|csync|adservice|criteo|outbrain|taboola|popads|adnxs|rubicon|pubmatic|amazon-adsystem|hotjar|fullstory|segment|mixpanel|amplitude|scorecardresearch|quantserve|crwdcntrl|demdex|mathtag/i;
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
      let version = '16.1.1';
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
let lastAutoBuildId = null;
const flags = { follow: true, autoBuild: true, autoAccept: false, autoSpell: true, flashSlot: 'D' };

function startLcuLoops() {
  // Ultra-fast champ tracking (500ms, cached creds)
  const lcu = require('./lcu.js');
  setInterval(async () => {
    try {
      if (!win || win.isDestroyed()) return;
      const { request } = require('league-connect');
      const creds = await lcu.getCreds();
      const res = await request({ method: 'GET', url: '/lol-champ-select/v1/session' }, creds);
      if (res.status !== 200) { lastSentChamp = null; lastAutoBuildId = null; return; }
      const s = await res.json();
      const me = (s.myTeam || []).find((p) => p.cellId === s.localPlayerCellId);
      const champId = me?.championId || me?.championPickIntent || 0;
      if (!champId) return;
      if (champId !== lastSentChamp) {
        lastSentChamp = champId;
        const name = await champIdToName(champId);
        if (name) {
          win.webContents.send('otp:auto-champ', name);
          if (flags.follow) {
            const curUrl = win.webContents.getURL() || '';
            const targetSlug = encodeURIComponent(name).toLowerCase();
            if (!curUrl.toLowerCase().includes(`/champions/builds/${targetSlug}`)) {
              win.webContents.session.setPreloads([path.join(__dirname, 'preload.js')]);
              win.loadURL(`https://www.onetricks.gg/champions/builds/${encodeURIComponent(name)}`);
            }
          }
        }
      }
    } catch {}
  }, 500);

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

async function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    icon: path.join(__dirname, 'assets/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Hide the Electron tag: some WAFs challenge non-standard UAs (error pages in-app while fetch works)
  win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

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
  startLcuLoops();
  // Pre-warm champion and ddragon caches in background for instant lookup
  champIdToName(1).catch(() => {});
  lcu.getChampId('Annie').catch(() => {});
  ipcMain.on('otp:settings', (_e, s) => {
    Object.assign(flags, s || {});
    lcu.setFlags(flags);
  });
  ipcMain.on('otp:open-tier', () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.session.setPreloads([path.join(__dirname, 'tier-preload.js')]);
    win.loadFile(path.join(__dirname, 'tierlist.html'));
  });
  ipcMain.on('otp:open-summoner', () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.session.setPreloads([path.join(__dirname, 'summoner-preload.js')]);
    win.loadFile(path.join(__dirname, 'summoner.html'));
  });
  ipcMain.on('otp:go-home', () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.session.setPreloads([path.join(__dirname, 'preload.js')]);
    win.loadURL('https://www.onetricks.gg');
  });
  ipcMain.handle('otp:open-build', async (_e, slug) => {
    try {
      if (win && !win.isDestroyed()) {
        win.webContents.session.setPreloads([path.join(__dirname, 'preload.js')]);
        await win.loadURL(`https://www.onetricks.gg/champions/builds/${encodeURIComponent(slug)}`);
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
      const { authenticate, request } = require('league-connect');
      const creds = await authenticate({ awaitConnection: false });
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
      const { authenticate, request } = require('league-connect');
      const creds = await authenticate({ awaitConnection: false });
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
  function dlFetchText(url, timeoutMs = 4000) {
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
      const listP = get(`${DL}/summoner/list?platform_id=${platform}&riot_id_name=${encodeURIComponent(gameName)}`, 'search');
      const profP = get(`${DL}/summoner/summoner?riot_id_name=${encodeURIComponent(gameName)}&riot_id_tag_line=${encodeURIComponent(tagLine)}&platform_id=${platform}`, 'profile');
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
      const base = await ddBase();
      const ml = await get(`${DL}/match/matches?puu_id=${encodeURIComponent(puu)}&platform_id=${platform}&offset=0&count=30&queue_type=ALL&champion_id=-1&only_list=1&last_updated_at=1`, 'matches');
      const pendingIds = ((ml || {}).match_id_list || []).slice(0, 30).map((x) => ({ id: x.match_id, ts: x.match_creation_time }));
      const parts = String(entry.tier || '').split(' ');
      return {
        ok: true, source: 'deeplol', puuid: puu, platform, pendingIds,
        profile: { name: entry.riot_id_name, tag: entry.riot_id_tag_line, level: entry.summoner_level, iconUrl: `${base}/img/profileicon/${entry.profile_id}.png` },
        ranks: [{ queueType: 'Ranked', tier: parts[0] || '?', rank: parts[1] || '', leaguePoints: entry.lp ?? 0, wins: null, losses: null }]
      };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
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
  async function dlMatchDetail(matchId, platform, puu, base) {
    const hit = dlMatchCache.get(matchId);
    if (hit && Date.now() - hit.ts < 10 * 60 * 1000) return { m: hit.m };
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
            teams.push({
              name: x.riot_id_name || x.summoner_name || '?', tag: x.riot_id_tag_line || '',
              champ: xc, icon: `${base}/img/champion/${xc}.png`,
              kills: xfs.kills ?? 0, deaths: xfs.deaths ?? 0, assists: xfs.assists ?? 0,
              ai: xfs.ai_score ?? null, lvl: xfs.champion_level ?? null,
              dmg: x.total_damage_dealt ?? 0,
              cs: xfs.cs ?? 0,
              gold: x.total_gold ?? 0, items: [...xitems, xtrinket], trinket: xtrinket,
              tier: [x.tier, x.division].filter(Boolean).join(' '),
              side: x.side, win: blueWin == null ? !!x.is_win : ((x.side === 'BLUE') === !!blueWin)
            });
        }
        const m = {
          id: matchId, champ: cname, icon: `${base}/img/champion/${cname}.png`,
          kills: fs.kills ?? 0, deaths: fs.deaths ?? 0, assists: fs.assists ?? 0,
          win: !!p.is_win, queue: det?.match_basic_dict?.queue_id, mode: '',
          dur: det?.match_basic_dict?.game_duration ?? null,
          ts: det?.match_basic_dict?.creation_timestamp ?? null,
          cs: fs.cs ?? 0, ai: fs.ai_score ?? null, teams
        };
        dlMatchCache.set(matchId, { ts: Date.now(), m });
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
      // max 4 concurrent — deeplol rate-limits bursts
      for (let s = 0; s < ids.length; s += 4) {
        const rs = await Promise.all(ids.slice(s, s + 4).map((id) => dlMatchDetail(id, platform, puu, base)));
        rs.forEach((r, k) => {
          if (r?.m) matches.push(r.m);
          else failed.push({ id: ids[s + k], reason: r?.err || 'unknown' });
        });
      }
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
  startLcuLoops();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
