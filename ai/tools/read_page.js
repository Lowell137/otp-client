// Read a web page as plain text (for links from web_search): scripts, styles and
// tags removed, trimmed to a size a small model can handle.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX = 7000;

module.exports = {
  name: 'read_page',
  description: 'Read the text of a web page (a link from web_search) to get details such as exact patch changes. Returns the page title and up to ~7000 characters of text.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full https:// address' },
      find: { type: 'string', description: 'Optional word to jump to, e.g. a champion name, so the text around it is returned' },
    },
    required: ['url'],
  },
  async run(args) {
    const url = String(args?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return { error: 'Give a full http(s) address.' };
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(12000), redirect: 'follow' });
    if (!r.ok) return { error: `Could not open the page (HTTP ${r.status}).` };
    const type = r.headers.get('content-type') || '';
    if (!/text\/html|text\/plain|json/.test(type)) return { error: `Not a text page (${type}).` };
    const html = await r.text();
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    let text = html
      .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    let start = 0;
    if (args?.find) {
      const i = text.toLowerCase().indexOf(String(args.find).toLowerCase());
      if (i > 0) start = Math.max(0, i - 800);
    }
    return { url, title: title.replace(/\s+/g, ' ').trim(), text: text.slice(start, start + MAX), truncated: text.length > start + MAX || start > 0 };
  },
};
