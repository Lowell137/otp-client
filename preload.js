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

// ---- Detect active First-Item filter from the onetricks.gg UI ----
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
        // Locate the runes card
        const allHeaders = Array.from(document.querySelectorAll('*'));
        const runesH = allHeaders.find(el =>
          el.textContent?.trim()?.endsWith('Runes') &&
          el.children.length === 0 &&
          el.textContent.trim().length < 30
        );
        if (!runesH) return null;
        const runesCard = runesH.closest('.cardBorder') || runesH.closest('[class*="card"]') || runesH.parentElement?.parentElement;
        if (!runesCard) return null;

        // Find active tab and its panel
        const tabs = Array.from(runesCard.querySelectorAll('[role="tab"]'));
        const activeTab = tabs.find(t => t.getAttribute('aria-selected') === 'true') || tabs[0];
        const panelId = activeTab?.getAttribute('aria-controls');
        const panel = (panelId ? document.getElementById(panelId) : null) || runesCard;
        const activeTabIdx = Math.max(0, tabs.indexOf(activeTab));
        const tabLabel = activeTab?.textContent?.trim() || 'Set 1';

        // Extract non-grayscale rune icons from the active panel
        const icons = Array.from(panel.querySelectorAll('[data-tooltip-html]'));
        const runeNames = [];
        const shardTexts = [];

        for (const ic of icons) {
          const cs = getComputedStyle(ic);
          if (cs.filter && cs.filter.includes('grayscale')) continue;
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

// ---- Build data from __NEXT_DATA__ with DOM rune override ----
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
      const r = await fetch(location.href, { credentials: 'omit' });
      const html = await r.text();
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (m) pp = JSON.parse(m[1])?.props?.pageProps;
    } catch {}
  }

  if (!pp) return { error: 'Page data not found' };

  const champ = pp.champion || pp.key?.split('--')?.[0];
  if (!champ) return { error: 'Champion not found on page' };

  const fis = pp.firstItemStats;
  if (!fis) return { error: 'No build data available for this champion' };

  const patches = Object.keys(fis);
  const patch = patches[0];
  const byFirst = fis[patch];
  if (!byFirst) return { error: `No build data for patch: ${patch}` };

  const firstKey = (selectedFirstKey && byFirst[selectedFirstKey])
    ? selectedFirstKey
    : (byFirst.all ? 'all' : Object.keys(byFirst)[0]);
  const group = byFirst[firstKey] ?? byFirst.all ?? byFirst[Object.keys(byFirst)[0]];
  if (!group) return { error: 'Build group not found' };

  // ---- RUNE EXTRACTION: DOM first, fallback to popRunes ----
  const runeNameMap = buildRuneNameMap(pp.runes?.subStyle);
  const slotMap = buildSlotMap(pp.runes?.subStyle);
  const fallbackStats = group.popStat ?? [5008, 5008, 5001];

  let runes = await extractActiveRunesFromDOM(runeNameMap, fallbackStats);

  if (!runes) {
    // Fallback: pick best variant from popRunes (static data)
    let bestKeystone = null;
    let bestVariant = null;
    for (const [k, variants] of Object.entries(group.popRunes || {})) {
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
    runes = {
      primary,
      sub,
      keystone: Number(bestKeystone),
      selectedPerkIds: [...ordered, ...fallbackStats].map(Number),
      source: 'static:bestVariant'
    };
  }

  // ---- ITEMS ----
  const sSpells = group.sSpells?.[0]?.[0]?.map(Number) ?? [];
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

// ---- Settings Management ----
const DEF_SETTINGS = { follow: true, autoBuild: false, autoAccept: false, autoSpell: true };
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

// ---- CSS matching onetricks.gg native style ----
const CSS = `
/* Hide video ads that displace header layout */
.video-ad-center, .video-ad-top, .video-ad { display: none !important; }

/* Primary "Import" Button matching onetricks "Get Pro" style */
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

/* Gear Icon Button matching onetricks secondary buttons */
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
#otp-popover {
  display: none; position: absolute; top: 40px; right: 0;
  width: 240px; background: rgb(24, 26, 27);
  border: 1px solid rgb(85, 85, 85); border-radius: 6px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.6);
  padding: 6px; font-family: inherit; font-size: 12px;
  color: rgb(232, 230, 227); z-index: 10000;
}
#otp-popover.open { display: block; }

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

  const res = await ipcRenderer.invoke('otp:import-build', b);
  if (btn) btn.disabled = false;

  const logEl = document.getElementById('otp-log');
  if (res.ok) {
    const parts = ['Runes', 'Items', res.spells ? 'Spells' : null].filter(Boolean).join(' + ');
    const rateText = b.rate ? ` (${(b.rate * 100).toFixed(0)}% WR)` : '';
    if (logEl) logEl.textContent = `${b.champion} \u2713 ${parts}${rateText}`;
    toast(`Imported: ${b.champion} (${parts})`);
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
}

// ---- Inject CSS ----
function injectStyles() {
  if (document.getElementById('otp-injected-css')) return;
  const st = document.createElement('style');
  st.id = 'otp-injected-css';
  st.textContent = CSS;
  document.head.appendChild(st);
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

  // champBox is the flex container with avatar + title, has align-items:center
  const champBox = h1.parentElement?.parentElement;
  if (!champBox) return;
  const style = champBox.getAttribute('style') || '';
  if (!style.includes('align-items:center')) return; // safety check

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

  // Gear button
  const gearBtn = document.createElement('button');
  gearBtn.id = 'otp-gear-btn';
  gearBtn.className = 'otp-gear';
  gearBtn.title = 'Settings';
  gearBtn.innerHTML = GEAR_SVG;
  gearBtn.onclick = (e) => { e.stopPropagation(); togglePopover(); };

  // Settings popover
  const popover = document.createElement('div');
  popover.id = 'otp-popover';
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
        <span>Auto Import on Lock-in</span>
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
    </div>
    <div id="otp-log" class="otp-popover-log"></div>
  `;

  bar.appendChild(importBtn);
  bar.appendChild(gearBtn);
  bar.appendChild(popover);
  champBox.appendChild(bar);

  // Dikey hiza: buton grubunun ortasını h1 başlığının ortasıyla eşitle
  requestAnimationFrame(() => {
    try {
      const boxTop = champBox.getBoundingClientRect().top;
      const hTop = h1.getBoundingClientRect().top;
      const mt = (hTop - boxTop) + (h1.offsetHeight - bar.offsetHeight) / 2;
      if (mt > 0) bar.style.marginTop = mt.toFixed(1) + 'px';
    } catch {}
  });

  // Wire up setting switches
  const paintSwitches = () => {
    bar.querySelectorAll('.otp-switch-row').forEach(r => {
      r.classList.toggle('on', !!settings[r.dataset.k]);
    });
  };
  bar.querySelectorAll('.otp-switch-row').forEach(r => {
    r.onclick = (e) => {
      e.stopPropagation();
      settings[r.dataset.k] = !settings[r.dataset.k];
      saveSettings();
      paintSwitches();
    };
  });
  paintSwitches();

  // Close popover when clicking outside
  document.addEventListener('click', (e) => {
    const pop = document.getElementById('otp-popover');
    if (pop && !bar.contains(e.target)) {
      pop.classList.remove('open');
    }
  });

  updateClientStatusUI();
}

function mountUI() {
  injectStyles();
  injectHeaderActions();
}

// ---- Auto-Import Check upon navigation ----
function checkPendingAutoImport() {
  try {
    const pending = localStorage.getItem('otp.pendingAuto');
    const m = location.pathname.match(/\/champions\/builds\/([^/]+)/i);
    if (pending && m && m[1].toLowerCase() === pending.toLowerCase() && settings.autoBuild) {
      localStorage.removeItem('otp.pendingAuto');
      lastAutoImport = pending.toLowerCase();
      setTimeout(() => doImport(true), 2500);
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

// ---- Champion Select Listener ----
ipcRenderer.on('otp:auto-champ', (_e, name) => {
  if (!name) return;
  const target = `/champions/builds/${name}`.toLowerCase();
  const here = location.pathname.toLowerCase() === target;

  if (settings.autoBuild && lastAutoImport !== name.toLowerCase()) {
    lastAutoImport = name.toLowerCase();
    if (here) {
      setTimeout(() => doImport(true), 2000);
    } else {
      try { localStorage.setItem('otp.pendingAuto', name); } catch {}
      if (settings.follow) {
        toast(`Picked: ${name} -> Importing build`);
        setTimeout(() => {
          location.href = `https://www.onetricks.gg/champions/builds/${encodeURIComponent(name)}`;
        }, 800);
      }
    }
  } else if (settings.follow && !here) {
    toast(`Picked: ${name} -> Navigating to build`);
    setTimeout(() => {
      location.href = `https://www.onetricks.gg/champions/builds/${encodeURIComponent(name)}`;
    }, 800);
  }
});

// ---- Lifecycle & Observers ----
// contextBridge must be called synchronously at top-level
contextBridge.exposeInMainWorld('otp', { parseBuild, doImport });

// Defer DOM manipulation until the document is ready
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    mountUI();
    checkPendingAutoImport();
    refreshLcuStatus();
  }, 500);

  // Re-inject UI when React re-renders the page (SPA navigation)
  new MutationObserver(() => {
    mountUI();
  }).observe(document.documentElement, { childList: true, subtree: true });
});

// Periodically refresh LCU connection status
setInterval(refreshLcuStatus, 4000);
