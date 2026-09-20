// LCU layer: reads lockfile via league-connect and writes runes, item sets, and spells.
// Only official LCU REST APIs are used (no memory manipulation or injection).

const { authenticate, request } = require('league-connect');

let cachedCreds = null;
async function getCreds(force = false) {
  if (cachedCreds && !force) return cachedCreds;
  try {
    cachedCreds = await authenticate({ awaitConnection: false });
    return cachedCreds;
  } catch (e) {
    cachedCreds = null;
    throw e;
  }
}

function clearCreds() {
  cachedCreds = null;
}

async function reqJson(creds, method, url, body) {
  try {
    const res = await request({ method, url, body }, creds);
    const status = res.status;
    if (status === 401 || status === 403) clearCreds();
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    let raw = '';
    try { raw = typeof data === 'string' ? data : JSON.stringify(data); } catch { raw = ''; }
    return { status, data, raw };
  } catch (err) {
    clearCreds();
    throw err;
  }
}

// DataDragon champion name -> ID mapping (cached)
let champMap = null;
async function getChampId(name) {
  if (!champMap) {
    let version = '16.1.1';
    try {
      const vRes = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
      const vJson = await vRes.json();
      if (vJson?.[0]) version = vJson[0];
    } catch {}
    const r = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`);
    const j = await r.json();
    champMap = {};
    for (const [id, data] of Object.entries(j.data || {})) {
      const numId = Number(data.key);
      champMap[id.toLowerCase()] = numId;
      if (data.name) champMap[data.name.toLowerCase()] = numId;
      const clean = (data.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (clean) champMap[clean] = numId;
    }
  }
  const raw = String(name || '').toLowerCase();
  const clean = raw.replace(/[^a-z0-9]/g, '');
  return champMap[raw] ?? champMap[clean] ?? 0;
}

async function importRunes(creds, build) {
  // List existing rune pages
  let pages = [];
  try {
    const p = await reqJson(creds, 'GET', '/lol-perks/v1/pages');
    if (Array.isArray(p.data)) pages = p.data;
  } catch {}
  const title = (`OTP ${build.champion}`).slice(0, 25);
  const payload = {
    name: title,
    primaryStyleId: build.runes.primary,
    subStyleId: build.runes.sub,
    selectedPerkIds: build.runes.selectedPerkIds,
    current: true
  };

  // Only consider editable custom pages (never touch Riot preset pages)
  const editablePages = pages.filter((x) => x.isEditable !== false && !x.isPreset);

  // 1) Try in-place update first (works seamlessly during champion select).
  // Priority: exact title match > any OTP page > active page (if editable) > first editable page
  let curActiveId = null;
  try {
    const cur = await reqJson(creds, 'GET', '/lol-perks/v1/currentpage');
    if (cur.data?.id) curActiveId = cur.data.id;
  } catch {}

  let target = editablePages.find((x) => x.name === title) ||
               editablePages.find((x) => typeof x.name === 'string' && x.name.startsWith('OTP ')) ||
               editablePages.find((x) => x.id === curActiveId) ||
               editablePages[0];

  let targetId = target?.id;
  let putErr = null;
  if (targetId) {
    const put = await reqJson(creds, 'PUT', `/lol-perks/v1/pages/${targetId}`, { ...payload, id: targetId });
    if (put.status < 400) {
      try { await reqJson(creds, 'PUT', '/lol-perks/v1/currentpage', targetId); } catch {}
      return put.data;
    }
    putErr = put.raw.slice(0, 200);
  }

  // 2) Free up space and try POST if no editable pages or PUT failed
  if (editablePages.length >= 2 || pages.length >= 5) {
    const victim = editablePages.find((x) => x.isDeletable !== false && x.id !== targetId) ||
                   pages.find((x) => x.isDeletable === true);
    if (victim?.id) {
      try { await reqJson(creds, 'DELETE', `/lol-perks/v1/pages/${victim.id}`); } catch {}
    }
  }

  const created = await reqJson(creds, 'POST', '/lol-perks/v1/pages', payload);
  if (created.status >= 400) {
    if (created.raw.includes('Max pages reached')) {
      throw new Error('Rune pages full. Delete 1 custom rune page in Client and try again.');
    }
    throw new Error(`Rune update failed (PUT: ${putErr || '?'}, POST: ${created.raw.slice(0, 200)})`);
  }
  if (created.data?.id) {
    try { await reqJson(creds, 'PUT', '/lol-perks/v1/currentpage', created.data.id); } catch {}
  }
  return created.data;
}

async function importItems(creds, build) {
  const sum = await reqJson(creds, 'GET', '/lol-summoner/v1/current-summoner');
  const s = sum.data;
  if (!s || !s.summonerId) throw new Error('No logged-in summoner found');

  const champId = await getChampId(build.champion);
  const title = (`OTP ${build.champion}`).slice(0, 25);

  const toEntries = (ids) => (ids || []).filter((id) => Number(id) > 0).map((id) => ({ id: String(id), count: 1 }));

  const blocks = [];
  if (build.items.starting?.length) blocks.push({ type: `OTP Start`, items: toEntries(build.items.starting) });
  if (build.items.core?.length) blocks.push({ type: `OTP Core`, items: toEntries(build.items.core) });
  if (build.items.full?.length) blocks.push({ type: `OTP Full`, items: toEntries(build.items.full.slice(0, 6)) });
  if (build.items.boots?.length) blocks.push({ type: `OTP Boots`, items: toEntries(build.items.boots.slice(0, 2)) });

  const newSet = {
    title,
    associatedChampions: champId ? [champId] : [],
    associatedMaps: [11],
    blocks,
    map: 'any',
    mode: 'any',
    preferredItemSlots: [],
    sortrank: 0,
    startedFrom: 'blank',
    type: 'custom'
  };

  // Fetch existing sets, replace matching title or append
  let existing = [];
  let accountId = s.accountId;
  try {
    const cur = await reqJson(creds, 'GET', `/lol-item-sets/v1/item-sets/${s.summonerId}/sets`);
    const j = cur.data;
    existing = j?.itemSets ?? [];
    accountId = j?.accountId ?? accountId;
  } catch {}

  // Limit check: client rejects if > 30 sets
  const filtered = existing.filter((x) => x.title !== title);
  while (filtered.length >= 29) filtered.shift();
  filtered.push(newSet);

  const payload = { accountId, timestamp: Date.now(), itemSets: filtered };
  const put = await reqJson(creds, 'PUT', `/lol-item-sets/v1/item-sets/${s.summonerId}/sets`, payload);
  if (put.status >= 400) {
    throw new Error('Failed to write item set: ' + put.raw.slice(0, 300));
  }
  return { title, champId };
}

const flags = { follow: true, autoBuild: false, autoAccept: false, autoSpell: true, flashSlot: 'D' };
function setFlags(s) { Object.assign(flags, s || {}); }

function orderSpellsBySlot(spells, flashSlot = 'D') {
  const arr = (spells || []).map(Number).filter(Boolean);
  if (arr.length < 2) return [4, 14];
  const FLASH_ID = 4;
  if (!arr.includes(FLASH_ID)) return arr.slice(0, 2);
  const other = arr.find((id) => id !== FLASH_ID) || 14;
  if (String(flashSlot).toUpperCase() === 'D') {
    return [FLASH_ID, other];
  } else {
    return [other, FLASH_ID];
  }
}

async function importSpells(creds, build) {
  // Sets summoner spells during champion select
  const rawSpells = (build.spells && build.spells.length >= 2) ? build.spells : [4, 14];
  const prefSlot = build.flashSlot || flags.flashSlot || 'D';
  const ordered = orderSpellsBySlot(rawSpells, prefSlot);
  const [s1, s2] = ordered.map(Number);
  if (!s1 || !s2) return null;
  const r = await reqJson(creds, 'PATCH', '/lol-champ-select/v1/session/my-selection', { spell1Id: s1, spell2Id: s2 });
  if (r.status >= 400) {
    console.log(`[otp] spell PATCH status ${r.status}: ${r.raw}`);
    throw new Error('Spell error: ' + r.raw.slice(0, 150));
  }
  console.log(`[otp] spells applied: D=${s1}, F=${s2} (Flash on ${prefSlot})`);
  return [s1, s2];
}

function registerIpc(ipcMain) {
  ipcMain.handle('otp:lcu-status', async () => {
    try {
      const creds = await getCreds();
      const sum = await reqJson(creds, 'GET', '/lol-summoner/v1/current-summoner');
      const s = sum.data;
      return { connected: true, name: s ? `${s.displayName || s.gameName || 'Connected'}` : 'Connected' };
    } catch (e) {
      return { connected: false, error: String(e?.message ?? e) };
    }
  });

  ipcMain.handle('otp:import-build', async (_e, build) => {
    try {
      if (!build?.runes?.selectedPerkIds || build.runes.selectedPerkIds.length !== 9) {
        throw new Error('Failed to parse build (9 runes required)');
      }
      const creds = await getCreds();
      const [runeRes, itemRes, spellRes] = await Promise.allSettled([
        importRunes(creds, build),
        importItems(creds, build),
        (flags.autoSpell !== false) ? importSpells(creds, build) : Promise.resolve(null)
      ]);

      const runeOk = runeRes.status === 'fulfilled';
      const itemOk = itemRes.status === 'fulfilled';
      const spellOk = spellRes.status === 'fulfilled' && !!spellRes.value;

      if (!runeOk && !itemOk) {
        const err = runeRes.reason?.message || itemRes.reason?.message || 'Import failed';
        return { ok: false, error: err };
      }

      return {
        ok: true,
        rune: runeOk ? (runeRes.value?.name ?? 'ok') : null,
        items: itemOk ? (itemRes.value?.title ?? 'ok') : null,
        spells: spellOk ? spellRes.value : null,
        runeError: runeOk ? null : String(runeRes.reason?.message ?? runeRes.reason ?? 'unknown'),
        itemError: itemOk ? null : String(itemRes.reason?.message ?? itemRes.reason ?? 'unknown')
      };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
}

// ---- Direct build fetch (for fast auto-import, no page needed) ----
function buildSlotMap(subStyle) {
  const map = {};
  if (!subStyle) return map;
  for (const [styleId, style] of Object.entries(subStyle)) {
    (style.slots || []).forEach((slot, idx) => {
      for (const r of slot.runes || []) map[r.id] = { style: Number(styleId), slot: idx };
    });
  }
  return map;
}

function orderRunes(six, primary, sub, keystone, slotMap) {
  const key = Number(keystone);
  const rest = six.map(Number).filter((r) => r !== key);
  if (!slotMap || !Object.keys(slotMap).length) return [key, ...rest];
  const prim = [], sec = [], unk = [];
  for (const r of rest) {
    const info = slotMap[r];
    if (info && info.style === primary && info.slot > 0) prim.push({ r, slot: info.slot });
    else if (info && info.style === sub && info.slot > 0) sec.push({ r, slot: info.slot });
    else unk.push({ r, slot: 99 });
  }
  prim.sort((a, b) => a.slot - b.slot);
  sec.sort((a, b) => a.slot - b.slot);
  return [key, ...prim.map((x) => x.r), ...sec.map((x) => x.r), ...unk.map((x) => x.r)];
}

// Fetches the top OTP build for a champion straight from the site HTML.
const otpBuildCache = new Map();
async function fetchOtpBuild(champion) {
  const hit = otpBuildCache.get(String(champion).toLowerCase());
  if (hit && Date.now() - hit.ts < 10 * 60 * 1000) return hit.build;
  const url = `https://www.onetricks.gg/champions/builds/${encodeURIComponent(champion)}`;
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (r.status === 429 || r.status >= 500) throw new Error('build page HTTP ' + r.status + ' (retrying)');
      if (!r.ok) throw new Error('build page HTTP ' + r.status);
      const html = await r.text();
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) throw new Error('no build data on page');
      const pp = JSON.parse(m[1])?.props?.pageProps;
      if (!pp?.firstItemStats) throw new Error('no build data for ' + champion);
      const build = finishOtpBuild(pp, champion);
      otpBuildCache.set(String(champion).toLowerCase(), { ts: Date.now(), build });
      return build;
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function extractStats(popStat) {
  if (!popStat) return [5008, 5008, 5001];
  let arr = popStat;
  if (Array.isArray(arr[0])) arr = arr[0];
  if (Array.isArray(arr[0])) arr = arr[0];
  const nums = (Array.isArray(arr) ? arr : []).map(Number).filter((n) => !isNaN(n) && n >= 5000 && n < 6000);
  if (nums.length === 3) return nums;
  return [5008, 5008, 5001];
}

function finishOtpBuild(pp, champion) {
  const champ = pp.champion || champion;
  const fis = pp.firstItemStats;
  const patches = Object.keys(fis || {});
  const patch = patches[0] || '16.18';
  const byFirst = fis?.[patch] || {};
  const group = byFirst.all ?? byFirst[Object.keys(byFirst)[0]];
  if (!group) throw new Error('empty build group');
  let best = null;
  for (const [keystone, arr] of Object.entries(group.popRunes ?? {})) {
    for (const [six, rate, tree] of arr || []) {
      if (!best || rate > best.rate) best = { six, rate, tree, keystone };
    }
  }
  if (!best) throw new Error('no rune stats');
  const [primary, sub] = best.tree;
  const ordered = orderRunes(best.six, primary, sub, best.keystone, buildSlotMap(pp.runes?.subStyle));
  const stats = extractStats(group.popStat);
  const perks = [...ordered.slice(0, 6)];
  const selectedPerkIds = [...perks, ...stats].map(Number);
  const sSpells = group.sSpells?.[0]?.[0]?.map(Number) ?? [];
  const starting = group.startingItems?.[0]?.[0]?.map(Number) ?? [];
  const full = (group.popularItems ?? []).slice(0, 6).map(([id]) => Number(id));
  const core = (group.popCore?.[0]?.[0] ?? full.slice(0, 2)).map(Number);
  const boots = (group.boots ?? []).slice(0, 2).map(([id]) => Number(id));
  return {
    champion: champ, patch, rate: best.rate, firstKey: 'all',
    runes: { primary, sub, keystone: Number(best.keystone), selectedPerkIds },
    spells: sSpells,
    items: { starting, core, full, boots }
  };
}

module.exports = { registerIpc, setFlags, getCreds, importRunes, importItems, importSpells, fetchOtpBuild, getChampId };
