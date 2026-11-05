// Turn downloaded public docs (Markdown only) into the "tech" corpus for the map: brain/data/corpus/tech/technical-docs/<source>/...
//   node make-corpus.js <folder with one sub-folder per source>     then:  node brain.js build-mk tech
// The downloaded files are data, never code: they are only read and cleaned here, nothing in them is run.
// Cleaning: front matter becomes a "# title" line; doc-site markup (includes, shortcodes, HTML tags) is removed; tiny files are skipped.
const fs = require('fs');
const path = require('path');
const { homeDir } = require('./rules.js');

const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.log('usage: node make-corpus.js <folder with one sub-folder per source>'); process.exit(1); }
const out = path.join(homeDir(), 'brain', 'data', 'corpus', 'tech');
const SKIP_DIR = new Set(['.git', 'includes', 'snippets', 'media', 'images', 'node_modules', 'zone-pivots']);
const LICENSE = { 'dotnet-docs': 'dotnet/docs, CC BY 4.0 (text), MIT (code)', 'azure-arch-center': 'MicrosoftDocs/architecture-center, CC BY 4.0', 'dapr-docs': 'dapr/docs, CC BY 4.0', 'ef-core-docs': 'dotnet/EntityFramework.Docs, CC BY 4.0', 'angular-docs': 'angular/angular (adev content), MIT', 'azure-data-guide': 'MicrosoftDocs/architecture-center, CC BY 4.0', 'azure-data-services': 'MicrosoftDocs/azure-docs, CC BY 4.0', 'fabric-docs': 'MicrosoftDocs/fabric-docs, CC BY 4.0', 'spark-docs': 'apache/spark, Apache 2.0', 'flink-docs': 'apache/flink, Apache 2.0', 'hadoop-docs': 'apache/hadoop, Apache 2.0' };

function clean(raw) {
  let text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n'), title = '';
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) { const t = fm[1].match(/^title:\s*(.+)$/m); if (t) title = t[1].replace(/^["']|["']$/g, '').trim(); text = text.slice(fm[0].length); }
  text = text
    .replace(/^\s*\[!INCLUDE[^\n]*$/gim, '')                         // docs-site includes
    .replace(/^\s*:::[^\n]*$/gm, '')                                // docs-site containers (:::image, :::code, :::zone)
    .replace(/\{\{[%<][\s\S]*?[%>]\}\}/g, '')                        // Hugo shortcodes (Dapr)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/gim, (m, k) => '> ' + k[0] + k.slice(1).toLowerCase() + ':')
    .replace(/<\/?(?:img|br|div|span|p|a|table|tr|td|th|thead|tbody|ul|li|ol|strong|em|code|pre|docs-[a-z-]+)\b[^>]*>/gi, ' ')
    .replace(/\n{3,}/g, '\n\n');
  if (!/^\s*#\s/.test(text) && title) text = `# ${title}\n\n${text}`;
  return text.trim() + '\n';
}

let files = 0, bytes = 0, skipped = 0;
fs.rmSync(path.join(out, 'technical-docs'), { recursive: true, force: true });
const walk = (dir, rel, source) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p, rel + '/' + e.name, source); continue; }
    if (!e.name.endsWith('.md') || /^(toc|index-test|readme)\.md$/i.test(e.name) && source !== 'angular-docs' || /contribut|code-of-conduct|^license|^security|changelog|^support\.md$/i.test(e.name)) { if (e.name.endsWith('.md')) skipped++; continue; }
    const text = clean(fs.readFileSync(p, 'utf8'));
    if (text.length < 500 || text.length > (source === 'spark-docs' ? 150000 : 40000)) { skipped++; continue; }   // Spark's guides are long but are the core docs; elsewhere a long page is mostly generated tables   // tiny stubs and huge reference pages (generated tables, option lists) add noise and slow the search
    const dest = path.join(out, 'technical-docs', source, rel.replace(/^\//, ''), e.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
    files++; bytes += text.length;
  }
};
for (const e of fs.readdirSync(src, { withFileTypes: true })) if (e.isDirectory()) walk(path.join(src, e.name), '', e.name);
fs.mkdirSync(path.join(out, 'graphify-out'), { recursive: true });
fs.writeFileSync(path.join(out, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [], links: [], built_at_commit: '' }));
fs.writeFileSync(path.join(out, 'SOURCES.md'), '# Sources of the tech corpus\n\nPublic documentation, downloaded as Markdown and cleaned by make-corpus.js. Keep the licence notes with any copy.\n\n' + Object.entries(LICENSE).map(([k, v]) => `- ${k}: ${v}`).join('\n') + '\n');
console.log(`corpus written: ${files} files, ${(bytes / 1048576).toFixed(1)} MB, ${skipped} skipped, in ${out}`);
