# PAR-5

Storage, residency, boot checks, disclosures, consents and legal pages. Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-PAR-5`, branch `wp/PAR-5`, base `3fa104e` (the PAR-1 merge). Nothing committed, pushed or stashed. No schema change, no new dependency, no dev server, no browser, no call to a real provider.

This is the handoff after the independent review. All six review findings are resolved in code or, where the file is not PAR-5's, as an exact request. Eight of the nine items are done. Item 7 is done in every file PAR-5 owns; its last step (the G1 onboarding step stores the cross-border grant on a mainland deployment that uses the shared stack) needs a change in `server/src/features/onboarding-cn/validate.ts`, which no bundle owns. The exact change is under Requests → Orchestrator.

Every test in a file PAR-5 owns is green (28 files, 724 passed, 2 skipped on purpose: both wait for PAR-2 and run by themselves after the merge). Both typechecks pass for the whole repository; `npm run check` passes. The full suite has 92 failures: 89 that were red at the base in other bundles' files, and 3 that PAR-5 turns red, all in PAR-3 files.

**Read first (orchestrator).**
1. **One merge-time edit is needed to finish item 7:** `onboarding-cn/validate.ts` still decides the G1 cross-border box by region alone. See Requests → Orchestrator, first entry. Until it is applied, a user on a mainland deployment without a CN stack ticks the box in G1 and no record is written; the consent can still be given in Settings › Consents.
2. **New rule for callers outside this area:** a synchronous call that builds a consent text, its hash or the cross-border requirement for the live process must be preceded by `await loadAiStackSnapshot()` (exported from `features/compliance`). PAR-5's own entry points do it. PAR-3's sign-up paths and the G1 step need one line each (Requests).
3. Three PAR-3 tests go red because of this bundle. Each needs a one-line change. See "Red tests for other bundles".
4. Two tests are skipped until PAR-2 is merged: the O-1 boot acceptance in `startup.test.ts`, and the new contract check `disclosuresResolverContract.test.ts`. Both run by themselves once the PAR-2 exports exist. The contract check was run once against PAR-2's current worktree code (read only, through a temporary probe file that was deleted): it passes for all seven environments.
5. Two places follow the plan text or a later request instead of the item text. See "Precedence".
6. Behaviours an owner may want to overrule are under "Requests → Owner". One is new in this round and visible on RoboApply (a gateway model id that carries a mainland vendor's name).

## Review resolution

| # | Finding | Verdict | What was done |
|---|---|---|---|
| U1 | Item 7 not done end to end: the G1 step validates with `isOffshore` | **Real. Not fixable inside PAR-5's owns.** | Confirmed in `server/src/features/onboarding-cn/validate.ts:100-118` (in no bundle's owns). The previous handoff raised no request; it does now, with the exact edit, the test to change and the one await the caller needs (Requests → Orchestrator). The AI-vendor half of this entry is finding 1, fixed. |
| 1 | Mixed stack: a shared bare model id is disclosed as served by GoApply's own provider | **Real. Fixed.** | `disclosures.ts` no longer parses every row with the brand's provider. Each setting is resolved per key in the plan §3.3 order and keeps the stack it comes from; a bare id takes the provider of that stack. The reviewer's environment now gives `vision → openai, US, shared`, `aiLeavesMainland` true, and the vendor is named in the consent sentence, the offshore processor list and the footer. Extended to the same class of error: a row is placed with a mainland vendor only when the request really goes there (`qwen/…` on the shared stack and `moonshotai/…` are gateway namespaces, not routes to the mainland). Behind the wall, a shared value that names no mainland vendor is not listed, which is what PAR-2's resolver does with it. Tests: three new cases in `compliance.test.ts`, the override cases in `aiStackSnapshot.test.ts`, and the gated contract check against PAR-2's resolver. |
| 2 | Consent text, hash and requirement depend on a lazily warmed database cache | **Real. Fixed in PAR-5's files; two callers elsewhere need one line.** | New `loadAiStackSnapshot(env)` in `features/compliance` (awaits `getLlmStack` for both brands and keeps the result as the snapshot of that env object). The synchronous functions read only that snapshot, never the resolver's background cache. Awaited at the top of `listConsents`, `recordConsent` (which also decides the closing withdrawal) and the route handlers for disclosures (seeker and public), the footer, the public consent catalog and the legal documents. Also started once when the routers are built for the live process, so it is normally loaded before the first request. Exported; PAR-3 and the G1 caller are asked to await it. Tests (`aiStackSnapshot.test.ts`, 14): an override is seeded through a mocked `appConfig` row; a cold instance and later calls give the same text, hash and requirement; a grant recorded on a second cold instance stores the hash the first one served and is not shown as "the text changed"; a withdrawal on a cold instance closes the account; the public routes serve the override cold. |
| 3 | The G1 step discards the cross-border grant on a mainland deployment on the shared stack | **Real. File is in no bundle's owns.** | Same as U1: exact request to the orchestrator. Nothing in PAR-5's files can make that step keep the grant. |
| 4 | `cn_email_offshore` misses a mistyped `CN_EMAIL_TRANSPORT` | **Real. Fixed.** | `startupAssertions.ts` reads the variable as the email service does: every value other than `aliyun_dm` and `none` sends through Resend, so it is flagged when `RESEND_API_KEY` is set (an explicit `resend` always, as before). The message says the value names no transport; it does not print the value. `preflight.mjs` inherits it. Tests: typo cases in `startupAssertions.test.ts` (advisory by default, failure under the strict switch, not flagged without a key) and in `__tests__/deploy/preflight.test.ts`. |
| 5 | `originalStorageConfigured` builds a service on every call and repeats an error log | **Real. Fixed.** | For the live process the answer comes from the module service (`resumeOriginalFileStorageService.isConfigured`), the one that does the write. For any other env object one probe is built and kept in a `WeakMap`. Test: five questions on a half-set CN bucket log the line once, and the line carries no value. |
| 6 | Staged zh copy uses 账户 where the glossary uses 账号 | **Real. Fixed.** | `legal.crossBorder.applies` in `i18n/staging/legal.zh.json` and the server string `crossBorderNoticeMarkdown` now say 账号. The zh cross-border consent prose is aligned too (`关闭我的账号`): that text is already new under v3 in this bundle and v3 has never been served, so no second version bump is needed; the pinned v3 hash in `consents.test.ts` is updated. Legal documents under `content/legal/cn/` keep their wording. |
| – | `unownedEdits: []` | Nothing to revert. | The two colocated test files noted last under "Files changed" are unchanged from the first handoff. |

## Items

### 1. [P0] GoApply resume originals are kept, on the shared store when it has no bucket: done

- `platform/residency/uploadPolicy.ts`: `brandStorageConfigured` reads the storage group through `brandEnv` and `brandStack` (the CN bucket when `CN_S3_BUCKET` starts one, else the shared one). `resumeUploadPolicy('goapply')` returns `originals: 'store'`, `redactKinds: []`, `dropImages: false`, `markerLocale: 'zh'` by default, in either region. New `CN_STORAGE_MODE`: `redact` redacts the parsed text and keeps the file; `discard` is the former CN-0 rule. `unavailable` only when `cnResidencyStrict(env)` and GoApply has no complete mainland bucket of its own (`cnOwnStorageProblem`), and never under `discard`.
- `services/ResumeOriginalFileStorageService.ts`: two stores, and the key says which one holds the object. `shared` is RoboApply's store with unchanged keys; GoApply writes there under `goapply/` when it has no bucket. `cn` is GoApply's own bucket (`CN_S3_*`, keys `cn/` as before). Reads, deletes, HEAD and signed URLs route by key, so an object written to the shared store stays readable and purgeable after GoApply gets its own bucket. `brandOfKey` answers GoApply for both prefixes. Local disk outside production as for RoboApply. New `providerOfKey(key)` and `originalStorageConfigured(brand, env)` (review finding 5: the live process is answered by the module service, any other env by one cached probe).
- The mainland-host check on the CN endpoint applies only under the strict switch (it is part of the policy now, one rule).
- A `CN_S3_BUCKET` with a missing key stores nothing (mode `none`): the shared keys never complete a half-set CN bucket (P2). The problem is logged once.
- `summary.ts`: new `storage: 'own' | 'shared'`; `storageHost` is the host of the store really used. `lib/candidateResumeIngest.ts`, `RAResumeService.deleteArtifactObject` and the purge's default artifact deleter follow (they ask `providerOfKey`).
- ACCEPT, tested: with only `S3_*` set a GoApply PDF or Word upload stores the original under `goapply/roboapply-resumes/…`, it reads back, images are kept, no 503; the account purge deletes those objects in the shared bucket; RoboApply keys are unchanged.
- Tests: `uploadPolicy.test.ts`, `cn0Upload.test.ts` (rewritten), `resumeOriginalStorage.test.ts`, `resumes.hub.test.ts`, `resumes.upload.test.ts`, `SeekerAccountPurgeService.brand.test.ts`.
- `resumes.hub.test.ts` sets `CN_RECRUITMENT_INFO_MODE=off` in the two "mode off" cases and asserts the default shows the posting. `resumes.legacyTailor.test.ts` had no test that depended on unset meaning off; the `delete` there is a reset and now says so.

### 2. [P1] Pre-storage redaction is an opt-in; photo and parsing work wherever storage works: done

- `applyResumeUploadPolicy` applies `CN0_STORAGE_PII_KINDS` only under `CN_STORAGE_MODE=redact` or `discard`.
- `features/profile/service.ts`: `cnPhoto` = market cn and `originalStorageConfigured(brand, env)`. Offered with only the shared bucket, on local disk in development, and with its own bucket. Refused with no store at all in production, under `discard`, and under the strict switch without a mainland bucket.
- GoHire stays GoApply's preferred parser. When it is not configured or cannot read the file, a GoApply PDF or image is read by the local pipeline exactly as on RoboApply. The "image goes to GoHire only, else 422 `image_parse_unavailable`" rule is gone: it was a refusal for a missing China-specific provider. An image nothing can read still fails honestly (`empty_text`).
- ACCEPT, tested: a GoApply resume with an ID number is stored verbatim by default and with the marker under `redact`; the photo field appears with only the shared bucket; with no `GOHIRE_API_KEY` a scanned PDF goes to the local pipeline (which uses the vision model the brand resolves, the shared one when `CN_LLM_VISION_MODEL` is unset).
- Tests: `uploadPolicy.test.ts`, `goHireParseRouting.test.ts`, `cn0Upload.test.ts`, `features/profile/routes.test.ts`.

### 3. [P0] The PI egress policy allows the fallback stack; the allowlist is a strict-mode rule: done

`egressPolicy.ts` `checkEgress`, cn branch: after the no-PI vendor rules it returns allowed unless `cnResidencyStrict(env)`. Under the strict switch the former mainland rules apply in every region: the allowlist, `intl_storage_for_cn`, `vendor_disabled_in_region`, and no exemption for offshore infrastructure. RapidAPI, Tavily and Firecrawl stay no-PI vendors on both brands. Header rewritten.

ACCEPT, tested: OpenRouter, Resend, LiveKit Cloud, the shared S3 endpoint and Tavily without PI are allowed for GoApply by default in both regions and denied under `CN_RESIDENCY_STRICT=true`; RoboApply decisions are unchanged (asserted under the strict switch too).

### 4. [P0] A mainland deployment boots without China-specific providers: done

- `startupAssertions.ts`: the report has `strict`, `failures`, `advisories`, `warnings`. Topology checks are always failures (`deploy_region_unknown`, `db_url_missing`, `db_host_not_allowed`, `intl_brand_on_mainland`; exported as `TOPOLOGY_FAILURE_CODES`). `icp_missing`, `cn_llm_off_allowlist`, `cn_storage_missing`, `cn_storage_offshore`, `content_safety_not_aliyun_green`, `content_safety_not_ready`, `cn_email_offshore` are advisories by default and failures under `CN_RESIDENCY_STRICT`.
- `cn_email_offshore` (review finding 4): the variable is read as the email service reads it. An explicit `resend` is flagged as before. Unset, and any value that is not `aliyun_dm` or `none` (a typo such as `aliyun` or `smtp`), is flagged when `RESEND_API_KEY` is set, because mail then goes through Resend.
- `cnLlmRouteFailures` asks the route policy with the domestic-only wall on, so it keeps answering "is this route domestic" after PAR-2 makes the default policy open.
- `startup.ts` logs each advisory as `Residency: [code] message` and continues.
- `deploy/cn/preflight.mjs` mirrors: advisories print as warnings and the exit code is 0; under the strict switch they are failures again and `content_safety_not_cn1_ready` is added as before. Its own cron, `VERCEL` and region checks still refuse.
- ACCEPT, tested: `DEPLOY_REGION=cn-mainland` with a valid database URL and no `CN_S3_*`, `CN_LLM_*`, `CN_ICP_NUMBER` or Aliyun keys boots with the gaps in the log; with `CN_RESIDENCY_STRICT=true` it exits 1 with the same codes.
- Tests: `startupAssertions.test.ts`, `startup.test.ts`, `__tests__/deploy/preflight.test.ts`.

### 5. [P0] Writes and boot checks on a deployment that serves both brands (P5-1, P5-2, P5-4, P5-6): done

- `writeBrand.ts`: new `resolveOwnerWriteBrand(explicit, ownerUserId, env)`. Order: explicit brand, the unit of work, the stored brand of the owning user (`brandOfUser`), the brand a one-brand deployment implies, else null. An owner whose brand the deployment does not serve gets null. RoboApply is never guessed. Callers: `candidateResumeIngest.ts`, `GoHireResumeParseService.parseResumeFile` (new optional `userId`), `ResumeOriginalFileStorageService.saveFile`.
- `startup.ts`: `copilotBrands` is unchanged and now checks both brands on a default production deployment. The check is not weakened. Tests rewritten to the new default.
- P5-6, one line each at boot: a scope variable that names no brand (error), each half-set GoApply group (warning; names only, no value), an unknown `CN_RECRUITMENT_INFO_MODE` (error), an unknown `CN_STORAGE_MODE` (error), an unknown `CN_SIGNUP_MODE` (error; PAR-3 request), an invalid content-safety setting (warning). The GoApply lines are skipped when the deployment does not serve GoApply. Under `CN_RESIDENCY_STRICT` a half-set storage group refuses the boot in any region (`StrictStorageGroupStartupError`, code `cn_storage_group_incomplete`).
- The footer model line (`buildLegalFooter`) reads the effective model (item 6).
- ACCEPT, tested: production with no `ALLOWED_BRANDS`, no context: a RoboApply user's upload is stored under RoboApply's keys and a GoApply user's under `goapply/`; with neither a context nor a known owner nothing is written and the error code is `brand_context_missing`; the GoApply footer names the shared model.
- Not verifiable here: "boots with a tool-capable shared copilot model and serves both brands" needs PAR-2. The test exists and is gated on the seam (`it.runIf(effectiveLlmProfile exists)`); a second test, green today, pins that whatever is refused in the interim is never RoboApply and that `ALLOWED_BRANDS=roboapply` boots.

### 6. [P0] Disclosures name the stack GoApply really uses: done (reworked after review findings 1 and 2)

`features/compliance/disclosures.ts`:
- **Per key, with the stack each value comes from.** `configuredModels` resolves every task in the order of plan §3.3: RoboApply = its admin override, then `<NAME>`; GoApply = its admin override, `CN_<NAME>`, then the shared stack (RoboApply's override, then `<NAME>`). Each row remembers whether its selector is GoApply's own or the shared stack's, because a selector is read in the context of its own stack.
- **A bare id takes the provider of the stack that set it.** GoApply's own provider is used only for GoApply's own selectors. A bare id left to the shared stack is disclosed with the shared provider (finding 1).
- **Mainland only when the request really goes there.** `parseModelId(id, provider, dialect)` names the first segment as before, with one rule on top: a row is placed with a mainland vendor only when the route goes to that vendor. `qwen/…` is Alibaba's endpoint in a selector GoApply set for itself and a gateway namespace on the shared stack (the router's own dialect rule, `resolveProviderPrefix`); `moonshotai/…` is a gateway namespace in both. Such a row names the provider the request is sent to and keeps the whole id as the model.
- **Behind the wall** a shared value that names no mainland vendor is not listed (the resolver sets it aside and the router would refuse it).
- **`source`**: `own` = a `CN_` value, `override` = the brand's own admin override, `shared` = a value of the shared stack (its variable or its override). Contract comment updated.
- **Admin overrides come from an explicit snapshot** (`loadAiStackSnapshot`, finding 2; see item 7). An explicit `env` object reads no database unless a reader is passed.
- `llmEndpointRule` / `llmEndpointFacts`: `no_mainland` (RoboApply, unchanged), `mainland_only` (GoApply behind the wall), `open` (GoApply by default: every provider it can reach, no host list, no excluded upstreams).
- `configuredProcessors`: email from `transportNameFor` (the PAR-3 contract), voice, speech, storage and push from their groups, payments from the rails that can charge, models from the list above. GoApply on the shared stack lists the shared processors. GoApply-only rows appear only when configured: Aliyun DirectMail, Alipay, WeChat Pay, Aliyun Content Moderation, its own LiveKit plane, "Object storage (CN)" only when the endpoint is mainland storage.
- New processor purpose `push` (`legal.processors.push`).
- Web: `LlmEndpoints` renders the `open` rule with its own key and no host list; `ProcessorsTable` renders the new purpose.
- ACCEPT, tested: with the shared-only env GoApply's rows equal RoboApply's minus Stripe; nothing unconfigured is listed (empty env → empty list); with a full CN stack and `CN_LLM_DOMESTIC_ONLY=true` the rule is `mainland_only`; the mixed stack names the shared vendor for the shared task.
- Works before and after PAR-2 and PAR-3: nothing here calls a function whose meaning those bundles change. `disclosuresResolverContract.test.ts` compares the disclosure with PAR-2's resolver once it is merged ("a task is disclosed with a mainland vendor exactly when the resolver routes it to a mainland provider").

### 7. [P0] The cross-border consent and its text follow the stack in use: done in PAR-5's files; the G1 step needs the orchestrator edit

- `deployment.ts`: `crossBorderApplies(brand, env) = isOffshore(env) || brandUsesSharedStack(brand, env)` (the contract; PAR-1 seam only).
- `disclosures.ts`: `crossBorderConsentApplies(brand, env)` = that, OR `aiLeavesMainland(brand, env)` (a configured model whose vendor is not known to be in the mainland, with no wall). This is P5-5: it sees database overrides, and GoApply's own provider being abroad.
- `consents.ts`: requirement and applicability `cross_border` (was `offshore`) use it; so do `onWithdraw` in the catalog and the closing withdrawal in `recordConsent`. RoboApply definitions are unchanged.
- **Same answer on every instance (finding 2).** `loadAiStackSnapshot(env)` loads the admin model overrides of both brands; the text, the hash and the requirement are built from that snapshot. `listConsents`, `recordConsent` and every route of this area that serves a text or a disclosure await it first. With `LLM_SETTINGS_DB_DISABLED=true` no row is read, as in the resolver. If the row cannot be read the request is still served, from the environment.
- Prose: the cross-border text no longer says "closed beta" or that all data is offshore, and carries `%AI_PLACE%`. `aiPlaceSentence` with rule `open` names the AI services configured, each with its country; it says "mainland only" only under `mainland_only`. The zh text says 账号 (finding 6).
- `CONSENT_PROSE_VERSION = '2026-10-11.par5.v3'`. Only four served texts changed (cross-border and AI consent, zh and en); every other v2 hash is unchanged under its version, pinned by test.
- `{{offshore_notice}}` in the GoApply privacy notice is built from the same sentences (API markdown) and rendered as a live block on the page (`CrossBorderNotice`). The hand-typed "处理地区为美国" is gone from both loaders.
- ACCEPT, tested: mainland with only shared credentials → required, text names the offshore processors and the AI destination; mainland with a complete CN stack → not offered, and with the wall the AI sentence says mainland only; a complete CN stack plus an admin override that sends one task abroad → required, cold or warm; offshore unchanged in rule; no text names an unconfigured processor or a vendor the request does not go to.
- **Not done, outside PAR-5's owns:** "an existing account is asked through the existing required-consent prompt". The G1 screen shows the box (it is catalog-driven) and sends it, and `onboarding-cn/validate.ts` drops it unless the deployment is offshore. PAR-3's sign-up already takes the union with the catalog (`requiredSignupConsents` in its worktree), so sign-up and catalog agree after the merge.

### 8. [P1] Legal documents are served on GoApply by the same rule as RoboApply: done

The production GoApply `not_found` branch for drafts is removed from `legalDocs.ts` and `app/legal/legalSource.ts`. `/legal`, `/legal/terms`, `/legal/privacy`, `/legal/coaching` load on GoApply in production as drafts with the banner; with `CN_LEGAL_DOCS_VERSION` and an approved file the banner is gone (tested with a temporary content directory, both brands). Page comments updated. `server/src/features/coaching/legal.test.ts` (PAR-8) did not turn red.

### 9. [P1] The video-recording consent is offered on GoApply: done

The goapply `interview_video` entry applies through a new rule `camera_video`: offered unless `CN_INTERVIEW_CAMERA_PUBLISH` is set and is not a true value, the reading PAR-4's `getInterviewMediaPolicy` applies to the same variable. zh and en prose unchanged. A grant given before the switch was set stays listed so it can be withdrawn. `content/legal/cn/pi-collection-list.md` names camera video as a separately consented item. Tests: `consents.test.ts`, `components/features/compliance/compliance.test.tsx`.

### Carry-over entries (`waveFIX-carryover.md`, PAR-5 section)

1. `parsedResumeToMarkdown` dates: **done**. A role line uses `startDate` / `endDate` when `duration` holds no year; a duration with dates is kept as written.
2. Rewrite response `source`: **done**. `POST /v2/resumes/:id/rewrite` answers `source: 'model' | 'fallback'` (additive). The web type is in the frozen client (Request).
3. `WhyThisJob.tsx` punctuation: **done**. New keys `legal.explain.quoteFromPosting` / `quoteFromResume` take `{evidence}` and hold the colon and quotes.
4. RoboApply sign-up rows without a hash: **not done**. `server/src/features/auth/signupPolicy.ts` is PAR-3's.
5. `storageCountry` Hong Kong check: **done** (the redundant check is deleted; the test stays).
6. Consent omits AI model rows: **done** by item 7. With rule `open` the rows are listed; with `mainland_only` they are left out because the router refuses the rest.
7. `findJob` scope: **not done**. `server/src/features/resume/store.ts` is in no bundle's owns.

### Precedence (documents and later requests over the item text)

- **Item 5, write brand.** PAR-1's O-3 proposed returning the default brand on a shared bucket. The item and plan §3.6 say to pass the owner's brand and never guess RoboApply. Implemented per the item and the plan.
- **Item 6, endpoint rule.** The item says `mainland_only` "when `cnLlmDomesticOnly(env)` and GoApply has its own provider". Implemented as `mainland_only` whenever the wall is on. Behind the wall with no provider nothing can be sent, so `open` would print a provider list that is refused. PAR-2 reports the same reading. Plan §3.6 names the rule without the second condition.

## Files changed

61 files (58 modified, 3 new), all inside PAR-5's owns except the two noted last.

- `server/src/platform/residency/`: `uploadPolicy.ts`, `egressPolicy.ts`, `startupAssertions.ts`, `writeBrand.ts`, `summary.ts`, `deployRegion.ts` (comments), `index.ts`, and tests `uploadPolicy`, `egressPolicy`, `startupAssertions`, `resumeOriginalStorage`, `goHireParseRouting`, `cn0Upload`, new `writeBrand.test.ts`
- `server/src/platform/startup.ts`, `startup.test.ts`
- `server/src/services/ResumeOriginalFileStorageService.ts`, `GoHireResumeParseService.ts`
- `server/src/lib/candidateResumeIngest.ts`
- `server/src/roboapply/v2/services/RAResumeService.ts`, `routes/resumes.ts`, `routes/resumes.hub.test.ts`, `resumes.upload.test.ts`, `resumes.legacyTailor.test.ts`
- `server/src/roboapply/services/SeekerAccountPurgeService.ts`, `SeekerAccountPurgeService.brand.test.ts`
- `server/src/features/profile/service.ts`, `contract.ts` (comments), `routes.test.ts`
- `server/src/features/compliance/`: `deployment.ts`, `disclosures.ts`, `consents.ts`, `processingStatement.ts`, `legalDocs.ts`, `contract.ts`, `index.ts`, `routes.ts` (this round), and tests `compliance`, `consents`, `workers`, `routes`, new `aiStackSnapshot.test.ts` and `disclosuresResolverContract.test.ts` (this round)
- `components/features/compliance/`: `DisclosureTables.tsx`, `LegalDocument.tsx`, `ConsentsPanel.tsx`, `WhyThisJob.tsx`, `legalCatalog.ts`, `index.ts`, `compliance.test.tsx`
- `app/legal/legalSource.ts`, `legalSource.test.ts`, `page.tsx`, `[doc]/page.tsx`
- `content/legal/cn/pi-collection-list.md`
- `deploy/cn/preflight.mjs`, `__tests__/deploy/preflight.test.ts`
- `i18n/staging/legal.en.json`, `legal.zh.json`
- **Not in any bundle's owns, colocated with `routes/resumes.ts`:** `server/src/roboapply/v2/routes/resumes.rewriteCredit.test.ts` (1 assertion) and `resumes.rewriteFallback.test.ts` (4 assertions). They compared the whole response body, so the additive `source` field needed them. Revert carry-over 2 if this is not wanted. The review listed no unowned edit.

Changed in the review round: `disclosures.ts`, `consents.ts`, `routes.ts`, `index.ts`, `contract.ts`, `legalDocs.ts`, `startupAssertions.ts`, `ResumeOriginalFileStorageService.ts`, `i18n/staging/legal.zh.json`, the tests `compliance`, `consents`, `workers`, `startupAssertions`, `resumeOriginalStorage`, `preflight`, and the two new test files.

## Tests run

| Command | Result |
|---|---|
| Owned files (`server/src/platform/residency`, `startup.test.ts`, `platform/pii`, `routes/resumes*`, `SeekerAccountPurgeService.brand.test.ts`, `features/profile`, `features/compliance`, `components/features/compliance`, `app/legal`, `__tests__/deploy/preflight.test.ts`) | 28 files, 724 passed, 2 skipped (both gated on PAR-2) |
| `server/src/features/compliance` alone | 7 files, 204 passed, 1 skipped |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 (design, copy, LLM costs, API boundary, extension, zh variants) |
| `npx vitest run --exclude ".claude/**"` (final run) | 12,955 tests: 12,850 passed, 92 failed, 3 skipped, 10 todo; 43 failing files, none in PAR-5's owns and none unowned |
| `node docs/jobright-clone/orch/check-bundles.mjs …/parity-bundles.json` | 0 problems |
| Contract check against PAR-2's worktree code (temporary probe file, deleted) | 2 passed, 0 skipped |

The suite was run three times in this round. The failing set was identical in the first and the last run. In the middle run one more test failed once: `components/features/feed/feed.test.tsx` "a failed Undo keeps the job in Applied…" (PAR-8). It passes alone (35 of 35) and passed in the other two runs; it waits on a toast and is timing-sensitive under 624 parallel workers. This bundle touches nothing it imports.

The final runs leave no file behind (no `server/storage/`, nothing untracked except the three new test files).

## Red tests for other bundles

Turned red by PAR-5, all **PAR-3**:

- `server/src/features/auth-cn/routes.test.ts` "policy serves the text of each required consent…": it asserts the old cross-border wording `中国大陆境外处理和存储`. The text now starts `使用 GoApply 时，你的个人信息会由中国大陆境外的服务处理或存储。`, followed by the processors sentence and the AI sentence, and ends `我知道撤回此同意会关闭我的账号并删除我的数据。`. Assert that.
- `server/src/features/auth/goapplySignup.test.ts` "requires the agreement, the age confirmation and (outside the mainland) the cross-border consent": its mainland env has no CN stack, so the catalog now requires `pipl_cross_border` there (item 7). The "not asked, not stored" case needs a complete CN stack in the env (see `MAINLAND_OWN` in `consents.test.ts`), and the bare mainland env should assert the consent is required.
- `components/features/growth/invite.test.tsx` "/legal/referral-terms is not served on production GoApply while it is a draft": it is served now (item 8). Assert `kind: 'doc'` with `draft: true`.

## Pre-existing failures

89 tests in 40 files, all in other bundles' files and all from PAR-1's list (its 95 minus PAR-5's 6). By owner in the final run: PAR-11 44 tests in 16 files, PAR-2 17 in 10, PAR-3 8 in 5 (plus the 3 above), PAR-4 11 in 3, PAR-7 5 in 2, PAR-8 3 in 3, PAR-9 1 in 1. The 12 older failures PAR-1 listed as pre-existing do not fail at this base.

## Requests

### Orchestrator

- **Finish item 7 at merge: `server/src/features/onboarding-cn/validate.ts` (no owner).** In `validateConsent`, replace `const offshore = isOffshore(ctx.env ?? process.env);` with `const offshore = crossBorderConsentApplies(getBrand('goapply'), ctx.env ?? process.env);` (the flag has three uses: the required check, the `pipl_cross_border` effect, the stored answer). Import `crossBorderConsentApplies` from `../compliance/index.js` in place of `isOffshore`, and `getBrand` from `../../platform/brand/registry.js`. Update the header at `validate.ts:10-11` and the comment at `onboarding-cn/contract.ts:22` ("required while personal information leaves the mainland on this deployment"). In `onboardingCn.test.ts:245` the case `MAINLAND = { DEPLOY_REGION: 'cn-mainland' }` now requires the box and produces a `pipl_cross_border` effect; the "not required, not stored" case needs a complete CN stack (the `MAINLAND_OWN` object in `features/compliance/consents.test.ts`).
- **Same step, one await: `server/src/features/onboarding/defaults.ts:133` (no owner).** `validateCnStep` is synchronous. Wrap it: `validateCnStep: async (step, body, ctx) => { if (step === 'consent') await loadAiStackSnapshot(); return validateCnStep(step, body, ctx); }` with `loadAiStackSnapshot` from `../compliance/index.js`. `applyCnStep` already goes through `recordConsent` and `listConsents`, which load it themselves.
- **Hot file `lib/api/v2/_real.ts`:** add `source?: 'model' | 'fallback'` to the `resumes.rewrite` response type (carry-over 2).
- **Dead client code:** the server no longer answers `image_parse_unavailable`. `app/(auth)/resume/page.tsx:299` (the error map) and the comment at `lib/api/resumes.ts:196` can go; the string `resume.hub.errors.image_unreadable` then has no user.
- **i18n merge:** keys below. `legal.consents.closeBody`, `legal.explain.fromPosting` and `legal.explain.fromResume` have no user after this bundle; remove them from all nine bundles once the new keys are translated.
- **Staging rule to know:** `__tests__/lib/i18nStaging.test.ts` fails for a staged string that contains `%BRAND%`. The staged copy here therefore names no brand.
- After the merge, confirm the two gated tests run and pass: the O-1 acceptance in `startup.test.ts` and `features/compliance/disclosuresResolverContract.test.ts`.

### PAR-3

- The three red tests above.
- **Await the snapshot before the sign-up policy and validation (review finding 2).** In `auth-cn/signupPolicy.ts`, right after each `await import('../compliance/index.js')` (in `requiredSignupConsents`, in the phone and WeChat validation, in the policy that serves the texts), add `await compliance.loadAiStackSnapshot?.(env);`. Same in `features/auth/goapplySignup.ts` before `servedConsentProseByHash` and the catalog validation. The optional call works before and after the merge. Without it the policy can be served by a warm instance and the form refused by a cold one (`consent_required` or an outdated hash) when an admin model override exists.
- The earlier request to use one predicate is **withdrawn**: your `requiredSignupConsents` already adds whatever the catalog requires, so sign-up and catalog agree.
- Your P5-A is done with a lazy import of `cnSignupModeProblem` from `features/auth-cn/index.js`, only when `CN_SIGNUP_MODE` is set. If the export is renamed, the line disappears silently; tell the orchestrator.
- Carry-over 4 stays with you (`features/auth/signupPolicy.ts`).

### PAR-2

- Nothing to change. For your information: the disclosures no longer call `getModelSetting`. They resolve each key from the same sources in your order and keep the stack of each value, because the returned string alone does not say which provider a bare id goes to. `disclosuresResolverContract.test.ts` compares the two answers after the merge. If you later expose the source per key with an `env` argument (`resolveModelKey(key, brand, env).source`), the mirror in `disclosures.ts` (`resolveSetting`) can be replaced by it.

### PAR-4

- The purge test file is rewritten so it holds before and after your merge: a GoApply session's keys must be deleted in the CN store, extra deletes of the same keys in the shared store are allowed, and "without a CN store" accepts either the blocked answer (today) or the shared-store clean-up (after your merge). Tighten it after the merge if you want exact counts.
- Your P5-C (`warnVoiceConfigProblemsOnce` at boot) is not wired: startup already logs the half-set voice and speech groups from `brandEnvGroupProblems`, and the function does not exist at this base.

### PAR-6

- Optional `alipayEntityNotice(env)` at boot is not wired (the export does not exist at this base).

### PAR-10

- Document `CN_STORAGE_MODE` as below, including that an unknown value is read as `discard`.
- Document that `CN_EMAIL_TRANSPORT` has three values and that any other value is read as `resend`, which the boot check and the preflight now report when `RESEND_API_KEY` is set.
- Startup also logs an unknown `CN_STORAGE_MODE` and an invalid content-safety setting. The strict rule for a half-set `CN_S3_*` group applies in every region, not only on the mainland.
- The preflight header says "OK, with warnings" when it passes with advisories. Your `deployKit.test.ts` list of eight codes matches.

### Owner

- **New consent wording (v3), zh and en, is the agent's, not counsel's.** It now applies on a mainland deployment that uses the shared stack. Plan §8 item 3 already asks for this review.
- **New in this round, visible on RoboApply too: a gateway model id that carries a mainland vendor's name.** A model set as `qwen/…` or `moonshotai/…` and sent through OpenRouter (or another gateway) used to be listed as that vendor with country China. It is now listed as the gateway with the whole id as the model (for example `openrouter`, `moonshotai/kimi-k2`, United States), because that is where the request is sent, and because the cross-border consent decision reads these rows. On RoboApply the old row contradicted the page's own statement that no request goes to a mainland service. Ids with an `openrouter/` prefix, direct prefixes (`openai/`, `deepseek/`, `dashscope/`) and non-mainland namespaces (`x-ai/…`) are listed exactly as before. Say if you want the old display back for RoboApply.
- **`CN_STORAGE_MODE=redact` keeps the uploaded file as uploaded;** only the stored text and fields are redacted. `discard` is the mode that keeps no original. Say if `redact` should also drop the original.
- **An unknown `CN_STORAGE_MODE` value is read as `discard`** and logged at error level, on the reasoning that a typo in a privacy switch must not keep everything. The other new switches fail open. Say if you want this one to match them.
- **RoboApply's processor list gains one row** when VAPID keys are set: "Browser push service (Google, Apple, Mozilla)", purpose push, country not listed. It also names the model an admin override selects, where it used to name the env value.
- Existing GoApply accounts hold a cross-border grant to the v2 text. Settings shows "the text changed" and "Agree to this text"; nothing prompts them. Same open decision as carry-over Owner item 2.

## Schema requests

None.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `CN_STORAGE_MODE` | new. `store`: GoApply keeps originals and stores text as parsed. `redact`: ID numbers and health details are removed from the stored text and fields; the file is still kept. `discard`: no original, no photo, redacted text. Unknown value: read as `discard`, logged | `store` |
| `CN_RESIDENCY_STRICT` | behaviour added here: PI egress allowlist for GoApply in every region; originals only in a complete mainland bucket of its own (else 503 `storage_unavailable`); mainland boot advisories become failures; a half-set `CN_S3_*` group refuses the boot | off |
| `CN_S3_BUCKET` (+ `CN_S3_ENDPOINT`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_REGION`, `_FORCE_PATH_STYLE`) | optional. Set: GoApply files go to this bucket under `cn/`. Unset: the shared bucket under `goapply/`. The mainland-host check applies only under the strict switch | unset |
| `CN_INTERVIEW_CAMERA_PUBLISH` | read here for the consent catalog: set and not a true value → the video consent is not offered on GoApply | on |
| `CN_LLM_DOMESTIC_ONLY` | read here for disclosures: rule `mainland_only`, AI rows left out of the cross-border consent, shared model values that name no mainland vendor not listed | off |
| `CN_EMAIL_TRANSPORT` | read here for the boot advisory `cn_email_offshore`: `resend`, or any value other than `aliyun_dm` and `none` (unset included) when `RESEND_API_KEY` is set. Through `transportNameFor`, also for the processor list | `resend` |
| `CN_LEGAL_DOCS_VERSION` | no longer gates serving. A draft is served with the banner; the version only publishes | unset |
| `GOHIRE_API_KEY` | no longer needed for GoApply images or scans: the local pipeline is the fallback | unset |
| `DEPLOY_REGION` | no longer decides the GoApply storage rule, the egress rule or the cross-border consent by itself | unset (offshore) |
| `LLM_SETTINGS_DB_DISABLED` | existing switch, now also read here: `true` → disclosures and consent texts ignore admin model overrides, as the resolver does | unset |

## i18n keys added or changed

All in namespace `legal`, staged in `i18n/staging/legal.en.json` and `legal.zh.json`. No existing key was changed.

- `legal.consents.closeBodyCrossBorder` (replaces the use of `closeBody`, which spoke of a beta that runs offshore)
- `legal.processors.push`
- `legal.llmEndpoints.open`
- `legal.crossBorder.applies`, `legal.crossBorder.none` (zh `applies` now says 账号, review finding 6)
- `legal.explain.quoteFromPosting`, `legal.explain.quoteFromResume` (take `{evidence}`)

Server strings, not in the bundles: the cross-border consent prose (zh, en), the `open` AI sentences and the push purpose words in `processingStatement.ts`, the `open` line of `llmEndpointsMarkdown`, `crossBorderNoticeMarkdown`.

## Known gaps

- **Nothing was checked in a browser.** To retest after the merge on both brands, light and dark, 375 px and 1280 px: `/legal` and `/legal/privacy` on GoApply (draft banner, the cross-border notice, the `open` AI block with no host list, the processors table with the push row), the withdraw dialog in Settings › Consents, the photo field in Settings › Sensitive answers, and G1 on a mainland deployment without a CN stack once the orchestrator edit is in.
- **Until the i18n merge** GoApply Chinese pages show the seven new strings in English.
- **The G1 cross-border box** (item 7) is stored only after the orchestrator edit. Until then Settings › Consents is the working path.
- **Synchronous callers that do not await the snapshot** (PAR-3 sign-up, the G1 validator) read whatever snapshot the instance holds. The snapshot starts loading at boot, so the window is the first moments of a cold instance, and it matters only when an admin model override changes a vendor. The two requests close it.
- **After an admin saves a model override**, instances pick it up within the resolver's 30-second cache. A consent granted inside that window on an instance that still holds the old row carries the old hash and is later shown as "the text changed". This is a real change of text, shown late on one side.
- **Model naming limits kept from before:** a bare id with no provider setting is listed as `unknown` (the router's default for it is OpenRouter); a bare id under provider mode `direct` is listed as `direct`. Both have no country, so for GoApply they count as possibly abroad, which errs toward asking for the consent.
- **Reads under the strict switch.** The strict switch refuses writes to the shared store. Objects already written under `goapply/` stay readable and deletable there, so turning the switch on strands nothing. It also means such objects are still read from an offshore bucket until they are moved or purged.
- **`brandUsesSharedStack` is over-inclusive for the consent.** It is true when a group resolves to shared names that are themselves unset (a full CN stack with no `CN_VAPID_PUBLIC_KEY` and no VAPID at all). The consent is then asked although nothing may leave the mainland; its text names no processor and points at the Legal page. The predicate is PAR-1's contract.
- **`aiLeavesMainland` treats a vendor with no known country as possibly abroad** (a self-hosted gateway named in `CN_LLM_PROVIDER`). An operator who runs mainland-only sets `CN_LLM_DOMESTIC_ONLY=true`, which settles it.
- **GoApply interview media** on the shared store, and its purge, are PAR-4's (`interview-engine`); this bundle's storage service covers resume originals and application files only.
- `resumeUploadPolicy().stage` and `isCn0` still exist as region facts for other areas (`features/tools`, `auth-cn`); they no longer decide anything in this bundle's files.
