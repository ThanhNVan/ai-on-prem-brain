// Makillez map: a neuron-like network over Makillez-master-docs (technical-docs + the graphify code graph).
//   neurons   doc chunks (technical-docs), code nodes (graphify graph.json), communities (hidden layer)
//   synapses  graphify edges (calls/implements/... strong, imports weak), doc->code (cited paths and symbols),
//             doc->doc (links, same section, shared code names)
//   firing    a prompt lights seed neurons by words, synonyms and meaning; the light then spreads a few steps
//             along the synapses (hubs are damped, each step keeps only the strongest) and the strongest neurons are shown.
// Everything lives in one derived file, data/mk.db (not in git; rebuilt by `node brain.js build-mk`). Any trouble = no map, never a failed prompt.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { homeDir, dataDir, tokens, loadThesaurus } = require('./rules.js');

const DB_VERSION = 5;     // 2 = stable node keys + learning tables; 3 = plural stems (ies -> y) and heading words ('#word') in the word index
const DECAY = 0.55, ROUNDS = 3, FRONTIER = 300, HUB = 600;     // spreading: damping per step, steps, neurons kept per step, a neuron with more links only receives
const SEED_DOCS = 30, SEED_CODE = 30, SEED_HUB = 800;          // seeds kept per layer; code nodes with more links than SEED_HUB are never seeds
const MIN_SCORE = 2.5, WORD_SCALE = 12, THESAURUS_WEIGHT = 0.5; // same word scoring as rules.js
const SIM_FLOOR = 0.2, SIM_SPAN = 0.35, SIM_GATE = 0.3;         // meaning score of a doc chunk, same calibration as brain.js
const HEAD_GATE = 0.52;   // a question this close in meaning to a section title passes the gate on its own
const ROUTE_PRIOR = 0.5, ROUTE_NAMED = 1.2;   // see searchAll
const ALSO_CLOSE = 0.4, TECH_IF_WEAKER_THAN = 1.6, ALSO_CHARS = 1100;   // a second project block when its score is within 0.4 of the best; tech is only asked when the project's own best is under 1.6
const TECH_FIRST = 0.8;
const TECH_GATE = 1.7, TECH_MARGIN = 0.3, TECH_PROBE_ALONE = 0.5, TECH_PROBE_WITH_PROJECT = 1.0;   // tech docs: their own stricter gate (positives: median 2.35, 10th percentile 1.75; unrelated prompts: median 0.67, 90th percentile 1.10), the lead needed over a project, and the words-only look that decides whether the full tech search runs
const CODE_SIM = 0.55;  // a class name must be this close in meaning to the question to be added
const MAX_DOCS = 6, MAX_CODE = 6, MAX_CHARS = 2200, DOC_CHARS = 210, GATE = 0.65, Q_GATE = 9;   // Q_GATE: a question-index match this close can rescue a prompt the gate would drop (9 = off until measured)
// Learning from use: opening or editing a file soon after a map was shown strengthens the links from that prompt's strongest seeds to the file's main types.
// Bounded on purpose: a link saturates at LEARN_MAX (a full link counts like one full graph edge), fades with a half-life, needs several confirmations to show, and is never used to start a search or pass the gate.
const LEARN_RATE = 0.2, LEARN_MAX = 1, LEARN_GAIN = 1, LEARN_PRUNE = 0.02, LEARN_MIN_N = 2, LEARN_CAP = 0.45, HALF_LIFE_DAYS = 45, LEARN_WINDOW_MS = 45 * 60000, LEARN_SEEDS = 8, LEARN_TARGETS = 3;
const GENERIC = new Set('Empty Task CancellationToken IEnumerable DateTime Guid List Dictionary String Int32 Result IRequest IRequestHandler Unit Component Object Json Action Func Exception Boolean Nullable Type Tuple'.split(' '));
const REL = { calls: 1, implements: 1, inherits: 1, extends: 1, dispatches_to: 1, rationale_for: 0.8, conceptually_related_to: 0.6, semantically_similar_to: 0.6, method: 0.7, defines: 0.6, contains: 0.5, references: 0.3, imports: 0.2, imports_from: 0.2, re_exports: 0.2 };

// Projects in the one map file: Makillez (the default), ESG, AIPO and general technical docs (tech). A search looks at one project only, so a new project cannot disturb the Makillez answers.
const PROJECTS = { makillez: { dir: 'Makillez-master-docs', name: 'Makillez' }, esg: { dir: 'esg-master-docs', name: 'ESG' }, aipo: { dir: 'metizone-AIPO-code-docs', name: 'AIPO' }, tech: { name: 'Tech docs' } };
const docsRoot = (project = 'makillez') => (project === 'makillez' && process.env.MK_DOCS) || (project === 'tech' ? path.join(os.homedir(), '.claude', 'brain', 'data', 'corpus', 'tech') : path.join(os.homedir(), 'source', 'repos', PROJECTS[project].dir));
const dbFile = (home) => path.join(dataDir(home), 'mk.db');   // one file for all projects; every row carries its project
const f32 = (b) => (b.byteOffset % 4 === 0 ? new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) : new Float32Array(new Uint8Array(b).buffer));   // meaning numbers read in place (a copy only when the bytes are not aligned): the scan covers every chunk of a project
const sqlite = () => require('node:sqlite').DatabaseSync;       // loaded here so a missing module never breaks the hook

// ---- words ----
const camel = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
// The root of a word, so that forms of one word meet: generated and generator -> generat, sends and sender -> send. Cut up to two endings, drop a doubled end letter and a final e.
function rootOf(w) {
  let r = w;
  for (let pass = 0; pass < 2; pass++) {
    const s = ['ing', 'ers', 'ors', 'ed', 'er', 'or'].find((x) => r.endsWith(x) && r.length - x.length >= 4);
    if (!s) break;
    r = r.slice(0, -s.length);
  }
  const s = ['ation', 'ion'].find((x) => r.endsWith(x) && r.length - x.length >= 4);
  if (s) r = r.slice(0, -s.length);
  if (/([b-df-hj-np-tv-z])\1$/.test(r) && r.length > 4) r = r.slice(0, -1);
  return r.length > 4 && r.endsWith('e') ? r.slice(0, -1) : r;
}
function words(text) { // normal words, plus the pieces of identifiers: IhmEventTask -> ihmeventtask, ihm, event, task
  const out = tokens(text);
  for (const w of tokens(camel(text))) out.add(w);
  for (const w of [...out]) if (w.length > 5 && w.endsWith('ie')) out.add(w.slice(0, -2) + 'y'); // repositories -> (stemmed) repositorie -> repository
  return out;
}
// word families, for the code-name pass: sends, sender and send are one family; generated and generator are one family
const CODE_SYN = [['update', 'change', 'edit', 'modify'], ['create', 'add', 'new', 'insert'], ['delete', 'remove', 'drop'], ['store', 'save', 'persist', 'keep'], ['get', 'fetch', 'load', 'read'], ['find', 'search', 'lookup'], ['hold', 'collect', 'gather', 'accumulate']];
const CODE_FILLER = new Set(['class', 'type', 'object', 'thing', 'item', 'one']);   // words of a question that never help to find a class name
let canonCache;
const canon = () => canonCache ||= new Map(CODE_SYN.flatMap((g) => g.map((w) => [rootOf(w), rootOf(g[0])])));
const familyOf = (w) => { const r = rootOf(w.length === 4 && w.endsWith('s') && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w); return canon().get(r) || r; };
const families = (text, skip) => { const out = new Set(); for (const w of words(text)) if (w.length >= 3 && /^[a-z]+$/.test(w) && !(skip && skip.has(w))) out.add(familyOf(w)); return out; };
// words that mean nearly the same in this codebase and its docs (only the map uses them; the rules brain keeps its own list)
const MK_SYNONYMS = [['manual', 'manually', 'hand', 'handmade'], ['store', 'storage', 'persist', 'saved', 'kept'], ['working', 'healthy', 'strong', 'shape'], ['base', 'root', 'parent', 'inherit', 'super'],
  ['style', 'convention', 'format', 'lint'], ['disagree', 'drift', 'mismatch', 'differ', 'contradict', 'inconsistent'], ['authorization', 'authorisation', 'permission', 'access', 'rights'],
  ['frontend', 'front', 'ui', 'angular', 'spa'], ['sidecar', 'dapr'], ['install', 'prerequisite', 'requirement', 'setup'], ['start', 'run', 'launch', 'boot'], ['event', 'message', 'notification'],
  ['log', 'trace', 'observability', 'telemetry'], ['fail', 'broken', 'error', 'crash', 'wrong'], ['cors', 'origin'], ['health', 'alive', 'liveness', 'heartbeat'], ['outbox', 'bus']];
const CORE_DOC = /\/(01-architecture|02-bounded-contexts|05-gateway-and-routing|06-frontend|07-deployment|08-development-workflow|10-findings|13-cicd-process)\.md$/;   // the broad docs that a general question usually wants
const META_Q = new Set(['disagree', 'drift', 'mismatch', 'differ', 'contradict', 'bug', 'finding', 'unfixed', 'broken', 'problem', 'improve', 'suggestion', 'gap', 'wrong', 'outdated', 'stale'].map(familyOf));
let mkSynCache;
const mkSynonyms = () => (mkSynCache ||= MK_SYNONYMS.map((g) => g.map((w) => [...tokens(w)][0]).filter(Boolean)));
let rankCache;   // weights for the doc ranking (rank.json next to this file); null = none, the plain activation order is used
function loadRank() { if (rankCache === undefined) { try { rankCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'rank.json'), 'utf8')).w; } catch { rankCache = null; } } return rankCache; }
// the role a folder gives to the classes inside it: a class under TicketAggr/ is an aggregate, under Queries/ a query
const ROLE_FOLDER = [[/Aggr$/, 'aggregate'], [/^Events$/, 'event'], [/^Queries$/, 'query'], [/^Commands$/, 'command'], [/^Controllers$/, 'controller'], [/^Policies$/, 'policy'], [/^Repositories$/, 'repository'], [/\.Domain$/, 'domain'], [/\.Application$/, 'application']];
const roleWords = (file) => {
  const segs = String(file || '').split('/').slice(0, -1), out = [];
  for (const seg of segs) for (const [re, w] of ROLE_FOLDER) if (re.test(seg)) out.push(w);
  const i = segs.indexOf('Services');
  if (i >= 0 && segs[i + 1]) out.push(segs[i + 1].replace(/([a-z])([A-Z])/g, '$1 $2'));   // the service a class lives in (CompanyRegister) is part of what it is
  return out.join(' ');
};

// ---- reading the docs ----
function listDocs(root) {
  const out = [], base = path.join(root, 'technical-docs');
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'atlas' && e.name !== '_tools') walk(p); } else if (e.name.endsWith('.md')) out.push(p); } };
  if (fs.existsSync(base)) walk(base);
  else {   // a project without technical-docs/ (AIPO): every .md under the root, except tool folders
    const skip = new Set(['graphify-out', 'node_modules', '.git', 'atlas', '_tools']);
    const walkAll = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!skip.has(e.name)) walkAll(p); } else if (e.name.endsWith('.md')) out.push(p); } };
    walkAll(root);
  }
  return out.sort();
}

const clean = (s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*{1,3}/g, '').replace(/(^|\s)_+|_+(?=\s|$)/g, '$1').replace(/\s+/g, ' ').trim(); // keeps underscores inside names like DEFINITION_OF_DONE
const slug = (h) => h.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-');

// Split one markdown file into chunks of about 450 characters. A chunk keeps its heading path.
function chunkDoc(rel, raw) {
  const out = [], stack = [];
  let fence = false, buf = '', sec = '';
  const flush = () => { const t = buf.trim(); buf = ''; if (t.length >= 30) out.push({ section: sec, text: t.slice(0, 700) }); };
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { flush(); fence = !fence; continue; }
    if (fence) continue;
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); stack.length = h[1].length - 1; stack[h[1].length - 1] = clean(h[2]); sec = stack.filter(Boolean).join(' > '); continue; }
    if (!line.trim()) { flush(); continue; }
    if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) continue;             // table separator row
    const text = clean(line.replace(/^\s*[-*]\s+|^\s*\d+\.\s+|^\s*>\s?/, '').replace(/^\||\|$/g, '').replace(/\|/g, ' · '));
    if (!text) continue;
    if (buf && buf.length + text.length > 450) flush();
    buf += (buf ? ' ' : '') + text;
  }
  flush();
  const links = [...raw.matchAll(/\]\(([^)#\s]+\.md)(?:#([^)]*))?\)/g)].map((m) => ({ file: path.basename(m[1]), anchor: m[2] || '' }));
  return { rel, no: (path.basename(rel).match(/^(\d+)/) || [])[1] || path.basename(rel, '.md'), chunks: out, links };
}

const PATH_RE = /[\w.\/-]+\.(?:cs|ts|html|scss|py|yml|json|ps1)\b/g;
const spansOf = (t) => [...t.matchAll(/`([^`]{2,80})`/g)].map((m) => m[1].trim());

// ---- build ----
async function build(home = homeDir(), opts = {}) {
  const project = opts.project || 'makillez', root = opts.root || docsRoot(project), t0 = Date.now(), log = opts.log || (() => {});
  const graphPath = path.join(root, 'graphify-out', 'graph.json');
  if (!fs.existsSync(graphPath) && project !== 'tech') throw new Error('no graphify-out/graph.json under ' + root);   // the tech docs have no code graph
  const g = fs.existsSync(graphPath) ? JSON.parse(fs.readFileSync(graphPath, 'utf8')) : { nodes: [], links: [], built_at_commit: '' };
  const files = listDocs(root);
  const tmp = dbFile(home, project) + '.' + process.pid + '.tmp';
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  for (const f of fs.readdirSync(path.dirname(tmp))) if (f.startsWith(path.basename(dbFile(home, project)) + '.') && f.endsWith('.tmp')) { try { fs.rmSync(path.join(path.dirname(tmp), f), { force: true }); } catch { /* still in use by a build that is running */ } }
  const db = new (sqlite())(tmp);
  db.exec(`CREATE TABLE nodes(id INTEGER PRIMARY KEY, kind TEXT, label TEXT, file TEXT, loc TEXT, section TEXT, text TEXT, comm INTEGER, deg INTEGER, nkw INTEGER, key TEXT);
    CREATE TABLE learn(ka TEXT, kb TEXT, w REAL, n INTEGER, t INTEGER, PRIMARY KEY(ka, kb));
    CREATE TABLE last(session TEXT PRIMARY KEY, t INTEGER, seeds TEXT, done TEXT);
    CREATE TABLE kw(word TEXT, node INTEGER);
    CREATE TABLE kw2(word TEXT, node INTEGER);
    CREATE TABLE df(word TEXT, kind TEXT, n INTEGER, PRIMARY KEY(word, kind));
    CREATE TABLE edges(a INTEGER, b INTEGER, w REAL);
    CREATE TABLE comm(id INTEGER PRIMARY KEY, name TEXT, size INTEGER);
    CREATE TABLE vec(node INTEGER PRIMARY KEY, v BLOB);
    CREATE TABLE vech(node INTEGER PRIMARY KEY, v BLOB);
    CREATE TABLE vecc(label TEXT PRIMARY KEY, v BLOB);
    CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);`);
  const addNode = db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?,?,?,?)'), addKw = db.prepare('INSERT INTO kw VALUES(?,?)'), addKw2 = db.prepare('INSERT INTO kw2 VALUES(?,?)'), addEdge = db.prepare('INSERT INTO edges VALUES(?,?,?)');
  db.exec('BEGIN');
  let nid = 0;
  // 1. code neurons
  const codeId = new Map(), labelOf = new Map(), byFile = new Map(), byLabel = new Map(), comms = new Map();
  for (const n of g.nodes) {
    const id = ++nid; codeId.set(n.id, id); labelOf.set(id, n.label || '');
    const kws = words(n.label || '');
    addNode.run(id, 'code', n.label || '', n.source_file || '', n.source_location || '', '', '', n.community ?? -1, 0, kws.size, 'c|' + n.id);   // the graph's own id: stable across rebuilds
    for (const w of kws) addKw.run(w, id);
    for (const f of families((n.label || '') + ' ' + roleWords(n.source_file))) addKw2.run(f, id);   // the code-name pass: word families, never used to start a doc search or to spread
    if (n.source_file) (byFile.get(n.source_file) || byFile.set(n.source_file, []).get(n.source_file)).push(id);
    if (n.label) (byLabel.get(n.label) || byLabel.set(n.label, []).get(n.label)).push(id);
    if (n.community !== undefined) { const c = comms.get(n.community) || { name: n.community_name || '', size: 0 }; c.size++; comms.set(n.community, c); }
  }
  const addComm = db.prepare('INSERT INTO comm VALUES(?,?,?)');
  for (const [id, c] of comms) addComm.run(id, c.name, c.size);
  log(`code neurons ${g.nodes.length}, communities ${comms.size}`);
  // 2. code synapses (one row per direction; the strongest relation of a pair wins)
  const pair = new Map();
  for (const e of g.links) {
    const a = codeId.get(e.source), b = codeId.get(e.target);
    if (!a || !b || a === b) continue;
    const w = (REL[e.relation] ?? 0.3) * (e.confidence_score ?? 1);
    const k = a < b ? a * 1e6 + b : b * 1e6 + a;
    if ((pair.get(k) || 0) < w) pair.set(k, w);
  }
  const deg = new Map();
  for (const [k, w] of pair) {
    const a = Math.floor(k / 1e6), b = k % 1e6;
    addEdge.run(a, b, w); addEdge.run(b, a, w);
    deg.set(a, (deg.get(a) || 0) + 1); deg.set(b, (deg.get(b) || 0) + 1);
  }
  log(`code synapses ${pair.size}`);
  // 3. doc neurons and their synapses
  const docs = files.map((f) => chunkDoc(path.relative(root, f).replace(/\\/g, '/'), fs.readFileSync(f, 'utf8')));
  const docIds = [], byDocName = new Map(), spanChunks = new Map();
  const link = (a, b, w) => { addEdge.run(a, b, w); addEdge.run(b, a, w); deg.set(a, (deg.get(a) || 0) + 1); deg.set(b, (deg.get(b) || 0) + 1); };
  for (const d of docs) {
    d.ids = [];
    let prev = 0;
    for (const c of d.chunks) {
      const id = ++nid; c.id = id; d.ids.push(id);
      const sp = spansOf(c.text);
      const heading = (c.section.split(' > ').pop() || '');
      const kws = new Set([...[...words(c.section + ' ' + c.text)].filter((w) => w[0] !== '~'), ...sp.map((s) => s.toLowerCase()), ...[...c.text.matchAll(PATH_RE)].map((m) => m[0].toLowerCase()), ...[...words(heading)].map((w) => '#' + w)]); // '#word' = a word of the chunk's own heading: a question that names a heading should find its section
      addNode.run(id, 'doc', 'doc ' + d.no, d.rel, '', c.section, c.text, -1, 0, kws.size, 'd|' + d.rel + '|' + crypto.createHash('sha1').update(c.section + '\n' + c.text).digest('hex').slice(0, 12));   // changes only when the chunk's text changes
      for (const w of kws) addKw.run(w, id);
      docIds.push(id);
      if (prev) link(prev, id, 0.3);                      // next chunk in the same file
      prev = id;
      for (const s of new Set(sp)) (spanChunks.get(s) || spanChunks.set(s, []).get(s)).push(id);
      // doc -> code: a cited file path, a cited symbol
      for (const p0 of new Set([...c.text.matchAll(PATH_RE)].map((m) => m[0]))) {
        const p = p0.replace(/^src\//, '').replace(/^\.\//, '');
        const hit = byFile.get(p) || [...byFile].find(([f]) => f.endsWith('/' + p))?.[1];
        if (!hit) continue;
        const base = path.basename(p).replace(/\.[^.]+$/, '');
        const top = hit.slice().sort((x, y) => (labelOf.get(x) === base ? 0 : 1) - (labelOf.get(y) === base ? 0 : 1)).slice(0, 6);
        for (const t of top) link(id, t, 1);
      }
      for (const s of new Set(sp)) {
        const sym = s.replace(/\(\)$/, '').split('.').pop();
        const hit = byLabel.get(sym) || byLabel.get(s);
        if (hit && hit.length <= 3 && /^[A-Z]/.test(sym)) for (const t of hit) link(id, t, 0.9);
      }
    }
    byDocName.set(path.basename(d.rel), d);
  }
  // doc -> doc: markdown links (to the chunk whose heading matches the anchor, else the first chunk), shared code names, same section
  for (const d of docs) for (const l of d.links) {
    const t = byDocName.get(l.file); if (!t || !t.chunks.length || !d.ids.length) continue;
    const hit = l.anchor ? t.chunks.find((c) => slug(c.section.split(' > ').pop() || '') === l.anchor) : null;
    link(d.ids[0], (hit || t.chunks[0]).id, 0.8);
  }
  for (const [, ids] of spanChunks) if (ids.length >= 2 && ids.length <= 6) for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) link(ids[i], ids[j], 0.7);
  const bySec = new Map();
  for (const d of docs) for (const c of d.chunks) { const k = d.rel + '::' + c.section; (bySec.get(k) || bySec.set(k, []).get(k)).push(c.id); }
  for (const ids of bySec.values()) if (ids.length <= 8) for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) link(ids[i], ids[j], 0.4);
  log(`doc neurons ${docIds.length} from ${docs.length} files`);
  // 4. degrees, word counts per layer, meta
  const setDeg = db.prepare('UPDATE nodes SET deg = ? WHERE id = ?');
  for (const [id, d] of deg) setDeg.run(d, id);
  db.exec('CREATE INDEX kw_w ON kw(word); CREATE INDEX kw2_w ON kw2(word); CREATE INDEX edges_a ON edges(a); CREATE INDEX nodes_kind ON nodes(kind);');
  db.exec('CREATE TABLE df2(word TEXT PRIMARY KEY, n INTEGER); INSERT INTO df2 SELECT word, COUNT(*) FROM kw2 GROUP BY word;');
  db.exec('INSERT INTO df SELECT k.word, n.kind, COUNT(*) FROM kw k JOIN nodes n ON n.id = k.node GROUP BY k.word, n.kind;');
  const setMeta = db.prepare('INSERT INTO meta VALUES(?,?)');
  for (const [k, v] of Object.entries({ version: DB_VERSION, built: Date.now(), commit: g.built_at_commit || '', root, stamp: JSON.stringify(sources(root)), nCode: g.nodes.length, nDoc: docIds.length })) setMeta.run(k, String(v));
  db.exec('COMMIT');
  // 5. meaning numbers for the doc chunks (skipped when the local model is not installed)
  let vecs = 0;
  if (!opts.noEmbed) {
    const embed = opts.embed || (await require('./embed.js').getEmbedder(false));
    if (embed) {
      const rows = db.prepare("SELECT id, section, text FROM nodes WHERE kind = 'doc'").all();
      const put = db.prepare('INSERT INTO vec VALUES(?,?)');
      db.exec('BEGIN');
      for (let i = 0; i < rows.length; i += 32) {
        const part = rows.slice(i, i + 32), got = await embed(part.map((r) => (r.section ? r.section + ': ' : '') + r.text.slice(0, 300)));
        part.forEach((r, j) => { const f = Float32Array.from(got[j]); put.run(r.id, Buffer.from(f.buffer, f.byteOffset, f.byteLength)); vecs++; });
        if (opts.progress) opts.progress(Math.min(i + 32, rows.length), rows.length);
      }
      db.exec('COMMIT');
      // the heading alone (last two levels of the path), one number set per distinct heading: a question often matches the title of the section that answers it
      const headOf = (s) => (s || '').split(' > ').slice(-2).join(': ');
      const uniq = [...new Set(rows.map((r) => headOf(r.section)).filter(Boolean))], hv = new Map();
      for (let i = 0; i < uniq.length; i += 32) { const part = uniq.slice(i, i + 32), got = await embed(part); part.forEach((h, j) => hv.set(h, Float32Array.from(got[j]))); }
      const puth = db.prepare('INSERT INTO vech VALUES(?,?)');
      db.exec('BEGIN');
      for (const r of rows) { const f = hv.get(headOf(r.section)); if (f) puth.run(r.id, Buffer.from(f.buffer, f.byteOffset, f.byteLength)); }
      db.exec('COMMIT');
      // the meaning of class names: each distinct type name, read as words (DomainServiceDomainEventsHolder -> "domain service domain events holder")
      const names = db.prepare("SELECT DISTINCT label FROM nodes WHERE kind = 'code' AND file != ''").all().map((r) => r.label).filter((l) => /^[A-Za-z][A-Za-z0-9]{4,}$/.test(l) && !GENERIC.has(l));
      const putc = db.prepare('INSERT INTO vecc VALUES(?,?)');
      db.exec('BEGIN');
      for (let i = 0; i < names.length; i += 64) {
        const part = names.slice(i, i + 64), got = await embed(part.map((l) => camel(l).toLowerCase()));
        part.forEach((l, j) => { const f = Float32Array.from(got[j]); putc.run(l, Buffer.from(f.buffer, f.byteOffset, f.byteLength)); });
      }
      db.exec('COMMIT');
    }
  }
  db.close();
  const merged = integrate(home, tmp, project);         // the project's fresh rows replace its old rows in mk.db; learned links stay where they are
  return { merged, code: g.nodes.length, docs: docIds.length, files: docs.length, synapses: pair.size, vectors: vecs, commit: g.built_at_commit || '', ms: Date.now() - t0 };
}

// ---- learning: one store (this file), keyed by stable names, merged on every rebuild ----
const effective = (w, t, now) => w * Math.pow(0.5, Math.max(0, now - t) / (HALF_LIFE_DAYS * 86400000)); // a learned link fades by half every HALF_LIFE_DAYS

// ---- one file for all projects ----
// Every table carries a `project` tag (kw, kw2, vec, vech, df, df2, comm, meta, nodes). Edges and learned links need none: ids are unique, and keys of the other projects start with "<project>:".
// Open mk.db and make sure the tables exist. A file from before projects existed (no `project` column) is replaced; what it learned is carried over.
function openMain(home) {
  const file = dbFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let carry = null;
  if (fs.existsSync(file)) {
    let old;
    try {
      old = new (sqlite())(file, { readOnly: true });
      const cols = old.prepare('PRAGMA table_info(nodes)').all().map((c) => c.name);
      if (cols.length && !cols.includes('project')) carry = { learn: old.prepare('SELECT * FROM learn').all(), last: old.prepare('SELECT * FROM last').all() };
    } catch { /* not a map file: start again */ } finally { try { old.close(); } catch { /* closed */ } }
    if (carry) fs.rmSync(file, { force: true });
  }
  const db = new (sqlite())(file);
  db.exec('PRAGMA busy_timeout = 8000');
  db.exec(`CREATE TABLE IF NOT EXISTS nodes(id INTEGER PRIMARY KEY, kind TEXT, label TEXT, file TEXT, loc TEXT, section TEXT, text TEXT, comm INTEGER, deg INTEGER, nkw INTEGER, key TEXT, project TEXT);
    CREATE TABLE IF NOT EXISTS learn(ka TEXT, kb TEXT, w REAL, n INTEGER, t INTEGER, PRIMARY KEY(ka, kb));
    CREATE TABLE IF NOT EXISTS last(session TEXT PRIMARY KEY, t INTEGER, seeds TEXT, done TEXT);
    CREATE TABLE IF NOT EXISTS kw(word TEXT, node INTEGER, project TEXT);
    CREATE TABLE IF NOT EXISTS kw2(word TEXT, node INTEGER, project TEXT);
    CREATE TABLE IF NOT EXISTS df(word TEXT, kind TEXT, n INTEGER, project TEXT, PRIMARY KEY(word, kind, project));
    CREATE TABLE IF NOT EXISTS df2(word TEXT, n INTEGER, project TEXT, PRIMARY KEY(word, project));
    CREATE TABLE IF NOT EXISTS edges(a INTEGER, b INTEGER, w REAL);
    CREATE TABLE IF NOT EXISTS comm(id INTEGER, name TEXT, size INTEGER, project TEXT);
    CREATE TABLE IF NOT EXISTS vec(node INTEGER PRIMARY KEY, v BLOB, project TEXT);
    CREATE TABLE IF NOT EXISTS vech(node INTEGER PRIMARY KEY, v BLOB, project TEXT);
    CREATE TABLE IF NOT EXISTS vecc(label TEXT, v BLOB, project TEXT, PRIMARY KEY(label, project));
    CREATE TABLE IF NOT EXISTS meta(k TEXT, v TEXT, project TEXT, PRIMARY KEY(k, project));
    CREATE INDEX IF NOT EXISTS kw_w ON kw(word, project); CREATE INDEX IF NOT EXISTS kw2_w ON kw2(word, project);
    CREATE INDEX IF NOT EXISTS kw_node ON kw(node); CREATE INDEX IF NOT EXISTS kw2_node ON kw2(node);
    CREATE INDEX IF NOT EXISTS edges_a ON edges(a); CREATE INDEX IF NOT EXISTS nodes_p ON nodes(project, kind); CREATE INDEX IF NOT EXISTS nodes_file ON nodes(file, project);
    CREATE INDEX IF NOT EXISTS vec_p ON vec(project); CREATE INDEX IF NOT EXISTS vech_p ON vech(project);`);
  if (carry) {
    const put = db.prepare('INSERT OR REPLACE INTO learn VALUES(?,?,?,?,?)'), putLast = db.prepare('INSERT OR REPLACE INTO last VALUES(?,?,?,?)');
    db.exec('BEGIN');
    for (const r of carry.learn) put.run(r.ka, r.kb, r.w, r.n, r.t);
    for (const r of carry.last) putLast.run(r.session, r.t, r.seeds, r.done);
    db.exec('COMMIT');
  }
  return db;
}

// Move a freshly built project (a temporary file with the old one-project layout) into mk.db, in one transaction: a reader sees the old rows or the new rows, never half.
// Ids move up by an offset, so the project keeps its order. A learned link is kept only when both its neurons still exist and it has not faded away.
function integrate(home, tmp, project) {
  const db = openMain(home), out = { kept: 0, dropped: 0, sessions: 0 };
  try {
    db.exec(`ATTACH DATABASE '${tmp.replace(/'/g, "''")}' AS t`);
    db.exec('BEGIN IMMEDIATE');
    try {
      const mine = '(SELECT id FROM nodes WHERE project = ?)';
      for (const tbl of ['kw', 'kw2']) db.prepare(`DELETE FROM ${tbl} WHERE node IN ${mine}`).run(project);
      db.prepare(`DELETE FROM edges WHERE a IN ${mine}`).run(project);
      for (const tbl of ['vec', 'vech', 'vecc', 'df', 'df2', 'comm', 'meta', 'nodes']) db.prepare(`DELETE FROM ${tbl} WHERE project = ?`).run(project);
      const off = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM nodes').get().m, mkKey = project === 'makillez';
      db.prepare(`INSERT INTO nodes SELECT id + ?, kind, label, file, loc, section, text, comm, deg, nkw, ${mkKey ? 'key' : "? || ':' || key"}, ? FROM t.nodes`).run(...(mkKey ? [off, project] : [off, project, project]));
      db.prepare('INSERT INTO kw SELECT word, node + ?, ? FROM t.kw').run(off, project);
      db.prepare('INSERT INTO kw2 SELECT word, node + ?, ? FROM t.kw2').run(off, project);
      db.prepare('INSERT INTO edges SELECT a + ?, b + ?, w FROM t.edges').run(off, off);
      db.prepare('INSERT INTO vec SELECT node + ?, v, ? FROM t.vec').run(off, project);
      db.prepare('INSERT INTO vech SELECT node + ?, v, ? FROM t.vech').run(off, project);
      db.prepare('INSERT INTO vecc SELECT label, v, ? FROM t.vecc').run(project);
      db.prepare('INSERT INTO df SELECT word, kind, n, ? FROM t.df').run(project);
      db.prepare('INSERT INTO df2 SELECT word, n, ? FROM t.df2').run(project);
      db.prepare('INSERT INTO comm SELECT id, name, size, ? FROM t.comm').run(project);
      db.prepare('INSERT INTO meta SELECT k, v, ? FROM t.meta').run(project);
      if (mkKey) {   // learning belongs to Makillez: drop links whose neurons are gone or have faded
        const before = db.prepare('SELECT COUNT(*) AS c FROM learn').get().c, now = Date.now();
        db.exec('DELETE FROM learn WHERE ka NOT IN (SELECT key FROM nodes) OR kb NOT IN (SELECT key FROM nodes)');
        for (const r of db.prepare('SELECT ka, kb, w, t FROM learn').all()) if (effective(r.w, r.t, now) < LEARN_PRUNE) db.prepare('DELETE FROM learn WHERE ka = ? AND kb = ?').run(r.ka, r.kb);
        out.kept = db.prepare('SELECT COUNT(*) AS c FROM learn').get().c; out.dropped = before - out.kept;
        out.sessions = db.prepare('SELECT COUNT(*) AS c FROM last').get().c;
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* nothing open */ } throw e; }
    db.exec('DETACH DATABASE t');
  } finally { try { db.close(); } catch { /* closed */ } }
  fs.rmSync(tmp, { force: true });
  return out;
}

const openRw = (home) => { const db = new (sqlite())(dbFile(home)); db.exec('PRAGMA busy_timeout = 2000'); return db; };

// Called by the hook after a map was shown: remember this prompt's strongest seeds for this session.
function remember(home, session, res, now = Date.now()) {
  if (!session || !res || !res.seedKeys || !res.seedKeys.length || (res.project && res.project !== 'makillez')) return false;   // only Makillez learns from use
  let db; try { db = openRw(home); } catch { return false; }
  try { db.prepare('INSERT OR REPLACE INTO last VALUES(?,?,?,?)').run(session, now, JSON.stringify(res.seedKeys), '[]'); return true; } catch { return false; } finally { try { db.close(); } catch { /* closed */ } }
}

// Called when a file was opened or edited (PostToolUse). If a map was shown for this session within LEARN_WINDOW_MS, the prompt's
// strongest seeds are linked to the file's main types. Each file counts once per map. Returns { learned } or { ignored: why }.
function touched(home, session, file, opts = {}) {
  const now = opts.now ?? Date.now();
  const p = String(file || '').replace(/\\/g, '/'), i = p.toLowerCase().indexOf('/src/');
  if (!session || i < 0) return { ignored: 'not a file under src' };
  const rel = p.slice(i + 5);
  let db; try { db = openRw(home); } catch { return { ignored: 'no map' }; }
  try {
    const row = db.prepare('SELECT t, seeds, done FROM last WHERE session = ?').get(session);
    if (!row || now - row.t > LEARN_WINDOW_MS) return { ignored: 'no recent map' };
    const done = JSON.parse(row.done || '[]');
    if (done.includes(rel)) return { ignored: 'already counted' };
    const base = path.basename(rel).replace(/\.[^.]+$/, '');
    const targets = db.prepare("SELECT key, label FROM nodes WHERE project = 'makillez' AND kind = 'code' AND file = ? AND deg <= ? ORDER BY (label = ?) DESC, deg DESC LIMIT 12").all(rel, HUB, base)
      .filter((n) => !n.label.startsWith('.') && n.label.length >= 4 && !GENERIC.has(n.label)).slice(0, LEARN_TARGETS);
    if (!targets.length) return { ignored: 'file not in the map' };
    const inFile = new Set(db.prepare("SELECT key FROM nodes WHERE project = 'makillez' AND file = ?").all(rel).map((r) => r.key));
    const seeds = JSON.parse(row.seeds).filter(([k]) => !inFile.has(k)).slice(0, LEARN_SEEDS);
    const get = db.prepare('SELECT w, n, t FROM learn WHERE ka = ? AND kb = ?'), put = db.prepare('INSERT OR REPLACE INTO learn VALUES(?,?,?,?,?)');
    let learned = 0;
    db.exec('BEGIN');
    for (const [sk, act] of seeds) for (const t of targets) {
      const [ka, kb] = sk < t.key ? [sk, t.key] : [t.key, sk], cur = get.get(ka, kb);
      const w0 = cur ? effective(cur.w, cur.t, now) : 0;
      put.run(ka, kb, Math.min(LEARN_MAX, w0 + LEARN_RATE * act * (1 - w0 / LEARN_MAX)), (cur ? cur.n : 0) + 1, now);
      learned++;
    }
    done.push(rel);
    db.prepare('UPDATE last SET done = ? WHERE session = ?').run(JSON.stringify(done), session);
    db.exec('COMMIT');
    return { learned, file: rel, targets: targets.map((t) => t.label) };
  } catch { try { db.exec('ROLLBACK'); } catch { /* none */ } return { ignored: 'error' }; } finally { try { db.close(); } catch { /* closed */ } }
}

function learnShow(home, limit = 15, now = Date.now()) {
  const db = new (sqlite())(dbFile(home), { readOnly: true });
  try {
    const rows = db.prepare('SELECT l.ka, l.kb, l.w, l.n, l.t, a.label AS la, a.section AS sa, a.file AS fa, b.label AS lb, b.file AS fb FROM learn l LEFT JOIN nodes a ON a.key = l.ka LEFT JOIN nodes b ON b.key = l.kb').all()
      .map((r) => ({ ...r, eff: effective(r.w, r.t, now) })).filter((r) => r.eff >= LEARN_PRUNE).sort((x, y) => y.eff - x.eff);
    const name = (l, s, f) => (l && l.startsWith('doc ') ? `${l} > ${s || f}` : `${l} (${f})`);
    return { total: rows.length, lines: rows.slice(0, limit).map((r) => `${r.eff.toFixed(2)} (x${r.n})  ${name(r.la, r.sa, r.fa)}  <->  ${name(r.lb, '', r.fb)}`) };
  } finally { db.close(); }
}

function learnReset(home) {
  const db = openRw(home);
  try { const n = db.prepare('SELECT COUNT(*) AS c FROM learn').get().c; db.exec('DELETE FROM learn; DELETE FROM last;'); return n; } finally { db.close(); }
}

// Is the map as new as the graph and the docs? Reads only the last bytes of graph.json (that is where built_at_commit is).
function status(home = homeDir(), project = 'makillez') {
  const root = docsRoot(project), out = { stale: stale(home, project), root };
  try {
    const db = new (sqlite())(dbFile(home, project), { readOnly: true });
    try {
      const m = Object.fromEntries(db.prepare('SELECT k, v FROM meta WHERE project = ?').all(project).map((r) => [r.k, r.v]));
      Object.assign(out, { mapCommit: m.commit, built: Number(m.built), nCode: Number(m.nCode), nDoc: Number(m.nDoc), learned: db.prepare('SELECT COUNT(*) AS c FROM learn').get().c });
    } finally { db.close(); }
  } catch { out.mapCommit = null; }
  try { // graphify writes built_at_commit as the last key, so the last 400 bytes are enough (the file is ~90 MB)
    const f = path.join(root, 'graphify-out', 'graph.json'), size = fs.statSync(f).size, n = Math.min(400, size), b = Buffer.alloc(n), fd = fs.openSync(f, 'r');
    try { fs.readSync(fd, b, 0, n, size - n); } finally { fs.closeSync(fd); }
    out.graphCommit = (b.toString('utf8').match(/"built_at_commit"\s*:\s*"([0-9a-f]{7,40})"/) || [])[1] || null;
  } catch { out.graphCommit = null; }
  try { out.lastUpdateCommit = fs.readFileSync(path.join(root, '.last_update_commit'), 'utf8').trim(); } catch { out.lastUpdateCommit = null; }
  return out;
}

// What the map was built from: the graph file and every technical doc. Cheap to compare (a few stat calls).
function sources(root) {
  const st = (f) => { try { const s = fs.statSync(f); return `${Math.round(s.mtimeMs)}:${s.size}`; } catch { return 'none'; } };
  return { graph: st(path.join(root, 'graphify-out', 'graph.json')), docs: listDocs(root).map((f) => path.relative(root, f).replace(/\\/g, '/') + '@' + st(f)).join('|') };
}

function stale(home = homeDir(), project = 'makillez') { // true when there is no map, or a doc or the graph changed since it was built
  try {
    const db = new (sqlite())(dbFile(home, project), { readOnly: true });
    try {
      const m = Object.fromEntries(db.prepare('SELECT k, v FROM meta WHERE project = ?').all(project).map((r) => [r.k, r.v]));
      if (!m.root) return project === 'makillez' ? fs.existsSync(path.join(docsRoot(), 'graphify-out', 'graph.json')) : false;   // this project has no rows yet
      return Number(m.version) !== DB_VERSION || m.stamp !== JSON.stringify(sources(m.root));
    } finally { db.close(); }
  } catch { return project === 'makillez' ? fs.existsSync(path.join(docsRoot(), 'graphify-out', 'graph.json')) : false; }   // the other projects are built on request, so no map is not "stale"
}

// ---- firing ----
function expand(q, groups) {
  const m = new Map([...q].map((t) => [t, 1]));
  for (const g of groups) if (g.some((t) => q.has(t))) for (const t of g) if (!m.has(t)) m.set(t, THESAURUS_WEIGHT);
  return m;
}

// Returns { docs, code, comms, commit, built } or null. `pv` is the prompt's meaning vector (optional).
function search(home, text, opts = {}) {
  let db;
  const project = opts.project || 'makillez';
  try { db = new (sqlite())(dbFile(home, project), { readOnly: true }); } catch { return null; }
  try {
    const meta = Object.fromEntries(db.prepare('SELECT k, v FROM meta WHERE project = ?').all(project).map((r) => [r.k, r.v]));
    if (Number(meta.version) !== DB_VERSION) return null;
    const q = words(text);
    if (!q.size) return null;
    const qw = expand(q, opts.thesaurus || loadThesaurus().concat(mkSynonyms()));
    for (const [w, wt] of [...qw]) qw.set('#' + w, wt);            // every question word also looks at section headings
    const N = { doc: Number(meta.nDoc), code: Number(meta.nCode) };
    // 1. seeds by words: every query word fires the neurons that hold it
    const score = new Map(), hit = new Map(), strong = new Set(), kindOf = new Map(), hscore = new Map(), simOf = new Map(), hsimOf = new Map();
    const dfq = db.prepare('SELECT kind, n FROM df WHERE word = ? AND project = ?'), post = db.prepare('SELECT k.node AS node, n.kind AS kind, n.nkw AS nkw, n.deg AS deg, n.label AS label FROM kw k JOIN nodes n ON n.id = k.node WHERE k.word = ? AND k.project = ?');
    for (const [w, wt] of qw) {
      const dfs = Object.fromEntries(dfq.all(w, project).map((r) => [r.kind, r.n]));
      if (!Object.keys(dfs).length) continue;
      for (const r of post.all(w, project)) {
        const idf = Math.log(1 + N[r.kind] / (dfs[r.kind] || 1));
        kindOf.set(r.node, [r.kind, r.nkw, r.deg]);
        score.set(r.node, (score.get(r.node) || 0) + idf * wt);
        if (w[0] === '#') { hscore.set(r.node, (hscore.get(r.node) || 0) + idf * wt); continue; }   // a heading hit only adds score: it is the same word again, so it is not a second word and never "strong"
        hit.set(r.node, (hit.get(r.node) || 0) + 1);
        if (wt === 1 && w.length >= 8 && idf >= 3.5) strong.add(r.node);
        else if (wt === 1 && r.kind === 'code' && r.label.toLowerCase() === w && /^[A-Z]/.test(r.label) && w.length >= 5 && idf >= 3.2) strong.add(r.node); // the question names a class exactly (Ticket): one word is enough
      }
    }
    const seeds = new Map();
    for (const [id, s] of score) {
      const [kind, nkw, deg] = kindOf.get(id);
      if (kind === 'code' && deg > SEED_HUB) continue;
      if (!((hit.get(id) >= 2 && s >= MIN_SCORE) || strong.has(id))) continue;
      seeds.set(id, { kind, s: s / WORD_SCALE / Math.sqrt(Math.max(nkw, 8) / 8) });
    }
    // 2. seeds by meaning: doc chunks that are close in meaning to the prompt
    if (opts.pv) {
      const floor = opts.simFloor ?? SIM_FLOOR, span = opts.simSpan ?? SIM_SPAN, simGate = opts.simGate ?? SIM_GATE;   // opts only for experiments with other models (see eval-model.js)
      for (const r of db.prepare('SELECT node, v FROM vec WHERE project = ?').all(project)) {
        const v = f32(r.v);
        if (v.length !== opts.pv.length) break;
        let sim = 0; for (let i = 0; i < v.length; i++) sim += v[i] * opts.pv[i];
        simOf.set(r.node, sim);
        if (sim < simGate && !seeds.has(r.node)) continue;
        const s = Math.min(Math.max((sim - floor) / span, 0), 1);
        if (s > 0) { const o = seeds.get(r.node) || { kind: 'doc', s: 0 }; o.s += s; seeds.set(r.node, o); }
      }
    }
    // 2b. a question that closely matches a section title is enough on its own (unrelated questions never come close: the highest measured was 0.47)
    if (opts.pv && project !== 'tech') {   // not for the tech docs: reading every heading number of 85,000 chunks costs a second; their candidates get their heading number further down
      try {
        const rescue = Math.max(0, ...[...seeds.values()].map((o) => o.s)) < (opts.gate ?? GATE);   // only when the gate would say no: otherwise these seeds would only disturb a good ranking
        for (const r of db.prepare('SELECT node, v FROM vech WHERE project = ?').all(project)) {
          const v = f32(r.v); if (v.length !== opts.pv.length) break;
          let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * opts.pv[i];
          hsimOf.set(r.node, s);
          if (rescue && s >= (opts.headGate ?? HEAD_GATE)) { const o = seeds.get(r.node) || { kind: 'doc', s: 0 }; o.s += Math.min(1, (s - SIM_FLOOR) / SIM_SPAN); seeds.set(r.node, o); }
        }
      } catch { /* a map without heading numbers */ }
    }
    // 2c. the question index (dq.js): the best-matching of the few questions written for each section (a map without the index works as before)
    const qsimOf = new Map();
    if (opts.pv && project === 'makillez' && !opts.noDq) {
      try {
        const Q = require('./dq.js').load(home);
        if (Q && Q.dim === opts.pv.length) {
          const idOfKey = new Map(db.prepare("SELECT id, key FROM nodes WHERE kind = 'doc' AND project = ?").all(project).map((r) => [r.key, r.id]));
          for (let i = 0; i < Q.keys.length; i++) {
            const id = idOfKey.get(Q.keys[i]); if (!id) continue;
            let s = 0; const o = i * Q.dim; for (let j = 0; j < Q.dim; j++) s += Q.vecs[o + j] * opts.pv[j];
            if (s > (qsimOf.get(id) ?? -1)) qsimOf.set(id, s);
          }
          const rescue = Math.max(0, ...[...seeds.values()].map((o) => o.s)) < (opts.gate ?? GATE);
          if (rescue) for (const [id, s] of qsimOf) if (s >= (opts.qGate ?? Q_GATE)) { const o = seeds.get(id) || { kind: 'doc', s: 0 }; o.s += Math.min(1, (s - SIM_FLOOR) / SIM_SPAN); seeds.set(id, o); }
        }
      } catch { /* no question index */ }
    }
    if (!seeds.size) return null;
    // the best seed must be clearly matched, or the prompt is not about this system
    const best = Math.max(0, ...[...seeds.values()].map((o) => o.s));
    if (best < (opts.gate ?? GATE)) return null;     // on the ~160 questions of eval-mk.js, Makillez questions score 0.55 to over 2, unrelated ones 0 to 0.7; a missing map costs more than an extra one
    const act = new Map();
    for (const kind of ['doc', 'code']) {
      const t = [...seeds].filter(([, o]) => o.kind === kind).sort((a, b) => b[1].s - a[1].s).slice(0, kind === 'doc' ? SEED_DOCS : SEED_CODE);
      const max = t.length ? t[0][1].s : 1;
      for (const [id, o] of t) act.set(id, o.s / max);
    }
    const nSeeds = act.size;
    // what to remember for learning: this prompt's strongest seeds, by stable key
    const now = opts.now ?? Date.now(), keyOf = db.prepare('SELECT key FROM nodes WHERE id = ?');
    const seedKeys = [...act].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, a]) => [keyOf.get(id).key, Math.round(a * 100) / 100]);
    // learned links, both directions, already faded by age; they only help to spread, never to start a search
    const learned = new Map();
    if (opts.learn !== false) {
      try {
        const add = (a, b, w) => (learned.get(a) || learned.set(a, []).get(a)).push([b, w]);
        for (const r of db.prepare('SELECT a.id AS a, b.id AS b, l.w AS w, l.t AS t FROM learn l JOIN nodes a ON a.key = l.ka JOIN nodes b ON b.key = l.kb WHERE l.n >= ?').all(LEARN_MIN_N)) { // one stray file open is a coincidence, not yet a habit
          const w = effective(r.w, r.t, now);
          if (w >= LEARN_PRUNE) { add(r.a, r.b, w); add(r.b, r.a, w); }
        }
      } catch { /* a map from before learning existed: no learned links */ }
    }
    // 3. spreading: a few steps; hubs receive little and do not pass it on; each step keeps only the strongest neurons
    const degOf = db.prepare('SELECT deg FROM nodes WHERE id = ?'), out = db.prepare('SELECT b, w FROM edges WHERE a = ?');
    const degCache = new Map();
    const dg = (id) => { if (!degCache.has(id)) degCache.set(id, degOf.get(id)?.deg ?? 0); return degCache.get(id); };
    const learnedIn = new Map();
    for (let r = 0; r < ROUNDS; r++) {
      const front = [...act].filter(([id]) => dg(id) <= HUB).sort((a, b) => b[1] - a[1]).slice(0, FRONTIER);
      const inflow = new Map(), viaLearned = new Map();
      for (const [u, au] of front) {
        for (const e of out.all(u)) inflow.set(e.b, (inflow.get(e.b) || 0) + au * e.w * DECAY / Math.sqrt(1 + dg(e.b)));
        for (const [b, w] of learned.get(u) || []) viaLearned.set(b, (viaLearned.get(b) || 0) + au * w * LEARN_GAIN / Math.sqrt(1 + dg(b)));
      }
      // learned light is capped per neuron (45% of the strongest unlearned activation): many seeds pointing at one learned file must never outshine what words and meaning found
      let topFree = 0;                                   // the strongest activation that did not come from learning
      for (const [id, a] of act) topFree = Math.max(topFree, a - (learnedIn.get(id) || 0));
      for (const [b, f] of viaLearned) {
        const room = LEARN_CAP * topFree - (learnedIn.get(b) || 0), add = Math.min(f, room);
        if (add > 0) { learnedIn.set(b, (learnedIn.get(b) || 0) + add); inflow.set(b, (inflow.get(b) || 0) + add); }
      }
      for (const [id, f] of inflow) act.set(id, (act.get(id) || 0) + f);
      if (act.size > FRONTIER * 4) { const keep = [...act].sort((a, b) => b[1] - a[1]).slice(0, FRONTIER * 4); act.clear(); for (const [id, a] of keep) act.set(id, a); }
    }
    // 4. read the strongest neurons of each layer
    const info = db.prepare('SELECT * FROM nodes WHERE id = ?');
    const ranked = [...act].sort((a, b) => b[1] - a[1]);
    // code: one type per file first (a class, interface or record), methods and file nodes only when too few types fire
    let docs = [], seen = new Map(), types = [], extra = [], files = new Set();
    const shown = new Set();
    for (const [id, a] of ranked) {
      const n = info.get(id); if (!n) continue;
      if (n.kind === 'doc') {
        if (docs.length >= MAX_DOCS || (seen.get(n.file) || 0) >= 2 || (docs.length && a < docs[0].a * 0.3)) continue;
        seen.set(n.file, (seen.get(n.file) || 0) + 1); docs.push({ a, n });
      } else {
        if (n.deg > HUB || !n.file || n.label.length < 4 || GENERIC.has(n.label) || shown.has(n.label)) continue; // framework names say nothing; one result per name (the graph keeps a stub node per referencing file)
        shown.add(n.label);
        const isFile = n.label.toLowerCase() === path.basename(n.file).toLowerCase(), isMethod = n.label.startsWith('.');
        if (isFile || isMethod) { if (extra.length < MAX_CODE) extra.push({ a, n }); continue; }
        if (files.has(n.file) || types.length >= MAX_CODE || (types.length && a < types[0].a * 0.3)) continue;
        files.add(n.file); types.push({ a, n });
      }
    }
    let code = types.length >= 3 ? types : types.concat(extra.filter((e) => !files.has(e.n.file)).slice(0, 3 - types.length));
    // code-name pass: a type whose name families cover (nearly) every known word of the question. It only adds to the code list; it never starts or feeds the spreading above.
    {
      const fam = [...families(text, CODE_FILLER)], idf2 = new Map(), nCode = N.code;
      const d2 = db.prepare('SELECT n FROM df2 WHERE word = ? AND project = ?');
      for (const f of fam) { const r = d2.get(f, project); if (r) idf2.set(f, Math.log(1 + nCode / r.n)); }
      const total = [...idf2.values()].reduce((s, v) => s + v, 0);
      if (idf2.size >= 2 && total > 0) {
        const per = new Map(), post2 = db.prepare('SELECT k.node AS node, n.label AS label, n.file AS file, n.deg AS deg, n.nkw AS nkw FROM kw2 k JOIN nodes n ON n.id = k.node WHERE k.word = ? AND k.project = ?');
        for (const [f, idf] of idf2) for (const r of post2.all(f, project)) { const o = per.get(r.node) || per.set(r.node, { r, n: 0, s: 0 }).get(r.node); o.n++; o.s += idf; }
        const pickF = new Set(), extraCode = [];
        const named = [...per.values()].filter((o) => o.n >= 2 && o.s / total >= 0.6 && o.r.file && o.r.deg <= SEED_HUB && o.r.label.length >= 4 && !GENERIC.has(o.r.label) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(o.r.label) && o.r.label.toLowerCase() !== path.basename(o.r.file).toLowerCase())
          .sort((a, b) => (b.s / total) - (a.s / total) || b.s / Math.sqrt(b.r.nkw) - a.s / Math.sqrt(a.r.nkw));
        for (const o of named) {
          if (pickF.has(o.r.file) || extraCode.some((e) => e.n.label === o.r.label)) continue;
          if (extraCode.length >= 3) break;
          pickF.add(o.r.file);
          const old = code.find((c) => c.n.id === o.r.node || (c.n.label === o.r.label && c.n.file === o.r.file));
          const n = old ? old.n : info.get(Number(o.r.node));
          if (n) extraCode.push({ a: old ? old.a : 0, n });   // a result the search already had keeps its place at the front; it is moved up, not dropped
        }
        const front = new Set(extraCode.map((e) => e.n.id));
        code = [...extraCode, ...code.filter((c) => !front.has(c.n.id))].slice(0, MAX_CODE);
      }
      // meaning of class names: names read as words that are close to the question (only the one or two clearly closest)
      if (opts.pv) {
        const T = opts.codeSim ?? CODE_SIM, near = [];
        try {
          for (const r of db.prepare('SELECT label, v FROM vecc WHERE project = ?').all(project)) {
            const v = f32(r.v); if (v.length !== opts.pv.length) break;
            let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * opts.pv[i];
            if (s >= T) near.push([r.label, s]);
          }
        } catch { /* a map without class-name numbers */ }
        near.sort((a, b) => b[1] - a[1]);
        const byLabel = db.prepare("SELECT id FROM nodes WHERE kind = 'code' AND label = ? AND file != '' AND project = ? ORDER BY deg DESC LIMIT 1");
        const add = [];
        for (const [label, s] of near.slice(0, 2)) {
          if (s < near[0][1] - 0.05) continue;
          const row = byLabel.get(label, project), n = row && info.get(row.id);
          if (n && n.deg <= SEED_HUB) add.push({ a: s, n });
        }
        if (add.length) { const front2 = new Set(add.map((e) => e.n.id)); const keep = code.filter((c) => !front2.has(c.n.id)); code = [...keep.slice(0, 1), ...add, ...keep.slice(1)].slice(0, MAX_CODE); }
      }
    }
    // doc ranking: a few signals per candidate section, combined with weights learned from written-down questions (rank.json, made by train-rank.js)
    let feat;
    const W = opts.rankW === undefined ? loadRank() : opts.rankW;
    if (opts.pv && (W || opts.feat)) {
      try {
        const isDoc = (id) => (info.get(id) || {}).kind === 'doc';
        const topIds = (m, k, f = (x) => x) => [...m].sort((a, b) => f(b[1]) - f(a[1])).slice(0, k).map(([id]) => id);
        const wOnly = new Map(); for (const [id, s] of score) if ((kindOf.get(id) || [])[0] === 'doc') wOnly.set(id, s - (hscore.get(id) || 0));
        const pool = new Set([...ranked.filter(([id]) => isDoc(id)).slice(0, 40).map(([id]) => id), ...topIds(wOnly, 15), ...topIds(simOf, 15), ...topIds(hsimOf, 10), ...topIds(qsimOf, 15)]);
        if (project === 'tech') {   // heading meaning for the candidates only
          const one = db.prepare('SELECT v FROM vech WHERE node = ?');
          for (const id of pool) { const r = one.get(id); if (r) { const v = f32(r.v); let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * opts.pv[i]; hsimOf.set(id, s); } }
        }
        const plain = [...qw].filter(([w, wt]) => w[0] !== '#' && wt === 1).map(([w]) => w), idfD = new Map();
        for (const w of plain) { const r = dfq.all(w, project).find((x) => x.kind === 'doc'); if (r) idfD.set(w, Math.log(1 + N.doc / r.n)); }
        const total = [...idfD.values()].reduce((s, v) => s + v, 0) || 1;
        const kwOf = db.prepare('SELECT word FROM kw WHERE node = ?'), fileOf = db.prepare("SELECT MIN(id) AS m, COUNT(*) AS c FROM nodes WHERE file = ? AND kind = 'doc' AND project = ?"), fcache = new Map();
        const metaQ = [...families(text)].some((f) => META_Q.has(f));   // the question is about problems, drift or gaps: the findings and backlog docs are the place
        const rows = [...pool].map((id) => {
          const n = info.get(id), ws = new Set(kwOf.all(id).map((r) => r.word));
          let cov = 0, hcov = 0, mc = 0; for (const [w, idf] of idfD) { if (ws.has(w)) { cov += idf; mc++; } if (ws.has('#' + w)) hcov += idf; }
          const fi = fcache.get(n.file) || fcache.set(n.file, fileOf.get(n.file, project)).get(n.file);
          const meta = /\/(10-findings|19-known-unfixed-bugs|20-improvement-suggestions|09-repo-metrics)\.md$/.test(n.file) ? 1 : 0, nonDev = /for-non-dev\//.test(n.file) || /\/README\.md$/.test(n.file) ? 1 : 0;
          return { id, n, f: [act.get(id) || 0, wOnly.get(id) || 0, hscore.get(id) || 0, (simOf.get(id) ?? 0.3) - 0.3, (hsimOf.get(id) ?? 0.3) - 0.3, cov / total, hcov / total, Math.log(1 + fi.c) / 5, id === fi.m ? 1 : 0, (n.section || '').split(' > ').length / 4, 0, 0, 0, meta, nonDev, 0, mc / Math.sqrt(Math.max(ws.size, 4)) * 3, 0, 0, metaQ && meta ? 1 : 0, CORE_DOC.test(n.file) ? 1 : 0, (qsimOf.get(id) ?? 0.3) - 0.3, 0] };
        });
        const mx = [0, 1, 2].map((k) => Math.max(1e-9, ...rows.map((r) => r.f[k])));
        for (const r of rows) for (const k of [0, 1, 2]) r.f[k] /= mx[k];
        const top = (k) => Math.max(...rows.map((r) => r.f[k])), tS = top(3), tH = top(4), tC = top(5), secMax = new Map();
        for (const r of rows) { const key = r.n.file + '::' + r.n.section; secMax.set(key, Math.max(secMax.get(key) ?? -1, r.f[3])); }
        const fileSim = new Map(), fileWord = new Map();   // file-level evidence: the best meaning and the total word score of the file's candidate chunks
        for (const r of rows) { fileSim.set(r.n.file, Math.max(fileSim.get(r.n.file) ?? -1, r.f[3])); fileWord.set(r.n.file, (fileWord.get(r.n.file) || 0) + r.f[1]); }
        const fwMax = Math.max(1e-9, ...fileWord.values()), fsMax = Math.max(...fileSim.values());
        for (const r of rows) { r.f[17] = fileSim.get(r.n.file) - fsMax; r.f[18] = fileWord.get(r.n.file) / fwMax; }
        const tQ = Math.max(...rows.map((r) => r.f[21])); for (const r of rows) r.f[22] = r.f[21] - tQ;   // question meaning vs the best
        for (const r of rows) { r.f[10] = r.f[3] - tS; r.f[11] = r.f[4] - tH; r.f[12] = r.f[5] - tC; r.f[15] = secMax.get(r.n.file + '::' + r.n.section); }
        if (opts.feat) feat = rows.map((r) => ({ n: r.n, f: r.f }));
        if (W) {
          for (const r of rows) r.z = r.f.reduce((s, v, i) => s + v * (W[i] || 0), 0);
          rows.sort((a, b) => b.z - a.z);
          const picked = [], per = new Map(), secs = new Set();   // at most 2 per file and 1 per section: two chunks of one section waste a slot
          for (const r of rows) { const sk = r.n.file + '::' + r.n.section; if (picked.length >= MAX_DOCS || secs.has(sk) || (per.get(r.n.file) || 0) >= 2 || r.z < rows[0].z - 3) continue; secs.add(sk); per.set(r.n.file, (per.get(r.n.file) || 0) + 1); picked.push({ a: r.z, n: r.n }); }
          if (picked.length) docs = picked;
        }
      } catch { /* keep the plain ranking */ }
    }
    if (!docs.length && !code.length) return null;
    return { project, docs, code, commit: meta.commit, built: Number(meta.built), seeds: nSeeds, best, seedKeys, learned: learned.size, feat };
  } catch { return null; } finally { try { db.close(); } catch { /* already closed */ } }
}

// Which project does a prompt belong to? Every project is asked; score = best match + a prior for Makillez (the default; the ESG docs copy its layout, so generic prompts match both)
// + a bonus for a project named in the prompt (a bonus, not a rule: the Makillez docs about AIPO also say "aipo") + a small bonus for the working folder. The highest score wins.
// The numbers come from an offline search over 487 written questions: 98.6% routed to the right project (makillez 99.1%, esg 88.5%, aipo 100%; no priors at all: 88%, aipo 13%). The general tech docs are only a fallback: they are the slowest to search and the least specific.
function searchAll(home, text, opts = {}) {
  const lc = String(text || '').toLowerCase(), cwd = String(opts.cwd || '').toLowerCase();
  const named = ['makillez', 'esg', 'aipo'].filter((p) => new RegExp(`\\b${p}\\b`).test(lc));
  const hits = [];
  for (const p of ['makillez', 'esg', 'aipo']) {
    const r = search(home, text, { ...opts, project: p, learn: p === 'makillez' ? opts.learn : false });
    if (r) hits.push({ r, score: r.best + (p === 'makillez' ? ROUTE_PRIOR : 0) + (named.includes(p) ? ROUTE_NAMED : 0) + (cwd.includes(p) || (p === 'makillez' && cwd.includes('metizoft')) ? 0.3 : 0) });
  }
  hits.sort((a, b) => b.score - a.score);
  const top = hits[0], also = [];
  if (top && hits[1] && hits[1].score >= top.score - ALSO_CLOSE) also.push(hits[1].r);   // a close call: the second project gets a short block too
  // The general tech docs: the fallback when no project answers, and a short extra block when the project's own answer is weak and the tech docs are clearly stronger.
  // A words-only look costs 0.3 s; the meaning scan of the tech chunks about 1 s, so it only runs when the project is weak and the words already match something.
  if (!top || top.r.best < TECH_IF_WEAKER_THAN) {
    const probe = search(home, text, { ...opts, pv: null, gate: 0, project: 'tech', learn: false });
    if (probe && probe.best >= (top ? TECH_PROBE_WITH_PROJECT : TECH_PROBE_ALONE)) {
      const t = search(home, text, { ...opts, gate: TECH_GATE, project: 'tech', learn: false });
      if (t && !top) { t.also = []; return t; }
      if (t && t.best >= top.r.best + TECH_FIRST) { t.also = [top.r, ...also]; return t; }   // the tech docs are far stronger than a weak project match: they lead
      if (t && t.best >= top.r.best + TECH_MARGIN) also.push(t);
    }
  }
  if (!top) return null;
  top.r.also = also;
  return top.r;
}

function format(res, lim = {}) {   // lim: a shorter block (max characters, number of docs and code lines) for a second project
  if (!res) return '';
  const pj = res.project || 'makillez', pn = (PROJECTS[pj] || PROJECTS.makillez).name;
  let out = pj === 'tech'
    ? `Tech docs (general programming and architecture, from public docs; built ${new Date(res.built).toISOString().slice(0, 10)}; background reading, not a rule of this repo):\n`
    : `${pn} map (spreading search over technical-docs + code graph${res.commit ? ' @' + res.commit.slice(0, 8) : ''}, built ${new Date(res.built).toISOString().slice(0, 10)}; start here, then confirm in the code, the map can be old):\n`;
  const add = (s) => { if (out.length + s.length + 1 <= (lim.max ?? MAX_CHARS)) out += s + '\n'; };
  for (const d of res.docs.slice(0, lim.docs ?? 99)) add(`- doc ${d.n.file.replace(/^technical-docs\//, '')} > ${d.n.section || '(top)'}: ${d.n.text.length > DOC_CHARS ? d.n.text.slice(0, DOC_CHARS) + '...' : d.n.text}`);
  for (const c of res.code.slice(0, lim.code ?? 99)) add(`- code ${c.n.label} (${c.n.file}${c.n.loc ? ':' + c.n.loc.replace(/^L/, '') : ''})`);
  if (!lim.max) for (const a of res.also || []) out += format(a, { max: ALSO_CHARS, docs: 2, code: 2 });   // a second project: short
  return out;
}

module.exports = { PROJECTS, dbFile, docsRoot, build, stale, search, searchAll, format, chunkDoc, words, sources, remember, touched, learnShow, learnReset, status, effective };
