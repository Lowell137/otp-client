// op.gg game modes (ARAM Mayhem, Arena): champion builds and augment stats.
//
// op.gg pages are server-rendered React (RSC). The payload sits in
// self.__next_f.push([1,"..."]) chunks inside the HTML; concatenated, it holds:
//  - Mayhem augments: {"data":[{id,tier,performance,popular,name,key,
//    largeIcon,rarity,desc}, ...]}  (we keep popular = pick rate only)
//  - Arena augments: {"1":[...],"4":[...]} by rarity, each
//    {id,name,rareity,image_url,pick_rate,win_rate,play,desc} (pick_rate only)
//  - Build tables as rendered rows keyed starter_items_N / boots_N /
//    core_items_N / spell_N / skill_N, items as "metaId":<id>. Rows come in
//    popularity order; the percentages live in lazily loaded parts, so we keep
//    only the order.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function rscPayload(html) {
  let out = '';
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let m;
  while ((m = re.exec(html))) {
    try { out += JSON.parse('"' + m[1] + '"'); } catch {}
  }
  return out;
}

// JSON array/object literal starting at raw[start] ('[' or '{').
function sliceJson(raw, start) {
  const open = raw[start], close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false;
  for (let j = start; j < raw.length; j++) {
    const c = raw[j];
    if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return raw.slice(start, j + 1); }
  }
  return null;
}

// Riot's League policy: products may not show win rates for Augments or Arena
// items (pick rate is allowed). So only pick rate leaves this file: no win rate,
// no win-rate tier. Augments are grouped by how often they are picked:
// band 0 = most picked (top 15%), 1 = common (next 35%), 2 = less picked.
function byPick(list) {
  const sorted = [...list].filter((x) => x.pick > 0).sort((x, y) => y.pick - x.pick);
  sorted.forEach((x, i) => { const p = i / Math.max(1, sorted.length); x.band = p < 0.15 ? 0 : p < 0.5 ? 1 : 2; });
  for (const x of list) if (x.band == null) x.band = 2;
  return list.sort((x, y) => x.band - y.band || y.pick - x.pick);
}

function mayhemAugments(raw) {
  const i = raw.indexOf('{"data":[{"id":');
  if (i < 0) return [];
  try {
    const arr = JSON.parse(sliceJson(raw, raw.indexOf('[', i)));
    return byPick(arr.filter((a) => a && a.name).map((a) => ({
      id: a.id, name: a.name, icon: a.largeIcon || a.smallIcon || '', rarity: a.rarity,
      pick: Number(a.popular) || 0, desc: String(a.desc || '').replace(/<[^>]+>/g, ''),
    })));
  } catch { return []; }
}

function arenaAugments(raw) {
  const all = [];
  const re = /\{"id":\d+,"name":"(?:[^"\\]|\\.)*","rareity":\d/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(raw))) {
    const s = sliceJson(raw, m.index);
    if (!s) continue;
    try {
      const a = JSON.parse(s);
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      all.push({
        id: a.id, name: a.name, icon: a.image_url || '', rarity: a.rareity,
        pick: Number(a.pick_rate) || 0, games: Number(String(a.play || '0').replace(/,/g, '')) || 0,
        desc: String(a.desc || '').replace(/<[^>]+>/g, ''),
      });
    } catch {}
  }
  return byPick(all);
}

function rows(raw, key, n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const i = raw.indexOf(`"${key}_${k}"`);
    if (i < 0) break;
    // A row ends where the next row of this table, or another table, starts.
    const other = ['starter_items', 'boots', 'core_items', 'spell', 'skill', 'spell_table'].filter((t) => t !== key)
      .map((t) => raw.indexOf(`"${t}_0"`, i + 5));
    const nexts = [raw.indexOf(`"${key}_${k + 1}"`, i + 5), ...other].filter((x) => x > i);
    const end = nexts.length ? Math.min(...nexts) : i + 20000;
    const seg = raw.slice(i, end);
    if (key === 'skill') {
      const letters = (seg.match(/"children":"([QWER])"/g) || []).map((x) => x.slice(-2, -1));
      if (letters.length) out.push(letters);
      continue;
    }
    const ids = [];
    for (const mm of seg.matchAll(/"metaId":(\d+)/g)) { const id = Number(mm[1]); if (!ids.includes(id)) ids.push(id); }
    if (ids.length) out.push(ids);
  }
  return out;
}

// Summoner spells: rows are "spell_table_N"; inside a row the two spells are the
// "spell_0" / "spell_1" slots with metaId = Riot summoner spell id.
function spellRows(raw, n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const i = raw.indexOf(`"spell_table_${k}"`);
    if (i < 0) break;
    const j = raw.indexOf(`"spell_table_${k + 1}"`, i + 5);
    const seg = raw.slice(i, j > i ? j : i + 4000);
    const ids = [];
    for (const mm of seg.matchAll(/"metaId":(\d+),"metaType":"spell"/g)) { const id = Number(mm[1]); if (!ids.includes(id)) ids.push(id); }
    if (ids.length) out.push(ids.slice(0, 2));
  }
  return out;
}
// Skills: the max order is the first "skill_0..2" slots (extraData Q/W/E); the
// 18-level sequence is a run of numbered <span key="0..17"> rows with a letter.
function skillData(raw) {
  const order = [];
  for (const mm of raw.matchAll(/"metaType":"skill","metaId":"[a-z]+","extraData":"([QWER])"/g)) {
    if (!order.includes(mm[1])) order.push(mm[1]);
    if (order.length >= 3) break;
  }
  const levels = [];
  const re = /\["\$","span","(\d+)",\{"className":"inline-flex flex-col items-center gap-0\.5[^"]*","children":\["\$undefined",\["\$","strong",null,\{[^}]*?"children":"([QWER])"\}\]\]\}\]/g;
  let mm;
  while ((mm = re.exec(raw))) {
    const idx = Number(mm[1]);
    if (idx !== levels.length) { if (idx === 0 && levels.length) break; continue; }
    levels.push(mm[2]);
    if (levels.length >= 18) break;
  }
  return { order, levels: levels.length === 18 ? levels : [] }; // partial runs skip levels: not shown
}

const cache = new Map();
async function fetchRaw(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
  if (!r.ok) throw new Error('op.gg ' + r.status);
  return rscPayload(await r.text());
}

// mode: 'aram-mayhem' | 'arena'; champ: Data Dragon key (e.g. "MonkeyKing").
async function modeData(mode, champ) {
  const m = mode === 'arena' ? 'arena' : 'aram-mayhem';
  const slug = String(champ || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!slug) throw new Error('champion');
  const key = m + '|' + slug;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < 60 * 60 * 1000) return hit.data;
  const base = `https://op.gg/lol/modes/${m}/${slug}`;
  const [augRaw, buildRaw] = await Promise.all([fetchRaw(base + '/augments'), fetchRaw(base + '/build').catch(() => '')]);
  const data = {
    mode: m, champ,
    augments: m === 'arena' ? arenaAugments(augRaw) : mayhemAugments(augRaw),
    build: {
      // Core rows and the first boots / starter row (later rows mix in other tables).
      core: rows(buildRaw, 'core_items', 4),
      starter: rows(buildRaw, 'starter_items', 1),
      boots: (rows(buildRaw, 'boots', 1)[0] || []).slice(0, 1),
      spells: spellRows(buildRaw, 2),
      skills: skillData(buildRaw),
    },
    source: base,
  };
  cache.set(key, { ts: Date.now(), data });
  return data;
}

module.exports = { modeData, rscPayload, mayhemAugments, arenaAugments, rows };
