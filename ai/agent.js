// Tool-calling loop: model -> tool calls -> results -> model ... -> answer.
// Events go to the page as they happen: { type: 'tool', name, args },
// { type: 'tool-done', name, ok }, { type: 'answer', content }, { type: 'error', message }.
const providers = require('./providers.js');
const tools = require('./tools/index.js');

const MAX_STEPS = 6;

function systemPrompt() {
  const now = new Date().toISOString().slice(0, 10);
  return [
    'You are the assistant inside OTP Client, a League of Legends companion app built around onetricks.gg.',
    `Today is ${now}.`,
    'Answer in the language the user writes in (Turkish or English usually). Be short and concrete: a few lines or a small list, no filler.',
    'Use the tools for anything about players, the current game, items, builds or stats; never invent ranks, stats or match results. If a tool returns an error, tell the user plainly what is missing.',
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
