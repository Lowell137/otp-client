// Matchups for a champion in a role (op.gg counters): its win rate against each
// opponent it often meets, the hardest and easiest ones, and one matchup if
// asked ("Yasuo vs Annie"). Champion matchup win rates are allowed by Riot's
// policy (the ban is on augments / Arena items). Cached 1 hour.
const data = require('../data.js');
const opgg = require('../../opgg.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const POS = { top: 'top', jungle: 'jungle', jg: 'jungle', mid: 'mid', middle: 'mid', bot: 'adc', bottom: 'adc', adc: 'adc', support: 'support', supp: 'support', sup: 'support', utility: 'support' };
const MIN_GAMES = 150;
const cache = new Map();

async function list(champId, pos) {
  const url = `https://op.gg/lol/champions/${champId.toLowerCase()}/counters${pos ? '/' + pos : ''}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < 3600 * 1000) return { url, rows: hit.rows };
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`op.gg ${r.status}`);
  const raw = opgg.rscPayload(await r.text());
  const i = raw.indexOf('{"data":[{"play":');
  if (i < 0) return { url, rows: [] };
  let d = 0, e = raw.indexOf('[', i);
  const s = e;
  for (; e < raw.length; e++) { if (raw[e] === '[') d++; else if (raw[e] === ']') { d--; if (!d) break; } }
  const rows = JSON.parse(raw.slice(s, e + 1))
    .filter((x) => x && x.champion)
    .map((x) => ({ opponent: x.champion.name, key: x.champion.key, games: x.play, winRate: Number(x.win_rate) }));
  cache.set(url, { ts: Date.now(), rows });
  return { url, rows };
}

module.exports = {
  name: 'counters',
  description: "Matchups for a champion in a role (op.gg): its win rate against the opponents it meets most, the hardest and easiest matchups, and one specific matchup if an opponent is given ('Yasuo vs Annie', 'who counters Yasuo', 'is X good against Y'). Defaults to my champion and role in the current game.",
  parameters: {
    type: 'object',
    properties: {
      champion: { type: 'string', description: 'The champion (default: mine in the current game)' },
      role: { type: 'string', description: 'top, jungle, mid, adc or support' },
      opponent: { type: 'string', description: 'One opponent to check, e.g. "Annie" (default: my lane opponent in the current game)' },
    },
    required: [],
  },
  async run(args, ctx) {
    let champ = args?.champion, role = args?.role, opp = args?.opponent;
    if (!champ || !role || !opp) {
      const g = await data.gamePlayers(ctx).catch(() => null);
      champ = champ || g?.me?.champ;
      role = role || g?.me?.role;
      if (!opp && g && role) opp = (g.enemies || []).find((p) => p.role === role && p.champ)?.champ;
    }
    const c = await data.champion(champ);
    if (!c) return { error: champ ? `Unknown champion "${champ}".` : 'Which champion?' };
    const pos = POS[data.norm(role)] || '';
    const { url, rows } = await list(c.id, pos);
    if (!rows.length) return { error: `No matchup data on op.gg for ${c.name}${pos ? ' ' + pos : ''}.` };
    const solid = rows.filter((x) => x.games >= MIN_GAMES);
    const byWr = [...solid].sort((a, b) => a.winRate - b.winRate);
    const fmt = (x) => ({ opponent: x.opponent, winRate: `${x.winRate.toFixed(1)}%`, games: x.games });
    const out = {
      champion: c.name, role: pos || 'most played', source: url, note: `Win rate of ${c.name} against each opponent; matchups with ${MIN_GAMES}+ games.`,
      hardest: byWr.slice(0, 5).map(fmt),
      easiest: byWr.slice(-5).reverse().map(fmt),
    };
    if (opp) {
      const o = await data.champion(opp);
      const m = o ? rows.find((x) => data.norm(x.key) === data.norm(o.id) || data.norm(x.opponent) === data.norm(o.name)) : null;
      out.matchup = m ? { ...fmt(m), lowSample: m.games < MIN_GAMES || undefined } : { opponent: o ? o.name : opp, note: 'Not among the opponents op.gg lists for this champion and role.' };
    }
    return out;
  },
};
