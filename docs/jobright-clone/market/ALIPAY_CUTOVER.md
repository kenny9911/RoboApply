# Alipay cut-over runbook (GoApply)

**Written:** 2026-10-11, market wave phase M3 (bundle MKT-3H). **Requirement:** AL-8 (`MARKET_STRATEGY.md` section 9.3). **Source of every rule here:** `MARKET_STRATEGY.md` section 5.2 (rules A1 to A12), section 5.3 (G1 to G13 and the cut-over checklist), section 7 items 5 to 8a, and the code on `feat/jobright-clone` as merged at the M2 gate.

**For:** the owner and one operator. The supervised order (step 3) needs the owner present: it spends real money (¥12) and ends with a refund in the Alipay merchant console.

**What this document is not.** It names no merchant, no legal entity, no licence number and no secret value. Where a fact is not known to this repository it says "not known" and says who can answer.

**What was measured and what is assumed** is listed in section 9. Short version: the script and every answer code were run against this repository's own callback route on a loopback port. Nothing here was run against the GoHire payment worker, against `www.goapply.top`, or against any deployed host.

---

## 0. The day on one page

| # | Step | Who | Stops the cut-over when |
|---|---|---|---|
| 1 | Decide the callback secret (section 4.1) | owner | no secret is set on the deployment that will take the order |
| 2 | Make the test host a GoApply site (2.1), set the notify origin of the test deployment and run the pre-flight (4.2) | operator | the result is anything but `PASS`, or the test host does not resolve to GoApply |
| 3 | Buy one 会员周卡 (¥12), capture the callback, confirm activation and the receipt, refund it, record the refund (4.3) | owner + operator | the order does not activate, or the refund cannot be made |
| 4 | Read the captured callback and settle G9 and G10 (4.4) | operator | the amount check refused a paid order |
| 5 | Production: keep roboapply.io where it is, repeat the pre-flight against `https://www.goapply.top` (4.5) | operator | the result is anything but `PASS` |

Kill switch at any moment: `CN_PAYMENTS_ENABLED=false` (section 6).

---

## 1. What must be true before the day

1. **`goapply.top` serves this code and the database that creates GoApply's orders.** The notify from the payment worker goes to GoApply's own host. The callback finds the order by its order number, so the host that receives the notify must read the same database as the deployment that created the order, and must run this code. The pre-flight proves the code half (section 4.2). It cannot prove the database half: only the supervised order does.
2. **`roboapply.io` is not pointed at this code before that** (decision M-18). While `goapply.top` is live on this code, `roboapply.io` still runs `main`. Its callback handler has no amount check, accepts a callback without a secret when none is set there, and does not know GoApply's plans. A GoApply notify must never go there. This is why the notify origin never falls back to `BACKEND_URL` or `www.roboapply.io` (G8).
3. **A callback secret is decided** (section 4.1). Without `ALIPAY_CALLBACK_SECRET` GoApply lists its plans and prices and cannot open a payment: `GET /billing/plans` still carries the amounts but offers no rail (`paymentsOpen` is false), a checkout answers 503 `rail_not_configured`, and every callback answers 503 / 50003.
4. **The owner can refund in the Alipay merchant console**, or knows who can and how fast (section 7 item 6 of the strategy). The rail has no refund call: money goes back by hand.
5. **Someone can read the logs of the deployment** during the order (section 3 and step 3).

Not required for the day: a collecting entity name (it is printed when set and is otherwise absent, G5), a price variable (¥12 is the catalog default, `pro_week_pass` = 1200 fen), `ALIPAY_API_URL` (the worker URL has a default in the rail).

---

## 2. Environment

Every name below is read by the merged code. "Unset" means: leave the variable out.

| Variable | Test deployment (the supervised order) | Production (`goapply.top`) | What it does |
|---|---|---|---|
| `ALIPAY_CALLBACK_SECRET` | **set** | **set**, the same value on every deployment that can receive a notify for an order | The rail's one credential. It is put on every `notify_url` as `?cb=` and compared in constant time on every callback. Unset: no payment can be opened and every callback answers 503 / 50003. |
| `CN_ALIPAY_NOTIFY_ORIGIN` | **the test deployment's own public origin**, for example `https://<public-alias>`. Never `https://www.roboapply.io` while that host runs `main`. | unset when `https://www.goapply.top` serves this deployment's `/api/v1/*` (the default); otherwise the origin that does | Where the worker is told to post the notify. A bare https origin: scheme and host, optional port, nothing else. A value with a path, a query, a fragment or credentials, or on http, is **ignored** and the startup line becomes a warning. |
| `CN_BACKEND_URL` | unset, unless GoApply's API has its own host | as today | GoApply's own API origin. Second in the notify chain: `CN_ALIPAY_NOTIFY_ORIGIN`, else `CN_BACKEND_URL`, else `https://www.goapply.top`. `BACKEND_URL` is never read for GoApply. |
| `CN_PAYMENT_COLLECTING_ENTITY` | unset until the owner supplies the merchant's legal name | the merchant's legal name, once the owner supplies it | Printed on the order `body` and on the receipt. Unset: the order carries no `body` (as production's does) and one warning is logged per process. Never type a name that the owner has not confirmed. |
| `CN_PAYMENT_REQUIRE_ENTITY` | unset | unset | `true` refuses to charge until the entity is named. Off by default. |
| `CN_ALIPAY_PACKAGE_ID_MODE` | unset for the first attempt | set to `legacy` only if step 3 shows the worker refuses the plan key (G10) | Unset: `package_data.package_id` is the plan key (`pro_week_pass`). `legacy`: it is `starter`, production's id, and the plan key stays in `package_name`. |
| `CN_PAYMENTS_ENABLED` | unset | unset | The kill switch. Unset means on. `false` (also `0`, `off`, `no`) stops new orders on both mainland rails. It is not a prerequisite: never set it to `true` "to switch payments on". |
| `ALIPAY_SECRETLESS_UNTIL` | unset | unset, unless section 4.1 case B2 applies | A full ISO instant with a zone (`2026-10-20T08:00:00Z` or `2026-10-20T16:00:00+08:00`). Opens the secret-less window for orders **production** created. See 4.1. |
| `ALIPAY_API_URL` | unset | unset | Overrides the worker URL. The default is `https://worker.gohire.top/payment/payment/create`. |
| `CN_ALIPAY_PLATFORM` | unset | unset | The worker `platform` field. The default is `gohire`, the only merchant the worker has today. |
| `ALLOWED_BRANDS` / `BRAND_LOCK` | unset, or a value that includes `goapply` | unset, or a value that includes `goapply` | Unset already serves both brands. A deployment narrowed to RoboApply answers 404 `brand_unavailable` on a GoApply host, and logs no notify host. |
| `BRAND_HOST_MAP` | `<the test host>=goapply` when that host is not under `goapply.top` (see 2.1) | unset | Extra host to brand pairs, comma separated. Read by the API and by the web. |

A changed variable takes effect when the process starts again (a new deployment, or a restart).

### 2.1 The test host must be a GoApply site

Serving GoApply is not enough: the host the owner opens must **resolve** to GoApply. The brand is decided per request from the host. A host the code does not know, which is every `*.vercel.app` alias and every other custom domain, resolves to RoboApply while the deployment serves both brands. The owner would then see RoboApply's plans in USD with Stripe, and there is no 会员周卡 to buy.

The ways the code offers, in order of preference:

| Way | What to do | What it changes |
|---|---|---|
| **1. A host under `goapply.top`** | Give the test deployment an alias such as `<name>.goapply.top`. | Nothing to configure: `goapply.top`, `www.goapply.top` and every host that ends in `.goapply.top` are GoApply (`brandIdFromHost` in `server/src/platform/brand/registry.ts`). |
| **2. `BRAND_HOST_MAP`** | `BRAND_HOST_MAP=<alias host>=goapply` on the test deployment (the host only, no scheme). | That host is GoApply for every request, on the API and on the web (`parseBrandHostMap` in `server/src/platform/brand/runtime.ts` and `lib/brand/runtime.ts`). |
| **3. A GoApply-only deployment** | `ALLOWED_BRANDS=goapply` on the test deployment. | Every unknown host resolves to GoApply. The deployment no longer serves RoboApply at all: a RoboApply host answers 404 `brand_unavailable`. |
| 4. On a `*.vercel.app` host only | `BRAND_FORCE=goapply` on the deployment, or open the site once with `?__brand=goapply` (it sets the cookie `ra_brand_override` for 7 days in that browser; `?__brand=clear` removes it). | `BRAND_FORCE` covers every request to that host. The query covers **that browser only**: a request without the cookie, such as the pre-flight and the worker's notify, still resolves to RoboApply there. Neither works on a custom domain. |

With way 4 by query the order is still a GoApply order (the checkout request carries the cookie) and the notify is still handled: the callback finds the order by its order number and does not look at the brand of the request. This follows from the code and was not tried on a deployment; prefer ways 1 to 3, where the pre-flight shows the brand (4.2).

**Where the cashier sends the buyer back.** The order's `return_url` is built from GoApply's app origin: `CN_CANONICAL_ORIGIN`, else `https://www.goapply.top` (`appOrigin` in `server/src/platform/billing/origins.ts`). It is not the host the buyer came from. On a test host, expect to land on that origin after paying, and open the test host by hand for steps 4.3 d and e. Activation does not depend on the return page: the notify does it.

---

## 3. Boot lines to read before anything else

The deployment that serves GoApply says where the notify goes when it starts. Search its log for these texts (all under the tag `RA_BILLING`):

| Line | Meaning | Action |
|---|---|---|
| `GoApply Alipay notify host: <host> (decided by CN_ALIPAY_NOTIFY_ORIGIN)` | The override is used. | `<host>` is the host to give the pre-flight. |
| `GoApply Alipay notify host: <host> (decided by CN_BACKEND_URL)` | GoApply's own API origin is used. | Same. |
| `GoApply Alipay notify host: www.goapply.top (decided by the brand origin (no variable set))` | The default. | Same. |
| a **warning** that contains `CN_ALIPAY_NOTIFY_ORIGIN is set and ignored` | The override is not a bare https origin. The server silently uses the next step of the chain. | **Stop.** Write scheme and host only, not the callback URL. Restart and read the line again. |
| `Alipay secret-less window: orders created before <T>, closes <T + 7 days>` | `ALIPAY_SECRETLESS_UNTIL` is set and the window is open. | Check that `<T>` is the instant you meant. A year typed wrong is visible here. |
| `Alipay secret-less window: closed since <T + 7 days>` | The window has closed for good. | Remove the variable at the next deploy. |
| a **warning** `ALIPAY_SECRETLESS_UNTIL is set and names no instant` | The value is not a full ISO instant with a zone. There is no window. | Fix the format before cutting over. |
| a **warning** `GoApply Alipay orders and receipts name no collecting entity` | `CN_PAYMENT_COLLECTING_ENTITY` is unset. | Expected until the owner supplies the name. |

No line at all about the notify host means the deployment does not serve GoApply (`ALLOWED_BRANDS` / `BRAND_LOCK`).

---

## 4. The five steps

### 4.1 Step 1: the callback secret

**Question for the owner: is `ALIPAY_CALLBACK_SECRET` set in Vercel production today?** Names only, never the value:

```bash
vercel env ls production | grep ALIPAY_CALLBACK_SECRET
```

(Run in a checkout that is linked to the production project. The command is Vercel's, not this repository's.)

Two facts from the code decide what follows:

- This code puts `?cb=<secret>` on the `notify_url` of every order it creates, and refuses every callback whose `cb` does not match its own `ALIPAY_CALLBACK_SECRET`. So an order created here is fulfilled only by a deployment that holds the same value.
- `main` builds the same `?cb=` when a secret is set there, and checks nothing when none is set.

| Case | Do |
|---|---|
| **A. Production has the secret.** | Reuse the same value on the test deployment and on `goapply.top`. No window is needed. Do not rotate it on the day. |
| **B. Production has no secret.** Choose a new value (long, random, URL-safe is simplest; it is URL-encoded either way). Then one of: | |
| B1 | Set it on `main` first, wait out the Alipay cashier's order lifetime, then go on. After that wait no pending production order is left without `cb`. *The cashier's order lifetime is not known to this repository: ask whoever operates the GoHire payment worker.* |
| B2 | Do not touch `main`. On the day `roboapply.io` itself moves to this code, set `ALIPAY_SECRETLESS_UNTIL` to that deploy instant. A callback with no `cb` at all is then accepted only for an Alipay order **production** created (a row with no brand) before that instant, and only until 7 days after it. The window closes by itself. |

What the window is not: it never accepts an order this code created. A GoApply order always needs the secret, whatever its age. For the GoApply cut-over alone (`roboapply.io` still on `main`) the window changes nothing, because production's notifies still go to `main`.

While a window is open, two log lines tell what happens: `alipay callback accepted without cb` lists each order it let through; `alipay callback without cb refused: the order was not created by production` is somebody trying one of our orders without the secret.

### 4.2 Step 2: the notify origin and the pre-flight

1. On the deployment used for the test, set `CN_ALIPAY_NOTIFY_ORIGIN` to that deployment's own public origin. A notify sent to production would not find the order, or would be handled by `main`'s code.
2. Start the deployment and read the boot line of section 3. Note the host.
3. **Before any order**, from a machine outside the deployment's network (the worker reaches the host from the public internet, so the check must too):

```bash
node scripts/alipay-notify-preflight.mjs --origin https://<the host of the boot line>
```

Without `--origin` the script resolves the host with the server's own rule from the variables of the shell it runs in (`CN_ALIPAY_NOTIFY_ORIGIN`, else `CN_BACKEND_URL`, else `https://www.goapply.top`). Your shell rarely holds the deployment's variables, so give `--origin`.

One variable of the shell counts even with `--origin`: a `CN_ALIPAY_NOTIFY_ORIGIN` that the server would ignore (not a bare https origin). The script then stops with `FAIL` before any request and does not check the host you gave. If the shell holds the deployment's variables, the deployment ignores the same value and sends the notify to the next step of the chain, which is not the host you typed; a `PASS` for that host would be worth nothing. Fix the variable on the deployment, or unset it in the shell when it is not the deployment's, and run again.

What the script does: one `GET <origin>/api/v1/roboapply/billing/alipay/callback` with no parameters, no order number and no secret; redirects are not followed; 10 seconds limit. It creates nothing and reads no order. It never reads, sends or prints the callback secret. It is safe to run against production.

| Result | Exit code | Meaning | Action |
|---|---|---|---|
| `PASS` | 0 | HTTP 403 with `{ "code": 40003 }` and the `X-RA-Brand` response header: this code answered and a callback secret is set on that host. | Go on. |
| `PASS-ROUTE / FAIL-SECRET` | 1 | HTTP 503 with `{ "code": 50003 }`: the route is reached, `ALIPAY_CALLBACK_SECRET` is not set there. | Set the secret, restart, run again. |
| `PASS-ROUTE / FAIL-HANDLER` | 1 | The callback route answered, but not as this code does: HTTP 400 with `{ "code": 40001 }`, or 403 / 40003 without the `X-RA-Brand` header. That is what `main` answers (40001 when no secret is set on its host, 40003 without the header when one is). | **Stop.** This host does not run this code. Do not send GoApply notifies to it. |
| `FAIL` HTTP 401 | 1 | The host asks for a login before our code runs. A Vercel preview behind Deployment Protection answers 401 to the worker too. | Use a public domain alias, or switch protection off for that deployment. |
| `FAIL` HTTP 404 | 1 | The host does not serve the callback route. `brand_unavailable` in the answer means this code runs there and the deployment does not serve that host's site. | Fix the host, or `ALLOWED_BRANDS` / `BRAND_LOCK`. |
| `FAIL` an HTML page | 1 | Another site or a gateway answered. | Fix the routing of `/api/v1/*`. |
| `FAIL` a redirect | 1 | The exact address does not answer. Whether the worker follows a redirect is not known, so the notify must not depend on it. | Use the final host as the origin. |
| `FAIL` no answer, or the request failed | 1 | Timeout, DNS, refused connection or TLS. | Fix reachability. |
| a usage error | 2 | `--origin` is not a bare origin. Nothing was sent. The value is never repeated, because a pasted notify URL would carry the secret. | Give scheme and host only. |
| `FAIL` before any request | 1 | With or without `--origin`: the shell holds a `CN_ALIPAY_NOTIFY_ORIGIN` the server would ignore. The result names the host a deployment with that value would use instead, and never prints the value. Without `--origin` only: a `CN_BACKEND_URL` that is not a plain origin. | Fix the variable, or unset it in this shell when it is not the deployment's. Run again. |

**Read the `brand:` line too.** It is the `X-RA-Brand` header of the answer: the brand that host resolves to for a request without a cookie. For the test host of step 3 it should read `goapply (X-RA-Brand)`. `roboapply` there does not change the result (the callback does not depend on the brand of the request), but it means the site the owner opens on that host is RoboApply: go back to section 2.1 before step 3. For a production notify origin that is deliberately another host of this code (4.5 item 5) `roboapply` is expected.

**Start the script by its path, in any way.** It runs the same through a linked directory or a linked file (a checkout under a linked folder, a path under `/tmp` on macOS). It always prints a `result:` line or a usage line. No output at all is never a pass: check that the path is the script.

**What `PASS` does not prove** (the script prints this under every `PASS`): that the host uses the same database, or holds the same secret value, as the deployment that creates the orders. One request without an order number and without the secret cannot show that. Step 3 does.

**Where this differs from the strategy text.** Section 5.3 step 2 of `MARKET_STRATEGY.md` lists "`40001` with HTTP 400" as an acceptable answer. This code never gives that answer to a request without the secret: it asks for the secret first (403 / 40003 with a secret set, 503 / 50003 without one). 400 / 40001 to this request is `main`'s answer when no secret is set on its host. Accepting it would pass exactly the host correction C1 exists to keep out, so the script reports it as `PASS-ROUTE / FAIL-HANDLER`. For the same reason `PASS` also asks for the `X-RA-Brand` header, which this code puts on every response and `main` does not.

The same check by hand, when Node is not at hand:

```bash
curl -si https://<host>/api/v1/roboapply/billing/alipay/callback
```

Expect `HTTP/… 403`, a header line `x-ra-brand: …` and the body `{"code":40003,"message":"forbidden"}`. If a proxy in front removes the header the script cannot tell this code from `main`: confirm the deployment another way before going on.

### 4.3 Step 3: the supervised order (owner present)

Have the form of section 5 open and fill it as you go.

**a. Buy one 会员周卡 (¥12).** On the test deployment's GoApply site (section 2.1: the host must resolve to GoApply; if the plan sheet shows USD plans, it does not), signed in as the owner's own account, open the plan sheet, choose 会员周卡, pay with Alipay (the first and default rail).

- The log line `alipay order created` carries `outTradeNo` (it starts with `RAORDER_`), `planKey: pro_week_pass`, `amountYuan: 12` and `brand: goapply`. Write the order number on the form.
- If the cashier does not open and the log shows `alipay worker error` (with the worker's `code` and `message`) or `alipay worker non-JSON response`: the worker refused the request. No order row was written here and the buyer never reached the cashier. If the worker's message is about the package id, set `CN_ALIPAY_PACKAGE_ID_MODE=legacy`, restart, and try again. **This is the answer that decides G10.** Any other message: stop and take it to whoever operates the worker.
- A second attempt within a short time can answer 429 `rate_limited` (the per-user order limit). Wait for the stated seconds.

**b. Pay ¥12 in the Alipay cashier.**

**c. Capture the worker's raw callback: method, query and body.**

The application itself does not log requests, and it never logs a query string or a body. So the raw callback has to come from one of these, in order of preference:

1. **The worker's own log** of the notify it sent for this order number: method, URL and body. Ask whoever operates the GoHire payment worker. This is the only source that certainly has the body.
2. **The request log of the platform in front of the application** (the hosting platform's request log, or the access log of the proxy or ingress), filtered on the path `/api/v1/roboapply/billing/alipay/callback` and the time of the payment. It shows the method and, when the platform records it, the query string. It does not show a request body.

**Redact before you attach anything:** the query contains `cb=<the secret>`. Replace the value with `REDACTED` in every copy. Never paste the secret into the form, a ticket or a chat.

What the application's own log says about the same callback (search for the order number):

| Log line | Meaning |
|---|---|
| `pass fulfilled` with `outTradeNo`, `planKey`, `brand: goapply`, `channel: alipay` | The notify arrived, `cb` matched, the amount was accepted or was not stated. The order is `completed`. |
| `alipay callback total_amount read as fen` | The worker stated the amount in fen (`1200` for ¥12). It was accepted. |
| `alipay callback total_amount is not usable: treated as not stated`, with `reason` and `rawLength` | The amount was malformed or implausible. It was ignored, the order was still fulfilled. |
| `alipay callback refused` with `code: 40003` | The notify arrived without the right `cb`: the worker did not send the secret back, or the deployment that answered holds another value. |
| `alipay callback refused` with `code: 40004`, and `fulfilPass: paid amount does not match the order` with `expected` and `paid` (both in fen) | A real mismatch. The order stays `pending`. `paid` shows what the worker stated, read as yuan. |
| `alipay callback refused` with `code: 40002` | The order number is not in this database: the notify reached a deployment on another database. |
| no line that names the order | Either the notify did not reach this deployment (look at the platform's request log and at the notify host), or it was refused and its parameters were in the body: an `alipay callback refused` line at the time of the payment with no `out_trade_no` is then this notify. |

In `alipay callback refused` the field `out_trade_no` is taken from the query only. When it is missing there, the worker sent its parameters in the body.

**d. Confirm activation.** The return page (`/settings/billing/return`) shows the plan once the notify is handled. The cashier returns the buyer to GoApply's app origin (section 2.1), so on a test host that is not that origin open `https://<test host>/settings/billing/return` by hand. The account now has 7 days of Pro. Write the time on the form.

**e. Confirm the receipt.** `/settings/billing/history` lists the order; its download is the receipt. It names the brand and the payment method, and the collecting entity only when `CN_PAYMENT_COLLECTING_ENTITY` is set.

**f. Refund ¥12 in the Alipay merchant console.** By hand, by the owner or the person named in section 7 item 6 of the strategy. Write the console's refund reference on the form.

**g. Record the refund in the admin console.** Requirement AL-7, built in phase M4 (server: bundle MKT-4B; console: bundle MKT-4C; the two were held together at the M4 gate, `__tests__/contracts/billingM4.seam.test.ts`). In the console: open `/admin/credits`, section "Refunds", enter the buyer's user id and press "Show"; under "Mainland orders" find the order by its order number and press "Record refund"; tick "The money was returned in the merchant console", give a reason and save. The row then shows the marker and what happened to the access. The action only records a refund that was already made, and reverses the entitlement once. It never writes the order row and never calls a payment provider. The same two calls, for a shell:

```
GET  /api/v1/roboapply/admin/credits/cn-orders?userId=<the buyer's user id>
     → { items: [{ id, outTradeNo, planKey, channel, amountMinor, completedAt, refunded, reversalPending? }] }

POST /api/v1/roboapply/admin/credits/cn-orders/<id>/refund
     { "reason": "<why>", "confirmMoneyReturned": true }
     → { status: "recorded" | "already_recorded", orderId, entitlement: "pass_ended" | "pass_shortened" | "pack_zeroed" | "none" }
```

`<id>` is the `id` of the list, not the order number. A second call answers `already_recorded` with what the first record did, and changes nothing. One case finishes something: when the record was written and the reversal of the access failed (the call answered an error, the account still has its 7 days), the order's row says so (`reversalPending: true`) and offers "Check the record"; that sends the same call again, which finishes the reversal and answers `already_recorded` with the outcome. A partial amount (`refundedAmountMinor` below the order) is recorded and changes no access, and closes the order's record: a later full refund of the same order cannot be recorded (`waveM4-carryover.md`, Owner). Write the answer on the form.

**If the owner paid and the order did not activate.** The money is with the merchant; refund it in the console as in f. Do not open sales. To serve the buyer of this one supervised order after the cause is understood, the operator may send the notify once more by hand, from a shell that holds the secret in the variable `ALIPAY_CALLBACK_SECRET`:

```bash
printf %s "$ALIPAY_CALLBACK_SECRET" | curl -sG "https://<notify host>/api/v1/roboapply/billing/alipay/callback" \
  --data-urlencode "pay_status=TRADE_SUCCESS" \
  --data-urlencode "out_trade_no=<the order number>" \
  --data-urlencode "cb@-"
```

`cb@-` makes `curl` read the value of `cb` from standard input and URL-encode it. `printf` is built into the shell (`bash`, `zsh`), so the value is not typed, not stored in the shell history and not in the argument list of any process (a value written as `"cb=$ALIPAY_CALLBACK_SECRET"` would be in `curl`'s argument list, readable with `ps` by every user of the machine while the request runs). It **is** in the request URL, as it is in the worker's own notify, so the request log of the platform holds it: section 4.3 c on redaction applies. Do not use `echo` in place of `printf %s`: it adds a line end to the value. Do not add `-v` or `--trace`: they print the URL.

Only when the merchant console shows the payment as received. The answer `{"code":0,"message":"success"}` means fulfilled; a repeat answers the same and changes nothing (rule A4).

### 4.4 Step 4: read the captured callback, then change what it shows

Three questions. Each has the answer that decides it.

| Question | Decided by | If yes | If no |
|---|---|---|---|
| **Did `cb` come back?** | The order activated (`pass fulfilled`). A GoApply order cannot activate without the right `cb`. | Nothing to change. | The log shows `alipay callback refused` / 40003. The rail cannot fulfil through this worker as it is. Do not open sales. Take the worker's log of the notify URL it called to whoever operates it. |
| **G9: what is `total_amount`?** | The `total_amount` value in the captured callback: is it there, does it have a decimal point, is it `12`, `12.00` or `1200`? The two log lines of 4.3 c answer it when the raw value cannot be had. | See the table below. | |
| **G10: did the worker accept the plan key as `package_id`?** | Step 3 a: did order creation succeed with `CN_ALIPAY_PACKAGE_ID_MODE` unset? | Keep the default. | Keep `CN_ALIPAY_PACKAGE_ID_MODE=legacy` in production. |

G9, by what the capture shows:

| `total_amount` in the callback | What the code did | Follow-up (a later change to requirement AL-4, not part of this runbook) |
|---|---|---|
| yuan, with or without decimals (`12.00`, `12`) | Compared with the order as yuan. No log line. | The fen reading can be removed: the tolerance can be tightened to yuan only. |
| fen (`1200`) | Accepted as fen, logged `total_amount read as fen`. | Make fen the stated unit and remove the yuan reading. |
| not sent | Not stated: no amount check was made. No log line. | Decide whether an order may be fulfilled with no stated amount. Today it is. |
| anything else | `total_amount is not usable` (ignored), or 40004 (refused, order pending). | Stop. Bring the captured value to the follow-up. |

"No log line" is the same for the first and the third row. Only the raw callback tells them apart.

### 4.5 Step 5: production

1. Do not point `roboapply.io` at this code until `goapply.top` serves this flow (M-18).
2. On the production deployment that serves `goapply.top`: the variables of section 2, the boot lines of section 3.
3. Repeat the pre-flight against production before GoApply sells anything:

```bash
node scripts/alipay-notify-preflight.mjs --origin https://www.goapply.top
```

With no variable set in the shell, `node scripts/alipay-notify-preflight.mjs` alone checks the same host. The result must be `PASS`.

4. Make sure the notify origin is served by the same deployment and database that create the orders (section 7 item 8a of the strategy). The pre-flight cannot show the database: the first real order does. Watch its `pass fulfilled` line.
5. Set `CN_ALIPAY_NOTIFY_ORIGIN=https://www.roboapply.io` only once `roboapply.io` runs this code against the same database, and run the pre-flight against it first.

---

## 5. The form to attach

Attach this to the requirement AL-8, filled in.

```
Alipay cut-over: supervised order

Date and time (with zone):
Operator:                                Owner present (yes / no):
Deployment URL (the test deployment):
Commit of the deployment:
Test host is a GoApply site by (host under goapply.top / BRAND_HOST_MAP / ALLOWED_BRANDS=goapply / preview override):

Step 1  ALIPAY_CALLBACK_SECRET set in production before today (yes / no):
        Case chosen (A / B1 / B2):
        ALIPAY_SECRETLESS_UNTIL (value, or "unset"):

Step 2  Boot line "GoApply Alipay notify host: ...":
        Pre-flight command as run:
        Pre-flight output (all lines):

Step 3  Order number (RAORDER_...):
        Plan and amount:                 会员周卡, ¥12
        CN_ALIPAY_PACKAGE_ID_MODE at creation (unset / legacy):
        Captured callback, secret REDACTED
          source (worker log / platform request log):
          method:
          query:
          body:
        Application log lines for the order:
        Activation time:
        Receipt downloaded (yes / no):
        Refund reference (merchant console):
        Refund time:
        Recorded in the admin console (yes / not built yet / no):

Step 4  cb came back (yes / no):
        total_amount as sent (yuan with decimals / whole yuan / fen / not sent / other):
        Worker accepted the plan key as package_id (yes / no):
        Follow-up opened for G9 (link):
        CN_ALIPAY_PACKAGE_ID_MODE for production (unset / legacy):

Step 5  Pre-flight against https://www.goapply.top, output:
        roboapply.io still on main (yes / no):
```

---

## 6. Rollback

`CN_PAYMENTS_ENABLED=false` on the deployment, then restart or redeploy.

- New orders stop at once on both mainland rails (Alipay and, when it is configured, WeChat Pay): plans stay listed with their amounts and are marked `payments_disabled`; a checkout answers 409 `plan_not_sellable`.
- **Pending orders still fulfil.** The callback route has no capability flag in front of it (rule A1), so a buyer who is already in the cashier is served when the notify arrives. The pre-flight still answers `PASS` under the kill switch.
- Passes that are live stay live. Nothing is refunded by the switch.

To sell again, remove the variable. Do not set it to `true`: unset is on.

Do not remove `ALIPAY_CALLBACK_SECRET` as a way to stop sales. It also stops every pending order from being fulfilled (503 / 50003 to every notify).

---

## 7. The twelve "do not break" rules, and the test that pins each

No Alipay code changes on the day or in this phase. These tests must be green on the commit that is deployed, unedited:

```bash
npx vitest run \
  server/src/roboapply/routes/billing.test.ts \
  server/src/platform/billing/rails/rails.test.ts \
  server/src/platform/billing/fulfilPass.test.ts \
  server/src/roboapply/services/RoboApplyBillingService.alipay.test.ts \
  server/src/platform/billing/integration/RoboApplyBillingService.stripe.test.ts
```

| # | Rule | Pinned in (tests named `A<n> …`) |
|---|---|---|
| A1 | `GET` and `POST /api/v1/roboapply/billing/alipay/callback` stay public (no auth, no CSRF, no capability flag), read parameters from query and JSON body, and stay mounted after `express.json`. | `server/src/roboapply/routes/billing.test.ts` |
| A2 | Answers: HTTP 200 `{ code: 0 }` for success, closed, no-action and replays; 400 with 40001 (missing parameters), 40002 (unknown order, or a tier without `ra_`), 40004 (amount mismatch, the order stays pending), 40005 (the order names no pass or pack plan); 403 / 40003 for a wrong secret; 503 / 50003 when no callback secret is configured or the rail is not registered; 500 / 50001 on an exception. Never non-200 to a replay of a paid order. | `server/src/roboapply/routes/billing.test.ts` |
| A3 | `AlipayOrder.outTradeNo` is unique and is the only key the callback uses. `tier` keeps the `ra_` prefix; a tier without it is `not_found`. | `server/src/roboapply/routes/billing.test.ts`, `server/src/platform/billing/fulfilPass.test.ts` |
| A4 | One order activates once and grants once, under replay and under two concurrent notifies. | `server/src/roboapply/routes/billing.test.ts`, `server/src/platform/billing/fulfilPass.test.ts` |
| A5 | Worker request: the default endpoint, `pay_channel: 'alipay'`, `platform: 'gohire'` unless overridden, whole-yuan numeric `total_amount`, `package_data` with the four string fields, `notify_url` on a host that serves the callback route, `?cb=` URL-encoded. | `server/src/platform/billing/rails/rails.test.ts` |
| A6 | A callback whose `cb` does not match the configured secret is refused before any database write; the comparison is constant-time. | `server/src/platform/billing/rails/rails.test.ts`, `server/src/roboapply/routes/billing.test.ts` |
| A7 | A pending legacy `ra_starter` / `ra_growth` order still fulfils: 30 days, plan credits, CNY, `market: 'cn'`. | `server/src/platform/billing/fulfilPass.test.ts` |
| A8 | `AlipayOrder` is never widened destructively: `tier`, `amount`, `status`, `completedAt` keep their meaning. | `server/src/platform/billing/fulfilPass.test.ts`, `server/src/roboapply/routes/billing.test.ts` |
| A9 | Mainland rails sell one-time products only. `fulfilPass` refuses a subscription plan. No auto-debit, no stored agreement. | `server/src/platform/billing/fulfilPass.test.ts` |
| A10 | Every completed `ra_*` order stays listed in `/billing/history` and is downloadable by its owner only. | `server/src/roboapply/routes/billing.test.ts` |
| A11 | Stripe never serves GoApply, and the Stripe webhook never activates a `goapply` object. | `server/src/platform/billing/rails/rails.test.ts`, `server/src/roboapply/routes/billing.test.ts`, `server/src/roboapply/services/RoboApplyBillingService.alipay.test.ts`, `server/src/platform/billing/integration/RoboApplyBillingService.stripe.test.ts` |
| A12 | WeChat Pay work does not change the Alipay rail registration or the `fulfilPass` signature. | `server/src/platform/billing/fulfilPass.test.ts`, `server/src/roboapply/services/RoboApplyBillingService.alipay.test.ts` |

The pre-flight script has its own tests, which also run it against this repository's real callback route on a loopback port:

```bash
npx vitest run __tests__/scripts/alipayNotifyPreflight.test.ts
```

---

## 8. Try the script on your own machine first

Nothing here touches a deployment, the worker or a database.

**A stub that answers as this code does with a secret set.** Start it, run the script, stop it:

```bash
node -e "require('node:http').createServer((q,s)=>{s.writeHead(403,{'content-type':'application/json','x-ra-brand':'goapply'});s.end(JSON.stringify({code:40003,message:'forbidden'}))}).listen(8787,'127.0.0.1')" & STUB=$!
sleep 1
node scripts/alipay-notify-preflight.mjs --origin http://127.0.0.1:8787
kill $STUB
```

Expected, with exit code 0:

```
Alipay notify pre-flight (read-only: one GET, no parameters, no secret, no order)
host:     127.0.0.1:8787
decided:  --origin
request:  GET http://127.0.0.1:8787/api/v1/roboapply/billing/alipay/callback
status:   HTTP 403
answer:   { code: 40003 }
brand:    goapply (X-RA-Brand)
result:   PASS  our callback route answered (403 / 40003, the refusal of a request without the secret) and a callback secret is set on that host.
          Not proven by this check: that this host uses the same database and the same callback secret as the deployment that creates the orders.
```

Run the script line again after `kill $STUB`: nothing listens, the result is `FAIL  the request failed before any answer (ECONNREFUSED)` and the exit code is 1.

An override the server would ignore, in the shell, stops the same command before any request, whether the stub runs or not (exit code 1, `Nothing was sent.`):

```bash
CN_ALIPAY_NOTIFY_ORIGIN=www.goapply.top node scripts/alipay-notify-preflight.mjs --origin http://127.0.0.1:8787
```

`http://` is accepted for `localhost`, `127.0.0.1`, `[::1]` and names ending in `.localhost` only. Every other origin must be `https://`.

**The local development stack.** With `./scripts/dev-clone.sh` running (API on port 4621):

```bash
node scripts/alipay-notify-preflight.mjs --origin http://localhost:4621
```

`PASS` when `ALIPAY_CALLBACK_SECRET` is set in the clone `.env`, `PASS-ROUTE / FAIL-SECRET` when it is not. (Expected from the code and from the loopback test of the same route; the development stack itself was not started for this document.)

---

## 9. What was measured and what is assumed

**Measured** (run on 2026-10-11 in the MKT-3H worktree; no network beyond the loopback interface):

- The pre-flight script against this repository's real billing router on a loopback port: with a secret set the route answers 403 / 40003 with `X-RA-Brand` and the script reports `PASS`; without one it answers 503 / 50003 and the script reports `PASS-ROUTE / FAIL-SECRET`; the kill switch does not close the route; inside an open secret-less window the answer is the same; the order table is not read (`__tests__/scripts/alipayNotifyPreflight.test.ts`).
- The script's host resolver against the server's `resolveAlipayNotifyOrigin` for 32 environments (same test file).
- Every other result of section 4.2 against an injected answer (same test file).
- The stub commands of section 8, as written, with the output printed there. (An earlier draft stopped the stub with `kill %1`; in a shell without job control that left it running, so the stub's process id is kept in `STUB`.)
- The script started through a linked directory and a linked file: same output and exit codes as by its real path (same test file, and by hand).
- The form of the recovery command of 4.3 (`printf %s … | curl -sG … --data-urlencode "cb@-"`) against a loopback listener with a made-up value, curl 8.7.1: the listener received `cb=<the value, URL-encoded>` in the query. Not run against the callback route with a real secret.
- How a host becomes a GoApply site (section 2.1), by reading `brandIdFromHost` and `isDevOrPreviewHost` (`server/src/platform/brand/registry.ts`), `resolveBrandFromRequest` (`server/src/platform/brand/runtime.ts`), `resolveWebBrand` (`lib/brand/runtime.ts`), `proxy.ts`, and `appOrigin` (`server/src/platform/billing/origins.ts`) for the return address. None of the four ways was tried on a deployment.
- `main`'s handler, by reading `main:server/src/roboapply/routes/billing.ts` and `main:server/src/roboapply/services/RoboApplyBillingService.ts`: no secret set → no check, then 400 / 40001 for missing parameters; secret set → 403 / 40003; `main` has no brand middleware, so no `X-RA-Brand` header.
- Every variable name, log text, answer code and path in this document was read in the merged code.

**Assumed, not seen:**

- Everything about the GoHire payment worker: that it calls `notify_url` unchanged (so `cb` comes back), the method it uses, whether parameters are in the query or the body, the unit of `total_amount`, whether it validates `package_id`, whether it follows a redirect, how often it retries a notify, and the cashier's order lifetime. The supervised order settles the first five.
- That `https://www.goapply.top` serves `/api/v1/*` from the deployment and database that create GoApply's orders. The script was not run against it or against any deployed host.
- That a proxy in front of the deployment passes the `X-RA-Brand` response header through. If one removes it, the script reports `PASS-ROUTE / FAIL-HANDLER` on a correct deployment; use the `curl` check of 4.2 and confirm the deployment another way.
- What the hosting platform's request log records (method, path, query). The application logs none of it.
- The `vercel env ls production` command and Deployment Protection behaviour are Vercel's; they were not run here.
- The admin action of step 3 g is built (phase M4) and tested on an in-memory database with orders paid through the real `fulfilPass`. It was not run against a deployed host, and the console page was not seen in a browser.

**Not decided here** (owner, `MARKET_STRATEGY.md` section 7): whether production has the secret today (item 5), the merchant's legal name and whether GoApply may sell through it (item 6), the supervised order itself (item 7), the M-18 default (item 8), the notify origin (item 8a).
