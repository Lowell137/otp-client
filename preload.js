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
const DEF_SETTINGS = { follow: true, autoBuild: true, autoAccept: false, autoSpell: true, autoMatchup: true, autoStart: false, overlay: false, winChance: false, helper: false, flashSlot: 'D', apiKey: '', region: 'tr1' };
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
      <div class="otp-switch-row" data-k="autoStart" title="Opens OTP Client when the League client starts (a tiny watcher, a few MB, runs in the background)">
        <span>Start with League</span>
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
      <div class="otp-switch-row" data-k="winChance" title="Estimated win chance in game, every 3 minutes">
        <span>In-Game Win Chance</span>
        <span class="otp-sw"></span>
      </div>
      <div class="otp-switch-row" data-k="helper" title="Next item, skill to level, CS and lane gold, enemy ranks">
        <span>In-Game Build &amp; Lane Info</span>
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
  renderPostGame();
  renderPgToast();
  mountSearchPanel();
  renderModes();
  if (otpPro === null) checkPro(); else applyPro();
  maybeAutoMatchup();
  injectSiteNav();
}

// ---- Instant Auto-Import on any rune / set / filter selection ----
let _autoImportTimer = null;
document.addEventListener('click', (e) => {
  const target = e.target;
  if (!target) return;

  // Ignore clicks inside our own header bar, floating settings, or popover
  if (target.closest('#otp-header-actions') || target.closest('#otp-float-settings') || target.closest('.otp-popover') || target.closest('#otp-lobby') || target.closest('#otp-msearch') || target.closest('#otp-postgame') || target.closest('#otp-modes') || target.closest('.otp-mode-tab')) return;

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
      // Assistant (ai.html), same look as Summoner.
      const ab = sb.cloneNode(true);
      ab.id = 'otp-ainav';
      (ab.firstElementChild || ab).textContent = 'Assistant';
      ab.onclick = (e) => { e.preventDefault(); try { ipcRenderer.send('otp:go', 'ai'); } catch {} };
      sb.after(ab);
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
  const ab = sb.cloneNode(true);
  ab.id = 'otp-ainav';
  ab.textContent = 'Assistant';
  ab.onclick = (e) => { e.preventDefault(); try { ipcRenderer.send('otp:go', 'ai'); } catch {} };
  anchor.parentElement.appendChild(ab);
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
#otp-lobby .lb-live{width:8px;height:8px;border-radius:50%;background:#2fb96b;animation:otp-pulse 1.6s ease-in-out infinite}
@keyframes otp-pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(47,185,107,.55)}50%{opacity:.45;box-shadow:0 0 0 5px rgba(47,185,107,0)}}
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

// ---- Lobby role picker: guessed lanes (main/lobby.js) can be corrected by hand ----
// Overrides are kept per champion and side for the current session; picking a
// lane swaps it with whoever had it, so a team never shows a lane twice.
let roleOv = (() => { try { return JSON.parse(sessionStorage.getItem('otp.roleOv') || '{}'); } catch { return {}; } })();
function saveRoleOv() { try { sessionStorage.setItem('otp.roleOv', JSON.stringify(roleOv)); } catch {} }
function applyTeamOv(list, side) {
  const out = (list || []).map((p) => ({ ...p }));
  for (const p of out) {
    const k = side + '|' + p.champ;
    if (!p.champ || !roleOv[k] || roleOv[k] === p.role) continue;
    const want = roleOv[k];
    const other = out.find((q) => q !== p && q.role === want);
    if (other) { other.role = p.role; other.guess = true; }
    p.role = want;
    p.guess = false;
    p.picked = true;
  }
  return out;
}
// lobbyState with the user's lane picks applied (and "me" following them).
function lobbyEff() {
  const st = lobbyState;
  if (!st) return st;
  const allies = applyTeamOv(st.allies, 'a');
  const enemies = applyTeamOv(st.enemies, 'e');
  const me = allies.find((p) => p.me);
  return { ...st, allies, enemies, me: { ...(st.me || {}), role: (me && me.role) || st.me?.role || '' } };
}
let rolePop = null;
function openRolePicker(btn) {
  rolePop?.remove();
  const side = btn.dataset.side, champ = btn.dataset.champ;
  rolePop = document.createElement('div');
  rolePop.id = 'otp-rolepop';
  rolePop.innerHTML = LOBBY_ROLES.map((r) => `<div data-r="${r}">${ROLE_LABEL[r]}</div>`).join('') + '<div data-r="" class="auto">Auto</div>';
  document.body.appendChild(rolePop);
  const b = btn.getBoundingClientRect();
  rolePop.style.left = Math.round(b.left + window.scrollX) + 'px';
  rolePop.style.top = Math.round(b.bottom + window.scrollY + 4) + 'px';
  rolePop.addEventListener('mousedown', (e) => {
    const d = e.target.closest('[data-r]');
    if (!d) return;
    e.preventDefault(); e.stopPropagation();
    const k = side + '|' + champ;
    if (d.dataset.r) roleOv[k] = d.dataset.r; else delete roleOv[k];
    saveRoleOv();
    rolePop.remove(); rolePop = null;
    renderLobbyPanel(); renderChampChip();
  });
}
document.addEventListener('mousedown', (e) => { if (rolePop && !e.target.closest('#otp-rolepop')) { rolePop.remove(); rolePop = null; } }, true);
const ROLEPICK_CSS = `
#otp-lobby .lb-role{background:transparent;border:1px solid transparent;border-radius:6px;padding:3px 0;font:inherit;font-size:11px;font-weight:600;color:var(--lightText,#c2baaf);cursor:pointer;width:100%}
#otp-lobby .lb-role:hover{border-color:var(--border,#656e73);color:#fff}
#otp-lobby .lb-role.guess{color:#8f96a3;border-style:dashed;border-color:#2c2f31}
#otp-lobby .lb-role.picked{color:#8cc0f5}
#otp-rolepop{position:absolute;z-index:3000;background:#212324;border:1px solid #2c2f31;border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.45);font-size:12.5px;color:#e8e6e3;min-width:70px}
#otp-rolepop div{padding:5px 10px;border-radius:6px;cursor:pointer}
#otp-rolepop div:hover{background:#2c2e2f}
#otp-rolepop .auto{color:#8f96a3;border-top:1px solid #2c2f31;margin-top:2px}
`;

function renderLobbyPanel() {
  const isBuild = location.pathname.includes('/champions/builds/');
  let panel = document.getElementById('otp-lobby');
  const st = lobbyEff();
  if (!isBuild || !st || !(st.allies?.length || st.enemies?.length)) { panel?.remove(); return; }
  if (!document.getElementById('otp-lobby-css')) {
    const s = document.createElement('style');
    s.id = 'otp-lobby-css';
    s.textContent = LOBBY_CSS + ROLEPICK_CSS;
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
      <button class="lb-role${p.guess ? ' guess' : ''}${p.picked ? ' picked' : ''}" data-rolepick="1" data-side="${side === 'enemy' ? 'e' : 'a'}" data-champ="${lobbyEsc(p.champ || '')}" title="${p.guess ? 'Guessed lane: click to change' : 'Click to change the lane'}">${ROLE_LABEL[p.role] || '—'}${p.guess ? '?' : ''}</button>
      ${p.champ ? `<img class="lb-ic" src="${lobbyIcon(p.champ)}" alt="">` : '<div class="lb-ic none"></div>'}
      <div class="lb-who">${name}<div class="lb-rank">${p.hidden || p.bot ? '' : lobbyRankText(p.rank)}</div></div>
      <div class="lb-stat">${lobbyStatText(p)}</div>
    </div>`;
  };
  const hiddenAllies = st.phase === 'ChampSelect' && (st.allies || []).some((a) => a.hidden && !a.me);
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
  const rp = e.target.closest('[data-rolepick]');
  if (rp) { e.preventDefault(); e.stopPropagation(); if (rp.dataset.champ) openRolePicker(rp); return; }
  const t = e.target.closest('[data-vs],[data-adv],[data-clear]');
  if (!t) return;
  e.preventDefault();
  e.stopPropagation();
  const st = lobbyEff() || {};
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
ipcRenderer.on('otp:lobby-state', (_e, s) => { lobbyState = s; renderLobbyPanel(); renderPostGame(); maybeAutoMatchup(); renderChampChip(); });

// In game, open my champion's build vs my lane opponent once per game (setting
// "Auto Matchup"). Only on my own champion's page; "All matchups" afterwards
// sticks because the same game/opponent is not applied twice.
function maybeAutoMatchup() {
  const st = lobbyEff();
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
let msOpen = (() => { try { return localStorage.getItem('otp.msOpen') === '1'; } catch { return false; } })();

const MS_CSS = `
#otp-msearch{background:var(--fg,#212324);border:1px solid var(--border-light,#2c2f31);border-radius:10px;margin:10px 0 0;color:var(--text,#e8e6e3);font-size:13px;box-sizing:border-box}
#otp-msearch.closed{display:none}
#otp-ms-toggle{margin-left:auto;align-self:center;display:inline-flex;align-items:center;gap:7px;background:transparent;border:1px solid var(--border-light,#2c2f31);color:var(--text,#e8e6e3);border-radius:8px;padding:8px 13px;font:inherit;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap}
#otp-ms-toggle:hover{background:var(--hover,#1b1d1e);border-color:var(--border,#656e73)}
#otp-ms-toggle{flex:none}
#otp-ms-toggle.compact{padding:8px 10px}
#otp-ms-toggle.compact span{display:none}
#otp-ms-toggle.on{background:var(--blue,#1063b7);border-color:var(--blue,#1063b7);color:#fff}
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
  msMountToggle(card);
  if (!msOpen) { panel.innerHTML = ''; return; }

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
      </div>`;
  }
  panel.innerHTML = `${head}<div class="ms-body"><div class="ms-filters">${filters}</div>
    <div class="ms-row"><button class="ms-btn" data-reset="1">Clear filters</button><span class="ms-k">Filters work on the recent games onetricks shows for this champion; only the lane opponent is known per game, not full team comps.</span></div>
    ${body}</div>`;
}

// "Match Search" toggle in the empty right end of the site's filter row (Region /
// role / vs / VODs / patch). The panel opens right under the filter card.
function msMountToggle(card) {
  const row = card && card.id !== 'otp-msearch' && /Region/.test(card.textContent) ? card.firstElementChild : null;
  let btn = document.getElementById('otp-ms-toggle');
  if (!row) { btn?.remove(); return; }
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'otp-ms-toggle';
    btn.type = 'button';
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); msToggle(); });
  }
  if (btn.parentElement !== row) row.appendChild(btn);
  btn.classList.toggle('on', msOpen);
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg><span>Match Search</span>';
  btn.title = 'Match Search';
  // Stay on the filter row: when the row is full (e.g. a vs chip is set) drop to the icon.
  btn.classList.remove('compact');
  const first = row.firstElementChild;
  if (first && first !== btn && btn.offsetTop > first.offsetTop + 8) btn.classList.add('compact');
}
function msToggle() {
  msOpen = !msOpen;
  try { localStorage.setItem('otp.msOpen', msOpen ? '1' : '0'); } catch {}
  renderSearchPanel();
  if (msOpen) msLoad();
}
function onSearchClick(e) {
  if (e.target.closest('[data-toggle]')) { msToggle(); return; }
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

// ---- onetricks header: back / forward / reload + current-champion chip ----
// Next to the site logo. Only on onetricks pages (the local pages have their own
// header without these buttons). The chip shows the champion you picked or hover in
// champion select / in game and goes back to its build (your lane; vs your lane
// opponent in game).
const SITENAV_CSS = `
/* Top-left corner of the page, under the header, in the empty left gutter. */
#otp-hdr-extra{background:transparent !important;border:0 !important;box-shadow:none !important;padding:0 !important;backdrop-filter:none !important;position:fixed;left:8px;top:calc(var(--otp-hh,66px) + 14px);z-index:900;display:flex;flex-direction:column;align-items:flex-start;gap:8px;-webkit-app-region:no-drag}
@media (max-width:1240px){#otp-hdr-extra{display:none}}
#otp-sitenav{display:inline-flex;flex-direction:row;align-items:center;gap:3px;-webkit-app-region:no-drag}
#otp-sitenav .nb{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:8px;background:transparent;color:var(--text,#e8e6e3);cursor:pointer;padding:0;-webkit-app-region:no-drag}
#otp-sitenav .nb:hover:not(:disabled){background:var(--fg-raised,#2c2e2f)}
#otp-sitenav .nb:disabled{opacity:.35;cursor:default}
#otp-sitenav .nb svg{width:16px;height:16px;display:block}
#otp-chip-wrap{display:inline-flex;align-items:center;margin-left:8px;margin-right:auto;padding-right:14px;align-self:center;-webkit-app-region:no-drag}
#otp-champ-chip{display:none;align-items:center;gap:7px;padding:4px 11px 4px 8px;height:32px;box-sizing:border-box;background:var(--fg-raised,#2c2e2f);border:1px solid var(--border-light,#2c2f31);border-radius:999px;color:var(--text,#e8e6e3);font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;-webkit-app-region:no-drag}
#otp-champ-chip.show{display:inline-flex}
#otp-champ-chip:hover{background:var(--hover,#1b1d1e);border-color:var(--border,#656e73)}
#otp-champ-chip img{width:22px;height:22px;border-radius:50%;display:block;flex:none}
#otp-champ-chip .dot{width:7px;height:7px;border-radius:50%;background:#2fb96b;flex:none;animation:otp-pulse 1.6s ease-in-out infinite}
@keyframes otp-pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(47,185,107,.55)}50%{opacity:.45;box-shadow:0 0 0 5px rgba(47,185,107,0)}}
#otp-champ-chip .st{color:var(--lightText,#c2baaf);font-weight:500;font-size:12px}

`;
const NAV_ICONS = {
  back: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>',
  forward: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
  reload: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.8v2.9h-2.9"/></svg>',
};
function injectSiteNav() {
  const header = document.querySelector('header');
  if (!header) return;
  if (!document.getElementById('otp-sitenav-css')) {
    const st = document.createElement('style');
    st.id = 'otp-sitenav-css';
    st.textContent = SITENAV_CSS;
    document.head.appendChild(st);
  }
  const logo = [...header.querySelectorAll('a[href="/"]')].find((a) => a.querySelector('img'));
  if (!logo) return;
  let nav = document.getElementById('otp-sitenav');
  if (!nav) {
    nav = document.createElement('span');
    nav.id = 'otp-sitenav';
    nav.innerHTML = ['back', 'forward', 'reload'].map((k) => `<button type="button" class="nb" data-nav="${k}" title="${{ back: 'Back (Alt+Left)', forward: 'Forward (Alt+Right)', reload: 'Reload (F5)' }[k]}">${NAV_ICONS[k]}</button>`).join('');
    nav.addEventListener('click', (e) => {
      const b = e.target.closest('[data-nav]');
      if (!b || b.disabled) return;
      e.preventDefault(); e.stopPropagation();
      try { ipcRenderer.send('otp:nav-' + b.dataset.nav); } catch {}
    });
  }
  let extra = document.getElementById('otp-hdr-extra');
  if (!extra) { extra = document.createElement('span'); extra.id = 'otp-hdr-extra'; }
  if (extra.parentElement !== document.body) document.body.appendChild(extra);
  if (nav.parentElement !== extra) extra.prepend(nav);
  let chip = document.getElementById('otp-champ-chip');
  if (!chip) {
    chip = document.createElement('a');
    chip.id = 'otp-champ-chip';
    chip.href = 'javascript:void(0)';
    chip.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); const u = chip.dataset.url; if (u) lobbyGo(u); });
  }
  let wrap = document.getElementById('otp-chip-wrap');
  if (!wrap) { wrap = document.createElement('span'); wrap.id = 'otp-chip-wrap'; }
  // Inner pages keep the logo in a plain block <li>; make it a row so the chip
  // sits next to the logo instead of under it.
  const lp = logo.parentElement;
  if (lp && lp.tagName === 'LI' && getComputedStyle(lp).display !== 'flex') { lp.style.display = 'flex'; lp.style.alignItems = 'center'; }
  if (logo.nextElementSibling !== wrap) logo.after(wrap);
  if (chip.parentElement !== wrap) wrap.appendChild(chip);
  renderChampChip();
  refreshNavState();
  placeSiteNav();
}
// Keep the top-left buttons off page content: aligned with the first content row,
// hidden when there is less than 12 px between them and the content.
function placeSiteNav() {
  const extra = document.getElementById('otp-hdr-extra');
  if (!extra) return;
  const hh = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--otp-hh')) || 66;
  // Home: level with the champion shortcut row; other pages: just under the header.
  let top = location.pathname === '/' ? hh + 24 : hh + 10;
  extra.style.top = top + 'px';
  for (let i = 0; i < 4; i++) {
    const r = extra.getBoundingClientRect();
    if (!r.width) return;
    let hit = null;
    for (const y of [r.top + 2, r.top + r.height / 2, r.bottom - 2]) {
      for (const el of document.elementsFromPoint(r.right + 12, y)) {
        if (el === document.documentElement || el === document.body || extra.contains(el)) continue;
        const er = el.getBoundingClientRect();
        // Real content (a card/chip), not a full-width background or page wrapper.
        if (er.width < 420 && er.height < 200 && er.left < r.right + 14) { hit = er; break; }
      }
      if (hit) break;
    }
    extra.style.visibility = hit ? 'hidden' : '';
    if (hit) extra.style.top = top + 'px';
    return;
  }
}
window.addEventListener('resize', () => { clearTimeout(window._otpNavT); window._otpNavT = setTimeout(placeSiteNav, 150); });
function refreshNavState() {
  ipcRenderer.invoke('otp:nav-state').then((s) => {
    const nav = document.getElementById('otp-sitenav');
    if (!nav || !s) return;
    nav.querySelector('[data-nav="back"]').disabled = !s.back;
    nav.querySelector('[data-nav="forward"]').disabled = !s.forward;
  }).catch(() => {});
}
function renderChampChip() {
  const chip = document.getElementById('otp-champ-chip');
  if (!chip) return;
  const st = lobbyEff();
  const me = st && st.me;
  if (!me || !me.champ) { chip.classList.remove('show'); chip.dataset.url = ''; return; }
  const role = me.role || '';
  const opp = st.phase === 'InGame' && role ? (st.enemies || []).find((p) => p.role === role && p.champ) : null;
  const q = new URLSearchParams();
  if (opp) q.set('matchup', opp.champ);
  if (role) q.set('role', role);
  chip.dataset.url = `/champions/builds/${encodeURIComponent(me.champ)}${q.toString() ? '?' + q : ''}`;
  const nm = (k) => (msLookups?.champData?.[k]?.name) || k;
  chip.innerHTML = `<span class="dot"></span><img src="${lobbyIcon(me.champ)}" alt=""><span class="nm">${lobbyEsc(nm(me.champ))}</span>${opp ? `<span class="st">vs</span><img src="${lobbyIcon(opp.champ)}" alt=""><span class="nm">${lobbyEsc(nm(opp.champ))}</span>` : ''}`;
  chip.title = `Back to the ${nm(me.champ)} build`;
  chip.classList.add('show');
}
window.addEventListener('popstate', () => setTimeout(refreshNavState, 50));

// ---- Post-game card (build pages): how the last game went vs the OTP build ----
// Card from main (postgame.js): 'otp:postgame' / 'otp:postgame-get'. Shown at the top
// of build pages while no champion select / game is on (the lobby panel takes that
// place then). The OTP side is computed from the site's own recent one-trick games
// for that champion, lane and (if known) lane opponent.
let pgCard = null;
const pgOtp = new Map(); // key -> Promise<{ core, items, n, wr, itemData }>
const PG_CSS = `
#otp-postgame{background:var(--fg,#212324);border:1px solid var(--border-light,#2c2f31);border-radius:10px;padding:14px 16px;margin:0 0 16px;color:var(--text,#e8e6e3);font-size:13px;box-sizing:border-box;border-left:4px solid #e0605a}
#otp-postgame.win{border-left-color:#4f9be8}
#otp-postgame .pg-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
#otp-postgame .pg-res{font-weight:800;font-size:16px;color:#e0605a}
#otp-postgame.win .pg-res{color:#4f9be8}
#otp-postgame .pg-sub{color:var(--lightText,#c2baaf);font-size:12px}
#otp-postgame .pg-lp{margin-left:auto;font-weight:800;font-size:15px;padding:3px 10px;border-radius:8px;background:var(--fg-raised,#2c2e2f)}
#otp-postgame .pg-lp.up{color:#2fb96b}
#otp-postgame .pg-lp.down{color:#e0605a}
#otp-postgame .pg-rank{color:var(--lightText,#c2baaf);font-size:12px}
#otp-postgame .pg-x{background:transparent;border:0;color:var(--lightText,#c2baaf);cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;border-radius:6px}
#otp-postgame .pg-x:hover{background:var(--fg-raised,#2c2e2f);color:var(--text,#e8e6e3)}
#otp-postgame .pg-main{display:flex;align-items:center;gap:22px;flex-wrap:wrap}
#otp-postgame .pg-champ{position:relative;flex:none}
#otp-postgame .pg-champ img{width:52px;height:52px;border-radius:10px;display:block}
#otp-postgame .pg-champ span{position:absolute;right:-6px;bottom:-6px;background:var(--bg,#181a1b);border:1px solid var(--border-light,#2c2f31);border-radius:6px;font-size:11px;font-weight:700;padding:0 4px}
#otp-postgame .pg-stat .v{font-size:17px;font-weight:800}
#otp-postgame .pg-stat .k{color:var(--lightText,#c2baaf);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
#otp-postgame .pg-vs{display:flex;align-items:center;gap:7px;color:var(--lightText,#c2baaf)}
#otp-postgame .pg-vs img{width:26px;height:26px;border-radius:6px}
#otp-postgame .pg-rows{display:grid;grid-template-columns:auto 1fr;gap:8px 14px;align-items:center;margin-top:14px;padding-top:12px;border-top:1px solid var(--border-light,#2c2f31)}
#otp-postgame .pg-lab{color:var(--lightText,#c2baaf);font-size:11px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;white-space:nowrap}
#otp-postgame .pg-items{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
#otp-postgame .pg-it{position:relative;width:32px;height:32px;border-radius:7px;background:#111;display:block;box-sizing:border-box}
#otp-postgame .pg-it.empty{border:1px dashed var(--border,#656e73);background:transparent}
#otp-postgame .pg-it.ok{outline:2px solid #2fb96b;outline-offset:1px}
#otp-postgame .pg-it.miss{opacity:.45;outline:2px dashed #e0605a;outline-offset:1px}
#otp-postgame .pg-arr{color:var(--lightText,#c2baaf);font-size:12px;margin:0 2px}
#otp-postgame .pg-note{color:var(--lightText,#c2baaf);font-size:12px;margin-left:8px}
#otp-postgame .pg-note b{color:var(--text,#e8e6e3)}
`;
function pgAgo(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  return h + (h === 1 ? ' hour ago' : ' hours ago');
}
function pgOtpFor(card) {
  const key = `${card.champ}|${card.role}|${card.opp}`;
  if (!pgOtp.has(key)) {
    pgOtp.set(key, (async () => {
      const base = `/champions/builds/${encodeURIComponent(card.champ)}`;
      const q = (mu) => { const p = new URLSearchParams(); if (card.role) p.set('role', card.role); if (mu) p.set('matchup', mu); const s = p.toString(); return base + (s ? '?' + s : ''); };
      const pps = (await Promise.all([q(card.opp), q('')].filter((u, i, a) => a.indexOf(u) === i).map(msFetchPP))).filter(Boolean);
      const itemData = (pps.find((p) => p.itemData) || {}).itemData || {};
      const isCore = (id) => { const it = itemData[id]; return !!it && !MS_BOOTS.has(Number(id)) && (it.gold || 0) >= 2200; };
      // Prefer the matchup games when there are enough of them.
      const vs = pps.length > 1 && card.opp ? (pps[0].matchHistory || []) : [];
      const games = vs.length >= 8 ? vs : pps.flatMap((p) => p.matchHistory || []);
      const seen = new Set();
      const uniq = games.filter((g) => g && g.regChampGameId && !seen.has(g.regChampGameId) && seen.add(g.regChampGameId));
      const coreCount = new Map(); const itemCount = new Map();
      for (const g of uniq) {
        const ord = ((g.timeline && g.timeline.orderedItems) || []).filter(isCore);
        if (ord.length >= 3) { const k = ord.slice(0, 3).join('|'); coreCount.set(k, (coreCount.get(k) || 0) + 1); }
        for (const id of new Set(ord)) itemCount.set(id, (itemCount.get(id) || 0) + 1);
      }
      const core = [...coreCount.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        core: core ? core[0].split('|').map(Number) : [],
        coreN: core ? core[1] : 0,
        items: [...itemCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, n]) => ({ id: Number(id), share: Math.round((n / Math.max(1, uniq.length)) * 100) })),
        n: uniq.length, vsOnly: games === vs, isCore, itemData,
      };
    })().catch(() => null));
  }
  return pgOtp.get(key);
}

async function renderPostGame() {
  const isBuild = location.pathname.includes('/champions/builds/');
  let panel = document.getElementById('otp-postgame');
  const c = pgCard;
  const live = lobbyState && (lobbyState.allies?.length || lobbyState.enemies?.length);
  if (!isBuild || !c || live) { panel?.remove(); return; }
  if (!document.getElementById('otp-postgame-css')) {
    const s = document.createElement('style');
    s.id = 'otp-postgame-css'; s.textContent = PG_CSS;
    document.head.appendChild(s);
  }
  const h1 = document.querySelector('h1');
  if (!h1) return;
  let card = h1;
  while (card.parentElement && card.parentElement !== document.body) {
    if (parseFloat(getComputedStyle(card).borderTopLeftRadius) >= 6 && card.getBoundingClientRect().width > 500) break;
    card = card.parentElement;
  }
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'otp-postgame';
    panel.addEventListener('click', (e) => {
      if (e.target.closest('.pg-x')) { e.preventDefault(); e.stopPropagation(); try { ipcRenderer.send('otp:postgame-dismiss', pgCard && pgCard.gameId); } catch {} pgCard = null; panel.remove(); }
    });
  }
  if (panel.nextElementSibling !== card) card.before(panel);
  panel.classList.toggle('win', !!c.win);
  const ic = (id, cls = '') => (id ? `<img class="pg-it ${cls}" src="${msItemIcon(id)}" alt="">` : '<span class="pg-it empty"></span>');
  const min = Math.max(1, c.dur / 60);
  const kda = ((c.k + c.a) / Math.max(1, c.d)).toFixed(2);
  const lp = c.lp && c.lp.delta != null ? `<span class="pg-lp ${c.lp.delta >= 0 ? 'up' : 'down'}">${c.lp.delta >= 0 ? '+' : ''}${c.lp.delta} LP</span>` : '';
  const rank = c.lp ? `<span class="pg-rank">${c.lp.tier.charAt(0) + c.lp.tier.slice(1).toLowerCase()}${/MASTER|GRANDMASTER|CHALLENGER/.test(c.lp.tier) ? '' : ' ' + (DIV_NUM[c.lp.division] || c.lp.division)} · ${c.lp.lp} LP</span>` : '';
  const mine = c.items.slice(0, 6);
  const head = `<div class="pg-head">
      <span class="pg-res">${c.win ? 'Victory' : 'Defeat'}</span>
      <span class="pg-sub">${lobbyEsc(c.queue)} · ${Math.floor(c.dur / 60)}:${String(c.dur % 60).padStart(2, '0')} · ${pgAgo(c.ts)}</span>
      ${lp}${rank}
      <button class="pg-x" title="Hide this card">×</button>
    </div>
    <div class="pg-main">
      <div class="pg-champ"><img src="${lobbyIcon(c.champ)}" alt=""><span>${c.level}</span></div>
      <div class="pg-stat"><div class="v">${c.k} / ${c.d} / ${c.a}</div><div class="k">${kda} KDA</div></div>
      <div class="pg-stat"><div class="v">${c.cs}</div><div class="k">CS · ${(c.cs / min).toFixed(1)}/min</div></div>
      <div class="pg-stat"><div class="v">${(c.dmg / 1000).toFixed(1)}k</div><div class="k">Damage</div></div>
      <div class="pg-stat"><div class="v">${(c.gold / 1000).toFixed(1)}k</div><div class="k">Gold</div></div>
      ${c.vision ? `<div class="pg-stat"><div class="v">${c.vision}</div><div class="k">Vision</div></div>` : ''}
      ${c.opp ? `<div class="pg-vs">vs <img src="${lobbyIcon(c.opp)}" alt="">${lobbyEsc(c.opp)}</div>` : ''}
    </div>`;
  const yours = `<span class="pg-lab">Your items</span><div class="pg-items">${mine.map((id) => ic(id)).join('')}${ic(c.items[6])}</div>`;
  panel.innerHTML = `${head}<div class="pg-rows">${yours}<span class="pg-lab">OTP core</span><div class="pg-items"><span class="pg-note">Loading one-trick games…</span></div></div>`;
  const otp = await pgOtpFor(c);
  if (!document.body.contains(panel) || pgCard !== c) return;
  let row;
  if (!otp || !otp.core.length) {
    row = '<span class="pg-note">Not enough one-trick games for this champion yet.</span>';
  } else {
    const have = new Set(mine.filter(Boolean));
    const hit = otp.core.filter((id) => have.has(id)).length;
    const skipped = otp.items.filter((x) => !have.has(x.id) && x.share >= 30).slice(0, 2);
    row = otp.core.map((id, i) => (i ? '<span class="pg-arr">›</span>' : '') + ic(id, have.has(id) ? 'ok' : 'miss')).join('')
      + `<span class="pg-note">You built <b>${hit}/${otp.core.length}</b> of the most common one-trick core${c.opp && otp.vsOnly ? ' vs ' + lobbyEsc(c.opp) : ''} (${otp.coreN} of ${otp.n} games).`
      + (skipped.length ? ` Often built, you skipped: ${skipped.map((x) => `<b>${lobbyEsc((otp.itemData[x.id] && otp.itemData[x.id].name) || 'item ' + x.id)}</b> (${x.share}%)`).join(', ')}.` : '') + '</span>';
  }
  panel.querySelector('.pg-rows').innerHTML = `${yours}<span class="pg-lab">OTP core</span><div class="pg-items">${row}</div>`;
}
ipcRenderer.on('otp:postgame', (_e, c) => { pgCard = c; Promise.resolve(renderPostGame()).finally(renderPgToast); });
ipcRenderer.invoke('otp:postgame-get').then((c) => { if (c) { pgCard = c; Promise.resolve(renderPostGame()).finally(renderPgToast); } }).catch(() => {});

// ---- ARAM Mayhem / Arena (build pages): op.gg build + augments for this champion ----
// Two extra tabs next to the site's "ARAM" tab. The panel opens under the filter
// row: core build, boots, and the champion's augments by tier (Mayhem: op.gg's
// own tiers; Arena: ranked by win rate, shrunk by game count, see opgg.js).
let modeOpen = '';
let modeFilter = 'all';
const modeCache = new Map();
// Augments are grouped by pick rate only (Riot's policy bans showing augment win rates).
const MODE_TIER = ['Most picked', 'Common', 'Less picked'];
const MODE_TIER_COL = ['#1063b7', '#3a4a5c', '#33373a'];
// op.gg rarity flags: 1 Silver, 4 Gold, 8 Prism.
const RARITY = { 1: 'Silver', 4: 'Gold', 8: 'Prism' };
const MODES_CSS = `
.otp-mode-tab{cursor:pointer}
.otp-mode-tab.on{color:#fff !important;border-bottom-color:var(--blue,#1063b7) !important}
#otp-modes{background:var(--fg,#212324);border:1px solid var(--border-light,#2c2f31);border-radius:10px;margin:10px 0 0;padding:14px 16px;color:var(--text,#e8e6e3);font-size:13px;box-sizing:border-box}
#otp-modes .md-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
#otp-modes .md-title{font-weight:700;font-size:16px}
#otp-modes .md-src{color:var(--lightText,#c2baaf);font-size:12px}
#otp-modes .md-x{margin-left:auto;background:transparent;border:0;color:var(--lightText,#c2baaf);font-size:18px;cursor:pointer;border-radius:6px;padding:2px 8px}
#otp-modes .md-x:hover{background:var(--fg-raised,#2c2e2f);color:#fff}
#otp-modes .md-sec{background:var(--bg,#181a1b);border:1px solid var(--border-light,#2c2f31);border-radius:10px;padding:10px 12px;margin-bottom:10px}
#otp-modes .md-sec h5{margin:0 0 8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--lightText,#c2baaf);display:flex;align-items:center;gap:8px}
#otp-modes .md-builds{display:flex;flex-wrap:wrap;gap:8px 22px;align-items:center}
#otp-modes .md-row{display:flex;align-items:center;gap:3px}
#otp-modes .md-row img{width:34px;height:34px;border-radius:7px;background:#111}
#otp-modes .md-row .arr{color:#656e73;margin:0 2px}
#otp-modes .md-rank{color:var(--lightText,#c2baaf);font-size:11px;font-weight:700;margin-right:6px}
#otp-modes .md-filters{margin-left:auto;display:flex;gap:4px}
#otp-modes .md-filters button{background:transparent;border:1px solid var(--border-light,#2c2f31);color:var(--lightText,#c2baaf);border-radius:999px;padding:2px 10px;font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;text-transform:none;letter-spacing:0}
#otp-modes .md-filters button.on{background:var(--blue,#1063b7);border-color:var(--blue,#1063b7);color:#fff}
#otp-modes .md-tier{display:grid;grid-template-columns:62px 1fr;gap:10px;align-items:start;padding:8px 0}
#otp-modes .md-tier+.md-tier{border-top:1px solid rgba(255,255,255,.05)}
#otp-modes .md-tl{font-weight:900;font-size:18px;text-align:center;border-radius:8px;padding:6px 0;color:#111}
#otp-modes .md-augs{display:flex;flex-wrap:wrap;gap:6px}
#otp-modes .md-aug{display:flex;align-items:center;gap:7px;background:var(--fg,#212324);border:1px solid var(--border-light,#2c2f31);border-radius:8px;padding:4px 9px 4px 4px;max-width:250px}
#otp-modes .md-aug img{width:28px;height:28px;border-radius:6px;flex:none}
#otp-modes .md-aug .nm{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#otp-modes .md-aug .st{font-size:10.5px;color:var(--lightText,#c2baaf)}
#otp-modes .md-aug.r1{border-left:3px solid #b8c4cc}
#otp-modes .md-aug.r4{border-left:3px solid #e8b84b}
#otp-modes .md-aug.r8{border-left:3px solid #c46bff}
#otp-modes .md-skills b,#otp-modes .md-levels b{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:7px;color:#fff;font-weight:800;font-size:14px}
#otp-modes .md-levels{gap:3px}
#otp-modes .md-levels b{width:22px;height:22px;font-size:11px;border-radius:5px}
#otp-modes .md-empty{color:var(--lightText,#c2baaf);padding:6px 0}
`;
function modeTabRow() {
  const aram = [...document.querySelectorAll('a')].find((a) => a.textContent.trim() === 'ARAM' && /\/champions\//.test(a.getAttribute('href') || ''));
  return aram || null;
}
function injectModeTabs() {
  if (!location.pathname.includes('/champions/builds/')) return;
  const aram = modeTabRow();
  if (!aram) return;
  if (!document.getElementById('otp-modes-css')) {
    const s = document.createElement('style');
    s.id = 'otp-modes-css'; s.textContent = MODES_CSS;
    document.head.appendChild(s);
  }
  let last = aram;
  for (const [mode, label] of [['aram-mayhem', 'ARAM Mayhem'], ['arena', 'Arena']]) {
    let a = document.querySelector(`.otp-mode-tab[data-mode="${mode}"]`);
    if (!a) {
      a = document.createElement('a');
      a.href = 'javascript:void(0)';
      a.dataset.mode = mode;
      a.textContent = label;
      a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); modeOpen = modeOpen === mode ? '' : mode; renderModes(); });
    }
    a.className = (aram.className || '') + ' otp-mode-tab' + (modeOpen === mode ? ' on' : '');
    if (last.nextElementSibling !== a) last.after(a);
    last = a;
  }
}
async function renderModes() {
  injectModeTabs();
  let panel = document.getElementById('otp-modes');
  if (!modeOpen || !location.pathname.includes('/champions/builds/')) { panel?.remove(); return; }
  const champ = lobbyChampOfPage();
  const card = siteFilterCard() || document.querySelector('h1')?.closest('.cardBorder');
  if (!card || !champ) return;
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'otp-modes';
    panel.addEventListener('click', (e) => {
      if (e.target.closest('.md-x')) { modeOpen = ''; renderModes(); return; }
      const f = e.target.closest('[data-rf]');
      if (f) { modeFilter = f.dataset.rf; renderModes(); }
    });
  }
  if (card.nextElementSibling !== panel) card.after(panel);
  const title = modeOpen === 'arena' ? 'Arena' : 'ARAM Mayhem';
  const key = modeOpen + '|' + champ;
  let d = modeCache.get(key);
  if (!d) {
    panel.innerHTML = `<div class="md-head"><span class="md-title">${lobbyEsc(champ)} · ${title}</span><span class="md-src">Loading from op.gg…</span><button class="md-x" title="Close">×</button></div>`;
    try { d = await ipcRenderer.invoke('otp:opgg-mode', { mode: modeOpen, champ }); } catch (e) { d = { error: String(e) }; }
    if (d && !d.error) modeCache.set(key, d);
    if (modeOpen + '|' + lobbyChampOfPage() !== key) return;
  }
  if (!d || d.error) {
    panel.innerHTML = `<div class="md-head"><span class="md-title">${lobbyEsc(champ)} · ${title}</span><button class="md-x" title="Close">×</button></div><div class="md-empty">Could not load op.gg data (${lobbyEsc(d && d.error || 'unknown')}).</div>`;
    return;
  }
  const itemIcon = (id) => `https://opgg-static.akamaized.net/meta/images/lol/latest/item/${id}.png`;
  const row = (ids, i) => `<div class="md-row"><span class="md-rank">${i + 1}</span>${ids.map((id, k) => (k ? '<span class="arr">›</span>' : '') + `<img src="${itemIcon(id)}" alt="">`).join('')}</div>`;
  const b = d.build || {};
  const buildHtml = (b.core || []).length
    ? `<div class="md-sec"><h5>Core build</h5><div class="md-builds">${b.core.slice(0, 3).map(row).join('')}${(b.boots || []).length ? `<div class="md-row"><span class="md-rank">Boots</span><img src="${itemIcon(b.boots[0])}" alt=""></div>` : ''}${(b.starter || [])[0] ? `<div class="md-row"><span class="md-rank">Start</span>${b.starter[0].map((id) => `<img src="${itemIcon(id)}" alt="">`).join('')}</div>` : ''}</div></div>`
    : '';
  // Summoner spells (op.gg ids) and skill max order.
  const SPELL_KEY = { 1: 'SummonerBoost', 3: 'SummonerExhaust', 4: 'SummonerFlash', 6: 'SummonerHaste', 7: 'SummonerHeal', 11: 'SummonerSmite', 12: 'SummonerTeleport', 13: 'SummonerMana', 14: 'SummonerDot', 21: 'SummonerBarrier', 32: 'SummonerSnowball' };
  const spellIcon = (id) => (SPELL_KEY[id] ? `https://opgg-static.akamaized.net/meta/images/lol/latest/spell/${SPELL_KEY[id]}.png` : '');
  const sk = (b.skills && b.skills.order) || [];
  const lv = (b.skills && b.skills.levels) || [];
  const SK_COL = { Q: '#b4335a', W: '#6a3fb0', E: '#2563a8', R: '#b36a12' };
  const spellsHtml = (b.spells || []).length || sk.length
    ? `<div class="md-sec"><h5>Spells &amp; skills</h5><div class="md-builds">${(b.spells || []).slice(0, 2).map((ids, i) => `<div class="md-row"><span class="md-rank">${i + 1}</span>${ids.map((id) => spellIcon(id) ? `<img src="${spellIcon(id)}" alt="">` : '').join('')}</div>`).join('')}${sk.length ? `<div class="md-row md-skills"><span class="md-rank">Max</span>${sk.map((k, i) => (i ? '<span class="arr">›</span>' : '') + `<b style="background:${SK_COL[k]}">${k}</b>`).join('')}</div>` : ''}${lv.length ? `<div class="md-row md-levels">${lv.map((k, i) => `<b title="Level ${i + 1}" style="background:${SK_COL[k]}">${k}</b>`).join('')}</div>` : ''}</div></div>`
    : '';
  const augs = (d.augments || []).filter((a) => modeFilter === 'all' || String(a.rarity) === modeFilter);
  const byTier = [0, 1, 2].map((t) => augs.filter((a) => a.band === t));
  const stat = (a) => `${a.pick.toFixed(1)}% picked`;
  const augHtml = byTier.map((list, t) => (list.length ? `<div class="md-tier"><div class="md-tl" style="background:${MODE_TIER_COL[t]}">${MODE_TIER[t]}</div><div class="md-augs">${list.map((a) => `<div class="md-aug r${a.rarity}" title="${lobbyEsc(a.name)}: ${lobbyEsc(a.desc)}"><img src="${a.icon}" alt=""><div style="min-width:0"><div class="nm">${lobbyEsc(a.name)}</div><div class="st">${stat(a)}</div></div></div>`).join('')}</div></div>` : '')).join('');
  const rarities = [['all', 'All'], ['1', 'Silver'], ['4', 'Gold'], ['8', 'Prism']];
  panel.innerHTML = `<div class="md-head"><span class="md-title">${lobbyEsc(champ)} · ${title}</span><span class="md-src">op.gg · by pick rate on this champion</span><button class="md-x" title="Close">×</button></div>
    ${buildHtml}
    ${spellsHtml}
    <div class="md-sec"><h5>Augments for ${lobbyEsc(champ)}<span class="md-filters">${rarities.map(([v, l]) => `<button data-rf="${v}" class="${modeFilter === v ? 'on' : ''}">${l}</button>`).join('')}</span></h5>${augHtml || '<div class="md-empty">No augment data.</div>'}</div>`;
}

// ---- Post-game toast: visible on any page right after a game ----
// The full card only lives at the top of build pages (and gives way to the lobby
// panel in the next champion select), so a game could end without you ever seeing
// it. This small card shows wherever you are until closed or opened.
function pgToastSeen(id) { try { return sessionStorage.getItem('otp.pgToast') === String(id) || localStorage.getItem('otp.pgToastSeen') === String(id); } catch { return false; } }
function pgToastMark(id) { try { localStorage.setItem('otp.pgToastSeen', String(id)); } catch {} }
function renderPgToast() {
  let t = document.getElementById('otp-pgtoast');
  const c = pgCard;
  const onFullCard = !!document.getElementById('otp-postgame');
  if (c && onFullCard) pgToastMark(c.gameId); // seen in full on the build page
  if (!c || onFullCard || pgToastSeen(c.gameId)) { t?.remove(); return; }
  if (!document.getElementById('otp-pgtoast-css')) {
    const s = document.createElement('style');
    s.id = 'otp-pgtoast-css';
    s.textContent = `#otp-pgtoast{position:fixed;left:16px;bottom:16px;z-index:2147483000;display:flex;align-items:center;gap:12px;background:#212324;border:1px solid #2c2f31;border-left:4px solid #e0605a;border-radius:10px;padding:10px 12px;color:#e8e6e3;font:13px -apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5)}
#otp-pgtoast.win{border-left-color:#4f9be8}
#otp-pgtoast img{width:42px;height:42px;border-radius:9px}
#otp-pgtoast .r{font-weight:800;font-size:14px;color:#e0605a}
#otp-pgtoast.win .r{color:#4f9be8}
#otp-pgtoast .s{color:#c2baaf;font-size:12px;margin-top:2px}
#otp-pgtoast .lp{font-weight:800;margin-left:6px}
#otp-pgtoast .lp.up{color:#2fb96b}
#otp-pgtoast .lp.down{color:#e0605a}
#otp-pgtoast button{background:#1063b7;border:0;color:#fff;border-radius:8px;padding:7px 12px;font:inherit;font-weight:700;cursor:pointer}
#otp-pgtoast .x{background:transparent;color:#8f96a3;padding:4px 6px;font-size:16px}
#otp-pgtoast .x:hover{color:#fff}`;
    document.head.appendChild(s);
  }
  if (!t) {
    t = document.createElement('div');
    t.id = 'otp-pgtoast';
    document.body.appendChild(t);
    t.addEventListener('click', (e) => {
      const card = pgCard;
      if (!card) return;
      if (e.target.closest('.x')) { pgToastMark(card.gameId); t.remove(); return; }
      if (e.target.closest('.go')) {
        pgToastMark(card.gameId);
        t.remove();
        const q = new URLSearchParams();
        if (card.opp) q.set('matchup', card.opp);
        if (card.role) q.set('role', card.role);
        lobbyGo(`/champions/builds/${encodeURIComponent(card.champ)}${q.toString() ? '?' + q : ''}`);
      }
    });
  }
  t.classList.toggle('win', !!c.win);
  const lp = c.lp && c.lp.delta != null ? `<span class="lp ${c.lp.delta >= 0 ? 'up' : 'down'}">${c.lp.delta >= 0 ? '+' : ''}${c.lp.delta} LP</span>` : '';
  t.innerHTML = `<img src="${lobbyIcon(c.champ)}" alt=""><div><div class="r">${c.win ? 'Victory' : 'Defeat'}${lp}</div><div class="s">${lobbyEsc(c.champ)} · ${c.k}/${c.d}/${c.a} · ${lobbyEsc(c.queue)}</div></div><button class="go">Details</button><button class="x" title="Close">×</button>`;
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
    const needsPg = isBuild && !!pgCard && !(lobbyState && (lobbyState.allies?.length || lobbyState.enemies?.length)) && !document.getElementById("otp-postgame");
    const needsModes = isBuild && (!document.querySelector(".otp-mode-tab") && !!modeTabRow() || (!!modeOpen && !document.getElementById("otp-modes")));
    const needsNav = !!document.querySelector("header") && !document.getElementById("otp-sitenav");
    const needsSearch = isBuild && (!msEl || (msCard && (msCard.nextElementSibling !== msEl || !document.getElementById("otp-ms-toggle"))));
    if (otpPro !== true && !window._otpProRaf) window._otpProRaf = requestAnimationFrame(() => { window._otpProRaf = 0; applyPro(); });
    if (needsHeader || needsFloat || needsTier || needsLobby || needsSearch || needsNav || needsPg || needsModes) requestMountUI(80);

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
