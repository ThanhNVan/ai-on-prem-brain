// "Question index": for each doc section, a few plain-language questions a developer might ask (doc-questions.json, written once by a small model).
// Their meaning numbers let a question like "why is the browser blocking my request" find the CORS section even when the section never says that.
//   embedAll(home)  reads doc-questions.json, writes data/dq.bin + data/dq.idx.json   (run: node brain.js build-dq)
//   load(home)      { keys, vecs, dim } or null when the index is not built (the map then works without it)
const fs = require('fs');
const path = require('path');
const { homeDir } = require('./rules.js');

const dataDir = (home) => path.join(home || homeDir(), 'brain', 'data');
const files = (home) => ({ q: path.join(home || homeDir(), 'brain', 'doc-questions.json'), bin: path.join(dataDir(home), 'dq.bin'), idx: path.join(dataDir(home), 'dq.idx.json') });
let cache;

async function embedAll(home) {
  const f = files(home), qs = JSON.parse(fs.readFileSync(f.q, 'utf8')), keys = [], texts = [];
  for (const [k, list] of Object.entries(qs)) for (const t of list) { keys.push(k); texts.push(t); }
  const embed = await require('./embed.js').getEmbedder(false);
  if (!embed) throw new Error('the local meaning model is not installed');
  const out = [];
  for (let i = 0; i < texts.length; i += 64) out.push(...(await embed(texts.slice(i, i + 64))));
  const dim = out[0].length, all = new Float32Array(out.length * dim);
  out.forEach((v, i) => all.set(v, i * dim));
  fs.mkdirSync(dataDir(home), { recursive: true });
  fs.writeFileSync(f.bin, Buffer.from(all.buffer, all.byteOffset, all.byteLength));
  fs.writeFileSync(f.idx, JSON.stringify({ keys, dim }));
  cache = undefined;
  return { questions: texts.length, sections: Object.keys(qs).length, dim };
}

function load(home) {
  if (cache !== undefined) return cache;
  try {
    const f = files(home), idx = JSON.parse(fs.readFileSync(f.idx, 'utf8')), b = fs.readFileSync(f.bin);
    const vecs = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    cache = vecs.length === idx.keys.length * idx.dim ? { keys: idx.keys, vecs, dim: idx.dim } : null;
  } catch { cache = null; }
  return cache;
}

module.exports = { embedAll, load };
