// Meaning: the small local embedding model and the vectors file (data/vectors.json). Vectors are keyed by text hash.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { dataDir, writeAtomic } = require('./rules.js');

const MODEL = 'Xenova/all-MiniLM-L6-v2';                             // 23 MB, 384 numbers per text
const vecFile = (home) => path.join(dataDir(home), 'vectors.json');

const embedText = (n) => (n.section ? n.section + ': ' : '') + n.text.slice(0, 300);
const ehash = (n) => crypto.createHash('sha1').update(embedText(n)).digest('hex').slice(0, 16);
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]); // the CLI exits on its own, so a pending timer is fine

let embedderP;
function getEmbedder(allowDownload = false) { // null when the package or the model is not installed
  embedderP ||= (async () => {
    const tf = await import('@huggingface/transformers');
    const dir = path.join(__dirname, 'data', 'models');
    tf.env.cacheDir = dir; tf.env.localModelPath = dir; tf.env.allowLocalModels = true; tf.env.allowRemoteModels = allowDownload;
    const ext = await tf.pipeline('feature-extraction', MODEL, { dtype: 'q8', local_files_only: !allowDownload });
    return async (texts) => (await ext(texts, { pooling: 'mean', normalize: true })).tolist();
  })().catch(() => null);
  return embedderP;
}

function readVectors(home, model) { // Map hash -> Float32Array, or null when absent or made by another model
  try {
    const v = JSON.parse(fs.readFileSync(vecFile(home), 'utf8'));
    if (v.model !== model) return null;
    const out = new Map();
    for (const [h, b64] of Object.entries(v.vec)) { const b = Buffer.from(b64, 'base64'); out.set(h, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length))); }
    return out;
  } catch { return null; }
}

async function embedNodes(home, g, embedFn, model = MODEL) { // vectors are keyed by text hash, so only new or changed text is embedded
  const old = readVectors(home, model) || new Map(), want = new Map(), vecs = new Map();
  for (const n of g.nodes) if (!n.inContext) want.set(ehash(n), embedText(n));
  const missing = [...want].filter(([h]) => !old.has(h));
  for (const h of want.keys()) if (old.has(h)) vecs.set(h, old.get(h));
  if (missing.length) { const got = await embedFn(missing.map(([, t]) => t)); missing.forEach(([h], i) => vecs.set(h, Float32Array.from(got[i]))); }
  const vec = {};
  for (const [h, v] of vecs) vec[h] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
  writeAtomic(vecFile(home), JSON.stringify({ model, dim: [...vecs.values()][0]?.length || 0, vec }));
  return { total: vecs.size, added: missing.length };
}

module.exports = { MODEL, ehash, withTimeout, getEmbedder, readVectors, embedNodes };
