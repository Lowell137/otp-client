const { contextBridge, ipcRenderer } = require('electron');

const TIER_ORDER = ['S+', 'S', 'S-', 'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D'];
const TIER_COLORS = { 'S+': '#ff4655', 'S': '#ff8c42', 'S-': '#ffa94d', 'A+': '#ffd166', 'A': '#e3d76b', 'A-': '#b8e986', 'B+': '#7bd88f', 'B': '#5fc98a', 'B-': '#4db8a0', 'C+': '#6cb2ff', 'C': '#5b8fd6', 'C-': '#4a6fa5', 'D': '#9aa3b8' };
const LANES = [['all', 'All'], ['top', 'Top'], ['jungle', 'Jungle'], ['middle', 'Mid'], ['bottom', 'Bot'], ['support', 'Support']];
const TIERS = [['emerald_plus', 'Emerald+'], ['platinum_plus', 'Platinum+'], ['diamond_plus', 'Diamond+'], ['master_plus', 'Master+'], ['challenger', 'Challenger']];
const PATCH_OPTIONS = [['', 'Current'], ['16.18', '16.18'], ['16.17', '16.17'], ['16.16', '16.16'], ['16.15', '16.15'], ['16.14', '16.14']];
const REGIONS = [['all', 'Global'], ['kr', 'KR'], ['euw', 'EUW'], ['eune', 'EUNE'], ['na', 'NA'], ['br', 'BR'], ['tr', 'TR'], ['ru', 'RU'], ['jp', 'JP'], ['oce', 'OCE']];
const COLS = [
  { k: 'rank', label: '#', num: true },
  { k: 'name', label: 'Champion', num: false },
  { k: 'tier', label: 'Tier', num: false, tier: true },
  { k: 'lane', label: 'Lane', num: false },
  { k: 'win', label: 'Win %', num: true },
  { k: 'pick', label: 'Pick %', num: true },
  { k: 'ban', label: 'Ban %', num: true },
  { k: 'games', label: 'Games', num: true },
];

let rows = [];
let lane = 'all';
let tierBracket = 'emerald_plus';
let patchSel = '';
let region = 'all';
let tierFilter = 'All';
let query = '';
let sortKey = 'rank';
let sortDir = 1;
let patch = '';
let bracket = '';
let analysed = '';

function fillSelect(sel, opts, cur) {
  const el = document.querySelector(sel);
  if (!el || el.dataset.done) return;
  el.innerHTML = '';
  opts.forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    if (v === cur) o.selected = true;
    el.appendChild(o);
  });
  el.dataset.done = '1';
  el.onchange = () => {
    if (sel === '#otp-tier') tierBracket = el.value;
    else if (sel === '#otp-patchsel') patchSel = el.value;
    else region = el.value;
    load();
  };
}

function renderControls() {
  fillSelect('#otp-tier', TIERS, tierBracket);
  fillSelect('#otp-patchsel', PATCH_OPTIONS, patchSel);
  fillSelect('#otp-region', REGIONS, region);
  const tabs = document.querySelector('#otp-tabs');
  if (tabs) {
    tabs.innerHTML = '';
    LANES.forEach(([k, label]) => {
      const b = document.createElement('button');
      b.className = 'otp-tab' + (k === lane ? ' sel' : '');
      b.textContent = label;
      b.onclick = () => {
        lane = k;
        tabs.querySelectorAll('.otp-tab').forEach((t, idx) => t.classList.toggle('sel', LANES[idx][0] === lane));
        load();
      };
      tabs.appendChild(b);
    });
  }
}

function parseTierHTML(html) {
  patch = (html.match(/Patch ([\d.]+)/) || [])[1] || '';
  const bm = html.match(/Average (.*?) Win Rate/);
  bracket = bm ? bm[1] : '';
  const an = html.match(/Champions Analysed:.*?([\d,]+)/);
  analysed = an ? an[1] : '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = [];
  doc.querySelectorAll('div[class*="h-[52px]"]').forEach((row) => {
    try {
      const link = row.querySelector('a[href*="/build/"]');
      if (!link) return;
      const slug = (link.getAttribute('href').match(/\/lol\/([a-z0-9]+)\/build/) || [])[1];
      const icon = link.querySelector('img');
      const name = (icon ? icon.getAttribute('alt') : null) || (link ? link.textContent.trim() : null) || slug;
      if (!slug || !name) return;
      let tier = null, laneN = null, lanePct = null, win = null, delta = null, games = null;
      const nums48 = [];
      let rank = null;
      Array.from(row.children).forEach((cell) => {
        if (cell.tagName !== 'DIV') return;
        const w = (cell.getAttribute('style') || '').match(/width:(\d+)px/);
        if (!w) return;
        const t = (cell.textContent || '').trim();
        if (w[1] === '40') {
          if (/^(S\+|S-|S|A\+|A-|A|B\+|B-|B|C\+|C-|C|D)$/.test(t)) tier = t;
          else if (/^\d+$/.test(t) && rank === null) rank = Number(t);
          const limg = cell.querySelector('img[alt$="lane"]');
          if (limg) {
            laneN = limg.getAttribute('alt').replace(' lane', '');
            const n = t.match(/([\d.]+)/);
            lanePct = n ? Number(n[1]) : null;
          }
        } else if (w[1] === '48') {
          const sp = cell.querySelector('span[style*="color"]');
          if (sp && win === null) {
            win = parseFloat(sp.textContent);
            const d = t.match(/([+-][\d.]+)/);
            delta = d ? Number(d[1]) : null;
          } else {
            const n = t.match(/^([\d.,]+)$/);
            if (n) nums48.push(n[1]);
          }
        } else if (w[1] === '72') {
          const n = t.match(/([\d,]+)/);
          if (n) games = Number(n[1].replace(/,/g, ''));
        }
      });
      if (!tier) return;
      out.push({
        rank: rank ?? out.length + 1, slug, name, tier,
        lane: laneN, lanePct, win, delta,
        pick: nums48[0] != null ? parseFloat(nums48[0]) : null,
        ban: nums48[1] != null ? parseFloat(nums48[1]) : null,
        games,
      });
    } catch {}
  });
  return out;
}

function tierIdx(t) {
  const i = TIER_ORDER.indexOf(t);
  return i < 0 ? 99 : i;
}

function viewRows() {
  let v = rows.filter((r) =>
    (tierFilter === 'All' || r.tier === tierFilter) &&
    (!query || r.name.toLowerCase().includes(query))
  );
  const dir = sortDir;
  v = [...v].sort((a, b) => {
    let r = 0;
    if (sortKey === 'tier') r = tierIdx(a.tier) - tierIdx(b.tier);
    else if (sortKey === 'name' || sortKey === 'lane') r = String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? ''));
    else r = (a[sortKey] ?? -Infinity) - (b[sortKey] ?? -Infinity);
    return r * dir;
  });
  return v;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function render() {
  document.querySelector('#otp-patch').textContent =
    [patch ? `Patch ${patch}` : '', bracket, analysed ? `${analysed} games` : '', 'Data: Lolalytics'].filter(Boolean).join(' · ');
  fillSelect('#otp-tier', TIERS, tierBracket);
  fillSelect('#otp-patchsel', PATCH_OPTIONS, patchSel);
  fillSelect('#otp-region', REGIONS, region);
  const tabs = document.querySelector('#otp-tabs');
  tabs.innerHTML = '';
  LANES.forEach(([k, label]) => {
    const b = document.createElement('button');
    b.className = 'otp-tab' + (k === lane ? ' sel' : '');
    b.textContent = label;
    b.onclick = () => { lane = k; load(); };
    tabs.appendChild(b);
  });
  const tiers = ['All', ...TIER_ORDER.filter((t) => rows.some((r) => r.tier === t))];
  const chips = document.querySelector('#otp-chips');
  chips.innerHTML = '';
  tiers.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'otp-chip' + (t === tierFilter ? ' sel' : '');
    b.textContent = t;
    if (t !== 'All') b.style.borderColor = TIER_COLORS[t] || '#888';
    b.onclick = () => { tierFilter = t; renderTable(); renderChips(); };
    chips.appendChild(b);
  });
  renderTable();
}

function renderChips() {
  document.querySelectorAll('#otp-chips .otp-chip').forEach((b) => {
    b.classList.toggle('sel', b.textContent === tierFilter);
  });
}

function renderTable() {
  const v = viewRows();
  const thead = document.querySelector('#otp-tbl thead tr');
  thead.innerHTML = '';
  COLS.forEach((c) => {
    const th = document.createElement('th');
    th.textContent = c.label + (sortKey === c.k ? (sortDir === 1 ? ' ▲' : ' ▼') : '');
    th.onclick = () => {
      if (sortKey === c.k) sortDir *= -1;
      else { sortKey = c.k; sortDir = c.k === 'name' ? 1 : 1; }
      renderTable();
    };
    thead.appendChild(th);
  });
  const tb = document.querySelector('#otp-tbl tbody');
  if (!v.length) {
    tb.innerHTML = `<tr><td colspan="8" class="otp-empty">No champions found</td></tr>`;
    return;
  }
  tb.innerHTML = v.map((r, i) => `
    <tr data-i="${i}">
      <td class="c">${r.rank}</td>
      <td><div class="otp-champ"><img loading="lazy" src="${r.icon}" alt=""><b>${esc(r.name)}</b></div></td>
      <td><span class="otp-tier" style="background:${TIER_COLORS[r.tier] || '#888'}">${r.tier}</span></td>
      <td class="c">${esc(cap(r.lane))}${r.lanePct != null ? ` <span class="dim">${r.lanePct}%</span>` : ''}</td>
      <td class="r"><b>${r.win != null ? r.win.toFixed(2) + '%' : '—'}</b>${r.delta != null ? ` <span class="dim">${r.delta > 0 ? '+' : ''}${r.delta.toFixed(2)}</span>` : ''}</td>
      <td class="r">${r.pick != null ? r.pick.toFixed(2) : '—'}</td>
      <td class="r">${r.ban != null ? r.ban.toFixed(2) : '—'}</td>
      <td class="r">${r.games != null ? r.games.toLocaleString('en-US') : '—'}</td>
    </tr>`).join('');
  tb.querySelectorAll('tr[data-i]').forEach((tr) => {
    tr.onclick = () => {
      const r = v[Number(tr.dataset.i)];
      if (r) ipcRenderer.invoke('otp:open-build', otpSlug(r.name));
    };
  });
}

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—';
}

function otpSlug(name) {
  return (name || '').replace(/[^A-Za-z]/g, '');
}

let ddBase = 'https://ddragon.leagueoflegends.com/cdn/15.1.1';
let ddMap = null;
async function champIcon(slug, name) {
  try {
    if (!ddMap) {
      const v = await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json();
      if (v?.[0]) ddBase = `https://ddragon.leagueoflegends.com/cdn/${v[0]}`;
      const cj = await (await fetch(`${ddBase}/data/en_US/champion.json`)).json();
      ddMap = {};
      for (const k of Object.keys(cj.data)) ddMap[k.toLowerCase()] = k;
    }
    const id = ddMap[String(slug || '').toLowerCase()] || ddMap[String(name || '').toLowerCase().replace(/[^a-z]/g, '')];
    if (id) return `${ddBase}/img/champion/${id}.png`;
  } catch {}
  return `https://cdn5.lolalytics.com/champx46/${slug}.webp`;
}

async function load() {
  const tb = document.querySelector('#otp-tbl tbody');
  tb.innerHTML = `<tr><td colspan="8" class="otp-empty">Loading…</td></tr>`;
  try {
    const res = await ipcRenderer.invoke('otp:tierlist', { lane, tier: tierBracket, patch: patchSel, region });
    if (!res || !res.ok) throw new Error(res?.error || 'fetch failed');
    rows = parseTierHTML(res.html);
    if (!rows.length) throw new Error('empty');
    for (const r of rows) r.icon = await champIcon(r.slug, r.name);
    render();
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="8" class="otp-empty">Could not load tier list (${esc(e?.message || e)}). <a href="https://lolalytics.com/lol/tierlist/" target="_blank" rel="noopener">Open on lolalytics.com →</a></td></tr>`;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  renderControls();
  const q = document.querySelector('#otp-q');
  q.oninput = () => { query = q.value.trim().toLowerCase(); renderTable(); };
  document.querySelector('#otp-back').onclick = () => ipcRenderer.send('otp:go-home');
  load();
});
