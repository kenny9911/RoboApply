# CN / TW launch plan: GoApply (goapply.top) and Taiwan on RoboApply (roboapply.io)

**Owner:** International launch lead. **Date:** 2026-10-09, revised 2026-10-10 after three critic reviews. **Branch:** `feat/jobright-clone`.

> **How this maps to the task plan.** The work packages below are this plan's view; the executable split, file ownership and wave order are in `TASK_PLAN.md` (precedence and code layout: R-01/R-02; brand ids `roboapply`/`goapply` with `market` `intl`/`cn`). Mapping: WP-BRAND → WP-12 · WP-COMPLY → WP-13 · WP-AUTH-CORE → WP-10 · WP-AUTH-CN → WP-11 · WP-PAY → WP-21a/21b + WP-62 · WP-LLM-CN → WP-14 + WP-24 (content safety) · WP-RESIDENCY → WP-15 · WP-TW-LOCALE → WP-12 + WP-19 · WP-JOBS-CN → WP-41 · WP-ONB-CN → WP-31 + WP-65 · WP-TRK-CN → WP-38 + WP-64 · WP-CAL-CN → WP-58 · WP-DEPLOY-CN → WP-76 · WP-VOICE-CN → WP-63a + WP-63b + WP-66 (format, rubric, report) · WP-TW-JOBS → WP-42 · WP-NOTIF-CN → WP-73 · WP-EXT-CN → WP-71. Where this plan is stricter on legal, residency or data egress, it wins.
**Status:** Plan of record for implementation agents. Not legal advice. Every item in Part C needs sign-off from PRC counsel (mainland) or Taiwan counsel (TW) before it gates a production launch.

**Inputs read:** `research/china-market.md` (whole file), `FEATURE_CATALOG.md` §6 and §7, the brand/market/i18n, backend and interview maps, `docs/roboapply/OVERHAUL_RULINGS.md` (R1), and the code. Every "today" claim in §1 was checked against the code on 2026-10-09.

**Naming.** The international brand is **RoboApply at roboapply.io**, and Taiwan is part of it. Where the research says "RoboHire.io", read RoboApply. RoboHire.io stays the separate recruiter product. The mainland brand is **GoApply at goapply.top**. The code uses market-neutral brand ids **`intl`** and **`cn`**. Display names, hosts and logos are data in the brand registry. Do not reuse the recruiter ids `robohire`/`gohire` or the `APP_NAME` env var, which today selects the recruiter bank and DB (`server/src/lib/databaseUrl.ts:36-105`).

**Binding owner decisions that this plan applies:**
- **D1:** never submit on the user's behalf. In Chinese this means no 自动投递, 代投, 海投 or 自动打招呼. The autofill extension is called **一键填表** (zh-TW 一鍵填表), never 一键网申 or 一键投递.
- **D3:** no fabricated data. Every number shows its source.
- **D4:** Wave 0 (Track A) owns the live-interview fixes. This plan builds on top of Wave 0 and does not re-plan it.

---

## 0. Decisions in this plan (the short version)

| # | Decision |
|---|---|
| L-1 | One codebase with two brands, resolved per request from `x-forwarded-host` then `host`. **Both brands share one schema.** Every brand-scoped row carries `brand`. No feature may need a cross-brand join, so the mainland database can later be split off mechanically. |
| L-2 | Three mainland stages. **CN-0**, an offshore closed beta: same Vercel project, same Neon DB, invite-only, free, seeker tools only. **CN-1**, a mainland soft launch: Aliyun Shanghai stack, CN database, ICP, SMS and WeChat login, still free. **CN-2**, commercial: payments, licensed job information, campus calendar, extension, mini program. The code for all three ships now. Stage is selected by env and credentials, not by branches. |
| L-3 | **The `cn` brand never sends data to OpenRouter, Anthropic, OpenAI, Google or any non-allowlisted LLM, at any stage, including CN-0.** A hard-coded allowlist (deepseek, qwen, kimi, glm, doubao, minimax) is enforced in `LLMService`. With no CN model configured, cn AI features are hidden. They **never** fall back to intl models, and the Wave 0 fallback chain must respect this. |
| L-4 | `CN_RECRUITMENT_INFO_MODE = off \| partner_deeplink \| licensed` (default `off`). The cn job feed, recommendations, campus calendar and job alerts work only in `partner_deeplink` (GoHire's licence, with counsel OK) or `licensed`. In `off`, GoApply is a seeker toolkit: resume, practice interviews, tracker, and jobs the user imports. |
| L-5 | **No scraping, ever.** That covers BOSS直聘, 智联, 51job, 猎聘, 104, 1111, Cake and Yourator. Mainland sources: the GoHire bank, user-imported jobs, ops-curated official campus announcements, and partner feeds. Taiwan sources: RapidAPI providers with `country=tw`, public ATS job-board APIs, Taiwan open government data (to verify), and partnerships. BOSS/智联/猎聘 get user-initiated **search deep links only**. |
| L-6 | The brand locks the payment rail. `cn`: CNY through Alipay (the existing GoHire worker) and WeChat Pay v3 (new). Both are off until `CN_PAYMENTS_ENABLED=true`. `intl` (TW and HK included): Stripe USD only. The `?region=` rail flip is removed. Existing intl Alipay passes are honoured until they expire. |
| L-7 | Taiwan sees prices in USD with a **reference TWD amount**. The rate comes from an admin-maintained config that carries a source and an as-of date, and it hides itself when missing or older than 45 days. Billing stays in USD. |
| L-8 | cn identity requires a **verified mobile number** (real-name). It can be reached by phone OTP or by WeChat login followed by phone binding. Users without a real email get a reserved placeholder `…@users.goapply.invalid` with `emailIsPlaceholder=true`, and the email layer refuses to send to `.invalid`. intl adds Google, **LINE Login** and password reset. |
| L-9 | Taiwan users are always intl. A brand is never inferred from IP. The country header can only show a dismissible "use the other site" nudge. cn location pickers list only mainland cities, so cross-strait naming never comes up on GoApply. On intl, Taiwan is labelled "Taiwan" / 台灣. |
| L-10 | **New finding:** the GoHire parse API (`api.gohire.top`, also `worker.gohire.top` and `www.gohire.top`) resolves to 101.89.86.83, whose whois is CHINANET-SH, country CN. Today every **intl** resume upload, Taiwan included, goes to a mainland server for parsing. Decision: `GOHIRE_PARSE_BRANDS` defaults to `cn`. intl uses the local parser unless the owner opts in **and** the intl privacy notice discloses the transfer. |
| L-11 | cn voice interviews are **audio-first**. There is no face recognition, no face templates and no video recording. The camera is a local preview only. Transcripts stay in-region with 90-day retention. In CN-0 voice uses a separate LiveKit Cloud project (Asia region) with a domestic LLM. In CN-1 it uses self-hosted LiveKit in Shanghai with DashScope Paraformer STT and CosyVoice TTS. Volcano Engine RTC or Tencent TRTC is the fallback, behind the `VoiceSessionProvider` seam. |
| L-12 | AI labelling (cn): an in-app "AI 辅助生成" badge, plus implicit metadata in every PDF/DOCX export. `CN_AI_EXPORT_EXPLICIT_LABEL` defaults to `on` (a one-line footer on exports) until counsel rules on decision D-08. Each export writes a 6-month log row. |
| L-13 | Mainland deploy uses the same repo and the same commit: the Next `standalone` container, the Express container, the interview worker container and K8s CronJobs generated from `vercel.json`. Images are built by GitHub Actions, pushed to Aliyun ACR and run on ACK in Shanghai. Fonts are already self-hosted (correcting CN-E-02 in the catalog). |

---

## 1. Ground truth: what exists today (verified 2026-10-09)

| Area | What the code does today | Evidence | Consequence for this plan |
|---|---|---|---|
| Brand | No product-brand concept and no host-based logic. `server/src/brands/*` holds recruiter leftovers. "RoboApply" is hard-coded in 16 frontend lines, 18 i18n keys × 9 locales, and 69 server lines, including 10 LLM personas. | brand map §1, §12 | Foundation builds the `intl`/`cn` registry (§4.1) |
| Auth | Email + password only: `POST /signup` `:84`, `/login` `:200`, `GET /me` `:272`, `/logout` `:365` in `server/src/roboapply/routes/auth.ts`. No reset, OAuth, phone, WeChat or email verification. `User.phone` is not unique. `User.email @unique` is global. No `brand` column. | routes/auth.ts; schema.prisma `model User` :71 | WP-AUTH-CORE, WP-AUTH-CN |
| Consent | `SeekerConsentRecord` ledger with a closed enum: `seeker_app_optin`, `biometric_*`, `auto_apply`, `external_board_share`, `transactional_email`, `marketing_email`, `ai_assistance`. Prose version and hash are stored. | `server/src/roboapply/engine/lib/seekerConsentTypes.ts`; schema :4772 | Extend the enum; reuse the ledger (§4.1) |
| Payments | Stripe USD subscription. Alipay CNY monthly pass through the GoHire worker (`ALIPAY_API_URL` default `https://worker.gohire.top/payment/payment/create` `:338`, `platform: 'gohire'` `:323`). **`alipayConfigured` is always true** (`:195`). **No WeChat Pay.** Any user can flip rails with `?region=`. | `server/src/roboapply/services/RoboApplyBillingService.ts`; `routes/billing.ts:56-182` | WP-PAY |
| LLM | Providers `openai`, `openrouter`, `google`, `kimi`/`moonshot` (`api.moonshot.cn`), `deepseek` (`api.deepseek.com`), `anthropic`, `minimax`, `ollama`, `newapi` (`LLMService.ts:240-271`). **No Qwen, GLM or Doubao adapter.** `GLM_API_KEY` is in `.env` but nothing reads it. No per-brand routing. The AsyncLocalStorage request context is never entered (`app.ts`), so BYOK is dead. | `server/src/services/llm/*` | WP-LLM-CN |
| Fonts / third-party | **Fonts are self-hosted** under `app/fonts/*.woff2`, including `source-han-sans-cn-vf` and `source-han-sans-tw-vf`. No `next/font/google`, analytics, Sentry, CDN script or Stripe.js. `app/fonts/_download.py` is only a fetch script. | grep of app/lib/components | Catalog CN-E-02 ("Google Fonts") is outdated. Remaining offshore dependencies are server-side (§6.4). |
| Resume export | `pdfkit` + `docx` with CJK font embedding | `server/src/roboapply/v2/lib/resumeExport.ts` | The A4/CJK path exists; add AI-label metadata (WP-COMPLY) |
| Resume parse | GoHire API first (`DEFAULT_API_BASE='https://api.gohire.top'` `:36`), local parser as fallback | `server/src/services/GoHireResumeParseService.ts` | **Mainland host** (decision L-10) |
| Object storage | S3-compatible client via `S3_ENDPOINT/REGION/BUCKET/...` for resume originals and interview recordings | `ResumeOriginalFileStorageService.ts`, `interview-engine/config.ts:110-120` | Aliyun OSS's S3-compatible endpoint can be swapped in through `CN_S3_*` (smoke-test it) |
| DB driver | Prisma 7 with `@prisma/adapter-pg` (node-postgres pool) | `server/src/lib/prisma.ts:16,285` | Works against Aliyun RDS PostgreSQL / PolarDB; no Neon lock-in |
| Hosting | `next.config.mjs` `output:'standalone'`. Express runs `app.listen` off-Vercel. The worker has Docker plus `deploy/{fly,k8s,render,railway,systemd}`. **No `.github/workflows`.** 8 Vercel crons. The node-cron mirror **does not run `reconcileInterviewSessions`**. | next.config.mjs:3; vercel.json; RoboApplyCronService.ts | WP-DEPLOY-CN generates CronJobs from `vercel.json` |
| Voice | One LiveKit Cloud project. STT `deepgram/nova-3`, TTS `cartesia/sonic-3` through the LiveKit gateway. Agent `RoboApply-Interview`. The client receives `serverUrl` from the server per session, so per-brand LiveKit needs no frontend env. | interview maps | WP-VOICE-CN (after Wave 0) |
| Email | Resend only. The digest sends as "RoboHire". Billing-reminder links default to `roboapply.robohire.io`. | brand map §7 | Per-brand transport (WP-RESIDENCY) |
| Job sources | RapidAPI (JSearch `/search-v2`, ActiveJobsDB, LinkedIn) with default country `us`. Cross-bank RoboHire/GoHire DBs. `.env.example` has `GOHIRE_PUBLIC_JOB_BASE_URL=https://www.gohire.io`, **which is wrong** (should be gohire.top). | `raJobProviders.ts`, `job-search/validation.ts:40` | Per-brand source list (Foundation + WP-JOBS-CN/TW) |
| zh-TW copy | Already uses Taiwan terms: 履歷 ×146, 職缺 ×186, 應徵 ×50, with 0 occurrences of 简历/岗位/網申/校招/視頻/軟件/信息/默認/用戶/登錄. Missing: 待遇 and 面議 (0 each). | grep of `i18n/messages/zh-TW.json` | Lock this in with `scripts/check-zh-variants.mjs` (WP-TW-LOCALE) |

---

## 2. Market and brand model

### 2.1 Brand registry values (the Foundation wave creates them; this table is the spec)

| Field | `intl` (RoboApply) | `cn` (GoApply) |
|---|---|---|
| Hosts | `roboapply.io`, `www.roboapply.io`, `api.roboapply.io` | `goapply.top`, `www.goapply.top` |
| Dev / preview hosts | `localhost:3611`, `127.0.0.1` | `goapply.localhost:3611`. On previews: `BRAND_FORCE=cn`, or the `ra_brand_dev` cookie set by `?brand=cn` (non-production or preview hosts only) |
| Canonical origin | `https://www.roboapply.io` (`INTL_CANONICAL_ORIGIN`) | `https://www.goapply.top` (`CN_CANONICAL_ORIGIN`) |
| Locales | all 9; default `en` | `zh` (default), `en`. Other locale paths get a 301 to the same path on intl. `/zh-TW` on goapply.top → `https://www.roboapply.io/zh-TW`. |
| Market and currency | market from country: `tw`, `jp`, `other` (HK and Macau are `other`); currency **USD** | market `cn`; currency **CNY** |
| Payment rails | `stripe` | `alipay`, `wechatpay` (gated by `CN_PAYMENTS_ENABLED`) |
| Auth methods (when configured) | `email_password`, `google`, `line` (LINE listed first when locale is zh-TW or the country is TW) | `phone_otp`, `wechat` (+ `email_password` as a fallback for users who already have one) |
| LLM profile | unprefixed env (today's stack) | `CN_` env prefix; provider allowlist (L-3) |
| Job sources | external `[activejobs, linkedin, jsearch]`, `ats_public` (new), `tw_open_data` (if verified). Banks `[robohire]` (+gohire only with `RA_CROSSBANK_CROSS_TENANT_CONFIRMED`). Default country `us`; `tw` when market=tw. | external `[]`; banks `[gohire]`; `campus_calendar`; `user_import`. Default country `cn`. All recruitment information is gated by `CN_RECRUITMENT_INFO_MODE`. |
| Interview | `LIVEKIT_*`, agent `RoboApply-Interview` | `CN_LIVEKIT_*`, agent `GoApply-Interview`, provider `CN_VOICE_PROVIDER` |
| Email | Resend, `ROBOAPPLY_EMAIL_FROM` | `CN_EMAIL_TRANSPORT` (`aliyun_dm` \| `resend` \| `none`), `CN_EMAIL_FROM` |
| Storage | `S3_*` | `CN_S3_*` (no fallback to `S3_*`) |
| Legal footer | entity, privacy, terms | entity, **ICP no.**, **公安备案 no.**, EDI licence no., HR licence no. and holder, AI model and filing disclosure, 投诉举报 contact. Each is shown only when set. |
| Other brand | `cn` | `intl` |

### 2.2 The `brandEnv` rule
`brandEnv(brand, NAME)` returns `process.env[NAME]` for `intl` and `process.env['CN_' + NAME]` for `cn`. For `cn` there is **no fallback** to the unprefixed variable. That one rule is what prevents a missing `CN_S3_BUCKET` from sending mainland resumes to the intl bucket. Vendor keys that only domestic vendors use (`DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY`, `KIMI_API_KEY`, `GLM_API_KEY`, `ARK_API_KEY`, `WECHAT_*`, `WECHATPAY_*`, `ALIYUN_*`, `TENCENT_SMS_*`) are unprefixed because they are cn-only by nature.

### 2.3 Capabilities: how features hide when credentials are missing
`server/src/brand/capabilities.ts` computes `Capabilities` per brand at request time from env, DB AppConfig and the deploy stage. `GET /api/v1/roboapply/v2/brand/capabilities` returns it, and `useCapabilities()` reads it on the client. **Rules for every agent:**
1. A UI entry point for a disabled capability is **not rendered**. No disabled button, no "coming soon" with fake previews, no demo data.
2. The server route for a disabled capability returns `404 {code:'feature_unavailable'}`, or `503 {code:'ai_unavailable'}` for AI. The client already handles both, so there are no silent failures.
3. Capability keys: `auth.phoneOtp`, `auth.wechatWeb`, `auth.wechatInApp`, `auth.wechatMini`, `auth.google`, `auth.line`, `auth.passwordReset`, `pay.stripe`, `pay.alipay`, `pay.wechatpay`, `ai.text`, `ai.vision`, `ai.interviewVoice`, `jobs.feed`, `jobs.recommendations`, `jobs.campusCalendar`, `jobs.import`, `jobs.alerts`, `notify.email`, `notify.wechat`, `fx.reference`, `legal.footer.*`, `ext.autofill`.
4. In production, `cn` signup is disabled unless `CN_LEGAL_DOCS_VERSION` is set (counsel-approved documents exist) **and** at least one of `auth.phoneOtp` / `auth.wechatWeb` is live. In CN-0, `email_password` with an invite code is allowed (§3).

### 2.4 Cross-brand behaviour
- One person may hold an account on each brand. Phase 1 keeps `email @unique`. Logging into the wrong brand returns `409 {code:'account_other_brand', otherBrandUrl}` and a localized message. `@@unique([brand, phoneE164])` is used for phones. Phase 2 (after the CN-1 database split) needs no change.
- Nudges: a visitor on intl with `x-vercel-ip-country=CN` and locale `zh` sees one dismissible banner pointing to GoApply, and the reverse for zh-TW/HK/MO visitors on goapply.top. Nothing redirects automatically, and the nudge never changes the currency or the rail.
- **Data never crosses brands.** No cn user's resume, transcript or profile is processed by intl services or the reverse, and admin exports run per brand.

---

## 3. Launch stages and gates

| Stage | Hosting / data | Who can use it | Features on | Hard gates (Part C) | Flags / env |
|---|---|---|---|---|---|
| **TW-0** (as soon as WP-AUTH-CORE, WP-TW-* and WP-PAY merge) | intl stack (Vercel + Neon us-east) | everyone | the whole intl product in zh-TW; LINE login; TWD reference prices; TW job sources | PDPA notice text approved; LINE channel; e-invoice threshold monitoring | `LINE_LOGIN_*`, `RA_FX_REFERENCE` AppConfig |
| **CN-0** offshore closed beta | intl stack; `User.brand='cn'` rows in Neon; goapply.top CNAME to Vercel (**no ICP needed for an offshore host**) | invite codes only (`BrandInvite`), cap 1,000 accounts | resume suite, text practice interviews, voice practice (if `CN_LIVEKIT_*`), tracker with user-imported jobs, copilot on domestic models | domestic LLM keys; cross-border **separate consent** and PIA; PRC representative designated (PIPL Art. 53, offshore processor); counsel OK for a closed beta before 登记 | `ALLOWED_BRANDS=intl,cn`, `CN_SIGNUP_MODE=invite`, `CN_RECRUITMENT_INFO_MODE=off`, `CN_PAYMENTS_ENABLED=false` |
| **CN-1** mainland soft launch | Aliyun cn-shanghai: ACK + RDS PostgreSQL + OSS + CDN; self-hosted LiveKit. CN-0 users are migrated (with notice) and then purged from Neon. | open signup | CN-0 features + phone OTP + WeChat login + 公众号 notices + (if counsel OKs the GoHire licence route) `partner_deeplink` jobs | mainland entity; ICP 备案; 公安备案 within 30 days; SMS signature and templates; WeChat Open Platform and 公众号 verification; **生成式AI 登记**; content safety; legal docs | mainland deploy: `DEPLOY_REGION=cn-mainland`, `ALLOWED_BRANDS=cn`; intl deploy: `ALLOWED_BRANDS=intl` |
| **CN-2** commercial | as CN-1 | open | payments (WeChat Pay / Alipay), `licensed` recruitment info (feed, recommendations, campus calendar, alerts), 一键填表 extension, mini program (P2) | **经营性ICP (EDI) licence** before charging; **人力资源服务许可证** (online recruitment scope) or a licensed partner; algorithm filing (if counsel says it applies); merchant accounts; mini-program 备案 | `CN_PAYMENTS_ENABLED=true`, `CN_RECRUITMENT_INFO_MODE=licensed` |

A startup assertion (WP-RESIDENCY) refuses to boot when `DEPLOY_REGION=cn-mainland` and any of the following holds:
- `CN_ICP_NUMBER` is unset;
- the `DATABASE_URL` host is not on the CN allowlist (default suffixes are maintained in code; override with `CN_ALLOWED_DB_HOST_SUFFIXES`; private RFC1918 IPs are allowed);
  a match on a **default** Aliyun RDS suffix does not prove the region (the same suffix serves offshore regions), so the check only warns there; ops confirm the RDS RegionId or use the VPC private address (WP-15);
- `ALLOWED_BRANDS` contains `intl`;
- any CN LLM provider resolves outside the allowlist.

---

## 4. Part A: what code can do now in this repo

### 4.1 Foundation-wave asks (scaffolding that must exist before the feature waves)
Feature WPs below assume these exist. Where the master plan already has the same scaffolding, the master plan's file names win, and this list only adds the missing fields.

1. **Brand core** (server): `server/src/brand/registry.ts` (values from §2.1), `server/src/brand/resolve.ts` (`brandFromHost`, `brandFromRequest`, `BRAND_HOST_MAP` and `BRAND_FORCE` overrides), `server/src/brand/brandEnv.ts` (§2.2), `server/src/brand/capabilities.ts` (all cn keys `false`, intl keys computed from today's env), `server/src/middleware/brandContext.ts`, and the brand in `server/src/lib/requestContext.ts` (`getCurrentBrand`, `runWithBrand`). Mount it in `app.ts`, which also revives BYOK and attribution. Generate CORS origins from `registry.hosts`.
2. **Brand core** (web): `lib/brand/registry.ts` (mirror) + `__tests__/lib/brandParity.test.ts`, `lib/brand/BrandProvider.tsx` (`useBrand`), `lib/serverBrand.ts` (`resolveBrand()` via `headers()`), and `proxy.ts` stamping `x-ra-brand`. `app/layout.tsx` sets `<html data-brand>` and imports `styles/brand-cn.css` (an empty stub that WP-BRAND fills). `lib/api/client.ts` sends `X-RA-Brand` in dev only. `next.config.mjs` adds image remote patterns for `CN_PUBLIC_ASSET_BASE_URL`.
3. **Market slots:** stub components that feature WPs fill without touching shared cards:
   - `components/market/MarketJobMeta.tsx` dispatches to `components/market/{cn,tw}/JobMeta*.tsx`;
   - `components/market/LegalFooter.tsx`;
   - `components/market/OtherBrandNudge.tsx`;
   - `components/market/AiGeneratedBadge.tsx`;
   - `components/market/PriceReference.tsx`.
   The job card, footer, pricing and resume editor import these once (foundation edit). Market WPs then own only the `market/` files.
4. **Prisma** (multi-file; additive only):
   - `server/prisma/schema/identity.prisma`:
     - `User` gets `brand String @default("intl")` + `@@index([brand])`, `phoneE164 String?`, `phoneVerifiedAt DateTime?`, `emailIsPlaceholder Boolean @default(false)`, `@@unique([brand, phoneE164])`.
     - `AuthIdentity { id, userId, brand, provider ('google'|'line'|'wechat_open'|'wechat_mp'|'wechat_mini'), providerUserId, unionId?, email?, displayName?, avatarUrl?, createdAt, lastUsedAt; @@unique([provider, providerUserId]); @@index([unionId]); @@index([userId]) }`.
     - `PhoneOtp { id, brand, phoneE164, codeHash, purpose ('login'|'bind'), attempts Int @default(0), ipHash, expiresAt, consumedAt?, createdAt; @@index([phoneE164, createdAt]) }`.
     - `BrandInvite { id, brand, codeHash @unique, maxUses, uses, expiresAt?, note?, createdAt }`.
   - `server/prisma/schema/billing.prisma`: `AlipayOrder` gets `brand String @default("intl")`, `channel String @default("alipay")` ('alipay'|'wechatpay'), `wxPrepayId String?`, `wxCodeUrl String?`, `wxTransactionId String?`, `tradeType String?` ('NATIVE'|'H5'|'JSAPI'). Keep the model name; history code then covers WeChat orders unchanged. `SeekerSubscription` gets `brand`, `billingCountry String?`.
   - `server/prisma/schema/compliance.prisma`:
     - `AiContentLabelLog { id, brand, userId, artifactType, artifactId, labelMode ('explicit'|'implicit_only'), contentId, createdAt; @@index([createdAt]) }` (6-month purge);
     - `ContentSafetyEvent { id, brand, userId?, surface, direction ('input'|'output'), verdict, matched Json?, createdAt }`;
     - `PersonalInfoRequest { id, brand, userId, kind ('access'|'export'|'correct'|'delete'|'withdraw'), status, dueAt, createdAt, closedAt? }`.
   - `server/prisma/schema/jobs-market.prisma`:
     - `CampusRecruitingEvent { id, brand @default("cn"), companyName, title, cohortLabel ('2027届'), gradWindowStart, gradWindowEnd, applyOpensAt?, applyClosesAt?, stages Json, officialUrl, sourceUrl, sourceName, verifiedAt?, verifiedByUserId?, status ('draft'|'published'|'archived'), createdAt, updatedAt; @@index([status, applyClosesAt]) }`;
     - `CampusEventSubscription { id, userId, eventId, remindAt?, channel; @@unique([userId, eventId]) }`;
     - `CareerSiteSource { id, brandScope, ats ('greenhouse'|'lever'|'ashby'|'smartrecruiters'), boardToken, companyName, countryCode, enabled, lastSyncedAt?, lastError?; @@unique([ats, boardToken]) }`.
   - **Fields this plan needs on models the jobs plan owns (`RAJob`):** `sourceName`, `sourceUrl`, `originalSourceName` (reposted-source duty), `expiresAt`, `payDisclosed Boolean`, `salaryText` (verbatim, e.g. 面議), `countryCode`, `brandScope` ('intl'|'cn'|'both'), `fraudFlags Json?`, and `marketTags Json?` (array of `{tag, evidenceQuote, evidenceUrl}`).
   - Consent enum (`seekerConsentTypes.ts`) gains: `pipl_basic_processing`, `pipl_cross_border`, `pipl_sensitive_pi`, `ai_resume_parsing`, `personalized_recommendation`, `interview_recording`, `share_with_gohire`, `age_16_plus`, `tw_pdpa_notice`, `intl_cross_border_cn_parse`.
5. **Stub routers** (mounted, returning `feature_unavailable` until filled):
   - `/api/v1/roboapply/auth/{methods, password/forgot, password/reset, oauth/:provider/start, oauth/:provider/callback, phone/send-code, phone/verify, phone/bind, wechat/qr, wechat/callback, wechat/mp/start, wechat/mp/callback, wechat/mini/login}`;
   - `/api/v1/roboapply/billing/{wechatpay, wechatpay/notify}`;
   - `/api/v1/roboapply/v2/{brand/capabilities, legal/disclosures, campus-calendar, campus-calendar/:id/subscribe, pi-requests}`;
   - `/api/v1/roboapply/v2/admin/{campus-calendar, fx-reference, brand-invites, career-sources}`.
6. **lib/api modules:** `lib/api/brand.ts`, `lib/api/authProviders.ts`, `lib/api/campusCalendar.ts`, `lib/api/legal.ts`, plus hooks `useCapabilities`, `useDisclosures`.
7. **i18n staging:** cn-only copy goes in `i18n/staging/marketCn.en.json` **and** `i18n/staging/marketCn.zh.json`. cn WPs may author zh directly because zh is GoApply's primary language. The integration wave reviews it and merges it into `i18n/brands/cn/{zh,en}.json`, the brand override bundles deep-merged after the locale bundle. `loadMessages(locale, brand)` replaces the literal `RoboApply` with `brand.name`. TW-only copy goes in `i18n/staging/marketTw.en.json` and is translated to zh-TW by the integration wave using the glossary in §9.

### 4.2 Work packages
Columns: **wave** is the earliest wave relative to Foundation (W2 = first feature wave). **Owns** lists exclusive files. Where a WP would collide with a master-plan WP on the same files (billing, auth pages, LLMService), **merge them into one agent run**; never split those files across two agents in the same wave.

#### WP-BRAND: brand presentation, SEO and locale clamp (both brands), W2, about 1,800 LOC
- **Owns:** `lib/seo.ts`, `app/sitemap.ts`, `app/robots.ts`, `app/llms.txt/route.ts` (new; delete `public/llms.txt`, which still advertises auto-apply), `components/chrome/BrandSymbol.tsx` (adds a `brand` prop), `components/v3/shell/BrandLogo.tsx`, `components/landing/LandingJsonLd.tsx`, `components/landing/LanguageMenu.tsx`, `lib/localeConfig.ts` (brand helpers; unify the AuthShell and LanguageMenu lists), `lib/serverLocale.ts`, `app/[locale]/page.tsx` (clamp and 301 to intl), `styles/brand-cn.css` (identity-token overrides for light and dark, within ruling R3's four identity surfaces), `components/market/OtherBrandNudge.tsx`, `public/goapply-mark.svg`, `public/goapply-logo.png`, `public/og-goapply.png`, and deletion of the dead `components/chrome/Logo.tsx`.
- **Behaviour:**
  - Metadata, canonical, sitemap and robots are per host (Next 16 makes them dynamic when they call `headers()`).
  - cn adds the `baidu-site-verification` meta (`CN_BAIDU_SITE_VERIFICATION`; omitted when unset) and Baiduspider rules.
  - Hreflang: intl `/zh` is `zh-Hans`, goapply.top `/` is `zh-CN`, and each brand's sitemap lists its own URLs with alternates on the other domain.
  - `OpenRouterProvider.ts` headers are fixed to the intl brand (they belong to LLM, so WP-LLM-CN changes them).
- **Acceptance:** `__tests__/lib/brandFromHost.test.ts`, updated `localized-landing`/`landing` tests, and a snapshot of `/sitemap.xml`, `/robots.txt` and `/llms.txt` for both hosts.

#### WP-COMPLY: consent, legal surfaces and AI labelling (both brands), W2, about 2,500 LOC
- **Owns:** `components/market/LegalFooter.tsx`, `app/(public)/legal/[doc]/page.tsx`, `content/legal/{intl,cn}/*.md`, `components/market/consent/*`, `server/src/market/consent/*`, `server/src/roboapply/v2/routes/legal.ts` (disclosures and PI requests), `components/market/AiGeneratedBadge.tsx`, `server/src/market/cn/aiLabel.ts`, `components/v3/account/privacyControls.tsx`, and the PI-request handling plus purge crons for `AiContentLabelLog` (180 days).
- **Legal documents:**
  - intl: privacy, terms, AI disclosure, and the TW PDPA Art. 8 notice.
  - cn: 隐私政策, 用户协议, 个人信息收集清单, 第三方共享清单, AI 生成内容标识说明, 投诉举报.
  - Documents are markdown supplied by counsel. Agents write a **clearly marked DRAFT** skeleton listing the required headings. Production rendering for cn requires `CN_LEGAL_DOCS_VERSION`.
- **cn signup consent screen:**
  - One required checkbox for 用户协议 + 隐私政策, plus `age_16_plus`.
  - **Separate**, unbundled, unchecked toggles: AI resume parsing (`ai_resume_parsing`; required only to use AI parsing, and manual entry stays available; when it is off, **no** GoApply feature sends that user's data to a model — scoring falls back to the deterministic "Quick estimate", and Assistant, tailoring, letters and extension answers are hidden), sensitive PI (only when a photo, health or ID-type field is entered), personalised recommendations (**unset with no preselection; the user must choose 开启 or 关闭; until they choose, ranking is recency + filters only**; can be changed in settings), sharing with GoHire, interview recording (asked at session setup), long-term Assistant memory (`copilot_memory`, asked in context).
  - CN-0 adds `pipl_cross_border` (required in CN-0). Its prose names every offshore processor and region: Neon (us-east database), Vercel, LiveKit Cloud, Deepgram/Cartesia, Resend. Withdrawing it closes and purges the account. CN-0 copy never claims data stays in the mainland.
  - CN-0 storage minimization: no original upload is kept; parsed resume text is redacted (ID numbers, health keywords) **before storage**; no photo is stored.
- **intl signup:** a required "I'm 16 or older" consent (`age_16_plus`) on RoboApply too; the PDPA notice is shown to zh-TW/TW users (`tw_pdpa_notice`). The marketing opt-in is **unchecked**. If the owner keeps GoHire parse on for intl, `intl_cross_border_cn_parse` is required before upload, and "manual entry / local parse" is offered when it is declined.
- **Personalised recommendations off:** the server preference makes the feed WP's ranking use a non-personalised order (recency + filters). An "为什么推荐 / Why this job" explanation is required wherever a score is shown (PIPL Art. 24). The feed WP renders it; this WP provides `explainMatch()` copy rules.
- **AI labels (cn):**
  - The badge appears on every AI-generated block.
  - `aiLabel.ts` exposes `implicitLabelMetadata(artifact)`, which returns PDF info/XMP keys and DOCX custom properties following the implicit-label fields of the 2025 national labelling standard (generation flag, provider code, content ID; verify field names against GB 45438-2025). It also exposes `explicitFooterLine(locale)`.
  - The resume/cover-letter export WP calls both. This WP supplies the functions and a test.
  - Every export writes `AiContentLabelLog`.
- **PI rights:** a request queue with a 15-working-day `dueAt`. It reuses the existing `/account/delete` and `wipe-data` for execution.
- **Acceptance:** consent rows written with the prose hash; no pre-checked optional consent (unit tests on the consent schema); the footer renders only the configured numbers; the ICP link points to `https://beian.miit.gov.cn/`; 公安备案 links `https://beian.mps.gov.cn/#/query/webSearch?code=<CN_PSB_RECORD_CODE>`.

#### WP-AUTH-CORE: methods, password reset, Google, LINE, linking (intl + shared), W2, about 2,500 LOC
*(Merge with the master auth WP if one exists.)*
- **Owns:** `app/(public)/login/*`, `app/(public)/signup/*`, `components/auth/AuthShell.tsx`, `components/auth/methods/{email,google,line}/*`, `lib/api/auth.ts`, `server/src/roboapply/routes/authProviders.ts` (the methods, password and oauth parts), `server/src/roboapply/engine/services/SeekerOAuthService.ts`, `server/src/roboapply/engine/services/SeekerAuthService.ts` (brand stamping, the `account_other_brand` check, placeholder-email handling), `server/src/lib/oauth/{google,line}.ts`, `server/src/lib/cookieOptions.ts` (`buildCookieOptions(req)`; host-only cookies by default, `COOKIE_DOMAIN` for intl, `CN_COOKIE_DOMAIN` for cn).
- **Behaviour:**
  - `GET /auth/methods` returns `brand.authMethods ∩ capabilities` in display order.
  - Password reset works for both brands through the brand email transport. When the email transport is absent, reset is hidden and "contact support" is shown.
  - LINE uses OIDC with the `openid profile email` scope. LINE grants email only after the channel's email permission is approved; when email is absent, the user must enter and verify an email before the account is created.
  - Google and LINE login create **seeker** users (never the recruiter `AuthService.oauthLogin`, which enforces a business-email gate).
- **Absent credentials:** each provider is hidden.
- **Acceptance:** login and `/auth/me` verified on both hosts (AGENTS.md rule); both session cookie constants stay aligned.

#### WP-AUTH-CN: phone OTP, WeChat web/in-app/mini, bind-phone, W2, about 2,500 LOC
- **Owns:** `components/auth/methods/{phone,wechat}/*`, `components/auth/BindPhoneStep.tsx`, `server/src/roboapply/engine/services/SeekerPhoneOtpService.ts`, `server/src/roboapply/engine/services/SeekerWechatAuthService.ts`, `server/src/lib/sms/{index,aliyun,tencent,devConsole}.ts`, `server/src/lib/wechat/{oauth,miniProgram,client}.ts`, and the phone/wechat handlers in a separate file `server/src/roboapply/routes/authCn.ts`, mounted by Foundation under the same prefix.
- **Phone OTP:**
  - 6-digit code, hashed, 5-minute expiry, 5 attempts.
  - Limits: 1 send per 60 s per phone; 10 per phone per day; 20 per IP per hour.
  - The template contains **no links** (carrier rules).
  - E.164 for mainland numbers is +86 with 11 digits; other countries are rejected on cn.
- **WeChat:**
  - Outside WeChat: website QR (`snsapi_login`).
  - Inside the WeChat browser (UA `MicroMessenger`): 公众号 OAuth (`snsapi_base`, then `snsapi_userinfo` on consent).
  - Mini program: `POST /auth/wechat/mini/login` accepts `{code, phoneCode?}` (API only; the mini program client is out of scope).
  - Accounts are matched by `unionId` when it is present.
  - After WeChat login without a verified phone, the user is sent to bind a phone, and AI features are blocked until the phone is bound (real-name).
- **Dev:** `SMS_DEV_CONSOLE=true` prints codes to the server log only when `NODE_ENV!=='production'`. Production ignores it.
- **Absent credentials:** phone and WeChat are hidden. In production, if neither is live, cn signup is off (§2.3). CN-0 uses email + invite.

#### WP-PAY: brand-locked rails, WeChat Pay v3, TWD reference, TW revenue monitor, W2, about 2,200 LOC
*(Merge with the master billing/credits WP if one exists.)*
- **Owns:** `server/src/lib/billingRegion.ts`, `server/src/roboapply/routes/billing.ts`, `server/src/roboapply/services/RoboApplyBillingService.ts`, `server/src/lib/payments/wechatpay/*`, `server/src/roboapply/lib/invoiceReceipt.ts`, `server/src/roboapply/lib/billingEmails.ts`, `lib/pricing.ts`, `lib/serverMarket.ts`, `components/v3/account/{billing,planCatalog}.tsx`, `components/market/PriceReference.tsx`, and the admin FX-reference route plus its UI panel.
- **Rails and region:**
  - `resolveBillingRegion` takes the brand first. `?region=` is accepted only within the brand's rails (effectively removed).
  - Fix `alipayConfigured` to `Boolean(process.env.ALIPAY_API_URL)` with an explicit `ALIPAY_DEFAULT_WORKER_OK=true` escape hatch. The current code treats it as always true.
  - Alipay `notify_url` and return URLs use the request brand's canonical origin. Subject lines and receipts use `brand.name`.
- **WeChat Pay v3:**
  - Trade type by context: Native QR (desktop), H5 (mobile browser outside WeChat), JSAPI (inside WeChat, using the 公众号 openid from WP-AUTH-CN).
  - Notify verification uses the WeChat Pay public-key mode, decrypting the resource with the APIv3 key.
  - Idempotent fulfilment shares the Alipay pass-granting code.
- **TWD reference:**
  - AppConfig `fx.reference` = `{TWD:{rate, source, asOf}}`, edited in the admin console.
  - `PriceReference` renders "約 NT$X（依 {source} {asOf} 匯率估算，實際金額以發卡銀行為準）" only for zh-TW or market `tw`, only when `asOf` is 45 days old or less. It renders nothing otherwise.
- **TW revenue monitor:** the admin console shows year-to-date B2C revenue billed to TW cards (Stripe `billingCountry`), converted to NT$ at the reference rate, against the NT$600k threshold with a warning at 70%.
- **Absent credentials / flags:** each rail is hidden when unconfigured. cn plans render as "free during beta" with no price when `CN_PAYMENTS_ENABLED=false`, and no checkout route is reachable.
- **Acceptance:** an existing test is updated (`RoboApplyBillingService.alipay.test.ts`); WeChat Pay signature verification is tested against fixture vectors.

#### WP-LLM-CN: per-brand model profile, domestic adapters, egress guard, W2 (after Wave 0 merges), about 1,800 LOC
- **Owns:** `server/src/services/llm/LLMService.ts`, `providerPrefixes.ts`, `OpenRouterProvider.ts` (headers → intl brand), `server/src/lib/llm/{llmModels,llmTaskSettings,llmStackConfigResolver}.ts`, `server/src/market/cn/llmGuard.ts`, `server/src/lib/llm/brandPersona.ts`, the 10 persona agents (one-line swap to `brandPersona()`), `scripts/verify-llm-brand.ts`, and `server/src/market/cn/offPeak.ts`.
- **Adapters:**
  - New cases `qwen`/`dashscope` (OpenAI-compatible, `DASHSCOPE_BASE_URL` default `https://dashscope.aliyuncs.com/compatible-mode/v1`).
  - `glm`/`zhipu` (`GLM_API_BASE_URL` default `https://open.bigmodel.cn/api/paas/v4`).
  - `doubao`/`ark` (`ARK_BASE_URL` default `https://ark.cn-beijing.volces.com/api/v3`).
- **Routing:** for brand `cn`, `getModelSetting(key)` reads `CN_<MODEL_ENV[key]>` (and `CN_RA_MODEL_*`) with no fallback, and the DB stack key is per brand.
- **Guard:**
  - Before any call for brand `cn`, the provider must be in `{deepseek, qwen, kimi, glm, doubao, minimax}`. The base URL host must not be `openrouter.ai`, `*.anthropic.com`, `*.openai.com` or `generativelanguage.googleapis.com`.
  - BYOK is disabled for cn.
  - The Wave 0 fallback chain is filtered by the same guard.
  - A violation throws `BrandEgressViolation` (500, logged) and is never silently re-routed.
- **Other behaviour:**
  - The prompt locale defaults to `zh` for cn (`getStrictOutputLanguageDirective(locale,'content')`).
  - Reasoning-token headroom applies to DeepSeek V4 thinking and Qwen thinking modes (an existing lesson).
  - `offPeak.ts` schedules cn batch scoring and digests inside DeepSeek's off-peak windows when `CN_LLM_OFFPEAK_BATCH=true`.
- **Absent credentials:** with no `CN_LLM_PROVIDER` key resolvable, `ai.text` is false and every cn AI route returns `503 ai_unavailable`. The UI hides AI actions and offers manual editing.
- **Acceptance:** guard unit tests (cn plus openrouter must throw); `npm run verify:llm -- --brand cn` probes every CN task model.

#### WP-RESIDENCY: deploy region, egress policy, per-brand storage and email, W2, about 1,500 LOC
- **Owns:** `server/src/market/residency/{deployRegion,egressPolicy,startupAssertions}.ts`, `server/src/services/EmailService.ts` (`transportFor(brand)`, refusing `.invalid`), `server/src/lib/email/aliyunDirectMail.ts`, `server/src/services/ResumeOriginalFileStorageService.ts` (`brandEnv` S3 config), `server/src/services/GoHireResumeParseService.ts` (`GOHIRE_PARSE_BRANDS`, default `cn`, plus scrubbing the real candidate PII from the header comment flagged in the backend map), `server/src/roboapply/services/RoboApplyDigestService.ts` and `RoboApplyBillingReminderService.ts` (From address and links per brand, through `runWithBrand(user.brand)`), `server/src/market/pii/redact.ts` (removes 18-digit PRC ID numbers, TW national IDs and US SSNs before LLM calls, for both brands), and `.env.example` (all new variables; fix `GOHIRE_PUBLIC_JOB_BASE_URL=https://www.gohire.top`).
- **Egress policy:** a per-brand list of hosts allowed to receive PI.
  - cn: domestic LLM hosts, `api.gohire.top`, `CN_S3_ENDPOINT`, Aliyun SMS/DM/Green, WeChat, and the CN LiveKit host. In CN-0 the intl-hosted infrastructure (Neon, Vercel, LiveKit Cloud) is allowed only because consent covers it.
  - intl: today's list, minus `api.gohire.top` unless `GOHIRE_PARSE_BRANDS` includes intl.
  - Tavily, Firecrawl and RapidAPI may receive **no PI** for either brand. Only company or job queries go to them, and for cn they are disabled in CN-1.
- **Acceptance:** startup-assertion tests (§3); a cn upload without `CN_S3_*` fails closed with "storage unavailable" and never writes to the intl bucket.

#### WP-TW-LOCALE: zh variant guard, glossary and TW profile deltas, W2, about 1,000 LOC
- **Owns:** `scripts/check-zh-variants.mjs`, `i18n/glossary/zh-variants.json` (from §9), `components/market/tw/*` (except job meta), `server/src/market/tw/profileFields.ts`.
- **Check script:**
  - Fails if `zh-TW.json` contains mainland vocabulary: 简历, 簡歷, 岗位, 崗位, 网申, 網申, 校招, 视频, 視頻, 软件, 軟件, 信息, 默认, 默認, 用户, 用戶, 登录, 登錄, 质量, 質量, 网络, 網絡, 账号, 賬號, 数据, 數據.
  - Fails if `zh.json` contains 履歷, 職缺 or 面議.
  - The integration wave adds it to `npm run check`.
- **TW profile deltas** (stored in `preferencesBlob`): 希望職稱/職類, 希望地點 (縣市 multi), 希望待遇 (月薪 or 年薪 NT$ range, or "面議 / 依公司規定"), 工作許可 status for foreign nationals (`citizen_or_resident | work_permit_needed | gold_card`).
- **TW resume config:** an optional photo, a 自傳 section, and a one-page English template flag. The resume WP renders sections from this config.

#### WP-JOBS-CN: recruitment-info mode, GoHire mapping, honesty fields, anti-fraud, deep links, W3, about 2,200 LOC
- **Owns:** `server/src/market/cn/jobs/{mode,gohireMapping,fraudClassifier,marketTags,deeplinks}.ts`, `components/market/cn/JobMetaCn.tsx`, `components/market/cn/SalaryCn.tsx`, `components/market/cn/ExternalSearchLinks.tsx`, and the admin fraud-review queue panel `components/admin/cn/FraudQueue.tsx`.
- **Mode gate:** `mode.ts` sets `jobs.feed`, `jobs.recommendations` and `jobs.alerts` capabilities from `CN_RECRUITMENT_INFO_MODE`. In `partner_deeplink`, every cn job card shows "来源：GoHire（{CN_HR_LICENCE_HOLDER} 人力资源服务许可证 {CN_HR_LICENCE_NUMBER}）", and apply opens gohire.top.
- **Card honesty:** every cn card and detail view shows the source, the updated date and the expiry date. Salary is shown only from structured or verbatim employer data ("15-25K·13薪"); otherwise it reads "薪资未披露". **No applicant counts, view counts or funding data.**
- **Market tags** (可落户 / 央国企 / 事业编 / 外企) appear only with `evidenceQuote` taken from the posting or an official source. The tooltip shows the quote.
- **Fraud classifier** (keywords + cheap LLM) for 招转培, 培训贷, deposits or "先交钱", MLM, gambling and telecom-fraud lures:
  - flagged jobs are excluded from ranking and recommendations;
  - user-imported jobs that match get a warning;
  - evidence goes to `RAJob.fraudFlags`, and an admin blacklist covers employers.
- **External search deep links:** user-initiated "在 BOSS 直聘 / 智联 / 猎聘 搜索「{query}」" links built from the user's own query. **No fetching, no autofill and no greeting on those sites.**
- **Acceptance:** with mode `off`, no cn route returns third-party postings (route tests); fraud fixtures are covered.

#### WP-ONB-CN: cn onboarding questionnaire, profile schema and resume sections, W3, about 2,000 LOC
- **Owns:** `server/src/market/cn/profileSchema.ts`, `components/market/cn/onboarding/*`, `components/market/cn/resume/*`. The onboarding WP's stage machine picks the cn variant by `brand`, which is the foundation slot.
- **Questionnaire** (codes stored in `preferencesBlob.cn`):
  - 身份 `fresh_grad|student|experienced`;
  - 毕业届别 (e.g. 2027) and month;
  - 学历 `dazhuan|bachelor|master|phd` plus 统招 flag;
  - 学校 (typeahead over the Ministry of Education's public list of higher-education institutions, with 985/211/双一流 marks from the official MOE lists; the data file carries `source` and `asOf`; free text allowed; **display and user filter only, never a ranking input**);
  - 专业;
  - 求职状态 `left_now|employed_month|employed_open|not_looking`;
  - 期望职位 (multi), 期望城市 (multi, grouped by province — 一线/新一线 tiers come from a commercial ranking with no official source), 期望行业;
  - 期望薪资 K/月 range and 薪数 (12–16);
  - 工作性质 `fulltime|intern|parttime`;
  - 实习 days/week and months;
  - 到岗时间;
  - 是否接受调剂;
  - optional tag preferences 户口/央国企/编制/外企.
- **Resume sections:** 基本信息, optional photo, optional 籍贯/政治面貌, 求职意向, 教育, 实习, 项目 (STAR), 校园经历, 技能证书 (CET-4/6), 获奖, 自我评价; A4, 1–2 pages, zh/en bilingual export.
- **PII rules** (enforced in `profileSchema.ts` and unit-tested): photo, 籍贯, 政治面貌, gender, birth date and family members are **never** sent to match scoring and **never** go into any LLM prompt; when the user generates a document that includes them, the export renderer places them after the model runs.

#### WP-TRK-CN: Chinese pipeline stages, 三方 and offer comparison, W3, about 1,500 LOC
- **Owns:** `server/src/market/cn/tracker/{stages,offerCompare}.ts`, `components/market/cn/tracker/*`, `components/market/cn/offers/*`, and the route file `server/src/roboapply/v2/routes/offersCn.ts`.
- **Stages:** canonical tracker codes added for both brands are `assessment`, `written_test`, `ai_interview`, `signed` (三方). cn displays 收藏 → 网申 → 测评 → 笔试 → AI面试 → 面试 (rounds) → Offer → 三方 / 未通过. intl displays the shorter ladder by default.
- **Offer comparison:** **user-entered** offers only (月薪, 薪数, 城市, 户口, 五险一金 base, 公积金 %, 签字费, 期权). The AI explains the trade-offs and invents no market data. Any benchmark must cite a source or be absent.

#### WP-CAL-CN: 校招日历 (campus calendar), W4, about 2,000 LOC, gated `jobs.campusCalendar`
- **Owns:** `server/src/market/cn/campus/*`, `server/src/roboapply/v2/routes/campusCalendar.ts`, `components/market/cn/campus/*`, `app/(app)/campus/page.tsx` (route shell from Foundation), and the admin editor `components/admin/cn/CampusEditor.tsx`.
- **Ops-curated:**
  - An admin pastes an **official** announcement URL (employer career site or university career centre).
  - A single-page fetch plus an LLM extractor proposes fields: company, 届别 window, 网申 open/close, 笔试/面试 waves.
  - A human verifies and publishes. `verifiedAt` and `verifiedBy` are required.
  - **No crawling, no aggregator sources, no automated publishing.**
- **Users:** filter by 届别 eligibility, subscribe, and get reminders (email, plus WeChat once WP-NOTIF-CN lands) 3 days and 1 day before 网申截止.
- **Display:** every entry shows "来源：{sourceName}" with a link and a "最后核实 {date}" date.

#### WP-RESIDENCY-DEPLOY (WP-DEPLOY-CN): mainland deployment kit, W3, about 1,200 LOC + YAML
- **Owns:** `deploy/cn/{Dockerfile.web,Dockerfile.api,nginx.conf,k8s/*.yaml,compose.yaml}`, `scripts/gen-cn-cronjobs.mjs` + `__tests__/deploy/cronParity.test.ts`, `.github/workflows/deploy-cn.yml`, `docs/runbooks/cn-deploy.md`.
- **Containers:**
  - `web` is the Next standalone server.
  - `api` runs `node server/dist/app.js` (listen mode) with `ROBOAPPLY_CRON_DISABLED=true`.
  - `worker` is the interview agent (agent name `GoApply-Interview`).
- **Routing:** nginx/ALB sends `/api/v1/*` and `/api/auth/*` → api and everything else → web, mirroring `vercel.json`. IPv6 is enabled. Health checks are in place.
- **Crons:** K8s CronJobs are generated from `vercel.json` (curl with `CRON_SECRET`). The parity test fails if they drift. This also brings the interview reconciler to the mainland, which node-cron lacks today.
- **CI:**
  - Build on GitHub-hosted runners, push to ACR Shanghai, then `kubectl set image` on ACK.
  - The job **skips with a notice** when `ALIYUN_ACR_REGISTRY` or `ACK_KUBECONFIG_B64` is missing.
  - The build arg `NPM_REGISTRY` (default npmjs; npmmirror optional) is for builds inside the mainland.
  - **Schema pushes against the CN DB are never automated** (owner confirms each `db push`).
- **Runbook:** CN-0 → CN-1 migration. Export rows where `brand='cn'` from Neon → import into RDS → verify → switch the goapply.top DNS to the Aliyun SLB → set intl `ALLOWED_BRANDS=intl` → purge cn rows from Neon after a 7-day verification window → record the deletion.

#### WP-VOICE-CN: voice provider seam and domestic STT/TTS/LLM, W3 (after Wave 0 merges), about 2,500 LOC
- **Owns:**
  - `server/src/interview-engine/providers/{types,livekitCloud,livekitSelfHosted,index}.ts`: `VoiceSessionProvider` = `createRoom`, `mintClientToken`, `dispatchAgent`, `deleteRoom`, `startRecording`, `verifyWebhook`. The `livekitCloud` provider wraps Wave 0's fixed code unchanged.
  - `server/src/interview-engine/config.ts` (brand creds through `brandEnv`).
  - `interview-agent/src/backends/llm.ts` (`LLM_BACKEND=gateway|openai_compatible` with `LLM_BASE_URL/LLM_API_KEY/LLM_MODEL`, using the LiveKit Agents OpenAI plugin with a custom base URL).
  - `interview-agent/src/plugins/dashscope/{stt,tts}.ts` (Paraformer realtime v2 streaming STT and CosyVoice streaming TTS over DashScope websockets).
  - `interview-agent/deploy/cn/*`, and the retention purge `server/src/market/cn/interviewRetention.ts`.
- **cn rules:**
  - The camera is a local preview only: no video track is published to egress, no expression analysis, no face data.
  - Recording is audio only and needs `interview_recording` consent; it goes to `CN_S3_*`. (The same consent rule now applies to RoboApply: recording off unless consented, video needs a second opt-in.)
  - Transcripts and recordings are purged after `INTERVIEW_RETENTION_DAYS` (default 90) on both brands.
  - The practice format is 20–30 minutes with communication, logic and behavioural dimensions, a STAR completeness check and filler-word counts. Content (zh question sets, rubric, report layout) is owned by its own work package (`TASK_PLAN.md` WP-66). User copy says "模拟企业常用的 AI 面试形式" and never names a vendor.
- **Stage behaviour:**
  - CN-0: `CN_VOICE_PROVIDER=livekit_cloud` with a **separate** LiveKit Cloud project in an Asia region, a worker on a host near Asia (for example the existing fly/k8s recipes), and `LLM_BACKEND=openai_compatible` → DeepSeek/Qwen. STT/TTS stay on the gateway, covered by cross-border consent.
  - CN-1: `livekit_selfhosted` plus the DashScope plugins.
  - `volcano` and `trtc` exist as reserved enum values with **no implementation**. They are not listed as capabilities.
- **Absent credentials:** `ai.interviewVoice=false`, and cn users get the existing text practice interview (`RAMockService`).
- **Before ending a session**, the client pre-check (mic + network RTT/jitter) suggests text mode when the network is poor. The check reuses Wave 0's mic test UI.

#### WP-TW-JOBS: Taiwan job sources and salary honesty, W3, about 2,000 LOC
- **Owns:** `server/src/roboapply/v2/lib/sources/atsPublic/{greenhouse,lever,ashby,smartrecruiters,index}.ts`, `server/src/roboapply/v2/lib/sources/twOpenData.ts`, `server/src/market/tw/salary.ts`, `components/market/tw/JobMetaTw.tsx`, and `components/admin/CareerSourcesPanel.tsx`.
- **Public ATS job-board connectors:** these use the endpoints each ATS publishes for embedding job boards:
  - `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`;
  - `api.lever.co/v0/postings/{company}?mode=json`;
  - `api.ashbyhq.com/posting-api/job-board/{org}`;
  - `api.smartrecruiters.com/v1/companies/{id}/postings`.
  An ops-curated `CareerSiteSource` list (with country tags; TW companies included) is synced by cron into `RAJob` with `sourceName` = company + ATS and `sourceUrl` = the posting. Workday is excluded (no published public API).
- **TW open data:**
  - Spike first: confirm that the Ministry of Labor's job-vacancy dataset (台灣就業通) is on data.gov.tw under the Open Government Data License, and check its fields and update cadence.
  - If confirmed, import with attribution "資料來源：台灣就業通（勞動部勞動力發展署）".
  - If not confirmed, `TW_OPEN_DATA_JOBS_ENABLED` stays false and the file ships only as a guarded stub.
- **RapidAPI:** `country=tw` when the user's market is `tw` or the target location is in Taiwan.
- **Salary:**
  - Parse "面議", "待遇面議", "依公司規定" → `payDisclosed=false` and keep the verbatim `salaryText`. Never estimate.
  - The salary filter excludes undisclosed jobs by default and offers an "包含面議職缺" toggle.
  - The tooltip states the legal rule (Employment Services Act Art. 5: regular monthly wage under NT$40,000 must be disclosed) with a link to the Ministry of Labor page. It never claims a specific job pays at least 40k.
- **Work authorization:** tags 可協助申請工作許可 / 就業金卡 appear only with an evidence quote from the posting.
- **Acceptance:** connector contract tests against recorded fixtures; no scraping code paths (lint rule in review: no HTML fetches of 104, 1111, Cake or Yourator domains).

#### WP-NOTIF-CN: WeChat 公众号 notifications, W4, about 1,200 LOC
- **Owns:** `server/src/lib/notify/{channel,wechatMp}.ts`, `server/src/roboapply/v2/routes/wechatMpEvents.ts` (server message endpoint with signature check), `components/market/cn/NotifyPrefs.tsx`.
- **Behaviour:** registers the `wechat_mp` channel through the notification WP's `registerDeliveryChannel()` (channels `email | wechat_mp | in_app`; SMS stays OTP-only). The server message endpoint reads the raw XML body (FND mounts a raw parser for `/api/v1/webhooks/*`). Templates: deadline reminder, interview report ready, payment success. Each template ID comes from env, and a template with no ID is never sent.
- **SMS is OTP-only.** Re-engagement never goes through SMS.

#### WP-EXT-CN: 一键填表 for mainland 网申 portals, W4 (after the core extension WP), about 2,500 LOC
- **Owns:** `extension/adapters/cn/{beisen,moka,feishu,dayee,generic}.ts`, `extension/brands/goapply/manifest.json`, `extension/brands/goapply/strings.zh.json`, and `docs/runbooks/edge-addons-publish.md`.
- **Fill modes:** fill all, fill blanks only, fill selection, plus field maps for 家庭成员 / 政治面貌 / 生源地. These fields are optional and only filled from values the user entered.
- **The submit button is never clicked by the extension.** After filling, it highlights the portal's own submit control and shows "请核对后自行提交".
- **Distribution:** Edge Add-ons + Chrome Web Store, with a separate GoApply build pointed at goapply.top.
- **Gate:** `ext.autofill`. Because the extension fills the user's own data into employer sites the user opened, it is allowed in all modes, including `off`.

#### Integration-wave checklist (CN/TW items)
1. Merge `marketCn` and `marketTw` staging. Run `i18n-locale-sync`, the glossary in §9, `npm run check`, and `scripts/check-zh-variants.mjs`.
2. Browser-verify **both** hosts: `http://localhost:3611` (intl, en + zh-TW) and `http://goapply.localhost:3611` (cn, zh). Check signup, login, `/auth/me`, capabilities with **all CN credentials absent** (no cn AI, payment, phone or WeChat entry points visible; the invite flow works), and the footer.
3. Run guard tests: a cn request with `CN_LLM_PROVIDER=openrouter` must fail, and a cn upload without `CN_S3_*` must fail closed.
4. Run `npm run build`, `npm run typecheck:server`, and the parity tests (brand registry, crons, pricing).

---

## 5. Part B: third-party accounts and credentials the owner must obtain

**Rule:** a feature whose credentials are absent is hidden (§2.3). Nothing is simulated, stubbed with sample data, or routed to the other brand's vendor.

### 5.1 Taiwan / intl

| Account | Needs | Env vars the code reads | When absent |
|---|---|---|---|
| Google Cloud OAuth client (web) | any entity; consent-screen verification | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Google button hidden |
| LINE Login channel (LINE Developers) | provider + channel; **apply for email permission** | `LINE_LOGIN_CHANNEL_ID`, `LINE_LOGIN_CHANNEL_SECRET` | LINE button hidden |
| Stripe (exists) | — | `STRIPE_*`, `STRIPE_ROBOAPPLY_*_PRICE_ID`, `ROBOAPPLY_STRIPE_WEBHOOK_SECRET` | paid plans hidden |
| Reference FX (no account) | an admin enters the Bank of Taiwan board rate monthly | AppConfig `fx.reference` (admin UI) | TWD line hidden |
| RapidAPI (exists) | — | `RAPID_API_KEY` | external sources skipped |
| TW open data | none (open licence, pending verification) | `TW_OPEN_DATA_JOBS_ENABLED`, `TW_OPEN_DATA_JOBS_URL` | source off |
| 104 / Cake / Yourator / 1111 | **business partnership** (no public APIs) | `TW_PARTNER_<NAME>_*` (defined when a contract exists) | not integrated |
| Taiwan e-invoice provider (e.g. ECPay/ezPay e-invoice) | only after VAT registration (NT$600k threshold) | `TW_EINVOICE_*` (P2, not built now) | n/a |

### 5.2 Mainland (most items require the **mainland legal entity** first)

| Account | Needs | Env vars | When absent |
|---|---|---|---|
| Domestic LLM vendors: DeepSeek, Aliyun Model Studio / DashScope (Qwen, Paraformer, CosyVoice), Moonshot Kimi, Zhipu GLM, Volcano Ark (Doubao) | enterprise real-name accounts (DeepSeek and DashScope can be used in CN-0) | `DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY`, `DASHSCOPE_BASE_URL`, `KIMI_API_KEY`, `GLM_API_KEY`, `GLM_API_BASE_URL`, `ARK_API_KEY`, `ARK_BASE_URL`; routing `CN_LLM_PROVIDER`, `CN_LLM_MODEL`, `CN_LLM_FALLBACK_MODEL`, `CN_LLM_{MATCHING,EXTRACT,ONBOARDING,REWRITE,INTERVIEW,VISION}_MODEL`, `CN_RA_MODEL_*`, `CN_LLM_OFFPEAK_BATCH` | all cn AI hidden (`ai_unavailable`) |
| Aliyun account (enterprise real-name): ACK, ECS, SLB, RDS PostgreSQL, OSS, CDN, ACR | entity | deploy: `DATABASE_URL`/`DIRECT_DATABASE_URL` (CN deploy), `CN_S3_ENDPOINT`, `CN_S3_REGION`, `CN_S3_BUCKET`, `CN_S3_ACCESS_KEY_ID`, `CN_S3_SECRET_ACCESS_KEY`, `CN_S3_FORCE_PATH_STYLE`, `CN_PUBLIC_ASSET_BASE_URL`; CI secrets `ALIYUN_ACR_REGISTRY`, `ALIYUN_ACR_USERNAME`, `ALIYUN_ACR_PASSWORD`, `ACK_KUBECONFIG_B64` | CN-1 not deployable; cn uploads fail closed |
| Aliyun SMS (signature + OTP template) or Tencent SMS | entity; signature = company name or **registered trademark**; 7–10 working days | `CN_SMS_PROVIDER` (`aliyun`\|`tencent`), `ALIYUN_SMS_ACCESS_KEY_ID`, `ALIYUN_SMS_ACCESS_KEY_SECRET`, `ALIYUN_SMS_SIGN_NAME`, `ALIYUN_SMS_TEMPLATE_OTP` / `TENCENT_SMS_SECRET_ID`, `TENCENT_SMS_SECRET_KEY`, `TENCENT_SMS_SDK_APP_ID`, `TENCENT_SMS_SIGN_NAME`, `TENCENT_SMS_TEMPLATE_OTP` | phone login hidden |
| WeChat Open Platform website app | developer verification (fee), **ICP-filed domain** | `WECHAT_OPEN_APP_ID`, `WECHAT_OPEN_APP_SECRET` | WeChat QR hidden |
| WeChat 服务号 (service account, verified) | entity verification; bind to the Open Platform for UnionID | `WECHAT_MP_APP_ID`, `WECHAT_MP_APP_SECRET`, `WECHAT_MP_TOKEN`, `WECHAT_MP_ENCODING_AES_KEY`, `WECHAT_MP_TEMPLATE_{DEADLINE,REPORT,PAYMENT}` | in-WeChat login and WeChat notices hidden |
| WeChat mini program (P2) | 小程序备案 + category qualification (recruitment category likely needs the HR licence) | `WECHAT_MINI_APP_ID`, `WECHAT_MINI_APP_SECRET` | mini login endpoint returns `feature_unavailable` |
| WeChat Pay merchant (APIv3) | entity, corporate bank account, filed site | `WECHATPAY_MCH_ID`, `WECHATPAY_APP_ID`, `WECHATPAY_API_V3_KEY`, `WECHATPAY_MCH_CERT_SERIAL`, `WECHATPAY_MCH_PRIVATE_KEY`, `WECHATPAY_PUBLIC_KEY_ID`, `WECHATPAY_PUBLIC_KEY`, `WECHATPAY_NOTIFY_URL` | WeChat Pay hidden |
| Alipay | today through the **GoHire worker** (GoHire's merchant); an own Alipay Open Platform app later if GoApply has its own entity | existing `ALIPAY_API_URL`, `ALIPAY_CALLBACK_SECRET`, `ROBOAPPLY_ALIPAY_PLATFORM`; future `ALIPAY_APP_ID`, `ALIPAY_APP_PRIVATE_KEY`, `ALIPAY_PUBLIC_KEY` | Alipay hidden (after the `alipayConfigured` fix) |
| Aliyun DirectMail (better delivery to QQ/163 than Resend) | entity, sender domain DNS | `CN_EMAIL_TRANSPORT`, `CN_EMAIL_FROM`, `ALIYUN_DM_ACCESS_KEY_ID`, `ALIYUN_DM_ACCESS_KEY_SECRET`, `ALIYUN_DM_ACCOUNT_NAME`, `ALIYUN_DM_REGION` | cn email features hidden (reset, digests); phone users are unaffected |
| Aliyun Content Security (内容安全) | entity | `CN_CONTENT_SAFETY_PROVIDER` (`aliyun_green`\|`keyword_only`), `ALIYUN_GREEN_ACCESS_KEY_ID`, `ALIYUN_GREEN_ACCESS_KEY_SECRET`, `CN_SAFETY_KEYWORDS_URL` (private list) | `keyword_only`; **CN-1 assertion requires `aliyun_green`** |
| LiveKit (CN-0): a second LiveKit Cloud project | any | `CN_LIVEKIT_URL`, `CN_LIVEKIT_API_KEY`, `CN_LIVEKIT_API_SECRET`, `CN_INTERVIEW_ENGINE_AGENT_NAME` (default `GoApply-Interview`), `CN_LIVEKIT_AGENT_CALLBACK_SECRET`, `CN_INTERVIEW_ENGINE_CALLBACK_BASE_URL`, `CN_VOICE_PROVIDER` | voice hidden; text practice remains |
| LiveKit self-hosted (CN-1) | Aliyun ECS + ICP-filed domain + TLS cert for the TURN domain | the same `CN_LIVEKIT_*`; worker env `LLM_BACKEND`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `STT_BACKEND=dashscope_paraformer`, `TTS_BACKEND=dashscope_cosyvoice`, `DASHSCOPE_API_KEY`, `COSYVOICE_VOICE_ZH_{FEMALE,MALE}` | same |
| Baidu Search Resource Platform | ICP site | `CN_BAIDU_SITE_VERIFICATION` | meta omitted |
| Microsoft Edge Add-ons partner account (+ Chrome Web Store) | any | n/a (publishing) | extension not distributed |
| GoHire (internal) | confirm the **HR-service licence** and the **EDI licence**; fix the bank DB TLS and private link; a worker WeChat channel? | `CN_HR_LICENCE_HOLDER`, `CN_HR_LICENCE_NUMBER`, `DATABASE_URL_GOHIRE` (with `sslmode=require`), `GOHIRE_PARSE_BRANDS` | `CN_RECRUITMENT_INFO_MODE` stays `off` |

### 5.3 Legal-display env (cn), set by ops after each filing
`CN_LEGAL_ENTITY_NAME`, `CN_ICP_NUMBER`, `CN_PSB_NUMBER`, `CN_PSB_RECORD_CODE`, `CN_EDI_LICENCE_NUMBER`, `CN_HR_LICENCE_NUMBER`, `CN_HR_LICENCE_HOLDER`, `CN_GENAI_DISCLOSURES` (JSON `[{model, vendor, filingNo}]`), `CN_GENAI_APP_REGISTRATION_NO`, `CN_ALGORITHM_FILING_NO`, `CN_COMPLAINT_EMAIL`, `CN_COMPLAINT_PHONE`, `CN_SUPPORT_EMAIL`, `CN_LEGAL_DOCS_VERSION`.
Mode and stage env: `DEPLOY_REGION`, `ALLOWED_BRANDS`, `BRAND_HOST_MAP`, `BRAND_FORCE`, `INTL_CANONICAL_ORIGIN`, `CN_CANONICAL_ORIGIN`, `CN_COOKIE_DOMAIN`, `CN_SIGNUP_MODE` (`invite`\|`open`), `CN_RECRUITMENT_INFO_MODE`, `CN_PAYMENTS_ENABLED`, `CN_AI_EXPORT_EXPLICIT_LABEL`, `CN_INTERVIEW_RETENTION_DAYS`, `CN_ALLOWED_DB_HOST_SUFFIXES`, `SMS_DEV_CONSOLE`.

A model name is shown in the AI disclosure as soon as it is configured. Filing numbers are shown **only** when set. Nothing reads "备案中" (filing in progress) unless ops sets an explicit `CN_GENAI_STATUS_NOTE`.

---

## 6. Part C: legal, filing and ops steps

### 6.1 Mainland: ordered checklist
All lead times are estimates to confirm with the provider or counsel.

| # | Step | Prerequisite | Lead time (est.) | Unlocks |
|---|---|---|---|---|
| C-1 | **Entity decision (D-03).** Either operate GoApply as a GoHire product line under GoHire's entity (preferred if GoHire holds or can get the HR and EDI licences), or form a new domestic company or WFOE. **Check the cap table:** Anthropic bars entities majority-owned by PRC-HQ companies, so a PRC-HQ majority holder anywhere above the intl operating company could cost RoboApply its Claude access. Keep the intl entity's ownership clear of that. | counsel | 2–12 weeks | everything below |
| C-2 | Domain: put goapply.top under the entity's real name at an **MIIT-approved registrar** with more than 45 days to expiry. Run the Aliyun "可否备案" check. IANA's 2026 sponsor change for .top makes fileability **unverified**, so register **goapply.cn** now as a fallback. Register the **GoApply / 职途通…** trademark (the Chinese name is an owner decision) in classes 9, 35, 42 and 45; the SMS signature can use the company name until it registers. | C-1 | days (trademark 9–12 months) | C-3, C-7 |
| C-3 | **ICP 备案** for the apex domain via the Aliyun console (needs a mainland server purchase). | C-1, C-2, Aliyun ECS | 1–4 weeks | CN-1 hosting, WeChat web login, WeChat Pay H5 |
| C-4 | **公安联网备案** (beian.mps.gov.cn) | site live on ICP | within 30 days of go-live | footer `CN_PSB_*` |
| C-5 | **PIPL package:** privacy policy, user agreement, PI collection list, third-party sharing list, **PIA (个人信息保护影响评估)**, data inventory and classification, retention schedule (interview 90 days, AI-label logs 6 months, OTP 24 h), 15-working-day rights handling. For **CN-0**: separate cross-border consent + PIA + a designated **PRC representative** (PIPL Art. 53). Staying under 100k individuals per year exempts **non-sensitive** PI only. Resumes can carry sensitive PI (ID numbers, health details, photos), so either (a) CN-0 stores none of it (redaction before storage, no photo, no original file — the code default) or (b) **file the PIPL standard contract** before transferring any. CN-0 is capped at 1,000. | counsel | 4–6 weeks | `CN_LEGAL_DOCS_VERSION`; CN-0 opening |
| C-6 | **Generative-AI 登记** with the provincial CAC (an app calling filed models). Prepare the model list with vendor filing numbers, a security self-assessment, the content-safety mechanism (Aliyun Green + keyword list), the complaint channel, a test question set, and the labelling implementation (WP-COMPLY). Then publish the model and filing numbers in the product. | C-1, C-3, content safety live | weeks to months | CN-1 public access (counsel decides whether the CN-0 closed beta needs it) |
| C-7 | **SMS** enterprise qualification + signature + OTP template (no links). | C-1 (+ trademark or company name) | 7–10 working days | `auth.phoneOtp` |
| C-8 | **WeChat:** Open Platform developer verification; service-account (服务号) verification; bind the service account to the Open Platform (UnionID); website app review + login permission; message templates. | C-1, C-3 | 1–3 weeks | `auth.wechat*`, `notify.wechat` |
| C-9 | **AI content labelling policy (D-08):** counsel rules on whether user-edited resumes need an explicit label in exports. Configure `CN_AI_EXPORT_EXPLICIT_LABEL` accordingly. | C-5 | 2 weeks | — |
| C-10 | **Algorithm filing (算法备案)** if counsel finds the personalised job feed in scope (comparable boards filed). File within 10 working days of launching recommendations. | CN-2 feed | weeks | `CN_ALGORITHM_FILING_NO`; `jobs.recommendations` |
| C-11 | **人力资源服务许可证 with 网络招聘 scope** (requires 职业中介活动 in the business scope, premises (Beijing example: 50 m²), staff, rules, ledgers, and a telecom licence for online services), **or** written counsel approval for `partner_deeplink` under GoHire's licence. | C-1, C-12 | 1–3 months | `CN_RECRUITMENT_INFO_MODE` |
| C-12 | **经营性ICP / EDI licence** before charging any user. Registered-capital and shareholder conditions apply. Foreign-equity relief exists only in the pilot zones (Beijing, Shanghai Lingang, Hainan, Shenzhen). | C-1 | about 60 days review + prep | `CN_PAYMENTS_ENABLED` |
| C-13 | **Merchants:** WeChat Pay (APIv3, public-key mode) and Alipay (or keep the GoHire worker if GoHire is the seller of record). The 用户协议, receipts and the payment subject name the **actual collecting entity**; charging stays off until that entity matches the merchant account (collecting for another seller risks 二清). No coaching payments on CN rails. Publish the fee schedule (network-recruitment rules: no deposits from seekers). | C-1, C-3 | 1–2 weeks | `pay.*` |
| C-14 | **Mini-program 备案** + category qualification (P2). iOS mini-program digital goods go through Apple's Mini Apps program (15%). | C-1, C-11 | 2–4 weeks | `auth.wechatMini` |
| C-15 | **GoHire bank hardening:** private link or VPC peering + TLS (`sslmode=require`); confirm employer verification meets the 2026 five-ministry notice (real-name, 6-month re-verification, base pay and expiry on every post, original source on reposts). | GoHire | 2–4 weeks | `partner_deeplink` |
| C-16 | **Carrier network test** of voice from Shanghai, Beijing and Guangzhou on Telecom, Unicom and Mobile: self-hosted LiveKit (TURN/TLS 443) vs Volcano RTC / TRTC. Decide CN-1 voice. | Aliyun ECS + ICP domain | 1 week | `CN_VOICE_PROVIDER` |
| C-17 | **Data migration CN-0 → CN-1:** notify users 14 days ahead, migrate, verify, purge Neon, log it (WP-DEPLOY-CN runbook). | CN-1 stack | 1 week | intl `ALLOWED_BRANDS=intl` |

### 6.2 Mainland hosting options and how the same codebase deploys

| Option | ICP | Latency / reliability from mainland | WeChat login / Pay H5 | Verdict |
|---|---|---|---|---|
| Vercel (CN-0) with a custom domain | not possible / not needed | slow and unreliable; no China PoPs (Vercel KB) | blocked (needs a filed domain) | **CN-0 closed beta only** |
| Hong Kong (Aliyun HK / Tencent HK) | not needed | moderate | blocked (filed domain required) | stop-gap only if ICP is delayed; same containers |
| **Aliyun cn-shanghai: ACK + RDS PostgreSQL + OSS + CDN (IPv6)** | required | good | yes | **Recommended for CN-1.** One vendor covers DashScope (Qwen, Paraformer, CosyVoice), SMS, DirectMail, Content Security and ACR. GoHire is already on a Shanghai network. |
| Tencent Cloud (TKE + TencentDB PG + COS + EdgeOne CN) | required | good | yes | equivalent alternative; swap the vendor adapters |
| Cloudflare China Network | required, plus Enterprise and JD Cloud vetting | good | yes | not worth it at our size |

**Same codebase, same pipeline:** one commit is built twice. Vercel (intl) uses its Git integration. `deploy-cn.yml` builds `web`, `api` and `worker` images. Brand behaviour comes only from env (`DEPLOY_REGION`, `ALLOWED_BRANDS`, `CN_*`). Schema changes are applied to each DB by an owner-confirmed `prisma db push`.

### 6.3 Resources that are blocked or slow in China (audit of this repo)
- **Already fine:** fonts are self-hosted (including Source Han Sans CN/TW). No analytics, error SaaS, CDN scripts, Google Fonts, reCAPTCHA or maps in the page.
- **Must be hidden or replaced on cn:**
  - Stripe and the Google OAuth button (hidden by capability);
  - `next.config.mjs` image host `r2.robohire.io` (Cloudflare R2; use `CN_PUBLIC_ASSET_BASE_URL` on OSS/CDN);
  - LiveKit Cloud and its STT/TTS gateway (CN-0 only);
  - Resend (replace with DirectMail);
  - OpenRouter, Anthropic, OpenAI and Gemini (blocked by guard);
  - RapidAPI, Tavily and Firecrawl (disabled for cn in CN-1; the campus extractor in CN-1 uses a plain server fetch of the single official URL).
- **Never add** Google Analytics, Sentry SaaS, Intercom or similar to shared layouts. If analytics is ever needed, it is first-party, or the cn deployment uses a domestic tool behind a capability.
- **Extension stores:** Chrome Web Store reachability from the mainland is unverified, so the Edge Add-ons store is the primary channel for GoApply.

### 6.4 Voice reachability and the domestic RTC seam
- LiveKit Cloud has no mainland or HK region (nearest are Japan and Singapore). WebRTC across the border is lossy. Expect a degraded CN-0 voice beta, and mitigate with TURN/TLS 443 plus the network pre-check.
- The `VoiceSessionProvider` seam (WP-VOICE-CN) keeps the session, transcript and report pipeline identical. Only room, token and agent dispatch change.
- **Preferred (CN-1):** self-hosted LiveKit with the same worker under `GoApply-Interview`, plus DashScope STT/TTS and a domestic LLM.
- **Fallback:** Volcano Engine RTC conversational AI (`StartVoiceChat`/`StopVoiceChat`) or the TRTC AI-interview solution. Each is a new provider implementation, added only if C-16 shows self-hosting fails.

### 6.5 Taiwan ops and legal steps
| # | Step | Unlocks |
|---|---|---|
| T-1 | PDPA review of the intl privacy notice (Art. 8 items: collector, purposes, data categories, period/region/recipients/method of use, rights, consequence of not providing). Add a breach-notification runbook (the 2025 amendment requires notifying data subjects and the regulator). | TW-0 |
| T-2 | Disclose processing regions (US: Neon, Vercel, LLM vendors). Decide GoHire parse for intl (L-10): default **off**. If the owner turns it on, disclose "resume parsing may be processed in mainland China" and collect `intl_cross_border_cn_parse`. | intl uploads |
| T-3 | LINE Login channel + email permission application. | `auth.line` |
| T-4 | Tax: monitor TW B2C revenue (WP-PAY admin panel). At NT$600k a year, register for TW business tax as a foreign e-service provider and issue cloud e-invoices (an e-invoice provider integration is a P2 code item). Stripe Tax can compute the 5% once registered. | compliance |
| T-5 | Partnerships: approach Cake, Yourator and 104 (HR-tech partner programme) for feeds. Verify the 台灣就業通 open-data licence (WP-TW-JOBS spike). | TW inventory |
| T-6 | AI Basic Act (promulgated 2026-01-14): our interview product is self-practice only, never employer screening. Keep it that way (104 declined employer AI interviews over discrimination risk). | — |
| T-7 | Copy review by a Taiwan-native reviewer of the zh-TW bundle after the integration wave (glossary §9). | TW-0 |

---

## 7. Job data: what is legal and feasible

| Source | Market | Status | How |
|---|---|---|---|
| GoHire job bank (first party) | cn | P0 (`partner_deeplink`/`licensed`) | cross-bank materialisation into `RAJob` with `brandScope='cn'`, source and licence line, expiry, `payDisclosed`; apply on gohire.top |
| User-imported jobs (paste a URL or text) | both | P0 in all modes | the user's own data; parse with the brand's LLM; fraud warning for cn |
| Ops-curated official campus announcements | cn | P1 (`jobs.campusCalendar`) | single official URL → extractor → human verification → publish with source |
| 国家24365 / university career centres | cn | partnership (after licence) | official feeds only, with attribution |
| 牛客 / 实习僧 / 脉脉 | cn | partnership | 内推 and internships; nothing without a contract |
| BOSS直聘 / 智联 / 猎聘 / 51job | cn | **never integrated** | search deep links from the user's own query only |
| RapidAPI JSearch / ActiveJobsDB / LinkedIn | intl incl. TW | live | `country=tw` for TW users |
| Public ATS job-board APIs (Greenhouse, Lever, Ashby, SmartRecruiters) | intl incl. TW | P1 | ops-curated company list; official endpoints |
| 台灣就業通 open data | TW | spike, then P1 | only if the open licence and fields are confirmed |
| 104 / 1111 / Cake / Yourator | TW | partnership only | no scraping, no paid scrapers (e.g. Apify actors) |

**Display rules for both brands (D3):**
- The source and its URL appear on every card.
- The expiry or last-updated date is shown.
- Salary appears only as disclosed. Otherwise show "薪资未披露" (cn), "待遇面議" (TW, keeping the employer's wording) or "Salary not listed".
- No applicant counts, funding figures or ratings without a primary source.
- Market tags carry an evidence quote.

---

## 8. Taiwan specifics (consolidated)
- **Brand and stack:** intl; market `tw`; Stripe USD; TWD reference line (L-7); LINE + Google + email login.
- **Copy:** zh-TW glossary (§9), enforced by `check-zh-variants.mjs`. Never use mainland terms. Campus hiring is 校園徵才. Online application is 線上應徵 (never 網申).
- **Resume:** optional photo (local firms expect one; foreign firms usually don't, so the template toggle defaults to off for English resumes), a 自傳 section, 期望待遇 "依公司規定 / 面議" options, and a one-page English template.
- **Jobs:** §7; salary honesty per Employment Services Act Art. 5 (§4.2 WP-TW-JOBS).
- **Work authorization:** 工作許可 / 就業金卡 tags only from posting text. The US-specific H1B filter generalises to country-specific sponsorship (owned by the filters WP; TW values defined in `server/src/market/tw/profileFields.ts`).
- **Data:** TW user data never enters a cn database or a mainland service unless the user consented (L-10).
- **Naming:** on intl, Taiwan is "Taiwan" / 台灣 in all pickers.

---

## 9. Terminology glossary (integration wave and translators)

| English | zh (GoApply, Simplified) | zh-TW (RoboApply, Traditional) |
|---|---|---|
| resume | 简历 | 履歷 |
| job / opening | 岗位 / 职位 | 職缺 |
| salary | 薪资 | 薪資 |
| compensation (on a posting) | 薪资待遇 | 待遇 |
| negotiable | 面议 | 面議 |
| year-end bonus | 年终奖 | 年終 |
| 13-month pay | 13薪 | 年終另計 / 13個月 |
| apply | 投递 / 申请 | 應徵 |
| online application form | 网申 | 線上應徵 |
| campus recruiting | 校招 | 校園徵才 |
| internship | 实习 | 實習 |
| cover letter | 求职信 | 求職信 |
| autobiography section | — | 自傳 |
| interview practice | AI 模拟面试 | AI 模擬面試 |
| written test | 笔试 | 筆試 |
| assessment | 测评 | 測驗 |
| referral | 内推 | 內部推薦 |
| offer | Offer / 录用通知 | 錄取通知 |
| tripartite agreement | 三方协议 | — |
| application tracker | 求职进度 | 應徵進度 |
| match | 匹配度 | 符合度 |
| autofill (extension) | 一键填表 | 一鍵填表 |
| profile | 个人资料 | 個人檔案 |
| account | 账号 | 帳號 |
| log in | 登录 | 登入 |
| settings | 设置 | 設定 |
| upload / file | 上传 / 文件 | 上傳 / 檔案 |
| default | 默认 | 預設 |
| user | 用户 | 使用者 |
| data / information | 数据 / 信息 | 資料 / 資訊 |
| video | 视频 | 影片 |
| software | 软件 | 軟體 |
| project | 项目 | 專案 |
| remote / hybrid | 远程 / 混合办公 | 遠端 / 混合辦公 |
| currency | 元 / ¥ | 新台幣 / NT$ |

### 9.1 Proposed amendment to `scripts/check-copy.mjs` (explicit; D1)
Add Chinese auto-apply vocabulary to `BANNED`, with the reason "the product never submits to an employer":
- zh: `自动投递`, `一键投递`, `一键网申`, `代投`, `海投`, `自动打招呼`, `替你投递`, `帮你投递`;
- zh-TW: `自動投遞`, `一鍵投遞`, `代投`, `海投`, `自動應徵`, `替你應徵`, `幫你應徵`.

Also add, with the reason "implies affiliation": zh `北森`, `牛客` (user copy says "模拟企业常用的 AI 面试形式").

The other locales get their own auto-apply bans (ja 自動応募, 代わりに応募 · ko 자동 지원, 대신 지원 · es postulación automática, postulamos por ti · fr candidature automatique, postule pour vous · pt candidatura automática, candidatamo-nos por si · de automatische Bewerbung, bewirbt sich für Sie), because English terms never match translated bundles; `BANNED` entries carry `{term, locales, regex}` (`TASK_PLAN.md` R-12).

None of these blocks a legitimate feature name: the autofill feature is 一键填表 / 一鍵填表, and a "don't mass-apply" tip can be phrased without 海投. The integration wave applies the amendment only after grepping all nine bundles for false positives.

---

## 10. Owner decisions and open risks

| ID | Decision / risk | Recommendation |
|---|---|---|
| D-03 | GoApply entity and licensing path | Run it as a GoHire product line if GoHire holds or gets the HR-service and EDI licences; otherwise form a new Shanghai entity. Ship CN-0 meanwhile. |
| D-08 | Explicit AI label on exported resumes | Default **on** until counsel rules |
| D-CN-1 | CN-0 closed beta before 登记 | Allowed only with counsel sign-off and as invite-only. Otherwise go straight to CN-1. |
| D-CN-2 | GoHire parse for intl (TW resumes to mainland) | Default **off** for intl (L-10) |
| D-CN-3 | Chinese brand name for GoApply (trademark, SMS signature, mini program) | Owner picks; file the trademark immediately |
| D-CN-4 | Alipay merchant of record for GoApply | GoHire worker only if GoHire is the seller of record and is named as the collecting entity; otherwise own Alipay app. Charging stays off until they match (C-13). |
| R-1 | .top fileability after the IANA sponsor change | Register goapply.cn now |
| R-2 | Model churn (Kimi K2 retired, DeepSeek repricing, Qwen 3.5 moved to legacy) | Pinned IDs plus a quarterly `verify:llm --brand cn` check |
| R-3 | Cap table vs Anthropic access for intl | Keep the intl entity free of PRC-HQ majority control |
| R-4 | Mainland WebRTC quality | C-16 carrier test before committing CN-1 voice |
| R-5 | Recruitment-category qualification for the mini program | Confirm in the WeChat backend before building the mini program |
