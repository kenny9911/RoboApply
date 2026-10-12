INT-10 · **status: complete — all 7 items done, all 3 review findings fixed, all four gates green at default timeouts.**

On the relayed request ("launch the new version and let me try out"): this bundle is not launched. I started no dev server and committed nothing, per the bundle rules. The work is uncommitted in `/Users/kenny/code/RoboApply/.claude/worktrees/wp-INT-10` (branch `wp/INT-10`) for the orchestrator to verify, commit, merge and launch.

## Review resolution

1. **viewedAt stamped by every reader (medium) — fixed, option (a).**
   - `GET /:id/grade/latest` stamps only with `?opened=1`; a plain GET never stamps.
   - New `markResumeCheckOpened(id)` in `lib/api/resumes.ts` sends it. Only `ResumeCheckReport` calls it, from an effect that fires once per check when a finished report is on screen.
   - The editor summary, tailor availability and the onboarding dock still call `getLatestGrade` and no longer stamp.
   - Tests: a plain GET (and `opened=0`, `true`, empty) does not stamp; `?opened=1` stamps once; someone else's check gets 404 and no stamp. The report calls it once across re-renders, not before a finished check, again after a re-check, and the editor popover never calls it.

2. **Signed-out check counts a rule it cannot judge (low) — fixed in owned code.**
   - `server/src/features/tools/checks.ts` belongs to INT-06, so I took the reviewer's fallback: `hasTemplate` now defaults to false, and `defaultResumeCheckDeps()` sets it true.
   - The free tool's count is therefore correct whichever bundle merges first.
   - `ResumeCheckService.test.ts` now runs the real `runChecklist` from `features/tools/checks.js` (intl and cn) and pins `rulesChecked` to `rulesCountFor(profile, false, { template: false })`.

3. **`localParser` opens the local pipeline on GoApply (low) — fixed at two layers.**
   - `uploadAndCreate` ignores the flag on the cn market.
   - `ingestCandidateResume` also ignores `forceLocalParser` on the cn market, so no other caller can reopen it.
   - Tests: a GoApply PDF with `localParser=1` or `true` still goes to GoHire with zero local extractor, OCR or parse-agent calls; the residency test now asserts the flag is ignored on GoApply.
   - The GoHire-down case for scanned GoApply PDFs is not fixed here. `PDFService.ts` is outside this bundle and the reviewer scoped it as a follow-up; it is in Requests and Known gaps.

4. **Unowned edits — all five kept, as colocated tests of owned files; nothing reverted.**
   - `server/src/roboapply/v2/routes/resumes.upload.test.ts`, `resumes.legacyTailor.test.ts`, `resumes.hub.test.ts` (next to owned `resumes.ts`)
   - `server/src/roboapply/v2/lib/resumeExport.test.ts` (next to owned `resumeExport.ts`)
   - `server/src/roboapply/lib/invoiceReceipt.test.ts` (next to owned `invoiceReceipt.ts`)

## Per-item result

1. **REQ-WP15-03 residency — done.**
   - `candidateResumeIngest.ts` runs `applyResumeUploadPolicy` after parse and summary on every path (GoHire, local PDF fallback, `.docx`, LinkedIn `textTransform`). It passes `brand` explicitly to GoHire and to storage.
   - GoApply images go to GoHire only (JPEG/PNG wrapped into a one-page PDF in memory with the existing `pdfkit`). If GoHire can't read one, the upload fails with `image_parse_unavailable`; there is no local OCR.
   - With no known brand, the stricter GoApply rule applies.
   - The three `it.todo` are now tests, plus image and `forceLocalParser` cases. The PII anecdote is scrubbed from `GoHireResumeParseService.ts` and from the ingest comment.
   - New in this pass: `forceLocalParser` is ignored on GoApply.

2. **Upload privacy and cap — done.**
   - `POST /v2/resumes/upload` uses GoHire for a RoboApply user only when `goHireParseActive('roboapply')` and the newest `intl_cross_border_cn_parse` answer is a grant. Declined, never answered, or an unreadable answer all mean local.
   - `localParser=1` forces the local parser on RoboApply; GoApply ignores it.
   - A persisted 10-per-day per-user cap (`RARateCounter`, key `resumeUploadPerUser`) is shared with the LinkedIn PDF import. Past it the route answers 429 `rate_limited` with `Retry-After` and `details.reason: resume_upload_daily_limit`. Idempotent replays and slot-limit refusals don't count; a counter that can't be read fails open.
   - **Added beyond the item:** GoApply uploads without the `ai_resume_parsing` consent now answer 503 `ai_unavailable` (`details.reason: ai_consent_required`) before any file is read. Say if you'd rather not have this.

3. **Legacy tailoring onto tailor sessions — done.**
   - `POST /resumes kind=tailored_for_jd` now runs a tailor session: one `tailor` credit, claim check, `unverifiedClaims`, phone and AI-consent gates. The response adds `tailorSessionId` and `pendingClaims`.
   - `/tailor-diff` and `/tailor-apply` answer 410 `gone`, still behind the old gates.
   - `TailorModal`, its index export, the two hooks and wrappers, and `tailorDiff` with its helpers in `RAResumeAIService` (about 520 lines) are deleted.
   - New `TailorTarget` step: pick a saved job from the tracker, or paste a posting into `jd { title, company, text }`. The editor toolbar mounts `<TailorSheet>`.
   - Hub: tailored copies with unverified details show "Verify details" linking to `/resume?tailorSession=<id>`.
   - `layout_columns` is counted for stored resumes (`UNCOUNTED_RULES` removed); the signed-out free tool leaves it out.
   - **Behaviour changes:** the legacy create no longer makes a free plain copy when AI is off (it answers 503). The tailor job read now applies the GoApply recruitment-info mode.

4. **Fonts — done.**
   - New shared `createRunDrawer` / `fontChainForText` in `resumeExport.ts`; the resume renderer, cover letters and receipts all draw with it.
   - Korean letters embed Noto Sans KR, zh-TW the Traditional face, zh Noto Sans SC. Receipts send Traditional-only characters to the TC face instead of boxes.
   - Attach confirmed: one letter per application, tested at the Prisma store.
   - Visual change: Latin text on receipts now prints in Helvetica rather than Noto Sans SC.

5. **Resume check seams — done.**
   - `RAResumeGrade.viewedAt` is stamped on the authenticated `GET /:id/grade/latest?opened=1`, first view of a finished check only. Plain GETs and server-side reads don't stamp.
   - `/resume/<id>/check?issue=<id>` did not focus the issue before. It now scrolls to it, focuses it, opens its details, and shows a note when the issue is gone.
   - `primaryVariantId(userId)` is exported from `features/resume/index.ts` and on `resumeSuiteService`.

6. **Shim and todos — done.**
   - `HAS_AI_ASSISTED_COLUMN` is removed. `aiAssistedAt` is stamped on an editor PATCH and when a resume-check AI fix is applied.
   - SR-36b-1 is a test (PDF Info, XMP, DOCX properties). SR-37-1 is implemented, not just tested: `createPrismaPostingStore` persists `RACoverLetter.postingSnapshot`.

7. **Test moves, DownloadModal, job scope — done.**
   - Both tests moved next to their sources; every original case is kept, plus the new INT-10 cases.
   - DownloadModal audit: the server puts `unverified_claims` in `code` with `details.count`, so the modal was already correct. It now also accepts `details.reason` and `details.pending`.
   - The export file name and the hub card's job title/company go through `legacyJobVisible`; a GoApply mode-off export never names a third-party posting.

## Files

**Created**
- `components/features/tailor/TailorTarget.tsx`
- `components/features/tailor/__tests__/editorTailor.test.tsx`
- `components/v3/resume-editor/DownloadModal.test.tsx`
- `hooks/tailor/useTailorTargets.ts`
- `hooks/resume/uploadResume.test.ts`
- `server/src/features/resume/primaryVariant.ts` and `primaryVariant.test.ts`
- `server/src/features/resume/tailor/store.test.ts`
- `server/src/features/coverletter/letterExport.test.ts` and `store.test.ts`
- `server/src/roboapply/lib/invoiceReceipt.test.ts`
- `server/src/roboapply/v2/lib/resumeExport.test.ts` (moved)
- `server/src/roboapply/v2/routes/resumes.hub.test.ts` (moved), `resumes.upload.test.ts`, `resumes.legacyTailor.test.ts`

**Deleted**
- `components/features/resume/server/resumeExport.test.ts` and `resumes.hub.test.ts` (and the folder)
- `components/v3/resume-editor/TailorModal.tsx`
- `server/src/features/resume/tailor/legacyTailorDiff.test.ts`

**Modified**
- `app/(auth)/resume/`: `page.tsx`, `[id]/page.tsx`, `[id]/check/page.tsx`
- `components/features/resume/`: `IssueCard.tsx`, `ResumeCheckReport.tsx`, `ResumeCheck.module.css`, `ResumeCheck.test.tsx`, `ResumeHub.tsx`, `ResumeHub.module.css`, `ResumeHub.test.tsx`
- `components/features/tailor/`: `TailorSheet.tsx`, `TailorFlow.tsx`, `Tailor.module.css`, `index.ts`, `__tests__/tailor.test.tsx`
- `components/v3/resume-editor/`: `DownloadModal.tsx`, `index.ts`
- `hooks/tailor/index.ts`, `hooks/useResumes.ts`, `lib/api/resumes.ts`
- `i18n/staging/`: `resume.en.json`, `resumeCheck.en.json`, `tailor.en.json`
- `server/src/features/coverletter/`: `fixtures.ts`, `index.ts`, `letterExport.ts`, `service.ts`, `service.test.ts`, `store.ts`
- `server/src/features/resume/`: `ResumeCheckService.ts` and its test, `check/taxonomy.ts`, `check/rules.test.ts`, `consentWiring.test.ts`, `contract.ts` (comment only), `index.ts`, `legacyAiGate.test.ts`, `memoryStore.ts`, `routes.ts`, `routes.test.ts`, `store.ts`
- `server/src/features/resume/tailor/`: `TailorService.ts` and its test, `agentPrompt.test.ts`, `memoryStore.ts`, `routes.test.ts`, `store.ts`
- `server/src/lib/candidateResumeIngest.ts`
- `server/src/platform/residency/cn0Upload.test.ts`
- `server/src/roboapply/lib/invoiceReceipt.ts`
- `server/src/roboapply/v2/lib/resumeExport.ts`
- `server/src/roboapply/v2/routes/resumes.ts`
- `server/src/roboapply/v2/services/RAResumeAIService.ts`, `RAResumeService.ts`
- `server/src/services/GoHireResumeParseService.ts`

## Tests

1. **Owned areas plus neighbours:** `npx vitest run server/src/features/resume server/src/features/coverletter server/src/features/tools server/src/roboapply/v2 server/src/roboapply/lib server/src/platform/residency components/features/resume components/features/tailor components/features/coverletter components/features/onboarding components/v3/resume-editor hooks/resume hooks/tailor __tests__/contracts` → 79 files, 1526 passed.
2. **Typechecks:** `npm run typecheck:server` and `npm run typecheck:web` → clean.
3. **`npm run check`** → all six checks pass.
4. **Full suite:** `npx vitest run --exclude ".claude/**"` → 557 files, 10102 passed, 1 skipped, 21 todo, at default timeouts. The earlier timeout failures in unowned files did not recur.

`extension/` was not touched.

## Requests

- **INT-08 (onboarding O5):** the upload route enforces the consent itself, so `ResumeStep.tsx` can accept PDFs after a decline. Relax `pdfOpen` / `pdfNeedsConsent`; optionally pass `{ file, localParser: true }` to `useUploadResumeMutation` (RoboApply only). GoApply onboarding should expect 503 `ai_unavailable` (`ai_consent_required`) and 422 `image_parse_unavailable`.
- **INT-08 (`FirstVisitPrompts.tsx`):** nothing to change. It reads `getLatestGrade` without `opened`, which no longer stamps; do not add `opened=1` there.
- **INT-07:** `viewedAt` is now written only when the report page is shown. Read it in `features/lifecycle/repo.ts` and flip `it.todo('SR-39a-1 …')`.
- **INT-06 (`features/tools/checks.ts`):** optional now. Passing `hasTemplate: () => false` in `serviceFor(...)` would make the intent explicit; the count is already correct without it.
- **Orchestrator (`PDFService.ts` has no INT owner):** add a text-layer-only extraction option, for the ingest to use on cn-market PDFs, failing with `image_parse_unavailable` when a PDF has no text layer. I will wire it into `candidateResumeIngest.ts` once it exists.
- **Orchestrator J2:** switch `copilot/store.ts` `primaryResumeId` to `primaryVariantId` from `features/resume/index.js` (same result).
- **Orchestrator J6:** `hooks/useJobSearch.ts` has no importer now that TailorModal is gone. The `tailorDiff` / `tailorApply` slices in `lib/api/v2/_real.ts`, `lib/api/v2/types.ts`, `lib/stub/raV2.stub.ts` and `FIXTURE_TAILOR_DIFF` in `lib/fixtures/resumeAI.ts` have no UI caller.
- **INT-13:** tidy-ups that are safe to leave: the dead tailor-diff rows in `server/src/middleware/userActivity.ts`, the unused tailor-change labels in `raResumeAIMessages.ts`, the retired `tailor-diff` row in `legacyAiGates.test.ts`, a stale path comment at `resumeOriginalStorage.test.ts:164`, and the ARCHITECTURE.md row for `GET /v2/resumes/:id/grade/latest` (add `?opened=1`).
- **Platform ratelimit owner (optional):** add `resumeUploadPerUser: [{ limit: 10, windowSec: DAY }]` to `RATE_LIMITS` so `RATE_LIMITS_JSON` can override it.
- **INT-04 (optional):** the tracker drawer can pass `trackerEntryId` to `DownloadModal`; the prop already exists.

## i18n

**Added (English staging only; none in this pass)**
- `tailor.target.*`: `title`, `sub`, `savedTitle`, `savedLoading`, `savedEmpty`, `savedError`, `pasteTitle`, `jobTitleLabel`, `companyLabel`, `textLabel`, `textHint`, `textShort`, `continue`, `chosenLabel`, `chosenWithCompany`, `change`
- `resume.hub.tailored.verify_cta`, `resume.hub.tailored.verify_aria`
- `resume.hub.errors.upload_daily_limit`, `image_unreadable`, `ai_off`
- `resumeCheck.focus.gone`

**Obsolete:** every key under `resume.tailor.*` in `i18n/messages/*` (used only by the deleted TailorModal).

## Env vars

None introduced. Existing ones read: `GOHIRE_PARSE_BRANDS`, `GOHIRE_PARSE_ENABLED`, `CN_RECRUITMENT_INFO_MODE`.

## Known gaps

- Nothing was looked at in a browser. The target step, the Verify details link, the issue focus, the letter and receipt PDFs still need the 375/1280, light/dark, both-brand pass.
- A GoApply PDF still falls back to the local pipeline when GoHire is down or switched off for the brand, and on the LinkedIn import path. That pipeline can use vision OCR on a scanned PDF (see the `PDFService` request).
- GoApply WebP and HEIC image uploads always fail closed, because only JPEG and PNG can be wrapped for GoHire.
- Opening the report costs one extra GET per check per page mount; the response is discarded.
- A `ResumeCheckService` built without `hasTemplate` reports one rule fewer than it checks. Only the free tool does this today, where that is correct.
- The target step lists the 30 most recently updated tracker entries that have a job record; hand-added entries are not offered.
- Tailored rows written by the old no-AI fallback keep whatever `sourceKind` they have. The backfill is the deferred owner-approved DML.