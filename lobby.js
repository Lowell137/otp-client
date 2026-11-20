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

  // Lane guesses for players without a known lane (enemies in champion select,
  // blind pick, bots): each champion's play rate per position (Meraki
  // championrates.json, refreshed daily), then the assignment of the free lanes
  // with the highest total play rate, so two players never share a guess.
  let rates = null, ratesTs = 0;
  async function loadRates() {
    if (rates && Date.now() - ratesTs < 24 * 3600 * 1000) return rates;
    try {
      const r = await fetch('https://cdn.merakianalytics.com/riot/lol/resources/latest/en-US/championrates.json');
      if (r.ok) { rates = (await r.json()).data || {}; ratesTs = Date.now(); }
    } catch {}
    return rates || {};
  }
  const POS = { top: 'TOP', jungle: 'JUNGLE', mid: 'MIDDLE', bot: 'BOTTOM', supp: 'UTILITY' };
  async function guessRoles(players) {
    if (!players || !players.length) return;
    const taken = new Set(players.map((p) => normRole(p.role)).filter(Boolean));
    const free = Object.keys(POS).filter((r) => !taken.has(r));
    const open = players.filter((p) => !normRole(p.role));
    if (!open.length || !free.length) return;
    const rt = await loadRates();
    const rate = (p, r) => (p.champId && rt[p.champId] ? (rt[p.champId][POS[r]]?.playRate || 0) : 0);
    let best = null, bestScore = -1;
    const perm = (i, used, acc, score) => {
      if (i === open.length) { if (score > bestScore) { bestScore = score; best = acc.slice(); } return; }
      for (const r of free) {
        if (used.has(r)) continue;
        used.add(r); acc.push(r);
        perm(i + 1, used, acc, score + rate(open[i], r));
        used.delete(r); acc.pop();
      }
      if (open.length > free.length) { acc.push(''); perm(i + 1, used, acc, score); acc.pop(); }
    };
    perm(0, new Set(), [], 0);
    if (!best || bestScore <= 0) return;
    open.forEach((p, i) => { if (best[i] && rate(p, best[i]) > 0) { p.role = best[i]; p.guess = true; } });
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
    const base = { me: !!p.me, bot: !!p.bot, hidden: !p.puuid && !p.bot, name: p.name || '', tag: p.tag || '', champ, role: normRole(p.role), guess: !!p.guess, rank: null, recent: null };
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
    // The game's own Live Client API lists all ten players with team and lane (the
    // LCU session leaves out bots, e.g. Practice Tool / Co-op). Build the roster
    // from it and take puuids (for rank and history) from the LCU session.
    let list = null;
    try { list = await liveGet('/liveclientdata/playerlist', 1500); } catch {}
    if (Array.isArray(list) && list.length) {
      const lcuByName = new Map([...one, ...two].filter((p) => p.name).map((p) => [p.name.toLowerCase(), p]));
      const myName = String(me.gameName || me.displayName || '').toLowerCase();
      const nameOf = (x) => String(x.riotIdGameName || (x.riotId || '').split('#')[0] || x.summonerName || '');
      const meRow = list.find((x) => nameOf(x).toLowerCase() === myName) || list.find((x) => !x.isBot);
      const myTeam = meRow ? meRow.team : 'ORDER';
      const rows = await Promise.all(list.map(async (x) => {
        const nm = nameOf(x);
        const l = lcuByName.get(nm.toLowerCase());
        const key = String(x.rawChampionName || '').split('_').pop();
        return {
          me: x === meRow,
          bot: !!x.isBot,
          puuid: x.isBot ? '' : (l ? l.puuid : (x === meRow ? me.puuid : '')),
          name: x.isBot ? '' : nm,
          tag: x.isBot ? '' : (x.riotIdTagLine || (x.riotId || '').split('#')[1] || (l && l.tag) || ''),
          champId: (l && l.champId) || await champKeyToId(key),
          role: x.position || (l && l.role) || '',
        };
      }));
      return { phase: 'InGame', mine: rows.filter((_, i) => list[i].team === myTeam), theirs: rows.filter((_, i) => list[i].team !== myTeam) };
    }
    const mineIsOne = one.some((p) => p.me);
    return { phase: 'InGame', mine: mineIsOne ? one : two, theirs: mineIsOne ? two : one };
  }

  // Champion key ("KogMaw") -> numeric id from Data Dragon; the live API names
  // champions by key.
  let keyToId = null;
  async function champKeyToId(key) {
    if (!keyToId) {
      try {
        const v = (await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json())[0];
        const d = (await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/data/en_US/champion.json`)).json()).data;
        keyToId = new Map(Object.values(d).map((c) => [c.id.toLowerCase(), Number(c.key)]));
      } catch { return 0; }
    }
    return keyToId.get(String(key || '').toLowerCase()) || 0;
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
          await guessRoles(raw.mine);
          await guessRoles(raw.theirs);
          const allies = await Promise.all(raw.mine.map((p) => enrich(creds, p)));
          const enemies = await Promise.all(raw.theirs.map((p) => enrich(creds, p)));
          const me = allies.find((p) => p.me) || {};
          // No lane for me (Practice Tool, blind pick): if the others cover four
          // different lanes, mine is the one left.
          if (me.me && !me.role) {
            const taken = new Set(allies.filter((p) => !p.me && p.role).map((p) => p.role));
            const left = ['top', 'jungle', 'mid', 'bot', 'supp'].filter((r) => !taken.has(r));
            if (taken.size === 4 && left.length === 1) me.role = left[0];
          }
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
    if (state) console.log(`[otp] lobby ${state.phase}: me=${state.me.champ || "-"}/${state.me.role || "-"} allies=${state.allies.map((p) => (p.champ || "?") + (p.hidden ? "(hidden)" : p.rank ? "(" + p.rank.tier + ")" : "")).join(",")} enemies=${state.enemies.map((p) => (p.champ || "?") + (p.role ? "@" + p.role : "") + (p.rank ? "(" + p.rank.tier + ")" : "")).join(",")}`);
    else console.log("[otp] lobby: none");
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
