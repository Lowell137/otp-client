// Best teammates for a champion (op.gg synergies): e.g. which ADC goes well with
// a Nami support, which jungler with a Yasuo mid. Win rate together, games, tier.
const data = require('../data.js');
const opgg = require('../../opgg.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const POS = { top: 'top', jungle: 'jungle', jg: 'jungle', mid: 'mid', middle: 'mid', bot: 'adc', bottom: 'adc', adc: 'adc', support: 'support', supp: 'support', sup: 'support', utility: 'support' };
const cache = new Map();

// Each section: {"position":..,"synergyPosition":"adc","data":[...]} in the RSC payload.
function sections(raw) {
  const out = {};
  for (const m of raw.matchAll(/"synergyPosition":"([a-z]+)","data":\[/g)) {
    const s = m.index + m[0].length - 1;
    let d = 0, e = s;
    for (; e < raw.length; e++) { if (raw[e] === '[') d++; else if (raw[e] === ']') { d--; if (!d) break; } }
    try { out[m[1]] = JSON.parse(raw.slice(s, e + 1)); } catch {}
  }
  return out;
}

module.exports = {
  name: 'duo_synergy',
  description: "Best teammates for a champion in a role (op.gg synergy): e.g. which ADC to pick with Nami support, which support with Jinx, which jungler with Yasuo. Use for 'X yanına ne alayım', 'who goes well with X', duo questions.",
  parameters: {
    type: 'object',
    properties: {
      champion: { type: 'string', description: 'The champion already chosen, e.g. "Nami"' },
      role: { type: 'string', description: "That champion's role: top, jungle, mid, adc or support" },
      partnerRole: { type: 'string', description: 'Role of the teammate wanted (default: adc for a support, support for an adc, jungle otherwise)' },
    },
    required: ['champion'],
  },
  async run(args) {
    const c = await data.champion(args?.champion);
    if (!c) return { error: `Unknown champion "${args?.champion}".` };
    let pos = POS[data.norm(args?.role)] || '';
    if (!pos) pos = c.tags.includes('Marksman') ? 'adc' : c.tags[0] === 'Support' ? 'support' : '';
    const want = POS[data.norm(args?.partnerRole)] || (pos === 'support' ? 'adc' : pos === 'adc' ? 'support' : 'jungle');
    const url = `https://op.gg/lol/champions/${c.id.toLowerCase()}/synergies${pos ? '/' + pos : ''}`;
    let secs = cache.get(url);
    if (!secs || Date.now() - secs.ts > 3600 * 1000) {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return { error: `op.gg did not answer (HTTP ${r.status}).` };
      secs = { ts: Date.now(), v: sections(opgg.rscPayload(await r.text())) };
      cache.set(url, secs);
    }
    const list = secs.v[want] || [];
    if (!list.length) return { error: `No synergy data for ${c.name}${pos ? ' ' + pos : ''} with ${want}.`, available: Object.keys(secs.v) };
    const top = list
      .filter((x) => (x.play || 0) >= 200)
      .sort((a, b) => (a.tier_rank ?? 99) - (b.tier_rank ?? 99) || b.win_rate - a.win_rate)
      .slice(0, 6)
      .map((x) => ({ champion: x.synergy_champion_name, winRateTogether: `${(x.win_rate * 100).toFixed(1)}%`, games: x.play, tierRank: x.tier_rank }));
    return { champion: c.name, role: pos || 'any', partnerRole: want, source: url, bestPartners: top };
  },
};
