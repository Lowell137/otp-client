// A champion's current build for a role from op.gg: runes, starting items, core
// items, boots, summoner spells and skill max order. Defaults to my champion and
// role in the current game. Cached 1 hour (light load on op.gg).
const data = require('../data.js');
const opgg = require('../../opgg.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const POS = { top: 'top', jungle: 'jungle', jg: 'jungle', mid: 'mid', middle: 'mid', bot: 'adc', bottom: 'adc', adc: 'adc', support: 'support', supp: 'support', sup: 'support', utility: 'support' };
const SPELLS = { 1: 'Cleanse', 3: 'Exhaust', 4: 'Flash', 6: 'Ghost', 7: 'Heal', 11: 'Smite', 12: 'Teleport', 13: 'Clarity', 14: 'Ignite', 21: 'Barrier', 32: 'Mark' };
const cache = new Map();

function runePage(raw) {
  const s = raw.indexOf('{"rune_pages":');
  if (s < 0) return null;
  let d = 0, e = s;
  for (; e < raw.length; e++) { if (raw[e] === '{') d++; else if (raw[e] === '}') { d--; if (!d) break; } }
  try {
    const page = JSON.parse(raw.slice(s, e + 1)).rune_pages?.[0];
    const b = page?.builds?.[0];
    if (!b) return null;
    const act = (rows) => (rows || []).flat().filter((r) => r.isActive).map((r) => r.name);
    return {
      primary: b.primary_perk_style?.name, secondary: b.perk_sub_style?.name,
      runes: act(b.main_runes), secondaryRunes: act(b.sub_runes),
      winRate: page.win_rate != null ? `${(page.win_rate * 100).toFixed(1)}%` : undefined,
      pickRate: page.pick_rate != null ? `${(page.pick_rate * 100).toFixed(1)}%` : undefined,
    };
  } catch { return null; }
}

module.exports = {
  name: 'champion_build',
  description: "A champion's current build for a role (op.gg): runes, starting items, core items, boots, summoner spells and skill order. Defaults to my champion and role in the current game. Use for 'what should I build', 'runes for X', 'hangi build'.",
  parameters: {
    type: 'object',
    properties: {
      champion: { type: 'string', description: 'Champion (default: mine in the current game)' },
      role: { type: 'string', description: 'top, jungle, mid, adc or support (default: my role)' },
    },
    required: [],
  },
  async run(args, ctx) {
    let champ = args?.champion, role = args?.role;
    if (!champ || !role) {
      const g = await data.gamePlayers(ctx).catch(() => null);
      champ = champ || g?.me?.champ;
      role = role || g?.me?.role;
    }
    if (!champ) return { error: 'Which champion? (No current game to take it from.)' };
    const c = await data.champion(champ);
    if (!c) return { error: `Unknown champion "${champ}".` };
    const pos = POS[data.norm(role)] || '';
    const key = `${c.id}|${pos}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < 3600 * 1000) return hit.v;
    const url = `https://op.gg/lol/champions/${c.id.toLowerCase()}/build${pos ? '/' + pos : ''}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { error: `op.gg did not answer (HTTP ${r.status}).` };
    const raw = opgg.rscPayload(await r.text());
    const d = await data.dd();
    const itemName = (id) => d.items[String(id)]?.name || `item ${id}`;
    const core = opgg.rows(raw, 'core_items', 2).map((row) => row.map(itemName));
    const skills = (() => {
      const order = [];
      for (const m of raw.matchAll(/"metaType":"skill","metaId":"[a-z]+","extraData":"([QWER])"/g)) { if (!order.includes(m[1])) order.push(m[1]); if (order.length >= 3) break; }
      return order;
    })();
    const spellIds = [];
    for (const m of raw.matchAll(/"metaId":(\d+),"metaType":"spell"/g)) { const id = Number(m[1]); if (!spellIds.includes(id)) spellIds.push(id); if (spellIds.length >= 2) break; }
    const v = {
      champion: c.name, role: pos || 'most played', patch: d.ver, source: url,
      runes: runePage(raw) || undefined,
      startingItems: (opgg.rows(raw, 'starter_items', 1)[0] || []).map(itemName),
      coreBuilds: core,
      boots: (opgg.rows(raw, 'boots', 1)[0] || []).slice(0, 1).map(itemName)[0],
      summonerSpells: spellIds.map((id) => SPELLS[id] || `spell ${id}`),
      skillMaxOrder: skills.length ? skills.join(' > ') : undefined,
    };
    if (!core.length && !v.runes) return { error: `No build data on op.gg for ${c.name}${pos ? ' ' + pos : ''}.` };
    cache.set(key, { ts: Date.now(), v });
    return v;
  },
};
