// Background splash for the local pages (Tier List, Summoner, Wallpapers).
// Picks one of the user's saved wallpapers (Wallpapers page, localStorage
// 'otp.wallpapers'). With none saved the page keeps onetricks' own plain
// background (body.otp-plain).
(function () {
  const DD = 'https://ddragon.leagueoflegends.com/cdn/img/champion/splash/';

  function saved() {
    try {
      const v = JSON.parse(localStorage.getItem('otp.wallpapers') || '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && /^[A-Za-z]+_\d+$/.test(x)) : [];
    } catch { return []; }
  }

  // Avoid showing the same splash twice in a row.
  function choose(list) {
    let last = null;
    try { last = sessionStorage.getItem('otp.bg.last'); } catch {}
    const pool = list.length > 1 ? list.filter((k) => k !== last) : list;
    const k = pool[Math.floor(Math.random() * pool.length)];
    try { sessionStorage.setItem('otp.bg.last', k); } catch {}
    return k;
  }

  function apply(list, tries = 0) {
    if (!list.length || tries > 4) return;
    const key = choose(list);
    const url = DD + key + '.jpg';
    const img = new Image();
    img.onload = () => document.body.style.setProperty('--otp-splash', `url("${url}")`);
    img.onerror = () => apply(list.filter((k) => k !== key), tries + 1);
    img.src = url;
  }

  // Background blur in px (Wallpapers page slider), default 8.
  let blur = 8;
  try {
    const v = Number(localStorage.getItem('otp.bgBlur'));
    if (localStorage.getItem('otp.bgBlur') !== null && Number.isFinite(v)) blur = Math.max(0, Math.min(40, v));
  } catch {}
  document.body.style.setProperty('--otp-blur', blur + 'px');
  // Darkening over the splash, 0.4–0.95 (Wallpapers page), default 0.86.
  try {
    const d = Number(localStorage.getItem('otp.bgDim'));
    if (localStorage.getItem('otp.bgDim') !== null && Number.isFinite(d)) {
      document.body.style.setProperty('--otp-dim', String(Math.max(0.4, Math.min(0.95, d))));
    }
  } catch {}

  const mine = saved();
  if (mine.length) apply(mine);
  else document.body.classList.add('otp-plain');
})();
