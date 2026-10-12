# PAR-9

Public surfaces of the D5 parity wave. Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-PAR-9`, branch `wp/PAR-9`, base `3fa104e` (PAR-1 merged). Nothing committed, pushed or stashed. No schema change, no new dependency, no env variable added. No dev server, browser or `next build` was run (the bundle rules forbid them), so nothing here was seen in a browser.

All eight items are done and all six review findings are resolved (see "Review resolution" at the end; two sub-points of the proposed fixes were done differently, with the reason). Every test in a file PAR-9 owns is green (33 files, 659 tests). Both typechecks pass for the whole repository and `npm run check` passes. The full suite has 98 failures, the same 98 as before the review pass: 94 are the PAR-1 red tests in other bundles' files, 4 are turned red by this bundle in files it does not own (listed below with what each should now assert).

Two places where the plan documents won over the item text (details under the item):
- Item 6: `/features/ready-to-apply` on GoApply answers 200 but is not in the sitemap, because it is a gated page (`agent`) and `waveFIX-carryover.md` fixes the rule "a feature page's noindex and the static sitemap read one rule, `isFeatureIndexable`". The three ungated pages are in the sitemap. This is exactly how RoboApply's `/features/ready-to-apply` behaves.
- Item 7: GoApply's refund copy follows MARKET_STRATEGY §4.4 ("Printed on /pricing: the same") instead of only removing the old wording.

## Items

### 1. [P0] Public job pages, browse pages, ticker and sitemaps on GoApply: done

- `server/src/features/seo/routes.ts`: the `intlOnly` middleware is deleted. `/page`, `/hub` and `/jobs/:id` carry `requireCnRecruitmentInfo` (GoApply with `CN_RECRUITMENT_INFO_MODE=off` → 404 `feature_disabled`); `/page` and `/hub` keep `requireFlag('seo.browse')`. The per-IP limit now covers GoApply reads of `/ticker`, `/sitemap` and `/sitemap/:part` too.
- `server/src/features/seo/service.ts`: the four `market === 'cn'` early returns are gone. One rule replaces them, `publicListingsOpen(brand, env)` (exported, also from `seo/index.ts`): always true for RoboApply; for GoApply false only with the mode literally `off`. With it off: hub and ticker are empty, the sitemap has no parts, a part and a page are 404.
- `server/src/features/seo/cron.ts`: the rebuild runs for GoApply (stores `locale: 'zh'` rows, revalidates `goapply.top`, pushes newly indexable URLs to Baidu when `CN_BAIDU_PUSH_TOKEN` is set). Skips: `disabled` (seo.browse off, either brand), `postings_off` (GoApply mode off).
- **Mainland display lines (review finding 1).** `RAJob.lastSeenAt` is now selected (`repo.ts` `CARD_SELECT`, `SeoJobRow.lastSeenAt`) and sent as **`lastVerifiedAt`** (ISO string or null) on every `PublicJobCard` and so on `PublicJobDetail` (the name PAR-11's contract uses for the same fact). `PublicJobDetail` gained **`licence: { holder, number } | null`**: `service.job()` fills it through `cnLicenceFor(row, env)`, which asks `buildCnCardMeta` (the rule of the signed-in card: a GoHire bank posting, both `CN_HR_LICENCE_HOLDER` and `CN_HR_LICENCE_NUMBER` set). It is null for every other source, on RoboApply, and with half a licence. On GoApply the public job page prints, under the source name and the original link, "Last checked {date}" and the licence line; the browse card prints "Last checked {date}" under its source. Both are read with a null default, so an older API response prints neither. RoboApply's page and cards are unchanged.
- **Visa-sponsorship pages stay RoboApply's (review finding 6, plan §3.12).** One rule, `pageTypeOpen(type, market)` in `seo/paths.ts`: `sponsorship_role` is closed on market `cn`. The rebuild asks it (no sponsorship candidates, a stored row is not refreshed), `service.page()` answers 404 `not_found`, and the hub and the roles sitemap skip such rows.
- **WeChat share card (review finding 5).** The public job page shares its own canonical public path (`job.canonicalPath`), not the signed-in `/jobs/<id>`.
- Web: cn guards removed in `app/job/[idSlug]/page.tsx`, `app/browse/page.tsx`, `app/browse/[...path]/page.tsx`, `lib/server/publicApi.ts` (`publicJobHtmlStatus`), `lib/seo.ts` (`/browse` is listed for either brand when `surfaces.browse` is true).
- `server/src/features/visitor/digest.ts` `digestJobHref` and `components/features/visitor/model.ts` `visitorJobHref`: the public job path on both brands. `visitorJobHref(job)` lost its `market` and `from` parameters. A feed item whose `path` is null (PAR-11 changes `publicPathFor`) opens `/job/<id>`, which 301s to the canonical path, so it works before and after PAR-11 merges.
- `lib/seo.ts` `llmsTxt` (GoApply): adds the free-tools link and the same "job pages are not open to AI crawlers" note RoboApply's has.
- Gates unchanged: `seo.browse` (registry default false on both brands), `PUBLIC_DISPLAY_PROVIDERS`, `isPubliclyListable`.

ACCEPT, tested: a listable cn posting has a public page (`/job/<id>` for a Chinese title) and is in the cn ticker and sitemap; a cn row of a provider outside `PUBLIC_DISPLAY_PROVIDERS` is on no route and appears once the provider is listed; with `seo.browse` off `/page` and `/hub` are 404 on both brands while job pages still answer; the two brands never read each other's market. RoboApply snapshots (robots, sitemap index, static sitemap, llms.txt) are unchanged.

Tests: `seo/routes.test.ts` (GoApply section: 10 cases, among them the licence matrix, the last-checked date on page and card, sponsorship pages 404 / not in hub / not in roles sitemap on GoApply and live on RoboApply), `seo/seo.test.ts`, `seo/cron.test.ts` (GoApply builds no sponsorship page and does not refresh a stored one), `visitor/digest.test.ts`, `components/features/seo/__tests__/components.test.tsx` (new describe "GoApply display lines": page source block, licence line, missing fields, RoboApply unchanged, browse card; share-card path), `lib.test.ts`, `routes.test.tsx`, `publicApi.test.ts`, `components/features/visitor/__tests__/visitor.test.tsx`.

### 2. [P0] Free tools open on GoApply: done

- `server/src/features/tools/service.ts`: `toolsOpen` returns true for both brands; the three `feature_disabled` throws are gone. New exported `processedOutsideMainland(brand, env)` = GoApply AND (offshore deployment OR `brandUsesSharedStack`). `/config` returns it.
- `server/src/features/tools/parse.ts`: `ParseInput.consented`; `anonymousAiAllowed(brand, consented)` is true for GoApply only when the run carried the ticked notice.
- `server/src/features/tools/contract.ts`: **`TOOLS_CONSENT_VERSION` is `tools-processing.2026-10-11.v3`** because the notice text changed (it names the AI read, and the outside-the-mainland line no longer says "beta" or "United States"). The client mirror follows; a test keeps them equal. A run sent with the v2 version answers `consent_required`.
- **The two sentences whose meaning changed have new keys (review finding 2):** `tools.consent.labelAi` and `tools.consent.outsideMainland` (`fields.tsx`). The old keys `tools.consent.label` and `tools.consent.offshore` are no longer read, so a locale that still holds the old sentence (zh.json: no AI read; "测试期间…地点为美国") can never print it under v3. Until a locale has the new keys it shows the new English text.
- Web: `app/tools/meta.ts` `freeToolsOpen` returns true; `app/tools/page.tsx`, `app/tools/[tool]/page.tsx` no longer 404 on GoApply; `useFreeToolsLinked` returns true without asking the API; `ToolsHub` lists both tools by default.
- Carry-over FIX-4 (done): `server/src/features/tools/checks.ts` passes `keywordCasing: 'posting'`. The cache key version went from `v3` to `v4`.

ACCEPT, tested: both tool pages answer on GoApply for any `DEPLOY_REGION`; `GET /public/tools/config` returns `available: true` with no `CN_` value; a run without the tick is 422 `consent_required` and uses no allowance; with it the parser is told `consented: true` and runs the AI parse when `ai.text` is on; the tools are in the GoApply static sitemap.

Tests: `tools/service.test.ts`, `parse.test.ts`, `routes.test.ts`, `defaultService.test.ts`, `components/features/tools/__tests__/tools.test.tsx` (new: GoApply in Chinese never shows the old sentences), `pages.test.tsx`, the tools cases of `components/features/seo/__tests__/lib.test.ts` and `routes.test.tsx`.

### 3. [P1] Signed-out job alerts on GoApply: done

- The SEO sitemap index gained **`surfaces.alerts`** = the brand's `jobs.alerts` capability, and `lib/seo.ts` gained `alertsSurfaceOn(surfaces)`: only an explicit `false` is off.
- `app/tools/job-alerts/page.tsx`: indexed when `alertsSurfaceOn`. `lib/seo.ts` `toolSitemapPaths({ toolsOpen, toolPaths, alerts })` lists `/tools/job-alerts` on the same rule.
- `ToolsHub` and `VisitorFeed` already showed the card and the link on `jobs.alerts` + `notify.email` with no market condition; tests now pin that for GoApply.

ACCEPT, tested at the route: on GoApply with only `RESEND_API_KEY` (no `CN_` value) `POST /public/alerts` answers **202** `pending_confirmation` (the item says 201; the route has always answered 202). Off switches each tested: `CN_RECRUITMENT_INFO_MODE=off`, `FLAG_GOAPPLY_JOBS_ALERTS=false`, `CN_EMAIL_TRANSPORT=none`, no email credentials. **The mail itself leaves only after PAR-3's transport fallback merges**; the route test uses the injected sender.

Tests: `visitor/routes.test.ts`, `components/features/visitor/__tests__/pages.test.tsx`, `visitor.test.tsx`, `tools.test.tsx`, `seo/routes.test.ts`.

### 4. [P1] Visitor assistant on both brands when its flag is on: done

- `server/src/features/visitor/contract.ts`: `VISITOR_CONSENT_VERSION = 'visitor-assistant.2026-10-11.v1'`; `VisitorTurnBodySchema` is the visitor area's own schema (the Assistant's turn plus optional `consent`, strict). `VISITOR_ERROR_CODES.visitorNoConsent` is replaced by `consentRequired`.
- `server/src/features/visitor/routes.ts`: `requireVisitorConsent`: GoApply without the current version → 422 `invalid_request`, `details.reason: 'consent_required'`, before the limiter and before any model.
- Widget (`VisitorAssistant.tsx`): on GoApply a consent line with an unticked box and a privacy link; chips, input and Send are disabled until it is ticked; every turn carries the version. RoboApply shows no box and sends no field.
- The `market === 'intl'` render conditions are removed in `VisitorFeed.tsx` and `JobPage.tsx`. Registry default stays false on both brands.

Tests: `visitor/routes.test.ts` (GoApply describe, 6 cases), `components/features/visitor/__tests__/visitor.test.tsx`, `components/features/seo/__tests__/components.test.tsx`.

### 5. [P1] GoApply home offers the same visitor functions: done

- `GoApplyHome.tsx`: hero → pillars → `FeatureGrid` → `IndexCounters` → the server ticker slot → `QuickSearch` → campus preview → AI practice → `PricingSummary` → FAQ → final CTA. It takes a `ticker` prop like `RoboApplyHome`.
- **Listed jobs follow `jobs.feed` (review finding 3).** With the operator's `CN_RECRUITMENT_INFO_MODE=off` (which turns `jobs.feed` off) the home shows no counters, no ticker, no quick search, no "Where do the jobs come from?" question and no job-matches card or footer link. Two hooks, one per kind of content: the counters are a number, so they show only once `jobs.feed` is known to be on (`useMarketingFlag`); the ticker, the search form, the question and the card are part of the page the server sends and are removed once the capability is known to be off (new `useMarketingFlagOff` in `hooks.ts`). The route's FAQ JSON-LD (`app/page.tsx`, `app/[locale]/page.tsx`) lists only the five questions that hold in every mode (`cnHomeFaqKeys(false)` in `catalog.ts`), so structured data never says more than the page.
- `Sections.tsx`: `FeatureGrid` (shared); `QuickSearch` takes `examples` and hides the country picker when the brand has one country; `PricingSummary` takes `ns`, `id` and `note`.
- `app/page.tsx`, `app/[locale]/page.tsx`: both homes get `<Suspense><JobTicker /></Suspense>`.
- A line about answering out loud shows while `ai.interviewVoice` is on. The interview pillar follows `ai.text`.
- D3: counters use the existing rule (real count, hidden under 1,000); the ticker renders nothing without public jobs; an empty campus preview says the calendar is being put together.
- Carry-over FIX-1 (done): the campus preview formats dates in `Asia/Shanghai`.
- Carry-over FIX-8 (done): the marketing footer has no "cancel a subscription" entry on GoApply (`brandPlansRenew`). `/security` says "we email you" unless email is **known** to be off (review finding 4: the sentence is back in the server HTML on both brands); the pricing "instant alert emails" row needs `jobs.alerts` and `notify.email`.
- Carry-over FIX-7 (done): `/help/ranking` on GoApply names the fourth sort with the sort menu's own label.

Tests: `components/features/marketing/__tests__/home.test.tsx` (GoApply describe, 18 cases; new: `jobs.feed` off, and the page before the capabilities are known), `routes.test.tsx` (FAQ JSON-LD: five questions on `/` and `/en`, never the jobs question), `__tests__/pages/localized-landing.test.ts`.

### 6. [P1] Feature pages for every shared capability on GoApply: done, with one deviation

- `catalog.ts`: GoApply gains `job-matches`, `resume-tailoring`, `cover-letters` (ungated), `ready-to-apply` (gate `agent`) and `referral-codes` (内推码, gate `cn.referralCodes`). `visa-sponsorship` stays RoboApply-only.
- **New optional `FeatureDef.needs`** (review finding 3): a default-on capability the page is about. GoApply's `job-matches` has `needs: 'jobs.feed'`. The page stays ungated (body in the server HTML, indexable, in the sitemap); once `jobs.feed` is known to be off its card and footer link disappear (`useFeatureVisible`) and the page says "not available" (`FeaturePage`). RoboApply's entries have no `needs` and behave as before.
- Copy: `landing.features.goapply.{jobMatches,resumeTailoring,coverLetters,readyToApply,referralCodes}` in English and Chinese (18 strings each).
- **Deviation (documents win):** `ready-to-apply` is gated, so by the FIX-gate rule it is noindex and unlisted, as on RoboApply. In the GoApply sitemap: `/features/job-matches`, `/features/resume-tailoring`, `/features/cover-letters`, `/features/resume`.

Tests: `links.test.ts` (new: what follows `jobs.feed`), `pages.test.tsx` (five pages, gating, `needs` known off / unknown / RoboApply), `routes.test.tsx`, `components/features/seo/__tests__/lib.test.ts` and `routes.test.tsx` (sitemap).

### 7. [P1] The pricing page follows the plans API: done

- `PricingPage.tsx`: "Not open yet" shows only when `paymentsOpen === false`. Every plan with `sellable` true and payments open carries a button: `/settings/billing?plan=<key>#plans` for a signed-in visitor, `/signup?from=pricing:<key>` otherwise. A plan name with no translation shows `defaultLabel`.
- **This adds the buy button to RoboApply's plan cards too.** The rule is the plans API, not the brand.
- The refund and renewal blocks read `brandPlansRenew`. GoApply's refund text now prints the two MARKET_STRATEGY §4.4 rules and a link to Help. **Owner/counsel should read that wording** (`landing.pricingPage.passRefund1`, `passRefund2`, `passRefundHow`).
- `GoApplyHome`: the note "Paid passes can't be bought yet." shows only when `paymentsOpen === false`.

Tests: `components/features/marketing/__tests__/pages.test.tsx` (`/pricing`: 13 cases).

### 8. [P2] Campus calendar surfaces with the default on: done

- `CampusCalendar.tsx`: an empty, unfiltered calendar says "The calendar is being put together"; "No programmes match these filters" shows only when the visitor's filters emptied the list.
- `CampusAdmin.tsx`: comments only.
- Carry-over FIX-8 "class filter default" (not done, nothing to do in my files): the default needs `cnClassYear` in `server/src/features/onboarding/contract.ts`, which no bundle owns.

Tests: `components/features/campus/__tests__/campus.test.tsx`, `pages.test.tsx`; `admin.test.tsx` unchanged and green.

### PAR-1 handoff and carry-over

- Red test for PAR-9 (`visitor/routes.test.ts` "mode off → 404"): rewritten and green.
- Requests addressed to PAR-9 in the PAR-1 handoff: none.
- Carry-over PAR-9 entries: 1, 2, 3, 5 done; 4 waits on an unowned file; 6 is a list of known gaps of the free matcher, not a change request.

## Files changed

92 files, all inside PAR-9's owns (checked against `parity-bundles.json`: 0 unowned).

- Server: `server/src/features/seo/{routes,service,cron,contract,index,paths,repo,testkit}.ts`, `{routes,seo,cron}.test.ts`; `server/src/features/tools/{service,parse,checks,contract,index,fixtures}.ts`, `{service,parse,routes,defaultService}.test.ts`; `server/src/features/visitor/{routes,contract,digest}.ts`, `{routes,digest}.test.ts`
- App: `app/page.tsx`, `app/[locale]/page.tsx`, `app/job/[idSlug]/page.tsx`, `app/browse/page.tsx`, `app/browse/[...path]/page.tsx`, `app/sitemaps/[file]/route.ts`, `app/tools/{meta.ts,page.tsx}`, `app/tools/[tool]/page.tsx`, `app/tools/job-alerts/page.tsx`, `app/pricing/page.tsx`, `app/campus/page.tsx`
- Lib: `lib/seo.ts`, `lib/server/publicApi.ts`, `lib/api/visitor.ts`
- Components: `components/features/marketing/{GoApplyHome,RoboApplyHome,Sections,PricingPage,SiteChrome,CompanyPages,FeaturePage}.tsx`, `{catalog,hooks,brandEnv}.ts`; `components/features/seo/{JobPage,JobCard,JobTicker}.tsx`; `components/features/visitor/{VisitorAssistant,VisitorFeed,VisitorJobCard}.tsx`, `model.ts`; `components/features/tools/{ToolsHub,ToolRunner,fields}.tsx`, `catalog.ts`; `components/features/campus/{CampusCalendar,CampusAdmin}.tsx`; their tests, the SEO test fixtures and two snapshot files (GoApply entries only)
- Tests: `__tests__/pages/localized-landing.test.ts`
- i18n staging: `landing.en.json`, `landing.zh.json`, `tools.en.json`, `tools.zh.json`, `visitor.en.json`, `visitor.zh.json` (new), `seo.en.json`, `seo.zh.json` (new), `campus.en.json`, `campus.zh.json`

## Tests run

All run after the last edit of the review pass.

| Command | Result |
|---|---|
| `npx vitest run server/src/features/seo` | 112 / 112 |
| `npx vitest run server/src/features/tools` | 122 / 122 |
| `npx vitest run server/src/features/visitor` | 67 / 67 |
| `npx vitest run components/features/marketing` | 126 / 126 |
| `npx vitest run components/features/seo` | 111 / 111 |
| `npx vitest run components/features/visitor` | 28 / 28 |
| `npx vitest run components/features/tools` | 50 / 50 |
| `npx vitest run components/features/campus` | 33 / 33 |
| `npx vitest run __tests__/pages/localized-landing.test.ts` | 5 / 5 |
| All of the above plus `components/landing` in one run | 33 files, 659 / 659 |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 (design, copy, LLM costs, API boundary, extension, zh variants) |
| `node scripts/i18n-merge-staging.mjs --dry-run` | valid; in my namespaces 2 changed keys (`landing.ranking.otherSorts`, `landing.cnHome.campus.empty`), the rest new |
| `npx vitest run --exclude ".claude/**"` | 622 files, 12,919 tests: 12,810 passed, 98 failed, 1 skipped, 10 todo (94 PAR-1 red tests in other bundles' files + the 4 below; 44 failing files, none in PAR-9's owns) |

## Red tests for other bundles

Turned red by this bundle (unchanged by the review pass):

- **PAR-11**, `server/src/features/cn/jobs/__tests__/modeOff.routes.test.ts` (2): "seo: implemented routes return no third-party posting…" and "seo: the seeded GoHire posting is on no public route…". The file's `MODE_OFF` is `{}`. With `MODE_OFF = { CN_RECRUITMENT_INFO_MODE: 'off' }` (the change PAR-11 already makes for the other 12 cases in this file) both pass unchanged.
- **PAR-8**, `__tests__/shell/entryPoints.test.tsx` (1): "browse is dark on GoApply (404)…" greps `app/browse/[...path]/page.tsx` for the deleted market guard. It should assert that the route has no market guard and that `/browse` is a live page on both brands.
- **Orchestrator** (no bundle owns it), `__tests__/lib/i18nStaging.test.ts` (1): compares `loadMessages('en')` with the raw staged string, so any staged string containing `%BRAND%` fails. It should compare against `substituteBrandTokens(staged, brand)` from `lib/brand/tokens`.

## Pre-existing failures

None in files PAR-9 owns. The 94 remaining failures are the ones PAR-1's handoff lists by owning bundle (`cn/jobs/__tests__/modeOff.routes.test.ts` shows 14 = its 12 plus my 2; `__tests__/shell/routes.test.ts` is PAR-1's listed sign-in-order case).

## Requests

**PAR-3**
- The signed-out alert confirmation and digest mails on GoApply need the transport and From fallback of plan §3.4 (`EmailService.transportNameFor`). Until then the route answers 202 and the send is suppressed as `transport_not_configured`.

**PAR-6**
- `credits.plans.goapply.student_monthly` and `student_quarterly` names (en and zh). Until they exist the pricing page and the home summary print the catalog `defaultLabel`.
- `components/features/credits/__tests__/fixtures.tsx` `plansView('goapply')` still defaults to `paymentsOpen: false` and unsellable plans. My tests override it.
- The pricing page links a signed-in buyer to `/settings/billing?plan=<key>#plans` for every sellable plan. Confirm the picker preselects those keys.

**PAR-8**
- The `entryPoints.test.tsx` case above.
- The signed-in card says "{date}最后核对" (`jobsCn.dates.lastChecked`); the public page and browse card now say "最后核验 {date}" (`seo.job.lastChecked`, the wording of MARKET_STRATEGY §1.4). If one wording is wanted, change `jobsCn.dates.lastChecked` in zh.

**PAR-11**
- The two `modeOff.routes.test.ts` cases above.
- `feed/publicRoutes.ts` `publicPathFor` for both brands (already your item). The web opens `/job/<id>` when `path` is null, so the order of merges does not matter.
- `cnLicenceFor` calls your `buildCnCardMeta(row, cnJobCapabilities(env)).sourceLine.licence` with the SEO row (it carries `sourceBoard`, `sourceName`, `fromRecruiterBank`, not `provider`). If the GoHire rule in `card.ts` starts reading another column, tell the orchestrator so `seo/repo.ts` `CARD_SELECT` selects it.

**PAR-10**
- Document: the free tools no longer depend on `DEPLOY_REGION`; `seo-rebuild` runs for GoApply; `FLAG_GOAPPLY_VISITOR_ASSISTANT=true` now turns the visitor assistant on; `PUBLIC_DISPLAY_PROVIDERS` and `FLAG_<BRAND>_SEO_BROWSE` now govern GoApply's public pages too; `CN_HR_LICENCE_HOLDER` / `CN_HR_LICENCE_NUMBER` now also print on GoApply's public job page for GoHire bank postings; GoApply has no visa-sponsorship browse pages.
- Post-merge verification: `/job/<id>` for a listable cn row (source, original link, "最后核验", licence line when set), `/sitemaps/static.xml` and `/sitemap.xml` on the GoApply host, `/tools/job-alerts`, one free-tool run with the notice ticked in Chinese, and the GoApply home with `CN_RECRUITMENT_INFO_MODE=off` (no counters, ticker, search, jobs question or job-matches link).

**Orchestrator**
- `__tests__/lib/i18nStaging.test.ts` (above).
- `server/src/features/support/service.ts` (no bundle owns it): `GET /support/index-stats` counts market `cn` rows whatever the mode. It should return no counts for GoApply while `CN_RECRUITMENT_INFO_MODE=off` (for example by asking `publicListingsOpen(brand, env)` from `features/seo`). The home already hides the counters in that mode; this closes the endpoint itself.
- `app/layout.tsx` (unowned) passes no `initialCapabilities`. If the layout seeded them, every capability-dependent marketing section would be right in the server HTML and the "known off" hook would not be needed.
- `app/sitemap.xml/route.ts` (unowned): its header still says "GoApply lists the static set only". The code needs no change.
- `server/src/features/onboarding/contract.ts` `cnClassYear` (carry-over unowned item 9) for the campus class default.
- i18n pass: after the merge, remove `tools.consent.label` and `tools.consent.offshore` from all nine bundles (nothing reads them), and `landing.cnHome.free.{title,body,notOpen,pricing}` and `landing.pricingPage.cnRefund` after a grep.

**Owner**
- Counsel should read three new texts before GoApply is public: the free-tools notice (`tools.consent.labelAi`, `tools.consent.outsideMainland`), the visitor-assistant consent line (`visitor.assistant.consent.*`), and the GoApply refund lines on `/pricing`.
- The visitor-assistant consent is a tick in the browser, checked on every turn and stored nowhere. If counsel wants a record of it, that needs a schema item.
- GoApply public job pages and browse pages follow `PUBLIC_DISPLAY_PROVIDERS` (default empty) and bank syndication consent, exactly as RoboApply's (owner decision OPS-A4, now applying to both brands).

## Schema requests

None.

## Env variables added or redefined

None added.

| Name | Change |
|---|---|
| `DEPLOY_REGION` | no longer closes the free tools on GoApply. It still decides, with `brandUsesSharedStack`, whether the tools notice carries the outside-the-mainland line |
| `CN_RECRUITMENT_INFO_MODE=off` | now also closes GoApply's public job pages, browse pages, ticker and sitemap partitions, skips its `seo-rebuild`, and (through `jobs.feed`) removes the job sections of the GoApply home and the job-matches page |
| `CN_HR_LICENCE_HOLDER`, `CN_HR_LICENCE_NUMBER` | now also printed on GoApply's public job page for a GoHire bank posting (both must be set; same rule as the signed-in card) |
| `FLAG_GOAPPLY_SEO_BROWSE`, `PUBLIC_DISPLAY_PROVIDERS`, `CN_BAIDU_PUSH_TOKEN` | now take effect for GoApply's public pages (same meaning as for RoboApply) |
| `FLAG_GOAPPLY_VISITOR_ASSISTANT` | `true` now turns the visitor assistant on for GoApply (default still off on both brands) |

## i18n keys added or changed

English in `i18n/staging/<ns>.en.json`, GoApply Chinese in `<ns>.zh.json`. `%BRAND%` counts and ICU parameters match between the two for every key.

- **landing** (en + zh unless noted)
  - new: `landing.cnHome.search.{rolePlaceholder,cityPlaceholder}`, `landing.cnHome.practice.voice`, `landing.cnHome.pricing.{eyebrow,title,sub,freeNote,proNote,notSet,seeAll,notOpen}`, `landing.cnHome.faq.{q4,q5,q6}.{q,a}`
  - new: `landing.features.goapply.{jobMatches,resumeTailoring,coverLetters,readyToApply,referralCodes}.*` (18 strings each)
  - new: `landing.pricingPage.{choosePlan,signupToBuy,passRefund1,passRefund2,passRefundHow}`, `landing.ranking.deadlineSort`
  - changed: `landing.cnHome.campus.empty` (the old translations, "No programmes are listed yet", stay true until translated again)
  - kept from FIX-7 (en only): `landing.ranking.otherSorts` (changed by design; old translations ignore the new parameters and stay true)
  - no longer rendered, remove after a grep: `landing.cnHome.free.{title,body,notOpen,pricing}`, `landing.pricingPage.cnRefund`
- **tools**: new `tools.consent.labelAi`, `tools.consent.outsideMainland` (en + zh). No longer read, remove from all nine bundles: `tools.consent.label`, `tools.consent.offshore`
- **visitor**: new `visitor.assistant.consent.{label,detail,privacyLink}`, `visitor.assistant.errors.consent` (en + zh; `visitor.zh.json` is a new file)
- **campus**: new `campus.list.{compiling,compilingSub}` (en + zh)
- **seo**: new `seo.job.lastChecked` ("Last checked {date}" / "最后核验 {date}"), `seo.job.licence` ("{holder}, HR service licence {number}" / "{holder} 人力资源服务许可证 {number}") (en + zh; `seo.zh.json` is a new file)

Until the merge, GoApply shows every **new** key in English (the runtime merges only staged English). The two **changed** keys keep their existing translations until the merge; both old sentences are still true. No changed key carries a consent or a claim that became false.

## Known gaps

- Not verified in a browser, in either theme or at 375 px. The UI changes reuse existing classes and components only (no new CSS), and the design gate passes, but the GoApply home is a much longer page, the visitor-assistant consent block is new, and the job page gained two lines in its source block: all belong on the post-merge retest list.
- "Known off" content (the GoApply home's search form, jobs question and job-matches card; the job-matches page; the `/security` email sentence) is in the server HTML and is removed in the browser once the capabilities arrive. With `CN_RECRUITMENT_INFO_MODE=off` a crawler that runs no scripts still receives it, `/features/job-matches` stays in the static sitemap, and that page's own FAQ JSON-LD is still sent. The web has no server-side capability reader; seeding `initialCapabilities` in `app/layout.tsx` (Requests) is the root fix.
- The home counters hide in mode off, but `GET /support/index-stats` itself still answers counts (Requests, orchestrator).
- The visitor assistant's GoApply consent line is conditional ("may process … outside mainland China") because the widget has no endpoint that tells it which stack answers. The tools notice is exact (it reads `/config`).
- GoApply browse pages store English titles in `RASeoPage` (the web localises role and city names itself).
- `IndexCounters` hides under 1,000 open roles on both brands; with about 1,800 mainland postings measured in the plan GoApply is near that floor.
- The pricing page's signed-out button goes to sign-up with `from=pricing:<plan>`; the plan is not carried through onboarding into checkout.

## Review resolution

1. **GoApply public job page lacks the mainland display lines (medium): fixed.** `lastSeenAt` selected and sent as `lastVerifiedAt`; `licence` added to the job detail through `cnLicenceFor` (the signed-in card's rule, `buildCnCardMeta`); `JobPage` prints "Last checked {date}" and the licence line on market `cn`. Two things beyond the proposed fix: `lastVerifiedAt` sits on `PublicJobCard`, so GoApply's browse cards print the date too; and the licence follows the signed-in card's GoHire rule instead of `fromRecruiterBank` alone, because a RoboHire bank row is also `fromRecruiterBank` and the licence is GoHire's. Route test (licence matrix: both values, half a licence, employer-board row, RoboApply) and component tests added.
2. **Stale Chinese tools notice under consent v3 (medium): fixed** as proposed: new keys `tools.consent.labelAi` and `tools.consent.outsideMainland`, old keys listed for removal, handoff sentence corrected. A test renders the notice on GoApply in Chinese and asserts the old sentences never appear. I also checked every other staged key of this bundle against `en.json`: the only other changed keys are `landing.ranking.otherSorts` and `landing.cnHome.campus.empty`, whose old translations remain true.
3. **GoApply home shows job sections with postings off (medium): fixed, with two deliberate differences from the proposed fix.**
   - Counters: gated on `useMarketingFlag('jobs.feed')` as proposed. FAQ: the jobs question is left out, and the JSON-LD on `/` and `/{locale}` never lists it.
   - Quick search, the jobs question and the job-matches card are hidden once `jobs.feed` is **known to be off** (`useMarketingFlagOff`) instead of failing closed. Reason: the layout passes no `initialCapabilities`, so a fail-closed gate would take the search form, the question and the card out of the server HTML in the default mode and shift the page when the flags arrive, which is the defect finding 4 describes. The rule finding 4 states ("on by default, so unknown should render it") is applied to both.
   - Ticker: not gated on a fail-closed client flag, for the same reason (it would drop the job links from the server HTML). It is already closed at the source (`publicListingsOpen` makes `/ticker` answer empty in mode off, tested in `seo/routes.test.ts`) and is additionally removed once `jobs.feed` is known to be off, which covers a cached response.
   - The job-matches card is hidden by a catalog rule (`needs: 'jobs.feed'`), which also removes the footer link and turns the page itself into "not available" in that mode, not only the home card.
4. **`/security` drops the new-device sentence from the server HTML (low): fixed** as proposed, through the same `useMarketingFlagOff('notify.email')`. Test: the sentence is present before the capabilities are known, on both brands.
5. **WeChat share path (low): fixed.** `path={job.canonicalPath}`; header comment and test updated.
6. **Visa-sponsorship browse pages on GoApply (low): fixed.** One rule `pageTypeOpen(type, market)`; the rebuild, `service.page()`, the hub and the roles sitemap ask it. Cases added to `seo/cron.test.ts` and `seo/routes.test.ts`. Removed from "Known gaps".

Undone items: none were reported. Unowned edits: none were reported and none exist (92 changed files, 0 outside the owns).

Handoff file: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-par/PAR-9.md`
