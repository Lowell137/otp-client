// A finished game in full (deeplol), for "what should I have bought / done" reviews:
// both teams with champion, role, KDA, CS, damage, gold, final items and AI score,
// my item purchase order, and the current op.gg build of my champion to compare.
// Default: my newest game on the account logged in to the League client.
const data = require('../data.js');
const build = require('./champion_build.js');

const QUEUES = { 420: 'Ranked Solo', 440: 'Ranked Flex', 400: 'Normal Draft', 430: 'Normal Blind', 490: 'Quickplay', 450: 'ARAM', 1700: 'Arena', 2400: 'ARAM Mayhem', 1900: 'URF' };

module.exports = {
  name: 'last_game',
  description: "Full details of my last finished game (or an earlier one, or another player's): both teams' champions, roles, KDA, CS, damage, gold, final items and AI score (0-100), my item purchase order, and the recommended op.gg build for my champion to compare. Use for game reviews: 'what should I have built', 'what went wrong', 'son maçım', 'bu maç ne almalıydım'.",
  parameters: {
    type: 'object',
    properties: {
      index: { type: 'integer', description: '0 = newest game (default), 1 = the one before, ...' },
      riotId: { type: 'string', description: 'Another player (Name#TAG). Default: me.' },
      region: { type: 'string', description: 'Server of that player. Default: my server.' },
    },
    required: [],
  },
  async run(args, ctx) {
    let riotId = args?.riotId;
    let region = args?.region;
    if (!riotId) {
      const acc = await ctx.call('otp:my-account').catch(() => null);
      if (!acc?.name) return { error: 'I do not know your account yet: open the League client once, or give your Riot ID (Name#TAG).' };
      riotId = `${acc.name}#${acc.tag}`;
      region = region || acc.region;
    }
    const r = await data.resolvePlayer(ctx, { riotId, region });
    if (r.error) return r;
    const { res, platform } = r;
    const idx = Math.max(0, Math.min(19, Number(args?.index) || 0));
    const id = res.pendingIds?.[idx]?.id;
    if (!id) return { error: 'No finished games found for that account.' };
    const ml = await ctx.call('otp:deeplol-matches', { platform, puuid: res.puuid, ids: [id] });
    const m = ml?.matches?.[0];
    if (!m) return { error: 'Could not load that game from deeplol. Try again in a moment.' };
    const d = await data.dd();
    const item = (x) => (x && x.id ? d.items[String(x.id)]?.name || `item ${x.id}` : null);
    const meKey = `${res.profile.name}#${res.profile.tag}`.toLowerCase();
    const isMe = (t) => `${t.name}#${t.tag}`.toLowerCase() === meKey;
    const me = (m.teams || []).find(isMe);
    const row = (t) => ({
      player: `${t.name}#${t.tag}`, me: isMe(t) || undefined, champion: t.champ, role: t.position || undefined,
      kda: `${t.kills}/${t.deaths}/${t.assists}`, cs: t.cs, damage: t.dmg, gold: t.gold, aiScore: t.ai ?? undefined,
      items: (t.items || []).slice(0, 6).map(item).filter(Boolean),
    });
    const mine = (m.teams || []).filter((t) => me && t.side === me.side).map(row);
    const theirs = (m.teams || []).filter((t) => !me || t.side !== me.side).map(row);
    const opp = me ? (m.teams || []).find((t) => t.side !== me.side && t.position && t.position === me.position) : null;
    const order = [];
    for (const g of m.build?.items || []) for (const it of g.items) { const n = item(it); if (n && order.length < 14) order.push(`${g.min}m ${n}`); }
    let recommended;
    try {
      const b = await build.run({ champion: m.champ, role: m.position }, ctx);
      if (!b.error) recommended = { runes: b.runes, core: b.coreBuilds, boots: b.boots, startingItems: b.startingItems, source: b.source };
    } catch {}
    return {
      game: { queue: QUEUES[m.queue] || m.queue, result: m.win ? 'win' : 'loss', minutes: m.dur ? Math.round(m.dur / 60) : undefined, when: data.ago(m.ts) },
      me: me ? { ...row(me), laneOpponent: opp ? `${opp.champ} (${opp.kills}/${opp.deaths}/${opp.assists})` : undefined } : undefined,
      myPurchaseOrder: order,
      myTeam: mine, enemyTeam: theirs,
      recommendedBuildForMyChampion: recommended,
      note: 'AI score is deeplol\'s 0-100 rating of each player. Compare my items with the enemy damage types and the recommended build.',
    };
  },
};
