const { ipcRenderer } = require('electron');

const REGIONS = ['tr1', 'euw1', 'eun1', 'na1', 'br1', 'la1', 'la2', 'kr', 'jp1', 'oc1', 'ru'];
const QTABS = [['all', 'Total'], [420, 'Ranked Solo'], [440, 'Ranked Flex']];

let settings = { region: 'tr1' };
try { Object.assign(settings, JSON.parse(localStorage.getItem('otp.settings') || '{}')); } catch {}
function saveSettings() {
  try { localStorage.setItem('otp.settings', JSON.stringify(settings)); } catch {}
  try { ipcRenderer.send('otp:settings', settings); } catch {}
}

function shortReg(r) {
  return String(r || '').replace(/1$/, '').toUpperCase();
}

let lastDlRes = null;
let lastLobbyRes = null;
let curQueue = 'all';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

// ---- recent searches ----
function getRecents() {
  try { return JSON.parse(localStorage.getItem('otp.recent') || '[]'); } catch { return []; }
}
function pushRecent(name, tag, region) {
  try {
    let r = getRecents().filter((x) => !(x.name === name && x.tag === tag && x.region === region));
    r.unshift({ name, tag, region, ts: Date.now() });
    localStorage.setItem('otp.recent', JSON.stringify(r.slice(0, 8)));
  } catch {}
  renderRecents();
}
function delRecent(i) {
  try {
    const r = getRecents();
    r.splice(i, 1);
    localStorage.setItem('otp.recent', JSON.stringify(r));
  } catch {}
  renderRecents();
}
function renderRecents() {
  const box = document.querySelector('#otp-recent');
  if (!box) return;
  box.innerHTML = '';
  getRecents().forEach((r, i) => {
    const c = document.createElement('span');
    c.className = 'otp-chip';
    c.innerHTML = `<span>${esc(r.name)} #${esc(r.tag)}</span><span class="rg">${esc(r.region.replace(/1$/, '').toUpperCase())}</span><span class="x" title="Remove">✕</span>`;
    c.onclick = (e) => {
      if (e.target.classList.contains('x')) { delRecent(i); return; }
      document.querySelector('#otp-sinput').value = `${r.name}#${r.tag}`;
      settings.region = r.region; saveSettings(); syncRegBadge();
      doSummonerSearch();
    };
    box.appendChild(c);
  });
}

// ---- queue filter ----
const QNAMES = { 400: 'Normal', 420: 'Ranked Solo', 430: 'Normal', 440: 'Ranked Flex', 450: 'ARAM', 700: 'Clash', 900: 'ARURF', 1700: 'Arena', 490: 'Quickplay', 720: 'ARAM Clash', 830: 'Bots', 840: 'Bots', 850: 'Bots' };
function qname(id) { return QNAMES[id] || (id ? `Q${id}` : 'Other'); }
function viewMatches() {
  const ms = lastDlRes?.matches || [];
  if (curQueue === 'all') return ms;
  return ms.filter((m) => m.queue === curQueue);
}
function allQueues() {
  const seen = [];
  (lastDlRes?.matches || []).forEach((m) => { if (m.queue != null && !seen.includes(m.queue)) seen.push(m.queue); });
  const fixed = [420, 440];
  const extra = seen.filter((q) => !fixed.includes(q)).sort((a, b) =>
    (lastDlRes.matches.filter((m) => m.queue === b).length - lastDlRes.matches.filter((m) => m.queue === a).length));
  return ['all', ...fixed.filter((q) => seen.includes(q) || q === 420 || q === 440), ...extra];
}
function renderQtabs() {
  const tabs = document.querySelector('#otp-qtabs');
  if (!tabs) return;
  tabs.innerHTML = '';
  allQueues().forEach((v) => {
    const b = document.createElement('button');
    b.className = 'otp-qtab';
    b.dataset.v = String(v);
    b.onclick = () => { curQueue = (v === 'all') ? 'all' : v; syncQtabs(); paintMatchData(); };
    tabs.appendChild(b);
  });
  syncQtabs();
  paintQtabCounts();
}
function syncQtabs() {
  document.querySelectorAll('#otp-qtabs .otp-qtab').forEach((b) => {
    b.classList.toggle('sel', (b.dataset.v === 'all' ? 'all' : Number(b.dataset.v)) === curQueue);
  });
}
function paintQtabCounts() {
  const every = lastDlRes?.matches || [];
  document.querySelectorAll('#otp-qtabs .otp-qtab').forEach((b) => {
    const v = b.dataset.v === 'all' ? 'all' : Number(b.dataset.v);
    const n = v === 'all' ? every.length : every.filter((m) => m.queue === v).length;
    const label = v === 'all' ? 'Total' : qname(v);
    b.textContent = `${label} (${n})`;
  });
}

// ---- search ----
async function doSummonerSearch(fresh = false) {
  const body = document.querySelector('#otp-sbody');
  const raw = (document.querySelector('#otp-sinput')?.value || '').trim();
  const region = settings.region || 'tr1';
  settings.region = region; saveSettings();
  const i = raw.lastIndexOf('#');
  if (i < 1) { body.innerHTML = `<div class="otp-serr">Format: Name#TAG</div>`; return; }
  const gameName = raw.slice(0, i), tagLine = raw.slice(i + 1);
  body.innerHTML = `<div class="otp-serr">${fresh ? 'Refreshing…' : 'Searching…'}</div>`;
  document.querySelector('#otp-qtabs').classList.remove('show');
  document.querySelector('#otp-refresh').classList.remove('show');
  const res = await ipcRenderer.invoke('otp:deeplol', { region, gameName, tagLine, fresh });
  if (res?.ok) pushRecent(res.profile.name, res.profile.tag, region);
  renderSummoner(res);
}

// ---- lobby ----
async function doLobby() {
  const body = document.querySelector('#otp-sbody');
  body.innerHTML = `<div class="otp-serr">Reading lobby…</div>`;
  const res = await ipcRenderer.invoke('otp:lobby');
  if (!res || !res.ok) { body.innerHTML = `<div class="otp-serr">Error: ${res?.error || 'unknown'} (open during champion select)</div>`; return; }
  lastLobbyRes = res;
  renderLobbyList(res);
}
function renderLobbyList(res) {
  const body = document.querySelector('#otp-sbody');
  if (!body) return;
  document.body.classList.add('has-result');
  const up = document.querySelector('#otp-updated');
  if (up) up.textContent = '';
  document.querySelector('#otp-qtabs').classList.remove('show');
  const soloOf = (p) => (p.ranks || []).find((r) => r.queueType === 'RANKED_SOLO_5x5');
  body.innerHTML = `<div class="otp-ssec">My Team — click a player for full profile</div>` + res.team.map((p, idx) => {
    const s = soloOf(p);
    const sc = p.score || {};
    const tag = p.profile.tag ? ` #${p.profile.tag}` : '';
    return `<div class="otp-mrow otp-lobrow" data-idx="${idx}" style="cursor:pointer">
      <img loading="lazy" src="${p.profile.iconUrl}">
      <span><b>${esc(p.profile.name)}${esc(tag)}</b> <span class="sub">Lv ${p.profile.level}</span>${p.pick ? ` · <span class="sub">picking ${esc(p.pick)}</span>` : ''}</span>
      <span class="kda">${s ? `${s.tier} ${s.rank} · ${s.leaguePoints} LP` : 'Unranked'}</span>
      <span class="sub">${sc.wr ?? '—'}% WR · ${sc.kda ?? '—'} KDA</span>
    </div>`;
  }).join('') + (res.foes?.length ? `<div class="otp-ssec">Enemy picks</div><div class="otp-serr">${res.foes.map(esc).join(' · ')}</div>` : '');
  body.querySelectorAll('.otp-lobrow').forEach((row) => {
    row.onclick = () => openLobbyPlayer(res.team[Number(row.dataset.idx)]);
  });
}
async function openLobbyPlayer(p) {
  if (!p) return;
  const body = document.querySelector('#otp-sbody');
  const region = settings.region || 'tr1';
  const name = p.profile.name, tag = p.profile.tag;
  const showFull = async (nm, tg) => {
    body.innerHTML = `<div class="otp-serr">Loading ${esc(nm)}…</div>`;
    const res = await ipcRenderer.invoke('otp:deeplol', { region, gameName: nm, tagLine: tg });
    if (res?.ok) pushRecent(res.profile.name, res.profile.tag, region);
    renderSummoner(res, true);
  };
  if (tag) { await showFull(name, tag); return; }
  body.innerHTML = `<div class="otp-serr">Finding ${esc(name)}…</div>`;
  const li = await ipcRenderer.invoke('otp:deeplol-list', { region, gameName: name });
  const cands = ((li || {}).lists || []).filter((e) => String(e.name || '').toLowerCase() === String(name).toLowerCase());
  const back = `<div class="otp-serr" style="text-align:left;padding:0 0 8px;"><a href="javascript:void(0)" id="otp-backlob" style="color:#6cb2ff">← Back to lobby</a></div>`;
  const wireBack = () => {
    const b = document.querySelector('#otp-backlob');
    if (b) b.onclick = () => lastLobbyRes && renderLobbyList(lastLobbyRes);
  };
  if (!cands.length) { body.innerHTML = `${back}<div class="otp-serr">No match found for ${esc(name)}.</div>`; wireBack(); return; }
  if (cands.length === 1) { await showFull(cands[0].name, cands[0].tag); wireBackAfter(); return; }
  body.innerHTML = `${back}<div class="otp-ssec">Pick account for ${esc(name)}</div>` + cands.slice(0, 10).map((c, i) =>
    `<div class="otp-mrow otp-cand" data-i="${i}" style="cursor:pointer"><span><b>${esc(c.name)} #${esc(c.tag)}</b></span><span class="sub">${esc(c.tier || '')} ${c.lp ?? ''} LP · Lv ${c.level ?? '?'}</span></div>`).join('');
  wireBack();
  body.querySelectorAll('.otp-cand').forEach((row) => {
    row.onclick = async () => { const c = cands[Number(row.dataset.i)]; await showFull(c.name, c.tag); wireBackAfter(); };
  });
  function wireBackAfter() {
    const b = document.querySelector('#otp-sbody');
    if (b && lastLobbyRes) {
      b.insertAdjacentHTML('afterbegin', back);
      wireBack();
    }
  }
}

// ---- result render ----
function updKey() {
  const p = lastDlRes || {};
  return p.puuid || ((p.profile?.name || '') + '#' + (p.profile?.tag || ''));
}
// "Last updated" is deeplol's own update time for this player (updated-time), not
// when we looked: searching used to print "0m ago" while deeplol's data was hours old.
let updatingNow = false;
function paintUpdated() {
  const el = document.querySelector('#otp-updated');
  if (!el) return;
  if (updatingNow) { el.textContent = 'Updating from Riot…'; return; }
  const ts = lastDlRes?.extra?.updatedAt;
  el.textContent = ts ? `Last updated: ${timeAgo(ts) || 'just now'}` : '';
}
function markUpdated() { paintUpdated(); }

// Ranks, LP history, season champion stats, deeplol update time. Data older than
// 5 minutes is refreshed automatically (deeplol's "Update"), then the profile
// is reloaded in place.
const AUTO_RENEW_SEC = 5 * 60;
async function loadExtra(res, allowRenew = true) {
  if (!res?.ok || !res.puuid) return;
  const key = res.puuid;
  let ex = null;
  try { ex = await ipcRenderer.invoke('otp:deeplol-extra', { platform: res.platform, puuid: res.puuid, summonerId: res.summonerId }); } catch {}
  if (!lastDlRes || lastDlRes.puuid !== key || !ex) return;
  lastDlRes.extra = ex;
  paintExtra();
  paintUpdated();
  const age = ex.updatedAt ? Date.now() / 1000 - ex.updatedAt : Infinity;
  if (allowRenew && age > AUTO_RENEW_SEC) renewProfile();
}
async function renewProfile() {
  if (!lastDlRes?.puuid || updatingNow) return;
  const cur = lastDlRes;
  updatingNow = true;
  paintUpdated();
  const btn = document.querySelector('#otp-refresh');
  btn?.classList.add('spin');
  try {
    await ipcRenderer.invoke('otp:deeplol-renew', { platform: cur.platform, puuid: cur.puuid });
    const res = await ipcRenderer.invoke('otp:deeplol', { region: cur.platform, gameName: cur.profile.name, tagLine: cur.profile.tag });
    if (!lastDlRes || lastDlRes.puuid !== cur.puuid) return;
    updatingNow = false;
    if (res?.ok) {
      const firstNew = res.pendingIds?.[0]?.id;
      const firstOld = (cur.pendingIds || [])[0]?.id;
      const scroll = (document.getElementById('otp-scroll') || document.scrollingElement).scrollTop;
      if (firstNew !== firstOld) renderSummoner(res, false, true);
      else loadExtra(res, false);
      (document.getElementById('otp-scroll') || document.scrollingElement).scrollTop = scroll;
    }
  } finally {
    updatingNow = false;
    btn?.classList.remove('spin');
    paintUpdated();
  }
}

const ROLE_SLUG = { TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'mid', BOTTOM: 'bot', UTILITY: 'supp' };
// deeplol positions: Top, Jungle, Middle, Bot, Supporter (Riot: TOP ... UTILITY).
function normPos(p) {
  const x = String(p || '').toUpperCase();
  return { TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MIDDLE', MID: 'MIDDLE', BOT: 'BOTTOM', BOTTOM: 'BOTTOM', ADC: 'BOTTOM', SUPPORTER: 'UTILITY', SUPPORT: 'UTILITY', UTILITY: 'UTILITY' }[x] || '';
}
const TIER_COL = { IRON: '#8c7b72', BRONZE: '#b0816d', SILVER: '#9fb0bb', GOLD: '#d6a64b', PLATINUM: '#4fb3a9', EMERALD: '#2fb96b', DIAMOND: '#6c95f2', MASTER: '#b866dc', GRANDMASTER: '#e0605a', CHALLENGER: '#f0c75e' };
const DIVS = ['', 'I', 'II', 'III', 'IV'];
const tierName = (t) => (t ? t.charAt(0) + t.slice(1).toLowerCase() : '');
const apexTier = (t) => /MASTER|GRANDMASTER|CHALLENGER/.test(t || '');
// Champion icons (match rows, champion lists) open that champion's onetricks build.
function openBuild(champ, position) {
  if (!champ || !/^[A-Za-z]+$/.test(champ)) return;
  const role = ROLE_SLUG[normPos(position)] || '';
  ipcRenderer.send('otp:go-build', `/champions/builds/${champ}${role ? '?role=' + role : ''}`);
}
document.addEventListener('click', (e) => {
  const el = e.target.closest && e.target.closest('[data-build]');
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  openBuild(el.dataset.build, el.dataset.pos);
}, true);

// LP over the last 30 days as a small line chart (tier-chart).
function lpChartSvg(points) {
  const pts = (points || []).map((p) => {
    const t = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'].indexOf(p.tier);
    const v = t < 0 ? null : t >= 7 ? 2800 + p.league_points : t * 400 + (4 - (p.division || 4)) * 100 + p.league_points;
    return v == null ? null : { ts: p.timestamp, v, p };
  }).filter(Boolean);
  if (pts.length < 2) return '';
  const W = 260, H = 80, P = 6;
  const min = Math.min(...pts.map((x) => x.v)), max = Math.max(...pts.map((x) => x.v));
  const span = Math.max(40, max - min);
  const t0 = pts[0].ts, t1 = pts[pts.length - 1].ts || t0 + 1;
  const X = (ts) => P + ((ts - t0) / Math.max(1, t1 - t0)) * (W - 2 * P);
  const Y = (v) => H - P - ((v - min) / span) * (H - 2 * P);
  const d = pts.map((x, i) => `${i ? 'L' : 'M'}${X(x.ts).toFixed(1)},${Y(x.v).toFixed(1)}`).join(' ');
  const delta = pts[pts.length - 1].v - pts[0].v;
  const col = delta >= 0 ? '#2fb96b' : '#e0605a';
  return `<div class="otp-lpchart"><div class="otp-lpchart-head"><span>Last 30 days</span><span style="color:${col};font-weight:700">${delta >= 0 ? '+' : ''}${delta} LP</span></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>${pts.map((x) => `<circle cx="${X(x.ts).toFixed(1)}" cy="${Y(x.v).toFixed(1)}" r="2.2" fill="${col}"><title>${tierName(x.p.tier)} ${apexTier(x.p.tier) ? '' : DIVS[x.p.division] || ''} ${x.p.league_points} LP</title></circle>`).join('')}</svg></div>`;
}

function paintExtra() {
  const ex = lastDlRes?.extra;
  if (!ex) return;
  const rb = document.querySelector('#otp-rankedbox');
  if (rb) {
    const card = (label, r, hist) => {
      if (!r) return `<div class="otp-rank-q"><div class="otp-rank-top"><span class="q">${label}</span><span class="un">Unranked</span></div></div>`;
      const tot = (r.wins || 0) + (r.losses || 0);
      const wr = tot ? Math.round((r.wins / tot) * 100) : 0;
      return `<div class="otp-rank-q">
        <div class="otp-rank-top"><span class="q">${label}</span>${r.peak ? `<span class="peak">Peak ${esc(r.peak.split(' ').map((w, i) => (i ? w : tierName(w))).join(' '))}</span>` : ''}</div>
        <div class="otp-rank-main"><b style="color:${TIER_COL[r.tier] || '#e8e6e3'}">${tierName(r.tier)}${apexTier(r.tier) ? '' : ' ' + (DIVS[r.division] || '')}</b><span>${r.lp} LP</span></div>
        <div class="otp-rank-sub"><span>${r.wins}W ${r.losses}L</span><span class="${wr >= 50 ? 'up' : 'down'}">${wr}%</span></div>
        ${lpChartSvg(hist)}
      </div>`;
    };
    rb.innerHTML = card('Ranked Solo', ex.ranks?.solo, ex.lpHistory?.solo) + card('Ranked Flex', ex.ranks?.flex, ex.lpHistory?.flex);
  }
  paintSeasonChamps();
}
// Season champion stats (deeplol champion-stat) in the left column, filtered by the
// queue tab: Total / Ranked Solo / Ranked Flex.
function paintSeasonChamps() {
  const ex = lastDlRes?.extra;
  const cb = document.querySelector('#otp-champsbox');
  const cl = document.querySelector('#otp-champlabel');
  if (!ex || !cb) return;
  const qk = curQueue === 420 ? 'ranked_solo_5x5' : curQueue === 440 ? 'ranked_flex_sr' : 'total';
  const list = (ex.champStats?.[qk] || []).slice(0, 12);
  if (cl) cl.textContent = `Season champions${qk === 'total' ? '' : qk === 'ranked_solo_5x5' ? ' · Solo' : ' · Flex'}`;
  if (!list.length) { cb.innerHTML = '<div class="otp-serr" style="padding:10px;">No games this season</div>'; return; }
  const ddv = (lastDlRes.profile?.iconUrl || '').match(/cdn\/([^/]+)\//)?.[1] || '16.23.1';
  cb.innerHTML = list.map((c) => {
    const wrCol = c.wr >= 60 ? '#10b981' : c.wr <= 40 ? '#ef4444' : '#e2e8f0';
    return `<div class="otp-side-champ otp-season-champ" data-build="${esc(c.champ)}" title="Open the ${esc(c.champ)} build">
      <img src="https://ddragon.leagueoflegends.com/cdn/${ddv}/img/champion/${esc(c.champ)}.png">
      <div>
        <div class="otp-side-champ-name">${esc(c.champ)}</div>
        <div class="otp-side-champ-kda">${(c.kda ?? 0).toFixed(2)} KDA · ${(c.cspm ?? 0).toFixed(1)} CS/m</div>
      </div>
      <div class="otp-side-champ-right">
        <div class="otp-side-champ-wr" style="color:${wrCol}">${Math.round(c.wr)}%</div>
        <div class="otp-side-champ-count">${c.games} games</div>
      </div>
    </div>`;
  }).join('');
}

function renderSummoner(res, showBack, isRenew) {
  const body = document.querySelector('#otp-sbody');
  if (!body) return;
  if (!res || !res.ok) { body.innerHTML = `<div class="otp-serr">Error: ${esc(res?.error || 'unknown')}</div>`; return; }
  const prevExtra = isRenew && lastDlRes && lastDlRes.puuid === res.puuid ? lastDlRes.extra : null;
  lastDlRes = { ...res, matches: res.matches ? [...res.matches] : [], _view: [], _painted: 0, extra: prevExtra };
  document.body.classList.add('has-result');
  setTimeout(() => { loadExtra(res, !isRenew); }, 0);
  markUpdated();

  const backHtml = (showBack && lastLobbyRes) ? `<div class="otp-serr" style="text-align:left;padding:0 0 8px;"><a href="javascript:void(0)" id="otp-backlob" style="color:#6cb2ff">← Back to lobby</a></div>` : '';
  body.innerHTML = `
    ${backHtml}
    <div class="otp-sprof" style="display:flex;align-items:center;gap:16px;">
      <img src="${res.profile.iconUrl}">
      <div>
        <div style="display:flex;align-items:center;gap:10px;">
          <b style="font-size:18px;color:#fff;">${esc(res.profile.name)} <span style="color:#94a3b8;font-size:15px;">#${esc(res.profile.tag)}</span></b>
          <span class="lv">Lv ${res.profile.level}</span>
        </div>
      </div>
    </div>

    <!-- DeepLoL 3-part Stats Summary Box -->
    <div id="otp-dl-summary"></div>

    <!-- DeepLoL 2-Column Grid -->
    <div class="otp-dl-grid">
      <!-- Left Column: Ranked info + Champions sidebar -->
      <div class="otp-dl-sidebar">
        <div class="otp-side-card">
          <div class="otp-side-card-head"><span>Ranked</span></div>
          <div id="otp-rankedbox"></div>
        </div>
        <div class="otp-side-card">
          <div class="otp-side-card-head"><span id="otp-champlabel">Champions</span></div>
          <div id="otp-champsbox"></div>
        </div>
      </div>

      <!-- Right Column: Matches with spells/runes, fate, and team expandable table -->
      <div class="otp-dl-main">
        <div id="otp-matchlist">${(res.pendingIds?.length) ? '<div class="otp-serr" id="otp-mloading">Loading matches…</div>' : ''}</div>
        <div class="otp-serr" style="font-size:11px">Scores and Fate are computed from match participants. Click any row for team details.</div>
      </div>
    </div>`;

  const bb = body.querySelector('#otp-backlob');
  if (bb) bb.onclick = () => renderLobbyList(lastLobbyRes);
  document.querySelector('#otp-qtabs').classList.add('show');
  document.querySelector('#otp-refresh').classList.add('show');
  renderQtabs();
  if (res.pendingIds?.length) {
    loadMatchChunks(res);
  } else {
    paintMatchData();
  }
}

function dlStats() {
  const ms = lastDlRes?._view || [];
  let w = 0, k = 0, d = 0, a = 0, aiSum = 0, aiN = 0;
  let diffSum = 0, diffN = 0;
  const roles = { TOP: 0, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, UTILITY: 0 };

  ms.forEach((m) => {
    if (m.win) w++; k += m.kills; d += m.deaths; a += m.assists;
    if (typeof m.ai === 'number') { aiSum += m.ai; aiN++; }
    if (typeof m.teamDiff === 'number') { diffSum += m.teamDiff; diffN++; }
    const pos = normPos(m.position);
    if (pos && roles[pos] !== undefined) roles[pos]++;
  });

  const n = ms.length || 1;
  const wr = Math.round((w / n) * 100);
  const kda = ((k + a) / Math.max(1, d)).toFixed(2);
  const avgK = (k / n).toFixed(1);
  const avgD = (d / n).toFixed(1);
  const avgA = (a / n).toFixed(1);
  const aiAvg = aiN ? Math.round(aiSum / aiN) : null;
  const avgDiff = diffN ? (diffSum / diffN) : 0;

  // Exact DeepLoL Fate calculation based on teammate difference vs opponent
  let fate = { type: 'balanced', label: 'Balanced', pct: 50 };
  if (diffN > 0) {
    if (avgDiff >= 2.0) {
      fate = { type: 'godlike', label: 'Godlike', pct: Math.min(10, Math.max(1, Math.round(20 - avgDiff * 2))) };
    } else if (avgDiff >= 0.5) {
      fate = { type: 'solid', label: 'Solid', pct: Math.min(30, Math.max(11, Math.round(40 - avgDiff * 5))) };
    } else if (avgDiff <= -3.0) {
      fate = { type: 'messy', label: 'Messy', pct: Math.min(99, Math.max(70, Math.round(65 - avgDiff * 3))) };
    } else if (avgDiff <= -1.0) {
      fate = { type: 'messy', label: 'Unlucky', pct: Math.min(75, Math.max(55, Math.round(50 - avgDiff * 4))) };
    } else {
      fate = { type: 'balanced', label: 'Balanced', pct: 50 };
    }
  }

  const champs = {};
  ms.forEach((m) => {
    const c = (champs[m.champ] = champs[m.champ] || { champ: m.champ, icon: m.icon, g: 0, w: 0, k: 0, d: 0, a: 0 });
    c.g++; if (m.win) c.w++; c.k += m.kills; c.d += m.deaths; c.a += m.assists;
  });

  return {
    n: ms.length, w, l: ms.length - w, wr, kda, avgK, avgD, avgA, aiAvg, fate,
    roles,
    value: Math.min(9999, Math.round(wr * 50 + ((k + a) / Math.max(1, d)) * 120)),
    champs: Object.values(champs).sort((x, y) => y.g - x.g)
  };
}

function aiColor(v) {
  if (v == null) return null;
  if (v >= 85) return ['#ffd166', '#111'];
  if (v >= 70) return ['#059669', '#fff'];
  if (v >= 50) return ['#0d9488', '#fff'];
  if (v >= 40) return ['#b45309', '#fff'];
  return ['#b91c1c', '#fff'];
}
function aiBadge(v) {
  const c = aiColor(v);
  if (!c) return '';
  return `<span class="otp-dl-aiscore-badge" title="AI-Score" style="background:${c[0]};color:${c[1]}">${Math.round(v)}</span>`;
}

function timeAgo(ts) {
  if (!ts) return '';
  const ms = ts > 1e12 ? ts : ts * 1000;
  const d = Date.now() - ms;
  if (d < 0) return '';
  const m = Math.floor(d / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  const dt = new Date(ms);
  return `${String(dt.getDate()).padStart(2, '0')}.${String(dt.getMonth() + 1).padStart(2, '0')}.${dt.getFullYear()}`;
}

function matchRowHtml(m, mi) {
  const kRatio = ((m.kills + m.assists) / Math.max(1, m.deaths));
  const kda = kRatio.toFixed(2);

  let matchFate = { type: 'balanced', label: 'Balanced' };
  if (typeof m.teamDiff === 'number') {
    if (m.teamDiff >= 8) matchFate = { type: 'godlike', label: 'Godlike' };
    else if (m.teamDiff >= 1.5) matchFate = { type: 'solid', label: 'Solid' };
    else if (m.teamDiff <= -8) matchFate = { type: 'messy', label: 'Messy' };
    else matchFate = { type: 'balanced', label: 'Balanced' };
  }

  const cloudSvg = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`;

  const spellsHtml = (m.spells || []).map((s) => `<img src="${s}">`).join('');
  const runesHtml = (m.runes || []).map((r) => `<img src="${r}">`).join('');

  return `
    <div class="otp-mrow ${m.win ? 'win' : 'lose'} otp-mexp" data-mi="${mi}" style="cursor:pointer" title="Click for team details">
      <div class="otp-m-meta">
        <span class="otp-m-queue">${esc(qname(m.queue))}</span>
        <span class="otp-m-time">${m.ts ? timeAgo(m.ts) : ''}</span>
        <span class="otp-m-result ${m.win ? 'win' : 'lose'}">${m.win ? 'Win' : 'Lose'}${m.dur ? ` ${Math.floor(m.dur/60)}:${String(m.dur%60).padStart(2,'0')}` : ''}</span>
      </div>

      <div class="otp-m-champbox">
        <img class="champ-icon" loading="lazy" src="${m.icon}" title="${esc(m.champ)} build" data-build="${esc(m.champ)}" data-pos="${esc(m.position || '')}">
        <div class="otp-m-spells-runes">
          ${spellsHtml}
          ${runesHtml}
        </div>
      </div>

      <div class="otp-m-kda">
        <div class="otp-m-kda-nums">${m.kills} / <span style="color:#ef4444">${m.deaths}</span> / ${m.assists}</div>
        <div class="otp-m-kda-ratio">${kda} KDA</div>
      </div>

      <div class="otp-m-ai">
        ${aiBadge(m.ai)}
        ${m.mvp ? `<span class="otp-m-tag tag-mvp">👑 MVP</span>` : m.ace ? `<span class="otp-m-tag tag-ace">ACE</span>` : ''}
      </div>

      <div class="otp-m-tagbox">
        <span class="otp-m-tag tag-${matchFate.type}">${cloudSvg} Fate: ${matchFate.label}</span>
      </div>

      <div style="font-size:11px;color:#8f96a3;text-align:right;">
        <span>${m.cs || 0} CS</span>
      </div>
    </div>
    <div id="otp-mexp-${mi}" style="display:none;margin:6px 0 14px 0;"></div>`;
}

function paintMatchData() {
  if (!lastDlRes) return;
  const all = lastDlRes.matches || [];
  lastDlRes._view = curQueue === 'all' ? all : all.filter((m) => m.queue === curQueue);
  const st = dlStats();
  lastDlRes.score = { value: st.value, wr: st.wr, kda: st.kda, games: st.n, aiAvg: st.aiAvg };

  // 1. DeepLoL 3-Part Summary Block
  const sumEl = document.querySelector('#otp-dl-summary');
  if (sumEl) {
    if (st.n > 0) {
      const circleBorder = st.wr >= 50 ? '#10b981' : '#ef4444';
      const cloudSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`;

      const champsMiniHtml = st.champs.slice(0, 3).map((c) => {
        const cwr = c.g ? Math.round((c.w / c.g) * 100) : 0;
        const ckda = ((c.k + c.a) / Math.max(1, c.d)).toFixed(2);
        const wrCol = cwr >= 60 ? '#10b981' : cwr <= 40 ? '#ef4444' : '#e2e8f0';
        return `
          <div class="otp-sum-champ-row">
            <img src="${c.icon}">
            <div class="otp-sum-champ-meta">
              <div><span style="font-weight:700;color:${wrCol}">${cwr}%</span> <span style="color:#8f96a3;">(${c.w}W ${c.g - c.w}L)</span></div>
              <div class="otp-sum-champ-kda">${ckda} KDA</div>
            </div>
          </div>`;
      }).join('');

      // Top roles distribution
      const rMax = Math.max(1, st.roles.TOP, st.roles.JUNGLE, st.roles.MIDDLE, st.roles.BOTTOM, st.roles.UTILITY);
      const roleBar = (cnt, lbl) => {
        const h = Math.max(4, Math.round((cnt / rMax) * 36));
        const col = cnt > 0 ? (cnt === rMax ? '#3b82f6' : '#1e3a8a') : '#1c202d';
        return `<div class="otp-role-bar-wrap"><div class="otp-role-bar" style="height:${h}px;background:${col};"></div><span class="otp-role-icon">${lbl}</span></div>`;
      };

      sumEl.innerHTML = `
        <div class="otp-dl-summary-box">
          <div class="otp-sum-col-main">
            <div class="otp-sum-circle" style="border-color:${circleBorder};">
              <span>${st.wr}%</span>
            </div>
            <div class="otp-sum-details">
              <div class="otp-sum-row-top">
                <span class="otp-sum-games">${st.n} Games</span>
                <span class="otp-sum-kda">${st.kda} KDA</span>
                <span class="otp-sum-score">${st.aiAvg ?? st.value} <span style="font-size:10px;color:#8f96a3;font-weight:normal;">AI-Score</span></span>
              </div>
              <div class="otp-sum-row-sub">
                <span>${st.w}W ${st.l}L</span>
                <span>${st.avgK} / <span style="color:#ef4444">${st.avgD}</span> / ${st.avgA}</span>
              </div>
              <div class="otp-sum-row-badges">
                <div class="otp-sum-badge-card">
                  <span style="color:#8f96a3;">AI Tier:</span>
                  <span style="color:#ffd166;font-weight:600;">Prediction</span>
                </div>
                <div class="otp-sum-badge-card">
                  <span style="display:inline-flex;align-items:center;gap:4px;color:#60a5fa;font-weight:600;">
                    ${cloudSvg} Fate: ${st.fate.label} <span style="color:#94a3b8;font-size:10px;">(Top ${st.fate.pct}%)</span>
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div class="otp-sum-col-champs">
            <span class="otp-roles-title">Champion Played</span>
            ${champsMiniHtml}
          </div>

          <div class="otp-sum-col-roles">
            <span class="otp-roles-title">Top Roles</span>
            <div class="otp-roles-bars">
              ${roleBar(st.roles.TOP, 'TOP')}
              ${roleBar(st.roles.JUNGLE, 'JGL')}
              ${roleBar(st.roles.MIDDLE, 'MID')}
              ${roleBar(st.roles.BOTTOM, 'BOT')}
              ${roleBar(st.roles.UTILITY, 'SUP')}
            </div>
          </div>
        </div>`;
    } else {
      sumEl.innerHTML = '';
    }
  }

  // 2. Left Column: Ranked box
  const rb = document.querySelector('#otp-rankedbox');
  if (rb) {
    rb.innerHTML = (lastDlRes.ranks || []).map((r) => {
      const q = r.queueType === 'RANKED_SOLO_5x5' ? 'Solo' : r.queueType === 'RANKED_FLEX_SR' ? 'Flex' : r.queueType;
      const tot = (r.wins ?? 0) + (r.losses ?? 0);
      const wr = tot ? Math.round((r.wins / tot) * 100) : 0;
      const wl = (r.wins == null) ? '' : `<div style="font-size:11px;color:#8f96a3;">${r.wins}W ${r.losses}L (${wr}%)</div>`;
      return `
        <div style="padding:6px 0;border-bottom:1px solid #1f232e;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:11px;color:#8f96a3;">${q}</span>
            <span style="font-size:12px;font-weight:700;color:#f3f4f6;">${r.tier} ${r.rank}</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px;">
            <span style="font-size:11px;color:#60a5fa;">${r.leaguePoints} LP</span>
            ${wl}
          </div>
        </div>`;
    }).join('') || `<div class="otp-serr" style="padding:10px;">Unranked</div>`;
  }

  // 3. Left Column: Champions Sidebar list
  const cl = document.querySelector('#otp-champlabel');
  if (cl) cl.textContent = `Champions (${st.n})`;
  const cb = document.querySelector('#otp-champsbox');
  if (cb) {
    cb.innerHTML = st.champs.slice(0, 6).map((c) => {
      const cwr = c.g ? Math.round((c.w / c.g) * 100) : 0;
      const ckda = ((c.k + c.a) / Math.max(1, c.d)).toFixed(2);
      const wrColor = cwr >= 60 ? '#10b981' : cwr <= 40 ? '#ef4444' : '#e2e8f0';
      return `
        <div class="otp-side-champ">
          <img src="${c.icon}">
          <div>
            <div class="otp-side-champ-name">${esc(c.champ)}</div>
            <div class="otp-side-champ-kda">${ckda} KDA</div>
          </div>
          <div class="otp-side-champ-right">
            <div class="otp-side-champ-wr" style="color:${wrColor}">${cwr}%</div>
            <div class="otp-side-champ-count">${c.g} games</div>
          </div>
        </div>`;
    }).join('');
  }

  // 4. Right Column: Match List
  const ml = document.querySelector('#otp-matchlist');
  if (ml) {
    ml.innerHTML = lastDlRes._view.map((m, k) => matchRowHtml(m, k)).join('') || `<div class="otp-serr">No matches for this filter</div>`;
    const nf = (lastDlRes._failed || []).length;
    if (nf) {
      const reasons = {};
      lastDlRes._failed.forEach((f) => {
        const r = typeof f === 'string' ? 'unknown' : (f.reason || 'unknown');
        reasons[r] = (reasons[r] || 0) + 1;
      });
      const why = Object.entries(reasons).map(([r, n]) => `${n}× ${esc(r)}`).join(', ');
      ml.insertAdjacentHTML('beforeend', `<div class="otp-serr" id="otp-retry">${nf} match${nf > 1 ? 'es' : ''} couldn't load (${why}). <a href="javascript:void(0)" id="otp-retrybtn" style="color:#6cb2ff">Retry →</a></div>`);
    }
    const rb = document.querySelector('#otp-retrybtn');
    if (rb) rb.onclick = () => retryFailedMatches();
    ml.querySelectorAll('.otp-mexp').forEach((row) => {
      row.onclick = () => toggleMatchExpand(Number(row.dataset.mi));
    });
  }
  renderQtabs();
  if (lastDlRes.extra) paintExtra();
}

async function loadMatchChunks(res) {
  const items = res.pendingIds || [];
  const ids = items.map((x) => (typeof x === 'string' ? x : x.id));
  lastDlRes.moreOffset = ids.length;
  const tsArr = items.map((x) => (typeof x === 'string' ? null : x.ts)).filter((t) => t != null);
  lastDlRes.moreTs = tsArr.length ? tsArr[tsArr.length - 1] : 1;
  lastDlRes._failed = [];
  const setLoading = (txt) => {
    const ld = document.querySelector('#otp-mloading');
    if (ld) ld.textContent = txt;
  };
  for (let s = 0; s < ids.length; s += 10) {
    let chunk = { matches: [] };
    try {
      chunk = await ipcRenderer.invoke('otp:deeplol-matches', { platform: res.platform, puuid: res.puuid, ids: ids.slice(s, s + 10) });
    } catch {}
    if (!lastDlRes || lastDlRes.puuid !== res.puuid) return;
    for (const m of chunk.matches || []) lastDlRes.matches.push(m);
    for (const f of chunk.failed || []) lastDlRes._failed.push(f);
    setLoading(`Loading matches (${lastDlRes.matches.length}/${ids.length})…`);
    paintMatchData();
  }
  const ld = document.querySelector('#otp-mloading');
  if (ld) ld.remove();
  paintMatchData();
  paintMoreBtn();
}

function paintMoreBtn() {
  const ml = document.querySelector('#otp-matchlist');
  if (!ml) return;
  let btn = document.querySelector('#otp-morebtn');
  const loaded = (lastDlRes?.matches || []).length;
  if (loaded < 10) { if (btn) btn.remove(); return; }
  if (!btn) {
    ml.insertAdjacentHTML('afterend', `<div class="otp-serr"><button id="otp-morebtn" style="background:rgb(35,38,41);border:1px solid rgb(85,85,85);color:#e8e6e3;border-radius:6px;font-size:12px;padding:7px 18px;cursor:pointer;">Load older matches</button></div>`);
    btn = document.querySelector('#otp-morebtn');
    btn.onclick = () => loadMoreMatches();
  }
  btn.disabled = false;
  btn.textContent = `Load older matches (${loaded} loaded)`;
}

async function loadMoreMatches() {
  const btn = document.querySelector('#otp-morebtn');
  if (!btn || !lastDlRes) return;
  btn.disabled = true;
  btn.textContent = 'Loading…';
  let more = { ids: [] };
  try {
    more = await ipcRenderer.invoke('otp:deeplol-more', {
      platform: lastDlRes.platform, puuid: lastDlRes.puuid,
      offset: lastDlRes.moreOffset || 0, lastTs: lastDlRes.moreTs || 1
    });
  } catch {}
  const items = more.ids || [];
  if (!items.length) {
    btn.textContent = 'No older matches';
    btn.disabled = true;
    return;
  }
  lastDlRes.moreOffset = (lastDlRes.moreOffset || 0) + items.length;
  const tsArr = items.map((x) => x.ts).filter((t) => t != null);
  if (tsArr.length) lastDlRes.moreTs = tsArr[tsArr.length - 1];
  await loadIds(items.map((x) => x.id));
  paintMoreBtn();
}

async function loadIds(ids) {
  for (let s = 0; s < ids.length; s += 10) {
    let chunk = { matches: [] };
    try {
      chunk = await ipcRenderer.invoke('otp:deeplol-matches', { platform: lastDlRes.platform, puuid: lastDlRes.puuid, ids: ids.slice(s, s + 10) });
    } catch {}
    if (!lastDlRes) return;
    for (const m of chunk.matches || []) lastDlRes.matches.push(m);
    for (const f of chunk.failed || []) lastDlRes._failed.push(f);
    paintMatchData();
  }
}

async function retryFailedMatches() {
  if (!lastDlRes?._failed?.length) return;
  const ids = (lastDlRes._failed || []).map((f) => (typeof f === 'string' ? f : f.id));
  if (!ids.length) return;
  lastDlRes._failed = [];
  const ml = document.querySelector('#otp-matchlist');
  let chunk = { matches: [] };
  try {
    chunk = await ipcRenderer.invoke('otp:deeplol-matches', { platform: lastDlRes.platform, puuid: lastDlRes.puuid, ids });
  } catch {}
  for (const m of chunk.matches || []) lastDlRes.matches.push(m);
  for (const f of chunk.failed || []) lastDlRes._failed.push(f);
  paintMatchData();
}

function toggleMatchExpand(mi) {
  const box = document.getElementById('otp-mexp-' + mi);
  const m = lastDlRes?._view?.[mi];
  if (!box || !m?.teams?.length) return;
  if (box.style.display !== 'none') { box.style.display = 'none'; box.innerHTML = ''; return; }
  const prof = lastDlRes?.profile || {};
  const me = m.teams.find((t) => String(t.name).toLowerCase() === String(prof.name || '').toLowerCase() && String(t.tag || '').toLowerCase() === String(prof.tag || '').toLowerCase());
  const order = me ? [me.side, me.side === 'BLUE' ? 'RED' : 'BLUE'] : ['BLUE', 'RED'];
  const fmt = (n) => (n ?? 0).toLocaleString('en-US');
  const kda0 = (t) => ((t.kills + t.assists) / Math.max(1, t.deaths)).toFixed(2);
  const ord = (n) => n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
  const allSorted = [...m.teams].sort((a, b) => (b.ai ?? -1) - (a.ai ?? -1));
  const mvp = allSorted[0];
  const maxDmg = Math.max(1, ...m.teams.map((t) => t.dmg || 0));
  const cspm = (cs) => (m.dur && cs != null) ? ` (${(cs / (m.dur / 60)).toFixed(1)}/m)` : '';

  const board = order.map((side) => {
    const ts = m.teams.filter((t) => t.side === side);
    if (!ts.length) return '';
    const won = ts[0].win;
    const isBlue = side === 'BLUE';
    const ranked = [...ts].sort((a, b) => (b.ai ?? -1) - (a.ai ?? -1));

    return `<div class="otp-dl-card ${isBlue ? 'side-blue' : 'side-red'} ${won ? 'win' : 'lose'}">
      <div class="otp-dl-head">
        <div class="otp-dl-head-left">
          <span class="otp-dl-badge ${won ? 'win' : 'lose'}">${won ? 'Win' : 'Lose'}</span>
          <span class="otp-dl-teamname">(${isBlue ? 'Blue' : 'Red'} Team)</span>
        </div>
        <div class="otp-dl-head-cols">
          <span class="col-ai">AI-Score</span>
          <span class="col-kda">KDA</span>
          <span class="col-dmg">Damage</span>
          <span class="col-cs">CS</span>
          <span class="col-items">Items (Click)</span>
        </div>
      </div>
      <div class="otp-dl-rows">` + ranked.map((t) => {
        const rk = ranked.indexOf(t) + 1;
        const isMvp = t === mvp && t.win;
        const kRatio = ((t.kills + t.assists) / Math.max(1, t.deaths));
        const kRatioStr = kRatio.toFixed(2);
        const dmgPct = Math.min(100, Math.round((t.dmg / maxDmg) * 100));

        const items = t.items || [];
        let itemsHtml = '';
        for (let idx = 0; idx < 6; idx++) {
          const it = items[idx];
          if (it && it.icon) {
            itemsHtml += `<img class="otp-dl-item" loading="lazy" src="${it.icon}" title="${it.id}">`;
          } else {
            itemsHtml += `<span class="otp-dl-item empty"></span>`;
          }
        }
        const trinket = t.trinket || items[6];
        if (trinket && trinket.icon) {
          itemsHtml += `<img class="otp-dl-item trinket" loading="lazy" src="${trinket.icon}" title="${trinket.id}">`;
        } else {
          itemsHtml += `<span class="otp-dl-item empty trinket"></span>`;
        }

        return `<div class="otp-dl-row">
          <div class="otp-dl-pcell">
            <div class="otp-dl-iconwrap">
              <img class="champ-img" loading="lazy" src="${t.icon}" title="${esc(t.champ)} build" data-build="${esc(t.champ)}" data-pos="${esc(t.position || '')}">
              ${t.lvl ? `<span class="champ-lvl">${t.lvl}</span>` : ''}
            </div>
            ${t.tier ? `<span class="otp-dl-tier tier-${String(t.tier).toLowerCase().slice(0, 1)}">${esc(t.tier.slice(0, 2))}</span>` : ''}
            <div class="otp-dl-namebox">
              <div class="p-name otp-plink" data-name="${esc(t.name)}" data-tag="${esc(t.tag || '')}" title="Open profile">${esc(t.name)} <span class="p-tag">${t.tag ? `#${esc(t.tag)}` : ''}</span></div>
              <div class="p-champ">${esc(t.champ)}</div>
            </div>
          </div>
          <div class="otp-dl-aicell">
            ${aiBadge(t.ai)}
            <span class="otp-dl-rank ${isMvp ? 'mvp' : ''}">${isMvp ? '👑 1st' : ord(rk)}</span>
          </div>
          <div class="otp-dl-kdacell">
            <div class="kda-nums">${t.kills} / ${t.deaths} / ${t.assists}</div>
            <div class="kda-ratio ${kRatio >= 4 ? 'high' : ''}">${kRatioStr}</div>
          </div>
          <div class="otp-dl-dmgcell">
            <div class="dmg-num">${fmt(t.dmg)}</div>
            <div class="dmg-bar-bg"><div class="dmg-bar-fill" style="width:${dmgPct}%"></div></div>
          </div>
          <div class="otp-dl-cscell">
            <div class="cs-num">${fmt(t.cs)}</div>
            <div class="cs-pm">${cspm(t.cs).trim()}</div>
          </div>
          <div class="otp-dl-itemscell">
            ${itemsHtml}
          </div>
        </div>`;
      }).join('') + `</div>
    </div>`;
  }).join('');
  box.innerHTML = matchTabsHtml(m, board);
  wireMatchTabs(box);
  wireWinChance(box, m);
  box.style.display = 'block';
  box.querySelectorAll('.otp-plink').forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); openPlayerProfile(el.dataset.name, el.dataset.tag); };
  });
}

// ---- Match detail tabs: Scoreboard / Build / Win chance ----
const SKILL_KEYS = ['', 'Q', 'W', 'E', 'R'];
function matchTabsHtml(m, board) {
  const b = m.build || {};
  const items = (b.items || []).map((g) => `<div class="otp-bt-step"><div class="otp-bt-ics">${g.items.map((it) => `<img src="${it.icon}" alt="" title="${it.id}">`).join('')}</div><span>${g.min}m</span></div>`).join('<span class="otp-bt-arr">›</span>');
  const sk = b.skills || [];
  const order = (() => { // max order: first basic skill to reach 5 points, then the next
    const cnt = { 1: 0, 2: 0, 3: 0 }; const done = [];
    for (const s of sk) { if (s >= 1 && s <= 3) { cnt[s]++; if (cnt[s] === 5 && !done.includes(s)) done.push(s); } }
    for (const s of [1, 2, 3]) if (!done.includes(s)) done.push(s);
    return done;
  })();
  const grid = [1, 2, 3, 4].map((k) => `<div class="otp-sk-row"><span class="otp-sk-key">${SKILL_KEYS[k]}</span>${Array.from({ length: 18 }, (_, i) => `<span class="otp-sk-cell${sk[i] === k ? ' on k' + k : ''}">${sk[i] === k ? i + 1 : ''}</span>`).join('')}</div>`).join('');
  const rn = b.runes || {};
  const ric = (src, cls = '') => (src ? `<img class="${cls}" src="${src}" alt="">` : '');
  const buildHtml = `
    <div class="otp-bt-sec"><h5>Items</h5><div class="otp-bt-items">${items || '<span class="otp-serr">No purchase data</span>'}</div></div>
    <div class="otp-bt-sec"><h5>Skill order <span class="otp-bt-max">${order.map((s) => SKILL_KEYS[s]).join(' › ')}</span></h5><div class="otp-sk-grid">${grid}</div></div>
    <div class="otp-bt-sec"><h5>Runes</h5><div class="otp-bt-runes">
      <div class="otp-rn-tree">${ric(rn.primaryStyle, 'style')}${(rn.primary || []).map((x, i) => ric(x, i ? '' : 'key')).join('')}</div>
      <div class="otp-rn-tree">${ric(rn.subStyle, 'style')}${(rn.secondary || []).map((x) => ric(x)).join('')}</div>
    </div></div>`;
  return `<div class="otp-xtabs"><button class="on" data-x="board">Scoreboard</button><button data-x="build">Build</button><button data-x="wc">Win chance</button></div>
    <div class="otp-xpane" data-x="board">${board}</div>
    <div class="otp-xpane" data-x="build" hidden>${buildHtml}</div>
    <div class="otp-xpane" data-x="wc" hidden>${winChanceSvg(m)}</div>`;
}
function wireMatchTabs(box) {
  box.querySelectorAll('.otp-xtabs button').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      box.querySelectorAll('.otp-xtabs button').forEach((x) => x.classList.toggle('on', x === b));
      box.querySelectorAll('.otp-xpane').forEach((p) => { p.hidden = p.dataset.x !== b.dataset.x; });
    };
  });
}
// Your team's chance to win over the game (deeplol time_analysis).
function winChanceSvg(m) {
  const pts = m.winChance || [];
  if (pts.length < 2) return '<div class="otp-serr">No timeline for this match</div>';
  const W = 760, H = 220, L = 34, R = 10, T = 12, B = 26;
  const tMax = Math.max(...pts.map((p) => p.t), 1);
  const X = (t) => L + (t / tMax) * (W - L - R);
  const Y = (v) => T + (1 - v / 100) * (H - T - B);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.wr).toFixed(1)}`).join(' ');
  const area = d + ` L${X(pts[pts.length - 1].t).toFixed(1)},${Y(50)} L${X(pts[0].t).toFixed(1)},${Y(50)} Z`;
  const ticks = []; for (let t = 0; t <= tMax; t += 5) ticks.push(t);
  const last = pts[pts.length - 1].wr;
  const col = m.win ? '#4f9be8' : '#e0605a';
  return `<div class="otp-wc"><div class="otp-wc-head"><span>Your team's chance to win</span><b style="color:${m.win ? '#4f9be8' : '#e0605a'}">${m.win ? 'Win' : 'Loss'}</b></div>
    <svg viewBox="0 0 ${W} ${H}">
      ${[0, 25, 50, 75, 100].map((v) => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 50 ? '#656e73' : '#2c2f31'}" stroke-dasharray="${v === 50 ? '' : '3 4'}"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${v}%</text>`).join('')}
      ${ticks.map((t) => `<text x="${X(t)}" y="${H - 8}" text-anchor="middle">${t}m</text>`).join('')}
      <path d="${area}" fill="${m.win ? 'rgba(79,155,232,.16)' : 'rgba(224,96,90,.14)'}"/>
      <path d="${d}" fill="none" stroke="${col}" stroke-width="2.2" stroke-linejoin="round"/>
      <line class="wc-hl" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="#c2baaf" stroke-width="1" stroke-dasharray="3 3" visibility="hidden"/>
      <circle class="wc-dot" r="5" fill="${col}" stroke="#fff" stroke-width="2" visibility="hidden"/>
      <rect class="wc-hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
    </svg><div class="wc-tip" hidden></div></div>`;
}
// Hover on the win chance chart: nearest event gets a guide line, a dot and a
// "12m · 63.4% (▲4.1)" label (like deeplol's AI graph).
function wireWinChance(box, m) {
  const wrap = box.querySelector('.otp-wc');
  const svg = wrap && wrap.querySelector('svg');
  const pts = m.winChance || [];
  if (!svg || pts.length < 2) return;
  const W = 760, H = 220, L = 34, R = 10, T = 12, B = 26;
  const tMax = Math.max(...pts.map((p) => p.t), 1);
  const X = (t) => L + (t / tMax) * (W - L - R);
  const Y = (v) => T + (1 - v / 100) * (H - T - B);
  const hl = svg.querySelector('.wc-hl'), dot = svg.querySelector('.wc-dot'), tip = wrap.querySelector('.wc-tip');
  const hide = () => { hl.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  svg.addEventListener('mouseleave', hide);
  svg.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * W;
    if (sx < L || sx > W - R) { hide(); return; }
    const t = ((sx - L) / (W - L - R)) * tMax;
    let i = 0;
    for (let k = 1; k < pts.length; k++) if (Math.abs(pts[k].t - t) < Math.abs(pts[i].t - t)) i = k;
    const p = pts[i], prev = pts[Math.max(0, i - 1)];
    const x = X(p.t), y = Y(p.wr);
    hl.setAttribute('x1', x); hl.setAttribute('x2', x); hl.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('visibility', 'visible');
    const delta = p.wr - prev.wr;
    const up = p.wr >= 50;
    tip.innerHTML = `<b style="color:${up ? '#4f9be8' : '#e0605a'}">${p.wr.toFixed(1)}%</b> <span style="color:${delta >= 0 ? '#2fb96b' : '#e0605a'}">(${delta >= 0 ? '▲' : '▼'}${Math.abs(delta).toFixed(1)})</span><div>${Math.floor(p.t)}:${String(Math.round((p.t % 1) * 60)).padStart(2, '0')}</div>`;
    tip.hidden = false;
    const wr = wrap.getBoundingClientRect();
    const px = r.left - wr.left + (x / W) * r.width;
    const py = r.top - wr.top + (y / H) * r.height;
    tip.style.left = Math.max(4, Math.min(wr.width - tip.offsetWidth - 4, px - tip.offsetWidth / 2)) + 'px';
    tip.style.top = Math.max(4, py - tip.offsetHeight - 12) + 'px';
  });
}

async function openPlayerProfile(name, tag) {
  if (!name) return;
  const body = document.querySelector('#otp-sbody');
  if (!body) return;
  const region = lastDlRes?.platform || settings.region || 'tr1';
  if (!tag) {
    const li = await ipcRenderer.invoke('otp:deeplol-list', { region, gameName: name });
    const cands = ((li || {}).lists || []).filter((e) => String(e.name || '').toLowerCase() === String(name).toLowerCase());
    if (cands.length === 1) { tag = cands[0].tag; }
    else if (!cands.length) { toast(`No match found for ${name}`); return; }
    else {
      body.innerHTML = `<div class="otp-ssec">Pick account for ${esc(name)}</div>` + cands.slice(0, 10).map((c, i) =>
        `<div class="otp-mrow otp-cand" data-i="${i}" style="cursor:pointer"><span><b>${esc(c.name)} #${esc(c.tag)}</b></span><span class="sub">${esc(c.tier || '')} ${c.lp ?? ''} LP · Lv ${c.level ?? '?'}</span></div>`).join('');
      body.querySelectorAll('.otp-cand').forEach((row) => {
        row.onclick = async () => {
          const c = cands[Number(row.dataset.i)];
          body.innerHTML = `<div class="otp-serr">Loading ${esc(c.name)}…</div>`;
          const res = await ipcRenderer.invoke('otp:deeplol', { region, gameName: c.name, tagLine: c.tag });
          if (res?.ok) pushRecent(res.profile.name, res.profile.tag, region);
          renderSummoner(res);
        };
      });
      document.querySelector('#otp-qtabs').classList.remove('show');
      document.querySelector('#otp-refresh').classList.remove('show');
      (document.getElementById('otp-scroll') || window).scrollTo({ top: 0 });
      return;
    }
  }
  body.innerHTML = `<div class="otp-serr">Loading ${esc(name)}…</div>`;
  const res = await ipcRenderer.invoke('otp:deeplol', { region, gameName: name, tagLine: tag });
  if (res?.ok) pushRecent(res.profile.name, res.profile.tag, region);
  renderSummoner(res);
  (document.getElementById('otp-scroll') || window).scrollTo({ top: 0 });
}

function syncRegBadge() {
  const b = document.querySelector('#otp-sregbtn');
  if (b) b.textContent = (settings.region || 'tr1').replace(/1$/, '').toUpperCase() + ' ▾';
  document.querySelectorAll('#otp-reglist div').forEach((d) => {
    d.classList.toggle('sel', d.dataset.v === settings.region);
  });
}

window.addEventListener('DOMContentLoaded', () => {
  const list = document.querySelector('#otp-reglist');
  REGIONS.forEach((r) => {
    const d = document.createElement('div');
    d.dataset.v = r; d.textContent = shortReg(r);
    d.onclick = (e) => { e.stopPropagation(); settings.region = r; saveSettings(); syncRegBadge(); list.classList.remove('open'); };
    list.appendChild(d);
  });
  syncRegBadge();
  document.querySelector('#otp-sregbtn').onclick = (e) => { e.stopPropagation(); list.classList.toggle('open'); };
  document.addEventListener('click', () => list.classList.remove('open'));
  document.querySelector('#otp-back').onclick = () => ipcRenderer.send('otp:go-home');
  const go = () => doSummonerSearch();
  const sgo = document.querySelector('#otp-sgo');
  if (sgo) sgo.onclick = go;
  const sgoicon = document.querySelector('#otp-sgoicon');
  if (sgoicon) sgoicon.onclick = go;
  document.querySelector('#otp-slobby').onclick = () => doLobby();
  document.querySelector('#otp-refresh').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.classList.add('spin');
    try {
      const inp = document.querySelector('#otp-sinput');
      if (lastDlRes?.puuid) await renewProfile();
      else if (inp && inp.value.trim()) await doSummonerSearch(true);
      else if (lastLobbyRes) await doLobby();
    } finally {
      btn.classList.remove('spin');
    }
  };
  document.querySelector('#otp-sinput').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  document.querySelector('#otp-sinput').focus();
  renderRecents();
  renderQtabs();
  const tl = document.querySelector('#otp-toplobby');
  if (tl) tl.onclick = () => doLobby();
});
// Header search (shell.js, summoner mode): { name, tag, region? }.
window.addEventListener('otp-summoner-search', (e) => {
  let p = null;
  try { p = JSON.parse(e.detail || 'null'); } catch {}
  if (!p || !p.name || !p.tag) return;
  if (p.region) { settings.region = p.region; saveSettings(); syncRegBadge(); }
  const inp = document.querySelector('#otp-sinput');
  if (inp) inp.value = `${p.name}#${p.tag}`;
  doSummonerSearch();
});

// Shared header (shell.js): route [data-go] clicks to main.
document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest && e.target.closest('#otp-shell-header [data-go]');
  if (!a) return;
  e.preventDefault();
  ipcRenderer.send('otp:go', a.dataset.go);
});

// Shared header: champion search -> build page; native caption buttons take the
// header's color/height (#212324, 56 px) like on the site's inner pages.
// shell.js fires 'otp-open-champ' with the champion name when a suggestion is picked.
document.addEventListener('otp-open-champ', (e) => {
  const id = e && e.detail;
  if (typeof id === 'string' && id) ipcRenderer.send('otp:open-champ', id);
});
window.addEventListener('DOMContentLoaded', () => {
  try { ipcRenderer.send('otp:caption', { color: '#00000000', height: 56 }); } catch {}
});

// shell.js header drag (no CSS drag region on local pages): forward to main.
document.addEventListener('otp-win-drag', (e) => {
  const phase = e && e.detail;
  if (typeof phase === 'string') ipcRenderer.send('otp:win-drag', phase);
});

// Update progress badge (shell.js draws it): forward main's update state to the page
// and the page's "install" click back to main.
const fwdUpdate = (s) => { try { window.dispatchEvent(new CustomEvent('otp-update-state', { detail: JSON.stringify(s || {}) })); } catch {} };
ipcRenderer.on('otp:update-state', (_e, s) => fwdUpdate(s));
window.addEventListener('DOMContentLoaded', () => { ipcRenderer.invoke('otp:update-get').then(fwdUpdate).catch(() => {}); });
window.addEventListener('otp-update-install', () => ipcRenderer.send('otp:update-install'));
// Current-champion chip in the shell header (shell.js): lobby state in, build path out.
const fwdLobby = (st) => { try { window.dispatchEvent(new CustomEvent('otp-lobby-state', { detail: JSON.stringify(st || null) })); } catch {} };
ipcRenderer.on('otp:lobby-state', (_e, st) => fwdLobby(st));
window.addEventListener('DOMContentLoaded', () => { ipcRenderer.invoke('otp:lobby-get').then(fwdLobby).catch(() => {}); });
window.addEventListener('otp-go-build', (e) => ipcRenderer.send('otp:go-build', String(e.detail || '')));

// ---- Start screen (no summoner shown yet): your account + best one-tricks ----
// Account from the League client (remembered when it is closed); its three most
// played champions this season (deeplol) as tabs; for the selected one, the top
// one-tricks from onetricks' Ranking page. A click opens that player here.
let homeAcc = null;
let homeMains = [];
let homeChamp = '';
function homeDdv() { try { const c = JSON.parse(localStorage.getItem('otp.shell.champs2') || 'null'); const m = c && c.list && c.list[0] && c.list[0].icon.match(/cdn\/([^/]+)\//); if (m) return m[1]; } catch {} return '16.23.1'; }
const HOME_TIER = { CHALLENGER: '#f0c75e', GRANDMASTER: '#e0605a', MASTER: '#b866dc', DIAMOND: '#6c95f2', EMERALD: '#2fb96b', PLATINUM: '#4fb3a9', GOLD: '#d6a64b', SILVER: '#9fb0bb', BRONZE: '#b0816d', IRON: '#8c7b72' };
function openFromHome(p) {
  if (!p || !p.name || !p.tag) return;
  if (p.region) { settings.region = p.region; saveSettings(); syncRegBadge(); }
  const inp = document.querySelector('#otp-sinput');
  if (inp) inp.value = `${p.name}#${p.tag}`;
  doSummonerSearch();
}
async function renderHome() {
  const box = document.querySelector('#otp-home');
  if (!box) return;
  try { homeAcc = await ipcRenderer.invoke('otp:my-account'); } catch {}
  const ddv = homeDdv();
  const accHtml = homeAcc
    ? `<div class="otp-home-acc" data-acc="1">
        <img src="https://ddragon.leagueoflegends.com/cdn/${ddv}/img/profileicon/${homeAcc.iconId}.png" alt="">
        <div class="who"><div class="nm">${esc(homeAcc.name)} <span>#${esc(homeAcc.tag)}</span></div>
        <div class="sub">${homeAcc.live ? '<span class="dot"></span>Signed in to League' : 'Last signed-in account'} · Lv ${homeAcc.level ?? '?'} · ${esc(shortReg(homeAcc.region))}</div></div>
        <span class="go">Open my profile ›</span>
      </div>`
    : '';
  box.innerHTML = `${accHtml}<div id="otp-home-otp"></div>`;
  const acc = box.querySelector('[data-acc]');
  if (acc) acc.onclick = () => openFromHome(homeAcc);
  if (!homeAcc || !homeAcc.region) return;
  try { homeMains = await ipcRenderer.invoke('otp:my-mains', { name: homeAcc.name, tag: homeAcc.tag, region: homeAcc.region }); } catch { homeMains = []; }
  if (!homeMains.length) return;
  if (!homeMains.some((m) => m.champ === homeChamp)) homeChamp = homeMains[0].champ;
  renderHomeOtps();
}
async function renderHomeOtps() {
  const box = document.querySelector('#otp-home-otp');
  if (!box || !homeChamp) return;
  const ddv = homeDdv();
  const tabs = homeMains.map((m) => `<button class="${m.champ === homeChamp ? 'on' : ''}" data-c="${esc(m.champ)}"><img src="https://ddragon.leagueoflegends.com/cdn/${ddv}/img/champion/${esc(m.champ)}.png" alt="">${esc(m.champ)}<span>${m.games}</span></button>`).join('');
  box.innerHTML = `<div class="otp-home-head"><span>Best ${esc(homeChamp)} one-tricks</span><div class="otp-home-tabs">${tabs}</div></div><div class="otp-home-list"><div class="otp-serr">Loading…</div></div>`;
  box.querySelectorAll('.otp-home-tabs button').forEach((b) => { b.onclick = () => { homeChamp = b.dataset.c; renderHomeOtps(); }; });
  let list = [];
  try { list = await ipcRenderer.invoke('otp:otp-ranking', homeChamp); } catch {}
  const lb = box.querySelector('.otp-home-list');
  if (!lb || box.querySelector('.otp-home-tabs .on')?.dataset.c !== homeChamp) return;
  if (!list.length) { lb.innerHTML = '<div class="otp-serr">Could not load the onetricks ranking right now.</div>'; return; }
  lb.innerHTML = list.slice(0, 8).map((p, i) => `<div class="otp-home-row" data-i="${i}">
      <span class="rk">${i + 1}</span>
      <img src="https://ddragon.leagueoflegends.com/cdn/${ddv}/img/profileicon/${p.iconId}.png" alt="">
      <div class="who"><div class="nm">${esc(p.name)} <span>#${esc(p.tag)}</span>${p.otp ? '<em>OTP</em>' : ''}</div><div class="sub"><b style="color:${HOME_TIER[String(p.tier).toUpperCase()] || '#e8e6e3'}">${esc(p.tier)}</b> ${p.lp} LP · ${esc(shortReg(p.region))}</div></div>
      <div class="st"><div class="${p.wr >= 55 ? 'up' : p.wr <= 48 ? 'down' : ''}">${Math.round(p.wr)}%</div><div class="sub">${p.games} games · ${(p.kda ?? 0).toFixed(2)} KDA</div></div>
    </div>`).join('');
  lb.querySelectorAll('.otp-home-row').forEach((row) => { row.onclick = () => openFromHome(list[Number(row.dataset.i)]); });
}
window.addEventListener('DOMContentLoaded', () => { renderHome(); });
