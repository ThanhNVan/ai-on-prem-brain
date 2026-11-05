const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_SAVED = 8000; // characters kept per prompt
const HIST_GATE = 0.60; // measured on 52 prompt pairs: unrelated prompts score up to 0.45, same-topic questions up to 0.61, paraphrases 0.57-0.97 (median 0.85)
const dir = (home) => path.join(home, 'brain', 'history');
const machineId = () => {
  const raw = process.env.BRAIN_MACHINE !== undefined ? process.env.BRAIN_MACHINE : os.hostname();
  const normalized = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'pc';
};
const monthName = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}.${machineId()}.jsonl`;
const entryId = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 16);

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try { fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

function redact(text) {
  let out = String(text);
  out = out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[hidden]');
  out = out.replace(/\b(Bearer)\s+\S+/gi, '$1 [hidden]');
  out = out.replace(/sk-[A-Za-z0-9_-]{16,}/g, '[hidden]');
  out = out.replace(/\b([A-Za-z_]*(?:key|token|secret|password|passwd|pwd|license|licence))(\s*[:=]\s*)\S+/gi, '$1$2[hidden]'); // also names like PINTURA_LICENSE_KEY
  return out.replace(/[A-Za-z0-9+/_=-]{24,}/g, (run, offset, whole) => {
    if (!/[A-Za-z]/.test(run) || !/[0-9]/.test(run)) return run;
    const left = whole.slice(Math.max(0, offset - 80), offset);
    const right = whole.slice(offset + run.length, offset + run.length + 8);
    const lineStart = Math.max(left.lastIndexOf('\n'), left.lastIndexOf(' '), left.lastIndexOf('\t')) + 1;
    const before = left.slice(lineStart);
    if (/\\/.test(before) || /:\/\//.test(before) || /^:\/\//.test(right) || /^\\/.test(right) || (run.includes('/') && /(?:^|\s)["']?\//.test(left.slice(lineStart)))) return run;
    return '[hidden]';
  });
}

// Messages the harness sends through the same hook (task finished, reminders, local commands). They are not the user's words.
const AUTOMATED = /^\s*(<task-notification|<system-reminder|<local-command|<command-(name|message)|<user-prompt-submit-hook|\[SYSTEM NOTIFICATION|Caveat: The messages below|Below is a conversation log from a Claude Code|This session is being continued from a previous conversation)/i;
const isAutomated = (prompt) => AUTOMATED.test(String(prompt));

function append(home, prompt, cwd) {
  try {
    let p = redact(prompt).trim();
    if (!p) return false;
    if (p.length > MAX_SAVED) p = `${p.slice(0, MAX_SAVED)} ...[cut]`; // a pasted log must not fill the history; the meaning step reads only the start anyway
    const folder = dir(home), file = path.join(folder, monthName());
    let lead = ''; // a crash can leave a last line without its newline; start on a fresh line so the new entry is not glued to it
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8'), lines = text.trimEnd().split('\n');
      if (text && !text.endsWith('\n')) lead = '\n';
      if (lines.length) {
        try { if (JSON.parse(lines[lines.length - 1]).p === p) return false; } catch { /* ignore a broken last line */ }
      }
    }
    fs.mkdirSync(folder, { recursive: true });
    fs.appendFileSync(file, `${lead}${JSON.stringify({ t: new Date().toISOString(), p, cwd: typeof cwd === 'string' ? cwd : '' })}\n`);
    return true;
  } catch { return false; }
}

function load(home) {
  const folder = dir(home), entries = [];
  try {
    for (const file of fs.readdirSync(folder).filter((f) => f.endsWith('.jsonl')).sort()) {
      let lines;
      try { lines = fs.readFileSync(path.join(folder, file), 'utf8').split(/\r?\n/); } catch { continue; }
      for (const line of lines) {
        try {
          const row = JSON.parse(line);
          if (typeof row.p !== 'string') continue;
          entries.push({ t: typeof row.t === 'string' ? row.t : '', p: row.p, cwd: typeof row.cwd === 'string' ? row.cwd : '', id: entryId(row.p) });
        } catch { /* skip bad lines */ }
      }
    }
  } catch { return []; }
  return entries.map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.t < b.entry.t ? -1 : a.entry.t > b.entry.t ? 1 : 0) || a.index - b.index)
    .map(({ entry }) => entry);
}

function readVectors(home, model) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir(home), 'vectors.json'), 'utf8'));
    if (data.model !== model || !data.vec || typeof data.vec !== 'object') return null;
    const vectors = new Map();
    for (const [id, encoded] of Object.entries(data.vec)) {
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length % 4) continue;
      vectors.set(id, new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)));
    }
    return vectors;
  } catch { return null; }
}

async function embedHistory(home, embedFn, model) {
  const entries = load(home), ids = new Set(entries.map((e) => e.id));
  let old = readVectors(home, model) || new Map();
  old = new Map([...old].filter(([id]) => ids.has(id)));
  const vecs = new Map(old), missing = entries.filter((e) => !vecs.has(e.id));
  const before = readVectors(home, model);
  if (!missing.length && before && before.size === vecs.size) return { total: vecs.size, added: 0 }; // nothing changed: do not rewrite the file
  for (let i = 0; i < missing.length; i += 64) {
    const batch = missing.slice(i, i + 64), got = await embedFn(batch.map((e) => e.p));
    batch.forEach((e, j) => vecs.set(e.id, Float32Array.from(got[j])));
  }
  const vec = {};
  for (const [id, value] of vecs) vec[id] = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64');
  writeAtomic(path.join(dir(home), 'vectors.json'), JSON.stringify({ model, dim: [...vecs.values()][0]?.length || 0, vec }));
  return { total: vecs.size, added: missing.length };
}

// true when some saved prompt has no vector yet (the hook uses this to start a background refresh)
function hasUnembedded(home, model) {
  try {
    const entries = load(home);
    if (!entries.length) return false;
    const vectors = readVectors(home, model);
    return !vectors || entries.some((e) => !vectors.has(e.id));
  } catch { return false; }
}

function searchHistory(home, pv, model, opts = {}) {
  try {
    const vectors = readVectors(home, model);
    if (!vectors) return [];
    const entries = load(home), found = [];
    for (const entry of entries) {
      if (entry.p === opts.exclude) continue;
      const v = vectors.get(entry.id);
      if (!v || v.length !== pv.length) continue;
      let sim = 0;
      for (let i = 0; i < v.length; i++) sim += v[i] * pv[i];
      if (sim < HIST_GATE || sim >= 0.98) continue;
      found.push({ t: entry.t, p: entry.p, sim });
    }
    found.sort((a, b) => b.sim - a.sim);
    return found.slice(0, opts.max ?? 2);
  } catch { return []; }
}

function forget(home, text) {
  const query = String(text).trim();
  if (!query) return 0;
  const folder = dir(home), needle = query.toLowerCase(), removed = new Set();
  let count = 0;
  try {
    for (const name of fs.readdirSync(folder).filter((f) => f.endsWith('.jsonl'))) {
      const file = path.join(folder, name), keep = [];
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (!line) continue;
        try {
          const row = JSON.parse(line);
          if (typeof row.p === 'string' && row.p.toLowerCase().includes(needle)) { removed.add(entryId(row.p)); count++; }
          else keep.push(line);
        } catch { keep.push(line); }
      }
      if (keep.length !== fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length) writeAtomic(file, keep.length ? `${keep.join('\n')}\n` : '');
    }
    if (removed.size) {
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(folder, 'vectors.json'), 'utf8')); } catch { data = null; }
      if (data && data.vec) {
        for (const id of removed) delete data.vec[id];
        writeAtomic(path.join(folder, 'vectors.json'), JSON.stringify(data));
      }
    }
  } catch { /* keep any files already updated */ }
  return count;
}

function formatHistory(entries) {
  if (!entries || !entries.length) return '';
  const lines = entries.map((entry) => {
    const date = typeof entry.t === 'string' ? entry.t.slice(0, 10) : '';
    const p = String(entry.p || '');
    return `- [you asked ${date}] ${p.length > 200 ? `${p.slice(0, 200)}...` : p}`;
  });
  return `Earlier prompts of yours that look related:\n${lines.join('\n')}`;
}

module.exports = { redact, isAutomated, append, load, embedHistory, hasUnembedded, searchHistory, forget, formatHistory, HIST_GATE, machineId };
