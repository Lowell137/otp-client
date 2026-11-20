// Builds the header for local pages as a copy of onetricks' inner-page header
// (logo, centered champion search, right nav). The page sets
// <body data-page="tier|summoner|wallpapers">; [data-go] clicks and the search are
// routed by the page's preload (ipc 'otp:go' / 'otp:open-champ').
(function () {
  const page = document.body.dataset.page || '';
  // Same items the site shows; Guides / Discover use the site's 1368px breakpoint (.wide).
  const items = [
    ['guides', 'Guides', 'wide'],
    ['tier', 'Tier List', ''],
    ['summoner', 'Summoner', ''],
    ['discover', 'Discover', 'wide'],
  ];
  const wallIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="m3.5 11.5 3-3 2 2 1.5-1.5 2.5 2.5" stroke-linecap="round"/><circle cx="10.5" cy="6" r="1"/></svg>';
  const h = document.createElement('header');
  h.id = 'otp-shell-header';
  h.innerHTML = `<ul>
    <li class="left"><a class="brand" data-go="home" title="onetricks.gg"><img class="ic" src="assets/ot-logo-icon.png" alt=""><img class="wm" src="assets/ot-logo-text.svg" alt="ONETRICKS.GG"></a></li>
    <li class="mid"><div class="sw">
      <input id="otp-shell-search" type="text" placeholder="Search Champion Builds…" autocomplete="off" spellcheck="false">
      <div id="otp-shell-sugg" role="listbox"></div>
    </div></li>
    <li class="right nav">
      ${items.map(([k, label, cls]) => `<a data-go="${k}" class="${[cls, k === page ? 'on' : ''].join(' ').trim()}">${label}</a>`).join('')}
      <a data-go="wallpapers" class="icon${page === 'wallpapers' ? ' on' : ''}" title="Wallpapers">${wallIcon}</a>
    </li>
  </ul>`;

  document.body.prepend(h);
  const anchor = document.createElement('div');
  anchor.id = 'otp-drag-anchor';
  document.body.appendChild(anchor);

  // ---- Champion search with a small suggestion list (max 8, icons, keyboard) ----
  const input = h.querySelector('#otp-shell-search');
  const box = h.querySelector('#otp-shell-sugg');
  let champs = [];
  let shown = [];
  let sel = -1;

  (async () => {
    try {
      const c = JSON.parse(localStorage.getItem('otp.shell.champs2') || 'null');
      if (c && Date.now() - c.ts < 86400000) champs = c.list;
    } catch {}
    if (!champs.length) {
      try {
        const v = (await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json())[0];
        const j = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/data/en_US/champion.json`)).json();
        champs = Object.values(j.data).map((x) => ({ id: x.id, name: x.name, icon: `https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${x.id}.png` }))
          .sort((a, b) => a.name.localeCompare(b.name));
        localStorage.setItem('otp.shell.champs2', JSON.stringify({ ts: Date.now(), list: champs }));
      } catch {}
    }
  })();

  const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
  function render() {
    const q = norm(input.value);
    if (!q) { box.classList.remove('open'); shown = []; return; }
    const starts = champs.filter((c) => norm(c.name).startsWith(q));
    const has = champs.filter((c) => !norm(c.name).startsWith(q) && norm(c.name).includes(q));
    shown = [...starts, ...has].slice(0, 8);
    sel = shown.length ? 0 : -1;
    box.innerHTML = shown.length
      ? shown.map((c, i) => `<div class="it${i === sel ? ' sel' : ''}" data-i="${i}"><img src="${c.icon}" alt=""><span>${c.name}</span></div>`).join('')
      : '<div class="none">No champion found</div>';
    box.classList.add('open');
  }
  function mark() { box.querySelectorAll('.it').forEach((el, i) => el.classList.toggle('sel', i === sel)); }
  function go(c) {
    if (!c) return;
    input.value = '';
    box.classList.remove('open');
    input.dispatchEvent(new CustomEvent('otp-open-champ', { bubbles: true, detail: c.name }));
  }
  input.addEventListener('input', render);
  input.addEventListener('focus', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && shown.length) { sel = (sel + 1) % shown.length; mark(); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && shown.length) { sel = (sel - 1 + shown.length) % shown.length; mark(); e.preventDefault(); }
    else if (e.key === 'Enter') { go(shown[sel] || shown[0]); e.preventDefault(); }
    else if (e.key === 'Escape') { input.value = ''; box.classList.remove('open'); input.blur(); }
  });
  box.addEventListener('mousedown', (e) => {
    const el = e.target.closest('.it');
    if (el) { e.preventDefault(); go(shown[Number(el.dataset.i)]); }
  });
  input.addEventListener('blur', () => setTimeout(() => box.classList.remove('open'), 100));
})();

// Current-champion chip next to the logo: during champion select or a game it shows
// the champion you picked (or are hovering) and takes you back to its build (your
// lane; vs your lane opponent once the game is on). State: preload 'otp-lobby-state'.
(function () {
  const left = document.querySelector('#otp-shell-header .left');
  if (!left) return;
  const chip = document.createElement('a');
  chip.id = 'otp-champ-chip';
  left.appendChild(chip);
  let url = '';
  chip.addEventListener('click', (e) => { e.preventDefault(); if (url) chip.dispatchEvent(new CustomEvent('otp-go-build', { bubbles: true, detail: url })); });
  const champName = (id) => {
    try { const c = JSON.parse(localStorage.getItem('otp.shell.champs2') || 'null'); const x = c && c.list.find((k) => k.id === id); if (x) return x; } catch {}
    return { id, name: id, icon: '' };
  };
  window.addEventListener('otp-lobby-state', (e) => {
    let st = null;
    try { st = JSON.parse(e.detail || 'null'); } catch {}
    const me = st && st.me;
    if (!me || !me.champ) { chip.classList.remove('show'); url = ''; return; }
    const role = me.role || '';
    const opp = st.phase === 'InGame' && role ? (st.enemies || []).find((p) => p.role === role && p.champ) : null;
    const q = new URLSearchParams();
    if (opp) q.set('matchup', opp.champ);
    if (role) q.set('role', role);
    url = `/champions/builds/${me.champ}${q.toString() ? '?' + q : ''}`;
    const c = champName(me.champ);
    const icon = c.icon || '';
    chip.innerHTML = `<span class="dot"></span>${icon ? `<img src="${icon}" alt="">` : ''}<span class="nm">${c.name}</span><span class="st">${st.phase === 'InGame' ? (opp ? 'vs ' + champName(opp.champ).name : 'In game') : 'Champ select'}</span>`;
    chip.title = `Back to the ${c.name} build`;
    chip.classList.add('show');
  });
})();

// Window moving for local pages (no CSS drag region, see shell.css): press on empty
// header space and drag; double-click toggles maximize. The page's preload forwards
// 'otp-win-drag' to main, which moves the window by the cursor's screen position.
(function () {
  const h = document.getElementById('otp-shell-header');
  if (!h) return;
  const send = (detail) => h.dispatchEvent(new CustomEvent('otp-win-drag', { bubbles: true, detail }));
  const isEmpty = (t) => !(t.closest && t.closest('a, input, button, #otp-shell-sugg, .sw'));
  let dragging = false;
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !isEmpty(e.target) || e.detail > 1) return;
    dragging = true;
    h.setPointerCapture(e.pointerId);
    send('start');
    e.preventDefault();
  });
  h.addEventListener('pointermove', () => { if (dragging) send('move'); });
  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    try { h.releasePointerCapture(e.pointerId); } catch {}
    send('end');
  };
  h.addEventListener('pointerup', stop);
  h.addEventListener('pointercancel', stop);
  h.addEventListener('dblclick', (e) => { if (isEmpty(e.target)) send('max'); });
})();

// Round update badge (bottom-right) while an update is checked / downloading / ready.
// State comes from the page's preload ('otp-update-state'); clicking when ready
// restarts into the new version.
(function () {
  const ring = document.createElement('div');
  ring.id = 'otp-upd-ring';
  ring.innerHTML = '<svg viewBox="0 0 40 40" width="40" height="40"><circle class="trk" cx="20" cy="20" r="16" fill="none" stroke-width="3"/><circle class="bar" cx="20" cy="20" r="16" fill="none" stroke-width="3" stroke-linecap="round" stroke-dasharray="100.53" stroke-dashoffset="100.53"/></svg><span></span>';
  document.body.appendChild(ring);
  let state = {};
  ring.addEventListener('click', () => { if (state.state === 'ready') window.dispatchEvent(new CustomEvent('otp-update-install')); });
  window.addEventListener('otp-update-state', (e) => {
    try { state = JSON.parse(e.detail || '{}'); } catch { return; }
    const st = state.state;
    ring.classList.toggle('show', st === 'checking' || st === 'downloading' || st === 'ready');
    ring.classList.toggle('ready', st === 'ready');
    ring.classList.toggle('checking', st === 'checking');
    const pct = st === 'ready' ? 100 : st === 'downloading' ? (state.percent || 0) : 0;
    if (st !== 'checking') ring.querySelector('.bar').setAttribute('stroke-dashoffset', String(100.53 * (1 - pct / 100)));
    ring.querySelector('span').textContent = st === 'ready' ? '↻' : st === 'downloading' ? pct + '%' : '';
    ring.title = st === 'ready' ? 'Update v' + (state.version || '') + ' ready: click to restart and install'
      : st === 'downloading' ? 'Downloading update v' + (state.version || '') + ': ' + pct + '%' : 'Checking for updates…';
  });
})();
