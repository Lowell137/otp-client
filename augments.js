// "Ask about these augments" (in-game assistant, ARAM Mayhem / Arena): a picture
// of the screen the game is on, Windows' own OCR (Windows.Media.Ocr, through
// PowerShell, nothing to install) reads the text, and the augment names found
// are matched against op.gg's list for my champion in this mode.
//
// Riot's policy bans showing augment win rates, so the answer uses only how
// often each augment is picked on this champion and what it does.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// PowerShell 5.1 + WinRT OCR. Path of the PNG is passed in, lines come out.
const OCR_PS = (png) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait() | Out-Null; $task.Result }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${png.replace(/'/g, "''")}')) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$stream.Dispose()
$result.Lines | ForEach-Object { $_.Text }
`;

function ocr(pngPath) {
  // WinRT StorageFile wants a full Windows path (backslashes).
  const enc = Buffer.from(OCR_PS(path.resolve(pngPath).replace(/\//g, '\\')), 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
      { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => {
        if (err) {
          // PowerShell writes errors as CLIXML on stderr: keep the message text.
          const raw = String(errOut || err.message);
          const msg = (raw.match(/<S S="Error">([^<]*)<\/S>/g) || []).map((x) => x.replace(/<[^>]+>/g, '').replace(/_x000D__x000A_/g, ' ')).join(' ').trim();
          return reject(new Error('OCR failed: ' + (msg || raw.split('\n')[0]).slice(0, 200)));
        }
        resolve(String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
      });
  });
}

// Screen picture of the display the game is on (the overlay covers the game).
async function capture(bounds) {
  const { desktopCapturer, screen } = require('electron');
  const disp = bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay();
  const size = { width: Math.round(disp.size.width * disp.scaleFactor), height: Math.round(disp.size.height * disp.scaleFactor) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
  if (!src) throw new Error('no screen');
  const file = path.join(os.tmpdir(), `otp-augments-${Date.now()}.png`);
  fs.writeFileSync(file, src.thumbnail.toPNG());
  return file;
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

// Augment names that appear in the OCR text (cards may wrap a name over lines).
function matchNames(lines, augments) {
  const joined = norm(lines.join(' '));
  const found = augments.filter((a) => {
    const n = norm(a.name);
    return n.length >= 4 && joined.includes(n);
  });
  // A short name inside a longer one that also matched ("Deft" in "Deft Hands"): keep the longer.
  return found.filter((a) => !found.some((b) => b !== a && norm(b.name).includes(norm(a.name))));
}

async function ask({ all, bounds, champIdToKey }) {
  const mode = /CHERRY/i.test(all?.gameData?.gameMode || '') ? 'arena' : 'aram-mayhem';
  const meName = all?.activePlayer?.riotId || all?.activePlayer?.summonerName;
  const me = (all?.allPlayers || []).find((p) => (p.riotId || p.summonerName) === meName);
  const champ = String(me?.rawChampionName || '').replace(/^.*_displayname_/, '') || String(me?.championName || '').replace(/[^A-Za-z]/g, '');
  if (!champ) return { ok: false, error: 'Could not tell which champion you are playing.' };
  const data = await require('./opgg.js').modeData(mode, champ);
  const augs = data.augments || [];
  if (!augs.length) return { ok: false, error: `No augment data on op.gg for ${champ}.` };
  const file = await capture(bounds);
  let lines;
  try { lines = await ocr(file); } finally { try { fs.unlinkSync(file); } catch {} }
  const found = matchNames(lines, augs).sort((a, b) => b.pick - a.pick).slice(0, 4);
  if (!found.length) {
    return { ok: false, error: 'I could not read any augment names. Open the augment choice first, keep it uncovered, and try again. (If the game is not in English, names may not match op.gg.)' };
  }
  const mostPicked = found[0];
  const text = [
    `Augments on your screen, by how often ${me?.championName || champ} players pick them (op.gg):`,
    ...found.map((a) => `**${a.name}** · picked ${a.pick.toFixed(1)}%${a.desc ? ` · ${a.desc.length > 110 ? a.desc.slice(0, 107) + '…' : a.desc}` : ''}`),
    found.length > 1 ? `Most picked here: **${mostPicked.name}**. Pick rate only; the choice is yours.` : '',
  ].filter(Boolean).join('\n');
  return { ok: true, text, found: found.map((a) => ({ name: a.name, pick: a.pick })) };
}

module.exports = { ask, ocr, matchNames };
