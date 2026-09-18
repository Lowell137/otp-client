// LCU layer: reads lockfile via league-connect and writes runes, item sets, and spells.
// Only official LCU REST APIs are used (no memory manipulation or injection).

const { authenticate, request } = require('league-connect');

async function getCreds() {
  // Throws an error if League Client is not running
  return await authenticate({ awaitConnection: false });
}

async function reqJson(creds, method, url, body) {
  const res = await request({ method, url, body }, creds);
  const status = res.status;
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  let raw = '';
  try { raw = typeof data === 'string' ? data : JSON.stringify(data); } catch { raw = ''; }
  return { status, data, raw };
}

// DataDragon champion name -> ID mapping (cached)
let champMap = null;
async function getChampId(name) {
  if (!champMap) {
    let version = '15.1.1';
    try {
      const vRes = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
      const vJson = await vRes.json();
      if (vJson?.[0]) version = vJson[0];
    } catch {}
    const r = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`);
    const j = await r.json();
    champMap = {};
    for (const k of Object.keys(j.data)) {
      champMap[k.toLowerCase()] = Number(j.data[k].key);
    }
  }
  return champMap[String(name).toLowerCase()] ?? 0;
}

async function importRunes(creds, build) {
  // List existing rune pages
  let pages = [];
  try {
    const p = await reqJson(creds, 'GET', '/lol-perks/v1/pages');
    if (Array.isArray(p.data)) pages = p.data;
  } catch {}
  const title = (`OTP ${build.champion}`).slice(0, 25);
  const same = pages.find((x) => x.name === title);
  const payload = {
    name: title,
    primaryStyleId: build.runes.primary,
    subStyleId: build.runes.sub,
    selectedPerkIds: build.runes.selectedPerkIds,
    current: true
  };

  // 1) Try in-place update first (page deletion is locked during champion select).
  // Target: page with same OTP name > current active page > first editable page
  let targetId = same?.id;
  if (!targetId) {
    try {
      const cur = await reqJson(creds, 'GET', '/lol-perks/v1/currentpage');
      if (cur.data?.id) targetId = cur.data.id;
    } catch {}
  }
  if (!targetId) {
    const editable = pages.find((x) => x.isEditable !== false) ?? pages[0];
    if (editable?.id) targetId = editable.id;
  }
  if (targetId) {
    const put = await reqJson(creds, 'PUT', `/lol-perks/v1/pages/${targetId}`, { ...payload, id: targetId });
    if (put.status < 400) {
      try { await reqJson(creds, 'PUT', '/lol-perks/v1/currentpage', targetId); } catch {}
      return put.data;
    }
    var putErr = put.raw.slice(0, 200);
  }

  // 2) Free up space and try POST (works in lobby)
  const rest = pages.filter((x) => x.id !== targetId);
  if (rest.length >= 4 || pages.length >= 5) {
    const victim = rest.find((x) => x.isDeletable !== false && x.isEditable !== false) ?? rest[0];
    if (victim?.id) {
      const del = await reqJson(creds, 'DELETE', `/lol-perks/v1/pages/${victim.id}`);
      if (del.status >= 400) {
        throw new Error(`Rune update failed (PUT: ${putErr ?? '?'}). Page deletion is locked in Champ Select. Delete 1 rune page in Client > Collection > Runes and try again.`);
      }
    }
  }

  const created = await reqJson(creds, 'POST', '/lol-perks/v1/pages', payload);
  if (created.status >= 400) {
    if (created.raw.includes('Max pages reached')) {
      throw new Error('Rune pages full and could not be updated. Delete 1 rune page in Client > Collection > Runes and try again.');
    }
    throw new Error('Failed to create rune page: ' + created.raw.slice(0, 300));
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

  const toEntries = (ids) => (ids || []).filter(Boolean).map((id) => ({ id: String(id), count: 1 }));

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

const flags = { follow: true, autoBuild: false, autoAccept: false, autoSpell: true };
function setFlags(s) { Object.assign(flags, s || {}); }

async function importSpells(creds, build) {
  // Sets summoner spells during champion select
  const [s1, s2] = (build.spells || []).map(Number);
  if (!s1 || !s2) return null;
  const r = await reqJson(creds, 'PATCH', '/lol-champ-select/v1/session/my-selection', { spell1Id: s1, spell2Id: s2 });
  if (r.status >= 400) throw new Error('Spell error: ' + r.raw.slice(0, 150));
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
      const runeRes = await importRunes(creds, build);
      const itemRes = await importItems(creds, build);
      let spells = null;
      if (flags.autoSpell) {
        try { spells = await importSpells(creds, build); } catch {}
      }
      return { ok: true, rune: runeRes?.name ?? 'ok', items: itemRes.title, spells };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
}

module.exports = { registerIpc, setFlags };
