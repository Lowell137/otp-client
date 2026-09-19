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
function paintUpdated() {
  const el = document.querySelector('#otp-updated');
  if (!el) return;
  let map = {};
  try { map = JSON.parse(localStorage.getItem('otp.updated') || '{}'); } catch {}
  const ts = map[updKey()];
  el.textContent = ts ? `Last updated: ${timeAgo(ts)}` : '';
}
function markUpdated() {
  try {
    const map = JSON.parse(localStorage.getItem('otp.updated') || '{}');
    map[updKey()] = Date.now();
    localStorage.setItem('otp.updated', JSON.stringify(map));
  } catch {}
  paintUpdated();
}

function renderSummoner(res, showBack) {
  const body = document.querySelector('#otp-sbody');
  if (!body) return;
  if (!res || !res.ok) { body.innerHTML = `<div class="otp-serr">Error: ${esc(res?.error || 'unknown')}</div>`; return; }
  lastDlRes = { ...res, matches: res.matches ? [...res.matches] : [], _view: [], _painted: 0 };
  markUpdated();
  const rankHtml = (res.ranks || []).map((r) => {
    const q = r.queueType === 'RANKED_SOLO_5x5' ? 'Solo' : r.queueType === 'RANKED_FLEX_SR' ? 'Flex' : r.queueType;
    const tot = (r.wins ?? 0) + (r.losses ?? 0);
    const wr = tot ? Math.round((r.wins / tot) * 100) : 0;
    const wl = (r.wins == null) ? '' : `<span class="sub">${r.wins}W ${r.losses}L (${wr}%)</span>`;
    return `<div class="otp-mrow"><span style="width:44px;color:#9aa3b8">${q}</span><b>${r.tier} ${r.rank}</b><span>${r.leaguePoints} LP</span>${wl}</div>`;
  }).join('') || `<div class="otp-serr">No ranked data (unranked?)</div>`;
  const backHtml = (showBack && lastLobbyRes) ? `<div class="otp-serr" style="text-align:left;padding:0 0 8px;"><a href="javascript:void(0)" id="otp-backlob" style="color:#6cb2ff">← Back to lobby</a></div>` : '';
  body.innerHTML = `
    ${backHtml}
    <div class="otp-sprof">
      <img src="${res.profile.iconUrl}">
      <div><b style="font-size:15px">${esc(res.profile.name)} #${esc(res.profile.tag)}</b><div class="lv" style="margin-left:14px;">Level ${res.profile.level}</div></div>
      <div class="otp-score" id="otp-scorebox">…</div>
    </div>
    <div class="otp-ssec">Ranked</div>${rankHtml}
    <div class="otp-ssec" id="otp-champlabel">Champions</div><div id="otp-champsbox"></div>
    <div class="otp-ssec">Recent Matches — click a row for both teams</div>
    <div id="otp-matchlist">${(res.pendingIds?.length) ? '<div class="otp-serr" id="otp-mloading">Loading matches…</div>' : ''}</div>
    <div class="otp-serr" style="font-size:11px">Scores are computed from loaded matches. Not an official/deeplol score.</div>`;
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
  ms.forEach((m) => {
    if (m.win) w++; k += m.kills; d += m.deaths; a += m.assists;
    if (typeof m.ai === 'number') { aiSum += m.ai; aiN++; }
  });
  const n = ms.length || 1;
  const wr = Math.round((w / n) * 100);
  const kda = ((k + a) / Math.max(1, d)).toFixed(2);
  const champs = {};
  ms.forEach((m) => {
    const c = (champs[m.champ] = champs[m.champ] || { champ: m.champ, icon: m.icon, g: 0, w: 0, k: 0, d: 0, a: 0 });
    c.g++; if (m.win) c.w++; c.k += m.kills; c.d += m.deaths; c.a += m.assists;
  });
  return { n, w, wr, kda, aiAvg: aiN ? Math.round(aiSum / aiN) : null,
    value: Math.min(9999, Math.round(wr * 50 + ((k + a) / Math.max(1, d)) * 120)),
    champs: Object.values(champs).sort((x, y) => y.g - x.g) };
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
  const kda = ((m.kills + m.assists) / Math.max(1, m.deaths)).toFixed(2);
  return `<div class="otp-mrow ${m.win ? 'win' : 'lose'} otp-mexp" data-mi="${mi}" style="cursor:pointer" title="Click for both teams"><img loading="lazy" src="${m.icon}"><span style="width:104px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(m.champ)}</span>${aiBadge(m.ai)}<span class="kda">${m.kills}/${m.deaths}/${m.assists} (${kda})</span><span class="sub">${qname(m.queue)} · ${m.win ? 'W' : 'L'} · ${m.cs} CS${m.ts ? ` · ${timeAgo(m.ts)}` : ''}</span></div><div id="otp-mexp-${mi}" style="display:none;margin:8px 0 14px 0;"></div>`;
}

function paintMatchData() {
  if (!lastDlRes) return;
  const all = lastDlRes.matches || [];
  lastDlRes._view = curQueue === 'all' ? all : all.filter((m) => m.queue === curQueue);
  const st = dlStats();
  lastDlRes.score = { value: st.value, wr: st.wr, kda: st.kda, games: st.n, aiAvg: st.aiAvg };
  const sb = document.querySelector('#otp-scorebox');
  if (sb) sb.innerHTML = `<b>${st.aiAvg ?? st.value}</b><div>${st.aiAvg != null ? 'deeplol AI score (avg)' : 'OTP Score'} · last ${st.n} games</div><div>%${st.wr} WR · ${st.kda} KDA</div>`;
  const cl = document.querySelector('#otp-champlabel');
  if (cl) cl.textContent = `Champions (last ${st.n} games)`;
  const cb = document.querySelector('#otp-champsbox');
  if (cb) cb.innerHTML = st.champs.slice(0, 6).map((c) => {
    const cwr = c.g ? Math.round((c.w / c.g) * 100) : 0;
    const ckda = ((c.k + c.a) / Math.max(1, c.d)).toFixed(2);
    return `<div class="otp-mrow"><img loading="lazy" src="${c.icon}"><span>${esc(c.champ)}</span><span class="sub">${c.g} games · ${cwr}% · ${ckda} KDA</span></div>`;
  }).join('');
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
  renderQtabs(); // rebuild tabs (new queues may appear) + counts
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

  box.innerHTML = order.map((side) => {
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
              <img class="champ-img" loading="lazy" src="${t.icon}">
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
  box.style.display = 'block';
  box.querySelectorAll('.otp-plink').forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); openPlayerProfile(el.dataset.name, el.dataset.tag); };
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
      window.scrollTo({ top: 0 });
      return;
    }
  }
  body.innerHTML = `<div class="otp-serr">Loading ${esc(name)}…</div>`;
  const res = await ipcRenderer.invoke('otp:deeplol', { region, gameName: name, tagLine: tag });
  if (res?.ok) pushRecent(res.profile.name, res.profile.tag, region);
  renderSummoner(res);
  window.scrollTo({ top: 0 });
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
      if (inp && inp.value.trim()) await doSummonerSearch(true);
      else if (lastLobbyRes) await doLobby();
    } finally {
      btn.classList.remove('spin');
    }
  };
  document.querySelector('#otp-sinput').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  document.querySelector('#otp-sinput').focus();
  renderRecents();
  renderQtabs();
});
