// op.gg game modes (ARAM Mayhem, Arena): champion builds and augment stats.
//
// op.gg pages are server-rendered React (RSC). The payload sits in
// self.__next_f.push([1,"..."]) chunks inside the HTML; concatenated, it holds:
//  - Mayhem augments: {"data":[{id,tier(0-5),performance,popular,name,key,
//    largeIcon,rarity,desc}, ...]} (tier 0 = best, 5 = not enough games)
//  - Arena augments: {"1":[...],"4":[...]} by rarity, each
//    {id,name,rareity,image_url,pick_rate,win_rate,play,desc} (no tier: we rank)
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

function mayhemAugments(raw) {
  const i = raw.indexOf('{"data":[{"id":');
  if (i < 0) return [];
  try {
    const arr = JSON.parse(sliceJson(raw, raw.indexOf('[', i)));
    return arr.filter((a) => a && a.name).map((a) => ({
      id: a.id, name: a.name, icon: a.largeIcon || a.smallIcon || '', rarity: a.rarity,
      tier: a.tier, score: a.performance, pick: a.popular, desc: String(a.desc || '').replace(/<[^>]+>/g, ''),
    }));
  } catch { return []; }
}

// Arena: rank inside the champion by win rate, shrunk towards the average when
// few games (so a 3-game 100% doesn't top the list); tiers by percentile.
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
        wr: Number(a.win_rate) || 0, pick: Number(a.pick_rate) || 0, games: Number(String(a.play || '0').replace(/,/g, '')) || 0,
        desc: String(a.desc || '').replace(/<[^>]+>/g, ''),
      });
    } catch {}
  }
  if (!all.length) return [];
  const tot = all.reduce((s, a) => s + a.games, 0) || 1;
  const avg = all.reduce((s, a) => s + a.wr * a.games, 0) / tot;
  const K = 60;
  for (const a of all) a.score = (a.wr * a.games + avg * K) / (a.games + K);
  const ranked = [...all].filter((a) => a.games >= 20).sort((x, y) => y.score - x.score);
  ranked.forEach((a, i) => {
    const p = i / Math.max(1, ranked.length);
    a.tier = p < 0.05 ? 0 : p < 0.2 ? 1 : p < 0.45 ? 2 : p < 0.7 ? 3 : 4;
  });
  for (const a of all) if (a.tier == null) a.tier = 5;
  return all.sort((x, y) => x.tier - y.tier || y.score - x.score);
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
      // Only the parts that parse reliably: core rows and the first boots / starter row
      // (spell and skill rows are split across lazily loaded chunks).
      core: rows(buildRaw, 'core_items', 4),
      starter: rows(buildRaw, 'starter_items', 1),
      boots: (rows(buildRaw, 'boots', 1)[0] || []).slice(0, 1),
    },
    source: base,
  };
  cache.set(key, { ts: Date.now(), data });
  return data;
}

module.exports = { modeData, rscPayload, mayhemAugments, arenaAugments, rows };
