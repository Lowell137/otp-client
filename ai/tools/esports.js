// Pro play from Leaguepedia (lol.fandom.com, public Cargo query API, no key):
// a team's recent results or upcoming matches, a pro player's recent games
// (champion, KDA, win), or a league / tournament's results and schedule.
// Light use: a few small queries per question, cached 10 minutes.
const API = 'https://lol.fandom.com/api.php';
const UA = 'OTP-Client/0.1 (League companion app)';
const cache = new Map();

// Values go inside "..." in a Cargo where clause: keep them plain.
const clean = (s) => String(s || '').replace(/["\\;=<>()]/g, '').trim().slice(0, 60);

async function cargo(params) {
  const qs = new URLSearchParams({ action: 'cargoquery', format: 'json', ...params });
  const url = `${API}?${qs}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < 10 * 60 * 1000) return hit.rows;
  // Anonymous use is rate limited: one retry after a short wait.
  let j = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Leaguepedia ${r.status}`);
    j = await r.json();
    if (!(j.error && /rate limit/i.test(j.error.info || ''))) break;
    if (attempt === 0) await new Promise((res) => setTimeout(res, 4000));
  }
  if (j.error) throw new Error(/rate limit/i.test(j.error.info || '') ? 'Leaguepedia is busy right now (rate limit). Try again in a minute.' : (j.error.info || 'query failed'));
  const rows = (j.cargoquery || []).map((x) => x.title);
  cache.set(url, { ts: Date.now(), rows });
  return rows;
}

// "T1", "BLG", "g2", "Gen.G" -> the team's full name as Leaguepedia uses it.
const teamCache = new Map(); // short name -> full name, for a day
async function teamName(q) {
  const v = clean(q);
  if (!v) return null;
  const hitT = teamCache.get(v.toLowerCase());
  if (hitT && Date.now() - hitT.ts < 24 * 3600 * 1000) return hitT.name;
  const rows = await cargo({ tables: 'Teams', fields: 'Name,Short,IsDisbanded', where: `Short="${v}" OR Name="${v}" OR Name LIKE "${v}%"`, limit: '8' });
  const live = rows.filter((t) => t.IsDisbanded !== '1');
  const pick = live.find((t) => t.Short?.toLowerCase() === v.toLowerCase()) || live.find((t) => t.Name?.toLowerCase() === v.toLowerCase()) || live[0] || rows[0];
  if (pick) teamCache.set(v.toLowerCase(), { ts: Date.now(), name: pick.Name });
  return pick ? pick.Name : null;
}

const when = (s) => (s ? String(s).replace(/:00$/, '') + ' UTC' : undefined);
const event = (p) => String(p || '').replace(/_/g, ' ');

module.exports = {
  name: 'esports',
  description: "Pro League of Legends from Leaguepedia: a team's recent results or upcoming matches ('T1 last matches', 'when does G2 play'), a pro player's recent games with champion and KDA ('what did Faker play'), or a league / tournament's results or schedule ('LCK this week', 'Worlds results').",
  parameters: {
    type: 'object',
    properties: {
      team: { type: 'string', description: 'Team name or short name, e.g. T1, BLG, G2, Gen.G' },
      player: { type: 'string', description: 'Pro player name, e.g. Faker, Caps' },
      league: { type: 'string', description: 'League or tournament, e.g. LCK, LEC, Worlds, MSI' },
      upcoming: { type: 'boolean', description: 'true = upcoming matches, false/empty = recent results' },
      count: { type: 'integer', description: 'How many, 1-10 (default 5)' },
    },
    required: [],
  },
  async run(args) {
    const n = String(Math.max(1, Math.min(10, Number(args?.count) || 5)));
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    if (args?.player) {
      const p = clean(args.player);
      const rows = await cargo({
        tables: 'ScoreboardPlayers', fields: 'Link,Team,Champion,Kills,Deaths,Assists,PlayerWin,DateTime_UTC,OverviewPage',
        where: `Link="${p}"`, order_by: 'DateTime_UTC DESC', limit: n,
      });
      if (!rows.length) return { error: `No pro games found for "${p}" on Leaguepedia (check the spelling of the pro name).` };
      return {
        source: 'Leaguepedia', player: rows[0].Link, team: rows[0].Team,
        games: rows.map((g) => ({ when: when(g['DateTime UTC']), champion: g.Champion, kda: `${g.Kills}/${g.Deaths}/${g.Assists}`, result: g.PlayerWin === 'Yes' ? 'win' : 'loss', event: event(g.OverviewPage) || undefined })),
      };
    }

    const parts = [];
    let team = null;
    if (args?.team) {
      team = await teamName(args.team);
      if (!team) return { error: `No team "${clean(args.team)}" on Leaguepedia.` };
      parts.push(`(Team1="${team}" OR Team2="${team}")`);
    }
    if (args?.league) {
      const l = clean(args.league).replace(/^worlds?$/i, 'World Championship');
      parts.push(`OverviewPage LIKE "%${l}%"`);
    }
    if (!parts.length) return { error: 'Give a team, a player or a league.' };
    const up = !!args?.upcoming;
    parts.push(up ? `Winner IS NULL AND DateTime_UTC >= "${now}"` : 'Winner IS NOT NULL');
    const rows = await cargo({
      tables: 'MatchSchedule', fields: 'Team1,Team2,Team1Score,Team2Score,Winner,DateTime_UTC,OverviewPage,BestOf',
      where: parts.join(' AND '), order_by: `DateTime_UTC ${up ? 'ASC' : 'DESC'}`, limit: n,
    });
    if (!rows.length) return { team: team || undefined, note: up ? 'No upcoming matches listed.' : 'No results found.' };
    return {
      source: 'Leaguepedia', team: team || undefined, kind: up ? 'upcoming' : 'recent results',
      matches: rows.map((m) => ({
        when: when(m['DateTime UTC']), match: `${m.Team1} vs ${m.Team2}`,
        score: up ? undefined : `${m.Team1Score}-${m.Team2Score}`,
        winner: up ? undefined : m.Winner === '1' ? m.Team1 : m.Winner === '2' ? m.Team2 : undefined,
        bestOf: m.BestOf ? `Bo${m.BestOf}` : undefined, event: event(m.OverviewPage),
      })),
    };
  },
};
