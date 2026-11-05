#!/usr/bin/env node
// Brain graph v2: turn ~/.codex rules and memory into a graph, then pick the few nodes a prompt needs.
// Matches by words (plus thesaurus.json synonyms) and by meaning (a small local embedding model).
//   node brain.js build [--require-embeddings]   build graph.json, then vectors (downloads the model once)
//   node brain.js query "<text>"                 show what would be injected for this text
//   node brain.js hook                           UserPromptSubmit hook (JSON on stdin, JSON on stdout, fails open)
//   node brain.js refresh                        embed nodes that have no vector yet (the hook starts this itself)
// Env BRAIN_HOME overrides ~/.codex (used by the test). Only the build step may use the network (model download).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const history = require('./history.js');
const { homeDir, graphFile, dataDir, tokens, build, fresh, loadThesaurus, wordScores, rank, query } = require('./rules.js');
const { MODEL, ehash, withTimeout, getEmbedder, readVectors, embedNodes } = require('./embed.js');

const MAX_CHARS = 2400, NODE_CHARS = 320;
const SIM_FLOOR = 0.2, SIM_SPAN = 0.35, SIM_GATE = 0.3;              // calibrated on the real rules: unrelated prompts peak at 0.18
const EMBED_TIMEOUT = 9000, REFRESH_LOCK_MS = 120000, MK_LOCK_MS = 600000; // the hook limit is 15 s (settings.json); the map search is skipped after 11 s
const MK_BUDGET_MS = 11000;

// Words + synonyms + meaning. Any trouble with the model falls back to words + synonyms.
async function searchFull(home, text, opts = {}) {
  const g = fresh(home), score = wordScores(g, text, opts.thesaurus || loadThesaurus());
  let hist = [], pv = null;
  const vecs = readVectors(home, opts.model || MODEL);
  if (vecs) {
    try {
      const embed = opts.embed || (await getEmbedder(false));
      if (embed) {
        [pv] = await withTimeout(embed([text.slice(0, 500)]), opts.timeoutMs || EMBED_TIMEOUT);
        hist = history.searchHistory(home, pv, opts.model || MODEL, { max: 2, exclude: text.trim() });
        for (const n of g.nodes) {
          const v = vecs.get(ehash(n));
          if (!v || v.length !== pv.length) continue;               // vector of another size: ignore
          let sim = 0;
          for (let i = 0; i < v.length; i++) sim += v[i] * pv[i];
          if (sim < SIM_GATE && !score.has(n.id)) continue;        // meaning alone needs a clear match
          const s = Math.min(Math.max((sim - SIM_FLOOR) / SIM_SPAN, 0), 1);
          if (s > 0) score.set(n.id, (score.get(n.id) || 0) + s);
        }
      }
    } catch { /* words and synonyms only */ }
  }
  try { // exact rare words (ids, file names) fill the free history slots: meaning search can miss them
    for (const e of require('./graphdb.js').lexical(home, text, tokens, { max: 2, exclude: text.trim() })) if (hist.length < 2 && !hist.some((h) => h.p === e.p)) hist.push(e);
  } catch { /* the keyword graph is optional */ }
  return { nodes: rank(g, score), hist, pv };
}

// The Makillez map (mk.js): a spreading search over technical-docs + the code graph. Empty when there is no map or nothing fits.
function mapFor(home, text, pv, started, session, cwd = '') {
  try {
    if (Date.now() - started > MK_BUDGET_MS) return '';
    const mk = require('./mk.js');
    const res = mk.searchAll(home, text, { pv, cwd });   // Makillez, ESG, AIPO or (as a fallback) the general tech docs
    if (res && session) mk.remember(home, session, res);   // so a file opened soon after can teach the network (see `touched`)
    return mk.format(res);
  } catch { return ''; }
}

// PostToolUse hook: a file was opened or edited. If a map was shown for this session a moment ago, learn from it. JSON on stdin; prints nothing; fails open.
function touchedHook() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const ti = input.tool_input || {};
    const file = ti.file_path || ti.notebook_path || ti.path;
    if (!file || !input.session_id) return;
    require('./mk.js').touched(homeDir(), input.session_id, file);
  } catch { /* never block a tool call */ }
}

// When a doc or the code graph changed since the map was built, rebuild it in the background (once per 10 minutes). The old map keeps serving.
function refreshMapInBackground(home) {
  try {
    if (process.env.BRAIN_HOME) return; // set only by the tests: they must never start a real map build
    const mk = require('./mk.js');
    const stamp = path.join(dataDir(home), 'mk-check');
    let due = true;
    try { due = Date.now() - fs.statSync(stamp).mtimeMs > 60000; } catch { /* no stamp yet */ }
    if (!due) return;
    try { fs.writeFileSync(stamp, ''); } catch { /* data folder missing: check every time */ }
    if (!mk.stale(home)) return;
    const lock = path.join(dataDir(home), 'mk.lock');
    if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < MK_LOCK_MS) return;
    fs.writeFileSync(lock, String(Date.now()));
    spawn(process.execPath, ['--max-old-space-size=4096', __filename, 'build-mk'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref();
  } catch { /* never block a prompt */ }
}

async function search(home, text, opts = {}) { return (await searchFull(home, text, opts)).nodes; }

function format(nodes) {
  let out = 'Relevant rules from the brain graph (matched to this prompt):\n';
  for (const n of nodes) {
    const t = n.text.length > NODE_CHARS ? n.text.slice(0, NODE_CHARS) + '...' : n.text;
    const line = `- [${n.file}${n.section ? ' > ' + n.section : ''}${n.stale ? ', old note: verify' : ''}] ${t}\n`;
    if (out.length + line.length > MAX_CHARS) break;
    out += line;
  }
  return out;
}

// After a source file changed, new nodes have no vector. Embed them in the background (once per 2 minutes, no download).
function refreshInBackground(home) {
  try {
    const vecs = readVectors(home, MODEL);
    // checking history reads the whole vector file, so do it at most once a minute (and not at all when no model is installed)
    const stamp = path.join(dataDir(home), 'history-check');
    let due = true;
    try { due = Date.now() - fs.statSync(stamp).mtimeMs > 60000; } catch { /* no stamp yet */ }
    if (vecs && due) try { fs.writeFileSync(stamp, ''); } catch { /* data folder missing: check every time */ }
    const historyNeedsRefresh = !!vecs && due && history.hasUnembedded(home, MODEL);
    let nodesNeedRefresh = false;
    if (vecs) {
      const g = fresh(home);
      nodesNeedRefresh = g.nodes.some((n) => !n.inContext && !vecs.has(ehash(n)));
    }
    if (!nodesNeedRefresh && !historyNeedsRefresh) return;
    const lock = path.join(dataDir(home), 'refresh.lock');
    if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < REFRESH_LOCK_MS) return;
    fs.writeFileSync(lock, String(Date.now()));
    spawn(process.execPath, [__filename, 'refresh'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref();
  } catch { /* never block a prompt */ }
}

async function hook() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const prompt = String(input.prompt || '');
    if (/^\s*\//.test(prompt) || prompt.trim().split(/\s+/).length < 4 || history.isAutomated(prompt)) return;
    const started = Date.now();
    const { nodes, hist, pv } = await searchFull(homeDir(), prompt);
    const cwd = typeof input.cwd === 'string' ? input.cwd : '';
    try { history.append(homeDir(), prompt, cwd); } catch {}
    refreshInBackground(homeDir());
    refreshMapInBackground(homeDir());
    const parts = [];
    if (nodes.length) parts.push(format(nodes));
    const map = mapFor(homeDir(), prompt, pv, started, typeof input.session_id === 'string' ? input.session_id : '', cwd);
    if (map) parts.push(map);
    if (hist.length) parts.push(history.formatHistory(hist));
    if (!parts.length) return;
    const additionalContext = parts.join('\n');
    const out = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } });
    await new Promise((resolve) => process.stdout.write(out, resolve));
  } catch { /* fail open: never block a prompt */ }
}

module.exports = { build, query, search, searchFull, embedNodes, format, tokens };

if (require.main === module) {
  (async () => {
    const [mode, arg] = process.argv.slice(2);
    const home = homeDir();
    if (mode === 'build') {
      const g = build();
      console.log(`built ${g.nodes.length} nodes, ${g.links.length} links -> ${graphFile(home)}`);
      for (const w of g.graph.warnings || []) console.log('WARNING ' + w);
      const embed = await getEmbedder(true);
      if (!embed) {
        console.log('embeddings: not available (run setup.ps1 to install the model). Words and synonyms only.');
        if (process.argv.includes('--require-embeddings')) process.exitCode = 3;
      } else {
        const r = await embedNodes(home, g, embed);
        console.log(`embeddings: ${r.total} nodes with ${MODEL} (${r.added} new)`);
        const hr = await history.embedHistory(home, embed, MODEL); // prompts pulled from git on a new machine need their numbers too
        console.log(`history: ${hr.total} prompts with meaning numbers (${hr.added} new)`);
      }
    } else if (mode === 'refresh') {
      const embed = await getEmbedder(false);
      if (embed) {
        await embedNodes(home, fresh(home), embed);
        await history.embedHistory(home, embed, MODEL);
      }
      try { require('./graphdb.js').sync(home, tokens); } catch { /* the keyword graph is optional */ }
    } else if (mode === 'graph') { // rebuild the keyword graph of your prompts if needed, then show the strongest keyword pairs
      const gdb = require('./graphdb.js'), r = gdb.sync(home, tokens);
      console.log(`${r.prompts} prompts, ${r.keywords} keywords, ${r.edges} links${r.rebuilt ? ' (rebuilt)' : ''} -> ${gdb.dbFile(home)}`);
      for (const e of gdb.top(home)) console.log(`${String(e.w).padStart(4)}  ${e.x} -- ${e.y}`);
    } else if (mode === 'related') { // node brain.js related "word": linked keywords and the prompts that hold it
      const gdb = require('./graphdb.js');
      gdb.sync(home, tokens);
      const r = gdb.related(home, arg || '', tokens);
      console.log(`${r.word}: in ${r.df} prompt(s)`);
      if (r.neighbours.length) console.log('linked: ' + r.neighbours.map((n) => `${n.word} (${n.w})`).join(', '));
      for (const p of r.prompts) console.log(`- ${p.t.slice(0, 10)} ${p.p.replace(/\s+/g, ' ').slice(0, 140)}`);
    } else if (mode === 'check') { // problems in note headers (valid-until, supersedes) and notes dropped on purpose
      const w = build(home).graph.warnings;
      console.log(w.length ? w.map((x) => 'WARNING ' + x).join('\n') : 'no problems in note headers');
      process.exitCode = w.some((x) => !/dropped/.test(x)) ? 1 : 0;
    } else if (mode === 'build-dq') { // embed the section questions in doc-questions.json into data/dq.bin (the question index); about a minute
      try { const r = await require('./dq.js').embedAll(home); console.log(`question index: ${r.questions} questions for ${r.sections} sections`); } catch (e) { console.error('build-dq failed: ' + e.message); process.exitCode = 1; }
    } else if (mode === 'build-mk') { // build the Makillez map from Makillez-master-docs (MK_DOCS overrides the folder); about a minute
      const mk = require('./mk.js'), list = arg === 'all' ? Object.keys(mk.PROJECTS) : [mk.PROJECTS[arg] ? arg : 'makillez'];   // node brain.js build-mk [esg|aipo|tech|all]
      for (const [i, project] of list.entries()) {
        if (list.length > 1) console.log(`[${i + 1}/${list.length}] ${mk.PROJECTS[project].name}`);
        try {
          const r = await mk.build(home, { project, log: (m) => console.log(m), progress: (n, total) => { if (n === total || n % 320 === 0) console.log(`meaning numbers ${n}/${total}`); } });
          console.log(`map built in ${(r.ms / 1000).toFixed(1)} s: ${r.code} code neurons, ${r.docs} doc neurons from ${r.files} files, ${r.synapses} code synapses, ${r.vectors} meaning numbers, graph @${r.commit.slice(0, 8)}`);
          console.log(`old map merged in: ${r.merged.kept} learned links kept, ${r.merged.dropped} dropped (neuron gone or faded), ${r.merged.sessions} recent session(s) carried over`);
        } catch (e) { console.log('map not built: ' + e.message); process.exitCode = 1; } finally { try { if (project === 'makillez') fs.rmSync(path.join(dataDir(home), 'mk.lock'), { force: true }); } catch { /* none */ } }
      }
    } else if (mode === 'touched') { // PostToolUse hook (see settings.json): learn from a file that was just opened or edited
      touchedHook();
    } else if (mode === 'learn-show') { // the strongest learned links, with their age-faded weight
      const r = require('./mk.js').learnShow(home, Number(arg) || 15);
      console.log(`${r.total} learned link(s)`); for (const l of r.lines) console.log(l);
    } else if (mode === 'learn-reset') { // forget everything the map learned from use (the docs and graph are untouched)
      console.log(`forgot ${require('./mk.js').learnReset(home)} learned link(s)`);
    } else if (mode === 'mk-status' && arg === 'all') { // one line per project: node brain.js mk-status all
      const mk = require('./mk.js');
      for (const p of Object.keys(mk.PROJECTS)) {
        const s = mk.status(home, p);
        console.log(`${mk.PROJECTS[p].name.padEnd(9)} ${s.nDoc ? `${s.nCode} code + ${s.nDoc} doc neurons, built ${new Date(s.built).toISOString().slice(0, 16).replace('T', ' ')}${s.mapCommit ? ', @' + s.mapCommit.slice(0, 8) : ''}${s.stale ? '   STALE' : '   ok'}` : 'no map (run: node brain.js build-mk ' + p + ')'}`);
      }
    } else if (mode === 'mk-status') { // is the map as new as the graph and the docs?
      const s = require('./mk.js').status(home);
      console.log(`map:   ${s.mapCommit ? s.mapCommit.slice(0, 8) : 'none'}${s.built ? ' built ' + new Date(s.built).toISOString().slice(0, 16).replace('T', ' ') : ''}${s.nCode ? `, ${s.nCode} code + ${s.nDoc} doc neurons, ${s.learned} learned link(s)` : ''}`);
      console.log(`graph: ${s.graphCommit ? s.graphCommit.slice(0, 8) : 'unknown'} (graphify-out/graph.json)   .last_update_commit: ${s.lastUpdateCommit ? s.lastUpdateCommit.slice(0, 8) : 'none'}`);
      const same = s.mapCommit && s.graphCommit && s.mapCommit === s.graphCommit;
      console.log(s.stale || !same ? 'STALE: run  node --max-old-space-size=4096 brain.js build-mk' : 'OK: the map matches the graph and the docs');
      if (s.graphCommit && s.lastUpdateCommit && s.graphCommit !== s.lastUpdateCommit) console.log('NOTE: graph.json commit differs from .last_update_commit (see the Stamp check in /Makillez-update-docs)');
    } else if (mode === 'mk') { // show the Makillez map for a text: node brain.js mk "text" [--no-meaning]
      const mk = require('./mk.js');
      let pv = null;
      if (!process.argv.includes('--no-meaning')) { const embed = await getEmbedder(false); if (embed) [pv] = await embed([(arg || '').slice(0, 500)]); }
      const pi = process.argv.indexOf('--project'), t0 = Date.now(), res = mk.search(home, arg || '', { pv, project: pi >= 0 ? process.argv[pi + 1] : 'makillez' });
      console.log(mk.format(res) || '(no map for this text)');
      console.log(`[${Date.now() - t0} ms${res ? `, ${res.seeds} seeds, best ${res.best.toFixed(2)}` : ''}]`);
    } else if (mode === 'query') {
      console.log(format(await search(home, arg || '')));
    } else if (mode === 'forget') {
      if (!arg) console.log('usage: node brain.js forget "<text>"');
      else console.log(`forgot ${history.forget(home, arg)} prompt(s)`);
    } else if (mode === 'hook') {
      await hook();
    } else {
      console.log('usage: node brain.js build [--require-embeddings] | query "<text>" | hook | refresh | forget "<text>" | graph | related "<word>" | check | build-mk | mk "<text>" | mk-status | learn-show | learn-reset | touched');
    }
  })().then(() => process.exit()); // onnx keeps threads alive; exit with the code set above
}
