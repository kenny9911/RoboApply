INT-03 · status: **complete, with one gate exception.** The full suite has one failing test, `server/src/features/jobs/detail/detail.test.ts:354`, which is INT-05's file and needs a one-line flip at the join. Nothing was launched: this task forbids dev servers and browsers, so the "launch and try it" step is still the orchestrator's.

Worktree: `/Users/kenny/code/RoboApply/.claude/worktrees/wp-INT-03` (branch `wp/INT-03`). Nothing committed, pushed or stashed; no `.prisma` edits, no db push, no new dependencies.

## Review resolution

1. **Ready-only filters not refreshed — fixed.**
   - `useGenerateList` now re-reads the agent settings when `overrides` were sent, and waits for them before the mutation resolves.
   - After "No, only Ready to apply" the card shows the kept chips, the "Your lists here use filter changes…" line and "Use my main search only" straight away.
   - A second edit starts from the filters in use, so the first change is sent again with it (new component test).
   - The server still keeps the filters before the empty-list returns, and the message now says so (new key `ready.search.keptReady`).
2. **Panel-saved answers filled into other employers' forms — fixed, slightly differently from the suggestion.**
   - `/ext/autofill-profile` answers now carry `source`. The extension fills an `ai_confirmed` answer by itself only on an exact question match.
   - A close match is still offered through the draft path and needs "Use this answer".
   - I keyed on `source` rather than the `custom:` prefix because answers typed in the web app also use `custom:` keys; those keep their existing close-match behaviour.
3. **`detail.test.ts:354` — real, not fixed here.** The file is outside my owns; it stays a Request to INT-05 / the orchestrator.
4. **Panel copy promising one form fill — fixed.**
   - `steps` carries `oneRun`, true only for `ONE_RUN_MULTI_PAGE` (Workday). The cost sentences show only then.
   - Taleo and SuccessFactors get the neutral line (new test with the Taleo fixture).
   - The GoApply line is now "Filling the same page again uses no extra form fill." / "同一页面再次填写不会多用填表次数。"
5. **Run reuse handing out uncharged fills — fixed; (a) changes the item's stated key and needs your sign-off.**
   - (a) The reuse key is still the URL without its query, but when the query names the job a hash of those parameters is appended as `#job=<hash>`. The keys are an allowlist: `gh_jid`, `token`, `job`, `jobId`, `career_job_req_id`, `id` and similar. Tracking parameters are ignored and no query value is stored.
   - (b) A reused run that has filled nothing now holds a credit again before it is returned. This applies when an earlier pass reported "nothing filled", or the run never reported and is older than the 15-minute stale-reservation window. With no credits left the call answers `credits_exhausted`.
   - Not covered: portals that name the job only in the URL fragment. The extension keys the panel by origin + path, so that needs a client change beyond this finding.
6. **Grades rule catching work-achievement questions — fixed.**
   - Bare 成绩 / 排名, "academic performance" and "test/exam results" count as grades only with a study context next to them, or as the whole field label.
   - The reviewer's five questions are in a new `FREE_TEXT_NOT_GRADES` sample list and classify as free text on both sides.
   - Server and extension now share one pattern, and `contractParity` asserts the two sources are equal.
   - I also narrowed the GoApply portal adapter's own score rule (`extension/src/adapters/cn/fields.ts`), which had the same bare words and would have kept blocking drafts.
   - Deviation: "Please enter your exam results" stays protected. A wrong free-text verdict there would let AI draft a score.

## Per-item result

1. **Extension server ↔ package contract (wave4 #5) — done.**
   - Added: `flags.aiAnswers`, profile-view names on `/ext/autofill-profile`, canonical-origin `downloadUrl`, `POST /ext/answers/save`, the `protected_question` 422 with `details.type`, the web-bridge `connected` fix, and (this pass) `answers[].source`.
   - Already done, tests added: pair-code redeem, idempotent PATCH.
   - `resume-for-job` without a job: the server already returned the main resume; the extension now uses it.
2. **Workday multi-page "Fill this page" (wave5 #17) — done.** One panel session and one run per application; server reuse within 2 h; `workday` removed from `EXTENSION_PER_PAGE_ATS_TYPES` and the web mirror. iCIMS, Taleo and SuccessFactors stay listed.
3. **GoApply extension build (wave5 #18) — done.** `GOAPPLY_DISTRIBUTION`, `--store`, `--all`, zh_CN `_locales`.
4. **GoApply popup injection (wave5 #19) — done.** Permissions unchanged.
5. **Protected type `grades` (wave5 #21) — done**, with the narrower rule above.
6. **Ready to apply UI ↔ server (wave4 #4) — done.** No mirror types left in `lib/api/agent.ts`; `fit` on list rows; `agent.record-files` job records the resume on first open. The Pro cap line was already done.
7. **SR-52-1 / SR-52-3 (wave4 #3) — done.** Weekly lists read the kept filters; `RAAgentKitEvent.kind` is written on every new row. "No, only this list" became "No, only Ready to apply" because the change is now kept for later lists.

## Files

Created (untracked): `extension/test/build.test.ts`, `extension/test/intl/workdayPages.test.tsx`. Deleted: none. All 69 modified files are inside the bundle's owns; `git status` in the worktree lists them.

Touched in this pass:
- **Web:** `hooks/agent/useAgent.ts`, `components/features/agent/ReadySearchCard.tsx`, `components/features/agent/agent.test.tsx`
- **Server:** `server/src/features/extension/{contract,service,repository,questionTypes,questionSamples}.ts`, `{service,questionTypes}.test.ts`
- **Extension source:** `extension/src/{mapping/resolve.ts,mapping/questions.ts,adapters/cn/fields.ts,shared/contract.ts,content/main.ts,content/panel/Panel.tsx}`, `extension/README.md`
- **Extension tests:** `extension/test/{fill,mapping,contractParity}.test.ts`, `extension/test/cn/sections.test.ts`, `extension/test/intl/workdayPages.test.tsx`
- **Strings:** `i18n/staging/{ready.en,extension.en,extension-cn.en,extension-cn.zh}.json`

## Tests run

| Command | Result |
|---|---|
| `npx vitest run server/src/features/extension server/src/features/agent components/features/agent components/features/extension hooks/agent hooks/extension __tests__/contracts` | 17 files, 1148 passed |
| `npm --prefix extension run typecheck` | clean |
| `npm --prefix extension test` | 36 files, 708 passed; no-submit check passes |
| `npm run typecheck:server`, `npm run typecheck:web` | clean |
| `npm run check` | all six checks pass |
| `npx vitest run --exclude ".claude/**"` | 547 files passed, 1 failed; 10085 tests passed, 1 failed |

The first full run had 8 failing files: `detail.test.ts`, and 7 that timed out with the machine at a load average of about 150. All 7 pass on their own and in the second full run. That includes the two timeouts the previous handoff attributed to the base commit (`legacyAuth.test.ts`, `externalRoutes.practice.test.ts`).

## Requests

- **INT-05 / orchestrator (required for a green suite):** in `server/src/features/jobs/detail/detail.test.ts` line 354, change the Workday expectation to `toBe(true)`; keep the SuccessFactors line at false.
- **Orchestrator:** confirm the run-reuse key change in 5(a), which differs from the item's "URL without its query".
- **INT-13 (`docs/jobright-clone/ARCHITECTURE.md`):**
  - §3.7 lacks these routes:
    - `POST /agent/setup/step`
    - `POST /agent/list/generate`
    - `POST /agent/search/save-to-main`
    - `GET /agent/badge`
    - `POST /agent/queue/prepare`
    - `GET /agent/queue/:id` (with `kit.revisionCost`)
    - `GET /agent/queue/:id/history`
    - `POST /agent/queue/:id/restore`
    - `GET /agent/answers/questions`
    - `DELETE /agent/answers/:key`
  - §3.7 also needs: `GET /agent/queue` `tab`/`cursor`/`limit` → `counts`, `weekKey`, `nextCursor`, `job.fit`; `GET/PUT /agent/settings` `listFilters` and `filterOverrides: null`; `open` → `alreadyApplied`, `atsType`, `extensionSupported`, `item`.
  - §3.8/§6 needs: `POST /ext/answers/save`, `answers[].source`, run reuse with the job-aware key and the credit re-hold, `fieldsTotal`, the `protected_question` 422, `flags.aiAnswers`, the `grades` type.
  - New queue kind `agent.record-files`.
- **INT-02:** `proCap` on the `ready_kits` bucket of the credits summary is still what "Pro: up to 30 kits a week" waits for.
- **INT-11 / owner:** confirm the artifact retention row covers channel `agent` (the `agent.record-files` export).
- **INT-SCHEMA (comment only, no DDL):** the `RAAutofillRun.pageUrl` doc comment should say the value may end in `#job=<hash>`.
- **WP-91 (translation):** the keys below.

## i18n keys

- **Added, `extension`:** `panel.fillPage`, `panel.pageByPage`, `panel.oneFill`, `panel.newPage`, `panel.newPageHint`, `panel.newPageNoCost`, `draft.save`, `draft.saving`, `draft.saveHint`, `draft.saved`, `draft.saveFailed`, `draft.saveProtected`.
- **Added, `ready`:** `search.ownChanges`, `search.useMainOnly`, `search.ownRemoved`, `search.keptReady`.
- **Changed text:** `ready.search.no`, `ready.search.askNote`, `ready.search.addedReady`; `extension-cn.modes.cost` (en and zh).
- **Obsoleted:** `extension.note.resume_no_job`.

## Env vars introduced

None.

## Known gaps

- Nothing was run in a browser; Playwright e2e and live-form checks remain WP-94's.
- iCIMS, Taleo and SuccessFactors may still start one run per page when the path changes and no job is matched; the panel no longer promises otherwise.
- Portals that name the job only in the URL fragment share one panel and one run across jobs until the tab reloads.
- The job-parameter allowlist is a guess at common names; an unlisted one falls back to the path-only key.
- A draft for a close match of a panel-saved answer is offered only when AI answers are available for the account, although the server returns it for free.
- The self-hosted CRX build has no `update_url`; packing, signing and the update manifest are not built.
- The list-row fit is the deterministic estimate and can differ from an AI-scored tier on the job page.
- `searchProfileId` is read but nothing writes it yet.
- Rows from before this change keep `kind` and `pageUrl` null; no backfill.