# Parity wave: verification after the merge

**For:** the orchestrator (or any agent with no context), after all eleven bundles of `parity-bundles.json` are merged into `feat/jobright-clone`.
**Specification:** [`../GOAPPLY_PARITY_PLAN.md`](../GOAPPLY_PARITY_PLAN.md) §7. **Written by:** PAR-10.

Run the steps top to bottom on the clone dev stack. Report **pass** or **fail** per step with the evidence each step names (command output, a count, a screenshot). A step that needs a credential the owner has not added is reported as **not configured**, with the variable name. That is not a failure (see "Credentials the owner may still have to add").

Rules while verifying:

- Never print a secret. Every command below prints names, counts, status codes or public fields only.
- No schema push, no deploy, no production build in the checkout the dev stack runs from.
- D1: nothing in this list submits a job application. D3: an empty list is reported as empty, never padded.
- The dev stack makes real provider calls with the keys in the clone `.env` (models, email, LiveKit, RapidAPI for RoboApply's ingest). Keep the walk to what each step asks for.
- Every command block can be run on its own, in a fresh shell with no terminal attached: a block that needs the checkout or the addresses starts by loading `/tmp/par-verify/env.sh` (written in Setup), the others read files under `/tmp/par-verify` only, and nothing asks for typed input.

## 0. Before anything is pushed or deployed

This is the release rule from the PAR-1 handoff (O-1). It is a precondition, not a test.

1. `ALLOWED_BRANDS=roboapply` is set on every Vercel environment of the project (Production and Preview) before the wave branch is pushed. A deployment with no `ALLOWED_BRANDS` now serves both brands, so it would serve `goapply.top` as soon as its DNS points there. Remove the variable deliberately on the day GoApply goes live.
2. A value that names no valid brand (a typo) does not open GoApply: the deployment serves RoboApply only and logs the bad value at boot. The mainland kit keeps `ALLOWED_BRANDS=goapply`; a typo there refuses the boot (`intl_brand_on_mainland`).
3. The i18n merge and translation pass has run, or is scheduled before GoApply is shown to users. Until then GoApply shows English for strings that exist only in `i18n/staging/`.

## Setup

Write the settings every later block loads. Shell variables do not survive from one command to the next in an agent's shell, so they live in a file:

```bash
mkdir -p /tmp/par-verify && chmod 700 /tmp/par-verify
cat > /tmp/par-verify/env.sh <<'EOF'
cd /Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone
export API=http://localhost:4621
export WEB=http://localhost:3621
export RA_HOST=localhost:3621
export GO_HOST=goapply.localhost:3621
EOF
```

Confirm the stack will be the shared-credentials case the plan is about. The API reads `.env`, then `.env.local`, and the shell that starts it wins over both, so all three are checked. This prints the **names** of the China-specific values and of the deployment scope, never a value. Run it in the shell that will start the stack:

```bash
. /tmp/par-verify/env.sh
NAMES='^(CN_[A-Z0-9_]+|FLAG_GOAPPLY_[A-Z0-9_]+|ALLOWED_BRANDS|BRAND_LOCK)=.'
for f in .env .env.local; do [ -f "$f" ] && grep -oE "$NAMES" "$f" | sed "s/=.\$//; s|^|$f: |"; done
env | grep -oE "$NAMES" | sed 's/=.$//; s/^/shell: /'
echo "checked"
```

Expected: nothing before `checked`, or only identity names such as `CN_CANONICAL_ORIGIN`. `ALLOWED_BRANDS` or `BRAND_LOCK` must not be set on the dev stack (it would hide one brand). Any `CN_LLM_*`, `CN_EMAIL_*`, `CN_LIVEKIT_*`, `CN_S3_*`, `CN_RECRUITMENT_INFO_MODE`, `CN_SIGNUP_MODE`, `CN_PAYMENTS_ENABLED`, `CN_STORAGE_MODE` or `FLAG_GOAPPLY_*` line means the run does not prove the default. Report the names and, for the off switches and the scope, remove the line (or unset the shell variable) before continuing.

Start the stack and leave it running. It must start with no extra variable. `GOAPPLY_PREVIEW` is retired: if it is set the script prints one notice and ignores it. A person can run `./scripts/dev-clone.sh` in a terminal of its own; an agent starts it in the background and keeps the log:

```bash
. /tmp/par-verify/env.sh
nohup ./scripts/dev-clone.sh > /tmp/par-verify/stack.log 2>&1 &
echo $! > /tmp/par-verify/stack.pid
until curl -sf "$API/api/health" > /dev/null; do sleep 2; done
until curl -s -o /dev/null "$WEB/"; do sleep 2; done
echo "stack ready"
```

To stop it later: Ctrl-C in its terminal, or `kill -INT "$(cat /tmp/par-verify/stack.pid)"`.

Read the API start-up log once (`/tmp/par-verify/stack.log`, the lines prefixed `[api]`). Expected: no error. These lines are allowed and are reported as information: the warning that names a half-set GoApply group, the warning that `CN_PAYMENT_COLLECTING_ENTITY` is not set, the warning about an ignored `CN_EXTERNAL_PROVIDERS` or `*_PUBLIC_JOB_BASE_URL`. A line that says `ALLOWED_BRANDS` names no brand, that `CN_RECRUITMENT_INFO_MODE`, `CN_SIGNUP_MODE` or `CN_STORAGE_MODE` has an unknown value, or that a content-safety setting is invalid, is a configuration mistake: fix `.env` and restart.

## 1. Static gates

```bash
. /tmp/par-verify/env.sh
npm run gen:brand && git diff --exit-code -- lib/brand/registry.generated.ts
node scripts/gen-brand-mirror.mjs --check
node docs/jobright-clone/orch/check-bundles.mjs docs/jobright-clone/orch/parity-bundles.json
npm run typecheck:server
npx next typegen && npm run typecheck:web
npx vitest run --exclude ".claude/**"
npm run check
npm --prefix extension run typecheck && npm --prefix extension test
npm --prefix interview-agent run typecheck && npm --prefix interview-agent test
bash -n scripts/dev-clone.sh
```

Pass: every command exits 0; `gen:brand` leaves no diff; `check-bundles` reports 0 problems.

For the test run, compare with the PAR-1 handoff (`handoffs-par/PAR-1.md`): it listed 95 red tests that the other bundles had to turn green and 12 failures that existed before the wave. Pass means none of the 95 is still red. If any of the 12 older ones is still red, list it by file under "pre-existing" with the bundle handoff that says so; a failure that is in neither list is a **fail**.

The mainland kit passes its preflight. `__tests__/deploy/deployKit.test.ts` asserts that the filled kit example has no preflight failure at all (and is refused again under `CN_RESIDENCY_STRICT=true`) only once the strict posture is built. Confirm that branch of the test ran:

```bash
. /tmp/par-verify/env.sh
grep -lE 'CN_RESIDENCY_STRICT|cnResidencyStrict' server/src/platform/residency/startupAssertions.ts deploy/cn/preflight.mjs
npx vitest run __tests__/deploy/deployKit.test.ts -t 'the preflight passes'
```

Pass: the `grep` prints **both** file names and the test passes. If a file name is missing, PAR-5's change is not merged and the kit's "passes preflight with warnings" is unproven: **fail**. Once this has passed, the pre-merge branch of that test can be deleted (the `if (STRICT_POSTURE_BUILT)` guard and the comment below it).

Wording check on the files PAR-10 owns (expected output: nothing):

```bash
. /tmp/par-verify/env.sh
grep -nEi 'no fallback|ships? dark|never falls? back' .env.example deploy/cn/cn.env.example deploy/cn/cn.web.env.example deploy/cn/README.md scripts/dev-clone.sh
```

## 2. Capability comparison of the two brands

```bash
. /tmp/par-verify/env.sh
curl -s -H "Host: $RA_HOST" "$API/api/v1/public/brand" > /tmp/par-verify/ra.json
curl -s -H "Host: $GO_HOST" "$API/api/v1/public/brand" > /tmp/par-verify/go.json
jq -r '.data.id' /tmp/par-verify/ra.json /tmp/par-verify/go.json
```

Expected: `roboapply` then `goapply`.

Every capability that is on for RoboApply and not on for GoApply:

```bash
jq -n --slurpfile ra /tmp/par-verify/ra.json --slurpfile go /tmp/par-verify/go.json '
  def on: .data.flags | to_entries | map(select(.value == true) | .key);
  (($ra[0] | on) - ($go[0] | on)) | sort'
```

Pass: the output is a subset of exactly these six keys, the market differences D5 names:

```json
["auth.google", "auth.line", "eeoAnswers", "fx.reference", "h1bHistory", "pay.stripe"]
```

A key outside that list is a **fail**: name it. A key of the list that is missing from the output only means RoboApply itself has no credential for it on this stack (for example no Google client): report it as not configured.

The mode value and the sign-in and payment lists:

```bash
jq -r '"\(.data.id): hiringContacts=\(.data.flags.hiringContacts) authMethods=\(.data.authMethods | join(",")) paymentRails=\(.data.paymentRails | join(","))"' /tmp/par-verify/ra.json /tmp/par-verify/go.json
```

Pass:

- GoApply `authMethods` starts with `email_password`. With the script default (`SMS_DEV_CONSOLE=true`) it is `email_password,phone_otp`, plus `wechat` only when the WeChat credentials are set.
- GoApply `paymentRails` never contains `stripe`. It contains `alipay` when `ALIPAY_CALLBACK_SECRET` is in the environment; otherwise it is empty and step 6 reports "not configured".
- `hiringContacts` is the same value for both brands.

The capabilities this wave turned on, one by one (each must print `true`):

```bash
jq -r '.data.flags as $f | ["ai.text","ai.vision","copilot","agent","notify.email","auth.passwordReset","jobs.feed","jobs.recommendations","jobs.alerts","campusCalendar","interviewVoice","ai.interviewVoice","webPush","coaching","extension","student"][] | "\(.)=\($f[.])"' /tmp/par-verify/go.json
```

A `false` is a **fail** unless the same key is `false` in `ra.json`. Then the capability is off for both brands for want of a shared credential: report "off on both brands" with the key, not a failure. Check with `jq -r '.data.flags["<key>"]' /tmp/par-verify/ra.json`. `webPush=false` on both brands means the VAPID keys are not set. (`visitorAssistant`, `companyNews` and `seo.browse` are not in the list: they are off by default on both brands and are turned on with `FLAG_<BRAND>_<KEY>=true`.)

Which stack each GoApply model setting resolves to (no provider is called without `--probe`):

```bash
. /tmp/par-verify/env.sh
npm run verify:llm
```

Pass: both brands resolve the same selectors; on this stack no GoApply line is marked `[own]` (each value that is set is `[shared]`); the report ends with `No policy violations.`

**2b. Email sign-in does not depend on the phone demo.** Stop the stack, start it once with `SMS_DEV_CONSOLE=false ./scripts/dev-clone.sh` (in the background form of Setup: `SMS_DEV_CONSOLE=false nohup ./scripts/dev-clone.sh …`), and repeat:

```bash
. /tmp/par-verify/env.sh
curl -s -H "Host: $GO_HOST" "$API/api/v1/public/brand" | jq -c '.data.authMethods'
```

Pass: the list still contains `email_password` (and no `phone_otp`). Restart the stack normally afterwards.

**2c. Off switches still work (optional, one restart each).** Start with `CN_RECRUITMENT_INFO_MODE=off ./scripts/dev-clone.sh`: `jobs.feed`, `jobs.recommendations` and `jobs.alerts` are `false` for GoApply and unchanged for RoboApply. Start with `CN_PAYMENTS_ENABLED=false ./scripts/dev-clone.sh`: GoApply `paymentRails` is empty. Restart normally afterwards.

## 3. Signed-out pages, both brands

```bash
. /tmp/par-verify/env.sh
for host in "$GO_HOST" "$RA_HOST"; do
  for path in / /pricing /tools/resume-check /tools/job-alerts /features/job-matches /features/resume-tailoring /features/cover-letters /features/ready-to-apply /developers/job-search /campus /legal/privacy /legal/terms /sitemap.xml /sitemaps/static.xml; do
    printf '%-24s %-30s ' "$host" "$path"
    curl -s -L -o /dev/null -w '%{http_code}\n' -H "Host: $host" "$WEB$path"
  done
done
```

Pass for `goapply.localhost:3621`: every line is `200`.

Pass for `localhost:3621` (regression): every line is `200` except `/campus`, which is GoApply's page and answers `404` on RoboApply as it did before the wave.

GoApply's static sitemap lists its own pages on its own origin, the free tools among them:

```bash
. /tmp/par-verify/env.sh
curl -s -H "Host: $GO_HOST" "$WEB/sitemaps/static.xml" | grep -oE '<loc>[^<]+</loc>' | sed -E 's/<\/?loc>//g' | grep -E '/(tools|features|pricing)' | sort
```

Pass: `/pricing`, `/tools/resume-check`, `/tools/job-alerts` and the ungated feature pages are listed; no line is on RoboApply's origin. (`/features/ready-to-apply` is a gated page and is not listed, as on RoboApply.)

Then open these four in a browser on GoApply, signed out, at 1280 px and 375 px, light and dark, and check what a status code cannot show:

| Page | Must be true |
|---|---|
| `http://goapply.localhost:3621/` | GoApply name and mark, Chinese copy, the quick search, counters and feature cards show real values or an honest empty state (no invented numbers) |
| `/pricing` | five paid plans with CNY amounts (¥12, ¥39, ¥99, ¥29, ¥79); no Stripe wording; no auto-renewal promise. With `ALIPAY_CALLBACK_SECRET` set there is no "not open" notice. Without it the notice ("会员卡暂时还不能购买。", or its English text until the translation pass) is expected: report **not configured: `ALIPAY_CALLBACK_SECRET`**, not a fail. A notice while `paymentsOpen` is `true` (step 6), or a plan without a price, is a **fail** |
| `/tools/resume-check` | the tool opens; the consent tick and the notice that processing happens outside the mainland are shown before anything is uploaded. Run it once with a sample PDF and the notice ticked: a result comes back. Without the tick the run is refused and no allowance is used |
| `/legal/privacy` | the page renders with the DRAFT banner while `CN_LEGAL_DOCS_VERSION` is unset; the processor list names the processors of the shared stack; RoboApply's legal entity does not appear |

Fail: a page of another brand's identity (RoboApply's name, entity or origin on GoApply), a fabricated number, or a white-on-white block in dark mode.

## 4. GoApply signed-in walk

In a browser at `http://goapply.localhost:3621`. Use a fresh email address you can read and a password made up for this run (a test account of this dev stack only). Evidence per row: a screenshot or the response named.

| # | Do | Pass |
|---|---|---|
| 4.1 | Open `/signup` | the email and password form is the first thing on the page; no invite-code field; phone appears beside it as a second method (demo console) |
| 4.2 | Sign up with email + password, ticking the required consents | the account is created with no invite; the consent list includes the cross-border item, and its text names the processors of the stack in use |
| 4.3 | Check the inbox | a verification mail arrives, sent under the display name GoApply from the shared verified sender address (`ROBOAPPLY_EMAIL_FROM`), not from `noreply@goapply.top`; the link opens `goapply.localhost` and verifies the address. No mail at all: check the API log for a refused sender and report `ROBOAPPLY_EMAIL_FROM` / `CN_EMAIL_FROM` as not configured |
| 4.4 | Sign out, use "forgot password" | the reset mail arrives; the new password signs in |
| 4.5 | Finish onboarding, upload a PDF resume | the resume is parsed and shown; then download the original from the resume page: the same file comes back |
| 4.6 | Open the Assistant, ask one question about your resume | an answer streams; the AI-generated label and the AI consent prompt appear as on GoApply before the wave; no "AI unavailable" |
| 4.7 | `/practice`: start a written practice | questions appear; finish it; a report is produced |
| 4.8 | `/practice`: start a voice practice | the room connects and the interviewer speaks within about 30 seconds; the consent sheet offers the recording and the video choice; end the session; a report is produced |
| 4.9 | Open `/coaching` | 200, the roster or its honest empty state; no 404 |
| 4.10 | Open `/extension` | 200, the install entry (store link or the stated fallback); no 404. With `NEXT_PUBLIC_CN_EXT_ID` unset the install link is hidden: report not configured |
| 4.11 | Open `/jobs` | the feed lists postings (after step 5 has run); the header says where they come from ("来自 N 家企业招聘官网"); each card names its source |
| 4.12 | Settings › notifications | web push can be switched on when the VAPID keys are set (otherwise report "not configured: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY") |

API probes that go with the walk (GoApply's sign-up policy, no session needed):

```bash
. /tmp/par-verify/env.sh
curl -s -H "Host: $GO_HOST" "$API/api/v1/roboapply/auth/phone/policy?locale=zh" | jq '{signupOpen: .data.signupOpen, inviteRequired: .data.inviteRequired, consents: [.data.requiredConsents[]?.type]}'
curl -s -H "Host: $GO_HOST" "$API/api/v1/roboapply/auth/methods?locale=zh" | jq -c '.data'
```

Pass: `signupOpen` is `true`, `inviteRequired` is `false`, the consent list contains `pipl_cross_border` (the stack is offshore), and the methods begin with email and password.

**A session for the API steps below.** Sign the test account in from the shell and keep its session in a cookie jar. Write the account's email and password (after 4.4, the new password) to a private file with an editor or a file tool, not on a command line, so they are never echoed:

```json
{"email": "<the test account's address>", "password": "<its password>"}
```

saved as `/tmp/par-verify/go-login.json`. Then:

```bash
. /tmp/par-verify/env.sh
chmod 600 /tmp/par-verify/go-login.json
curl -s -o /dev/null -w 'login %{http_code}\n' -c /tmp/par-verify/go.cookies -H "Host: $GO_HOST" -H 'Content-Type: application/json' \
  -d @/tmp/par-verify/go-login.json "$API/api/v1/roboapply/auth/login"
chmod 600 /tmp/par-verify/go.cookies
curl -s -o /dev/null -w 'session %{http_code}\n' -b /tmp/par-verify/go.cookies -H "Host: $GO_HOST" "$API/api/v1/roboapply/auth/me"
```

Pass: `login 200` and `session 200`. The later blocks send the jar with `-b /tmp/par-verify/go.cookies` and the same `Host` header (curl matches the cookie to that host). Neither file is ever printed; both are deleted in "Clean up".

A person at a terminal can paste the browser's cookie instead (dev tools › Application › Cookies › `ra_session_token`): `read -rs GO_SESSION` and `-H "Cookie: ra_session_token=$GO_SESSION"` in place of `-b …`, in one shell kept open.

## 5. Job sources (GoApply)

**5.1 Run the ingest.** The cron endpoints run every brand this deployment serves. GoApply reads its seeded employer boards and the GoHire bank; it makes no RapidAPI call. RoboApply's share of the same run makes its normal, budgeted provider calls.

```bash
. /tmp/par-verify/env.sh
CRON_AUTH="Authorization: Bearer $(grep -E '^CRON_SECRET=' .env | cut -d= -f2- | tr -d '"')"
curl -s -H "$CRON_AUTH" "$API/api/v1/cron/jobs-plan" | jq -c '.'
for i in 1 2 3 4 5 6; do curl -s -H "$CRON_AUTH" "$API/api/v1/cron/jobs-ingest" | jq -c '.'; sleep 5; done
```

(The second line reads the secret into a shell variable without printing it.) Repeat the `jobs-ingest` loop until the GoApply part of the answer reports no work left, or until the report of 5.2 shows every seeded board with a last-seen date. Pass for this sub-step: the GoApply entry is never `no_providers`, `feature_disabled` or an error.

**5.2 The read-only report.** It runs four `SELECT` statements and reads the stored source statuses; it calls no provider and writes nothing. It loads `.env` and `.env.local` itself and takes the brand as `--brand <id>` (a bare word is ignored and the report is GoApply's). `--check` makes it exit 1 when the acceptance does not hold.

```bash
. /tmp/par-verify/env.sh
npx tsx server/src/features/jobs/ingest/verifyFeed.ts --brand goapply --check | tee /tmp/par-verify/verify-feed-goapply.txt
echo "verifyFeed exit: ${PIPESTATUS[0]}"
head -1 /tmp/par-verify/verify-feed-goapply.txt
```

The first line of the report names the brand: it must read `Job index report for goapply (market cn) …`. If it names another brand, stop: the numbers below would be judged on the wrong market.

Pass, all of:

- `verifyFeed exit: 0` and the report ends with `Acceptance: PASS`. Exit 1 is a **fail**: copy the `FAIL` lines of the acceptance block;
- at least **300** open `RAJob` rows with `market = 'cn'` and `visibility = 'public'` from the employer boards, across at least **10** boards (the line "Employer boards with open public rows");
- every one of those rows has a provider id, a source name, an apply URL and a posted or last-verified date ("without provider id 0"; the samples show a source name, an apply host and dates);
- every apply host in the samples is the employer's own site or its ATS (hosts such as `boards.greenhouse.io`, `jobs.lever.co`, `jobs.ashbyhq.com`, `jobs.smartrecruiters.com` or the employer's career domain), never a job board's search page;
- **zero** rows with source board `jsearch` and **zero** open public rows without an apply URL;
- the GoHire bank shows its synced, skipped and held counts under "Sources (last ingest run)". With `GOHIRE_PUBLIC_JOB_URL_TEMPLATE` unset (the default) its rows are **held** (no public job page) and none is listed; this is the expected state, not a failure. "never ran" for the bank with `RA_CROSSBANK_CROSS_TENANT_CONFIRMED` unset is reported as not configured;
- a source that answered an error is shown as `ERROR` by the report, never hidden.

Report the row count, the number of boards and the three largest boards with their counts.

**5.3 Three apply links.** Open `/jobs` on GoApply and take three postings from three different employers (the report's samples show hosts only, not full links). Open each posting's apply link in a browser. Pass: each shows that posting (same title and employer) on the employer's page. A "page not found" or a search-results page is a **fail** for that board: name it.

**5.4 The feed and the sentence search.**

```bash
. /tmp/par-verify/env.sh
curl -s -b /tmp/par-verify/go.cookies -H "Host: $GO_HOST" -H 'Content-Type: application/json' \
  -d '{"sort":"newest"}' "$API/api/v1/roboapply/feed/query" > /tmp/par-verify/go-feed.json
jq '{count: (.data.items | length), sources: .data.sources, first: (.data.items[0] | {jobId, title, company, apply, source})}' /tmp/par-verify/go-feed.json

curl -s -b /tmp/par-verify/go.cookies -H "Host: $GO_HOST" -H 'Content-Type: application/json' \
  -d '{"text":"上海的软件工程师职位"}' "$API/api/v1/roboapply/feed/nl-query" \
  | jq '{diff: .data.diff, unmatched: .data.unmatched}'
```

Pass: the first call returns at least one item; `sources.employerBoards` is 1 or more and `sources.gohire` is `false` while the bank's page template is unset; the first item carries `apply.url`, `apply.target` (`employer`) and a `source` with a name and `lastVerifiedAt`. The second call returns a filter proposal (`diff`) built from the sentence, with no error; applying it in the `/jobs` page narrows the list. If the field names differ from these, read them from the PAR-11 handoff (feed contract) and report the difference.

**5.5 The bank listing rule (optional, one restart).** Only if a real GoHire posting page exists: start with `GOHIRE_PUBLIC_JOB_URL_TEMPLATE` set to it, re-run 5.1 and 5.2, and confirm the held rows are now listed and one of their links opens the posting. Do not set a template that points at a page that does not exist: `https://www.gohire.top/jobs/<id>` and `https://www.robohire.io/jobs/<id>` render "Page not found" (checked 2026-10-11).

**5.6 A public job page.** Signed out, for the first posting of the feed:

```bash
. /tmp/par-verify/env.sh
JOB_ID=$(jq -r '.data.items[0].jobId' /tmp/par-verify/go-feed.json)
curl -s -L -o /dev/null -w "/job/$JOB_ID %{http_code}\n" -H "Host: $GO_HOST" "$WEB/job/$JOB_ID"
grep -oE '^PUBLIC_DISPLAY_PROVIDERS=.' .env | sed 's/=.$/ is set/'
```

Pass: `200` when `PUBLIC_DISPLAY_PROVIDERS` lists `ats_public` (employer-board postings may then be shown publicly). With the default (the variable unset or without `ats_public`) the page answers `404` and the posting is in no sitemap partition: report **not configured: `PUBLIC_DISPLAY_PROVIDERS`** (an owner decision, the same gate as on RoboApply), not a fail. A `200` for a posting whose provider is not listed is a **fail**.

## 6. GoApply plans and checkout

```bash
. /tmp/par-verify/env.sh
curl -s -H "Host: $GO_HOST" "$API/api/v1/roboapply/billing/plans" \
  | jq '{currency: .data.currency, paymentsOpen: .data.paymentsOpen, rails: .data.checkout.rails, plans: [.data.plans[] | {key, sellable, amountMinor, unsellableReason}]}'
```

Pass:

- `currency` is `CNY`;
- five paid plans (`pro_week_pass`, `pro_monthly`, `pro_quarterly`, `practice_pack_5`, `practice_pack_15`), each with `amountMinor` in fen (1200, 3900, 9900, 2900, 7900) and `unsellableReason` never `price_unset` or `payments_disabled`;
- repeat the call with `-b /tmp/par-verify/go.cookies` for an account with a verified `.edu.cn` address: `student_monthly` (2900) and `student_quarterly` (6900) appear as well. Without such an account report "student passes: not exercised";
- `checkout.rails` contains `alipay` and `paymentsOpen` is `true` **when `ALIPAY_CALLBACK_SECRET` is set**. When it is not, the plans and prices still list, `rails` is empty and `paymentsOpen` is `false`: report "not configured: ALIPAY_CALLBACK_SECRET". `rails` never contains `stripe`.

The fields are those of `PlansResponse` (`server/src/features/credits/contract.ts`) and `CatalogPlan` (`server/src/platform/billing/planCatalog.ts`). A plan's `sellable` comes from the catalog (an amount is present and charging is not switched off), so every paid GoApply plan is `sellable: true` by default; whether a payment can be opened right now is `paymentsOpen` and `checkout.rails`.

Do not open a real payment in this pass. The supervised first purchase is the owner's cut-over checklist in `market/MARKET_STRATEGY.md` §5.3.

The frozen Alipay contract is covered by tests, not by a live call. Confirm they are in the green run of step 1:

```bash
. /tmp/par-verify/env.sh
npx vitest run server/src/platform/billing server/src/roboapply/services/RoboApplyBillingService.alipay.test.ts
```

## 7. RoboApply regression

Repeat for `http://localhost:3621`:

**7.1 No capability that was on is off.** The baseline is computed, not remembered: the flag code of the last commit before the wave (`606365f`, the parent of PAR-1's commit `5822134`), run with today's environment. The files are extracted to `/tmp` with `git archive` (read-only; no worktree is added, nothing in the checkout changes).

```bash
. /tmp/par-verify/env.sh
rm -rf /tmp/par-verify/base && mkdir -p /tmp/par-verify/base
git archive 606365f server/src/platform server/src/lib | tar -x -C /tmp/par-verify/base
cat > /tmp/par-verify/ra-before.mts <<'EOF'
// The capabilities that were on for RoboApply before the parity wave, with today's environment.
import { createRequire } from 'node:module';
import path from 'node:path';
const [checkout, base] = [process.argv[2]!, process.argv[3]!];
const dotenv = createRequire(path.join(checkout, 'package.json'))('dotenv');
dotenv.config({ path: path.join(checkout, '.env'), override: false, quiet: true });
dotenv.config({ path: path.join(checkout, '.env.local'), override: false, quiet: true });
const { getBrand } = await import(path.join(base, 'server/src/platform/brand/registry.ts'));
const { resolveFlags } = await import(path.join(base, 'server/src/platform/flags.ts'));
const on = Object.entries(resolveFlags(getBrand('roboapply'), process.env)).filter(([, v]) => v === true).map(([k]) => k).sort();
console.log(JSON.stringify(on));
EOF
npx tsx /tmp/par-verify/ra-before.mts "$PWD" /tmp/par-verify/base > /tmp/par-verify/ra-before.json
jq -c 'length' /tmp/par-verify/ra-before.json
jq -n --slurpfile b /tmp/par-verify/ra-before.json --slurpfile ra /tmp/par-verify/ra.json \
  '$b[0] - ($ra[0].data.flags | to_entries | map(select(.value == true) | .key))'
```

Pass: the count is 20 or more (the baseline was really computed; it prints flag names only) and the last command prints `[]`. Any key it prints was on for RoboApply before the wave and is off now: **fail**, name it. (The brand endpoint and the baseline use the same `resolveFlags(brand, env)`, so the two lists are comparable. Run it in a shell that has none of the stack's variables overridden.) The one intended change in RoboApply's data is its provider list (no `linkedin`).

**7.2** Step 3: the page list (already run above).

**7.3** Step 4 rows 4.1 to 4.10 with a fresh RoboApply account: sign-up, verification mail, password reset, resume upload and original download, Assistant, written and voice practice, `/coaching`, `/extension`.

**7.4 The feed.** Sign the RoboApply test account in the same way as in step 4 (`/tmp/par-verify/ra-login.json`, `Host: $RA_HOST`, jar `/tmp/par-verify/ra.cookies`):

```bash
. /tmp/par-verify/env.sh
chmod 600 /tmp/par-verify/ra-login.json
curl -s -o /dev/null -w 'login %{http_code}\n' -c /tmp/par-verify/ra.cookies -H "Host: $RA_HOST" -H 'Content-Type: application/json' \
  -d @/tmp/par-verify/ra-login.json "$API/api/v1/roboapply/auth/login"
chmod 600 /tmp/par-verify/ra.cookies
curl -s -b /tmp/par-verify/ra.cookies -H "Host: $RA_HOST" -H 'Content-Type: application/json' \
  -d '{"sort":"newest"}' "$API/api/v1/roboapply/feed/query" | jq '{count: (.data.items | length), first: (.data.items[0] | {title, company})}'
npx tsx server/src/features/jobs/ingest/verifyFeed.ts --brand roboapply | tee /tmp/par-verify/verify-feed-roboapply.txt
head -1 /tmp/par-verify/verify-feed-roboapply.txt
```

The first line of the report must read `Job index report for roboapply (market intl) …`. If it says `goapply`, the `--brand` argument was not passed: stop and run it again. (`--check` is not used here: the 300-row acceptance is GoApply's.)

Pass: `login 200`; the feed returns items; the report is for market `intl` and no source in it shows `ERROR`; RoboHire-bank rows are held while `ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE` is unset (about 70 rows on the dev database leave the feed: expected, owner item 6 of the plan's §8). That a posting located in mainland China is never written to market `intl` is covered by the ingest tests of step 1, not by this report.

**7.5 Plans.** `curl -s -H "Host: $RA_HOST" "$API/api/v1/roboapply/billing/plans" | jq '{currency: .data.currency, rails: .data.checkout.rails}'` prints `USD` and, with a Stripe key, `["stripe"]`. Never `alipay` for a new RoboApply checkout.

Fail: any RoboApply behaviour, plan, provider or copy that changed without a bundle item saying so.

## 8. Browser retests carried over from Wave FIX

Nothing in Wave FIX was checked in a browser (`requests/waveFIX-carryover.md`, Owner items 18 to 26). Run them in the same session, both brands where the item says so:

| Group | Retest |
|---|---|
| FIX-1 | top bar at 375 px and 761 to 1000 px (Safari and Firefox for the one-line ellipsis); `/no-such-page` console and theme flash; `next build` prerender of `/_not-found` and `/_global-error` (in a separate checkout, never where `next dev` runs) |
| FIX-2 | the first-visit tour and the finish banner on in-app navigation; the GoApply delete dialog in Chinese |
| FIX-3 | filter drawer comboboxes, `/jobs` and the tracker at 375 px and in dark mode; tailoring "Fit score not available" on the real provider |
| FIX-4 | resume editor at 375 px, toolbar wrap at 1280 px |
| FIX-5 | the rail composer margin (Safari and Firefox sticky), Stop mid-reply against the real server, "New chat about this job" |
| FIX-6 | code blocks in the text room at 375 px; the snap rows |
| FIX-7 | the language menu reload, the footer theme switch at 375 px in both themes and brands, the matcher through the real PDF path, signed-in `/help/ranking` |
| FIX-8 | G1 with an earlier-text grant, the manual profile form, `/legal` table below 640 px, RoboApply 繁體中文 and 日本語 "Tips and reminders" sentence |
| FIX-9 | a credit reserve, a commit and `/credits/history` with a practice debit against the clone branch database |

## Credentials the owner may still have to add

Their absence is reported, not treated as a failure. GoApply functions without them (plan §8).

| Variable | What it opens | Without it |
|---|---|---|
| `ALIPAY_CALLBACK_SECRET` (and `ALIPAY_API_URL` if the worker is not the default) | GoApply checkout through Alipay | plans and prices list; no payment can be opened and `/pricing` shows its "not open" notice (as RoboApply without `STRIPE_SECRET_KEY`) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | web push on both brands | `webPush` is off for both brands |
| `GOHIRE_PUBLIC_JOB_URL_TEMPLATE`, `ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE` | listing of recruiter-bank jobs | bank rows are synced, counted and held; needs a public posting page in the GoHire / RoboHire product first |
| `RA_CROSSBANK_CROSS_TENANT_CONFIRMED=true` | reading the GoHire bank at all (the legacy cross-tenant guard) | the bank is skipped; the feed still fills from the employer boards |
| `PUBLIC_DISPLAY_PROVIDERS` with `ats_public` | signed-out job pages and sitemap partitions for employer-board postings, on both brands | those postings are shown to signed-in users only |
| `ROBOAPPLY_EMAIL_FROM` (the shared verified sender); later `CN_EMAIL_FROM` with a verified `goapply.top` sender | GoApply mail that is delivered; then mail from its own address | with neither, the sender is `noreply@goapply.top`, which Resend refuses while that domain is unverified |
| `CN_SMS_PROVIDER` and its keys, the WeChat credentials | phone and WeChat sign-in | email and password sign-in only (plus the dev console demo) |
| `NEXT_PUBLIC_CN_EXT_ID` (the Microsoft Edge Add-ons id) | the GoApply extension install link | the `/extension` page renders without an install link |
| `CN_PAYMENT_COLLECTING_ENTITY` | the entity line on orders and receipts | one start-up warning; the order is created without the line |
| `CN_LEGAL_DOCS_VERSION` and the legal display values | final legal documents and footer lines | drafts with the DRAFT banner; footer lines not printed |
| domestic providers (`CN_LLM_*`, `CN_S3_*`, `CN_LIVEKIT_*`, Aliyun DirectMail, Aliyun Green) | latency and deliverability inside China; the strict posture | the shared stack |

## Clean up

```bash
rm -f /tmp/par-verify/go-login.json /tmp/par-verify/ra-login.json /tmp/par-verify/go.cookies /tmp/par-verify/ra.cookies
rm -rf /tmp/par-verify/base
```

Keep the reports (`verify-feed-*.txt`, `ra.json`, `go.json`, `ra-before.json`) until the result file below is written. `stack.log` may hold one-time sign-in codes of the phone demo: delete it with the rest when the run is over. The two test accounts stay in the dev database; say so in the report.

## Report format

One line per step: `step, pass | fail | not configured, evidence`. For a fail, add the exact command output or the screenshot, the bundle that owns the code (from `parity-bundles.json`), and whether RoboApply is affected. Save the report as `docs/jobright-clone/orch/parity-verify-results.md`.
