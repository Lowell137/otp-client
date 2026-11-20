// Post-game card: after a game ends, the build page shows how it went (result, LP
// change, KDA, CS, damage, gold, items) next to what one-tricks build.
//
// main side: watches the LCU game flow. In champion select / in game it snapshots
// the ranked standings and the newest match id; when the game is over it waits
// for the match to show up in the match history (a few seconds after the end),
// then for the ranked numbers to change, builds the card and sends it to the page
// ('otp:postgame'). The card is kept in the state file until dismissed.
//
// OTP_POSTGAME_DEMO=1 sends a fixed sample card shortly after start.

const QUEUE = { 420: 'Ranked Solo/Duo', 440: 'Ranked Flex', 400: 'Normal Draft', 430: 'Normal Blind', 490: 'Quickplay', 450: 'ARAM', 1700: 'Arena', 1900: 'URF', 0: 'Custom' };
const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const DIV = { IV: 0, III: 1, II: 2, I: 3 };
// One number per standing so LP gained across a division / tier change adds up.
function ladder(q) {
  if (!q || !q.tier || q.tier === 'NONE') return null;
  const t = TIERS.indexOf(q.tier);
  if (t < 0) return null;
  if (t >= 7) return 2800 + (q.leaguePoints || 0); // Master+: one LP pool
  return t * 400 + (DIV[q.division] ?? 0) * 100 + (q.leaguePoints || 0);
}

function createPostGameWatch({ getCreds, request, champIdToName, getLobby, readState, writeState, send }) {
  let prevPhase = null;
  let before = null;   // { gameId, ranked: { 420: q, 440: q }, role, opp }
  let pending = null;  // looking for the finished game
  let busy = false;

  async function lcu(creds, url) {
    const r = await request({ method: 'GET', url }, creds);
    if (r.status !== 200) throw new Error('LCU ' + r.status);
    return r.json();
  }
  async function newestGame(creds, puuid) {
    const mh = await lcu(creds, `/lol-match-history/v1/products/lol/${puuid}/matches?begIndex=0&endIndex=0`);
    return ((mh.games && mh.games.games) || [])[0] || null;
  }
  async function rankedQueues(creds, puuid) {
    const rs = await lcu(creds, `/lol-ranked/v1/ranked-stats/${puuid}`);
    return { 420: rs?.queueMap?.RANKED_SOLO_5x5 || null, 440: rs?.queueMap?.RANKED_FLEX_SR || null };
  }

  async function snapshot(creds) {
    const me = await lcu(creds, '/lol-summoner/v1/current-summoner');
    const [g, ranked] = await Promise.all([newestGame(creds, me.puuid).catch(() => null), rankedQueues(creds, me.puuid).catch(() => ({}))]);
    const lob = getLobby() || {};
    const role = lob.me?.role || '';
    const opp = role ? (lob.enemies || []).find((p) => p.role === role && p.champ)?.champ || '' : '';
    before = { puuid: me.puuid, gameId: g ? g.gameId : 0, ranked, role, opp, ts: Date.now() };
  }

  async function buildCard(creds, g) {
    const p = (g.participants || [])[0] || {};
    const st = p.stats || {};
    const champ = (await champIdToName(p.championId)) || '';
    const card = {
      gameId: g.gameId, ts: g.gameCreation ? g.gameCreation + (g.gameDuration || 0) * 1000 : Date.now(),
      queueId: g.queueId, queue: QUEUE[g.queueId] || g.gameMode || 'Game',
      dur: g.gameDuration || 0, win: !!st.win, champ, level: st.champLevel || 0,
      k: st.kills || 0, d: st.deaths || 0, a: st.assists || 0,
      cs: (st.totalMinionsKilled || 0) + (st.neutralMinionsKilled || 0),
      gold: st.goldEarned || 0, dmg: st.totalDamageDealtToChampions || 0, vision: st.visionScore || 0,
      items: [0, 1, 2, 3, 4, 5, 6].map((i) => st['item' + i] || 0),
      spells: [p.spell1Id, p.spell2Id].filter(Boolean), keystone: st.perk0 || 0, sub: st.perkSubStyle || 0,
      role: before?.role || '', opp: before?.opp || '', lp: null,
    };
    return card;
  }

  // Ranked: LP before/after for the game's queue. The ranked numbers update a bit
  // after the match history does, so this is retried a few times.
  async function lpChange(creds, card) {
    const qid = card.queueId === 440 ? 440 : card.queueId === 420 ? 420 : 0;
    if (!qid || !before?.ranked?.[qid]) return null;
    const b = before.ranked[qid];
    for (let i = 0; i < 8; i++) {
      const now = (await rankedQueues(creds, before.puuid).catch(() => ({})))[qid];
      if (now && (now.wins + now.losses) !== (b.wins + b.losses)) {
        const x = ladder(b), y = ladder(now);
        return {
          delta: x != null && y != null ? y - x : null,
          tier: now.tier, division: now.division, lp: now.leaguePoints,
          changedTier: b.tier !== now.tier || b.division !== now.division,
        };
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
    return null;
  }

  async function finish(creds) {
    // Up to ~2 minutes for the game to appear in the match history.
    for (let i = 0; i < 24; i++) {
      const g = await newestGame(creds, before.puuid).catch(() => null);
      if (g && g.gameId && g.gameId !== before.gameId) {
        const card = await buildCard(creds, g);
        publish(card);
        card.lp = await lpChange(creds, card);
        if (card.lp) publish(card);
        return;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  function publish(card) {
    const st = readState();
    st.lastGame = card;
    writeState(st);
    console.log(`[otp] post-game: ${card.champ} ${card.win ? 'win' : 'loss'} ${card.k}/${card.d}/${card.a}${card.lp ? ` LP ${card.lp.delta}` : ''}`);
    send(card);
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const creds = await getCreds();
      const phase = await lcu(creds, '/lol-gameflow/v1/gameflow-phase');
      if (phase !== prevPhase) {
        if (phase === 'ChampSelect' || (phase === 'InProgress' && !before)) await snapshot(creds).catch(() => {});
        // Keep role / opponent fresh once the game is on (lanes known then).
        if (phase === 'InProgress' && before) {
          const lob = getLobby() || {};
          if (lob.me?.role) before.role = lob.me.role;
          const opp = before.role ? (lob.enemies || []).find((p) => p.role === before.role && p.champ) : null;
          if (opp) before.opp = opp.champ;
        }
        const ended = (prevPhase === 'InProgress' || prevPhase === 'Reconnect') && phase !== 'InProgress' && phase !== 'Reconnect';
        if (ended && before && !pending) {
          pending = finish(creds).catch(() => {}).finally(() => { pending = null; before = null; });
        }
        prevPhase = phase;
      } else if (phase === 'InProgress' && before && !before.opp) {
        const lob = getLobby() || {};
        if (lob.me?.role) before.role = lob.me.role;
        const opp = before.role ? (lob.enemies || []).find((p) => p.role === before.role && p.champ) : null;
        if (opp) before.opp = opp.champ;
      }
    } catch {
      // Client closed: forget the game in progress.
      prevPhase = null;
    } finally { busy = false; }
  }

  return {
    start() {
      if (process.env.OTP_POSTGAME_DEMO === '1') { setTimeout(() => send(DEMO), 3000); return; }
      setInterval(tick, 3000);
      tick();
    },
    current() {
      if (process.env.OTP_POSTGAME_DEMO === '1') return DEMO;
      const st = readState();
      const c = st.lastGame;
      if (!c || st.lastGameDismissed === c.gameId) return null;
      // Old news after half a day.
      if (Date.now() - (c.ts || 0) > 12 * 60 * 60 * 1000) return null;
      return c;
    },
    dismiss(gameId) {
      const st = readState();
      st.lastGameDismissed = gameId;
      writeState(st);
    },
  };
}

const DEMO = {
  gameId: 1, ts: Date.now() - 4 * 60 * 1000, queueId: 420, queue: 'Ranked Solo/Duo', dur: 1712, win: true,
  champ: 'Fiora', level: 16, k: 9, d: 3, a: 4, cs: 231, gold: 13120, dmg: 24850, vision: 18,
  items: [3074, 3078, 3047, 6333, 3071, 0, 3340], spells: [4, 12], keystone: 8010, sub: 8400,
  role: 'top', opp: 'Jax',
  lp: { delta: 22, tier: 'EMERALD', division: 'II', lp: 67, changedTier: false },
};

module.exports = { createPostGameWatch };
