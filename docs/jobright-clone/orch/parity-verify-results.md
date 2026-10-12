# Browser and API verification of both brands (HANDOFF step 5)

Run on 2026-10-12 against the clone dev stack (`scripts/dev-clone.sh`, API 4621, web 3621) and the Neon branch `jobright-clone`, at `31b893d` and the fixes after it. Guide: [`parity-verify.md`](parity-verify.md). One line per check: result and evidence. "Not configured" names the missing setting; it is not a failure.

## How the stack was run

The branch database is a copy of production, and the dev API registers the platform crons in process. So `.env.local` carried, for this run only (removed afterwards):

- `ROBOAPPLY_CRON_DISABLED=true`: no in-process schedule, so no job alert, lifecycle e-mail, reminder or push could reach a real user's copy. (Earlier runs did try: every send failed, Resend refusing `roboapply.io` as unverified and `example.com` as a recipient.)
- `ENRICH_DAILY_JOBS=0`: no LLM enrichment (43,305 `job.enrich` items were queued; the default budget is 8,000 model calls a day per market).
- `RA_ONBOARDING_EXTERNAL_JOBS_DISABLED=true`: no metered job-search call.

Only `jobs-plan`, `jobs-boards` and `jobs-ingest` were triggered by hand. `queue-drain` (every worker kind, notifications included) and `score-precompute` (scores the copied real users) were not run.

## Results

| Step | Result | Evidence |
|---|---|---|
| 2 Brand payloads | pass | `roboapply`, `goapply` |
| 2 Capabilities on for RoboApply only | pass | `eeoAnswers`, `fx.reference`, `h1bHistory` (a subset of the six market keys; `auth.google`, `auth.line`, `pay.stripe` off because RoboApply has no Google or LINE client here and Stripe refuses the live key outside production) |
| 2 Parity capabilities on GoApply | pass | all `true` except `webPush`, off on both brands: not configured, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`. `campusCalendar` is GoApply's own |
| 2 Sign-in and payment lists | pass / not configured | GoApply `email_password,phone_otp`; `hiringContacts=deeplinks_only` on both; `paymentRails` empty on GoApply: not configured, `ALIPAY_CALLBACK_SECRET` |
| 3 Signed-out pages | pass | GoApply: all 14 paths 200. RoboApply: all 200, `/campus` 404 as designed |
| 3 GoApply static sitemap | pass | `/pricing`, `/tools/*`, the ungated feature pages, all on `www.goapply.top` |
| 3 Home pages in a browser | pass after fix | RoboApply home with a live role count; GoApply home in Chinese, "核心功能免费 · 每份申请都由你自己提交". **Fixed** `27c3789`: GoApply's English page had a Chinese tab title (`landing.cnHome.meta.title` in `en.json` was Chinese) |
| 4 GoApply sign-up policy | pass | `signupOpen: true`, `inviteRequired: false`, consents `pipl_basic_processing`, `age_16_plus`, `pipl_cross_border`; methods begin with `email_password` |
| 4.1 / 4.2 Sign-up, both brands | pass | Email and password; GoApply: email tab first, phone second, no invite field, three consents unticked, the cross-border text names the stack's processors (Neon us-west-2, Resend, openrouter, LiveKit Cloud, object storage) |
| 4.3 / 4.4 Verification and reset mail | not configured | Resend refuses `example.com` recipients (422) and `roboapply.io` is not a verified domain (403). Needs a verified sender (`ROBOAPPLY_EMAIL_FROM`) and a real inbox |
| 4.5 Resume upload and parse | pass | English PDF on RoboApply, Chinese PDF on GoApply; parsed (pdftotext, then one model call) |
| 4.5 Download of the original | not configured | Storing the original fails with "Access Denied": the S3 key in the clone `.env` cannot write to its bucket (every upload since 2026-10-10). The parsed resume is kept. `RESUME_FILE_STORAGE_PROVIDER=local` in `.env.local` does not reach the storage service: it settles its store while modules load, before `app.ts` reads `.env.local` (dev only) |
| Onboarding | pass | RoboApply 5 steps (situation, basics with a live market snapshot, resume, matching, confirm); GoApply 8 steps (separate PIPL choices, identity, education, intent with GB/T 4754 industries, tags, resume, matching, confirm), honest empty states throughout |
| 4.6 Assistant | pass | RoboApply ("What am I missing for this job?") and GoApply ("我为什么适合") answered from the resume and the posting, with the AI label and the daily count (30, then 29) |
| 4.7 Written practice | pass | Prepared in about 68 s; the voice room offered "Practice in writing instead"; five questions built from the resume, interviewer feedback after each answer; report 46/100 with "They don't predict a real interview". The abandoned voice session was closed "not charged" |
| 4.8 Voice practice | not exercised | The browser pane blocks camera and microphone (the device check said so and offered voice-only or writing). The worker registered as `RoboApply-Interview-Clone` |
| 4.11 / 5.4 Feed | pass | Both brands list jobs with tier, score, "This is not your chance of getting hired", source, dates, "Apply on company site"; GoApply "来源 … 查看原帖", "截止日期未注明", "最后核验" |
| Job page | pass after fix | **Fixed** `be76c6c`: "About the job" was empty for every employer-board posting (about 48,000 open rows; all of GoApply's feed): the HTML description went through Markdown, which drops raw HTML. It now shows `descriptionPlain`. AI fit ("Good fit 75/100") and the keyword check render |
| Tailoring | pass after fix | Verify-details flow, keyword check, no credit used on failure. **Fixed** `e89af45`: "BS/MS in Computer Science" read as a master's, so a B.S. holder saw "Your degree is below the listed level" |
| Sentence search | pass after fix | `上海的软件工程师职位` gives software engineer, CN, Shanghai within 40 km (12 jobs). **Fixed** `3e1cfd9`: one model answer with a field the strict plan check refuses had made it a 503; the planner is now asked once more |
| 5.1 Ingest | pass | `jobs-plan` skipped the metered providers; `jobs-boards` read 17 boards (2,735 written, 30 new, 50 closed, 0 board errors); `jobs-ingest` wrote 4,601 rows for RoboApply (Taiwan open data and 事求人 first runs on this branch) and synced 121 GoHire bank rows, held |
| 5.2 GoApply feed report | pass | `Job index report for goapply (market cn)`; `Acceptance: PASS`: 2,055 open public employer-board rows on 55 boards, none without provider id, apply URL, source name or apply host, no JSearch row. The 18 apply hosts outside the board systems are employers' own career sites |
| 7.4 RoboApply feed report | pass, one note | market `intl`; employer boards 2,619, `tw_open_data` 3,159, `tw_gov_jobs` 1,153 written today. Active Jobs DB shows `ERROR provider_unavailable` from 2026-10-11 (its free month), not today's run |
| 6 GoApply plans | pass / not configured | `CNY`, five paid plans 1200, 3900, 9900, 2900, 7900 fen, `sellable: true`, no `price_unset`; `paymentsOpen: false`, rails empty: not configured, `ALIPAY_CALLBACK_SECRET` |
| 7.5 RoboApply plans | pass / not configured | `USD`, never `alipay`; rails empty because the clone holds a live Stripe key, refused outside production |
| Pricing pages | pass | RoboApply: renewal rules, caps "Up to N a day", refunds, "Paid plans can't be bought yet". GoApply: ¥12 / ¥39 / ¥99 / ¥29 / ¥79, "一次性付款 · 到期不自动续费", no Stripe wording |
| Settings | pass | Account page loads |
| Sponsorship facts block (M5) | not exercised | No register or LCA rows on the branch (`RASponsorRegisterEntry` 0); the block correctly renders nothing. Needs the importers run once |
| Taiwan extras, closed notice, sources console (M5) | not exercised | Not reached in this pass |
| 8 Wave FIX retests | not exercised | Safari/Firefox and 375 px checks need a person at a browser |

## Noted, not changed

- Astera Labs postings show "Suzhou Qu, Gansu, China": the geocoder read 苏州 (Jiangsu) as 肃州区 (Gansu).
- The free daily tailoring cap is 3 on GoApply and 2 on RoboApply; check that the per-market difference is meant.
- The test accounts of this run and of 2026-10-10 (ten `claude-verify-*` users) were deleted on the branch afterwards, the way the account purge does for a user with no stored files: product events, the rows with no FK to User, then the User rows. No mainland row came from JSearch, LinkedIn or Active Jobs DB, so nothing was archived.
