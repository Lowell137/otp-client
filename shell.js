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
    <li class="mid"><input id="otp-shell-search" type="search" placeholder="Search Champion Builds…" autocomplete="off" spellcheck="false" list="otp-shell-champs"><datalist id="otp-shell-champs"></datalist></li>
    <li class="right nav">
      ${items.map(([k, label, cls]) => `<a data-go="${k}" class="${[cls, k === page ? 'on' : ''].join(' ').trim()}">${label}</a>`).join('')}
      <a data-go="wallpapers" class="icon${page === 'wallpapers' ? ' on' : ''}" title="Wallpapers">${wallIcon}</a>
    </li>
  </ul>`;
  document.body.prepend(h);

  // Champion names for the search suggestions (Data Dragon, cached for a day).
  (async () => {
    let names = null;
    try {
      const c = JSON.parse(localStorage.getItem('otp.shell.champs') || 'null');
      if (c && Date.now() - c.ts < 86400000) names = c.names;
    } catch {}
    if (!names) {
      try {
        const v = (await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json())[0];
        const j = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/data/en_US/champion.json`)).json();
        names = Object.values(j.data).map((x) => x.name).sort();
        localStorage.setItem('otp.shell.champs', JSON.stringify({ ts: Date.now(), names }));
      } catch { names = []; }
    }
    document.getElementById('otp-shell-champs').innerHTML = names.map((n) => `<option value="${n.replace(/"/g, '&quot;')}">`).join('');
  })();
})();
