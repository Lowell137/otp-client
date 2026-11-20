// AI assistant settings, kept in <userData>/ai.json.
//
// provider: 'ollama' (local, default) or 'custom' (any OpenAI-compatible server:
// OpenRouter, LM Studio, llama.cpp server, ...). API keys are encrypted with
// Electron's safeStorage (Windows DPAPI) and never sent to the page.

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULTS = {
  provider: 'ollama',
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: '' },
  custom: { name: 'Custom', baseUrl: '', keyEnc: '', model: '', models: [] },
};

const file = () => path.join(app.getPath('userData'), 'ai.json');

function load() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch {}
  return {
    provider: c.provider === 'custom' ? 'custom' : 'ollama',
    ollama: { ...DEFAULTS.ollama, ...(c.ollama || {}) },
    custom: { ...DEFAULTS.custom, ...(c.custom || {}) },
  };
}

function save(c) {
  try { fs.writeFileSync(file(), JSON.stringify(c, null, 2)); } catch (e) { console.warn('[otp] ai config save:', e?.message || e); }
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

// What the page may see: everything but the key itself.
function publicView(c) {
  return {
    provider: c.provider,
    ollama: { ...c.ollama },
    custom: { name: c.custom.name, baseUrl: c.custom.baseUrl, model: c.custom.model, models: c.custom.models || [], hasKey: !!c.custom.keyEnc },
  };
}

// Page sends a partial update; a key is only replaced when one is given.
function update(patch) {
  const c = load();
  if (patch.provider === 'ollama' || patch.provider === 'custom') c.provider = patch.provider;
  if (patch.ollama) {
    if (typeof patch.ollama.baseUrl === 'string' && patch.ollama.baseUrl.trim()) c.ollama.baseUrl = patch.ollama.baseUrl.trim().replace(/\/+$/, '');
    if (typeof patch.ollama.model === 'string') c.ollama.model = patch.ollama.model;
  }
  if (patch.custom) {
    const p = patch.custom;
    if (typeof p.name === 'string') c.custom.name = p.name.trim() || 'Custom';
    if (typeof p.baseUrl === 'string') c.custom.baseUrl = p.baseUrl.trim().replace(/\/+$/, '');
    if (typeof p.model === 'string') c.custom.model = p.model.trim();
    if (Array.isArray(p.models)) c.custom.models = p.models.map(String).filter(Boolean).slice(0, 50);
    if (typeof p.key === 'string' && p.key.trim()) c.custom.keyEnc = encryptKey(p.key.trim());
    if (p.clearKey) c.custom.keyEnc = '';
  }
  save(c);
  return c;
}

module.exports = { load, save, update, publicView, decryptKey };
