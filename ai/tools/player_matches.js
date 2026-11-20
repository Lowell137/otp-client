// A player's recent matches (deeplol): champion, result, KDA, CS, AI score.
const data = require('../data.js');

const QUEUES = { 420: 'Ranked Solo', 440: 'Ranked Flex', 400: 'Normal Draft', 430: 'Normal Blind', 490: 'Quickplay', 450: 'ARAM', 1700: 'Arena', 2400: 'ARAM Mayhem', 1900: 'URF' };

module.exports = {
  name: 'player_matches',
  description: "A player's most recent matches: champion, role, win/loss, KDA, CS, game length, queue and AI score (0-100). Leave both out for my own account. Or give a Riot ID (Name#TAG), or the champion the player is on in the current game.",
  parameters: {
    type: 'object',
    properties: {
      riotId: { type: 'string', description: 'Riot ID like Faker#KR1' },
      champion: { type: 'string', description: 'Champion the player is on in the current game, instead of a Riot ID' },
      region: { type: 'string', description: 'Server: TR, EUW, NA, KR, ... Defaults to my server.' },
      count: { type: 'integer', description: 'How many matches, 1-10 (default 10)' },
    },
    required: [],
  },
  async run(args, ctx) {
    const r = await data.resolvePlayer(ctx, args || {});
    if (r.error) return r;
    const { res, platform } = r;
    const n = Math.max(1, Math.min(10, Number(args?.count) || 10));
    const ids = (res.pendingIds || []).slice(0, n).map((x) => x.id);
    if (!ids.length) return { riotId: `${res.profile.name}#${res.profile.tag}`, matches: [], note: 'No recent matches.' };
    const ml = await ctx.call('otp:deeplol-matches', { platform, puuid: res.puuid, ids });
    const matches = (ml?.matches || []).sort((a, b) => (b.ts || 0) - (a.ts || 0)).map((m) => ({
      champion: m.champ, role: m.position || undefined, result: m.win ? 'win' : 'loss',
      kda: `${m.kills}/${m.deaths}/${m.assists}`, cs: m.cs, minutes: m.dur ? Math.round(m.dur / 60) : undefined,
      queue: QUEUES[m.queue] || m.queue, aiScore: m.ai ?? undefined, when: data.ago(m.ts),
    }));
    const wins = matches.filter((m) => m.result === 'win').length;
    return { riotId: `${res.profile.name}#${res.profile.tag}`, summary: `${wins}W ${matches.length - wins}L in the last ${matches.length}`, matches };
  },
};
