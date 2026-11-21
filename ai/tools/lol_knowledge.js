// Game knowledge that does not change every patch (ai/knowledge/*.md): wave
// management, recalls, vision, objectives, roles, trading, team fights, macro,
// items, jungle, climbing. Searched by words (Turkish suffixes too, by prefix).
// Draft notes; numbers that change (spawn times, item stats) stay with the
// live tools (lol_wiki, champion_build, recommend_items).
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'knowledge');
let notes = null;

const low = (s) => String(s || '').toLocaleLowerCase('tr').replace(/[^a-z0-9çğıöşü' ]+/g, ' ');
const words = (s) => low(s).split(/\s+/).filter((w) => w.length >= 3);
const STOP = new Set(['the', 'and', 'for', 'how', 'what', 'when', 'should', 'with', 'nasıl', 'neden', 'ne', 'zaman', 'için', 'bir', 'bu', 'şu', 'ben', 'benim', 'mı', 'mi', 'mu', 'mü', 'yapmalıyım', 'yapayım', 'gerekir', 'lazım', 'iyi', 'daha']);

function load() {
  if (notes) return notes;
  notes = [];
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.md')).sort()) {
    const text = fs.readFileSync(path.join(DIR, f), 'utf8');
    const title = (text.match(/^#\s+(.+)$/m) || [])[1] || f;
    const keywords = words((text.match(/^keywords:\s*(.+)$/m) || [])[1] || '');
    const sections = text.split(/\n(?=##\s)/).slice(1).map((s) => ({ head: (s.match(/^##\s+(.+)$/m) || [])[1] || '', body: s.trim() }));
    notes.push({ file: f, title, keywords, sections, intro: text.split(/\n(?=##\s)/)[0].replace(/^keywords:.*$/m, '').trim() });
  }
  return notes;
}

// A query word matches a note word when one starts with the other (4+ letters),
// so "dalgayı" finds "dalga" and "freezing" finds "freeze".
const hit = (q, w) => q === w || (q.length >= 4 && w.length >= 4 && (q.startsWith(w) || w.startsWith(q)));

module.exports = {
  name: 'lol_knowledge',
  description: 'General League of Legends know-how that does not change every patch: wave management (freeze, slow push, crash), recall timing, vision and wards, objectives priority, what each role does, laning and trading, power spikes, team fights, macro / split push, itemization basics, jungle pathing and ganks, climbing and mental. Use for "how do I…", "what should I do…", strategy and concept questions.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'The question or topic, e.g. "when to freeze the wave", "how to play jungle"' } },
    required: ['query'],
  },
  async run(args) {
    const q = words(args?.query).filter((w) => !STOP.has(w));
    if (!q.length) return { error: 'What topic? e.g. wave management, vision, team fights.' };
    const all = load();
    const scored = [];
    for (const n of all) {
      for (const s of n.sections) {
        const sw = words(s.body);
        const hw = words(s.head);
        const tw = words(n.title);
        let score = 0;
        for (const w of q) {
          if (n.keywords.some((k) => hit(w, k))) score += 3;
          if (tw.some((k) => hit(w, k))) score += 2;
          if (hw.some((k) => hit(w, k))) score += 2;
          score += Math.min(3, sw.filter((k) => hit(w, k)).length);
        }
        if (score > 0) scored.push({ n, s, score });
      }
    }
    if (!scored.length) return { error: 'Nothing in the knowledge notes for that. Try lol_wiki for champion or item facts.' };
    scored.sort((a, b) => b.score - a.score);
    const best = scored.slice(0, 4);
    let budget = 3000;
    const parts = [];
    for (const b of best) {
      const t = `[${b.n.title}] ${b.s.body}`;
      if (t.length > budget) break;
      parts.push(t);
      budget -= t.length;
    }
    return {
      source: 'OTP Client knowledge notes (draft, general advice, not patch data)',
      sections: parts,
      otherTopics: [...new Set(scored.slice(4).map((x) => x.n.title))].slice(0, 4),
    };
  },
};
