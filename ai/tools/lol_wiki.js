// League of Legends Wiki (wiki.leagueoflegends.com, MediaWiki API): champions,
// items, runes, game modes, and each champion's patch history ("Jinx/Patch history").
const API = 'https://wiki.leagueoflegends.com/en-us/api.php';
const UA = 'OTP-Client/0.1 (League companion app)';
const MAX = 6000;

const strip = (html) => String(html || '')
  .replace(/<(script|style|table class="navbox)[\s\S]*?<\/(script|style|table)>/gi, ' ')
  .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|dd|dt)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").replace(/&nbsp;|&#160;/g, ' ')
  .replace(/\[edit\]|\[\d+\]/g, '')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

async function api(params) {
  const r = await fetch(`${API}?${new URLSearchParams({ format: 'json', ...params })}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

module.exports = {
  name: 'lol_wiki',
  description: 'Look something up on the League of Legends Wiki: a champion (abilities, stats), an item, a rune, a game mode, or a champion\'s patch history (query "Jinx/Patch history"). Returns the page text (newest changes first on patch history pages).',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Page or search words, e.g. "Jinx/Patch history", "Infinity Edge", "ARAM Mayhem"' },
      find: { type: 'string', description: 'Optional word to jump to inside the page' },
    },
    required: ['query'],
  },
  async run(args) {
    const q = String(args?.query || '').trim();
    if (!q) return { error: 'Empty query.' };
    const s = await api({ action: 'query', list: 'search', srsearch: q, srlimit: '5' });
    const hits = s?.query?.search || [];
    if (!hits.length) return { error: `Nothing on the wiki for "${q}".` };
    const exact = hits.find((h) => h.title.toLowerCase() === q.toLowerCase());
    const title = (exact || hits[0]).title;
    const p = await api({ action: 'parse', page: title, prop: 'text', redirects: '1' });
    let body = strip(p?.parse?.text?.['*']);
    let start = 0;
    if (args?.find) {
      const i = body.toLowerCase().indexOf(String(args.find).toLowerCase());
      if (i > 0) start = Math.max(0, i - 500);
    } else if (/patch history/i.test(title)) {
      // Skip the header/navigation to the first patch entry.
      const i = body.search(/\bV\d{2}\.\d+\b/);
      if (i > 0) start = i;
    }
    return {
      title, url: `https://wiki.leagueoflegends.com/en-us/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      text: body.slice(start, start + MAX), otherPages: hits.filter((h) => h.title !== title).map((h) => h.title).slice(0, 4),
    };
  },
};
