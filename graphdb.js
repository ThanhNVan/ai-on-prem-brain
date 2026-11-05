// Keyword graph of your saved prompts, kept in one SQLite file (history/graph.db).
// The JSONL files stay the source of truth (they are what git syncs). This file is derived: delete it any time, it is rebuilt.
//   prompt --has--> keyword      keyword --co-occurs (weight = number of shared prompts)--> keyword
const fs = require('fs');
const path = require('path');
const history = require('./history.js');

const MAX_KW = 25;      // keywords kept per prompt (the most shared ones), so a pasted log cannot create thousands of edges
const RARE_DF = 5, MAX_RARE = 100; // a rare word is in 5 prompts or fewer; at most 100 per prompt
const MAX_TEXT = 3000;  // only the start of a prompt is read for keywords
const dbFile = (home) => path.join(home, 'brain', 'history', 'graph.db');

function open(home) {
  const { DatabaseSync } = require('node:sqlite'); // built in from Node 22.5; loaded here so a missing module never breaks the hook
  fs.mkdirSync(path.dirname(dbFile(home)), { recursive: true });
  const db = new DatabaseSync(dbFile(home));
  db.exec(`CREATE TABLE IF NOT EXISTS prompts(id TEXT PRIMARY KEY, t TEXT, cwd TEXT, p TEXT);
    CREATE TABLE IF NOT EXISTS keywords(id INTEGER PRIMARY KEY, word TEXT UNIQUE, df INTEGER);
    CREATE TABLE IF NOT EXISTS pk(pid TEXT, kid INTEGER, PRIMARY KEY(pid, kid));
    CREATE TABLE IF NOT EXISTS edges(a INTEGER, b INTEGER, w INTEGER, PRIMARY KEY(a, b));
    CREATE TABLE IF NOT EXISTS pw(pid TEXT, word TEXT, PRIMARY KEY(pid, word));
    CREATE INDEX IF NOT EXISTS pw_w ON pw(word);
    CREATE INDEX IF NOT EXISTS pk_k ON pk(kid);`);
  return db;
}

// Rebuild only when the set of saved prompts changed. Returns { prompts, keywords, edges, rebuilt }.
function sync(home, tokens) {
  const entries = history.load(home), db = open(home);
  try {
    const have = new Set(db.prepare('SELECT id FROM prompts').all().map((r) => r.id));
    const want = new Set(entries.map((e) => e.id));
    const version = db.prepare('PRAGMA user_version').get().user_version; // 2 = has the rare-words table
    const same = version === 2 && have.size === want.size && [...want].every((id) => have.has(id));
    if (!same) {
      // drop numbers, timestamps and ids from pasted logs: a word needs at least 3 letters and mostly letters
      const wordLike = (w) => (w.match(/[a-z]/g) || []).length >= 3 && (w.match(/[0-9]/g) || []).length * 2 < w.length;
      const words = new Map(entries.map((e) => [e.id, [...tokens(e.p.slice(0, MAX_TEXT))].filter(wordLike)]));
      const df = new Map();
      for (const ws of words.values()) for (const w of ws) df.set(w, (df.get(w) || 0) + 1);
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM prompts; DELETE FROM keywords; DELETE FROM pk; DELETE FROM edges; DELETE FROM pw;');
        const addW = db.prepare('INSERT OR IGNORE INTO pw VALUES(?,?)');
        const addP = db.prepare('INSERT OR IGNORE INTO prompts VALUES(?,?,?,?)');
        const addK = db.prepare('INSERT OR IGNORE INTO keywords(word, df) VALUES(?,?)');
        const kid = db.prepare('SELECT id FROM keywords WHERE word = ?');
        const addPK = db.prepare('INSERT OR IGNORE INTO pk VALUES(?,?)');
        for (const e of entries) {
          addP.run(e.id, e.t, e.cwd, e.p);
          // every rare word is kept (not only the 25 most shared), so an id in a long pasted log is still found
          for (const w of words.get(e.id).filter((x) => df.get(x) <= RARE_DF).slice(0, MAX_RARE)) addW.run(e.id, w);
          const keep = words.get(e.id).sort((a, b) => df.get(b) - df.get(a) || (a < b ? -1 : 1)).slice(0, MAX_KW); // most shared first: shared words are what make links
          for (const w of keep) { addK.run(w, df.get(w)); addPK.run(e.id, kid.get(w).id); }
        }
        db.exec(`INSERT INTO edges SELECT x.kid, y.kid, COUNT(*) FROM pk x JOIN pk y ON x.pid = y.pid AND x.kid < y.kid GROUP BY x.kid, y.kid;`);
        db.exec('COMMIT');
        db.exec('PRAGMA user_version = 2');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    const n = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    return { prompts: n('prompts'), keywords: n('keywords'), edges: n('edges'), rebuilt: !same };
  } finally { db.close(); }
}

// Keywords linked to `word` (strongest first) and the prompts that hold it (newest first).
function related(home, word, tokens, { max = 10 } = {}) {
  const w = [...tokens(word)][0] || String(word).toLowerCase().trim();
  const db = open(home);
  try {
    const k = db.prepare('SELECT id, df FROM keywords WHERE word = ?').get(w);
    if (!k) return { word: w, df: 0, neighbours: [], prompts: [] };
    const neighbours = db.prepare(`SELECT kw.word, e.w FROM (
        SELECT b AS o, w FROM edges WHERE a = ?1 UNION ALL SELECT a AS o, w FROM edges WHERE b = ?1) e
      JOIN keywords kw ON kw.id = e.o ORDER BY e.w DESC, kw.word LIMIT ?2`).all(k.id, max);
    const prompts = db.prepare(`SELECT p.t, p.p FROM pk JOIN prompts p ON p.id = pk.pid WHERE pk.kid = ? ORDER BY p.t DESC LIMIT ?`).all(k.id, max);
    return { word: w, df: k.df, neighbours, prompts };
  } finally { db.close(); }
}

// Earlier prompts that share exact rare words with `text` (meaning search can miss ids and file names).
// A prompt counts when it shares 2 words that appear in 5 prompts or fewer, or 1 long id-like word (a-b, file.ext). Read only: never builds the file.
function lexical(home, text, tokens, { max = 2, exclude = '' } = {}) {
  if (!fs.existsSync(dbFile(home))) return [];
  const all = [...tokens(String(text).slice(0, MAX_TEXT))];
  // "shared-config.yaml" also yields shared, config, yaml: count the whole name once, not four times
  const parts = new Set(all.filter((w) => /[-.]/.test(w)).flatMap((w) => w.split(/[^a-z0-9]+/)));
  const q = all.filter((w) => !parts.has(w)).slice(0, 60);
  if (!q.length) return [];
  const db = open(home);
  try {
    // pw holds only words of 5 prompts or fewer. "strong" = long id-like word that is in 2 prompts or fewer.
    return db.prepare(`SELECT p.t, p.p, COUNT(*) n,
        MAX(w.word GLOB '*[-.]*' AND length(w.word) >= 8 AND (SELECT COUNT(*) FROM pw x WHERE x.word = w.word) <= 2) strong
      FROM pw w JOIN prompts p ON p.id = w.pid
      WHERE w.word IN (${q.map(() => '?').join(',')}) AND p.p <> ?
      GROUP BY p.id HAVING n >= 2 OR strong ORDER BY strong DESC, n DESC, p.t DESC LIMIT ?`).all(...q, exclude, max)
      .map((r) => ({ t: r.t, p: r.p, sim: 0 }));
  } finally { db.close(); }
}

// The strongest keyword pairs overall: a quick look at what you ask about together.
function top(home, max = 15) {
  const db = open(home);
  try {
    return db.prepare(`SELECT a.word x, b.word y, e.w FROM edges e JOIN keywords a ON a.id = e.a JOIN keywords b ON b.id = e.b ORDER BY e.w DESC, x, y LIMIT ?`).all(max);
  } finally { db.close(); }
}

module.exports = { sync, related, top, lexical, dbFile };
