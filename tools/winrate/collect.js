// Training data for the live win chance model (winprob.js).
//
// Walks deeplol: starts from one account's match list, then the players met in
// those matches, and saves each Summoner's Rift match (ranked / normal draft) as
// it comes from deeplol's match-cached endpoint. Slow on purpose (one request
// at a time with a pause) to keep the load on deeplol light.
//
//   node tools/winrate/collect.js <Name#TAG> [platform=TR1] [matches=300]
//
// Output: tools/winrate/data/<matchId>.json (git-ignored).
const fs = require('fs');
const path = require('path');

const DL = 'https://b2c-api-cdn.deeplol.gg';
const OUT = path.join(__dirname, 'data');
const SR = new Set([420, 440, 400, 430, 490]);
const PAUSE = 700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(15000) });
      if (r.ok) return await r.json();
    } catch {}
    await sleep(2000);
  }
  return null;
}

(async () => {
  const [riotId, platformArg, nArg] = process.argv.slice(2);
  if (!riotId || !riotId.includes('#')) { console.log('usage: node collect.js Name#TAG [TR1] [300]'); process.exit(1); }
  const platform = (platformArg || 'TR1').toUpperCase();
  const want = Number(nArg) || 300;
  fs.mkdirSync(OUT, { recursive: true });
  const [name, tag] = riotId.split('#');
  const prof = await get(`${DL}/summoner/summoner?riot_id_name=${encodeURIComponent(name)}&riot_id_tag_line=${encodeURIComponent(tag)}&platform_id=${platform}`);
  const start = prof?.summoner_basic_info_dict?.puu_id;
  if (!start) { console.log('account not found'); process.exit(1); }
  const players = [start];
  const seenPlayers = new Set(players);
  const seenMatches = new Set(fs.readdirSync(OUT).map((f) => f.replace(/\.json$/, '')));
  let saved = 0;
  while (players.length && saved < want) {
    const puu = players.shift();
    await sleep(PAUSE);
    const ml = await get(`${DL}/match/matches?puu_id=${encodeURIComponent(puu)}&platform_id=${platform}&offset=0&count=20&queue_type=ALL&champion_id=-1&only_list=1&last_updated_at=1`);
    for (const x of (ml?.match_id_list || []).slice(0, 8)) {
      if (saved >= want) break;
      if (seenMatches.has(x.match_id)) continue;
      seenMatches.add(x.match_id);
      await sleep(PAUSE);
      const m = await get(`${DL}/match/match-cached?match_id=${x.match_id}&platform_id=${platform}`);
      const q = m?.match_basic_dict?.queue_id;
      if (!m || !SR.has(q) || !m.time_analysis?.concat_events_dict || (m.match_basic_dict.game_duration || 0) < 900) continue;
      fs.writeFileSync(path.join(OUT, `${x.match_id}.json`), JSON.stringify(m));
      saved++;
      if (saved % 10 === 0) console.log(`saved ${saved}/${want}`);
      for (const p of m.participants_list || []) if (p.puu_id && !seenPlayers.has(p.puu_id) && players.length < 400) { seenPlayers.add(p.puu_id); players.push(p.puu_id); }
    }
  }
  console.log(`done: ${saved} new matches in ${OUT}`);
})();
