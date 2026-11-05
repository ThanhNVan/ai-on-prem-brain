// Rules graph: turn ~/.claude rules and memory into graph.json, then score its nodes by words and synonyms (no model needed).
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_NODES = 6, MIN_SCORE = 2.5, STALE_DAYS = 30, DECAY = 0.4, MIN_RATIO = 0.35;
const WORD_SCALE = 12, THESAURUS_WEIGHT = 0.5;                       // word score = idf sum / 12; synonyms count half
const STOP = new Set('the and for with that this from have has not are was were you your use used using when what how why into out all any can will but its per via then than also only one two new does did they them there here about after before should would could just very more most some such like make made need needs file run line step write each read work first say edit path word user check'.split(' '));
const GRAPH_VERSION = 3; // bump when the way words are cut changes (STOP, stem, tokens): old graph.json files are then rebuilt
const SECRET = /\b(key|token|secret|password)\b.*[A-Za-z0-9_-]{24,}/i; // a line that looks like it holds a key is never stored

const homeDir = () => process.env.BRAIN_HOME || path.join(os.homedir(), '.claude');
const graphFile = (home) => path.join(home, 'brain', 'graph.json');
const dataDir = (home) => path.join(home, 'brain', 'data');
function writeAtomic(file, text) { // write to a temp name, then rename: a reader never sees half a file
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try { fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}
const stem = (w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

function tokens(text) {
  const t = text.toLowerCase(), out = new Set();
  for (const w of t.split(/[^a-z0-9]+/)) if (w.length >= 3 && !STOP.has(w)) out.add(stem(w));
  for (const w of t.match(/[a-z0-9_.-]{5,}/g) || []) {
    const c = w.replace(/^[-.]+|[-.]+$/g, '');
    if (/[-.]/.test(c)) out.add(c);
  }
  return out;
}
const spans = (text) => [...text.matchAll(/`([^`]{2,60})`/g)].map((m) => m[1].toLowerCase().trim());

function sources(home) {
  const list = [];
  for (const f of ['CLAUDE.md', 'preferences.md']) if (fs.existsSync(path.join(home, f))) list.push({ rel: f, abs: path.join(home, f), note: false });
  const proj = path.join(home, 'projects');
  if (fs.existsSync(proj)) {
    for (const p of fs.readdirSync(proj)) {
      const mem = path.join(proj, p, 'memory');
      if (!fs.existsSync(mem)) continue;
      for (const f of fs.readdirSync(mem)) if (f.endsWith('.md') && f !== 'MEMORY.md') list.push({ rel: `memory/${f}`, abs: path.join(mem, f), note: true });
    }
  }
  return list;
}

// Split one markdown file into blocks: a bullet (with its continuation lines) or a paragraph.
function blocks(body) {
  const out = [];
  let section = '', cur = null, fence = false;
  const flush = () => { if (cur) out.push({ section, text: cur.replace(/\s+/g, ' ').trim() }); cur = null; };
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { flush(); fence = !fence; continue; }
    if (fence) continue;
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { flush(); section = h[1].trim(); continue; }
    if (!line.trim()) { flush(); continue; }
    const b = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (b) { flush(); cur = b[1]; } else if (cur !== null) cur += ' ' + line.trim(); else cur = line.trim();
  }
  flush();
  return out.filter((b) => b.text.length >= 12);
}

function build(home = homeDir()) {
  const nodes = [], built = Date.now(), mtimes = {}, replaced = new Map(), names = new Set(), warnings = [];
  let expires = 0; // earliest future valid-until date: after it the graph must be rebuilt
  for (const s of sources(home)) {
    const stat = fs.statSync(s.abs);
    mtimes[s.abs] = stat.mtimeMs;
    let raw = fs.readFileSync(s.abs, 'utf8'), name = '', type = '';
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (fm) {
      name = (fm[1].match(/^name:\s*(.+)$/m) || [])[1] || '';
      type = (fm[1].match(/^\s*type:\s*(\w+)/m) || [])[1] || '';
      raw = raw.slice(fm[0].length);
      // optional header lines: "valid-until: YYYY-MM-DD" drops the note after that day; "supersedes: <note name>" drops the older note
      names.add(name.trim());
      const rawUntil = ((fm[1].match(/^\s*valid-until:\s*(.+)$/m) || [])[1] || '').replace(/['"]/g, '').trim();
      const ms = /^\d{4}-\d{2}-\d{2}$/.test(rawUntil) ? Date.parse(rawUntil) : NaN;
      const until = !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === rawUntil ? ms + 86400000 : NaN; // 2026-02-31 would silently become 3 March
      if (rawUntil && Number.isNaN(until)) warnings.push(`${s.rel}: valid-until "${rawUntil}" is not a real date like 2026-12-31, so the note stays active`);
      if (until <= built) { warnings.push(`${s.rel}: dropped, valid-until ${rawUntil} has passed`); continue; } // an expired note replaces nothing
      if (until > built) expires = expires ? Math.min(expires, until) : until;
      for (const m of fm[1].matchAll(/^\s*supersedes:\s*(.+)$/gm)) replaced.set(m[1].replace(/['"]/g, '').trim(), s.rel);
    }
    const kind = s.note ? (type === 'feedback' ? 'procedural' : 'semantic') : 'procedural';
    const stale = s.note && (built - stat.mtimeMs) / 86400000 > STALE_DAYS;
    for (const b of blocks(raw)) {
      if (SECRET.test(b.text)) continue;
      const section = s.note ? name.trim() : b.section;
      nodes.push({
        id: `${s.rel}#${nodes.length}`, label: b.text.slice(0, 60), file: s.rel, section, text: b.text, kind,
        inContext: s.rel === 'CLAUDE.md', stale: !!stale, kw: [...new Set([...tokens(b.text), ...spans(b.text)])],
      });
    }
  }
  for (const [n, by] of replaced) if (!names.has(n)) warnings.push(`${by}: supersedes "${n}" matches no note name, so nothing was dropped`);
  if (replaced.size) for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].file.startsWith('memory/') && replaced.has(nodes[i].section)) nodes.splice(i, 1);
  const links = [], seen = new Set();
  const link = (a, b, weight) => { const k = a < b ? a + '|' + b : b + '|' + a; if (a !== b && !seen.has(k)) { seen.add(k); links.push({ source: a, target: b, weight }); } };
  const bySection = new Map();
  for (const n of nodes) { const k = n.file + '::' + n.section; (bySection.get(k) || bySection.set(k, []).get(k)).push(n); }
  for (const group of bySection.values()) if (group.length <= 12) for (const a of group) for (const b of group) link(a.id, b.id, 0.5);
  for (const n of nodes) for (const m of n.text.matchAll(/\[\[([^\]]+)\]\]/g)) for (const t of nodes) if (t.file.startsWith('memory/') && t.section === m[1].trim()) link(n.id, t.id, 1);
  const byCode = new Map();
  for (const n of nodes) for (const c of new Set(spans(n.text))) (byCode.get(c) || byCode.set(c, []).get(c)).push(n.id);
  for (const ids of byCode.values()) if (ids.length >= 2 && ids.length <= 6) for (const a of ids) for (const b of ids) link(a, b, 0.8);

  const graph = { directed: false, multigraph: false, graph: { built, mtimes, expires, warnings, version: GRAPH_VERSION }, nodes, links };
  try { writeAtomic(graphFile(home), JSON.stringify(graph)); }
  catch { /* another session is writing the same file right now: use the graph we hold in memory */ }
  return graph;
}

function fresh(home) { // missing, half-written or out-of-date graph.json: rebuild it, never fail
  try {
    const g = JSON.parse(fs.readFileSync(graphFile(home), 'utf8'));
    const now = sources(home);
    if (Array.isArray(g.nodes) && g.graph.version === GRAPH_VERSION && !(g.graph.expires && Date.now() > g.graph.expires) && now.length === Object.keys(g.graph.mtimes).length && now.every((s) => g.graph.mtimes[s.abs] === fs.statSync(s.abs).mtimeMs)) return g;
  } catch { /* fall through to a rebuild */ }
  return build(home);
}

// ---- words and synonyms ----
let thesaurusCache;
function loadThesaurus() { // groups of near-equal words, stemmed like the keywords. Missing or broken file = no synonyms.
  if (!thesaurusCache) {
    try { thesaurusCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'thesaurus.json'), 'utf8')).groups.map((g) => g.map((w) => stem(String(w).toLowerCase()))); }
    catch { thesaurusCache = []; }
  }
  return thesaurusCache;
}

function expand(q, groups) { // prompt words at weight 1, their synonyms at THESAURUS_WEIGHT
  const m = new Map([...q].map((t) => [t, 1]));
  for (const g of groups) if (g.some((t) => q.has(t))) for (const t of g) if (!m.has(t)) m.set(t, THESAURUS_WEIGHT);
  return m;
}

function wordScores(g, text, groups) {
  const q = tokens(text), score = new Map();
  if (!q.size) return score;
  const qw = expand(q, groups), N = g.nodes.length, df = new Map();
  for (const n of g.nodes) for (const k of n.kw) df.set(k, (df.get(k) || 0) + 1);
  const idf = (k) => Math.log(1 + N / (df.get(k) || 1));
  for (const n of g.nodes) {
    let s = 0, c = 0, strong = false;
    for (const k of n.kw) {
      const w = qw.get(k);
      if (!w) continue;
      const i = idf(k);
      s += i * w; c++;
      if (w === 1 && k.length >= 8 && /[-.]/.test(k) && i >= 3) strong = true;
    }
    // long notes match more words by chance, so a short exact rule must not lose to them: shrink the score of notes over 8 keywords
    if ((c >= 2 && s >= MIN_SCORE) || strong) score.set(n.id, s / WORD_SCALE / Math.sqrt(Math.max(n.kw.length, 8) / 8));
  }
  return score;
}

// Spread to linked neighbours, drop inContext nodes, cut the weak tail, cap the count.
function rank(g, score) {
  const adj = new Map();
  for (const l of g.links) { (adj.get(l.source) || adj.set(l.source, []).get(l.source)).push([l.target, l.weight]); (adj.get(l.target) || adj.set(l.target, []).get(l.target)).push([l.source, l.weight]); }
  const total = new Map(score);
  for (const [id, s] of score) for (const [nb, w] of adj.get(id) || []) if (!score.has(nb)) total.set(nb, Math.max(total.get(nb) || 0, s * w * DECAY));
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const ranked = [...total].map(([id, s]) => ({ ...byId.get(id), score: s })).filter((n) => !n.inContext).sort((a, b) => b.score - a.score);
  return ranked.filter((n) => n.score >= ranked[0].score * MIN_RATIO).slice(0, MAX_NODES); // drop weak tail: noise costs tokens
}

function query(home, text, opts = {}) { // words + synonyms only, no model
  const g = fresh(home);
  return rank(g, wordScores(g, text, opts.thesaurus || loadThesaurus()));
}

module.exports = { homeDir, graphFile, dataDir, writeAtomic, tokens, build, fresh, loadThesaurus, wordScores, rank, query };
