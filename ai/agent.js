// Tool-calling loop: model -> tool calls -> results -> model ... -> answer.
// Events go to the page as they happen: { type: 'tool', name, args },
// { type: 'tool-done', name, ok }, { type: 'answer', content }, { type: 'error', message }.
const providers = require('./providers.js');
const tools = require('./tools/index.js');

const MAX_STEPS = 8;

// Who the user is and what they are doing right now, so "me", "my game", "which
// one is me" need no tool call and no guessing.
async function userContext(ctx) {
  const lines = [];
  try {
    const acc = await ctx.call('otp:my-account');
    if (acc?.name) lines.push(`The user is the League player ${acc.name}#${acc.tag} (server ${String(acc.region || '?').toUpperCase()}). In any scoreboard, screenshot or match data, the row with this name is the user ("me", "ben", "benim").`);
  } catch {}
  try {
    const lob = ctx.getLobby && ctx.getLobby();
    if (lob && lob.phase) lines.push(`Right now the user is ${lob.phase === 'InGame' ? 'in a game' : 'in champion select'}${lob.me?.champ ? ` on ${lob.me.champ}` : ''}${lob.me?.role ? ` (${lob.me.role})` : ''}.`);
    else lines.push('Right now the user is not in a game or champion select. Questions about "this game / bu maç" usually mean their last finished game: use last_game.');
  } catch {}
  return lines.join('\n');
}

function systemPrompt(who) {
  const now = new Date().toISOString().slice(0, 10);
  return [
    'You are the assistant inside OTP Client, a League of Legends companion app built around onetricks.gg.',
    `Today is ${now}.`,
    who,
    `Reply in the same language as the user's last message: a Turkish message (e.g. "naber", "hangi", "ne") gets a Turkish answer, English gets English. Be short and concrete: a few lines or a small list, no filler.`,
    'Greetings and small talk ("hi", "naber", "nasılsın", "thanks") are not questions about the game: reply warmly in one line with NO tool call and NO "could not find". Example: user "naber" -> "İyiyim, sen nasılsın? LoL hakkında ne sormak istersin?"',
    '',
    'STRICT RULES for facts about League of Legends:',
    '1. Inventing is forbidden. Never state a rank, stat, tier, win rate, build, champion role, patch change or item from memory. Your own knowledge is old; the game changes every patch.',
    '2. Always use the newest data from the tools, every time, even if you think you know.',
    '3. If no stats tool covers it, research: patch_notes (official patch notes), lol_wiki (champions, items, runes, modes, "Jinx/Patch history"), read_page (a link). Name the source and patch.',
    '4. If you still cannot find it, say so plainly. "I could not find that" beats a guess.',
    '5. Call each tool at most once per question with the same input. When you have the data, answer.',
    '6. Screenshots: read what is in the image. If it is a scoreboard, find the user by name and use last_game for the exact numbers and items.',
    '',
    'Which tool:',
    '- recommend a champion to play: suggest_pick. What is strong / meta: tier_list.',
    '- runes, items, spells, skill order for a champion: champion_build.',
    '- best teammate for a champion ("Nami yanına ne alayım"): duo_synergy.',
    '- how to play, strategy and concepts (wave management, recalls, vision, objectives, roles, trading, team fights, macro, jungle, climbing): lol_knowledge, then answer from those notes in your own words.',
    "- pro play: esports (a team's results or upcoming matches, a pro player's recent games, a league's schedule).",
    '- counters and matchups ("who counters Yasuo", "Yasuo vs Annie", "is X good against Y"): counters (win rate in the matchup, hardest and easiest opponents). For a matchup question also get champion_build for the build.',
    '- boots and defensive items against the enemy team: recommend_items.',
    '- review of a finished game ("bu maç ne almalıydım", "what went wrong", "son maçım"): last_game. Compare the items with the enemy team and the recommended build, then give 2-4 concrete points.',
    '- who is in my current game: current_game (only during champion select or a game).',
    '- a specific player: player_profile, player_matches. An enemy or ally named by champion ("the enemy Ezreal"): pass that champion.',
    'If a tool returns an error, tell the user plainly what is missing.',
    "Riot's rules: information, builds and analysis (also after a game) are fine. Do not make real-time in-game decisions for the player (when to fight, where the enemy jungler is, ability timers).",
  ].filter((l) => l !== undefined).join('\n');
}

async function run({ history, onEvent, signal, model }) {
  const provider = providers.current();
  const list = tools.all();
  const who = await userContext(module.exports.ctx).catch(() => '');
  const messages = [{ role: 'system', content: systemPrompt(who) }, ...history];
  const thoughts = [];
  const think = (t) => { if (t && t.trim()) thoughts.push(t.trim()); };
  const done = new Map(); // "tool|args" -> result: small models like to repeat the same call
  const m = model || providers.currentModel();
  const lastUser = [...history].reverse().find((x) => x.role === 'user')?.content || '';
  for (let step = 0; step < MAX_STEPS; step++) {
    const r = await provider.chat({ messages, tools: list, model: m, signal });
    think(r.thinking);
    // A game-fact question answered from memory (no tool at all): run the tool
    // that fits ourselves and make the model answer from its result.
    if (!r.toolCalls.length && step === 0 && !done.size) {
      const forced = forcedTool(lastUser);
      if (forced && tools.byName(forced.name)) {
        r.toolCalls = [{ id: `forced_${Date.now()}`, name: forced.name, args: forced.args }];
        r.content = '';
      }
    }
    if (!r.toolCalls.length) {
      const content = r.content || '(no answer)';
      onEvent({ type: 'answer', content });
      return { content, thinking: thoughts.join('\n\n'), messages: messages.slice(1) };
    }
    messages.push({ role: 'assistant', content: r.content || '', toolCalls: r.toolCalls });
    // All tool calls of one step run at the same time (like op.gg's assistant);
    // results go back in the order the model asked for them.
    let repeats = 0;
    const results = await Promise.all(r.toolCalls.map(async (tc) => {
      const key = `${tc.name}|${JSON.stringify(tc.args || {})}`;
      if (done.has(key)) {
        repeats++;
        return { note: 'You already called this with the same input; the result is above. Do not call it again: answer the user now, or use a different tool.' };
      }
      const t = tools.byName(tc.name);
      tc.args = await fillFromQuestion(tc.name, tc.args || {}, lastUser).catch(() => tc.args);
      onEvent({ type: 'tool', name: tc.name, args: tc.args });
      let result;
      try {
        result = t ? await t.run(tc.args || {}, module.exports.ctx) : { error: `Unknown tool ${tc.name}` };
      } catch (e) {
        result = { error: String(e?.message || e) };
      }
      done.set(key, result);
      onEvent({ type: 'tool-done', name: tc.name, ok: !result?.error });
      return result;
    }));
    r.toolCalls.forEach((tc, i) => messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: JSON.stringify(results[i]).slice(0, 12000) }));
    // Only repeats this round: stop looping and answer from what we have.
    if (repeats === r.toolCalls.length) break;
  }
  // Out of steps (or looping): ask once more with no tools, so it must answer.
  messages.push({ role: 'user', content: 'Answer my question now using only the tool results above. If they do not contain the answer, say what is missing.' });
  const fin = await provider.chat({ messages, tools: [], model: m, signal });
  think(fin.thinking);
  const content = fin.content || 'I could not find an answer to that.';
  onEvent({ type: 'answer', content });
  return { content, thinking: thoughts.join('\n\n'), messages: messages.slice(1) };
}

// Questions that must be answered from live data, by words (Turkish and English).
// Used only when the model called no tool at all.
const ROLE_WORDS = [['top', /\btop\b/i], ['jungle', /jungle|ormanc|\bjg\b/i], ['mid', /\bmid\b|orta/i], ['bot', /\badc\b|\bbot\b(?!lar)|bot ?lane|nişanc/i], ['support', /support|\bsup\b|destek/i]];
function forcedTool(q) {
  const t = String(q || '');
  const role = (ROLE_WORDS.find(([, re]) => re.test(t)) || [])[0];
  if (/(\bbot(u|unu|lar|ları|lari)\b|boots|savunma|defansif|defensive|karşı.*(al|item|eşya)|(item|eşya).*karşı|anti.?heal)/i.test(t)) return { name: 'recommend_items', args: {} };
  if (/(espor|esports|\blck\b|\blec\b|\blpl\b|\blcs\b|worlds|\bmsi\b|pro (oyuncu|maç|player|game)|turnuva|tournament)/i.test(t)) return { name: 'esports', args: {} };
  if (/(counter|matchup|eşleşme|\bvs\.?\b|karşı (iyi|güçlü|zayıf|zor|kolay)|(iyi|güçlü|zayıf) mı)/i.test(t)) return { name: 'counters', args: {} };
  if (/(item|eşya|build|rün|rune|starter|başlangıç|ilk .*al|ne al|alay[ıi]m|almal[ıi]|skill|yetenek sıra|spell|büyü)/i.test(t)) return { name: 'champion_build', args: {} };
  if (/((karakter|şampiyon|champ\w*).*(öner|seç)|(öner|suggest|recommend).*(karakter|şampiyon|champ|pick)|ne (oynay|seçey)|what should i (play|pick))/i.test(t)) return { name: 'suggest_pick', args: role ? { role } : {} };
  if (/(dalga|wave|freeze|dondur|recall|base.?e dön|geri dön|\bward|vision|görüş|makro|macro|team ?fight|takım savaş|split|rotasyon|rotation|gank|power spike|güç an|nasıl (oyna|kazan|carry|yüksel|gelişir)|how (do i|to) (play|win|climb|carry|improve)|tavsiye|ipucu|\btips?\b|ne yapmalıyım|what should i do)/i.test(t)) return { name: 'lol_knowledge', args: { query: t } };
  if (/(tier|meta|en güçlü|en iyi|strongest|best|op olan|güçlü)/i.test(t)) return { name: 'tier_list', args: role ? { role } : {} };
  if (/(patch|yama|nerf|buff)/i.test(t)) return { name: 'patch_notes', args: {} };
  return null;
}

// Champions named in the question, in order ("Thresh için ... karşıda Zed Jinx").
async function champsIn(text) {
  const data = require('./data.js');
  const d = await data.dd();
  const low = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9ğüşöçı' ]/gi, ' ') + ' ';
  const hits = [];
  for (const c of Object.values(d.champs)) {
    for (const n of new Set([c.name, c.id])) {
      const re = new RegExp(`[^a-z]${n.toLowerCase().replace(/[^a-z0-9]+/g, "[ '.]*")}[^a-z]`);
      const m = low.match(re);
      if (m) { hits.push({ name: c.name, at: m.index }); break; }
    }
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.name);
}

// Small models call build / item tools without the champions the user named:
// fill them in from the question.
async function fillFromQuestion(name, args, q) {
  if (name === 'recommend_items' && !(args.enemies && args.enemies.length)) {
    const champs = await champsIn(q);
    if (champs.length) {
      const mineMatch = String(q).match(/([a-zçğıöşü' .]+?)\s+(için|ile oynuyorum|oynuyorum)|\bfor\s+([a-z' .]+?)[,?]|\bas\s+([a-z' .]+)/i);
      const mineText = mineMatch ? (mineMatch[1] || mineMatch[3] || mineMatch[4] || '') : '';
      const mine = args.myChampion || (await champsIn(mineText))[0] || (champs.length > 1 ? champs[0] : '');
      const enemies = champs.filter((c) => c !== mine);
      return { ...args, ...(mine ? { myChampion: mine } : {}), ...(enemies.length ? { enemies } : {}) };
    }
  }
  if (name === 'esports' && !args.team && !args.player && !args.league) {
    // A league named in the question; teams / players the model has to pass.
    const lg = String(q).match(/\b(LCK|LEC|LPL|LCS|LTA|PCS|VCS|CBLOL|LJL|Worlds|MSI|First Stand)\b/i);
    if (lg) return { ...args, league: lg[1], ...(/(bu hafta|this week|yaklaşan|upcoming|ne zaman|when|schedule|fikstür)/i.test(q) ? { upcoming: true } : {}) };
  }
  if (name === 'counters' && !args.champion) {
    // "Yasuo vs Annie mid": first champion is mine, second the opponent.
    const champs = await champsIn(q);
    const role = (ROLE_WORDS.find(([, re]) => re.test(q)) || [])[0];
    if (champs.length) return { ...args, champion: champs[0], ...(champs[1] && !args.opponent ? { opponent: champs[1] } : {}), ...(role && !args.role ? { role } : {}) };
  }
  if (name === 'champion_build' && !args.champion) {
    const champs = await champsIn(q);
    if (champs.length) return { ...args, champion: champs[0] };
  }
  return args;
}

module.exports = { run, ctx: null, forcedTool, champsIn, fillFromQuestion };
