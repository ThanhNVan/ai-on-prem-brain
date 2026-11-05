// Train the doc ranking of the Makillez map from the written-down questions (eval-mk-cases.json). No download, no outside model.
//   node train-rank.js                      leave-one-area-out check: train on all areas but one, test on that one; prints the honest score
//   node train-rank.js --train dev,held     train on these sets, test on the others (default test: fresh)
//   node train-rank.js --write              train on all questions of the chosen sets and write rank.json (the map uses it from then on)
// Each candidate section has a few signals (see mk.js, "doc ranking"). The weights are learned with a listwise loss: the right sections of a question must score above the others.
const fs = require('fs');
const path = require('path');
const mk = require('./mk.js');
const { homeDir } = require('./rules.js');
const { getEmbedder } = require('./embed.js');

const argv = process.argv.slice(2), opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const NAMES = ['activation', 'words', 'heading words', 'meaning', 'heading meaning', 'word coverage', 'heading coverage', 'file size', 'first chunk of file', 'depth', 'meaning vs best', 'heading meaning vs best', 'coverage vs best', 'findings or backlog doc', 'non-developer or README', 'best meaning in section', 'query share of chunk', 'file best meaning vs best', 'file word share', 'problem question and findings doc', 'core doc', 'question meaning', 'question meaning vs best'];
const LAMBDA = Number(opt('--l2', 0.01)), MAX_DOCS = 4;
const rx = (s) => new RegExp(s, 'i');

function pick(rows, w, max = MAX_DOCS) {   // the same selection as mk.search
  const sc = rows.map((r) => ({ r, z: r.f.reduce((s, v, i) => s + v * w[i], 0) })).sort((a, b) => b.z - a.z), out = [], per = new Map();
  const secs = new Set();
  for (const x of sc) { const sk = x.r.n.file + '::' + x.r.n.section; if (out.length >= max || secs.has(sk) || (per.get(x.r.n.file) || 0) >= 2 || x.z < sc[0].z - 3) continue; secs.add(sk); per.set(x.r.n.file, (per.get(x.r.n.file) || 0) + 1); out.push(x.r); }
  return out;
}
function train(qs, l2 = LAMBDA, iters = 1200) {   // Adam on the listwise loss: -log( sum of softmax over the right sections )
  const d = NAMES.length, w = new Array(d).fill(0), m = new Array(d).fill(0), v = new Array(d).fill(0);
  const use = qs.filter((q) => q.rows.some((r) => r.y));
  for (let t = 1; t <= iters; t++) {
    const g = new Array(d).fill(0);
    for (const q of use) {
      const z = q.rows.map((r) => r.f.reduce((s, x, i) => s + x * w[i], 0)), mxz = Math.max(...z);
      const e = z.map((x) => Math.exp(x - mxz)), Z = e.reduce((s, x) => s + x, 0);
      const ep = q.rows.map((r, i) => (r.y ? e[i] : 0)), Zp = ep.reduce((s, x) => s + x, 0);
      for (let i = 0; i < q.rows.length; i++) for (let k = 0; k < d; k++) g[k] += (e[i] / Z - ep[i] / Zp) * q.rows[i].f[k];
    }
    for (let k = 0; k < d; k++) {
      const gk = g[k] / use.length + l2 * w[k];
      m[k] = 0.9 * m[k] + 0.1 * gk; v[k] = 0.999 * v[k] + 0.001 * gk * gk;
      w[k] -= 0.05 * (m[k] / (1 - 0.9 ** t)) / (Math.sqrt(v[k] / (1 - 0.999 ** t)) + 1e-8);
    }
  }
  return w;
}
const hit = (q, w) => pick(q.rows, w).some((r) => r.y);

(async () => {
  const embed = await getEmbedder(false), home = homeDir();
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval-mk-cases.json'), 'utf8')).filter((c) => !c.known && !c.none && c.doc && c.set !== 'blind2' && c.set !== 'blind5' && c.set !== 'blind6');   // blind2, blind5 and blind6 are never used here (kept for honest tests)
  const qs = [];
  for (const c of cases) {
    const pv = (await embed([c.q]))[0];
    const res = mk.search(home, c.q, { pv, learn: false, feat: true, rankW: null });
    if (!res || !res.feat) continue;
    const rows = res.feat.map((x) => ({ n: x.n, f: x.f, y: rx(c.doc).test(x.n.file) && (!c.sec || rx(c.sec).test(x.n.section || '')) }));
    qs.push({ c, rows, area: c.id.replace(/-\d+$/, ''), base: res.docs.some((d) => rx(c.doc).test(d.n.file) && (!c.sec || rx(c.sec).test(d.n.section || ''))) });
  }
  const withPos = qs.filter((q) => q.rows.some((r) => r.y));
  console.log(`${qs.length} doc questions; the right section is in the candidate pool for ${withPos.length} (${Math.round((100 * withPos.length) / qs.length)}%)`);
  const pct = (n, t) => `${n}/${t} ${Math.round((100 * n) / Math.max(t, 1))}%`;

  if (argv.includes('--write') || argv.includes('--train')) {
    const sets = opt('--train', 'dev,held,fresh').split(',');
    const tr = qs.filter((q) => sets.includes(q.c.set)), te = qs.filter((q) => !sets.includes(q.c.set));
    const w = train(tr);
    console.log('weights: ' + NAMES.map((n, i) => `${n} ${w[i].toFixed(2)}`).join(', '));
    console.log(`train sets ${sets.join('+')}: plain ranking ${pct(tr.filter((q) => q.base).length, tr.length)} -> learned ${pct(tr.filter((q) => hit(q, w)).length, tr.length)}`);
    if (te.length) console.log(`test (not trained on): plain ranking ${pct(te.filter((q) => q.base).length, te.length)} -> learned ${pct(te.filter((q) => hit(q, w)).length, te.length)}`);
    if (argv.includes('--write')) { fs.writeFileSync(path.join(__dirname, 'rank.json'), JSON.stringify({ names: NAMES, w, trained: sets, questions: tr.length, made: new Date().toISOString().slice(0, 10) }, null, 1)); console.log('wrote rank.json'); }
    process.exit(0);
  }

  // leave-one-area-out: the honest estimate
  const areas = [...new Set(qs.map((q) => q.area))];
  let base = 0, got = 0;
  const per = [], misses = [], atK = {};
  for (const a of areas) {
    const tr = qs.filter((q) => q.area !== a), te = qs.filter((q) => q.area === a);
    const w = train(tr), b = te.filter((q) => q.base).length, l = te.filter((q) => hit(q, w)).length;
    base += b; got += l; per.push(`${a} ${b}->${l}/${te.length}`);
    for (const k of [1, 2, 3, 4, 5, 6, 8]) atK[k] = (atK[k] || 0) + te.filter((q) => pick(q.rows, w, k).some((r) => r.y)).length;
    for (const q of te) if (!hit(q, w)) misses.push(`${q.c.id} "${q.c.q}"\n      want ${q.c.doc} ${q.c.sec || ''}\n      got  ${pick(q.rows, w).map((r) => r.n.file.replace(/^technical-docs\/(for-dev\/)?/, '') + ' > ' + (r.n.section || '').split(' > ').slice(-1)[0]).join(' | ')}`);
  }
  console.log('leave-one-area-out (train on the other areas, test on this one), plain -> learned:\n  ' + per.join('  '));
  console.log(`TOTAL doc questions: plain ${pct(base, qs.length)} -> learned ${pct(got, qs.length)}`);
  console.log('right section among the first k doc lines (learned, leave-one-area-out): ' + Object.entries(atK).map(([k, n]) => `k=${k} ${pct(n, qs.length)}`).join('  '));
  if (argv.includes('--show')) console.log('\nstill missed:\n  ' + misses.join('\n  '));
  const w = train(qs);
  console.log('weights on all: ' + NAMES.map((n, i) => `${n} ${w[i].toFixed(2)}`).join(', '));
  process.exit(0);
})();
