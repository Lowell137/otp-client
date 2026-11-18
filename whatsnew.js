// "What's new" pop-up drawn inside the current page (site or local) by main via
// executeJavaScript. A shadow root keeps the site's CSS out; font and logo are
// inlined as data URLs because https pages can't load file:// assets.
// The returned promise resolves when the user dismisses it.
const fs = require('fs');
const path = require('path');

function dataUrl(file, mime) {
  try { return `data:${mime};base64,${fs.readFileSync(path.join(__dirname, file)).toString('base64')}`; } catch { return ''; }
}

const CSS = (font) => `
@font-face { font-family: "OTP Montserrat"; font-weight: 800; src: url("${font}") format("woff2"); }
:host { all: initial; }
.back { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .55); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #e8e6e3; font-size: 13px;
  -webkit-font-smoothing: antialiased; -webkit-app-region: no-drag; animation: fade .18s ease-out; }
.card { width: min(440px, calc(100vw - 32px)); max-height: min(600px, calc(100vh - 80px)); display: flex; flex-direction: column;
  background: #212324; border: 1px solid #2c2f31; border-radius: 12px; overflow: hidden;
  box-shadow: 0 24px 64px rgba(0, 0, 0, .55); animation: pop .22s cubic-bezier(.2, .9, .3, 1); }
.top { padding: 22px 24px 16px; display: flex; align-items: center; gap: 12px;
  background: linear-gradient(180deg, rgba(16, 99, 183, .18), transparent); }
.top img { width: 40px; height: 40px; border-radius: 9px; }
.t { display: flex; flex-direction: column; gap: 3px; }
.t b { font-family: "OTP Montserrat", sans-serif; font-weight: 800; font-size: 17px; letter-spacing: .03em; }
.t span { color: #c2baaf; font-size: 12px; }
.list { overflow-y: auto; padding: 4px 16px 8px; }
.list::-webkit-scrollbar { width: 8px; }
.list::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, .14); border-radius: 8px; }
.it { display: flex; gap: 12px; padding: 10px 8px; border-radius: 8px; }
.it:hover { background: #2c2e2f; }
.dot { flex: none; width: 8px; height: 8px; margin-top: 5px; border-radius: 50%; background: #1063b7; box-shadow: 0 0 0 3px rgba(16, 99, 183, .2); }
h3 { margin: 0 0 3px; font-size: 13.5px; font-weight: 700; color: #e8e6e3; }
p { margin: 0; color: #c2baaf; font-size: 12.5px; line-height: 1.45; }
.older { color: #8b8f92; font-size: 11.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; padding: 14px 8px 4px; }
.foot { padding: 14px 24px 18px; display: flex; justify-content: flex-end; border-top: 1px solid #2c2f31; }
button { background: #1063b7; color: #fff; border: 0; border-radius: 8px; font: inherit; font-weight: 600; padding: 9px 22px; cursor: pointer; }
button:hover { filter: brightness(1.1); }
button:focus { outline: none; }
button:focus-visible { box-shadow: 0 0 0 2px #212324, 0 0 0 4px rgba(16, 99, 183, .55); }
@keyframes fade { from { opacity: 0; } }
@keyframes pop { from { opacity: 0; transform: translateY(8px) scale(.98); } }
`;

function overlayScript(data) {
  const payload = JSON.stringify({
    data,
    css: CSS(dataUrl('assets/fonts/montserrat-800-latin.woff2', 'font/woff2')),
    logo: dataUrl('assets/logo-80.png', 'image/png'),
  });
  return `new Promise((resolve) => {
    const { data, css, logo } = ${payload};
    document.getElementById('otp-whatsnew-host')?.remove();
    const host = document.createElement('div');
    host.id = 'otp-whatsnew-host';
    const root = host.attachShadow({ mode: 'open' });
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const item = ([h, p]) => '<div class="it"><div class="dot"></div><div><h3>' + esc(h) + '</h3><p>' + esc(p) + '</p></div></div>';
    const list = data.entries.map((e, i) => (i ? '<div class="older">Version ' + esc(e.version) + '</div>' : '') + e.items.map(item).join('')).join('');
    root.innerHTML = '<style>' + css + '</style><div class="back"><div class="card" role="dialog" aria-label="What\\'s new">'
      + '<div class="top"><img src="' + logo + '" alt=""><div class="t"><b>WHAT\\'S NEW</b><span>Updated to version ' + esc(data.version) + '</span></div></div>'
      + '<div class="list">' + list + '</div><div class="foot"><button>Got it</button></div></div></div>';
    const close = () => { host.remove(); window.removeEventListener('keydown', onKey, true); resolve(true); };
    const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); } };
    root.querySelector('button').onclick = close;
    root.querySelector('.back').addEventListener('click', (e) => { if (e.target.classList.contains('back')) close(); });
    window.addEventListener('keydown', onKey, true);
    (document.body || document.documentElement).appendChild(host);
    root.querySelector('button').focus();
  })`;
}

module.exports = { overlayScript };
