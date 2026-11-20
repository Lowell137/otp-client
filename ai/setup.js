// Assistant setup when Ollama is missing: what this PC has (GPU memory, RAM),
// which model fits, the commands to paste into PowerShell, and a one-click
// install that opens a visible PowerShell window (winget installs Ollama, then
// `ollama pull <model>`); the panel polls until the model is there.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

// Picked from what the Ollama library has (checked 2026-11-21) and what worked
// in our tests: Qwen3.5 answered best, LFM3 is the lightest.
const MODELS = [
  { id: 'lfm3:1.7b', name: 'LFM3 1.7B', note: 'Lightest, fast, tool calling. Text only.', minVram: 0 },
  { id: 'qwen3.5:4b', name: 'Qwen3.5 4B', note: 'Balanced. Reads screenshots.', minVram: 6000 },
  { id: 'qwen3.5:9b', name: 'Qwen3.5 9B', note: 'Best answers. Reads screenshots. Tight on 8 GB of GPU memory while the game runs.', minVram: 7800 },
];

const ollamaExe = () => path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe');

function gpu() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 4000, windowsHide: true }, (err, out) => {
      if (err || !out) return resolve(null);
      const [name, mem] = String(out).split('\n')[0].split(',').map((s) => s.trim());
      resolve({ name, vramMb: Number(mem) || 0 });
    });
  });
}

function recommend(vramMb) {
  // The game uses some GPU memory too, so leave room for it.
  if (vramMb >= 9500) return 'qwen3.5:9b';
  if (vramMb >= 6000) return 'qwen3.5:4b';
  return 'lfm3:1.7b';
}

async function status(provider) {
  const g = await gpu();
  let running = false, models = [];
  try { await provider.ping(); running = true; models = (await provider.models()).map((m) => m.id); } catch {}
  const vram = g?.vramMb || 0;
  return {
    installed: fs.existsSync(ollamaExe()), running, models,
    gpu: g ? `${g.name} · ${Math.round(vram / 1024)} GB` : 'No NVIDIA GPU found',
    ramGb: Math.round(os.totalmem() / 1024 ** 3),
    recommended: recommend(vram),
    choices: MODELS.map((m) => ({ ...m, fits: vram >= m.minVram || m.minVram === 0 })),
  };
}

const safeModel = (m) => (MODELS.some((x) => x.id === m) ? m : 'qwen3.5:4b');

// What a person pastes into PowerShell themselves.
function commands(model) {
  const m = safeModel(model);
  return [
    '# 1) Install Ollama',
    'winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements',
    '# 2) Download the model (open a new PowerShell window first if "ollama" is not found)',
    `ollama pull ${m}`,
  ].join('\r\n');
}

// One click: a visible PowerShell window does the same, with progress.
function install(model) {
  const m = safeModel(model);
  const script = [
    "$Host.UI.RawUI.WindowTitle = 'OTP Client - assistant setup'",
    "Write-Host 'OTP Client: setting up the assistant' -ForegroundColor Cyan",
    `$exe = Join-Path $env:LOCALAPPDATA 'Programs\\Ollama\\ollama.exe'`,
    "if (-not (Test-Path $exe)) { Write-Host 'Installing Ollama...' -ForegroundColor Cyan; winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements }",
    "if (-not (Test-Path $exe)) { Write-Host 'Ollama did not install. Get it from https://ollama.com/download and run this again.' -ForegroundColor Red; return }",
    "if (-not (Get-Process ollama -ErrorAction SilentlyContinue)) { Start-Process $exe 'serve' -WindowStyle Hidden; Start-Sleep -Seconds 4 }",
    `Write-Host 'Downloading ${m} (this can take a few minutes)...' -ForegroundColor Cyan`,
    `& $exe pull ${m}`,
    "if ($LASTEXITCODE -eq 0) { Write-Host 'Done. Go back to OTP Client; you can close this window.' -ForegroundColor Green } else { Write-Host 'The download failed. Try again.' -ForegroundColor Red }",
  ].join('; ');
  const child = spawn('cmd.exe', ['/c', 'start', '""', 'powershell.exe', '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { ok: true, model: m };
}

module.exports = { status, commands, install, MODELS };
