# MKT-2A

Alipay, additive only: wire parity with production and callback tolerance (AL-3, AL-4). Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-2A`, branch `wp/MKT-2A`. Nothing committed, pushed or stashed. No schema change, no new dependency, no dev server, no browser, no call to a real provider or database (fetch is a stub, the database is `createFakePrisma`).

All five items are done and the four review findings are resolved (three in code, one as a Request because the file is outside my owns). The whole suite is green: 678 files, 15,853 tests (base 675 / 15,702; this bundle adds 3 files and 151 tests). Both typechecks and `npm run check` pass. All 55 tests named `A<n> …` pass unedited.

Handoff file (same text): `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-2A.md`

Read first:
- **The secret-less window now accepts production's orders only** (review finding 1). A callback with no `cb` is accepted only for an Alipay row with `brand = null`, created before the instant, inside the 7 days. An order this code created (GoApply Alipay, WeChat Pay) is never fulfilled without the secret, whatever its age and whatever the instant says. This is narrower than the literal text of G4 ("an order created before `ALIPAY_SECRETLESS_UNTIL`") and matches its stated purpose ("orders production created before the cut-over"). No schema change: production's table has no `brand` column and its code writes none; this code writes `brand` on every order (`alipayWorker.ts`, `wechatpay.ts`), and no code path sets `brand` on an existing row.
- **O-1 is now needed at the gate, not optional** (review finding 4). `server/src/platform/startup.ts` is outside my owns. Without it, a runtime that loads `.env` inside the entry point (local `server/src/app.ts`) first prints the default notify host at import and the true one on the first GoApply plans read. Deployed runtimes are not affected. The exact line is under Requests.
- **Five pre-existing assertions were adapted, not three.** Item 1 names three in `rails/rails.test.ts`. Two more non-A tests pinned the same value (`body` equal to the subject when no entity is set). Both are in my owns, neither is an A-test, and both pin a value G6 changes on purpose. The list is under item 1.
- **One choice beyond the item text (secret-less window):** a database failure while reading the order inside a live window is thrown (HTTP 500 / 50001, the worker retries), not answered as `bad_secret`. A 403 could be final for a buyer who did pay. Nothing is fulfilled either way.
- **`ALIPAY_SECRETLESS_UNTIL` must be a full ISO instant with a zone** (`2026-10-20T08:00:00Z` or `2026-10-20T16:00:00+08:00`). Anything else names no instant: the window stays closed, and that is now a warning at startup (review finding 2), not only when the first buyer's callback is refused.

## Items

### 1. [P0] Ground rules: done

Run before starting: `npx vitest run server/src/roboapply/services/RoboApplyBillingService.alipay.test.ts server/src/platform/billing server/src/roboapply/routes/billing.test.ts` → 20 files, 469 passed. Same command after the review fixes → 23 files, 620 passed (469 + 151 new). `npx vitest run -t "A[0-9]+ " server/src` → 55 passed, before and after.

`git status` shows no change in `fulfilPass.ts`, `roboapply/routes/billing.ts`, `RoboApplyBillingService.ts`, `fulfilPass.test.ts`, `routes/billing.test.ts` or `platform/startup.ts`. No test named `A<n> …` was edited, renamed, re-ordered or skipped. No answer code of rule A2 was added, removed or renumbered. The `fulfilPass` signature and the rail registration keep their shape: `ensureDefaultRails` holds one added log call (`reportAlipayRailOnce()`, item 2).

Pre-existing assertions edited (none is an A-test; line numbers are those of the file before my change):

| File | Test | Line | Was | Now |
|---|---|---|---|---|
| `rails/rails.test.ts` | `creates a whole-yuan order with the GoApply callback, return URL and collecting entity` | 146 | `/^GAORDER_…/` | `/^RAORDER_20261010080000_user_123_[0-9a-f]{10}$/` |
| `rails/rails.test.ts` | `with ALIPAY_CALLBACK_SECRET alone: a 月卡 order at the catalog price, on the default worker, with cb on the notify URL` | 165 | `toMatchObject({ …, body: 'GoApply 会员月卡' })` | the same match without `body`, plus `not.toHaveProperty('body')` (**not named in item 1**) |
| `rails/rails.test.ts` | `creates the order without an entity: the body is the subject alone and every other field is unchanged` | 197, 206, 209, 210 | title; `b.body` equals the subject; same key list; same values with `body` nulled | renamed `… no body is sent and every other field is unchanged`; `b` has no `body` key; `Object.keys(b)` equals `Object.keys(a)` without `body` (same order); every other value equal |
| `rails/rails.test.ts` | `never borrows another brand's entity: only CN_PAYMENT_COLLECTING_ENTITY names GoApply's` | 236 | `body` equals the subject | no `body` key |
| `RoboApplyBillingService.alipay.test.ts` | `with the callback secret alone: a 月卡 checkout creates one AlipayOrder at the catalog price and answers the pay URL` | 125 | `toMatchObject({ …, body: 'GoApply 会员月卡', … })` | the same match without `body`, plus `not.toHaveProperty('body')` (**not named in item 1**) |

### 2. [P0] Notify URL on GoApply's own host; host logged at startup: done

`server/src/platform/billing/origins.ts`:
- `resolveAlipayNotifyOrigin(brand, env)` (pure) returns `{ origin, source, ignoredOverride }`. GoApply: `CN_ALIPAY_NOTIFY_ORIGIN` when it is an https origin → `CN_BACKEND_URL` (read with `brandOwnEnv`, so it cannot resolve to the shared `BACKEND_URL`) → `brand.canonicalOrigin` (`https://www.goapply.top`). RoboApply: `callbackOrigin`, unchanged.
- `alipayNotifyOrigin(brand, env, log?)` returns the origin and logs an ignored override once per process and value: variable name and reason (`not_https`, `malformed`, `not_an_origin`), never the value.
- An override is an https origin only: scheme, host, optional port. A path, a query (it would collide with `?cb=`), a fragment or credentials make it invalid.
- `originHost`, `ALIPAY_NOTIFY_ORIGIN_ENV`, and a tests-only reset.
- `callbackOrigin` is unchanged, so WeChat Pay's notify does not read the Alipay override.

`rails/alipayWorker.ts`: `notify_url` uses `alipayNotifyOrigin`; `return_url` stays on `appOrigin`. `logAlipayNotifyHostOnce(env, log?, opts?)` writes one `RA_BILLING` line, host only (no scheme, no query, no secret), silent when the deployment does not serve GoApply, and a fault in it is swallowed:
- nothing ignored → info: `GoApply Alipay notify host: <host> (decided by <CN_ALIPAY_NOTIFY_ORIGIN | CN_BACKEND_URL | the brand origin (no variable set)>)`.
- override set and ignored → **warn** (review finding 3): `GoApply Alipay notify host: <host> (CN_ALIPAY_NOTIFY_ORIGIN is set and ignored: <reason in words>; decided by <CN_BACKEND_URL | the brand origin>)`. "(no variable set)" is printed only when the override really is unset.
- meta: `{ host, source, callbackPath }` plus `ignored: { variable, reason }` when an override was ignored.

`rails/index.ts`: `ensureDefaultRails` calls `reportAlipayRailOnce()` when it registers the Alipay rail (the one added call). That function says the notify-host line and the secret-less window line (item 5). The rail's `isConfigured` calls it again for GoApply and the process environment; a line is repeated only if its answer changed.

ACCEPT, all tested: empty env → `www.goapply.top`; `CN_BACKEND_URL=https://api.goapply.example/` → that host with no double slash; the override wins over `CN_BACKEND_URL`; `BACKEND_URL=https://www.roboapply.io` alone changes nothing; an http or malformed override is ignored and logged; the startup line prints the host and no secret; `return_url` is on the GoApply app origin; `cb` is still URL-encoded.

Tests: `origins.test.ts` (new, 32), `rails/alipayWorker.wire.test.ts` (new, 33; shared with item 3).

### 3. [P0] Request body back to production's shape: done

`rails/alipayWorker.ts`:
- G7: `newOutTradeNo` uses `RAORDER` for both brands (`ALIPAY_ORDER_PREFIX`). Timestamp, first 8 characters of the user id and the 10-hex random part are kept. The comment is corrected. The `brand` parameter stays (as `_brand`) so callers keep their shape.
- G6: `body` is in the payload only when a collecting entity is set (`<subject> · <entity>`, at most 200 characters). With an entity the key sits where it did, after `subject`.
- G10: `alipayPackageIdMode(brand, env)`. Default `package_id` = the plan key. `CN_ALIPAY_PACKAGE_ID_MODE=legacy` (case and blanks ignored; GoApply only) sends `package_id: 'starter'` (`ALIPAY_LEGACY_PACKAGE_ID`) with the plan key in `package_name`. `package_type '1'` and the string `package_price` are unchanged. Any other value is the default.
- Nothing else of rule A5 moved.

ACCEPT, all tested: with no entity the keys sent are exactly `out_trade_no, total_amount, subject, pay_channel, user_name, user_email, user_id, platform, package_data, notify_url, return_url`; `out_trade_no` matches `/^RAORDER_\d{14}_.{1,8}_[0-9a-f]{10}$/` on both brands, with an underscore in the user part; legacy mode sends `starter` and keeps the plan key in `package_name`; the stored row still has `tier 'ra_<planKey>'` and `brand 'goapply'`.

The production fixture in the wire test is labelled SYNTHETIC: it is built from the field table of PAYMENTS_AUDIT §A2, not from a captured request (D3). The supervised first order (AL-8) is what captures one.

One wording note on the ACCEPT line "differs only in … the hosts of notify_url / return_url": the path of `return_url` also differs from production's (`/settings/billing/return` against `/account`). PAYMENTS_AUDIT §A2 already lists that as a web-only difference and no item asks to change it.

### 4. [P0] Callback amount tolerance: done

`rails/alipayWorker.ts` `verifyCallback`, in the item's order:
1. The secret check, as before, before any database access.
2. The parameter check (`pay_status`, `out_trade_no`).
3. `readAlipayTotalAmount(raw, present)` (exported, no database): absent → `null`; not well-formed (letters, a sign, more than two decimals, an exponent, empty, zero, a non-scalar) → `null` and one warning with the order number and the raw value's length; above ¥1,000,000 (`ALIPAY_MAX_PLAUSIBLE_YUAN`) → `null` and the same warning with reason `implausible`; otherwise the yuan reading, exactly as before.
4. The order is read only when the value can be fen (no decimal point, an integer multiple of 100) **and the trade is paid**. One `findUnique({ where: { outTradeNo }, select: { amount: true, amountMinor: true } })` through the rail's own `getDb`. Yuan reading equals the order → that amount; stated number equals the order in fen → the order's amount, with one info log `alipay callback total_amount read as fen`; anything else, no row, or any error (opening the database included) → the yuan reading unchanged. The read is in `try / catch` and never makes `verifyCallback` throw.

Narrower than the item in one place: a closed or waiting trade never reads the order, because nothing checks its amount. This is inside the contract ("reads the order only when …").

Not changed (PAR-6 finding 4): a replay of a paid order that states a genuinely different amount still answers 40004.

ACCEPT, all tested at the rail and at the route: 3900 and 39.00 fulfil a ¥39 order; 40.00 refuses; 39 fulfils; 4000 refuses (40004, pending); `abc` and `-39` fulfil as not stated and are logged; a missing amount fulfils; an unknown order answers 40002; a wrong `cb` is refused with zero reads; 39.00, 39 and none make zero reads and 3900 makes exactly one; when that read throws the yuan reading is returned; a value above ¥1,000,000 is not stated and logged.

Tests: `rails/alipayWorker.callback.test.ts` (new, 73; shared with item 5), `RoboApplyBillingService.alipay.test.ts` (13 new cases in the new block `AL-4 callback tolerance: the route answers`).

### 5. [P0] Secret-less callbacks for pre-cut-over orders, for 7 days: done

`rails/alipayWorker.ts`:
- `ALIPAY_SECRETLESS_WINDOW_DAYS = 7` and `ALIPAY_SECRETLESS_WINDOW_MS`, with the comment the item asks for (now also stating the production-rows rule and why). `alipaySecretlessUntil(env)` parses the variable.
- `verifyCallback`: no secret configured → `not_configured` as before. Secret matches → as before. A callback that carries a `cb` anywhere (query, body or header; an empty one, a JSON `null` and an array count as carried) and does not match → `bad_secret` with no database access. A callback with no `cb` at all → `secretlessCallbackAllowed`, evaluated in this order: the variable names an instant T → `now < T + 7 days` → the callback names an order → the order exists → it is one production wrote and it was created before T. The database is opened only after the first three hold. One read: `findUnique({ where: { outTradeNo }, select: { createdAt: true, brand: true, channel: true } })`.
- `alipaySecretlessEligible(row, until)` (exported, pure) is the one rule: `brand` is null, `channel` is `'alipay'`, `createdAt < T` (strict). Accepted → one warning with the order number and the instant the window closes. An order with a brand or another channel → `bad_secret` and one warning `alipay callback without cb refused: the order was not created by production …` with the order number. Everything else → `bad_secret`.
- Startup report (review finding 2): `alipaySecretlessWindowState(env, at)` (pure: `unset`, `invalid`, `open`, `closed`) and `logAlipaySecretlessWindowOnce(env, log?, opts?)`, once per process and answer:
  - set and not an instant → warn `ALIPAY_SECRETLESS_UNTIL is set and names no instant: the Alipay secret-less window is CLOSED. Write a full ISO instant with a zone, for example 2026-10-20T08:00:00Z or 2026-10-20T16:00:00+08:00` (variable name only, never the value);
  - open → info `Alipay secret-less window: orders created before <T ISO>, closes <T + 7 d ISO>`;
  - closed → info `Alipay secret-less window: closed since <T + 7 d ISO>`;
  - unset → nothing.
  It is not tied to a brand (the orders it is for are production's, and their notifies go to the other brand's host). `reportAlipayRailOnce` calls it at rail registration and on the rail's first use. The warning at callback time is kept.

ACCEPT, all tested: a no-`cb` callback fulfils only an order older than T, and none once 7 days have passed (the last millisecond inside passes, exactly 7 days does not); an order created one second after T, or exactly at T, is refused (403 / 40003); a wrong `cb` is refused inside the window without a database read; no secret configured → 503 / 50003; variable unset, empty or unparseable → nothing changes and no database access.

Added by the review: a GoApply Alipay order, a GoApply WeChat Pay order, an Alipay row that carries the other brand and a WeChat Pay row with no brand, all created before T, are refused inside the window and with T a year in the future, at the rail and at the route (403 / 40003, order pending, no subscription); the production row is still accepted; with the secret the same GoApply order is fulfilled as always. I removed the brand and channel lines once to check the tests: 8 went red, and I restored them.

Tests: `rails/alipayWorker.callback.test.ts` (clock through `deps.now`), two route-level cases in `RoboApplyBillingService.alipay.test.ts`.

### Carry-over

- `waveM1-carryover.md` → `### MKT-2A` entry 1 (= PAR carry-over payments 8, the ten PAR-6 findings):
  - Done: 1 (`RAORDER_`), 2 (`body`), 3 (fen), 5 (secret-less window), 7 (`CN_ALIPAY_NOTIFY_ORIGIN`, host logged), 8 (`package_id` mode).
  - Left on purpose: 4 (amount check before the replay claim: `fulfilPass.ts` is edited by no bundle; item 4 says so); 6 (secret before parameters: the A6 test pins it and no G rule changes it).
  - Not mine: 9 (`/billing/history` capped at 50) is in `RoboApplyBillingService.ts` (MKT-2B in M2, MKT-4B in M4; ST-10); 10 (Stripe webhook brand rule) is MKT-2B item 1.
- `wavePAR-carryover.md` "Market waves" entries 9 to 12 name no file in my owns.

## Review resolution

| # | Severity | Finding | Verdict | What was done |
|---|---|---|---|---|
| 1 | high | The secret-less window also fulfils orders this code created | **Real, fixed.** Verified: `main`'s `AlipayOrder` model has no `brand` column and `main`'s create writes none; this branch's column is `brand String?` and `channel String @default("alipay")`; both writers here set `brand` (`alipayWorker.ts` create, `wechatpay.ts` create); no update path sets `brand` on an existing row. | `alipaySecretlessEligible` (brand null, channel `alipay`, `createdAt < T`); the read selects `{ createdAt, brand, channel }`; comments on the function, the constants and the file header rewritten; a refused own order is logged by order number. Tests: four own-order rows at the rail (inside the window and at its last millisecond), the future-T case, the unit table, the changed `findUnique` assertion, the route-level case `inside the secret-less window an order this code created stays pending without cb: 403 / 40003`. The existing route case's 30-day-old row is now a production row, so it still tests the closing of the window and not the brand rule. |
| 2 | medium | A mistyped `ALIPAY_SECRETLESS_UNTIL` is reported only after it refused a paid order | **Real, fixed.** | `logAlipaySecretlessWindowOnce` and `alipaySecretlessWindowState`, called through `reportAlipayRailOnce` from `ensureDefaultRails` and from the rail's `isConfigured` branch for the process environment. The reviewer's two failing values (`2026-10-20 08:00:00Z`, `…+0800`) are in the test table. The callback-time warning is kept. The accepted format is not widened: a value that is almost an instant is safer refused loudly than guessed. Request to MKT-3H added. |
| 3 | low | The startup line says "(no variable set)" when the override is set and ignored | **Real, fixed.** | The line is a warning and says `CN_ALIPAY_NOTIFY_ORIGIN is set and ignored: <reason>; decided by <source>`. The log parameter type is `{ info, warn }`. `wire.test.ts`: the old assertion is rewritten; added the three reasons, the once-only guard, and the case that the rail's first use warns before any order. |
| 4 | low | With `.env` loaded inside the entry point the first startup line names the default host | **Real; not fixable inside my owns.** `server/src/platform/startup.ts` belongs to no M2 bundle. | Request O-1, now marked needed at the gate, with the exact line (it names `reportAlipayRailOnce`, so the window line comes with it). I did not defer the import-time call with a timer: it would log during other bundles' tests and its order against the entry point is not guaranteed. I kept the import-time call: dropping it before O-1 is applied would remove the startup line on deployed runtimes. |

Undone items: none were reported. Unowned edits: none were reported and `git status` shows none.

## Files changed

All under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-2A/`:
- `server/src/platform/billing/origins.ts` (additive)
- `server/src/platform/billing/origins.test.ts` (new)
- `server/src/platform/billing/rails/alipayWorker.ts` (additive)
- `server/src/platform/billing/rails/alipayWorker.wire.test.ts` (new)
- `server/src/platform/billing/rails/alipayWorker.callback.test.ts` (new)
- `server/src/platform/billing/rails/index.ts` (one log call; new exports)
- `server/src/platform/billing/rails/rails.test.ts` (four non-A tests adapted, table above)
- `server/src/roboapply/services/RoboApplyBillingService.alipay.test.ts` (one non-A assertion adapted; one new describe block appended)

New exports since the first handoff: `alipaySecretlessEligible`, `alipaySecretlessWindowState`, `logAlipaySecretlessWindowOnce`, `reportAlipayRailOnce` (all re-exported from `rails/index.ts`).

## Tests run

| Command | Result |
|---|---|
| `npx vitest run server/src/roboapply/services/RoboApplyBillingService.alipay.test.ts server/src/platform/billing server/src/roboapply/routes/billing.test.ts` (before the bundle) | 20 files, 469 passed |
| same (after the review fixes) | 23 files, 620 passed |
| `npx vitest run -t "A[0-9]+ " server/src` | 9 files, 55 passed |
| `npm run typecheck:server` | pass |
| `npx next typegen && npm run typecheck:web` | pass |
| `npm run check` | pass (exit 0) |
| `npx vitest run --exclude ".claude/**"` | 678 files passed; 15,853 passed, 1 skipped, 10 todo; 0 failed |

## Red tests for other bundles

None.

## Pre-existing failures

None.

## Requests

**Orchestrator**

- **O-1 (needed at the gate; `server/src/platform/startup.ts`, no owner in M2).** Import `reportAlipayRailOnce` from `./billing/rails/index.js` next to `warnIfAlipayEntityUnset`, and add this entry to `DEFAULT_GOAPPLY_MODULE_REPORTS`:
  `(env) => (env === process.env ? reportAlipayRailOnce(env) : null),`
  Reason: the boot report runs after `.env` is loaded, so a runtime that loads `.env` inside the entry point gets the true notify host and the window state at boot. Each line is guarded by its own text, so on a deployed runtime nothing is printed twice. Optional after that: remove the `reportAlipayRailOnce()` call from `ensureDefaultRails` to have one line in local development too (keep the rail's first-use call; adjust the wire test `ensureDefaultRails logs it when it registers the Alipay rail`). Note that the boot reports run only when the deployment serves GoApply, so a deployment that serves RoboApply alone hears about the window from the import-time call; that is one more reason to keep it.
- O-2 (information): on the merged tree, re-run the item 1 command. `routes/billing.test.ts` does not blank `ALIPAY_SECRETLESS_UNTIL`, `CN_ALIPAY_NOTIFY_ORIGIN` or `CN_ALIPAY_PACKAGE_ID_MODE` in its env fixture, so a machine that exports one of them could move an A-test. Nothing sets them today. I did not touch that file (not in my owns, and it holds A-tests).
- O-3 (documents): `MARKET_STRATEGY.md` §5.3 G4 and the `ALIPAY_SECRETLESS_UNTIL` line of the env examples should say "an order production created (a row with no brand)". The code is narrower than the sentence as written; the purpose is the same.

**MKT-3H** (pre-flight script and cut-over runbook)

- Resolve the host with `resolveAlipayNotifyOrigin(getBrand('goapply'), env)` from `server/src/platform/billing/origins.ts` (pure; returns `origin`, `source`, `ignoredOverride`), or mirror its three-step rule if the script must not import server code. The path is `ALIPAY_CALLBACK_PATH`. The script should fail when `ignoredOverride` is set.
- Runbook, boot lines to look for under `RA_BILLING` before the cut-over:
  - `GoApply Alipay notify host: <host> (decided by …)`. If it is a warning that contains `CN_ALIPAY_NOTIFY_ORIGIN is set and ignored`, stop: the override must be a bare https origin, not the callback URL.
  - `Alipay secret-less window: orders created before <T>, closes <T + 7 d>` when `ALIPAY_SECRETLESS_UNTIL` is set. If instead there is a warning `ALIPAY_SECRETLESS_UNTIL is set and names no instant`, the window is closed: fix the format (`2026-10-20T08:00:00Z` or `2026-10-20T16:00:00+08:00`) before cutting over.
- Runbook, facts: the window accepts production's orders only (rows with no brand); a GoApply order always needs the secret. After the supervised order, grep for `alipay callback total_amount read as fen` and `total_amount is not usable` to settle G9, and set `CN_ALIPAY_PACKAGE_ID_MODE=legacy` only if order creation fails on the id. During the window, `alipay callback accepted without cb` lists each order it let through, and `alipay callback without cb refused: the order was not created by production` is somebody trying one of our orders without the secret.

**Owner**

- Unchanged from the plan: say whether production has `ALIPAY_CALLBACK_SECRET` today (decides `ALIPAY_SECRETLESS_UNTIL`), and confirm the notify origin (MARKET_TASK_PLAN lines AL-3 / AL-4).

## Schema requests

None.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `CN_ALIPAY_NOTIFY_ORIGIN` | Bare https origin (scheme, host, optional port) that receives GoApply's Alipay notifies. Set it to another host only when that host runs this code on the same database. Anything that is not an https origin is ignored, and the startup line is then a warning. | unset → `CN_BACKEND_URL` → `https://www.goapply.top` |
| `ALIPAY_SECRETLESS_UNTIL` | Full ISO instant with a zone. A callback with no `cb` at all is accepted only for an Alipay order production created (a row with no brand) before it, and only until 7 days after it. A wrong `cb` is always refused. The state of the window is logged at startup. | unset = never |
| `CN_ALIPAY_PACKAGE_ID_MODE` | `legacy` sends `package_id: 'starter'` and keeps the plan key in `package_name`. GoApply only. | unset = the plan key as `package_id` |

`CN_BACKEND_URL` is not redefined: it is still GoApply's own API origin and now sits second in the Alipay notify chain.

## i18n keys added or changed

None (no namespace owned; no user-facing copy).

## Known gaps

- Nothing here was checked against the real worker. The fen format, whether the worker echoes `cb`, and whether it validates `package_id` are settled by the supervised order (AL-8).
- The production-rows rule rests on `brand` being null on production's rows. If a later migration backfills `AlipayOrder.brand` on old rows before the window closes, those orders stop qualifying and need the secret (the safe direction). Nothing does that today.
- With T in the future, production's own pending orders (no brand) are accepted without `cb` until T + 7 days. That is the purpose of the window and no worse than production without a secret; the startup line prints T so a mistyped year is visible.
- Until O-1 is applied, a runtime that loads `.env` inside the entry point prints the default notify host at import and the true one on the first GoApply plans read; a deployment that serves RoboApply alone and loads `.env` late hears about the window only at the first callback without `cb`.
- `0` and `0.00` are now "not stated" (the item's "greater than zero"), so such a callback with a valid secret fulfils; before, it answered 40004.
- The production request fixture is synthetic (see item 3).
