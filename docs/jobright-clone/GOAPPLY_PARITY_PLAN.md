# GoApply parity plan (D5)

**Branch:** `feat/jobright-clone`. **Written:** 2026-10-11. **Inputs:** four read-only audits (gating, providers, job sources, UI parity; 130 gaps) and the running dev stack.
**Machine-readable bundles:** [`orch/parity-bundles.json`](orch/parity-bundles.json) (10 bundles, disjoint file ownership, same format as `orch/verify-fix-groups.json`).

**Relation to [`market/MARKET_STRATEGY.md`](market/MARKET_STRATEGY.md)** (D6, written the same day). README D6 assigns the choice of job sources, prices and payment rails per market to `docs/jobright-clone/market/`. This plan owns capability defaults and provider fallbacks (D5); that file owns sources, matching, prices and rails. Where the two touched the same point this plan follows it: JSearch is not a GoApply source, `linkedin` leaves RoboApply's provider list, GoApply student passes have catalog default prices, and no posting-age cut-off is applied to board or bank rows. §9 lists which of its requirements are folded into the bundles here and which stay in its own waves.

This plan turns owner ruling D5 into code. It supersedes TASK_PLAN R-03 (no `CN_X → X` fallback), R-13 (GoApply domestic-only LLM), R-14 (recruitment-info mode default `off`), R-15 (GoApply payments off), the invite-only GoApply sign-up, and the "ships dark" principle of `CN_TW_LAUNCH_PLAN.md`. D1 (the product never submits an application) and D3 (never fabricate data) are unchanged. D6 (per-market sources, prices, Alipay kept as is for mainland China, Stripe for the international brand) is respected where the two meet (§3.8, §3.9).

---

## 1. The ruling

> D5 (owner, 2026-10-11): "Both GoApply and RoboApply should have the same robust functionalities; the differences are the job board, job sources, job search APIs."

1. A capability that is on for RoboApply is **on for GoApply by default**. GoApply never ships a feature dark because a China-specific credential or licence is missing.
2. China-specific providers (`CN_LLM_*`, `CN_EMAIL_*`, `CN_LIVEKIT_*` / `CN_VOICE_*`, `CN_S3_*`, SMS, WeChat) are **optional overrides**. Set → used. Unset → GoApply **falls back to the shared stack** RoboApply uses (same LLM routing, email transport, voice infrastructure, storage).
3. Legitimately different: the **job board, job sources and job-search APIs** per brand, and what follows from the market (default language zh, CNY, payment rail, additional sign-in methods, legal footer).
4. Consent prompts, AI-generated labels and GoApply's extras (campus calendar, 内推码, 一键填表, AI 面试 format) stay. They add, they never remove.

### What the audits found

With only the shared credentials set (the state of the clone `.env`), GoApply today resolves: no AI, no email, no password reset, no voice practice, no web push, no coaching, no student pricing, no payments, no job feed, no free tools, no public job pages, invite-only sign-up. The dev stack hides most of this through a preview block in `scripts/dev-clone.sh`. Five root causes cover almost all 130 gaps:

| # | Root cause | Where |
|---|---|---|
| 1 | `brandEnv()` never falls back from `CN_X` to `X` | `server/src/platform/brand/brandEnv.ts` |
| 2 | Capability requirements test CN-only credentials, a licence mode and a payments switch | `server/src/platform/flags.ts` |
| 3 | Four registry booleans and the provider list for GoApply | `server/src/platform/brand/registry.ts` |
| 4 | Hard `market === 'cn'` returns in tools, SEO, visitor, web search, people, job search, push | feature modules |
| 5 | The GoApply job-source layer returns nothing (one bank adapter, disabled by a TLS rule; JSearch rows dropped) | `server/src/features/jobs/ingest/*` |

---

## 2. Principles for every bundle

- **P1. Optional override, else shared.** One rule, in one place (§3.1). No module invents its own fallback.
- **P2. Never mix credential sets.** A group of settings that belong together (LiveKit URL + key + secret; bucket + keys; VAPID pair) is read wholly from `CN_*` or wholly from the shared names.
- **P3. Identity never crosses.** Origin, cookie domain, legal entity, sender identity, support mailboxes, collecting entity and licence numbers are per brand. RoboApply's legal name or origin never appears on GoApply, and the reverse (D3).
- **P4. The strict mainland posture is an explicit operator choice**, not a default and not implied by a missing value: `CN_LLM_DOMESTIC_ONLY=true` and `CN_RESIDENCY_STRICT=true`.
- **P5. Off switches survive.** Every former prerequisite that made sense as a kill switch keeps working as one (`CN_RECRUITMENT_INFO_MODE=off`, `CN_PAYMENTS_ENABLED=false`, `CN_SIGNUP_MODE=closed|invite`, `FLAG_GOAPPLY_<KEY>=false`).
- **P6. Honesty follows the code.** The privacy notice, the processor list, the cross-border consent requirement and the AI-model footer are generated from the stack GoApply really resolves (D3). A job card names its real source; a search link is never shown as an apply link.
- **P7. RoboApply does not regress.** Its reads, its rule "no user data to a mainland endpoint", its plans and its providers are unchanged unless an item says otherwise.
- **P8. Tests state the new truth.** A test that pinned the old gated behaviour is rewritten by the bundle that owns the file: either it now sets the off switch explicitly, or it asserts the fallback.

---

## 3. Design decisions

### 3.1 Env resolution: `brandEnv` (bundle PAR-1)

`brandEnv(brand, NAME)` keeps its signature. For RoboApply nothing changes. For GoApply:

| Class | Rule | Names |
|---|---|---|
| **Brand-own** (`BRAND_OWN_ENV`) | `CN_NAME` only, never the shared value | `CANONICAL_ORIGIN`, `COOKIE_DOMAIN`, `BACKEND_URL`, `EMAIL_FROM`, `SUPPORT_EMAIL`, `COACHING_ADMIN_EMAIL`, `TAKEDOWN_CONTACT`, `LEGAL_ENTITY_NAME`, `LEGAL_POSTAL_ADDRESS`, `LEGAL_DOCS_VERSION`, `PAYMENT_COLLECTING_ENTITY`, `MIN_EXT_VERSION`, `BAIDU_PUSH_TOKEN`, `CONTACT_OPTIN_API_URL`, `CONTACT_OPTIN_API_KEY`, `CONTENT_SAFETY_PROVIDER`, `CONTENT_SAFETY_TIMEOUT_MS`, `SAFETY_KEYWORDS_URL` |
| **Grouped** (`BRAND_ENV_GROUPS`) | whole group from `CN_*` when the anchor is set, else whole group from the shared names | `voice` (anchor `LIVEKIT_URL`): `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_AGENT_NAME`, `LIVEKIT_AGENT_CALLBACK_SECRET`, `VOICE_PROVIDER`, `INTERVIEW_ENGINE_AGENT_NAME`, `INTERVIEW_ENGINE_CALLBACK_BASE_URL` · `speech` (anchors `INTERVIEW_ENGINE_STT_MODEL` and `INTERVIEW_ENGINE_TTS_MODEL`, both): those two plus `INTERVIEW_ENGINE_TTS_VOICE`, `INTERVIEW_ENGINE_TTS_VOICE_MALE`, `INTERVIEW_ENGINE_STT_FALLBACK_MODELS` · `storage` (anchor `S3_BUCKET`): `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` · `push` (anchor `VAPID_PUBLIC_KEY`): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |
| **Everything else** | `CN_NAME ?? NAME`, per key | `LLM_*`, `TOTP_ENCRYPTION_KEY`, `COPILOT_DAILY_BUDGET_USD`, `SCORE_DAILY_BUDGET`, `RA_SYSTEM_USER_ID`, `INTERVIEW_RETENTION_DAYS`, `INTERVIEW_ENGINE_RECORDING_ENABLED`, … |

New exports of `server/src/platform/brand/brandEnv.ts` (the seam every other bundle may import; nothing else is added to this file by other bundles):

```ts
brandOwnEnv(brand, name, env?)        // the old strict read: CN_NAME for GoApply, NAME for RoboApply
brandEnvSource(brand, name, env?)     // 'own' | 'shared' | 'none'  (disclosures, admin)
brandStack(brand, group, env?)        // 'own' | 'shared'; group: 'llm' | 'voice' | 'speech' | 'storage' | 'push'
                                      //   'llm' is 'own' when CN_LLM_PROVIDER or CN_LLM_MODEL is set
brandUsesSharedStack(brand, env?)     // true when any group above, or email, resolves to the shared stack
cnResidencyStrict(env?)               // CN_RESIDENCY_STRICT=true
cnLlmDomesticOnly(env?)               // CN_LLM_DOMESTIC_ONLY=true || cnResidencyStrict(env)
BRAND_OWN_ENV, BRAND_ENV_GROUPS
```

Because about 60 call sites already read through `brandEnv`, most of the fallback arrives with this one change, and `flags.ts` and `interview-engine/config.ts` stay in step without importing each other (the drift matrix in `flags.test.ts` keeps passing).

### 3.2 Capability defaults (bundle PAR-1)

`enabled(key) = requirementsMet(key) AND (userOverride ?? FLAG_<BRAND>_<KEY> ?? registryDefault)` is unchanged. What changes is the requirement and the default.

| Key | Before (GoApply) | After |
|---|---|---|
| `ai.text`, `copilot`, `agent`, `visitorAssistant`, `competitiveness` | CN model + content safety | content safety usable (default config is); never the CN model |
| `ai.vision` | CN model + `CN_LLM_VISION_MODEL` | same as `ai.text` |
| `ai.interviewVoice`, `interviewVoice` | registry false; `CN_LIVEKIT_*` only | registry **true**; LiveKit through the `voice` group |
| `notify.email`, `auth.passwordReset` | `CN_EMAIL_TRANSPORT` required | `aliyun_dm` → Aliyun keys; `none` → off; anything else → `RESEND_API_KEY` |
| `jobs.feed`, `jobs.recommendations`, `jobs.alerts` | `CN_RECRUITMENT_INFO_MODE` (default off) | on; `off` only when the variable is literally `off`; unset → `licensed` |
| `campusCalendar` / `jobs.campusCalendar` | mode ≠ off or `CN_CAMPUS_CALENDAR_ENABLED` | registry value; `CN_CAMPUS_CALENDAR_ENABLED=false` is the off switch |
| `webPush` | never | registry **true**; VAPID through the `push` group |
| `coaching`, `student` | registry false | registry **true** |
| `pay.alipay` | `CN_PAYMENTS_ENABLED=true` + `ALIPAY_API_URL` + secret | rail listed AND `ALIPAY_CALLBACK_SECRET` AND not killed (`CN_PAYMENTS_ENABLED=false`) |
| `pay.wechatpay` | `CN_PAYMENTS_ENABLED=true` + merchant set | merchant set + entity match AND not killed |
| unchanged, market-specific | | `auth.google`, `auth.line`, `pay.stripe`, `fx.reference`, `h1bHistory`, `eeoAnswers` (RoboApply); `auth.phoneOtp`, `auth.wechat*`, `notify.wechat`, `cn.referralCodes`, `legal.footer.*` (GoApply, each only when its own value is set) |

Registry (`registry.ts`, then `npm run gen:brand`): `goapply.flags.coaching`, `interviewVoice`, `webPush`, `student` → `true`; `goapply.authMethods` → `['email_password', 'phone_otp', 'wechat']` (email first); `goapply.jobProviders` stays `['bank_gohire', 'user_import']` (public employer boards join through the market-registered `ats_public` adapter; JSearch is not a GoApply source, MARKET_STRATEGY M-6); `roboapply.jobProviders` drops `linkedin` (M-4: not subscribed, not to be); `email.transport` documented as the preferred transport. `allowedBrands()` defaults to both brands in every environment; `ALLOWED_BRANDS` / `BRAND_LOCK` narrow a deployment (the mainland kit keeps `ALLOWED_BRANDS=goapply`).

**Acceptance for the whole plan:** with `GOAPPLY_PREVIEW=0` and only shared credentials, `GET /api/v1/public/brand` for `goapply.localhost:3621` shows `true` for every flag that is `true` for `localhost:3621`, except `h1bHistory`, `eeoAnswers`, `fx.reference`, `pay.stripe`, `auth.google`, `auth.line`.

### 3.3 LLM (bundle PAR-2)

- **Per key, not per stack.** Each model setting resolves `llm_stack.goapply` blob → `CN_<NAME>` → `llm_stack.roboapply` blob → `<NAME>`. The provider mode resolves the same way.
- **Effective profile.** `effectiveLlmProfile(brand, env)` (in `server/src/lib/llm/llmBrand.ts`) is `'domestic_cn'` only when GoApply has its own provider (`brandStack(brand, 'llm') === 'own'` or a provider in the GoApply blob). Otherwise `'global'`: the same default provider, models and fallback chain as RoboApply. `LLMService.callBrand` returns the brand with the effective profile and prefix, so the existing profile checks need no edits.
- **Mixed case.** When GoApply has its own provider and one setting comes from the shared stack (CN text model, shared vision model), the shared selector is qualified to a full route so it goes where it goes for RoboApply, never to the CN provider.
- **The domestic-only wall is opt-in** (`cnLlmDomesticOnly`). It covers primary and fallback routes, BYOK, and the enrich / campus / fraud model prefix check. Default: GoApply may use every route RoboApply may use, plus its domestic vendors. RoboApply's rule (never a mainland endpoint) is untouched.
- **Task resolvers** (enrichment, fit scorer, campus extraction, fraud second opinion, interview blueprint) go through the shared resolver; no private `CN_` reads.
- **BYOK** follows RoboApply unless the wall is on. (No web UI uses it; this is a server seam.)
- **Content safety stays** on GoApply calls, on the shared route too. An invalid `CN_CONTENT_SAFETY_*` value degrades to the built-in keyword list with a warning instead of turning AI off; it fails closed only under `CN_RESIDENCY_STRICT`.

### 3.4 Email, push, notices (bundle PAR-3)

- **Transport:** `CN_EMAIL_TRANSPORT` ∈ `aliyun_dm | resend | none`; unset → `resend` (shared `RESEND_API_KEY`).
- **From:** display name always `GoApply`. Address: `CN_EMAIL_FROM`, else (Resend only) `ROBOAPPLY_EMAIL_FROM`, then `EMAIL_FROM`, last the registry address. The shared verified sender is used because `noreply@goapply.top` is not a verified domain on the shared Resend account; `CN_EMAIL_FROM` takes over once it is. Reply-To and legal lines stay brand-own.
- **Web push:** both brands, shared VAPID pair unless `CN_VAPID_PUBLIC_KEY` starts an own group. WeChat notices remain an additional GoApply channel.

### 3.5 Voice and video practice (bundle PAR-4)

- **Media plane:** no `CN_LIVEKIT_URL` → the shared LiveKit project, the shared worker and its agent name (`INTERVIEW_ENGINE_AGENT_NAME`, else RoboApply's registry name). `GoApply-Interview` is dispatched only on GoApply's own plane. A session stores `stack: 'own' | 'shared'` and keeps its plane for its lifetime.
- **Webhooks and callbacks:** a webhook is accepted for a session when the signing API key is the key of the plane that session runs on (several brands may share it); the callback secret and base URL come from the same group.
- **Speech and models:** no CN speech pair → the shared voice catalog (zh voices) and STT; no `CN_LLM_INTERVIEW_*` → RoboApply's interview routing (same `ALIGNED_INTERVIEW_MODELS` allowlist).
- **Artifacts:** recordings and transcripts use the `storage` group; sharing the shared bucket is the fallback, not an error.
- **Camera and video recording:** same policy on both brands, behind the existing per-session `interview_recording` + `interview_video` consents. `CN_INTERVIEW_CAMERA_PUBLISH=false` restores the audio-only rule (CN L-11) for an operator who wants it.
- **Parley transport, web research, requirements preview:** same as RoboApply; queries carry no personal information on either brand.
- **First free practice:** a verified email or a verified phone earns it on GoApply.

### 3.6 Storage, residency, boot, disclosures (bundle PAR-5)

- **Resume originals and photos:** stored as on RoboApply. No CN bucket → the shared store, under a `goapply/` key prefix. `CN_STORAGE_MODE=redact|discard` (opt-in) restores pre-storage redaction or no-original. Uploads are never refused for a missing CN bucket unless `CN_RESIDENCY_STRICT=true`.
- **PI egress allowlist** applies only under `CN_RESIDENCY_STRICT`; otherwise GoApply may send where RoboApply may (no-PI vendor rules stay).
- **Boot:** on `DEPLOY_REGION=cn-mainland`, `icp_missing`, `cn_llm_off_allowlist`, `cn_storage_missing|offshore`, `content_safety_*` and `cn_email_offshore` become warnings; they fail the boot only under `CN_RESIDENCY_STRICT`. Topology checks (`deploy_region_unknown`, `db_*`, `intl_brand_on_mainland`) still fail.
- **Disclosures:** the model list, processor list and endpoint rule (`open` | `mainland_only`) are generated from the effective stack. The cross-border consent (`pipl_cross_border`) is required whenever the deployment is offshore **or** `brandUsesSharedStack(goapply)` is true.
- **Legal documents:** served on GoApply by the same rule as RoboApply (drafts carry the DRAFT banner). Sign-up no longer depends on a document version.

### 3.7 Accounts (bundle PAR-3)

- **Sign-up is open** on GoApply with email + password. `CN_SIGNUP_MODE` ∈ `open` (default) | `invite` | `closed`. Required consents (agreement, age, cross-border where it applies) stay and keep a version (`CN_LEGAL_DOCS_VERSION`, else the built-in prose version).
- **Sign-in methods are a market difference** (D5). Email + password is primary on both. Phone OTP and WeChat appear beside it on GoApply when their credentials exist; Google and LINE stay RoboApply's additional methods (Google sign-in is not reachable from mainland networks, so it is not added to GoApply).
- **Phone binding** is required only when a phone can be bound (`auth.phoneOtp` requirement met).
- **Two-factor:** `CN_TOTP_ENCRYPTION_KEY ?? TOTP_ENCRYPTION_KEY`; unsealing tries both so a later CN key locks nobody out.
- **Student verification** runs on GoApply (`*.edu.cn` already matches).

### 3.8 Payments (bundle PAR-6; D6)

- **Rail:** mainland China pays with **Alipay, the existing implementation** (`rails/alipayWorker.ts` → the Alipay worker). Its request, callback and verification path is not rewritten. WeChat Pay remains GoApply's second, optional rail with its own merchant checks. **Stripe is not added to GoApply.**
- **The Alipay contract is frozen first.** Before any gate changes, PAR-6 writes characterisation tests for the twelve "do not break" rules of MARKET_STRATEGY §5.2 (its requirement AL-1); they pass before and after.
- **Purchasable by default:** the catalog carries default CNY amounts (MARKET_STRATEGY §4.2: 周卡 ¥12, 月卡 ¥39, 季卡 ¥99, packs ¥29 / ¥79, 学生月卡 ¥29, 学生季卡 ¥69) overridable by `CN_PRICE_<KEY>_FEN` (an override that is not whole yuan is ignored and logged). No GoApply plan is ever `price_unset`. `CN_PAYMENTS_ENABLED=false` is the kill switch; unset means on.
- **Gates removed:** the collecting-entity requirement on the Alipay rail (the entity is printed when `CN_PAYMENT_COLLECTING_ENTITY` is set, a startup warning when it is not; `CN_PAYMENT_REQUIRE_ENTITY=true` restores the hard gate) and the `ALIPAY_API_URL` requirement (the rail already defaults the worker URL). `ALIPAY_CALLBACK_SECRET` remains required: it is the rail's own credential, the equal of `STRIPE_SECRET_KEY`, and it closes a forgery hole.
- **Student passes** join the GoApply catalog (30 / 90 days, flag `student`).
- **Left to the market waves** (same files, after PAR-6): RoboApply USD defaults and the Stripe catalog sync, Alipay wire parity and callback tolerance (AL-3, AL-4), the link for mainland visitors on roboapply.io (AL-6), the refund record (AL-7), the supervised cut-over order (AL-8).
- Stays different (follows from the rail): non-renewing passes, no promotion codes, no failed-renewal banner, no TWD line.

### 3.9 Per-brand job source registry (bundle PAR-7; sources per MARKET_STRATEGY §1)

One registry answers "which sources feed this brand, how, and are they healthy". The capability (feed, search, alerts, similar jobs, market stats) is identical; only the rows differ. No mainland source offers lawful keyword search over the market, so GoApply **ingests into its own index and searches that**.

| Brand | Source | Kind | Transport | State after this plan |
|---|---|---|---|---|
| RoboApply | `activejobs`, `jsearch` | search API | RapidAPI | unchanged here (their roles change in the market waves: JI-1…JI-7); `linkedin` removed |
| RoboApply | `bank_robohire` | recruiter bank | Postgres | unchanged |
| RoboApply | `ats_public` | public ATS boards | documented job-board APIs | keeps every posting not located in mainland China |
| GoApply | `bank_gohire` | recruiter bank | Postgres when its URL satisfies the TLS rule; otherwise HTTPS (`api.gohire.top` list endpoint, strict field whitelist; the syndication endpoint when `GOHIRE_SYNDICATION_URL` is set) | **on** over HTTPS; published + named-employer rows only; a row opens the GoHire page |
| GoApply | `ats_public` | public ATS boards | the same connectors; a posting located in mainland China enters `market = 'cn'` | **on**; a seed of China-hiring boards, each verified against its live board |
| both | `user_import` | user import | — | unchanged |
| GoApply | deep links | search links built from the user's own query | — | unchanged (three boards today); shown when results are thin |
| GoApply | campus calendar | curated events | admin flow | on; empty until staff publish events (never invented) |
| not a GoApply source | `jsearch` with `country=cn` | | | off (MARKET_STRATEGY M-6: rows carry no apply link and are third-hand copies of a mainland board's postings) |

Rules of the layer:

- **Provider list** = `brand.jobProviders` plus adapters registered for the market, optionally narrowed by `JOB_PROVIDERS_<BRAND>` (subset only). `CN_EXTERNAL_PROVIDERS` is removed.
- **A posting with no usable apply URL is never listed** (both markets, as today). Nothing is submitted for the user (D1).
- **Every card names its source (D3).** GoHire bank rows carry the licence line only when `CN_HR_LICENCE_*` is set. Every other mainland posting shows `来源：{original publisher}`, the original link and `最后核验 {date}`. The feed header says where postings come from ("来自 GoHire 与 N 家企业招聘官网", N computed) and never implies full-market coverage.
- **Market by location for employer boards.** One board can feed both brands: its mainland postings go to GoApply, the rest to RoboApply, each row in exactly one market.
- **GoHire bank quality gates stay.** Unpublished, unattributed or test requisitions are skipped and counted (`bank_unpublished`, `bank_no_company`, `bank_test_posting`), never inferred. Only this source may carry 企业直招, and only when the bank says the employer is verified.
- **No posting-age cut-off for board or bank rows.** They close by listing diff, tombstone or stated deadline (MARKET_STRATEGY §1.5).
- **No scraping.** No adapter fetches HTML or private JSON from BOSS直聘, 智联, 猎聘, 前程无忧 or 拉勾, and no Chinese ATS vendor's internal endpoint is called.

### 3.10 Natural-language job search on both brands (bundles PAR-7, PAR-8)

- **In-app:** `POST /feed/nl-query` (sentence → filters over our own index) already exists on both brands and works as soon as `jobs.feed` is on and the index has rows (§3.9). GoApply keeps the AI consent prompt. Retrieval quality work (hybrid retrieval, embeddings, the natural-language rewrite) is MARKET_STRATEGY §2 (SM-6…SM-9) and applies to both brands.
- **Job-search API, planner agent and developer keys:** opened on both brands. `providersForBrand(brand)`: RoboApply keeps today's list; GoApply gets `index` (our `market = 'cn'` index: GoHire bank and employer-board rows). The planner calls `aiAllowed(userId)` first on GoApply. A key is valid only on its owner's brand host.

### 3.11 Public surfaces and the signed-in workspace (bundles PAR-9, PAR-8)

- Public job pages, browse pages, ticker and sitemaps: the same gates as RoboApply (`seo.browse`, `PUBLIC_DISPLAY_PROVIDERS`, `isPubliclyListable`); the `intlOnly` guard is deleted.
- Free tools: open on GoApply behind the existing consent tick and the "processed outside the mainland" notice.
- Visitor assistant: when its flag is on it works on both brands; GoApply shows a consent line first.
- GoApply home and feature pages: the same visitor functions over GoApply data (counters, quick search, pricing summary, feature cards, ticker; pages for job matches, resume tailoring, cover letters, ready to apply, 内推).
- Navigation: 职位 no longer depends on a flag; 求职辅导 and the extension entry exist on GoApply under the same gates as RoboApply.
- Job detail: People tab shows hiring contacts and people-you-know on GoApply plus 内推码; company news follows its flag only; the company-size filter is kept beside employer tags; Assistant dictation is enabled.

### 3.12 What stays market-specific

Job sources and job-search providers; default language and locale set; currency and price ladder; payment rail and plan shape (passes vs subscriptions); sign-in methods beyond email + password; legal footer lines (each only when set); visa / H-1B / EEO / Taiwan fields (RoboApply); campus calendar, 内推码, deadline sort, AI 面试 format, campus filters, WeChat notices and share card, Consents settings section, AI-generated labels, content-safety filter, AI consent gate and cross-border consent (GoApply); GoHire-first resume parsing; LinkedIn resume import (RoboApply); the autofill portal list (GoApply's becomes a superset).

---

## 4. Environment variables introduced or redefined

| Variable | Meaning | Default |
|---|---|---|
| `CN_<NAME>` (infrastructure) | optional override of `<NAME>` for GoApply (§3.1) | unset → shared value |
| `CN_LLM_DOMESTIC_ONLY` | GoApply may use only mainland model endpoints | off |
| `CN_RESIDENCY_STRICT` | PI egress allowlist, mainland storage required, boot assertions fail; implies the LLM wall | off |
| `CN_STORAGE_MODE` | `store` \| `redact` \| `discard` for GoApply resume originals | `store` |
| `CN_INTERVIEW_CAMERA_PUBLISH` | `false` = GoApply audio-only practice | on |
| `CN_RECRUITMENT_INFO_MODE` | `off` \| `partner_deeplink` \| `licensed` | `licensed` |
| `CN_CAMPUS_CALENDAR_ENABLED` | `false` hides the campus calendar | on |
| `CN_SIGNUP_MODE` | `open` \| `invite` \| `closed` | `open` |
| `CN_PAYMENTS_ENABLED` | `false` stops GoApply charging | on |
| `CN_PRICE_<KEY>_FEN` | overrides a catalog amount (whole yuan only) | catalog default |
| `CN_PAYMENT_REQUIRE_ENTITY` | `true` = Alipay refuses to charge without `CN_PAYMENT_COLLECTING_ENTITY` | off |
| `CN_EMAIL_TRANSPORT` | `aliyun_dm` \| `resend` \| `none` | `resend` |
| `GOHIRE_BANK_TRANSPORT` | `db` \| `api` \| `off` | `db` when the URL satisfies TLS, else `api` when `GOHIRE_API_KEY` is set |
| `GOHIRE_SYNDICATION_URL` | the GoHire syndication endpoint (cursor, tombstones) once it exists | list endpoint |
| `JOB_PROVIDERS_ROBOAPPLY`, `JOB_PROVIDERS_GOAPPLY` | narrow a brand's provider list (subset) | registry list |
| `ALLOWED_BRANDS` | brands a deployment serves | both |
| removed | `CN_EXTERNAL_PROVIDERS`; `RA_V2_DISCOVER_DISABLED=true` and the "Stage switches" block of the CN kit; the `GOAPPLY_PREVIEW` LLM / mode / campus / sign-up exports of `scripts/dev-clone.sh` | |

---

## 5. Implementation bundles

Ten bundles, each in its own git worktree (`orch/wave-setup.sh`), committed and merged with `orch/wave_commit.py --items docs/jobright-clone/orch/parity-bundles.json`. No path appears in two bundles and no owned directory contains another bundle's path. Assumes the nine verification fix groups (`orch/verify-fix-groups.json`) are merged first.

| ID | Bundle | Phase | i18n namespaces |
|---|---|---|---|
| PAR-1 | Foundation: `brandEnv` fallback, capability requirements, registry defaults, deployment scope | 0 (merge first) | — |
| PAR-2 | LLM on the shared stack: resolution, policy, task models, BYOK, content safety | 1 | — |
| PAR-3 | Accounts and messaging: open sign-up, email fallback, web push, phone binding, 2FA key | 1 | auth, authCn, accountV2, pwa |
| PAR-4 | Voice and video practice on the shared media plane | 1 | practice, practiceCn |
| PAR-5 | Storage, residency, boot checks, disclosures, consents, legal pages | 1 | legal |
| PAR-6 | Payments: Alipay contract frozen by tests, GoApply plans purchasable through Alipay, student passes | 1 | credits, billingCn |
| PAR-7 | GoApply job-source layer: registry, GoHire bank over HTTPS, employer boards for mainland roles, source line and apply target, normalisation, admin sources | 1 | admin |
| PAR-8 | Job search on both brands and signed-in workspace parity (nav, job detail, filters, extension, coaching, dictation) | 1 | jobs, jobsCn, jobDetail, people, filters, nav, assistant, extensionWeb, coaching |
| PAR-9 | Public surfaces: job pages, browse, free tools, visitor assistant, landing, feature pages, pricing, campus | 1 | landing, tools, visitor, seo, campus |
| PAR-10 | Docs, env examples, CN deploy kit, dev script; post-merge verification list | 1 (verification last) | — |

**Order.** PAR-1 merges first: it changes `brandEnv`, `flags.ts` and the registry and adds the seam exports of §3.1. PAR-2…PAR-9 branch from that merge and run in parallel; PAR-10 can start at once. If every bundle is launched together, bundles 2–9 rebase on `wp/PAR-1` before running their acceptance tests.

**Hot files (one owner each).** `server/src/platform/flags.ts`, `server/src/platform/brand/*` (registry, `brandEnv`, runtime), `lib/brand/registry.generated.ts`, `server/src/features/index.ts` → PAR-1. `server/src/app.ts`, `components/v3/shell/destinations.ts` → PAR-8. `server/src/cron/*`, `vercel.json` → PAR-7. `.env.example`, `scripts/dev-clone.sh`, `deploy/cn/cn.env.example` → PAR-10 (other bundles list the variables they add in their handoff; §4 is the contract). `server/prisma/schema/*` → nobody (no schema change in this plan; the market waves carry theirs).

**Rules.**
1. Edit only owned paths. A needed change elsewhere goes in the handoff as a request to the owning bundle.
2. Never commit or push; the orchestrator commits after checking ownership.
3. New English strings go to `i18n/staging/<namespace>.en.json`, GoApply Chinese to `i18n/staging/<namespace>.zh.json`, only in the bundle's namespaces. The orchestrator runs the locale sync after the merge.
4. Each bundle fixes the header comments of the files it owns that still describe R-03 / R-13 / R-14 / R-15.
5. Verification per bundle: smallest relevant test, then the affected suite, `npm run typecheck:server` for server changes, `npm run check` for copy. No `db:push`, no production build against the running dev stack.
6. Tests that relied on "unset means off" set the off switch explicitly; tests that asserted a refusal now run under the strict switch or assert the fallback (P8). PAR-1 lists in its handoff every test outside its ownership that turns red, with the owning bundle.

**Cross-bundle contracts.**

| Contract | Provider | Consumers |
|---|---|---|
| `brandEnv` semantics and exports (§3.1) | PAR-1 | all |
| `getModelSetting` / `getProviderSetting` / `getTaskModelOrDefault` fall back to the shared stack; `effectiveLlmProfile` | PAR-2 | PAR-4 (interview models), PAR-5 (disclosures), PAR-7 (fraud model) |
| Feed item and job detail expose `apply: { url, target: 'gohire' \| 'employer' }`, `source: { name, original, url, lastVerifiedAt, via: 'bank' \| 'ats' \| 'import' }`, `salary: null` when undisclosed; the feed response carries `sources: { gohire: boolean, employerBoards: number }` for the header | PAR-7 | PAR-8 (cards, detail, header) |
| `interview_video` consent offered on GoApply | PAR-5 | PAR-4 (records video only with the grant; audio-only until then) |
| `GET /billing/plans` → `paymentsOpen`, `checkout.rails` | PAR-6 | PAR-9 (pricing page) |
| `transportNameFor(brand, env)` (effective email transport) | PAR-3 | PAR-5 (processor list) |

---

## 6. Every audit gap and its decision

Numbering follows the audit order: G1–G37 gating, G38–G80 providers, G81–G98 job sources, G99–G130 UI parity. "Keep" means the difference is legitimate under D5.

| G | Gap | Decision | Bundle |
|---|---|---|---|
| 1 | No GoApply AI without `CN_LLM_*` | Shared LLM stack when unset; effective profile | PAR-1, PAR-2 |
| 2 | `ai.vision` needs `CN_LLM_VISION_MODEL` | Same as `ai.text`; vision model falls back | PAR-1, PAR-2 |
| 3 | Task resolvers require a domestic prefix | Shared resolver; refusal only under the LLM wall | PAR-2, PAR-4, PAR-7 |
| 4 | BYOK refused | Allowed unless the LLM wall is on | PAR-2 |
| 5 | Content safety GoApply-only; misconfig hides AI | Keep the filter; misconfig degrades to keyword list | PAR-2 |
| 6 | No email without `CN_EMAIL_TRANSPORT` | Resend fallback; shared verified sender | PAR-1, PAR-3 |
| 7 | Voice practice off | Registry on; shared LiveKit, worker, speech | PAR-1, PAR-4 |
| 8 | No camera publish / video recording | Same policy on both; consent stays; `CN_INTERVIEW_CAMERA_PUBLISH=false` opts out | PAR-4, PAR-5 |
| 9 | Requirements preview and web search off | Enabled; no-PI check stays | PAR-4 |
| 10 | WeChat-only accounts locked out of AI | Binding required only when SMS is live | PAR-3 |
| 11 | Originals discarded / uploads refused | Stored on the shared store under `goapply/` | PAR-5 |
| 12 | Mainland boot refuses | Warnings; failures only under `CN_RESIDENCY_STRICT` | PAR-5 |
| 13 | PI egress allowlist excludes the shared stack | Allowlist only under strict mode | PAR-5, PAR-2 |
| 14 | Sign-up invite-only | `open` by default; `invite` opt-in | PAR-3 |
| 15 | Production sign-up closed without legal version / SMS | Always open with email + password; legal drafts served | PAR-3, PAR-5 |
| 16 | Different sign-in method sets | Keep; email + password primary on both | PAR-3 |
| 17 | AI consent gate | Keep; reachable from every surface | — (PAR-9 for visitor and tools) |
| 18 | Visitor assistant blocked | Body-level consent on GoApply; guards removed | PAR-9 |
| 19 | Free tools closed | Open; anonymous AI with the tools consent | PAR-9 |
| 20 | Feed, recommendations, alerts, campus off | On by default; `off` explicit | PAR-1, PAR-7 |
| 21 | Job search, planner, keys RoboApply-only | Both brands; per-brand providers | PAR-8 |
| 22 | Ingest providers differ | Keep per brand; GoApply = GoHire bank + employer boards (MARKET_STRATEGY M-6) | PAR-7 |
| 23 | Public job pages, browse, ticker, sitemaps blocked | Same gates as RoboApply | PAR-9 |
| 24 | Job-alerts page noindex / not in sitemap | Indexed when `jobs.alerts` is on | PAR-9 |
| 25 | Company news refused | Flag only | PAR-7 (server), PAR-8 (web) |
| 26 | Hiring contacts / people hidden | Shown under the same mode, plus 内推码 | PAR-8 |
| 27 | No extension nav entry / install link | Entry added; store-listing fallback | PAR-8 |
| 28 | Autofill portal lists separate | GoApply list becomes a superset | PAR-8 |
| 29 | Coaching off | Registry on; nav entry; brand-own mailbox | PAR-1, PAR-8 |
| 30 | Student verification and plans off | Registry on; student passes at ¥29 / ¥69 | PAR-1, PAR-3, PAR-6 |
| 31 | Web push never | Both brands; shared VAPID | PAR-1, PAR-3 |
| 32 | Assistant voice input off | Enabled; hides after a failed start | PAR-8 |
| 33 | Cannot sell plans | Purchasable by default through Alipay; kill switch | PAR-1, PAR-6 |
| 34 | Auto-renew, promo codes, TWD | Keep (follows the rail) | — |
| 35 | `brandEnv` no fallback | Optional override, else shared (§3.1) | PAR-1 |
| 36 | US / Taiwan / CN-only data features | Keep | — |
| 37 | Deploy kit and dev preview encode "ships dark" | Rewritten; preview block reduced to SMS console | PAR-10 |
| 38 | `brandEnv()` root cause | Same as G35; own list, groups, source | PAR-1 |
| 39 | Model settings read CN only | Per-key fallback; qualified mixed case | PAR-2 |
| 40 | LLMService domestic-only | Effective profile in `callBrand` | PAR-2 |
| 41 | Egress guard refuses non-mainland routes | Opt-in wall | PAR-2 |
| 42 | `ai.text` / `ai.vision` / AI flags need a CN model | Content safety only | PAR-1 |
| 43 | BYOK disabled | Same as G4 | PAR-2 |
| 44 | Enrich / campus / fraud models must be domestic | Shared default; check only under the wall | PAR-2, PAR-7 |
| 45 | Scorer default provider CN only | `getProviderSetting` for both brands | PAR-2 |
| 46 | Content safety GoApply-only | Keep; verified on the shared route | PAR-2 |
| 47 | Disclosures describe a domestic-only stack | Generated from the effective stack | PAR-5 |
| 48 | No email (providers view) | Same as G6 | PAR-1, PAR-3 |
| 49 | From address has no shared fallback | Shared verified sender, GoApply display name | PAR-3 |
| 50 | Voice off in registry, CN LiveKit only | Same as G7 | PAR-1, PAR-4 |
| 51 | Dispatch to unregistered `GoApply-Interview` | Shared agent name on the shared plane; plane pinned per session | PAR-4 |
| 52 | Shared-project webhooks ignored | Accept by signing key of the session's plane | PAR-4 |
| 53 | Speech must be DashScope | Shared catalog when the CN pair is unset | PAR-4 |
| 54 | Interview models must be domestic | RoboApply routing when unset | PAR-4 |
| 55 | Artifact storage off without a separate bucket | Shared bucket fallback | PAR-4 |
| 56 | No camera video (unsure) | Same as G8; owner legal note | PAR-4, PAR-5 |
| 57 | Parley and web research skipped | Same as RoboApply | PAR-4 |
| 58 | Callback URL and secret CN-only | From the `voice` group | PAR-4 |
| 59 | Offshore discard / mainland refuse | Same as G11 | PAR-5 |
| 60 | Pre-storage redaction (unsure) | Verbatim by default; `CN_STORAGE_MODE=redact` | PAR-5 |
| 61 | PI egress allowlist | Same as G13 | PAR-5 |
| 62 | Free tools closed; photo unavailable | Tools open; photo wherever storage works | PAR-9, PAR-5 |
| 63 | Mainland startup assertions (unsure) | Same as G12 | PAR-5 |
| 64 | Resume parse routing | Keep; test local parse on the shared vision model | PAR-5 |
| 65 | Google sign-in not on GoApply | Keep (market sign-in method; not reachable from the mainland) | — |
| 66 | Sign-up invite-only / closed | Same as G14, G15 | PAR-3 |
| 67 | Email + password behind 其他方式 | Primary | PAR-1 (order), PAR-3 |
| 68 | WeChat-only binding | Same as G10 | PAR-3 |
| 69 | First free practice needs a phone | Verified email or phone | PAR-4 |
| 70 | 2FA needs `CN_TOTP_ENCRYPTION_KEY` | Fallback; unseal tries both keys | PAR-3 |
| 71 | `CN_PAYMENTS_ENABLED` master switch | Kill switch only | PAR-1, PAR-6 |
| 72 | Alipay needs `ALIPAY_API_URL` and an entity | Secret only; entity printed when set | PAR-1, PAR-6 |
| 73 | WeChat Pay readiness | Keep its merchant checks | PAR-6 |
| 74 | Plan catalog differs (unsure) | Keep passes; add student passes with catalog defaults | PAR-6 |
| 75 | Web push blocked in four places | Same as G31 | PAR-1, PAR-3 |
| 76 | WeChat notices | Keep; other channels verified | PAR-3 |
| 77 | Assistant voice input | Same as G32 | PAR-8 |
| 78 | R-14 default | Same as G20 | PAR-1 |
| 79 | External job-search API RoboApply-only | Same as G21 | PAR-8 |
| 80 | Production serves RoboApply only (unsure) | Both brands by default; `ALLOWED_BRANDS` narrows; owner note | PAR-1 |
| 81 | Plan / ingest / feed gated on R-14 | Same as G20; tests set `off` explicitly | PAR-1, PAR-7 |
| 82 | GoApply registry holds one disabled provider | `bank_gohire` over HTTPS, `ats_public` by posting location, `user_import`; no JSearch | PAR-1, PAR-7 |
| 83 | GoHire DB endpoint has no TLS | Keep the TLS rule; HTTPS transport; ops TLS is an owner item | PAR-7 |
| 84 | No partner feed endpoint | Interim reader over the list endpoint with a whitelist; `GOHIRE_SYNDICATION_URL` when the endpoint exists (owner, second repo) | PAR-7 |
| 85 | Most GoHire rows are internal requisitions | Keep the gates; count skip reasons; agency label | PAR-7 |
| 86 | Bank sync drops 学历 and headcount | Selected and mapped | PAR-7 |
| 87 | JSearch cn rows have no apply link | Not a GoApply source (M-6); a row without an apply URL is never listed | PAR-1, PAR-7 |
| 88 | Liepin-origin text via aggregator (unsure) | Not ingested (M-6) | PAR-7 |
| 89 | Planner has no cn seeds, English queries | No search adapter on GoApply: the planner plans bank and board syncs only; Chinese query text returns with Active Jobs DB for cn (market wave JC-6) | PAR-7 |
| 90 | Budgets per provider only | No provider is shared across markets after this plan; quota metering is market wave JI-1 / JC-6 | — |
| 91 | Stale mainland rows | The stale rows were JSearch's (not ingested). Board and bank rows close by listing diff or tombstone, never by age (JI-10) | — |
| 92 | No education / zh employment parse | Deterministic parsers; mainland pay as posted; "薪资未披露" | PAR-7, PAR-8 |
| 93 | `ats_public` intl only | Serves both markets; a mainland posting enters `market = 'cn'`; seeded China-hiring boards | PAR-7 |
| 94 | Job-search API and pages closed on GoApply | Both brands | PAR-8 |
| 95 | Two RoboApply providers do not answer (unsure) | `linkedin` removed (M-4); provider health and quota metering are market wave JI-1 / JI-2; Active Jobs DB plan is an owner item | PAR-1 |
| 96 | Bank rows in the wrong market (unsure) | Materialiser sets the market; data fix and RoboHire-CN routing are owner items | PAR-7 |
| 97 | User import and campus calendar | Keep; honest empty state | PAR-9 |
| 98 | No-scraping rule, deep links, fraud checks, AI labels | Keep | — |
| 99 | Feed off by default (UI) | Same as G20; nav entry unflagged | PAR-1, PAR-8 |
| 100 | Campus calendar ships dark | Default on | PAR-1 |
| 101 | AI hidden without a domestic model | Same as G1 | PAR-1, PAR-2, PAR-9 |
| 102 | `ai.vision` false | Same as G2 | PAR-1 |
| 103 | Voice interview off | Same as G7 | PAR-1, PAR-4, PAR-9 |
| 104 | Video practice never publishes | Same as G8 | PAR-4, PAR-5 |
| 105 | Web-search panels RoboApply-only | Same as G9, G25 | PAR-4, PAR-7, PAR-8 |
| 106 | No email (UI) | Same as G6 | PAR-1, PAR-3 |
| 107 | Web push (UI) | Same as G31 | PAR-1, PAR-3 |
| 108 | Plans cannot be bought | Same as G33; UI reads the plans API | PAR-6, PAR-9 |
| 109 | Student plans RoboApply-only | Same as G30 | PAR-1, PAR-6 |
| 110 | Sign-up invite-only (UI) | Same as G14 | PAR-3 |
| 111 | WeChat-only lockout | Same as G10 | PAR-3 |
| 112 | Legal pages 404 while draft (unsure) | Served with the draft banner; owner legal note | PAR-5 |
| 113 | Free tools closed (UI) | Same as G19 | PAR-9 |
| 114 | Signed-out job alerts unusable | Works through feed and email defaults; cn special cases removed | PAR-9 |
| 115 | No public job / browse pages | Same as G23 | PAR-9, PAR-7 |
| 116 | Visitor assistant | Same as G18 | PAR-9 |
| 117 | GoApply home lacks search, counters, ticker, pricing, cards | Added over GoApply data | PAR-9 |
| 118 | Four feature pages missing | Added, plus 内推 | PAR-9 |
| 119 | Coaching nav | Same as G29 | PAR-8 |
| 120 | Extension nav | Same as G27 | PAR-8 |
| 121 | People tab | Same as G26 | PAR-8 |
| 122 | Company-size filter hidden | Shown beside employer tags | PAR-8 |
| 123 | Assistant dictation (unsure) | Same as G32 | PAR-8 |
| 124 | Resume upload / storage | Same as G11 | PAR-5 |
| 125 | Per-brand job providers | Keep; verified to yield rows (GoHire bank, employer boards) | PAR-7 |
| 126 | Developer job-search API RoboApply-only | Opened on both (G94) | PAR-8 |
| 127 | Link import paste-only on the mainland stack | Plain server fetch under the URL policy first | PAR-7 |
| 128 | No LinkedIn door on GoApply | Keep | — |
| 129 | Market-specific fields and rules | Keep | — |
| 130 | GoApply-only extras | Keep | — |

---

## 7. Verification after all bundles merge

Run by the orchestrator; PAR-10 writes the commands into `orch/parity-verify.md`.

1. `npm run gen:brand` leaves no diff; `npm run typecheck:server`, `npm test`, `npm run check` pass.
2. Start the dev stack with `GOAPPLY_PREVIEW=0`. `GET /api/v1/public/brand` for both hosts meets the acceptance of §3.2. With `SMS_DEV_CONSOLE` unset, GoApply `authMethods` still lists `email_password`.
3. GoApply, signed out: `/`, `/pricing`, `/tools/resume-check`, `/features/job-matches`, `/features/resume-tailoring`, `/features/cover-letters`, `/features/ready-to-apply`, `/developers/job-search`, `/campus`, `/legal/privacy` answer 200.
4. GoApply, new account by email + password (no invite): verification email arrives; password reset works; upload a PDF resume and download the original; open the Assistant; start a written practice and a voice practice; open `/coaching` and `/extension`.
5. Job sources: trigger `jobs-plan` and `jobs-ingest` for GoApply (no RapidAPI call is made for GoApply). `RAJob` rows with `market = 'cn'` and `visibility = 'public'` exist from the GoHire bank and from seeded employer boards; every row has a provider id, a source, an apply URL and a posted or last-verified date; the feed and `POST /feed/nl-query` return them; no row has `sourceBoard = 'jsearch'`.
6. GoApply `GET /billing/plans`: five paid plans and, for a verified student, two student passes, all with CNY amounts; `checkout.rails` contains `alipay` once `ALIPAY_CALLBACK_SECRET` is in the environment.
7. RoboApply regression: the same page list and flows on `localhost:3621`; its flags are unchanged from before the wave.

---

## 8. What needs the owner

Nothing here blocks GoApply from functioning; each line is a credential that improves a provider, or a legal note. The D6 owner list (purchases, Stripe, tax, partnerships) is MARKET_STRATEGY §7.

1. **Alipay credential in the GoApply environment:** `ALIPAY_CALLBACK_SECRET` (and `ALIPAY_API_URL` if it is not the default worker) — the values production uses. Until set, GoApply lists its plans and prices but cannot open a payment, exactly as RoboApply without `STRIPE_SECRET_KEY`.
2. **Optional mainland providers** for latency and deliverability inside China: a domestic model (`CN_LLM_PROVIDER`, `CN_LLM_MODEL`, vendor key), Aliyun DirectMail or a verified `goapply.top` sender (`CN_EMAIL_FROM`), `CN_LIVEKIT_*` with DashScope speech, `CN_S3_*`, an SMS provider, WeChat login / notices / Pay credentials.
3. **Legal note, cross-border processing:** on the shared stack GoApply resumes, prompts and interview media are processed by the same offshore processors as RoboApply. The sign-up consent and the generated processor list say so. Counsel should review that wording and decide whether `CN_RESIDENCY_STRICT`, `CN_STORAGE_MODE=redact` or `CN_LLM_DOMESTIC_ONLY` should be set for the mainland deployment.
4. **Legal note, camera video on GoApply** (sensitive personal information): on, behind the per-session consent. `CN_INTERVIEW_CAMERA_PUBLISH=false` restores audio-only.
5. **Legal note, launch scope:** a production deployment now serves `goapply.top` as soon as its DNS points there (set `ALLOWED_BRANDS=roboapply` to keep it closed). Draft legal documents are visible with a DRAFT banner; ICP, PSB, HR-licence and collecting-entity lines print only when set. For payments, the Alipay merchant should be the GoApply operating entity (二清); set `CN_PAYMENT_COLLECTING_ENTITY` to print it.
6. **GoHire feed:** approve the syndication endpoint in the GoHire backend (second repo) and a scoped service key, or enable TLS on the GoHire Postgres endpoint. Until then the HTTPS list reader is used and works with the current key.
7. **Two confirmations on job data:** move the six legacy `sourceBoard = 'gohire'` rows to `market = 'cn'` on the clone branch; and whether RoboHire-bank jobs located in mainland China may appear under GoApply.
8. **Listings:** the published GoApply extension build and its store id; the first batch of campus calendar events; more verified China-hiring employer boards (the market strategy asks for at least 50 before the production launch; this wave seeds the first verified batch).

## 9. Relation to the market waves, and follow-ups

**MARKET_STRATEGY requirements folded into the parity bundles** (do not build them twice):

| Requirement | Folded into |
|---|---|
| JC-1 feed on by default; source line, original link, 最后核验; per-row apply target; honest header | PAR-1 (flag default), PAR-7 (data), PAR-8 (cards) |
| JC-2 interim: GoHire bank over the HTTPS list reader; `GOHIRE_SYNDICATION_URL` variant; test postings filtered | PAR-7 |
| JC-4 employer-board rows located in mainland China enter `market = 'cn'`; first verified seed | PAR-7 |
| JC-7 `jsearch` not in GoApply's providers; a row without an apply URL never listed; mainland normalisation | PAR-1, PAR-7 |
| JI-2 (one line): `linkedin` removed from RoboApply's `jobProviders` | PAR-1 |
| AL-1 characterisation tests for the twelve Alipay rules | PAR-6 (first item) |
| AL-2 rail opens with the callback secret alone; AL-5 rail chooser, Alipay first | PAR-1 (flags), PAR-6 |
| PC-1 GoApply half (CNY defaults, kill switch, whole-yuan override); PC-2 GoApply student passes | PAR-6 |

**Left to the market waves** (they touch files owned here by PAR-6 and PAR-7, so they start after this wave merges): PC-1 RoboApply half, PC-3…PC-5, every ST-*, AL-3, AL-4, AL-6…AL-8, JI-1…JI-12 except the `linkedin` line, JT-*, JC-3, JC-5, JC-6, JC-8, every SM-*.

**Other follow-ups.**
- GoHire product: a publish step that requires employer, city and pay; `employerVerified` and a consent-to-syndicate field before any bank job becomes a public page.
- A mainland web-search provider and people-search target as optional overrides.
