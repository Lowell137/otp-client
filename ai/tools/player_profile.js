// A player's ranks, LP trend and most played champions this season (deeplol).
const data = require('../data.js');

module.exports = {
  name: 'player_profile',
  description: "Look up a League of Legends player: solo/flex rank with wins and losses, peak, LP change over the last 30 days and most played champions this season. Give a Riot ID (Name#TAG), or the champion the player is on in the current game (e.g. 'Ezreal' for the enemy Ezreal).",
  parameters: {
    type: 'object',
    properties: {
      riotId: { type: 'string', description: 'Riot ID like Faker#KR1' },
      champion: { type: 'string', description: 'Champion the player is on in the current game, instead of a Riot ID' },
      region: { type: 'string', description: 'Server: TR, EUW, EUNE, NA, KR, ... Defaults to my server.' },
    },
    required: [],
  },
  async run(args, ctx) {
    const r = await data.resolvePlayer(ctx, args || {});
    if (r.error) return r;
    const { res, platform } = r;
    const ex = await ctx.call('otp:deeplol-extra', { platform, puuid: res.puuid, summonerId: res.summonerId }).catch(() => null);
    const rk = (q) => (q ? {
      rank: `${q.tier} ${q.division ?? ''} ${q.lp ?? 0} LP`.replace(/\s+/g, ' '),
      wins: q.wins, losses: q.losses,
      winRate: q.wins + q.losses ? `${Math.round((q.wins / (q.wins + q.losses)) * 100)}%` : undefined,
      peak: q.peak || undefined,
    } : 'unranked');
    // tier-chart points: { tier, division (1-4), league_points, timestamp }; one ladder number per point.
    const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
    const lp30 = (list) => {
      const v = (list || []).map((p) => {
        const t = TIERS.indexOf(p?.tier);
        return t < 0 ? null : t >= 7 ? 2800 + p.league_points : t * 400 + (4 - (p.division || 4)) * 100 + p.league_points;
      }).filter((x) => x != null);
      return v.length > 1 ? v[v.length - 1] - v[0] : undefined;
    };
    const champs = (ex?.champStats?.total || []).slice(0, 6).map((c) => ({
      champion: c.champ, games: c.games, winRate: `${Math.round(c.wr)}%`, kda: Number((c.kda ?? 0).toFixed(2)), csPerMin: c.cspm != null ? Number(c.cspm.toFixed(1)) : undefined,
    }));
    return {
      riotId: `${res.profile.name}#${res.profile.tag}`, server: platform.toUpperCase(), level: res.profile.level,
      soloQueue: ex ? rk(ex.ranks?.solo) : res.ranks?.[0],
      flexQueue: ex ? rk(ex.ranks?.flex) : undefined,
      soloLpChangeLast30Days: ex ? lp30(ex.lpHistory?.solo) : undefined,
      seasonChampions: champs,
      deeplol: `https://www.deeplol.gg/summoner/${platform.replace(/\d+$/, '')}/${encodeURIComponent(res.profile.name)}-${encodeURIComponent(res.profile.tag)}`,
    };
  },
};
