INT-09 · **status: complete** — all 8 items implemented with tests, nothing committed. The last full-suite runs hit load-induced timeouts in four files outside this bundle (details under Tests). I did not launch anything: this bundle's rules forbid dev servers, so "launch the new version" is left to the orchestrator after merge.

Worktree: `/Users/kenny/code/RoboApply/.claude/worktrees/wp-INT-09` (branch `wp/INT-09`).

## Per-item result

1. **Preview gate, no-PI search, browser `POST /sessions`** — done.
   - `POST /requirements/preview` (it lives in `previewRoutes.ts`, not `internalRoutes.ts`) now checks the shared practice gate first. GoApply with consent off gets 503 `ai_unavailable`, no phone gets 403, with zero model calls and zero Tavily requests.
   - `webSearch.ts` never searches for GoApply, explicit or ambient brand, so voice `prepare` is covered too. There is no domestic provider, so I took the "no web search" option.
   - RoboApply queries go through `assertNoPiInPayload` with the user's name as a known value. I added the same check to the written practice's search in `RAInterviewPromptService`.
   - Browser `POST /sessions` is removed (no callers), along with `interviewEngineApi.create`. `/v1/practice/sessions` is the one first-party create and keeps `jobId`, market, resume and recording.
   - Beyond the item: `prepare` and `coach` now check the same gate, and `GET /catalog` is market-aware.

2. **cn AI面试 format** — done.
   - Engine and mock catalogs list `cn_ai_interview` first on GoApply only.
   - A GoApply first-party session whose type and length satisfy `usesCnFormat` is stored as `interviewType: 'cn_ai_interview'`, with length clamped to 20–30 before the credit gate.
   - `RAMockService.start()` takes `jdText`, `market`, `jobId`, uses the pre-generated session id as `seed`, and returns per-question timing. `score()` returns `cn` on GoApply only; `formatId` is the format only when `blueprint.cnFormat` exists.
   - Web: the picker shows `practiceCn.format.label/.sub`, offers 20/25/30 minutes, and `TextPracticeRoom` renders `CnQuestionTiming` and `CnReportView`.
   - AI badges added to the text thread and the LiveKit room: an "AI voice" mark on the interviewer tile, plus text badges on the question card and the rail.

3. **`InterviewSession.brand` / `voiceProvider`, text-practice columns** — done.
   - Every create writes both columns. All readers go through `resolveSessionSeam`: column, then `liveMetrics.voiceSeam`, then the owner's `User.brand`. A failed owner lookup throws rather than guessing.
   - Text practice reads `RAMockSession.jobId` / `practiceCompletedAt` first with the JSON as fallback; no DML. The `kind`, `creditExempt` and `checklistMarkedAt` tags stay in `blueprint.practice` because they have no column.

4. **R2 client cache** — done. Keyed by endpoint + bucket + access key id. The GoApply "same bucket name" guard in `config.ts` now refuses only the same name on the same endpoint.

5. **SR-59-1/2/3** — done.
   - `createPrismaJobSetIndex` replaces the memory index. `put` stamps `jobId` and unlinks an older set; `get` returns the newest generation only, which I defined as rows with no gap over 60 s between neighbours. The `it.todo` is now a cold-start test.
   - Contribution `category` and `rejectReason` are stored and shown in the admin console. I also added an optional group select to the share dialog so the column is actually filled.
   - `addReport` is a plain insert plus increment; P2002 reads as already reported.

6. **`report_ready` WeChat notice** — done. Sent once per report via a `reportNoticeAt` claim, for live and written practice, GoApply only. Start is wrapped in `<SubscribeOnTap template="report_ready">` through a new `wrapStart` prop.

7. **i18n code parts** — done. (a) The 12 `practice.live` keys are added and the brand test now asserts the copy. (b) `user_reports` is mapped in `SourceNote` and both count lines use it; until INT-12's label key lands it falls back to "another source", not a key path.

8. **Move practice server tests** — done. 58 tests before and 58 after the move, 76 now with INT-09 additions. `rubricParity.test.ts` and `CnReport.test.tsx` under `practice-cn` still import server code as test-only parity checks.

**Unplanned fix:** `GET /practice/setup` on GoApply did two concurrent dynamic imports of the consent module; under vitest one resolved to the real module and queried the database from `.env` (8–9 s, timing out). Both now share one import, so the test no longer reaches the DB.

## Files

**Created**
- `server/src/interview-engine/routes/practiceGate.ts`
- `server/src/interview-engine/routes/previewRoutes.test.ts`
- `server/src/interview-engine/webSearch.test.ts`
- `server/src/interview-engine/storage/r2Storage.test.ts`
- `server/src/features/prep/jobSetIndex.test.ts`
- `server/src/features/cn/interview/__tests__/mockServiceCn.test.ts`
- `components/features/practice-cn/format.ts`
- `components/features/practice-cn/__tests__/practiceSetupCn.test.tsx`

**Moved**
- `components/features/practice/__tests__/server/{InterviewSessionService,externalRoutes}.practice.test.ts` → `server/src/interview-engine/sessions/InterviewSessionService.practice.test.ts` and `server/src/interview-engine/routes/externalRoutes.practice.test.ts` (old folder removed)

**Modified — server**
- `server/src/interview-engine/`: `sessions/InterviewSessionService.ts`, `routes/{internalRoutes,externalRoutes,previewRoutes}.ts`, `routes/sessionRoutes.test.ts`, `providers/{sessionSeam,index}.ts`, `providers/__tests__/{providers,sessionSeam.service,brandConfig}.test.ts`, `catalog/interviewCatalog.ts`, `prompt/interviewPromptService.ts`, `scoring/cnRubricBranch.ts`, `storage/r2Storage.ts`, `webSearch.ts`, `config.ts`
- `server/src/features/prep/`: `index.ts`, `jobSetIndex.ts`, `store.ts`, `memoryStore.ts`, `service.ts`, `contract.ts`, `fixtures.ts`, `service.test.ts`, `store.test.ts`
- `server/src/features/cn/interview/__tests__/promptServiceCnBranch.test.ts`
- `server/src/roboapply/v2/`: `services/RAMockService.ts`, `services/RAInterviewPromptService.ts`, `lib/raMockCatalog.ts`, `routes/mock.ts`

**Modified — web**
- `app/(auth)/practice/page.tsx`, `app/(auth)/practice/[id]/page.tsx`, `app/(auth)/practice/[id]/live.module.css`
- `components/v3/mock/{PracticeSetupFlow.tsx,liveConnection.ts,DeviceCheck.tsx}`
- `components/features/practice/{TextPracticeRoom,NetworkPrecheck}.tsx` and its `__tests__/{TextPracticeRoom,practicePage}.test.tsx`
- `components/features/practice-cn/{index,fromSession}.ts`, `__tests__/rubricParity.test.ts`
- `components/features/prep/{PracticeQuestionsPage,CompanyQuestionsPage,ContributeQuestion,AdminQuestionsConsole}.tsx` and its `__tests__/{practiceQuestions,adminQuestions}.test.tsx`
- `components/features/common/SourceNote.tsx`
- `lib/api/interviewEngine.ts`
- `__tests__/pages/{practice,practice-live-brand}.test.tsx`
- `i18n/staging/{practice,practiceQuestions}.en.json`

## Tests

- **Gate 1:** `npx vitest run` over the bundle's server and web paths → 82 files, 1006 passed.
- **Gate 2:** `npm run typecheck:server` and `npm run typecheck:web` → clean.
- **Gate 3:** `npm run check` → all six checks ✓.
- **Gate 4:** `npx vitest run --exclude ".claude/**"` → 554 files; 10076 passed before the last three small edits, 10078 passed after them (1 skipped, 25 todo both times).
- **Later runs:** three further full-suite runs (one before the 10078 run, two after, the last two at load average ~180–200) had 2–4 files time out. The four seen were `features/legacyPrecedence`, `v2/routes/index.unmounted`, `test/areaStubs` and `features/auth/legacyAuth`, none in this bundle. Those four pass 58/58 with `--testTimeout 180000 --hookTimeout 180000`. Worth one re-run on a quiet machine.

## Requests

- **INT-12:** add `nav.source.label.user_reports` ("users who shared questions").
- **INT-04:** `interview_prep { write: true }` is unblocked; the job set now survives a cold start.
- **INT-13:** `.env.example` — `CN_S3_BUCKET` only has to differ from `S3_BUCKET` when both are on the same endpoint. `WECHAT_MP_TEMPLATE_REPORT` must be set for the notice to send. Plan docs: WP-93 #8, SR-59-1/2/3 and WP-63a-S1 are closed.
- **Orchestrator / translation:** the 16 new English keys need the locale pass (`i18n-locale-sync`). `practice.live.cam.*` is shown mainly on GoApply and `practice` has no `.zh` staging file in my ownership.
- **Owner:** the optional `InterviewSession.brand` backfill is no longer needed for correctness.

## i18n keys

- **Added, `practice.live`:** `cam.localOnly`, `cam.localOnlyShort`, `network.label`, `.checking`, `.good`, `.fair`, `.poor`, `.fairBody`, `.poorBody`, `.switchToText`, `.switching`, `.retry`.
- **Added, `practiceQuestions`:** `share.group`, `share.groupNone`, `admin.contribution.suggestedGroup`, `admin.contribution.rejectedFor`.
- **Obsoleted and removed from staging:** `practiceQuestions.companies.source`, `practiceQuestions.company.asOf`.

## Env vars introduced

None.

## Known gaps

- The GoApply requirements preview stays hidden in the UI; the server is gated and never searches, so a preview there would only restate the role.
- A GoApply user who withdraws AI consent between create and prepare gets 503 and the session stays `preparing` until the 30-minute sweep.
- `rejectReason` is stored and shown to staff; there is no contributor-facing list of their own contributions yet.
- The written practice's `cn` block is returned by `score` only, not persisted, so its notice links to `/practice`.
- The live-practice notice fires when the session becomes `completed`; the AI review may still be finishing.
- New `RAMockSession` ids are UUIDs rather than cuids, because the id is generated up front as the seed.
- The stub catalog (`lib/stub`, not owned) has no cn format; the stub is off by default.