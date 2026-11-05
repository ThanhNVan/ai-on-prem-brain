# Graph Report - brain  (2026-11-02)

## Corpus Check
- 21 files · ~78,586 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 103 nodes · 204 edges · 11 communities (9 shown, 2 thin omitted)
- Extraction: 80% EXTRACTED · 20% INFERRED · 0% AMBIGUOUS · INFERRED: 40 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Tests and test helpers
- History store
- Meaning vectors and refresh
- Hook, output and eval
- Rules graph build
- Keyword graph (SQLite)
- Word and synonym scoring
- Setup script
- Synonym signal and thesaurus
- README root

## God Nodes (most connected - your core abstractions)
1. `searchFull()` - 11 edges
2. `build()` - 10 edges
3. `embedNodes()` - 9 edges
4. `fresh()` - 9 edges
5. `refreshInBackground()` - 7 edges
6. `hook()` - 7 edges
7. `readVectors()` - 7 edges
8. `tokens()` - 7 edges
9. `wordScores()` - 7 edges
10. `runBrain()` - 7 edges

## Surprising Connections (you probably didn't know these)
- `Fail-open rule` --implements--> `hook()`  [EXTRACTED]
  README.md → brain.js
- `Hook time limits (3.5 s model, 5 s hook)` --references--> `refreshInBackground()`  [EXTRACTED]
  README.md → brain.js
- `Meaning vectors (data/vectors.json)` --implements--> `embedNodes()`  [EXTRACTED]
  README.md → embed.js
- `Secret redaction before save` --implements--> `redact()`  [EXTRACTED]
  README.md → history.js
- `Words match signal` --references--> `tokens()`  [EXTRACTED]
  README.md → rules.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Three match signals added together** — readme_word_signal, readme_synonym_signal, readme_meaning_signal [EXTRACTED 1.00]

## Communities (11 total, 2 thin omitted)

### Community 0 - "Tests and test helpers"
Cohesion: 0.17
Nodes (13): Secret redaction before save, Tests (test-brain, test-history), dims(), fake(), hook(), histDir(), home(), runForget() (+5 more)

### Community 1 - "History store"
Cohesion: 0.17
Nodes (16): append(), embedHistory(), entryId(), forget(), hasUnembedded(), load(), machineId(), monthName() (+8 more)

### Community 2 - "Meaning vectors and refresh"
Cohesion: 0.24
Nodes (14): refreshInBackground(), ehash(), embedNodes(), embedText(), readVectors(), vecFile(), Fail-open rule, Hook time limits (3.5 s model, 5 s hook) (+6 more)

### Community 3 - "Hook, output and eval"
Cohesion: 0.24
Nodes (12): format(), hook(), search(), searchFull(), getEmbedder(), withTimeout(), Quality eval (eval.js, 36 prompts), Rule output cap (6 rules, 2,400 chars) (+4 more)

### Community 4 - "Rules graph build"
Cohesion: 0.54
Nodes (7): Rules graph (brain/graph.json), blocks(), build(), fresh(), graphFile(), sources(), spans()

### Community 5 - "Keyword graph (SQLite)"
Cohesion: 0.43
Nodes (6): dbFile(), open(), related(), sync(), top(), Keyword graph (history/graph.db)

### Community 6 - "Word and synonym scoring"
Cohesion: 0.40
Nodes (6): expand(), loadThesaurus(), query(), stem(), tokens(), wordScores()

### Community 8 - "Synonym signal and thesaurus"
Cohesion: 0.50
Nodes (4): Synonyms match signal, thesaurus.json, Keep synonym groups tight, Words match signal

## Knowledge Gaps
- **7 isolated node(s):** `Forget command (brain.js forget)`, `all-MiniLM-L6-v2 model`, `Undo (remove hook entry)`, `Meaning vectors (data/vectors.json)`, `Quality eval (eval.js, 36 prompts)` (+2 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `embedNodes()` connect `Meaning vectors and refresh` to `Hook, output and eval`?**
  _High betweenness centrality (0.050) - this node is a cross-community bridge._
- **What connects `Forget command (brain.js forget)`, `all-MiniLM-L6-v2 model`, `Undo (remove hook entry)` to the rest of the system?**
  _7 weakly-connected nodes found - possible documentation gaps or missing edges._