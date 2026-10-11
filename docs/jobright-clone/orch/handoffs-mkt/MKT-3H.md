# MKT-3H

Runbooks and pre-flight: Alipay cut-over with the notify check, Stripe test-mode pass (two documents and one script). Wave MKT-M3. Worktree `wp-MKT-3H`, branch `wp/MKT-3H`, base `48a5e56`. Nothing committed.

**This is the handoff after the independent review.** The four findings were each verified and all four are fixed (list under "Review resolution"). Two of them I fixed more strictly than the reviewer's suggestion, and verifying the third turned up two more facts the runbook now states. No unowned edit existed and none was made.

**No Alipay code was edited. No file outside my owns was edited.** The tests named `A<n> …` are unedited and green (199 tests in the five files that hold them).

**Nothing was run against a deployed host, the GoHire worker or Stripe.** The script was run against this repository's own callback route on a loopback port (in the test) and against loopback stubs (the commands of the runbook, as written).

## Review resolution

| # | Finding | Verdict | What was done |
|---|---|---|---|
| 1 | high: started through a symlinked path the pre-flight does nothing and exits 0 | **Real.** Reproduced with the old entry check: by its real path it ran, through a linked directory it printed nothing and exited 0. | `scripts/alipay-notify-preflight.mjs`: the entry check is now `isEntryPoint()`, which compares **both** sides as real paths (`realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))`). Stricter than the suggested fix, which resolved `argv[1]` only: under `node --preserve-symlinks-main` the module URL is the link itself, and that case would have stayed silent. Run by hand through a linked directory: usage error exit 2, `--help` exit 0 with the usage line, a dead port `FAIL` exit 1, and the same under `--preserve-symlinks --preserve-symlinks-main`. Tests added in the "run as a command" block: a link to the file and a link to the `scripts` directory, each for a usage error (status 2, usage line on stderr) and for `--help` (usage line on stdout); a dead loopback port through the link (status 1, a `result: FAIL` line); `isEntryPoint` directly (real path, both links, the preserve-symlinks case, another file, a missing file, no path); importing the script does not run it. The runbook says in 4.2 that no output at all is never a pass. |
| 2 | low: with `--origin`, an ignored `CN_ALIPAY_NOTIFY_ORIGIN` is only a note and the run can end `PASS` | **Real.** Carry-over M2 MKT-3H.1 says "Fail when `ignoredOverride` is set" without an exception, and the previous handoff claimed the rule as met. | One rule in `resolveTarget`: an ignored override is a refusal **before any request**, with or without `--origin` (exit 1, `Nothing was sent.`, the value never printed, the host a deployment with that value would use is named, and with `--origin` the line says the given host was not checked and to fix or unset the variable). I did not take the suggested form (run the check, print `PASS`, then exit 1): a `result: PASS` line with exit code 1 is two answers in one output, and the form of the runbook attaches the output. The `note:` line and the `note` field are gone. A usage error in `--origin` is still reported first (exit 2). Tests: the old test that pinned `PASS` / exit 0 is replaced by three cases × two spellings of `--origin` expecting `FAIL`, exit 1 and no request; no environment with an ignored override can end in exit 0 whatever the host answers (5 values × 3 argument forms); a usable override does not stand in the way of `--origin`; one spawn test with a pasted notify URL in the variable (exit 1, the secret not printed). Runbook: 4.2 has a paragraph and the "FAIL before any request" row now covers both cases; section 8 has the command to try it. |
| 3 | low: the runbook does not say how the test host becomes a GoApply site | **Real, and wider than reported.** Read in `registry.ts` (`brandIdFromHost`, `isDevOrPreviewHost`), `runtime.ts` (`resolveBrandFromRequest`), `lib/brand/runtime.ts` (`resolveWebBrand`) and `proxy.ts`: an unknown host resolves to RoboApply while both brands are served, and unset already serves both. | `ALIPAY_CUTOVER.md`: the `ALLOWED_BRANDS` / `BRAND_LOCK` cells read "unset, or a value that includes `goapply`"; a `BRAND_HOST_MAP` row; new section **2.1 "The test host must be a GoApply site"** with the ways the code offers. The reviewer named three (a host under `goapply.top`, `BRAND_HOST_MAP`, `ALLOWED_BRANDS=goapply`); the code has a fourth for `*.vercel.app` hosts only (`BRAND_FORCE=goapply`, or `?__brand=goapply`, which sets a cookie in that browser alone), listed with its limit: a request without the cookie (the pre-flight, the worker's notify) still resolves to RoboApply there. 4.2 says how to read the script's `brand:` line (`goapply` for the test host; `roboapply` means the site the owner opens is RoboApply; the result does not depend on it because the callback finds the order by number). Step 0 row 2, step 4.3 a and the form name it too. **Found while verifying:** the order's `return_url` is built from GoApply's app origin (`CN_CANONICAL_ORIGIN`, else `https://www.goapply.top`; `appOrigin` in `origins.ts`), not from the host the buyer came from, so on a test host the cashier sends the owner to another host: 2.1 and step 4.3 d now say so and tell the operator to open the test host by hand. |
| 4 | low: the recovery command's claim that the secret never appears on the command line is wrong | **Real.** The shell expands `"cb=$ALIPAY_CALLBACK_SECRET"` into `curl`'s argument list. | The command is now `printf %s "$ALIPAY_CALLBACK_SECRET" \| curl -sG … --data-urlencode "cb@-"`. Checked here against a loopback listener with a made-up value that holds a space, `/`, `+`, `&` and `=` (curl 8.7.1): the listener received `cb=<the value, URL-encoded>` in the query; `printf` is a builtin of the shell. The sentence now says what is true: not typed, not in the shell history, not in any argument list; it **is** in the request URL, so the platform's request log holds it. Added: do not use `echo` (it adds a line end), do not add `-v` or `--trace` (they print the URL). |

Also changed, not asked for by the review:

- **Runbook section 8 stopped its stub with `kill %1`.** In a shell without job control that left the stub running here (the next run still answered `PASS` from it). The commands now keep the process id (`& STUB=$!` … `kill $STUB`) and were run again as written. The leftover listener was stopped.
- **One claim I wrote and then removed after reading the code:** that `CN_COOKIE_DOMAIN` set to `.goapply.top` breaks sign-in on a test host outside that domain. `cookieDomainFor` (`platform/brand/runtime.ts`) falls back to a host-only cookie when the host does not match, so it does not.

## Items

### 1. [P0] Pre-flight script: done, with three deliberate departures from the item text

`scripts/alipay-notify-preflight.mjs` (plain Node, no dependency, no import from the server). One `GET <origin>/api/v1/roboapply/billing/alipay/callback` with no parameter, no order number and no secret; redirects not followed; 10 s limit. It reads only `CN_ALIPAY_NOTIFY_ORIGIN` and `CN_BACKEND_URL` from the shell, never `BACKEND_URL`, never the callback secret. It prints the host, what decided it, the HTTP status, the answer code, the brand header and one result. Exit code 0 only on `PASS`, 1 on every other result, 2 on a usage error. The fetch, the environment, the timeout and the output are injectable. The usage line is in the header. It runs the same when started through a symbolic link.

ACCEPT lines, each held by a test in `__tests__/scripts/alipayNotifyPreflight.test.ts` (106 tests, no network beyond loopback):

- With an empty environment it checks `www.goapply.top`; `--origin` wins in both spellings.
- A 401, a 404, an HTML body and a redirect each report `FAIL` with the reason; a timeout and an unreachable host too.
- 503 / 50003 reports `PASS-ROUTE / FAIL-SECRET` (route reached, secret missing).
- `BACKEND_URL` is never read (a recording environment proves which names are read: the two above and no other).
- The resolver equals the server's `resolveAlipayNotifyOrigin(getBrand('goapply'), env)` for a table of 32 environments (origin, source and ignored-override reason), and the path and the override name equal the server's constants.
- Carry-over M2 MKT-3H.1: the script fails whenever `ignoredOverride` is set, **with or without `--origin`**, sends nothing, names the host the server would use instead, and never prints the ignored value.
- Started as a command by its real path, through a link to the file and through a link to its directory: the same exit codes and output.
- The last block runs the script, with the real `fetch`, against the real billing router and `handleAlipayCallback` on a loopback port: `PASS` with a secret set, `PASS-ROUTE / FAIL-SECRET` without, `PASS` under the kill switch and inside an open secret-less window, and the order table is never read.

**Where the script differs from the item, and why (evidence in the code):**

1. **400 / 40001 is not `PASS`.** The item (and `MARKET_STRATEGY.md` 5.3, cut-over step 2) lists "40001 with HTTP 400" as our answer. This code never gives it to a request without the secret: `verifyCallback` (`rails/alipayWorker.ts`) asks for the secret before it looks at the parameters, so the answer is 403 / 40003 with a secret set and 503 / 50003 without one (PAR-6 finding "the secret checked before the parameters"; rule A2 as tested). 400 / 40001 to this request is what `main` answers when no secret is set on its host (`main:server/src/roboapply/routes/billing.ts` lines 130 to 149: `alipayCallbackSecretOk` returns true with no secret, then the missing parameters give 40001). Accepting it would pass exactly the host correction C1 exists to keep out. It is reported as `PASS-ROUTE / FAIL-HANDLER`, exit 1.
2. **`PASS` also needs the `X-RA-Brand` response header.** `main` with a secret set answers the same 403 / 40003 body as this code. The header is put on every response by this code's brand middleware (`platform/brand/brandContext.ts`) and `main` has no such middleware. Without the header: `PASS-ROUTE / FAIL-HANDLER`, with the `curl` line to check by hand. Risk: a proxy that strips response headers makes a correct deployment report this result; the runbook says so.
3. **Every redirect is `FAIL`,** not only one to another host. Whether the worker follows a redirect, and keeps its parameters when it does, is not known (D3), so a notify must not depend on it.

Additions the item does not name: `http://` is accepted for a loopback host only (so the runbook can be tried on a stub); a `--origin` that carries a path, a query or credentials is a usage error and the value is never echoed (a pasted notify URL holds the secret); a `CN_BACKEND_URL` the worker could not call is a `FAIL` without a request; a 404 `brand_unavailable` names `ALLOWED_BRANDS` / `BRAND_LOCK`; a line under every `PASS` says what one request cannot prove.

### 2. [P0] Alipay cut-over runbook: done

`docs/jobright-clone/market/ALIPAY_CUTOVER.md`. Sections: the day on one page; what must be true before the day; the environment table for the test deployment and production, with 2.1 on making the test host a GoApply site; the boot lines to read; the five steps of strategy 5.3 with commands; what the captured callback decides; the form to attach; rollback; rules A1 to A12 with the test file that pins each; trying the script on a stub; what was measured and what is assumed.

ACCEPT, document part:

- **Every command runs as written.** Run here: the stub and the script (section 8, output pasted from the run, including the ignored-override command), the A-test command (5 files, 199 tests), the script test command (106 tests), the form of the recovery command against a loopback listener with a made-up value. Not run: `vercel env ls production`, the two `curl` lines against a deployed host and the recovery command with a real secret (owner steps).
- **Every variable exists in the code:** `ALIPAY_CALLBACK_SECRET`, `CN_ALIPAY_NOTIFY_ORIGIN`, `CN_BACKEND_URL`, `CN_PAYMENT_COLLECTING_ENTITY`, `CN_PAYMENT_REQUIRE_ENTITY`, `CN_ALIPAY_PACKAGE_ID_MODE`, `CN_PAYMENTS_ENABLED`, `ALIPAY_SECRETLESS_UNTIL`, `ALIPAY_API_URL`, `CN_ALIPAY_PLATFORM`, `ALLOWED_BRANDS`, `BRAND_LOCK`, and since the review `BRAND_HOST_MAP`, `BRAND_FORCE`, `CN_CANONICAL_ORIGIN`. Each was read in `alipayWorker.ts`, `origins.ts`, `flags.ts`, `planCatalog.ts`, `brand/runtime.ts`, `brand/registry.ts`, `lib/brand/runtime.ts` or `proxy.ts`.
- **Nothing made up:** no entity name, no licence number, no secret. The one price is the catalog default (会员周卡, 1200 fen). The cashier's order lifetime is stated as not known.
- **It says which answers decide G9 and G10** (section 4.4): G9 by the `total_amount` value of the captured callback (present or not, decimal point or not, 12 / 12.00 / 1200), with the two log lines that answer it when the raw value cannot be had; G10 by whether order creation succeeded with `CN_ALIPAY_PACKAGE_ID_MODE` unset.
- Carry-over M2 MKT-3H.2: the boot lines under `RA_BILLING` and the secret-less window facts are in sections 3 and 4.1, word for word from the code.

**Where the runbook differs from the item:**

- **"Capture the worker's raw callback from the request log": the application has no such log.** Nothing in `server/src` logs a request's method, query or body (`app.ts` has no request logger; the callback route logs only the answer code and the order number, the latter from the query only). The runbook therefore names the two sources that exist (the worker's own log of the notify it sent, which is the only one that certainly has the body; the request log of the platform in front of the application), tells the operator to redact `cb`, and lists what the application's own log lines settle without the raw request. One case stays open without the raw callback: a yuan amount that matches and an amount that was not sent at all both leave no log line. See Requests (owner).
- **Step "record the refund in the admin console"** is marked "available after phase M4" and written from the contract in `MARKET_TASK_PLAN.md` 3.1 (MKT-4B, MKT-4C), as the item asks.
- **The pre-flight result table follows the script,** so it carries the departures of item 1, and section 4.2 states the difference from strategy 5.3 step 2 in the document itself.
- Added: what `PASS` does not prove (same database, same secret value); how to read the `brand:` line; how the test host becomes a GoApply site and where the cashier returns the buyer (2.1); a recovery step for the one supervised order when the owner paid and the order did not activate (the notify sent by hand, the secret fed on standard input); a warning not to remove the secret as a way to stop sales.

### 3. [P1] Stripe test-mode recipe and scenario list: done, with one scenario that cannot be run as written

`docs/jobright-clone/market/STRIPE_TEST_RECIPE.md`. Unchanged by the review. Sections: safety; the two owner steps; what appears with no setup; test cards; the scenario pass (base rows 1 to 13 and 10a, renewals and dunning, how to replay, rows a to i from the M2 handoffs); going live; where to look; what was checked.

ACCEPT:

- **Commands and URLs match the merged code:** ports 4621 / 3621 (`scripts/dev-clone.sh`), the webhook path (`STRIPE_WEBHOOK_PATH`), the variable names (`stripeEnv.ts`), the live endpoint on RoboApply's canonical origin.
- **The event list equals `EXPECTED_STRIPE_EVENTS`:** compared by a one-off script, 14 of 14 in the same order. A comment in the document names the constant.
- **The prices printed are the catalog defaults** (`ROBOAPPLY_DEFAULT_PRICE_USD_CENTS`: 999, 2499, 5499, 999, 999, 2499; students 1749, 3799).
- **No live key, no secret, no real customer.**
- Carry-over M1 MKT-3H.1 (test keys only outside production, restricted-key write on Products and Prices, never archive an `ra_…_incl` price, nothing seen against Stripe) and M2 MKT-3H.3 (the secret list, the eight new event types, portal and webhook-endpoint permissions, scenarios a to i, the two error-level log lines): all in.

**Where the recipe differs from the item:**

- **Scenario "a renewal failure with a test clock" cannot be run against the merged code.** A Stripe test clock holds only customers created under it; `ensureCustomer` (`rails/stripe.ts`) creates the customer itself with no `test_clock`, and nothing reads `STRIPE_TEST_CLOCK_ID` (planned in `PAYMENTS_AUDIT.md` B5 and B6, never built: `grep -r STRIPE_TEST_CLOCK_ID server/src` is empty). The recipe says so, gives the steps for when the variable exists, and a stand-in for today (`billing_cycle_anchor=now` after replacing the card) with its limit stated: it can show the failed-payment and action-required paths if Stripe marks the subscription past due, and it cannot show a real renewal. See Requests (orchestrator).
- **Three things are not built until M4** and are marked so: the admin refund action (row 10a), the withdrawal routes (row 11 and row i), the admin "Stripe" readout (section 7). Until then section 7 lists the log lines that say the same.
- **Added from the code:** `NEXT_PUBLIC_ROBOAPPLY_URL` must be `http://localhost:3621` for this stack, because Checkout's success and cancel URLs and the portal's return URL are built from it (`appOrigin`); `.env.example` carries the main checkout's 3611. With the wrong value Stripe returns the buyer to another stack or to production and the return-page reconcile never runs. I did not open `.env`, so I do not know its value: the recipe gives the `grep` to check it.
- **Restricted-key table:** written from the Stripe calls the code makes (`grep` over `server/src`). Two rows are not in the item's list: Payment Intents read and Charges read (`paymentIntents.retrieve`, `charges.retrieve`, `charges.list` in the refund engine and the Taiwan revenue report). The Dashboard's permission names were not checked.
- **Event API version:** events forwarded by the CLI and events of the Dashboard endpoint carry the endpoint's API version; the SDK here sends `2026-09-30.endive`. The recipe asks for that version on the live endpoint. Not an item requirement; it follows from the handlers reading version-dependent fields.

## Files changed

All new (untracked), all inside my owns. The first three were changed in this review pass; the fourth was not.

- `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-3H/scripts/alipay-notify-preflight.mjs`
- `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-3H/__tests__/scripts/alipayNotifyPreflight.test.ts`
- `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-3H/docs/jobright-clone/market/ALIPAY_CUTOVER.md`
- `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-3H/docs/jobright-clone/market/STRIPE_TEST_RECIPE.md`
- outside the worktree, as instructed: this handoff, `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-3H.md`

## Tests run

All after the review fixes.

| Command | Result |
|---|---|
| `npx vitest run __tests__/scripts/alipayNotifyPreflight.test.ts` | 1 file, 106 passed (93 before the review) |
| `npx vitest run server/src/roboapply/routes/billing.test.ts server/src/platform/billing/rails/rails.test.ts server/src/platform/billing/fulfilPass.test.ts server/src/roboapply/services/RoboApplyBillingService.alipay.test.ts server/src/platform/billing/integration/RoboApplyBillingService.stripe.test.ts` (the A-rule files, the command of the runbook) | 5 files, 199 passed |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 |
| `npm run eval:match -- --enforce M2` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | 715 files: 714 passed, 1 failed. 17,203 tests: 17,188 passed, 4 failed, 1 skipped, 10 todo. The 4 are the pre-existing date failure below. |
| the stub and script commands of `ALIPAY_CUTOVER.md` section 8, as written | `PASS`, exit 0; with an ignored override in the shell `FAIL … Nothing was sent.`, exit 1; after `kill $STUB` `FAIL … (ECONNREFUSED)`, exit 1; a bare host as `--origin` exit 2 |
| by hand, through a linked `scripts` directory | `--bogus` exit 2 with the usage line; `--help` exit 0 with the usage line; a dead port `FAIL`, exit 1; the same with `--preserve-symlinks --preserve-symlinks-main` |
| by hand, the recovery command's form against a loopback listener | the listener received `pay_status`, `out_trade_no` and `cb=<value, URL-encoded>` in the query |

`extension/` and `interview-agent/` not touched.

## Red tests for other bundles

None. Nothing I changed is imported by any test but my own.

## Pre-existing failures

**`components/features/copilot/__tests__/cards.test.tsx`, 4 tests, red on every worktree of this base since 2026-10-11T08:00:00Z** (`filter_diff … CountView counts render as numbers`, `the server's real 409 …`, `the remember tool's own card on GoApply …`, `propose_filter_change: the card previews the ops and offers Apply changes`). Not caused by this bundle: my diff is four new files that the test does not import.

Cause, read in the files: `components/features/copilot/__tests__/wireCards.ts` line 199 gives its proposals `expiresAt: new Date(NOW.getTime() + 86_400_000)` and `NOW` is the fixed `2026-10-10T08:00:00.000Z` (`server/src/features/copilot/__tests__/areaFakes.ts` line 13). The card compares that instant with the real clock, so since 08:00 UTC today it renders "This suggestion expired. Ask again for a fresh one." and the buttons the tests look for are gone. MKT-3F and MKT-3G report the same four tests with the same cause.

## Requests

**Orchestrator**

1. **Before the M3 gate: the expired copilot fixture** (above). No M3 bundle owns the file. In `components/features/copilot/__tests__/wireCards.ts` line 199 use a far instant, as line 271 of the same file already does: `expiresAt: new Date('2099-01-01T00:00:00.000Z')`. Every bundle's full suite is red on it until then.
2. **`STRIPE_TEST_CLOCK_ID`, so the renewal and dunning rows of the Stripe pass can be run** (`server/src/platform/billing/rails/stripe.ts`; no owner after M2). In `ensureCustomer`, add to the `customers.create` parameters, only for a test key: `...(stripeKeyMode(env) === 'test' && env.STRIPE_TEST_CLOCK_ID?.trim() ? { test_clock: env.STRIPE_TEST_CLOCK_ID.trim() } : {})` (pass `env` into `ensureCustomer`; import `stripeKeyMode` from `../stripeEnv.js`). Tests in `rails/stripe.checkout.test.ts`: with a test key and the variable the create call carries `test_clock`; with a live key, or without the variable, it never does. Then one line in `.env.example` (MKT-5H) and the note in `STRIPE_TEST_RECIPE.md` 5.2 loses its "once it is honoured". Without it rows 8, 9 and i of the pass rest on a stand-in that does not exercise a real renewal.
3. **At the M4 gate, re-read three places of my two documents against what MKT-4A, MKT-4B and MKT-4C built** (the documents have no owner after M3): `ALIPAY_CUTOVER.md` 4.3 g (the CN refund record), `STRIPE_TEST_RECIPE.md` 5.1 rows 10a and 11 and section 7 (admin refund, withdrawal routes, the Stripe readout). They are written from the contract rows of `MARKET_TASK_PLAN.md` 3.1 and say "available after phase M4"; remove that mark, or correct the path, when the code exists.

**MKT-5H** (final pass over the plan documents)

4. `MARKET_STRATEGY.md` 5.3, cut-over step 2: "must return our JSON (`{"code":40003,…}` with HTTP 403, or 40001 with HTTP 400)". Remove "or 40001 with HTTP 400" and add "with the `X-RA-Brand` response header; 503 / 50003 means the route is reached and the secret is missing". Reason under item 1. The same sentence in the item text of this bundle is superseded by the runbook.
5. `PAYMENTS_AUDIT.md` B5 and B6 still name `STRIPE_TEST_CLOCK_ID` as if it existed; mark it "not built" unless request 2 is done.
6. No new variable from this bundle for the env examples.
7. New since the review: `MARKET_STRATEGY.md` 5.3 cut-over step 2 ("On the deployment used for the test, set `CN_ALIPAY_NOTIFY_ORIGIN` …") could point to `ALIPAY_CUTOVER.md` 2.1: the test host must also resolve to GoApply, and the cashier's return address is GoApply's app origin, not the test host.

**Owner**

8. The decisions the runbook waits for are unchanged from `MARKET_STRATEGY.md` section 7 items 5 to 8a: whether production has `ALIPAY_CALLBACK_SECRET` today, the merchant's legal name, the supervised order, the M-18 default, the notify origin.
9. **Who can give the raw callback.** The application cannot (see item 2). Please name who operates `worker.gohire.top` and can read its log of the notify it sent, before the day.
10. **Optional, your call because the plan forbids any further edit of `alipayWorker.ts`:** one additive, secret-free log line in `verifyCallback` would make the capture self-contained: the method, which parameter names arrived in the query and which in the body, and the shape of `total_amount` (digits with a decimal point, digits without, absent), never a value of `cb`. It would close the one case the logs cannot tell apart today. It needs the method passed into `CallbackInput`, which the frozen callback route builds, so it is not free: say if you want it and the orchestrator can plan it after the supervised order shows whether it is needed.
11. `NEXT_PUBLIC_ROBOAPPLY_URL` in the clone `.env` should be `http://localhost:3621` before the Stripe pass (item 3).
12. New since the review: **choose the test deployment's host before the day.** The simplest is an alias under `goapply.top` (it is a GoApply site with nothing to configure). Any other host needs `BRAND_HOST_MAP=<host>=goapply` or a GoApply-only deployment (`ALLOWED_BRANDS=goapply`); `ALIPAY_CUTOVER.md` 2.1.

## Schema requests

None.

## Env variables added or redefined

None. The script reads `CN_ALIPAY_NOTIFY_ORIGIN` and `CN_BACKEND_URL` from the operator's shell, with the server's meaning. `STRIPE_TEST_CLOCK_ID` is requested above, not added.

## i18n keys added or changed

None (no namespace owned; no user-facing copy).

## Carry-over

| Entry | State |
|---|---|
| `waveM1-carryover.md` MKT-3H.1 (what `STRIPE_TEST_RECIPE.md` must say) | Done: sections 1, 2, 3 and 6.3. The "one webhook secret" sentence is replaced by the list rule, as `waveM2-carryover.md` MKT-3H.3 directs. |
| `waveM2-carryover.md` MKT-3H.1 (resolver, path, fail on `ignoredOverride`) | Done: mirrored rule with a parity test against the server's function; the script imports no server code. Since the review the fail has no exception: with `--origin` too. |
| `waveM2-carryover.md` MKT-3H.2 (boot lines and window facts in the runbook) | Done: sections 3, 4.1, 4.3 c and 4.4. |
| `waveM2-carryover.md` MKT-3H.3 (events, permissions, scenarios a to i, log lines) | Done: sections 5.4, 6.1 and 6.3. |
| `wavePAR-carryover.md`, Market waves, job sources 1 to 7b | Left: none names a file of mine. |
| `wavePAR-carryover.md`, payments 8 to 12 | Left: none names a file of mine (8 was MKT-2A's and MKT-2B's and is built; 9 and 10 were closed at the M2 gate; 11 and 12 are MKT-4A's). |

## Known gaps

- **The script was not run against `https://www.goapply.top` or any deployed host.** My permitted external requests in this phase are the public job-board and open-data endpoints only. Its first real run is the operator's, in step 2 of the runbook.
- **`PASS` proves the route, this code and that a secret is set.** It cannot prove that the host reads the database that creates the orders, or holds the same secret value: the supervised order does.
- **The `X-RA-Brand` requirement assumes proxies pass response headers through.** A deployment behind one that strips them reports `PASS-ROUTE / FAIL-HANDLER`; the runbook gives the `curl` check and says to confirm the deployment another way.
- **An ignored `CN_ALIPAY_NOTIFY_ORIGIN` in the shell now stops every run,** also when the variable is a leftover that has nothing to do with the deployment being checked. That is deliberate (the script cannot tell the two apart); the result line says to unset it.
- **The entry check returns "not the command" when a real path cannot be read** (the file was removed while starting, or the path is unreadable). Node could not have loaded the script in that case, so no silent exit 0 follows from it that I can construct.
- **None of the four ways to make a host a GoApply site (runbook 2.1) was tried on a deployment.** They are read from the code. The preview override by query was not tried with a real checkout: that the order is then a GoApply order and its notify is handled follows from `resolveBrandFromRequest` and from `handleAlipayCallback` not reading the brand of the request.
- **The recovery command was checked for its form only** (what `curl` sends, on a loopback listener, with a made-up value). It was not sent to the callback route with a real secret. A secret that holds a space is sent as `+`, which the server's query parser reads back as a space.
- **Everything about the GoHire worker is assumed:** that it calls `notify_url` unchanged, its method, where it puts parameters, the unit of `total_amount`, whether it validates `package_id`, whether it follows redirects, its retry behaviour and the cashier's order lifetime.
- **No Stripe CLI command of the recipe was run.** They are written from `PAYMENTS_AUDIT.md` B6 (which read Stripe's testing page) and from general knowledge of the CLI; the recipe marks the ones that are assumptions (`billing_cycle_anchor=now`, the test-clock helper commands, `--latest`, the Dashboard's "Run simulation" and its permission names).
- **Every "Expected" of the scenario pass is the behaviour of the code on a fake client,** not something seen. The recipe says so at the top and per row where it rests on SDK typings alone.
- **The event list in `STRIPE_TEST_RECIPE.md` is a copy** with a comment naming the constant; no test holds the two together (the item asks for a document without a test, and the only test file I own is the script's).
- The runbook's local development-stack command (`--origin http://localhost:4621`) is expected from the loopback test of the same route; the development stack was not started.
