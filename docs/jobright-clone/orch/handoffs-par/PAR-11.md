# PAR-11

GoApply feed and job detail, after the independent review. Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-PAR-11`, branch `wp/PAR-11`, base `3fa104e` (PAR-1 merged). Nothing committed, pushed or stashed. No schema change, no new dependency, no i18n change, no dev server, browser or provider call.

All three items are done and all seven review findings are fixed (none was rejected). Every test in a file PAR-11 owns is green (66 files, 1,467 passed, 1 skipped). Both typechecks and `npm run check` pass for the whole repository. The full suite has 51 failures in 27 files, all in other bundles' files and all red at the base (PAR-1's list); none is in a PAR-11 file and none is new. No unowned file was edited.

Three things the reader should know first:

1. **The page reader and the posting-text rules no longer use a pattern that starts again at every unclosed tag, bracket or blank run and reads to the end each time.** A new linear HTML scanner (`server/src/features/jobs/import/html.ts`) is the one reader for the plain server read, the import extractor and the mainland contact rule. 2 MB of each input the reviewer measured is now read in 1 to 13 ms (it was minutes); half a million real tags take about 150 ms.
2. **`thin` changed meaning in one case.** It now says the whole list is short, not the first window. On GoApply it is still known on the first page (the matching public rows are counted). On RoboApply it is false until the list has reached its age floor short; nothing on RoboApply reads it.
3. **The shared `htmlToPlain` in `jobs/normalize/text.ts` (PAR-7's file) has the same slow patterns** and runs on every provider description at ingest with no length cap: 100 KB of `<li ` took 1.0 s here. It is not mine to edit; see Requests, PAR-7.

## Review resolution

| # | Finding | Verdict | What changed |
|---|---|---|---|
| 1 | High. Plain server read: the HTML-to-text patterns are quadratic | Real. Fixed | New `jobs/import/html.ts`: `scanHtml` reads a document once (next `<` by `indexOf`, a tag ends at its `>` outside quoted values, a comment or a whole script / style / noscript / svg / template / iframe / title element is one hidden piece, and a search that found nothing is never repeated). `pageOf` reads the title, the four metas the import uses, the structured-data blocks and the main part in two passes; `htmlToText` is a third. `directFetch.ts` keeps `mainHtmlOf`, `toScrapedPage`, `charsetOf` with the same results on ordinary pages. I did not cap the page at a prefix: with a linear reader the 2 MB cap is enough, and a prefix would lose postings that follow large inline data. **I also followed the page into the extractor**, which the same crafted page reaches next: `extract.ts` read `rawHtml` with `/<script\b[^>]*…/` (quadratic on `<script ` repeated), cleaned markdown with `/\[[^\]]*\]\(…/` (quadratic on `[` or `![` repeated) and `/[ \t]+\n/` (quadratic on a long run of blanks). Now: structured data comes from `ldJsonBlocks` (one scan), markdown links from `withoutMarkdownLinks` (one pass, checked against the two old patterns on every string of up to 7 bracket characters and 3,000 random ones), the blank pattern starts only at the start of a run, and a value that may hold markup goes through `tagsOnly` before the shared `htmlToPlain`. A plain-text page has its blank runs folded like an HTML page. The direct reader hands the extractor only the structured-data blocks as `rawHtml`, not the document. Tests: `html.test.ts` (new, 40), `directFetch.test.ts` (+13: 2 MB of 11 inputs as a bare document, inside `<head>` and `<main>`, and as plain text, read under 200 ms and the draft built under 400 ms; each measured under 25 ms). |
| 2 | Medium. WeChat ids and service lines stay in the stored HTML when a tag or `&nbsp;` separates label and value | Real. Fixed | In markup the details are now found in the text a reader sees (`visibleText`: a block tag is a line break, an inline tag one blank, a comment nothing, entities decoded, every character mapped back to its source range) and cut out of the text nodes they came from; tags stay. Nothing inside a tag is text any more. One exception, kept from before: the target of a link that rings or messages the recruiter (`href="tel:…"`, `sms:`, `weixin:`) is emptied. `withoutContactInfo` then reads the cleaned markup again as a reader would and stores the cleaned plain text instead if a detail still shows. Tests: the reviewer's four shapes plus four more (a number split over `<span>`s, numeric entities, a source line break, comments inside a number), each asserting neither stored column contains the detail; a hook-level test in `service.test.ts`. |
| 3 | Medium. Contact removal deletes ordinary words and reference numbers | Real. Fixed | (a) After a Latin word and only a colon ("WeChat: …") the next word is a contact only when it looks like an id: an underscore, or a digit and the word stands alone. Letters alone never count there. After the Chinese word and a colon ("微信：zhangsan"), after 加微信 and after 微信号 a letters-only id still counts, but only when it stands alone (not the first word of a Latin phrase). (b) A landline with no label needs its area code in brackets or 7 to 8 subscriber digits in one run; a grouped one ("010-1234-5678") is removed after a phone label or a "ring this" word (致电, 拨打, 来电, call). (c) A number after an id label (编号, 工号, 单号, ID, Ref, Req, Job No.) is not a phone number; "Prepaid 138…" is not shielded by its "id". (d) An amount ("13800000000 元") is not a phone number. (e) Extensions ("ext 12", "分机 801") leave with their number; "Phone No.:" and "Mobile number" are labels. (f) Attribute values are not text (finding 2). Every example of the review is a negative test, plus "WeChat: OAuth2 login", "e-commerce", "官方微信公众号：…" and an address line. |
| 4 | Medium. Contact removal is quadratic on long runs, with no size cap | Real. Fixed | Every blank run in a pattern is bounded (`{0,6}`), the e-mail half of the protected pattern starts only at the start of its run and is bounded, the line tidy folds blank runs first, the "is this markup" test is bounded, and markup is read by the scanner (an inline image is inside a tag and is never matched). No size cap was needed. `postingText` reads `description` with the same scanner (its old `/<(script|style)[\s\S]*?…/` had the same fault and I had put raw provider markup through it in this bundle). Tests: ten 500 KB postings (a base64 image in markup and in plain text, a label and a long blank run, full-width blanks, unclosed tags and scripts, many labels, digits, at signs). Each call measured 3 to 20 ms (the review measured 5 s and 18.6 s at 100 KB); the test limit is 250 ms, not the 100 ms the review named, so a busy machine does not trip it. I probed 53 inputs in 7 arrangements before writing them; none passed 100 ms. |
| 5 | Medium. `thin` is true while most of the list is unread | Real. Fixed | `thin` is true only when the list is known to be short: it has reached its age floor with fewer than 60 results, or (GoApply) fewer than 60 public rows match the query at all. `sourcesSql` now also returns `count(*) AS "listed"`; the service reads it and does not send it (the wire `sources` keeps its two fields). Tests: 30 recent plus 100 older rows answer `thin: false` on every page and paging reaches all 130; 30 rows and nothing older answer `thin: true` on the first page although a second page follows; with the count unavailable the answer is false until the list ends. |
| 6 | Low. People-search role: any 2 to 5 letter field is thrown away | Real. Fixed | Region codes are tested as written, in capitals (`/^[A-Z]{2,5}$/`, no `i`). "Director, Legal" gives "Legal Director", "Analyst, Risk" gives "Risk Analyst", "Manager, Tax" gives "Tax Manager"; "Manager, APAC" stays "Manager". 8 new assertions. |
| 7 | Low. `salary` is null on a mainland row whose pay is in another currency or period | Real. Fixed | Feed card and job page: when the mainland notation has no line but the posting states figures, `salary` carries them (`text: null`, min, max, currency, period). Found while testing it: a stored 0 produced a "0K" pay line on GoApply (CNY, monthly, min 0 and max 0). A stored 0 is now no figure in `cn/jobs/salary.ts`, and the fallback needs a figure above zero (`hasPayFigure`). Tests in `items.test.ts`, `detail.test.ts`, `card.test.ts`, `sourceLine.test.ts`. |

Items the reviewer judged not done:

- **Item 2, ACCEPT "a phone number or WeChat id in a board posting's text is removed before it is stored".** Now met for HTML postings (findings 2 and 3). `thin`: finding 5.
- **waveFIX carry-over 1, 3, 4, 7.** 4: the defect is fixed (finding 6). 1 and 3: nothing more can be done inside PAR-11's files; the reviewer agreed they are correctly raised as O11-1 to O11-3, which stand. 7: done before, unchanged.

Unowned edits: none (the reviewer found none; `git status` lists 69 paths, all inside `owns`).

## Items

### 1. [P0] Feed, recommendations and alerts are on by default; mode tests say off explicitly: done

No gate was added. `cn/jobs/mode.ts`: comments only (default `licensed`, `off` is the kill switch; the licence line stays env-only).

Tests rewritten so "off" is set explicitly and the default (nothing set) is asserted to show postings: `cn/jobs/__tests__/mode.test.ts` (unknown value and unset give `licensed`), `modeOff.routes.test.ts` (`MODE_OFF = { CN_RECRUITMENT_INFO_MODE: 'off' }`, a `MODE_DEFAULT` harness that must not answer `feature_disabled`, and the GoHire posting opens by default), `card.test.ts`, `service.test.ts`; `feed/marketStats.test.ts`, `seams.test.ts` (new default-on case: counts, sample, preview, alert candidates return the public market cn rows), `personalization.cn.test.ts` (now runs with nothing set), `routes.test.ts`; `alerts/modeOff.test.ts`; `tracker/modeOff.test.ts`, `reminders.test.ts`; `lifecycle/lifecycle.test.ts`; `match/MatchService.test.ts`, `cron.test.ts`; `offers/postedRange.test.ts`; `agent/__tests__/consentAndD1.test.ts`, `routes.test.ts`; `resume/tailor/store.test.ts`; `roboapply/v2/routes/legacyJobScope.test.ts`; `jobs/detail/detail.test.ts`; `onboarding/routes.test.ts`.

Three points that go beyond "set off explicitly":
- `agent/__tests__/routes.test.ts`: GoApply with no CN model passes the capability gate. The 503 `ai_unavailable` case uses `CN_CONTENT_SAFETY_PROVIDER=nonsense` together with `CN_RESIDENCY_STRICT=true`, which is unusable both before and after PAR-2's "degrade to the built-in list" rule.
- `onboarding/routes.test.ts`: GoApply's default `nextRoute` is `/campus`; `/resume` only with both `CN_CAMPUS_CALENDAR_ENABLED=false` and `CN_RECRUITMENT_INFO_MODE=off`; each switch alone is also asserted (`/campus`, `/jobs`).
- Tests that used another bundle's real policy now inject its answer, so they hold before and after the sibling merges: `match/cron.test.ts` and `match/MatchService.test.ts` (the scorer route policy is PAR-2's `scorerRoute.ts`), `jobs/detail/detail.test.ts` "Fill this form" (the last line follows `extensionOffersFill('cn', …)` instead of pinning `false`), `modeOff.routes.test.ts` job-search section (only the mode-off case is asserted here).

ACCEPT met: with no `CN_RECRUITMENT_INFO_MODE` a GoApply user gets public market cn rows from the feed, similar jobs, market stats, alerts and the Assistant's preview seam; with `off` every former off-mode assertion still holds.

### 2. [P0] Every mainland card names its source and opens its own apply link: done

**Contract (plan §5), as implemented. PAR-8 and PAR-10 read these names.**

Feed item (`FeedItem`, also the visitor item, the similar-job item and `feedService.preview`):

```ts
apply: { url: string; target: 'gohire' | 'employer' | null } | null
source: { name; kind;                       // unchanged
          original: string | null;          // the employer for a board row; the stored original publisher otherwise
          url: string | null;               // original posting link (http/https, never LinkedIn)
          lastVerifiedAt: string | null;    // RAJob.lastSeenAt, ISO
          via?: 'bank' | 'ats' | 'import' } // absent for an aggregator row (RoboApply only)
salary: { text: string | null; min; max; currency; period; months } | null   // null = the posting states no pay
```

Job page: the same three on `detail.job` (`job.apply`, the extended `job.source`, `job.salary`); `job.applyUrl`, `job.pay`, `job.payText`, `job.source.originalName` stay.

Feed response (`POST /feed/query`): `sources?: { gohire: boolean; employerBoards: number }` and `thin: boolean`.

GoApply card meta (`cardMeta.cn.sourceLine`, `marketMeta.cn.sourceLine`): additive `original`, `url`, `via`.

The new fields are typed optional ("always sent by the server") so objects other bundles build still compile; the server always sends them.

Rules, one place each:
- `feed/sourceLine.ts` (pure; re-exported by `feed/contract.ts`, which is what other areas import because of the area boundary test): `sourceKindOf`, `applyLinkOf`, `sourceFactsOf`, `salaryLineOf`, `hasPayFigure`, `cnListable`, `cnListableWhere`, `httpUrl`. Used by `feed/items.ts`, `jobs/detail/view.ts`, `cn/jobs/card.ts`, `alerts/repo.ts`, `agent/service.ts`, `jobs/detail/service.ts`.
- `apply.target` is `gohire` only for a GoHire bank row (`fromRecruiterBank` and `sourceBoard = 'gohire'`), `employer` only for a row from a known employer board (`greenhouse`, `lever`, `ashby`, `smartrecruiters`, plus the two older spellings the card already read as a board). An unknown `sourceBoard` is never called an employer board.
- `salary` on market cn is the line the card meta shows (`cnSalary` in the pure module `cn/jobs/salary.ts`, re-exported by `cn/jobs/contract.ts` and `card.ts`): the posting's words when they carry a figure, else the mainland notation of the stated figures. When the notation has no line (another currency, a weekly rate) but the posting states figures above zero, `salary` carries those figures with `text: null`. 面议, figure-less text and a stored 0 give null.
- `sources` is one aggregate (`sourcesSql`, `FeedRepo.querySources`) over the public rows the query can reach (its filters, its age floor, the browse category). A board is one (system, board token); a row whose id has no board token counts by employer name. Sent on market cn; left off when the count fails (the list still answers) and on other markets. The same statement returns `listed`, the number of those rows, which the service uses for `thin` and does not send.
- `thin` is true when the whole list is known to hold fewer than 60 results (`FEED_THIN_BELOW`): the list has reached its age floor short, or (GoApply) fewer than 60 public rows match the query. It is false while older results may still come and nothing counts them.
- A public market cn row with no usable apply link is never listed: in the feed's SQL scope (`scopePredicates`: list, later pages, counts, Explore counts, samples, alert candidates, the visitor list, the header facts), in similar jobs (`similarWhere`), in the alerts repo and in Ready to apply (`visibleJobs`). The user's own import needs no link. RoboApply statements are unchanged (asserted).
- Licence line: unchanged rule, tested for the default mode: only on a GoHire row and only with both `CN_HR_LICENCE_HOLDER` and `CN_HR_LICENCE_NUMBER`.

Mainland text rules (`cn/jobs/text.ts`, `service.ts` `cnAfterNormalize`):
- At ingest, for every market cn row whatever its provider, recruiter phone numbers and WeChat ids are removed from `description`, `descriptionPlain` and the section columns before the row is stored. The run's notes get `contact_info_removed`.
- What is removed: mainland mobiles (bare or labelled, with +86), landlines (labelled in any grouping; unlabelled with the area code in brackets or 7 to 8 subscriber digits in one run, or after 致电 / 拨打 / 来电 / call), service lines and anything phone-shaped after a phone label and a colon, extensions, WeChat ids after 加微信 / 微信号 / 微信： / +V: / VX: / "WeChat ID:", "微信同号", and the target of a `tel:` / `sms:` / `weixin:` link.
- What is never touched: links and e-mail addresses, pay figures, dates, amounts, numbers after an id label, numbers inside a longer token, anything inside a tag, and "WeChat" used as a channel or product name ("WeChat: official accounts", "微信小程序", "微信公众号：…").
- In markup the details are found in the visible text, so a label in one tag and its value in the next are read together; the markup itself stays.
- The fraud rules and posting tags then run on the text that will be stored, so every stored quote exists in the stored text. A board row is tested.

ACCEPT met and tested: a board row on GoApply returns `source.original` = the employer, its original link, a last-verified date and `apply.target = employer`; a bank row returns `apply.target = gohire` and its GoHire page; no market cn row without an apply link reaches the feed, similar jobs, alerts or Ready to apply; a phone number or WeChat id in a board posting, plain or HTML, is removed before it is stored. Nothing here submits or pre-submits anything (D1).

Tests: `feed/items.test.ts` (22), `feed/FeedQueryService.test.ts` (48, 7 of them on sources, thin and the apply-link rule), `feed/sql.test.ts` (two snapshots updated in the first pass, one more now for `listed`), `feed/sourceLine.test.ts` (6), `jobs/detail/detail.test.ts` (73), `cn/jobs/__tests__/card.test.ts`, `service.test.ts` (44), `text.test.ts` (94), `alerts/modeOff.test.ts`.

### 3. [P1] Job detail and import guards: done

- **Company news** (`jobs/detail/service.ts`): the market term is removed. The route follows the `companyNews` flag and a configured search on both brands. With `FLAG_GOAPPLY_COMPANY_NEWS=true` the GoApply job page returns news (tested with an injected search; the real search still asks the residency policy, PAR-5's).
- **Fraud second opinion** (`cn/jobs/fraud/llm.ts` `resolveFraudModel`): fraud model, else enrichment model, else default model, each read through `brandEnv` (`CN_X ?? X`), so with no CN value it runs on the shared model. The mainland-prefix check applies only under `cnLlmDomesticOnly(env)`. When GoApply has its own LLM stack only its own `CN_` names are passed. The call still runs under `runWithBrand('goapply')`, so the content-safety filter applies.
- **Public job path** (`feed/publicRoutes.ts` `publicPathFor`): returned for both brands.
- **Link import on a mainland deployment** (`jobs/import/service.ts`, `directFetch.ts`, `html.ts`): order is (1) the configured fetch provider when it has a key, the deployment is not under `CN_RESIDENCY_STRICT`, and the residency policy allows it; (2) on a mainland deployment only, one plain server read; (3) paste. A provider that is refused or out of reach gives way to the plain read; a page that cannot be reached, is not HTML or text, is too large, or comes back empty falls back to paste with the link kept. RoboApply and GoApply offshore never use the plain read.

  Because the server opens this connection itself, `directFetch.ts` carries the SSRF rules: the existing URL policy on every hop (so a listed board is never read, by redirect either); the host is resolved once and every address must be public (loopback, private, link-local and cloud metadata, CGNAT, multicast, reserved, IPv4-mapped and NAT64 forms are refused); the socket is pinned to the checked address; redirects are followed by hand, at most three; GET only, no cookies or credentials; a 10 s limit for the whole read; a 2 MB cap counted after decompression; HTML or plain text only. A link that carries personal data is refused before any read. Mainland pages in GBK are decoded by their declared charset.

  The page is also input to our own process: it is turned into text by the linear scanner (review finding 1), and so is everything the extractor does with it.

ACCEPT met and tested: company news on GoApply behind its flag; the second opinion on the shared model; a link import on `DEPLOY_REGION=cn-mainland` returns the posting text for a reachable page and falls back to paste otherwise.

Tests: `jobs/detail/detail.test.ts`, `cn/jobs/__tests__/service.test.ts`, `feed/publicRoutes.test.ts` (5), `jobs/import/service.test.ts`, `jobs/import/directFetch.test.ts` (60, including the real pinned GET against a loopback server in the test process), `jobs/import/html.test.ts` (40), `jobs/import/extract.test.ts` (unchanged, green on the new reader).

### PAR-1 handoff inputs

- Semantics: used as written (`brandEnv` per key, `brandOwnEnv`, `brandStack`, `cnLlmDomesticOnly`, `cnResidencyStrict`). No PAR-1 file was edited.
- Red tests: all 44 in PAR-11's files plus `onboarding/routes.test.ts` are green.
- P7-1: every reader of the mode in PAR-11's files handles `licensed` as the default. P7-2: no expectation in PAR-11's files names `linkedin` as a provider. P7-3: PAR-11's code names `'linkedin'` once, as a stored `sourceBoard` string in `jobs/detail/view.ts` (`API_BOARDS`), not as a `JobProvider`.

### Sibling handoffs that named PAR-11

- PAR-2 (5 tests): all green here and independent of PAR-2's change. Its request to use `getEnvModelSetting` and `taskModelRoute` in `fraud/llm.ts` cannot be taken in this worktree (those exports do not exist at this base); see Requests.
- PAR-7: board rows map to `via: 'ats'`, GoHire rows to `via: 'bank'`. Hiding unverified GoHire rows under "exclude agencies" is the intended reading of the filter; nothing changed.
- PAR-8 R11-1, R11-2: the field names and places match; `feedService.preview` returns `apply.url` for market cn rows (tested). R11-3: the three tests are green before and after its change. R11-4 (posting excerpt on the card): not done, not in this bundle's items.
- PAR-9: the two SEO cases pass with the explicit off switch; `publicPathFor` answers for both brands.

### waveFIX carry-over (section "PAR-7", by file ownership)

1. Weekly insight in the reader's zone: **done for the two files PAR-11 owns.** `RAInsightService.getWeekly(userId, weekStartUtc?, tz?)` and `refresh(userId, locale?, { weekStartUtc?, tz? })` pass `tz` to `tracker.weeklyFacts`; `refresh` writes under the week the page shows and refuses a week that is not the current week of some zone. `tracker/contract.ts`: `WeeklyInsightQuerySchema` takes an optional `tz`; new `WeeklyInsightRefreshBodySchema`. The route and the web client are unowned: O11-1, O11-2.
2. Stored rows keep old values: owner DML, nothing to code.
3. `MatchService` rewrite: **not done.** A distinct reason for "the daily limit stopped the rewrite" needs a field on `MatchFitView` (`match/contract.ts`, no owner) and a web reader: O11-3.
4. People search for a composite role: **done**, and the short-field defect the review found is fixed. "Sr. Manager, Strategic Finance - EMEA" gives "Strategic Finance Manager"; "Director, Legal" gives "Legal Director"; a comma part that is a place, a region code in capitals, a work arrangement or a level is not taken as a field.
5. Country-wide location shape: no new writer of saved-search locations was added.
6. Ready to apply "Company I don't want": unchanged, owner decision.
7. Fraud and tag quotes cut from the posting's own text: **done.** `postingText` reads the description as the posting wrote it (tags removed by the scanner, entities decoded) and falls back to the folded copy. Matching, flag keys and the admin "cleared" memory ignore width.

## Files changed

69 files, all inside PAR-11's owns (checked against `parity-bundles.json`).

New (9): `server/src/features/feed/sourceLine.ts`, `sourceLine.test.ts`, `publicRoutes.test.ts`; `server/src/features/cn/jobs/salary.ts`, `__tests__/text.test.ts`; `server/src/features/jobs/import/directFetch.ts`, `directFetch.test.ts`, `html.ts`, `html.test.ts`.

Modified, source (32): `server/src/features/feed/` `FeedQueryService.ts`, `contract.ts`, `items.ts`, `marketStats.ts` (comment), `publicRoutes.ts`, `repo.ts`, `routes.ts` (comment), `sql.ts`, `testkit.ts`, `types.ts`; `server/src/features/cn/jobs/` `card.ts`, `contract.ts`, `fraud/llm.ts`, `mode.ts` (comments), `service.ts`, `text.ts`; `server/src/features/jobs/detail/` `contract.ts`, `service.ts`, `view.ts`; `server/src/features/jobs/import/` `contract.ts` (re-exports `scanHtml` and `tagsOnly`; comments), `extract.ts`, `firecrawl.ts` (comment), `service.ts`, `urlPolicy.ts` (comment); `server/src/features/alerts/repo.ts`; `server/src/features/agent/` `routes.ts` (comment), `service.ts`; `server/src/features/tracker/contract.ts`; `server/src/features/match/MatchService.ts` (comments); `server/src/features/offers/postedRange.ts` (comments); `server/src/roboapply/v2/lib/legacyJobScope.ts` (comment); `server/src/roboapply/v2/services/RAInsightService.ts`.

Modified, tests (28): the test files named under the items, plus `cn/jobs/__tests__/testkit.ts`, `feed/__snapshots__/sql.test.ts.snap`, `tracker/insights.test.ts`.

Changed in the review pass: `jobs/import/html.ts` and `html.test.ts` (new), `directFetch.ts`, `directFetch.test.ts`, `extract.ts`, `contract.ts`; `cn/jobs/text.ts`, `salary.ts`, `__tests__/text.test.ts`, `service.test.ts`, `card.test.ts`; `feed/FeedQueryService.ts`, `sql.ts`, `repo.ts`, `testkit.ts`, `contract.ts`, `items.ts`, `sourceLine.ts` and their tests and snapshot; `jobs/detail/view.ts`, `detail.test.ts`.

## Tests run

| Command | Result |
|---|---|
| Every test file PAR-11 owns (the directories and files of `owns`) | 66 files: 1,467 passed, 1 skipped, 0 failed |
| `npx vitest run server/src/features/boundary.test.ts` (PAR-1's; cross-area imports) | 5 / 5 |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 (design, copy, LLM costs, API boundary, extension, zh variants) |
| `npx vitest run --exclude ".claude/**"` | 627 files, 13,092 tests: 13,030 passed, 51 failed, 1 skipped, 10 todo. The 51 are in 27 files of other bundles, the same 27 files and the same count as before the review pass, all red at the base |

`extension/` and `interview-agent/` were not touched.

Timing tests are part of the suite (`html.test.ts`, `directFetch.test.ts`, `text.test.ts`). Their limits are 200 ms to 1.5 s for calls that measured 0 to 97 ms here, and 2 to 4 s for half a million real tags that take about 150 ms; the faults they guard against took seconds to minutes. They passed in three whole-suite runs. If a loaded CI machine ever trips one, raise the limit, do not remove the test.

## Red tests for other bundles

One, and it was already red at the base:

- **PAR-9**, `server/src/features/visitor/routes.test.ts` "GoApply items have no public page (path null); mode off → 404 feature_disabled": `publicPathFor` now answers for both brands, so `items[0].path` is the job's public path (`/job/j0-data-analyst-acme` in that fixture), not null. (Its other failing assertion is PAR-1's: the off case must set `CN_RECRUITMENT_INFO_MODE=off`.)

The review pass turned no test red outside PAR-11's files.

## Pre-existing failures

50 further tests in 26 files of other bundles, exactly the remainder of PAR-1's list: PAR-2 17 (its 14 plus `copilot/__tests__/support.test.ts`, `tools.test.ts`, `match/inputs.test.ts`), PAR-3 8, PAR-4 11, PAR-5 6, PAR-7 5 (`jobs/ingest/cron.test.ts` 3, `adapters/adapters.test.ts` 2), PAR-8 3.

## Requests

### Orchestrator

- **O11-1. `server/src/roboapply/v2/routes/insights.ts` (no owner).** Read the zone and the week on both routes: `const { weekStartUtc, tz } = parseQuery(req, WeeklyInsightQuerySchema); return service.getWeekly(userId, weekStartUtc, tz);` and on `POST /refresh` `const body = parseBody(req, WeeklyInsightRefreshBodySchema); return service.refresh(userId, getRequestLocale(req), body);`. Both schemas are exported from `features/tracker/index.ts`. Without this the service change has no caller.
- **O11-2. `lib/api/tracker.ts` (no owner).** `getWeeklyInsight(weekStartUtc?, tz?)` adds `?tz=`; `refreshWeeklyInsight({ weekStartUtc, tz })` sends the body of O11-1; `trackerExportCsvUrl(timeZone?)` adds `?tz=`. Then PAR-8 can drop `withTimeZone` in `components/features/tracker/ApplicationsToolbar.tsx`.
- **O11-3. `server/src/features/match/contract.ts` (no owner).** Add `rewriteBlocked?: EstimateReason | null` to `MatchFitView` (additive). `MatchService.scoreJob` would set it where a rewrite is stopped by the daily cap, and the web can then say when the limit resets. PAR-11 will make the one-line service change once the field exists.
- **O11-4. After PAR-2 merges, in `server/src/features/cn/jobs/fraud/llm.ts` (PAR-11's file):** replace the local env reads and the local provider list with PAR-2's `getEnvModelSetting('LLM_FRAUD_MODEL', brand, env)` and `taskModelRoute(brand, model, env)`. The tests in `cn/jobs/__tests__/service.test.ts` state the behaviour to keep.

### PAR-7

- **`server/src/features/jobs/normalize/text.ts`: `htmlToPlain` and `looksLikeHtml` are quadratic on unclosed openers, and `normalizeProviderJob` runs them on every provider description with no length cap.** Measured here: 50 KB of `<li ` 0.26 s, 100 KB 1.0 s, 100 KB of `<a ` 1.35 s; the time quadruples per doubling. One such posting from a board stalls the ingest pass, and stalls it again on every later pass. The fix is one line at the top of `htmlToPlain`: `const s = cleanText(typeof input === 'string' ? tagsOnly(input) : input)`, with `tagsOnly` imported from `server/src/features/jobs/import/contract.js` (re-exported there from the pure module `html.ts`, which imports nothing; the same call takes 4 to 8 ms on those inputs and gives the same text on well-formed markup, tested in `html.test.ts`). `looksLikeHtml` needs `[^<>]{0,2000}` in place of `[^>]*`. If you would rather own the scanner, move `html.ts` under `jobs/normalize/` and I will import it from there. Paste and link imports reach the same helper with at most 60,000 characters, about 0.4 s at worst.
- Board rows as you describe them need nothing else from this pass. The contact rule now reads HTML descriptions as a reader sees them, so an adapter may hand `description` as HTML or as text.

### PAR-8

- **`thin`:** read it from the first page, as you do. It now means the whole list is short. On GoApply the first page knows (the matching rows are counted); if the count could not be read, `sources` is absent and `thin` is false until the list ends.
- **`salary` can have `text: null` with figures on a GoApply row** (pay in another currency or by the week). `payUndisclosed()` must treat `salary !== null` as stated pay and format the figures as it does on RoboApply; `salary: null` still means the posting states none. A CNY row with a stored 0 no longer sends a "0K" line.
- **`apply.target` can be `null`.** It is `gohire` or `employer` only where that is known. A user's own import and an aggregator row carry `{ url, target: null }`. `apply` itself is `null` when the row has no http(s) link.
- **`source.via` is absent on an aggregator row** (RoboApply's search providers). On market cn it is always one of the three.
- **`sources`** is sent on GoApply only, and is left off when it could not be counted: render no header then, never "0 家".
- `cardMeta.cn.sourceLine` also carries `original`, `url`, `via` (the same values as `item.source`).

### PAR-9

- The visitor test above.

### PAR-2

- See O11-4. `resolveFraudModel` is env-only, like `resolveEnrichModel` was. A model set only in the admin `llm_stack` blob is not seen by it; `taskModelRoute` should close that when O11-4 is applied.

### PAR-5

- `jobs/import/service.ts` asks `assertNoPiInPayload` for the fetch provider as before. On a mainland deployment a refusal now leads to the plain read instead of straight to paste. Under `CN_RESIDENCY_STRICT` the provider is not asked at all. No change needed in the residency module.
- `jobs/detail/newsSearch.ts` still asks the residency policy before calling the news search for GoApply.

### PAR-10

- Document: `FLAG_GOAPPLY_COMPANY_NEWS=true` turns company news on for GoApply; a link import on `DEPLOY_REGION=cn-mainland` reads the page from the server when the fetch provider cannot be used; `LLM_FRAUD_MODEL` (table below).
- `orch/parity-verify.md` §5.4: the field names are as PAR-10 wrote them (`data.sources.gohire`, `data.sources.employerBoards`, `items[].apply`, `items[].source`). `thin` on a filtered GoApply query is now false when older postings exist beyond the first page; a check that expected `thin: true` from a first page with 20 to 59 recent rows should count the whole list.

### Owner

- **Plain server read of an imported link (security note).** On a mainland deployment the server opens a user-supplied link itself, once per import, under the address rules in item 3, and reads the page with a linear scanner. This is what plan gap G127 asks for; it is limited to `DEPLOY_REGION=cn-mainland`. If you would rather keep "paste only" there, the off switch is one line (`mainland` in `readLink`); say so.
- **Contact removal is a trade between two mistakes**, and I set it toward leaving text as written where the two meet: after "WeChat:" in Latin letters, a word of letters only is kept ("WeChat: Moments" is a channel far more often than an id). A recruiter who writes "WeChat: zhangsan" in an English posting keeps that id on the page. After the Chinese word ("微信：zhangsan") it is removed. If you want the stricter side, it is one constant (`WECHAT_ID_STRICT` in `cn/jobs/text.ts`).

## Schema requests

None.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `LLM_FRAUD_MODEL` | now read for GoApply's fraud second opinion when `CN_LLM_FRAUD_MODEL` is unset (per key, `CN_X ?? X`); then `LLM_ENRICH_MODEL`, then `LLM_MODEL`, each with its `CN_` twin first | unset: the enrichment or default model |
| `CN_LLM_FRAUD_MODEL` | unchanged name; no longer has to be a mainland id unless the wall is on | unset |
| `CN_LLM_DOMESTIC_ONLY`, `CN_RESIDENCY_STRICT` | read here: the fraud model must name a mainland provider; under the strict switch a mainland link import never calls the fetch provider | off |
| `FLAG_GOAPPLY_COMPANY_NEWS` | now effective: turns company news on for GoApply | off (registry) |
| `CN_RECRUITMENT_INFO_MODE` | no new meaning (PAR-1's); every reader in PAR-11's files treats unset as on | `licensed` |
| `CN_HR_LICENCE_HOLDER`, `CN_HR_LICENCE_NUMBER` | unchanged: both needed for the GoHire licence line | unset: no line |

No variable was added.

## i18n keys added or changed

None. PAR-11 has no namespace and changed no copy.

## Known gaps

- **Precedence and reading notes.** (1) Plan §3.9 says a posting with no usable apply link is never listed on both markets; the item asks for the read-side guard on market cn. Implemented for market cn only, so RoboApply's statements are unchanged (plan principle P7); ingest already refuses such rows on both markets. (2) The item names `apply.target` as `'gohire' | 'employer'`; D3 wins for rows where neither is known, hence `null`. (3) "The existing thin-result threshold" is read as 60, the number the feed already widens its first window below. (4) Plan §3.3 wants the fraud model to go through the shared resolver; that resolver is PAR-2's and not at this base (O11-4). (5) The review asked for a parse prefix of about 512 KB on the plain read; I made the reader linear over the whole 2 MB instead, because a prefix drops postings that follow large inline data. (6) The plan's wire `sources` has two fields; `listed` stays inside the server.
- **Contact removal is rule-based.** Not removed: a number spelled in Chinese numerals; a number with each digit in its own tag or split into more groups than 3-4-4; a WeChat id that follows the word with only a blank and no 号, colon or 加 ("微信 hr_zhang01"); a letters-only id after a Latin "WeChat:"; a QQ number; an image of a QR code. Removed although arguably not a recruiter's: a company fax number, and a lone Latin word after "微信：" in Chinese text. A user's own import keeps its text as pasted. Rows stored before this change keep their text until their next sync rewrites it.
- **The second look in `withoutContactInfo` has no test that reaches it.** It stores cleaned plain text when cleaned markup would still show a detail. Both passes read the same visible text, so I could not build an input that gets past the first and is caught by the second; it is a safety net and is cheap (one more read of a changed row).
- **`thin` on RoboApply** is false until the list has reached its age floor (a list under 21 results reaches it on the first page). No RoboApply screen reads it. A count there would add a query to every RoboApply feed page, which I did not do.
- **`thin` on GoApply counts public rows.** A user's own imports are not in the count; a list with fewer than 60 public rows is thin whatever the user imported, unless the list already holds 60.
- **`partner_deeplink` mode** still only changes `cnJobCapabilities().applyVia`, which nothing reads (as before this bundle).
- **`sources` adds one aggregate query per GoApply feed page.** With the index sizes of this wave that is small. If the mainland index grows large, cache it per session.
- **The plain read sees only server-rendered pages.** A career site drawn by scripts comes back empty and the user is asked to paste. A `<main>`, `<article>` or `<body>` that is opened and never closed is read to the end of the document.
- **Weekly insight zone and the rewrite reason** are finished only as far as PAR-11's files go (O11-1 to O11-3).
- Not verified in a browser or against a running stack (the bundle rules forbid both). No provider, database or outside network was reached by any test; the only sockets opened are loopback servers inside the test process.
