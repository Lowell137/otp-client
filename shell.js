// Builds the onetricks-style header for local pages. The page sets
// <body data-page="tier|summoner|wallpapers">; clicks on [data-go] are routed by the
// page's preload (ipc 'otp:go').
(function () {
  const page = document.body.dataset.page || '';
  const items = [
    ['guides', 'Guides'],
    ['tier', 'Tier List'],
    ['summoner', 'Summoner'],
    ['discover', 'Discover'],
  ];
  const wallIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="m3.5 11.5 3-3 2 2 1.5-1.5 2.5 2.5" stroke-linecap="round"/><circle cx="10.5" cy="6" r="1"/></svg>';
  const h = document.createElement('header');
  h.id = 'otp-shell-header';
  h.innerHTML = `<ul>
    <li><a class="brand" data-go="home" title="onetricks.gg"><img src="assets/logo.png" alt=""><b>OTP</b></a></li>
    <li class="spacer"></li>
    <li class="nav">
      ${items.map(([k, label]) => `<a data-go="${k}" class="${k === page ? 'on' : ''}">${label}</a>`).join('')}
      <a data-go="wallpapers" class="${page === 'wallpapers' ? 'on' : ''}" title="Wallpapers">${wallIcon}</a>
    </li>
  </ul>`;
  document.body.prepend(h);
})();
