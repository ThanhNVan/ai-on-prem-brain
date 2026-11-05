# Live Codex comparison: ESG

This page records a live comparison of Codex with the current hooks enabled and disabled. It uses ten ESG questions. The first run is recorded here; these questions are no longer unseen after this run.

## Method

- Run each question in a fresh Codex session from `esg-master-docs` with `gpt-6-sol`, medium reasoning and read-only access.
- Ask both sessions to inspect the repository, cite exact files and make no changes.
- The enabled run uses the current hooks. The disabled run uses `--disable hooks`, which disables all hooks, not only the brain.
- The CLI log confirms hook execution but does not show the injected brain text. The comparison cannot prove that a brain result reached the model or isolate its effect.
- Compare answers with the ESG documentation and, where practical, source files. Record missing details and uncertainty; do not treat a successful process exit as proof of a correct answer.
- Time is wall-clock time per session, including startup and hooks. Four sessions ran at once, so timing is affected by contention. Token totals are the CLI's reported totals.

## Questions

1. In ESG, how does a request travel from an API controller to its handler?
2. In ESG, how are domain events handled and how is email sent?
3. In ESG, how are API permissions and organization data scope enforced?
4. In ESG, what is stored in Cosmos DB versus SQL, and how are migrations applied?
5. In ESG, how does an edited OnlyOffice report get saved and exported as a PDF?
6. In ESG, how do I add a new Cosmos container?
7. In ESG, how is the Angular API client regenerated after an API change?
8. In ESG, what local services are needed to run the application?
9. In ESG, what tests and test frameworks are present, and what are the gaps?
10. In ESG, which branch triggers the deployment pipelines and what deployment drift is documented?

## Results: 2026-11-05

All 20 sessions exited successfully. These are observations of the answers, not a full independent audit of every claim or citation. Time is in seconds; tokens are the total reported by Codex.

| # | Hooks off: time / tokens | Hooks on: time / tokens | Answer comparison |
|---|---|---|---|
| 1 | 51.9 / 35,195 | 91.0 / 24,987 | Both traced controller, MediatR and handler. Off cited docs; on cited ESG source. |
| 2 | 55.5 / 20,347 | 106.0 / 45,278 | Both described in-process events, email paths and swallowed sender errors. On cited source. |
| 3 | 55.7 / 24,859 | 132.8 / 73,335 | Both covered permission checks and the limit of organization scoping. On traced an integration endpoint in source. |
| 4 | 109.3 / 44,022 | 151.5 / 38,079 | Both distinguished Cosmos containers, SQL roles and migration paths, with source citations. |
| 5 | 110.9 / 59,867 | 108.1 / 40,291 | Both traced OnlyOffice callbacks, saving and PDF export, with source citations. |
| 6 | 73.6 / 28,504 | 91.4 / 31,943 | Both described the container, interface, repository and partition key changes. |
| 7 | 46.0 / 15,830 | 97.2 / 46,235 | Both gave `npm run gen`. On also identified the local Swagger endpoint prerequisite. |
| 8 | 66.9 / 42,750 | 91.8 / 26,686 | Both identified Cosmos Emulator, LocalDB, OnlyOffice, API and web app, and noted local Redis is in memory. |
| 9 | 105.9 / 43,536 | 97.6 / 42,703 | Both discussed backend and frontend tests, test tooling and gaps, with source citations. |
| 10 | 40.1 / 19,008 | 59.4 / 16,002 | Both identified the `main` trigger and documented pipeline drift. On cited pipeline YAML directly. |

The mean was **71.6 seconds and 33,392 tokens per question with hooks off**, and **102.7 seconds and 38,554 tokens with hooks on**. Totals were 333,918 and 385,539 tokens respectively. This small, concurrent run does not establish a general speed or cost difference.

For question 7, the on answer said the local API must supply Swagger on port 5257. A separate check confirmed that `src/ESG.WebApp/ReportClientApp/api-report.nswag:7` points to `http://localhost:5257/swagger/internal/swagger.json`. The off answer gave the generation command but omitted this prerequisite. See [ESG development workflow](../../source/repos/esg-master-docs/technical-docs/for-dev/08-development-workflow.md) and [NSwag configuration](../../source/repos/esg/src/ESG.WebApp/ReportClientApp/api-report.nswag).

The ESG docs themselves were verified against commit `b736dab2` on 2026-10-28 and can be stale. The sessions could read the neighboring `esg` source checkout, but not all chose to do so. No app, pipeline or automated tests were run. The raw session logs were kept in the local temporary `brain-live-esg-20261105` folder; they may contain project details and are not part of this document.

## Simpler debugging and programming tests

Use the same question in a fresh session for each hook setting. Ask Codex to answer without editing files. Score each answer with the 100-point rubric below. Check the examples before scoring.

1. **Debugging:** In ESG, why might `EmailSenderService.SendAsync` return without throwing when sending an email fails? Point to the code and suggest a small fix.
2. **Programming:** Write a C# function `CanAddAttachment(int currentCount, int maxCount)` that returns `true` only when adding one attachment would not exceed the limit. Assume both inputs are non-negative. Give examples for `(2, 3)`, `(3, 3)` and `(0, 0)`.

For the first question, check that the answer identifies the catch block and telemetry call in [EmailSenderService](../../source/repos/esg/src/ESG.Shared/EmailSender/EmailSenderService.cs), and explains that rethrowing changes the caller's error handling. This is a source-based scenario, not a reproduced incident. For the second, expected results are `true`, `false` and `false`. A comparison such as `currentCount < maxCount` also avoids integer overflow.

| Test | Hooks off score / 100 | Hooks off tokens | Hooks on score / 100 | Hooks on tokens | Result |
|---|---:|---:|---:|---:|---|
| Debugging | 94 (38/28/19/9) | 15,181 | 98 (39/29/20/10) | 55,128 | Both found the catch and suggested `throw;`. Both cited the existing failure test. On also traced the Service Bus caller and warned that all callers see changed behavior. |
| Programming | 97 (39/30/18/10) | 14,082 | 97 (39/30/18/10) | 7,844 | Both used `currentCount < maxCount` and gave all three correct results. Neither ran code. |
| **Total tokens** | — | **29,263** | — | **62,972** | Total for both sessions in each condition. |

The figures in parentheses are accuracy / completeness / evidence / clarity. This is a subjective review of one answer per condition, with the labels visible. The programming evidence score reflects the supplied examples; it does not require repository citations. Hooks-off disabled all hooks. The on logs show hook events but do not prove what brain text was supplied, so this cannot isolate the brain's effect. The questions and expected answers were recorded before these runs and are not an unseen test.

On 2026-11-05, all four fresh sessions completed in the ESG source folder using `gpt-6-sol`, medium reasoning, read-only access and `--skip-git-repo-check`. Sessions ran concurrently. The reported token totals include the whole session, not just the final answer.

Codex could not find its home directory inside the workspace sandbox, but worked outside it. The watched runner required `pwsh`, which was unavailable, so a temporary copy used Windows PowerShell for its child process. The original runner was not changed. Logs are in the local temporary `watched-runs` folder and may contain project details. No app or automated tests were run.

## Programming debug test: email failures

Question: “Debug this ESG issue using the source: an email send fails, but the caller sees the operation complete without an exception. Trace the relevant code and a real caller, identify the cause and limits of what can be concluded, propose a specific fix and a regression test. Cite exact files and make no changes. Do not claim you reproduced it unless you actually did.”

The question is based on a real code path: `EmailSenderService.SendAsync` catches exceptions from the send operation, records them in telemetry, and does not rethrow them. This is a source finding, not a reproduced incident. See [EmailSenderService](../../source/repos/esg/src/ESG.Shared/EmailSender/EmailSenderService.cs).

| Measure | Hooks off | Hooks on |
|---|---:|---:|
| Live answer | Not produced | Not produced |
| Answer quality / 100 | Not scored | Not scored |

Both CLI attempts failed before a session started: Codex could not find its home directory. The watched runner also could not start because `pwsh` was unavailable. No timing or token comparison is available. The scoring rubric below will apply when both answers are available. The question and source finding are now recorded, so this is no longer an unseen test.

## Answer quality: 100-point review

The same reviewer scored each full answer after the run. The score combines **accuracy (40 points)**, **completeness (30)**, **evidence (20)** and **clarity (10)**. Accuracy reflects agreement with the available ESG docs and checked source, with deductions for material unsupported claims or missing qualifications. Completeness measures how well the answer addresses the question. Evidence rewards relevant, traceable citations and direct source checks; a documented answer can still be useful. Clarity rewards a readable answer and honest limits. Scores are judgment calls, not measured probabilities or percentages of objectively correct statements.

The figures in parentheses are accuracy / completeness / evidence / clarity. Each answer is judged separately against the question, using the same rubric.

| # | Hooks off / 100 | Hooks on / 100 | Main reason for the scores |
|---|---:|---:|---|
| 1 | 88 (38/27/14/9) | 96 (39/29/19/9) | Both explain the flow; on traces the example through source. |
| 2 | 91 (38/29/15/9) | 96 (39/29/19/9) | Both cover event and email paths and the failure caveat; on cites implementation. |
| 3 | 90 (38/28/15/9) | 95 (38/29/19/9) | Both explain scope limits; on traces the integration asset path in source. |
| 4 | 96 (39/29/19/9) | 96 (39/29/19/9) | Both distinguish storage and migration paths and cite source. |
| 5 | 94 (38/28/19/9) | 94 (38/28/19/9) | Both trace saving and distinguish PDF paths; runtime behavior remains untested. |
| 6 | 96 (39/29/19/9) | 96 (39/29/19/9) | Both give a detailed, source-backed container recipe and partition-key warning. |
| 7 | 82 (38/21/14/9) | 95 (38/29/19/9) | Off omits the local Swagger prerequisite; on identifies it and marks generation untested. |
| 8 | 96 (39/29/19/9) | 96 (39/29/19/9) | Both identify the local services and in-memory Redis, with source citations. |
| 9 | 95 (38/29/19/9) | 91 (36/27/19/9) | Both inspect test gaps; on does not qualify the PR pipeline's automatic trigger. |
| 10 | 91 (38/29/15/9) | 96 (39/29/19/9) | Both cover deployment and drift; off relies on docs, on cites YAML. |
| **Mean** | **91.9** | **95.1** | **3.2 points higher with hooks on in this review.** |

These scores were assigned after reading the answers and their labels. They are subjective and not independently reviewed. They cannot establish that the brain caused the difference: the off run disabled all hooks, and the enabled run's injected brain text was not visible in the logs. Scores do not certify every factual claim or citation. For example, the question 7 on answer suggests an explicit NSwag command but did not run it.

## Selected-fact checklist

Reviewed on 2026-11-05 after the runs. Each question has four equally weighted checks below. A check earns one point when the answer covers it; otherwise it earns zero. These are a small, manual, **post-hoc** checklist, not a blind or independent assessment. They measure coverage of selected facts, not the truth of every statement, the quality of every citation, or real-world task success. Both sides used the same checks.

| # | Four checks | Hooks off | Hooks on |
|---|---|---:|---:|
| 1 | Route to controller; request context; MediatR and authorization; handler and response. | 4/4 | 4/4 |
| 2 | In-process events and policies; Service Bus email; a direct email path; sender error caveat. | 4/4 | 4/4 |
| 3 | Authentication; request permissions; organization scope; scope is not guaranteed by permission alone. | 4/4 | 4/4 |
| 4 | Cosmos data; SQL roles; SQL migrations; Cosmos migrations. | 4/4 | 4/4 |
| 5 | OnlyOffice callback and validation; save statuses; DOCX storage; separate PDF path. | 4/4 | 4/4 |
| 6 | Container creation and getter; interface; repository; matching partition key. | 4/4 | 4/4 |
| 7 | Correct working directory; generation command; generated output; local Swagger endpoint prerequisite. | 3/4 | 4/4 |
| 8 | Cosmos emulator and LocalDB; OnlyOffice; API and web app; local Redis behavior. | 4/4 | 4/4 |
| 9 | Backend tests and tools; frontend tests and tools; mocked integration gap; uncertainty about automatic PR test execution. | 4/4 | 3/4 |
| 10 | `main` and path filter; deployment stages; build guide drift; PR trigger and exclusion drift. | 4/4 | 4/4 |
| **Total** | **Points earned** | **39/40 (97.5%)** | **39/40 (97.5%)** |

The hooks-off answer to question 7 omitted the running API and Swagger prerequisite; the NSwag config points to the local endpoint. The hooks-on answer included it. The hooks-on answer to question 9 said the PR pipeline runs tests without stating that automatic PR triggering is not declared in YAML. The hooks-off answer flagged this uncertainty. The YAML declares `trigger: none` and no `pr` trigger; settings outside the repository were not checked. See [NSwag config](../../source/repos/esg/src/ESG.WebApp/ReportClientApp/api-report.nswag), [PR pipeline](../../source/repos/esg/pipelines/pull-request.yaml), and [CI/CD process](../../source/repos/esg-master-docs/technical-docs/for-dev/13-cicd-process.md).

These scores are tied on this checklist. The on answers more often inspected source in the first three questions, but that is a separate observation from the score. All hooks were disabled in the off condition, and brain injection was not visible in the logs, so the review cannot attribute any quality difference to the brain alone. The ten questions were selected before the runs, but the checks were written after reading the answers. A stronger comparison would pre-register the checks, hide the run labels from an independent reviewer and isolate the brain hook.
