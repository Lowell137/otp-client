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

// Streaming POST: calls onLine(line) for each line of the body as it arrives
// (Ollama sends one JSON per line, OpenAI-style servers send "data: {...}").
// A server that ignores stream:true and answers with plain JSON is handled too:
// the whole body comes back as { json }. Times out after 120 s with no data.
async function postStream(url, body, { headers = {}, signal, onLine, idleMs = 120000 } = {}) {
  const ctl = new AbortController();
  let t;
  const arm = () => { clearTimeout(t); t = setTimeout(() => ctl.abort(new Error('timeout')), idleMs); };
  const onAbort = () => ctl.abort(new Error('stopped'));
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  arm();
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    if (!r.ok) {
      const text = await r.text();
      let msg = text.slice(0, 300);
      try { const j = JSON.parse(text); msg = j.error?.message || j.error || msg; } catch {}
      throw new Error(`HTTP ${r.status}: ${msg}`);
    }
    const ct = String(r.headers.get('content-type') || '');
    if (/application\/json/.test(ct) && !/ndjson/.test(ct)) return { json: await r.json() };
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      arm();
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    }
    if (buf.trim()) onLine(buf.trim());
    return {};
  } finally {
    clearTimeout(t);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// Live text for the panel: full snapshots (answer so far, thinking so far),
// at most every 80 ms, plus one last snapshot at the end.
function liveFeed(onDelta) {
  let raw = '', think = '', last = 0, timer = null;
  const emit = () => {
    timer = null; last = Date.now();
    if (onDelta) onDelta({ text: stripThink(raw), thinking: [think, thinkOf(raw)].filter(Boolean).join('\n') });
  };
  return {
    add(text, thinking) {
      if (text) raw += text;
      if (thinking) think += thinking;
      if (!onDelta || timer) return;
      const wait = Math.max(0, 80 - (Date.now() - last));
      timer = setTimeout(emit, wait);
    },
    end() { if (timer) { clearTimeout(timer); emit(); } },
    get raw() { return raw; },
    get think() { return think; },
  };
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
    async chat({ messages, tools, model, signal, onDelta }) {
      const feed = liveFeed(onDelta);
      const calls = [];
      const r = await postStream(`${base}/api/chat`, {
        model: model || p.model, messages: messages.map(conv), tools: tools?.length ? toolSpec(tools) : undefined,
        stream: true, keep_alive: '3m', options: { num_ctx: 8192, temperature: 0.3 },
      }, {
        signal,
        onLine(line) {
          let j; try { j = JSON.parse(line); } catch { return; }
          if (j.error) throw new Error(String(j.error));
          const m = j.message || {};
          if (m.tool_calls?.length) calls.push(...m.tool_calls);
          feed.add(m.content, m.thinking);
        },
      });
      feed.end();
      const msg = r.json ? (r.json.message || {}) : { content: feed.raw, thinking: feed.think, tool_calls: calls };
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
    async chat({ messages, tools, model, signal, onDelta }) {
      if (!base) throw new Error(`No server address set for ${p.name || 'this provider'}`);
      const feed = liveFeed(onDelta);
      const calls = []; // tool calls arrive in pieces, by index
      const r = await postStream(`${base}/chat/completions`, {
        model: model || p.model, messages: messages.map(conv),
        tools: tools?.length ? toolSpec(tools) : undefined, temperature: 0.3, stream: true,
      }, {
        headers, signal,
        onLine(line) {
          if (!line.startsWith('data:')) return;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') return;
          let j; try { j = JSON.parse(data); } catch { return; }
          if (j.error) throw new Error(String(j.error.message || j.error));
          const d = j.choices?.[0]?.delta || {};
          for (const tc of d.tool_calls || []) {
            const k = tc.index ?? calls.length;
            const c = calls[k] || (calls[k] = { id: '', function: { name: '', arguments: '' } });
            if (tc.id) c.id = tc.id;
            if (tc.function?.name) c.function.name += tc.function.name;
            if (tc.function?.arguments) c.function.arguments += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
          }
          const th = [d.reasoning_content, d.reasoning].find((x) => typeof x === 'string');
          feed.add(typeof d.content === 'string' ? d.content : '', th);
        },
      });
      feed.end();
      const msg = r.json ? (r.json.choices?.[0]?.message || {}) : { content: feed.raw, reasoning_content: feed.think, tool_calls: calls.filter(Boolean) };
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
    async chat({ messages, tools, onDelta }) {
      const last = messages[messages.length - 1];
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      // Slow, streamed like a real model, so the panel's live view can be checked.
      const thinking = 'The user asked something. I should look at the data first, then answer briefly.';
      for (let i = 1; i <= 4; i++) { await wait(300); onDelta?.({ text: '', thinking: thinking.slice(0, (thinking.length * i) / 4) }); }
      if (last.role === 'tool') {
        const content = `Tool ${last.name} returned:\n${String(last.content).slice(0, last.name === 'game_review' ? 9000 : 600)}`;
        for (let i = 1; i <= 8; i++) { await wait(150); onDelta?.({ text: content.slice(0, Math.ceil((content.length * i) / 8)), thinking }); }
        return { content, thinking, toolCalls: [] };
      }
      const text = String(last.content || '').toLowerCase();
      const pick = (n) => tools.find((t) => t.name === n);
      if (/boot|item|bot|eşya/.test(text) && pick('recommend_items')) {
        const vs = String(last.content || '').match(/vs:\s*([^\n]+)/i);
        const me = String(last.content || '').match(/me:\s*([A-Za-z' ]+)/i);
        return { content: '', toolCalls: [{ id: 'c1', name: 'recommend_items', args: { enemies: vs ? vs[1].split(',').map((x) => x.trim()) : undefined, myChampion: me ? me[1].trim() : undefined } }] };
      }
      const rid = String(last.content || '').match(/([^\s#]{3,16})#([A-Za-z0-9]{2,5})/);
      if (/played with|together/.test(text) && pick('played_with')) { const w = String(last.content || '').match(/with ([^s,?]+)/i); return { content: '', toolCalls: [{ id: 'c1', name: 'played_with', args: { riotId: rid ? `${rid[1]}#${rid[2]}` : undefined, region: 'TR', with: w ? w[1] : undefined, games: 40 } }] }; }
      if (/review|mistake|hata/.test(text) && pick('game_review')) return { content: '', toolCalls: [{ id: 'c1', name: 'game_review', args: rid ? { riotId: `${rid[1]}#${rid[2]}`, region: /TR/.test(String(last.content)) ? 'TR' : undefined, index: Number((String(last.content).match(/index (\d)/) || [])[1] || 0) } : {} }] };
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
