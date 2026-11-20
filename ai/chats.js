// Saved assistant conversations, in <userData>/ai-chats.json (newest first, max 60).
// Each: { id, title, updated, messages: [{ role: 'user'|'assistant', content }] }.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX = 60;
const file = () => path.join(app.getPath('userData'), 'ai-chats.json');

function readAll() {
  try { const a = JSON.parse(fs.readFileSync(file(), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}
function writeAll(a) {
  try { fs.writeFileSync(file(), JSON.stringify(a.slice(0, MAX))); } catch (e) { console.warn('[otp] ai chats save:', e?.message || e); }
}

const titleOf = (messages) => {
  const first = (messages || []).find((m) => m.role === 'user');
  const t = String(first?.content || 'New chat').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? t.slice(0, 57) + '…' : t;
};

function list() {
  return readAll().map((c) => ({ id: c.id, title: c.title, updated: c.updated, count: (c.messages || []).length }));
}
function get(id) { return readAll().find((c) => c.id === id) || null; }
function save({ id, messages }) {
  if (!id || !Array.isArray(messages) || !messages.length) return null;
  const clean = messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-80);
  const all = readAll().filter((c) => c.id !== id);
  const c = { id, title: titleOf(clean), updated: Date.now(), messages: clean };
  all.unshift(c);
  writeAll(all);
  return { id: c.id, title: c.title, updated: c.updated };
}
function remove(id) { writeAll(readAll().filter((c) => c.id !== id)); return true; }

module.exports = { list, get, save, remove };
