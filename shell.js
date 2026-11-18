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
    <li class="left"><a class="brand" data-go="home" title="onetricks.gg"><img src="assets/logo.png" alt=""><b>OTP</b></a></li>
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
