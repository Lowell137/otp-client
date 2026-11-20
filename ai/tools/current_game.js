// Who is in the current champion select / game: champions, roles, names, ranks,
// and how often each player has played their champion lately.
const data = require('../data.js');

module.exports = {
  name: 'current_game',
  description: 'Get the current champion select or live game: my champion and role, allies and enemies with champion, role, Riot ID, solo rank and recent games on that champion. Use for any question about the current game, lobby, teammates or enemies.',
  parameters: { type: 'object', properties: {}, required: [] },
  async run(_args, ctx) {
    const g = await data.gamePlayers(ctx);
    if (!g) return { error: 'Not in champion select or a game right now (or the League client is closed).' };
    const p = (x) => ({
      champion: x.champ || null,
      role: x.role || null,
      roleGuessed: x.guess || undefined,
      riotId: x.hidden ? 'hidden (ranked champion select)' : (x.name ? `${x.name}#${x.tag}` : null),
      me: x.me || undefined,
      rank: x.rank ? `${x.rank.tier} ${x.rank.division || ''} ${x.rank.lp ?? ''} LP (${x.rank.wins}W ${x.rank.losses}L)`.replace(/\s+/g, ' ').trim() : undefined,
      recentOnChampion: x.recent ? `${x.recent.games} of last ${x.recent.total} games, ${x.recent.wins} wins${x.recent.otp ? ', one-trick' : ''}${x.recent.first ? ', first time recently' : ''}` : undefined,
    });
    return { phase: g.phase, me: { champion: g.me?.champ || null, role: g.me?.role || null }, allies: g.allies.map(p), enemies: g.enemies.map(p) };
  },
};
