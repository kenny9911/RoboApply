FIX-8 · handoff (after review)

Five of the six findings are fixed inside my owns; finding 4 is still open on RoboApply until one unowned route change is applied. The full suite is **not** green: reverting the two unowned test edits, as instructed, leaves 4 tests failing that assert the old behaviour. Nothing was checked in a browser (not permitted).

All three patches below apply cleanly to this worktree and their four test files pass with them applied (108 tests); the worktree was restored afterwards. They are in `/private/tmp/claude-501/-Users-kenny-code-RoboApply/ca326177-3056-45db-a2e4-d92af4c9efdb/scratchpad/fix8/`.

## Review resolution

1. **[HIGH] Tips sentence still English for RoboApply zh-TW / ja — confirmed, not fixable in my owns.**
   - `notifications/routes.ts` `localeOf` reads `x-ra-locale` / `NEXT_LOCALE`, which nothing sends, so the locale is always null.
   - I wrote the route fix and a route-level test, confirmed the test fails without the fix (returns the English sentence for `X-Robo-Locale: ja`) and passes with it, then reverted both. Patch: `orch-notifications-locale.patch`.
   - Once applied, the side effect also goes away (a GoApply user reading English gets English again).

2. **[MEDIUM] Mainland or unknown-location services named as offshore — fixed.**
   - "Outside mainland China" is now said only of a processor with a known non-CN country.
   - A processor with no known country is disclosed in its own sentence (`以下处理方的所在国家/地区未披露：…`), not called offshore.
   - No AI model row is listed when the routing rule is mainland-only.
   - GoApply's bucket row gets country `CN` when its endpoint establishes it (new `storageCountry` in `disclosures.ts`), so `/legal` and the consent agree.
   - Test uses the reviewer's exact environment; the consent now names only Neon.

3. **[LOW] Old-text consent shown as agreed next to new text — fixed.**
   - `listConsents` now returns `answeredProseVersion` and `answeredTextCurrent`. The second is computed by re-hashing today's text under the record's own version, so a version bump with unchanged words still counts as current.
   - G1: a grant of an earlier text is a box again, unticked, with "You agreed to an earlier version of this text on {date}…". `applyCnStep` then records it under the current text.
   - Settings consents: the row says the text changed and offers "Agree to this text".
   - Both new fields are optional in the contract so unowned test fixtures still type-check.

4. **[LOW] Manual form drops hand-typed months — fixed.**
   - New `normalizeMonth` reads `2024/03`, `2024.3`, `2024年3月`, `202403`. Anything else is a new `dateFormat` problem that stops the save.
   - Both fields have a `YYYY-MM` placeholder.
   - Tests written first and seen failing.

5. **[LOW] Override parity test conflicts with merge script — fixed.** The test now requires en ⊆ zh, with the reason in the file header.

6. **Unowned edits — reverted.** Both are now Requests with patches. The 4 failing tests are exactly these.

## Per-finding result

1. **Consent vs /legal disagree — fixed.** Root cause: processors and "美国东部" were typed into `consents.ts`, and `ConsentStep` added its own AI line. The prose is now filled from `configuredProcessors()` and `llmEndpointFacts()`, the functions `/legal` renders. Tightened this round per review item 2.
2. **Required consents asked twice — fixed.** Root cause: G1 ignored sign-up grants. G1 reads the ledger and shows a grant of the current text as given; a grant of an earlier text is asked again (review item 3).
3. **GoApply brand overrides missing — fixed; section gates requested.** `loadMessages` merges `i18n/brands/<brand>/<locale>.json`; 29 keys each in zh and en. `/cancel` on GoApply renders `NoRenewalNotice`.
4. **"Tips and reminders" in English — not fixed on RoboApply.** The catalog has all nine locales and no-locale means brand default, so GoApply 中文 is right. RoboApply 繁體中文 / 日本語 need the route patch.
5. **AI off: no manual form — gate fixed; shared screens requested.** `CnResumeGate` opens `ManualProfileForm`; dates hardened this round.
6. **Polish — fixed except two requests.**
   - Done: 台湾 added to the province data; step counter on every screen; confirm summary with 修改 links; `/legal` table stacks below 640px.
   - Decision for you: 统招 is now an optional 是/否 with no preselection, which deviates from PRODUCT_PLAN G3 "Default On". Say if you want the default back.
   - Not done: the analytics banner covering the sign-in link, and the campus 届别 default — both under Requests.

## Files changed

All under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-FIX-8/`.

- **Server compliance:** `consents.ts`, `contract.ts`, `disclosures.ts`, `routes.ts`, `index.ts`, new `deployment.ts`, new `processingStatement.ts`, `consents.test.ts`, `routes.test.ts`.
- **Server onboarding-cn:** `apply.ts`, `validate.ts`, `index.ts`, `data/provinces.json`, `onboardingCn.test.ts`, `routes.test.ts`.
- **Client onboarding-cn:** `ConsentStep.tsx`, `EducationStep.tsx`, `CnConfirmStep.tsx`, `CnResumeGate.tsx`, `IdentityStep.tsx`, `IntentStep.tsx`, `TagsStep.tsx`, `parts.tsx`, `types.ts`, `api.tsx`, `index.ts`, `OnboardingCn.module.css`, new `ManualProfileForm.tsx`, new `ConfirmSummary.tsx`, its test.
- **Compliance UI:** `ConsentsPanel.tsx`, `DisclosureTables.tsx`, `compliance.module.css`, `compliance.test.tsx`.
- **Billing-cn:** new `NoRenewalNotice.tsx`, new `renewal.ts`, `index.ts`, `billingCn.module.css`, new test.
- **Other owned:** `app/cancel/page.tsx`, `lib/i18n.ts`, new `lib/i18n.brandOverrides.test.ts`, new `i18n/brands/goapply/{zh,en}.json`, staging `onboardingCn`, `billingCn`, `legal` (en + zh).
- **Outside owns:** none.

## Tests run

- `npx vitest run --exclude ".claude/**"`: 586 files, 584 passed, 2 failed; 11,863 tests passed, 4 failed, 1 skipped, 10 todo.
  - `components/features/onboarding/goapply.test.tsx`: 3 G6 tests expect "fill in by hand" to skip at once.
  - `server/src/features/auth-cn/routes.test.ts`: 1 assertion expects the hard-coded `美国`.
- Owned suites: 15 files, 768 passed.
- `npm run typecheck:server`, `npx next typegen && npm run typecheck:web`: clean.
- `npm run check`: all six clean.
- `node scripts/i18n-merge-staging.mjs --dry-run`: 64 new, 0 changed, 0 routed to the brand override.
- Extension untouched.

## Requests

**Orchestrator / unowned**
- Apply `orch-notifications-locale.patch`: in `notifications/routes.ts` `localeOf` and `announcements/routes.ts` `requestLocale`, read `x-robo-locale`, then the `robo_locale` cookie, then the old names; adds the route test. This closes finding 4.
- Apply `orch-auth-cn-routes.test.ts.patch`: replace `expect(zh[2]!.prose.text).toContain('美国')` with `toContain('中国大陆境外处理和存储')` and `not.toMatch(/美国东部|%OFFSHORE_PROCESSORS%/)`.
- `server/src/platform/residency/egressPolicy.ts`: `MAINLAND_STORAGE_HOST_PATTERNS` accepts `oss-cn-hongkong.aliyuncs.com` as mainland (I ran the regex). GoApply files could be stored in Hong Kong under the mainland-only rule. Exclude it. My disclosure code already refuses to call it CN.
- `notifications/` and `auth-cn/`: widen the `locale: 'en' | 'zh'` annotations (`tipsConsentProse`, `NotificationPreferencesView.tipsRemindersConsent`, `SignupPolicyConsent.prose`) to `ConsentProseLocale`, then drop the cast in `consents.ts`.
- `auth-cn/signupPolicy.ts`: pass `env` to `resolveConsentProse(def, brand, lang, env)`.
- `components/features/campus`: default the class filter to the user's 届别.
- Update PRODUCT_PLAN G1 (processor list is config-driven) and G3 (统招 default).
- Run `npm run i18n:merge` and translate.
- Decision for product/legal: GoApply accounts already past G1 agreed to the old cross-border text. They see the note and button in Settings only; nothing prompts them.

**FIX-1**
- Remove `onboardingCn.consent.aiOffshore` from all nine bundles (no longer rendered; it carried the false claim).

**FIX-2**
- Apply `FIX-2-goapply.test.tsx.patch`: the three G6 tests click "Fill in my profile by hand", expect the manual form, then "Fill in later".
- `onboarding/steps/ResumeStep.tsx`: do not render the LinkedIn door when `state.brand === 'goapply'`.
- `server/src/features/onboarding/contract.ts`: add `cnClassYear?: number | null` to `FirstValueContext`; `firstValueRoute` returns `/campus?class=${ctx.cnClassYear}` when set.
- Matching run and `MatchingStep`: report `reading: 'skipped'` with no resume; skip `comparing` when 个性化推荐 is off.
- `growth/AnalyticsConsent.tsx`: the banner covers "Already have an account? Sign in" on `/signup` at 1280×900.
- Settings and invite: hide the LinkedIn link field and the `#connections` "LinkedIn 好友" section on GoApply; hide the invite 邮件 button when `notify.email` is off.

**FIX-3**
- `NotificationsSettings`: hide 邮件汇总 and the email channel when `emailUnavailableReason === 'not_offered'`.
- `/jobs` header (`jobs.workspace.intro`): state-aware variants for no resume and personalisation off.

**FIX-7**
- Hide `CancelFooterLink` in the marketing footer on GoApply.
- Gate the pricing "instant alert emails" row and the `/security` "we email you" line on `notify.email`.

## i18n keys added or changed

- **New this round (staging en + zh):**
  - `onboardingCn.consent.{changedSinceOn, changedSince}`
  - `onboardingCn.manual.problem.dateFormat`, `onboardingCn.manual.monthPlaceholder`
  - `legal.consents.{textChanged, agreeCurrent}`
- **From the first round (staging en + zh):**
  - `onboardingCn.common.optional`
  - `onboardingCn.consent.{given, givenOn, requiredGiven}`
  - `onboardingCn.education.{fullTimeYes, fullTimeNo}`
  - `onboardingCn.confirm.{summaryTitle, edit, editRow, notSet, skipped, notChosen, fullTime, resumeAdded, resumeNone}`
  - `onboardingCn.confirm.rows.{identity, education, roles, cities, workType, pay, employer, resume, ai, ranking}`
  - `onboardingCn.manual.*` (the rest)
  - `billingCn.noRenewal.{title, body, ends, pricingLink, settingsLink}`
- No existing key's English changed. No longer used: `onboardingCn.consent.aiOffshore`.
- Brand overrides (not staging): 29 keys in `i18n/brands/goapply/{zh,en}.json`.
- Server consent prose (version `2026-10-11.fix8.v2`): `tips_reminders` in nine locales; cross-border and AI-processing texts rewritten, including the new "country not listed" sentence.

## Known gaps

- Finding 4 stays open on RoboApply until the route patch lands. Until then a GoApply user reading English sees the Chinese tips sentence.
- On GoApply the consent omits AI model rows because routing refuses non-mainland endpoints. If a non-mainland model is misconfigured, `/legal` still lists it while the consent does not.
- The eight `tips_reminders` translations and the new consent sentences are mine, not counsel-reviewed.
- A record without a stored hash counts as "earlier text" and is asked again on G1.
- The manual form takes one experience; more are added in 我的资料.
- Email wording overrides are channel-neutral, not capability-aware; the section gates above are the complete fix.