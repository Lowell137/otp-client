// Background splash for the local pages (Tier List, Summoner, Wallpapers).
// Picks one of the user's saved wallpapers (Wallpapers page, localStorage
// 'otp.wallpapers'); until something is saved, a small hand-picked default set.
(function () {
  const DD = 'https://ddragon.leagueoflegends.com/cdn/img/champion/splash/';
  const DEFAULTS = ['Ahri_86', 'Jinx_60', 'Yasuo_77', 'Kaisa_70', 'Akali_60', 'Yone_19', 'Viego_37', 'Seraphine_43', 'Sett_66', 'Lux_70'];

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

  const mine = saved();
  apply(mine.length ? mine : DEFAULTS);
})();
