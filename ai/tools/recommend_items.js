// Boots and defensive items against the enemy team: how much physical vs magic
// damage they have, how many tanks, auto-attackers, healers and heavy-CC champions,
// then a short list of items that fit my champion's class. Item names are checked
// against the current patch (Data Dragon), so removed items never show up.
const data = require('../data.js');

// Champions whose healing makes anti-heal worth it (not exhaustive).
const lc = (a) => new Set(a.map((x) => x.toLowerCase()));
const HEALERS = lc(['Aatrox', 'Soraka', 'Vladimir', 'Sylas', 'Yuumi', 'Warwick', 'DrMundo', 'Fiddlesticks', 'Nami', 'Sona', 'Briar', 'Swain', 'Illaoi', 'Olaf', 'Volibear', 'Trundle', 'Kayn', 'Irelia', 'Samira', 'Seraphine', 'Renata', 'Milio', 'Senna', 'Gwen', 'Belveth', 'Nasus', 'Aphelios', 'Zac', 'Maokai', 'Yorick', 'Mordekaiser', 'Ksante', 'Darius', 'Viego', 'Lillia', 'Taric']);
// Champions with a lot of hard crowd control (not exhaustive).
const HEAVY_CC = lc(['Leona', 'Nautilus', 'Amumu', 'Sejuani', 'Maokai', 'Rell', 'Alistar', 'Thresh', 'Blitzcrank', 'Morgana', 'Lux', 'Ashe', 'Malphite', 'Ornn', 'Rakan', 'Lissandra', 'Annie', 'Veigar', 'Zac', 'Skarner', 'Vi', 'Jax', 'Warwick', 'Poppy', 'Sion', 'Galio', 'Twistedfate', 'Pyke', 'Braum', 'Taric', 'Zyra', 'Neeko', 'Nami', 'Seraphine', 'Vex', 'Syndra', 'Leblanc', 'Ahri', 'Ksante', 'Volibear', 'Nunu', 'Rammus', 'Jarvaniv', 'Leesin', 'Wukong', 'Diana', 'Kennen', 'Fiddlesticks', 'Hecarim', 'Rengar', 'Ekko']);

const POOLS = {
  tank: { ad: ["Randuin's Omen", 'Thornmail', 'Frozen Heart', "Dead Man's Plate"], ap: ['Force of Nature', 'Spirit Visage', 'Kaenic Rookern', "Jak'Sho, The Protean"], heal: ['Thornmail'] },
  fighter: { ad: ["Death's Dance", "Sterak's Gage", "Randuin's Omen", 'Thornmail'], ap: ['Maw of Malmortius', 'Spirit Visage', 'Force of Nature', 'Kaenic Rookern'], heal: ['Chempunk Chainsword', 'Thornmail'] },
  marksman: { ad: ['Guardian Angel', "Death's Dance", 'Phantom Dancer'], ap: ['Maw of Malmortius', 'Mercurial Scimitar', 'Wit\'s End'], heal: ['Mortal Reminder'] },
  assassin: { ad: ['Guardian Angel', "Death's Dance", 'Edge of Night'], ap: ['Maw of Malmortius', 'Edge of Night'], heal: ['Chempunk Chainsword'] },
  mage: { ad: ["Zhonya's Hourglass", "Seraph's Embrace"], ap: ["Banshee's Veil", 'Abyssal Mask'], heal: ['Morellonomicon'] },
  support: { ad: ['Locket of the Iron Solari', "Knight's Vow", 'Zeke\'s Convergence'], ap: ['Locket of the Iron Solari', "Mikael's Blessing"], heal: ['Chemtech Putrifier'] },
};

function classOf(c) {
  const t = c?.tags || [];
  if (t[0] === 'Tank' || (t.includes('Tank') && !t.includes('Mage'))) return 'tank';
  if (t[0] === 'Support') return 'support';
  if (t[0] === 'Marksman') return 'marksman';
  if (t[0] === 'Assassin') return (c.info?.magic || 0) > (c.info?.attack || 0) ? 'mage' : 'assassin';
  if (t[0] === 'Mage') return 'mage';
  return 'fighter';
}

module.exports = {
  name: 'recommend_items',
  description: "Recommend boots and defensive items against the enemy team composition (physical vs magic damage, tanks, auto-attackers, healing, crowd control). Uses the current game's enemies and my champion unless they are given.",
  parameters: {
    type: 'object',
    properties: {
      myChampion: { type: 'string', description: 'My champion (default: the one I am playing)' },
      enemies: { type: 'array', items: { type: 'string' }, description: 'Enemy champions (default: the current game)' },
    },
    required: [],
  },
  async run(args, ctx) {
    let enemies = Array.isArray(args?.enemies) ? args.enemies.filter(Boolean) : [];
    let mine = args?.myChampion || '';
    if (!enemies.length || !mine) {
      const g = await data.gamePlayers(ctx);
      if (!enemies.length) enemies = (g?.enemies || []).map((p) => p.champ).filter(Boolean);
      if (!mine) mine = g?.me?.champ || '';
    }
    if (!enemies.length) return { error: 'No enemy champions known yet. Ask again in a game, or name the enemy champions.' };
    const d = await data.dd();
    const champs = (await Promise.all(enemies.map((e) => data.champion(e)))).filter(Boolean);
    let ad = 0, ap = 0;
    const out = { enemies: [], physicalDamage: 0, magicDamage: 0, tanks: [], autoAttackers: [], healers: [], heavyCC: [] };
    for (const c of champs) {
      const a = c.info?.attack || 0, m = c.info?.magic || 0;
      const type = m >= a + 2 ? 'magic' : a >= m + 2 ? 'physical' : 'mixed';
      if (type === 'physical') ad += 1; else if (type === 'magic') ap += 1; else { ad += 0.5; ap += 0.5; }
      out.enemies.push(`${c.name} (${type}, ${c.tags.join('/')})`);
      if (c.tags.includes('Tank')) out.tanks.push(c.name);
      if (c.tags[0] === 'Marksman') out.autoAttackers.push(c.name);
      if (HEALERS.has(data.norm(c.id))) out.healers.push(c.name);
      if (HEAVY_CC.has(data.norm(c.id))) out.heavyCC.push(c.name);
    }
    out.physicalDamage = `${Math.round((ad / Math.max(1, ad + ap)) * 100)}%`;
    out.magicDamage = `${Math.round((ap / Math.max(1, ad + ap)) * 100)}%`;

    const me = mine ? await data.champion(mine) : null;
    const cls = classOf(me);
    out.myChampion = me ? `${me.name} (${cls})` : 'unknown (defaulting to fighter items)';

    // Boots
    let boots, why;
    if (cls === 'marksman' && ad < 3) { boots = "Berserker's Greaves"; why = 'attack speed boots, the enemy damage is not heavy enough to need defensive boots'; }
    else if (out.heavyCC.length >= 3 && ap >= ad) { boots = "Mercury's Treads"; why = `${out.heavyCC.length} heavy crowd-control champions and mostly magic damage`; }
    else if (ad >= 3 || out.autoAttackers.length >= 2) { boots = 'Plated Steelcaps'; why = `${out.physicalDamage} physical damage${out.autoAttackers.length ? `, auto-attackers: ${out.autoAttackers.join(', ')}` : ''}`; }
    else if (ap >= 3 || out.heavyCC.length >= 3) { boots = "Mercury's Treads"; why = `${out.magicDamage} magic damage${out.heavyCC.length ? `, crowd control from ${out.heavyCC.join(', ')}` : ''}`; }
    else if (cls === 'mage') { boots = "Sorcerer's Shoes"; why = 'mixed enemy damage, so damage boots'; }
    else { boots = 'Plated Steelcaps or Mercury\'s Treads'; why = 'mixed damage: pick by the lane opponent or whoever is fed'; }
    out.boots = { pick: boots, why };

    // Defensive items that exist this patch
    const pool = POOLS[cls];
    const want = [...(ad >= ap ? pool.ad : pool.ap), ...(ad >= ap ? pool.ap.slice(0, 1) : pool.ad.slice(0, 1)), ...(out.healers.length >= 2 ? pool.heal : [])];
    const items = [];
    for (const n of [...new Set(want)]) {
      const it = await data.itemByName(n);
      if (it) items.push({ name: it.name, gold: it.gold, what: it.plaintext || undefined });
    }
    out.defensiveItems = items;
    out.note = `Patch ${d.ver}. Rough estimate from champion classes; lane matchup and who is fed matter more.`;
    return out;
  },
};
