// In-game helper for the overlay (like Blitz / op.gg / Porofessor), built only from
// what the game shows the player anyway (Live Client API = Tab screen + own stats):
//   next item   - first core item of the op.gg build I don't have, and gold short
//   skill       - which ability to level next when a point is free (op.gg max order)
//   cs          - my CS, CS/min, and CS vs my lane opponent
//   lane        - item value vs my lane opponent
// op.gg build data is cached per champion and role for an hour.
const opgg = require('./opgg.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const POS = { TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'mid', BOTTOM: 'adc', UTILITY: 'support' };
const buildCache = new Map();
let itemsCache = null; // { base, data }

async function items(ddragonBase) {
  if (itemsCache && itemsCache.base === ddragonBase) return itemsCache.data;
  const j = await (await fetch(`${ddragonBase}/data/en_US/item.json`)).json();
  itemsCache = { base: ddragonBase, data: j.data };
  return j.data;
}

async function opggBuild(champKey, position) {
  const pos = POS[position] || '';
  const key = `${champKey}|${pos}`;
  const hit = buildCache.get(key);
  if (hit && Date.now() - hit.ts < 3600 * 1000) return hit.v;
  const url = `https://op.gg/lol/champions/${champKey.toLowerCase()}/build${pos ? '/' + pos : ''}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('op.gg ' + r.status);
  const raw = opgg.rscPayload(await r.text());
  const order = [];
  for (const m of raw.matchAll(/"metaType":"skill","metaId":"[a-z]+","extraData":"([QWER])"/g)) { if (!order.includes(m[1])) order.push(m[1]); if (order.length >= 3) break; }
  const v = {
    core: (opgg.rows(raw, 'core_items', 1)[0] || []).map(String),
    boots: String((opgg.rows(raw, 'boots', 1)[0] || [])[0] || ''),
    order,
  };
  buildCache.set(key, { ts: Date.now(), v });
  return v;
}

// Standard leveling from a max order: Q/W/E once each at 1-3 (in max order),
// R at 6/11/16, otherwise the first skill in the order that is not maxed.
function nextSkill(order, lv, champLevel) {
  if (order.length < 3) return null;
  const spent = lv.Q + lv.W + lv.E + lv.R;
  if (spent >= champLevel) return null; // no free point
  const cap = (k) => (k === 'R' ? (champLevel >= 16 ? 3 : champLevel >= 11 ? 2 : champLevel >= 6 ? 1 : 0) : Math.min(5, Math.ceil(champLevel / 2)));
  if (cap('R') > lv.R) return 'R';
  for (const k of order) if (lv[k] === 0 && cap(k) > 0) return k;
  for (const k of order) if (lv[k] < cap(k)) return k;
  return null;
}

// Gold still needed for an item, counting components I already hold.
function goldShort(id, inv, gold, data) {
  const it = data[id];
  if (!it) return null;
  const have = [...inv];
  const owned = (x) => {
    const i = have.indexOf(x);
    if (i >= 0) { have.splice(i, 1); return data[x]?.gold?.total || 0; }
    return (data[x]?.from || []).reduce((a, c) => a + owned(c), 0);
  };
  const ownedValue = (it.from || []).reduce((a, c) => a + owned(c), 0);
  return Math.max(0, (it.gold?.total || 0) - ownedValue - Math.floor(gold));
}

function itemValue(p, data) {
  return (p.items || []).reduce((a, it) => {
    const d = data[String(it.itemID)];
    if (!d || (d.tags || []).includes('Consumable') || (d.tags || []).includes('Trinket')) return a;
    return a + (d.gold?.total || 0) * (it.count || 1);
  }, 0);
}

async function helper(all, ddragonBase) {
  const data = await items(ddragonBase);
  const meName = all.activePlayer?.riotId || all.activePlayer?.summonerName;
  const me = (all.allPlayers || []).find((p) => (p.riotId || p.summonerName) === meName);
  if (!me) return null;
  const t = Math.max(1, (all.gameData?.gameTime || 0) / 60);
  // Lane opponent: same position; with no positions (practice tool, customs) the
  // only enemy if there is just one.
  const enemies = (all.allPlayers || []).filter((p) => p.team !== me.team);
  const hasPos = me.position && me.position !== 'NONE';
  const opp = (hasPos && enemies.find((p) => p.position === me.position)) || (enemies.length === 1 ? enemies[0] : null);
  const champKey = String(me.rawChampionName || '').replace(/^.*_displayname_/, '') || String(me.championName || '').replace(/[^A-Za-z]/g, '');
  const out = {
    cs: { cs: me.scores?.creepScore || 0, perMin: +((me.scores?.creepScore || 0) / t).toFixed(1), opp: opp ? (opp.scores?.creepScore || 0) : null },
    lane: opp ? { opp: opp.championName, diff: itemValue(me, data) - itemValue(opp, data) } : null,
  };
  try {
    const b = await opggBuild(champKey, me.position);
    const inv = (me.items || []).map((it) => String(it.itemID));
    const has = (id) => inv.includes(id);
    const plan = [...(b.boots ? [b.boots] : []), ...b.core];
    // Boots after the first core item, like most builds.
    const ordered = b.core.length ? [b.core[0], ...(b.boots ? [b.boots] : []), ...b.core.slice(1)] : plan;
    const nextId = ordered.find((id) => !has(id) && data[id]);
    if (nextId) {
      const it = data[nextId];
      out.next = { id: nextId, name: it.name, icon: `${ddragonBase}/img/item/${nextId}.png`, cost: it.gold?.total || 0, short: goldShort(nextId, inv, all.activePlayer?.currentGold || 0, data) };
    } else if (ordered.length) out.next = { done: true };
    const ab = all.activePlayer?.abilities || {};
    const lv = { Q: ab.Q?.abilityLevel || 0, W: ab.W?.abilityLevel || 0, E: ab.E?.abilityLevel || 0, R: ab.R?.abilityLevel || 0 };
    out.skill = { order: b.order.join(' > '), next: nextSkill(b.order, lv, all.activePlayer?.level || me.level || 1) };
  } catch {}
  return out;
}

module.exports = { helper, nextSkill, goldShort };
