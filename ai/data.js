// Shared lookups for the assistant's tools: Data Dragon champions/items, region
// names, Riot IDs, players in the current game, deeplol profiles (cached).

let ddCache = null; // { ver, champs: { id -> {id,name,tags,info,title} }, items: { id -> {name,...} } }

async function dd() {
  if (ddCache && Date.now() - ddCache.ts < 6 * 3600 * 1000) return ddCache;
  const ver = (await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json())[0];
  const base = `https://ddragon.leagueoflegends.com/cdn/${ver}`;
  const [cj, ij] = await Promise.all([
    fetch(`${base}/data/en_US/champion.json`).then((r) => r.json()),
    fetch(`${base}/data/en_US/item.json`).then((r) => r.json()),
  ]);
  const champs = {};
  for (const c of Object.values(cj.data)) champs[c.id] = { id: c.id, key: Number(c.key), name: c.name, title: c.title, tags: c.tags, info: c.info, partype: c.partype };
  const items = {};
  for (const [id, it] of Object.entries(ij.data)) {
    if (it.maps && it.maps['11'] === false) continue; // Summoner's Rift items only
    items[id] = { id: Number(id), name: it.name, gold: it.gold?.total || 0, tags: it.tags || [], plaintext: it.plaintext || '' };
  }
  ddCache = { ts: Date.now(), ver, base, champs, items };
  return ddCache;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// "ezreal", "Kai'Sa", "lee sin", "wukong" -> Data Dragon champion.
async function champion(name) {
  const d = await dd();
  const n = norm(name);
  if (!n) return null;
  const all = Object.values(d.champs);
  return all.find((c) => norm(c.id) === n || norm(c.name) === n)
    || all.find((c) => norm(c.name).startsWith(n) || norm(c.id).startsWith(n))
    || null;
}

async function itemByName(name) {
  const d = await dd();
  const n = norm(name);
  return Object.values(d.items).find((i) => norm(i.name) === n) || null;
}

const REGIONS = {
  tr: 'tr1', tr1: 'tr1', euw: 'euw1', euw1: 'euw1', eune: 'eun1', eun1: 'eun1', na: 'na1', na1: 'na1',
  kr: 'kr', br: 'br1', br1: 'br1', lan: 'la1', la1: 'la1', las: 'la2', la2: 'la2', oce: 'oc1', oc1: 'oc1',
  jp: 'jp1', jp1: 'jp1', ru: 'ru', me: 'me1', me1: 'me1', sg: 'sg2', sg2: 'sg2', tw: 'tw2', tw2: 'tw2', vn: 'vn2', vn2: 'vn2',
};
async function region(ctx, r) {
  if (r && REGIONS[norm(r)]) return REGIONS[norm(r)];
  try { const a = await ctx.call('otp:my-account'); if (a?.region) return a.region; } catch {}
  return 'tr1';
}

function parseRiotId(s) {
  const m = String(s || '').trim().match(/^(.+?)\s*#\s*([^\s#]+)$/);
  return m ? { name: m[1].trim(), tag: m[2].trim() } : null;
}

// Players of the current game (champ select or in game), from the lobby watcher;
// in game, falls back to the Live Client API (names, teams, positions).
async function gamePlayers(ctx) {
  const lob = ctx.getLobby();
  if (lob && (lob.allies?.length || lob.enemies?.length)) {
    return { phase: lob.phase, me: lob.me, allies: lob.allies || [], enemies: lob.enemies || [] };
  }
  try {
    const list = await ctx.liveGet('/liveclientdata/playerlist');
    const meName = await ctx.liveGet('/liveclientdata/activeplayername').catch(() => '');
    const all = (list || []).map((p) => {
      const [name, tag] = String(p.riotId || p.summonerName || '').split('#');
      return { name, tag: tag || '', champ: (p.rawChampionName || '').replace('game_character_displayname_', '') || p.championName, role: String(p.position || '').toLowerCase(), team: p.team, me: (p.riotId || p.summonerName) === meName };
    });
    const mine = all.find((p) => p.me)?.team;
    return { phase: 'InGame', me: all.find((p) => p.me) || {}, allies: all.filter((p) => p.team === mine), enemies: all.filter((p) => p.team !== mine) };
  } catch {}
  return null;
}

// Champion name -> that player in the current game.
async function playerByChampion(ctx, champName) {
  const g = await gamePlayers(ctx);
  if (!g) return { error: 'No game or champion select right now, so there is no player on that champion.' };
  const c = await champion(champName);
  const want = norm(c ? c.id : champName);
  const wantName = norm(c ? c.name : champName);
  const p = [...g.enemies, ...g.allies].find((x) => norm(x.champ) === want || norm(x.champ) === wantName);
  if (!p) return { error: `Nobody is playing ${champName} in the current game.` };
  if (p.hidden || !p.name) return { error: `The ${champName} player's name is hidden (ranked champion select). It shows once the game is loading.` };
  return { player: p };
}

// deeplol profile, cached 5 minutes per account.
const profCache = new Map();
async function profile(ctx, name, tag, platform) {
  const k = `${platform}|${name}#${tag}`.toLowerCase();
  const hit = profCache.get(k);
  if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return hit.v;
  const res = await ctx.call('otp:deeplol', { region: platform, gameName: name, tagLine: tag });
  if (res?.ok) profCache.set(k, { ts: Date.now(), v: res });
  return res;
}

// Resolve {riotId | champion, region} to a deeplol profile.
async function resolvePlayer(ctx, args) {
  let who = parseRiotId(args.riotId);
  if (!who && args.champion) {
    const r = await playerByChampion(ctx, args.champion);
    if (r.error) return { error: r.error };
    who = { name: r.player.name, tag: r.player.tag };
  }
  if (!who && args.riotId) return { error: 'Riot ID must look like Name#TAG.' };
  // No player named: the user themself (account logged in to the League client).
  let myRegion = '';
  if (!who) {
    const acc = await ctx.call('otp:my-account').catch(() => null);
    if (acc?.name) { who = { name: acc.name, tag: acc.tag }; myRegion = acc.region || ''; }
  }
  if (!who) return { error: 'Give a Riot ID (Name#TAG) or the champion the player is on in the current game.' };
  const platform = await region(ctx, args.region || myRegion);
  const res = await profile(ctx, who.name, who.tag, platform);
  if (!res?.ok) return { error: `Could not find ${who.name}#${who.tag} on ${platform.toUpperCase()}: ${res?.error || 'unknown error'}` };
  return { res, platform, who };
}

const ago = (ts) => {
  if (!ts) return '';
  const ms = ts > 1e12 ? ts : ts * 1000;
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

module.exports = { dd, champion, itemByName, region, parseRiotId, gamePlayers, playerByChampion, profile, resolvePlayer, ago, norm };
