// Wide test of the brain (run: node wide-test.js). Fresh prompts from many fields. Real rules read-only; history and hook runs use a THROWAWAY home.
const fs = require('fs'), os = require('os'), path = require('path'), { spawn, spawnSync } = require('child_process');
const BRAINDIR = __dirname, REAL = path.dirname(BRAINDIR); // works from wherever the brain lives
const brain = require(path.join(BRAINDIR, 'brain.js')), history = require(path.join(BRAINDIR, 'history.js'));
const pct = (a, b) => `${a}/${b} = ${b ? Math.round(100 * a / b) : 0}%`;
const hr = (t) => console.log('\n' + '='.repeat(8) + ' ' + t);

// ---------- part 1: rules, positives in new words ----------
const RULES = [
  ['go on and sync my changes up to the origin server', 'Never commit or push'],
  ['could you stage and commit this for me', 'Never commit or push'],
  ['please do not run any git write command yourself', 'Never commit or push'],
  ['delegate the whole implementation to the other model', 'Codex'],
  ['a patch this big makes codex quit without saying anything', 'Codex'],
  ['codex says it cannot start a powershell file here', 'cannot run `.ps1`'],
  ['what model do i pick for a codex job that only runs a script', 'gpt-6-luna'],
  ['dont launch lots of claude subagents to do bulk work', 'Do not spawn many'],
  ['when you review what codex wrote read every line of the diff', 'Review the full diff'],
  ['graphify workers on windows keep re-running my script top', 'spawn'],
  ['which script rebuilds the knowledge graph of the master docs', 'Graph refresh tool'],
  ['read the code from a pristine worktree of origin main for the docs update', 'clean `origin/main`'],
  ['the commit stamp inside the graph file is wrong', 'Stamp'],
  ['do i need to refresh the page for non developers when the developer page changes', 'Twins'],
  ['can a retired business rule number be given to a new rule', 'Ids are never reused'],
  ['should config values or only key names go in the findings page', 'config key names only'],
  ['the validator passes but the line it cites says something different', 'only checks that a cited line exists'],
  ['all my line references moved after the refactor', 'remap shifted line refs'],
  ['a command that runs for more than a minute should go to the background', 'Steps over 60 seconds'],
  ['the tool timed out in the foreground, did the job actually fail', 'Steps over 60 seconds'],
  ['let me watch a progress indicator as the deploy runs', 'Always show a progress bar'],
  ['for a small question just answer it yourself', 'Small edits, questions'],
  ['dont guess the container name, check it', 'Use facts and proof'],
  ['list what was changed and what was verified', 'Say what changed'],
  ['at the end give me the compose commands to rebuild and recreate', 'After code work'],
  ['where do i put the pintura license when building the angular app', 'Never type the Pintura key'],
  ['ask me for the seq key before you read the logs', 'Ask me for the Seq key'],
  ['can you turn off the windows firewall for me', 'System and security changes'],
  ['in c# prefer any over count greater than zero', 'Use `Any()`'],
  ['should this method return a tuple or a record', 'No tuples in new code'],
  ['leave the old lines alone unless the ticket needs them', 'Do not change old lines'],
  ['each part of a split plan needs its own folder and numbers', 'Each split plan'],
  ['this bug is out of scope for the ticket, where is it recorded', 'doc 19'],
];

// ---------- part 2: 30 topics. entry (saved earlier), paraphrase (should hit), sameTopic (different question, should stay quiet) ----------
const T = [
  ['explain how retrieval augmented generation reduces hallucinations in chatbots', 'how does RAG help chatbots hallucinate less', 'how do i chunk documents for a vector database'],
  ['what is the difference between fine tuning and prompt engineering for a language model', 'fine tuning versus prompting, which one changes the model weights', 'how many tokens fit in a context window'],
  ['what does the eu ai act say about high risk systems', 'obligations for high risk ai under the european ai act', 'does gdpr apply to chatbots that store chat logs'],
  ['how long is the notice period to terminate a residential lease in vietnam', 'notice needed to end a rental contract in vietnam', 'what taxes does a landlord pay in vietnam'],
  ['can an employer fire someone without notice during probation', 'is dismissal without warning allowed in the probation period', 'how many days of annual leave is an employee entitled to'],
  ['how do i make crispy roast potatoes in the oven', 'tips for getting oven roasted potatoes crunchy', 'how long should i boil an egg'],
  ['what are good stretches for lower back pain after sitting all day', 'stretching exercises for a sore lower back from desk work', 'how many hours of sleep does an adult need'],
  ['what is the difference between an etf and a mutual fund', 'etf versus mutual fund, how do they differ', 'how does compound interest work on savings'],
  ['plan a three day itinerary for da nang', 'three days in da nang, what should i do', 'what is the best time of year to visit hanoi'],
  ['explain how gradient descent finds the minimum of a function', 'how does gradient descent work to minimise a loss', 'what is the derivative of x squared'],
  ['how do i reverse a linked list in python', 'reverse a singly linked list using python code', 'how do i sort a dictionary by value in python'],
  ['why does my react component render twice in strict mode', 'react strict mode causes double rendering, why', 'how do i use useeffect cleanup'],
  ['kubernetes pod stuck in crashloopbackoff what should i check', 'pod keeps crashing with crashloopbackoff, how to debug', 'how do i expose a service with an ingress'],
  ['difference between inner join and left join in sql', 'inner join versus left join explained', 'how do i add an index to speed up a query'],
  ['how does the oauth authorization code flow with pkce work', 'explain the pkce authorization code flow in oauth', 'what is the difference between hashing and encryption'],
  ['how do i register a scoped service in dotnet dependency injection', 'adding a scoped dependency injection service in dotnet', 'how do i read configuration from appsettings in dotnet'],
  ['recommend a good book about habits and productivity', 'what is a good productivity and habit building book', 'recommend a podcast about history'],
  ['how do i say thank you very much in japanese', 'japanese phrase for thank you very much', 'how do i count to ten in korean'],
  ['what are the rules of offside in football', 'explain the offside rule in soccer', 'how long is a marathon'],
  ['why is the sky blue during the day', 'reason the daytime sky looks blue', 'why are sunsets red'],
  ['what caused the fall of the roman empire', 'main reasons the roman empire collapsed', 'who was julius caesar'],
  ['how do i get rid of mold in a bathroom', 'removing bathroom mould, what works', 'how do i unclog a kitchen sink'],
  ['what does the check engine light mean', 'check engine light is on, what could it be', 'how often should i change engine oil'],
  ['help me write a polite email asking a client to extend a payment deadline', 'draft a courteous note asking a customer if the payment date can move', 'write a cover letter for a developer job'],
  ['how do i remove duplicate rows in pandas', 'drop duplicate rows with pandas', 'how do i merge two dataframes in pandas'],
  ['what is a good color palette for a financial dashboard', 'color scheme ideas for a finance dashboard', 'what font should i use for a report'],
  ['how do i estimate a software project with a lot of uncertainty', 'estimating a software project when much is unknown', 'how do i run a good retrospective'],
  ['how do i give an ai agent long term memory', 'ways to add persistent memory to an llm agent', 'how do i evaluate an llm agent on a benchmark'],
  ['how do i fix a merge conflict during a git rebase', 'resolving conflicts in the middle of a git rebase, what are the steps', 'how do i undo the last git commit'],
  ['why is my docker build so slow on windows', 'docker builds are very slow on windows, what is wrong', 'how do i run a container with a volume mount'],
];
const MAY_HIT = new Set([29, 30, 16]); // topics that legitimately touch a rule (git, docker, dotnet): not counted as rule false hits
const UNREL = ['how tall is mount everest', 'what to wear to a wedding in summer', 'best way to learn to swim as an adult', 'how do i grow basil indoors', 'what is the plot of hamlet',
  'how do airplanes stay in the air', 'ideas for a rainy day with kids', 'how do i clean white sneakers', 'what are the symptoms of the flu', 'suggest a name for a golden retriever puppy',
  'what is the population of canada', 'how do i tie a tie', 'is it ok to eat rice that was left out overnight', 'what does a venture capitalist do', 'how do magnets work',
  'give me a workout plan for beginners', 'what is the meaning of the word ephemeral', 'how do i change a flat tire', 'what are the benefits of meditation', 'how does a bill become a law in the usa',
  'what is a good gift for a coworker leaving', 'how do vaccines train the immune system', 'what is the speed of light', 'how do i start learning the guitar', 'why do cats purr',
  'what is the best way to save money on groceries', 'describe the water cycle', 'how do i politely decline an invitation', 'what is inflation and why does it matter', 'how do solar panels make electricity'];
const FILL_T = ['what is the history of {s}', 'explain {s} to a ten year old', 'what are common mistakes people make with {s}', 'give me a short summary about {s}'];
const FILL_S = ['the printing press', 'coral reefs', 'jazz music', 'the silk road', 'volcanoes', 'chess openings', 'origami', 'the great depression', 'the moon landing', 'rainforests', 'the olympic games', 'impressionist painting', 'tea ceremonies', 'bridges', 'submarines', 'the renaissance', 'glaciers', 'opera', 'pottery', 'lighthouses', 'monsoons', 'tectonic plates', 'folk songs', 'fermentation', 'chocolate'];
const FILL = []; FILL_S.forEach((s, i) => FILL.push(FILL_T[i % 4].replace('{s}', s)));

(async () => {
  // ----- rules -----
  hr('PART 1  rules: 33 new prompts in your own work area');
  let hit = 0; const miss = [];
  for (const [p, want] of RULES) { const r = await brain.search(REAL, p); if (r.map((n) => n.text).join('\n').includes(want)) hit++; else miss.push(`${p}  (want "${want}") got: ${r.map((n) => n.text.slice(0, 28)).join(' | ') || 'nothing'}`); }
  console.log('RECALL', pct(hit, RULES.length)); miss.forEach((m) => console.log('  MISS', m));

  hr('PART 2  rules must stay quiet on prompts from everywhere else + 30 unrelated');
  const quietSet = []; T.forEach((t, i) => { if (!MAY_HIT.has(i + 1)) t.forEach((p) => quietSet.push(p)); }); UNREL.forEach((p) => quietSet.push(p));
  let quiet = 0, rulesAdded = 0; const noisy = [];
  for (const p of quietSet) { const r = await brain.search(REAL, p); if (!r.length) quiet++; else { rulesAdded += r.length; noisy.push(`${p}  ->  ${r.map((n) => n.text.slice(0, 34)).join(' | ')}`); } }
  console.log('QUIET', pct(quiet, quietSet.length), ' rules wrongly added in total:', rulesAdded);
  noisy.slice(0, 40).forEach((m) => console.log('  NOISY', m)); if (noisy.length > 40) console.log('  ... and', noisy.length - 40, 'more');

  // ----- history layer in a throwaway home -----
  hr('PART 3  history: crowded history (30 topics + ' + FILL.length + ' fillers), real model');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wide-')); fs.mkdirSync(path.join(home, 'brain'), { recursive: true });
  const tf = require('module').createRequire(BRAINDIR + path.sep)('@huggingface/transformers');
  const dir = path.join(BRAINDIR, 'data', 'models'); tf.env.cacheDir = dir; tf.env.localModelPath = dir; tf.env.allowLocalModels = true; tf.env.allowRemoteModels = false;
  const ext = await tf.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8', local_files_only: true });
  const embMany = async (a) => (await ext(a, { pooling: 'mean', normalize: true })).tolist();
  const emb = async (t) => (await embMany([t]))[0];
  process.env.BRAIN_MACHINE = 'wide-a';
  [...T.map((t) => t[0]), ...FILL].forEach((p) => history.append(home, p, 'X'));
  const MODEL = 'Xenova/all-MiniLM-L6-v2';
  const e = await history.embedHistory(home, embMany, MODEL); console.log('saved + embedded', e.total, 'prompts');
  let ph = 0, pw = 0, st = 0, sq = 0, un = 0, uq = 0; const phMiss = [], stBad = [], unBad = [];
  const top = async (q) => (history.searchHistory(home, await emb(q), MODEL, { max: 1 }))[0];
  for (let i = 0; i < T.length; i++) {
    const [entry, para, same] = T[i];
    const a = await top(para); pw++; if (a && a.p === entry) ph++; else phMiss.push(`${para}  ->  ${a ? a.p.slice(0, 50) : 'nothing'}`);
    const b = await top(same); st++; if (!b || b.p !== entry) sq++; else stBad.push(`${same}  ->  ${b.p.slice(0, 50)}`);
  }
  for (const q of UNREL) { const c = await top(q); un++; if (!c) uq++; else unBad.push(`${q}  ->  ${c.p.slice(0, 50)}`); }
  console.log('PARAPHRASE FOUND the right earlier prompt:', pct(ph, pw)); phMiss.forEach((m) => console.log('  MISS', m));
  console.log('SAME-TOPIC question did NOT pull the wrong entry:', pct(sq, st)); stBad.forEach((m) => console.log('  WRONG', m));
  console.log('UNRELATED stayed quiet:', pct(uq, un)); unBad.forEach((m) => console.log('  NOISY', m));

  // ----- hook robustness, real hook, throwaway home -----
  hr('PART 4  real hook with odd inputs (throwaway home)');
  const hh = fs.mkdtempSync(path.join(os.tmpdir(), 'wide-hook-'));
  fs.copyFileSync(path.join(REAL, 'preferences.md'), path.join(hh, 'preferences.md'));
  spawnSync(process.execPath, [path.join(BRAINDIR, 'brain.js'), 'build'], { env: { ...process.env, BRAIN_HOME: hh, BRAIN_MACHINE: 'wide-b' }, encoding: 'utf8' });
  const run = (input, ms = 15000) => { const t = Date.now(); const r = spawnSync(process.execPath, [path.join(BRAINDIR, 'brain.js'), 'hook'], { input, env: { ...process.env, BRAIN_HOME: hh, BRAIN_MACHINE: 'wide-b' }, encoding: 'utf8', timeout: ms, maxBuffer: 1 << 26 }); return { st: r.status, out: r.stdout, ms: Date.now() - t, err: r.error && r.error.code }; };
  const J = (o) => JSON.stringify(o);
  const odd = {
    'empty stdin': '', 'blank prompt': J({ prompt: '   ' }), 'bad json': '{not json', 'no prompt field': J({ cwd: 'X' }), 'prompt is a number': J({ prompt: 12345 }),
    'prompt is an array': J({ prompt: ['a', 'b', 'c', 'd', 'e'] }), 'null prompt': J({ prompt: null }),
    'emoji only': J({ prompt: '🔥🔥🔥🔥🔥 🚀🚀🚀🚀 😀😀😀😀' }), 'vietnamese': J({ prompt: 'làm sao để đẩy mã lên máy chủ mà không tự commit bây giờ' }),
    'arabic': J({ prompt: 'كيف أقوم بدفع التغييرات إلى الخادم الآن من فضلك' }), 'chinese': J({ prompt: '请把我的代码提交并推送到远程服务器上去现在' }),
    'NUL bytes': J({ prompt: 'push\u0000 it\u0000 to\u0000 the remote now please' }), 'one 300 KB word': J({ prompt: 'a'.repeat(300000) + ' b c d' }),
    '1 MB prompt': J({ prompt: 'please commit and push this to the remote now '.repeat(22000) }),
    'pasted code': J({ prompt: 'why does this fail?\nfunction f(a,b){ if(a>b){ return a-b } else { return b-a } }\nconsole.log(f(1,2))\n// thanks please look' }),
    'ALL CAPS': J({ prompt: 'PLEASE PUSH THE BRANCH TO THE SERVER RIGHT NOW' }), 'typos': J({ prompt: 'pls psuh teh brnach to remtoe sevrer now thx' }),
    'sql injection text': J({ prompt: "'; DROP TABLE users; -- please explain this attack to me now" }), 'path with spaces': J({ prompt: 'open C:\\Program Files\\My App\\data.txt and read the first line please' }),
    'secret in prompt': J({ prompt: 'use the api key=Qw3rTy9UiOp2AsDf5GhJk8LzXc1VbNm0 to call the endpoint now' }),
  };
  let okOdd = 0;
  for (const [k, input] of Object.entries(odd)) {
    const r = run(input);
    let valid = r.st === 0 && !r.err; if (valid && r.out) { try { JSON.parse(r.out).hookSpecificOutput.additionalContext; } catch { valid = false; } }
    if (valid && r.ms < 5000) okOdd++;
    console.log(`  ${valid && r.ms < 5000 ? 'ok  ' : 'BAD '} ${String(r.ms).padStart(5)} ms  ${r.out ? 'injected' : 'silent  '}  ${k}`);
  }
  console.log('ODD INPUTS handled (exit 0, valid output, under the 5 s limit):', pct(okOdd, Object.keys(odd).length));
  const saved = history.load(hh); const secretLeak = saved.some((x) => /Qw3rTy9UiOp2/.test(x.p));
  console.log('secret saved in plain text?', secretLeak ? 'YES (BAD)' : 'no'); console.log('prompts saved from the odd inputs:', saved.length, '| longest saved:', Math.max(0, ...saved.map((x) => x.p.length)), 'chars');

  hr('PART 5  20 hooks at once');
  const before = history.load(hh).length;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 20 }, (_, i) => new Promise((res) => { const c = spawn(process.execPath, [path.join(BRAINDIR, 'brain.js'), 'hook'], { env: { ...process.env, BRAIN_HOME: hh, BRAIN_MACHINE: 'wide-b' }, stdio: ['pipe', 'pipe', 'ignore'] }); let out = ''; c.stdout.on('data', (d) => out += d); c.on('exit', (code) => res({ code, out })); c.stdin.end(J({ prompt: `concurrent prompt number ${i} about topic ${i * 7} with plenty of words here` })); })));
  const after = history.load(hh).length;
  const lines = fs.readdirSync(path.join(hh, 'brain', 'history')).filter((f) => f.endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(hh, 'brain', 'history', f), 'utf8').split('\n').filter(Boolean)).flat();
  const broken = lines.filter((l) => { try { JSON.parse(l); return false; } catch { return true; } }).length;
  console.log(`saved ${after - before}/20 prompts, broken lines: ${broken}, wall time ${Date.now() - t0} ms, tmp files: ${fs.readdirSync(path.join(hh, 'brain', 'history')).filter((f) => f.endsWith('.tmp')).length}`);

  hr('PART 6  typical hook time (10 normal prompts, throwaway home)');
  const times = []; for (let i = 0; i < 10; i++) times.push(run(J({ prompt: `please show a progress bar while the long build number ${i} runs in the background now` })).ms);
  times.sort((a, b) => a - b); console.log('ms min/median/max:', times[0], times[5], times[9]);

  delete process.env.BRAIN_MACHINE;
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(hh, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
