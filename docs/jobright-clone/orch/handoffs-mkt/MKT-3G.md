# MKT-3G

Mainland deep links: nine boards, ordered by audience, built only from the user's own query (JC-5). Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-3G`, branch `wp/MKT-3G`. Nothing committed.

**Read this first: JC-5 is built but NOT delivered to users, and the M3 gate must not record it as delivered.** The nine boards are named and the audience order, the route, the panel and the tests are in place, but all six new boards ship with `verifiedOn: null` and no URL in the code. GoApply users still see the three links they saw before (BOSS直聘, 智联招聘, 猎聘), in the same order, whatever their identity. No pattern was confirmed, for the reasons under item 1. Each board goes live when the owner fills one row.

**One edit outside the listed owns, for the orchestrator to accept or redo:** three lines in `server/src/features/cn/jobs/__tests__/modeOff.routes.test.ts` (a test seam; see Review resolution 2). It sits next to this bundle's owned tests, no bundle of any phase owns it, and the reviewer asked for it there.

## Items

### 1. [P0] Six more boards in `CN_EXTERNAL_BOARD_SPECS`, each pattern verified before it ships: done, with all six left unverified

What changed (`server/src/features/cn/jobs/deeplinks.ts`, `contract.ts`):

- `CN_EXTERNAL_BOARDS` has nine ids: `boss`, `zhaopin`, `liepin`, `job51`, `lagou`, `shixiseng`, `nowcoder`, `iguopin`, `ncss`.
- A spec is one of two shapes, enforced by the type: confirmed (`host`, `url`, `verifiedOn: string`) or unconfirmed (`host: null`, `url: null`, `verifiedOn: null`). `buildExternalSearchLinks` returns only confirmed specs.
- `CN_EXTERNAL_HOSTS` is derived from the confirmed specs (`externalHosts()`), so it is exactly their hosts by construction.
- `boardSearchUrl()` is the one place a link is built. It throws when a pattern yields anything but https on the spec's own host (no other host, no port, no credentials). This runs in production too, not only in the test.
- The three existing links are byte for byte what they were (pinned as literals in the test).
- Board names stay in this server file. Nothing fetches a board, fills a form or greets a recruiter.

Verification status of the six boards:

| Board | id | Status | Reason |
|---|---|---|---|
| 前程无忧 | `job51` | not verified | See below; also on the forbidden list of strategy 1.6 (search results), which the wave rules say may not be called |
| 拉勾 | `lagou` | not verified | Same as 前程无忧 |
| 实习僧 | `shixiseng` | not verified | See below |
| 牛客 | `nowcoder` | not verified | See below |
| 国聘 | `iguopin` | not verified | See below |
| 24365 | `ncss` | not verified | See below |

Why none was verified: the item says to open each candidate URL in the in-app Browser pane, but the rules of this run say "Do not run next build, a dev server or a browser", and the M3 network allowance names only Greenhouse, Lever, Ashby, SmartRecruiters and 台灣就業通. Where the two disagreed the prohibition was followed, in all three sessions. The item's own fallback covers this (ship `verifiedOn: null`, list for the owner), and MARKET_TASK_PLAN (owner list, JC-5) already lists the check as an owner task for all six.

Two deviations from the item text, both on the side of D3:

- **An unconfirmed board has no URL builder at all.** The item implies a candidate pattern sitting in the table with `verifiedOn: null`. The bundle notes say deep-link patterns are never typed from memory, and there was no source for them other than memory, so no candidate pattern is in the repository and none is in this handoff.
- **The three existing boards carry `verifiedOn: 'wp41'`** (`SHIPPED_BEFORE_VERIFICATION_RULE`), not a date. WP-41 recorded no check date for them and none was invented. Whoever checks one of the three replaces the marker with that day's date; the test accepts either on those three boards and refuses the marker on any other board.

Tests: `deeplinks.test.ts` (44 tests). Host allow-list, https, one query parameter equal to the keyword and nothing else, over twelve keywords (Chinese, spaces, URL syntax, markup, control characters, emoji, other scripts), for both audiences, on the real table and on a SYNTHETIC nine-board table (`<board>.search.test` addresses); unverified specs excluded; a pattern that leaves its host, uses http, a port or credentials throws; table shape and uniqueness; the check-date rule (below, Review resolution 3 and 4).

### 2. [P0] Links ordered by audience: done

- Each spec has `audience`: campus for 实习僧, 牛客, 24365, 国聘; experienced for BOSS直聘, 智联招聘, 猎聘, 前程无忧, 拉勾. The type allows `both`; no board uses it.
- `ExternalLinksQuerySchema` gains optional `audience: 'campus' | 'experienced'` (anything else answers 422). Each response item gains `audience`.
- `buildExternalSearchLinks(q, city, audience = 'experienced', specs = table)` puts the audience's own boards first in the order above, then the others. Nothing is hidden. The response order is the display order.
- Route: an explicit `?audience=` wins and reads nothing. Otherwise `resolveLinkAudience` reads the user's identity: `zaixiao` or `yingjie` gives campus; anything else, no answer, or a failed read gives experienced. Age and graduation year are never read.
- A failed identity read still answers the links, and now leaves one warning in the log (category `CN_JOBS`, the error message, no user id). The logger is loaded only on that path, and a logger that throws does not fail the links.
- Sign-in requirement and the RoboApply 404 are unchanged.

One choice to confirm: the identity is read from the profile first (`RAProfile.cnFields.identity`) and from the stored onboarding answer second, both through onboarding-cn's `identityFrom`. The item names only the onboarding answer. The identity step writes both, but only the profile value can be corrected later, so a graduate who changes it to 社招 stops getting the campus order.

Tests: `deeplinks.test.ts` (order per audience, `both`, identity precedence, failed read and its warning, a throwing logger) and `routes.test.ts` (12 tests: derivation from a faked identity for all three identities plus none and unknown; a throwing reader answers 200 with the experienced order and one warning that does not name the user; explicit override without an identity read; 401 signed out; 422 unknown audience; no user data in the response).

### 3. [P1] The GoApply panel shows the ordered links and says what they are: done

- `ExternalSearchLinks.tsx` keeps the server's order and label. With both audiences in the answer it renders two labelled groups, the user's first, and the campus group has one extra line. With one audience it renders one list and no group heading.
- The existing sentence ("Opens a search for … %BRAND% does not sign you in there or send anything to it") is unchanged.
- Links keep `target="_blank"`, `rel="noopener noreferrer nofollow"` and `referrerPolicy="no-referrer"`.
- `lib/api/cnJobs.ts`: `getExternalLinks` accepts the optional `audience` through the contract type; new pure helper `groupExternalLinks` (a link with no `audience` counts as experienced, so older responses and other bundles' fixtures still render).
- `ExternalSearchPanel.tsx`: comment only. The panel is where and what the parity wave made it.

Two small behaviour changes beyond the item:

- When the server sends no links the section shows "No search links are available right now." instead of a heading over an empty list.
- The section's heading id comes from `useId` (it was a fixed id, duplicated when two panels were on one page).

Tests: `externalSearchLinks.test.tsx` (new, 16 tests): grouping, order, link attributes, single group without a heading, links without `audience`, empty, loading and error states, RoboApply renders nothing, unique ids with two panels, staged copy names no board in en or zh.

### Carry-over

- `waveM1-carryover.md`, `waveM2-carryover.md`: no `### MKT-3G` section. Nothing to do.
- `wavePAR-carryover.md`, Market waves 1 to 7b: no entry names a file in my owns. Left to their bundles.

### Plan documents versus the item

No conflict found between the item and MARKET_STRATEGY (1.4 tier 0, 1.6, JC-5, C16). PAR-7 and PAR-11 did not touch the deep-link files.

## Review resolution

1. **JC-5's visible result is not delivered (medium): accepted, no code change, as the reviewer asked.** Verified: `deeplinks.ts` registers the six new boards through `unverified(...)`, `buildExternalSearchLinks` filters them out, and every confirmed board is `experienced`, so both audiences get the same three links in one group. The handoff now says at the top that the gate must not record JC-5 as delivered; the owner task and the open question on 前程无忧 and 拉勾 are under Requests.
2. **`modeOff.routes.test.ts` ran real Prisma queries (medium): fixed.** Reproduced first: a verbose run of the `cn.jobs` case printed two `prisma:error` blocks at `deeplinks.ts:161` and `:162` ("Can't reach database server at 127.0.0.1:1"). `seamsFor` in that file now returns `{ cnIdentity: async () => null }` for `cn.jobs`, the same kind of seam the file already has for `feed.public`. After the change a verbose run of `modeOff.routes.test.ts`, `routes.test.ts` and `deeplinks.test.ts` prints no `prisma:error` line. The file is not in this bundle's owns list (see the note at the top and Requests). The previous handoff's "Red tests for other bundles: None" missed this; the test was green but it broke the rule that tests never reach a database.
3. **The table test forbade a real check date on the three shipped boards (low): fixed.** The rule is now one function in the test, `verifiedOnProblem`: the three WP-41 boards may carry the marker or a real date; every other board needs a real date and the marker is refused. A new test proves each branch on synthetic rows, because today's table has no dated row to exercise it.
4. **"Not a future date" compared against the UTC day (low): fixed.** The limit is the latest date anywhere on Earth (now + 14 h). The new test fixes the clock at 2026-10-11 17:00 UTC (01:00 on 12 October in mainland China): a row dated 2026-10-12 passes, 2026-10-13 fails. Added on the way: a date must be a real calendar day (2026-02-30 is refused).
5. **A failed identity read was swallowed with no log (low): fixed.** `resolveLinkAudience` logs one warning through `LoggerService` (`CN_JOBS`, "deep links: the identity read failed; answering the experienced order", `{ error }`), loaded lazily so the module keeps its type-only static imports. Tests assert one warning with the error text and without the user id, in `deeplinks.test.ts` and through the route in `routes.test.ts` (`u_broken`); no warning on the paths that do not fail; a logger that throws still answers the experienced order.
6. **The client caches the links per (query, city) forever (low): accepted, not fixable in this bundle's files.** Verified: `useExternalLinks` in `components/features/market/cn/useCnJobs.ts` uses `staleTime: Infinity` and no bundle of any phase owns that file. The exact change is under Requests (orchestrator). It has no visible effect until a campus board is verified.

No finding was rejected. The review listed no undone item and no unowned edit.

## Files changed

All under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-3G/`:

- `server/src/features/cn/jobs/deeplinks.ts`
- `server/src/features/cn/jobs/contract.ts`
- `server/src/features/cn/jobs/routes.ts`
- `server/src/features/cn/jobs/__tests__/deeplinks.test.ts`
- `server/src/features/cn/jobs/__tests__/routes.test.ts`
- `server/src/features/cn/jobs/__tests__/modeOff.routes.test.ts` (NOT in the owns list: three lines, one test seam; Review resolution 2)
- `components/features/market/cn/ExternalSearchLinks.tsx`
- `components/features/market/cn/ExternalSearchPanel.tsx` (comment)
- `components/features/market/cn/__tests__/externalSearchLinks.test.tsx` (new)
- `lib/api/cnJobs.ts`
- `i18n/staging/jobsCn.en.json`, `i18n/staging/jobsCn.zh.json`

Changed in this review pass: `deeplinks.ts` (the warning), `deeplinks.test.ts`, `routes.test.ts`, `modeOff.routes.test.ts`. No web file, contract or copy changed in this pass.

Handoff file: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-3G.md`

## Tests run

All run in the worktree on 2026-10-11 after the review fixes.

| Command | Result |
|---|---|
| `npx vitest run server/src/features/cn/jobs/__tests__/deeplinks.test.ts` | 44 passed |
| `npx vitest run server/src/features/cn/jobs/__tests__/routes.test.ts` | 12 passed |
| `npx vitest run server/src/features/cn/jobs/__tests__/modeOff.routes.test.ts` | 35 passed; verbose run prints no `prisma:error` |
| `npx vitest run server/src/features/cn/jobs` | 11 files, 329 passed |
| `npx vitest run components/features/market/cn components/features/feed` | 10 files, 177 passed (16 in the new file) |
| `npm run typecheck:server` | pass |
| `npx next typegen && npm run typecheck:web` | pass |
| `npm run check` | exit 0, all six checks pass |
| `npm run eval:match -- --enforce M2` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | 715 files: 714 passed, 1 failed. 17,158 tests: 17,143 passed, 4 failed, 1 skipped, 10 todo. The four failures are the expired fixture under Pre-existing failures |

The full suite was run twice. The first run also had one timeout, `server/src/features/match/eval/run.test.ts > baselines > the first baseline is the list read before the fit contract…` ("Test timed out in 5000ms"), with the machine's load average above 100 from the sibling bundles' runs. The file passes alone (38 of 38) and passed in the second full run; this bundle touches nothing it reads.

No browser, dev server or network call was used. The panel was not looked at in a browser (both brands, light and dark, 375 px and 1280 px): the new markup uses only classes that already exist in `cnJobs.module.css`, which this bundle does not own.

One thing the first session's full suite caught, fixed then: a static import of `onboarding-cn` in `deeplinks.ts` broke `server/src/roboapply/v2/routes/resumes.hub.test.ts`, because the jobs pipeline loads `cn/jobs` through its market hooks. `deeplinks.ts` has type-only static imports; `cnIdentityOf` loads onboarding-cn and the database client when called, and the logger is loaded only when that read fails.

## Red tests for other bundles

None is red. One test outside the owns list needed a seam because of this bundle's change, and the seam was added here (Review resolution 2): `server/src/features/cn/jobs/__tests__/modeOff.routes.test.ts`, no owning bundle in any phase.

## Pre-existing failures

Four tests in `components/features/copilot/__tests__/cards.test.tsx` fail on any worktree of this base from 2026-10-11 08:00 UTC on. Not caused by this bundle: the diff touches neither the test nor its fixtures, the file fails the same way when run alone, and the cause below is a date.

- `filter_diff (F-ORION-04) > the propose_filter_change tool's own card: CountView counts render as numbers (120 now, 40 with the change)`
- `filter_diff (F-ORION-04) > the server's real 409 (proposals.ts): details.card parses and renders as the fresh diff`
- `memory_add > the remember tool's own card on GoApply carries consentRequired; saved and dismissed cards show their status on reload`
- `WP-50 producers ↔ WP-51 cards (Wave 4 gate) > propose_filter_change: the card previews the ops and offers Apply changes`

Cause: `components/features/copilot/__tests__/wireCards.ts` (line 199) creates its proposals with `expiresAt: new Date(NOW.getTime() + 86_400_000)`, and `NOW` is the fixed `2026-10-10T08:00:00.000Z` of `server/src/features/copilot/__tests__/areaFakes.ts` (line 13). The cards are rendered against the real clock, so since 2026-10-11 08:00 UTC each one shows "This suggestion expired. Ask again for a fresh one." and the Apply button and the consent line the tests look for are gone. The second builder in the same file (line 271) already uses `2099-01-01` and is not affected.

Seen while checking finding 2, not a failure and not from this bundle: `server/src/features/cn/jobs/__tests__/service.test.ts` (untouched) prints `prisma:error` lines from `server/src/lib/llm/llmStackConfigResolver.ts:54` (`appConfig.findUnique` against the closed port) in its "LLM check worker" tests. It is the same kind of database reach the reviewer flagged, in files no M3 bundle owns.

## Requests

**Owner (already in MARKET_TASK_PLAN's owner list, JC-5):** confirm the search URL pattern of 前程无忧, 拉勾, 实习僧, 牛客, 国聘 and 24365 from a mainland network, signed out. For each: use the site's own search box with a test keyword, copy the resulting address, strip everything but the keyword, reload, and check the search page still shows that keyword applied. Then on the board's row in `CN_EXTERNAL_BOARD_SPECS` replace `unverified(...)` with `host`, `url` and `verifiedOn: 'YYYY-MM-DD'` (the local date of the check is fine). The three shipped boards can be checked in the same pass: replace `SHIPPED_BEFORE_VERIFICATION_RULE` with the date. The tests cover a new or re-dated row with no test edit, with one limit: they require exactly one query parameter, equal to the keyword. A site that needs a fixed second parameter, or the keyword in the path, needs that assertion widened on purpose.

**Orchestrator:**

- **Do not record JC-5 as delivered at the M3 gate.** Its acceptance clause "a 校招 user sees 实习僧 / 牛客 / 24365 / 国聘 first" is true only on the synthetic table in the tests until the owner fills the rows.
- **Rule on 前程无忧 and 拉勾:** strategy 1.6 forbids reading their search results. Say whether a person opening their search page by hand to confirm a link pattern counts, and whether linking to them is intended at all. If not, the two rows should be removed from the table and from `CN_EXTERNAL_BOARDS`, which is a change to JC-5's list of nine.
- **Accept or redo the edit to `server/src/features/cn/jobs/__tests__/modeOff.routes.test.ts`.** In `seamsFor`, before the final `return {}`: `if (id === 'cn.jobs') return { cnIdentity: async () => null };` plus a two-line comment. If ownership is read strictly, revert the file with `git checkout -- server/src/features/cn/jobs/__tests__/modeOff.routes.test.ts` and apply the same line at the gate; without it the `cn.jobs` case runs two Prisma queries against the closed port (it stays green).
- **`components/features/market/cn/useCnJobs.ts` (no owner in any phase), `useExternalLinks`:** replace `staleTime: Infinity` with `staleTime: 5 * 60_000`. The answer now depends on the signed-in user's identity, so a user who changes 应届 to 社招 on the profile page and repeats a search already run in the session keeps the old order until a reload. The alternative is to invalidate `cnJobsKeys.all` in the profile save handler when `cnFields.identity` changes. No visible effect until a campus board is verified.
- **Fix the expired fixture before the M3 gate**, because every bundle's full suite is red on it. No M3 bundle owns the file. In `components/features/copilot/__tests__/wireCards.ts` line 199, replace `new Date(NOW.getTime() + 86_400_000)` with `new Date('2099-01-01T00:00:00.000Z')` (what line 271 of the same file already does). Check first that no test in `cards.test.tsx` relies on that builder's proposals expiring one day after `NOW`.
- Decide whether the browser check of the six patterns may be run by an agent after the merge (six page loads), subject to the ruling on 前程无忧 and 拉勾 above.
- zh-TW and the other locales need the four new `jobsCn.external` keys at the OT-2 pass. GoApply-only copy; `zh` is staged.
- `server/src/features/cn/jobs/index.ts` (not owned) describes the area's deep links in its header; no code change needed, `buildExternalSearchLinks` keeps its export and its old two-argument call works.

**No bundle:** `useCnJobs.ts` does not send `audience`. Nothing needs it today, because the server derives it. A manual "show campus sites first" switch would start there.

## Schema requests

None.

## Env variables added or redefined

None.

## i18n keys added or changed

Added to `i18n/staging/jobsCn.en.json` and `jobsCn.zh.json` (no key removed or rewritten; unchanged in the review pass):

| Key | en | zh |
|---|---|---|
| `jobsCn.external.none` | No search links are available right now. | 暂时没有可用的搜索链接。 |
| `jobsCn.external.groups.campus` | Campus hiring and internship sites | 校招和实习网站 |
| `jobsCn.external.groups.experienced` | General job sites | 综合招聘网站 |
| `jobsCn.external.groups.campusNote` | Useful for campus hiring, internships and jobs for new graduates. | 适合找校园招聘、实习和应届生职位。 |

No string names a board.

## Known gaps

- **JC-5's visible result is not delivered until the patterns are confirmed.** With today's table every confirmed board is an experienced one, so a 校招 user and an experienced user get the same three links in the same order, in one group. The campus-first order and the two groups appear when the first campus board gets its row. They are proven only on the SYNTHETIC nine-board table.
- The acceptance line "the handoff lists each of the six boards as verified (with date and URL shape) or not verified (with the reason)" is met with six "not verified".
- The three boards shipped by WP-41 have no recorded check date.
- No visual check of the grouped layout (see Tests run).
- The default identity read is two small queries per links request when no `audience` is sent. The client caches the answer per query and city for the session (`useCnJobs.ts`, not owned), so a user who changes their identity keeps the old order for a search they already ran until they reload (Requests).
- The warning for a failed identity read is one log line per failed request, with no rate limit: a database outage logs once per links request for as long as it lasts.
