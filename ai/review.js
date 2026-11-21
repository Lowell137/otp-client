// Game review: the timeline of a finished Summoner's Rift game (deeplol match-cached:
// every kill with killer, assists, map position and deeplol's win-chance change,
// objectives, towers, per-minute scores) turned into facts about ONE player's
// game. Pure functions, no network: the tool (tools/game_review.js) feeds them.
// Only facts that the data shows. The model writes the advice from `findings`.

const ROLE_KEY = { Top: 'Top', Jungle: 'Jun', Middle: 'Mid', Bot: 'Bot', Supporter: 'Sup' };
const ROLE_LABEL = { Top: 'top', Jun: 'jungle', Mid: 'mid', Bot: 'bot', Sup: 'support' };
const LANE_OF = { Top: 'top', Mid: 'mid', Bot: 'bot', Sup: 'bot' };
const MAP_W = 14870, MAP_H = 14881;

const slotOf = (p) => (p.side === 'BLUE' ? 'B_' : 'R_') + (ROLE_KEY[p.position] || '?');
const clock = (t) => { const s = Math.max(0, Math.round(t * 60)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const r1 = (n) => Math.round(n * 10) / 10;
const pp = (n) => `${n > 0 ? '+' : ''}${r1(n)} pp`;

// Where on the map, from the player's side. Lanes are the three roads; the river
// runs corner to corner; everything else is jungle of one half or the other.
function zone(x, y, side, myLane) {
  const u = x / MAP_W, v = y / MAP_H;
  const mine = side === 'BLUE' ? u + v < 1 : u + v > 1;
  const dBlue = Math.hypot(u - 0.04, v - 0.04), dRed = Math.hypot(u - 0.96, v - 0.96);
  if (dBlue < 0.19 || dRed < 0.19) return { label: (dBlue < 0.19) === (side === 'BLUE') ? 'your base' : 'enemy base', enemyHalf: !((dBlue < 0.19) === (side === 'BLUE')), lane: null };
  const top = (u < 0.16 && v > 0.15) || (v > 0.84 && u < 0.85);
  const bot = (v < 0.16 && u > 0.15) || (u > 0.84 && v < 0.85);
  const mid = Math.abs(v - u) < 0.08 && u > 0.15 && u < 0.85;
  const lane = top ? 'top' : bot ? 'bot' : mid ? 'mid' : null;
  if (lane) {
    const own = lane === myLane;
    return { label: own ? (mine ? 'your lane, your side' : 'your lane, enemy side') : `${mine ? 'your' : 'enemy'} ${lane} lane`, enemyHalf: !mine, lane };
  }
  if (Math.abs(u + v - 1) < 0.1) return { label: 'river', enemyHalf: false, lane: null };
  return { label: mine ? 'your jungle' : 'enemy jungle', enemyHalf: !mine, lane: null };
}

function objName(e) {
  const t = String(e.target || '');
  if (e.type === 'Tower') return /INHIBITOR/.test(t) ? 'an inhibitor' : /NEXUS/.test(t) ? 'a nexus tower' : 'a tower';
  if (/BARON/.test(t)) return 'Baron';
  if (/ELDER/.test(t)) return 'the Elder Dragon';
  if (/DRAGON/.test(t)) return 'a dragon';
  if (t === 'HORDE') return 'Void Grubs';
  if (t === 'RIFTHERALD') return 'the Herald';
  if (/ATAKHAN/.test(t)) return 'Atakhan';
  return null;
}

function eventsOf(det) {
  const out = [];
  const ce = det?.time_analysis?.concat_events_dict || {};
  for (const minute of Object.keys(ce)) {
    for (const x of Object.values(ce[minute] || {})) {
      if (x && x.event && typeof x.event.timestamp === 'number') out.push({ ...x, t: x.event.timestamp / 60000, e: x.event });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// det: deeplol match-cached JSON; puu: the player; champ(id) -> champion name.
function review(det, puu, champ = (id) => `#${id}`) {
  const parts = det?.participants_list || [];
  const meP = parts.find((p) => p.puu_id === puu);
  if (!meP) return { error: 'That player is not in this game.' };
  const slots = {};
  for (const p of parts) slots[slotOf(p)] = p;
  if (parts.length !== 10 || Object.keys(slots).length !== 10 || Object.keys(slots).some((k) => k.endsWith('?'))) {
    return { error: 'Reviews work for Summoner\'s Rift games with five roles per team (not ARAM, Arena or Mayhem).' };
  }
  const evs = eventsOf(det);
  if (!evs.length) return { error: 'deeplol has no event timeline for this game yet (too old or still processing).' };

  const my = slotOf(meP), side = meP.side, sign = side === 'BLUE' ? 1 : -1;
  const role = my.slice(2), lane = LANE_OF[role] || null;
  const opp = (side === 'BLUE' ? 'R_' : 'B_') + role;
  const ally = (s) => s.startsWith(side === 'BLUE' ? 'B_' : 'R_');
  const nameOf = (s) => (s === my ? 'you' : slots[s] ? `${ally(s) ? 'ally' : 'enemy'} ${champ(slots[s].champion_id)}` : String(s));
  const champOf = (s) => (slots[s] ? champ(slots[s].champion_id) : String(s));
  const mins = (det.match_basic_dict?.game_duration || 0) / 60;
  const won = !!meP.is_win;

  // Team win chance (deeplol's estimate) before / after each event, from my side.
  const wAfter = (x) => 50 + sign * x.win_rate;
  const wBefore = (x) => 50 + sign * (x.win_rate - x.win_rate_delta);
  const dMine = (x) => sign * x.win_rate_delta;
  const mineTeam = (e) => e.side === side;

  // Fights: kills closer than 25 s to each other.
  const fights = [];
  for (const x of evs.filter((k) => k.e.type === 'Champion')) {
    const last = fights[fights.length - 1];
    if (last && x.t - last.end <= 25 / 60) { last.ev.push(x); last.end = x.t; } else fights.push({ start: x.t, end: x.t, ev: [x] });
  }
  for (const f of fights) { f.mine = f.ev.filter((k) => mineTeam(k.e)).length; f.theirs = f.ev.length - f.mine; }
  const inFight = (f) => f.ev.some((k) => k.e.killer === my || k.e.target === my || (k.e.assists || []).includes(my));

  const enemyObjs = evs.filter((x) => (x.e.type === 'Monster' || x.e.type === 'Tower') && x.e.side && !mineTeam(x.e) && objName(x.e));
  const teamObjs = evs.filter((x) => (x.e.type === 'Monster' || x.e.type === 'Tower') && mineTeam(x.e) && objName(x.e));

  // ---- My deaths ----
  const deaths = [];
  for (const x of evs) {
    if (x.e.type !== 'Champion' || x.e.target !== my) continue;
    const f = fights.find((q) => q.ev.includes(x));
    const z = x.e.coordinates ? zone(x.e.coordinates.x, x.e.coordinates.y, side, lane) : { label: 'unknown', enemyHalf: false };
    const involved = 1 + (x.e.assists || []).length;
    const cost = enemyObjs.find((o) => o.t > x.t && o.t - x.t <= 1.25);
    deaths.push({
      t: x.t, time: clock(x.t), zone: z.label, enemyHalf: z.enemyHalf, by: champOf(x.e.killer), involved,
      lvl: x.level ? [x.level[my], x.level[x.e.killer]] : null,
      before: r1(wBefore(x)), delta: r1(dMine(x)), mine: typeof x[my] === 'number' ? r1(x[my]) : null,
      first: f ? f.ev[0] === x && f.ev.length >= 2 : false,
      alone: f ? f.ev.length === 1 : true,
      fightLost: f ? f.theirs > f.mine : false,
      cost: cost ? `${clock(cost.t)} enemy took ${objName(cost.e)}` : null,
    });
  }
  const deathLine = (d) => `${d.time} · ${d.zone} · killed by ${d.by}${d.involved > 1 ? ` +${d.involved - 1}` : ''}${d.lvl && d.lvl[0] != null ? ` · lvl ${d.lvl[0]} vs ${d.lvl[1]}` : ''} · team ${d.before}% → ${r1(d.before + d.delta)}%${d.cost ? ` · ${d.cost}` : ''}`;

  // ---- Win chance curve ----
  const curve = evs.filter((x) => typeof x.win_rate === 'number').map((x) => ({ t: x.t, w: wAfter(x), x }));
  const peak = curve.reduce((a, b) => (b.w > a.w ? b : a), { w: 50, t: 0 });
  const low = curve.reduce((a, b) => (b.w < a.w ? b : a), { w: 50, t: 0 });
  const describe = (x) => {
    const e = x.e;
    if (e.type === 'Champion') return `${nameOf(e.killer)} killed ${nameOf(e.target)}${(e.assists || []).length ? ` (+${e.assists.length})` : ''}`;
    const o = objName(e);
    return `${mineTeam(e) ? 'your team' : 'the enemy'} took ${o || String(e.target)}`;
  };
  const involvesMe = (e) => e.killer === my || e.target === my || (e.assists || []).includes(my);
  const swing = (arr) => arr.map((x) => `${clock(x.t)} ${describe(x)} (${pp(dMine(x))}${involvesMe(x.e) ? ', you were in it' : ''})`);
  const worst = [...evs].filter((x) => typeof x.win_rate_delta === 'number').sort((a, b) => dMine(a) - dMine(b)).slice(0, 3).filter((x) => dMine(x) <= -2.5);
  const best = [...evs].filter((x) => typeof x[my] === 'number' && x[my] > 0).sort((a, b) => b[my] - a[my]).slice(0, 3);

  // ---- My impact on win chance (deeplol attributes each event's change to the players in it) ----
  const impact = { deaths: 0, kills: 0, assists: 0, objectives: 0 };
  for (const x of evs) {
    const v = x[my];
    if (typeof v !== 'number' || !v) continue;
    if (x.e.target === my && x.e.type === 'Champion') impact.deaths += v;
    else if (x.e.killer === my && x.e.type === 'Champion') impact.kills += v;
    else if ((x.e.assists || []).includes(my) && x.e.type === 'Champion') impact.assists += v;
    else impact.objectives += v;
  }

  // ---- Per-minute score against the lane opponent ----
  const seq = det.time_analysis?.concat_seq_dict || {};
  const scoreAt = (m, s) => { for (let i = m; i >= 0; i--) { const v = seq[String(i)]?.[s]; if (typeof v === 'number') return v; } return null; };
  const lanePts = [10, 15, 20, 25].filter((m) => m < mins - 1).map((m) => {
    const a = scoreAt(m, my), b = scoreAt(m, opp);
    return a != null && b != null ? { m, me: r1(a), opp: r1(b), diff: r1(a - b) } : null;
  }).filter(Boolean);
  let drop = null;
  const lastMin = Math.min(Math.floor(mins), Math.max(0, ...Object.keys(seq).map(Number)));
  for (let m = 3; m + 3 <= lastMin; m++) {
    const a = scoreAt(m, my), b = scoreAt(m + 3, my);
    if (a != null && b != null && (!drop || a - b > drop.by)) drop = { from: m, to: m + 3, by: r1(a - b), a: r1(a), b: r1(b) };
  }

  // ---- Fights I was not part of (kill, assist or death) ----
  const big = fights.filter((f) => f.ev.length >= 3);
  const missed = big.filter((f) => !inFight(f));
  const myFights = big.filter(inFight);

  // ---- Objectives I was part of ----
  const myObjs = teamObjs.filter((x) => involvesMe(x.e));

  // ---- Shopping gaps ----
  const buyMins = [...new Set((meP.item_seq_list || []).filter((e) => e.type === 'ITEM_PURCHASED').map((e) => e.minute))].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < buyMins.length; i++) if (buyMins[i] - buyMins[i - 1] >= 9 && buyMins[i - 1] >= 2) gaps.push(`${buyMins[i - 1]}–${buyMins[i]} min`);

  // ---- Vision and damage against the lane opponent and the team ----
  const fsOf = (p) => p.final_stat_dict || {};
  const perMin = (n) => (mins ? r1((n || 0) / mins) : 0);
  const vis = (p) => ({ placed: fsOf(p).wards_placed || 0, bought: fsOf(p).vision_wards_bought || 0, cleared: fsOf(p).wards_killed || 0, perMin: perMin(fsOf(p).wards_placed) });
  const team = parts.filter((p) => p.side === side);
  const teamDmg = team.reduce((a, p) => a + (p.total_damage_dealt_to_champion || 0), 0) || 1;
  const dmgShare = Math.round(((meP.total_damage_dealt_to_champion || 0) / teamDmg) * 100);
  const dmgRank = [...team].sort((a, b) => (b.total_damage_dealt_to_champion || 0) - (a.total_damage_dealt_to_champion || 0)).findIndex((p) => p === meP) + 1;
  const oppP = slots[opp];

  // ---- Findings: only what the numbers show, biggest first ----
  const F = [];
  const tot = deaths.length;
  const cost = deaths.reduce((a, d) => a + d.delta, 0);
  if (tot) F.push({ w: 1000, text: `You died ${tot} time${tot > 1 ? 's' : ''}; together they cost your team about ${r1(Math.abs(cost))} pp of win chance (deeplol's estimate).` });
  const over = deaths.filter((d) => d.enemyHalf && !/base/.test(d.zone) || /enemy base/.test(d.zone));
  if (over.length >= 2) F.push({ w: over.reduce((a, d) => a + Math.abs(d.delta), 0), text: `${over.length} of ${tot} deaths were on the enemy side of the map (${over.map((d) => `${d.time} ${d.zone}`).join('; ')}).` });
  // Early deaths in your own lane are lane trades, counted under 'before minute 10', not 'caught alone'.
  const alone = deaths.filter((d) => d.alone && !(d.t < 10 && /^your lane/.test(d.zone)));
  if (alone.length >= 2) F.push({ w: alone.reduce((a, d) => a + Math.abs(d.delta), 0), text: `${alone.length} deaths came with no fight around them, nobody on your team got a kill or died within 25 s (${alone.map((d) => `${d.time} to ${d.by}${d.involved > 1 ? ` +${d.involved - 1}` : ''}`).join('; ')}): caught alone / picked off.` });
  const firsts = deaths.filter((d) => d.first && d.fightLost);
  if (firsts.length) F.push({ w: firsts.reduce((a, d) => a + Math.abs(d.delta), 0), text: `You were the first to die in ${firsts.length} fight${firsts.length > 1 ? 's' : ''} your team then lost (${firsts.map((d) => d.time).join(', ')}).` });
  const ahead = deaths.filter((d) => d.before >= 58);
  if (ahead.length) F.push({ w: ahead.reduce((a, d) => a + Math.abs(d.delta), 0) + 1, text: `You died while your team was clearly ahead (${ahead.map((d) => `${d.time} at ${d.before}%`).join('; ')}).` });
  const costly = deaths.filter((d) => d.cost);
  if (costly.length) F.push({ w: costly.length * 3, text: `${costly.length} death${costly.length > 1 ? 's were' : ' was'} followed within 75 s by an enemy objective (${costly.map((d) => `${d.time} → ${d.cost.replace(/^\S+ /, '')}`).join('; ')}).` });
  const early = deaths.filter((d) => d.t < 10);
  if (early.length >= 2) F.push({ w: 4, text: `${early.length} deaths before minute 10 (${early.map((d) => `${d.time} ${d.zone}`).join('; ')}).` });
  const lane10 = lanePts.find((p) => p.m === 10);
  if (lane10 && lane10.diff <= -8 && oppP) F.push({ w: 4, text: `At 10 minutes deeplol rated you ${Math.abs(lane10.diff)} points below your lane opponent (${champOf(opp)}).` });
  if (peak.w >= 62 && !won) F.push({ w: 6, text: `You had a lead and lost: team win chance peaked at ${Math.round(peak.w)}% at ${clock(peak.t)}, the game ended in a loss.` });
  if (worst.length) F.push({ w: Math.abs(dMine(worst[0])), text: `Biggest swings against your team: ${swing(worst).join('; ')}.` });
  if (teamObjs.length >= 4 && myObjs.length / teamObjs.length < 0.4) F.push({ w: 3, text: `You were part of ${myObjs.length} of your team's ${teamObjs.length} objectives (towers, dragons, Herald, Baron).` });
  if (big.length >= 3 && missed.length / big.length >= 0.5) F.push({ w: 3, text: `${missed.length} of ${big.length} big fights (3+ kills) had no kill, assist or death from you (${missed.map((f) => clock(f.start)).join(', ')}).` });
  if (gaps.length) F.push({ w: 1.5, text: `Long stretches without shopping: ${gaps.join(', ')} (9+ minutes each).` });
  if ((role === 'Sup' || role === 'Jun') && oppP) {
    const a = vis(meP), b = vis(oppP);
    if (b.placed && a.placed < b.placed * 0.65) F.push({ w: 2, text: `Vision: ${a.placed} wards placed (${a.perMin}/min) vs ${b.placed} (${b.perMin}/min) for your lane opponent ${champOf(opp)}.` });
  }
  F.sort((a, b) => b.w - a.w);

  const strengths = [];
  if (best.length) strengths.push(`Best moments by win chance: ${best.map((x) => `${clock(x.t)} ${describe(x)} (${pp(x[my])})`).join('; ')}.`);
  if (impact.kills + impact.assists + impact.objectives > 0) strengths.push(`Your kills, assists and objectives added about ${r1(impact.kills + impact.assists + impact.objectives)} pp; your deaths took ${r1(Math.abs(impact.deaths))} pp.`);
  if (myObjs.length) strengths.push(`Part of ${myObjs.length} of ${teamObjs.length} team objectives.`);
  if (dmgRank === 1 && dmgShare >= 28) strengths.push(`Top damage on your team (${dmgShare}%).`);

  return {
    game: { minutes: Math.round(mins), result: won ? 'win' : 'loss', queueId: det.match_basic_dict?.queue_id, patch: det.match_basic_dict?.game_version, avgRank: [det.match_basic_dict?.avg_tier, det.match_basic_dict?.avg_division].filter(Boolean).join(' ') || undefined },
    you: {
      champion: champOf(my), role: ROLE_LABEL[role], kda: `${fsOf(meP).kills}/${fsOf(meP).deaths}/${fsOf(meP).assists}`, cs: fsOf(meP).cs, csPerMin: fsOf(meP).cspm,
      deeplolScore: fsOf(meP).ai_score, scoreRankInGame: fsOf(meP).ai_score_rank, damageShare: `${dmgShare}% of team (#${dmgRank})`,
      wards: vis(meP), laneOpponent: oppP ? `${champOf(opp)} ${fsOf(oppP).kills}/${fsOf(oppP).deaths}/${fsOf(oppP).assists}, score ${fsOf(oppP).ai_score}, cs ${fsOf(oppP).cs}, wards ${vis(oppP).placed}` : undefined,
    },
    findings: F.map((f) => f.text),
    strengths,
    deaths: deaths.slice(0, 12).map(deathLine),
    winChance: {
      peak: `${Math.round(peak.w)}% at ${clock(peak.t)}`, lowest: `${Math.round(low.w)}% at ${clock(low.t)}`,
      atMinutes: [10, 15, 20, 25].filter((m) => m < mins - 1).map((m) => { const p = [...curve].reverse().find((c) => c.t <= m); return p ? `${m}m ${Math.round(p.w)}%` : null; }).filter(Boolean).join(', '),
    },
    laneVsOpponent: lanePts.map((p) => `${p.m}m: you ${p.me} vs ${p.opp} (${p.diff > 0 ? '+' : ''}${p.diff})`),
    biggestScoreDrop: drop && drop.by >= 4 ? `Your score fell ${drop.by} points between minute ${drop.from} and ${drop.to} (${drop.a} → ${drop.b}).` : undefined,
    fights: myFights.slice(0, 5).map((f) => `${clock(f.start)} · ${f.ev.length} kills · your team ${f.mine}–${f.theirs}${f.ev[0].e.target === my ? ' · you died first' : ''}`),
    impactOnWinChance: { fromDeaths: r1(impact.deaths), fromKills: r1(impact.kills), fromAssists: r1(impact.assists), fromObjectives: r1(impact.objectives) },
    note: 'Win chance numbers are deeplol\'s model (pp = percentage points). "Score" is deeplol\'s 0-100 performance rating. Positions are from event coordinates.',
  };
}

module.exports = { review, zone, slotOf, eventsOf };
