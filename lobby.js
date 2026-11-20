// Lobby scouting for the build page panel.
//
// Watches the League client (LCU) every 2 s and builds one state object:
//   { phase: 'ChampSelect' | 'InGame', me: { champ, role }, allies: [...], enemies: [...] }
// Each player: { me, hidden, name, tag, champ, role, rank, recent }.
//   rank   = solo queue rank from /lol-ranked (tier, division, LP, wins, losses)
//   recent = last 20 games from /lol-match-history: games/wins on the player's
//            current champion, and whether they look like a one-trick (OTP).
//
// Champ select in ranked is anonymous: allies there come without puuid/name and we
// leave them that way (no de-anonymizing). Names show up again once the game starts
// (the loading screen shows them too), from /lol-gameflow/v1/session.
//
// OTP_LOBBY_DEMO=1 sends a fixed sample lobby so the panel can be tested offline.

const ROLE = {
  top: 'top', jungle: 'jungle', middle: 'mid', mid: 'mid', bottom: 'bot', bot: 'bot',
  utility: 'supp', support: 'supp', supp: 'supp',
};
const normRole = (r) => ROLE[String(r || '').toLowerCase()] || '';

function createLobbyWatch({ getCreds, request, champIdToName, liveGet, send }) {
  const cache = new Map(); // puuid -> { ts, rank, games: [{ champId, win }] }
  const TTL = 10 * 60 * 1000;
  let lastJson = '';
  let busy = false;

  async function lcu(creds, url) {
    const r = await request({ method: 'GET', url }, creds);
    if (r.status !== 200) throw new Error('LCU ' + r.status + ' ' + url);
    return r.json();
  }

  async function playerInfo(creds, puuid) {
    const hit = cache.get(puuid);
    if (hit && Date.now() - hit.ts < TTL) return hit;
    const out = { ts: Date.now(), rank: null, games: [] };
    const [rs, mh] = await Promise.allSettled([
      lcu(creds, `/lol-ranked/v1/ranked-stats/${puuid}`),
      lcu(creds, `/lol-match-history/v1/products/lol/${puuid}/matches?begIndex=0&endIndex=19`),
    ]);
    if (rs.status === 'fulfilled') {
      const q = rs.value?.queueMap?.RANKED_SOLO_5x5 || rs.value?.queueMap?.RANKED_FLEX_SR;
      if (q && q.tier && q.tier !== 'NONE') {
        out.rank = {
          queue: rs.value?.queueMap?.RANKED_SOLO_5x5?.tier && rs.value.queueMap.RANKED_SOLO_5x5.tier !== 'NONE' ? 'Solo' : 'Flex',
          tier: q.tier, division: q.division, lp: q.leaguePoints ?? 0, wins: q.wins ?? 0, losses: q.losses ?? 0,
        };
      }
    }
    if (mh.status === 'fulfilled') {
      const games = mh.value?.games?.games || mh.value?.games || [];
      for (const g of games) {
        const p = (g.participants || [])[0] || {};
        const champId = g.championId ?? p.championId ?? 0;
        const win = !!(p.stats?.win ?? g.stats?.win);
        if (champId) out.games.push({ champId, win });
      }
    }
    cache.set(puuid, out);
    return out;
  }

  function recentFor(info, champId) {
    const total = info.games.length;
    const on = info.games.filter((g) => g.champId === champId);
    const wins = on.filter((g) => g.win).length;
    // One-trick: at least half of the recent games (and 5+) on this champion.
    const otp = on.length >= 5 && on.length / Math.max(1, total) >= 0.5;
    return { total, games: on.length, wins, otp, first: total >= 5 && on.length === 0 };
  }

  async function enrich(creds, p) {
    const champ = p.champId ? await champIdToName(p.champId) : null;
    const base = { me: !!p.me, hidden: !p.puuid, name: p.name || '', tag: p.tag || '', champ, role: normRole(p.role), rank: null, recent: null };
    if (!p.puuid) return base;
    try {
      const info = await playerInfo(creds, p.puuid);
      base.rank = info.rank;
      if (p.champId) base.recent = recentFor(info, p.champId);
    } catch {}
    return base;
  }

  async function fromChampSelect(creds) {
    const s = await lcu(creds, '/lol-champ-select/v1/session');
    const mine = (s.myTeam || []).map((p) => ({
      me: p.cellId === s.localPlayerCellId,
      puuid: p.puuid || '',
      name: p.gameName || '', tag: p.tagLine || '',
      champId: p.championId || p.championPickIntent || 0,
      role: p.assignedPosition,
    }));
    // Names of allies may be hidden (ranked); fill in my own name from the summoner.
    for (const p of mine) {
      if (p.puuid && !p.name) {
        try {
          const si = await lcu(creds, `/lol-summoner/v2/summoners/puuid/${p.puuid}`);
          p.name = si.gameName || si.displayName || ''; p.tag = si.tagLine || '';
        } catch {}
      }
    }
    const theirs = (s.theirTeam || []).map((p) => ({
      puuid: '', name: '', champId: p.championId || p.championPickIntent || 0, role: p.assignedPosition,
    }));
    return { phase: 'ChampSelect', mine, theirs };
  }

  async function fromGame(creds) {
    const gs = await lcu(creds, '/lol-gameflow/v1/session');
    const gd = gs.gameData || {};
    const me = await lcu(creds, '/lol-summoner/v1/current-summoner');
    const sel = new Map((gd.playerChampionSelections || []).map((x) => [x.puuid || x.summonerInternalName, x.championId]));
    const conv = (x) => ({
      me: x.puuid === me.puuid,
      puuid: x.puuid || '',
      name: x.gameName || x.summonerName || '', tag: x.tagLine || '',
      champId: x.championId || sel.get(x.puuid) || 0,
      role: x.selectedPosition || '',
    });
    const one = (gd.teamOne || []).map(conv);
    const two = (gd.teamTwo || []).map(conv);
    const mineIsOne = one.some((p) => p.me);
    const res = { phase: 'InGame', mine: mineIsOne ? one : two, theirs: mineIsOne ? two : one };
    // Live Client Data (in game) knows every player's lane; fill missing roles.
    try {
      const list = await liveGet('/liveclientdata/playerlist', 1500);
      const byName = new Map(list.map((x) => [String(x.riotIdGameName || (x.riotId || '').split('#')[0] || x.summonerName || '').toLowerCase(), x.position]));
      for (const p of [...res.mine, ...res.theirs]) {
        if (!p.role && p.name) p.role = byName.get(p.name.toLowerCase()) || '';
      }
    } catch {}
    return res;
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      let raw = null;
      try {
        const creds = await getCreds();
        const phase = await lcu(creds, '/lol-gameflow/v1/gameflow-phase');
        if (phase === 'ChampSelect') raw = await fromChampSelect(creds);
        else if (phase === 'InProgress' || phase === 'GameStart' || phase === 'Reconnect') raw = await fromGame(creds);
        if (raw) {
          const allies = await Promise.all(raw.mine.map((p) => enrich(creds, p)));
          const enemies = await Promise.all(raw.theirs.map((p) => enrich(creds, p)));
          const me = allies.find((p) => p.me) || {};
          raw = { phase: raw.phase, me: { champ: me.champ || null, role: me.role || '' }, allies, enemies };
        }
      } catch { raw = null; }
      push(raw);
    } finally { busy = false; }
  }

  function push(state) {
    const j = JSON.stringify(state);
    if (j === lastJson) return;
    lastJson = j;
    send(state);
  }

  return {
    start() {
      if (process.env.OTP_LOBBY_DEMO === '1') { setTimeout(() => push(DEMO), 3000); return; }
      setInterval(tick, 2000);
      tick();
    },
    current() { return lastJson ? JSON.parse(lastJson) : null; },
  };
}

const r = (tier, division, lp, wins, losses) => ({ queue: 'Solo', tier, division, lp, wins, losses });
const DEMO = {
  phase: 'InGame',
  me: { champ: 'Fiora', role: 'top' },
  allies: [
    { me: true, hidden: false, name: 'Lowell', tag: 'TR1', champ: 'Fiora', role: 'top', rank: r('EMERALD', 'II', 45, 61, 52), recent: { total: 20, games: 14, wins: 9, otp: true, first: false } },
    { me: false, hidden: false, name: 'Kestrel', tag: 'EUW', champ: 'LeeSin', role: 'jungle', rank: r('PLATINUM', 'I', 78, 40, 38), recent: { total: 20, games: 3, wins: 1, otp: false, first: false } },
    { me: false, hidden: false, name: 'nightjar', tag: '000', champ: 'Ahri', role: 'mid', rank: r('EMERALD', 'IV', 12, 22, 25), recent: { total: 20, games: 0, wins: 0, otp: false, first: true } },
    { me: false, hidden: false, name: 'Bluefin', tag: 'TR1', champ: 'Jinx', role: 'bot', rank: r('DIAMOND', 'IV', 0, 70, 64), recent: { total: 20, games: 11, wins: 7, otp: true, first: false } },
    { me: false, hidden: false, name: 'Marrow', tag: 'TR1', champ: 'Thresh', role: 'supp', rank: null, recent: { total: 12, games: 4, wins: 2, otp: false, first: false } },
  ],
  enemies: [
    { me: false, hidden: false, name: 'Quillfeather', tag: 'TR1', champ: 'Jax', role: 'top', rank: r('DIAMOND', 'III', 33, 88, 70), recent: { total: 20, games: 17, wins: 12, otp: true, first: false } },
    { me: false, hidden: false, name: 'Tallow', tag: 'TR1', champ: 'Viego', role: 'jungle', rank: r('EMERALD', 'I', 90, 51, 49), recent: { total: 20, games: 6, wins: 4, otp: false, first: false } },
    { me: false, hidden: false, name: 'Cobalt', tag: 'TR1', champ: 'Syndra', role: 'mid', rank: r('EMERALD', 'III', 50, 33, 30), recent: { total: 20, games: 2, wins: 1, otp: false, first: false } },
    { me: false, hidden: false, name: 'Wren', tag: 'TR1', champ: 'Kaisa', role: 'bot', rank: r('PLATINUM', 'II', 64, 29, 31), recent: { total: 20, games: 0, wins: 0, otp: false, first: true } },
    { me: false, hidden: false, name: 'Pumice', tag: 'TR1', champ: 'Nautilus', role: 'supp', rank: r('EMERALD', 'II', 20, 45, 41), recent: { total: 20, games: 9, wins: 5, otp: false, first: false } },
  ],
};

module.exports = { createLobbyWatch };
