# Wave 3 carry-over requests

**Written at the Wave 3 gate (SCHEMA-3 + G4), 2026-10-10.** Source: the 16 Wave 3 handoffs (WP-30 … WP-43). Everything below was asked of a later work package, of INT, or of the owner, and was **not** done at the gate. What the gate applied is listed at the end for context. The Wave 2 file (`wave2-carryover.md`) still applies; items here do not repeat it.

How to use this file:
- **Feature agents (Waves 4–5):** read your own section. Each item names the asking WP (in brackets), the seam to use and the acceptance it implies. Your owned paths still rule: if an item needs a file you do not own, put it in your handoff's Requests.
- **INT (WP-90 … WP-97):** the INT sections are your backlog from Wave 3. Requests that Wave 3 WPs addressed to Wave 2/3 packages that have no owner any more are routed to WP-93.
- **Owner:** the "Owner" section lists decisions, credentials and data the code waits on.

Rules added in Wave 3 that apply to every later WP:
- **GoApply recruitment-info mode.** Any reader that can return a job row must hide third-party postings when `CN_RECRUITMENT_INFO_MODE=off`: use `assertCnPostingVisible` / `filterCnPostings` / `cnPostingsWhere` from `server/src/features/cn/jobs/index.ts`. Job detail (`server/src/features/jobs/detail/service.ts` `loadJob`) and company pages (`jobs/companies` router `restrict`) do this since the gate. When your router stops being a stub, replace its `it.todo` in `server/src/features/cn/jobs/__tests__/modeOff.routes.test.ts` with a real test that seeds one GoHire posting through your router's seam (the scanner requires at least one scanned 2xx body; see the `seamsFor()` helper there).
- **Reminder producers** are registered by name in `server/src/cron/handlers.ts` (`tracker`, `agent`, `campus` with `markets: ['cn']`) and run by WP-39a's `runReminders`. Fill your area's `produceReminders` export; if you also call `registerReminderProducer`, pass **the same function reference** (a different task under a taken name throws at import).
- **Inbox rows** go through `notificationCenterService.create()` (`server/src/features/notifications/index.ts`). Rendered template keys today: `inbox.templates.{alerts.instant, alerts.digest, tracker.followUp, tracker.interview}`; any other key shows the stored title and body, so either ask for a key or store real text.
- **Email** is gated by WP-39a's gate AND WP-39b's message-center gate (both fail closed; composed in `features/alerts/preferences.ts` `installEmailPreferenceGate`). Non-transactional mail needs a list (`alerts`, `digest`, `reminders`, `tips`, `marketing`).
- **Apply / Undo.** `useJobActions` (FND) now offers Undo only when the server says the move changed something (`alreadyApplied !== true`). Any new apply surface returns `alreadyApplied` and honours it.
- **Tailoring** launches through the URL: `/resume?tailor=<jobId>` or `/resume/<id>?tailor=<jobId>` (`useLaunchTailor`); `TailorLaunchHost` is mounted on both pages since the gate. Render `<TailorButton jobId from />` (hides itself when AI is off).
- **Schema columns that exist after the SCHEMA-3 push** (not before). **The generated client selects these columns on every default read** (any `findUnique`/`findFirst`/`findMany` without `select` on `InterviewSession`, `RAMockSession`, `RAResumeVariant`, `RAResumeGrade`, `RATailorSession`, `RACoverLetter`, `RAFeedSession`), so against a database without SCHEMA-3 those reads fail with P2022 — **the push must land before this branch runs (`npm run dev`, preview or production deploy) against any database.** Do not add more `'col' in Prisma.*ScalarFieldEnum` shims: they detect the generated client, not the database (`HAS_AI_ASSISTED_COLUMN` in `RAResumeService.ts` is one; remove it after the push): `RAResumeVariant.aiAssistedAt`, `RAResumeGrade.viewedAt`, `RATailorSession.baseContentHash`, `RACoverLetter.postingSnapshot`, `RAFeedSession.windowEndsId`, `InterviewSession.{jobId, recordingConsent, practiceCompletedAt}`, `RAMockSession.{jobId, practiceCompletedAt}`, models `RACnEmployerBlacklist`, `RACnFraudReview`, `RAUnsubscribeFeedback`.

---

## Wave 4

### WP-50 · Assistant API
- **(WP-32)** Tools that list jobs use `feedService.preview` (`server/src/features/feed/index.ts`).
- **(WP-35)** `add_external_job`: `importJob(userId, { url })` for the draft, then `importJob(userId, { manual, importId })`; or `jobImportService.saveJob(userId, fields, { source: 'assistant', importId })`. Both apply the import limits (429 with `details.reason` and `Retry-After`).
- **(WP-36a)** `resumeSuiteService.createTailorSession(...)` works (fast mode) and checks the GoApply phone itself: handle `AuthCnError('phone_binding_required')` (403) and `ai_unavailable` (503).
- **(WP-37)** `coverLetterService.createLetter(...)` and `.attach(...)`; with no locale the letter follows the brand (`zh` on GoApply).
- **(WP-38)** `trackerService.summary()` is live for `application_summary`.

### WP-51 · Assistant UI
- **(WP-33)** After the user confirms a filter change, call `noteAssistantFilterChange({ searchProfileId, before })` from `hooks/feed` (it triggers the "Looks better / Not quite" card on `/jobs`).
- **(WP-36a)** Render `<TailorButton jobId={…} from="assistant" />` from `components/features/tailor`.

### WP-52 · Ready to apply API
- **(WP-34 + WP-38, conflict; see INT item 5)** Two apply/undo seams exist. R-19 says Open application behaves exactly like Apply on company site, so prefer `jobDetailService.recordApplyClick(userId, jobId)` (409 `no_apply_link` → offer "I applied"). If you need a separate `via`, use WP-38's `trackerService.markApplied(userId, jobId, 'agent_open')`, keep the returned `ApplyMark`, and undo with `undoApplied(userId, jobId, { mark })` — but WP-34's `DELETE /jobs/:id/applied` will not undo an `agent_open` move. Pick one per surface and return `alreadyApplied`.
- **(WP-36a / WP-37)** Kits use `createTailorSession` and `coverLetterService.createLetter/attach` (see WP-50).
- **(WP-39a)** Use `NOTIFY_TEMPLATES.readyListReady` and `kitNotOpened`; your reminder producer is `features/agent/cron.ts` `produceReminders` (already registered as `agent`).
- **(WP-39b)** Inbox rows via `notificationCenterService.create()`.

### WP-53 · Ready to apply UI
- **(WP-36a)** Render `<TailorButton jobId from="ready" />` in the kit review.

### WP-54 · People
- **(WP-34)** `PeoplePanel` is mounted in the job page's People tab: shown on RoboApply when `hiringContacts` ≠ `off`, on GoApply only when `cn.referralCodes` is on.
- **(WP-38)** The tracker drawer has no follow-up draft link yet. Add a seam the drawer can mount (a stub component or a `draftHref` prop on `TrackerDrawer`); the keys `applications.follow_up.{write_cta,grounding,open_mail}` are kept for you.

### WP-55a · Extension web side
- **(WP-34)** Call `registerExtensionAtsTypes([...])` (`server/src/features/jobs/detail/index.ts`) with the ATS types the extension can fill; until then `autofill.supported` is false everywhere.
- **(WP-35)** "Save" calls `jobImportService.saveJob(userId, fields, { source: 'extension', idempotencyKey })`; it answers 429 for a locked user or one over the hourly limit — reuse the import page's plain messages.
- **(WP-38)** `userMarkedSubmitted` calls `trackerService.markApplied(userId, jobId, 'extension')`; write `RAApplicationArtifact` rows with `trackerEntryId` so the files show in the drawer.
- **(WP-32)** After `userMarkedSubmitted` / any extension apply or save, call `feedService.recordInteraction(userId, jobId, 'applied' | 'save')` (`server/src/features/feed/index.ts`) once per change, softly (never block the action). Job-page save / apply click / "I applied" do this since the Wave 3 gate (`jobs/detail/service.ts` `affinity`).

### WP-56 · SEO
- **(WP-41, R41-1b)** Public job pages: `assertCnPostingVisible` / `cnPostingsWhere`; replace the `seo` `it.todo` rows in `modeOff.routes.test.ts` with a seeded test.
- **(WP-40)** Align browse slugs with the marketing site: `/browse/{role}`, `/browse/{role}/{city}`, `/browse/remote/{role}`, `?country=XX`, `backend_engineer` → `backend-engineer`. Rewrite the sitemap with `brandLanguageAlternates` (`lib/seo.ts`). Supply the server-side public fetch helper `lib/server/publicApi.ts`. The flag key `seo.browse` now exists (default off on both brands); turn it on when browse pages ship (the marketing quick search then links to `/browse`).
- **(WP-34)** Share links are `/job/<id>-<slug>`; confirm `app/job/[idSlug]` parses them (R-05).

### WP-58 · Campus calendar
- **(WP-31)** Return an `asOf` with `listCampusEvents`, so onboarding can date the campus count before the cn snapshot route is used.
- **(WP-40)** `GET /api/v1/public/campus?openNow=true` feeds the GoApply home preview (only the calendar link shows while it answers 501).
- **(WP-39a)** Use `NOTIFY_TEMPLATES.campusDeadline`; your producer is `features/cn/campus/cron.ts` `produceReminders` (already registered as `campus`, cn only).
- **(WP-32)** The GoApply deadline sort and `campus.applyClosesAt` read only `apply_closes:<yyyy-mm-dd>` market tags with an `evidenceQuote`. `RACampusEvent` has no job link; if you want one, file a concrete schema request (SR-34-2 was too vague to apply).
- **(WP-32 → WP-41, not met at Wave 3)** Only `class_year:` market tags have a producer (`server/src/features/cn/jobs/card.ts`). Write `cn_hire:campus | social` and `apply_closes:<yyyy-mm-dd>` (each with an `evidenceQuote`, only when the posting states it) next to the `class_year:` tags with the same `replace…Tags` merge; `intern_days:<n>` and `school_tier:` likewise. Until then the 校招 filter uses the gate's fallback (`feed/sql.ts`: a `class_year:`-tagged non-internship posting with no `cn_hire:` tag counts as campus), the deadline sort is newest-first and `campus.applyClosesAt` is always null. Owner of the producer: WP-58 (campus) with WP-41's `card.ts`; if WP-58 does not take it, WP-93.

### WP-59 · Practice questions
- **(WP-34)** `/practice/questions/[company]` receives the company slug, or the URL-encoded company name when there is no company record.
- **(WP-43)** The "Practice questions" link on `/practice` (shown only with `interviewBank`) points at `/practice/questions`, not a company page.

### WP-61 · PWA and web push
- **(WP-39a)** `registerDeliveryChannel('web_push', impl)` (`features/alerts/index.ts`): the channel receives `notificationId`, checks its own subscription and sets `pushSentAt` itself.
- **(WP-39b)** Before delivering, check `notificationCenterService.preferencesFor(userId).channels[category]` includes `push`.

### WP-63a · Interview per-brand seam
- **(WP-43)** `POST /requirements/preview` in `server/src/interview-engine/routes/internalRoutes.ts` runs Tavily plus the blueprint LLM with no `aiAllowed` check: add it, and give GoApply a domestic search path or no web search.
- **(WP-43)** Browser session create (`internalRoutes.ts` `POST /sessions`) must be removed or forward `jobId`, `market`, `resumeId` and `recording`; as it stands it can't record and loses the job.
- **(WP-43)** Consider a proper `/practice` mount in `routes/index.ts` instead of the external router.
- **(WP-43-S1, now in the schema)** `InterviewSession.jobId`, `recordingConsent` (`{ audio, video }`) and `practiceCompletedAt` exist after the push. Move `liveMetrics.practice` (`readPracticeMeta`) onto them, reading both during the transition (no backfill DML without the owner).
- **(WP-21a / WP-43)** Written-practice debits put an `RAMockSession` id in `MockInterviewCreditLedger.relatedSessionId` (comment widened at the gate); keep idempotency keys distinct per session type.

### WP-65 · Resume builder
- **(WP-36b)** Any new writer of tailored variants sets `sourceKind: 'tailored'` only for text a model wrote (`'tailored_copy'` otherwise) and stamps `RAResumeVariant.aiAssistedAt` when a model writes into a resume (column exists after the push). Exports read `isAiAssisted()`.
- **(WP-36b)** F-RES-12 section reorder is not built; `layout.{eduOrder, justify, bullet, skillsLayout}` are saved but not rendered.

### WP-66 · GoApply AI面试 format
- **(WP-43)** `/api/v1/roboapply/v2/mock/{start,next-turn,:id/score}` pass the GoApply phone gate and the AI consent gate since the Wave 3 gate (`roboapply/v2/lib/legacyAiGates.ts`, 403 / 503 with zero model calls) but are still not charged. Charge them like a practice, or retire them for seekers (WP-43's client no longer calls them; `hooks/useMockV3.ts` still imports the catalog).
- **(WP-43)** Let `RAMockService.start` accept a `jdText` (or job) brief, so the written practice is seeded with the job post, not only its title and company.
- **(WP-43-S2, now in the schema)** `RAMockSession.jobId` and `practiceCompletedAt` exist after the push; move `readTextPracticeMeta` off `blueprint.practice`.
- **(WP-43)** `PracticeReportEnd` renders `CnReport` on GoApply; fill it.

---

## Wave 5

### WP-70 · Extension adapters
- **(WP-34)** Call `registerExtensionAtsTypes([...])` for every adapter you add.

### WP-72 · Coaching
- **(WP-43)** `PracticeReportCoachLine` receives `{ sessionId, jobId }` at the end of every practice report.

### WP-73 · WeChat notices
- **(WP-39a)** `registerDeliveryChannel('wechat_mp', impl)`; check your own subscription; set `pushSentAt`.
- **(WP-39b)** Deliver only when `preferencesFor(...).channels[category]` includes `wechat`.

### WP-74 · Admin console
- **(WP-32)** "Reports to review": jobs with `closeReason='reported'` and `RAJobInteraction` rows with `kind='report'` (reasons include the cn `scam / training_loan / pay_to_work / fee_required`).
- **(WP-41)** Add `/admin/fraud` to admin navigation. **(WP-42)** Add `/admin/sources`.

### WP-75 · Cleanup
- **(WP-30)** Delete `server/src/roboapply/v2/routes/onboarding.ts`, `RAOnboardingService`, `components/v3/setup/` and `hooks/useSetup*.ts` (zero-importer grep first); obsolete keys `jobs.setup.*`.
- **(WP-32)** Move `CommandPalette`, `useHomeJobs`, `useJobSearch`, `useTodayMatches` off `raV2Api.search.run` onto `lib/api/feed.ts` `queryFeed({ q })`, then unmount and delete `/v2/search` and `RAJobIndexService`.
- **(WP-33)** Delete `app/(auth)/job-search/page.tsx` together with `scripts/job-search-preview/entry.tsx`; `components/job-search/{JobSearchWorkspace,JobResultCard}.tsx` and `__tests__/pages/job-search.test.tsx`; `components/v3/today/lib.ts` with `__tests__/utils/discovery.test.ts`; `hooks/useTodayMatches.ts` once `hooks/useSetup.ts` and its two tests stop importing it.
- **(WP-34)** Delete the legacy `/v2/jobs` route and `hooks/useJobDetail.ts`.
- **(WP-36a)** Legacy `tailorDiff` (`RAResumeAIService`) is `@deprecated`; delete with `TailorModal` once INT item 3 moves its callers.
- **(WP-37)** `RoboApplyAuthorAgent` still imports `SeekerResumeTailorAgent.__test`; delete the two together.
- **(WP-40)** Delete `components/landing/LandingContent.tsx`, `LandingJsonLd.tsx`, `__tests__/pages/landing.test.tsx`; then `landingJsonLd` and `languageAlternates` in `lib/seo.ts` once `app/sitemap.ts` (WP-56) and `__tests__/lib/pricing.test.ts` stop importing them.
- **(WP-36b)** Fold the additive resume fields (`targetTitle`, `layout`, `unverifiedClaims`, `aiAssisted`, `defaultPage`, `basedOnVariantId`, `sourceKind: 'tailored_copy'`) into `lib/api/v2/types.ts`, or delete the V2 slice.

---

## INT

### WP-90 · Schema reconciliation
- **SR-39a-2 (optional, not applied):** a dedicated lifecycle send record (`RALifecycleSend(userId, templateKey, sentAt)`) or `SeekerNotification.hiddenAt`. The code uses `RARateCounter` rows (`lifecycle:sent:<user>:<template>`, 90 days). Apply only if a WP picks one and changes `features/lifecycle/repo.ts`.
- **SR-34-2 (not applied):** an explicit job ↔ `RACampusEvent` link; underspecified (see WP-58).
- **SR-37-2 defaults:** owner decision (see Owner).

### WP-91 / WP-92 · i18n
- Translate (zh first where GoApply renders it): `onboarding` (**urgent zh**: the shared resume and matching screens show on GoApply), `onboardingCn` (route `.zh.json`), `jobs` (incl. new `jobs.card.payPeriod.week`, added at the gate), `jobDetail`, `jobImport` (zh matters most: import is GoApply's main source while the feed is off), `tailor`, `resume`, `coverLetter` (glossary 求职信 / 求職信), `applications` (GoApply labels 收藏 / 网申 / 测评 / 笔试 / AI面试 / 面试 / 三方 / 未通过; rounds 一面 / 二面 / HR面), `notify` (server email, 9 locales, zh priority), `inbox` (`unsubscribe.confirmSub` / `doneSub` are objects now), `landing` (route `.zh.json`), `jobsCn` (route zh, write zh-TW), `jobsTw` (zh-TW first), `practice`.
- Remove obsolete keys: `jobs.{page_title, headline, headlineLoading, sub, read_count, matchesTitle, tag, gap, whyFits, thinking, noReasoning, explanationLanguage, evidence, trail, filter, posted, work, status, facet, detail, actions, appliedOnSiteBanner, notInterestedBanner, empty, error, discovery}` (keep `jobs.fit`, `jobs.score`, `jobs.setup` until WP-75); `applications.sub`, `applications.view.{by_stage,by_date}`, `applications.insight.*`; `resume.library.count`, `resume.import.linkedin.{or,url_label,placeholder,hint}`, `resume.import.errors.{invalid_url,fetch_failed,profile_empty,url_import_not_configured}`; `practice.report.sub`, `practice.setup.format.{video,voice}.{desc,b1,b2,b3}`; `settings.notif.*`; `landing.{meta,header,hero,problem,how,loop,studio,rules,pricing,faq,final,sticky,footer}.*` after WP-75.
- **(WP-38)** The tracker CSV header and stage words are hard-coded in `server/src/features/tracker/csv.ts`; move them into the server email/i18n loader with Traditional labels for RoboApply zh-TW (English today).

### WP-93 · Final wiring
1. **REQ-WP15-03 — GoApply CN-0 blocker, open since Wave 2.** `server/src/lib/candidateResumeIngest.ts` (no owner; WP-93 takes it): call `applyResumeUploadPolicy(brand, …)` from `server/src/platform/residency` on every parse path (GoHire, local PDF fallback after a GoHire 500, `.docx`, LinkedIn `textTransform`), pass `brand` to GoHire and storage, send GoApply image uploads to GoHire only. Then turn the three `it.todo('REQ-WP15-03: …')` in `server/src/platform/residency/cn0Upload.test.ts` into tests.
2. **(WP-30 → WP-36b, privacy)** `POST /v2/resumes/upload` (`server/src/roboapply/v2/routes/resumes.ts`) must not use the GoHire parser for a RoboApply user who declined, or never answered, `intl_cross_border_cn_parse`; accept a flag that forces the local parser for PDFs; add a persisted 10-per-day per-user cap. Until then onboarding O5 refuses PDFs after a decline.
3. **(WP-36a → WP-36b)** Move legacy `/tailor-apply` and `POST /resumes kind=tailored_for_jd` onto tailor sessions (today they skip the `tailor` credit and the claim checks); then retire `TailorModal`. In the hub, mark tailored copies with `unverifiedClaims > 0` as "Verify details" linking to `?tailorSession=<id>`. Remove `layout_columns` from `UNCOUNTED_RULES` in `server/src/features/resume/check/taxonomy.ts` now that layouts are saved as `layout.template`. **Gate note (Wave 3):** `/v2/resumes/:id/tailor-diff` and `/tailor-apply` now pass `requirePhoneBound` + the AI consent gate (`legacyAiGates`), and the legacy job readers are scoped (`legacyJobScope.ts`); the claim check, the `tailor` credit and `unverifiedClaims` are still missing on that path. The editor toolbar's Tailor button (`app/(auth)/resume/[id]/page.tsx` → `TailorModal`) cannot simply switch to `<TailorSheet jobId={null}>`: `TailorSetup` has no target step, and `CreateTailorSessionBodySchema` needs `jobId` or `jd`. Add a target step to the tailor flow (pick a saved job, or paste a posting into `jd: { title, company, text }`), then mount `TailorSheet` there and retire `TailorModal`.
4. **(WP-31 ↔ WP-30)** GoApply onboarding seam. **Joined at the Wave 3 gate:** `saveStep` calls `validateCnStep(step, body, { answers })` (422 with issues) and then `applyCnStep(userId, brand, result, { locale })` (consents, cnFields, default filters; `service.test.ts` covers it). Still to do: use `PUT /steps/confirm` on GoApply (the intl confirm schema requires `experienceLevels`); send GoApply `GET /onboarding/market-snapshot` to `onboardingCnService.marketSnapshotForOnboarding`; build `firstValueRoute` with `cnFirstValueContext`; pass `matchSummary={{ jobCount }}`; wrap the GoApply resume screen in `<CnResumeGate onManual>` and add `resume` to `CN_ONBOARDING_STEPS`; render `<CnFirstValueTour classYear cities campusCalendar aiAllowed onFinish>`. Add `lib/api/onboardingCn.ts` wrappers for `/schools`, `/provinces`, `/market-snapshot`, `/defaults` (router mounted at the gate at `/api/v1/roboapply/onboarding/cn`) and switch `defaultCnOnboardingApi.marketSnapshot` to it through `cnSnapshotView`.
5. **(WP-34 ↔ WP-38) Apply/undo consolidation.** `jobDetailService` (undo within 24 h of an `apply_click`/`manual` move, advisory lock `trackerEntryLockKey`) and `trackerService.markApplied/undoApplied` (token or `via` within 10 min) both exist. Make one the source of truth (or delegate one to the other), have every tracker writer take `pg_advisory_xact_lock(hashtext(trackerEntryLockKey(userId, jobId)))`, and use `payload.via = 'tracker'` for moves made in the tracker.
6. **(WP-31 → WP-32, PIPL Art. 24)** WP-32 implemented non-personalised order itself (`isFeedPersonalized`, `order: 'recency'`, fit null); WP-31 built `feedRankingFor(userId, brand, sort)`. Confirm both read the same `personalized_recommendation` rule (no record = off on GoApply), keep one, and turn `it.todo('… [REQ WP-31→WP-32 #1]')` in `server/src/features/onboarding-cn/onboardingCn.test.ts` into a feed-level test.
7. **(WP-33 → WP-32)** `FeedItem`: `cardMeta?: MarketCardMeta` (from `marketHooks.cardMeta()`, rows with `salaryText, salaryDisclosed, marketTags, sourceName, sourceUrl, applyUrl, sourceBoard, atsType, locationCountry, locations, descriptionPlain` — also WP-41/WP-42) and `explanation?: MatchExplanation`; treat `POST /feed/query` with `overrides.taxonomyIds` and no `searchProfileId` as a browse (market + visibility rules only) so Explore lists match the tile counts. Same `cardMeta` for the job page (`marketMeta` dep in `jobs/detail/defaultService.ts`). On GoApply do not render a second pay or "Updated" line next to `JobMetaCn`. (Sponsorship / no-sponsorship / clearance / citizens-only badges and the stated 网申 close date render since the Wave 3 gate from WP-32's existing badge kinds and `campus.applyClosesAt`; `fitTier` is already honoured by `FeedQueryService`.)
8. **(WP-41, R41-1b)** Mode-off filtering for tracker job cards, match, seeker alerts and saved searches; replace their `it.todo` rows in `modeOff.routes.test.ts`. **(R41-2)** `toUpsertRow` (jobs ingest) should persist `NormalizedJob.fraudFlags` and `marketTags` from `afterNormalize`, merging with other modules' flags. Register SKU `ra_cn_fraud_check` in `raFeatureCatalog.ts` and `matchBilling.ts` (costs log under `ra_job_enrich` with `metadata.task='cn_fraud_check'` today). Place `ExternalSearchLinks` somewhere visible in mode off (import page, tracker empty state or GoApply home).
9. **(WP-38 ↔ WP-39a/39b)** Tracker reminders write `SeekerNotification` and queue `email.send` only once a template exists. Either call `notifyUser` (templates `NOTIFY_TEMPLATES.followUpReminder` / `interviewReminder`, `category: 'reminder'`; `deferred` → keep and retry; `skipped: no_user` → drop) or register `notify.tracker_reminder` (params `{ reason, name, company, title, days, at, href }`). The message center renders only `inbox.templates.*` keys: map `applications.reminders.*` (or switch to `tracker.followUp` / `tracker.interview`).
10. **(WP-39a)** `sendEmail` should return the `RAEmailLog` id so `RAAlertDelivery.emailLogId` can be filled. **(WP-39a → WP-22)** On the authenticated GET of a completed resume check, stamp `RAResumeGrade.viewedAt` (column after the push), read it in `features/lifecycle/repo.ts` `people()`, and turn `it.todo('SR-39a-1 …')` in `lifecycle.test.ts` into a test. **(WP-39a)** An alert-candidate seam on the feed so alerts use the feed's filter semantics (radius, `postedWithinDays`, GoApply fields).
11. **(WP-39a/39b → WP-13)** Add a GoApply `tips_reminders` consent entry with zh prose (default off) in `server/src/features/compliance/consents.ts`; RoboApply's follows the regional default. Optionally clear `notificationPreferences.center.unsubscribed[list]` when `marketing_email` / `tips_reminders` is re-granted. **(WP-43 → WP-13)** Add `interview_video` consent definitions for both brands (until then video is never recorded) and review whether the `interview_recording` wording should mention video.
12. **(WP-39b → WP-10)** `/auth/me.unreadCount` → `notificationCenterService.unreadCount(userId, brand)`; call `notificationCenterService.rememberRegion(userId, x-vercel-ip-country)` at signup, login and `/auth/me`. **(WP-43 → WP-11)** Call `grantPracticeCredit(userId, 'phone_verified', 'phone_verified')` when a phone is bound.
13. **(WP-39b)** Settings: add `notifications: NotificationsSettingsSection` to `SECTION_COMPONENTS` and drop the page's `notifications` renderer and `NotifSection` import (cosmetic: `NotifSection` already renders the new settings). **(WP-30)** Mount `FinishSetupSettingsLine` in Settings `#account`.
14. **(WP-43 → WP-34/WP-38)** Wire the job page's "Practiced" step: `jobs/detail/defaultService.ts` `practicedForJob` → `interviewSessionService.practicedJobs` (includes written practice); then turn `it.todo('SR-34-1 …')` in `server/src/features/jobs/detail/detail.test.ts` into a test (the column is `RAMockSession.jobId`, not `raJobId`). The tracker drawer's "Practice for this job" can use the same.
15. **(WP-35)** Job page: `sourceBoard='user_import'` source line reads "Added by you"; a private import with `applyUrl=''` hides "Apply on company site" (the server answers 409 `no_apply_link`); keep `POST /jobs/:id/save` accepting the user's own private rows (WP-34's `loadJob` allows them). Feed `external` count = `ownerUserId = me AND sourceBoard='user_import' AND archivedAt IS NULL`. Render `FeedTabs` with `feedTabPanelProps('added')` on `/jobs/added` and add a nav/tab entry. Fill `ImportStatusResponse.warnings` from `job.cnFraudWarnings` / `cnImportWarnings(job)` (WP-41). `jobImport.list.emptySub` can mention the fit score again now that job detail is reachable.
16. **(WP-42)** Exclude `ats_public` from date expiry (`resolveExpiresAt` in `jobs/normalize/identity.ts`, `BANK_BOARDS` in `jobs/ingest/maintain.ts`); let `SourceFetchResult` carry a `closeReason` (board closures are archived as `bank_closed` today); optionally add `locationCountry, locations, sourceUrl, applyUrl` to `enrich/repository.ts` `JOB_SELECT` and export `TW_FLOOR_RE` / `NEGOTIABLE_RE` from `normalize/salary.ts`. Render `<NegotiablePayNote context="filter" />` (now re-exported from `components/features/market`) next to "Only jobs that list pay" for zh-TW / TW users (filters, WP-20).
17. **(WP-40)** `HybridShell` header CTA keeps `job` / `ref` / `utm_*` via `buildSignupHref` (`components/features/marketing`); `/help/ranking` reads the weights from `features/feed/contract.ts` (`RANKING_FACTORS`, `ORDERING_RULES`, `GOAL_ADJUSTMENTS`; mirrored in `marketing/catalog.ts` today); link "How ranking works" from the feed sort menu (WP-33). Optional: `supportContactPerIp` and `companyNewsPerUser` in `RATE_LIMITS` (no effect today: both routes pass explicit windows).
18. **(WP-33)** Retitle `/jobs/explore` metadata (still `jobSearchMetadata('search')`).
19. **(WP-36a, optional)** `unverified_claims: 409` in `ERROR_STATUS` (both routers write the response themselves today).
20. **(WP-37)** Cover letters: `renderResumePdf` / `renderResumeDocx(md, { layout, locale, aiLabel, footerLine })` now exist, so letters can share the per-run font chain (Korean letters have no KR face in `letterExport.ts`; zh-TW uses the bundled `HanSansTC` since the gate). Confirm with WP-38 that an application holds one letter (attaching a new one detaches the old one); the drawer's files list shows `RAApplicationArtifact kind='cover_letter'` and links with `coverLetterHref(letterId, entryId)`; the hub's Cover letters tab links `COVER_LETTERS_HREF`.
21. **(WP-36b)** `server/src/roboapply/lib/invoiceReceipt.ts` reads `NotoSansSC-*.ttf`, which covers GB2312 only: Traditional-only characters on an invoice print as boxes. Use the resume exporter's per-run font chain. **(WP-36b → WP-38)** Pass `trackerEntryId` to `DownloadModal` / `downloadResumeExport` from the tracker drawer.
22. **Test locations (WP-36b, WP-43):** `components/features/resume/server/{resumeExport,resumes.hub}.test.ts` and `components/features/practice/__tests__/server/{InterviewSessionService,externalRoutes}.practice.test.ts` test server modules from web-owned folders. Move them next to their sources (rewrite relative paths) or record them in the owners' lists. **(WP-38)** The comment "only four rungs render" in `__tests__/pages/applications.test.tsx` is stale.
23. **(WP-16a carry-over, owner decision pending)** The feed card opens whatever `applyUrl` the apply-click returns, LinkedIn hosts included (`apply_url_linkedin_host` flag); filter them once the owner decides.
24. **(WP-32 → WP-38)** `trackerService.markApplied` (and any other tracker writer that moves a job to Saved or Applied) should call `feedService.recordInteraction(userId, jobId, 'save' | 'applied')` once per change, softly. The job page and feed card (`jobs/detail/service.ts`) do since the Wave 3 gate; the published ranking claim (`RANKING_FACTORS.affinity`, `/help/ranking`) depends on it.
25. **(WP-32 → WP-18 / INT)** The fit-score precompute can take its candidate job ids from `feedService.preview` instead of its own narrow query (was in the gate table, missing from this file).
26. **(WP-36a)** Render `<TailorButton jobId from=… />` on the tracker drawer and the feed card (was in the gate table, missing from this file).
27. **(Wave 3 gate)** Other `apiErrorCode(err) === '<reason>'` checks may have the same bug the feed had (the area reason is in `details.reason`, read it with `apiErrorReason` from `lib/api/contracts/wire.ts`): audit `components/features/auth-cn/{shared.ts,PhoneMethod.tsx}` (`phone_binding_required`, `invite_invalid`), `components/features/credits/PublicCancelFlow.tsx` (`cancel_token_invalid`), `components/v3/resume-editor/DownloadModal.tsx` (`unverified_claims`) against what each server route actually puts in `code`.
28. **(Wave 3 gate)** Legacy job readers not covered by `legacyJobScope.ts`: `RAJobIndexService.getById`, `RAInsightService` (titles by id), `RAResumeService` export file name (`variant.targetJobId`). Scope them the same way or delete them with WP-75.

### WP-95 / WP-96 · Browser verification
- Nothing in Wave 3 was looked at in a browser (375 / 1280 px, light / dark, both brands). Add to the WP-95 flow: `/jobs` split view and Explore, job page tabs, `/jobs/added`, tailor sheet from a job (`/resume?tailor=`), cover letter PDF in zh-TW, `/applications` views + CSV, `/inbox`, `/unsubscribe/[token]`, marketing home / pricing / help / ranking. WP-96: G1–G7, campus-first landing, GoApply home with AI off, `/admin/fraud`, job import with the fraud fixture, mode-off company page (no GoHire job listed or counted).

---

## Owner

- **SCHEMA-3 push (precondition for running this branch).** The generated client already selects the SCHEMA-3 columns on default reads, so resume hub, editor, interview, cover letters and feed sessions 500 (P2022) against a database without them: push before any `npm run dev`, preview or deploy of this tree against the clone Neon branch. Confirm the additive push of SCHEMA-3 to the clone Neon branch (diff attached to the gate report: 10 new nullable columns on 7 tables, 3 `CREATE TABLE`, 11 `CREATE INDEX` (1 unique) incl. a GIN on `RAJob.employerTags` and a `text_pattern_ops` btree on `RAJob(sourceBoard, externalId)`, 1 FK; no `DROP` / `ALTER COLUMN`). After the push, the orchestrator runs the read-only feed index proof: `FEED_INDEX_PROOF=1 npx vitest run server/src/features/feed/indexProof.test.ts`.
- **SR-37-2 (not applied, non-additive):** change `RACoverLetter.tone` default `"professional"` → `"plain"` and `length` default `"medium"` → `"standard"` (an `ALTER COLUMN … SET DEFAULT`; the clone always writes both values, so this is cosmetic).
- **Data (WP-31):** check `server/src/features/onboarding-cn/data/{schools,provinces,industries}.json` against the 985/211 lists, the 2022 第二轮双一流 list, the MCA 行政区划 and GB/T 4754-2017, then set `verified: true` and each `asOf`. Approve downloading the MOE 全国高等学校名单 and run `buildSchools.ts`.
- **Data (WP-42):** record the live ATS fixtures on a machine with network access (`npx tsx server/src/features/jobs/sources/atsPublic/__fixtures__/record.ts --greenhouse <t> --lever <t> --ashby <t> --smartrecruiters <t>`) and commit the `*.recorded.json` + `recorded-meta.json`; TW open-data licence check (T-5); seed the curated board list; confirm the Employment Services Act Art. 5 law link.
- **Decisions (WP-43):** keep the written transcript when recording consent is off (the report is built from it)? Charge the written practice like a live one after the free first practice? WP-21a's one free practice credit a month for Free users is still pending.
- **Decisions (WP-39a):** "Tips and reminders" off when the country is unknown; Free "1 alert a day" counted across all saved searches together.
- **Decisions (WP-40):** non-AI copy for GoApply's `/features/resume` and the "Fewer forms" pillar when `ai.text` is off; RoboApply `/features/interview-practice` stays `noindex` until a server-side flag read exists.
- **Decisions (WP-36b):** confirm upload-parsed resumes are not labelled as AI content; optionally swap Google's Noto Sans TC files in (`server/assets/fonts/README.md`); a data backfill (DML) of tailored rows made before the fix by the no-AI fallback (`sourceKind 'tailored'` → `'tailored_copy'`) needs your approval.
- **Decisions (carried from Wave 2):** LinkedIn `applyUrl` display (WP-16a); GoHire parse for RoboApply (OD-3).
- **Env / credentials:** `SUPPORT_EMAIL` / `CN_SUPPORT_EMAIL`, `LEGAL_ENTITY_NAME` / `CN_LEGAL_ENTITY_NAME`, `NEXT_PUBLIC_EXT_ID` / `NEXT_PUBLIC_CN_EXT_ID` (extension pages and the autofill pricing row appear only when set and `extension` is on), `CN_HR_LICENCE_HOLDER` / `CN_HR_LICENCE_NUMBER`, `CN_LLM_FRAUD_MODEL` (optional), `TAVILY_API_KEY` for company news (flag `companyNews`, off by default).

---

## Applied at the Wave 3 gate (for context; not carried over)

- **SCHEMA-3:** SR-32-1…4, SR-34-1 (as `RAMockSession.jobId`, reconciled with WP-43-S2), SR-35-1 (comment), SR-36a-1, SR-36b-1, SR-37-1, SR-37-2 comments only, SR-39a-1, SR-39b-1, SR-41-1, SR-41-2, WP-42 optional index, WP-43-S1, WP-43-S2, ledger comment (WP-43 → WP-21a), `lastFeedVisitAt` comment (WP-32 contract change). Shims flipped: feed index proof (SR-32-1…3 now planned; three `it.todo` → tests), SR-36b-1 provenance test.
- **Gates and tests:** deleted stale `__tests__/pages/jobs.test.tsx` (WP-33); emptied `scripts/api-boundary-baseline.json` and updated `checkGates.test.ts` (WP-36b); removed the REQ-WP15-02/04 `it.todo` (WP-36b covers it); GoApply landing test now expects `GoApplyHome` (WP-40); onboarding GoApply test expects WP-31's real screen; mode-off route test seams for feed and job detail; schema invariants classify the new models.
- **R41-1:** company job list and open-job count apply `cnPostingsWhere` on GoApply (the `it.fails` is now `it`). **R41-1b (job detail):** `loadJob` hides third-party postings in mode off.
- **Wiring:** onboarding-cn router mounted; `reminders` cron runs `runReminders` with the three producers registered; WP-39a and WP-39b email gates composed; `companyNews` and `seo.browse` flags (default off); `SURFACES_READY.jobDetail` on; `TailorLaunchHost` mounted on `/resume` and `/resume/[id]`; `/resume/letters?job=` accepted; `useJobActions` honours `alreadyApplied`; `SendEmailInput.replyTo` and the support form uses it; TW market re-exports; `.env.example` documents `ATS_PUBLIC_SOURCES_DISABLED` and `CN_LLM_FRAUD_MODEL`; legacy `RATailorDiff.matchBefore/After` nullable with "—" in `TailorModal` (WP-36a hard blocker); weekly pay period on feed cards; nullable `usePathname` in `TailorLaunchHost`; cover-letter PDFs use the bundled `HanSansTC` face for zh-TW.
- **Integration fixes (after the gate review):** GoApply onboarding writes its effects (`validateCnStep` with stored answers → `applyCnStep`; WP-93 #4 first half); 校招 filter fallback on `class_year:` tags (`feed/sql.ts`); feed UI reads `details.reason` (`apiErrorReason`): refresh-limit notice, already-rated card, expired session restarts at page 1; feed cards render `no_sponsorship`, clearance, citizens-only and the stated close date, and GoApply employer tags as copy (`jobsCn.tags.*`); alert senders honour Settings' `center` channels, quiet hours, unsubscribes and `regionCountry`; job page save / apply click / "I applied" feed affinity; legacy `/v2/search/run`, `/v2/jobs/:id/*`, legacy tailor job context scoped to market, own imports and the R-14 mode; legacy `/v2/mock` model routes and `/v2/resumes/:id/tailor-{diff,apply}` behind the phone and AI consent gates.
