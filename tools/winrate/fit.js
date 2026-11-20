// Fit the live win chance model (winprob.js) on the games collect.js saved.
//
// Target: deeplol's own win chance after each event (it is trained on far more
// games than we have), so the small model learns the same curve from features we
// can also read live. Checked on held-out games against deeplol and against the
// real result (log loss, AUC), per game phase.
//
//   node tools/winrate/fit.js      -> writes winmodel.json in the app folder
const fs = require('fs');
const path = require('path');
const wp = require('../../winprob.js');

const DATA = path.join(__dirname, 'data');
const OUT = path.join(__dirname, '..', '..', 'winmodel.json');

function auc(pairs) { // [p, y]
  const pos = pairs.filter((x) => x[1] === 1).map((x) => x[0]);
  const neg = pairs.filter((x) => x[1] === 0).map((x) => x[0]);
  if (!pos.length || !neg.length) return NaN;
  const all = [...pos.map((p) => [p, 1]), ...neg.map((p) => [p, 0])].sort((a, b) => a[0] - b[0]);
  let rank = 0, sumPos = 0;
  for (let i = 0; i < all.length; i++) { rank = i + 1; if (all[i][1]) sumPos += rank; }
  return (sumPos - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}
const ll = (p, y) => -(y * Math.log(Math.max(1e-6, p)) + (1 - y) * Math.log(Math.max(1e-6, 1 - p)));

(async () => {
  const ver = (await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json())[0];
  const items = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/en_US/item.json`)).json();
  const values = wp.itemValues(items);
  const files = fs.readdirSync(DATA).filter((f) => f.endsWith('.json')).sort();
  const games = [];
  for (const f of files) {
    try {
      const rows = wp.fromDeeplol(JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')), values);
      if (rows.length >= 10) games.push(rows);
    } catch {}
  }
  // Same split every run: every 5th game is held out.
  const train = games.filter((_, i) => i % 5 !== 0).flat();
  const test = games.filter((_, i) => i % 5 === 0);
  console.log(`games ${games.length} (train rows ${train.length}, test games ${test.length})`);

  // Logistic regression, soft targets, Adam, small L2.
  const X = train.map((r) => wp.features(r.s));
  // Target: deeplol's chance (default), the real result, or the mean of both.
  const mode = (process.argv[2] || 'deeplol');
  const Y = train.map((r) => (mode === 'outcome' ? r.win : mode === 'mix' ? (r.win + r.target) / 2 : r.target));
  console.log('target', mode);
  const n = X[0].length;
  let w = new Array(n).fill(0), b = 0;
  const m = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0);
  const lr = 0.03, b1 = 0.9, b2 = 0.999, l2 = 1e-4;
  for (let ep = 1; ep <= 400; ep++) {
    const g = new Array(n + 1).fill(0);
    for (let i = 0; i < X.length; i++) {
      let z = b;
      for (let j = 0; j < n; j++) z += w[j] * X[i][j];
      const err = wp.sigmoid(z) - Y[i];
      for (let j = 0; j < n; j++) g[j] += err * X[i][j];
      g[n] += err;
    }
    for (let j = 0; j <= n; j++) {
      const gj = g[j] / X.length + (j < n ? l2 * w[j] : 0);
      m[j] = b1 * m[j] + (1 - b1) * gj; v[j] = b2 * v[j] + (1 - b2) * gj * gj;
      const step = lr * (m[j] / (1 - b1 ** ep)) / (Math.sqrt(v[j] / (1 - b2 ** ep)) + 1e-8);
      if (j < n) w[j] -= step; else b -= step;
    }
  }
  const model = { w, bias: b };

  // Held-out check, by game phase.
  const buckets = [[0, 10], [10, 20], [20, 30], [30, 99]];
  const report = {};
  for (const [lo, hi] of buckets) {
    const rows = test.flat().filter((r) => r.s.t >= lo && r.s.t < hi);
    if (!rows.length) continue;
    const ours = rows.map((r) => [wp.predict(r.s, model), r.win]);
    const dl = rows.map((r) => [r.target, r.win]);
    report[`${lo}-${hi === 99 ? '+' : hi} min`] = {
      rows: rows.length,
      maeVsDeeplol: +(rows.reduce((a, r, i) => a + Math.abs(ours[i][0] - r.target), 0) / rows.length).toFixed(3),
      aucOurs: +auc(ours).toFixed(3), aucDeeplol: +auc(dl).toFixed(3),
      logLossOurs: +(ours.reduce((a, [p, y]) => a + ll(p, y), 0) / rows.length).toFixed(3),
      logLossDeeplol: +(dl.reduce((a, [p, y]) => a + ll(p, y), 0) / rows.length).toFixed(3),
    };
  }
  console.table(report);
  console.log('weights', Object.fromEntries(wp.KEYS.map((k, i) => [k, +w[i].toFixed(3)])), 'bias', +b.toFixed(3));
  if (process.argv[3] === '--dry') return;
  fs.writeFileSync(OUT, JSON.stringify({
    w: w.map((x) => +x.toFixed(5)), bias: +b.toFixed(5), keys: wp.KEYS,
    trained: new Date().toISOString().slice(0, 10), patch: ver, target: mode, games: games.length, check: report,
  }, null, 2));
  console.log('wrote', OUT);
})();
