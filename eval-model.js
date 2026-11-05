// Try another embedding model for the Makillez map, in a throwaway home, without touching the live map.
//   node eval-model.js <name> [--grid 0.15,0.25,...]     name is a key of MODELS below (or "minilm" for the current one)
// It builds a map in %TEMP%\mk-model-<name> with that model, runs the written-down questions (eval-mk-cases.json)
// for several similarity floors, and prints strict pass rates per set. Pick the floor on `dev` only.
// Gate = floor + 0.1 and span = 0.35, the same shape as the live calibration (mk.js SIM_FLOOR/SIM_GATE/SIM_SPAN).
const fs = require('fs');
const os = require('os');
const path = require('path');
const mk = require('./mk.js');

const Q_BGE = 'Represent this sentence for searching relevant passages: ';
const MODELS = {
  minilm: { id: 'Xenova/all-MiniLM-L6-v2', pooling: 'mean' },
  'bge-small': { id: 'Xenova/bge-small-en-v1.5', pooling: 'cls', q: Q_BGE },
  'bge-base': { id: 'Xenova/bge-base-en-v1.5', pooling: 'cls', q: Q_BGE },
  'gte-base': { id: 'Xenova/gte-base', pooling: 'mean' },
  'e5-base': { id: 'Xenova/e5-base-v2', pooling: 'mean', q: 'query: ', p: 'passage: ' },
  mpnet: { id: 'Xenova/all-mpnet-base-v2', pooling: 'mean' },
  arctic: { id: 'Snowflake/snowflake-arctic-embed-m', pooling: 'cls', q: Q_BGE },
};
const name = process.argv[2], M = MODELS[name];
if (!M) { console.log('models: ' + Object.keys(MODELS).join(', ')); process.exit(1); }
const gi = process.argv.indexOf('--grid');
const grid = (gi > 0 ? process.argv[gi + 1] : '0.15,0.25,0.35,0.45,0.55,0.65').split(',').map(Number);
const home = path.join(os.tmpdir(), 'mk-model-' + name);
const rx = (s) => new RegExp(s, 'i');

function judge(c, res) {   // same rules as eval-mk.js
  if (c.none) return res ? 'LEAK' : 'OK';
  const docs = res ? res.docs : [], code = res ? res.code : [];
  const docFile = c.doc ? docs.some((d) => rx(c.doc).test(d.n.file)) : null;
  const docSec = c.doc ? docs.some((d) => rx(c.doc).test(d.n.file) && (!c.sec || rx(c.sec).test(d.n.section || ''))) : null;
  const codeOk = c.code ? code.some((x) => rx(c.code).test(x.n.label)) : null;
  const strict = c.any ? (docSec || codeOk) : [docSec, codeOk].filter((v) => v !== null).every(Boolean);
  if (strict) return 'OK';
  const lenient = c.any ? (docFile || codeOk) : [docFile, codeOk].filter((v) => v !== null).every(Boolean);
  return lenient ? 'DOC' : 'FAIL';
}

(async () => {
  const tf = await import('@huggingface/transformers');
  const dir = path.join(os.tmpdir(), 'mk-model-cache');
  tf.env.cacheDir = dir; tf.env.allowRemoteModels = true;
  const t0 = Date.now();
  const ext = await tf.pipeline('feature-extraction', M.id, { dtype: 'q8' });
  console.log(`${name}: model ${M.id} loaded in ${Date.now() - t0} ms`);
  const run = async (texts, pre) => (await ext(texts.map((t) => (pre || '') + t), { pooling: M.pooling, normalize: true })).tolist();
  const passage = (texts) => run(texts, M.p), query = (texts) => run(texts, M.q);

  fs.mkdirSync(path.join(home, 'brain', 'data'), { recursive: true });
  const b0 = Date.now();
  const r = await mk.build(home, { embed: passage });
  console.log(`built map in ${Date.now() - b0} ms: ${r.docs} docs, ${r.vectors} vectors`);

  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval-mk-cases.json'), 'utf8')).filter((c) => !c.known);
  const pvs = [];
  const q0 = Date.now();
  for (const c of cases) pvs.push((await query([c.q]))[0]);
  console.log(`embedded ${cases.length} questions, ${Math.round((Date.now() - q0) / cases.length)} ms each`);

  const rate = (rs) => (rs.length ? `${rs.filter((x) => x === 'OK').length}/${rs.length} ${Math.round((100 * rs.filter((x) => x === 'OK').length) / rs.length)}%` : '-');
  const lenient = (rs) => `${Math.round((100 * rs.filter((x) => x === 'OK' || x === 'DOC').length) / Math.max(rs.length, 1))}%`;
  const rows = [];
  for (const f of [null, ...grid]) {   // null = words only, no meaning
    const res = cases.map((c, i) => judge(c, mk.search(home, c.q, f === null ? { learn: false } : { pv: pvs[i], learn: false, simFloor: f, simSpan: 0.35, simGate: f + 0.1 })));
    const pick = (fn) => res.filter((_, i) => fn(cases[i]));
    const pos = pick((c) => !c.none), neg = pick((c) => c.none);
    rows.push({ f, all: rate(pos), dev: rate(pick((c) => !c.none && c.set === 'dev')), held: rate(pick((c) => !c.none && c.set === 'held')), fresh: rate(pick((c) => !c.none && c.set === 'fresh')), docOrCode: lenient(pos), quiet: rate(neg) });
  }
  console.log(`\n${name} (${M.id})  floor | all Makillez | dev | held | fresh | right doc or code | unrelated quiet`);
  for (const x of rows) console.log(`  ${x.f === null ? 'words only' : 'floor ' + x.f.toFixed(2)} | ${x.all} | ${x.dev} | ${x.held} | ${x.fresh} | ${x.docOrCode} | ${x.quiet}`);
  process.exit(0);
})();
