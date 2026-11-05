// Self-test for graphdb.js (the keyword graph). Uses a temporary home. Prints "ALL PASSED" or throws.
const assert = require('assert');
const fs = require('fs');
const { tempHome, runBrain } = require('./test-util.js');
const history = require('./history.js');
const { tokens } = require('./rules.js');
const gdb = require('./graphdb.js');

const home = tempHome('graph-test-');
const add = (p) => history.append(home, p, 'X');
add('fix the docker compose build for the webapp container');
add('docker compose build fails on the vessels container');
add('write the release notes for the webapp container');

// 1: first sync builds the graph; words are stemmed and short words dropped
const r1 = gdb.sync(home, tokens);
assert.strictEqual(r1.prompts, 3);
assert.ok(r1.rebuilt && r1.keywords > 0 && r1.edges > 0, JSON.stringify(r1));

// 2: same prompts again = no rebuild
assert.strictEqual(gdb.sync(home, tokens).rebuilt, false, 'rebuilt with no change');

// 3: related() shows linked words, strongest first, and the prompts that hold the word
const rel = gdb.related(home, 'docker', tokens);
assert.strictEqual(rel.df, 2, 'docker is in 2 prompts');
assert.strictEqual(rel.prompts.length, 2);
const links = Object.fromEntries(rel.neighbours.map((n) => [n.word, n.w]));
assert.strictEqual(links.compose, 2, 'docker--compose should share 2 prompts: ' + JSON.stringify(links));
assert.ok(links.webapp === 1, 'docker--webapp should share 1 prompt');
assert.strictEqual(gdb.related(home, 'zzzunknown', tokens).df, 0, 'unknown word');

// 4: top() lists the strongest pairs first
const t = gdb.top(home, 3);
assert.ok(t.length && t[0].w >= t[t.length - 1].w && t[0].w >= 2, JSON.stringify(t));

// 5: a new prompt triggers a rebuild; a log-like number never becomes a keyword
add('docker 20261102123456 error 0x7fff12345678 in the webapp container');
const r5 = gdb.sync(home, tokens);
assert.ok(r5.rebuilt && r5.prompts === 4, JSON.stringify(r5));
assert.strictEqual(gdb.related(home, '20261102123456', tokens).df, 0, 'number kept as keyword');

// 6: deleting the file is safe: it is rebuilt from the JSONL
fs.rmSync(gdb.dbFile(home), { force: true });
assert.strictEqual(gdb.sync(home, tokens).prompts, 4, 'not rebuilt from the JSONL');

// 7: the CLI modes run on the same home
const cli = runBrain(home, ['related', 'docker']);
assert.ok(/docker: in 3 prompt/.test(cli.stdout), cli.stdout + cli.stderr);
assert.ok(/--/.test(runBrain(home, ['graph']).stdout), 'graph mode printed no pairs');

// 8: lexical() finds earlier prompts by exact rare words (an id-like word alone, or 2 shared rare words), never the same prompt, nothing for common words
add('open the file changelog-draft.md and fix the heading');
add('please rename the vessels container volume');
gdb.sync(home, tokens);
const lx = gdb.lexical(home, 'where is changelog-draft.md stored', tokens, { exclude: 'where is changelog-draft.md stored' });
assert.ok(lx.length === 1 && /changelog-draft/.test(lx[0].p), 'id-like word: ' + JSON.stringify(lx));
assert.strictEqual(gdb.lexical(home, 'open the file changelog-draft.md and fix the heading', tokens, { exclude: 'open the file changelog-draft.md and fix the heading' }).length, 0, 'same prompt must be excluded');
assert.ok(gdb.lexical(home, 'the vessels container volume is full', tokens).length >= 1, 'two shared rare words');
assert.strictEqual(gdb.lexical(home, 'what is the capital of France', tokens).length, 0, 'unrelated prompt stays quiet');
assert.deepStrictEqual(gdb.lexical(tempHome('graph-empty-'), 'changelog-draft.md', tokens), [], 'no graph.db: empty, and none is created');

// 9: a rare id inside a long prompt (more than 25 other words) is still found, and an old graph.db without the rare-words table is rebuilt
const filler = Array.from({ length: 60 }, (_, i) => `filler${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i / 26) | 0))}word`).join(' ');
add(`${filler} the ticket is ZQX-4417-report.log somewhere`);
assert.ok(gdb.sync(home, tokens).rebuilt, 'new prompt should rebuild');
const lx2 = gdb.lexical(home, 'find zqx-4417-report.log please', tokens);
assert.ok(lx2.length === 1 && /ZQX-4417/.test(lx2[0].p), 'rare id in a long prompt not found: ' + JSON.stringify(lx2));
const { DatabaseSync } = require('node:sqlite');
const raw = new DatabaseSync(gdb.dbFile(home)); raw.exec('PRAGMA user_version = 0; DELETE FROM pw;'); raw.close();
assert.strictEqual(gdb.lexical(home, 'find zqx-4417-report.log please', tokens).length, 0, 'sanity: table emptied');
assert.ok(gdb.sync(home, tokens).rebuilt, 'old-version graph.db was not rebuilt');
assert.strictEqual(gdb.lexical(home, 'find zqx-4417-report.log please', tokens).length, 1, 'rare words not restored after rebuild');
// a long id-like word seen in 3 prompts is too common to count alone
add('see the file shared-config.yaml for the options');
add('edit shared-config.yaml again and save');
add('copy shared-config.yaml to the server');
gdb.sync(home, tokens);
assert.strictEqual(gdb.lexical(home, 'where is shared-config.yaml', tokens).length, 0, 'id-like word in 3 prompts must not count alone');

console.log('ALL PASSED');
