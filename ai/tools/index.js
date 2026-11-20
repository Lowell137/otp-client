// Tool registry: every other .js file in this folder is one tool:
//   module.exports = { name, description, parameters (JSON schema), async run(args, ctx) }
// Adding a capability = dropping a file here. run() returns a JSON-able object;
// { error } tells the model what went wrong in plain words.
const fs = require('fs');
const path = require('path');

let cache = null;
function all() {
  if (cache) return cache;
  cache = [];
  for (const f of fs.readdirSync(__dirname).sort()) {
    if (!f.endsWith('.js') || f === 'index.js') continue;
    try {
      const t = require(path.join(__dirname, f));
      if (t && t.name && typeof t.run === 'function') cache.push(t);
    } catch (e) {
      console.warn(`[otp] ai tool ${f} failed to load:`, e?.message || e);
    }
  }
  return cache;
}

const byName = (n) => all().find((t) => t.name === n) || null;

module.exports = { all, byName };
