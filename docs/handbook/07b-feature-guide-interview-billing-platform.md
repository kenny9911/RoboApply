# Feature guide: interviews, billing and the platform around them

As of 2026-11-03 (main @ b89d5256).

A map for engineers. Each section says what the feature does for the user, how a request flows end to end, where the code is, which tables and providers it touches, and what is easy to break. It points to the deeper specs instead of repeating them. Paths are relative to this file.

Conventions used below:

- "Seeker API" means `/api/v1/roboapply/*`; feature routers are mounted from one table, `FEATURE_MOUNTS` in [`server/src/features/index.ts`](../../server/src/features/index.ts), after the legacy routers in [`server/src/app.ts`](../../server/src/app.ts). Admin feature routers sit at `/api/v1/roboapply/admin/<area>`, public ones at `/api/v1/public/*`, raw-body webhooks at `/api/v1/webhooks/*`.
- "D1 … D6" are the owner rulings in [`docs/jobright-clone/README.md`](../jobright-clone/README.md). The ones that matter most here: D1 (the product never submits an application), D3 (never fabricate data, sources, prices or counts), D5 (both brands have the same functionality; `CN_*` providers are optional overrides) and D6 (sources, prices and payment rails are per market).
- The Prisma schema is a directory, [`server/prisma/schema/`](../../server/prisma/schema/) (`legacy.prisma` plus one `ra-*.prisma` file per area), not the single `schema.prisma` file that `AGENTS.md` names.

---

## 1. Interview engine (mock interviews and practice)

### What it does

A candidate picks a job (typed, searched, browsed by industry, pasted, or opened from a job page), gets a plan written for that job (requirements, a set of simulated interviewers, focuses, the company's interview style when public sources exist, a strategy), and runs a 15, 20 or 30 minute practice. Voice/video practice talks to an AI interviewer in real time; written practice is a typed question-and-answer loop. Both end in a scored report. Third parties can run the same voice interviews through an API-key surface.

### Two practice paths

| | Live (voice or video) | Written |
|---|---|---|
| Row | `InterviewSession` ([`legacy.prisma`](../../server/prisma/schema/legacy.prisma)) | `RAMockSession` ([`ra-mock.prisma`](../../server/prisma/schema/ra-mock.prisma)) |
| Question writer | [`prompt/interviewPromptService.ts`](../../server/src/interview-engine/prompt/interviewPromptService.ts): Tavily research → one `InterviewBlueprintAgent` call → deterministic voice prompt ([`voiceSystemPrompt.ts`](../../server/src/interview-engine/prompt/voiceSystemPrompt.ts)) | [`RAInterviewPromptService.ts`](../../server/src/roboapply/v2/services/RAInterviewPromptService.ts): Tavily → requirements → strategy → tactics → questions agents |
| Conversation | LiveKit room + the `interview-agent/` worker (or the Parley pilot) | [`RAMockService.ts`](../../server/src/roboapply/v2/services/RAMockService.ts) + `RAMockInterviewerAgent`, one HTTP call per turn |
| Scoring | Deterministic scorer, then the LLM evaluation (three agents) | The same deterministic scorer ([`scoring/interviewScorer.ts`](../../server/src/interview-engine/scoring/interviewScorer.ts)); no LLM evaluation |
| Metering | Credit gate at create; pro-rated debit at finalize | Credit gate at start; pro-rated debit at score, only if at least one answer |
| When used | Default on both brands | When voice is unavailable for the brand (GoApply with `ai.interviewVoice` off or no usable voice config), or when a live practice switches to writing (`fromSessionId`) |

`RAMockService` is the older RoboApply "mock" service. It is no longer called directly for new work: both the first-party routes (`/practice/text/*`) and the legacy `/api/v1/roboapply/v2/mock/*` routes go through the written-practice wrappers in `InterviewSessionService` (`startTextPractice`, `textPracticeTurn`, `scoreTextPractice`), which add the credit gate, the job's market check and the idempotent completion debit. Do not add a new caller of `raMockService` that skips those wrappers.

### Flow end to end (live practice)

1. **Setup.** [`app/(auth)/practice/page.tsx`](<../../app/(auth)/practice/page.tsx>) owns state and engine calls; [`components/v3/mock/PracticeTargetPicker.tsx`](../../components/v3/mock/PracticeTargetPicker.tsx) and [`PracticeSetupFlow.tsx`](../../components/v3/mock/PracticeSetupFlow.tsx) own the screen. `GET /practice/setup` returns the market, the job (if `?job=`), the server-chosen resume, the first-free-practice state, the voice/AI gate, recording availability and consent, and the media policy.
2. **Prep.** `prep/industries`, `prep/roles`, `prep/search` (job finder) and `prep/plan` (planner). The browser keeps the plan for 30 minutes per target. Details: [`docs/interview-practice/PREP_AGENTS.md`](../interview-practice/PREP_AGENTS.md).
3. **Create.** `POST /practice/sessions` with the plan (`prep`) and the chosen interviewer and focus. `createSession` loads and market-checks the job (404 before any charge), snaps the duration, picks the format (GoApply's `cn_ai_interview` where it applies), runs the credit gate (402 with an upsell payload), resolves the brand's media plane and voice, decides recording from the consent ledger, and writes the row with status `preparing`. The plan is stored in `InterviewSession.blueprint.prep`.
4. **Prepare.** The page navigates to [`app/(auth)/practice/[id]/page.tsx`](<../../app/(auth)/practice/[id]/page.tsx>) and calls `POST /sessions/:id/prepare` (LLM, can be slow; a GET poll backs it up). Success → `created`; failure → `failed` with `llm_unavailable` or `prepare_failed`, never charged.
5. **Device check, then connect.** Mic (and camera for video) are opened before `POST /sessions/:id/connection`, because minting the token creates the room, dispatches the worker and starts egress (status `live`).
6. **Live.** The worker posts transcript batches, lifecycle and metrics to `/callbacks/sessions/:id/*` (shared secret). The page calls `POST /sessions/:id/coach` for one-line live hints ([`coaching/interviewCoachService.ts`](../../server/src/interview-engine/coaching/interviewCoachService.ts), never throws) and `client-events` for telemetry.
7. **End.** `POST /sessions/:id/end` → `finalizing`, an `{type:'end'}` data message to the worker, a wait for its drain, then `finalize()`: transcript to R2, deterministic score, LLM evaluation, cost ledger, credit debit. A session with zero candidate turns becomes `failed`/no-answer and is not charged. LiveKit's `room_finished` / `egress_ended` webhooks also finalize.
8. **Report.** [`app/(auth)/practice/[id]/report/page.tsx`](<../../app/(auth)/practice/[id]/report/page.tsx>) polls `GET /sessions/:id/report`; deterministic scores arrive first, the LLM review and the recording later. GoApply adds the `cn` block and the AI-generated label.
9. **Clean-up.** The `interview-cleanup` cron (every 15 minutes) finalizes or expires stuck sessions (`reconcileExpiredSessions`; expiry `INTERVIEW_ENGINE_SESSION_EXPIRY_MIN`, default 120).

Disconnect is not end: a `live` session is rejoinable (re-minted token, re-dispatched agent). Only a deliberate end or a server-side termination finalizes, so a Wi-Fi blip never scores and bills a half interview.

### Routes

All under `/api/v1/interview-engine` ([`routes/index.ts`](../../server/src/interview-engine/routes/index.ts)). Frontend wrappers: [`lib/api/interviewEngine.ts`](../../lib/api/interviewEngine.ts) (`interviewEngineApi`, `practiceApi`, `prepApi`, `textPracticeApi`).

| Prefix | Auth | File | Purpose |
|---|---|---|---|
| `/catalog`, `/sessions/*`, `/requirements/preview` | cookie/JWT | `internalRoutes.ts`, `previewRoutes.ts` | Session lifecycle used by the practice pages |
| `/v1/practice/*` (setup, sessions, jobs, `text/*`, `prep/*`) | cookie/JWT only; an API key gets 403 | `externalRoutes.ts`, `prep/routes.ts` | First-party practice |
| `/v1/sessions/*` | `X-API-Key` only; a cookie gets 403 | `externalRoutes.ts` | External developer API (sessions scoped to the key owner and key; durations 5–120 min; records only when the tenant sends `recording: true`) |
| `/callbacks/sessions/:id/{transcript,usage,metrics,lifecycle}` | `LIVEKIT_AGENT_CALLBACK_SECRET` | `callbackRoutes.ts` | Worker → control plane |
| `/webhooks/livekit`, `/webhooks/parley` | provider signature on the raw body | `webhookRoutes.ts`, `parleyWebhookRoutes.ts` | Room/egress events |

Trap: the first-party practice routes live under the external router's `/v1` prefix but are the opposite surface (`requireFirstParty`). Every route that calls a model goes through [`routes/practiceGate.ts`](../../server/src/interview-engine/routes/practiceGate.ts): RoboApply is always open; GoApply needs a bound phone (403 `phone_binding_required`) and a live `ai_resume_parsing` consent (503 `ai_unavailable`), and voice additionally needs `ai.interviewVoice` and a configuration a voice session can start on.

I could not find how interview API keys are issued in RoboApply: the `X-API-Key` path reads the shared `ApiKey` table (legacy RoboHire model); the only key issuer in this repo is the job-search one (`rajs_` keys, [`server/src/job-search/keys.ts`](../../server/src/job-search/keys.ts)). Unverified.

### Server modules

| Module | Role |
|---|---|
| [`sessions/InterviewSessionService.ts`](../../server/src/interview-engine/sessions/InterviewSessionService.ts) (3.3k lines) | The lifecycle orchestrator; the header comment is the best overview. Also the written-practice wrappers and the first-free-practice grant |
| [`catalog/`](../../server/src/interview-engine/catalog/) | 18 personas (`interviewCatalog.ts`, the WHO), 7 archetypes (HOW they probe and grade), 28 formats plus GoApply's `cn_ai_interview` (STRUCTURE), 18 domain-expert playbooks (SUBSTANCE, classified from the role title and JD; resolved domain persisted in the blueprint) |
| [`skills/`](../../server/src/interview-engine/skills/) | 23 loop patterns, 12 market norms, and the registry the planners read |
| [`prep/`](../../server/src/interview-engine/prep/) | Job finder, company style (Tavily), industries (27), planner, market context, cache, routes |
| [`prompt/`](../../server/src/interview-engine/prompt/) | Blueprint agent, prompt service, voice system prompt, `llmFailure.ts` (classifies prepare failures) |
| [`scoring/`](../../server/src/interview-engine/scoring/) | Deterministic scorer; `interviewEvaluationService.ts` runs `HolisticScorecardAgent` + `QuestionDeepDiveAgent` in parallel, then `RecommendationsAgent`; never throws. `cnRubricBranch.ts` adds the GoApply lens and `cn` block only when the session ran the cn format |
| [`billing/sessionCost.ts`](../../server/src/interview-engine/billing/sessionCost.ts) | Cost-to-serve per session (blueprint, live LLM/STT/TTS, evaluation, coach) on the row, mirrored to `UsageDeductionLog` as SKU `mock_interview`; calls the credit debit |
| [`providers/`](../../server/src/interview-engine/providers/), [`livekit/`](../../server/src/interview-engine/livekit/) | Per-brand voice seam (`livekit_cloud` default; `volcano`/`trtc` reserved and answer 503), room/dispatch/egress, webhook verification per plane |
| [`parley/`](../../server/src/interview-engine/parley/) | The Parley WebRTC pilot |
| [`storage/r2Storage.ts`](../../server/src/interview-engine/storage/r2Storage.ts) | `interviews/<sessionId>/{recording.mp4,transcript.json,transcript.txt,report.json}` |
| [`config.ts`](../../server/src/interview-engine/config.ts) | The only file in the engine that reads `process.env`; lists every variable |

### Durations and credits

- First-party practice: 15, 20 or 30 minutes, default 20 (`snapPracticeMinutes`, `DEFAULT_PRACTICE_MINUTES` in [`prep/contract.ts`](../../server/src/interview-engine/prep/contract.ts)). Older links asking for longer snap to the nearest.
- GoApply's AI-interview format runs 20 or 30 (`clampCnMinutes` in `features/cn/interview/format.ts`; a 15 snaps up to 20). A planned practice runs that format only when the plan chose it; an unplanned GoApply general practice (screening/behavioral/culture) of 20–30 minutes runs it automatically.
- 1 practice credit = 20 minutes (`RA_MOCK_CREDIT_MINUTES`); other lengths are pro-rated. Credits live in the mock-credit ledger, not the window buckets (section 2).
- Exempt from the gate and the debit: admins (`creditExempt`), and the `recruiter` / `external` sources. A non-admin account with legacy `role === 'user'` is created with source `recruiter`, so it is ungated. That is deliberate in the code; know it when you test with an old account.

### The voice worker (`interview-agent/`)

A separate long-running Node process on `@livekit/agents`; it cannot run on Vercel. Read [`interview-agent/README.md`](../../interview-agent/README.md). The contract with the control plane:

- **Agent name.** Worker `INTERVIEW_ENGINE_AGENT_NAME` must equal the API's (default `RoboApply-Interview`; GoApply's own plane `GoApply-Interview`). Explicit dispatch only. A mismatch means dispatch succeeds and nobody joins; the UI says "agent never joined" after about 15 s.
- **Callback secret.** `LIVEKIT_AGENT_CALLBACK_SECRET` must match on both sides, or transcripts and lifecycle callbacks are refused and reports come out empty.
- **Callback origin.** Outside local dev set `INTERVIEW_ENGINE_CALLBACK_BASE_URL` (or rely on the create request's origin, which the session stores); otherwise the worker posts to localhost and every callback is lost.
- **Room metadata** is `InterviewRoomMetadata` in [`server/src/interview-engine/types.ts`](../../server/src/interview-engine/types.ts), built by `buildRoomMetadata` in the session service: system prompt, `openingInstruction`, `openingLine`, voice, STT, `llm {model, reasoningEffort}`, duration, language, callback base URL. The worker also understands `openingGreeting`/`openingQuestion` and `liveLlm`, but on main the control plane sends the combined `openingLine` (the worker splits it, `src/opening.ts`) and puts the live model in `llm`.
- **Models.** The live model must be in `ALIGNED_INTERVIEW_MODELS` in `config.ts` (a LiveKit Inference allowlist), or session create answers 503. Probe a new id with `cd interview-agent && npm run verify:llm`; `verify-llm.mjs` mirrors the list.
- **Dev.** `npm run dev` supervises the worker (`scripts/dev-interview-agent.sh`, log `/tmp/roboapply-interview-agent.log`); it reads only `interview-agent/.env.local`. A dev worker registers under the production name, so production dispatches can land on a laptop.
- **"30-second sessions"** (fixed 2026-07): `SESSION_EXPIRES_IN=30d` was read with `parseInt`, giving 30-second sign-in sessions that also killed mid-interview calls. TTL variables now go through [`server/src/lib/parseDuration.ts`](../../server/src/lib/parseDuration.ts) and accept s/m/h/d/w. If interviews drop at about 30 s again, check that nobody bypasses it. (Source: the owner's notes and the code; I found no document in `docs/` describing it.)

### Parley pilot

`INTERVIEW_ENGINE_PARLEY_PILOT` ([`parley/parleyConfig.ts`](../../server/src/interview-engine/parley/parleyConfig.ts)): unset/`off` = LiveKit for everyone; `all`; or a comma list of emails/user ids. Parley is a standalone WebRTC service (its own VAD/STT/LLM/TTS); the browser connects to it directly, skipping LiveKit and the worker. The choice is stored on the session at create (`liveMetrics.control.transport`), so flipping the flag never moves a live session. Needs `PARLEY_URL`, `PARLEY_API_KEY`, `PARLEY_WEBHOOK_SECRET`, `PARLEY_AGENT_ID`. Under the GoApply domestic-only wall a GoApply session never takes Parley. Frontend: `components/v3/mock/parley/`. The production host for Parley is not set up (owner notes; unverified here).

### Recording

Off unless `INTERVIEW_ENGINE_RECORDING_ENABLED` is on, R2 can store, and the user has a live `interview_recording` consent (`interview_video` for video). The decision is made at create from the consent ledger and stored; egress starts only if it says so (rule H8).

### Honesty rules (do not regress)

- Interviewer names are invented and labelled simulated; titles describe a seat in the loop, never a real person.
- Company style is "from public sources" only when the agent cited results; otherwise it becomes "usual practice for companies like it" with no stages or values (`companyStyle.ts`, `basis: 'sources' | 'general'`). Questions are never presented as a company's real questions.
- Searches carry only a job title and a company name; `assertNoPiInPayload` refuses anything else. `IMPORT_FETCH_DENYLIST` hosts (LinkedIn, Indeed, Glassdoor, BOSS直聘, 104 …) are never searched or shown.
- Report scores describe this practice, never a prediction.

### Related pages that are not the interview engine

- `/coaching` ([`app/(auth)/coaching/page.tsx`](<../../app/(auth)/coaching/page.tsx>), `features/coaching/`) is the human-coach directory (WP-72): request a coach by email, capability `coaching`, no bookings, nothing charged. The live interview coach is `POST /sessions/:id/coach`, shown by `components/v3/mock/LiveCoach.tsx`.
- `/practice/questions` is the interview question bank (`features/prep/`, `RAInterviewQuestion`), mounted at `/api/v1/roboapply/interview-bank`.

### Read next

[`PREP_AGENTS.md`](../interview-practice/PREP_AGENTS.md) (prep layer), [`interview-agent/README.md`](../../interview-agent/README.md) (worker), the `InterviewSessionService.ts` header, [`docs/jobright-clone/GOAPPLY_PARITY_PLAN.md`](../jobright-clone/GOAPPLY_PARITY_PLAN.md) §3.5 (voice on GoApply).

---

## 2. Credits, plans and billing

### What it does

Free users get daily/weekly caps per AI feature and one free practice once their account is verified (plus one for finishing the getting-started checklist). Paid plans unlock the Pro caps and grant practice credits; practice packs add credits valid 12 months. RoboApply sells through Stripe in USD (TWD optional); GoApply sells one-time passes and packs in CNY through Alipay (WeChat Pay optional).

### Two credit systems

| | Window buckets | Practice credits |
|---|---|---|
| What | Per-feature caps: `fit_analysis`, `tailor`, `cover_letter`, `resume_check`, `rewrite`, `outreach`, `assistant`, `autofill`, `ai_answer`, `job_import`, `ready_kits`, `competitiveness`, `contact_lookup` (0 until a licensed provider exists) | Interview minutes, 1 credit = 20 min |
| Code | [`platform/credits/`](../../server/src/platform/credits/): `catalog.ts` (caps per brand × free/pro), `CreditService.ts` (reserve → commit/release, `withCredit`), `EntitlementService.ts` | [`server/src/lib/mockCreditService.ts`](../../server/src/lib/mockCreditService.ts) (balance, gate, debit, plan grants); [`platform/credits/practice.ts`](../../server/src/platform/credits/practice.ts) (idempotent grants) |
| Tables | `RACreditWindow`, `RACreditLedger` (reservations and idempotency claims), `RACreditGrant`, `RAEntitlementOverride` ([`ra-credits.prisma`](../../server/prisma/schema/ra-credits.prisma)) | `SeekerSubscription.mockCredits` (running balance), `MockInterviewCreditLedger` (immutable movements); packs are `RACreditGrant` rows with bucket `practice` |
| Usage log | `commit` writes one `UsageDeductionLog` row (success-only billing) | `sessionCost.ts` writes SKU `mock_interview` |
| Admin override | AppConfig `credits.catalog.v1` (validated, cached 30 s), `PUT /admin/credits/catalog` | AppConfig `mock_plans.{env}` for the grandfathered Free/Starter/Growth plans (`mockInterviewPlans.ts`) |

`CreditService` rules: debited only on success; an idempotency key per user and bucket; a released reservation can be re-armed by a retry; stale reservations (older than 15 min) are released by the `jobs-maintain` cron; a busy database gives `CreditStoreBusyError` (503) on reserve and keeps the result of work already done. A reservation while an admin is viewing as the user throws `ViewAsReadOnlyError`.

Where window credits are charged (callers of `withCredit`/`reserve`): copilot, cover letters, the extension (autofill, AI answers), job import, match and competitiveness, network outreach, resume check, builder and tailor, the agent, and `roboapply/v2/routes/resumes.ts`. Practice credits are charged by the interview engine only (section 1). Every plan, Pro included, has a cap; copy says "Up to N", never "unlimited". Caps table: [`MARKET_STRATEGY.md`](../jobright-clone/market/MARKET_STRATEGY.md) §3.

### Plan catalog and prices

[`platform/billing/planCatalog.ts`](../../server/src/platform/billing/planCatalog.ts). Prices are catalog defaults in code; env values only override them, and no paid plan is ever "price not set".

| Plan key | RoboApply (USD, Stripe) | GoApply (CNY, Alipay) |
|---|---|---|
| `pro_weekly` | $9.99, renews weekly | not defined (no auto-renew on the mainland rails) |
| `pro_monthly` | $24.99, renews; 3 practice credits a period | ¥39, 30-day pass; 3 credits once |
| `pro_quarterly` | $54.99, renews; 3 credits a month | ¥99, 90-day pass; 3 credits a month |
| `pro_week_pass` | $9.99, 7 days, no renewal; 1 credit | ¥12; 1 credit |
| `practice_pack_5` / `_15` | $9.99 / $24.99 | ¥29 / ¥79 |
| `student_monthly` / `_quarterly` | $17.49 / $37.99 (flag `student`) | ¥29 / ¥69 passes |

Overrides: `PRICE_<KEY>_USD_CENTS` (alias `STRIPE_PRICE_<KEY>_CENTS`), optional pin `STRIPE_PRICE_<KEY>`, Taiwan `PRICE_<KEY>_TWD_CENTS`; GoApply `CN_PRICE_<KEY>_FEN` (whole yuan only). Weekly plans and passes are never preselected; auto-renewing plans need the unticked acknowledgement (consent `auto_renew_ack`). Legacy `starter`/`growth` are grandfathered, never sold. `GET /api/v1/roboapply/billing/plans` returns the catalog with `sellable` and `paymentsOpen`.

### Stripe (RoboApply only)

- **Live-key guard** ([`stripeEnv.ts`](../../server/src/platform/billing/stripeEnv.ts)): only `sk_test_`/`rk_test_` count as test keys; every other key is live and is refused unless `VERCEL_ENV=production` or `STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION=true`. Then `getStripe()` returns null and no Stripe call of any kind is made. The local `.env` holds a live key, so locally Stripe is off unless you put in a test key.
- **Rail readiness**: a usable key and a webhook secret (`ROBOAPPLY_STRIPE_WEBHOOK_SECRET` or `STRIPE_WEBHOOK_SECRET`, each a comma list for rotation). Without both, plans list with prices and `payments_disabled`.
- **Catalog sync** ([`stripeCatalog.ts`](../../server/src/platform/billing/stripeCatalog.ts)): products `ra_pro`, `ra_pro_student`, `ra_pro_week_pass`, `ra_practice_pack`; prices found or created at checkout by lookup key `ra_<planKey>_<currency>_<amountMinor>_incl`. A changed amount is a new price.
- **Webhook**: `POST /api/v1/roboapply/stripe/webhook` ([`roboapply/routes/stripeWebhook.ts`](../../server/src/roboapply/routes/stripeWebhook.ts), raw body, mounted before `express.json`). Every subscription event re-reads the subscription first; every effect is claimed in `RACreditLedger`, so replays are no-ops. Events not ours (other products on the same account) answer 200 `handled: false`. Lost-event recovery for one-time payments: `POST /billing/checkout/reconcile` from the return page. Event table: [`MARKET_STRATEGY.md`](../jobright-clone/market/MARKET_STRATEGY.md) §5.1.
- **Seeker routes**: `/api/v1/roboapply/billing/{plan,credits,checkout,checkout/reconcile,portal,cancel,switch,history,invoices/:id/download}` ([`roboapply/routes/billing.ts`](../../server/src/roboapply/routes/billing.ts), service `RoboApplyBillingService.ts`) and `/api/v1/roboapply/credits/{,history,cancel,cancel/survey,resume,withdrawal}` ([`features/credits/routes.ts`](../../server/src/features/credits/routes.ts)). The emailed no-login cancel link uses `/api/v1/public/cancel`.
- Local testing needs the owner's test key and a `stripe listen` secret: [`STRIPE_TEST_RECIPE.md`](../jobright-clone/market/STRIPE_TEST_RECIPE.md).

### Alipay (GoApply) and the frozen contract

- Rail: [`platform/billing/rails/alipayWorker.ts`](../../server/src/platform/billing/rails/alipayWorker.ts), over the GoHire payment worker. It opens with one credential, `ALIPAY_CALLBACK_SECRET`; `CN_PAYMENTS_ENABLED=false` is the kill switch (prices stay listed, no new order, callbacks stay open).
- Callback: `GET`/`POST /api/v1/roboapply/billing/alipay/callback` → `handleAlipayCallback` in `RoboApplyBillingService.ts` → `fulfilPass` ([`platform/billing/fulfilPass.ts`](../../server/src/platform/billing/fulfilPass.ts)). Orders are `AlipayOrder` rows (`RAORDER_…`, tier with the `ra_` prefix).
- **Frozen.** Rules A1–A12 ([`MARKET_STRATEGY.md`](../jobright-clone/market/MARKET_STRATEGY.md) §5.2) are pinned by tests named `A<n> …` in `fulfilPass.test.ts`, `rails/rails.test.ts`, `roboapply/routes/billing.test.ts` and `RoboApplyBillingService.alipay.test.ts`. Never edit, skip or weaken them; a red one means your change is wrong. Do not edit `fulfilPass.ts`, the callback route or `handleAlipayCallback`. A GoApply plan never reaches Stripe and the Stripe webhook never activates a `goapply` object (A11). Cut-over steps: [`ALIPAY_CUTOVER.md`](../jobright-clone/market/ALIPAY_CUTOVER.md).

### WeChat Pay (GoApply, optional second rail)

Built: [`rails/wechatpay.ts`](../../server/src/platform/billing/rails/wechatpay.ts) (Native, H5, JSAPI; API v3 signing; raw-body notify at `/api/v1/webhooks/wechatpay`), routes in [`features/billing-cn/`](../../server/src/features/billing-cn/). Orders reuse `AlipayOrder` (channel `wechatpay`) and fulfil through `fulfilPass`. The rail reports itself unconfigured until the `WECHATPAY_*` merchant credentials are set and `WECHATPAY_MERCHANT_ENTITY` matches `CN_PAYMENT_COLLECTING_ENTITY`. Not configured anywhere as far as the docs say.

### Refunds, withdrawal, admin billing

- Rules ([`MARKET_STRATEGY.md`](../jobright-clone/market/MARKET_STRATEGY.md) §4.4): first purchase refundable within 7 days (weekly and pass: 48 h) with fewer than 5 paid-only credits used; packs while unused; statutory 14-day withdrawal for EU/EEA/UK/Taiwan.
- Stripe: [`stripeRefunds.ts`](../../server/src/platform/billing/stripeRefunds.ts). A full refund reverses entitlements through `charge.refunded` (so a Dashboard refund behaves the same); a partial refund changes no access; a withdrawal cancels the subscription first, then refunds. Records: `RABillingRefund`.
- GoApply: refunded by hand in the Alipay merchant console, then recorded with `POST /admin/credits/cn-orders/:orderId/refund`, which reverses the entitlement once.
- Admin billing (`/api/v1/roboapply/admin/credits/*`, [`features/credits/adminRoutes.ts`](../../server/src/features/credits/adminRoutes.ts), page [`app/(auth)/admin/credits`](<../../app/(auth)/admin/credits/page.tsx>)): caps editor, entitlement overrides, refunds and refund quote, CN orders, practice cost, Stripe health (read-only endpoint check), TWD reference rate, TW revenue. Money actions name the acting admin.

### Frontend entry points

`/pricing`, [`app/(auth)/settings/billing`](<../../app/(auth)/settings/billing/page.tsx>) (+ `/return`, `/history`), `/cancel`, the shared out-of-credits sheet opened on any 402. API modules: `lib/api/credits.ts`, `lib/api/account.ts`, `lib/api/billingCn.ts`, `lib/api/adminBilling.ts`.

---

## 3. Growth and notifications

### Invites and referrals

- Invite friends (F-GROW-01, [`features/growth/referrals.ts`](../../server/src/features/growth/referrals.ts); the header describes the whole life cycle). `/invite` shows the code (created only after the inviter's account is verified). A friend signs up through `/r/<code>`; signup passes `?ref=` to `recordAttribution`. When the friend is verified and has finished onboarding, a risk check runs (`referralRisk.ts`; score ≥ 50 holds for review); otherwise both get 1 practice credit (cap 10 rewarded invites per inviter per calendar year). Rewards are practice credits, never cash. Nothing in the product sends the invite: the user shares the link.
- Tables: `RAReferralCode`, `RAReferral`, `RAAttribution`, `RAGrowthChecklist`, `RAReferralSignal` ([`ra-growth.prisma`](../../server/prisma/schema/ra-growth.prisma)). Held rewards: `/api/v1/roboapply/admin/growth/referrals`.
- Getting-started checklist: `GET /api/v1/roboapply/growth/checklist`; steps complete only through `markChecklistStep()` on the server.
- Not the same thing: GoApply's 内推码 hub (`/referrals`, `features/cn/referrals`, flag `cn.referralCodes`) is employee referral codes for jobs, and GoApply invite-only signup codes (`RABrandInvite`, `/admin/invites`) are used only when `CN_SIGNUP_MODE=invite`.

### Email

- [`platform/email/EmailService.ts`](../../server/src/platform/email/EmailService.ts): `sendEmail({ template, to, userId, locale, params })`. Templates in [`platform/email/templates/`](../../server/src/platform/email/templates/) (auth, billing, coaching, growth, notify), localized per brand and locale. Non-transactional mail (alerts, tips, marketing) needs the preference gate and gets a signed unsubscribe link and RFC 8058 headers. Every send writes `RAEmailLog` (address stored as sha256). It never throws for delivery problems.
- Transport: Resend (`RESEND_API_KEY`) for RoboApply and, by default, GoApply; GoApply can switch with `CN_EMAIL_TRANSPORT` (`aliyun_dm` | `none`).
- Sender: RoboApply reads `ROBOAPPLY_EMAIL_FROM`, then `EMAIL_FROM`. GoApply reads `CN_EMAIL_FROM`, then the shared sender under GoApply's display name. **Trap:** `roboapply.io` has no Resend DNS records; production sends from `EMAIL_FROM` = `noreply@updates.robohire.io` (per [`HANDOFF.md`](../jobright-clone/HANDOFF.md) §6). `.env.example` shows `ROBOAPPLY_EMAIL_FROM=RoboApply <noreply@roboapply.io>`; copying that makes every send fail until the domain is verified in Resend.

### Lifecycle mail, job alerts, reminders

| Cron (vercel.json) | Code | What |
|---|---|---|
| `job-alerts` every 15 min | [`features/alerts/cron.ts`](../../server/src/features/alerts/cron.ts) | Saved-search alerts (`RAAlertDelivery`); free 1 a day, Pro "as they arrive" (stored cap 100 a day); also the logged-out visitor digests |
| `lifecycle-emails` hourly at :15 | [`features/lifecycle/`](../../server/src/features/lifecycle/) | Welcome, finish setup, resume check ready, tips (first tailor, practice), re-engagement only with a real count of ≥ 3 new jobs. One lifecycle message per person per day; quiet hours 21:00–08:00 local; "Tips and reminders" default off for EEA/UK/CH/CA and GoApply |
| `reminders` hourly | `features/alerts/reminders.ts` | Tracker and agent reminders; also purges free-tool results older than 24 h |
| `billing-renewal-reminder` daily | `roboapply/services/RoboApplyBillingReminderService.ts` | Renewal reminders (MARKET_STRATEGY §4.4) |

Logged-out alerts: `/tools/job-alerts`, `/api/v1/public/alerts`, `RAAnonAlertSubscription`. In-app inbox and preferences: `/api/v1/roboapply/notifications`, page `/inbox`. Announcements: `RAAnnouncement`, admin `/admin/announcements`. GoApply WeChat MP messages: `features/notify-cn/`.

### Web push

[`features/push/`](../../server/src/features/push/), `/api/v1/roboapply/push`. VAPID keys `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:` or `https:`); GoApply uses its own `CN_VAPID_*` set only when `CN_VAPID_PUBLIC_KEY` is set. Without keys the area answers 501 `provider_not_configured` (nothing is simulated). `FLAG_<BRAND>_WEB_PUSH=false` turns it off per brand. Table `RAPushSubscription`. Importing the router registers the `web_push` delivery channel with alerts.

### Unsubscribe

Stateless HMAC tokens ([`platform/email/unsubscribe.ts`](../../server/src/platform/email/unsubscribe.ts); secret `EMAIL_UNSUBSCRIBE_SECRET`, else derived from `JWT_SECRET`). `GET /api/v1/public/email/unsubscribe` previews (link scanners GET too), `POST` turns the list off (one-click). Page `/unsubscribe/<token>`. Lists: alerts/digest, reminders, tips (withdraws the tips consent), marketing (withdraws `marketing_email`). A token is verified for the request's brand.

### Traps

- **Crons and production.** `CRON_SECRET` is not set on Vercel, so all 16 cron routes answer 401 in production; setting it starts all of them at once (job reads, up to 8,000 enrichment calls a day per market, alerts, lifecycle mail, account purge). Decide budgets first ([`HANDOFF.md`](../jobright-clone/HANDOFF.md) §6). I cannot verify Vercel state from the repo.
- **The local API runs the same sweeps in process** (node-cron, [`roboapply/schedulers/RoboApplyCronService.ts`](../../server/src/roboapply/schedulers/RoboApplyCronService.ts)) against whatever database `.env` names. With a production or production-copy database that means real alerts, mail and push. Set `ROBOAPPLY_CRON_DISABLED=true` in `.env.local` before running the stack against such a database.

---

## 4. Admin

### Who and how

Admin is `User.role === 'admin'`; server routes use `requireAuth` + `requireAdmin`. Admins are credit-exempt in practice.

### Two admin APIs

| API | Mounted at | Code | Covers | Audit table |
|---|---|---|---|---|
| Analytics console (legacy) | `/api/v1/roboapply/v2/admin/*` | [`roboapply/v2/routes/admin.ts`](../../server/src/roboapply/v2/routes/admin.ts), `RAAdminAnalyticsService.ts` | Operations overview, users, payments, activity (+ CSV), sessions, set a user's plan, rate card | `AdminAdjustment` |
| Admin console (WP-74) | `/api/v1/roboapply/admin/*` | [`features/admin/routes.ts`](../../server/src/features/admin/routes.ts) | System (queue, retries, admin audit), costs, safety, reports, entitlement overrides, referral moderation, copilot feedback, view-as | `RAAdminAuditLog` via `writeAdminAudit` ([`audit.ts`](../../server/src/features/admin/audit.ts)) |
| Area admin routers | `/api/v1/roboapply/admin/<area>` | `features/*/adminRoutes.ts` | credits, compliance, growth/referrals, prep, coaching, announcements, auth-cn, career-sources, cn/jobs, cn/campus, cn/referrals, tw | `RAAdminAuditLog` where they call `writeAdminAudit` |

Pages: [`app/(auth)/admin/page.tsx`](<../../app/(auth)/admin/page.tsx>) (tabs overview, users, payments, activity, sessions, rate card; data from the legacy API through `lib/api/adminOperations.ts`) and sub-pages `users/[userId]`, `sessions/[sessionId]`, `credits`, `system`, `reports`, `sources`, `questions`, `coaches`, `campus`, `announcements`, `invites`, `fraud`. API module `lib/api/admin.ts` wraps both surfaces.

Older audit rows written before `RAAdminAuditLog` existed stay in `SeekerActivityLog`.

### View as (read-only god's-eye view)

[`platform/viewAs/viewAs.ts`](../../server/src/platform/viewAs/viewAs.ts). `POST /api/v1/roboapply/admin/view-as` sets an httpOnly `ra_view_as` grant (1 hour, signed with a key derived from `JWT_SECRET`, bound to the admin's own session); `POST /view-as/stop` ends it; each writes an audit row. While a grant is applied:

- `requireAuth` ([`middleware/auth.ts`](../../server/src/middleware/auth.ts)) refuses every non-read with 403 `view_as_read_only`. Reads are GET/HEAD/OPTIONS plus the exact POST paths in `VIEW_AS_READ_POSTS` (today `/api/v1/roboapply/feed/query` and `/api/v1/roboapply/search-profiles/count`). **If you add a read that is sent as POST, add its path there**, or it fails under view-as.
- Anything that stamps the user's own activity must check `getCurrentViewAs()` ([`lib/requestContext.ts`](../../server/src/lib/requestContext.ts)) and skip: `lastActiveAt`, `UserActivity`, the `/auth/me` region stamp and the feed's "last visit" already do. Credit reservations throw.
- An expired or invalid grant is dropped with `X-RA-View-As: ended`; a read continues as the admin.

### LLM stack settings

Effective model settings come from AppConfig `llm_stack.*`, resolved by [`lib/llm/llmStackConfigResolver.ts`](../../server/src/lib/llm/llmStackConfigResolver.ts) (a save writes an `AdminAdjustment` row). Verified: nothing in this repo calls `saveLlmStack`, so there is no admin UI or route that writes `llm_stack` in RoboApply; changes are made in the database or from RoboHire's admin.

---

## 5. SEO, landing and the i18n surface

| Piece | Where | Invariant |
|---|---|---|
| Localized homes `/{locale}` | [`app/[locale]/page.tsx`](<../../app/[locale]/page.tsx>), `/` = English | A segment that is not one of the brand's locales 404s. `/en` renders English with canonical `/`. GoApply indexes `zh` only (`seoLocales`). |
| `x-pathname` | [`proxy.ts`](../../proxy.ts) stamps it; [`lib/serverLocale.ts`](../../lib/serverLocale.ts) reads it (path > cookie > Accept-Language) | Remove it and every `/{locale}` page renders in the cookie's language with a wrong `<html lang>`. |
| `SEO_READY_LOCALES` | [`lib/localeConfig.ts`](../../lib/localeConfig.ts), used by [`lib/seo.ts`](../../lib/seo.ts) | Gates hreflang, sitemap and index/noindex. All 9 locales are in it today. A new locale joins only after its `landing` namespace is translated. |
| Sitemaps | `app/sitemap.xml/route.ts` (index), `app/sitemaps/[file]` (static + API partitions `roles-<n>`, `jobs-<n>`, ≤ 45,000 URLs) | Host-aware, per brand. |
| `llms.txt` | `app/llms.txt/route.ts` → `llmsTxt(brand)` in `lib/seo.ts` | Says the user applies themselves (D1), quotes no prices, closes `/job/*` to AI crawlers. |
| Programmatic pages | `/browse/[...path]` (role, role × city, remote, visa sponsorship, entry level, internships, graduate), `/job/[idSlug]`, `/tools/[tool]` | Data from `/api/v1/public/seo/*` ([`features/seo/routes.ts`](../../server/src/features/seo/routes.ts)); flag `seo.browse`; job pages only for `PUBLIC_DISPLAY_PROVIDERS`; pages below the job-count floor are noindex. `RASeoPage` is rebuilt by the daily `seo-rebuild` cron, which only uses real counts and revalidates changed tags. |
| Structured data | `lib/seo.ts` | No prices, ratings or reviews in JSON-LD (D3). |

Skills for this surface: `.claude/skills/landing-review-panel` (expert + persona review of a landing change), `seo-geo-audit`, `i18n-locale-sync` (any copy change must reach every locale; run `npm run check`). [`docs/LANDING_GAP_ANALYSIS.md`](../LANDING_GAP_ANALYSIS.md) is historical (see the stale list below).

---

## 6. GoApply (China) specifics and compliance

### What differs (and what does not)

Same features on both brands (D5). Brand is resolved per request from the Host header ([`platform/brand/registry.ts`](../../server/src/platform/brand/registry.ts)); `ALLOWED_BRANDS` narrows a deployment.

| | RoboApply | GoApply |
|---|---|---|
| Hosts, market | roboapply.io, `intl` (Taiwan included) | goapply.top, `cn` |
| Locales | 9 | `zh`, `en` (SEO `zh` only) |
| Sign-in | email/password, Google, LINE | email/password, phone OTP (`RAPhoneOtp`), WeChat (web, in-app, mini program); optional invite-only signup |
| Payments | Stripe, USD (TWD optional) | Alipay (+ WeChat Pay optional), CNY, one-time only |
| Job sources | RapidAPI providers, employer boards, banks | Its own sources and index, no RapidAPI ([`JOB_SOURCES_CN.md`](../jobright-clone/market/JOB_SOURCES_CN.md)); `CN_RECRUITMENT_INFO_MODE=off` hides every posting |
| AI gate | none | bound phone + live `ai_resume_parsing` consent before any model call (`platform/consent/aiAllowed.ts`) |
| Content safety | never checked | every AI input and output checked ([`platform/llm/contentSafety/`](../../server/src/platform/llm/contentSafety/)): built-in keyword list by default, Aliyun Green optional; block → 422 `content_blocked`; provider failure → 503 (fail closed); every check writes `RAContentSafetyEvent` |
| Interview | shared formats | adds `cn_ai_interview` (20/30 min) and the `cn` report block |
| Legal | | ICP and PSB numbers, `CN_LEGAL_*`, `CN_GENAI_*` from config; nothing shown that ops has not set |

### Residency and the domestic-only wall

[`platform/residency/`](../../server/src/platform/residency/) and [`platform/llm/brandPolicy.ts`](../../server/src/platform/llm/brandPolicy.ts):

- By default GoApply runs on the shared stack (OpenRouter, Resend, LiveKit Cloud, shared bucket under a `goapply/` prefix); what goes offshore is disclosed and consented to (`pipl_cross_border`), not refused.
- `CN_LLM_DOMESTIC_ONLY=true` (implied by `CN_RESIDENCY_STRICT=true`) restricts GoApply models to domestic vendors (DeepSeek, DashScope, Moonshot, Zhipu, Volcano Ark, MiniMax China, `CN_LLM_DOMESTIC_HOSTS`), with no international fallback and no BYOK. It also keeps GoApply interview sessions off Parley.
- `CN_RESIDENCY_STRICT=true` turns the PI egress rule into an allowlist, requires a mainland bucket for originals (else 503 `storage_unavailable`), and makes the boot advisories fatal.
- RoboApply: PI never goes to a mainland model endpoint or mainland-only services; matching is by endpoint host.
- Both brands: Tavily, Firecrawl and RapidAPI receive no PI (`assertNoPiInPayload`).
- `DEPLOY_REGION=cn-mainland` always refuses a wrong topology at boot (database host not on the CN allowlist, RoboApply served from the mainland); an unknown value is refused everywhere.
- Upload policy: `CN_STORAGE_MODE=redact|discard` (an unknown value reads as `discard`).
- `writeBrand.ts`: a residency-critical write without a brand context never guesses RoboApply on a two-brand deployment; it writes nothing.

### Compliance module

[`features/compliance/`](../../server/src/features/compliance/), `/api/v1/roboapply/compliance` (seeker), `/api/v1/public/legal` (public), `/api/v1/roboapply/admin/compliance` (PI requests). No capability flag: legal surfaces exist on every brand.

- Disclosures (`disclosures.ts`): models, processors and filings describe the stack the brand really resolves; unset filing numbers are absent, never "pending".
- Consents (`consents.ts`): catalog with prose versions, grants and withdrawals stored with a prose hash (`SeekerConsentRecord`).
- PI requests and data export (`piRequests.ts`, `dataExport.ts`; `RAPersonalInfoRequest`).
- Account purge (`purge.ts`): withdrawing a consent the service cannot run without closes the account at once and hard-deletes it; otherwise the nightly `account-purge` sweep deletes closed accounts after `ACCOUNT_PURGE_RETENTION_DAYS` (default 30). `compliance-daily` closes requests and purges old logs.
- AI labels (`aiLabel.ts`): GB 45438-2025 implicit labels and IPTC marks on exports; a visible footer on GoApply exports when `CN_AI_EXPORT_EXPLICIT_LABEL` is on; `RAAiContentLabelLog`.
- Legal documents: `content/legal/` (must be traced into the serverless bundle; `vercel.json` `includeFiles`).

### Mainland deployment

[`docs/runbooks/cn-deploy.md`](../runbooks/cn-deploy.md) and the kit in [`deploy/cn/`](../../deploy/cn/): Aliyun ACK (gateway, web, API, 16 CronJobs generated from `vercel.json` by `scripts/gen-cn-cronjobs.mjs`, worker at 0 replicas until GoApply has its own LiveKit plane), RDS PostgreSQL with `vector` ≥ 0.7.0, optional OSS. Nothing is deployed; it is blocked on filings (ICP, PIPL package, generative-AI registration), not on code. Plan of record: [`CN_TW_LAUNCH_PLAN.md`](../jobright-clone/CN_TW_LAUNCH_PLAN.md).

---

## Stale, contradictory or unverified (as of this writing)

- `AGENTS.md` says the schema is `server/prisma/schema.prisma`; it is the directory `server/prisma/schema/`.
- `AGENTS.md` still describes `feat/practice-prep` as work in progress on "this branch"; both `feat/practice-prep` and `feat/jobright-clone` are merged into `main`. `PREP_AGENTS.md` still says "Status: built on `feat/practice-prep`".
- `HANDOFF.md` §2 says "Nothing from this work is on `main`"; it is merged.
- `README.md` says `vercel.json` wires "7 cron jobs"; there are 16.
- `docs/runbooks/cn-deploy.md` §1 says five `vercel.json` crons are not mirrored on the mainland; the generated `deploy/cn/k8s/cronjobs.yaml` says none are excluded, and those five crons are no longer in `vercel.json`.
- `interview-agent/README.md` describes `openingGreeting`/`openingQuestion` and `liveLlm` metadata as what the control plane sends; on main `buildRoomMetadata` sends `openingLine` and `llm` (the worker handles both).
- `RAInterviewPromptService.ts` header says "mock is not a billed SKU"; written practice is metered by the session-service wrappers (the comment is about LLM cost, but reads as if practice were free).
- `docs/LANDING_GAP_ANALYSIS.md` (2026-07-11) describes auto-apply, a $15/$29 interview-credit catalog and an "AUTOPILOT · EARLY ACCESS" landing; auto-apply is removed (D1) and the prices are the catalog in section 2.
- `.env.example` example value `ROBOAPPLY_EMAIL_FROM=RoboApply <noreply@roboapply.io>` points at a domain not verified in Resend (per `HANDOFF.md`).
- Unverified: how external interview API keys (`X-API-Key`) are issued in RoboApply; the Vercel state of `CRON_SECRET`, `ALLOWED_BRANDS` and `RESEND_API_KEY` (taken from `HANDOFF.md` §6); whether Parley has a production host; whether any WeChat Pay or Alipay production credentials are set.
