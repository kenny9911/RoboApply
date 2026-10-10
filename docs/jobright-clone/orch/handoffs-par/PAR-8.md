# PAR-8

Job search on both brands and signed-in workspace parity, after the independent review. Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-PAR-8`, branch `wp/PAR-8`, base `3fa104e`. Nothing committed, pushed or stashed. No schema change, no new dependency, no `i18n/messages` edit, no dev server, no browser run, no call to a real provider.

All nine items are done and all seven review findings are resolved (six in code, one as a verified patch for files no bundle owns). Every test in a file PAR-8 owns is green (57 files, 1,555 tests). Both typechecks pass for the whole repository. `npm run check` passes. The full suite has 95 failures, all in other bundles' files: 92 were red at the base and 3 are turned red by this bundle (listed below). The extension package's own suite has 8 failures in `extension/test/`, which no bundle owns; the patch that turns them green is under Requests O8-1.

**Read first (orchestrator).**
1. **Apply the patch in O8-1 at the merge** (`git apply`), or the CI job `extension` is red. `extension/test/` is in no bundle's owns, so I did not edit it. I ran the whole extension suite against the patched content without touching the files: 709 / 709.
2. The GoApply job-search results depend on PAR-11's contract field `apply.url` on the feed item. Until PAR-11 merges, a GoApply search answers 200 with an honest empty list (`status: 'empty'`), never an error and never a fabricated link.
3. `JOB_SEARCH_GLOBAL_DAILY_LIMIT` is now a budget per brand, not one sum for the deployment (review finding 3). On a deployment that serves both brands the total can be twice the value. See the env table.
4. Nothing here was checked in a browser. The UI changes use design tokens only and are covered by component tests on both brands; light / dark at 375 px and 1280 px still need the post-merge browser pass.

## Review resolution

| # | Finding | Verdict | What was done |
|---|---|---|---|
| 1 | High. The GoApply planner skips the phone-binding and `ai.text` gates | Real. Fixed | `server/src/job-search/agent.ts`: the consent-only check is replaced by one injected gate, `createPlannerGate`, run after the source check and before any reservation or model call. Three checks in the order of `legacyAiGates.ts` and `POST /feed/nl-query`: (1) GoApply only, `phoneBindingRequired(userId)` from `features/auth-cn` answers `403 phone_binding_required`; (2) `aiAllowed` answers `403 ai_off`; (3) `isEnabled('ai.text', { userId, brand })` answers `503 ai_unavailable`. A failed lookup throws, so the gate fails closed. The GoApply OpenAPI document lists the three answers. **One deliberate difference from the reviewer's text:** check 3 runs on both brands, not on GoApply only, because the consent-and-`ai.text` pair is the rule every feature uses on both brands (`resumeAiAvailable`, `outreachAiAvailable`). On RoboApply it changes an answer only when an operator set `FLAG_ROBOAPPLY_AI_TEXT=false` or a per-user override turns AI text off; before, the planner ignored that switch. With defaults RoboApply is unchanged (tested with nothing injected). The phone rule is not looked up for RoboApply (the same skip as the feed's phone gate). Tests: 10 new or rewritten cases in `agent.test.ts`, one of them through the configured gate with nothing injected (a GoApply WeChat account with no phone is refused, the same account with a phone and the consent runs, then `FLAG_GOAPPLY_AI_TEXT=false` refuses it); `routes.test.ts` checks the three typed answers on both routers. |
| 2 | High. Merging turns 8 extension tests red, and CI runs them | Real. Not mine to edit; verified patch supplied | `extension/test/` is in no bundle's owns. The exact patch is under Requests O8-1. It applies cleanly to the base (`git apply --check`), and I ran the extension suite with the patched content loaded in place of the four files (a Vite `load` hook in a scratch config; no file in `extension/test/` was touched): 36 files, 709 / 709. `manifestViolations` and the forbidden-host assertions are unchanged. |
| 3 | Medium. One global daily search quota is shared by both brands | Real. Fixed | `server/src/job-search/quota.ts`: `reserve(userId, apiKeyId, requestId, brand)`. The deployment count is scoped to the brand's accounts through the `user` relation of `ApiUsageRecord` (no schema change). The three limits are read through `brandEnv`, so `CN_JOB_SEARCH_GLOBAL_DAILY_LIMIT` (and the two per-user names) can differ. `routes.ts` and both `agent.ts` reservations pass the brand. **Difference from the reviewer's snippet:** `User.brand` is `String @default("roboapply")`, not nullable, so `{ brand: null }` does not typecheck. RoboApply's budget counts every account whose stored brand is not another known brand (`brand: { notIn: ['goapply'] }`), which also covers a legacy value, the same rule `keys.ts` uses. Tests: 5 new cases in `quota.test.ts` over an in-memory usage table, including "250 GoApply reservations do not rate-limit a RoboApply user, and the reverse". |
| 4 | Medium. GoApply integration keys answer 503 `not_licensed` by default, and the GoApply pages do not say so | Real. Resolved with option (b); the default is still the owner's call | I kept the operator's grant as the default: turning the index on for keys republishes employer-board and recruiter-bank rows through third parties, which is a licensing decision (D3) I should not make for the owner. What changed is that the product now says so. (1) `jobsCn.searchApi.sources` (en, zh) names the recruiter bank ("and, when they are listed, from {sourceName}") and says the site operator decides whether keys can read the postings and that a key returns an error until then. (2) The GoApply OpenAPI description says the same, with the exact answers. (3) `GET /job-search/keys` now also returns `sources`, the source list as a key sees it, and the key page shows a notice when no source is open to keys (`jobs.searchApi.keySourcesOff`). The notice is driven by the response on both brands, because the rule is the same on both; a RoboApply page shows it only when no source is granted to keys, which is exactly when every key call fails. An older server (no `sources`) shows nothing. If the owner picks option (a) it is one line, see Owner. |
| 5 | Low. 面议 is still printed outside the card slot; `payUndisclosed` is never used | Real. Fixed | One rule in the market module: `marketPayWords(market, row)` and `marketPayLineText(market, text)` (`components/features/market/MarketJobMeta.tsx`, GoApply half `cnPayWords` / `isNegotiablePay` in `market/cn/meta.ts`). On GoApply a posting states no pay when the contract says so (`salary: null`) or when its pay line only says 面议; that reads "Pay not listed". RoboApply prints the words as before (Taiwan's 面議 keeps its own note). Used by `SimilarJobs`, `JobHeader` (the fallback when there is no market block), the WeChat share-card chain in `JobDetailPanel`, and the card's own pay line (`cardModel.payText`, which the visitor and Assistant cards share). `payUndisclosed` now reads the contract field and is what `cnPayWords` calls; the unused `JobListing.payUndisclosed` is deleted. Tests: one per surface in `job.test.tsx` (header, similar jobs, share card, RoboApply unchanged) and reader cases in `cnListing.test.tsx`. |
| 6 | Low. `listingApply` replaces a producer `target: null` with a guess | Real. Fixed | `lib/api/feed.ts`: when the item has an `apply` field (even null) the server's answer is final for both `url` and `target`. Only a response with no `apply` field at all falls back to `applyUrl` and the source kind. Tests: `{ apply: { url, target: null }, source: { kind: 'bank' } }` gives `target: null`, `apply: null` gives no link, and `cnApplyCopy` gives the shared wording for such a row. |
| 7 | Low. A LinkedIn-only plan on GoApply spends a reservation and a model call, then answers 503 | Real. Fixed | `agent.ts`: when the brand's source list has no LinkedIn-capable source (GoApply), an explicit `linkedinOnly: true` answers `400 invalid_request` before any reservation or model call, and a planned `linkedinOnly` is not applied: the search runs on the site's sources and the wish is listed in `unverifiedPreferences` in the user's own words (or as `LinkedIn` when the request has no such clause). RoboApply is unchanged. The GoApply OpenAPI text describes both. Tests: 4 new cases in `agent.test.ts`. |

No unowned edit was found by the reviewer and none exists now: all 93 changed paths were checked against `parity-bundles.json` by script.

## Items

### 1. [P0] Job-search API, planner and integration keys on both brands: done

- `server/src/job-search/routes.ts`: `roboApplyOnly` is replaced by `requireJobsFeed`: `isEnabledForBrand('jobs.feed', brand, env)` before the OpenAPI document, the key lookup and the session lookup. The brand, the reader (`userId`) and the brand's default country are passed into the service, the planner and the quota. `createJobSearchRouters` takes an `env` dependency (default `process.env`, read per request). `GET /keys` also returns `sources`, the source list as a key of this brand sees it.
- `server/src/job-search/service.ts`: `providersForBrand(brand)` (exported). RoboApply keeps its list and every existing rule. GoApply gets one provider, `index`. `createJobSearchService` takes `brandProviders` for tests. For GoApply no RapidAPI key is required, RoboApply's allowlist and `RA_ONBOARDING_*_DISABLED` switches are not read, and no RapidAPI provider is ever in its list. The cache key carries the brand, and the reader for a per-user source, so one user never gets another user's cached result.
- New `server/src/job-search/index-provider.ts`: reads `feedService.preview(userId, { q, filters, limit })` (lazy import, run as GoApply). It clears every saved filter of the reader first (the feed merges overrides over the user's saved search; a keyword search states its own filters), then sets only what the request states. It never returns the reader's own imports, returns nothing for a country other than `cn`, and fails closed without a reader. `normalization.ts` is unchanged: a row with no apply link is dropped on both brands.
- `server/src/job-search/agent.ts`: the planner gate (`createPlannerGate`, review finding 1): GoApply phone binding (`403 phone_binding_required`), the AI consent (`403 ai_off`), the brand's `ai.text` capability (`503 ai_unavailable`), after the source check and before any reservation or model call. The plan's default country is the brand's. LinkedIn-only on a brand with no LinkedIn-capable source (review finding 7): explicit is `400`, planned is not applied and is disclosed.
- `server/src/job-search/quota.ts`: one deployment budget per brand, limits through `brandEnv` (review finding 3).
- `server/src/job-search/keys.ts`: `authenticate(authorization, brandId)`. A key is valid only on its owner's brand host, in both directions. An owner with no stored brand is a RoboApply account.
- `server/src/job-search/openapi.ts`: `jobSearchOpenApiFor(brand)`. RoboApply's document is unchanged except the version (1.1.0 to 1.2.0), `Provider.sourceType` gaining `index`, `Provider.homepage` being allowed empty, and the planner's 503 line naming `ai_unavailable`. GoApply's names its own product, default country `cn`, mainland examples, its one source, that key access to the index is the operator's grant, the three gate answers, and what `linkedinOnly` does there. `types.ts` and `validation.ts` follow (`index` is a known provider id; `parseSearchInput(value, { country })`).
- `server/src/app.ts`: comment rewritten.

ACCEPT, all tested: GoApply `POST search` returns market cn rows from the index with source and apply URL and calls no outside provider; the planner refuses without the consent and works with it; a RoboApply key is invalid on GoApply and the reverse; `CN_RECRUITMENT_INFO_MODE=off` answers 404 `feature_disabled` on every route of both routers before any lookup; RoboApply is served with that switch set and its results are unchanged.

**Decision to know (documents win over a looser reading of the item).** For integration keys (audience `api`) the index needs the operator's grant, exactly as every RoboApply source does: `index` must be named in `JOB_SEARCH_API_PROVIDERS` (GoApply reads `CN_JOB_SEARCH_API_PROVIDERS ?? JOB_SEARCH_API_PROVIDERS`). Without it a GoApply key answers `not_licensed`, which is what a RoboApply key answers today with no grant. The signed-in website search needs no grant. This keeps one redistribution rule for both brands (D5) and never republishes employer-board rows through a key by default (D3). The pages and the OpenAPI document now say so (review finding 4). See Owner.

Tests: `routes.test.ts` (GoApply section: 9 cases), `index-provider.test.ts` (11), `agent.test.ts` (65 in the file; 14 for the gate and LinkedIn), `quota.test.ts` (14; 5 for the brand budgets), `keys.test.ts` (rewritten brand cases). `audience-policy.test.ts` has no GoApply 404 case to rewrite (it never had one); the GoApply grant rule is tested in `index-provider.test.ts`. 180 tests in `server/src/job-search`.

### 2. [P0] Job-search pages and developer documentation on GoApply: done

- `components/job-search/metadata.ts`: `jobSearchAvailableFor` is true for both brands. The metadata now loads the request brand's bundle, so the description names GoApply on GoApply (it named RoboApply before, through the default brand).
- `app/(auth)/job-search/developers/page.tsx`, `app/developers/job-search/page.tsx`: no `notFound()`.
- `components/job-search/countries.ts`: `jobSearchBrandExamples(brand)` and `countryOptionsFor`. `lib/api/job-search.ts`: `jobSearchExamples(spec)` builds the two curl examples; RoboApply's are byte-identical to before (tested). `keysReadNoSource(sources)` reads the new field of the key list with a safe default.
- `JobSearchDeveloperGuide.tsx`: the brand's own symbol and name (it hard-coded RoboApply), mainland examples and `GOAPPLY_*` placeholder names on GoApply, and three GoApply lines: what the results are (employer careers pages and, when listed, the recruiter bank; key access is the operator's decision), what the natural-language route needs (the AI consent, and a verified phone for a WeChat account), and the placeholder note. `ApiKeyWorkspace.tsx`: the same source line, "a key works only on this site", and the notice when the server says no source is open to keys. Both show "This is not available yet." (existing `common.not_available`) when the site's `jobs.feed` capability is off, instead of a page that describes an API answering 404.
- `lib/proxyPaths.ts`: the list already served both brands; comment updated.
- `server/src/roboapply/v2/routes/discover.ts`: gates unchanged, comment rewritten (the mode defaults to `licensed`; `RA_V2_DISCOVER_DISABLED` stays an operator switch that nothing sets by default).

Chinese copy: `jobSearch` / `jobSearchApi` are already translated in `i18n/messages/zh.json`, so `/developers/job-search` renders Chinese on GoApply today. The new strings are staged in `jobsCn` and `jobs` (en and zh). I did not add `components/job-search/messages.zh.json`: nothing loads such a file, and `__tests__/routeShells/routeShells.test.tsx` (unowned) pins the exact file list of that directory.

`/job-search` itself is a redirect to `/jobs/explore` on both brands (`next.config.mjs`); the item's "answers 200" holds for the page it lands on.

Tests: `__tests__/pages/jobSearchPages.test.ts` (10), `__tests__/shell/jobSearchGuide.test.tsx` (9), `legacyAiGates.test.ts` (the red test fixed: the off case sets `off`; new default case: GoApply runs with no mode set and the phone and consent gates still come first; 19).

### 3. [P0] Navigation parity: done

`components/v3/shell/destinations.ts`: `cn.jobs` has `flag: null`; `cn.coaching` and `cn.extension` added exactly as specified (same icon, matcher, gate and mobile slot as RoboApply's entries; a test compares each pair field by field). Comments updated. With the feed switched off the Jobs page itself says so and still offers the user's added jobs (existing `jobs.workspace.feedOff`).

No string was needed: `nav.coaching` (求职辅导) and `nav.extension` (获取插件) already exist in every locale.

Tests: `__tests__/shell/nav.test.tsx`, `noDeadEnds.test.tsx`, `layout.test.tsx`, `routes.test.ts` (the red PAR-1 test: GoApply's sign-in order is `email_password`, `phone_otp`, `wechat`). 308 tests in `__tests__/shell`.

### 4. [P1] Extension on GoApply: done

- `hooks/extension/bridge.ts`: one rule for both brands: the configured store URL, else the listing of the brand's published id on the brand's store, else null. **Precedence:** the item says "the same rule as RoboApply", whose fallback is the Chrome Web Store. ARCHITECTURE §6.8 and `docs/runbooks/edge-addons-publish.md` make Microsoft Edge Add-ons GoApply's primary store (the Chrome Web Store does not open in mainland China), and `NEXT_PUBLIC_CN_EXT_ID` is that listing's id. So GoApply's fallback is `https://microsoftedge.microsoft.com/addons/detail/<id>`. With no id: null, entry and section hidden.
- `components/features/settings/registry.ts`: no change needed. The Devices section already requires the `extension` flag and a published id for both brands (tested in `__tests__/shell/settings.test.tsx`).
- `server/src/features/extension/contract.ts`, `supported.ts`: `EXTENSION_ATS_TYPES_BY_MARKET.cn` is the four portals plus the whole intl list. `hooks/extension/bridge.ts` `EXTENSION_ATS_BY_BRAND.goapply` mirrors it.
- `extension/src/adapters/registry.ts`: the `cn` set is the mainland portals, then every international adapter, then the 网申 fallback last. `extension/src/popup/Popup.tsx` recognises the international form sites in both builds. `extension/src/brands/goapply/index.ts`: `goapplyFillableAtsTypes()`. The manifest follows through `adapterHostPatterns('cn')`; `manifestViolations` stays empty (tested).

**Precedence:** the item's example says a GoApply job on SuccessFactors is offered autofill. SuccessFactors is in `EXTENSION_PER_PAGE_ATS_TYPES` and is held back on RoboApply too (rule R4). GoApply now offers exactly what RoboApply offers: Workday and the single-page forms yes, iCIMS / Taleo / SuccessFactors no. A test compares the two markets case by case.

Tests: `server/src/features/extension/supported.test.ts` (rewritten, plus two cases that read `extension/src` for the GoApply adapter set and manifest), `components/features/extension/extension.test.tsx` (GoApply list, store link, no-id case). `npm run check:extension` passes. `npm --prefix extension run typecheck` passes. The 8 tests in `extension/test/` that pin the old rule are covered by the patch in O8-1 (review finding 2).

### 5. [P0] Job cards and detail on GoApply: done

- `lib/api/feed.ts`: `listingSource`, `listingApply`, `payUndisclosed`, `feedSources`, `feedIsThin`, `safeHttpUrl`. `lib/api/jobs.ts`: `jobListing(detail)`. `lib/api/cnJobs.ts`: `cnFeedSummary(response)`. Every contract field has a safe default: a response from before the contract renders what it rendered before, links that are not http(s) are dropped, and the apply target is never guessed from a link. When the contract field is present, what the server sent is final: `apply: null` and `target: null` are not replaced by a fallback (review finding 6).
- `components/features/market`: `withListing` hands the contract facts to the slot; `JobMetaCn` shows 来源：the original publisher for a board row (the bank for a bank row, licence line only when the server sent one), a link to the original posting, and 最后核验 {date}. New `CnFeedSources` (the header line), `applyCopy.ts` (`cnApplyCopy`), `ExternalSearchPanel` `variant="thin"`. New `marketPayWords` / `marketPayLineText`: the one rule that a GoApply pay line which only says 面议, or a posting the server marks `salary: null`, reads 薪资未披露 wherever pay words are printed (review finding 5).
- `components/features/feed`: `JobCard` passes `apply.url` to the action (the tab opens inside the click) and labels the button by target on GoApply; `FeedList` leaves out a public GoApply row that names no source; `JobsWorkspace` shows the header line from the response's `sources`, the search links under a thin list, and an intro that says "by date posted" when the response says the order is recency. New `useFeedFirstPage` reads the first page from the query cache the list already fills (no second request). `cardModel.payText` drops a 面议 line on GoApply.
- `components/features/job`: `JobDetailPanel` and `JobOverview` do the same on the job page (button label and hint, publisher, original link, last verified). `JobHeader`, `SimilarJobs` and the WeChat share card print pay words through `marketPayWords`.

ACCEPT, tested: no GoApply card without a source; nothing implies the product applies for the user; no GoApply surface prints 面议; RoboApply cards, header, similar jobs and intro are unchanged with the same contract fields present.

Tests: `components/features/feed/cnListing.test.tsx` (21), `components/features/market/cn/__tests__/jobMetaCn.test.tsx` (+11), `components/features/job/job.test.tsx` (+11), fixtures `feedItemCnBoard`, `feedItemCnBank`, `feedResponseCnBoards` in `__tests__/fixtures/feed`.

Contract reading (for PAR-11, see Requests): on the job page I read `apply`, `salary` and the extended `source` from `detail.job`; on a similar-jobs item I read `salary` and `payText`.

### 6. [P1] People tab and company news on GoApply: done

- `JobDetailPanel.tsx`: `peopleTab = (hiring !== 'off' && detail.people.mode !== 'off') || referralCodes` for both brands; the checklist gets `people: peopleTab`; company news follows the `companyNews` flag only.
- `PeoplePanel.tsx`: hiring contact and people-you-know render on both brands, above the 内推码 block. On GoApply the people section renders only when someone is in it (its import prompt names LinkedIn), so there is no empty section. With mode off and no referral codes the panel renders nothing, as on RoboApply. LinkedIn search links stay RoboApply-only (the server sends none for GoApply).
- `TrackerDrawer.tsx` `useFollowUpDraftAllowed`: one rule for both brands (AI text on and the consent given). The server writes drafts in every contacts mode, so the mode was a GoApply-only restriction.
- `server/src/features/network/service.test.ts`: five GoApply cases (the opted-in GoHire recruiter who posted the job, the honesty rules, empty buckets, the modes, market isolation). No server code change was needed.

Tests: `components/features/network/network.test.tsx` (+4), `tracker.test.tsx` (rewritten case), `job.test.tsx` (above), `server/src/features/network` (87).

### 7. [P2] Company-size filter on GoApply: done

`FilterSections.tsx`: `CompanySizeEditor` beside `EmployerTagsEditor` in the cn companies section. `FilterEditors.tsx`: the cn early return removed. Strings already exist in zh. Tests: `FiltersDrawer.test.tsx` (size and employer tags saved in one PATCH; a saved size comes back pressed on both brands). 40 tests.

### 8. [P1] Coaching on GoApply: done

No service change was needed: `coachingAdminAddress` already resolves `CN_COACHING_ADMIN_EMAIL`, else `CN_SUPPORT_EMAIL`, else the GoApply registry reply-to, and both names are brand-own in PAR-1's `brandEnv`, so a RoboApply mailbox can never be returned. The page already follows the flag and the roster, and `/legal/coaching` already resolves for cn. zh copy is already complete (no key missing).

Tests rewritten: `routes.test.ts` (setup has no `FLAG_`, no `CN_EMAIL_TRANSPORT`, no `CN_EMAIL_FROM`; the red PAR-1 test now asserts on-by-default; new off-switch case; the staff copy of a GoApply request goes to a GoApply mailbox), `service.test.ts` (the mailbox order, never across brands), `legal.test.ts` (GoApply publishes its policy). 43 tests.

### 9. [P2] Assistant dictation on GoApply: done

- `VoiceInput.tsx`: `enabled: true`. On GoApply the first use on a device shows a one-line notice: the browser's own speech service processes the audio, which may happen outside mainland China. It is an info toast, because the composer row has no room for a sentence at 375 px and the composer's stylesheet is not PAR-8's.
- `useVoiceInput.ts`: a start that fails with `network` or `service-not-allowed` hides the button for the browser session (memory plus `sessionStorage`), with no error state. A blocked microphone keeps the button and its existing message.

Tests: `hooks/copilot/useVoiceInput.test.ts` (7), `components/features/copilot/VoiceInput.test.tsx` (6).

### PAR-1 handoff, section PAR-8

- Red tests (3): all green (`__tests__/shell/routes.test.ts`, `coaching/routes.test.ts`, `legacyAiGates.test.ts`).
- P8-1: covered by items 3 and 8.

### Carry-over (waveFIX, section PAR-8)

1. Campus apply window in the campus zone: **done** (`JobOverview.tsx`, `CAMPUS_TIME_ZONE`).
2. `connectedOn` in UTC: **done** (`ConnectionsList.tsx`, `PeoplePanel.tsx`; test passes under `TZ=America/Los_Angeles`).
3. Punctuation typed in code: **done** (`jobs.card.leadLabel` = `{label}:`, zh `{label}：`; the labels keep their existing translations, so no locale regresses before the translate pass).
4. `/jobs` header variants: **partly**. The "listed by date" variant is done from the response's `order`. The "no resume yet" variant is not: the page has no resume state without a new request, and the hook that would carry it is unowned.
5. Saved-search limit message: **already right in the code**. `SavedSearchSwitcher.tsx` shows the bundle's `filters.saved.limitReached`, not the server sentence. A plural with `max` needs unowned item 13 (the server must send `max` in the error details).
6. Typeahead labels from the bundle: **not done**. It depends on the `taxonomy.roles.*` translations, which are not merged.
7. Tracker toolbar `withTimeZone`: **not done**. `trackerExportCsvUrl(timeZone)` does not exist yet (`lib/api/tracker.ts` is unowned).
8. Floating Ask button: not PAR-8's file.

## Files changed

82 modified and 11 new, all inside PAR-8's owns (checked by script against `parity-bundles.json`; two of the new files are tests colocated with an owned file). Changed in the review pass: `server/src/job-search/{agent,quota,routes,openapi}.ts` and their tests, `lib/api/{feed,jobs,job-search}.ts`, `components/job-search/{ApiKeyWorkspace,JobSearchDeveloperGuide}.tsx`, `components/features/market/{MarketJobMeta.tsx,index.ts}`, `market/cn/{meta,index}.ts`, `components/features/feed/cardModel.ts`, `components/features/job/{JobHeader,SimilarJobs,JobDetailPanel}.tsx`, the tests beside them, and the four staging files of `jobs` and `jobsCn`.

- Job search: `server/src/job-search/{routes,service,agent,keys,quota,openapi,types,validation}.ts`, new `index-provider.ts`, tests `routes.test.ts`, `agent.test.ts`, `keys.test.ts`, `quota.test.ts`, new `index-provider.test.ts`; `server/src/app.ts`; `server/src/roboapply/v2/routes/discover.ts`, `legacyAiGates.test.ts`
- Job-search web: `components/job-search/{ApiKeyWorkspace,JobSearchDeveloperGuide}.tsx`, `countries.ts`, `metadata.ts`; `app/(auth)/job-search/developers/page.tsx`; `app/developers/job-search/page.tsx`; `lib/api/job-search.ts`; `lib/proxyPaths.ts`; `__tests__/pages/jobSearchPages.test.ts`; new `__tests__/shell/jobSearchGuide.test.tsx`
- Navigation: `components/v3/shell/destinations.ts`; `__tests__/shell/{nav,noDeadEnds,layout}.test.tsx`, `routes.test.ts`
- Extension: `hooks/extension/bridge.ts`; `server/src/features/extension/{contract,supported}.ts`, `supported.test.ts`; `components/features/extension/extension.test.tsx`; `extension/src/adapters/registry.ts`, `adapters/cn/index.ts`, `brands/goapply/index.ts`, `brands/types.ts`, `popup/Popup.tsx`
- Cards and detail: `lib/api/{feed,jobs,cnJobs}.ts`; `components/features/feed/{JobCard,FeedList,JobsWorkspace}.tsx`, `cardModel.ts`, new `useFeedFirstPage.ts`, new `cnListing.test.tsx`, `jobCard.int.test.tsx`; `components/features/market/{index.ts,MarketJobMeta.tsx}`, `market/cn/{JobMetaCn,ExternalSearchPanel}.tsx`, `meta.ts`, `index.ts`, `cnJobs.module.css`, new `CnFeedSources.tsx`, new `applyCopy.ts`, `__tests__/jobMetaCn.test.tsx`; `components/features/job/{JobDetailPanel,JobHeader,JobOverview,GetReadyChecklist,SimilarJobs,PeopleTab}.tsx`, `job.test.tsx`; `__tests__/fixtures/feed/index.ts`
- People, tracker: `components/features/network/{PeoplePanel,ConnectionsList}.tsx`, `network.test.tsx`; `components/features/tracker/TrackerDrawer.tsx`, `tracker.test.tsx`; `server/src/features/network/index.ts` (comment), `service.test.ts`
- Filters: `components/features/filters/{FilterSections,FilterEditors}.tsx`, `FiltersDrawer.test.tsx`
- Coaching: `server/src/features/coaching/{routes,service,legal}.test.ts`
- Dictation: `components/features/copilot/VoiceInput.tsx`, new `VoiceInput.test.tsx`; `hooks/copilot/useVoiceInput.ts`, new `useVoiceInput.test.ts`
- i18n staging: `jobs.en.json`, new `jobs.zh.json`, `jobsCn.en.json`, `jobsCn.zh.json`, `assistant.en.json`, new `assistant.zh.json`

## Tests run

All after the review changes.

| Command | Result |
|---|---|
| `npx vitest run server/src/job-search` | 10 files, 180 / 180 |
| `npx vitest run __tests__/shell` | 9 files, 308 / 308 |
| `npx vitest run components/features/feed components/features/job components/features/market server/src/roboapply/v2/routes/legacyAiGates.test.ts` | 17 files, 357 / 357 |
| Every test file under PAR-8's owned paths (57 files, one run; the root config excludes `extension/**`) | 1,555 / 1,555 |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 (design, copy, LLM costs, API boundary, extension no-submit, zh variants) |
| `npx vitest run --exclude ".claude/**"` | 627 files, 12,955 tests: 12,849 passed, 95 failed in 40 files, 1 skipped, 10 todo. None of the failures is in PAR-8's owns (attributed by script: PAR-11 47, PAR-2 17, PAR-4 11, PAR-3 8, PAR-5 6, PAR-7 5, PAR-9 1) |
| `npm --prefix extension run typecheck` | exit 0 |
| `npm --prefix extension test` | 709 tests: 701 passed, 8 failed in `extension/test/` (unowned; O8-1) |
| The same suite with the O8-1 patch content loaded for the four files (scratch config, no file edited) | 36 files, 709 / 709 |
| `git apply --check` of the O8-1 patch on the worktree | applies cleanly |

## Red tests for other bundles

Turned red by this bundle (11 in all). The review pass turned no further test red.

**PAR-11** (3)
- `server/src/features/cn/jobs/__tests__/modeOff.routes.test.ts` "legacy job-search API on GoApply" (2). "mode off": `MODE_OFF` is `{}` in that file; it must be `{ CN_RECRUITMENT_INFO_MODE: 'off' }` (PAR-11 item 1 already sets it), and the case then passes unchanged. "postings allowed": the routers are now served on GoApply, so assert that the routes answer (200 for `/openapi.json`, `/providers`, `/search`, `/agent/search`, `/keys`) and that the key, session, search and planner doubles were called, instead of 404 everywhere. Two facts for whoever rewrites it: `GET /keys` now also calls the service double's `providers('api', brand)` and returns it as `sources`, and the quota double's `reserve` gets the brand as a fourth argument.
- `server/src/features/jobs/detail/detail.test.ts` "Fill this form only where the brand's extension runs on the application page" (1): the last line, `supported(cn, { atsType: 'greenhouse', … })`, is now `true` (GoApply's portal list is a superset).

**Orchestrator: `extension/test/` (no owner)** (8): `test/detect.test.ts` (1), `test/manifest.test.ts` (1), `test/cn/manifest.test.ts` (5), `test/intl/registry.test.ts` (1). The patch in O8-1 rewrites exactly these and nothing else.

## Pre-existing failures

92 of the 95 full-suite failures were red at the base and are in other bundles' files: PAR-11 44, PAR-2 17, PAR-4 11, PAR-3 8, PAR-5 6, PAR-7 5, PAR-9 1 (the same files and causes PAR-1's handoff lists). The 12 older failures PAR-1 listed as pre-existing (`practice.test.tsx`, `settings.test.tsx`, `onboarding/goapply.test.tsx`, `auth-cn/routes.test.ts`) did not fail in this worktree.

## Requests

### PAR-11
- **R11-1 (contract).** The job-search `index` provider and the cards read `item.apply.url`, `item.apply.target`, `item.source.{original,url,lastVerifiedAt,via}`, `item.salary`, and the feed response's `sources: { gohire, employerBoards }` and `thin`. On the job page I read `apply`, `salary` and the extended `source` from `detail.job`; on a similar-jobs item I read `salary`. If PAR-11 puts them elsewhere on the detail response, say so: the readers are `jobListing` in `lib/api/jobs.ts` and `payUndisclosed` in `lib/api/feed.ts`.
- **R11-2.** `feedService.preview` must return `apply.url` for market cn rows, or a GoApply search stays empty.
- **R11-3.** The three red tests above.
- **R11-4 (optional).** A search result has no posting text for index rows (`description: ''`, stated in the OpenAPI document), because the feed card carries none. If the feed item ever carries a plain-text excerpt, `indexRow` in `index-provider.ts` is the one place to map it.

### Orchestrator
- **O8-1 (blocks CI).** Apply this patch to `extension/test/` at the merge (or grant PAR-8 the directory and I apply it). It keeps every `manifestViolations` and forbidden-host assertion and changes only the four assertions that pinned "the GoApply build has no international adapters".

~~~diff
--- a/extension/test/cn/manifest.test.ts
+++ b/extension/test/cn/manifest.test.ts
@@ -1,5 +1,7 @@
-// GoApply build (WP-71): manifest host permissions follow the portal adapters,
-// no job boards, no broad hosts; detection; distribution values.
+// GoApply build (WP-71; parity wave PAR-8): manifest host permissions follow
+// the adapter set (the mainland portals first, then the international form
+// sites RoboApply fills, D5), no job boards, no broad hosts; detection;
+// distribution values.
 
 import { readFileSync } from 'node:fs';
 import { resolve } from 'node:path';
@@ -14,22 +16,18 @@
 
 describe('GoApply manifest', () => {
   for (const target of ['edge', 'chrome'] as const) {
-    it(`${target}: brand origin + the four portal hosts; content scripts only there; policy clean`, () => {
+    it(`${target}: brand origin + the portal hosts, then the international form hosts; content scripts only there; policy clean`, () => {
       const m = buildManifest({ brand: 'goapply', target, dev: false, version: '1.0.0' }) as {
         permissions: string[];
         host_permissions: string[];
         content_scripts: Array<{ matches: string[] }>;
       };
       expect(m.permissions).toEqual(['activeTab', 'scripting', 'storage']);
-      expect(m.host_permissions).toEqual([
-        'https://www.goapply.top/*',
-        'https://*.mokahr.com/*',
-        'https://*.zhiye.com/*',
-        'https://*.beisen.com/*',
-        'https://*.jobs.feishu.cn/*',
-        'https://*.dayee.com/*',
-        'https://*.hotjob.cn/*',
-      ]);
+      const portalHosts = ['https://*.mokahr.com/*', 'https://*.zhiye.com/*', 'https://*.beisen.com/*', 'https://*.jobs.feishu.cn/*', 'https://*.dayee.com/*', 'https://*.hotjob.cn/*'];
+      expect(m.host_permissions).toEqual(['https://www.goapply.top/*', ...adapterHostPatterns('cn')]);
+      // The mainland portals come first, then every host the RoboApply build has.
+      expect(m.host_permissions.slice(1, 1 + portalHosts.length)).toEqual(portalHosts);
+      expect(m.host_permissions).toEqual(expect.arrayContaining(adapterHostPatterns('intl')));
       expect(m.content_scripts[0].matches).toEqual(adapterHostPatterns('cn'));
       expect(manifestViolations(m)).toEqual([]);
       expect(JSON.stringify(m)).not.toMatch(/zhipin|liepin|51job|lagou|zhaopin|linkedin|indeed|<all_urls>|"\*:\/\/\*\/\*"/);
@@ -75,7 +73,8 @@
       };
       expect(manifestViolations(m)).toEqual([]);
       const portalHosts = CN_PORTAL_ADAPTERS.filter((a) => goapplyPortalIds().includes(a.id)).flatMap((a) => a.hostPatterns);
-      expect(m.host_permissions.slice(1)).toEqual(portalHosts);
+      expect(m.host_permissions.slice(1)).toEqual(adapterHostPatterns('cn'));
+      expect(m.host_permissions.slice(1, 1 + portalHosts.length)).toEqual(portalHosts);
       // The store strings are message placeholders the build fills from `_locales`.
       expect([m.name, m.description, m.action.default_title].every((v) => v.startsWith('__MSG_'))).toBe(true);
     });
--- a/extension/test/detect.test.ts
+++ b/extension/test/detect.test.ts
@@ -30,9 +30,9 @@
     expect(detectAdapter(local, doc, { set: 'intl', dev: true })?.id).toBe('ashby');
   });
 
-  it('the GoApply build ships no international adapters', () => {
+  it('the GoApply build fills the international form sites too (its adapter set is a superset of RoboApply\'s, D5)', () => {
     const doc = loadFixture('greenhouse', 'classic');
-    expect(detectAdapter(new URL('https://boards.greenhouse.io/x/jobs/1'), doc, { set: 'cn', dev: false })).toBeNull();
+    expect(detectAdapter(new URL('https://boards.greenhouse.io/x/jobs/1'), doc, { set: 'cn', dev: false })?.id).toBe('greenhouse');
   });
 });
 
--- a/extension/test/intl/registry.test.ts
+++ b/extension/test/intl/registry.test.ts
@@ -88,9 +88,12 @@
     expect(manifestViolations(m)).toEqual([]);
   });
 
-  it('GoApply builds do not get the international form hosts', () => {
+  it('GoApply builds get the international form hosts too (D5); RoboApply gets no mainland portal host', () => {
     const cn = buildManifest({ brand: 'goapply', target: 'edge', dev: false, version: '1.0.0' }) as { host_permissions: string[] };
-    expect(cn.host_permissions.join(' ')).not.toMatch(/workday|smartrecruiters|icims|workable|taleo|successfactors|jobvite|bamboohr/);
+    expect(cn.host_permissions).toEqual(expect.arrayContaining(adapterHostPatterns('intl')));
+    expect(manifestViolations(cn)).toEqual([]);
+    const intl = buildManifest({ brand: 'roboapply', target: 'chrome', dev: false, version: '1.0.0' }) as { host_permissions: string[] };
+    expect(intl.host_permissions.join(' ')).not.toMatch(/mokahr|zhiye|beisen|feishu|dayee|hotjob/);
   });
 
   it('a supported site is recognised from the URL alone, before its form is open', () => {
--- a/extension/test/manifest.test.ts
+++ b/extension/test/manifest.test.ts
@@ -40,10 +40,10 @@
     expect(m.background.service_worker).toBe('sw.js');
   });
 
-  it('GoApply: its own origin; no international form hosts until WP-71 ships portal adapters', () => {
+  it('GoApply: its own origin, the mainland portal hosts, then the international form hosts (D5: the same forms as RoboApply)', () => {
     const m = buildManifest({ brand: 'goapply', target: 'edge', dev: false, version: '1.0.0' }) as { host_permissions: string[]; content_scripts: unknown[]; externally_connectable: { matches: string[] } };
     expect(m.host_permissions).toEqual(['https://www.goapply.top/*', ...adapterHostPatterns('cn')]);
-    expect(m.host_permissions.join(' ')).not.toMatch(/greenhouse|lever|ashby/);
+    expect(m.host_permissions).toEqual(expect.arrayContaining(adapterHostPatterns('intl')));
     expect(m.externally_connectable.matches).toEqual(['https://goapply.top/*', 'https://www.goapply.top/*']);
   });
 
~~~

- **O8-2.** `__tests__/lib/i18nStaging.test.ts` (unowned) compares a staged string with `loadMessages('en')`, which has `%BRAND%` already replaced. Any staged string that contains `%BRAND%` therefore fails it. I worded the new strings without the token ("this site", "collected here"). The test should compare against the substituted value, or every bundle that follows the "use %BRAND%" rule turns it red.
- **O8-3.** `scripts/i18n-merge-staging.mjs` refuses a literal RoboHire / GoHire outside `legal.*`, `jobsCn.source*`, `people.source*`. The GoApply strings that name the recruiter bank therefore take `{sourceName}` (`jobsCn.header.gohireAndBoards`, `jobsCn.header.gohire`, `jobsCn.searchApi.sources`), and the code passes GoApply's bank name (`CN_RECRUITER_BANK_NAME`).
- **O8-4.** `hooks/feed/useFeed.ts` (unowned) does not expose the response's `sources`, `thin` and `order`. I read them from the query cache in `components/features/feed/useFeedFirstPage.ts`. If someone owns the hook later, expose the three fields on `FeedListState` and delete that file.
- **O8-5.** i18n pass: translate the keys below. `jobsCn.dates.lastChecked` is no longer used by `JobMetaCn` (it uses `jobsCn.dates.lastVerified`); remove it after the merge if nothing else reads it.

### PAR-10
- Document the variables in the table below, that the GoApply extension id is its Microsoft Edge Add-ons id, and that `JOB_SEARCH_GLOBAL_DAILY_LIMIT` is a budget per brand.

### PAR-7
- Carry-over 7: `trackerExportCsvUrl(timeZone)` in `lib/api/tracker.ts`, then PAR-8's tracker toolbar can drop its local `withTimeZone`.

### Owner
- **Integration keys on GoApply (review finding 4).** Decide whether GoApply keys may read the index by default. As built, the operator grants it by adding `index` to `CN_JOB_SEARCH_API_PROVIDERS` (or `JOB_SEARCH_API_PROVIDERS`), the same rule as RoboApply's sources, and the key page, the developer page and the OpenAPI document say that key access is the operator's decision. To make it the default instead: in `server/src/job-search/service.ts` `apiGrants`, use `brandOwnEnv(brand, 'JOB_SEARCH_API_PROVIDERS', env()) ?? 'index'` for market cn, then drop the "site operator decides" sentence from `jobsCn.searchApi.sources` and the OpenAPI description. The question behind the default is whether employer-board and recruiter-bank rows may be republished by third parties through a key.
- **Search budgets (review finding 3).** Each brand now has its own deployment budget of `JOB_SEARCH_GLOBAL_DAILY_LIMIT` (default 250 a day). GoApply searches cost no provider call, so its budget can be set higher with `CN_JOB_SEARCH_GLOBAL_DAILY_LIMIT` without touching RoboApply's.
- **GoApply extension listing.** The GoApply build now asks for host permissions on the international form hosts too (Greenhouse, Lever, Ashby, Workday, SmartRecruiters and the others RoboApply's build has). The Edge Add-ons listing and its permission justification must name them before the next submission.
- **Dictation notice.** GoApply shows the browser-vendor notice once per device and does not ask for a separate consent. If counsel wants a consent record for speech sent to the browser vendor, it is a new consent type (PAR-5's catalog).

## Schema requests

None. The per-brand quota count uses the existing `ApiUsageRecord.user` relation and `User.brand`.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `JOB_SEARCH_API_PROVIDERS` | redefined for GoApply: read as `CN_JOB_SEARCH_API_PROVIDERS ?? JOB_SEARCH_API_PROVIDERS`. The id `index` grants GoApply's own index to integration keys | empty (no source is granted to keys on either brand) |
| `JOB_SEARCH_DISABLED` | redefined for GoApply: read as `CN_JOB_SEARCH_DISABLED ?? JOB_SEARCH_DISABLED`; `true` disables the brand's job-search sources | off |
| `JOB_SEARCH_GLOBAL_DAILY_LIMIT` | redefined: the daily reservation budget of ONE brand's accounts (it was one sum for the deployment). GoApply reads `CN_JOB_SEARCH_GLOBAL_DAILY_LIMIT ?? JOB_SEARCH_GLOBAL_DAILY_LIMIT` | 250 per brand |
| `JOB_SEARCH_USER_DAILY_LIMIT`, `JOB_SEARCH_USER_PER_MINUTE` | unchanged in meaning (per user); GoApply reads the `CN_` twin when it is set | 100 a day, 10 a minute |
| `FLAG_GOAPPLY_AI_TEXT=false`, `FLAG_ROBOAPPLY_AI_TEXT=false` | existing switches, now also honoured by the job-search planner: `POST agent/search` answers `503 ai_unavailable` and no model is called | on |
| `JOB_SEARCH_PROVIDERS`, `RA_ONBOARDING_EXTERNAL_JOBS_DISABLED`, `RA_ONBOARDING_*_DISABLED`, `RAPID_API_KEY` | unchanged, and RoboApply only: never read for GoApply, whose one source is its own index | unchanged |
| `CN_RECRUITMENT_INFO_MODE=off` | also closes both job-search routers on GoApply (through the `jobs.feed` capability) | `licensed` |
| `NEXT_PUBLIC_CN_EXT_STORE_URL` | now optional: when unset the install link is the Microsoft Edge Add-ons listing of `NEXT_PUBLIC_CN_EXT_ID` | unset |
| `NEXT_PUBLIC_CN_EXT_ID` | unchanged: with no id the GoApply extension entry, page install link and Devices section stay hidden | unset |
| `RA_V2_DISCOVER_DISABLED` | unchanged: an operator switch for `POST /v2/discover/run` on both brands; nothing sets it by default | off |
| `FLAG_GOAPPLY_COACHING=false`, `FLAG_GOAPPLY_EXTENSION=false` | off switches for the two new GoApply nav entries and their pages | on |

No new variable name except the `CN_` twins that PAR-1's per-key rule already defines.

## i18n keys added or changed

All staged; no `i18n/messages` file was touched. English in `<ns>.en.json`, Chinese in `<ns>.zh.json`.

- `jobs.card.leadLabel` (new; en `{label}:`, zh `{label}：`; ja and zh-TW need the full-width colon)
- `jobs.workspace.introByDate` (new)
- `jobs.searchApi.keySourcesOff` (new in the review pass; shown on the key page of either brand when no source is open to keys)
- `jobsCn.searchApi.exampleNote` (args `{origin}`, `{key}`), `.agentIntro` (reworded in the review pass: also names the verified phone for a WeChat account), `.sources` (reworded in the review pass: takes `{sourceName}`, names the recruiter bank, says key access is the site operator's decision), `.keyScope` (new)
- `jobsCn.source.original` (new: 查看原帖)
- `jobsCn.dates.lastVerified` (new: 最后核验 {date}; replaces the use of `jobsCn.dates.lastChecked`)
- `jobsCn.apply.employer`, `.employerHint`, `.bank`, `.bankHint` (new; the bank keys take `{name}`)
- `jobsCn.header.boards` (plural `{count}`), `.gohireAndBoards` (`{sourceName}`, plural `{count}`), `.gohire` (`{sourceName}`), `.coverage` (new)
- `jobsCn.external.panel.thinIntro` (new)
- `assistant.voice.vendorNotice` (new)

Until the translate pass, a GoApply user reading Chinese sees these lines in English (the runtime merges staged English only). `jobs.zh.json` and `assistant.zh.json` are new files.

## Known gaps

- **GoApply search is empty until PAR-11's `apply.url` lands**, and has no posting text in its results after that (R11-4).
- **Integration keys get no GoApply results until the operator grants `index`** (Owner). The pages and the OpenAPI document now say so.
- **The planner gate adds lookups before the model call.** On GoApply: the phone-binding lookup, the consent lookup and the per-user flag overrides. On RoboApply: the per-user flag overrides only (a failed override lookup falls back to the brand default, as everywhere else).
- **The quota advisory lock is still one lock for both brands.** The counts are per brand; the lock only serialises the short reservation transaction, so it does not let one brand rate-limit the other.
- **Not verified in a browser** (the bundle rules forbid it): both brands, light and dark, 375 px and 1280 px. The pieces to look at: the GoApply jobs header line and thin-result panel, the source line with its "Original posting" link on the card and the job page, the apply button labels, the People tab order on GoApply, the company-size filter in the GoApply drawer, the two new GoApply nav entries, the dictation toast, `/developers/job-search` on GoApply, and the new notice on the key page when no source is open to keys.
- **`/jobs` intro for "no resume yet"** is not done (carry-over 4).
- **The `rajs_` key prefix** is the same on both brands. It is an opaque prefix, not a product name on screen, so I left the stored format alone.

Handoff file: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-par/PAR-8.md`
