// Personal review of one finished Summoner's Rift game: the player's own mistakes
// and good moments, from deeplol's event timeline (every kill with killer, assists
// and map position, objectives, win chance per event). Analysis in ai/review.js.
// Default: my newest game on the account logged in to the League client.
const data = require('../data.js');
const { review } = require('../review.js');

const QUEUES = { 420: 'Ranked Solo', 440: 'Ranked Flex', 400: 'Normal Draft', 430: 'Normal Blind', 490: 'Quickplay', 450: 'ARAM', 1700: 'Arena', 2400: 'ARAM Mayhem', 1900: 'URF' };

module.exports = {
  name: 'game_review',
  description: "Personal review of a finished game: MY mistakes and good moments with times and places. Every death (when, where on the map, who killed me, how many enemies, what the enemy took right after), deaths while ahead, first deaths in lost fights, lane against the opponent, win-chance curve and the turning point, objectives and big fights I missed, shopping gaps, vision. Use for 'what mistakes did I make', 'review my game', 'bu maçta ne yanlış yaptım', 'hatalarımı söyle', 'bana tavsiye ver'. Combine with last_game for items. Summoner's Rift only.",
  parameters: {
    type: 'object',
    properties: {
      index: { type: 'integer', description: '0 = newest game (default), 1 = the one before, ...' },
      riotId: { type: 'string', description: 'Another player (Name#TAG). Default: me.' },
      region: { type: 'string', description: 'Server of that player. Default: my server.' },
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
    const idx = Math.max(0, Math.min(19, Number(args?.index) || 0));
    const id = res.pendingIds?.[idx]?.id;
    if (!id) return { error: 'No finished games found for that account.' };
    const t = await ctx.call('otp:deeplol-timeline', { platform, matchId: id });
    if (!t?.ok) return { error: `Could not load the game timeline from deeplol (${t?.error || 'unknown'}). Try again in a moment.` };
    const d = await data.dd();
    const byKey = {};
    for (const c of Object.values(d.champs)) byKey[c.key] = c.name;
    const out = review(t.det, res.puuid, (cid) => byKey[cid] || `champion ${cid}`);
    if (out.error) return out;
    out.game.queue = QUEUES[out.game.queueId] || out.game.queueId;
    out.game.when = data.ago(t.det?.match_basic_dict?.creation_timestamp);
    delete out.game.queueId;
    out.player = `${res.profile.name}#${res.profile.tag}`;
    return out;
  },
};
