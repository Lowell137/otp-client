// Live win chance: one small logistic model over team differences (blue - red).
//
// The same state is built from two sources so training and live use one
// definition:
//   fromDeeplol(match, items)  -> rows at each event of a finished game (training)
//   fromLiveClient(all, items) -> the current state of the game being played
// state = { t: minutes, blue: Side, red: Side }
// Side  = { gold (item value, consumables left out), level (sum), kills, towers,
//           inhibs, dragons, elders, grubs, heralds, barons }
// The model (winmodel.json) is fitted by tools/winrate/fit.js on deeplol games,
// with deeplol's own per-event win chance as the target.

const KEYS = ['gold', 'goldLate', 'level', 'kills', 'towers', 'inhibs', 'dragons', 'elders', 'grubs', 'heralds', 'barons'];

const side = () => ({ gold: 0, level: 0, kills: 0, towers: 0, inhibs: 0, dragons: 0, elders: 0, grubs: 0, heralds: 0, barons: 0 });

// Item value per item id (Data Dragon gold.total), consumables and trinkets out.
// Also keeps each item's recipe (v.__from[id] = component ids) so training can
// follow an inventory the way the game does (components go into the new item).
function itemValues(itemJson) {
  const v = {};
  const from = {};
  for (const [id, it] of Object.entries(itemJson.data || itemJson)) {
    if (it.from) from[id] = it.from.map(String);
    const tags = it.tags || [];
    if (tags.includes('Consumable') || tags.includes('Trinket')) continue;
    v[id] = it.gold?.total || 0;
  }
  Object.defineProperty(v, '__from', { value: from, enumerable: false });
  return v;
}

// Buying an item uses up components that are in the inventory (recursively).
function buyInto(inv, id, from) {
  for (const c of from[id] || []) {
    const i = inv.indexOf(c);
    if (i >= 0) inv.splice(i, 1);
    else buyIntoMissing(inv, c, from);
  }
  inv.push(id);
}
// A component not held as a whole may have been held as its own components.
function buyIntoMissing(inv, id, from) {
  for (const c of from[id] || []) {
    const i = inv.indexOf(c);
    if (i >= 0) inv.splice(i, 1);
    else buyIntoMissing(inv, c, from);
  }
}

function features(s) {
  const d = (k) => (s.blue[k] || 0) - (s.red[k] || 0);
  const g = d('gold') / 1000;
  return [g, g * Math.min(s.t, 40) / 20, d('level') / 5, d('kills') / 5, d('towers'), d('inhibs'), d('dragons'), d('elders'), d('grubs') / 3, d('heralds'), d('barons')];
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
function predict(s, model) {
  const x = features(s);
  let z = model.bias || 0;
  for (let i = 0; i < x.length; i++) z += (model.w[i] || 0) * x[i];
  return sigmoid(z); // chance that blue wins
}

// ---- deeplol finished game -> training rows ----
const POS = ['Top', 'Jun', 'Mid', 'Bot', 'Sup'];
function fromDeeplol(m, values) {
  const ce = m?.time_analysis?.concat_events_dict;
  if (!ce) return [];
  // Each player's inventory value by minute, as the game would show it.
  const from = values.__from || {};
  const players = []; // { side, steps: [{ min, value }] }
  for (const p of m.participants_list || []) {
    const sd = p.side === 'BLUE' ? 'blue' : 'red';
    const inv = [];
    const steps = [];
    const seq = [...(p.item_seq_list || [])].sort((a, b) => a.minute - b.minute);
    for (const e of seq) {
      const id = String(e.item_id);
      if (e.type === 'ITEM_PURCHASED') buyInto(inv, id, from);
      else if (e.type === 'ITEM_SOLD') { const i = inv.indexOf(id); if (i >= 0) inv.splice(i, 1); }
      else continue;
      steps.push({ min: e.minute, value: inv.reduce((a, x) => a + (values[x] || 0), 0) });
    }
    players.push({ side: sd, steps });
  }
  const goldAt = (sd, minute) => players.filter((p) => p.side === sd).reduce((a, p) => {
    let v = 0;
    for (const s of p.steps) { if (s.min <= minute) v = s.value; else break; }
    return a + v;
  }, 0);
  const evs = [];
  for (const k of Object.keys(ce)) for (const x of Object.values(ce[k] || {})) if (x && x.event && typeof x.win_rate === 'number') evs.push(x);
  evs.sort((a, b) => a.time - b.time);
  const blueWin = !!m.match_basic_dict?.blue_win;
  const st = { blue: side(), red: side() };
  const rows = [];
  for (const x of evs) {
    const e = x.event;
    const who = e.side === 'BLUE' ? 'blue' : e.side === 'RED' ? 'red' : null;
    const tg = String(e.target || '');
    if (who) {
      if (e.type === 'Champion') st[who].kills++;
      else if (e.type === 'Tower') { if (/INHIBITOR/.test(tg)) st[who].inhibs++; else st[who].towers++; }
      else if (e.type === 'Monster') {
        if (/ELDER/.test(tg)) st[who].elders++;
        else if (/DRAGON/.test(tg)) st[who].dragons++;
        else if (tg === 'HORDE') st[who].grubs++;
        else if (tg === 'RIFTHERALD') st[who].heralds++;
        else if (/BARON/.test(tg)) st[who].barons++;
      }
    }
    // Item value bought up to this minute, levels at this event.
    st.blue.gold = goldAt('blue', e.minute);
    st.red.gold = goldAt('red', e.minute);
    if (x.level) {
      st.blue.level = 0; st.red.level = 0;
      for (const [k, lv] of Object.entries(x.level)) st[k.startsWith('B_') ? 'blue' : 'red'].level += lv || 0;
    }
    const s = { t: x.time, blue: { ...st.blue }, red: { ...st.red } };
    rows.push({ s, target: Math.min(0.99, Math.max(0.01, (50 + x.win_rate) / 100)), win: blueWin ? 1 : 0 });
  }
  return rows;
}

// ---- Live Client API (/liveclientdata/allgamedata) -> current state ----
// ORDER = blue, CHAOS = red. Kills from the scoreboard; objectives from events.
function fromLiveClient(all, values) {
  const st = { t: (all?.gameData?.gameTime || 0) / 60, blue: side(), red: side() };
  const teamOf = {};
  for (const p of all?.allPlayers || []) {
    const t = p.team === 'ORDER' ? 'blue' : 'red';
    for (const n of [p.riotId, p.riotIdGameName, p.summonerName]) if (n) teamOf[n] = t;
    st[t].level += p.level || 0;
    st[t].kills += p.scores?.kills || 0;
    for (const it of p.items || []) st[t].gold += (values[String(it.itemID)] || 0) * (it.count || 1);
  }
  const byName = (n) => {
    if (!n) return null;
    if (teamOf[n]) return teamOf[n];
    const base = String(n).split('#')[0];
    for (const [k, v] of Object.entries(teamOf)) if (k.split('#')[0] === base) return v;
    if (/T100|_T1_|Order/i.test(n)) return 'blue';
    if (/T200|_T2_|Chaos/i.test(n)) return 'red';
    return null;
  };
  const other = (t) => (t === 'blue' ? 'red' : 'blue');
  for (const e of all?.events?.Events || []) {
    switch (e.EventName) {
      case 'TurretKilled': {
        // "Turret_T1_..." is a blue turret: red gets it (and the reverse).
        const own = /_T1_/.test(e.TurretKilled) ? 'blue' : /_T2_/.test(e.TurretKilled) ? 'red' : null;
        if (own) st[other(own)].towers++;
        break;
      }
      case 'InhibKilled': {
        const own = /_T1_/.test(e.InhibKilled) ? 'blue' : /_T2_/.test(e.InhibKilled) ? 'red' : null;
        if (own) st[other(own)].inhibs++;
        break;
      }
      case 'DragonKill': { const t = byName(e.KillerName); if (t) st[t][/Elder/i.test(e.DragonType) ? 'elders' : 'dragons']++; break; }
      case 'HordeKill': { const t = byName(e.KillerName); if (t) st[t].grubs++; break; }
      case 'HeraldKill': { const t = byName(e.KillerName); if (t) st[t].heralds++; break; }
      case 'BaronKill': { const t = byName(e.KillerName); if (t) st[t].barons++; break; }
      default: break;
    }
  }
  return st;
}

module.exports = { KEYS, features, predict, sigmoid, itemValues, fromDeeplol, fromLiveClient };
