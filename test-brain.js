// Self-test for brain.js. Uses a fake ~/.claude in a temp folder. Prints "ALL PASSED" or throws.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { brainPath, tempHome, runBrain } = require('./test-util.js');
const brain = require(brainPath);

const home = tempHome('brain-test-');
const w = (rel, text) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

w('CLAUDE.md', '# Codex\n- Never commit or push anything. The user does.\n');
w('preferences.md', [
  '# Rules', '## How to work',
  '- Always build web apps with `docker compose build` and pass the Pintura key from `$env:PINTURA_LICENSE_KEY`.',
  '- Run long jobs with `run-watched.ps1` in the background.',
  '- The Seq key is AbCdEf0123456789AbCdEf0123456789 keep it.',
  '## Style',
  '- Use `Any()` to check for items in C# code.',
  '- The user runs git commit, git push and git merge by hand. Claude never does.', ''].join('\n'));
w('projects/p1/memory/MEMORY.md', '- [docker-note](docker-note.md) - index line that must be ignored\n');
w('projects/p1/memory/docker-note.md', '---\nname: docker-note\ndescription: docker service names\nmetadata:\n  type: feedback\n---\n\nUse `purchaseorder-api` as the real service name. See [[facts-note]].\n');
w('projects/p1/memory/facts-note.md', '---\nname: facts-note\ndescription: facts\nmetadata:\n  type: user\n---\n\nVerify identifiers against the source of truth before answering.\n');

const g = brain.build(home);
// 1: parse count (CLAUDE.md 1 + prefs 4 + 2 notes; MEMORY.md ignored; the secret line skipped)
assert.strictEqual(g.nodes.length, 7, 'node count ' + g.nodes.length);
assert.ok(!JSON.stringify(g).includes('AbCdEf0123456789'), 'secret leaked into graph');
assert.ok(fs.existsSync(path.join(home, 'brain', 'graph.json')), 'graph.json not written');

const texts = (r) => r.map((n) => n.text).join('\n');
// 2: a matching prompt finds the docker rule
assert.ok(texts(brain.query(home, 'how do I docker compose build the web app')).includes('Pintura'), 'docker rule missing');
// 3: an unrelated prompt returns nothing
assert.strictEqual(brain.query(home, 'what is the weather like today in Paris').length, 0, 'unrelated prompt returned rules');
// 4: spreading activation: the linked note comes in as a neighbour
const r4 = texts(brain.query(home, 'what is the purchaseorder-api service'));
assert.ok(r4.includes('purchaseorder-api') && r4.includes('source of truth'), 'neighbour missing: ' + r4);
// 5: CLAUDE.md nodes are never injected (already in context)
assert.ok(!texts(brain.query(home, 'never commit or push anything')).includes('Never commit'), 'CLAUDE.md node injected');

// 6: hook output and fail-open
const hook = (input) => runBrain(home, ['hook'], input);
const h1 = hook(JSON.stringify({ prompt: 'how do I docker compose build the web app' }));
const out = JSON.parse(h1.stdout);
assert.strictEqual(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
assert.ok(out.hookSpecificOutput.additionalContext.includes('Pintura'), 'hook context missing rule');
assert.ok(out.hookSpecificOutput.additionalContext.length <= 2600, 'hook context too long');
const h2 = hook('not json');
assert.ok(h2.status === 0 && h2.stdout === '', 'hook must fail open on bad input');
const h3 = hook(JSON.stringify({ prompt: '/brain-upgrade docker compose build' }));
assert.ok(h3.status === 0 && h3.stdout === '', 'slash commands must be skipped');
const h4 = hook(JSON.stringify({ prompt: 'docker build' }));
assert.ok(h4.status === 0 && h4.stdout === '', 'short prompts must be skipped');

// 7: thesaurus: a different word with the same meaning finds the rule; an empty thesaurus does not
const ship = 'please ship the change to the remote now';
assert.ok(texts(brain.query(home, ship)).includes('git commit'), 'thesaurus missed: ' + texts(brain.query(home, ship)));
assert.strictEqual(brain.query(home, ship, { thesaurus: [] }).length, 0, 'found without thesaurus: it was a word match');

// 8..12: meaning (embeddings), tested with a fake embedder so the test needs no model
const dims = (t) => (/zebra/.test(t) || /Pintura/.test(t) ? [1, 0, 0, 0] : /weather/.test(t) ? [0, 0, 0, 1] : [0, 0, 1, 0]);
const fake = async (texts) => texts.map(dims);
let finished = false; // if Node runs out of work before the async cases end, that is a failure, not a pass
process.on('exit', () => { if (!finished) { console.error('TEST DID NOT FINISH'); process.exitCode = 1; } });
(async () => {
  const g2 = brain.build(home);
  const e = await brain.embedNodes(home, g2, fake, 'fake-test');
  assert.strictEqual(e.total, g2.nodes.filter((n) => !n.inContext).length, 'not every injectable node got a vector');
  const o = { embed: fake, model: 'fake-test' };
  // 8: no shared word and no thesaurus match, but the meaning matches
  const zebra = 'zebra giraffe habitat elephants';
  assert.strictEqual(brain.query(home, zebra).length, 0, 'words alone should find nothing');
  assert.ok(texts(await brain.search(home, zebra, o)).includes('Pintura'), 'meaning match missing');
  // 9: an unrelated prompt still returns nothing
  assert.strictEqual((await brain.search(home, 'what is the weather like in Paris', o)).length, 0, 'unrelated prompt returned rules');
  // 10: a broken embedder falls back to words; a stuck one is cut off by the time limit
  const r10 = await brain.search(home, 'how do I docker compose build the web app', { ...o, embed: async () => { throw new Error('boom'); } });
  assert.ok(texts(r10).includes('Pintura'), 'no fallback to words');
  const t0 = Date.now();
  const r11 = await brain.search(home, 'how do I docker compose build the web app', { ...o, embed: () => new Promise(() => {}), timeoutMs: 300 });
  assert.ok(Date.now() - t0 < 1500 && texts(r11).includes('Pintura'), 'stuck embedder not cut off');
  // 12: vectors of another model are ignored (the hook must not load the real model for them)
  const t1 = Date.now();
  const h5 = hook(JSON.stringify({ prompt: 'how do I docker compose build the web app' }));
  assert.ok(h5.status === 0 && JSON.parse(h5.stdout).hookSpecificOutput.additionalContext.includes('Pintura') && Date.now() - t1 < 3000, 'hook with foreign vectors');

  // 13: a broken graph.json (crash during a write) is rebuilt, not fatal; no temp file is left; a vector of the wrong size is ignored
  fs.writeFileSync(path.join(home, 'brain', 'graph.json'), '{"nodes":[{"id":');
  assert.ok(texts(brain.query(home, 'how do I docker compose build the web app')).includes('Pintura'), 'broken graph.json was not rebuilt');
  assert.ok(texts(await brain.search(home, 'how do I docker compose build the web app', o)).includes('Pintura'), 'search after broken graph.json');
  assert.ok(!fs.readdirSync(path.join(home, 'brain')).some((f) => f.endsWith('.tmp')), 'temp file left behind');
  const short = async (t) => t.map(() => [1, 0]);
  const shortOpts = { embed: short, model: 'fake-test' };
  assert.ok(texts(await brain.search(home, 'zebra giraffe habitat elephants', shortOpts)).length === 0, 'wrong-size vectors must not match');

  // 14: a graph.json from an older word-cutting version is rebuilt even when no source file changed
  const gf = path.join(home, 'brain', 'graph.json'), cur = JSON.parse(fs.readFileSync(gf, 'utf8'));
  cur.graph.version = 1; cur.nodes.forEach((n) => { n.kw = ['poison']; }); fs.writeFileSync(gf, JSON.stringify(cur));
  assert.ok(texts(brain.query(home, 'how do I docker compose build the web app')).includes('Pintura'), 'old-version graph was reused');
  assert.strictEqual(JSON.parse(fs.readFileSync(gf, 'utf8')).graph.version, g2.graph.version, 'graph not rewritten with the current version');

  // 15: note headers: "valid-until" in the past drops the note, "supersedes" drops the older note, a future date keeps it and the graph is rebuilt after that day
  const h2 = tempHome('brain-test-expiry-'), w2 = (rel, text) => { const p = path.join(h2, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  const note = (name, extra, body) => w2(`projects/p1/memory/${name}.md`, `---\nname: ${name}\ndescription: d\n${extra}metadata:\n  type: project\n---\n\n${body}\n`);
  note('old-port', '', 'The staging server listens on port 8081 for every request.');
  note('new-port', 'supersedes: old-port\n', 'The staging server listens on port 9090 for every request.');
  note('gone-note', 'valid-until: 2020-01-01\n', 'The temporary freeze on deployments ends soon enough.');
  note('later-note', 'valid-until: 2999-01-01\n', 'The release window opens every second Thursday afternoon.');
  note('dead-new-port', 'supersedes: kept-port\nvalid-until: 2020-01-01\n', 'The legacy gateway listens on port 7070 for every call.');
  note('kept-port', '', 'The reporting gateway listens on port 6060 for every call.');
  note('typo-date', 'valid-until: 31/12/2030\n', 'The archive server keeps copies for ninety days exactly.');
  note('bad-day', 'valid-until: 2026-02-31\n', 'The backup job runs on the third floor server nightly.');
  note('ghost-ref', 'supersedes: no-such-note\n', 'The mail relay uses the internal hostname for every send.');
  const g3 = brain.build(h2), all = g3.nodes.map((n) => n.text).join('\n');
  assert.ok(all.includes('9090') && !all.includes('8081'), 'superseded note kept: ' + all);
  assert.ok(!all.includes('temporary freeze'), 'expired note kept');
  const warn = g3.graph.warnings.join('\n');
  assert.ok(/typo-date\.md: valid-until "31\/12\/2030"/.test(warn), 'no warning for a wrong date form: ' + warn);
  assert.ok(/bad-day\.md: valid-until "2026-02-31"/.test(warn), 'no warning for 31 February: ' + warn);
  assert.ok(/ghost-ref\.md: supersedes "no-such-note"/.test(warn), 'no warning for an unknown supersedes name: ' + warn);
  assert.ok(/gone-note\.md: dropped/.test(warn), 'no notice for an expired note');
  assert.ok(all.includes('archive server') && all.includes('backup job'), 'a bad date must leave the note active');
  assert.ok(!/later-note\.md|memory\/new-port\.md|memory\/old-port\.md|kept-port\.md/.test(warn), 'false warning: ' + warn);
  const chk = runBrain(h2, ['check']);
  assert.ok(chk.status === 1 && /WARNING .*typo-date/.test(chk.stdout), 'check mode: ' + chk.stdout + chk.stderr);
  assert.ok(all.includes('6060') && !all.includes('7070'), 'an expired note must not replace another note: ' + all);
  assert.ok(all.includes('release window'), 'future-dated note dropped');
  assert.ok(g3.graph.expires > Date.now(), 'expires not set: ' + g3.graph.expires);
  const g4 = JSON.parse(fs.readFileSync(path.join(h2, 'brain', 'graph.json'), 'utf8')); g4.graph.expires = Date.now() - 1000; fs.writeFileSync(path.join(h2, 'brain', 'graph.json'), JSON.stringify(g4));
  brain.query(h2, 'staging server port request');
  assert.ok(JSON.parse(fs.readFileSync(path.join(h2, 'brain', 'graph.json'), 'utf8')).graph.expires > Date.now(), 'graph past its expiry date was not rebuilt');

  // 16: searchFull puts exact-word history hits into hist, with or without the model, never more than 2, never the prompt itself
  const hist = require(path.join(path.dirname(brainPath), 'history.js')), gdb = require(path.join(path.dirname(brainPath), 'graphdb.js'));
  hist.append(home, 'open the file changelog-draft.md and fix the heading', 'X');
  hist.append(home, 'rename the changelog-draft.md file in the docs folder', 'X');
  gdb.sync(home, brain.tokens);
  const ask = 'where is changelog-draft.md stored';
  for (const opts of [o, { model: 'no-such-model' }]) {
    const f = await brain.searchFull(home, ask, opts);
    assert.strictEqual(f.hist.length, 2, 'history cap: ' + JSON.stringify(f.hist));
    assert.ok(f.hist.every((x) => /changelog-draft/.test(x.p)), 'wrong history hit');
  }
  assert.strictEqual((await brain.searchFull(home, 'open the file changelog-draft.md and fix the heading', o)).hist.some((x) => x.p === 'open the file changelog-draft.md and fix the heading'), false, 'the prompt itself came back');
  assert.strictEqual((await brain.searchFull(home, 'what is the weather like in Paris', o)).hist.length, 0, 'unrelated prompt got history');

  finished = true;
  console.log('ALL PASSED');
})().catch((err) => { console.error(err); process.exit(1); });
