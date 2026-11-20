const { contextBridge, ipcRenderer, webFrame } = require('electron');

// ---- Rune Ordering: LCU requires strict perk ordering ----
// [keystone, primary row 1-3, secondary row 1-2, stat shard 1-3]
function buildSlotMap(subStyle) {
  const map = {};
  if (!subStyle) return map;
  for (const [styleId, style] of Object.entries(subStyle)) {
    (style.slots || []).forEach((slot, idx) => {
      for (const r of slot.runes || []) map[r.id] = { style: Number(styleId), slot: idx };
    });
  }
  return map;
}

// Build a name->runeInfo map from subStyle for DOM-based extraction
function buildRuneNameMap(subStyle) {
  const map = {};
  if (!subStyle) return map;
  for (const [styleId, style] of Object.entries(subStyle)) {
    (style.slots || []).forEach((slot, sIdx) => {
      for (const r of slot.runes || []) {
        map[r.name.toLowerCase()] = {
          id: r.id,
          styleId: Number(styleId),
          slot: sIdx,
          isKeystone: sIdx === 0
        };
      }
    });
  }
  return map;
}

function orderRunes(six, primary, sub, keystone, slotMap) {
  const key = Number(keystone);
  const rest = six.map(Number).filter((r) => r !== key);
  if (!slotMap || !Object.keys(slotMap).length) return [key, ...rest];
  const prim = [], sec = [], unk = [];
  for (const r of rest) {
    const info = slotMap[r];
    if (info && info.style === primary && info.slot > 0) prim.push({ r, slot: info.slot });
    else if (info && info.style === sub && info.slot > 0) sec.push({ r, slot: info.slot });
    else unk.push({ r, slot: 99 });
  }
  prim.sort((a, b) => a.slot - b.slot);
  sec.sort((a, b) => a.slot - b.slot);
  return [key, ...prim.map((x) => x.r), ...sec.map((x) => x.r), ...unk.map((x) => x.r)];
}

// ---- Shard name -> ID mapping ----
const SHARD_MAP = {
  'attack speed': 5005, 'adaptive force': 5008, 'ability haste': 5007,
  'move speed': 5010, 'tenacity': 5012, 'health scaling': 5013,
  'health': 5011, '65 health': 5011
};

function extractStats(popStat) {
  if (!popStat) return [5008, 5008, 5001];
  let arr = popStat;
  if (Array.isArray(arr[0])) arr = arr[0];
  if (Array.isArray(arr[0])) arr = arr[0];
  const nums = (Array.isArray(arr) ? arr : []).map(Number).filter((n) => !isNaN(n) && n >= 5000 && n < 6000);
  if (nums.length === 3) return nums;
  return [5008, 5008, 5001];
}

function extractSpells(sSpells) {
  if (!sSpells) return [4, 14];
  if (Array.isArray(sSpells)) {
    const direct = sSpells.map(Number).filter((n) => !isNaN(n) && n > 0 && n < 50);
    if (direct.length === 2) return direct;
    for (const entry of sSpells) {
      if (Array.isArray(entry)) {
        if (Array.isArray(entry[0])) {
          const sub = entry[0].map(Number).filter((n) => !isNaN(n) && n > 0 && n < 50);
          if (sub.length === 2) return sub;
        }
        const flat = entry.map(Number).filter((n) => !isNaN(n) && n > 0 && n < 50);
        if (flat.length === 2) return flat;
      }
    }
  }
  return [4, 14];
}

// ---- Detect active First-Item filter from the site UI ----
async function detectSelectedFirstItemKey() {
  try {
    const key = await webFrame.executeJavaScript(`
      (() => {
        const allBtn = Array.from(document.querySelectorAll('button'))
          .find((b) => (b.textContent || '').trim() === 'ALL');
        if (!allBtn) return 'all';
        const scope = allBtn.parentElement;
        if (!scope) return 'all';
        const btns = Array.from(scope.querySelectorAll('button'));
        for (const b of btns) {
          const cs = getComputedStyle(b);
          const isSelected =
            (b.style.borderColor && b.style.borderColor.includes('green')) ||
            (b.style.background && b.style.background.includes('green')) ||
            cs.borderColor.includes('76, 175, 80') ||
            cs.backgroundColor.includes('45, 90, 45');
          if (isSelected) {
            const fiberKey = Object.keys(b).find(k => k.startsWith('__reactFiber'));
            if (fiberKey && b[fiberKey]?.key) return String(b[fiberKey].key);
            if ((b.textContent || '').trim() === 'ALL') return 'all';
          }
        }
        return 'all';
      })()
    `);
    return key || 'all';
  } catch (e) {
    return 'all';
  }
}

// ---- Extract active runes directly from the rendered DOM ----
// This is the key fix: __NEXT_DATA__ is static SSR and does NOT update
// when the user clicks Set 1/2/3/4 tabs or changes first-item buttons.
// We must read runes from the active tab panel in the live DOM.
async function extractActiveRunesFromDOM(runeNameMap, fallbackStats) {
  try {
    const result = await webFrame.executeJavaScript(`
      (() => {
        // Locate the runes card robustly
        let runesCard = document.querySelector('.cardBorder, [class*="card"]');
        const candidates = Array.from(document.querySelectorAll('*'));
        const runesH = candidates.find(el =>
          el.children.length === 0 &&
          /runes/i.test(el.textContent?.trim()) &&
          el.textContent.trim().length < 35
        );
        if (runesH) {
          const found = runesH.closest('.cardBorder') || runesH.closest('[class*="card"]') || runesH.parentElement?.parentElement;
          if (found) runesCard = found;
        }
        if (!runesCard) return null;

        // Find active tab and its panel — prefer a real tabpanel so header
        // mini-icons (keystone + "53%" row) never pollute the rune list.
        const tabs = Array.from(runesCard.querySelectorAll('[role="tab"]'));
        const activeTab = tabs.find(t => t.getAttribute('aria-selected') === 'true') || tabs[0];
        const panelId = activeTab?.getAttribute('aria-controls');
        let panel = panelId ? document.getElementById(panelId) : null;
        if (!panel) {
          const tps = Array.from(runesCard.querySelectorAll('[role="tabpanel"]'));
          panel = tps.find(p => p.offsetParent !== null) || tps[0] || null;
        }
        const headerScope = runesH?.parentElement || null;
        const useWholeCard = !panel;
        if (!panel) panel = runesCard;
        const activeTabIdx = Math.max(0, tabs.indexOf(activeTab));
        const tabLabel = activeTab?.textContent?.trim() || 'Set 1';

        // Extract non-grayscale rune icons from the active panel
        const icons = Array.from(panel.querySelectorAll('[data-tooltip-html]'));
        const runeNames = [];
        const shardTexts = [];

        for (const ic of icons) {
          const cs = getComputedStyle(ic);
          if (cs.filter && cs.filter.includes('grayscale')) continue;
          // Whole-card fallback: skip header-row icons (keystone + "53%" labels)
          if (useWholeCard && headerScope && headerScope.contains(ic)) continue;
          const html = ic.getAttribute('data-tooltip-html') || '';
          const m = html.match(/<b>(.*?)<\\/b>/i);
          if (m) {
            runeNames.push(m[1].trim().toLowerCase());
          } else {
            // Shard: no <b> tag, just tooltip text
            shardTexts.push(html.toLowerCase());
          }
        }

        return { runeNames, shardTexts, activeTabIdx, tabLabel };
      })()
    `);

    if (!result || !result.runeNames || result.runeNames.length < 4) return null;

    // Map rune names to IDs using the name map built from pageProps
    const activeRunes = [];
    for (const name of result.runeNames) {
      const info = runeNameMap[name];
      if (info && !activeRunes.some(x => x.id === info.id)) {
        activeRunes.push({ ...info, name });
      }
    }

    // Parse shards
    const shards = [];
    for (const text of result.shardTexts) {
      for (const [sName, sId] of Object.entries(SHARD_MAP)) {
        if (text.includes(sName)) {
          if (shards.length < 3) shards.push(sId);
          break;
        }
      }
    }

    // Build the rune page
    const keystone = activeRunes.find(r => r.isKeystone);
    if (!keystone) return null;

    const primaryStyleId = keystone.styleId;
    const primSorted = activeRunes
      .filter(r => !r.isKeystone && r.styleId === primaryStyleId)
      .sort((a, b) => a.slot - b.slot);
    const subSorted = activeRunes
      .filter(r => r.styleId !== primaryStyleId)
      .sort((a, b) => a.slot - b.slot);
    const subStyleId = subSorted[0]?.styleId;

    if (primSorted.length === 3 && subSorted.length === 2) {
      const finalShards = shards.length === 3 ? shards : (fallbackStats || [5008, 5008, 5001]);
      return {
        primary: primaryStyleId,
        sub: subStyleId,
        keystone: keystone.id,
        selectedPerkIds: [
          keystone.id,
          ...primSorted.map(r => r.id),
          ...subSorted.map(r => r.id),
          ...finalShards
        ],
        source: 'dom:' + result.tabLabel
      };
    }

    return null;
  } catch (e) {
    return null;
  }
}

// ---- Patch selection ----
// onetricks keys firstItemStats by "all", season ("16") and patch ("16.22").
// Integer-like keys sort first in JS, so Object.keys()[0] is the whole-season
// aggregate, not the current patch. Prefer the newest patch with a usable sample.
const MIN_PATCH_GAMES = 30;
function pickPatch(pp) {
  const fis = pp.firstItemStats || {};
  const stats = pp.patchStats || {};
  const keys = Object.keys(fis);
  const ver = (k) => k.split('.').map(Number);
  const newer = (a, b) => { const x = ver(a), y = ver(b); return (y[0] - x[0]) || (y[1] - x[1]); };
  const exact = keys.filter((k) => /^\d+\.\d+$/.test(k)).sort(newer);
  const usable = exact.find((k) => stats[k] == null || stats[k] >= MIN_PATCH_GAMES);
  if (usable) return usable;
  const season = keys.filter((k) => /^\d+$/.test(k)).sort((a, b) => b - a)[0];
  return season || (fis.all ? 'all' : keys[0]);
}

// ---- Build parser from pageProps ----
function buildFromPageProps(pp, champion, selectedFirstKey = 'all', domRunes = null) {
  const champ = pp.champion || pp.key?.split('--')?.[0] || champion;
  if (!champ) return { error: 'Champion not found on page' };

  const fis = pp.firstItemStats;
  if (!fis) return { error: 'No build data available for this champion' };

  const patch = pickPatch(pp);
  const byFirst = fis[patch] || {};

  const firstKey = (selectedFirstKey && byFirst[selectedFirstKey])
    ? selectedFirstKey
    : (byFirst.all ? 'all' : Object.keys(byFirst)[0]);
  const group = byFirst[firstKey] ?? byFirst.all ?? byFirst[Object.keys(byFirst)[0]];
  if (!group) return { error: 'Build group not found' };

  const slotMap = buildSlotMap(pp.runes?.subStyle);
  const fallbackStats = extractStats(group.popStat);

  let runes = domRunes;
  if (!runes) {
    // Selected first-item group may have no rune stats (e.g. item-specific tab) —
    // fall back to the 'all' group's popRunes instead of failing.
    let runeSource = group.popRunes;
    if ((!runeSource || !Object.keys(runeSource).length) && byFirst.all && byFirst.all !== group) {
      runeSource = byFirst.all.popRunes;
    }
    let bestKeystone = null;
    let bestVariant = null;
    for (const [k, variants] of Object.entries(runeSource || {})) {
      for (const v of variants || []) {
        if (!bestVariant || v[1] > bestVariant[1]) {
          bestVariant = v;
          bestKeystone = k;
        }
      }
    }
    if (!bestVariant) return { error: 'Rune statistics empty for this build' };

    const [six, rate, tree] = bestVariant;
    const [primary, sub] = tree;
    const ordered = orderRunes(six, primary, sub, bestKeystone, slotMap);
    const perks = [...ordered];
    while (perks.length < 6) perks.push(ordered[0] || 8000);
    runes = {
      primary,
      sub,
      keystone: Number(bestKeystone),
      selectedPerkIds: [...perks.slice(0, 6), ...fallbackStats].map(Number),
      source: 'static:bestVariant'
    };
  }

  const sSpells = extractSpells(group.sSpells);
  const starting = group.startingItems?.[0]?.[0]?.map(Number) ?? [];
  const full = (group.popularItems ?? []).slice(0, 6).map(([id]) => Number(id));
  const core = (group.popCore?.[0]?.[0] ?? full.slice(0, 2)).map(Number);
  const boots = (group.boots ?? []).slice(0, 2).map(([id]) => Number(id));

  return {
    champion: champ,
    patch,
    rate: group.rate || 0,
    firstKey,
    runes,
    spells: sSpells,
    items: { starting, core, full, boots }
  };
}

// Fetch build directly for any champion (SSR fast fetch ~100ms)
async function fetchBuildForChamp(champion) {
  const target = `/champions/builds/${champion}`.toLowerCase();
  if (location.pathname.toLowerCase() === target) {
    const b = await parseBuild();
    if (b && !b.error) return b;
  }
  try {
    const url = `https://www.onetricks.gg/champions/builds/${encodeURIComponent(champion)}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    const pp = JSON.parse(m[1])?.props?.pageProps;
    if (!pp?.firstItemStats) return null;
    const b = buildFromPageProps(pp, champion, 'all', null);
    if (b && !b.error) b.flashSlot = settings.flashSlot || 'D';
    return b;
  } catch {
    return null;
  }
}

// ---- Build data from current page with DOM rune override ----
async function parseBuild() {
  if (!location.pathname.includes('/champions/builds/')) {
    return { error: 'Please open a champion build page (e.g. /champions/builds/Lucian)', notBuildPage: true };
  }

  const selectedFirstKey = await detectSelectedFirstItemKey();

  // Get page props from __NEXT_DATA__
  let pp = null;
  try {
    const el = document.getElementById('__NEXT_DATA__');
    if (el) pp = JSON.parse(el.textContent)?.props?.pageProps;
  } catch {}

  if (!pp) {
    try {
      const r = await fetch(location.href);
      const html = await r.text();
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (m) pp = JSON.parse(m[1])?.props?.pageProps;
    } catch {}
  }

  if (!pp) return { error: 'Page data not found' };

  const runeNameMap = buildRuneNameMap(pp.runes?.subStyle);
  const fallbackStats = extractStats(pp.firstItemStats?.[Object.keys(pp.firstItemStats || {})[0]]?.all?.popStat);
  const domRunes = await extractActiveRunesFromDOM(runeNameMap, fallbackStats);
  const b = buildFromPageProps(pp, pp.champion, selectedFirstKey, domRunes);
  if (b && !b.error) b.flashSlot = settings.flashSlot || 'D';
  return b;
}

// ---- Settings Management ----
const DEF_SETTINGS = { follow: true, autoBuild: true, autoAccept: false, autoSpell: true, autoMatchup: true, overlay: false, flashSlot: 'D', apiKey: '', region: 'tr1' };
let settings = { ...DEF_SETTINGS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('otp.settings') || '{}')); } catch {}
function saveSettings() {
  try { localStorage.setItem('otp.settings', JSON.stringify(settings)); } catch {}
  try { ipcRenderer.send('otp:settings', settings); } catch {}
}

// ---- Toast Notification ----
function toast(msg, ok = true) {
  let t = document.getElementById('otp-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'otp-toast';
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:999999;padding:9px 16px;border-radius:6px;font:500 13px system-ui,-apple-system,sans-serif;color:#e8eaf0;max-width:480px;background:rgb(24,26,27);border:1px solid rgb(85,85,85);box-shadow:0 8px 24px rgba(0,0,0,.6);transition:opacity 0.2s ease;';
    document.body.appendChild(t);
  }
  t.style.borderColor = ok ? '#22c55e' : '#ef4444';
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.style.display = 'none'), 4500);
}

// ---- Gear SVG Icon ----
const GEAR_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;

// ---- CSS matching site native style ----
const CSS = `
/* Hide video ads that displace header layout */
.video-ad-center, .video-ad-top, .video-ad { display: none !important; }

/* Hide Get Pro button */
a.get-pro-btn, .get-pro-btn { display: none !important; }

/* Primary "Import" Button matching site primary style */
.otp-btn {
  background: rgb(16, 99, 183);
  color: #ffffff;
  border-radius: 4px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-family: inherit;
  transition: background 0.15s ease;
  user-select: none;
  height: 32px;
  box-sizing: border-box;
  letter-spacing: 0.2px;
  white-space: nowrap;
}
.otp-btn:hover { background: rgb(20, 115, 210); }
.otp-btn:disabled { opacity: 0.6; cursor: not-allowed; }

/* Connection Dot */
.otp-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: #ef4444; flex: none;
  transition: background 0.2s ease;
}
.otp-dot.connected { background: #22c55e; }

/* Gear Icon Button matching site secondary buttons */
.otp-gear {
  background: rgb(24, 26, 27);
  border: 1px solid rgb(85, 85, 85);
  color: rgb(232, 230, 227);
  border-radius: 4px;
  width: 32px; height: 32px;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
  user-select: none; box-sizing: border-box; padding: 0;
}
.otp-gear:hover { background: rgb(35, 38, 41); border-color: #aaa; }

/* Settings Popover */
.otp-popover {
  display: none; position: absolute; top: 40px; right: 0;
  width: 240px; background: rgb(24, 26, 27);
  border: 1px solid rgb(85, 85, 85); border-radius: 6px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.6);
  padding: 6px; font-family: inherit; font-size: 12px;
  color: rgb(232, 230, 227); z-index: 10000;
}
.otp-popover.open { display: block; }

/* Floating settings (non-build pages, e.g. homepage) */
#otp-float-settings { position: fixed; right: 18px; bottom: 18px; z-index: 10001; }
#otp-float-settings .otp-gear { width: 40px; height: 40px; border-radius: 50%; box-shadow: 0 6px 20px rgba(0,0,0,0.55); }
#otp-float-settings .otp-popover { position: absolute; top: auto; bottom: 50px; right: 0; }

.otp-popover-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 8px 8px;
  border-bottom: 1px solid rgb(50, 53, 56);
  font-weight: 600; font-size: 12.5px;
}
.otp-popover-status {
  display: flex; align-items: center; gap: 5px;
  font-size: 11px; color: #9aa3b8;
}
.otp-switch-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 8px; border-radius: 4px;
  cursor: pointer; user-select: none;
}
.otp-switch-row:hover { background: rgba(255,255,255,0.05); }

.otp-sw {
  width: 28px; height: 16px; border-radius: 8px;
  background: #3a4358; position: relative; flex: none;
  transition: background 0.15s ease;
}
.otp-sw::after {
  content: ""; position: absolute; top: 2px; left: 2px;
  width: 12px; height: 12px; border-radius: 50%;
  background: #aeb6c9; transition: left 0.15s ease;
}
.otp-switch-row.on .otp-sw { background: rgb(16, 99, 183); }
.otp-switch-row.on .otp-sw::after { left: 14px; background: #fff; }

.otp-popover-log {
  padding: 6px 8px 2px; font-size: 11px;
  color: #8b93a8; min-height: 14px;
}

/* Updates section in the settings menu */
.otp-upd { padding: 8px 8px 6px; border-top: 1px solid rgb(50,53,56); }
.otp-upd-row { display: flex; align-items: center; justify-content: space-between; font-size: 12px; font-weight: 500; }
.otp-upd-row .v { color: #8b93a8; font-weight: 400; font-size: 11px; }
#otp-upd-status { font-size: 11px; color: #c2baaf; margin: 4px 0 7px; min-height: 13px; }
#otp-upd-status.err { color: #f87171; }
#otp-upd-status.ok { color: #3fb950; }
.otp-upd-btn { width: 100%; height: 26px; border-radius: 5px; border: 1px solid rgb(85,85,85); background: rgb(33,35,36);
  color: #e8e6e3; font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer; }
.otp-upd-btn:hover:not(:disabled) { border-color: #aaa; }
.otp-upd-btn:disabled { opacity: .55; cursor: default; }
.otp-upd-btn.go { background: rgb(16,99,183); border-color: rgb(16,99,183); color: #fff; }

/* Update progress lives on the floating gear: rim = progress ring, icon -> % / ↻ */
#otp-float-settings .otp-gear { position: relative; overflow: visible; }
.otp-upd-ring { position: absolute; left: -4px; top: -4px; pointer-events: none; transform: rotate(-90deg); opacity: 0; transition: opacity .2s; }
.otp-gear.upd .otp-upd-ring { opacity: 1; }
.otp-upd-ring .trk { stroke: rgb(50,53,56); }
.otp-upd-ring .bar { stroke: rgb(16,99,183); transition: stroke-dashoffset .3s ease; }
.otp-gear.upd-ready .otp-upd-ring .bar { stroke: #3fb950; }
.otp-gear.upd-checking .otp-upd-ring .bar { stroke-dasharray: 34 200 !important; animation: otpspin 1s linear infinite; transform-origin: 23px 23px; }
.otp-gear-icon { display: inline-flex; }
.otp-gear-pct { display: none; font-size: 11px; font-weight: 800; font-variant-numeric: tabular-nums; }
.otp-gear.upd-dl .otp-gear-icon { display: none; }
.otp-gear.upd-dl .otp-gear-pct { display: inline; }
.otp-gear.upd-ready .otp-gear-pct { font-size: 16px; color: #3fb950; }
@keyframes otpspin { to { transform: rotate(360deg); } }
`;

// ---- State ----
let clientState = { connected: false, name: 'Offline' };
let lastAutoImport = null;

// ---- Import Handler ----
async function doImport(auto = false) {
  const btn = document.getElementById('otp-import-btn');
  if (btn) btn.disabled = true;

  const b = await parseBuild();
  if (!b || b.error) {
    if (btn) btn.disabled = false;
    if (!auto) toast('Build error: ' + (b?.error ?? 'Unknown'), false);
    return;
  }
  b.flashSlot = settings.flashSlot || 'D';

  const res = await ipcRenderer.invoke('otp:import-build', b);
  if (btn) btn.disabled = false;

  const logEl = document.getElementById('otp-log');
  if (res.ok) {
    // Only claim what actually succeeded (main reports per-part results)
    const parts = [res.rune ? 'Runes' : null, res.items ? 'Items' : null, res.spells ? 'Spells' : null].filter(Boolean);
    const failed = [res.rune ? null : ('Runes: ' + (res.runeError || 'failed')), res.items ? null : ('Items: ' + (res.itemError || 'failed'))].filter(Boolean);
    const rateText = b.rate ? ` (${(b.rate * 100).toFixed(0)}% WR)` : '';
    if (logEl) logEl.textContent = `${b.champion} ✓ ${parts.join(' + ') || 'nothing'}${rateText} [${b.runes?.source || 'static'}]${failed.length ? ' | FAILED: ' + failed.join('; ') : ''}`;
    if (failed.length) toast(`Imported ${parts.join(' + ') || 'nothing'} — FAILED: ${failed.join('; ')}`, false);
    else toast(`Imported: ${b.champion} (${parts.join(' + ')})`);
  } else {
    if (logEl) logEl.textContent = 'Error: ' + res.error;
    toast('Import failed: ' + res.error, false);
  }
}

// ---- Client Status UI Update ----
function updateClientStatusUI() {
  document.querySelectorAll('.otp-dot').forEach(d => {
    d.classList.toggle('connected', clientState.connected);
  });
  const statusTxt = document.getElementById('otp-status-label');
  if (statusTxt) {
    statusTxt.textContent = clientState.connected ? clientState.name : 'LoL Offline';
  }
  const btn = document.getElementById('otp-import-btn');
  if (btn) {
    btn.title = clientState.connected
      ? `Client connected (${clientState.name}) - Click to Import`
      : 'LoL Client Offline';
  }
}

function togglePopover() {
  const popover = document.getElementById('otp-popover');
  if (!popover) return;
  popover.classList.toggle('open');
  if (popover.classList.contains('open')) paintSettingsPopover(popover);
}

// ---- Inject CSS ----
function injectStyles() {
  if (document.getElementById('otp-injected-css')) return;
  const st = document.createElement('style');
  st.id = 'otp-injected-css';
  st.textContent = CSS;
  document.head.appendChild(st);
}

// ---- Remove "Get Pro" button from page ----
function removeGetProButton() {
  try {
    document.querySelectorAll('a.get-pro-btn, .get-pro-btn').forEach(el => el.remove());
  } catch {}
}

// ---- Inject UI: Inline with champion title, vertically centered ----
// DOM: champBox = h1.parentElement.parentElement
//   = div[display:flex;align-items:center;margin:20px 0;gap:5px]
//   contains: [avatar div] [text div with h1 + "Bot, Masters+"]
// We append our action bar as a 3rd flex child of champBox.
function injectHeaderActions() {
  const isBuildPage = location.pathname.includes('/champions/builds/');
  const existing = document.getElementById('otp-header-actions');
  if (!isBuildPage) {
    if (existing) existing.remove();
    return;
  }

  const h1 = document.querySelector('h1');
  if (!h1) return;

  // champBox is the flex container with avatar + title
  const champBox = h1.parentElement?.parentElement;
  if (!champBox) return;

  if (existing && champBox.contains(existing)) return; // already injected
  if (existing) existing.remove();

  const bar = document.createElement('div');
  bar.id = 'otp-header-actions';
  bar.style.cssText = 'display:inline-flex;align-items:center;gap:8px;margin-left:20px;flex:none;position:relative;align-self:flex-start;';

  // Import button
  const importBtn = document.createElement('button');
  importBtn.id = 'otp-import-btn';
  importBtn.className = 'otp-btn';
  importBtn.title = clientState.connected
    ? `Client connected (${clientState.name}) - Click to Import`
    : 'LoL Client Offline';

  const dot1 = document.createElement('span');
  dot1.className = 'otp-dot' + (clientState.connected ? ' connected' : '');
  const importText = document.createElement('span');
  importText.textContent = 'Import';

  importBtn.appendChild(dot1);
  importBtn.appendChild(importText);
  importBtn.onclick = () => doImport(false);

  // Settings live only in the bottom-right floating button now (on every page);
  // a second popover here shared its id and removed the other one.
  bar.appendChild(importBtn);
  champBox.appendChild(bar);

  // Vertical align: center the button group with the h1 title
  requestAnimationFrame(() => {
    try {
      const boxTop = champBox.getBoundingClientRect().top;
      const hTop = h1.getBoundingClientRect().top;
      const mt = (hTop - boxTop) + (h1.offsetHeight - bar.offsetHeight) / 2;
      if (mt > 0) bar.style.marginTop = mt.toFixed(1) + 'px';
    } catch {}
  });

  updateClientStatusUI();
}

// ---- Shared settings popover (build page bar + floating button) ----
function paintSettingsPopover(popover) {
  if (!popover) return;
  popover.querySelectorAll('.otp-switch-row').forEach(r => {
    r.classList.toggle('on', !!settings[r.dataset.k]);
  });
  const cur = (settings.flashSlot || 'D').toUpperCase();
  popover.querySelectorAll('.otp-flash-btn').forEach(btn => {
    const isSel = btn.dataset.slot === cur;
    btn.style.background = isSel ? 'rgb(16, 99, 183)' : 'transparent';
    btn.style.color = isSel ? '#ffffff' : '#8f96a3';
  });
}

function buildSettingsPopover() {
  const old = document.getElementById('otp-popover');
  if (old) old.remove();
  const popover = document.createElement('div');
  popover.id = 'otp-popover';
  popover.className = 'otp-popover';
  popover.innerHTML = `
    <div class="otp-popover-head">
      <span>LoL Client</span>
      <span class="otp-popover-status">
        <span class="otp-dot ${clientState.connected ? 'connected' : ''}"></span>
        <span id="otp-status-label">${clientState.connected ? clientState.name : 'Offline'}</span>
      </span>
    </div>
    <div style="padding: 4px 0;">
      <div class="otp-switch-row" data-k="follow">
        <span>Auto Follow Pick</span>
        <span class="otp-sw"></span>
      </div>
      <div class="otp-switch-row" data-k="autoBuild">
        <span>Auto Import (Hover / Pick)</span>
        <span class="otp-sw"></span>
      </div>
      <div class="otp-switch-row" data-k="autoMatchup">
        <span>Auto Matchup (Lane Opponent)</span>
        <span class="otp-sw"></span>
      </div>
      <div class="otp-switch-row" data-k="autoAccept">
        <span>Auto Accept Match</span>
        <span class="otp-sw"></span>
      </div>
      <div class="otp-switch-row" data-k="autoSpell">
        <span>Auto Select Spells</span>
        <span class="otp-sw"></span>
      </div>
      <div class="otp-switch-row" data-k="overlay">
        <span>In-Game Spell Timers</span>
        <span class="otp-sw"></span>
      </div>
    </div>
    <div style="padding:6px 8px;border-top:1px solid rgb(50,53,56);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin:4px 0;user-select:none;">
        <span style="font-size:12px;color:#e8e6e3;font-weight:500;">Flash Key</span>
        <div id="otp-flash-group" style="display:inline-flex;background:rgb(15,18,20);border:1px solid rgb(70,75,85);border-radius:4px;overflow:hidden;">
          <button type="button" class="otp-flash-btn" data-slot="D" style="padding:3px 12px;font-size:11px;font-weight:700;border:none;cursor:pointer;outline:none;transition:all 0.15s ease;">D</button>
          <button type="button" class="otp-flash-btn" data-slot="F" style="padding:3px 12px;font-size:11px;font-weight:700;border:none;cursor:pointer;outline:none;transition:all 0.15s ease;">F</button>
        </div>
      </div>
    </div>
    <div class="otp-upd">
      <div class="otp-upd-row"><span>Updates</span><span class="v" id="otp-upd-ver"></span></div>
      <div id="otp-upd-status"></div>
      <button type="button" class="otp-upd-btn" id="otp-upd-btn">Check for updates</button>
    </div>
    <div id="otp-log" class="otp-popover-log"></div>
  `;
  const updBtn = popover.querySelector('#otp-upd-btn');
  updBtn.onclick = (e) => {
    e.stopPropagation();
    if (updInfo.state === 'ready') { ipcRenderer.send('otp:update-install'); return; }
    paintUpdate({ ...updInfo, state: 'checking' });
    ipcRenderer.invoke('otp:update-check').then((s) => { if (s) paintUpdate(s); }).catch(() => {});
  };
  popover.querySelectorAll('.otp-switch-row').forEach(r => {
    r.onclick = (e) => {
      e.stopPropagation();
      settings[r.dataset.k] = !settings[r.dataset.k];
      saveSettings();
      paintSettingsPopover(popover);
    };
  });
  popover.querySelectorAll('.otp-flash-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      settings.flashSlot = btn.dataset.slot;
      saveSettings();
      paintSettingsPopover(popover);
      toast(`Flash assigned to ${settings.flashSlot} key`);
    };
  });
  paintSettingsPopover(popover);
  return popover;
}

// ---- Floating settings button for non-build pages (homepage etc.) ----
// Bottom-right settings button on every page (build pages too: the gear next to
// Import scrolls away with the page).
function injectFloatingSettings() {
  const existing = document.getElementById('otp-float-settings');
  if (existing) return;
  const wrap = document.createElement('div');
  wrap.id = 'otp-float-settings';
  // The gear itself shows update progress: its rim becomes a progress ring and the
  // icon turns into the percentage while downloading (↻ when ready).
  const gearBtn = document.createElement('button');
  gearBtn.id = 'otp-float-gear';
  gearBtn.className = 'otp-gear';
  gearBtn.title = 'OTP Settings';
  gearBtn.innerHTML = `<svg class="otp-upd-ring" viewBox="0 0 46 46" width="46" height="46"><circle class="trk" cx="23" cy="23" r="21" fill="none" stroke-width="2.5"/><circle class="bar" cx="23" cy="23" r="21" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="131.95" stroke-dashoffset="131.95"/></svg><span class="otp-gear-icon">${GEAR_SVG}</span><span class="otp-gear-pct"></span>`;
  gearBtn.onclick = (e) => { e.stopPropagation(); togglePopover(); };
  wrap.appendChild(gearBtn);
  wrap.appendChild(buildSettingsPopover());
  document.body.appendChild(wrap);
  updateClientStatusUI();
  paintUpdate(updInfo);
}

// ---- Update state (main: 'otp:update-state') -> settings menu + round badge ----
let updInfo = { state: 'idle' };
function paintUpdate(s) {
  updInfo = s || updInfo;
  const st = updInfo.state;
  const ver = document.getElementById('otp-upd-ver');
  if (ver && updInfo.current) ver.textContent = 'v' + updInfo.current;
  const status = document.getElementById('otp-upd-status');
  const btn = document.getElementById('otp-upd-btn');
  if (status && btn) {
    const msg = {
      idle: '', checking: 'Checking…', none: 'You have the latest version',
      downloading: `Downloading v${updInfo.version || ''} · ${updInfo.percent || 0}%`,
      ready: `v${updInfo.version || ''} is ready to install`,
      error: 'Could not check: ' + (updInfo.message || 'unknown error'),
      dev: updInfo.message || 'Updates work in the installed app only',
    }[st] ?? '';
    status.textContent = msg;
    status.className = st === 'error' ? 'err' : (st === 'none' || st === 'ready') ? 'ok' : '';
    btn.textContent = st === 'ready' ? 'Restart to update' : st === 'downloading' ? 'Downloading…' : st === 'checking' ? 'Checking…' : 'Check for updates';
    btn.disabled = st === 'checking' || st === 'downloading';
    btn.classList.toggle('go', st === 'ready');
  }
  const gear = document.getElementById('otp-float-gear');
  if (gear) {
    gear.classList.toggle('upd', st === 'checking' || st === 'downloading' || st === 'ready');
    gear.classList.toggle('upd-ready', st === 'ready');
    gear.classList.toggle('upd-checking', st === 'checking');
    gear.classList.toggle('upd-dl', st === 'downloading' || st === 'ready');
    const pct = st === 'ready' ? 100 : st === 'downloading' ? (updInfo.percent || 0) : 0;
    const bar = gear.querySelector('.otp-upd-ring .bar');
    if (bar && st !== 'checking') bar.setAttribute('stroke-dashoffset', String(131.95 * (1 - pct / 100)));
    gear.querySelector('.otp-gear-pct').textContent = st === 'ready' ? '↻' : st === 'downloading' ? pct + '%' : '';
    gear.title = st === 'ready' ? `Update v${updInfo.version || ''} ready: open settings to restart`
      : st === 'downloading' ? `Downloading update v${updInfo.version || ''}: ${pct}%`
      : st === 'checking' ? 'Checking for updates…' : 'OTP Settings';
  }
}
ipcRenderer.on('otp:update-state', (_e, s) => paintUpdate(s));
ipcRenderer.invoke('otp:update-get').then((s) => { if (s) paintUpdate(s); }).catch(() => {});

// Close any open settings popover when clicking outside (registered once)
if (!window._otpCloser) {
  window._otpCloser = true;
  document.addEventListener('click', (e) => {
    if (e.target.closest('.otp-popover') || e.target.closest('#otp-header-actions') || e.target.closest('#otp-float-settings')) return;
    document.querySelectorAll('.otp-popover.open').forEach(p => p.classList.remove('open'));
  });
}

// Tint and size the native min/max/close buttons to the site header
// (home header #141415, inner pages #212324).
function syncCaption() {
  const h = document.querySelector('header');
  if (!h) return;
  let el = h, bg = 'rgba(0, 0, 0, 0)';
  while (el && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { bg = getComputedStyle(el).backgroundColor; el = el.parentElement; }
  const m = bg.match(/\d+/g);
  if (!m) return;
  const hex = '#' + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  // Inner pages' <header> has no box of its own (height 0); its <ul> is the bar.
  const height = Math.round(Math.max(h.getBoundingClientRect().height,
    h.firstElementChild ? h.firstElementChild.getBoundingClientRect().height : 0)) || 40;
  document.documentElement.style.setProperty('--otp-hh', height + 'px');
  try { ipcRenderer.send('otp:caption', { color: hex, height }); } catch {}
}
window.addEventListener('resize', () => { clearTimeout(window._otpCapT); window._otpCapT = setTimeout(syncCaption, 150); });

function mountUI() {
  syncCaption();
  injectStyles();
  removeGetProButton();
  injectHeaderActions();
  injectFloatingSettings();
  injectTierNav();
  checkPendingAutoImport();
  renderLobbyPanel();
  mountSearchPanel();
  if (otpPro === null) checkPro(); else applyPro();
  maybeAutoMatchup();
}

// ---- Instant Auto-Import on any rune / set / filter selection ----
let _autoImportTimer = null;
document.addEventListener('click', (e) => {
  const target = e.target;
  if (!target) return;

  // Ignore clicks inside our own header bar, floating settings, or popover
  if (target.closest('#otp-header-actions') || target.closest('#otp-float-settings') || target.closest('.otp-popover') || target.closest('#otp-lobby') || target.closest('#otp-msearch')) return;

  if (!location.pathname.includes('/champions/builds/')) return;

  // Check if click was inside runes card, starting items, build path, or first-item filter
  const card = target.closest('.cardBorder') || target.closest('[class*="card"]');
  const isFilterBtn = target.closest('button, [role="tab"], .builds__tab, div[style*="cursor"]');
  const isClickable = isFilterBtn || (card && (target.closest('div') || target.tagName === 'IMG' || target.tagName === 'SPAN'));

  if (isClickable && (card || isFilterBtn)) {
    clearTimeout(_autoImportTimer);
    _autoImportTimer = setTimeout(async () => {
      try {
        await doImport(true);
      } catch (err) {
        console.error('[otp] instant auto-import failed:', err);
      }
    }, 250);
  }
}, true);

// ---- Auto-Import Check upon navigation ----
function checkPendingAutoImport() {
  try {
    const pending = localStorage.getItem('otp.pendingAuto');
    if (!pending) return;
    const m = location.pathname.match(/\/champions\/builds\/([^/]+)/i);
    if (m && m[1].toLowerCase() === pending.toLowerCase() && settings.autoBuild) {
      localStorage.removeItem('otp.pendingAuto');
      lastAutoImport = pending.toLowerCase();
      setTimeout(() => doImport(true), 350);
    }
  } catch {}
}

async function refreshLcuStatus() {
  try {
    const s = await ipcRenderer.invoke('otp:lcu-status');
    clientState = s;
    updateClientStatusUI();
  } catch {}
}

// ---- Champion Select Listener: Instant Auto-Import ----
ipcRenderer.on('otp:auto-champ', async (_e, info) => {
  const name = typeof info === 'string' ? info : info?.name;
  if (!name) return;
  const want = name.toLowerCase();

  // If already on the page for this champion, run import directly
  const isCur = location.pathname.toLowerCase().includes(`/champions/builds/${want}`);
  if (isCur) {
    if (settings.autoBuild && lastAutoImport !== want) {
      lastAutoImport = want;
      doImport(true);
    }
    return;
  }

  // If follow will navigate or user is switching champions, queue auto-import for when the page arrives
  if (settings.autoBuild && lastAutoImport !== want) {
    lastAutoImport = want;
    try { localStorage.setItem('otp.pendingAuto', want); } catch {}
  }
});

// ---- Tier List: hide PRO badges, themed Tier button + overlay, remove ad slots ----
const TIER_CSS = `
.pro-badge{display:none !important}
html.otp-nopro [class*="AdvancedSearch_container"],html.otp-nopro .otp-pro-only{display:none !important}
a.pro-btn,button.pro-btn,a.get-pro-btn{display:none !important}
.header-menu-btn, .home-header-menu-btn{display:none !important}
a[href*="discord"], .sidePanel{display:none !important}
#otp-tiernav,#otp-sumnav{display:inline-flex !important;align-items:center !important;cursor:pointer !important}
/* The site's header is the window title bar: drag on empty space, clickables stay
   clickable, and the right edge leaves room for the native min/max/close buttons. */
/* Inner pages: <header> has no box of its own, its fixed <ul> is the bar, so the ul
   needs the drag region too. */
header,header>ul{-webkit-app-region:drag;user-select:none}
header a,header button,header input,header [role],header [type="button"],header svg,header img,header select,header .IconButton{-webkit-app-region:no-drag}
header>ul{padding-right:142px !important;box-sizing:border-box}
/* Keep the header (= title bar) on top while scrolling. Inner pages already pin
   their header (fixed <ul>); the home page header (layout_headerTop) scrolls away,
   so pin it and push the page down by its height (--otp-hh, set by syncCaption). */
header[class*="layout_headerTop"]{position:fixed !important;top:0 !important;left:0 !important;right:0 !important;z-index:1000 !important}
body:has(header[class*="layout_headerTop"]){padding-top:var(--otp-hh,66px) !important}
/* Page scrollbar: no track background, and the track starts below the header so it
   never runs under the window's caption buttons (same as the local pages). */
html::-webkit-scrollbar{width:10px !important;background:transparent !important}
html::-webkit-scrollbar-track{background:transparent !important;margin-top:var(--otp-hh,66px) !important}
html::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16) !important;border-radius:10px !important;border:2px solid transparent !important;background-clip:padding-box !important}
html::-webkit-scrollbar-thumb:hover{background-color:rgba(255,255,255,.28) !important}
html::-webkit-scrollbar-corner{background:transparent !important}
#ad-slot,[id="ad-slot"],.vm-placement,[class*="vm-placement"],.ad-slot,.square-ad,.ad-md,.ad-lg,.ad-sidePanel,[class*="ad-leftSidePanel"],[class*="ad-rightSidePanel"],ins.adsbygoogle,iframe[src*="safeframe"],iframe[id^="google_ads"],[id^="div-gpt-ad"],[class*="pw-tag"],[id*="pw-oop"]{display:none !important;height:0 !important;min-height:0 !important;max-height:0 !important;margin:0 !important;padding:0 !important;opacity:0 !important;pointer-events:none !important;visibility:hidden !important;}
`;

function injectTierNav() {
  if (!document.getElementById('otp-tier-css')) {
    const st = document.createElement('style');
    st.id = 'otp-tier-css';
    st.textContent = TIER_CSS;
    document.head.appendChild(st);
  }
  const header = document.querySelector('header');
  if (!header) return;

  header.querySelectorAll('a[href*="login" i], a[href*="signin" i], a[href*="account" i], button[aria-label*="account" i], button[aria-label*="login" i]').forEach((el) => {
    el.style.display = 'none';
  });

  // Find site's existing Tier List link in header
  const origTier = Array.from(header.querySelectorAll('a')).find((a) =>
    a.id === 'otp-tiernav' || (!a.id && /tier\s*list/i.test(a.textContent || ''))
  );

  if (origTier) {
    origTier.id = 'otp-tiernav';
    origTier.removeAttribute('aria-describedby');
    origTier.style.cssText = 'display:inline-flex !important;align-items:center;color:var(--text);text-decoration:none;cursor:pointer;margin:0 !important;';
    origTier.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { ipcRenderer.send('otp:open-tier'); } catch {}
    };

    if (!document.getElementById('otp-sumnav')) {
      const sb = document.createElement('a');
      sb.id = 'otp-sumnav';
      sb.className = origTier.className || 'header-btns';
      sb.href = 'javascript:void(0)';
      sb.onclick = (e) => {
        e.preventDefault();
        try { ipcRenderer.send('otp:open-summoner'); } catch {}
      };

      const parent = origTier.parentElement;
      const isGap = parent && getComputedStyle(parent).gap && getComputedStyle(parent).gap !== 'normal';
      if (isGap) {
        sb.style.cssText = 'color:var(--text);text-decoration:none;cursor:pointer;display:inline-flex !important;align-items:center;white-space:nowrap;margin:0 0 0 12px !important;';
        sb.innerHTML = '<div style="color:var(--text);">Summoner</div>';
      } else {
        // Home page header: no flex gap, each item's inner div carries margin-right
        // (20px today). Copy that spacing so Summoner doesn't touch Discover.
        const sib = origTier.nextElementSibling || origTier.previousElementSibling;
        const sibInner = sib && (sib.firstElementChild || sib);
        const sp = (sibInner && parseFloat(getComputedStyle(sibInner).marginRight)) || 20;
        const tierInner = origTier.firstElementChild;
        if (tierInner && !parseFloat(getComputedStyle(tierInner).marginRight)) {
          origTier.style.setProperty('margin-right', sp + 'px', 'important');
        }
        sb.style.cssText = 'color:var(--text);text-decoration:none;cursor:pointer;display:inline-flex !important;align-items:center;margin:0;';
        sb.innerHTML = `<div style="color:var(--text);display:inline-block;margin-right:${sp}px;">Summoner</div>`;
      }
      origTier.after(sb);
    }
    return;
  }

  if (document.getElementById('otp-tiernav')) return;

  // Fallback if site had no Tier List link
  const navLink = header.querySelector('a[href*="champions"], a[href*="leaderboard"], a[href*="multisearch"], a[href*="discover"], nav a');
  const anchor = navLink ? (navLink.parentElement?.lastElementChild || navLink) : null;
  if (!anchor || !anchor.parentElement) return;

  const btn = document.createElement('a');
  btn.id = 'otp-tiernav';
  btn.textContent = 'Tier List';
  btn.href = 'javascript:void(0)';
  btn.className = anchor.className || 'header-btns';
  btn.style.cssText = 'color:var(--text);text-decoration:none;cursor:pointer;display:inline-flex !important;align-items:center;margin-left:16px;';
  btn.onclick = (e) => { e.preventDefault(); try { ipcRenderer.send('otp:open-tier'); } catch {} };

  const sb = document.createElement('a');
  sb.id = 'otp-sumnav';
  sb.textContent = 'Summoner';
  sb.href = 'javascript:void(0)';
  sb.className = anchor.className || 'header-btns';
  sb.style.cssText = 'color:var(--text);text-decoration:none;cursor:pointer;display:inline-flex !important;align-items:center;margin-left:16px;';
  sb.onclick = (e) => { e.preventDefault(); try { ipcRenderer.send('otp:open-summoner'); } catch {} };

  anchor.parentElement.appendChild(btn);
  anchor.parentElement.appendChild(sb);
}

// The site's own "Tier List" is a PRO-gated popup trigger that React re-renders,
// so an element-level onclick gets lost. Catch it at window capture, before React.
function isTierNavTarget(t) {
  const a = t && t.closest && t.closest('header a');
  if (!a) return false;
  return a.id === 'otp-tiernav' || /tier\s*list/i.test(a.textContent || '');
}
['pointerdown', 'mousedown', 'click'].forEach((type) => {
  window.addEventListener(type, (e) => {
    if (!isTierNavTarget(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (type === 'click') { try { ipcRenderer.send('otp:open-tier'); } catch {} }
  }, true);
});

// If main already imported (fast auto import), skip own flow, just notify
ipcRenderer.on('otp:auto-imported', (_e, info) => {
  if (!info) return;
  if (info.name) {
    lastAutoImport = info.name.toLowerCase();
    try { localStorage.removeItem('otp.pendingAuto'); } catch {}
    const logEl = document.getElementById('otp-log');
    if (logEl) logEl.textContent = `${info.name} ✓ runes+items${info.spells ? '+spells' : ''} (auto)`;
    toast(`Auto imported: ${info.name}`);
  } else if (info.error) {
    const logEl = document.getElementById('otp-log');
    if (logEl) logEl.textContent = 'Auto error: ' + info.error;
  }
});

// ---- Lobby panel (build pages): players in champ select / the live game ----
// State comes from main (lobby.js, 'otp:lobby-state'). Shows rank and recent games
// on the current pick for both teams; an enemy row opens this build vs that
// champion (?matchup=), "Vs their team" fills onetricks' advanced search with both
// comps (adv_e* / adv_a*).
let lobbyState = null;
const LOBBY_ROLES = ['top', 'jungle', 'mid', 'bot', 'supp'];
const ROLE_LABEL = { top: 'Top', jungle: 'Jg', mid: 'Mid', bot: 'Bot', supp: 'Sup' };
const ADV_SUFFIX = { top: 'top', jungle: 'jg', mid: 'mid', bot: 'bot', supp: 'supp' };
const RANK_COLOR = { IRON: '#8c7b72', BRONZE: '#b0816d', SILVER: '#9fb0bb', GOLD: '#d6a64b', PLATINUM: '#4fb3a9', EMERALD: '#2fb96b', DIAMOND: '#6c95f2', MASTER: '#b866dc', GRANDMASTER: '#e0605a', CHALLENGER: '#f0c75e' };
const DIV_NUM = { I: '1', II: '2', III: '3', IV: '4' };
const LOBBY_CSS = `
#otp-lobby{background:var(--fg,#212324);border:1px solid var(--border-light,#2c2f31);border-radius:10px;padding:14px 16px 12px;margin:0 0 16px;color:var(--text,#e8e6e3);font-size:13px;box-sizing:border-box}
#otp-lobby .lb-head{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
#otp-lobby .lb-title{font-weight:700;font-size:15px}
#otp-lobby .lb-sub{color:var(--lightText,#c2baaf);font-size:12px}
#otp-lobby .lb-live{width:8px;height:8px;border-radius:50%;background:#2fb96b;box-shadow:0 0 0 3px rgba(47,185,107,.18)}
#otp-lobby .lb-acts{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
#otp-lobby .lb-btn{background:var(--fg-raised,#2c2e2f);border:1px solid var(--border-light,#2c2f31);color:var(--text,#e8e6e3);border-radius:8px;padding:6px 11px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
#otp-lobby .lb-btn:hover{background:var(--hover,#1b1d1e);border-color:var(--border,#656e73)}
#otp-lobby .lb-btn.primary{background:var(--blue,#1063b7);border-color:var(--blue,#1063b7);color:#fff}
#otp-lobby .lb-btn.primary:hover{filter:brightness(1.1)}
#otp-lobby .lb-btn img{width:16px;height:16px;border-radius:4px}
#otp-lobby .lb-cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media (max-width:900px){#otp-lobby .lb-cols{grid-template-columns:1fr}}
#otp-lobby .lb-col h4{margin:0 0 6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;font-weight:700}
#otp-lobby .lb-col.enemy h4{color:#e0605a}
#otp-lobby .lb-col.ally h4{color:#4f9be8}
#otp-lobby .lb-row{display:grid;grid-template-columns:30px 34px minmax(0,1fr) auto;align-items:center;gap:9px;padding:5px 8px;border-radius:8px;border:1px solid transparent}
#otp-lobby .lb-row+.lb-row{margin-top:2px}
#otp-lobby .lb-row.me{background:rgba(16,99,183,.14);border-color:rgba(16,99,183,.35)}
#otp-lobby .lb-col.enemy .lb-row[data-vs]{cursor:pointer}
#otp-lobby .lb-col.enemy .lb-row[data-vs]:hover{background:var(--hover,#1b1d1e);border-color:var(--border-light,#2c2f31)}
#otp-lobby .lb-row.on,#otp-lobby .lb-col.enemy .lb-row.on:hover{background:rgba(224,96,90,.12);border-color:rgba(224,96,90,.45)}
#otp-lobby .lb-role{font-size:11px;color:var(--lightText,#c2baaf);font-weight:600;text-align:center}
#otp-lobby .lb-ic{width:34px;height:34px;border-radius:8px;background:#151617;display:block;object-fit:cover}
#otp-lobby .lb-ic.none{border:1px dashed var(--border,#656e73);box-sizing:border-box}
#otp-lobby .lb-who{min-width:0}
#otp-lobby .lb-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#otp-lobby .lb-name .tag{color:var(--lightText,#c2baaf);font-weight:400}
#otp-lobby .lb-name.hidden{color:var(--lightText,#c2baaf);font-style:italic;font-weight:400}
#otp-lobby .lb-rank{font-size:12px;color:var(--lightText,#c2baaf);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#otp-lobby .lb-rank b{font-weight:700}
#otp-lobby .lb-stat{text-align:right;font-size:12px;white-space:nowrap}
#otp-lobby .lb-stat .g{color:var(--lightText,#c2baaf)}
#otp-lobby .lb-b{margin-top:3px}
#otp-lobby .lb-badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:700;vertical-align:1px}
#otp-lobby .lb-badge.otp{background:#f5c518;color:#1b1b1b}
#otp-lobby .lb-badge.first{background:var(--fg-raised,#2c2e2f);color:var(--lightText,#c2baaf);border:1px solid var(--border-light,#2c2f31)}
#otp-lobby .wr-hi{color:#2fb96b}
#otp-lobby .wr-lo{color:#e0605a}
#otp-lobby .lb-note{margin-top:8px;font-size:11px;color:var(--lightText,#c2baaf)}
`;

function lobbyChampOfPage() {
  const m = location.pathname.match(/\/champions\/builds\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}
let lobbyDdVer = '16.23.1';
(async () => {
  try {
    const c = JSON.parse(localStorage.getItem('otp.ddver') || 'null');
    if (c && Date.now() - c.ts < 86400000) { lobbyDdVer = c.v; return; }
    const v = (await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json())[0];
    if (v) { lobbyDdVer = v; localStorage.setItem('otp.ddver', JSON.stringify({ ts: Date.now(), v })); }
  } catch {}
})();
function lobbyIcon(champ) {
  return champ ? `https://ddragon.leagueoflegends.com/cdn/${lobbyDdVer}/img/champion/${champ}.png` : '';
}
const lobbyEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function lobbyRankText(r) {
  if (!r) return '<span>Unranked</span>';
  const t = r.tier.charAt(0) + r.tier.slice(1).toLowerCase();
  const apex = /MASTER|GRANDMASTER|CHALLENGER/.test(r.tier);
  const g = r.wins + r.losses;
  const wr = g ? Math.round((r.wins / g) * 100) : null;
  return `<b style="color:${RANK_COLOR[r.tier] || 'inherit'}">${t}${apex ? '' : ' ' + (DIV_NUM[r.division] || r.division || '')}</b> ${r.lp} LP`
    + (wr != null ? ` · <span class="${wr >= 53 ? 'wr-hi' : wr <= 47 ? 'wr-lo' : ''}">${wr}%</span> <span class="g">(${g})</span>` : '');
}
function lobbyStatText(p) {
  const rc = p.recent;
  if (!rc || !p.champ) return "";
  const badge = rc.otp ? `<span class="lb-badge otp" title="Most of their last ${rc.total} games are on this champion">OTP</span>`
    : rc.first ? `<span class="lb-badge first" title="No games on this champion in their last ${rc.total}">1st time</span>` : "";
  const wr = rc.games ? Math.round((rc.wins / rc.games) * 100) : null;
  const top = rc.games
    ? `<span class="${wr >= 55 ? "wr-hi" : wr <= 45 ? "wr-lo" : ""}">${wr}%</span> <span class="g">${rc.games}/${rc.total}</span>`
    : `<span class="g">0/${rc.total}</span>`;
  return `<div>${top}</div>${badge ? `<div class="lb-b">${badge}</div>` : ""}`;
}

function lobbySort(list) {
  const idx = (r) => { const i = LOBBY_ROLES.indexOf(r); return i < 0 ? 9 : i; };
  return [...list].sort((a, b) => idx(a.role) - idx(b.role));
}
function lobbyBuildUrl(params) {
  const champ = lobbyChampOfPage() || lobbyState?.me?.champ;
  if (!champ) return null;
  const s = new URLSearchParams(params).toString();
  return `/champions/builds/${encodeURIComponent(champ)}${s ? '?' + s : ''}`;
}
function lobbyGo(url) { if (url && url !== location.pathname + location.search) location.assign(url); }

function renderLobbyPanel() {
  const isBuild = location.pathname.includes('/champions/builds/');
  let panel = document.getElementById('otp-lobby');
  const st = lobbyState;
  if (!isBuild || !st || !(st.allies?.length || st.enemies?.length)) { panel?.remove(); return; }
  if (!document.getElementById('otp-lobby-css')) {
    const s = document.createElement('style');
    s.id = 'otp-lobby-css';
    s.textContent = LOBBY_CSS;
    document.head.appendChild(s);
  }
  // Above the champion header card (the rounded card that holds the page's <h1>).
  const h1 = document.querySelector('h1');
  if (!h1) return;
  let card = h1;
  while (card.parentElement && card.parentElement !== document.body) {
    if (parseFloat(getComputedStyle(card).borderTopLeftRadius) >= 6 && card.getBoundingClientRect().width > 500) break;
    card = card.parentElement;
  }
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'otp-lobby';
    panel.addEventListener('click', onLobbyClick);
  }
  if (panel.nextElementSibling !== card) card.before(panel);

  const params = new URLSearchParams(location.search);
  const myRole = st.me?.role || '';
  const curMatchup = (params.get('matchup') || params.get('adv_e' + (ADV_SUFFIX[myRole] || 'x')) || '').toLowerCase();
  const opp = myRole ? (st.enemies || []).find((e) => e.role === myRole && e.champ) : null;

  const row = (p, side) => {
    const on = side === 'enemy' && p.champ && p.champ.toLowerCase() === curMatchup;
    const name = p.bot
      ? '<div class="lb-name hidden">Bot</div>'
      : p.hidden
      ? `<div class="lb-name hidden">${p.me ? 'You' : 'Hidden in champ select'}</div>`
      : `<div class="lb-name">${lobbyEsc(p.name)}${p.tag ? `<span class="tag"> #${lobbyEsc(p.tag)}</span>` : ''}</div>`;
    const vs = side === 'enemy' && p.champ ? ` data-vs="${lobbyEsc(p.champ)}" title="${on ? 'Showing this matchup' : 'Build vs ' + lobbyEsc(p.champ)}"` : '';
    return `<div class="lb-row${p.me ? ' me' : ''}${on ? ' on' : ''}"${vs}>
      <div class="lb-role">${ROLE_LABEL[p.role] || ''}</div>
      ${p.champ ? `<img class="lb-ic" src="${lobbyIcon(p.champ)}" alt="">` : '<div class="lb-ic none"></div>'}
      <div class="lb-who">${name}<div class="lb-rank">${p.hidden || p.bot ? '' : lobbyRankText(p.rank)}</div></div>
      <div class="lb-stat">${lobbyStatText(p)}</div>
    </div>`;
  };
  const hiddenAllies = (st.allies || []).some((a) => a.hidden && !a.me);
  const oppOn = opp && curMatchup === opp.champ.toLowerCase();
  panel.innerHTML = `
    <div class="lb-head">
      <span class="lb-live"></span>
      <span class="lb-title">${st.phase === 'InGame' ? 'Live game' : 'Champion select'}</span>
      <span class="lb-sub">Rank, and win rate / games on their pick in the last 20</span>
      <div class="lb-acts">
        ${opp ? `<button class="lb-btn${oppOn ? '' : ' primary'}" data-vs="${lobbyEsc(opp.champ)}"><img src="${lobbyIcon(opp.champ)}" alt="">Build vs ${lobbyEsc(opp.champ)}</button>` : ''}
        ${/[?&]matchup=/.test(location.search) ? '<button class="lb-btn" data-clear="1">All matchups</button>' : ''}
      </div>
    </div>
    <div class="lb-cols">
      <div class="lb-col ally"><h4>Your team</h4>${lobbySort(st.allies || []).map((p) => row(p, 'ally')).join('')}</div>
      <div class="lb-col enemy"><h4>Enemy team</h4>${lobbySort(st.enemies || []).map((p) => row(p, 'enemy')).join('') || '<div class="lb-note">Enemy picks show up as they lock in.</div>'}</div>
    </div>
    ${hiddenAllies ? '<div class="lb-note">Ranked champion select hides your teammates\' names; they show up once the game loads.</div>' : ''}`;
}

function onLobbyClick(e) {
  const t = e.target.closest('[data-vs],[data-adv],[data-clear]');
  if (!t) return;
  e.preventDefault();
  e.stopPropagation();
  const st = lobbyState || {};
  const role = st.me?.role || '';
  if (t.dataset.clear) { lobbyGo(lobbyBuildUrl({})); return; }
  if (t.dataset.vs) {
    const p = { matchup: t.dataset.vs };
    if (role) p.role = role;
    lobbyGo(lobbyBuildUrl(p));
    return;
  }
  if (t.dataset.adv) {
    const p = {};
    if (role) p.role = role;
    for (const x of st.enemies || []) if (x.champ && ADV_SUFFIX[x.role]) p['adv_e' + ADV_SUFFIX[x.role]] = x.champ;
    for (const x of st.allies || []) if (!x.me && x.champ && ADV_SUFFIX[x.role]) p['adv_a' + ADV_SUFFIX[x.role]] = x.champ;
    lobbyGo(lobbyBuildUrl(p));
  }
}
ipcRenderer.on('otp:lobby-state', (_e, s) => { lobbyState = s; renderLobbyPanel(); maybeAutoMatchup(); });

// In game, open my champion's build vs my lane opponent once per game (setting
// "Auto Matchup"). Only on my own champion's page; "All matchups" afterwards
// sticks because the same game/opponent is not applied twice.
function maybeAutoMatchup() {
  const st = lobbyState;
  if (!settings.autoMatchup || !st || st.phase !== 'InGame') return;
  const champ = lobbyChampOfPage();
  if (!champ || !st.me?.champ || champ.toLowerCase() !== st.me.champ.toLowerCase()) return;
  const role = st.me.role;
  if (!role) return;
  const opp = (st.enemies || []).find((e) => e.role === role && e.champ);
  if (!opp) return;
  const key = `${st.me.champ}|${role}|${opp.champ}`;
  try { if (sessionStorage.getItem('otp.autoMu') === key) return; sessionStorage.setItem('otp.autoMu', key); } catch {}
  if ((new URLSearchParams(location.search).get('matchup') || '').toLowerCase() === opp.champ.toLowerCase()) return;
  lobbyGo(lobbyBuildUrl({ matchup: opp.champ, role }));
}

// ---- onetricks Pro UI: hidden unless the signed-in account has Pro ----
// Advanced Search and its "Search BETA" toggle open a Get Pro wall for everyone
// else. /api/user/display-data is 401 when signed out.
let otpPro = null;
try { document.documentElement.classList.add('otp-nopro'); } catch {}
function applyPro() {
  document.documentElement.classList.toggle('otp-nopro', otpPro !== true);
  if (otpPro === true) return;
  siteAdvancedSearch()?.classList.add('otp-pro-only');
  // "Onetricks Desktop App ... Get Pro" promo card on build pages.
  for (const el of document.querySelectorAll('aside')) {
    if (/Get Pro/i.test(el.textContent) && el.getBoundingClientRect().height < 260) el.classList.add('otp-pro-only');
  }
  document.querySelectorAll('button').forEach((b) => {
    if (/^Search\s*BETA$/i.test(b.textContent.trim().replace(/\s+/g, ' '))) b.classList.add('otp-pro-only');
  });
}
async function checkPro() {
  try {
    const c = JSON.parse(sessionStorage.getItem('otp.pro') || 'null');
    if (c && Date.now() - c.ts < 10 * 60 * 1000) { otpPro = c.v; applyPro(); return; }
  } catch {}
  let v = false;
  try {
    const r = await fetch('/api/user/display-data', { credentials: 'include' });
    if (r.ok) {
      const j = await r.json();
      const s = JSON.stringify(j);
      v = /"(isPro|pro|premium|isPremium|subscribed|hasPro)":true/i.test(s)
        || /"(plan|tier|role|subscription[A-Za-z]*)":"[^"]*(pro|premium)/i.test(s);
    }
  } catch {}
  otpPro = v;
  try { sessionStorage.setItem('otp.pro', JSON.stringify({ ts: Date.now(), v })); } catch {}
  applyPro();
}
ipcRenderer.invoke('otp:lobby-get').then((s) => { if (s) { lobbyState = s; renderLobbyPanel(); } }).catch(() => {});

// ---- Match search (build pages): our own filter over the games the site shows ----
// The build page data carries the champion's recent high-elo games (100 for all
// regions, 65 per region, 40 per matchup). We load the page's own variants (all,
// KR, EUW1, NA1, and the same with ?matchup= when a lane opponent is picked),
// dedupe, and filter/aggregate locally: lane opponent, laning @15, keystone,
// secondary tree, spells, item bought, game length, rank, region, result.
// Data limits: only the lane opponent is known per game (no full team comps).
const MS_REGIONS = ['', 'KR', 'EUW1', 'NA1'];
const MS_BOOTS = new Set([1001, 3005, 3006, 3009, 3010, 3013, 3020, 3047, 3111, 3117, 3158, 2422]);
const msCache = new Map(); // url -> Promise<pageProps|null>
let msGames = [];
let msLookups = null;
let msLoadedKey = '';
let msLoading = false;
let msFilters = { enemy: '', lane: '', laneGold: 1000, keystone: '', sub: '', spell: '', item: '', len: '', tier: '', region: '', result: '' };
let msOpen = (() => { try { return localStorage.getItem('otp.msOpen') !== '0'; } catch { return true; } })();

const MS_CSS = `
#otp-msearch{background:var(--fg,#212324);border:1px solid var(--border-light,#2c2f31);border-radius:10px;margin:10px 0 0;color:var(--text,#e8e6e3);font-size:13px;box-sizing:border-box}
#otp-msearch .ms-head{display:flex;align-items:center;gap:10px;padding:13px 16px;cursor:pointer;user-select:none}
#otp-msearch .ms-title{font-weight:700;font-size:15px}
#otp-msearch .ms-sub{color:var(--lightText,#c2baaf);font-size:12px}
#otp-msearch .ms-chev{margin-left:auto;transition:transform .15s;color:var(--lightText,#c2baaf)}
#otp-msearch.closed .ms-chev{transform:rotate(-90deg)}
#otp-msearch.closed .ms-body{display:none}
#otp-msearch .ms-body{padding:0 16px 14px}
#otp-msearch .ms-filters{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px 12px;padding:12px 0;border-top:1px solid var(--border-light,#2c2f31);border-bottom:1px solid var(--border-light,#2c2f31)}
#otp-msearch label.f{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--lightText,#c2baaf);font-weight:600;letter-spacing:.02em}
#otp-msearch select{background:var(--bg,#181a1b);color:var(--text,#e8e6e3);border:1px solid var(--border-light,#2c2f31);border-radius:8px;padding:6px 8px;font:inherit;font-size:12.5px;outline:none}
#otp-msearch select:focus{border-color:var(--blue,#1063b7)}
#otp-msearch .ms-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}
#otp-msearch .ms-btn{background:var(--fg-raised,#2c2e2f);border:1px solid var(--border-light,#2c2f31);color:var(--text,#e8e6e3);border-radius:8px;padding:6px 11px;font:inherit;font-size:12px;font-weight:600;cursor:pointer}
#otp-msearch .ms-btn:hover{background:var(--hover,#1b1d1e);border-color:var(--border,#656e73)}
#otp-msearch .ms-sum{display:flex;gap:18px;align-items:baseline;flex-wrap:wrap;margin:14px 0 10px}
#otp-msearch .ms-big{font-size:22px;font-weight:800}
#otp-msearch .ms-k{color:var(--lightText,#c2baaf);font-size:12px}
#otp-msearch .ms-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
#otp-msearch .ms-box{background:var(--bg,#181a1b);border:1px solid var(--border-light,#2c2f31);border-radius:10px;padding:10px 12px}
#otp-msearch .ms-box h5{margin:0 0 8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--lightText,#c2baaf)}
#otp-msearch .ms-opt{display:flex;align-items:center;gap:8px;padding:4px 0}
#otp-msearch .ms-opt+.ms-opt{border-top:1px solid rgba(255,255,255,.04)}
#otp-msearch .ms-ics{display:flex;align-items:center;gap:3px;flex:none}
#otp-msearch .ms-ics img{width:26px;height:26px;border-radius:6px;background:#111}
#otp-msearch .ms-ics img.round{border-radius:50%}
#otp-msearch .ms-ics .arr{color:var(--lightText,#c2baaf);font-size:11px;margin:0 1px}
#otp-msearch .ms-nm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:12px}
#otp-msearch .ms-box.core .ms-nm{visibility:hidden}
#otp-msearch .ms-st{margin-left:auto;text-align:right;font-size:12px;white-space:nowrap}
#otp-msearch .ms-st .g{color:var(--lightText,#c2baaf)}
#otp-msearch .wr-hi{color:#2fb96b}
#otp-msearch .wr-lo{color:#e0605a}
#otp-msearch .ms-games{margin-top:12px}
#otp-msearch .ms-game{display:grid;grid-template-columns:44px 30px minmax(0,1.3fr) minmax(0,1fr) auto;gap:10px;align-items:center;padding:6px 8px;border-radius:8px;border-left:3px solid #e0605a;background:rgba(224,96,90,.05)}
#otp-msearch .ms-game.win{border-left-color:#4f9be8;background:rgba(79,155,232,.06)}
#otp-msearch .ms-game+.ms-game{margin-top:4px}
#otp-msearch .ms-game .res{font-weight:700;font-size:12px}
#otp-msearch .ms-game .who{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
#otp-msearch .ms-game .who .g{color:var(--lightText,#c2baaf)}
#otp-msearch .ms-empty{padding:18px 0 6px;color:var(--lightText,#c2baaf)}
#otp-msearch .ms-note{margin-top:10px;font-size:11px;color:var(--lightText,#c2baaf)}
`;

function msChamp() { return lobbyChampOfPage(); }
function msParseNext(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]).props.pageProps; } catch { return null; }
}
function msFetchPP(url) {
  if (!msCache.has(url)) {
    msCache.set(url, fetch(url, { credentials: 'include' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((h) => (h ? msParseNext(h) : null))
      .catch(() => null));
  }
  return msCache.get(url);
}
function msNorm(m, champKeys) {
  const d = m.details || {}, pd = d.playerData || {}, st = pd.stats || {}, gr = m.gameRoles || {};
  const finals = [0, 1, 2, 3, 4, 5].map((i) => st['item' + i]).filter(Boolean);
  return {
    id: m.regChampGameId, player: m.summonerName || '', tier: m.tier || '', region: m.platformId || '',
    ts: m.timestamp || 0, patch: m.p || '', win: !!st.win,
    k: st.kills || 0, d: st.deaths || 0, a: st.assists || 0, cs: st.cs || 0,
    dur: d.gameDuration || 0, role: gr.playerRole || '',
    enemy: champKeys[String(gr.enemyChampion)] || '', gd15: typeof gr.gd15 === 'number' ? gr.gd15 : null,
    keystone: st.perk0 || 0, sub: st.perkSubStyle || 0,
    spells: [pd.spell1Id, pd.spell2Id].filter(Boolean).sort((a, b) => a - b),
    items: finals, ordered: (m.timeline && m.timeline.orderedItems) || [],
  };
}
async function msLoad(force) {
  const champ = msChamp();
  if (!champ) return;
  const params = new URLSearchParams(location.search);
  const role = params.get('role') || '';
  const key = champ + '|' + role + '|' + msFilters.enemy;
  if (!force && key === msLoadedKey) return;
  msLoading = true; renderSearchPanel();
  const base = `/champions/builds/${encodeURIComponent(champ)}`;
  const urls = [];
  for (const r of MS_REGIONS) {
    const q = new URLSearchParams();
    if (role) q.set('role', role);
    if (r) q.set('region', r);
    urls.push(base + (q.toString() ? '?' + q : ''));
    if (msFilters.enemy) {
      const q2 = new URLSearchParams(q); q2.set('matchup', msFilters.enemy);
      urls.push(base + '?' + q2);
    }
  }
  const pps = await Promise.all(urls.map(msFetchPP));
  const own = (() => { try { return JSON.parse(document.getElementById('__NEXT_DATA__').textContent).props.pageProps; } catch { return null; } })();
  const all = [own, ...pps].filter(Boolean);
  const look = all.find((p) => p.championKeys && p.runes) || own || {};
  msLookups = {
    champKeys: look.championKeys || {}, champData: look.championData || {}, runes: look.runes || {},
    spells: look.summonerSpells || {}, items: look.itemData || {},
  };
  const seen = new Map();
  for (const p of all) for (const m of p.matchHistory || []) {
    if (m && m.regChampGameId && !seen.has(m.regChampGameId)) seen.set(m.regChampGameId, msNorm(m, msLookups.champKeys));
  }
  msGames = [...seen.values()].sort((a, b) => b.ts - a.ts);
  msLoadedKey = key;
  msLoading = false;
  renderSearchPanel();
}

const msDd = () => lobbyDdVer;
const msItemIcon = (id) => `https://ddragon.leagueoflegends.com/cdn/${msDd()}/img/item/${id}.png`;
const msChampIcon = (k) => `https://ddragon.leagueoflegends.com/cdn/${msDd()}/img/champion/${k}.png`;
function msSpellIcon(id) { const s = msLookups?.spells?.[id]; return s ? `https://ddragon.leagueoflegends.com/cdn/${msDd()}/img/spell/${s.image}` : ''; }
function msRuneIcon(id, kind) { const r = msLookups?.runes?.[kind]?.[id]; return r ? `https://ddragon.leagueoflegends.com/cdn/img/${r.icon}` : ''; }
const msName = {
  champ: (k) => msLookups?.champData?.[k]?.name || k,
  keystone: (id) => msLookups?.runes?.keystone?.[id]?.name || String(id),
  sub: (id) => msLookups?.runes?.subStyle?.[id]?.name || String(id),
  spell: (id) => msLookups?.spells?.[id]?.name || String(id),
  item: (id) => msLookups?.items?.[id]?.name || String(id),
};
function msIsCore(id) { const it = msLookups?.items?.[id]; return !!it && !MS_BOOTS.has(Number(id)) && (it.gold || 0) >= 2200; }

function msApply(games, f, skip) {
  return games.filter((g) => {
    if (skip !== 'enemy' && f.enemy && g.enemy !== f.enemy) return false;
    if (skip !== 'lane' && f.lane) {
      if (g.gd15 == null) return false;
      if (f.lane === 'ahead' && g.gd15 < f.laneGold) return false;
      if (f.lane === 'behind' && g.gd15 > -f.laneGold) return false;
      if (f.lane === 'even' && Math.abs(g.gd15) >= f.laneGold) return false;
    }
    if (skip !== 'keystone' && f.keystone && String(g.keystone) !== f.keystone) return false;
    if (skip !== 'sub' && f.sub && String(g.sub) !== f.sub) return false;
    if (skip !== 'spell' && f.spell && !g.spells.includes(Number(f.spell))) return false;
    if (skip !== 'item' && f.item && !g.items.includes(Number(f.item)) && !g.ordered.includes(Number(f.item))) return false;
    if (skip !== 'len' && f.len) {
      const m = g.dur / 60;
      if (f.len === 'short' && m >= 20) return false;
      if (f.len === 'med' && (m < 20 || m >= 30)) return false;
      if (f.len === 'long' && m < 30) return false;
    }
    if (skip !== 'tier' && f.tier && g.tier !== f.tier) return false;
    if (skip !== 'region' && f.region && g.region !== f.region) return false;
    if (skip !== 'result' && f.result && (f.result === 'win') !== g.win) return false;
    return true;
  });
}
function msCount(games, keyFn) {
  const m = new Map();
  for (const g of games) for (const k of [].concat(keyFn(g))) {
    if (k == null || k === '' || k === 0) continue;
    const e = m.get(k) || { k, n: 0, w: 0 };
    e.n++; if (g.win) e.w++;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}
const msWr = (e) => Math.round((e.w / Math.max(1, e.n)) * 100);
const msWrCls = (wr, n) => (n < 3 ? '' : wr >= 55 ? 'wr-hi' : wr <= 45 ? 'wr-lo' : '');

function msSelect(name, label, opts, val) {
  return `<label class="f">${label}<select data-f="${name}">${opts.map(([v, t]) => `<option value="${lobbyEsc(v)}"${String(v) === String(val) ? ' selected' : ''}>${lobbyEsc(t)}</option>`).join('')}</select></label>`;
}
function msOptRows(list, icons, name, max = 5) {
  if (!list.length) return '<div class="ms-k">No data</div>';
  return list.slice(0, max).map((e) => {
    const wr = msWr(e);
    return `<div class="ms-opt" title="${lobbyEsc(name(e.k))}"><span class="ms-ics">${icons(e.k)}</span><span class="ms-nm">${lobbyEsc(name(e.k))}</span><span class="ms-st"><span class="${msWrCls(wr, e.n)}">${wr}%</span> <span class="g">${e.n}</span></span></div>`;
  }).join('');
}

// The site filter card (Region / role / vs / VODs + the Pro Advanced Search form).
// Found by content: the site's ad-recovery script swaps real class names for random
// ones (only the page's own world sees the original names), so class selectors fail
// in this preload world.
function siteFilterCard() {
  return [...document.querySelectorAll('.cardBorder')].find((c) => c.id !== 'otp-msearch' && /Region/.test(c.textContent) && /VODs/.test(c.textContent)) || null;
}
function siteAdvancedSearch(card) {
  card = card || siteFilterCard();
  return card ? [...card.children].find((k) => /Advanced Search/.test(k.textContent)) || null : null;
}
function renderSearchPanel() {
  const isBuild = location.pathname.includes('/champions/builds/');
  let panel = document.getElementById('otp-msearch');
  if (!isBuild) { panel?.remove(); return; }
  if (!document.getElementById('otp-msearch-css')) {
    const s = document.createElement('style');
    s.id = 'otp-msearch-css'; s.textContent = MS_CSS;
    document.head.appendChild(s);
  }
  // Right under the site's filter card (Region / role / vs / VODs), where the Pro
  // Advanced Search form sits; falls back to under the champion header card.
  let card = siteFilterCard();
  if (!card) {
    const h1 = document.querySelector('h1');
    if (!h1) return;
    card = h1;
    while (card.parentElement && card.parentElement !== document.body) {
      if (parseFloat(getComputedStyle(card).borderTopLeftRadius) >= 6 && card.getBoundingClientRect().width > 500) break;
      card = card.parentElement;
    }
  }
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'otp-msearch';
    panel.addEventListener('click', onSearchClick);
    panel.addEventListener('change', onSearchChange);
  }
  if (card.nextElementSibling !== panel) card.after(panel);
  panel.classList.toggle('closed', !msOpen);

  const champ = msChamp();
  const f = msFilters;
  const games = msApply(msGames, f);
  const head = `<div class="ms-head" data-toggle="1"><span class="ms-title">Match Search</span>
    <span class="ms-sub">${msLoading ? 'Loading games…' : `${games.length} of ${msGames.length} recent high-elo ${lobbyEsc(msName.champ(champ))} games`}</span>
    <svg class="ms-chev" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg></div>`;
  if (!msOpen) { panel.innerHTML = head; return; }
  if (!msLookups) { panel.innerHTML = head + '<div class="ms-body"><div class="ms-empty">Loading games…</div></div>'; return; }

  // Options come from the games that match every other filter, with counts.
  const opt = (k, keyFn, nameFn, anyLabel) => {
    const list = msCount(msApply(msGames, f, k), keyFn);
    const cur = f[k];
    if (cur && !list.some((e) => String(e.k) === String(cur))) list.unshift({ k: cur, n: 0, w: 0 });
    return [['', anyLabel], ...list.map((e) => [e.k, `${nameFn(e.k)} (${e.n})`])];
  };
  const filters = [
    msSelect('enemy', 'Lane opponent', opt('enemy', (g) => g.enemy, msName.champ, 'Any'), f.enemy),
    msSelect('lane', 'Laning @ 15 min', [['', 'Any'], ['ahead', `Ahead by ${f.laneGold / 1000}k+`], ['even', `Even (±${f.laneGold / 1000}k)`], ['behind', `Behind by ${f.laneGold / 1000}k+`]], f.lane),
    msSelect('laneGold', 'Gold lead', [[500, '0.5k'], [1000, '1k'], [2000, '2k'], [3000, '3k']], f.laneGold),
    msSelect('keystone', 'Keystone', opt('keystone', (g) => String(g.keystone), msName.keystone, 'Any'), f.keystone),
    msSelect('sub', 'Secondary tree', opt('sub', (g) => String(g.sub), msName.sub, 'Any'), f.sub),
    msSelect('spell', 'Summoner spell', opt('spell', (g) => g.spells.map(String), msName.spell, 'Any'), f.spell),
    msSelect('item', 'Item bought', opt('item', (g) => [...new Set([...g.items, ...g.ordered])].filter(msIsCore).map(String), msName.item, 'Any'), f.item),
    msSelect('len', 'Game length', [['', 'Any'], ['short', 'Short < 20'], ['med', 'Med 20–30'], ['long', 'Long 30+']], f.len),
    msSelect('tier', 'Rank', opt('tier', (g) => g.tier, (x) => x, 'Any'), f.tier),
    msSelect('region', 'Region', opt('region', (g) => g.region, (x) => x, 'Any'), f.region),
    msSelect('result', 'Result', [['', 'Any'], ['win', 'Wins'], ['loss', 'Losses']], f.result),
  ].join('');

  let body;
  if (!games.length) {
    body = '<div class="ms-empty">No games match these filters. Loosen one of them.</div>';
  } else {
    const n = games.length, w = games.filter((g) => g.win).length;
    const K = games.reduce((s, g) => s + g.k, 0), D = games.reduce((s, g) => s + g.d, 0), A = games.reduce((s, g) => s + g.a, 0);
    const gdList = games.filter((g) => g.gd15 != null);
    const gd = gdList.length ? Math.round(gdList.reduce((s, g) => s + g.gd15, 0) / gdList.length) : null;
    const wr = Math.round((w / n) * 100);
    const runes = msCount(games, (g) => `${g.keystone}|${g.sub}`);
    const spells = msCount(games, (g) => g.spells.join('|'));
    const core = msCount(games, (g) => { const c = g.ordered.filter(msIsCore).slice(0, 3); return c.length >= 2 ? c.join('|') : null; });
    const items = msCount(games, (g) => [...new Set([...g.items, ...g.ordered])].filter(msIsCore));
    const vs = msCount(games, (g) => g.enemy);
    const img = (src, cls = '') => (src ? `<img class="${cls}" src="${src}" alt="">` : '');
    body = `<div class="ms-sum">
        <div><span class="ms-big ${msWrCls(wr, n)}">${wr}%</span> <span class="ms-k">win rate · ${n} games</span></div>
        <div><span class="ms-big">${((K + A) / Math.max(1, D)).toFixed(2)}</span> <span class="ms-k">KDA (${(K / n).toFixed(1)} / ${(D / n).toFixed(1)} / ${(A / n).toFixed(1)})</span></div>
        ${gd != null ? `<div><span class="ms-big ${gd >= 0 ? 'wr-hi' : 'wr-lo'}">${gd >= 0 ? '+' : ''}${gd}</span> <span class="ms-k">gold @15</span></div>` : ''}
      </div>
      <div class="ms-grid">
        <div class="ms-box core"><h5>Core build</h5>${msOptRows(core, (k) => k.split('|').map((id, i) => (i ? '<span class="arr">›</span>' : '') + img(msItemIcon(id))).join(''), (k) => k.split('|').map(msName.item).join(' › '), 4)}</div>
        <div class="ms-box"><h5>Runes</h5>${msOptRows(runes, (k) => { const [ks, sub] = k.split('|'); return img(msRuneIcon(ks, 'keystone'), 'round') + img(msRuneIcon(sub, 'subStyle'), 'round'); }, (k) => { const [ks, sub] = k.split('|'); return `${msName.keystone(ks)} + ${msName.sub(sub)}`; }, 4)}</div>
        <div class="ms-box"><h5>Summoner spells</h5>${msOptRows(spells, (k) => k.split('|').map((id) => img(msSpellIcon(id))).join(''), (k) => k.split('|').map(msName.spell).join(' + '), 4)}</div>
        <div class="ms-box"><h5>Items</h5>${msOptRows(items, (k) => img(msItemIcon(k)), msName.item, 6)}</div>
        ${f.enemy ? '' : `<div class="ms-box"><h5>Lane opponents</h5>${msOptRows(vs, (k) => img(msChampIcon(k)), msName.champ, 6)}</div>`}
      </div>
      <div class="ms-games">${games.slice(0, 12).map((g) => `<div class="ms-game${g.win ? ' win' : ''}">
          <span class="res">${g.win ? 'Win' : 'Loss'}<div class="ms-k">${Math.round(g.dur / 60)}m</div></span>
          ${g.enemy ? `<img src="${msChampIcon(g.enemy)}" alt="" title="vs ${lobbyEsc(msName.champ(g.enemy))}" style="width:30px;height:30px;border-radius:6px">` : '<span></span>'}
          <span class="who">${lobbyEsc(g.player)}<div class="g">${lobbyEsc(g.tier)} · ${lobbyEsc(g.region)} · ${g.k}/${g.d}/${g.a}${g.gd15 != null ? ` · ${g.gd15 >= 0 ? '+' : ''}${g.gd15}g @15` : ''}</div></span>
          <span class="ms-ics">${img(msRuneIcon(g.keystone, 'keystone'), 'round')}${g.spells.map((s) => img(msSpellIcon(s))).join('')}</span>
          <span class="ms-ics">${g.items.filter(msIsCore).slice(0, 5).map((id) => img(msItemIcon(id))).join('')}</span>
        </div>`).join('')}</div>`;
  }
  panel.innerHTML = `${head}<div class="ms-body"><div class="ms-filters">${filters}</div>
    <div class="ms-row"><button class="ms-btn" data-reset="1">Clear filters</button><span class="ms-k">Filters work on the recent games onetricks shows for this champion; only the lane opponent is known per game, not full team comps.</span></div>
    ${body}</div>`;
}

function onSearchClick(e) {
  if (e.target.closest('[data-toggle]')) {
    msOpen = !msOpen;
    try { localStorage.setItem('otp.msOpen', msOpen ? '1' : '0'); } catch {}
    renderSearchPanel();
    if (msOpen) msLoad();
    return;
  }
  if (e.target.closest('[data-reset]')) {
    const enemyBefore = msFilters.enemy;
    msFilters = { enemy: '', lane: '', laneGold: msFilters.laneGold, keystone: '', sub: '', spell: '', item: '', len: '', tier: '', region: '', result: '' };
    if (enemyBefore) msLoad(); else renderSearchPanel();
  }
}
function onSearchChange(e) {
  const sel = e.target.closest('select[data-f]');
  if (!sel) return;
  const k = sel.dataset.f;
  msFilters[k] = k === 'laneGold' ? Number(sel.value) : sel.value;
  if (k === 'enemy') msLoad(); else renderSearchPanel();
}
// Opponent from the URL (?matchup=, e.g. set by the lobby panel) presets the filter.
function msSyncFromUrl() {
  const p = new URLSearchParams(location.search);
  const mu = p.get('matchup') || '';
  if (mu && mu !== msFilters.enemy) msFilters.enemy = mu;
}
let msChampSeen = '';
function mountSearchPanel() {
  if (!location.pathname.includes('/champions/builds/')) { document.getElementById('otp-msearch')?.remove(); return; }
  const c = msChamp() || '';
  if (c !== msChampSeen) {
    msChampSeen = c;
    msFilters = { enemy: '', lane: '', laneGold: msFilters.laneGold, keystone: '', sub: '', spell: '', item: '', len: '', tier: '', region: '', result: '' };
    msGames = []; msLookups = null; msLoadedKey = '';
  }
  msSyncFromUrl();
  renderSearchPanel();
  if (msOpen) msLoad();
}

// ---- Lifecycle & Observers ----
// contextBridge must be called synchronously at top-level
contextBridge.exposeInMainWorld('otp', { parseBuild, doImport });

let _lastPath = location.pathname;
let _mountTimeout = null;

// Coalesce, don't debounce: the site mutates the DOM non-stop (timers, ads), so
// resetting the timer on every mutation could postpone the mount forever.
function requestMountUI(delay = 100) {
  if (_mountTimeout) return;
  _mountTimeout = setTimeout(() => {
    _mountTimeout = null;
    mountUI();
  }, delay);
}

// Defer DOM manipulation until the document is ready
window.addEventListener('DOMContentLoaded', () => {
  // Push settings to main process once on load
  try { saveSettings(); } catch {}

  setTimeout(() => {
    mountUI();
    checkPendingAutoImport();
    refreshLcuStatus();
  }, 350);

  // Re-inject UI only when URL changes or required elements are missing
  new MutationObserver((mutations) => {
    // Ignore mutations triggered solely by our own elements
    const onlyOtp = mutations.every(m => {
      const t = m.target;
      return t && (t.id?.startsWith('otp-') || t.className?.includes('otp-'));
    });
    if (onlyOtp) return;

    const isBuild = location.pathname.includes('/champions/builds/');
    const pathChanged = location.pathname !== _lastPath;

    if (pathChanged) {
      _lastPath = location.pathname;
      requestMountUI(50);
      return;
    }

    const needsHeader = isBuild && !document.getElementById('otp-header-actions');
    const needsFloat = !document.getElementById('otp-float-settings');
    const needsTier = !!document.querySelector('header') &&
      (!document.getElementById('otp-tiernav') || !document.getElementById('otp-sumnav'));
    // The site re-renders its header (React), which drops our ids and the Summoner link.
    const needsLobby = isBuild && !!lobbyState && !document.getElementById("otp-lobby");
    const msEl = document.getElementById("otp-msearch");
    const msCard = isBuild && siteFilterCard();
    const needsSearch = isBuild && (!msEl || (msCard && msCard.nextElementSibling !== msEl));
    if (otpPro !== true && !window._otpProRaf) window._otpProRaf = requestAnimationFrame(() => { window._otpProRaf = 0; applyPro(); });
    if (needsHeader || needsFloat || needsTier || needsLobby || needsSearch) requestMountUI(80);

    // Also remove Get Pro button if it reappears
    const getProBtn = document.querySelector('a.get-pro-btn, .get-pro-btn');
    if (getProBtn) getProBtn.remove();
  }).observe(document.body || document.documentElement, { childList: true, subtree: true });
});

// Periodically refresh LCU connection status
setInterval(refreshLcuStatus, 5000);

// main's clearSiteDrag() turns the header's drag region off right before leaving
// for a local page; if this page comes back from the back/forward cache, undo it.
window.addEventListener('pageshow', () => {
  document.getElementById('otp-leave-nodrag')?.remove();
  document.getElementById('otp-leave-anchor')?.remove();
});
