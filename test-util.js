// Helpers shared by the tests: a temp home that is removed when the test ends, and a way to run brain.js as a child process.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const brainPath = path.join(__dirname, 'brain.js');
const homes = [];
process.on('exit', () => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });

const tempHome = (prefix = 'brain-test-') => { const h = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); homes.push(h); return h; };
// run `node brain.js <args>` with BRAIN_HOME set; `input` goes to stdin. `env` adds variables, `opts` (timeout, maxBuffer) goes to spawnSync.
const runBrain = (home, args, input, env = {}, opts = {}) =>
  spawnSync(process.execPath, [brainPath, ...args], { input, env: { ...process.env, BRAIN_HOME: home, ...env }, encoding: 'utf8', ...opts });

module.exports = { brainPath, tempHome, runBrain };
