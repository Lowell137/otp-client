// Current tier list from lolalytics (same source as the app's Tier List page):
// best champions overall or for one role, with tier, win rate, pick and ban rate.
const data = require('../data.js');

const TIER_ORDER = ['S+', 'S', 'S-', 'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-'];
const LANES = { top: 'top', jungle: 'jungle', jg: 'jungle', mid: 'middle', middle: 'middle', bot: 'bottom', bottom: 'bottom', adc: 'bottom', support: 'support', supp: 'support', sup: 'support' };

// The full table is in the page's Qwik state; values are base-36 refs into `objs`.
function parseQwik(html) {
  const m = html.match(/<script type="qwik\/json">([\s\S]*?)<\/script>/);
  if (!m) return [];
  let O;
  try { O = JSON.parse(m[1]).objs; } catch { return []; }
  if (!Array.isArray(O)) return [];
  const deref = (ref, d = 0) => {
    if (typeof ref !== 'string' || d > 6) return ref;
    const v = O[parseInt(ref, 36)];
    if (Array.isArray(v)) return v.map((x) => deref(x, d + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deref(x, d + 1)]));
    return v;
  };
  return O.filter((o) => o && typeof o === 'object' && !Array.isArray(o) && 'cid' in o && 'row' in o)
    .map((o) => ({ cid: deref(o.cid), ...(deref(o.row) || {}) }))
    .filter((r) => r.cid != null && typeof r.tier === 'number');
}

module.exports = {
  name: 'tier_list',
  description: 'The current tier list (lolalytics, Emerald+): the strongest champions for one role (top, jungle, mid, bot, support), or with no role the top 3 of every role. Tier, win rate, pick rate, ban rate. Use for "best champion", "what is strong", "meta" questions.',
  parameters: {
    type: 'object',
    properties: {
      role: { type: 'string', description: 'top, jungle, mid, bot or support. Leave out for the top picks of every role.' },
      count: { type: 'integer', description: 'How many champions, 1-20 (default 10 for one role, 3 per role for all roles)' },
    },
    required: [],
  },
  async run(args, ctx) {
    // No role: each role on its own (an overall list hides whole roles, e.g. no ADC in the top 10).
    if (!LANES[data.norm(args?.role)]) {
      const per = Math.max(1, Math.min(5, Number(args?.count) || 3));
      const roles = ['top', 'jungle', 'mid', 'bot', 'support'];
      const lists = await Promise.all(roles.map((r) => module.exports.run({ role: r, count: per }, ctx)));
      const err = lists.find((l) => l.error);
      if (err && lists.every((l) => l.error)) return err;
      return {
        source: 'lolalytics', patch: lists.find((l) => l.patch)?.patch || '', rank: 'Emerald+',
        byRole: Object.fromEntries(roles.map((r, i) => [r, lists[i].error ? lists[i].error : lists[i].champions.map((c) => ({ champion: c.champion, tier: c.tier, winRate: c.winRate, pickRate: c.pickRate }))])),
        note: 'Top picks of each role, champions really played there (10%+ of their games, 0.5%+ pick rate); bot = marksmen.',
      };
    }
    const lane = LANES[data.norm(args?.role)];
    const n = Math.max(1, Math.min(20, Number(args?.count) || 10));
    const res = await ctx.call('otp:tierlist', { lane });
    if (!res?.ok) return { error: `Could not load the tier list: ${res?.error || 'unknown error'}` };
    const patch = (res.html.match(/Patch ([\d.]+)/) || [])[1] || '';
    const d = await data.dd();
    const byKey = {};
    for (const c of Object.values(d.champs)) byKey[String(c.key)] = c.name;
    // A role list also holds off-role picks (e.g. a mid laner played top 2% of the
    // time); keep champions that are really played there.
    const all = parseQwik(res.html);
    let real = lane === 'all' ? all : all.filter((r) => (r.pctLane ?? 100) >= 10 && (r.pr ?? 1) >= 0.5);
    // Bot lane / "adc": marksmen only (Katarina, Yasuo, Vel'Koz bot are not ADCs).
    if (lane === 'bottom') {
      const tags = {};
      for (const c of Object.values(d.champs)) tags[String(c.key)] = c.tags || [];
      const adc = real.filter((r) => (tags[String(r.cid)] || []).includes('Marksman'));
      if (adc.length >= 5) real = adc;
    }
    const rows = (real.length >= 5 ? real : all)
      .map((r) => ({
        champion: byKey[String(r.cid)], tier: TIER_ORDER[r.tier - 1] || 'D-', lane: r.lane || undefined,
        winRate: r.wr != null ? `${Number(r.wr).toFixed(2)}%` : undefined, pickRate: r.pr != null ? `${r.pr}%` : undefined, banRate: r.br != null ? `${r.br}%` : undefined,
        games: r.games ?? undefined, _t: r.tier, _wr: r.wr ?? 0,
      }))
      .filter((r) => r.champion)
      .sort((a, b) => a._t - b._t || b._wr - a._wr)
      .slice(0, n)
      .map(({ _t, _wr, ...r }) => r);
    if (!rows.length) return { error: 'The tier list page did not have data right now.' };
    return { source: 'lolalytics', patch, rank: 'Emerald+', role: lane === 'all' ? 'all roles' : lane, champions: rows, note: lane === 'all' ? undefined : 'Only champions played in this role at least 10% of the time, pick rate 0.5%+.' };
  },
};
