// LCU credentials for a client running under Darling: league-connect's own
// lookup greps ps output, and with more than one LeagueClientUx generation the
// port and token can come from different processes. Read the candidate
// processes directly and keep the one whose API answers.
const fs = require('fs');
const path = require('path');
const { request, authenticate } = require('league-connect');

const CERT = fs.readFileSync(path.join(__dirname, 'node_modules/league-connect/riotgames.pem'));
let cached = null;

function candidates() {
  const found = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let args;
    try { args = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').join(' '); } catch { continue; }
    if (!args.includes('LeagueClientUx')) continue;
    const port = args.match(/--app-port=(\d+)/);
    const password = args.match(/--remoting-auth-token=([\w-]+)/);
    if (port && password) found.push({ pid: Number(name), port: Number(port[1]), password: password[1], certificate: CERT });
  }
  return found;
}

async function findCreds() {
  // Windows and a stock macOS client have a single, unambiguous process; use
  // league-connect's own lookup there. The /proc scan is for hosts where more
  // than one LeagueClientUx generation is visible at once (Darling).
  if (process.platform !== 'linux') {
    return authenticate({ awaitConnection: false });
  }
  for (const creds of candidates()) {
    try {
      const res = await request({ method: 'GET', url: '/lol-perks/v1/pages' }, creds);
      if (res.status === 200) return creds;
    } catch {}
  }
  return null;
}

async function getCreds(force = false) {
  if (cached && !force) return cached;
  cached = await findCreds();
  if (!cached) throw new Error('no League Client LCU credentials found');
  return cached;
}

function clearCreds() { cached = null; }

module.exports = { getCreds, clearCreds };
