FIX-4 handoff (after review) — all 8 review findings resolved in code, none rejected; one gate is red by instruction. Reverting the unowned test leaves 1 failing test in the full suite: `server/src/roboapply/v2/routes/legacyJobScope.test.ts:80` still asserts the `provider` key that caused the critical 500. The one-line fix is in Requests. Nothing committed. Worktree: `/Users/kenny/code/RoboApply/.claude/worktrees/wp-FIX-4` (branch `wp/FIX-4`). Not browser-verified (rules forbid dev servers/browsers).

## Review resolution

1. **[HIGH] Rewrite credit committed for canned fallback — fixed inside owns, cleaner seam requested.**
   - Verified: `RAResumeAIService.rewrite` never throws on a model error, a rejected made-up number or an empty answer, so `withCredit` committed.
   - Fix (`routes/resumes.ts`): the route builds the service's fallback for the same input and compares; on a match it throws a private `CannedRewrite` inside `withCredit` (reservation released) and answers 200 with the fallback.
   - Caveat: it reads the fallback builders through the service's `__test` export, because `RAResumeAIService.ts` is unowned. See Requests.
   - Test: new `resumes.rewriteFallback.test.ts` drives the real service with a failing agent (provider error, fabricated number, empty answer, all three modes) and asserts zero committed rows, zero reserved, no audit log; model-written text costs one credit each.

2. **[HIGH] Parser heal branch misread the editor's own format — fixed.**
   - `lib/resumeStructure.ts`: new anchored `datePart()`. The dates-first reading is taken only when the first part is nothing but a date and the rest still looks like an upload.
   - Bold heads: a date straight after the bold means upload; a date further along means the part in between is the company. `splitRoleCompany` splits on the em dash only (what the upload writes).
   - Also fixed while there: "2021年3月 至今" kept "今" as the end date; it now keeps "至今".
   - Tests (round-trip file): both reviewer probes plus `Now`, `2020`, `Studio 2024` companies, the pasted `**Senior Engineer – Payments** · Stripe · …`, upload shapes, and the mangled-upload heal cases.

3. **[MEDIUM] Failed autosave never retried — fixed.**
   - `useEditorAutosave.ts`: a failed save retries on its own after 2 s, 4 s, 8 s … capped at 30 s; a new edit replaces the retry; retries stop on unmount.
   - Tests: fails twice then saves with no further edit; edit during the wait; unmount.

4. **[MEDIUM] Tailor merge dropped bold-led Summary/Skills lines — fixed.**
   - `tailor/blocks.ts`: the bold-head form counts as an entry line only in experience, projects and education (`isEntryLine(line, key)`).
   - Tests (`claims.test.ts`): the reviewer's summary and skills lines are kept and reported as rewrites; removing every claim returns the base resume.

5. **[HIGH unfixed #2 + MEDIUM] Watermark repair glued Spanish/Portuguese/Italian/English lines — fixed, differently from the suggestion.**
   - Root cause: the repair ran on every PDF, including ones with no watermark.
   - Fix (`PDFService.ts`): words are repaired only when the document actually carried a watermark (scatter verdict, repeated tracking token, hash line, or 3+ debris lines). A clean PDF is returned exactly as extracted.
   - Line rule tightened as a second layer: every vowel and "y" is never glued; a line needs two joinable letters plus a chain ("rodu c t", "Commer c iali z ation") or half the line being lone letters.
   - Why not the suggested one-third density: it would still glue Polish "Praca w firmie z branży IT" and "Series B startup, Type C connector" (exactly one third), and would stop repairing "Commer c iali z ation of new products".
   - Tests: all reviewer probe lines (es, pt, it, k-means, Series B) plus French; document-gate and debris-count tests.

6. **[LOW] Skill gaps padded with boilerplate vocabulary — fixed.**
   - `keywordReport.ts` / `vocabulary.ts`: a job with its own skill list and stored rows gets no text-scan terms on top.
   - Everyday vocabulary words (sales, accounting, API, 招聘, 销售, 测试 …) count only when the skill list, a required row or the job title names them.
   - Tool names that are also words (unity, sketch, excel, spark …) count only when written as a name ("Unity", "Excel, SQL and Tableau").
   - Tests: both reviewer probes; "Sales Manager" and "招聘专员" titles still count.

7. **[LOW] Placeholder hold only with `placeholderLines` — fixed.**
   - `DownloadModal` reads the blanks from `resumeMarkdown` itself (`placeholderLinesOfMarkdown` in `lib/resumeAnalyzer.ts`); the prop is an optional override. The tracker download gets the hold with no change to the tracker component.
   - Test uses exactly the props `ResumeForApplication.tsx` passes.

8. **[LOW] "1 detail … Check them" — fixed.** The second sentence is inside each plural branch for `resume.export.unverified`, and for `resume.export.placeholders`, which had the same fault.

9. **Unowned edit — reverted.** `server/src/roboapply/v2/routes/legacyJobScope.test.ts` is back to HEAD; the need is in Requests.

## Per-finding result (16 original findings, all fixed)

1. **[CRITICAL] GET /v2/resumes 500.** The job-scope select named `provider`, which `RAJob` does not have. Dropped it; the select now `satisfies Prisma.RAJobSelect`; `RAResumeService` reuses the one constant. `NewLetterForm` shows an error with retry. Tests: `legacyJobScope.select.test.ts`, `CoverLetter.test.tsx`.
2. **[HIGH] PDF glues words.** See resolution 5. Test: `PDFService.watermarkRepair.test.ts`.
3. **[HIGH] Editor rewrites an upload with no edit.** The parser reads the upload shapes without loss and autosave compares against what the loaded resume serializes to. Hardened per resolutions 2 and 3. Tests: `candidateResumeIngest.roundtrip.test.ts`, `useEditorAutosave.test.ts`.
4. **[HIGH] zh-TW interface translated an English resume.** The tailor agent uses the resume's own language. Test: `tailor/agentPrompt.test.ts`.
5. **[HIGH] Re-check with no credits showed "Excellent 100".** AI-pass issues still in the text are carried forward; AI-only types show "Not checked this time". Tests: `ResumeCheckService.test.ts`, `ResumeCheck.test.tsx`.
6. **[HIGH] Junk words offered as skills.** Only skills, required rows and vocabulary terms count; tightened per resolution 6. Tests: `keywordReport.test.ts`, `keywordReport.session.test.ts`, `tailor.test.tsx`.
7. **[HIGH] Chinese resume issues.** Headings in the resume's language, mixed-font line height, bold role heads read as entries, markup stripped in the UI. Tests: `resumeExport.test.ts`, `check/rules.test.ts`, `joinPhrase.test.ts`.
8. **[MEDIUM] "Remove" deleted the user's text.** Add + remove are paired as a replacement within the same entry; resolution 4 closes the second route to an empty Summary. Test: `claims.test.ts`.
9. **[MEDIUM] TXT/MD bypassed the Verify-details block.** Every format is blocked; the message links to Verify details; plain text strips markup. Test: `DownloadModal.test.tsx`.
10. **[MEDIUM] Placeholders exported unflagged.** New check issue `placeholder_unfilled`, editor bar, download hold (now from every caller, resolution 7). Tests: `rules.test.ts`, `placeholders.test.ts`, `DownloadModal.test.tsx`.
11. **[MEDIUM] Inline rewrites spent no credit.** One `rewrite` credit per model-written rewrite; failures and canned fallbacks are free (resolution 1). Tests: `resumes.rewriteCredit.test.ts`, `resumes.rewriteFallback.test.ts`.
12. **[MEDIUM] Editor downloads recorded no artifact.** Recorded on the tracker entry for the version's target job. Test: `resumes.hub.test.ts`.
13. **[MEDIUM] Editor at 375px.** Fixed inline negative margin replaced with `.rb-editor-bleed`; toolbar wraps; one-column fields. CSS only, not browser-checked.
14. **[LOW] File name and DOCX author.** Name from the tailor session's posting; creator is the candidate name or blank. Tests: `resumes.hub.test.ts`, `resumeExport.test.ts`, `letterExport.test.ts`.
15. **[LOW] Upload modal copy and timers.** Real formats only; nothing ticks; the done step shows what was read. Test: `ImportModal.test.tsx`.
16. **[LOW] Toolbar at 1280.** Wraps; name ellipsized; local meter labelled "Quick score".

## Files changed

58 tracked files modified, 15 new; all inside `owns` or tests beside owned files. Touched in this pass:

- `server/src/roboapply/v2/routes/resumes.ts`, `resumes.rewriteCredit.test.ts`, new `resumes.rewriteFallback.test.ts`
- `server/src/services/PDFService.ts`, `PDFService.watermarkRepair.test.ts`
- `server/src/features/resume/tailor/blocks.ts`, `tailor/claims.test.ts`
- `server/src/features/resume/keywords/keywordReport.ts`, `vocabulary.ts`, `keywordReport.test.ts`
- `server/src/lib/candidateResumeIngest.roundtrip.test.ts`
- `lib/resumeStructure.ts`, `lib/resumeAnalyzer.ts`
- `hooks/resume/useEditorAutosave.ts`, `useEditorAutosave.test.ts`
- `components/v3/resume-editor/DownloadModal.tsx`, `DownloadModal.test.tsx`
- `components/features/resume/ResumeHub.test.tsx`
- `i18n/staging/resume.en.json`
- Reverted to HEAD: `server/src/roboapply/v2/routes/legacyJobScope.test.ts`

## Tests run

- `npx vitest run --exclude ".claude/**"`: 594 files; 11929 passed, **1 failed**, 1 skipped, 10 todo. The failure is the reverted unowned assertion at `legacyJobScope.test.ts:80`.
- `npm run typecheck:server`: clean.
- `npx next typegen && npm run typecheck:web`: clean.
- `npm run check`: all six checks clean.
- Extension untouched.

## Requests

- **Orchestrator (blocks a green suite):** in `server/src/roboapply/v2/routes/legacyJobScope.test.ts:80` change the expected keys to `['market', 'ownerUserId', 'sourceBoard', 'visibility']`. `provider` is not an `RAJob` column; selecting it is what made every resume list answer 500. No group owns this file.
- **Orchestrator (no group owns `RAResumeAIService.ts`):** make `rewrite()` report whether the model wrote the result (for example return `{ result, agentSucceeded }`). Then replace `isCannedRewrite` in `routes/resumes.ts` with that flag and drop the `__test` import. Until then, do not remove or rename `__test.fallbackBulletRewrite / fallbackSummaryOptions / fallbackSkills`.
- **Orchestrator:** merge and translate the staged keys below.
- **FIX-1 (owns `i18n/messages`), optional:** these `resume` keys are no longer referenced: `export.blocked`, `import.drop.sub`, `import.done.body_import`, `ingest.import.{read,identity_v,experience_v,education_v,skills_v,cleaned,cleaned_v}`, `toolbar.strength`.
- **FIX-7:** the free tool builds its own `ResumeCheckService`, so its skill lists stay lower case. Add `keywordCasing: 'posting'` to its deps and change `server/src/features/tools/service.test.ts:390` to expect `'Python'`, `'Kubernetes'`.
- **FIX-3:** harden the TF-IDF stopwords in `server/src/features/jobs/enrich/keywords.ts`; stored rows still hold "paid", "了解", "28k".
- **Owner of `lib/api/`:**
  - `resumes.rewrite` in `lib/api/v2/_real.ts` sends no `Idempotency-Key`.
  - The rewrite response gives the client no way to tell canned text from model text; a `source` field would let the editor say so.
  - `ResumeVariant` could carry `tailorSessionId`.

## i18n keys added or changed

- Changed in this pass (staging only, not yet merged): `resume.export.unverified`, `resume.export.placeholders` (second sentence moved inside each plural branch).
- Added earlier in this group:
  - `coverLetter.form.resumeError`, `coverLetter.form.resumeRetry`
  - `resumeCheck.carried`, `resumeCheck.compare.notChecked`, `resumeCheck.issue.placeholder_unfilled.{title,why,how}`, `resumeCheck.typeName.placeholder_unfilled`
  - `resume.card.tailored_stamp`, `resume.bullet.placeholder_flag`, `resume.ai_edit_cost`
  - `resume.export.{verify_cta,placeholders_show,placeholders_anyway}`
  - `resume.import.drop.formats`, `resume.import.done.body_read`, `resume.import.reading`
  - `resume.ingest.found.{roles,schools,skills,none}`
  - `resume.toolbar.{quick_score,quick_score_hint}`

## Known gaps

- **Watermark repair**
  - In a watermarked PDF, a line with only one or two scattered breaks ("repor t for the c ompany") is now left as extracted.
  - On a line that is repaired, a lone letter between two whole words can still be glued to the left one ("monthly c ommer" → "monthlycommer").
  - Polish or Czech prose ("w", "z") in a watermarked PDF can still be glued.
  - Noticed, not changed: the older inline-fragment strip in the same pipeline removes 1–2 character tokens between wide gaps, which can drop a real "Go" or "R" from a column layout.
- **Rewrite credit:** a model answer identical to the canned fallback is treated as canned and not charged.
- **Parser:** an upload whose date is free text the anchored check does not read ("Since 2019") followed by a place that contains a year is read as the pasted shape. A pasted head with an em dash and no dates (`**Engineer — Payments** · Stripe`) is read as the upload shape.
- **Download hold:** it is client-side only; the server export does not check for blanks. The editor passes its own list, which does not scan entry titles.
- **Keywords:** the everyday-word and word-like-tool lists are hand-picked; a tool name at the very start of a sentence ("Excel is required.") is not counted.
- Resumes already rewritten by the old editor heal on next open, but a skill label the old parser dropped cannot be restored.
- Tailor sessions created before the pairing fix keep claims with no original; "Remove" still deletes those lines.
- Stored Chinese uploads keep English skill-group labels; Japanese and Korean uploads keep English titles.
- Noticed, not in the bundle: `findJob` in `server/src/features/resume/store.ts` has no market or recruitment-mode scope, so the keyword report can read a public job of the other market by id.