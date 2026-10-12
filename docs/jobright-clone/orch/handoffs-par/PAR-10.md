# PAR-10

Docs, env examples, CN deploy kit, dev script and the post-merge verification list of the D5 parity wave. Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-PAR-10`, branch `wp/PAR-10`, base `3fa104e` (PAR-1 merged). Nothing committed, pushed, stashed or reset. No schema change, no dependency, no i18n change, no server or browser run, no provider call.

This is the handoff after the independent review. All nine review findings were real and are resolved (list at the end); the three items the reviewer judged not done (2, 3, 5) are done. The review found no unowned edit and there is none: the 16 changed files are all inside PAR-10's owns. Since the first handoff the other ten handoffs were written, so their requests to PAR-10 are applied too and the env cross-check (old request O-3) was run against all of them.

Everything PAR-10 owns is green (`__tests__/deploy/deployKit.test.ts`: 104 tests). Both typechecks pass for the whole repository and `npm run check` passes. The full suite has the same 95 red tests in the same 43 files that the PAR-1 handoff lists for the other bundles; this bundle turns none red.

## Items

### 1. [P0] The dev script no longer needs a GoApply preview profile: done

`scripts/dev-clone.sh`: the exports of `CN_LLM_PROVIDER`, `CN_LLM_MODEL`, `CN_RECRUITMENT_INFO_MODE`, `CN_CAMPUS_CALENDAR_ENABLED` and `CN_SIGNUP_MODE` are gone, and so is the comment block that said GoApply ships with features off. One optional line stays: `SMS_DEV_CONSOLE` (default `true`), described as the phone sign-in demo. `GOAPPLY_PREVIEW` is accepted and ignored for one release (one notice on stderr when it is set). Ports (API 4621, web 3621), the worker agent name and the three processes are unchanged.

Tests: `bash -n scripts/dev-clone.sh`; three tests in `deployKit.test.ts` ("clone dev script"): valid bash, the export list is exactly `PORT`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SHOW_ALL_NAV`, `INTERVIEW_ENGINE_AGENT_NAME`, `SMS_DEV_CONSOLE` (no `CN_` export), ports and process list kept.

ACCEPT ("GoApply has AI, feed, email, voice and open sign-up from the shared credentials alone") depends on the code bundles and is step 2 of the verification list. Names only, no values: the worktree copy of the clone `.env` and `.env.local` set no `CN_` value, no `FLAG_GOAPPLY_*`, no `ALLOWED_BRANDS`, no `BRAND_LOCK`; `ALIPAY_CALLBACK_SECRET` and the VAPID keys are not set, so checkout and web push will be reported "not configured".

### 2. [P0] `.env.example` describes China providers as optional overrides: done

As in the first handoff:

- Header and the "Jobright clone" block: the "no fallback from `CN_NAME` to `NAME`" text is replaced by the rule of plan §3.1, by class: per key, grouped (the four groups with every member and anchor named) and brand-own (the 18 names), plus the list of off switches and the three strict switches.
- Relabelled "OPTIONAL override; unset = shared stack": `CN_LLM_*`, `CN_EMAIL_*`, `CN_LIVEKIT_*` / `CN_VOICE_PROVIDER`, the CN speech pair, `CN_S3_*`, `CN_VAPID_*`. SMS and WeChat are labelled optional additional sign-in methods.
- Every variable of plan §4 is listed once with its default; the redefined ones say their new meaning; `ALLOWED_BRANDS` says both brands when unset and RoboApply only for a value that names no brand (P10-1); `CN_EXTERNAL_PROVIDERS` and the two `*_PUBLIC_JOB_BASE_URL` names are gone as settings and named in a "no longer read" note.
- The example ships no off switch and no half of a credential group.

Added after the review (the reviewer's reason for "not done": "every variable a code bundle reads is listed once"):

- **`LLM_CAMPUS_MODEL` and `LLM_FRAUD_MODEL`** have entries beside `LLM_ENRICH_MODEL` (commented, no default), and the two `CN_` comments now name the whole chain ("unset = `LLM_FRAUD_MODEL`, then the enrichment model, then the default model").
- **`npm run verify:llm`** is named in the GoApply models block as the way to see which stack each task resolves to (it calls no provider without `--probe`).
- **The flag examples are true now.** `FLAG_GOAPPLY_VISITOR_ASSISTANT=false` and `FLAG_GOAPPLY_COMPANY_NEWS=false` were listed as off switches although both flags are off by default on both brands. They are now under "Off by default on both brands; =true turns one on", with `FLAG_GOAPPLY_SEO_BROWSE`. `FLAG_GOAPPLY_EXTENSION=false` and `FLAG_GOAPPLY_AUTH_PHONE_OTP=false` joined the off-switch examples.
- **Collecting entity:** "printed on the order description (body) and the receipt; the order subject is unchanged".
- **Env cross-check against all ten handoffs, run by script** (every backticked name in each "Env variables added or redefined" section): every variable has an entry. The only names without an entry line are flag overrides (documented in the flag block), plan keys (documented as `CN_PRICE_<KEY>_FEN`) and the removed names (in the "no longer read" note).
- Requests to PAR-10 from the other handoffs, applied:
  - PAR-2: `LLM_CAMPUS_MODEL`, `verify:llm`; `CN_LLM_DOMESTIC_HOSTS` is only consulted behind the wall.
  - PAR-3 (already applied): keep `TOTP_ENCRYPTION_KEY` after adding the CN key; `CN_VAPID_PUBLIC_KEY` alone turns GoApply web push off. Added: `FLAG_GOAPPLY_AUTH_PHONE_OTP`.
  - PAR-4: a `CN_` voice value is read only with `CN_LIVEKIT_URL` and the shared worker serves GoApply by default (already there); the shared worker, its callback secret and callback origin serve both brands; a domestic live model is sent as written only on GoApply's own plane; the Parley pilot applies to both brands; after setting `CN_S3_BUCKET`, earlier GoApply recordings stay in the shared bucket and their playback links stop (copy `interviews/<sessionId>/`).
  - PAR-5: `CN_STORAGE_MODE` as built (`redact` removes ID numbers and health details from the stored text and keeps the file; `discard` keeps no original and no photo; an unknown value is read as `discard` and logged); the own bucket uses a `cn/` key prefix; a half-set `CN_S3_*` group fails under the strict switch in every region; `DEPLOY_REGION` alone no longer decides storage, egress, the consent or the free tools.
  - PAR-6: `ALIPAY_CALLBACK_SECRET` alone opens GoApply payments; the kill switch leaves the callback, the WeChat Pay notify and the order status open. The seven amounts and keys match PAR-6's table (old request P6-A: answered, no difference).
  - PAR-7: the GoHire bank is read only with `RA_CROSSBANK_CROSS_TENANT_CONFIRMED=true`; `GOHIRE_SYNDICATION_URL` wording; `INGEST_LINKEDIN_DAILY_CALLS` moved to the "no longer read" note (old request P7-A: PAR-7 says the adapter is not registered, so nothing reads it).
  - PAR-8: `NEXT_PUBLIC_CN_EXT_ID` is the Microsoft Edge Add-ons id and `NEXT_PUBLIC_CN_EXT_STORE_URL` is optional; `index` in `JOB_SEARCH_API_PROVIDERS`. `CN_JOB_SEARCH_API_PROVIDERS` and `CN_JOB_SEARCH_DISABLED` are confirmed by PAR-8's table (old request O-3: they stay).
  - PAR-9: `PUBLIC_DISPLAY_PROVIDERS` (values, default empty, `ats_public` for GoApply's employer-board postings) and `FLAG_<BRAND>_SEO_BROWSE` govern GoApply's public pages; `seo-rebuild` runs for GoApply; `CN_RECRUITMENT_INFO_MODE=off` also closes job search, public job and browse pages, ticker and sitemap partitions.
  - PAR-11: `FLAG_GOAPPLY_COMPANY_NEWS=true`; `LLM_FRAUD_MODEL`; the link-import rule on a mainland deployment (beside `FIRECRAWL_API_KEY`).

Tests ("root .env.example", 7 tests, one new): no superseded wording; the rule with every group anchor and member (read from `BRAND_ENV_GROUPS`); each plan variable exactly once, now including the four campus and fraud names, the fallback chain in both `CN_` comments, and `npm run verify:llm` (the script exists in `package.json`); removed names; the `ALLOWED_BRANDS` text against `allowedBrands()` / `allowedBrandsProblem()`; copied as it is, no off switch and no half group. **New: every `FLAG_GOAPPLY_<KEY>=false` example in the file must change at least one GoApply capability in `resolveFlags`, and every flag named under "Off by default" must change one with `=true` and none with `=false`.** That test fails on the two lines the reviewer found.

### 3. [P1] CN deploy kit lists nothing as a prerequisite except topology: done

As in the first handoff: the "Stage switches" block is deleted; a "Shared stack" section names what GoApply runs on; object storage, domestic LLMs, content safety, email and the media plane are "Optional override" sections; phone and WeChat are "Optional additional sign-in methods"; the strict posture is a commented block; values that selected a provider whose keys were blank are commented out; the three `PRISMA_*` names are listed (carry-over 1); README and `cn.web.env.example` say the same.

Added after the review:

- **The kit now names the shared verified sender.** `ROBOAPPLY_EMAIL_FROM=` stands directly under `RESEND_API_KEY=` in the "Shared stack" section, with the reason (without it and without `CN_EMAIL_FROM` the sender is `noreply@goapply.top`, which Resend refuses while that domain is unverified, so verification and password-reset mail would not be delivered). The "Optional override: email" comment and `deploy/cn/README.md` item 3 say it too. So "describes a working GoApply" now holds for email.
- **The kit test asserts the ACCEPT line.** "passes preflight with warnings" is asserted (no failure at all, `ok` true, at least one warning; and under `CN_RESIDENCY_STRICT=true` the same environment is refused again with `icp_missing` and `cn_storage_missing`, and only for provider or filing codes) as soon as the boot check and the preflight read the strict switch. That is decided from the source of `startupAssertions.ts` and `preflight.mjs`, not from what the preflight reports, so a provider code that starts failing by default again cannot switch the assertion off. At this base (PAR-5 not merged) those lines do not run and the test holds what can hold on both sides: no topology failure, and no failure code outside the eight provider and filing codes. I ran the same environment in-process against PAR-5's working tree: `ok: true`, no failure, 5 warnings; strict: `icp_missing`, `cn_storage_missing`, `content_safety_not_aliyun_green`, `cn_email_offshore`, `content_safety_not_cn1_ready`. PAR-5's handoff confirms the eight codes.
- `RA_CROSSBANK_CROSS_TENANT_CONFIRMED=` is listed in the kit's "Job sources" section (PAR-7).

Tests ("mainland kit", 8 tests, one new): the seven of the first handoff, with the preflight test rewritten as above and `ROBOAPPLY_EMAIL_FROM` in the test values and in the "lists the shared stack" list; new: the sender line stands under the Resend key with its reason, the kit names the address that is refused, the README names the variable, and the root example ships the shared sender as an active line and no `CN_EMAIL_FROM`.

### 4. [P1] Plan documents state D5 as implemented and mark the superseded rules: done

Unchanged from the first handoff (README, TASK_PLAN with new §14, ARCHITECTURE with new §1.6.1 and rewritten §4.2, CN_TW_LAUNCH_PLAN, PRODUCT_PLAN, three alignments in GOAPPLY_PARITY_PLAN, `orch/README.md`, the carry-over file, root `README.md`; `market/*` not edited). One addition: `docs/jobright-clone/README.md` D5 section lists the settings and decisions the other bundles raised (the shared verified sender; `PUBLIC_DISPLAY_PROVIDERS` for GoApply's public job pages; the cross-tenant guard for the GoHire bank; `CN_STORAGE_MODE` semantics and the open question on its unknown-value rule; integration keys on GoApply).

Tests: `npm run check` passes (the copy gate does not scan these documents).

### 5. [P0] Post-merge verification list: done

`docs/jobright-clone/orch/parity-verify.md`, rewritten after the review so that an agent with no terminal and no persistent shell can run it top to bottom:

- **Setup writes `/tmp/par-verify/env.sh`** and every block that needs the checkout or the addresses starts with `. /tmp/par-verify/env.sh`. The stack can be started in the background with its log kept. All 25 bash blocks pass `bash -n`.
- **The shared-credentials check** reads `.env`, `.env.local` and the launching shell, and covers `ALLOWED_BRANDS` and `BRAND_LOCK` (names only).
- **Sessions are cookie jars**, made by signing the test account in with `curl -c` from a private JSON file; later blocks send `-b <jar>`. The pasted-cookie form stays as the alternative for a person at a terminal. A "Clean up" section deletes the login files, the jars and the baseline copy.
- **Step 1** has a check that the strict posture is merged and that the kit test's "passes the preflight" branch ran.
- **Step 2** adds `npm run verify:llm`, and no longer lists `visitorAssistant` among the capabilities that must be on. That was a mistake of the first version, not of the plan: plan §3.11 says the visitor assistant works on both brands when its flag is on, and the registry default is off on both (confirmed by PAR-9). `extension` is in the list now.
- **Step 3:** the `/pricing` row accepts the "not open" notice when `ALIPAY_CALLBACK_SECRET` is unset (reported as not configured) and fails a notice while `paymentsOpen` is true. Added from PAR-9: `/tools/job-alerts`, `/sitemap.xml`, `/sitemaps/static.xml`, the GoApply static sitemap contents, one free-tool run with the notice ticked.
- **Step 5:** `verifyFeed.ts --brand goapply --check` with the exit code printed (exit 1 is a fail), and "the first line of the report names the brand; if not, stop". The pass lines name the lines of PAR-7's report. New 5.6: a public job page for the first posting, with the `PUBLIC_DISPLAY_PROVIDERS` rule. Field names of 5.4 are confirmed by the PAR-11 handoff; the item id is `jobId`.
- **Step 7.1 computes the baseline:** the flag code of the last commit before the wave, extracted with `git archive` to `/tmp`, run with today's environment, compared with `ra.json` by `jq`; expected `[]`. I ran the script on this worktree: it prints 26 capability names.
- **Step 7.4:** `verifyFeed.ts --brand roboapply`, with the same first-line check.
- The credentials table gained the shared sender, the cross-tenant guard, `PUBLIC_DISPLAY_PROVIDERS` and the extension id.

## Precedence (documents over items)

- **Item 5, expected `jq` output.** The item says "expected output: h1bHistory, eeoAnswers, fx.reference, pay.stripe, auth.google, auth.line only". Plan §3.2 says "every flag true for RoboApply is true for GoApply, except" those six. A key appears in the difference only when it is true for RoboApply, and four of the six need RoboApply's own credential or an admin rate. The list passes when the output is a **subset** of the six; a missing one is reported "not configured".
- **Item 4, "JOB_SOURCES_CN section 5".** The sentence "a bank job opens the GoHire page" is in its §2.1 and §8 rule 3; §5 only depends on it. MARKET_STRATEGY M-7 already carries the condition (its finding C18). README and TASK_PLAN §14.4 say exactly that.
- **Deployment scope.** An `ALLOWED_BRANDS` or `BRAND_LOCK` value that names no valid brand serves RoboApply only in every environment and is logged; it does not refuse the boot (on the mainland kit it does, through `intl_brand_on_mainland`). Documented that way everywhere.
- **Plan §7 step 2** says "With `SMS_DEV_CONSOLE` unset"; item 1 makes the script default it to `true`. The list runs that check as `SMS_DEV_CONSOLE=false ./scripts/dev-clone.sh`.
- **Off values.** MARKET_STRATEGY §4.3 says `CN_PAYMENTS_ENABLED` is off for `false / 0 / off`. PAR-1's `switchedOff` treats any set value that is not `true / 1 / yes / on` as off. The catalogue says "false (or 0 / off / no)"; both readings agree on those.

## Carry-over (`requests/waveFIX-carryover.md`, PAR-10)

1. `PRISMA_*` names mirrored in the kit: done. 2. PRODUCT G3 `fullTime`: the owner has not ruled; the row states what was built and that the default is open. 3. Nothing to do. 4. Browser retests added to the verification list (§8): done. No "Hot files" or "Unowned fix WPs" entry names a file PAR-10 owns.

## Files changed

16 files, all inside PAR-10's owns:

- `scripts/dev-clone.sh`
- `.env.example`
- `deploy/cn/cn.env.example`, `deploy/cn/cn.web.env.example`, `deploy/cn/README.md`
- `__tests__/deploy/deployKit.test.ts`
- `README.md`
- `docs/jobright-clone/README.md`, `TASK_PLAN.md`, `ARCHITECTURE.md`, `CN_TW_LAUNCH_PLAN.md`, `PRODUCT_PLAN.md`, `GOAPPLY_PARITY_PLAN.md`
- `docs/jobright-clone/orch/parity-verify.md` (new), `docs/jobright-clone/orch/README.md`
- `docs/jobright-clone/requests/waveFIX-carryover.md`

Changed in the review pass: `.env.example`, `deploy/cn/cn.env.example`, `deploy/cn/README.md`, `__tests__/deploy/deployKit.test.ts`, `docs/jobright-clone/orch/parity-verify.md`, `docs/jobright-clone/README.md`.

Outside the worktree: this handoff only (`/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-par/PAR-10.md`).

## Tests run

All run in the worktree after the last edit.

| Command | Result |
|---|---|
| `bash -n scripts/dev-clone.sh` | ok |
| `npx vitest run __tests__/deploy/deployKit.test.ts` | 104 / 104 (102 before the review; 2 new, 1 rewritten) |
| `npx vitest run __tests__/deploy` | 4 files, 152 / 152 |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 (design, copy, LLM costs, API boundary, extension, zh variants) |
| `node docs/jobright-clone/orch/check-bundles.mjs docs/jobright-clone/orch/parity-bundles.json` | 11 bundles, 0 problems |
| `grep -nEi 'no fallback\|ships? dark\|never falls? back'` over the five env and kit files | no match |
| `bash -n` on each of the 25 bash blocks of `orch/parity-verify.md` | 0 syntax errors |
| `npx vitest run --exclude ".claude/**"` | 12,844 tests: 12,738 passed, 95 failed, 1 skipped, 10 todo; 43 files failed, 579 passed |

Not touched: `extension/`, `interview-agent/`.

## Red tests for other bundles

None caused by this bundle. The 95 failures are in the 43 files of "Red tests for other bundles" in the PAR-1 handoff (all under `server/src/` except `__tests__/shell`); none is under `__tests__/deploy`, and no failing file reads a file this bundle changed.

## Pre-existing failures

None besides the 95 above.

## Requests

### Orchestrator

- **O-1. `docs/runbooks/cn-deploy.md` (in no bundle's owns) still tells an operator the old rules.** Change: §1 table, row "Object storage": "No fallback to the international bucket." → "Optional override (`CN_S3_*`, anchored on `CN_S3_BUCKET`); unset = the shared store. Required only under `CN_RESIDENCY_STRICT=true`." Row "Voice worker": add "for GoApply's own media plane (`CN_LIVEKIT_*`); on the shared LiveKit project the shared worker serves GoApply". §2 "Gates before the first production deploy": say these are the owner's legal track, not code gates; replace "Content safety live: `CN_CONTENT_SAFETY_PROVIDER=aliyun_green` with keys" by "recommended; required only under the strict posture"; delete "Payments stay off (`CN_PAYMENTS_ENABLED=false`) until C-12 and C-13" or reword it as the owner's choice of the kill switch; replace "The API refuses to boot if the residency assertions fail, and the preflight refuses a few more cases" by "The API and the preflight refuse a wrong topology only; a missing China-specific provider or filing number is a warning unless `CN_RESIDENCY_STRICT=true`". Near line 146: the preflight line may now be "OK, with warnings". Near line 183 ("CN-0 stores no resume originals or photos for GoApply by default"): no longer true, originals are stored under `goapply/` in the shared store unless `CN_STORAGE_MODE` says otherwise. Add `ROBOAPPLY_EMAIL_FROM` to the secrets the API needs (the shared verified sender). `deployKit.test.ts` only requires that the runbook keeps the six legal names and `cn.web.env.example`.
- **O-2. `deploy/cn/k8s/api.yaml` line 41** (in no bundle's owns): the comment "Refuses to start the API when the mainland checks fail (residency, …)" → "Refuses to start the API on a wrong topology; provider and filing problems are warnings unless `CN_RESIDENCY_STRICT=true`". `deploy/cn/k8s/worker.yaml` header: add that this Deployment is for GoApply's own media plane.
- **O-3. After the merge, optional tidy-up in `__tests__/deploy/deployKit.test.ts`:** once step 1 of the verification list has shown that the strict posture is merged, the `if (STRICT_POSTURE_BUILT)` guard, the constant and the comment below the branch can be deleted so the assertions are unconditional. Nothing is wrong if they stay: after the merge the guard is always true.
- **O-4. The sentence "Bank jobs open the GoHire page" in `docs/jobright-clone/market/JOB_SOURCES_CN.md` §2.1 and §8 rule 3** was left as it is (the item forbids editing `market/`). The correction is stated beside the cross-links (README D5 section, TASK_PLAN §14.4, ARCHITECTURE §4.2, CN_TW §7). The market wave should fix the sentence in place.
- **O-5. Before the wave branch is pushed:** `ALLOWED_BRANDS=roboapply` on every Vercel environment (PAR-1 O-1). It is step 0 of the verification list and owner item 5 in the README.
- **O-6. An existing `.env` copied from the old `.env.example` may hold `CN_SIGNUP_MODE=invite`, `CN_RECRUITMENT_INFO_MODE=off`, `CN_PAYMENTS_ENABLED=false`.** They are off switches now. The clone `.env` and `.env.local` copies in this worktree have none of them (names checked, no value read); check the Vercel project's variables the same way before GoApply goes live. Check there too that `ROBOAPPLY_EMAIL_FROM` is set, or GoApply mail is sent from an unverified address.
- **O-7. `/tmp/par-verify` in the verification list** is the list's own working directory (mode 700, deleted in its "Clean up"). If the orchestrator's agents must not write under `/tmp`, replace the path in `env.sh` and in the blocks by their scratch directory; nothing else depends on it.
- Closed since the first handoff: the env cross-check (done against all ten handoffs), the field names of §5.4 (confirmed by PAR-11), `INGEST_LINKEDIN_DAILY_CALLS` (PAR-7), the price keys and amounts (PAR-6), the eight preflight codes (PAR-5).

### PAR-5

- **P5-A.** For information: the kit test turns its strict assertions on when both `server/src/platform/residency/startupAssertions.ts` and `deploy/cn/preflight.mjs` mention `CN_RESIDENCY_STRICT` or `cnResidencyStrict` (true in your working tree). It then expects, for the filled kit example: no failure, at least one warning; and under `CN_RESIDENCY_STRICT=true` failures that include `icp_missing` and `cn_storage_missing` and nothing outside the eight codes. A new failure code that fires by default on the shared stack turns that test red, by design: tell the orchestrator.
- **P5-B.** The documents and the verification list say startup logs: a half-set GoApply group (warning), an `ALLOWED_BRANDS` / `BRAND_LOCK` that names no brand (error), an unknown `CN_RECRUITMENT_INFO_MODE`, `CN_SIGNUP_MODE` or `CN_STORAGE_MODE` value and an invalid content-safety setting. If a line is not logged at boot, the place to adjust is "Setup" in `orch/parity-verify.md`.

### PAR-4

- **P4-A.** `interview-agent/deploy/cn/README.md` and `worker.env.example` (yours) describe the GoApply worker as the only way GoApply gets voice. Add one line: this worker serves GoApply's own media plane (`CN_LIVEKIT_*`); on the shared plane the shared worker serves both brands. `deployKit.test.ts` pins `GoApply-Interview`, `WORKER_BRAND=goapply` and the domestic backends in the kit's worker manifest, image and compose file; none of that needs to change.

### PAR-3

- **P3-A.** For information: the kit and the verification list rely on `fromFor` as you built it (GoApply on Resend: `CN_EMAIL_FROM`, then `ROBOAPPLY_EMAIL_FROM`, then `EMAIL_FROM`, then the registry address). If that order changes, the lines to adjust are the "Shared stack" comment of `deploy/cn/cn.env.example` and row 4.3 of `orch/parity-verify.md`.

### Owner

- Set `ALLOWED_BRANDS=roboapply` on Vercel (Production and Preview) before the wave is pushed; remove it on the day GoApply goes live.
- Keep `ROBOAPPLY_EMAIL_FROM` set wherever GoApply runs until a `goapply.top` sender is verified and `CN_EMAIL_FROM` names it.
- Decide whether `CN_RECRUITMENT_INFO_MODE=false | 0 | no` should close the GoApply feed like `off` (PAR-1's open question; the documents describe today's rule: only `off`).
- Decide whether GoApply's employer-board postings get signed-out pages: add `ats_public` to `PUBLIC_DISPLAY_PROVIDERS` (the same gate as RoboApply's, default empty).
- PRODUCT G3: keep the optional 是 / 否 for 统招 or restore the "On" default.
- The nine items of plan §8, and the settings the bundles raised, are listed in `docs/jobright-clone/README.md` under D5.

## Schema requests

None.

## Env variables added or redefined

PAR-10 adds no variable to the code. It documents the wave's variables in `.env.example`, and changes one script default:

| Name | Meaning | Default |
|---|---|---|
| `SMS_DEV_CONSOLE` (in `scripts/dev-clone.sh` only) | phone sign-in demo: codes printed in the API log; never read in production | `true` in the clone dev script (as before, but no longer behind `GOAPPLY_PREVIEW`); unset elsewhere |
| `GOAPPLY_PREVIEW` | retired; accepted and ignored by the dev script for one release | none |
| Documented with defaults (plan §4) | `CN_LLM_DOMESTIC_ONLY` (off), `CN_RESIDENCY_STRICT` (off), `CN_STORAGE_MODE` (`store`), `CN_INTERVIEW_CAMERA_PUBLISH` (on), `CN_RECRUITMENT_INFO_MODE` (`licensed`), `CN_CAMPUS_CALENDAR_ENABLED` (on), `CN_SIGNUP_MODE` (`open`), `CN_PAYMENTS_ENABLED` (on), `CN_PRICE_<KEY>_FEN` (catalog default), `CN_PAYMENT_REQUIRE_ENTITY` (off), `CN_EMAIL_TRANSPORT` (`resend`), `GOHIRE_BANK_TRANSPORT` (`db` with TLS, else `api` with a key), `GOHIRE_SYNDICATION_URL` (unset = the list endpoint), `GOHIRE_PUBLIC_JOB_URL_TEMPLATE` / `ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE` (unset), `JOB_PROVIDERS_ROBOAPPLY` / `_GOAPPLY` (registry list), `CN_VAPID_*` (shared pair), `ALLOWED_BRANDS` (both) | |
| Documented after the review | `LLM_CAMPUS_MODEL`, `LLM_FRAUD_MODEL` (shared task models GoApply reads when the `CN_` twin is unset; unset = the enrichment model, then the default model) | unset |
| Documented from the sibling handoffs | `CN_JOB_SEARCH_API_PROVIDERS`, `CN_JOB_SEARCH_DISABLED` (per-key overrides, PAR-8); `FLAG_GOAPPLY_EXTENSION`, `FLAG_GOAPPLY_AUTH_PHONE_OTP` (off switches); `FLAG_GOAPPLY_VISITOR_ASSISTANT`, `FLAG_GOAPPLY_COMPANY_NEWS`, `FLAG_GOAPPLY_SEO_BROWSE` (off by default, `=true` turns on) | |
| Listed in the mainland kit | `ROBOAPPLY_EMAIL_FROM` (the shared verified sender), `RA_CROSSBANK_CROSS_TENANT_CONFIRMED` (needed for the GoHire bank), the three `PRISMA_*` tuning names | |
| Removed from the catalogue | `CN_EXTERNAL_PROVIDERS`, `GOHIRE_PUBLIC_JOB_BASE_URL`, `ROBOHIRE_PUBLIC_JOB_BASE_URL`, `INGEST_LINKEDIN_DAILY_CALLS` (named in the "no longer read" note) | |

## i18n keys added or changed

None. PAR-10 has no namespace and changed no product copy.

## Known gaps

- **Nothing here was run against a stack or a browser.** The verification list was checked against the code and the sibling handoffs and working trees (read-only), its bash blocks are syntax-checked, and two of its pieces were run on this worktree with no stack: the names-only environment check and the step 7.1 baseline script. The session step relies on `curl` matching a cookie jar to the custom `Host` header, which is `curl`'s documented behaviour but was not exercised here; the pasted-cookie form is the fallback, and the block prints `session 200` or not, so a mismatch is visible at once.
- **The kit's "passes preflight with warnings" is asserted by the test only after PAR-5 is merged.** At this base the assertion is skipped by design (the provider codes still fail). Step 1 of the verification list checks that the strict branch ran.
- **`.env.example` describes behaviour that arrives with the other bundles** (shared-stack fallbacks, key prefixes, whole-yuan overrides, the bank transport, the sender order). It follows their handoffs as written on 2026-10-11; a bundle that changes after its own review should say so to the orchestrator.
- **The older plan documents are marked, not rewritten line by line.** Each has a binding note at the top, the named sections are rewritten, and the rules are marked in place. Work-package texts of Waves 1 to 5, TASK_PLAN Appendix A and the CN_TW work packages still describe what was built under the old rules; the header rule in each document says how to read them.
- **`docs/runbooks/cn-deploy.md` and two manifest comments** still state the old gating (O-1, O-2).
- **Sibling working trees were read, never modified** (`git -C … diff`, `grep` and `sed` by absolute path, and one in-process run of PAR-5's `runPreflight` with test values from a scratch script). Scratch files were written only in the session scratch directory.

## Review resolution

Items the reviewer judged not done:

- **Item 2 (`.env.example`): done.** `LLM_CAMPUS_MODEL` and `LLM_FRAUD_MODEL` are listed, `npm run verify:llm` is documented, and the cross-check now covers all ten handoffs by script.
- **Item 3 (mainland kit): done.** The kit names the shared verified sender, and the test asserts "passes preflight with warnings" once PAR-5's change is present.
- **Item 5 (verification list): done.** The `verifyFeed` calls, the `/pricing` row and the session steps are fixed; the list no longer needs a terminal or a persistent shell.

Findings (all nine verified against the code first; none rejected):

1. **`verifyFeed` argument (medium): fixed.** Verified in PAR-7's script: only `--brand <id>` is read, default `goapply`. Step 5.2 runs `--brand goapply --check` and prints the exit code; step 7.4 runs `--brand roboapply`; both check the first line of the report; `--env-file=.env` is dropped.
2. **`/pricing` row (medium): fixed.** Verified in PAR-9's page (`notOpen = paymentsOpen === false`, copy "会员卡暂时还不能购买。"). The row accepts the notice without `ALIPAY_CALLBACK_SECRET` as "not configured" and fails a notice while `paymentsOpen` is true or a plan without a price.
3. **Shared verified sender missing from the kit (medium): fixed.** Verified in PAR-3's `fromFor` and the registry address. `ROBOAPPLY_EMAIL_FROM` is in the kit's shared stack with the reason, in the README and in the email-override comment; a new test pins it; `FILL` and the shared-stack list include it. Also added to the verification list (row 4.3, credentials table) and the owner notes.
4. **`LLM_CAMPUS_MODEL`, `LLM_FRAUD_MODEL`, `verify:llm` (low): fixed** as proposed, plus assertions for all three in the test.
5. **Two inaccurate statements (low): fixed.** Confirmed with `resolveFlags` that the two `=false` lines changed nothing. Beyond the proposed wording, a new test checks every `FLAG_GOAPPLY_` example in the file against `resolveFlags`, so the mistake cannot come back. Entity wording corrected to "order description (body)".
6. **Session steps need a terminal (low): fixed.** `env.sh` in Setup, sourced by each block; cookie jars from a login file; the `read -rs` form kept as the alternative. Verified the login route, its body and the cookie it sets.
7. **Shared-credentials check reads `.env` only (low): fixed.** The check reads `.env`, `.env.local` and the shell, and includes `ALLOWED_BRANDS` and `BRAND_LOCK`. I ran it on this worktree: it prints nothing.
8. **Kit test never asserts that the preflight passes (low): fixed in the test, not left to a merge step.** The reviewer proposed that the orchestrator edit the test after the merge. Instead the test turns the strict assertions on by itself when the strict posture is in the source, so no manual step can be forgotten; the proposed assertions (`codes` empty; strict contains `icp_missing` and `cn_storage_missing`) are the ones it makes. Step 1 of the list confirms the branch ran. The optional tidy-up is request O-3.
9. **Step 7.1 has no baseline (low): fixed, with two deliberate differences from the proposal.** (a) The baseline commit is `606365f`, not `84dfc24`: `606365f` is the parent of PAR-1's commit `5822134`, the last commit before any parity code, and it differs from `84dfc24` under `server/src/platform` (5 files of the fix-pass gate). (b) The files are extracted with `git archive` into `/tmp` instead of `git worktree add`, so the repository's worktree list is not touched and nothing has to be removed from it afterwards; `dotenv` is loaded from the checkout's own `node_modules`. The script was run here and prints 26 capability names.

Unowned edits: the review found none, and `git status` shows only the 16 owned paths.
