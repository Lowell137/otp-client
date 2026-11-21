// AI assistant settings, kept in <userData>/ai.json.
//
//   { active: <provider id>, providers: [{ id, type, name, baseUrl, keyEnc, model, models }] }
//   type 'ollama' = Ollama's own API; 'openai' = any OpenAI-compatible server
//   (LM Studio, Unsloth Studio, llama.cpp, OpenRouter, ...). Any number of them;
//   the active one answers. API keys are encrypted with Electron's safeStorage
//   (Windows DPAPI) and never sent to the page.
// Older files ({ provider, ollama, custom }) are converted on load.

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const OLLAMA_URL = 'http://127.0.0.1:11434';
const file = () => path.join(app.getPath('userData'), 'ai.json');
const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const cleanUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

function fromOld(c) {
  const list = [{ id: 'ollama', type: 'ollama', name: 'Ollama', baseUrl: c.ollama?.baseUrl || OLLAMA_URL, keyEnc: '', model: c.ollama?.model || '', models: [] }];
  if (c.custom && c.custom.baseUrl) {
    list.push({ id: 'custom', type: 'openai', name: c.custom.name || 'Custom', baseUrl: c.custom.baseUrl, keyEnc: c.custom.keyEnc || '', model: c.custom.model || '', models: c.custom.models || [] });
  }
  return { active: c.provider === 'custom' && list.length > 1 ? 'custom' : 'ollama', providers: list };
}

function load() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch {}
  if (!Array.isArray(c.providers)) c = fromOld(c);
  c.providers = c.providers.filter((p) => p && p.id && (p.type === 'ollama' || p.type === 'openai'));
  if (!c.providers.length) c.providers = [{ id: 'ollama', type: 'ollama', name: 'Ollama', baseUrl: OLLAMA_URL, keyEnc: '', model: '', models: [] }];
  if (!c.providers.some((p) => p.id === c.active)) c.active = c.providers[0].id;
  return c;
}

function save(c) {
  try { fs.writeFileSync(file(), JSON.stringify({ active: c.active, providers: c.providers }, null, 2)); } catch (e) { console.warn('[otp] ai config save:', e?.message || e); }
}

function encryptKey(key) {
  if (!key) return '';
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(key).toString('base64');
  return 'raw:' + Buffer.from(key, 'utf8').toString('base64');
}

function decryptKey(v) {
  if (!v) return '';
  try {
    if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    if (v.startsWith('raw:')) return Buffer.from(v.slice(4), 'base64').toString('utf8');
  } catch {}
  return '';
}

const active = (c) => c.providers.find((p) => p.id === c.active) || c.providers[0];

// What the page may see: everything but the keys.
function publicView(c) {
  return {
    active: c.active,
    providers: c.providers.map((p) => ({ id: p.id, type: p.type, name: p.name, baseUrl: p.baseUrl, model: p.model, models: p.models || [], hasKey: !!p.keyEnc })),
  };
}

// Page sends one change at a time:
//   { active: id }                      use this provider
//   { model: { id, model } }            pick a model (and use that provider)
//   { upsert: { id?, type, name, baseUrl, model?, models?, key?, clearKey? } }
//   { remove: id }
function update(patch) {
  const c = load();
  if (patch.active && c.providers.some((p) => p.id === patch.active)) c.active = patch.active;
  if (patch.model && patch.model.id) {
    const p = c.providers.find((x) => x.id === patch.model.id);
    if (p) { p.model = String(patch.model.model || ''); c.active = p.id; }
  }
  if (patch.upsert) {
    const u = patch.upsert;
    let p = u.id ? c.providers.find((x) => x.id === u.id) : null;
    if (!p) { p = { id: u.id || newId(), type: u.type === 'ollama' ? 'ollama' : 'openai', name: '', baseUrl: '', keyEnc: '', model: '', models: [] }; c.providers.push(p); }
    if (u.type === 'ollama' || u.type === 'openai') p.type = u.type;
    if (typeof u.name === 'string') p.name = u.name.trim() || (p.type === 'ollama' ? 'Ollama' : 'Custom');
    if (typeof u.baseUrl === 'string') p.baseUrl = cleanUrl(u.baseUrl) || (p.type === 'ollama' ? OLLAMA_URL : '');
    if (typeof u.model === 'string') p.model = u.model.trim();
    if (Array.isArray(u.models)) p.models = u.models.map(String).filter(Boolean).slice(0, 80);
    if (typeof u.key === 'string' && u.key.trim()) p.keyEnc = encryptKey(u.key.trim());
    if (u.clearKey) p.keyEnc = '';
    if (u.makeActive) c.active = p.id;
    c.lastId = p.id;
  }
  if (patch.remove && c.providers.length > 1) {
    c.providers = c.providers.filter((p) => p.id !== patch.remove);
    if (c.active === patch.remove) c.active = c.providers[0].id;
  }
  save(c);
  return c;
}

module.exports = { load, save, update, publicView, decryptKey, active, OLLAMA_URL };
