// Who a player keeps meeting: teammates and opponents over their recent games
// (deeplol), with games together, wins, queues and a duo hint. Answers "do I always
// play with X?", "who do I duo with?", "have I played against Y?".
// Default: my own account. Looks at up to 60 recent games (30 by default).
const data = require('../data.js');

const QUEUES = { 420: 'Ranked Solo', 440: 'Ranked Flex', 400: 'Normal Draft', 430: 'Normal Blind', 490: 'Quickplay', 450: 'ARAM', 1700: 'Arena', 2400: 'ARAM Mayhem', 1900: 'URF' };
const key = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

module.exports = {
  name: 'played_with',
  description: "Who a player plays with and against, over their last 30-60 games: the teammates they meet most (games together, wins, queue, roles) and whether a named player (a friend, a duo, someone they keep seeing) was on their team or against them, with the dates and results. Use for 'do I always play with X', 'who do I duo with', 'is X in my games', 'did I play against Y'. In Ranked Solo/Duo, the same player on your team in several games means you queued together.",
  parameters: {
    type: 'object',
    properties: {
      riotId: { type: 'string', description: 'The player whose games to read (Name#TAG). Default: me.' },
      region: { type: 'string', description: 'Server of that player. Default: my server.' },
      with: { type: 'string', description: 'A player to look for in those games: a Riot ID (Name#TAG) or just the name (e.g. "Raxlingg"). Leave out to list the most frequent teammates.' },
      games: { type: 'integer', description: 'How many recent games to read, 10-60 (default 30).' },
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
    const want = Math.max(10, Math.min(60, Number(args?.games) || 30));
    let ids = (res.pendingIds || []).slice(0, want);
    if (want > ids.length && res.pendingIds?.length >= 30) {
      const last = res.pendingIds[res.pendingIds.length - 1];
      const more = await ctx.call('otp:deeplol-more', { platform, puuid: res.puuid, offset: res.pendingIds.length, lastTs: last?.ts }).catch(() => null);
      if (more?.ok) ids = ids.concat(more.ids || []).slice(0, want);
    }
    if (!ids.length) return { error: 'No games found for that account.' };

    // Game details, 10 at a time (a few batches at once).
    const batches = [];
    for (let i = 0; i < ids.length; i += 10) batches.push(ids.slice(i, i + 10).map((x) => x.id));
    const matches = [];
    for (let i = 0; i < batches.length; i += 3) {
      const got = await Promise.all(batches.slice(i, i + 3).map((b) => ctx.call('otp:deeplol-matches', { platform, puuid: res.puuid, ids: b }).catch(() => null)));
      for (const g of got) matches.push(...(g?.matches || []));
    }
    if (!matches.length) return { error: 'Could not load the games from deeplol. Try again in a moment.' };
    matches.sort((a, b) => (b.ts || 0) - (a.ts || 0));

    const meKey = key(`${res.profile.name}${res.profile.tag}`);
    const rows = [];
    for (const m of matches) {
      const teams = m.teams || [];
      const me = teams.find((t) => key(`${t.name}${t.tag}`) === meKey);
      if (!me) continue;
      rows.push({ m, me, mates: teams.filter((t) => t !== me && t.side === me.side), foes: teams.filter((t) => t.side !== me.side) });
    }
    const q = (m) => QUEUES[m.queue] || `queue ${m.queue}`;
    const line = (x, p) => `${data.ago(x.m.ts)} · ${q(x.m)} · ${x.m.win ? 'win' : 'loss'} · you ${x.me.champ}${x.me.position ? ` (${x.me.position})` : ''}, ${p.name}#${p.tag} ${p.champ}${p.position ? ` (${p.position})` : ''}`;
    const out = { player: `${res.profile.name}#${res.profile.tag}`, server: platform.toUpperCase(), gamesRead: rows.length };

    const target = String(args?.with || '').trim();
    if (target) {
      const full = target.includes('#') ? key(target) : null;
      const name = full ? null : key(target);
      const is = (p) => (full ? key(`${p.name}${p.tag}`) === full : key(p.name) === name || (name.length >= 4 && key(p.name).startsWith(name)));
      const together = [], against = [];
      for (const x of rows) {
        const mate = x.mates.find(is), foe = x.foes.find(is);
        if (mate) together.push({ x, p: mate });
        else if (foe) against.push({ x, p: foe });
      }
      const wins = together.filter((t) => t.x.m.win).length;
      const names = [...new Set([...together, ...against].map((t) => `${t.p.name}#${t.p.tag}`))];
      out.searched = target;
      out.matchedPlayers = names.slice(0, 3);
      out.sameTeam = { games: together.length, wins, losses: together.length - wins, winRate: together.length ? `${Math.round((wins / together.length) * 100)}%` : undefined };
      out.againstYou = { games: against.length, youWon: against.filter((t) => t.x.m.win).length };
      const soloTogether = together.filter((t) => t.x.m.queue === 420).length;
      const who = names[0] || target;
      out.verdict = together.length === 0 && against.length === 0
        ? `${target} is not in any of your last ${rows.length} games.`
        : together.length >= 3 && soloTogether >= 2
          ? `${who} was on your team in ${together.length} of ${rows.length} games, ${soloTogether} of them in Ranked Solo/Duo: you queue together (duo).`
          : together.length
            ? `${who} was on your team in ${together.length} of ${rows.length} games${soloTogether ? ` (${soloTogether} in Ranked Solo/Duo)` : ''}.`
            : `${who} was only an opponent (${against.length} games), never on your team.`;
      out.games = [...together.map((t) => `together: ${line(t.x, t.p)}`), ...against.map((t) => `against: ${line(t.x, t.p)}`)].slice(0, 10);
      out.note = 'Premade is not in the data: "queued together" is read from the same player being on your team in Ranked Solo/Duo several times. Normals and Flex can be premades of any size.';
      return out;
    }

    // Most frequent teammates and opponents.
    const tally = (pick) => {
      const map = new Map();
      for (const x of rows) for (const p of pick(x)) {
        const k = key(`${p.name}${p.tag}`);
        const e = map.get(k) || { player: `${p.name}#${p.tag}`, games: 0, wins: 0, solo: 0, roles: {} };
        e.games++; if (x.m.win) e.wins++; if (x.m.queue === 420) e.solo++;
        if (p.position) e.roles[p.position] = (e.roles[p.position] || 0) + 1;
        map.set(k, e);
      }
      return [...map.values()].filter((e) => e.games >= 2).sort((a, b) => b.games - a.games).slice(0, 6).map((e) => ({
        player: e.player, games: e.games, wins: e.wins, winRate: `${Math.round((e.wins / e.games) * 100)}%`, inRankedSolo: e.solo,
        usualRole: Object.entries(e.roles).sort((a, b) => b[1] - a[1])[0]?.[0],
      }));
    };
    out.mostFrequentTeammates = tally((x) => x.mates);
    out.mostFrequentOpponents = tally((x) => x.foes);
    out.note = 'Only players met 2+ times are listed. The same player on your team in several Ranked Solo/Duo games means you queued together (duo).';
    return out;
  },
};
