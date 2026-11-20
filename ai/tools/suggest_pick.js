// Champion pick suggestions for a role: the strongest champions this patch
// (lolalytics tier list) minus the ones already picked or banned in the current
// champion select. Role defaults to my assigned role.
const data = require('../data.js');
const tierList = require('./tier_list.js');

const ROLE = { top: 'top', jungle: 'jungle', jg: 'jungle', mid: 'mid', middle: 'mid', bot: 'bot', bottom: 'bot', adc: 'bot', support: 'support', supp: 'support', sup: 'support', utility: 'support' };

// Bans of the current champion select, straight from the client.
async function bans() {
  try {
    const creds = await require('../../lcu.js').getCreds();
    const { request } = require('league-connect');
    const r = await request({ method: 'GET', url: '/lol-champ-select/v1/session' }, creds);
    if (r.status !== 200) return [];
    const s = await r.json();
    const ids = [];
    for (const group of s.actions || []) for (const a of group) if (a.type === 'ban' && a.completed && a.championId) ids.push(a.championId);
    for (const id of [...(s.bans?.myTeamBans || []), ...(s.bans?.theirTeamBans || [])]) if (id) ids.push(id);
    const d = await data.dd();
    const byKey = {};
    for (const c of Object.values(d.champs)) byKey[c.key] = c.name;
    return [...new Set(ids)].map((id) => byKey[id]).filter(Boolean);
  } catch { return []; }
}

module.exports = {
  name: 'suggest_pick',
  description: 'Suggest champions to pick for a role (top, jungle, mid, bot/adc, support): the strongest this patch, without champions already picked or banned in the current champion select. Use for "suggest/recommend a champion", "what should I pick", "öner".',
  parameters: {
    type: 'object',
    properties: {
      role: { type: 'string', description: 'top, jungle, mid, bot (adc) or support. Default: my assigned role.' },
    },
    required: [],
  },
  async run(args, ctx) {
    const g = await data.gamePlayers(ctx).catch(() => null);
    const role = ROLE[data.norm(args?.role)] || ROLE[data.norm(g?.me?.role)] || '';
    if (!role) return { error: 'Which role? (top, jungle, mid, bot or support)' };
    const tl = await tierList.run({ role, count: 20 }, ctx);
    if (tl.error) return tl;
    const banned = g?.phase === 'ChampSelect' ? await bans() : [];
    const picked = [...(g?.allies || []), ...(g?.enemies || [])].map((p) => p.champ).filter(Boolean);
    const takenNorm = new Set([...banned, ...picked].map(data.norm));
    let free = tl.champions.filter((c) => !takenNorm.has(data.norm(c.champion)));
    // Bot lane: marksmen (an "ADC"), not the odd Katarina / Yasuo bot.
    if (role === 'bot') {
      const tags = await Promise.all(free.map(async (c) => ((await data.champion(c.champion))?.tags || [])));
      const adc = free.filter((_, i) => tags[i].includes('Marksman'));
      if (adc.length >= 3) free = adc;
    }
    const enemyLaner = (g?.enemies || []).find((p) => p.role === (role === 'support' ? 'supp' : role) && p.champ)?.champ;
    return {
      role, patch: tl.patch, source: 'lolalytics Emerald+',
      suggestions: free.slice(0, 5),
      notAvailable: [...new Set([...banned.map((b) => `${b} (banned)`), ...picked.map((p) => `${p} (picked)`)])],
      enemyLaner: enemyLaner || undefined,
    };
  },
};
