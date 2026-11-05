// Test for mk.js (the Makillez map) on a tiny fake docs folder and graph, in a temp folder. Prints ALL PASSED or the first failure.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-test-'));
const home = path.join(tmp, 'home'), root = path.join(tmp, 'docs');
process.env.MK_DOCS = root;
const mk = require('./mk.js');

const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
write(path.join(root, 'technical-docs', 'for-dev', '01-intro.md'), [
  '# 01 — Intro', '', '## Orders', '',
  'The `OrderHandler` in `Services/Shop/OrderHandler.cs` saves a new order and raises `OrderCreated` for the billing service.', '',
  'See [billing](02-billing.md) for the invoice rules.', '',
].join('\n'));
write(path.join(root, 'technical-docs', 'for-dev', '02-billing.md'), [
  '# 02 — Billing', '', '## Invoices', '',
  'An invoice is created when `OrderCreated` arrives. The `InvoiceWriter` stores it and retries on failure.', '',
].join('\n'));
// filler docs: word rarity (idf) only means something when there are many chunks, like the real ~1,600
write(path.join(root, 'technical-docs', 'for-dev', '03-filler.md'), ['# 03 — Filler', '', ...Array.from({ length: 120 }, (_, i) => `Filler note ${i} about subject${i} and gadget${i}.\n`)].join('\n'));
// a graph with a normal chain (handler -> repository) and one huge hub that everything points at
const nodes = [
  { id: 'h', label: 'OrderHandler', source_file: 'Services/Shop/OrderHandler.cs', source_location: 'L7', community: 1, community_name: 'Shop' },
  { id: 'r', label: 'OrderRepository', source_file: 'Services/Shop/OrderRepository.cs', source_location: 'L5', community: 1, community_name: 'Shop' },
  { id: 'w', label: 'InvoiceWriter', source_file: 'Services/Billing/InvoiceWriter.cs', source_location: 'L9', community: 2, community_name: 'Billing' },
  { id: 'hub', label: 'ResultBase', source_file: 'Services/Shared/ResultBase.cs', source_location: 'L1', community: 3, community_name: 'Shared' },
];
const links = [{ source: 'h', target: 'r', relation: 'calls', confidence_score: 1 }, { source: 'h', target: 'hub', relation: 'references', confidence_score: 1 }];
for (let i = 0; i < 700; i++) { nodes.push({ id: 'x' + i, label: 'Thing' + i, source_file: 'Services/Shared/Thing' + i + '.cs', source_location: 'L1', community: 3, community_name: 'Shared' }); links.push({ source: 'x' + i, target: 'hub', relation: 'references', confidence_score: 1 }); }
write(path.join(root, 'graphify-out', 'graph.json'), JSON.stringify({ nodes, links, built_at_commit: 'abc12345def' }));

(async () => {
  try {
    // no map yet: nothing found, nothing thrown, and "stale" says a build is due
    assert.strictEqual(mk.search(home, 'how does the order handler save an order'), null, 'no map must give null');
    assert.strictEqual(mk.stale(home), true, 'no map yet must be stale');
    const r = await mk.build(home, { root, noEmbed: true });
    assert.strictEqual(r.files, 3); assert.strictEqual(r.code, 704);
    assert.strictEqual(mk.stale(home), false, 'fresh map is not stale');

    // a prompt about the handler reaches the doc that cites it, the handler itself, and (by spreading) its repository
    const res = mk.search(home, 'how does the order handler save an order', {});
    assert.ok(res, 'a clear prompt must find something');
    assert.ok(res.docs.some((d) => d.n.file.includes('01-intro')), 'the doc that cites OrderHandler.cs must fire');
    assert.ok(res.code.some((c) => c.n.label === 'OrderHandler'), 'the handler must be found');
    assert.ok(res.code.some((c) => c.n.label === 'OrderRepository'), 'the repository must light up through the calls link');
    assert.ok(!res.code.some((c) => c.n.label === 'ResultBase'), 'a hub must not be shown');
    assert.ok(res.code.length <= 6 && res.docs.length <= 4, 'caps hold');

    // the doc link reaches the billing doc, which cites the invoice writer
    const res2 = mk.search(home, 'when does the invoice get created after an order', {});
    assert.ok(res2 && res2.docs.some((d) => d.n.file.includes('02-billing')), 'the billing doc must fire');

    // unrelated text stays quiet
    assert.strictEqual(mk.search(home, 'recommend a good pasta recipe for tonight'), null, 'unrelated text must give null');

    // the printed block names the commit and stays short
    const text = mk.format(res);
    assert.ok(text.includes('abc12345') && text.length <= 2300, 'format shows the commit and respects the size cap');

    // ---- a second project in the same file: kept apart, routed by what it knows, and a rebuild of one leaves the other alone ----
    const root2 = path.join(tmp, 'docs2');
    write(path.join(root2, 'technical-docs', '01-shipping.md'), ['# 01 — Shipping', '', '## Parcels', '', 'The `ParcelRouter` in `Services/Post/ParcelRouter.cs` sorts every parcel by zone and hands it to the courier.', ''].join('\n'));
    write(path.join(root2, 'technical-docs', '02-filler.md'), ['# 02 — Filler', '', ...Array.from({ length: 120 }, (_, i) => `Spare note ${i} about thing${i} and widget${i}.\n`)].join('\n'));
    write(path.join(root2, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [{ id: 'p', label: 'ParcelRouter', source_file: 'Services/Post/ParcelRouter.cs', source_location: 'L3', community: 1, community_name: 'Post' }], links: [], built_at_commit: 'fed98765cba' }));
    await mk.build(home, { root: root2, project: 'esg', noEmbed: true });
    const parcel = 'how does the parcel router sort a parcel by zone', order = 'how does the order handler save an order';
    const p2 = mk.search(home, parcel, { project: 'esg' });
    assert.ok(p2 && p2.project === 'esg' && p2.docs.some((d) => d.n.file.includes('01-shipping')) && p2.code.some((c) => c.n.label === 'ParcelRouter'), 'the second project finds its own doc and class');
    assert.strictEqual(mk.search(home, parcel, {}), null, 'the Makillez map does not know parcels');
    assert.strictEqual(mk.search(home, order, { project: 'esg' }), null, 'the second project does not know orders');
    const again = mk.search(home, order, {});
    assert.ok(again && again.project === 'makillez' && again.docs.some((d) => d.n.file.includes('01-intro')) && again.code.some((c) => c.n.label === 'OrderRepository'), 'building another project leaves Makillez as it was');
    assert.strictEqual(mk.searchAll(home, parcel, {}).project, 'esg', 'the router picks the project that knows the prompt');
    assert.strictEqual(mk.searchAll(home, order, {}).project, 'makillez', 'and the Makillez prompt stays with Makillez');
    assert.strictEqual(mk.searchAll(home, 'esg ' + order, {}).project, 'makillez', 'naming a project that does not know the prompt does not block the others');
    assert.strictEqual(mk.searchAll(home, 'in esg ' + parcel, {}).project, 'esg', 'a named project that knows the prompt wins');
    await mk.build(home, { root: root2, project: 'esg', noEmbed: true });   // a rebuild replaces the project rows and leaves the others
    assert.ok(mk.search(home, order, {}) && mk.search(home, parcel, { project: 'esg' }), 'both projects still answer after a rebuild');
    assert.strictEqual(mk.stale(home, 'esg'), false, 'the rebuilt project is not stale');
    assert.ok(mk.status(home, 'esg').nDoc > 0 && mk.status(home, 'makillez').nDoc > 0, 'status reads each project');

    // ---- learning from use ----
    const Q = 'how does the order handler save an order', T0 = Date.now(), actOf = (r, label) => (r.code.find((c) => c.n.label === label) || { a: 0 }).a;
    const file = 'C:\\work\\Makillez\\src\\Services\\Billing\\InvoiceWriter.cs';
    const before = mk.search(home, Q, { now: T0 });
    assert.strictEqual(actOf(before, 'InvoiceWriter'), 0, 'before learning the invoice writer is not part of an order-handler answer');
    assert.ok(before.seedKeys.length > 0 && before.seedKeys.every(([k]) => /^[cd]\|/.test(k)), 'seeds are remembered by stable key');
    // a touch without a recent map, a foreign file and an unknown file are all ignored
    assert.ok(mk.touched(home, 's1', file, { now: T0 }).ignored, 'no map was shown for this session yet');
    assert.strictEqual(mk.remember(home, 's1', before, T0), true);
    assert.ok(mk.touched(home, 's1', 'C:\\other\\notes.txt', { now: T0 }).ignored, 'a file outside src is ignored');
    assert.ok(mk.touched(home, 's1', 'C:\\w\\src\\Services\\Nope\\Missing.cs', { now: T0 }).ignored, 'a file that is not in the map is ignored');
    assert.ok(mk.touched(home, 's1', file, { now: T0 + 3 * 3600000 }).ignored, 'a map older than 45 minutes teaches nothing');
    // one confirmation is a whisper, repeated confirmations make the link visible
    const t1 = mk.touched(home, 's1', file, { now: T0 });
    assert.ok(t1.learned > 0 && t1.targets.includes('InvoiceWriter'), 'opening the file soon after a map teaches the network');
    assert.ok(mk.touched(home, 's1', file, { now: T0 }).ignored, 'the same file counts once per map');
    const one = mk.search(home, Q, { now: T0 });
    assert.strictEqual(actOf(one, 'InvoiceWriter'), 0, 'a single confirmation must not change the answer');
    for (let i = 0; i < 8; i++) { mk.remember(home, 's1', mk.search(home, Q, { now: T0, learn: false }), T0); mk.touched(home, 's1', file, { now: T0 }); }
    const after = mk.search(home, Q, { now: T0 });
    assert.ok(actOf(after, 'InvoiceWriter') > 0, 'a link confirmed many times shows the file');
    assert.ok(actOf(after, 'InvoiceWriter') <= 0.5 * actOf(after, 'OrderHandler'), 'learned light is capped: a learned file never outshines a real match');
    assert.ok(actOf(after, 'OrderHandler') > 0 && actOf(after, 'OrderHandler') >= actOf(after, 'InvoiceWriter'), 'the real best match stays on top after learning');
    assert.strictEqual(actOf(mk.search(home, Q, { now: T0, learn: false }), 'InvoiceWriter'), 0, 'learning can be switched off');
    assert.strictEqual(mk.search(home, 'recommend a good pasta recipe for tonight', { now: T0 }), null, 'learning never lets an unrelated prompt through');
    assert.strictEqual(actOf(mk.search(home, Q, { now: T0 + 400 * 86400000 }), 'InvoiceWriter'), 0, 'a learned link fades away with age');
    const shown = mk.learnShow(home, 5, T0);
    assert.ok(shown.total > 0 && /InvoiceWriter/.test(shown.lines.join('\n')), 'learn-show lists the strongest links');
    // a rebuild merges the old map in: links to neurons that still exist stay, links to removed ones go
    const g1 = JSON.parse(fs.readFileSync(path.join(root, 'graphify-out', 'graph.json'), 'utf8'));
    g1.nodes.push({ id: 'extra', label: 'ExtraThing', source_file: 'Services/Shop/ExtraThing.cs', source_location: 'L1', community: 1, community_name: 'Shop' });
    fs.writeFileSync(path.join(root, 'graphify-out', 'graph.json'), JSON.stringify(g1));
    const r2 = await mk.build(home, { root, noEmbed: true });
    assert.ok(r2.merged.kept > 0 && r2.merged.dropped === 0, 'a rebuild keeps the learned links');
    assert.ok(actOf(mk.search(home, Q, { now: T0 }), 'InvoiceWriter') > 0, 'the learned link still works after the rebuild');
    const g2 = { ...g1, nodes: g1.nodes.filter((n) => n.id !== 'w') };
    fs.writeFileSync(path.join(root, 'graphify-out', 'graph.json'), JSON.stringify(g2));
    const r3 = await mk.build(home, { root, noEmbed: true });
    assert.ok(r3.merged.dropped > 0 && r3.merged.kept === 0, 'links to a removed node are dropped');
    assert.strictEqual(mk.learnShow(home, 5, T0).total, 0, 'nothing is left to show');
    mk.remember(home, 's2', mk.search(home, Q, { now: T0 }), T0); mk.touched(home, 's2', 'C:\\w\\src\\Services\\Shop\\OrderRepository.cs', { now: T0 });
    assert.ok(mk.learnReset(home) >= 0 && mk.learnShow(home, 5, T0).total === 0, 'learn-reset forgets everything');
    assert.ok(mk.status(home).graphCommit === 'abc12345def', 'status reads the graph commit from the first bytes of graph.json');

    // a changed doc makes the map stale
    await new Promise((ok) => setTimeout(ok, 30));
    fs.appendFileSync(path.join(root, 'technical-docs', 'for-dev', '02-billing.md'), '\nMore text about refunds.\n');
    assert.strictEqual(mk.stale(home), true, 'a changed doc must make the map stale');

    // a broken map file never throws
    fs.writeFileSync(mk.dbFile(home), 'not a database');
    assert.strictEqual(mk.search(home, 'how does the order handler save an order'), null, 'a broken file must give null');
    console.log('ALL PASSED');
  } catch (e) { console.log('FAILED: ' + e.message); process.exitCode = 1; }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* the temp folder is cleaned by the OS later */ }
})();
