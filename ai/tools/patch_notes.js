// Official patch notes (leagueoflegends.com): the newest patch, or one asked for,
// with the parts that mention a champion / item / system.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const BASE = 'https://www.leagueoflegends.com';

const text = (html) => html
  .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ').replace(/&rArr;|⇒/g, '=>')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

module.exports = {
  name: 'patch_notes',
  description: 'Official League of Legends patch notes (newest patch by default, or a given one like "26.22"). With "find" (a champion, item or system name) it returns only the parts about it. Use for "what changed", "was X buffed/nerfed", "latest patch".',
  parameters: {
    type: 'object',
    properties: {
      find: { type: 'string', description: 'Champion, item or system to look for, e.g. "Jinx"' },
      patch: { type: 'string', description: 'Patch number like 26.22 (default: newest)' },
    },
    required: [],
  },
  async run(args) {
    const list = await get(`${BASE}/en-us/news/tags/patch-notes/`);
    const links = [...new Set([...list.matchAll(/href="(\/en-us\/news\/game-updates\/[^"]*patch-(\d+)-(\d+)-notes[^"]*)"/g)].map((m) => `${m[2]}.${m[3]}|${m[1]}`))]
      .map((s) => { const [v, href] = s.split('|'); return { v, href }; })
      .sort((a, b) => { const [a1, a2] = a.v.split('.').map(Number); const [b1, b2] = b.v.split('.').map(Number); return b1 - a1 || b2 - a2; });
    if (!links.length) return { error: 'Could not read the patch notes list.' };
    const want = String(args?.patch || '').match(/(\d+)\.(\d+)/);
    const pick = want ? links.find((l) => l.v === `${Number(want[1])}.${Number(want[2])}`) : links[0];
    if (!pick) return { error: `Patch ${args.patch} notes not found. Newest is ${links[0].v}.`, available: links.slice(0, 6).map((l) => l.v) };
    const body = text(await get(BASE + pick.href));
    const out = { patch: pick.v, newestPatch: links[0].v, url: BASE + pick.href };
    const f = String(args?.find || '').trim();
    if (!f) return { ...out, text: body.slice(0, 6000) };
    const low = body.toLowerCase(), key = f.toLowerCase();
    const parts = [];
    let i = low.indexOf(key);
    while (i >= 0 && parts.length < 4) {
      const s = Math.max(0, i - 200);
      parts.push(body.slice(s, i + 1400));
      i = low.indexOf(key, i + 1400);
    }
    if (!parts.length) return { ...out, found: false, note: `${f} is not mentioned in patch ${pick.v} notes.` };
    return { ...out, found: true, parts };
  },
};
