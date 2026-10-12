# Wave 2 carry-over requests

**Written at the Wave 2 gate (SCHEMA-2 + G3), 2026-10-10.** Source: the 17 Wave 2 handoffs (WP-10 … WP-24). Everything below was asked of a later work package, of INT, or of the owner, and was **not** done at the gate. Items the gate applied are not repeated here; they are listed at the end for context.

How to use this file:
- **Feature agents (Waves 3–5):** read your own section. Each item names the asking WP, the seam to use and the acceptance it implies. Your owned paths still rule: if an item needs a file you do not own, put it in your handoff's Requests.
- **INT (WP-90 … WP-97):** the INT sections are your backlog from Wave 2.
- **Owner:** the "Owner" section lists decisions, credentials and data the code waits on.

Rules that apply to every later WP (from WP-14 and WP-15):
- Crons, workers and scripts must run inside `runWithBrand(user.brand)` (or pass `brand` explicitly). On a production deployment that serves both brands, an LLM call or a residency-critical write with no brand now throws (`BrandContextMissingError` / `WriteBrandUnknownError` → 500 `brand_context_missing`).
- Build LLM prompt context only through `profileSnapshotForLlm(userId)` (`server/src/features/profile`), and redact free text with `redactPii(text, { kinds: LLM_PII_KINDS, knownValues: [name] })` from `server/src/platform/pii`.
- Any call to Tavily, Firecrawl or RapidAPI first calls `assertNoPiInPayload({ brand, target, payload, knownValues })` from `server/src/platform/residency`.
- GoApply AI routes: a WeChat account without a verified phone must answer `403 phone_binding_required` (`requirePhoneBound()` / `assertPhoneBound(userId)` from `server/src/features/auth-cn`), and the UI renders `<PhoneBindingNotice error={err} />` from `components/features/auth-cn` when an AI action fails.
- GoApply AI output: `content_blocked` (422, `details.stage` = `input` | `output`) and `ai_unavailable` with `details.reason = 'content_safety_unavailable'` (503) need plain client copy. Never retry a blocked call on another model.
- Use `offPeakDecision()` (`server/src/lib/llm/offPeak.ts`) for GoApply batch LLM jobs.

---

## Wave 3

### WP-30 · Onboarding (RoboApply)
- **(WP-10)** `/auth/me.onboarding` at step `account` must point `nextRoute` at the first onboarding screen; treat `account` as done.
- **(WP-16b)** Targeted ingest for O6: call `ingestForProfile(searchProfileId, budgetMs)` from `server/src/features/jobs/ingest/index.ts`. Overflow is queued as `ingest.query` items; it only adds demand and never lowers a shared query's priority.
- **(WP-19)** Write `cnFields` only with the documented `CnProfileFields` keys; `PATCH /profile` refuses unknown keys and the sensitive ones (`nativePlace`, `politicalStatus`, `familyMembers`, `photoAssetId`, `gender`, `birthDate`), merges with what is stored, and `null` removes a key. Taiwan desired titles/places (`RAProfile.twFields`, now in the schema) are form answers, not filters; a search profile may offer to start from them.
- **(WP-22)** First resume check during onboarding is free: call `grantOnboardingResumeCheck(userId)` (idempotent) from `server/src/features/resume/index.ts`, then `getResumeCheckService().grade(...)` or enqueue `resume.grade` `{ variantId }`. Read `GET …/v2/resumes/:id/grade/latest` for the "k things to fix" banner.
- **(WP-15)** Show the `intl_cross_border_cn_parse` consent step when `goHireParseActive('roboapply')` is true (RoboApply opted into GoHire parsing, OD-3).
- **(WP-13)** Take consent prose from `GET /api/v1/public/legal/consents`, send back its `proseVersion`, and start every optional box unticked with `initialConsentFormState`.

### WP-31 · GoApply onboarding
- **(WP-16b)** Same `ingestForProfile` seam as WP-30.
- **(WP-19)** Same `cnFields` key rules as WP-30.
- **(WP-13 / WP-11)** Consent text from `GET /api/v1/public/legal/consents`; echo `proseVersion`; `initialConsentFormState` so nothing starts checked. The CN-0 `pipl_cross_border` consent is required.

### WP-32 · Feed API
- **(WP-20)** Fill `feedService.countForFilters` / `limitingFilters`; the `/search-profiles/:id/count` and `/:id/limiting` routes switch over with no change. Add predicates for the GoApply-only `salaryMonthsMin` filter field (stored in the filters JSON). Expose the "Hiding {n} weaker fits" number for the fit-tier view. Invalidate on the `['feed']` query-key prefix.
- **(WP-18)** `matchService.preScoreMany` / `preScoreJobs` return `PreScoreResult` with `score: number | null` (null renders "—", never 0). Please expose a feed retrieval seam; until then the score precompute uses its own narrow candidate query.
- **(WP-17)** Keep jobs carrying an `INTL_SCAM_RULES` flag in `fraudFlags` out of Recommended. GoApply employer tags are stored as bare ids (`soe`, `bianzhi`, `hukou`, `foreign`).
- **(WP-16a)** Use `geo` `findCity` / `cityById` / `cityLabel`; `parseLocation`'s hint has `country` (binding) and `searchCountry` (weak). US regions use the FilterSet convention (`'TX'`); on the cn market `locationCity` is Simplified Chinese.

### WP-33 · Feed UI
- **(WP-18)** V2 Today cards: `deriveFacets` reads `signals.salary >= 70` and calls `skillValue(signals.skills)`; both can now be `null` (the legacy route stopped inventing signals) — render null as unknown. Treat a 503 `ai_off` / `ai_unavailable` from `POST /v2/jobs/:id/score` as "not scored". `tier` is available; `kind` is always `'ai'` on that route.
- **(WP-20)** Use `FilterBar` (or its pieces), `FilterDiff` and `useProfileLabel` from `components/features/filters`; write filter changes through `useApplyFilters` so each change is one PATCH.
- **(WP-23)** Mount `GettingStartedChecklist` on `/jobs` (the `GET/POST /growth/checklist[/dismiss]` routes are now mounted) and send `track('feed_card_impression' | 'feed_rating_submitted', …)`.
- **(WP-17)** Show the job summary as `{ text, aiWritten: true }` ("Summary written by AI from the job post"); sponsorship tooltips come from `sponsorshipEvidence`; citizenship and clearance quotes come from `marketTags` under `REQUIREMENT_TAGS`.
- **(WP-13)** Render `<WhyThisJob explanation={explainMatch(...)} />` wherever a score shows; on GoApply `personalized` = a live `personalized_recommendation` grant.
- **(WP-10)** Signup/login links carry `job` (and `action=apply`); never `jobTitle` (ignored).
- **(WP-16a, decision pending — see Owner)** A LinkedIn `applyUrl` is kept and flagged (`apply_url_linkedin_host`); the source line never shows LinkedIn. Do not show such a link until the owner decides.

### WP-34 · Job detail
- **(WP-18)** Mount `createScoreJobHandler()` at `POST /jobs/:id/score` (answers `{ fit: MatchFitView }`, a superset of `FitView`; `score`/`tier` may be null). Place `<JobFit>`, `<JobKeywordCheck>` and `<FitAnalysisCard>` from `components/features/match`. Mark `server/src/roboapply/v2/routes/jobs.ts` `@deprecated`.
- **(WP-16b)** `CompanyProfile.openJobs` is `Sourced<number>`. `/companies/:id/jobs` returns `{ items: FeedItem[], cursor }` (fit/tracker/badges empty; newest first, undated last). Anonymous callers get only `publicDisplay` jobs; for a signed-in job detail call `companyService.profile(id, { publicOnly: false })`. `lib/api/jobs.ts` `getCompanyJobs` can switch to `CompanyJobsResponse`.
- **(WP-22)** Use `KeywordReport` (`{ resumeId, jobId }`) from `components/features/resume`, or `resumeSuiteService.keywordReport` on the server. The response has `fit` (Sourced 0–100 or null) and `fitTier` — **no `score10`**.
- **(WP-23)** Call `markChecklistStep(userId, 'save_job')` every time a job is saved, then `refreshChecklist(queryClient)` on the client.
- **(WP-17)** Same summary / sponsorship / requirement-quote rules as WP-33.
- **(WP-13)** `<WhyThisJob>` beside every score (as WP-33).
- **(WP-10)** Contextual signup links carry `job` and `action=apply`.

### WP-35 · Job import
- **(WP-16a)** Normalize with provider `'user_import'` and `ctx.ownerUserId`.
- **(WP-15)** Call `assertNoPiInPayload(...)` before every Firecrawl request.

### WP-36a · Tailoring v2
- **(WP-22)** `tailorDiff` still sends the full base resume, contact and personal lines included, to the tailor agent. Strip it with `resumeForLlm` from `server/src/features/resume/index.ts`. Use `keywordRows()` / `matchService.keywordCheck` from `server/src/features/match/index.ts` and the `KeywordReport` contract (`fit`, not `score10`).
- **(WP-23)** Call `markChecklistStep(userId, 'tailor')` on every finalized tailor, then `refreshChecklist(queryClient)`.
- **(WP-19)** Prompt context only through `profileSnapshotForLlm(userId)`.
- **(WP-11)** GoApply AI: `requirePhoneBound()` on the routes; `<PhoneBindingNotice>` on failure.

### WP-36b · Resume hub, export, file record
- **(WP-15 REQ-WP15-03, residency; GoApply CN-0 blocker)** In `server/src/lib/candidateResumeIngest.ts` (no owner yet; request the grant from INT or the orchestrator): after parse and summary, on **every** path (GoHire, local PDF fallback after a GoHire 500, `.docx`, LinkedIn `textTransform`), call `applyResumeUploadPolicy(brand, { rawText, markdown, parsed, summary, highlight })` from `server/src/platform/residency` and store its output; pass `brand` to the GoHire and storage calls; send GoApply image uploads to GoHire only, never to local vision OCR. Then turn the three `it.todo('REQ-WP15-03: …')` cases in `server/src/platform/residency/cn0Upload.test.ts` into real tests. Today the CN-0 local-parse fallback can store a PRC ID number unredacted offshore.
- **(WP-15 REQ-WP15-04)** In `server/src/roboapply/v2/routes/resumes.ts`, call `resumeOriginalFileStorageService.assertAvailable(brand)` before accepting an upload, and add the supertest case "cn-mainland without `CN_S3_*` → 503 `storage_unavailable`, zero PutObject calls" (replaces the `it.todo('REQ-WP15-02/04 …')` in `server/src/platform/residency/resumeOriginalStorage.test.ts`). `storage_unavailable → 503` is already in `platform/http.ts` (applied at the gate).
- **(WP-22)** When `PATCH /:id/layout` ships, save the template as `layout.template` (or `layout.templateKey`) using the `TemplateKey` values in `lib/resumeTheme.ts`, so the check flags `two-column`. Once a layout is saved, remove `layout_columns` from `UNCOUNTED_RULES` in `server/src/features/resume/check/taxonomy.ts`; if you choose another key, update `isMultiColumnTemplate` in `check/rules.ts`.
- **(WP-13)** Write `complianceService.implicitLabelMetadata()` into every export, add `explicitFooterLine()` when `explicitLabelEnabled()`, and call `logAiContentLabel()`. Register the real storage deleter with `registerArtifactStorageDeleter` (compliance retention) — until then artifact rows that point at a stored file are held back.
- **(WP-10)** Also register the account-purge deleter with `setArtifactStorageDeleter` (`server/src/roboapply/services/SeekerAccountPurgeService.ts`) for application files; until then a purge with stored application files is blocked and retried.
- **(WP-11)** Render `<WechatBrowserBanner action="download" />` next to downloads on GoApply.
- **(WP-12 baseline)** `lib/resumeDownload.ts` is still the one baselined raw `/api/v1` literal; moving it into `lib/api/resumes.ts` lets INT delete the last row of `scripts/api-boundary-baseline.json`.

### WP-37 · Cover letters
- **(WP-13)** Same AI-label export rules as WP-36b (`implicitLabelMetadata`, `explicitFooterLine`, `logAiContentLabel`).
- **(WP-19 / WP-11 / WP-24)** Prompt context via `profileSnapshotForLlm`; GoApply `requirePhoneBound()` + `<PhoneBindingNotice>`; client copy for `content_blocked` / `ai_unavailable` (content safety).

### WP-38 · Applications tracker
- **(WP-10)** Register the real storage deleter for application files (`setArtifactStorageDeleter`, account purge) and, with WP-13, `registerArtifactStorageDeleter` (retention).
- **(WP-24)** Client copy for `content_blocked` / `ai_unavailable` on any AI action.

### WP-39a · Notification delivery
- **(WP-21a)** The Friday practice nudge sender is retired (`RoboApplyBillingReminderService` no-op). Send the equivalent under "Tips and reminders" (default off for EEA/UK/CH/CA and GoApply).
- **(WP-14)** GoApply batch sends that call an LLM use `offPeakDecision()`.

### WP-40 · Marketing site
- **(WP-12 R4, blocking at INT)** `components/landing/LandingContent.tsx` (lines ~58-60 and ~330) writes the literal "RoboApply" next to `BrandSymbol`, which follows the request's brand: on goapply.top the GoApply mark sits beside "RoboApply". Use `<BrandWordmark />` or `useBrand().name` (or pin `brand="roboapply"` on the symbol).
- **(WP-21b)** Place `CancelFooterLink` (from `components/features/credits`) in the marketing footer on every page (German label "Verträge hier kündigen").
- **(WP-13, optional)** Server-render the `LegalFooter` model on public pages (it is fetched on the client today).

### WP-41 · GoApply jobs
- **(WP-17)** Do not use the `intl_` prefix for CN fraud rules; `marketHooks.afterEnrich` receives the job with the enrichment update merged in; when the enrichment budget is used up, hooks run only once enrichment finishes.
- **(WP-18)** Write 届别 as `marketTags` entries `{ tag: 'class_year:<yyyy>', evidenceQuote }` so the pre-score's eligibility check reads it.

### WP-42 · Taiwan inventory
- **(WP-16b)** Register `ats_public` with `registerSourceAdapter` (`markets: ['intl']`); assert the Taiwan country check with `rapidApiSearchParams` / `rapidApiCountry` from `server/src/features/jobs/ingest/index.ts`.
- **(WP-16a)** Normalize with provider `'ats_public'` (`sourceBoard` = the ATS name).

### WP-43 · Practice entry
- **(WP-10)** The first free practice credit is granted on email verification (key `email_verified`); Google/LINE accounts get it at creation or when a provider sign-in first verifies an existing account.
- **(WP-23)** Call `markChecklistStep(userId, 'practice')` on every completed practice, then `refreshChecklist(queryClient)`.
- **(WP-21a, decision pending — see Owner)** `getBalance` still gives free users 1 practice credit every month; PRODUCT §6.2 says 1 after email verification plus 1 for the checklist.
- **(WP-24 / WP-11)** Content-safety client copy; GoApply `requirePhoneBound()`.

---

## Wave 4

### WP-50 · Assistant API
- **(WP-14)** Use `streamChatWithTools` from `server/src/platform/llm/index.ts` with task `copilot`. After a tool round, copy `result.reasoningContent` onto the next assistant tool-call message. Treat `LlmStreamInterruptedError` as the SSE `error` event and `BrandContextMissingError` as a server bug. On GoApply, text arrives in ~300-character segments released by WP-24's `createOutputStreamGuard` (wired into `streamChatWithTools` at the Wave 2 integration pass: keyword-length overlap, a trailing partial Latin word held back, a final whole-reply keyword scan, one `RAContentSafetyEvent` row per stream). A block can arrive after earlier text was shown (mid-stream or in the final scan): stop the stream and say plainly that the rest of the reply was blocked.
- **(WP-14, gate wiring)** `assertCopilotModelSupportsTools()` now runs at boot in **report-only** mode (`server/src/platform/startup.ts`, logs a warning per brand). When the Assistant ships, make it blocking (call it with `throwOnError: true`, or remove the `throwOnError: false` in `runStartupAssertions`) and update `server/src/platform/startup.test.ts`.
- **(WP-16b)** The `company_insights` tool must call `companyService.profile(id, { publicOnly: false })` for a signed-in user (the default is the anonymous count).
- **(WP-11 / WP-19 / WP-24)** `requirePhoneBound()` on GoApply; `profileSnapshotForLlm`; content-safety errors.

### WP-51 · Assistant UI
- **(WP-20)** `FilterDiff` plus `useApplyFilters({ patch })` is the Assistant's filter-proposal path.
- **(WP-24 / WP-11)** Client copy for `content_blocked` (input vs output) and `ai_unavailable` (content safety); `<PhoneBindingNotice>`.

### WP-53 · Ready to apply UI
- **(WP-19)** Render `<ProfileCompletionCard linkBase="/profile" />`; the profile's "Application answers" section links to `/ready/setup#answers`.

### WP-54 · People
- **(WP-16b)** Use `bankClients` from `server/src/features/jobs/ingest/index.ts` for contact sync.

### WP-55a · Extension web side
- **(WP-19)** Autofill uses `sensitiveAnswersForAutofill(userId)` (nothing without a live `autofill_sensitive` consent or when the row cannot be read) and `profileService.get` for the rest; EEO values are the closed `EEO_OPTIONS` codes.
- **(Wave 2 integration)** `autofill_sensitive` is now in WP-13's consent catalog for both brands (`server/src/features/compliance/consents.ts`: optional, in-context toggle, withdrawable, unticked; en prose, plus zh on GoApply). It shows in `#consents` and is recorded through `POST /compliance/consents` with the prose hash. Offer it in context where the extension would fill sensitive answers (start unticked; take the prose from `GET /api/v1/public/legal/consents`). Whether GoApply also needs `pipl_sensitive_pi` is an owner decision (see Owner).
- **(WP-10)** Register the storage deleter for any files the extension stores (`setArtifactStorageDeleter`).
- **(WP-11)** Render `<WechatBrowserBanner action="extension" />` next to extension prompts on GoApply.

### WP-56 · SEO
- **(WP-10)** Implement `GET /api/v1/public/seo/jobs/:id` returning a `PublicJobCard` (`title`, `companyName`, …) for `publicDisplay` jobs and 404 otherwise. The signup/login contextual titles and the brand-panel job line appear only once it exists (`getEntryJob` in `lib/api/auth.ts` already calls it).
- **(WP-10)** Public job pages link to signup/login with `job` and `action=apply`, never `jobTitle`.

### WP-62 · WeChat Pay
- **(WP-21a)** Register with `registerRail('wechatpay', impl)`; fulfil through `fulfilPass({ outTradeNo, channel: 'wechatpay', paidAmountMinor, transactionId })` (safe on a replayed notify). Write `AlipayOrder` rows with `tier = ra_<planKey>`, `planKey`, `brand`, `amountMinor`, `channel`, `purpose`. Throw `CallbackRejectedError(msg, reason)` from `verifyCallback`. Require `CN_PAYMENT_COLLECTING_ENTITY` before charging. The 3-day 续费 reminder is already sent by WP-21a's sweep; do not build a second one.

### WP-63a · Interview seam and retention
- **(WP-13)** When `runInterviewRetention` stops being a stub, change the `interview_recordings` row's `enforcedBy` from `not_automated` to `interview-retention` in `server/src/features/compliance/retention.ts` and update the matching expectation in `retention.test.ts` (a test fails if any row claims `interview-retention` while the stub remains). `retention.ts` has no Wave 4 owner: ask INT/the orchestrator for the grant in your handoff.

---

## Wave 5

### WP-74 · Admin console
- **(WP-13)** Admin UI over `GET` / `PATCH /admin/compliance/pi-requests` (due dates: 15 working days GoApply, 30 days RoboApply).
- **(WP-17)** List intl fraud flags (`fraudFlags` with `INTL_SCAM_RULES`) under "Reports to review". Cost analytics treat only the shared-cost user id as platform cost: either set `RA_SYSTEM_USER_ID` to that id or classify by `PLATFORM_SKUS` (now incl. `ra_job_enrich` in `DeductionSku`).
- **(WP-24)** Optional read-only view of `RAContentSafetyEvent` rows (incl. `excerptAnchor`, `finalScan`) and `contentSafetyReadiness()`.
- **(WP-21b, WP-11)** Nav entries for `/admin/credits` and `/admin/invites` (both pages exist; the admin index links neither). `/admin/credits` also needs a wrapper for `GET /admin/credits/refund-quote?userId`.

### WP-75 · Cleanup
- **(WP-21a)** Delete the `billing-friday-nudge` cron (`server/src/cron/handlers.ts`, `RoboApplyCronService`, `vercel.json`) and the `runFridayNudgeSweep` export.
- **(WP-21b)** Delete the deprecated `PlanCatalog`, `CurrencyNote`, `CurrentPlanCard`, `CreditsCard`, `BillingHistoryLink` (`components/v3/account/`), `useCheckout`, `useAlipayCheckout`, `useCancelPlan`, `usePortal` (`hooks/useAccount.ts`) and `__tests__/components/PlanCatalog.test.tsx`. The settings swap is done (Wave 2 integration pass), so no route imports them any more; grep for zero importers first. Keep `useBillingPlan` (still read by `PlanBadge` and `useSubscriptionState`). The legacy `settings.billing.*` / `settings.plan.*` copy keys go with them (WP-91).
- **(WP-12)** `AppearanceSection` (`components/v3/preferences/sections/AppearanceSection.tsx`) and the legacy `DataSection` wrapper are now unused by `/settings` (the gate mapped `appearance` and `privacy` to their area components); delete after a zero-importer grep.
- **(WP-10)** `server/src/roboapply/routes/settings.ts`: its duplicate account-delete route should call `authService.sendAccountDeletedEmail` (or be removed). `/me` still reads the V1 mission for the legacy `onboardingState`.

### WP-76 · Mainland deploy kit
- **(WP-24 / WP-15)** The CN-1 startup check should require `contentSafetyReadiness().cn1Ready` (Aliyun Green with keys), not only the provider name. Note: residency assertions now run at boot (`server/src/platform/startup.ts`).

### WP-77 · Competitiveness (owns `server/src/features/match/` in Wave 5)
- **(WP-18 / WP-15)** Switch `server/src/features/match/pii.ts` to `server/src/platform/pii/redact.ts`, keeping `inputs.test.ts` (He/Li/Ma and CJK name cases) as the scorer's contract.
- **(WP-18 / WP-16a)** Replace `repo.ts companyKey()` with the canonical `normalizeCompanyName` from `server/src/features/jobs/normalize`.
- **(WP-18)** The legacy `/v2/jobs/:id/score` route still sends the unstripped resume to the v2 model and has no 80/day cap; it goes when WP-34/WP-75 retire it.
- **(WP-14)** Confirm `getTaskModel('matching')` resolves per brand everywhere MATCH calls it (WP-14 made `llmModels` brand-aware). `scorerRoute.ts` now resolves the model prefix per brand profile with `resolveProviderPrefix` (RoboApply `qwen/…` = OpenRouter slug) and knows the DashScope/GLM/Ark base-URL variables (Wave 2 integration). Still open: for an unprefixed model id it falls back to the global `LLM_PROVIDER` (`configuredDefaultProvider()`), not GoApply's `CN_LLM_PROVIDER`; it fails closed, but a GoApply bare model id is then judged against the wrong provider. WP-14's check inside `LLMService` stays authoritative.

### WP-79 · Account V2 (owns `server/src/platform/billing/`, `components/features/credits/`, `lib/pricing.ts`)
The billing UI (WP-21b) and server (WP-21a) still disagree on these. The gate adapted only the plan switch (`accountApi.switchQuote/switchConfirm` now call `POST /billing/switch`) and the visitor country (`plansExtras()` falls back to `checkout.country`). If INT has not closed them first:
- `POST /api/v1/roboapply/credits/cancel/survey { reason?, note? }` does not exist; the survey shows "We couldn't send that". It must only record the answer (no cancel, no email, no event) — decide where it is stored (no schema exists for it; a schema request).
- `EntitlementSummary.cancelAtPeriodEnd` (`/credits` and `/auth/me.entitlements`) is missing; the UI falls back to `/billing/plan current.cancelAtPeriodEnd`, which must reflect cancellations of new-catalog subscriptions.
- `POST /credits/cancel` should return `alternative` only once per user; the public cancel confirm should use error code `cancel_token_invalid`; `TwRevenueResponse.warnAt` is ambiguous (UI accepts 0.7 or an absolute NT$).
- Checkout responses: the server answers `{ kind, url, orderId, rail }`; the UI types `{ url } | { orderId, payUrl?, qrCodeUrl? }`. Fine for Stripe; align before CN payments open.

### WP-60 · Invite friends (owns `server/src/features/growth/`)
- **(WP-23)** The checklist store and routes are live since SCHEMA-2 (model `RAGrowthChecklist`, mount `growth` at `/api/v1/roboapply/growth`). One `it.todo('SR-23-1 …')` in `growth.test.ts` remains for a real-database run.

---

## INT

### WP-93 · Final wiring
- **GoApply email signup gate (GoApply launch blocker; WP-11 → WP-10, unowned since Wave 2).** **Interim (Wave 2 integration):** `POST /api/v1/roboapply/auth/signup` answers 403 `signup_closed` on every GoApply host before anything else (`server/src/roboapply/routes/auth.ts`; tests in `auth.brand.test.ts` and `server/src/features/auth/legacyAuth.test.ts`; `EmailMethod` shows `auth.signupForm.closed`). Remove that gate when the real flow below lands, and restore route-level GoApply account-creation tests. The real flow, in `SeekerAuthService.signup` (`server/src/roboapply/engine/services/SeekerAuthService.ts`) and `server/src/features/auth/service.ts`:
  - in invite mode (`CN_SIGNUP_MODE=invite`, the default) email signup on GoApply must redeem an invite inside the account-creation transaction: `authCnService.redeemInviteInTx(tx, brand, code)` (early feedback via `isInviteRedeemable`); never `redeemInvite(userId, code)` after the fact;
  - in production, email signup on GoApply checks `goapplySignupOpen(env)`;
  - GoApply signup consents come from `requiredSignupConsents(env)` with the **server's** prose versions (CN-0 requires `pipl_cross_border` and `pipl_basic_processing`); WP-13 asks the same path to validate through compliance `validateSignupConsents` and store each record's `proseHash`;
  - `GET/POST /account/consents` should delegate to compliance `listConsents` / `recordConsent` (or be dropped for `/compliance/consents`), otherwise records skip the prose hash and the CN-0 purge;
  - web: on GoApply put email login behind "其他方式"; mount `<ChangePhoneSection/>` (from `components/features/auth-cn`) in `#security` on GoApply.
- **Signup attribution (WP-23 → WP-10).** `server/src/features/auth/service.ts:742` calls `recordAttribution(userId, touch, { anonId })` without `linkAllowed`, so marketing fields are always dropped and the `anonId` never links. Use WP-23's recipe: `analyticsIdentity(req, brand.market)` → `{ anonId, linkAllowed }`, `touchesFromClient(req.body?.attribution)` for `firstTouch`/`lastTouch` (second call with `lastTouchOnly: true`). Optionally record an `analytics` consent row for signed-in users.
- **Settings sections still on legacy renderers** (`app/(auth)/settings/page.tsx`): map in `components/features/settings/sectionComponents.ts` and delete the page's renderer + its now-unused state/hooks:
  - ~~`billing`, `credits`~~ → **done at the Wave 2 integration pass** (`CreditsSettingsSection`; the page's `{ tier }` checkout renderer, its banner/region state and hooks are deleted; settings tests updated). The WP-79 list above still applies to that view.
  - `search` → `SearchSettingsSection` (WP-20). Decide where `ResumeSection` and `BlocklistSection` (both draft-backed, today inside the legacy `search` renderer) go. If the legacy search renderer stays, change the page so a preferences refetch does not replace a dirty `draft`/`baseline`: merge only the search-backed keys (`roleTitles`, `workModes`, `cities`, `salaryMinK`, `salaryPeriod`, `employmentTypes`, `companyStages`, `companySizes`, `industriesTarget/Avoid`, `targetCompanies`) into the dirty draft (WP-20).
  - `account`, `security`, `danger` → `AuthSettingsSection` (WP-10) if the page renderers are retired.
  - Optionally mount `PaymentFailedBanner` (WP-21b) in the app layout.
- **CORS (WP-11 → INT, security).** `corsOrigins()` (`server/src/platform/brand/runtime.ts`) allows credentialed requests from **any** `https://*.vercel.app` origin in production (`/^https:\/\/[a-z0-9-]+\.vercel\.app$/i`). WP-11's `POST /auth/wechat/start` relies on production CORS refusing credentialed cross-origin POSTs. Narrow it to this project's preview hosts (e.g. `roboapply-…-kens-projects.vercel.app`) or drop it.
- **Enrichment maintenance (WP-17 → WP-16b).** (Ingest itself now enqueues a materially changed row with `{ jobId, force: true }` — Wave 2 integration, `pipeline.ts` — so edited postings are re-enriched and reconciled.) `jobs-maintain` should re-enqueue `job.enrich` for rows with `enrichVersion < ENRICH_VERSION`, and for `enrichModel = 'rules'` once a model or budget becomes available (GoApply without a domestic model; `ENRICH_DAILY_JOBS=0`). Optional: widen the enrich domestic provider list (`CN_DOMESTIC_PROVIDERS` in `server/src/features/jobs/enrich/agent.ts`) to `qwen`/`dashscope`, `glm`/`zhipu`, `doubao`/`ark` now that WP-14 ships those adapters (check how `options.provider` and the prefix alias combine first).
- **`server/src/platform/flags.ts` (WP-14, optional).** `cnLlmConfigured` rejects `CN_LLM_PROVIDER=newapi` even with an allowlisted host; it could use `checkLlmEgress`. It also ignores the GoApply DB override (errs safe). (The gate already made GoApply `ai.text` require `contentSafetyReadiness().usable`.)
- **`server/src/platform/http.ts` (WP-11, optional).** Fold the auth-cn error codes (`AUTH_CN_ERROR_STATUS`) into `ERROR_STATUS`; today the area writes the same envelope itself.
- **Retention rows (`server/src/features/compliance/retention.ts`, notices and `legal.retention.rows` en/zh):**
  - (WP-10) "Known sign-in devices (hash of account × browser × OS, plus browser and OS names): 90 days after the last sign-in from that device." Sign-in tokens are deleted once used or expired by the nightly account-purge cron.
  - (WP-24) Purge `RAContentSafetyEvent` after 6 months.
  - (WP-21a) Keep `auto_renew_ack` consent records (checkout and plan switch) at least 3 years; check the consent-record row.
  - (SR-13-1) `User.inactivityNoticeSentAt` now exists; the inactive-accounts row can be automated (still "Not automated yet").
- **Privacy/legal content (WP-23, WP-14, WP-15, WP-24 → WP-13; counsel writes the final text):** the drafts under `content/legal/` should name the `ra_anon` and `ra_analytics_consent` cookies and the 13-month event limit, and say that refusing still allows unlinked per-visit counts; GoApply's 个人信息收集清单 lists event collection; add a "Privacy choices" link (e.g. in `LegalFooter`) that calls `requestAnalyticsConsentReview()` from `lib/analytics`; the GoApply processor list adds Aliyun Content Moderation (mainland); render processing facts from `residencySummary(brand)` and the LLM vendor/host lists from `PROVIDER_DEFAULT_BASE_URLS`, `MAINLAND_LLM_HOST_SUFFIXES`, `OPENROUTER_MAINLAND_UPSTREAMS`; render `jobDataAttributions()` (WP-16a; GeoNames attribution once the city table is rebuilt) on `/legal`. Place `CancelFooterLink` in `LegalFooter` (WP-21b).
- **Optional:** a keyed variant in `server/src/lib/crypto.ts` (WP-19 uses its own module with the same envelope); an npm script for `npx tsx server/src/features/jobs/ingest/smoke.ts` (WP-16b); add the `RoboApplyBillingService.alipay.test.ts` path to WP-21a's owns in Appendix A (it was rewritten by WP-21a and merged; the original could not pass against the rail lock).
- **Unassigned (WP-16b):** nothing imports US DOL LCA files into `RAH1bEmployerStat`, so the H-1B route returns no years until an importer exists.
- **Unassigned (WP-19):** a GoApply photo upload endpoint for CN-1 (the profile only accepts `photoAssetId`; the photo is blocked in CN-0).

### WP-91 / WP-92 · i18n merge and translations
- Translate the new Wave 2 namespaces: `auth` (incl. `auth.signupForm.closed`, added at the integration pass), `authCn` (zh staged), `brand` (**zh urgent**: GoApply visitors see the wrong-brand banner in English), `legal` (zh staged; consent prose in other locales and the TW PDPA notice in Traditional Chinese come from counsel), `fit`, `profile`, `filters`, `credits`, `resumeCheck`, `growth` (`growth.consent.body` changed), plus the email staging bundles `auth`, `billing`, `compliance` (ratified at the gate; loaded by the `staging/*.en.json` glob).
- Remove obsolete keys: `auth.signup.{title,subtitle,name,submit,submitting}`; `settings.privacy.{group_data, export_label, export_sub, download_archive, retention_label, retention_sub, retention_30, retention_90, retention_365, retention_forever}`; every `settings.hunt.*` key except `eyebrow`, `title_before`, `title_em`, `title_after`, `sub`, `group_intent`, `intent_label`, `intent_sub`, `group_hard_rules`, `musthaves_*`, `dealbreakers_*`; `credits.usage.practiceNote`; the email keys `billing.renewal.*` and `billing.fridayNudge.*` from all 9 email bundles. `settings.security.error.weakPassword` is no longer used by the change-password form. The legacy `settings.billing.*` / `settings.plan.*` keys can go once WP-75 deletes `components/v3/account` billing pieces (the settings page no longer renders them since the integration pass).
- **WP-92-de:** `credits.cancelPage.footerLink` must read exactly "Verträge hier kündigen" and `credits.cancelPage.confirm` exactly "Jetzt kündigen".

### WP-94 / WP-95 / WP-96 · Gates and browser verification
- Measure ≥90% branch coverage for the pure modules WP-16a (`normalize`, `geo`), WP-17 (`quotes`, `scamSignals`, `reconcile`, `keywords`, `candidates`) and WP-18 (`preScore`) once `@vitest/coverage-v8` is a devDependency (see Orchestrator). Command from WP-16a: `npx vitest run server/src/features/jobs/{normalize,geo,data} --coverage --coverage.include='server/src/features/jobs/{normalize,geo}/**' --coverage.thresholds.branches=90`.
- Check in a real build that the `visitorCountryAction` server function (`app/(auth)/settings/billing/actions.ts`) works from `/settings#billing` behind the proxy (WP-21b), and the GoApply favicon/OG/apple-touch now resolve from `/brands/goapply/*` (WP-12 R1, applied).
- Not yet seen in a browser (every Wave 2 WP): 375 px / 1280 px, light/dark, both brands.

---

## Orchestrator

- **Push SCHEMA-2 before anything runs against the clone database.** The generated Prisma client now includes the SCHEMA-2 columns, so any full-row read of `User`, `RAJob`, `RAIngestQuery` or `RAProfile` fails on a database that has not been pushed. Diffs for the owner: `docs/jobright-clone/schema-diffs/schema2-additive.sql` and `schema2-drift.sql` (identical, additive only, no DROP/ALTER of an existing column).
- **After the push:**
  - WP-16b's missed-refresh rule turns on by itself (it probes `information_schema` for `RAIngestQuery.runCount`, `RAJob.lastSeenQueryId`, `RAJob.lastSeenRun`).
  - Persist `RAJob.originalHost` in the WP-16b upsert (`server/src/features/jobs/ingest/upsert.ts`: row type, column list, mapping, VALUES, INSERT columns and `ON CONFLICT … SET`, plus the SQL snapshot), then turn `it.todo('SCHEMA-2 RAJob.originalHost …')` in `normalizeProviderJob.test.ts` into a test. Do it **only after** the push: the raw upsert would fail on a database without the column. No later WP owns `features/jobs/ingest/`.
  - Run the real-database checks left as `it.todo`: SR-16b-1 (`cron.test.ts`), SR-23-1 (`growth.test.ts`).
  - Run WP-16b's live smoke on the Neon branch: `npx tsx server/src/features/jobs/ingest/smoke.ts --brand roboapply` with `RAPID_API_KEY` set (it writes ingest rows; owner approval).
- **`@vitest/coverage-v8` devDependency** (WP-16a, WP-17, WP-18): `package.json` + lockfile change; WP-24 found `@vitest/coverage-v8@5.0.3` (matching the installed vitest) in the local npm cache.
- **Track A hand-merge:** WP-14 changed 8 Wave 0 tests in `server/src/services/llm/LLMService.fallback.test.ts`. `main` has no commits beyond this branch today; hand-merge that file if Track A touches it again.

---

## Owner

- **H34 cross-brand signup (WP-10).** Signup with an email that exists on the other brand answers 200 `check_email` without a session; a new email answers 201 with a session, so the two can be told apart. Choose: (a) every email signup answers 200 `check_email` and the account is created from the emailed link (changes the signup flow), or (b) accept the leak and record it in TASK_PLAN H34.
- **GoApply email signup** (see INT/WP-93): closed by an interim 403 `signup_closed` gate since the Wave 2 integration pass, because the path does not yet ask for an invite or the CN-0 cross-border consent. Do not remove the gate until WP-93 lands the real flow.
- **Sensitive autofill on GoApply (WP-19 / WP-55a / WP-13):** `autofill_sensitive` now exists for both brands and alone releases stored sensitive answers to the extension. Decide whether GoApply must also hold `pipl_sensitive_pi` (PIPL separate consent for sensitive PI) — both to release them and to store them in the first place (the profile service stores 籍贯 / 政治面貌 / family members without checking it today).
- **OPS-A6 (WP-16b, blocking the GoHire bank):** `DATABASE_URL_GOHIRE` (host 101.89.86.83) uses `sslmode=disable`. Since WP-16b the GoHire bank is switched off without TLS: GoApply bank sync stops and the existing cross-bank GoHire search returns nothing (one warning in the logs). Serve it over TLS and set `sslmode=require` (or `verify-full`).
- **OPS-A4 (WP-16b, SR-16b-3/4):** add a verified-employer field (`Company.employerVerified Boolean`) and an employer syndication-consent field (`Job.syndicationConsentAt DateTime?`) to the RoboHire/GoHire **bank** schemas. Until then every bank job has `employerVerified=false` and `publicDisplay=false`. Also confirm what the bank's `salaryCurrency` (USD default) and `salaryPeriod` (monthly default) mean (WP-16a).
- **LinkedIn apply links (WP-16a → WP-16b/WP-33):** a LinkedIn `applyUrl` is kept and flagged; decide whether "Apply on company site" may open a linkedin.com URL.
- **GoApply LLM models and prices (WP-14, WP-17):** choose the GoApply model ids (`CN_LLM_*`, with a domestic prefix such as `deepseek/deepseek-chat`; a bare id leaves GoApply enrichment rules-only) and confirm their mainland CNY prices plus the CNY→USD rate, so the cost table gets rows (`verify:llm --require-priced` fails until then for configured CN models). Confirm the OpenRouter exclusion list (deepseek, alibaba, baidu, streamlake) quarterly against `GET https://openrouter.ai/api/v1/providers`, and check that no RoboApply model in use is served only by an excluded provider (e.g. `qwen/qwen3.8-flash`).
- **System users (WP-17):** `RA_SYSTEM_USER_ID` and `CN_RA_SYSTEM_USER_ID` must point at existing `User` rows, or the enrichment cost rows fail on the foreign key (logged, not thrown).
- **Practice credits for free users (WP-21a):** today 1 per month; PRODUCT §6.2 says 1 after email verification plus 1 for the checklist. Confirm which.
- **GeoNames (WP-16a):** permission to download `cities15000`, then `npx tsx server/src/features/jobs/geo/buildCities.ts <file>` (the city table is a 285-row hand seed).
- **Counsel / OPS-C:** final text for the 13 legal drafts (incl. the GB 45438 field names and the EU AI Act Art. 50(2) export metadata); whether storing 籍贯, 政治面貌 and family members (optional, encrypted) offshore is acceptable in CN-0 (only the photo is blocked there today, WP-19); GoApply refund policy (draft, WP-21a); set `BACKUP_RETENTION_DAYS` to the Neon history window before the notices are published (WP-13).
- **Content-safety keyword list (WP-24):** the private list at `CN_SAFETY_KEYWORDS_URL` should carry `block` entries for any category nouns you want hard-blocked; the built-in list only reviews them. A live smoke against Aliyun Green needs the large-model moderation services turned on.
- **Brand assets (WP-12):** the GoApply mark and logo are a WP-12 design (a "G" with the next-step arrow), not owner-approved artwork; the PNG wordmarks use system Helvetica; there is no Chinese brand name yet (OPS-B3).

---

## Applied at the Wave 2 integration pass (for context; not carried over)

- `/settings#billing` and `#credits` render WP-21b's `CreditsSettingsSection` (`sectionComponents.ts`); the page's legacy `{ tier }` checkout renderer (409 `plan_not_sellable` since WP-21a), the `?billing=` banner and the region switch are deleted.
- `LLMService.streamChatWithTools` uses WP-24's `createOutputStreamGuard` per attempt (failures mapped like `contentSafety()`); `StreamOutputGate` deleted; streaming tests cover one event row per stream, the partial-word holdback, the final scan and fail-closed.
- Ingest enqueues a changed row's `job.enrich` with `force: true` (`pipeline.ts`), plus a forced-reconcile test in `enrich/service.test.ts`.
- `autofill_sensitive` added to the consent catalog for both brands.
- Interim GoApply email-signup gate (403 `signup_closed`) in `server/src/roboapply/routes/auth.ts`.
- `scorerRoute.ts` resolves prefixes per brand profile and reads DashScope/GLM/Ark base URLs.

## Applied at the Wave 2 gate (for context; not carried over)

Schema (SCHEMA-2, additive; not pushed): `RAJob.originalHost`, `RAJob.lastSeenQueryId` (+ index), `RAJob.lastSeenRun`, `RAIngestQuery.runCount @default(0)`, GIN trigram index on `RACompany.nameNormalized`, `RAProfile.twFields Json?`, `User.inactivityNoticeSentAt`, new model `RAGrowthChecklist` + `User.raGrowthChecklist`; doc comments on `RAAuthToken.kind`, `RAPhoneOtp.purpose`, `RAPersonalInfoRequest.kind`, `RAContentSafetyEvent.verdict/matched`, `RAJob.taxonomyIds/salaryPeriod`, `RACreditLedger.bucket`.

Code: WP-10's `auth.brand.test.ts` patch; rate-limit defaults (`passwordResetPerIp`, `passwordResetSubmitPerIp`, `emailVerifySendPerUser`, `oauthStartPerIp`, `eventsPerIp`) with callers switched; `WipeDataResponse` fields; `purgeAccountNow(userId)` (WP-13 1b); GoApply asset paths + mirror + `it.fails`→`it` (WP-12 R1); API-boundary baseline + gate test (R2); `ra_clamped_from` cookie on the locale clamp (R3); auth language menu limited to brand locales and the job-search guide's mark pinned (R4, partial); slot test rewritten (R5); `appearance` and `privacy` mapped to area components, `consents` and `sensitive` sections and the Profile nav entries flipped to ready (R6, WP-13 7d, WP-19); `PUT /preferences/locale` limited to brand locales (R7); `content/legal/**` shipped with the API function and `/legal/*` (WP-13 7a); `.env.example` additions (WP-13, 14, 15, 16b, 19, 21a, 24); boot-time residency assertions and a report-only Assistant tools check (WP-15 REQ-01, WP-14); `storage_unavailable` (503) and `brand_context_missing` (500) error codes (WP-15 REQ-02); `verify:llm` npm script and CN models in `check:llm-costs` (WP-14); `ra_job_enrich` SKU (WP-17); growth router mounted and its wrapper docs restored (WP-23); GoApply `ai.text` requires a usable content-safety filter (WP-24); profile uses the residency mainland check (WP-15 → WP-19); ARCHITECTURE.md WeChat auth rows and the 13-month event retention (WP-11, WP-23); CN plan §3 RDS note (WP-15). The billing switch adapter and the `checkout.country` fallback are listed under WP-79.
