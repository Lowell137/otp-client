// Model providers behind one interface:
//   chat({ messages, tools, model, signal }) -> { content, toolCalls: [{ id, name, args }] }
//   models() -> [{ id, size? }]
//   ping() -> true / throws
//
// Messages use one internal shape (OpenAI-like) and are converted per provider:
//   { role: 'system'|'user'|'assistant'|'tool', content,
//     toolCalls?: [{ id, name, args }],      // assistant
//     toolCallId?, name?,                    // tool result
//     images?: [base64 png/jpg] }            // user (vision models)

const cfgMod = require('./config.js');

async function postJson(url, body, { headers = {}, signal, timeoutMs = 180000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctl.abort(new Error('stopped'));
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 300);
      try { const j = JSON.parse(text); msg = j.error?.message || j.error || msg; } catch {}
      throw new Error(`HTTP ${r.status}: ${msg}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function getJson(url, { headers = {}, timeoutMs = 5000 } = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const toolSpec = (tools) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

// ---- Ollama (/api/chat) ----
// keep_alive: the model leaves GPU memory 3 minutes after the last answer, so it
// does not sit there while you play.
function ollama(p) {
  const base = String(p.baseUrl || cfgMod.OLLAMA_URL).replace(/\/+$/, '');
  const conv = (m) => {
    if (m.role === 'assistant') {
      const o = { role: 'assistant', content: m.content || '' };
      if (m.toolCalls?.length) o.tool_calls = m.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.args || {} } }));
      return o;
    }
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.name };
    const o = { role: m.role, content: m.content || '' };
    if (m.images?.length) o.images = m.images;
    return o;
  };
  return {
    id: p.id, name: p.name, type: 'ollama',
    async chat({ messages, tools, model, signal }) {
      const j = await postJson(`${base}/api/chat`, {
        model: model || p.model, messages: messages.map(conv), tools: tools?.length ? toolSpec(tools) : undefined,
        stream: false, keep_alive: '3m', options: { num_ctx: 8192, temperature: 0.3 },
      }, { signal });
      const msg = j.message || {};
      const toolCalls = (msg.tool_calls || []).map((tc, i) => {
        let args = tc.function?.arguments || {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        return { id: `call_${Date.now()}_${i}`, name: tc.function?.name || '', args };
      });
      return { content: stripThink(msg.content || ''), thinking: [msg.thinking, thinkOf(msg.content)].filter(Boolean).join('\n'), toolCalls };
    },
    async models() {
      const j = await getJson(`${base}/api/tags`);
      return (j.models || []).map((m) => ({ id: m.name, size: m.size || 0, family: m.details?.family || '', params: m.details?.parameter_size || '' }));
    },
    async ping() { await getJson(`${base}/api/version`, { timeoutMs: 2000 }); return true; },
  };
}

// ---- OpenAI-compatible (/chat/completions) ----
function openaiCompat(p) {
  const base = String(p.baseUrl || '').replace(/\/+$/, '');
  const key = p.key != null ? p.key : cfgMod.decryptKey(p.keyEnc);
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  if (/openrouter\.ai/.test(base)) { headers['HTTP-Referer'] = 'https://github.com/Lowell137/otp-client'; headers['X-Title'] = 'OTP Client'; }
  const conv = (m) => {
    if (m.role === 'assistant') {
      const o = { role: 'assistant', content: m.content || '' };
      if (m.toolCalls?.length) o.tool_calls = m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) } }));
      return o;
    }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.images?.length) {
      return { role: m.role, content: [{ type: 'text', text: m.content || '' }, ...m.images.map((b) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b}` } }))] };
    }
    return { role: m.role, content: m.content || '' };
  };
  return {
    id: p.id, name: p.name, type: 'openai',
    async chat({ messages, tools, model, signal }) {
      if (!base) throw new Error(`No server address set for ${p.name || 'this provider'}`);
      const j = await postJson(`${base}/chat/completions`, {
        model: model || p.model, messages: messages.map(conv),
        tools: tools?.length ? toolSpec(tools) : undefined, temperature: 0.3,
      }, { headers, signal });
      const msg = j.choices?.[0]?.message || {};
      const toolCalls = (msg.tool_calls || []).map((tc, i) => {
        let args = {};
        try { args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : (tc.function?.arguments || {}); } catch {}
        return { id: tc.id || `call_${Date.now()}_${i}`, name: tc.function?.name || '', args };
      });
      const text = typeof msg.content === 'string' ? msg.content : '';
      return { content: stripThink(text), thinking: [msg.reasoning_content, msg.reasoning, thinkOf(text)].filter((x) => typeof x === 'string' && x.trim()).join('\n'), toolCalls };
    },
    async models() {
      if (!base) return [];
      const j = await getJson(`${base}/models`, { headers, timeoutMs: 8000 });
      return (j.data || []).map((m) => ({ id: m.id }));
    },
    async ping() { if (!base) throw new Error('no base url'); await getJson(`${base}/models`, { headers, timeoutMs: 4000 }); return true; },
  };
}

// Reasoning models put their thinking in <think>...</think>: the answer is shown
// without it, and the thinking apart, folded (ai.html).
function stripThink(s) { return String(s || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim(); }
function thinkOf(s) { return [...String(s || '').matchAll(/<think>([\s\S]*?)(<\/think>|$)/g)].map((m) => m[1].trim()).filter(Boolean).join('\n'); }

// Test double: OTP_AI_MOCK=1 answers with a scripted tool call, then echoes the result.
function mock() {
  return {
    id: 'mock',
    async chat({ messages, tools }) {
      const last = messages[messages.length - 1];
      if (last.role === 'tool') return { content: `Tool ${last.name} returned:\n${String(last.content).slice(0, 600)}`, toolCalls: [] };
      const text = String(last.content || '').toLowerCase();
      const pick = (n) => tools.find((t) => t.name === n);
      if (/boot|item|bot|eşya/.test(text) && pick('recommend_items')) {
        const vs = String(last.content || '').match(/vs:\s*([^\n]+)/i);
        const me = String(last.content || '').match(/me:\s*([A-Za-z' ]+)/i);
        return { content: '', toolCalls: [{ id: 'c1', name: 'recommend_items', args: { enemies: vs ? vs[1].split(',').map((x) => x.trim()) : undefined, myChampion: me ? me[1].trim() : undefined } }] };
      }
      const rid = String(last.content || '').match(/([^\s#]{3,16})#([A-Za-z0-9]{2,5})/);
      if (rid && pick('player_profile')) return { content: '', toolCalls: [{ id: 'c1', name: 'player_profile', args: { riotId: `${rid[1]}#${rid[2]}` } }] };
      if (pick('current_game')) return { content: '', toolCalls: [{ id: 'c1', name: 'current_game', args: {} }] };
      return { content: 'mock: no tool', toolCalls: [] };
    },
    async models() { return [{ id: 'mock' }]; },
    async ping() { return true; },
  };
}

// One provider entry from the settings -> its client.
const make = (p) => (p.type === 'ollama' ? ollama(p) : openaiCompat(p));

function current() {
  if (process.env.OTP_AI_MOCK === '1') return mock();
  return make(cfgMod.active(cfgMod.load()));
}

function currentModel() {
  if (process.env.OTP_AI_MOCK === '1') return 'mock';
  return cfgMod.active(cfgMod.load()).model;
}

module.exports = { current, currentModel, make, ollama, openaiCompat };
