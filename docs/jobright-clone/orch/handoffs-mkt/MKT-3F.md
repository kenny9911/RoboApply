# MKT-3F

Provider health in the admin System panel: plan, remaining quota, days to reset, dead sources visible (JI-1). Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-3F`, branch `wp/MKT-3F`. Nothing committed. Handoff file: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-3F.md` (same text as below).

All three items are done. This pass resolved the five findings of the independent review (see "Review resolution"); the reviewer judged no item undone and found no unowned edit.

## Review resolution

All five findings were real. Each was checked against the code in `wp-MKT-3A` (read only) before it was fixed.

1. **Daily limit and `provider_budget` used the configured bound (medium): fixed.** `limits.ts` `providerDailyLimit(provider, market, env, reading, now)` now returns what ingest enforces: intl = `min(bound, cap)` when the operator set a bound, else `cap ?? default`; cn = `min(INGEST_<P>_CN_DAILY_CALLS ?? 0, cap)`; `cap = floor((requestsRemaining - reserve) / max(1, daysToReset))`, `reserve = max(1, ceil(requestsLimit x INGEST_QUOTA_RESERVE_SHARE))`. `buildProviderRows` passes the provider's own current reading, so the admin process needs no in-memory quota. Tests: JSearch 9,773 of 10,000 with 17 days gives limit 545 and no `provider_budget` at 190 calls; Active Jobs DB 23 of 25 with 17 days gives limit 1 and `provider_budget` at 1 call; 0 left gives limit 0. MKT-3A's index does not export `quotaDailyCap` or the operator-bound reader, so the rule is written in `limits.ts` with the reading as an argument, and a parity test (`the daily limit is the one ingest enforces`) compares it with `effectiveDailyLimit` as soon as the ingest index exports it (skipped until then). I ran that comparison once against MKT-3A's as-built code with a temporary file (since deleted): 20 of 20 cases equal, including a bound set through MKT-3A's deprecated alias.
2. **On/off depended on the host of the admin (medium): fixed at the root.** New `readBrandSources` in `system.ts` reads a brand's sources inside `runWithBrand(brandId, ...)`. `providerSources` and `jobSourcesHealth` (the per-brand sources list had the same fault) both use it. The health e-mail is covered by the same change. Tests: the reviewer's adapter double (`isEnabled: () => getCurrentBrandId() !== 'goapply'`) at service level, and a route test that calls GET /admin/system from both hosts and gets identical providers, alerts and sources. I checked that the route test fails without the fix.
3. **A provider at ingest's reserve showed "Off" (medium): fixed.** `providerState` no longer treats every "off" as `disabled`. Off because the quota stops ingest falls through to the reading (`low`, `ok`, `unknown`). The quota is the cause when the adapter's reason is `quota`, or when the adapter states no reason (null, or the registry's generic `disabled`) and the reading is at or under ingest's reserve. The second form is needed because MKT-3A's adapter as built emits no reason; it makes a warm process and a cold one show the same state. A reason of its own (`no_key`, `kill_switch`) is still `disabled`. Tests: the reviewer's three cases, plus warm and cold rows at 400 of 10,000 both `low` with one `provider_quota` alert, and BASIC with 2 of 25 left `low`.
4. **A mainland counter with an opened budget vanished on a day without calls (low): fixed.** New `mainlandCounterSources`: when a served brand is a mainland brand, every metered provider the snapshot knows whose `INGEST_<P>_CN_DAILY_CALLS` is above 0, and that the registry does not already list for cn, gets a source. Test: `brandsServed ['goapply']`, budget 20, no usage, Active Jobs DB exhausted gives one row `activejobs:cn` `exhausted` and one `provider_quota` alert; without the env, no row.
5. **Row-header inline style (low): fixed.** `ROW_HEAD`, the `last` prop and the `CSSProperties` import are gone; the cell is `<th scope="row">` and the stylesheet rule `.table th[scope='row']` applies, as in the sources table. My earlier claim that the stylesheet had no such rule was wrong.

## Items

### 1. [P0] System status reports every provider of the served brands with its quota snapshot: done

- `contract.ts`: `ProviderUsageRow` gains `market`, `plan`, `requestsLimit`, `requestsRemaining`, `jobsLimit`, `jobsRemaining`, `resetAt`, `daysToReset`, `observedAt`, `costModel`, `state`, as the cross-bundle contract lists them. New exports: `PROVIDER_STATES`, `ProviderState`, `ProviderMarket`, `ProviderCostModel`, `ALERT_LEVELS.quotaLowShare` (0.1). `limit` is now documented as the limit ingest enforces that day.
- `system.ts`:
  - `SystemStore.providerQuota()` reads the one AppConfig row `jobs.providerQuota.v1` through `parseProviderQuota` (`findUnique` only; a test asserts the store never writes it).
  - `providerSources(brands, env, list)`: one source per (provider, market) from `sourcesForBrand` of every served brand, without `user_import`, each brand read in its own context. On or off is `adapterEnabledFor(adapter, market)`.
  - `mainlandCounterSources`: see Review resolution 4.
  - `buildProviderRows`: the union of those sources and the day's `RAProviderUsage` keys, merged with the snapshot. Rows are platform-wide: `brandsServed` decides the list, not `?brand=`.
  - Quota lookup for a row: the snapshot under its own usage key, then the provider (one plan serves both markets), then the provider it is billed on (`activejobs_feed` reads `activejobs`). The daily limit and the reserve use the provider's own reading only, never the billed-on one.
  - A reading whose `resetAt` has passed describes the previous period: plan and limits stay, what was left and the state do not.
  - `providerState` (pure), first match wins: unmetered source `ok` / `disabled`; `unauthorized` / `not_subscribed` from the reading; `gated`; `exhausted` (reading state, or 0 requests or 0 postings left); `disabled` (off for a reason other than quota); `unknown`; `low` (under 10% of a stated limit); `ok`.
- `limits.ts`: `providerDailyLimit`, `quotaDailyCap`, `quotaReserve`, `mainlandCallBudget`, `FEED_MIN_MONTHLY_JOBS`; still re-exports `dailyCallLimit` from the ingest index.
- `lib/api/admin.ts`: re-exports the four new types.
- ACCEPT, each asserted: activejobs with the stored BASIC snapshot and no call today gives plan `BASIC`, `requestsRemaining` 0, `daysToReset` 17, state `exhausted` (route test, exact object; its `limit` is 0); jsearch 9,773 of 10,000 is `ok`; a provider absent from the snapshot is `unknown` with every quota field null; `activejobs:cn` is its own row with market `cn`.
- "A GoApply-served deployment lists `activejobs:cn`" now holds on a day with a usage row, or whenever the operator opened the mainland budget and a reading exists, or once the registry lists the provider for cn (MKT-5A).

### 2. [P0] The System panel shows plan, remaining and days to reset, and flags a dead source: done

- `SystemConsole.tsx` providers section: columns Provider, Market, State, Plan, Requests left / limit, Jobs left / limit, Resets in, Calls today / daily limit, Returned, New, Errors. State is a pill with words. A value the provider did not state is a dash, never 0. A state this build does not know renders "Not known yet". The banner (`role="status"`) names the metered providers that are exhausted, not subscribed or refused and says the feed is running without them. `provider_quota` alerts read in plain words in the alert list.
- Tokens only. The state pill is local to the file (`badges.tsx` has no generic tone pill and is not mine). The table sits in the existing `tableWrap`.
- `console.test.tsx` asserts on the rendered output, not on the staging file.
- Not seen in a browser: the rules forbid a dev server here.

### 3. [P1] Alert level and the daily health e-mail include quota state: done

- `contract.ts`: alert key `provider_quota`; `AlertHit` gains optional `state` and `daysToReset`.
- `system.ts` `evaluateAlerts`: one hit per metered row that is exhausted, not subscribed, refused or low. `provider_budget` compares the day's calls with the row's `limit`, which is now the effective limit the item asks for.
- `healthEmail.ts`: `<provider>: monthly quota used up, resets in N days` (the reset only when stated), `<provider>: not subscribed`, `<provider>: key rejected`, `<provider>: under 10% of the monthly quota left`.
- ACCEPT: an exhausted activejobs row gives one `provider_quota` alert in GET /admin/system and one line in that day's e-mail; an ok provider gives none.

### Carry-over

- waveM1 "MKT-3F 1" (quota contract; I am the reader): done.
- waveM2: no MKT-3F section.
- wavePAR "Market waves" entries 1 to 7b: none names a file in my owns. Nothing taken.

### Where the item and the documents differ

No conflict with MARKET_STRATEGY. One reading of the item: 0 left is `exhausted`, not `low` (MKT-3A's writer records it the same way).

## Files changed

All under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-3F/`:

- `server/src/features/admin/contract.ts`
- `server/src/features/admin/system.ts`
- `server/src/features/admin/limits.ts`
- `server/src/features/admin/healthEmail.ts`
- `server/src/features/admin/__tests__/fakes.ts`
- `server/src/features/admin/__tests__/services.test.ts`
- `server/src/features/admin/__tests__/routes.test.ts`
- `components/v3/admin/SystemConsole.tsx`
- `components/v3/admin/__tests__/console.test.tsx`
- `lib/api/admin.ts`
- `i18n/staging/admin.en.json`
- `i18n/staging/admin.zh.json` (Requests 5)

## Tests run

| Command | Result |
|---|---|
| `npx vitest run server/src/features/admin components/v3/admin` | 4 files, 197 pass, 1 skipped (the parity test, until the ingest index exports `effectiveDailyLimit`) |
| `npm run typecheck:server` | clean |
| `npx next typegen && npm run typecheck:web` | clean |
| `npm run check` | all gates clean |
| `npm run eval:match -- --enforce M2` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | 714 files: 713 pass, 1 fails. 17,133 tests pass, 4 fail, 2 skipped, 10 todo. The 4 are under Pre-existing failures. |

## Red tests for other bundles

None.

## Pre-existing failures

`components/features/copilot/__tests__/cards.test.tsx`, 4 tests. Not in my diff: `server/src/features/copilot/__tests__/areaFakes.ts` has `NOW = 2026-10-10T08:00Z`, `components/features/copilot/__tests__/wireCards.ts` line 199 gives a proposal `expiresAt = NOW + 24 h`, and the card compares that with the real clock. Since 2026-10-11 08:00 UTC the cards render as expired. Every worktree fails the same way. Fix: `expiresAt: new Date('2099-01-01T00:00:00.000Z')` at line 199, as line 271 already does.

## Requests

1. **MKT-3A or orchestrator, at the M3 merge: one definition of the daily limit.** Export `quotaDailyCap`, `quotaReserve` and the operator-bound reader (`configuredDailyCalls`) from `jobs/ingest/index.ts`, or an `effectiveDailyLimit` variant that takes the reading. Then `admin/limits.ts` delegates and its local `quotaReserve`, `quotaDailyCap` and `operatorDailyBound` are deleted. Until then the parity test guards the copy. If MKT-3A changes `effectiveDailyLimit` in its own review pass, that test turns red at the merge: the fix is in `admin/limits.ts`.
2. **MKT-3A: say why the RapidAPI adapter is off.** `createRapidApiAdapter` gains `disabledReason`: `'quota'` when the client is usable and `quotaAllows(id, 'ingest')` is false; ideally `'no_key'` / `'kill_switch'` otherwise. The panel already works without it (Review resolution 3); with it, the case "no key and a reading at the reserve" reads `disabled` instead of `low`.
3. **MKT-3A: export the mainland-callable set** (`MAINLAND_CALLABLE` in `quota.ts`). `mainlandCounterSources` would then skip a provider that is never called for cn. Today an operator who sets `INGEST_JSEARCH_CN_DAILY_CALLS` above 0 gets a `jsearch:cn` row that never counts a call.
4. **MKT-5A.** (a) `plan_too_small` from `adapter.disabledReason()` turns a metered source that is off into `gated`. (b) A source the registry lists for cn wins over `mainlandCounterSources`. (c) When `quota.ts` exports `FEED_MIN_MONTHLY_JOBS` through the ingest index, re-export it in `admin/limits.ts` in place of the local constant.
5. **Orchestrator: `i18n/staging/admin.zh.json`.** Chinese for every new key, mirroring the file as the parity wave left it. My owns list names only `admin.en.json`; the `admin` namespace is mine in M3, and the reviewer did not count it as an unowned edit. Drop my hunk if the merge must hold to the list: nothing depends on it.
6. **Orchestrator (OT-2):** `title`, `sub`, `empty`, `calls`, `returned` and `new` under `admin.console.system.providers` are CHANGED English strings; the stale translations in the other eight locales must go.
7. **Orchestrator: the copilot fixture date** (Pre-existing failures). One line, no owner in this phase.
8. **MKT-4C (owns `SystemConsole.tsx` and the `admin` namespace in M4):** the providers panel is `ProvidersPanel`; `PROVIDER_STATE_TONE` is exported for the test. Add keys beside `admin.console.system.providers.*`.
9. **Owner, after the M3 merge:** look at `/admin/system` once in both themes at 375px and 1280px. Eleven columns scroll sideways on a phone by design.

## Schema requests

None.

## Env variables added or redefined

None added. Read for display only, both defined by MKT-3A:

- `INGEST_<PROVIDER>_CN_DAILY_CALLS`: daily call budget of a provider's mainland counter, default 0.
- `INGEST_QUOTA_RESERVE_SHARE`: share of a plan's monthly requests ingest never spends, default 0.05.

Named constants: `ALERT_LEVELS.quotaLowShare` = 0.1 (`contract.ts`); `FEED_MIN_MONTHLY_JOBS` = 20,000 (`limits.ts`, strategy M-2).

## i18n keys added or changed

`i18n/staging/admin.en.json` (and the same keys in `admin.zh.json`), all under `admin.console.system.providers`. Unchanged in this pass.

- Changed: `title`, `sub`, `empty`, `calls`, `returned`, `new`. Restaged unchanged: `provider`, `errors`.
- New: `market`, `state`, `plan`, `requests`, `jobs`, `resetsIn`, `leftOfLimit`, `days` (ICU plural), `markets.intl`, `markets.cn`, `states.{ok,low,exhausted,not_subscribed,unauthorized,gated,disabled,unknown}`, `banner`, `bannerOne`, `alert.{exhausted,exhaustedNoReset,not_subscribed,unauthorized,low}`.

## Known gaps

- The daily-limit rule exists twice until Request 1 is done (ingest's and the copy in `admin/limits.ts`), guarded by the parity test.
- An exhausted provider now shows "0 / 0" under Calls today / daily limit: ingest may make no call that day.
- Without Request 2, a provider with no key whose last reading is at the reserve reads `low`, not `disabled`. The reading is true; the row does not say the adapter is also off.
- `activejobs` and `activejobs:cn` on one exhausted plan give two rows, two alerts and two e-mail lines.
- A closed reading with no reset time (`not_subscribed`) stays until ingest records a newer one.
- Nothing was seen against a real snapshot, and the UI was not opened in a browser.
