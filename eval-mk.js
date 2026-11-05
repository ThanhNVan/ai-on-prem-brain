// Quality check for the Makillez map (mk.js). The questions are written down in eval-mk-cases.json (about 160, mostly about Makillez).
//   node eval-mk.js                     run all questions with the meaning model (like the hook) and print a summary
//   node eval-mk.js --set dev|held|fresh   only one set. Tune on `dev` only. `held`: do not tune on it. `fresh`: questions written after the tuning; write a new batch (set `fresh`) for the next round, then call the old one `held`
//   node eval-mk.js --tier middle       only easy | middle | hard
//   node eval-mk.js --area events       only one area (prefix of the id: ARCH, CTX, EVT, AUTH, GW, FE, DEP, WF, BUG, CI, AIPO, SRCH, FP, RUN, IHM, PAT, DOC, NON, CODE, NEG)
//   node eval-mk.js --no-meaning        words and synonyms only
//   node eval-mk.js --fails             list every failing question (default: only the first 40)
//   node eval-mk.js --report            also write EVAL-MK.md (every question with its result)
//   node eval-mk.js --route             use the real router (Makillez, ESG, AIPO, tech): an answer from the wrong project is a miss. Without it each question searches its own project (field `project`, default makillez)
//   node eval-mk.js --min 0.7           exit 1 when the strict pass rate of the chosen questions is under 70% (or an unrelated question leaks)
// A case: q (the question), doc / sec (regular expressions for a doc file and its section), code (regex for a code name),
// any (pass when the doc OR the code matches), none (nothing may be returned). Matching ignores case.
// Results: OK = right doc and section (or right code); DOC = right doc, wrong section; FAIL = nothing right; LEAK = an unrelated question got a map.
// Learned links are ignored here, so the numbers do not depend on how you worked.
const fs = require('fs');
const path = require('path');
const { homeDir } = require('./rules.js');
const mk = require('./mk.js');
const { getEmbedder } = require('./embed.js');

const argv = process.argv.slice(2), flag = (n) => argv.includes(n), opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const all = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval-mk-cases.json'), 'utf8'));
const cases = all.filter((c) => (!opt('--set') || c.set === opt('--set')) && (!opt('--tier') || c.tier === opt('--tier')) && (!opt('--area') || c.id.toUpperCase().startsWith(opt('--area').toUpperCase())));
const rx = (s) => new RegExp(s, 'i');
const short = (f) => f.replace(/^technical-docs\/(for-dev\/)?/, '').replace(/\.md$/, '');

function judge(c, res) {
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
  const embed = flag('--no-meaning') ? null : await getEmbedder(false);
  const rows = [];
  for (const c of cases) {
    const pv = embed ? (await embed([c.q]))[0] : null;
    // --route: the real router picks the project; an answer from the wrong project counts as no answer (a miss), and any answer to an unrelated question is a leak
    const t0 = Date.now(), res0 = flag('--route') ? mk.searchAll(homeDir(), c.q, { pv, learn: false }) : mk.search(homeDir(), c.q, { pv, learn: false, project: c.project || 'makillez' });
    const own = c.project || 'makillez', res = flag('--route') && res0 && !c.none ? (res0.project === own ? res0 : (res0.also || []).find((a) => a.project === own) || null) : res0;   // the right project's block may be the main one or a second, shorter one
    rows.push({ c, status: judge(c, res), alsoN: res0 && res0.also ? res0.also.length : 0, ms: Date.now() - t0, best: res ? res.best : 0, docs: res ? res.docs.map((d) => short(d.n.file) + ' > ' + (d.n.section || '').split(' > ').slice(-1)[0]) : [], code: res ? res.code.map((x) => x.n.label) : [], commit: res ? res.commit : null });
  }
  const rate = (rs, f) => (rs.length ? `${rs.filter(f).length}/${rs.length} (${Math.round((100 * rs.filter(f).length) / rs.length)}%)` : '-');
  const knownRows = rows.filter((r) => r.c.known);   // measured near misses that are listed but not counted
  rows.splice(0, rows.length, ...rows.filter((r) => !r.c.known));
  const isMk = (r) => !r.c.project || r.c.project === 'makillez';   // the headline numbers are Makillez only; the other projects get their own lines
  const pos = rows.filter((r) => !r.c.none && isMk(r)), neg = rows.filter((r) => r.c.none), others = rows.filter((r) => !r.c.none && !isMk(r));
  const strict = (r) => r.status === 'OK', lenient = (r) => r.status === 'OK' || r.status === 'DOC';
  const lines = [];
  const out = (s = '') => { lines.push(s); console.log(s); };
  out(`Makillez map eval: ${rows.length} questions (${pos.length} Makillez, ${neg.length} unrelated), ${embed ? 'with' : 'without'} meaning, learned links ignored`);
  out(`  Makillez questions   strict ${rate(pos, strict)}   right doc or code ${rate(pos, lenient)}`);
  out(`  unrelated questions  quiet ${rate(neg, strict)}   (a LEAK is a map shown for an unrelated question)`);
  for (const s of ['dev', 'held', 'fresh', 'train2', 'blind', 'blind2', 'blind3', 'blind4', 'blind5', 'blind6']) { const p = pos.filter((r) => r.c.set === s); if (p.length) out(`  set ${s.padEnd(6)}           strict ${rate(p, strict)}   right doc or code ${rate(p, lenient)}`); }
  for (const pj of ['esg', 'aipo', 'tech']) { const p = others.filter((r) => r.c.project === pj); if (p.length) out(`  project ${pj.padEnd(5)}         strict ${rate(p, strict)}   right doc or code ${rate(p, lenient)}`); }
  for (const t of ['easy', 'middle', 'hard']) { const p = pos.filter((r) => r.c.tier === t); if (p.length) out(`  tier ${t.padEnd(6)}          strict ${rate(p, strict)}   right doc or code ${rate(p, lenient)}`); }
  const areas = [...new Set(rows.map((r) => r.c.id.replace(/-\d+$/, '')))];
  out('  by area (strict): ' + areas.filter((a) => a !== 'NEG' && pos.some((r) => r.c.id.startsWith(a + '-'))).map((a) => { const p = pos.filter((r) => r.c.id.startsWith(a + '-')); return `${a} ${p.filter(strict).length}/${p.length}`; }).join('   '));
  if (flag('--route')) { const shown = rows.filter((r) => !r.c.none); out(`  second project block shown for ${rate(shown, (r) => r.alsoN > 0)} of the questions (the cost of a close call: a few more lines)`); }
  const ms = rows.map((r) => r.ms); out(`  search time: average ${Math.round(ms.reduce((a, b) => a + b, 0) / Math.max(ms.length, 1))} ms, slowest ${Math.max(0, ...ms)} ms (the hook limit is 15,000 ms)`);
  if (knownRows.length) out('  known, not counted: ' + knownRows.map((r) => `${r.c.id} (${r.status}): ${r.c.why || ''}`).join('; '));
  const bad = rows.filter((r) => !strict(r)), shown = flag('--fails') ? bad : bad.slice(0, 40);
  if (bad.length) out(`\nnot strict-OK (${bad.length})${shown.length < bad.length ? `, first ${shown.length} (use --fails for all)` : ''}:`);
  for (const r of shown) out(`  ${r.status.padEnd(4)} ${r.c.id.padEnd(8)} [${r.c.set},${r.c.tier}] "${r.c.q}"\n         want: ${[r.c.doc && 'doc~' + r.c.doc, r.c.sec && 'sec~' + r.c.sec, r.c.code && 'code~' + r.c.code, r.c.none && 'nothing'].filter(Boolean).join('  ')}${r.c.any ? '  (doc OR code)' : ''}\n         got:  ${r.docs.slice(0, 3).join(' | ') || '-'}  //  ${r.code.slice(0, 3).join(', ') || '-'}`);

  if (flag('--report')) {
    const md = [];
    const commit = (rows.find((r) => r.commit) || {}).commit;
    md.push('# Makillez map — test questions and results', '',
      `> Generated by \`node eval-mk.js --report\` on ${new Date().toISOString().slice(0, 10)}. Map built from graph commit \`${commit ? commit.slice(0, 8) : '?'}\`. The questions are in \`eval-mk-cases.json\`; this page is rebuilt from them.`, '',
      `${rows.length} questions: ${pos.length} about Makillez and ${neg.length} unrelated. Learned links are ignored, so the numbers do not depend on how the map was used.`, '',
      '## Summary', '', '| What | Strict | Right doc or code |', '|---|---|---|',
      `| All Makillez questions | ${rate(pos, strict)} | ${rate(pos, lenient)} |`,
      ...['dev', 'held', 'fresh', 'train2', 'blind', 'blind2', 'blind3', 'blind4', 'blind5', 'blind6'].filter((s) => pos.some((r) => r.c.set === s)).map((s) => `| Set \`${s}\`${{ dev: ' (used for tuning)', held: ' (failures were read, never tuned for)', fresh: ' (written after tuning, run once)', train2: ' (more data for the doc ranking weights)', blind: ' (run once, then used: its failures led to fixes and it joined the training)', blind2: ' (first run, before any fix: 48/59 strict = 81%, 54/59 right doc or code = 92%. The heading gate was added after that, so this row no longer counts as blind)', blind3: ' (written after round 3, first run: 53/61 strict = 87%, 55/61 right doc or code = 90%. The honest score for new questions. I read its failures, so it no longer counts as blind)', blind4: ' (written after round 4 from the doc headings, run once; the first-run score is in README.md. Once its failures are read it no longer counts as blind)', blind5: ' (written before the round-5 fixes from the doc headings, run once after them; the first-run score is in README.md)', blind6: ' (written before the question index was built, run once after it; the first-run score is in README.md)' }[s]} | ${rate(pos.filter((r) => r.c.set === s), strict)} | ${rate(pos.filter((r) => r.c.set === s), lenient)} |`),
      ...['easy', 'middle', 'hard'].map((t) => `| Tier \`${t}\` | ${rate(pos.filter((r) => r.c.tier === t), strict)} | ${rate(pos.filter((r) => r.c.tier === t), lenient)} |`),
      `| Unrelated questions kept quiet | ${rate(neg, strict)} | |`, '',
      '- **Strict:** the right doc and the right section (or the right code name) is in the map.',
      '- **Right doc or code:** the right doc is there, but maybe not the exact section.',
      '- **Tiers:** easy = the question uses the doc\'s own words; middle = a natural rephrasing; hard = a symptom or an indirect question.',
      '- **Sets:** only `dev` was used to tune the map. The failures of `held` were read but not tuned for. `fresh` was written after the tuning and run once, so it is the honest score for new questions.', '');
    const names = { ARCH: 'Architecture (doc 01)', CTX: 'Bounded contexts (doc 02)', EVT: 'Integration events (doc 03)', AUTH: 'Authorization (doc 04)', GW: 'Gateway and routing (doc 05)', FE: 'Frontend (doc 06)', DEP: 'Deployment (doc 07)', WF: 'Development workflow (doc 08)', BUG: 'Findings, bugs and improvements (docs 10, 19, 20)', CI: 'CI/CD (doc 13)', AIPO: 'aipo (docs 14, 15)', SRCH: 'Azure AI Search (doc 16)', FP: 'Filter panel (doc 17)', RUN: 'Running locally and seeding (RUNNING-LOCALLY, doc 18)', IHM: 'IHM onboarding', PAT: 'Coding patterns (docs 23, 24)', DOC: 'Doc rules (docs 21, 22)', NON: 'For non-developers', CODE: 'Code symbols (graphify graph)', ESG: 'ESG docs and code (project esg)', PAIPO: 'AIPO docs and code (project aipo)', TECH: 'General technical docs from the internet (project tech)', DIAG: 'Diagrams (docs 11, 12)', NEG: 'Unrelated questions (must stay quiet)' };
    for (const a of areas) {
      md.push(`## ${names[a] || a}`, '', '| ID | Set | Tier | Question | Expected | Result | Top hit |', '|---|---|---|---|---|---|---|');
      for (const r of rows.filter((x) => x.c.id.startsWith(a + '-'))) {
        const want = [r.c.doc && `doc \`${r.c.doc}\``, r.c.sec && `section \`${r.c.sec}\``, r.c.code && `code \`${r.c.code}\``, r.c.none && 'no map'].filter(Boolean).join(', ') + (r.c.any ? ' (doc or code)' : '');
        const top = (r.docs[0] || r.code[0] || '-').replace(/\|/g, '\\|');
        md.push(`| ${r.c.id} | ${r.c.set} | ${r.c.tier} | ${r.c.q.replace(/\|/g, '\\|')} | ${want.replace(/\|/g, '\\|')} | ${r.status} | ${top} |`);
      }
      md.push('');
    }
    fs.writeFileSync(path.join(__dirname, 'EVAL-MK.md'), md.join('\n') + '\n');
    out('\nwrote EVAL-MK.md');
  }
  const min = opt('--min');
  const failed = (min && pos.filter(strict).length / Math.max(pos.length, 1) < Number(min)) || neg.some((r) => r.status === 'LEAK');
  process.exit(min && failed ? 1 : 0);
})();
