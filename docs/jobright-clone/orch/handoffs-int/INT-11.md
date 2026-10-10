INT-11 · **status: review fixes applied, but gate 4 is still red (11 failed / 10,065 passed).** All 11 failures are tests in other bundles' files that assert the old behaviour; a verified patch for them is ready (see Requests). Gates 1–3 are green. Nothing was committed, and no dev server, build, browser or database was touched.

On "launch the new version": I did not launch anything. This worktree is one unmerged bundle of thirteen, so it is not the new version; the launch belongs after the merge, from the clone worktree.

## Per-item result

1. **CORS — done.** Production allows the brand hosts, `FRONTEND_URLS` and the deployment's own Vercel hosts exactly. There is no built-in preview pattern any more; `CORS_PREVIEW_HOSTS` is an explicit opt-in, and wide globs such as `*.vercel.app` are refused.
2. **Flags — done, with one deviation.**
   - `webPush` needs a non-mainland brand plus both VAPID keys and a `mailto:`/`https:` `VAPID_SUBJECT`. GoApply can never get it.
   - `pay.wechatpay` also needs the public key, its id, a 32-byte APIv3 key and the entity match.
   - `ai.interviewVoice` follows the media plane, so `FLAG_GOAPPLY_INTERVIEW_VOICE=true` plus `CN_LIVEKIT_*` turns GoApply voice on.
   - `CN_LLM_PROVIDER=newapi` is accepted when its host passes `checkLlmEgress`.
   - `competitiveness` stays in `AI_DEPENDENT_FLAGS`.
   - **Deviation:** `flags.ts` does not statically import `voiceAvailable` or `wechatPayReadiness`, because that drags the database pool and LiveKit SDK into web test helpers. `startup.ts` registers both at boot; before that an equivalent built-in rule runs, and `flags.test.ts` checks it against the real functions.
3. **Startup — done.** In production, a served brand with the copilot capability on and a model that cannot stream tools refuses to boot. Capability off skips the check; outside production it only warns.
4. **Consents — done.**
   - Added GoApply `tips_reminders` (zh + en), `interview_video` for both brands, and `coaching_share_with_coach` (GoApply, marked draft).
   - GoApply `interview_video` and the coaching consent are defined but not offered (`appliesWhen: 'never'`). They appear in the panel only once a record exists.
   - `CONSENT_PROSE_VERSION` is unchanged and a test pins all 30 earlier hashes.
5. **Retention — done except one part.**
   - New rows: `known_devices` (90 days, purged in compliance-daily), `tool_results` (24 h), `anon_alerts_unconfirmed` (72 h), `anon_alerts_unsubscribed` (30 days), `billing_consent_records` (36 months, minimum).
   - `admin_review` rows are left out of the 13-month rule.
   - **Not done:** `auto_renew_ack` records still cascade-delete with the account 30 days (GoApply 15) after deletion. Keeping them 3 years past deletion needs a table with no user FK, which I cannot add. No other code deletes consent records.
6. **Data export — done.** New sections `outreachDrafts`, `referralCodes`, `referrals` (status and dates only), `twoStepSignIn` (`enabled`, `enrolledAt`), `studentVerification`; `jobInteractions` drops `admin_review`.
7. **Legal drafts and disclosures — done; every document stays `status: draft`.**
   - The seven drafts cover the cookies, the 13-month limit, `ra_tool_visitor`, the LinkedIn import, the takedown contact, and the GoApply collecting entity with no renewal and no deposits.
   - `/public/legal/disclosures` returns processing facts, AI endpoint lists and data attributions; new `/legal` index page.
   - "Privacy choices" appears once the visitor has answered the analytics question.
   - The cancel link is in RoboApply's legal footer and not GoApply's.
8. **`publishedLegalDocVersion(brand, doc, env)` — done.**
9. **Purge and shim — done.** Each interview session's artifacts are deleted inside its own brand; missing GoApply storage holds the account. `twFieldsStore.ts` uses the typed column.

## Review resolution

- **GoApply camera consent (high) — fixed.** GoApply is no longer asked for a video consent it never uses; the practice sheet goes back to "video not offered". New test covers both regions and locales.
- **Other bundles' tests red (high) — confirmed, not fixable here.** I drafted the test updates, applied them temporarily, saw all five files pass (109 tests), then reverted those five paths. For a short time before that, those five files sat modified because a first revert command failed; they are clean now.
- **CORS default pattern (medium) — fixed.** No default pattern; a test asserts `https://roboapply-x-kens-projects.vercel.app` is refused by default. I did not check the team slug myself; the fix does not depend on it.
- **`/legal` not in file tracing (medium) — confirmed, moved to Requests.** Next's bundled picomatch shows `'/legal/*'` does not match `/legal`.
- **"Read on our own servers" (medium) — fixed.** The line now reads: "Your resume is not sent to a separate resume-parsing service. When AI reads it, including scanned pages and images, it goes to an AI model provider." Same in zh and in the notice markdown. The parsing service's name now comes from the server response (`resumeParser`), and the no-vendor-name test also looks for "GoHire".
- **`auto_renew_ack` after deletion (medium) — not fixed.** Needs a schema change and an owner/counsel decision; see Requests.
- **GoApply privacy draft (low) — fixed.** The `ra_analytics_consent` and "if you refuse" bullets are gone; it now says event collection is in the 个人信息收集清单 and `ra_anon` is set on first visit.
- **Storage host in the public response (low) — fixed.** `storageHost` is removed from the contract, the response, both bundles and the markdown.
- **`VAPID_SUBJECT` (low) — fixed.** Same rule as `vapidConfig`.
- **Cancel link on GoApply (low) — fixed.** Auto mode never adds it on the mainland market; a host can still force it.
- **Draft coaching consent as a live toggle (low) — fixed.** Not offered in the panel until a record exists.
- **Unowned edit — kept.** `server/src/roboapply/services/SeekerAccountPurgeService.brand.test.ts` is a test colocated with a file I own.

## Files

- **Created:** `app/legal/page.tsx`, `components/features/compliance/LegalIndex.tsx`, `server/src/roboapply/services/SeekerAccountPurgeService.brand.test.ts`.
- **Modified this round:**
  - `server/src/platform/brand/runtime.ts`, `server/src/platform/flags.ts`, and their tests
  - `server/src/features/compliance/{consents,contract,disclosures,legalDocs}.ts` and the `consents`, `compliance`, `workers` tests
  - `components/features/compliance/{DisclosureTables,LegalFooterView}.tsx` and `compliance.test.tsx`
  - `content/legal/cn/privacy.md`
  - `i18n/staging/legal.{en,zh}.json`
- **Modified earlier, unchanged this round:**
  - `startup.ts` and its test
  - `dataExport.ts`, `retention.ts`, compliance `index.ts`, and the retention test
  - `twFieldsStore.ts`, `seekerConsentTypes.ts`, `SeekerAccountPurgeService.ts`
  - the other compliance components, `app/legal/legalSource.ts` and its test
  - the other six legal drafts
- **Deleted:** none.

## Tests run

- Bundle paths: `npx vitest run server/src/platform/{flags,startup,http}.test.ts server/src/platform/brand/runtime.test.ts server/src/features/compliance server/src/features/profile server/src/roboapply/services components/features/compliance app/legal` → 17 files, 433 passed.
- `npm run typecheck:server` and `npm run typecheck:web` → clean.
- `npm run check` → all six checks pass.
- `npx vitest run --exclude ".claude/**"` → 544 files passed, 5 failed; 10,065 tests passed, 11 failed. An earlier run also failed `legacyPrecedence.test.ts` once on a cookie `Expires` one-second boundary; it passed on the rerun and is not from this bundle.

## Requests

The patch for the first three bullets is at `/private/tmp/claude-501/-Users-kenny-code-RoboApply/ca326177-3056-45db-a2e4-d92af4c9efdb/scratchpad/int11-other-bundles-tests.patch` (`git apply` from the repo root).

- **INT-07**
  - `features/push/push.test.ts` (6 tests): GoApply `isEnabledForBrand('webPush', …)` is now false; no-keys routes answer 404 `feature_disabled`, not 501; pass `VAPID` as the fourth argument to `handlePushSend`.
  - `notifications/__tests__/notifications.test.ts` (1 test): GoApply `tipsRemindersConsent` is the zh entry for locale `zh`, and the hash uses `locale: 'zh'`.
- **INT-02**
  - `platform/billing/rails/registry.test.ts` (1 test): `ENV` needs a 32-byte `WECHATPAY_API_V3_KEY`, `WECHATPAY_PUBLIC_KEY`, `WECHATPAY_PUBLIC_KEY_ID` and `WECHATPAY_MERCHANT_ENTITY: 'Example Collecting Co.'`.
  - `billing-cn/__tests__/billingCn.routes.test.ts` (2 tests): entity mismatch and missing public key now answer 404 `feature_disabled`.
- **INT-13**
  - `features/mount.test.ts` (1 test): same WeChat Pay env plus `CN_PAYMENT_COLLECTING_ENTITY`.
  - `next.config.mjs`: add `'/legal': ['./content/legal/**/*']` to `outputFileTracingIncludes`, and check the built trace for `/legal` before deploy. Without it the index page can 404 in production.
  - `.env.example`: document `CORS_PREVIEW_HOSTS` as opt-in with no default, with a warning that any pattern under `vercel.app` can be claimed by another Vercel account. Add `TAKEDOWN_CONTACT` / `CN_TAKEDOWN_CONTACT`, and note `VAPID_SUBJECT` now gates `webPush`.
  - `app.ts` lines 82–85: the comment still says `*.vercel.app` previews.
- **Owner / counsel, then INT-SCHEMA:** decide whether billing consent evidence must outlive account deletion. If yes, add an archive table with no user FK, have the purge copy `auto_renew_ack`, `withdrawal_waiver` and `cn_pay_terms_ack` into it, and add a 36-month rule. If deletion wins, add it to the deferred list and drop the 3-year item.
- **J5 (orchestrator):** default billing-cn's `termsVersion` to `publishedLegalDocVersion(brand, 'terms', env)` and skip the acceptance when it is null.
- **Coaching owner (no bundle lists `server/src/features/coaching`):** when `shareConsent === true`, call `recordConsent` with type `coaching_share_with_coach`. Nothing writes it today.
- **INT-09:** if CN L-11 ever lets GoApply record video, change GoApply `interview_video` to `appliesWhen: 'always'` in the same change. `r2Storage` caches its client by bucket name only (R8, already known).
- **INT-06:** optionally pass `cancelLink={false}` from `SiteChrome` so marketing HTML never carries the link twice before hydration.
- **INT-01:** `features/auth/devices.ts` header says 180 days; the code and the published row say 90.
- **Profile owner (none listed):** drop the `createTwFieldsStore(false)` 501 test so the seam and `twFieldsColumnPresent()` can go.

## i18n keys

All in `legal`, en and zh; no email keys; none obsoleted.

- **Changed this round:** `processing.files` (no `{host}` argument), `processing.parsing` (new wording, takes `{service}`).
- **Added earlier:**
  - `footer.privacyChoices`
  - `processors.content_safety`
  - `retention.enforced.minimum`
  - `retention.rows.{known_devices, tool_results, anon_alerts_unconfirmed, anon_alerts_unsubscribed, billing_consent_records}`
  - `processing.{region, files, parsing, redacted, images, pii.*}`
  - `llmEndpoints.{rule, hosts, excluded, colProvider, colHost}`
  - `attributions.{none, colDataset, colPublisher, colUsedFor, colLicence, colAsOf, purpose.*}`
  - `index.{title, sub, docsTitle, processingTitle, aiTitle, endpointsTitle, attributionsTitle, attributionsSub}`

## Env vars introduced

- `CORS_PREVIEW_HOSTS` — comma list of host globs; unset means no preview origins.
- `TAKEDOWN_CONTACT` / `CN_TAKEDOWN_CONTACT` — falls back to the support address.
- Newly read: `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL`; `VAPID_SUBJECT` in the `webPush` check; `NEWAPI_API_KEY` / `NEWAPI_BASE_URL`; `WECHATPAY_MERCHANT_ENTITY`, `CN_PAYMENT_COLLECTING_ENTITY`, `WECHATPAY_PUBLIC_KEY(_ID)` in the `pay.wechatpay` check.

## Known gaps

- **Deploy risk:** production refuses to boot if RoboApply's copilot model cannot stream tools or none is configured. Check the route, or set `LLM_COPILOT_MODEL` or `FLAG_ROBOAPPLY_COPILOT=false`, before the next production deploy.
- **Deploy risk:** `/legal` can 404 in production until INT-13 adds the tracing entry.
- **CORS:** a preview deployment's API accepts only its own host. A separate preview frontend calling it needs `CORS_PREVIEW_HOSTS` or `FRONTEND_URLS`.
- A WeChat Pay notify now gets 404 instead of 503 when the public key or entity match is missing. I am assuming WeChat retries any non-2xx; not checked against their docs.
- "Privacy choices" does not appear for a first-time EEA visitor until they answer the banner.
- The account data wipe still deletes an admin's own `admin_review` rows.
- The zh strings are staged, not merged, so GoApply shows the English staged copy until WP-91/92.
- No browser pass was done on `/legal` or the footer at 375/1280 in light and dark; coverage is component tests only.