// Self-test for history.js and its brain.js hook wiring. Uses only temporary homes.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { brainPath, tempHome, runBrain } = require('./test-util.js');
const historyPath = path.join(__dirname, 'history.js');
const history = require(historyPath);
const home = (prefix = 'history-test-') => tempHome(prefix);
const histDir = (h) => path.join(h, 'brain', 'history');
const vecFile = (h) => path.join(histDir(h), 'vectors.json');
const readRows = (h) => history.load(h);
const runHook = (h, prompt) => runBrain(h, ['hook'], JSON.stringify({ prompt, cwd: 'X' }));
const runForget = (h, text) => runBrain(h, ['forget', text]);

let finished = false;
process.on('exit', () => {
  if (!finished) { console.error('TEST DID NOT FINISH'); process.exitCode = 1; }
});

(async () => {
  // 1: redact secrets while preserving ordinary identifiers, URLs, and paths.
  // The fake secrets are built from pieces on purpose: the settings export drops any file that holds secret-like text.
  const j = (...parts) => parts.join('');
  const hidden = [
    j('use key=', 'AbCdEf0123456789', 'AbCdEf0123456789', ' for seq'),
    j('my token: ', 'gh', 'p_', 'ABCdef1234567890', 'ABCdef1234567890'),
    j('Authorization: Bear', 'er abc.def.ghi-12345'),
    j('s', 'k-proj-', 'ABCDEF1234567890', 'abcdef1234567890'),
    j('jwt ey', 'JhbGciOiJIUzI1NiJ9.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0.', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'),
    j('pass PINTURA_LICENSE_', 'KEY=xKz9Q1/', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd.QwEr now'), // made-up key, same shape as a license key
    j('the sec', 'ret is Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm9N please keep'),
    j('pass', 'word = hunter2', 'hunter2'),
  ];
  for (const input of hidden) {
    const out = history.redact(input);
    assert.ok(out.includes('[hidden]'), `redact should hide secret: ${input}`);
    const secret = input.includes('xKz9Q1') ? ['xKz9Q1', 'QwEr'] : input.match(/(?:key=|token: |Bearer |jwt |secret is |password = )(\S+)/i)?.[1];
    if (secret) for (const part of (Array.isArray(secret) ? secret : [secret])) assert.ok(!out.includes(part), `redact leaked ${part}: ${out}`);
    const longest = input.split(/\s+/).sort((a, b) => b.length - a.length)[0]; // the secret is the longest word in each sample
    assert.ok(!out.includes(longest.slice(-12)), 'redact leaked the end of a secret');
  }
  const kept = [
    'check purchaseorder-api and SFU-3248 in docker-compose.yml',
    'see https://dev.azure.com/metizoftas/Makillez/_git/Makillez/pullrequest/4121',
    'explain the difference between a mutex and a semaphore please',
    'src/Services/PurchaseOrder/PurchaseOrder.Database.SqlServer/Queries/PurchaseOrderLinesQueries.cs',
    'is the license key a good thing to ask for',
    'fix C:\\Users\\VanNhatThanh\\source\\repos\\Makillez-master-docs\\technical-docs\\for-dev\\19-known-unfixed-bugs.md',
  ];
  for (const input of kept) assert.strictEqual(history.redact(input), input, `redact changed ordinary text: ${input}`);

  // 2: harness messages are skipped; user prompts are retained.
  for (const p of ['<task-notification>\n<task-id>x</task-id>', '<system-reminder>hi', '[SYSTEM NOTIFICATION - NOT USER INPUT]', '<command-name>/compact</command-name>', 'Below is a conversation log from a Claude Code coding session. Create a summary', 'This session is being continued from a previous conversation that ran out of context.']) assert.strictEqual(history.isAutomated(p), true, `automated message not detected: ${p}`);
  for (const p of ['please push the build to the server', '<div> why does this render twice in angular']) assert.strictEqual(history.isAutomated(p), false, `user prompt misclassified: ${p}`);

  // 3: append, load, deduplication, redaction, and malformed lines.
  const h = home();
  assert.strictEqual(history.append(h, 'first useful prompt about a build', 'C:/repo'), true, 'first append failed');
  assert.strictEqual(history.append(h, 'second useful prompt about a query', 'D:/repo'), true, 'second append failed');
  let rows = readRows(h);
  assert.strictEqual(rows.length, 2, 'load should return two entries');
  assert.ok(rows[0].t && !Number.isNaN(Date.parse(rows[0].t)), 'entry t should be ISO time');
  assert.strictEqual(rows[0].p, 'first useful prompt about a build', 'oldest prompt should load first');
  assert.strictEqual(rows[0].cwd, 'C:/repo', 'cwd not loaded');
  assert.ok(rows[0].id, 'entry id missing');
  assert.strictEqual(rows[1].p, 'second useful prompt about a query', 'newest prompt not loaded');
  assert.strictEqual(history.append(h, rows[1].p, 'D:/repo'), false, 'duplicate last prompt should return false');
  assert.strictEqual(readRows(h).length, 2, 'duplicate append added an entry');
  assert.strictEqual(history.append(h, '', 'X'), false, 'empty prompt should be rejected');
  assert.strictEqual(history.append(h, '   ', 'X'), false, 'whitespace prompt should be rejected');
  const gh = j('gh', 'p_', 'ABCdef1234567890', 'ABCdef1234567890');
  assert.strictEqual(history.append(h, `my token: ${gh}`, 'X'), true, 'secret prompt append failed');
  const monthFile = path.join(histDir(h), fs.readdirSync(histDir(h)).find((f) => f.endsWith('.jsonl')));
  const diskText = fs.readFileSync(monthFile, 'utf8');
  assert.ok(diskText.includes('[hidden]') && !diskText.includes(gh), 'secret was not masked on disk');
  fs.appendFileSync(monthFile, 'this is garbage\n{"p":"half written"');
  assert.strictEqual(readRows(h).length, 3, 'load should skip malformed and incomplete lines');
  assert.strictEqual(history.append(h, 'later prompt still gets appended correctly', 'Y'), true, 'append failed after malformed lines');
  assert.strictEqual(readRows(h).length, 4, 'later append missing after malformed lines');
  assert.strictEqual(history.append(h, 'pasted log line '.repeat(2000), 'X'), true, 'long prompt not saved');
  const saved = readRows(h).pop().p;
  assert.ok(saved.length < 8100 && saved.endsWith('...[cut]'), `long prompt not cut: ${saved.length}`);

  // 4: embeddings, search gates, model and dimension checks, and refresh detection.
  const he = home();
  const prompts = ['zebra giraffe habitat question', 'what is the weather in paris', 'unrelated docker thing'];
  for (const p of prompts) assert.strictEqual(history.append(he, p, 'X'), true, `could not append ${p}`);
  const dims = (t) => /zebra/.test(t) ? [1, 0, 0, 0] : /weather/.test(t) ? [0, 0, 0, 1] : [0, 0, 1, 0];
  const fake = async (texts) => texts.map(dims);
  assert.deepStrictEqual(await history.embedHistory(he, fake, 'fake-test'), { total: 3, added: 3 }, 'initial embed result incorrect');
  const beforeVectors = fs.readFileSync(vecFile(he), 'utf8'), beforeStat = fs.statSync(vecFile(he)).mtimeMs;
  assert.deepStrictEqual(await history.embedHistory(he, fake, 'fake-test'), { total: 3, added: 0 }, 'repeat embed result incorrect');
  assert.strictEqual(fs.readFileSync(vecFile(he), 'utf8'), beforeVectors, 'repeat embedding rewrote vectors.json content');
  assert.strictEqual(fs.statSync(vecFile(he)).mtimeMs, beforeStat, 'repeat embedding rewrote vectors.json');
  assert.deepStrictEqual(history.searchHistory(he, [1, 0, 0, 0], 'fake-test'), [], 'identical prompt vector should be suppressed');
  assert.ok(history.searchHistory(he, [0.8, 0.6, 0, 0], 'fake-test').some((e) => e.p === prompts[0]), 'nearby zebra vector should match');
  assert.ok(!history.searchHistory(he, [0.8, 0.6, 0, 0], 'fake-test', { exclude: prompts[0] }).some((e) => e.p === prompts[0]), 'exclude did not remove exact text');
  assert.deepStrictEqual(history.searchHistory(he, [0.8, 0.6, 0, 0], 'different-model'), [], 'model mismatch should return no results');
  assert.deepStrictEqual(history.searchHistory(he, [1, 0], 'fake-test'), [], 'wrong vector length should return no results');
  const missing = home();
  assert.deepStrictEqual(history.searchHistory(missing, [1, 0, 0, 0], 'fake-test'), [], 'missing vectors should return no results');
  assert.strictEqual(history.append(he, 'another newly saved prompt', 'X'), true, 'extra append failed');
  assert.strictEqual(history.hasUnembedded(he, 'fake-test'), true, 'new prompt should need embedding');
  await history.embedHistory(he, fake, 'fake-test');
  assert.strictEqual(history.hasUnembedded(he, 'fake-test'), false, 'embedded prompts should be current');

  // 5: forget removes matching rows and their vectors, case-insensitively.
  const zebraId = readRows(he).find((e) => /zebra/i.test(e.p)).id;
  assert.strictEqual(history.forget(he, 'ZEBRA'), 1, 'forget should remove one zebra row');
  rows = readRows(he);
  assert.ok(!rows.some((e) => /zebra/i.test(e.p)), 'forgotten row remains in history');
  assert.ok(rows.some((e) => /weather/.test(e.p)) && rows.some((e) => /docker/.test(e.p)), 'forget removed unrelated rows');
  const vectorData = JSON.parse(fs.readFileSync(vecFile(he), 'utf8'));
  assert.ok(!Object.hasOwn(vectorData.vec, zebraId), 'forgotten id remains in vectors');
  assert.strictEqual(history.forget(he, '   '), 0, 'blank forget should return zero');
  assert.strictEqual(history.forget(he, 'no matching entry here'), 0, 'unmatched forget should return zero');

  // 6: eight simultaneous writers must leave eight intact lines and no temp files.
  const hp = home();
  const workers = Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
    const n = i + 1;
    const code = `require(${JSON.stringify(historyPath)}).append(${JSON.stringify(hp)}, ${JSON.stringify(`parallel prompt number ${n} with enough words`)}, 'X')`;
    const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (status) => status === 0 ? resolve() : reject(new Error(`parallel child ${n} exited ${status}`)));
  }));
  await Promise.all(workers);
  rows = readRows(hp);
  assert.strictEqual(rows.length, 8, 'parallel writers lost entries');
  assert.strictEqual(new Set(rows.map((e) => e.p)).size, 8, 'parallel writer prompts were duplicated or lost');
  assert.ok(!fs.readdirSync(histDir(hp)).some((f) => f.endsWith('.tmp')), 'parallel writers left temp files');

  // 7: history formatting and prompt truncation.
  assert.strictEqual(history.formatHistory([]), '', 'empty history format should be empty');
  const one = history.formatHistory([{ t: '2026-11-02T06:00:00.000Z', p: 'a related prompt' }]);
  assert.ok(one.startsWith('Earlier prompts of yours that look related:\n'), 'history heading missing');
  assert.ok(one.split('\n')[1].startsWith('- [you asked 2026-11-02] '), 'history date line missing');
  const long = history.formatHistory([{ t: '2026-11-02T06:00:00.000Z', p: 'x'.repeat(300) }]).split('\n')[1];
  assert.strictEqual(long.slice(long.indexOf('] ') + 2), 'x'.repeat(200) + '...', 'long history prompt was not truncated at 200 chars');

  // 8: hook wiring skips automated, slash, and short prompts, then stores a user prompt.
  const hh = home('history-hook-test-');
  const prefSource = path.join(os.homedir(), '.claude', 'preferences.md');
  assert.ok(fs.existsSync(prefSource), 'source preferences.md is unavailable for temp hook home');
  fs.copyFileSync(prefSource, path.join(hh, 'preferences.md'));
  const automated = runHook(hh, '<task-notification>\n<task-id>x</task-id> finished and has a long body here');
  assert.strictEqual(automated.status, 0, 'automated hook exit status');
  assert.strictEqual(fs.existsSync(histDir(hh)), false, 'automated hook created history');
  const normal = runHook(hh, 'please show a progress bar while the build runs now');
  assert.strictEqual(normal.status, 0, 'user hook exit status');
  let hookRows = readRows(hh);
  assert.strictEqual(hookRows.length, 1, 'user hook should save exactly one prompt');
  assert.strictEqual(hookRows[0].cwd, 'X', 'hook did not save cwd');
  for (const prompt of ['/compact please do it now ok', 'too short']) {
    const result = runHook(hh, prompt);
    assert.strictEqual(result.status, 0, `skipped hook exit status for ${prompt}`);
  }
  assert.strictEqual(readRows(hh).length, 1, 'slash or short hook prompt was saved');
  const forgot = runForget(hh, 'progress bar');
  assert.strictEqual(forgot.status, 0, 'forget command exit status');
  assert.ok(forgot.stdout.includes('forgot 1 prompt(s)'), `forget command output incorrect: ${forgot.stdout}`);

  // 9: sharing between machines.
  const previousMachine = process.env.BRAIN_MACHINE;
  try {
    process.env.BRAIN_MACHINE = 'My PC_01!';
    assert.strictEqual(history.machineId(), 'my-pc-01', 'machine id should normalize the configured name');
    delete process.env.BRAIN_MACHINE;
    assert.match(history.machineId(), /^[a-z0-9-]+$/, 'hostname machine id should be non-empty and normalized');

    const shared = home('history-shared-test-');
    process.env.BRAIN_MACHINE = 'pc-a';
    assert.strictEqual(history.append(shared, 'prompt from machine a number one', 'X'), true);
    await new Promise((r) => setTimeout(r, 5));
    process.env.BRAIN_MACHINE = 'pc-b';
    assert.strictEqual(history.append(shared, 'prompt from machine b number two', 'X'), true);
    await new Promise((r) => setTimeout(r, 5));
    process.env.BRAIN_MACHINE = 'pc-a';
    assert.strictEqual(history.append(shared, 'prompt from machine a number three', 'X'), true);
    const sharedFiles = fs.readdirSync(histDir(shared)).filter((f) => f.endsWith('.jsonl')).sort();
    assert.strictEqual(sharedFiles.length, 2, 'two machines should create exactly two month files');
    assert.ok(sharedFiles.some((f) => /^\d{4}-\d{2}\.pc-a\.jsonl$/.test(f)), 'pc-a month file missing or misnamed');
    assert.ok(sharedFiles.some((f) => /^\d{4}-\d{2}\.pc-b\.jsonl$/.test(f)), 'pc-b month file missing or misnamed');
    rows = readRows(shared);
    assert.strictEqual(rows.length, 3, 'merged history should contain all three machine prompts');
    assert.deepStrictEqual(rows.map((e) => e.p), [
      'prompt from machine a number one',
      'prompt from machine b number two',
      'prompt from machine a number three',
    ], 'merged history should be in time order');
    const fileA = path.join(histDir(shared), sharedFiles.find((f) => f.endsWith('.pc-a.jsonl')));
    const fileB = path.join(histDir(shared), sharedFiles.find((f) => f.endsWith('.pc-b.jsonl')));
    const contentA = fs.readFileSync(fileA, 'utf8');
    const contentBBefore = fs.readFileSync(fileB, 'utf8');
    assert.strictEqual(history.forget(shared, 'machine b'), 1, 'forget should remove the matching row across machines');
    assert.strictEqual(fs.readFileSync(fileA, 'utf8'), contentA, 'forget should leave pc-a file unchanged');
    assert.strictEqual(fs.readFileSync(fileB, 'utf8').split(/\r?\n/).filter(Boolean).length, contentBBefore.split(/\r?\n/).filter(Boolean).length - 1, 'forget should remove a row from pc-b file');

    const legacy = home('history-legacy-test-');
    const legacyDir = histDir(legacy);
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyFile = path.join(legacyDir, '2020-01.jsonl');
    const legacyText = `${JSON.stringify({ t: '2020-01-05T00:00:00.000Z', p: 'old legacy prompt' })}\n`;
    fs.writeFileSync(legacyFile, legacyText);
    assert.strictEqual(readRows(legacy)[0].p, 'old legacy prompt', 'legacy month file should load');
    process.env.BRAIN_MACHINE = 'pc-a';
    assert.strictEqual(history.append(legacy, 'new prompt from current machine', 'X'), true, 'append beside legacy file failed');
    assert.strictEqual(fs.readFileSync(legacyFile, 'utf8'), legacyText, 'append should not modify the legacy file');
    assert.ok(fs.readdirSync(legacyDir).some((f) => /^\d{4}-\d{2}\.pc-a\.jsonl$/.test(f)), 'append should create a separate machine file');
    rows = readRows(legacy);
    assert.strictEqual(rows[0].p, 'old legacy prompt', 'legacy entry should sort before newer append');
  } finally {
    if (previousMachine === undefined) delete process.env.BRAIN_MACHINE;
    else process.env.BRAIN_MACHINE = previousMachine;
  }

  finished = true;
  console.log('ALL PASSED');
})().catch((err) => { console.error(err); process.exit(1); });
