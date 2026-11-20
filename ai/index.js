// AI assistant: IPC between the chat page (ai.html) and the agent.
//
//   otp:ai-config-get / otp:ai-config-set   settings (keys never leave main)
//   otp:ai-models                           models of the current provider
//   otp:ai-status                           { ok, provider, model, error }
//   otp:ai-chat { id, history, model }      runs the agent; progress on 'otp:ai-event'
//   otp:ai-stop id                          aborts a running chat
//
// ctx gives tools the app's data: call(channel, arg) reuses any ipcMain.handle
// handler (deeplol, onetricks, op.gg, LCU import...), getLobby(), liveGet(path).
const config = require('./config.js');
const providers = require('./providers.js');
const agent = require('./agent.js');
const tools = require('./tools/index.js');

function register({ ipcMain, ctx }) {
  agent.ctx = ctx;
  const running = new Map();

  ipcMain.handle('otp:ai-config-get', () => config.publicView(config.load()));
  ipcMain.handle('otp:ai-config-set', (_e, patch) => config.publicView(config.update(patch || {})));
  ipcMain.handle('otp:ai-tools', () => tools.all().map((t) => ({ name: t.name, description: t.description })));
  // What the user is doing (for the start screen's suggestions).
  ipcMain.handle('otp:ai-context', () => {
    const lob = ctx.getLobby ? ctx.getLobby() : null;
    if (!lob || !lob.phase) return { phase: 'idle' };
    const role = lob.me?.role || '';
    const opp = role ? (lob.enemies || []).find((p) => p.role === role && p.champ)?.champ || '' : '';
    return { phase: lob.phase === 'InGame' ? 'game' : 'select', champ: lob.me?.champ || '', role, opp };
  });

  ipcMain.handle('otp:ai-models', async () => {
    try { return { ok: true, models: await providers.current().models() }; }
    catch (e) { return { ok: false, error: String(e?.message || e), models: [] }; }
  });

  // Settings dialog: try a provider config before saving it (lists its models).
  ipcMain.handle('otp:ai-test', async (_e, draft) => {
    try {
      const c = config.load();
      const tmp = JSON.parse(JSON.stringify(c));
      if (draft?.provider === 'ollama') {
        if (draft.ollama?.baseUrl) tmp.ollama.baseUrl = draft.ollama.baseUrl.trim().replace(/\/+$/, '');
        const p = providers.ollama(tmp);
        await p.ping();
        return { ok: true, models: (await p.models()).map((m) => m.id) };
      }
      if (typeof draft?.custom?.baseUrl === 'string') tmp.custom.baseUrl = draft.custom.baseUrl.trim().replace(/\/+$/, '');
      if (draft?.custom?.key) tmp.custom.keyEnc = 'raw:' + Buffer.from(draft.custom.key, 'utf8').toString('base64');
      const p = providers.openaiCompat(tmp);
      return { ok: true, models: (await p.models()).map((m) => m.id) };
    } catch (e) {
      let msg = String(e?.message || e);
      if (/401|403|auth/i.test(msg)) msg = 'The server wants an API key (or the key is wrong).';
      else if (/fetch failed|ECONNREFUSED|timeout/i.test(msg)) msg = 'Nothing answers at that address.';
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('otp:ai-status', async () => {
    const c = config.load();
    const p = providers.current();
    try {
      await p.ping();
      return { ok: true, provider: p.id, model: providers.currentModel() };
    } catch (e) {
      return { ok: false, provider: p.id, model: providers.currentModel(), error: String(e?.message || e), ollamaUrl: c.ollama.baseUrl };
    }
  });

  ipcMain.handle('otp:ai-chat', async (e, q) => {
    const id = String(q?.id || Date.now());
    const ctl = new AbortController();
    running.set(id, ctl);
    const send = (ev) => { try { if (!e.sender.isDestroyed()) e.sender.send('otp:ai-event', { id, ...ev }); } catch {} };
    try {
      const history = (q?.history || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'tool')).slice(-30);
      const r = await agent.run({ history, onEvent: send, signal: ctl.signal, model: q?.model });
      return { ok: true, content: r.content, thinking: r.thinking || '', messages: r.messages };
    } catch (err) {
      const message = ctl.signal.aborted ? 'Stopped.' : String(err?.message || err);
      send({ type: 'error', message });
      return { ok: false, error: message };
    } finally {
      running.delete(id);
    }
  });

  ipcMain.on('otp:ai-stop', (_e, id) => { const c = running.get(String(id)); if (c) c.abort(); });

  // Ollama setup screen (ai/setup.js)
  const setup = require('./setup.js');
  ipcMain.handle('otp:ai-setup-status', async () => setup.status(providers.ollama(config.load())));
  ipcMain.handle('otp:ai-setup-commands', (_e, model) => setup.commands(model));
  ipcMain.handle('otp:ai-setup-install', (_e, model) => {
    // Use Ollama with the chosen model once it is there.
    const r = setup.install(model);
    config.update({ provider: 'ollama', ollama: { model: r.model } });
    return r;
  });

  // Saved conversations (ai/chats.js)
  const chats = require('./chats.js');
  ipcMain.handle('otp:ai-chats-list', () => chats.list());
  ipcMain.handle('otp:ai-chats-get', (_e, id) => chats.get(String(id || '')));
  ipcMain.handle('otp:ai-chats-save', (_e, c) => chats.save(c || {}));
  ipcMain.handle('otp:ai-chats-delete', (_e, id) => chats.remove(String(id || '')));
}

module.exports = { register };
