# Map check, new blind test and clean-up: Plan

> **For agentic workers:** use superpowers:executing-plans. Steps use checkboxes. Never commit or push. Use the PowerShell tool for real work (the Bash tool is sandboxed).

**Goal:** Know the true map accuracy on the rebuilt Makillez map, get one honest number on new questions (`blind4`), test the hook in a live session at low token cost, and remove the scratch files.

**Approach:** Do it in 5 small tasks. Check after each one. The order matters: first run the old questions on the new map, then write `blind4` and run it only ONCE, then clean up.

**Tools:** `node ~/.claude/brain/eval-mk.js`, `brain.js`, `test-mk.js`, `claude -p` (headless, one turn).

**Spec:** your message: "use supperpower skill to have a plan first (export a md fille for it)", then "on the rebuilt Makillez map, write a fresh blind4 set, and clean up the scratch files", and "for live session, try to save tokens".

## Rules for this plan

- Never commit or push. You do that.
- Plain, short words in every doc.
- `blind4` is honest only on its FIRST run. Write the number down at once. Do not tune on it before that.
- Do not delete the rollback copy until Task 3 is checked and you say yes.
- Say what was checked and what was not.

---

### Task 1: Eval on the rebuilt Makillez map

**Files:** none changed. Output: `~/.claude/brain/EVAL-MK.md` (rewritten by `--report`).

- [ ] **Step 1: Check the map is OK.** `node ~/.claude/brain/brain.js mk-status all`. Expect 4 lines, all OK, Makillez with 1,589 doc neurons.
- [ ] **Step 2: Run the full routed eval** (about 7 min, so use `run-watched.ps1` in the background with a progress bar): `node ~/.claude/brain/eval-mk.js --route --report`.
- [ ] **Step 3: Compare with the last run.** Last: Makillez 410/446 strict (92%), 426/446 doc or code (96%); ESG 25/26; AIPO 15/15; tech 24/30; quiet 19/21.
- [ ] **Step 4: Decide.** A change of 1 or 2 questions is noise. A drop of more than 3 questions: list them with `--fails` and find the cause before going on.

**Done when:** the new numbers are written in the report to you, with the change from the last run.

### Task 2: Write `blind4` (new, unseen questions)

**Files:**
- Modify: `~/.claude/brain/eval-mk-cases.json` (add the set). Back it up first to `%TEMP%\eval-mk-cases.before-blind4.json`.
- Modify: `~/.claude/brain/eval-mk.js` (add `blind4` to the set name list and the label text, as was done for `blind3`).

- [ ] **Step 1: Back up** the cases file.
- [ ] **Step 2: Pick topics the old sets cover least.** Read the "by area" line of the Task 1 report. Choose areas with the lowest counts or scores (for example ARCH, BUG, CI, AIPO).
- [ ] **Step 3: Write about 60 questions.** Rules:
  - Write them from the real docs and code (open a doc, make a question a developer might ask). Do NOT run the map while writing.
  - Include about 15 mixed questions that do not name a project.
  - Include 4 unrelated questions (should get no map).
  - Each case needs: id, question, set `blind4`, expected doc path and section or class, tier (easy, middle, hard), area.
  - No question may copy words straight from a heading.
- [ ] **Step 4: Check the file.** `node -e` parse test, count the cases, make sure ids are new.

**Done when:** the file parses and shows 60+ new cases with set `blind4`.

### Task 3: Run `blind4` once and write the result down

- [ ] **Step 1: Run once:** `node ~/.claude/brain/eval-mk.js --route --set blind4`. (Check the real flag name in `eval-mk.js` first.)
- [ ] **Step 2: Write the first number in `brain/README.md` ("Testing the map") and in the memory note `brain-map-quality.md`.** Say plainly if 95% was not reached.
- [ ] **Step 3: Read the failures.** Put them in a list. Do NOT fix them in this plan; `blind4` is now read, like `blind3`.
- [ ] **Step 4: Run the 4 test suites and the rules eval** (`test-mk.js` and the others, `brain.js check`). Expect ALL PASSED.

**Done when:** first-run number is recorded in two places and tests pass.

### Task 4: Live hook test, low token cost

The hook has only been run directly, never inside a fresh Claude Code session.

- [ ] **Step 1: Use one short headless call on the cheapest model:**
  `claude -p "Where is the filter panel UX standard written? Answer in one line." --model haiku --max-turns 1`, run from `C:\Users\VanNhatThanh\source\repos\Makillez-master-docs` (so the cwd bonus applies).
  One turn and a one-line answer keep the cost small. The map block adds only a few hundred tokens.
- [ ] **Step 2: Check the hook ran.** Look in the hook log (`brain.js check` or the brain log file) for a map block for this prompt, and check the answer names `for-dev/17-filter-panel-ux-standard.md`.
- [ ] **Step 3: Do ONE more call** with an ESG-named prompt, run from `C:\Windows\System32`. Check the ESG map block appears and the time is under 15 s.
- [ ] **Step 4: Stop there.** Two calls only. Say what was and was not tested (for example: the interactive UI was not tested).

**Done when:** both calls show a map block in the log, and the answers use it. If the headless call does not run hooks, say so and keep this item open. Do not loop.

### Task 5: Clean up the scratch files

Folder: `C:\Users\VANNHA~1\AppData\Local\Temp\claude\C--Windows-System32\1af2d9ea-5498-41c5-9516-0dbbed91f3bf\scratchpad`

- [ ] **Step 1: List sizes** of `tech-src\`, `data-src\`, `backup-single-db\` and the helper scripts.
- [ ] **Step 2: Ask you** before deleting `backup-single-db\` (it holds the old 60 MB `mk.db` and the old code for rollback). Offer: (a) delete the downloaded repos only, keep the backup; (b) delete all.
- [ ] **Step 3: Delete what you chose** with `[IO.Directory]::Delete($path, $true)` (the shell guard can wrongly block `Remove-Item`). Make sure no build is running first.
- [ ] **Step 4: Check.** `mk-status all` still OK, the `corpus` folder under `brain/data` is untouched, and the folders are gone.
- [ ] **Step 5: Keep the small scripts** (`add-cases4.js`, `route-grid.js`) unless you say to delete them.

**Done when:** sizes before and after are reported and `mk-status all` is OK.

---

## Final check (end of plan)

- [ ] `mk-status all`: 4 lines OK.
- [ ] All test suites and the rules eval pass.
- [ ] Numbers in `README.md`, `CLAUDE.md` (accuracy line) and the memory note match the new runs.
- [ ] List of changed files for you to commit: `eval-mk-cases.json`, `eval-mk.js`, `README.md`, `EVAL-MK.md`, `CLAUDE.md` if edited, this plan file.
- [ ] Say what was not checked.

## Risks

- `blind4` may score below 87%. That is the honest result. Report it.
- The headless hook test may not match an interactive session. Say so.
- The eval needs about 7 min. Run it in the background with a progress bar.

## Not in this plan

Better short tech questions, ESG routing without the name, automatic rebuild for ESG, AIPO and tech, and graph refresh. Ask if you want a plan for them.
