# Wave FIX carry-over requests

**Written at the Wave FIX gate (SCHEMA-FIX + request triage), 2026-10-11.** Source: the nine Wave FIX handoffs (`docs/jobright-clone/orch/handoffs-fix/FIX-1.md` … `FIX-9.md`). Everything below goes to the D5 parity wave (`PAR-1` … `PAR-10`, `docs/jobright-clone/orch/parity-bundles.json`), to the next i18n merge-and-translate pass, to small fix WPs that own only the named files, or to the owner. What the gate applied is listed at the end for context. `wave2-carryover.md` … `waveINT-carryover.md` still apply; items here do not repeat them unless a FIX handoff re-raised them.

How to use this file:
- **PAR-n agents:** read your section. Each item names the asking group in brackets, the files, and the acceptance it implies. Items are grouped by the bundle whose `owns` list contains the file. An item is in your section because you own the file, not because it is part of the parity plan: do it when you are already in that file, and say in your handoff which ones you did.
- **i18n pass:** the section "i18n merge and translate" is one job. Merge and translate must ship together (the merge script drops the old translations of a changed key).
- **Fix WPs:** "Unowned follow-ups" lists changes in files no parity bundle owns. A fix WP owns only the files its item names.
- **Owner:** decisions, credentials, DML and counsel items the code waits on, and choices the FIX groups made that the owner may want to overrule.

Rules added at the FIX gate that apply to every later change:
- **SCHEMA-FIX is empty.** No FIX handoff carries a schema request, and the gate changed no `.prisma` file. There is no diff to push. (One known gap would need a schema change later; see Owner, "Assistant proposals".)
- **`credits_busy` is a registered error code.** `server/src/platform/http.ts` answers `503 credits_busy` with `Retry-After` and `details.retryAfterSec` when a credit reserve finds the database busy. Nothing was reserved, so the same request can be sent again. The web client still folds it into `server_error` (see "Unowned follow-ups", hot files).
- **`RAResumeAIService.rewriteWithSource()`** returns `{ result, agentSucceeded }`. A caller that charges for a rewrite charges only when `agentSucceeded` is true. `rewrite()` is unchanged (it returns `result`). The `__test` fallback builders are still exported for `resumes.rewriteFallback.test.ts`; the route no longer imports them.
- **`ConsentProseLocale` is a contract type** (`server/src/features/compliance/contract.ts`, with `CONSENT_PROSE_LOCALES`). `ResolvedProse.locale`, notifications `tipsRemindersConsent.locale` and auth-cn `SignupConsentProse.locale` are all typed with it; `proseLocale` still exists and holds the same value.
- **The request language on the server** is `X-Robo-Locale`, then the `robo_locale` cookie (`notifications/routes.ts` `localeOf`, `announcements/routes.ts` `requestLocale`, as `auth/routes.ts` `uiLocale` already did). `x-ra-locale` / `NEXT_LOCALE` are read last; nothing sends them.
- **`oss-cn-hongkong` is not a mainland storage host** (`platform/residency/egressPolicy.ts`). A GoApply deployment under the mainland-only storage rule that points `CN_S3_ENDPOINT` at Aliyun's Hong Kong region is now refused, as Tencent's `cos.ap-hongkong` already was.
- **The Stop button reaches the server.** `lib/api/copilot.ts` exports `stopTurn(threadId)`; `hooks/copilot/stopTurn.ts` imports it by name.
- **A feature page's noindex and the static sitemap read one rule**, `isFeatureIndexable` in `components/features/marketing/catalog.ts`.
- **Nothing in Wave FIX was checked in a browser.** Every group says so. The retest list is under Owner.

---

## Parity wave (PAR)

### PAR-1 · Foundation (`lib/brand/`, flags, registry)
1. **GoApply `/en` landing has a Chinese `<title>`, and signed-in pages are titled with the brand name only** [FIX-1]. `lib/brand/metadata.ts` had no owner in Wave FIX. Acceptance: the root metadata title follows the request locale on both brands; a test in `__tests__/lib/brandMetadata.test.tsx`.

### PAR-2 · LLM on the shared stack
1. **Keyword stopwords** [FIX-4 → FIX-3]: done for new enrichment by FIX-3 (two tiers in `server/src/features/jobs/enrich/keywords.ts`). Stored rows still hold "paid", "了解", "28k" until the keyword extraction is re-run (Owner, DML). Nothing to code unless you change the extractor again.

### PAR-3 · Accounts and messaging
1. **Analytics banner covers "Already have an account? Sign in"** on `/signup` at 1280×900 [FIX-2, FIX-8]. File: `components/features/growth/AnalyticsConsent.tsx`. Acceptance: the banner never overlaps the auth card's last link at 1280×900 and 375×812, both brands.
2. **Notification settings on GoApply** [FIX-8 → FIX-3]: in `components/features/notifications/NotificationsSettings.tsx`, hide 邮件汇总 and the email channel when `emailUnavailableReason === 'not_offered'`. Under D5 email falls back to the shared transport, so first check whether `not_offered` can still occur after PAR-3's email fallback; if it cannot, delete the branch instead.
3. **Invite section on GoApply** [FIX-8 → FIX-2]: hide the invite 邮件 button when `notify.email` is off (`components/features/growth/`). Same D5 check as item 2.
4. **`buildPublicUser` leaks at the source** [FIX-2]: `server/src/services/AuthService.ts` `buildPublicUser` still returns token, expiry, `providerId` and Stripe columns; `/auth/me`, signup, login and login/2fa now build `data.user` from an allowlist (`publicUserOf` in `server/src/roboapply/routes/auth.ts`, yours). `AuthService.ts` is not in your `owns`; if you need it, ask for a grant, grep every caller of `buildPublicUser` first (billing may read the Stripe ids), and drop the fields there.
5. **Scorer and consent strings written without a native read** [FIX-6, FIX-8]: the eight `tips_reminders` translations and the new consent sentences in `server/src/features/compliance/consents.ts` (PAR-5 owns the file; see Owner for counsel).

### PAR-4 · Voice and video practice
1. **`medium: 'text' | 'voice'` as a first-class input** [FIX-6]. Add it to the prompt generator (`server/src/roboapply/v2/services/RAInterviewPromptService.ts`, yours) and the interviewer agents (`server/src/roboapply/v2/agents/RAMockInterviewer*`, `RAInterview*`: not in your `owns`, ask for a grant), then delete `WRITTEN_PRACTICE_TYPE_NOTE` and `WRITTEN_PRACTICE_BRIEF` in `server/src/roboapply/v2/services/RAMockService.ts` (also unowned). Until then the written-practice note rides in the type line (95 characters) and the brief prefix (146 characters); keep both under the agents' clips (`RAMockInterviewerAgent.ts:241,253`).
2. **Native review of the scorer strings** [FIX-6]: `server/src/interview-engine/scoring/interviewScorer.ts` `roleFit.skipped` and `strengthFallback` for zh-TW, ja, ko, es, fr, pt, de. A test already checks that none is medium-specific.
3. **Known gaps in files you own** [FIX-6]: `PracticeReportEnd` links to the plan sheet at balance 0 whatever is on sale; the setup's "Get credits" link still points at `/settings#billing`; voice sessions pass no unanswered count, so "Engaged with every prompt" can still appear there; `FALLBACK_BANK` serves English questions in a non-English session when both question generators fail.
4. **`practice` has no zh staging file** [FIX-6, INT-09]. `i18n/staging/practice.zh.json` is yours to create: `practice.setup.insufficientCreditsNoPurchase` zh `这场面试需要 {required} 个额度，你还有 {balance} 个。`.

### PAR-5 · Storage, residency, disclosures, consents, legal
1. **`parsedResumeToMarkdown`** [FIX-7 → FIX-4]: in `server/src/lib/candidateResumeIngest.ts`, prefer `startDate`/`endDate` over a `duration` that holds no date range. The free tool normalises this itself (`withReadableDates` in `server/src/features/tools/parse.ts`); a signed-in upload does not.
2. **Rewrite response `source`** [FIX-4]: `POST /v2/resumes/:id/rewrite` (`server/src/roboapply/v2/routes/resumes.ts`) now knows whether the model wrote the text (`rewriteWithSource`). Add `source: 'model' | 'fallback'` to the response (additive) so the editor can say "this is a standard rewording, not charged". The web type is in the frozen V2 client; see "Unowned follow-ups", hot files.
3. **`WhyThisJob.tsx:24`** [FIX-1 → FIX-8]: the component types `: “{evidence}”` after the label. This is the mixed punctuation seen in zh-TW. Move the colon and the quotes into the message (`explain.fromPosting` / `explain.fromResume` take `{evidence}`), and translate.
4. **Signup consent rows** [INT-01, FIX-8]: done at the gate. `auth-cn/signupPolicy.ts` and `auth/goapplySignup.ts` both look the shown text up with the deployment `env`, through one function (`servedConsentProseByHash` in `compliance/consents.ts`, every language the entry is written in). If you change the processor facts per request, change that one function. Still open, and yours when you are in `server/src/features/auth/signupPolicy.ts` (lines 80 and 91): RoboApply sign-up (email, Google, LINE) writes `age_16_plus`, `tw_pdpa_notice` and `marketing_email` with a version and no hash, because those forms show bundle copy and not the catalog prose. Until the forms show the catalog text and send its hash, these rows answer `answeredTextCurrent: null` (unknown), so Settings cannot tell such a user when a text later changes.
5. **`disclosures.ts` `storageCountry`** still has its own `oss-cn-hongkong` check. It is now redundant with `isMainlandStorageHost`; keep or delete, but keep the test in `consents.test.ts`.
6. **Known gap** [FIX-8]: on GoApply the consent omits AI model rows because routing refuses non-mainland endpoints; if a non-mainland model is misconfigured, `/legal` lists it and the consent does not. D5 changes the routing rule (PAR-2), so re-derive this with PAR-2's `llmEndpointFacts()` after it merges.
7. **Known gap** [FIX-4]: `findJob` in `server/src/features/resume/store.ts` has no market or recruitment-mode scope, so the keyword report can read a public job of the other market by id. The file is not in your `owns` (nor anyone's); the scoped loader is `loadLegacyVisibleJob` in `server/src/roboapply/v2/lib/legacyJobScope.ts` (PAR-7). Listed here because it is a cross-market read; a fix WP may take it.

### PAR-6 · Payments and credits
1. **`credits.busy` string** [FIX-9]: add `credits.busy` ("We could not start this right now. Try again in a moment.") to `i18n/staging/credits.en.json` and `.zh.json`. The client code that would show it is a hot-file change (see "Unowned follow-ups").
2. **"0.75 used" / "已用 0.75 次"** for a practice interview that used part of a credit [FIX-9]: reads awkwardly with 次. A dedicated string (`credits.usage.usedPractice`) in `components/features/credits/CreditsUsage.tsx`.
3. **"Refills tomorrow 12:00 AM"** has no "at" [FIX-9], to avoid a new English string showing in eight locales. Add the word when the next translation pass runs.
4. **Account deletion reason** [FIX-2, INT-12]: the modal no longer asks for a reason. `deleteAccount` in `lib/api/account.ts` (yours) never sent one. If the owner wants the field back (Owner), send and store it; `server/src/roboapply/routes/account.ts` `POST /delete` must then accept an optional `reason` (unowned).
5. **A 429 from legacy `POST /billing/checkout`** still carries no `Retry-After` header [INT-02]; `fail()` and `mapError` in `platform/http.ts` now send it for `rate_limited` and `credits_busy` whenever `details.retryAfterSec` is present.

### PAR-7 · GoApply job-source layer, feed, tracker, agent, admin
1. **Weekly insight in the reader's zone** [FIX-3]. Server-ready: `core.weeklyFacts(userId, weekStart, tz?)` (`server/src/features/tracker/service.ts`). To finish:
   - `server/src/roboapply/v2/services/RAInsightService.ts` (yours): `getWeekly` and `refresh` take a `tz` and pass it as the third argument of `tracker.weeklyFacts`; `refresh` takes the same `weekStartUtc` as the GET.
   - `WeeklyInsightQuerySchema` in `server/src/features/tracker/contract.ts` (yours): optional `tz` (IANA, validated as the CSV route does).
   - `server/src/roboapply/v2/routes/insights.ts` (unowned; ask for a grant): read `tz` on `GET /weekly` and `POST /refresh`.
   - `lib/api/tracker.ts` (unowned; ask for a grant): `getWeeklyInsight(weekStartUtc?, tz?)`, `refreshWeeklyInsight(tz?)`, and `trackerExportCsvUrl(timeZone?)` adding `?tz=`; then `components/features/tracker/ApplicationsToolbar.tsx` (PAR-8) can drop its local `withTimeZone`.
   - Until then an account with no stored zone gets UTC-bucketed weekly counts.
2. **Stored rows keep old values** [FIX-3]: jobs classified `primaryTaxonomyId = 'architect'`, pay normalised before `payPlausible`, keywords extracted before the new stopwords. All three need DML (Owner). New ingest is correct.
3. **`MatchService` rewrite** [FIX-3]: a "rewrite in my language" still runs the full scorer and discards its numbers; a prose-only prompt would be cheaper (the agent is `RAJobMatchScorerAgent`, unowned). When a rewrite fails because of the daily limit the client still says "Try again"; return a distinct reason so the UI can say when it resets.
4. **People search for a composite role** [FIX-3]: `server/src/features/jobs/detail/view.ts` `searchRole` falls back to the cleaned title head, which can be generic ("Sr. Manager, Strategic Finance - EMEA" gives "Manager").
5. **`{ label: <code>, country: <code>, radiusKm: 0 }` means the whole country** in the feed (`feed/sql.ts` `isCountryWideLocation`) [FIX-3; asked by FIX-2, done]. Any new writer of saved-search locations must keep that shape; the client rule needs the label to name the country.
6. **Ready to apply** [FIX-5]: "Company I don't want" ratings now exclude that company (`server/src/features/agent/service.ts` `applyDislikes`), which was not in the finding. See Owner if this should be reverted.
7. **Fraud and tag quotes** on GoApply cards are still cut from the folded (half-width) text [FIX-3] (`server/src/features/cn/jobs/`).

### PAR-8 · Job search, workspace parity, job detail, filters, extension
1. **Campus apply window in the campus zone** [FIX-1 → FIX-3]: `components/features/job/JobOverview.tsx:33` formats `applyOpensAt` / `applyClosesAt` with no zone. Pass `timeZone: CAMPUS_TIME_ZONE` from `components/features/campus/format.ts`, as `EventCard.tsx:61` does. Acceptance: a viewer in `America/Los_Angeles` sees the same day as the calendar card.
2. **`connectedOn` is a date-only value** [FIX-1 → FIX-3]: `components/features/network/ConnectionsList.tsx:50` and `PeoplePanel.tsx:63` must pass `timeZone: 'UTC'`, or the month shifts west of UTC.
3. **Punctuation typed in code** [FIX-1 → FIX-3]: `components/features/feed/JobCard.tsx:281,287` types `: ` after `t('whatsMissing')` / `t('whatLinesUp')`. Move it into the message (or use a lead-label pattern with no colon) so zh/zh-TW/ja get full-width punctuation.
4. **`/jobs` header** [FIX-8 → FIX-3]: `jobs.workspace.intro` (`components/features/feed/JobsWorkspace.tsx:151`) needs state-aware variants for "no resume yet" and "personalised ranking is off" (GoApply 个性化推荐 off, or AI consent off).
5. **Saved-search limit message** [FIX-1 → FIX-3]: the web shows the server's English `Up to ${max} saved searches on this plan`. Render an ICU plural from the error's `max` in `components/features/filters/` (yours); the server side is in "Unowned follow-ups".
6. **Typeahead labels** [FIX-2, FIX-3]: role groups and categories are named from the web bundle; suggestion labels still come from the server in English for every locale but zh. FIX-3 staged 230 `taxonomy.roles.*` names: once translated, name suggestions from the bundle by taxonomy id in `components/features/filters/SearchTypeahead.tsx` and stop reading the server label.
7. **Tracker toolbar**: drop `withTimeZone` in `components/features/tracker/` once `trackerExportCsvUrl(timeZone)` exists (PAR-7 item 1).
8. **Floating Ask button** [FIX-5]: it can cover the resume editor's "Next note" when no field is focused. The button is in `components/features/copilot/CopilotRail.tsx` (not yours; you own only `VoiceInput.tsx`), the page is the resume editor (unowned). Listed for whoever next edits either.

### PAR-9 · Public surfaces
1. **GoApply home campus preview** [FIX-1 → FIX-7]: `components/features/marketing/GoApplyHome.tsx:61` (used for `applyClosesAt` at line 76) formats with no zone. Pass `timeZone: CAMPUS_TIME_ZONE`; this also stops the text changing after hydration.
2. **Free tools skill casing** [FIX-4 → FIX-7]: the free tool builds its own `ResumeCheckService`, so its skill lists stay lower case. Add `keywordCasing: 'posting'` to its deps in `server/src/features/tools/service.ts` and change `server/src/features/tools/service.test.ts:390` to expect `'Python'`, `'Kubernetes'`.
3. **Marketing footer and pricing on GoApply** [FIX-8 → FIX-7]: hide `CancelFooterLink` in the marketing footer on GoApply (passes do not renew; `/cancel` there renders `NoRenewalNotice`); gate the pricing "instant alert emails" row and the `/security` "we email you" line on the `notify.email` capability. Under D5 email falls back to the shared transport, so check the capability after PAR-3 before hiding anything.
4. **Campus class filter** [FIX-8]: `components/features/campus` should default the class filter to the user's 届别 (needs `cnClassYear`; see "Unowned follow-ups", onboarding contract).
5. **Ranking page** [FIX-7]: the sorts sentence names the three shared sorts; GoApply's fourth ("Applications closing soonest") is not mentioned. pt's sentence says "Melhor encaixe" while its menu says "Seus melhores encaixes" until re-translation.
6. **Free matcher known gaps** [FIX-7]: season dates ("Summer 2017"), roles written as bullets and unrecognised experience headings stay "Not listed"; a certificate or degree line directly above a job's lines keeps that job out; a dated line under an unknown heading that matches no guard pattern still counts as a role. Hard-skill count stays 3 of 4 on the QA files until the vocabulary is extended ("Unowned follow-ups", resume keywords).

### PAR-10 · Docs, env examples, deploy kit
1. **`.env.example`** now documents `PRISMA_TX_MAX_WAIT_MS`, `PRISMA_TX_TIMEOUT_MS`, `PRISMA_POOL_MAX` (gate). Mirror them in `deploy/cn/cn.env.example` if the mainland kit lists database tuning.
2. **`PRODUCT_PLAN.md` G3**: `fullTime` (统招) is documented as a toggle defaulting **On**; FIX-8 shipped an optional 是/否 with no preselection. Update the table once the owner rules (Owner).
3. **`ARCHITECTURE.md` §7.3** was updated at the gate (single-statement window reserve, settle limits, `credits_busy`, practice rows in `/credits/history`). `PRODUCT_PLAN.md` G1 was updated (processor list comes from configuration; earlier-text grants are asked again).
4. **Post-merge verification list**: add the browser retests under Owner.

---

## i18n merge and translate (one pass, after PAR)

`node scripts/i18n-merge-staging.mjs --dry-run` at the gate: valid; **382 new keys, 8 changed, 0 removed; 79 zh keys go to `zh.json`, 0 to the GoApply override**. Files with content: `accountV2`, `assistant`, `auth`, `billingCn`, `coverLetter`, `filters`, `fit`, `inbox`, `jobImport`, `jobs`, `jobsCn`, `landing`, `legal`, `onboarding`, `onboardingCn`, `practice`, `practiceCn`, `ready`, `resume`, `resumeCheck`, `taxonomy` (en; zh where a GoApply group staged it).

Changed keys (their old translations are dropped by the merge, so translate in the same pass): `fit.keywordCheck.count`, `jobImport.list.status.rejected` ("Rejected"), `landing.ranking.otherSorts` (now takes `{newest}`, `{bestFit}`, `{highestPay}`; suggested zh `“{newest}”“{bestFit}”“{highestPay}”都只按这一项排序。`), `practice.setup.creditCost`, `practice.setup.creditsRemaining`, `practice.setup.insufficientCredits`, `practice.setup.flow.costShort` (English ICU plurals; the other eight bundles need no change in meaning), `ready.intro.point_open`.

New keys by group:
- **[FIX-2]** `accountV2.prefs.identity.{name_ph,name_save_failed,pronouns_she,pronouns_he,pronouns_they,years_unset,linkedin_invalid}`, `accountV2.prefs.danger.{confirmKeyword,signedOutNow}`, `accountV2.prefs.security.{phoneNote,wechatNote,otherNote}`, `auth.verify.requestNew`, `auth.brand.feature_interview_written`, `onboarding.confirm.{titleSearch,titleSearchCapped,titleSearchNone,titleUncounted,searchNote,countNoteCompared}`, `onboarding.resume.errors.consentUnanswered`. **`confirmKeyword` must be the word each locale already types today:** en `DELETE`, zh `删除`, zh-TW `刪除`, ja `削除`, ko `삭제`, de `LÖSCHEN`, es `BORRAR`, fr `SUPPRIMER`, pt `APAGAR`. Until then de/es/fr/pt show `DELETE` in both danger dialogs (hint and check agree).
- **[FIX-3]** `filters.chips.{anywhereIn,sponsorshipNotNeeded,cleared,undo}`, `fit.keywordCheck.{shownBy,via}`, `fit.otherLanguage.{note,rewrite,rewriting,failed}`, `inbox.alertJobs.{label,item,more}`, `jobs.card.firstSeen`, `jobsCn.fit.logistics` (en + zh), `taxonomy.roles.*` (230 role names; zh-TW and ja first, since role names in those locales render in English today).
- **[FIX-4]** `coverLetter.form.{resumeError,resumeRetry}`, `resumeCheck.carried`, `resumeCheck.compare.notChecked`, `resumeCheck.issue.placeholder_unfilled.{title,why,how}`, `resumeCheck.typeName.placeholder_unfilled`, `resume.card.tailored_stamp`, `resume.bullet.placeholder_flag`, `resume.ai_edit_cost`, `resume.export.{unverified,placeholders,verify_cta,placeholders_show,placeholders_anyway}` (the first two are ICU plurals with the second sentence inside each branch), `resume.import.drop.formats`, `resume.import.done.body_read`, `resume.import.reading`, `resume.ingest.found.{roles,schools,skills,none}`, `resume.toolbar.{quick_score,quick_score_hint}`.
- **[FIX-5]** `assistant.cards.{applying,waitForAnswer,notSaved,inProgress}`, `assistant.cards.notice.stopped`, `assistant.cards.fit.{snapshot,openJob}`, `assistant.cards.jobList.workModel.{remote,hybrid,onsite}`, `assistant.cards.jobList.addedByYou`, `assistant.cheatsheet.{needsJob,openJobs,needsJobHere}`, `assistant.tools.added_jobs`, `assistant.context.{noJob,otherJob,askPageJob}`, `assistant.composer.placeholderShort` (**must stay short in every locale: the rail box is narrow**), `ready.setup.calibrate.{later,laterNote,noFeed}`, `ready.review.resume.fitNote`, `ready.review.open.{leadNeutral,host}`.
- **[FIX-6]** `practice.setup.insufficientCreditsNoPurchase` (suggested zh `这场面试需要 {required} 个额度，你还有 {balance} 个。`, zh-TW `這場面試需要 {required} 個額度，你還有 {balance} 個。`), `practiceCn.report.fillers.noteTyped` (zh staged `根据你输入的回答统计。`; suggested zh-TW `根據你輸入的回答統計。`). **Do not ship GoApply before this merge:** `lib/i18n.ts` merges only staged English at run time, so GoApply shows the English strings until then.
- **[FIX-7]** no new key; `landing.ranking.otherSortsNamed` was withdrawn and never merged.
- **[FIX-8]** `onboardingCn.consent.{given,givenOn,requiredGiven,changedSinceOn,changedSince}`, `onboardingCn.common.optional`, `onboardingCn.education.{fullTimeYes,fullTimeNo}`, `onboardingCn.confirm.{summaryTitle,edit,editRow,notSet,skipped,notChosen,fullTime,resumeAdded,resumeNone}`, `onboardingCn.confirm.rows.{identity,education,roles,cities,workType,pay,employer,resume,ai,ranking}`, `onboardingCn.manual.*` (incl. `problem.dateFormat`, `monthPlaceholder`), `billingCn.noRenewal.{title,body,ends,pricingLink,settingsLink}`, `legal.consents.{textChanged,agreeCurrent}` (all en + zh).
- **[FIX-9]** none staged. `credits.busy` is asked for under PAR-6.

Keys to remove from all nine bundles (grep before removing each):
- [FIX-2] `settings.identity.new_grad`, `settings.danger.reasonLabel`, `settings.danger.reasonPlaceholder`, `settings.danger.error.reasonRequired`; and `settings.danger.delete_data_confirm_keyword` once `accountV2.prefs.danger.confirmKeyword` is translated.
- [FIX-4] `resume.export.blocked`, `resume.import.drop.sub`, `resume.import.done.body_import`, `resume.ingest.import.{read,identity_v,experience_v,education_v,skills_v,cleaned,cleaned_v}`, `resume.toolbar.strength`.
- [FIX-8] `onboardingCn.consent.aiOffshore` (no longer rendered; it carried the false claim that AI processing is offshore).

Bundle shape changes asked for:
- [FIX-2] Replace the three-part settings headings with one `title` key per section, so translators own the spacing (`joinTitle` / `joinTitleTail` in `components/v3/preferences/controls.tsx` then go away).
- [FIX-2 ← FIX-1] `settings.usage.actionCount` cannot be pluralised in the bundle alone: `components/v3/account/usage.tsx:69,75` passes a pre-formatted string as `count`. Pass the number and format inside the message (`{count, plural, one {# action} other {# actions}}`).
- [FIX-1] `seo.job.notFound.home` is now also the visitor's button on the 404 and the route error page; a wording change there changes both.

Server strings (not in the web bundles): the consent prose in `server/src/features/compliance/consents.ts` (version `2026-10-11.fix8.v2`) and the scorer strings in `interviewScorer.ts` are written in nine locales by the FIX agents and have had no native or counsel read (Owner).

---

## Unowned follow-ups (fix WPs; each owns only the files it names)

**Hot files (orchestrator or a granted WP)**
1. **`lib/api/client.ts` `normalizeCode`** [FIX-9]: any unknown 5xx code becomes `server_error`, so the client cannot tell `credits_busy` from a crash. Add a retryable code for it (`RoboErrorCode`), honour `Retry-After` / `details.retryAfterSec`, and show `credits.busy` (PAR-6 stages it). Not applied at the gate: it needs a new string in nine locales and a consumer.
2. **`components/v3/shell/HybridShell.tsx`** [FIX-7 → FIX-1]: while the session is `loading`, the marketing chrome shows "Sign in / Get started" even to a signed-in user (about 1.5 s on `/help/ranking`). The handoff asks to hide the two links while loading. Not applied at the gate: the server render is always `loading`, so hiding them removes the links from the HTML crawlers and first paint get, which the file's header says is deliberate. Options: keep the links in the HTML and hide them with CSS until auth resolves, or read the session cookie's presence (not its validity) on the server and render the app shell skeleton. Needs a signed-in browser retest either way (FIX-7 could not reproduce it as a page defect).
3. **`lib/api/v2/_real.ts` `resumes.rewrite`** [FIX-4]: sends no `Idempotency-Key`; the route honours one and otherwise makes its own. Send a uuid per user intent and treat `409 request_already_completed` as "already done". Add `source?: 'model' | 'fallback'` to the response type when PAR-5 item 2 lands; `ResumeVariant` could carry `tailorSessionId`.
4. **`components/v3/primitives/Markdown.tsx`** [FIX-6]: block spacing and bold weight are set inline, which is why `practice.module.css` needs two `!important` rules (the report page has the same). Move them to a stylesheet, then remove the `!important`s. Check every caller of `Markdown block` in both themes.
5. **`app/layout.tsx` after the `ThemeBootScript` change** (applied at the gate): load `/no-such-page` in dev on both brands and confirm a clean console and no theme flash; run `next build` once to confirm `/_not-found` and `/_global-error` prerender (FIX-1 did not).

**Auth, settings, account (FIX-2 area)**
6. `server/src/roboapply/v2/services/RAPreferencesService.ts`: validate `links.linkedin` server-side (the client now blocks Save on a bad value; the server accepts anything) [FIX-2].
7. `components/v3/account/usage.tsx:69,75`: pass a number to `settings.usage.actionCount` (see i18n) [FIX-1].
8. `components/features/onboarding/steps/ResumeStep.tsx`: do not render the LinkedIn door when `state.brand === 'goapply'` (PRODUCT G6: "same four doors as intl, minus LinkedIn") [FIX-8].
9. `server/src/features/onboarding/contract.ts`: add `cnClassYear?: number | null` to `FirstValueContext`; `firstValueRoute` returns `/campus?class=${ctx.cnClassYear}` when set (R-06: the contract may only be extended) [FIX-8]. PAR-9 item 4 depends on it.
10. Matching run and `components/features/onboarding/steps/MatchingStep.tsx`: report `reading: 'skipped'` with no resume; skip `comparing` when 个性化推荐 is off [FIX-8].
11. Settings on GoApply: hide the LinkedIn link field (`components/v3/preferences/sections/IdentitySection.tsx`) and the `#connections` "LinkedIn 好友" section [FIX-8]. Check against D5 first: connections import is a feature, not a job source; hiding it needs the owner's nod (Owner).
12. Known gaps [FIX-2]: accounts that finished onboarding before the change keep an empty profile (no backfill; DML, Owner); match results stored before the change have no `searchCount`, so a no-resume user mid-setup sees "Your search is saved" with no number until "Finding jobs" runs again; "Change password" and "Send code" measured about 1.0 contrast in the 375 px QA log (untouched, `components/v3/account/security.tsx`).

**Feed, search, taxonomy (FIX-3 area)**
13. `server/src/features/search/SearchProfileService.ts:73`: `SavedSearchLimitError` sends the English sentence as its message. Send a code plus `max` (it already carries `max` and `upgradable`) and let the client render an ICU plural (PAR-8 item 5) [FIX-1].
14. `POST /search-profiles/count` (`server/src/features/search/routes.ts:109`) silently ignores `fitTier`: reject it with 422 or document it in the contract [FIX-2].
15. `server/src/features/jobs/geo/parseLocation.ts`: the "Anywhere" location label comes from job data, not a bundle. Return a code (for example `anywhere`) and translate on the client [FIX-1].
16. `server/src/features/jobs/taxonomy/taxonomy.v1.json`: add zh-Hant and ja labels and synonyms; return them from `taxonomyLabel(id, locale)` (`taxonomy.ts:118`, English for every locale but zh today) and index them in `searchTaxonomy` (`match.ts:241`). Japanese input finds nothing until then; Traditional-Chinese input is searched in its Simplified reading (`server/src/features/onboarding/zhFold.ts`, whose table covers only the characters the taxonomy's Chinese phrases use) [FIX-2].
17. `components/v3/pipeline/PipelineCard.tsx`: `formatShort(entry.followUpAt)` shows the previous day west of UTC; format date-only values in UTC as `dayKeyOf` in `components/features/tracker/shared.ts` does [FIX-3].
18. Two `job.test.tsx` tests fail under `TZ=America/Los_Angeles` (they assert a machine-zone date in code no FIX group touched); not re-run in Wave FIX [FIX-3].

**Resume (FIX-4 area)**
19. `hooks/resume/useResumeTour.ts:40` calls `requestPopup` directly in a mount effect, so it has the effect-order race FIX-2 fixed in `usePopupGate` (the tour is lost on in-app navigation to `/resume`). Switch it to `usePopupGate`, or call `notePageView(pathname)` before the request [FIX-2].
20. `server/src/features/resume/keywords/vocabulary.ts`: add to `HARD_SKILLS_EN` 'design systems', 'usability testing', 'interaction design', 'accessibility', 'wcag', 'motion design', 'after effects', 'wireframing', 'information architecture' (the unfixed part of the free matcher finding: 3 of 4 hard skills on the QA files) [FIX-7].
21. `server/src/features/resume/keywords/keywordReport.ts` [FIX-7]: in `parseDatePoint` change `([a-z]{3,4})[a-z]*` to `([a-z]{3})[a-z]*` (full month names fall back to year-only today) and add word boundaries to `/present|current|now|…/` ("Snowflake" reads as today); `titleRow` / `resumeYears` read only `###` entries, so a signed-in keyword check on an uploaded, unedited resume has the false gaps the free tool no longer has (`withEntryHeadings` in `server/src/features/tools/entries.ts` is the fix to share); `resumeYears` counts any section whose heading contains "experience", including "Volunteer Experience".
22. `components/features/tailor/TailorResult.tsx`: label Before/After as the fit at tailoring time, as the kit now does [FIX-5]. Optionally let the resume export take the kit's job for naming: an untailored kit resume downloaded before "Open application" gets no company or job in its name.
23. `server/src/features/resume/store.ts` `findJob`: no market or recruitment-mode scope (see PAR-5 item 7) [FIX-4].
24. Known gaps [FIX-4]: the download hold for unfilled placeholders is client-side only (the server export does not check); in a watermarked PDF a lone letter between two whole words can still be glued, and Polish or Czech prose can be glued; the older inline-fragment strip can drop a real "Go" or "R" from a column layout; tailor sessions created before the pairing fix keep claims with no original, where "Remove" still deletes the line.
24a. `components/v3/resume-editor/BulletRow.tsx`, `SummaryEditor.tsx`, `SkillsEditor.tsx` (through `hooks/useResumes.ts:253`): `POST /v2/resumes/:id/rewrite` now answers 403 `phone_binding_required` for a GoApply WeChat account with no bound phone (gate). The editor shows its generic error for it. Show `PhoneBindingNotice` (`components/features/auth-cn/`, as `components/features/tailor/TailorError.tsx` does) when `isPhoneBindingRequired(err)`. The same three places should treat 503 `credits_busy` as "try again in a moment" once hot-file item 1 lands.

**GoApply onboarding (FIX-8 area)**
25. `components/features/onboarding-cn/OpportunityPanel.tsx:52`, `CnFirstValueTour.tsx:113`, `CnConfirmStep.tsx:101`: pass `timeZone: CAMPUS_TIME_ZONE` to the campus deadline formatters [FIX-1].

**Assistant (FIX-5 area)**
26. Known gaps [FIX-5]: the `applying` status, Stop, early Stop and the unsaved-turn memory live in one server process (see Owner, "Assistant proposals"); after the 4 s wait the stored-card update continues after the response, and a platform that freezes the function at response time may drop it (the proposal row stays correct); `added_jobs` rows carry no pay.

**Other**
27. `pages/404.tsx` is still English with the old palette (the Pages Router fallback; the App Router 404 is localized) [FIX-1].
28. `server/src/features/resume/ResumeCheckService.ts` `fixIssue` [FIX-9 → "G4"]: the handoff asks that failures be logged. `fixIssue` already logs `fix rewrite failed` at line 460; confirm that covers the original finding (a busy credit reserve is now logged by the credit store with its cause) and close.

---

## Owner

**Decisions**
1. **统招 (`fullTime`) default** [FIX-8]: PRODUCT_PLAN G3 says "Default On". FIX-8 shipped an optional 是/否 with no preselection (nothing is pre-checked). Keep, or restore the default?
2. **GoApply accounts already past G1** agreed to the old cross-border text (hand-typed processor list, "美国东部") [FIX-8]. Those whose record carries a hash (email sign-up, or an answer given on G1 or in Settings) see "the text changed" and "Agree to this text" in Settings only; nothing prompts them. Product and legal decide whether to prompt on next sign-in.
2a. **Consent records with no hash** (gate): GoApply phone and WeChat sign-ups before this gate, and every RoboApply sign-up, stored no hash, so nothing can show which text was agreed to. The gate made the ledger answer "unknown" for them (`answeredTextCurrent: null`) instead of "the text changed", which was untrue for a text agreed to a minute earlier. Effect: G1 does not ask these users again and Settings shows no "text changed" note. If you want the pre-gate GoApply phone and WeChat accounts asked again for the cross-border text, say so: it needs an explicit rule (for example `pipl_cross_border` rows with no hash created before the gate date), not the missing hash.
2b. **What a phone or WeChat consent row records** (gate): it now names the consent text that was on screen (catalog version `CONSENT_PROSE_VERSION` and the text's hash), the same as an email sign-up row. It no longer carries `CN_LEGAL_DOCS_VERSION`. Which version of the 用户协议 and 隐私政策 was in force is then known only from the row's date. If counsel wants the documents version on the row as well, that is a new nullable column on `SeekerConsentRecord` (additive); say if it should be scheduled.
2c. **WeChat mini-program sign-up** (gate): `POST /auth/wechat/mini/login` now refuses a new account whose consents carry no `proseHash` (422 `consent_required`, `details.outdated`), like the web forms. No mini-program client exists in this repository; whoever builds it must read `GET /auth/phone/policy` and send each `prose.hash` back.
3. **Account deletion reason** [FIX-2]: the "Reason" box is removed (it was required without saying so, and what was typed was never sent). Bring it back as an optional, stored field, or leave it out?
4. **GoApply text practice** [FIX-6]: the Focus chip still reads "Live Coding … in a shared editor" (from `raMockCatalog.ts` and `practice.setup.types.technical.*`) although the practice is typed. Reword for the written format, or hide that type there?
5. **Ready to apply** [FIX-5]: "Company I don't want" ratings now exclude that company from the weekly list. Not in the finding; say if you want it reverted.
6. **LinkedIn on GoApply** [FIX-8]: the handoff asks to hide the LinkedIn resume door, the LinkedIn link field and the "LinkedIn 好友" connections section on GoApply. PRODUCT G6 already drops the door; the other two are parity questions under D5.
7. **Assistant proposals across instances** [FIX-5]: the "already being worked on" state lives in one server process. On another serverless instance a second click during a running apply is told `applied`. A real fix is an `applying` value for `RACopilotProposal.status` (a `String`, so additive: a doc-comment change and code, no DDL). No FIX handoff filed it as a schema request, so it is not in the schema; say if it should be scheduled.
8. **Vercel pool size** [FIX-9]: with `PRISMA_POOL_MAX` 1 (the Vercel default) an interactive transaction blocks every other query in that instance. Consider 3–5.
9. **Hong Kong storage** (gate): `oss-cn-hongkong.aliyuncs.com` no longer counts as mainland storage. If a GoApply deployment was meant to use it under the mainland-only rule, that is now refused.

**Credentials and configuration**
10. **OPS-A2**: set `RA_SYSTEM_USER_ID` and `CN_RA_SYSTEM_USER_ID` to real user ids [FIX-3]. Enrichment logs the missing system user once and skips for an hour.
11. `SENSITIVE_DATA_KEY` (OPS-A2) is still unset: Settings › Sensitive answers says "can't be saved right now" (dropped finding, by design).

**DML that needs owner approval (none was run)**
12. Re-classify stored jobs with `primaryTaxonomyId = 'architect'` [FIX-3].
13. Re-normalise pay on stored rows (`payPlausible` / `statesAmount` apply on write and on read; stored values are unchanged) [FIX-3].
14. Re-run keyword extraction for stored jobs: the new stopword tiers apply only to new enrichment [FIX-3, FIX-4].
15. No backfill for accounts that finished onboarding before `prefillFromResume` (their profile stays at 0%) [FIX-2].

**Counsel and native review**
16. The eight `tips_reminders` translations and the rewritten cross-border and AI-processing consent texts, including the new "country not listed" sentence (`CONSENT_PROSE_VERSION = '2026-10-11.fix8.v2'`), are the agent's wording, not counsel's [FIX-8].
17. Scorer strings in seven locales (`roleFit.skipped`, `strengthFallback`) have had no native read [FIX-6].

**Browser retests (nothing in Wave FIX was run in a browser)**
18. FIX-1: topbar at 375 px and 761–1000 px on both brands (Safari and Firefox for the one-line ellipsis); `/no-such-page` console and theme flash after the layout change; `next build` prerender of `/_not-found` and `/_global-error`.
19. FIX-2: the first-visit tour and the finish banner on in-app navigation; the GoApply delete dialog in Chinese.
20. FIX-3: filter drawer comboboxes, `/jobs` and tracker at 375 px and in dark mode; tailoring "Fit score not available" on the real provider.
21. FIX-4: resume editor at 375 px (`.rb-editor-bleed`), toolbar wrap at 1280.
22. FIX-5: the rail composer margin and `min-height` rule (Safari/Firefox sticky), Stop mid-reply against the real server, "New chat about this job".
23. FIX-6: code blocks in the text room at 375 px; the three snap rows' `scroll-padding-inline`.
24. FIX-7: the language menu reload, the footer theme switch at 375 px in both themes and brands, the matcher through the real `PDFService` path, signed-in `/help/ranking`.
25. FIX-8: G1 with an earlier-text grant, the manual profile form, `/legal` table below 640 px, RoboApply 繁體中文 / 日本語 "Tips and reminders" sentence (route fix applied at the gate).
26. FIX-9: the new credit SQL has not run on Neon; exercise a reserve, a commit and `/credits/history` with a practice debit against the clone branch.

---

## Applied at the gate (for context)

Schema: none (no request; `prisma validate` and `db:generate` clean; no `.prisma` file changed).

Requests applied:
- **[FIX-1]** `app/layout.tsx`: the inline theme `<script>` is replaced by `<ThemeBootScript />`. `__tests__/components/AvatarMenu.test.tsx` asserts `initialsFor` (no 'RA' fallback); the deprecated `monogramFor` export and the test that counted its occurrences are deleted.
- **[FIX-2]** `__tests__/pages/settings.test.tsx` patch (invite error state with "Try again", no Reason box, name editable).
- **[FIX-3]** `__tests__/lib/i18nStaging.test.ts` parses each bundle once (a `Map`): about 0.5 s instead of about 4.5 s.
- **[FIX-4]** `legacyJobScope.test.ts:80` expects no `provider` column. `RAResumeAIService.rewriteWithSource()` added; `routes/resumes.ts` uses `agentSucceeded` and no longer imports `__test`; `resumes.rewriteCredit.test.ts` mock updated. One behaviour change: a model answer identical to the fixed fallback is now charged as model text (it used to be treated as canned).
- **[FIX-5]** `lib/api/copilot.ts` `stopTurn` (also in `copilotApi` and the endpoint list); `hooks/copilot/stopTurn.ts` imports it directly; the `it.fails` tripwire is replaced by a test of the real wrapper's request.
- **[FIX-6]** `__tests__/pages/practice.test.tsx` patch (affordable default length).
- **[FIX-7]** `app/features/[slug]/page.tsx` uses `isFeatureIndexable(def)`.
- **[FIX-8]** `orch-notifications-locale.patch` (routes + test), `orch-auth-cn-routes.test.ts.patch`, `FIX-2-goapply.test.tsx.patch`; `MAINLAND_STORAGE_HOST_PATTERNS` excludes `oss-cn-hongkong` (+ test); the `'en' | 'zh'` annotations widened to `ConsentProseLocale` (notifications contract and service, auth-cn contract, `auth/goapplySignup.ts`) and the cast in `consents.ts` dropped; `auth-cn/signupPolicy.ts` passes `env` to `resolveConsentProse`; `PRODUCT_PLAN.md` G1 updated.
- **[FIX-9]** `platform/http.ts`: `credits_busy: 503`, its default message, `Retry-After` for it in `fail()` and both `mapError` branches; route-level test in `http.test.ts`; the contract test in `CreditService.test.ts` now always runs. `.env.example` documents the three Prisma variables. `ARCHITECTURE.md` §7.3 updated.

Applied at the cross-WP integration pass (after the gate above):
- **Consent hash on phone and WeChat sign-up** [FIX-8 vs auth-cn]: `ConsentInputSchema` takes an optional `proseHash` (64 hex); `checkSignupConsents(consents, brand, env)` is async, looks each required consent up by the hash the form sent (`servedConsentProseByHash`) and returns the catalog version and hash, or throws `consent_required { outdated }` when the hash is absent or matches no served text; `createGoApplyAccount` writes `proseHash`; the WeChat pending state keeps it; `PhoneMethod` and `WechatMethod` send `shownConsentsFromPolicy(policy)` and reload the policy on `outdated` (`consentsFromPolicy` is deleted). `answeredCurrentText` answers `null` for a record with no hash. Tests: `auth-cn/{phoneAuthService,wechatAuthService,routes}.test.ts`, `compliance/consents.test.ts`, `components/features/{auth-cn,onboarding-cn,compliance}` tests.
- **`POST /v2/resumes/:id/rewrite`** [FIX-9 vs FIX-4; WP-11]: mounted behind `legacyAiGates()` (403 `phone_binding_required`, 503 `ai_unavailable` before any reservation); a `CreditStoreBusyError` is answered through `mapError` (503 `credits_busy`, `Retry-After: 5`). Tests: `resumes.rewriteCredit.test.ts` (busy, unbound WeChat account, AI consent off), `legacyAiGates.test.ts` (the route is in the gated list).

Not applied, and why: the i18n merge (382 new and 8 changed keys need translating in the same pass); `HybridShell` loading state (changes what crawlers and first paint receive; unproven as a defect); `lib/api/client.ts` `credits_busy` (needs a new string in nine locales); `lib/api/v2/_real.ts` idempotency key (frozen client; needs a replay-handling decision); `Markdown.tsx` spacing (global visual change with no browser check); the weekly-insight `tz` chain and every FIX-to-FIX request (they belong to files a parity bundle or a fix WP owns).
