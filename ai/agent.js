// Tool-calling loop: model -> tool calls -> results -> model ... -> answer.
// Events go to the page as they happen: { type: 'tool', name, args },
// { type: 'tool-done', name, ok }, { type: 'answer', content }, { type: 'error', message }.
const providers = require('./providers.js');
const tools = require('./tools/index.js');

const MAX_STEPS = 8;

function systemPrompt() {
  const now = new Date().toISOString().slice(0, 10);
  return [
    'You are the assistant inside OTP Client, a League of Legends companion app built around onetricks.gg.',
    `Today is ${now}.`,
    `Reply in the same language as the user's last message: a Turkish message (e.g. "naber", "hangi", "ne") gets a Turkish answer, English gets English. Be short and concrete: a few lines or a small list, no filler.`,
    'Greetings and small talk ("hi", "naber", "thanks") get a short friendly reply with NO tool call.',
    'STRICT RULES for facts about League of Legends:',
    '1. Inventing is forbidden. Never state a rank, stat, tier, win rate, build, champion role, patch change or item from memory. Your own knowledge is old; the game changes every patch.',
    '2. Always use the newest data: get it from the tools (tier_list, player_profile, player_matches, current_game, recommend_items) every time, even if you think you know.',
    `3. If no stats tool covers the question, research it: patch_notes for what changed in a patch (official notes), lol_wiki for champions, items, runes, modes and a champion's patch history ("Jinx/Patch history"), read_page for a link. Answer from what you found and name the source and patch.`,
    '4. If you still cannot find it, say plainly that you could not find it. A short honest "I could not find that" is always better than a guess.',
    'Only call current_game, player_profile or player_matches when the user asks about a specific game or player. If a tool returns an error, tell the user plainly what is missing.',
    'When the user names an enemy or ally by champion ("the enemy Ezreal"), pass that champion to the tool instead of asking for a Riot ID.',
    "Riot's rules: give information, builds and analysis only. Do not make real-time in-game decisions for the player (when to fight, where the enemy jungler is, ability timers).",
  ].join('\n');
}

async function run({ history, onEvent, signal, model }) {
  const provider = providers.current();
  const list = tools.all();
  const messages = [{ role: 'system', content: systemPrompt() }, ...history];
  for (let step = 0; step < MAX_STEPS; step++) {
    const r = await provider.chat({ messages, tools: list, model: model || providers.currentModel(), signal });
    if (!r.toolCalls.length) {
      const content = r.content || '(no answer)';
      onEvent({ type: 'answer', content });
      return { content, messages: messages.slice(1) };
    }
    messages.push({ role: 'assistant', content: r.content || '', toolCalls: r.toolCalls });
    for (const tc of r.toolCalls) {
      const t = tools.byName(tc.name);
      onEvent({ type: 'tool', name: tc.name, args: tc.args });
      let result;
      try {
        result = t ? await t.run(tc.args || {}, module.exports.ctx) : { error: `Unknown tool ${tc.name}` };
      } catch (e) {
        result = { error: String(e?.message || e) };
      }
      onEvent({ type: 'tool-done', name: tc.name, ok: !result?.error });
      messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: JSON.stringify(result).slice(0, 12000) });
    }
  }
  const content = 'I could not finish this in a few steps. Try asking more specifically.';
  onEvent({ type: 'answer', content });
  return { content, messages: messages.slice(1) };
}

module.exports = { run, ctx: null };
