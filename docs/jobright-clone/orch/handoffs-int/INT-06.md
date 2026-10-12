**INT-06 · status: all five review findings fixed; item 9 still not done (optional, not a small change); nothing launched from this bundle; gates green except three server tests that time out only under machine load**

On "launch the new version": not done here, and it cannot be done from this bundle. INT-06 is one of 13 uncommitted bundles, so a server started from this worktree would show a thirteenth of the new version. The bundle rules also forbid dev servers and browsers, and the owner's server runs from the clone worktree. The changes sit uncommitted in `/Users/kenny/code/RoboApply/.claude/worktrees/wp-INT-06` for the orchestrator to merge and launch. Nothing in this bundle has been seen in a browser.

## Review resolution

1. **Home waits on an API read with no timeout (medium): fixed.** `app/page.tsx` now passes the ticker inside `<Suspense fallback={null}>`, so the home streams without it. The ticker read alone carries `AbortSignal.timeout(2500)` (`TICKER_TIMEOUT_MS` in `lib/server/publicApi.ts`); an abort throws and is never cached. Tests: the slot is a Suspense element; only the ticker read sends a signal; a hung read aborts.
2. **GoApply feed card for the user's own import (medium): fixed, differently from the suggested fix.** Adding "Added by you" to the card row would have left "Source not listed" beside it. Instead the GoApply slot's own source line now reads "Added by you" for the user's job, once.
   - I first added an `ownImport` prop to `MarketJobMetaProps`; the frozen contract test `__tests__/routeShells/stubContracts.test.tsx` (unowned) rejects that, so I reverted it.
   - The card and job page now mark the meta with `withOwnImport(meta, own)` and `JobMetaCn` reads the mark. Slot props are unchanged.
3. **`/help/ranking` on GoApply (low): fixed.** The heading takes a count ("One more rule" on GoApply, "More rules" on RoboApply). GoApply uses a new note with no mention of goals. The zh RoboApply note now mentions goals, matching the English.
4. **GoApply job page loses pay, dates and source on Company/People (low): fixed.** When the market block replaces the header lines, `JobDetailPanel` renders it above the tabs and `JobOverview` leaves it out. RoboApply and Taiwan jobs keep the block inside Overview. The header no longer prints "Added by you" on GoApply (the block does); "Only you can see this job" stays.
5. **"Choose 'I applied'" hint after applying (low): fixed.** For the user's own import the hint goes away once the job is applied, whether just now or on load. A listed job with no link keeps its plain line.

- **Unmet item 9 (server-rendered LegalFooter): still not done, re-checked.** `LegalFooter` is a client component mounted on 13 route files plus `SiteChrome`; about half are outside my ownership. See Requests.
- **Unowned edits:** none.

## Per-item result

1. **`/jobs?sort=`: done.** Unchanged since the last handoff.
2. **Added by you: done.** As before, plus: on GoApply the source reads "Added by you" in the market block on both the feed card and the job page, and the no-link hint disappears after applying.
3. **GoApply single pay/Updated line: done.** As before, plus: the block stays visible on every job-page tab.
4. **Ranking and Explore title: done.** As before, plus: the heading and note match what each brand shows.
5. **Placements (Tailor button, external search panel, negotiable-pay note): done.** Unchanged.
6. **WeChat share card: done.** Unchanged.
7. **SEO and tools: done, one part reported.** The ticker now streams and its read is time-limited. Not done: the `campus-<n>` sitemap part, because the public campus API returns paginated programmes, not URLs.
8. **Legacy landing removal: done.** Unchanged.
9. **Server-rendered LegalFooter (optional): not done.** Not a small change.

## Files

**Changed in this round**
- `app/page.tsx`
- `lib/server/publicApi.ts`
- `components/features/feed/JobCard.tsx`, `jobCard.int.test.tsx`
- `components/features/job/JobDetailPanel.tsx`, `JobHeader.tsx`, `JobOverview.tsx`, `job.test.tsx`
- `components/features/market/index.ts`, `cn/index.ts`, `cn/meta.ts`, `cn/JobMetaCn.tsx`, `cn/__tests__/jobMetaCn.test.tsx`
- `components/features/marketing/CompanyPages.tsx`, `__tests__/pages.test.tsx`, `__tests__/routes.test.tsx`
- `components/features/seo/__tests__/publicApi.test.ts`
- `i18n/staging/jobsCn.en.json`, `jobsCn.zh.json`, `landing.en.json`, `landing.zh.json`

**Created (whole bundle)**
- `components/features/market/cn/ExternalSearchPanel.tsx`
- `components/features/feed/jobCard.int.test.tsx`
- `components/features/feed/exploreMeta.test.ts`

**Deleted (whole bundle)**
- `components/landing/LandingContent.tsx`
- `components/landing/LandingJsonLd.tsx`
- `__tests__/pages/landing.test.tsx`

**Modified earlier in the bundle, unchanged this round**
- `app/robots.ts`, `app/sitemaps/[file]/route.ts`, `app/(auth)/jobs/added/page.tsx`, `app/(auth)/jobs/explore/layout.tsx`
- `lib/seo.ts`, `hooks/jobimport/useJobImport.ts`, `__tests__/lib/pricing.test.ts`
- `components/features/feed/`: `JobsWorkspace.tsx`, `SortMenu.tsx`, `feed.test.tsx`, `jobsPage.test.tsx`
- `components/features/filters/`: `FilterEditors.tsx`, `FiltersDrawer.test.tsx`, `filters.testkit.tsx`
- `components/features/job/format.ts`
- `components/features/jobimport/`: `AddJobPanel.tsx`, `ImportWarnings.tsx`, `JobsAddedPage.tsx`, `JobImport.test.tsx`
- `components/features/market/`: `MarketJobMeta.tsx`, `cn/cnJobs.module.css`
- `components/features/marketing/`: `RoboApplyHome.tsx`, `SiteChrome.tsx`, `catalog.ts`, `hooks.ts`, `__tests__/home.test.tsx`, `__tests__/links.test.ts`
- `components/features/seo/`: `JobPage.tsx`, `labels.ts`, `__tests__/{components,lib,routes}` tests and both snapshot files
- `components/features/tools/`: `ToolsHub.tsx`, `catalog.ts`, `hooks.ts`, `index.ts`, `__tests__/tools.test.tsx`
- `i18n/staging/`: `jobs.en`, `jobDetail.en`, `jobImport.en`, `tools.{en,zh}`

No server, Prisma or extension files were touched. Every path is inside INT-06's ownership.

## Tests run

| Command | Result |
|---|---|
| `npx vitest run components/features/{job,feed,market,marketing,seo} __tests__/routeShells` | 21 files, 560 tests passed |
| `npm run typecheck:web` | clean |
| `npm run typecheck:server` | clean |
| `npm run check` | all six checks clean |
| `npx vitest run --exclude ".claude/**"` | 546 files passed, 3 failed; 10020 tests passed, 2 failed, 5 skipped, 26 todo |

The three failing files are timeouts in server tests I did not touch:
- `server/src/features/legacyPrecedence.test.ts` (hook timeout, 10 s)
- `server/src/features/auth/legacyAuth.test.ts` › "returns the WP-10 additions and no V1 mission"
- `components/features/practice/__tests__/server/externalRoutes.practice.test.ts` › "works without a job…"

Run alone with default timeouts, all three pass (3 files, 38 tests). The machine's load average was about 160 during the full run, with the sibling bundles running, so I read these as load, not code.

## Requests

- **INT-04:** set `ACTION_CARD_CAPS.sortLink = true` in `components/features/copilot/cards/ActionCard.tsx` and restore the cheatsheet sort question. `/jobs?sort=` and `/jobs/added?import=` now work.
- **INT-05:**
  - Have `buildCnCardMeta` (`server/src/features/cn/jobs/card.ts`) send `ownImport: true` for the user's own job, and add it to `CnCardMeta` in `lib/api/contracts/cn/jobs`. The web already reads `meta.cn.ownImport`; the client-side mark can then go.
  - `ImportStatusResponse.warnings` is always `[]` for a draft; fill it from `cnImportWarnings` / `cnFraudWarnings` if drafts should warn before saving.
  - Return the draft values from `GET /jobs/import/:importId` so a reopened form can prefill.
- **INT-05 or orchestrator:** a `campus-<n>` sitemap part needs a URL-listing read on the campus area (`server/src/features/cn/campus`). The web side is then one regex change in `app/sitemaps/[file]/route.ts`.
- **Orchestrator (unowned files):**
  - `app/[locale]/page.tsx`: pass `ticker={<Suspense fallback={null}><JobTicker /></Suspense>}` to `RoboApplyHome`, as `app/page.tsx` does. Localized homes have no ticker yet.
  - `components/job-search/metadata.ts` still writes a literal `| RoboApply` and is used by `app/(auth)/job-search/**`.
  - Server-rendered legal lines (item 9): add a loader for `/api/v1/public/legal/footer` in `lib/server/publicApi.ts` and a provider in `app/layout.tsx`.
  - Dead after the landing deletion: `components/ui/PageContainer.tsx` (zero importers) and most of `styles/landing.css`.
- **INT-02:** `PLAN_PRICES_MINOR` / `planPriceMinor` in `lib/pricing.ts` are now read only by `__tests__/lib/pricing.test.ts`.
- **INT-01, INT-09, INT-13:** the three server tests above time out under load at the default 5 s / 10 s limits.
- **INT-12 (optional):** `HybridShell`'s signed-out header has no nav, so `/tools` is reachable there only through the footer.

## i18n keys

**Added this round (en and zh)**
- `jobsCn.source.addedByYou`
- `landing.ranking.pointsNoteRules`

**Changed this round**
- `landing.ranking.rulesTitle` is now an ICU plural taking `{count}` (en and zh).
- `landing.ranking.pointsNote` (zh only) now mentions goals.

**Added earlier in the bundle (English)**
- `jobs.explore.metaTitle`, `jobs.explore.metaDescription`
- `jobDetail.actions.noApplyLinkYours`
- `jobImport.add.resuming`, `jobImport.add.resumed`, `jobImport.errors.draftGone`
- `jobsCn.external.panel.{title,intro,label,placeholder,submit}`
- `landing.site.nav.tools`, `landing.site.footer.tools`
- `landing.ranking.{rulesTitle,pointsNote,upToPoints,addsPoints,goalIntro,goalOthers}`
- `landing.ranking.rules.{sponsorshipFirst,skillsBoost}.{title,body}`
- `landing.ranking.goals.{moreSenior,management,higherPay,flexibility}`
- `tools.hub.jobAlerts.{title,body}`

The same keys were added in `jobsCn.zh.json`, `landing.zh.json` and `tools.zh.json`.

**Obsoleted**
- `landing.ranking.goal1`, `landing.ranking.goal2` (removed from staging; remove from any locale bundle that has them).
- In `i18n/messages/*`, legacy landing keys with no reader left: `landing.{hero,problem,how,loop,studio,rules,pricing,faq,final,sticky,footer}`.
- Still read, keep: `landing.header` (`components/landing/ThemeToggle.tsx`) and `landing.meta` (`__tests__/lib/brandInvariants.test.ts`).

## Env vars introduced

None.

## Known gaps

- Nothing was looked at in a browser (375 / 1280 px, light / dark, either brand); proven with Testing Library only. The GoApply job page layout changed this round (market block above the tabs) and deserves a look after merge.
- When the ticker read takes longer than 2.5 s, the home shows no ticker for that request and retries on the next one.
- A reopened unfinished add opens an empty form, because the server keeps no draft values.
- On a GoApply host, the header and footer make one `GET /api/v1/public/tools/config` call to decide the `/tools` link.
- The feed card's Tailor button adds one latest-check read per feed load, shared across cards. A user with no resume sees no button.
- Robots disallows only the three named utility routes. `/cancel`, `/reset-password`, `/verify-email` and `/extension/uninstalled` are left alone.