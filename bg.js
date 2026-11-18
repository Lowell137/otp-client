// Random champion splash for the local pages (Tier List, Summoner).
// Picks a random champion and one of its skins from Data Dragon on every load.
// The champion list is cached in localStorage for a day; the splash fades in once loaded.
(function () {
  const DD = 'https://ddragon.leagueoflegends.com';
  const DAY = 24 * 60 * 60 * 1000;

  function cacheGet(k) {
    try {
      const v = JSON.parse(localStorage.getItem(k) || 'null');
      return v && Date.now() - v.ts < DAY ? v.data : null;
    } catch { return null; }
  }
  function cacheSet(k, data) {
    try { localStorage.setItem(k, JSON.stringify({ ts: Date.now(), data })); } catch {}
  }
  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  async function champList() {
    let c = cacheGet('otp.bg.champs');
    if (c) return c;
    const v = (await (await fetch(`${DD}/api/versions.json`)).json())[0];
    const j = await (await fetch(`${DD}/cdn/${v}/data/en_US/champion.json`)).json();
    c = { v, ids: Object.keys(j.data) };
    cacheSet('otp.bg.champs', c);
    return c;
  }

  async function randomSplash() {
    const { v, ids } = await champList();
    const id = pick(ids);
    let num = 0;
    try {
      const j = await (await fetch(`${DD}/cdn/${v}/data/en_US/champion/${id}.json`)).json();
      const skins = (j.data[id].skins || []).map((s) => s.num);
      if (skins.length) num = pick(skins);
    } catch {}
    return `${DD}/cdn/img/champion/splash/${id}_${num}.jpg`;
  }

  function apply(url, tries = 0) {
    const img = new Image();
    img.onload = () => {
      document.body.style.setProperty('--otp-splash', `url("${url}")`);
    };
    // Some skins have no splash on Data Dragon: fall back to the base skin, then retry another champ.
    img.onerror = () => {
      if (tries === 0 && !/_0\.jpg$/.test(url)) apply(url.replace(/_\d+\.jpg$/, '_0.jpg'), 1);
      else if (tries < 3) randomSplash().then((u) => apply(u, tries + 1)).catch(() => {});
    };
    img.src = url;
  }

  randomSplash().then(apply).catch(() => {
    apply(`${DD}/cdn/img/champion/splash/${pick(['Ahri', 'Jinx', 'Yasuo', 'Lux', 'Thresh', 'Ezreal'])}_0.jpg`);
  });
})();
