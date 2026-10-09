# Jobright Clone: Technical Architecture and Data Model

**Status:** binding engineering plan for branch `feat/jobright-clone`. **Author role:** Principal Engineer. **Date:** 2026-10-09, revised 2026-10-10 after three critic reviews. Where this document and `TASK_PLAN.md` §1–§2 disagree, `TASK_PLAN.md` wins (it records the reconciliation and the Revision log).
**Grounded in:** `main` @ 3b70322 (read-only inspection), `docs/jobright-clone/FEATURE_CATALOG.md` (feature IDs `F-*`, screens `S0`–`S12`, `CN-*`, `TW-*`), the eight research notes, the five codebase maps, `docs/roboapply/OVERHAUL_RULINGS.md`, `docs/design-system.md` ("Clarity"), and `AGENTS.md`.
**Audience:** the foundation, feature and integration agents. Every section is written to be executed, not discussed. When this document and older RoboApply specs disagree, this document wins, except where it defers to the owner decisions D1–D4 below.

---

## 0. Ground rules and key decisions

### 0.1 Binding owner decisions (restated so nobody has to look them up)

| ID | Decision | Architectural consequence |
|---|---|---|
| D1 | The product never submits an application. The Agent is **supervised**: it finds, prepares and pre-fills; the user clicks Submit. | No server-side "Easy Apply". No extension code path that clicks a submit control. A CI static check enforces it (§6.6). Copy never claims auto-apply; `scripts/check-copy.mjs` gains new bans (§10.1.4). |
| D2 | Overwrite where the clone conflicts; keep the good parts. | Kept: resume editor/tailor/export, tracker, mock interview, Stripe + Alipay billing, provider seam, cross-bank search, Clarity tokens, 9-locale i18n, copy/design gates. Replaced: the 8-card feed, the setup panel, the load-everything search, the fake score signals, the fake integrations, the V1 auto-apply engine. |
| D3 | Honesty. Never fabricate data. Every number has a source. | Every derived number carries `{value, source, sampleSize?, asOf}` on the wire (§2.14 provenance convention). Features without a real data source ship **gated** behind a brand flag (insider email finder, funding data, coaching marketplace until coaches exist). |
| D4 | Live interview fixes are a separate urgent track (Track A). | That track is **Wave 0**. Clone agents do not edit `server/src/interview-engine/**`, `interview-agent/**`, `app/(auth)/practice/[id]/**`, `components/v3/mock/**` or the interview reconciler until Wave 0 merges. The per-brand interview seam (§1.9) is applied **after** Wave 0. |

### 0.2 The twenty decisions this document makes

1. **Brand ids are `roboapply` and `goapply`.** They are product brands, not markets. They never reuse `APP_NAME`, `BRAND`, or the recruiter ids `robohire`/`gohire`, which select the recruiter bank and database (`server/src/lib/databaseUrl.ts:36-105`).
2. **One registry, one copy, one parity test.** The canonical registry is the zero-import module `server/src/platform/brand/registry.ts`. A generator copies it byte-for-byte to `lib/brand/registry.generated.ts`. A vitest parity test fails when they differ (§1.2).
3. **The brand is resolved per request from the Host.** The order is `x-forwarded-host`, then `host`. A dev/preview override is allowed **only** on dev and preview hosts. Express enters an AsyncLocalStorage context for every request, which also fixes the never-entered request context (§1.4).
4. **The brand locks the market and the payment rail.** GoApply means CNY with Alipay and WeChat Pay. RoboApply means USD with Stripe, **including Taiwan**. The `?region=` override is removed in production. Country only drives a "wrong site" nudge.
5. **One database, one deploy pipeline.** `User.brand` partitions identities. Phase 1 keeps `User.email @unique` global and refuses cross-brand login with `409 account_other_brand` — only after the password checks out (signup answers normally and emails a cross-brand notice, so account existence never leaks). Phone is unique per brand.
6. **Prisma moves to a multi-file schema** in `server/prisma/schema/` (§2.1). The foundation wave declares **every** model in this document, plus every back-relation, in **one** `db push` that the owner confirms. Later waves only add fields inside their own area files.
7. **New server code lives in `server/src/features/<area>/`**, mounted at `/api/v1/roboapply/<area>`. Shared plumbing lives in `server/src/platform/<concern>/`. Existing V2 routes stay where they are until their owning area retires them.
8. **Contracts are shared type-only.** Each area exports its wire types and zod schemas from `server/src/features/<area>/contract.ts`. The frontend re-exports the types with `export type * from '../../server/src/features/<area>/contract'`, the pattern `lib/api/job-search-types.ts` already uses.
9. **One canonical preference store:** `RASearchProfile.filters` (FilterSet v1). Onboarding, the filters drawer, Not Interested reasons and copilot diffs all write it, guarded by optimistic concurrency (`version`).
10. **Job inventory is ingested on a schedule** into `RAJob` from a demand-driven query plan. Ingestion runs on short Vercel cron ticks with DB leases. A deterministic normalizer comes first; an LLM-light enricher runs second, under a budget. Duplicates collapse to one canonical row.
11. **The feed query is SQL with indexes plus a ranked feed session.** This replaces the unbounded `findMany` at `RAJobIndexService.ts:208`. Pagination is a cursor into a stored, ranked id list.
12. **Scores have two kinds.** `pre` is a deterministic score computed on every candidate. `ai` is the LLM scorer v3, with real per-dimension sub-scores and evidence. Location, pay and visa are computed **deterministically**, never by the LLM and never as constants. Unknown inputs are labelled "not stated" and drop out of the weighting.
13. **The copilot is a tool-calling agent over our own services.** It streams over SSE from Express. Any mutation, and any credit spend, becomes a **proposal card** that the user confirms. Nothing changes silently.
14. **The extension is an in-repo MV3 package, `extension/`,** built per brand. It authenticates with a device token exchanged from the web session. It never uses the `cookies` permission and never clicks a submit control.
15. **Credits are typed buckets with windowed caps.** Consumption is atomic SQL, uses idempotency keys, and follows reserve, then commit or release. Billing stays success-only. Interview minutes keep the existing `mockCreditService`.
16. **Notifications use a per-brand email transport** (Resend now; an Aliyun DirectMail seam for GoApply). The in-app message center reuses `SeekerNotification`. Web push is RoboApply-only.
17. **SEO programmatic pages are rendered dynamically over a cached public API.** Express sends `s-maxage`; because the root layout is `force-dynamic`, Next caches SSR data with `unstable_cache` keyed by brand × slug plus tags (§9.2). Sitemaps are host-aware route handlers partitioned at 45k URLs. A page is indexable only above a real-inventory floor. True static ISR needs a root-layout split, which is a recorded follow-on (§9.7).
18. **i18n staging:** feature agents write `i18n/staging/<namespace>.en.json`. The runtime merges staging English over `en.json`, so English renders everywhere before translation. The integration wave merges and translates. Bundles carry the token `%BRAND%`, never a literal brand name.
19. **No new runtime dependency outside the foundation wave.** The foundation wave adds `zod@4`, `@vercel/functions` and `web-push` to the root `package.json` in one commit. The extension has its own `package.json` and lockfile, like `interview-agent/`.
20. **Dead V1 auto-apply code is removed in a dedicated cleanup area** after its dependents move (C27). The interview reconciler moves to its own cron **before** `/digest` and `/catchup` are deleted.

### 0.3 Area codes (used in every ownership table)

| Code | Area | Catalog IDs |
|---|---|---|
| FND | Foundation (scaffolding, hot files) | — |
| BRAND | Dual-brand presentation (tokens, metadata, assets, locale clamp) | F-MKT, CN-E-02/04, TW-01 |
| AUTH | Identity: Google, password reset, email verify, phone OTP, WeChat, LINE, account security | F-ACCT-01/02/06, F-ONB-11 |
| ONB | Onboarding stage machine and screens S0–S9 | F-ONB-* |
| PROF | Profile, education, work, skills, sensitive answers, completion wizard S10 | F-ACCT-03/04 |
| PREF | Search profiles (saved filters), filters drawer, taxonomy, passive-candidate magic link | F-FILT-*, F-FEED-03, F-ACCT-07 |
| INGEST | Providers, ingestion, normalization, enrichment, dedupe, expiry, companies, H-1B import | F-FEED-15, F-JOB-04, F-SAL-03 |
| FEED | Feed query, ranking, interactions, feed UI, Explore, visitor feed | F-FEED-* |
| MATCH | Scorer v3, breakdown, precompute, fit analysis, competitiveness report | F-MATCH-*, F-ORION-03 |
| JOB | Job detail page, company page, similar jobs, apply/did-you-apply, share, external import | F-JOB-*, F-TRK-04 |
| COP | Copilot (chat, tools, cards, memory, visitor copilot); LLM streaming + tools | F-ORION-* |
| RES | Resume grade, fix, ATS keyword report, tailor v2, claims verification, layout/templates, export | F-RES-* |
| CL | Cover letters | F-CL-* |
| NET | Contacts, LinkedIn connections import, outreach drafts | F-NET-* |
| TRK | Applications tracker, events, artifacts, reminders, weekly insight | F-TRK-* |
| AGENT | Supervised agent: setup wizard, queue, settings, answer bank | F-AGENT-* (supervised) |
| EXT | Chrome extension package and the `/ext` API | F-EXT-* |
| CRED | Credits, entitlements, plans, checkout rails, WeChat Pay, pricing page | F-BILL-* |
| NOTIF | Email platform, job alerts, message center, push, announcements, UI state | F-NOTIF-* |
| SEO | Public marketing, programmatic pages, sitemaps, robots, llms.txt, free tools | F-SEO-*, F-TOOL-*, F-MKT-* |
| GROW | Referral, attribution, missions, first-party events | F-GROW-* |
| PREP | Interview question bank, contributions, coaching marketplace | F-INT-01..04, F-COACH-* |
| CN | GoApply-specific: CN onboarding fields, consents, campus calendar, CN tracker stages | §6 of catalog |
| ADMIN | Admin console extensions (ingest, queue, moderation, coaches, overrides) | — |
| CLEAN | Dead-code and cron removal | — |
| INT | Integration wave (merge, translate, gates, build, browser verification, db push #2) | — |

---

## 1. Dual-brand infrastructure

### 1.1 What exists and what is wrong (grounding)

| Fact | Where | Consequence |
|---|---|---|
| `server/src/brands/*` and `server/src/lib/brand.ts` are recruiter brands, cached per process from `APP_NAME`. | `server/src/lib/brand.ts:16` | Unusable per request. Leave them alone (recruiter-bank scope). |
| `APP_NAME` selects the DB URL and the active recruiter bank. | `server/src/lib/databaseUrl.ts:36-105` | **Never** reuse it for the product brand. |
| Nothing reads `host` or `x-forwarded-host`. | grep | Everything below is new. |
| `withRequestContext` is never entered by `app.ts`. | `server/src/lib/requestContext.ts`, `server/src/app.ts:111-115` | `setCurrentUserId` is a no-op, BYOK never activates, logs lack the user. Fixed by the brand middleware (§1.4). |
| CORS origins are hard-coded to roboapply.io. | `server/src/app.ts:76-98` | Generate them from the registry. |
| `COOKIE_DOMAIN` is one global env var. | `server/src/lib/cookieOptions.ts:56` | Per-brand cookie domain. |
| Billing region falls back through country, profile market and locale. Any user can flip rails with `?region=`. | `server/src/lib/billingRegion.ts:44`, `routes/billing.ts:59` | Brand-locked rail. |
| "RoboApply" is hard-coded in 162 bundle strings, 16 frontend code lines and 69 server literals, including 10 LLM personas. | brand map §12 | `%BRAND%` token + `brandPersona()` helper. |
| Next dev proxy sets `x-forwarded-host`; Vercel preserves the host on rewrites. | brand map §11 | Express reads `x-forwarded-host` first. |
| The server tsconfig `rootDir` is `./src`, so the server cannot import repo-root `lib/`. | `server/tsconfig.json` | The registry is canonical in `server/src` and mirrored to `lib/`. |

### 1.2 Registry and mirror

**Canonical file:** `server/src/platform/brand/registry.ts`. It is pure data plus two pure functions. It has **zero imports** and reads **no env**, so it compiles identically for Node (server), Next (server and client) and the proxy. Env-dependent values (secrets, overrides) are resolved in `server/src/platform/brand/runtime.ts` (server) and `lib/brand/runtime.ts` (frontend), never in the registry.

```ts
// server/src/platform/brand/registry.ts  — CANONICAL. Edit here, then `npm run gen:brand`.
export type BrandId = 'roboapply' | 'goapply';
export type Market = 'intl' | 'cn';
export type RoboLocale = 'en' | 'zh' | 'zh-TW' | 'ja' | 'ko' | 'es' | 'fr' | 'pt' | 'de';
export type AuthMethod = 'email_password' | 'google' | 'line' | 'phone_otp' | 'wechat';
export type PaymentRail = 'stripe' | 'alipay' | 'wechatpay';
export type JobProvider = 'activejobs' | 'linkedin' | 'jsearch' | 'bank_robohire' | 'bank_gohire' | 'user_import';
export type LlmProfile = 'global' | 'domestic_cn';

export interface BrandFlags {
  copilot: boolean; agent: boolean; extension: boolean; coaching: boolean;
  interviewBank: boolean; interviewVoice: boolean; referrals: boolean; webPush: boolean;
  contactEmailLookup: boolean;      // gated on a licensed provider (D3)
  hiringContacts: 'off' | 'deeplinks_only' | 'on';   // 'on' only after the RoboHire/GoHire opt-in UI ships (OPS-A10)
  companyFunding: boolean;          // gated on a licensed provider (D3)
  h1bHistory: boolean;              // US DOL LCA public data; roboapply only
  campusCalendar: boolean;          // goapply
  eeoAnswers: boolean;              // false for goapply (catalog F-ACCT-04 clone note)
  invitations: boolean;             // RoboHire/GoHire recruiter → seeker invitations
}

export interface ProductBrand {
  id: BrandId;
  market: Market;
  name: string;                     // 'RoboApply' | 'GoApply'  (substitutes %BRAND%)
  legalEntity: string;              // placeholder until owner supplies; rendered in footer
  hosts: string[];                  // production hosts, lowercase, no port
  devHosts: string[];               // 'localhost', '127.0.0.1' | 'goapply.localhost'
  canonicalOrigin: string;          // 'https://www.roboapply.io' | 'https://www.goapply.top'
  cookieDomain: string;             // '.roboapply.io' | '.goapply.top'
  defaultLocale: RoboLocale;        // 'en' | 'zh'
  locales: RoboLocale[];            // roboapply: all 9 ; goapply: ['zh','en']
  seoLocales: RoboLocale[];
  defaultTimezone: string;          // 'UTC' | 'Asia/Shanghai'
  defaultCountry: string;           // 'US' | 'CN'   (ISO-3166 alpha-2)
  countries: string[];              // pickers: roboapply ['US','CA','GB','AU','IE','NZ','SG','HK','TW','JP','KR','DE','FR','ES','PT'] ; goapply ['CN']
  currency: 'USD' | 'CNY';
  paymentRails: PaymentRail[];      // ['stripe'] | ['alipay','wechatpay']
  authMethods: AuthMethod[];        // ['email_password','google','line'] | ['phone_otp','wechat','email_password']
  marketingOptInDefault: boolean;   // false for both (EU/TW/CN prudence; catalog §3.6)
  jobProviders: JobProvider[];      // §4.2
  llmProfile: LlmProfile;           // 'global' | 'domestic_cn'
  llmEnvPrefix: '' | 'CN_';
  interview: { agentName: string; envPrefix: '' | 'CN_' };   // 'RoboApply-Interview' | 'GoApply-Interview'
  email: { fromName: string; fromAddress: string; replyTo: string; transport: 'resend' | 'aliyun_dm' };
  assets: { mark: string; logo: string; og: string; favicon: string; appleTouch: string };
  theme: { themeColorLight: string; themeColorDark: string };
  seo: { titleSuffix: string; sameAs: string[]; searchEngines: ('google'|'bing'|'baidu')[] };
  legal: { termsPath: string; privacyPath: string; icpNumber?: string; psbNumber?: string; aiModelDisclosure?: boolean };
  otherBrand: BrandId;
  flags: BrandFlags;
}

export const BRANDS: Record<BrandId, ProductBrand> = { roboapply: {/* … */}, goapply: {/* … */} };
export const DEFAULT_BRAND: BrandId = 'roboapply';

/** Pure: strip port, lowercase, exact host match, then suffix match on hosts; returns null when unknown. */
export function brandIdFromHost(rawHost: string | null | undefined): BrandId | null;
export function getBrand(id: BrandId): ProductBrand;
export function isDevOrPreviewHost(host: string): boolean;   // localhost, *.localhost, 127.0.0.1, *.vercel.app
```

**Mirror.** `scripts/gen-brand-mirror.mjs` (FND) copies the canonical file to `lib/brand/registry.generated.ts`, adding a header line `// GENERATED from server/src/platform/brand/registry.ts — do not edit`. `package.json` gains `"gen:brand": "node scripts/gen-brand-mirror.mjs"`. `__tests__/lib/brandParity.test.ts` reads both files, strips the header and asserts equality. A second test asserts invariants: every brand's `locales` includes its `defaultLocale`; `seoLocales ⊆ locales`; hosts are lowercase and unique across brands; `goapply.flags.eeoAnswers === false`; `goapply.paymentRails` excludes `stripe`; `roboapply.currency === 'USD'`.

**Why not import across the boundary?** Type-only imports already cross (`lib/api/job-search-types.ts`). A runtime import into `proxy.ts` and client bundles from `server/src` is untested with Turbopack. The copy is 0 risk and the parity test removes the drift risk.

**Env overrides** (read only in the `runtime.ts` files): `BRAND_HOST_MAP` (comma list `host=brandId`, for staging domains), `BRAND_FORCE` (dev only; ignored when `NODE_ENV=production` and the host is not a preview host), `COOKIE_DOMAIN_ROBOAPPLY`, `COOKIE_DOMAIN_GOAPPLY`, `EMAIL_FROM_ROBOAPPLY`, `EMAIL_FROM_GOAPPLY`, `GOAPPLY_ICP_NUMBER`, `GOAPPLY_PSB_NUMBER`, `FLAG_<BRAND>_<FLAG>` (e.g. `FLAG_GOAPPLY_COACHING=true`).

### 1.3 Host resolution rules (identical on both tiers)

```
resolveBrand(request):
  host = first(x-forwarded-host) ?? host            # strip port, lowercase
  id   = BRAND_HOST_MAP[host] ?? brandIdFromHost(host)
  if isDevOrPreviewHost(host):
      override = query `__brand` (proxy only; it sets cookie ra_brand_override, 7d, host-only)
               ?? cookie ra_brand_override
               ?? header x-ra-brand      (Express: only when isDevOrPreviewHost OR X-RA-Internal matches INTERNAL_API_SECRET)
               ?? env BRAND_FORCE
      id = override ?? id
  return id ?? DEFAULT_BRAND ('roboapply')
```

- Local two-brand development: `http://localhost:3611` (RoboApply) and `http://goapply.localhost:3611` (GoApply). `*.localhost` resolves to loopback in Chrome and in the in-app Browser pane. Cookies stay separate per host.
- Production never trusts a client-sent brand header or cookie.
- A **wrong-market nudge** replaces geo-routing. On RoboApply with country header `CN`, a dismissible banner offers GoApply. On GoApply with `TW`/`HK`/non-CN, or with locale `zh-TW`, a banner offers RoboApply. Users are never redirected by IP (TW-01).

### 1.4 Express: brand middleware and request context (fixes the dead ALS)

New file `server/src/platform/brand/brandContext.ts`, mounted in `server/src/app.ts` **after** `cookieParser()` and the request-id middleware, and **before** `trackFeatureActivity` and all routers (FND edits `app.ts`).

```ts
// server/src/lib/requestContext.ts (FND, additive; existing exports keep working)
interface RequestStore { requestId: string; brandId?: BrandId; userId?: string; userName?: string; byokInRequest?: boolean }
export function withRequestContext<T>(requestIdOrStore: string | RequestStore, fn: () => T): T;  // string form kept for job-search/agent.ts:34
export function getCurrentBrandId(): BrandId | undefined;
export function runWithBrand<T>(brandId: BrandId, fn: () => T): T;   // crons, queue workers, webhooks

// server/src/platform/brand/brandContext.ts
export function brandContext(req, res, next) {
  const brand = getBrand(resolveBrandFromRequest(req));
  (req as BrandedRequest).brand = brand;
  res.setHeader('X-RA-Brand', brand.id);
  withRequestContext({ requestId: req.requestId, brandId: brand.id }, () => next());
}
export function getCurrentBrand(): ProductBrand;   // throws BrandContextMissingError when NODE_ENV!=='production'; logs + DEFAULT_BRAND in prod
```

Consequences, all applied by FND:
- `setCurrentUserId` in `server/src/middleware/auth.ts` now works, so BYOK and per-user log lines come alive. FND adds one test proving `getCurrentUserId()` is set inside a route handler.
- Every cron handler and queue worker wraps each user's unit of work in `runWithBrand(user.brand, …)`. A cron with no user (ingest) wraps each market in `runWithBrand(marketBrand)`.
- **Auth/brand gate.** `requireAuth` is extended (in `server/src/middleware/auth.ts`, FND) to reject a session whose `user.brand !== currentBrand` with `401 auth_other_brand`. This stops a GoApply cookie that was copied to RoboApply from working. Seeds and admins are exempt with `role === 'admin'`.

### 1.5 Next.js: proxy, layout, provider

**`proxy.ts`** (FND). It keeps its two responsibilities and gains a third: stamp the brand.
1. Delete any inbound `x-ra-brand` request header (anti-spoofing).
2. `brandId = resolveBrand(...)` (§1.3, using `lib/brand/runtime.ts`). If `?__brand=` is present on a dev/preview host, set `ra_brand_override` on the response.
3. **Locale clamp.** If the path's first segment is a locale outside `brand.locales`, return `NextResponse.redirect` to the same path under `brand.defaultLocale`. For GoApply, `/zh-TW/*` redirects to `/zh/*` and the page shows the RoboApply nudge. This is a locale redirect, not a destination router, so it does not violate the C29 "no second router" rule. The comment block in `proxy.ts` is updated to say so.
4. Set request headers `x-ra-brand` and `x-pathname`, then continue.
5. Auth gate: unchanged semantics; `PROTECTED_PREFIXES` gains the new authenticated prefixes (§11.3).

**Server helpers** (FND): `lib/server/brand.ts` exports `getServerBrand(): Promise<ProductBrand>` (reads `headers().get('x-ra-brand')`, falls back to host). `lib/serverLocale.ts` `resolveLocale()` clamps to `brand.locales` and defaults to `brand.defaultLocale`.

**`app/layout.tsx`** (FND):
- `<html lang={locale} data-brand={brand.id} data-theme=…>`.
- `generateMetadata()` replaces the static `metadata` export: `metadataBase` = `brand.canonicalOrigin`, title template `%s · ${brand.name}`, icons from `brand.assets`, theme colors from `brand.theme`, plus Baidu verification meta when `brand.seo.searchEngines` includes `baidu` (`BAIDU_SITE_VERIFICATION` env).
- `loadMessages(locale, brand.id)` (§1.7).
- `<Providers brand={publicBrand(brand)}>`. `publicBrand()` strips fields the client does not need.

**Client:** `lib/brand/BrandProvider.tsx` (`'use client'`) exports `BrandProvider` and `useBrand()`. `app/providers.tsx` wraps children in it (FND).

**API client:** `lib/api/client.ts` adds nothing in production (same-origin). In dev it echoes `ra_brand_override` as `X-RA-Brand`, which Express accepts on dev hosts only.

### 1.6 Per-brand surfaces (what each registry field drives)

| Field | Consumers (owner) |
|---|---|
| `name`, `assets`, `theme` | `app/layout.tsx` metadata (FND); `components/chrome/BrandSymbol.tsx` takes a `brand` prop; `components/v3/shell/BrandLogo.tsx`, `components/auth/AuthShell.tsx`, `components/landing/*` wordmarks (BRAND); `public/goapply-mark.svg`, `public/goapply-logo.png`, `public/og-goapply.png` (BRAND) |
| Theme tokens | `html[data-brand='goapply']` overrides **only identity and action tokens** in `styles/brands/goapply.css` (BRAND, imported once by `app/globals.css`, FND). Light and dark both. Tokens: `--action`, `--action-hover`, `--action-ink`, `--action-subtle`, `--brand-mark`, `--brand-plane`, `--grad-brand`, `--grad-brand-hover`, `--grad-soft`, `--grad-panel`. Proposed GoApply direction: a deep blue action (`#1F57C8` light / `#A9C3FF` dark) with a jade identity plane. BRAND may tune these, provided the 4.5:1 rules in `docs/design-system.md` hold; add a contrast unit test over both brands × both themes. |
| `defaultLocale`, `locales`, `seoLocales` | `proxy.ts` clamp, `lib/serverLocale.ts`, `app/[locale]/page.tsx` (`notFound()` outside `brand.locales`), both switchers. One list is used for both switchers: AuthShell's `READY_LOCALES` and the landing `LanguageMenu` both use `brand.locales` (the stale 4-locale list is deleted). Server: `raLocale.getRequestLocale` defaults to `brand.defaultLocale`. |
| `canonicalOrigin`, `seo` | `lib/seo.ts` (every function takes `brand`), `app/robots.ts`, sitemap handlers, `app/llms.txt/route.ts` (replaces the stale `public/llms.txt`), JSON-LD (SEO) |
| Cross-domain hreflang | RoboApply `/zh` declares `zh-Hans` and an alternate `zh-CN` pointing to `https://www.goapply.top/`. GoApply `/` declares `zh-CN` and points `en` and `zh-Hant` to RoboApply. Each domain's sitemap lists only its own URLs plus alternates (SEO). |
| `cookieDomain` | `server/src/lib/cookieOptions.ts` `buildCookieOptions(req)`. The domain is set only when the request host ends with the brand's cookie domain, so preview hosts get host-only cookies. `SESSION_COOKIE_NAME` stays `ra_session_token` on both brands (separate hosts already isolate them). `lib/config.ts` stays aligned. |
| CORS | `server/src/app.ts` builds `https://<host>` for every registry host, plus `FRONTEND_URLS`, plus `/^https:\/\/[a-z0-9-]+\.vercel\.app$/`. Dev adds `http://localhost:3611`, `http://goapply.localhost:3611`, `http://localhost:3000`. |
| `email` | `EmailService.send({brand,…})` (§8.1). Fix: digest/reminder fallbacks to robohire.io are deleted. |
| `paymentRails`, `currency` | `server/src/lib/billingRegion.ts` resolves from the brand only. `explicit` is honoured only when it names a rail in `brand.paymentRails`. `lib/pricing.ts` `resolveMarket()` reads the brand. `components/v3/account/billing.tsx` removes the CNY/USD switch link and shows the wrong-market nudge instead (CRED). Bug fix: `alipayConfigured` reads the real env (`RoboApplyBillingService.ts:195`). |
| `authMethods` | `GET /api/v1/roboapply/auth/methods`; login and signup render only those buttons (AUTH). |
| `jobProviders`, `defaultCountry`, `countries` | Ingest planner (§4.2), `server/src/job-search/validation.ts:40` and `agent.ts:23,83` default country (INGEST), country pickers (PREF) |
| `llmProfile`, `llmEnvPrefix` | §1.8 |
| `interview` | §1.9 (after Wave 0) |
| `legal` | Footer: ICP, PSB, HR licence placeholder and AI-model disclosure on GoApply (BRAND); `/legal/*` pages (SEO) |
| `flags` | Server `server/src/platform/flags.ts` `isEnabled(flag)` (brand flag, then `FLAG_*` env, then `RAEntitlementOverride` for per-user beta). `/auth/me` returns the resolved flags. `lib/flags.ts` `useFlag()` on the client. Nav entries, routes and API routers check the flag. A disabled router returns `404 feature_disabled`. |

### 1.7 i18n brand-name substitution

- next-intl 4.14.9 has no global default interpolation values. Bundles therefore carry the literal token **`%BRAND%`** wherever the product name appears (and `%OTHER_BRAND%` for nudges). ICU treats `%` as a literal, so messages stay valid ICU.
- `lib/i18n.ts` `loadMessages(locale, brandId)` deep-replaces the tokens with `brand.name` / `getBrand(brand.otherBrand).name`. The result is memoized per `brandId × locale` (18 entries).
- **Market overrides:** `i18n/brands/goapply/zh.json` and `i18n/brands/goapply/en.json` are deep-merged **after** the locale bundle, through the same `mergeOverEn`. They carry LinkedIn → 简历导入 copy, money copy, FAQ and footer lines (CN area owns them). RoboApply has no override bundle.
- FND converts the 18 existing keys × 9 bundles (162 strings) and `components/job-search/messages.en.json` (3 strings) from `RoboApply` to `%BRAND%` in one mechanical commit. `check-copy` then forbids literal `RoboApply`/`GoApply` in any bundle (§10.1.4).
- **Server strings:** emails and LLM personas use `brand.name` directly. The helper `server/src/platform/brand/persona.ts` `brandPersona(brand, role)` returns e.g. `"You are the resume assistant inside RoboApply"`. FND replaces the 10 hard-coded persona lines (brand map §8) with this helper. `OpenRouterProvider.ts:29-30` headers become `HTTP-Referer: brand.canonicalOrigin` and `X-Title: brand.name`.

### 1.8 LLM routing profile per brand

- `server/src/lib/llm/llmTaskSettings.ts`: `LlmTask` becomes `'matching' | 'extract' | 'onboarding' | 'rewrite' | 'interview' | 'copilot' | 'enrich' | 'writing'`. The three new tasks map to `LLM_COPILOT_MODEL`, `LLM_ENRICH_MODEL` and `LLM_WRITING_MODEL` in `llmStackConfigSchema.ts` `MODEL_ENV`.
- `getModelSetting(key)` / `getProviderSetting()` (`server/src/lib/llm/llmModels.ts`) read `${brand.llmEnvPrefix}${MODEL_ENV[key]}` first, then the unprefixed key. The DB stack override is looked up under `llm.stack.<brandId>` first, then the existing global key. All brand reads use `getCurrentBrandId()`.
- **GoApply policy guard** (`server/src/platform/llm/brandPolicy.ts`, wired into `LLMService.resolveDefaults` by FND). When `brand.llmProfile === 'domestic_cn'`, the resolved provider must be one of `deepseek`, `kimi`, `minimax` or `newapi` (an OpenAI-compatible gateway for Qwen, GLM and Doubao). Anything else throws `LlmBrandPolicyError`. `CN_LLM_ALLOW_OFFSHORE=true` is honoured only outside production. There is no GLM adapter; GLM runs through `newapi`.
- **RoboApply egress policy** (`server/src/platform/llm/egressPolicy.ts`, WP-14): a RoboApply prompt that carries user data never resolves to a mainland-China endpoint, as primary or as a fallback (Wave 0's chain includes `deepseek-v4-flash`): `api.deepseek.com`, `api.moonshot.cn`, MiniMax China, DashScope, `open.bigmodel.cn`, `volces.com`, or `newapi` pointed at any of them. Matching is by endpoint host, not provider name. The RoboApply privacy notice lists the model vendors and their countries.
- **GoApply content safety** (`server/src/platform/llm/contentSafety/`, WP-24): input and output checks on every GoApply call (`keyword_only` | `aliyun_green`), fail-closed, logged to `RAContentSafetyEvent`.
- **Note (2026-10-10):** `TASK_PLAN.md` R-13 tightens the GoApply allowlist above: `deepseek`, `qwen`/DashScope, `kimi`, `glm`, `doubao`/Ark, `minimax` with new adapters for qwen, glm and doubao; `newapi` only when its base host is on the domestic allowlist; no fallback to unprefixed env.
- The cost table (`check:llm-costs`) must list every model configured under `CN_*` (INT verifies).

### 1.9 Interview voice infrastructure per brand (post–Wave 0)

- `brand.flags.interviewVoice`: `true` for RoboApply. For GoApply it is `false` until a mainland media plane exists (CN-E-06). When it is false, `/practice` offers the text mock only, and the setup page says why.
- After Wave 0 merges, a small follow-up (owned by the Track A team, not a clone area) applies the seam:
  - `getLiveKitCreds(brand)` reads `${brand.interview.envPrefix}LIVEKIT_*`.
  - `getInterviewAgentName(brand)` uses `brand.interview.agentName`.
  - The voice catalog is profiled per brand.
  - The client already receives the LiveKit URL per session (`liveKitClient.ts:164`), so the frontend needs no change.

### 1.10 Identity partition (phase 1)

- `User.brand String @default("roboapply")` is set at signup from the current brand and is immutable.
- `User.market` keeps its vocabulary for analytics. Signup sets it from the brand: GoApply → `cn`. RoboApply → `tw`/`jp`/`other` from the locale, not Accept-Language (`SeekerAuthService.signup` changes, AUTH).
- `email @unique` stays global. Login on the wrong brand returns `409 account_other_brand` with `{ otherBrandUrl }` **only when the password is correct** (otherwise the usual invalid-credentials error), and the UI explains it. Signup with an other-brand email returns the normal "check your email" response and sends the notice to that inbox. Phone identities use `@@unique([brand, phoneE164])`, so the same phone may exist on both brands.
- Phase 2 (not this branch): `@@unique([brand, email])`. Only two seeker call sites query by email (`SeekerAuthService.ts:131, :220`), so the change stays small.

### 1.11 Hosting note (ops track, not code)

Both brands deploy from one Vercel project (add the `goapply.top` domains). `next.config.mjs` already sets `output: 'standalone'`, so a mainland deployment can run the same build with `BRAND_LOCK=goapply` (proxy and Express then refuse other brands) and its own `DATABASE_URL`, once ICP and licensing (CN-L-*) are in place. Nothing in this design assumes Vercel-only APIs, except `@vercel/functions` `waitUntil`, which degrades to a no-op elsewhere (§4.6).

---

## 2. Data model

### 2.1 Multi-file schema layout

Prisma 7.10's `defineConfig({ schema })` accepts a folder and recursively loads `*.prisma` files (verified in `node_modules/@prisma/config/dist/index.d.ts`). FND performs the move in one commit with **no DDL change**: models are moved, not edited. Then it adds the new models and fields (the DDL diff), runs `prisma validate` and `npm run db:generate`, and asks the owner to confirm **db push #1**.

```
server/prisma/
  schema/
    _datasource.prisma    generator + datasource            (FND, then frozen)
    legacy.prisma         the current 6,024-line file minus generator/datasource/RA* models,
                          plus additive fields on shared models and ALL back-relations   (FND → INT only)
    ra-platform.prisma    RAWorkItem, RARateCounter, RAAuthToken, RAAuthIdentity, RAProductEvent, RASurveyResponse (FND/AUTH/GROW fields)
    ra-jobs.prisma        RAJob (moved+extended), RACompany, RAIngestQuery, RAProviderUsage, RAH1bEmployerStat  (INGEST)
    ra-match.prisma       RAJobMatchScore (moved+extended), RAKeywordExtraction (moved), RAFitReport          (MATCH)
    ra-feed.prisma        RAJobUserState, RAJobInteraction, RAFeedSession, RAFeedRating, RAUserAffinity      (FEED)
    ra-profile.prisma     RAProfile, RAProfileEducation, RAProfileExperience, RASensitiveAnswers            (PROF)
    ra-search.prisma      RASearchProfile, RACareerGoal (moved), RASavedSearch (moved, deprecated)           (PREF)
    ra-onboarding.prisma  RAOnboardingSession (moved)                                                       (ONB)
    ra-resume.prisma      RAResumeVariant (moved+extended), RAResumeGrade, RATailorSession                  (RES)
    ra-coverletter.prisma RACoverLetter                                                                    (CL)
    ra-tracker.prisma     RATrackerEntry (moved+extended), RATrackerEvent, RAApplicationArtifact, RACareerInsight (moved)  (TRK)
    ra-network.prisma     RAContact, RAContactImport, RAOutreachDraft                                        (NET)
    ra-copilot.prisma     RACopilotThread, RACopilotMessage, RACopilotProposal, RACopilotMemory             (COP)
    ra-agent.prisma       RAAgentSettings, RAAgentQueueItem, RAAnswerBankItem                               (AGENT)
    ra-extension.prisma   RAExtensionDevice, RAAutofillRun, RASiteRequest                                   (EXT)
    ra-credits.prisma     RACreditWindow, RACreditLedger, RACreditGrant, RAEntitlementOverride               (CRED)
    ra-notify.prisma      RAAlertDelivery, RAPushSubscription, RAAnnouncement, RAUserUiState, RAEmailLog    (NOTIF)
    ra-growth.prisma      RAReferralCode, RAReferral, RAAttribution                                         (GROW)
    ra-prep.prisma        RAInterviewQuestion, RAQuestionContribution, RAQuestionReport, RACoach, RACoachSlot, RACoachBooking  (PREP)
    ra-seo.prisma         RASeoPage                                                                         (SEO)
    ra-cn.prisma          RAPhoneOtp, RACampusEvent                                                         (CN/AUTH)
    ra-mock.prisma        RAMockSession, RAIntegration (moved; RAIntegration deprecated)                    (Wave 0 / CLEAN)
  sql/
    000_extensions.sql    CREATE EXTENSION IF NOT EXISTS pg_trgm;   (owner runs once, before db push #1)
```

**Generator path.** The generator lives in `schema/_datasource.prisma`, so `output` becomes `"../../src/generated/prisma"`. Everything else in the generator block stays: `moduleFormat = "esm"`, `importFileExtension = "js"`.

**`prisma.config.ts` change (FND):**

```ts
export default defineConfig({
  schema: path.join('server', 'prisma', 'schema'),   // was: 'server/prisma/schema.prisma'
  datasource: { url: migrationUrl },
});
```

**Rules for every agent after FND:**
1. **Feature agents never edit `.prisma` files.** FND has already declared every planned model, relation and back-relation. If you need one more field, index or relation, record it under "Schema requests" in your handoff. At the next wave gate the orchestrator's **SCHEMA-n** step applies the wave's requests, runs `prisma validate`, `db:generate` and the additive/drift diffs, and the owner confirms an additive push to the clone Neon branch before the next wave starts (`TASK_PLAN.md` §4.0).
2. New code uses the **typed** Prisma client (`import prisma from '../../lib/prisma.js'`). The V2 habit `const p = prisma as any` is banned in new files; the review gate greps for it. Until a SCHEMA-n step lands a requested field, code against it behind a narrow typed adapter and mark the dependent test `it.todo` with the request id.
3. Nobody but the orchestrator/owner runs `db push`. FND's push #1 creates everything; SCHEMA-2…5 and INT's push #2 apply additions. **The owner confirms each push.** Only additive changes: new tables, new nullable columns or defaulted columns, new indexes. Every push is preceded by `npx prisma migrate diff --from-schema <main>/server/prisma/schema.prisma --to-schema server/prisma/schema --script` (additive test) and `npx prisma migrate diff --from-config-datasource --to-schema server/prisma/schema --script` (drift check against the real DB); any `DROP`/`ALTER` of an existing object stops the push. (Prisma 7.10 has no `--*-schema-datamodel` flags.)
4. Every array or JSON column has a documented TypeScript shape in the area's `contract.ts`, plus a zod schema used when reading it back.

**Trigram index.** `RAJob.searchText` gets `@@index([searchText(ops: raw("gin_trgm_ops"))], type: Gin)`. Prisma would drop an index that the schema does not declare, so the index **must** be declared in the schema. The extension it needs comes from `sql/000_extensions.sql`, which the owner runs once before push #1. FND verifies that `prisma validate` accepts the `raw` ops form. If it does not, FND stops and escalates to the owner. The index cannot live outside the schema, because `db push` would drop it.

### 2.2 Changes to shared models (in `legacy.prisma`, FND)

```prisma
model User {
  // … existing fields unchanged …
  brand            String    @default("roboapply")   // 'roboapply' | 'goapply'; immutable
  phoneE164        String?                            // normalized via libphonenumber-js
  phoneVerifiedAt  DateTime?
  lastActiveAt     DateTime?                          // touched at most hourly by requireAuth; drives precompute and alerts
  // back-relations (FND declares all of them; one line each):
  raProfile RAProfile?  raSensitive RASensitiveAnswers?  raEducation RAProfileEducation[]  raExperience RAProfileExperience[]
  raSearchProfiles RASearchProfile[]  raJobStates RAJobUserState[]  raInteractions RAJobInteraction[]  raFeedSessions RAFeedSession[]
  raFeedRatings RAFeedRating[]  raAffinity RAUserAffinity?  raFitReports RAFitReport[]  raResumeGrades RAResumeGrade[]
  raTailorSessions RATailorSession[]  raCoverLetters RACoverLetter[]  raTrackerEvents RATrackerEvent[]  raArtifacts RAApplicationArtifact[]
  raContactsOwned RAContact[]  raContactImports RAContactImport[]  raOutreachDrafts RAOutreachDraft[]
  raCopilotThreads RACopilotThread[]  raCopilotProposals RACopilotProposal[]  raCopilotMemory RACopilotMemory[]
  raAgentSettings RAAgentSettings?  raAgentQueue RAAgentQueueItem[]  raAnswerBank RAAnswerBankItem[]
  raExtDevices RAExtensionDevice[]  raAutofillRuns RAAutofillRun[]  raSiteRequests RASiteRequest[]
  raCreditWindows RACreditWindow[]  raCreditLedger RACreditLedger[]  raCreditGrants RACreditGrant[]  raEntitlementOverrides RAEntitlementOverride[]
  raAlertDeliveries RAAlertDelivery[]  raPushSubs RAPushSubscription[]  raUiState RAUserUiState?
  raReferralCode RAReferralCode?  raReferralsSent RAReferral[] @relation("RAReferralInviter")  raReferralReceived RAReferral? @relation("RAReferralInvitee")
  raAttribution RAAttribution?  raAuthIdentities RAAuthIdentity[]  raAuthTokens RAAuthToken[]
  raQuestionContribs RAQuestionContribution[]  raQuestionReports RAQuestionReport[]  raCoach RACoach?  raCoachBookings RACoachBooking[]
  raProductEvents RAProductEvent[]  raJobsOwned RAJob[] @relation("RAJobOwner")

  @@unique([brand, phoneE164])
  @@index([brand, createdAt])
  @@index([lastActiveAt])
}

model SeekerProfile {
  // … existing fields unchanged …
  onboardingStep        String    @default("signup")  // §3 table: signup|mode|basics|goal|advanced|resume|matching|confirm|welcome|done
  onboardingPath        String?                        // 'rush' | 'open'
  onboardingVersion     String?                        // 'v6-jobright'
  onboardingStartedAt   DateTime?
  onboardingCompletedAt DateTime?
  onboardingEntry       Json?                          // { from, jobId?, action?, inviteCode?, retarget? } (F-ONB-02)
  timezone              String?                        // IANA; captured at signup (the body already sends it)
  acquisitionSource     String?                        // S7 survey answer key
  acquisitionNote       String?
}

model SeekerSubscription {
  // … existing fields unchanged …
  brand     String?   // set on every write from now on
  planKey   String?   // 'pro_week' | 'pro_month' | 'pro_quarter' | legacy 'starter' | 'growth'
  interval  String?   // 'week' | 'month' | 'quarter'
  rail      String?   // 'stripe' | 'alipay' | 'wechatpay'
}

model AlipayOrder {   // name kept for callback compatibility; it now records any CN-rail order
  // … existing fields unchanged …
  channel     String  @default("alipay")   // 'alipay' | 'wechatpay'
  brand       String?
  planKey     String?
  purpose     String  @default("subscription")   // 'subscription' | 'interview_pack' — never 'coaching' on CN rails (no 二清)
  amountMinor Int?                               // fen; `amount` (Float yuan) stays for legacy readers
  relatedId   String?                            // reserved
  @@index([channel, status])
}

model SeekerNotification {   // REUSED as the in-app message center (§8.3)
  // … existing fields unchanged …
  userId      String?    // denormalized for the per-user unread query
  brand       String?
  category    String?    // 'job_alert' | 'application' | 'billing' | 'system' | 'invitation' | 'announcement' | 'referral'
  templateKey String?    // i18n key under `messages.templates.*`; title/body are fallbacks
  params      Json?      // ICU params for templateKey
  pushSentAt  DateTime?
  @@index([userId, readAt, createdAt])
}

// SeekerConsentRecord is REUSED unchanged; new consentType values are listed in §2.13.
```

### 2.3 Platform (`ra-platform.prisma`)

```prisma
/// Durable work queue drained by cron ticks and waitUntil (§4.6). One row per unit of work.
model RAWorkItem {
  id          String    @id @default(cuid())
  kind        String    // 'job.enrich' | 'job.score' | 'alert.send' | 'email.send' | 'seo.rebuild' | 'ingest.query' | 'resume.grade' | …
  dedupeKey   String?   @unique              // e.g. 'job.enrich:<jobId>:v3'
  brand       String?
  userId      String?
  payload     Json
  priority    Int       @default(100)        // lower runs first
  runAfter    DateTime  @default(now())
  status      String    @default("queued")   // queued | leased | done | failed | dead
  attempts    Int       @default(0)
  maxAttempts Int       @default(5)
  leasedUntil DateTime?
  leaseOwner  String?
  lastError   String?   @db.Text
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  @@index([kind, status, runAfter, priority])
  @@index([status, leasedUntil])
}

/// Fixed-window counters for rate limits and budgets (replaces the in-memory limiter).
model RARateCounter {
  key         String     // 'rl:signup:ip:<hash>' | 'budget:llm:enrich:roboapply' | 'rl:copilot:user:<id>'
  windowStart DateTime
  count       Int        @default(0)
  expiresAt   DateTime
  @@id([key, windowStart])
  @@index([expiresAt])
}

/// Single-use tokens: password reset, email verification, magic links, OAuth state, extension hand-off.
model RAAuthToken {
  id         String    @id @default(cuid())
  userId     String?
  user       User?     @relation(fields: [userId], references: [id], onDelete: Cascade)
  brand      String
  kind       String    // 'password_reset' | 'email_verify' | 'magic_prefs' | 'oauth_state' | 'ext_pair' | 'email_unsub'
  tokenHash  String    @unique              // sha256; raw token never stored
  payload    Json?
  expiresAt  DateTime
  consumedAt DateTime?
  createdAt  DateTime  @default(now())
  @@index([userId, kind])
  @@index([expiresAt])
}

/// External identities linked to a user (Google, WeChat, LINE).
model RAAuthIdentity {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  brand     String
  provider  String   // 'google' | 'wechat' | 'line'
  appId     String   @default("")            // WeChat appid (web vs 公众号 differ); "" otherwise
  subject   String                           // Google sub | WeChat openid | LINE userId
  unionId   String?                          // WeChat unionid
  email     String?
  profile   Json?                            // name/avatar as returned; no tokens stored
  createdAt DateTime @default(now())
  @@unique([brand, provider, appId, subject])
  @@index([unionId])
  @@index([userId])
}

/// First-party product analytics (no third-party pixels; CN-E-02).
model RAProductEvent {
  id        String   @id @default(cuid())
  brand     String
  userId    String?
  user      User?    @relation(fields: [userId], references: [id], onDelete: Cascade)   // deleted with the account; rows for linked anonIds are deleted by the wipe; kept ≤13 months
  anonId    String?  // set only after analytics consent for EEA/UK/CH visitors
  name      String   // 'onboarding_step_completed' | 'feed_card_impression' | …  (registry: server/src/features/growth/events.ts)
  props     Json?
  path      String?
  createdAt DateTime @default(now())
  @@index([name, createdAt])
  @@index([userId, createdAt])
  @@index([brand, createdAt])
}

/// Generic survey answers: extension uninstall, alert unsubscribe, NPS.
model RASurveyResponse {
  id        String   @id @default(cuid())
  brand     String
  kind      String   // 'ext_uninstall' | 'alert_unsubscribe' | 'nps'
  userId    String?
  anonId    String?
  answers   Json     // { reasons: string[], note?: string }
  createdAt DateTime @default(now())
  @@index([kind, createdAt])
}
```

### 2.4 Jobs, companies, ingestion (`ra-jobs.prisma`, INGEST)

`RAJob` keeps every existing column, so existing readers keep working. The new fields:

```prisma
model RAJob {
  // back-relations added by FND: userStates RAJobUserState[] (existing: trackerEntries, resumeVariants, keywordExtraction, matchScores)
  // ── existing columns kept verbatim (externalId, sourceBoard, applyUrl, title, titleNormalized, companyName,
  //    companyNameNormalized, companyLogoUrl, location, locationCity, locationCountry, workType, employmentType,
  //    salaryMin, salaryMax, salaryCurrency, salaryPeriod, description, descriptionPlain, qualifications,
  //    responsibilities, benefits, postedAt, seedTags, archivedAt, createdAt, updatedAt) ──
  market             String    @default("intl")      // 'intl' | 'cn' — which brand's feed may show it
  visibility         String    @default("public")    // 'public' | 'private' (user import, owner-only)
  ownerUserId        String?
  owner              User?     @relation("RAJobOwner", fields: [ownerUserId], references: [id], onDelete: Cascade)
  companyId          String?
  company            RACompany? @relation(fields: [companyId], references: [id], onDelete: SetNull)

  // taxonomy and level
  taxonomyIds        String[]  @default([])          // L1/L2/L3 ids, e.g. ['01','01-08','01-08-01']
  primaryTaxonomyId  String?
  seniority          String?                         // 'intern_newgrad'|'entry'|'mid'|'senior'|'lead_staff'|'director_exec'
  roleType           String?                         // 'ic' | 'manager'
  minYears           Int?
  maxYears           Int?
  educationLevel     String?                         // 'none'|'associate'|'bachelor'|'master'|'phd'
  skills             String[]  @default([])          // normalized lowercase, max 25
  skillsDetail       Json?                           // [{skill, kind:'hard'|'soft', required:boolean}]

  // location and work model (workType is deprecated: its 'onsite' default lies)
  workModel          String?                         // 'remote'|'hybrid'|'onsite'; null = not stated
  remoteScope        String?                         // ISO country, 'global', or null
  locationRegion     String?
  locations          Json?                           // [{city, region, country, lat, lng}]
  geoLat             Float?
  geoLng             Float?

  // pay (salaryMin/Max/Currency/Period kept as stated in the posting)
  salarySource       String?                         // 'provider' | 'posting_text' — never 'estimate' on this row
  salaryAnnualMin    Int?                            // annualized in salaryCurrency (hour×2080, month×12, or month×salaryMonths)
  salaryAnnualMax    Int?
  salaryMonths       Int?                            // CN "N薪"
  salaryDisclosed    Boolean   @default(false)       // TW-03: 面議 ≥ NT$40k is NOT disclosed

  // work authorization signals (extracted, with evidence; never inferred from absence — ruling C18)
  sponsorship        String?                         // 'offered' | 'not_offered' | null
  sponsorshipEvidence String?                        // ≤240-char quote from the posting
  citizenshipRequired Boolean?
  clearanceRequired  Boolean?
  employerTags       String[]  @default([])          // CN only: 'soe'|'bianzhi'|'hukou'|'foreign', each from a cited source

  // provenance and lifecycle
  sourceUrl          String?
  atsType            String?                         // 'greenhouse'|'lever'|'workday'|'ashby'|'smartrecruiters'|'icims'|'workable'|'taleo'|'successfactors'|'moka'|'beisen'|'feishu'|'dayee'|'other'
  isAgency           Boolean?
  fromRecruiterBank  Boolean   @default(false)       // from our RoboHire/GoHire banks. D3: NOT a claim that the job is absent from other boards, and no ranking boost
  employerVerified   Boolean   @default(false)       // the bank's verified-employer field; "Direct from employer"/企业直招 needs this AND !isAgency
  applicantCount     Int?                            // never written from 'linkedin' or 'jsearch' (scraped LinkedIn counts; F-FEED-08 is SKIP); reserved
  applicantCountSource String?
  applicantCountAt   DateTime?
  postedAtEstimated  Boolean   @default(false)
  firstSeenAt        DateTime  @default(now())
  lastSeenAt         DateTime  @default(now())
  expiresAt          DateTime?
  closedAt           DateTime?
  closeReason        String?                         // 'expired'|'source_removed'|'bank_closed'|'reported'|'duplicate'

  // dedupe
  dedupeKey          String?
  canonicalJobId     String?
  isCanonical        Boolean   @default(true)
  sourcePriority     Int       @default(50)          // lower wins: activejobs 10, bank 15, linkedin 20, jsearch 30, user_import 90

  // search + enrichment
  searchText         String    @default("")          // normalized title + company + top skills
  summary            String?   @db.Text              // ≤2 sentences; enrichment output
  enrichedAt         DateTime?
  enrichVersion      Int?
  enrichModel        String?
  slug               String?                         // public job page slug (SEO)
  publicDisplay      Boolean   @default(false)       // provider licence allows public redisplay (§9.4)

  @@index([market, isCanonical, archivedAt, postedAt(sort: Desc)])
  @@index([market, locationCountry, workModel, archivedAt])
  @@index([taxonomyIds], type: Gin)
  @@index([skills], type: Gin)
  @@index([searchText(ops: raw("gin_trgm_ops"))], type: Gin)
  @@index([dedupeKey])
  @@index([companyId, archivedAt])
  @@index([expiresAt])
  @@index([enrichedAt])
  @@index([ownerUserId])
  @@index([salaryCurrency, salaryAnnualMax])
}

model RACompany {
  id               String   @id @default(cuid())
  market           String                           // 'intl' | 'cn'
  nameNormalized   String
  displayName      String
  slug             String
  domain           String?
  logoUrl          String?
  website          String?
  linkedinUrl      String?
  industries       String[] @default([])
  sizeBand         String?                          // '1-10'|'11-50'|'51-200'|'201-500'|'501-1000'|'1001-5000'|'5001+'
  employeeCount    Int?
  hqLocation       String?
  foundedYear      Int?
  description      String?  @db.Text
  isAgency         Boolean?
  bankCompanyRef   String?                          // recruiter-bank Company.id (robohire:<id> | gohire:<id>)
  /// Provenance per field: { [field]: { source: 'provider:linkedin'|'bank'|'website'|'user', url?, fetchedAt } }. D3: no field is shown without an entry here.
  facts            Json     @default("{}")
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  jobs             RAJob[]
  @@unique([market, nameNormalized])
  @@unique([market, slug])
  @@index([domain])
}

/// Demand-driven ingestion plan (§4.3). One row per provider × normalized query.
model RAIngestQuery {
  id              String    @id @default(cuid())
  market          String
  provider        String    // JobProvider
  paramsHash      String
  params          Json      // { q, taxonomyId?, country, city?, remote?, datePosted, cursor? }
  origin          String    // 'demand' | 'seo_seed' | 'manual' | 'bank_sync'
  demandScore     Int       @default(0)           // #active users whose default profile maps here
  priority        Int       @default(100)
  enabled         Boolean   @default(true)
  nextRunAt       DateTime  @default(now())
  lastRunAt       DateTime?
  lastNewCount    Int?
  lastSeenCount   Int?
  consecutiveEmpty Int      @default(0)
  lastError       String?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  @@unique([provider, paramsHash])
  @@index([enabled, nextRunAt, priority])
}

model RAProviderUsage {
  provider     String
  dayKey       String     // 'YYYY-MM-DD' UTC
  calls        Int @default(0)
  jobsReturned Int @default(0)
  jobsNew      Int @default(0)
  errors       Int @default(0)
  @@id([provider, dayKey])
}

/// US DOL LCA public disclosure data, aggregated per employer and fiscal year (F-SAL-03 honest source).
model RAH1bEmployerStat {
  id                     String   @id @default(cuid())
  employerNameNormalized String
  fiscalYear             Int
  certifiedCount         Int
  withdrawnCount         Int      @default(0)
  medianWageAnnualUsd    Int?
  topTitles              Json     // [{title, count, medianWageAnnualUsd}]
  sourceFile             String   // e.g. 'LCA_Disclosure_Data_FY2026_Q3.xlsx'
  importedAt             DateTime @default(now())
  @@unique([employerNameNormalized, fiscalYear])
}
```

The 3-level taxonomy is **code data**, not a table: `server/src/features/jobs/taxonomy/taxonomy.v1.json` holds ids, the English label, synonyms and the zh label. Localized labels for the other locales come from `i18n` namespace `taxonomy` (INT translates). The taxonomy is versioned, and the version is stamped on `RAJob.enrichVersion`.

### 2.5 Match (`ra-match.prisma`, MATCH)

```prisma
model RAJobMatchScore {
  // existing columns kept (userId, jobId, resumeVariantId, score, explanation, resumeContentHashAtScore, modelUsed, tokenCost, generatedAt)
  scoreKind          String   @default("ai")      // 'ai' only is persisted; 'pre' is computed per request (§4.7)
  tier               String?                       // 'great'|'good'|'possible'|'unlikely' (ruling C2)
  /// [{key:'title_level'|'skills'|'industry'|'logistics'|'career_path', weight, score|null, status:'scored'|'not_stated', evidence:[{text, source:'resume'|'posting', ref?}]}]
  dimensions         Json?
  promptVersion      String?                       // 'scorer_v3'
  locale             String?
  searchProfileVersion Int?                        // logistics depend on the user's pay/location prefs
  @@index([userId, tier, generatedAt(sort: Desc)])
}

/// Competitiveness and other long reports (F-MATCH-04).
model RAFitReport {
  id         String   @id @default(cuid())
  userId     String
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  kind       String   // 'competitiveness' | 'linkedin_profile' (gated)
  inputHash  String
  report     Json     // see contract; every comparative number carries {value, source, sampleSize}
  model      String?
  creditLedgerId String?
  createdAt  DateTime @default(now())
  @@index([userId, kind, createdAt(sort: Desc)])
}
```

`RAKeywordExtraction` moves here unchanged. MATCH writes it as a by-product of enrichment (top keywords, recomputed per `enrichVersion`), which ends the "never written" problem.

### 2.6 Feed (`ra-feed.prisma`, FEED)

```prisma
/// One row per (user, job) with the user's current state. Used for NOT EXISTS / joins in the feed query.
model RAJobUserState {
  userId          String
  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  jobId           String
  job             RAJob     @relation(fields: [jobId], references: [id], onDelete: Cascade)
  hiddenAt        DateTime?
  hiddenReason    String?   // reason code (§4.9)
  viewedAt        DateTime?
  applyClickedAt  DateTime?
  impressions     Int       @default(0)
  lastImpressionAt DateTime?
  @@id([userId, jobId])
  @@index([userId, hiddenAt])
}

/// Append-only interaction log (feedback loop + analytics).
model RAJobInteraction {
  id           String   @id @default(cuid())
  userId       String
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  jobId        String
  kind         String   // 'view'|'save'|'unsave'|'hide'|'unhide'|'report'|'apply_click'|'applied'|'unapplied'|'share'|'copilot_open'
  reasonCode   String?
  detail       Json?
  feedSessionId String?
  position     Int?
  createdAt    DateTime @default(now())
  @@index([userId, createdAt(sort: Desc)])
  @@index([jobId, kind])
}

/// A ranked, paginated snapshot of the feed (fixes load-everything; §4.8).
model RAFeedSession {
  id               String   @id @default(cuid())
  userId           String
  user             User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  searchProfileId  String?
  profileVersion   Int?
  sort             String   // 'recommended' | 'recent' | 'top_fit'
  queryHash        String
  jobIds           String[]
  ranks            Json     // [{jobId, fit, kind:'pre'|'ai', rank}]
  totalEstimate    Int
  windowEndsAt     DateTime // older boundary of the retrieval window (for the next refill)
  createdAt        DateTime @default(now())
  expiresAt        DateTime
  @@index([userId, createdAt(sort: Desc)])
  @@index([expiresAt])
}

model RAFeedRating {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  dayKey    String
  score     Int      // 0–10
  reasons   String[] @default([])
  note      String?
  feedSessionId String?
  createdAt DateTime @default(now())
  @@unique([userId, dayKey])
}

model RAUserAffinity {
  userId          String   @id
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  taxonomyWeights Json     @default("{}")   // { taxonomyId: -1..1 }
  companyWeights  Json     @default("{}")
  skillWeights    Json     @default("{}")
  updatedAt       DateTime @updatedAt
}
```

**Liked = saved for later.** There is no separate "like" table. Saving a job creates or updates `RATrackerEntry{status:'bookmarked', source:'feed'}`, following the rulings (C7 "Save for later" lands in the Saved column). The feed's Saved tab reads the tracker.

### 2.7 Profile (`ra-profile.prisma`, PROF)

```prisma
model RAProfile {
  userId         String   @id
  user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  firstName      String?
  middleName     String?
  lastName       String?
  headline       String?
  contactEmail   String?
  phoneE164      String?
  phoneType      String?      // 'mobile'|'home'|'work'|'other'
  addressLine1   String?
  city           String?
  region         String?
  postalCode     String?
  country        String?
  links          Json  @default("{}")   // { linkedin, github, portfolio, website, x }
  summary        String?  @db.Text
  skills         Json  @default("[]")   // [{name, group?, level?, confirmed:boolean}]
  languages      Json  @default("[]")   // [{language, level}]
  /// [{country:'US', authorized:boolean|null, sponsorship:'now'|'later'|'no'|null}] — ruling C18: a question, not a label
  workAuth       Json  @default("[]")
  seekerType     String?   // 'rush' | 'open' (S1)
  careerGoal     String?   // 9 keys (S3)
  /// GoApply fields: { identity:'yingjie'|'zaixiao'|'shezhao', graduationClass, degree, isFullTimeProgram, schoolName,
  ///   schoolTags (display/user-filter only, never a ranking input), major, jobSearchStatus, internshipDaysPerWeek,
  ///   internshipMonths, availableFrom, acceptReassignment }
  cnFields       Json?
  completeness   Int      @default(0)
  syncedFromVariantId String?
  updatedAt      DateTime @updatedAt
  createdAt      DateTime @default(now())
}

model RAProfileEducation {
  id          String  @id @default(cuid())
  userId      String
  user        User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  school      String
  degree      String?
  major       String?
  gpa         String?
  startYm     String?   // 'YYYY-MM'
  endYm       String?
  current     Boolean @default(false)
  location    String?
  coursework  String?
  achievements String?
  sortOrder   Int     @default(0)
  @@index([userId, sortOrder])
}

model RAProfileExperience {
  id             String  @id @default(cuid())
  userId         String
  user           User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  title          String
  company        String
  employmentType String?
  location       String?
  startYm        String?
  endYm          String?
  current        Boolean @default(false)
  summary        String? @db.Text
  bullets        String[] @default([])
  kind           String  @default("work")   // 'work' | 'internship' (CN separates 实习)
  sortOrder      Int     @default(0)
  @@index([userId, sortOrder])
}

/// EEO answers (RoboApply) and CN sensitive fields (政治面貌, 籍贯, 家庭成员). AES-GCM via server/src/lib/crypto.ts.
/// Never sent to an LLM, never used in matching, decrypted only for the extension autofill payload with consent 'autofill_sensitive'.
model RASensitiveAnswers {
  userId     String   @id
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  ciphertext String   @db.Text
  keyVersion Int
  updatedAt  DateTime @updatedAt
}
```

### 2.8 Search profiles: the one preference store (`ra-search.prisma`, PREF)

```prisma
model RASearchProfile {
  id               String    @id @default(cuid())
  userId           String
  user             User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  name             String
  isDefault        Boolean   @default(false)   // exactly one per user (app-enforced in a transaction)
  isActive         Boolean   @default(false)   // the profile the feed uses now
  version          Int       @default(1)       // optimistic concurrency for drawer/copilot/onboarding writes
  schemaVersion    Int       @default(1)
  filters          Json                         // FilterSet v1 (contract below)
  alertInstantMax  Int       @default(0)        // 0 | 1 | 2 | 5 | 100(unlimited)
  alertDigest      String?                      // 'daily' | 'weekly' | null
  alertLastInstantAt DateTime?
  alertLastDigestAt  DateTime?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
  alertDeliveries  RAAlertDelivery[]
  @@index([userId, isDefault])
  @@index([alertInstantMax, alertLastInstantAt])
  @@index([alertDigest, alertLastDigestAt])
}
```

**FilterSet v1.** Defined as a zod schema in `server/src/features/search/contract.ts`. Every field is optional; absence means "any".

```ts
FilterSet = {
  taxonomyIds?: string[];  titles?: string[];  excludedTitles?: string[];
  jobTypes?: ('full_time'|'contract'|'part_time'|'internship')[];
  workModels?: ('remote'|'hybrid'|'onsite')[];
  country?: string;  locations?: { label: string; city?: string; region?: string; country: string; lat?: number; lng?: number; radiusKm: 0|8|40|80|160 }[];
  seniority?: ('intern_newgrad'|'entry'|'mid'|'senior'|'lead_staff'|'director_exec')[];
  yearsRange?: { min?: number; max?: number };  postedWithinDays?: 1|3|7|30;
  salaryMin?: { amount: number; currency: string; period: 'year'|'month'|'hour' };  includeUndisclosedPay?: boolean;  // default true
  needsSponsorship?: boolean;  excludeRequirements?: ('citizenship'|'clearance')[];
  industries?: string[];  excludedIndustries?: string[];  skills?: string[];  excludedSkills?: string[];
  roleType?: 'ic'|'manager';  companies?: string[];  companySizes?: string[];  excludeAgencies?: boolean;
  excludedCompanies?: string[];  recruiterJobsOnly?: boolean;  // free on every plan  fitTier?: 'all'|'good'|'great';
  employerTags?: ('soe'|'bianzhi'|'hukou'|'foreign')[];     // GoApply only
  q?: string;                                              // free-text title/company keywords
}
```

**Migration.** On the first read of `/search-profiles` for a user with none, PREF creates the default profile from `RACareerGoal.preferencesBlob` (`roleTitles`, `workModes`, `cities`, `salaryMinK`, `employmentTypes`, `industriesTarget/Avoid`, `targetCompanies`, `blockedCompanies`) and the goal row. Job-targeting keys stop being written to `preferencesBlob`. Non-search preferences (notifications, privacy, identity extras) stay there. The dead agent knobs (`aggressiveness`, `matchThreshold`, `dailyCap`, `quietStart/End`, `autoDecline`, `autoSchedule`) are dropped from the type and ignored on read.

`RASavedSearch` is deprecated (it has no UI). Its rows are imported once into `RASearchProfile` (non-default). Its routes are removed by CLEAN.

### 2.9 Resume, cover letter, tracker (RES, CL, TRK)

```prisma
model RAResumeVariant {           // ra-resume.prisma; existing columns kept
  layout           Json?          // { template:'standard'|'compact'|'centered'|'structured'|'split', font, sizes{name,section,sub,body}, page:'letter'|'a4', spacing{section,entry,line,marginY,marginX}, justify, headerAlign, accent, bullet, skillsLayout, eduOrder, dateFormat, hideDivider }
  targetTitle      String?
  unverifiedClaims Int     @default(0)   // >0 blocks export (§ RES rule; ruling C12)
  analysisStatus   String?               // 'none'|'running'|'done'|'failed'
  grades           RAResumeGrade[]
  tailorSessionsBase   RATailorSession[] @relation("TailorBase")
  tailorSessionsResult RATailorSession[] @relation("TailorResult")
  coverLetters     RACoverLetter[]
}

model RAResumeGrade {
  id          String   @id @default(cuid())
  userId      String
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  variantId   String
  variant     RAResumeVariant @relation(fields: [variantId], references: [id], onDelete: Cascade)
  contentHash String
  targetTitle String?
  status      String   @default("running")  // running | done | failed | cancelled
  grade       String?                       // 'A'|'B'|'C'|'D'
  score       Int?                          // 0–100
  counts      Json?                         // { urgent, critical, optional }
  issues      Json?                         // [{id, type, severity, section, anchor, why, how, suggestion?}]
  model       String?
  creditLedgerId String?
  createdAt   DateTime @default(now())
  completedAt DateTime?
  @@index([variantId, createdAt(sort: Desc)])
}

model RATailorSession {
  id               String   @id @default(cuid())
  userId           String
  user             User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  baseVariantId    String
  baseVariant      RAResumeVariant  @relation("TailorBase", fields: [baseVariantId], references: [id], onDelete: Cascade)
  resultVariantId  String?
  resultVariant    RAResumeVariant? @relation("TailorResult", fields: [resultVariantId], references: [id], onDelete: SetNull)
  jobId            String?
  jdSnapshot       Json?    // pasted posting: {title, company, text}
  mode             String   @default("guided")   // 'guided' | 'fast'
  sections         String[] @default([])         // 'summary'|'skills'|'work_quick'|'work_full'|'projects'
  customPrompt     String?
  keywordsSelected String[] @default([])
  scoreBefore      Int?
  scoreAfter       Int?
  /// [{id, text, kind:'keyword'|'number'|'claim', status:'pending'|'kept'|'removed'|'edited', evidence?:{source:'resume', ref}}]
  claims           Json     @default("[]")
  status           String   @default("draft")   // draft | generating | review | finalized | failed
  creditLedgerId   String?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  @@index([userId, jobId])
}

model RACoverLetter {             // ra-coverletter.prisma
  id              String   @id @default(cuid())
  userId          String
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  jobId           String?
  trackerEntryId  String?
  resumeVariantId String
  resumeVariant   RAResumeVariant @relation(fields: [resumeVariantId], references: [id], onDelete: Cascade)
  title           String
  tone            String   @default("professional")   // 'professional'|'warm'|'direct'|'enthusiastic'
  length          String   @default("medium")         // 'short'|'medium'|'long'
  locale          String
  bodyMarkdown    String   @db.Text
  versions        Json     @default("[]")              // [{body, reason, createdAt}] max 20
  citations       Json     @default("[]")              // [{sentenceIdx, source:'resume'|'posting', ref}]
  model           String?
  creditLedgerId  String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  deletedAt       DateTime?
  @@index([userId, updatedAt(sort: Desc)])
  @@index([userId, jobId])
}

model RATrackerEntry {            // ra-tracker.prisma; existing columns kept
  source            String?   // 'feed'|'external'|'extension'|'copilot'|'agent'|'manual'
  stageDetail       String?   // GoApply sub-stage: 'wangshen'|'ceping'|'bishi'|'ai_mianshi'|'mianshi_1'|'mianshi_2'|'hr_mianshi'|'offer'|'sanfang'
  outcome           String?   // 'they_said_no'|'i_withdrew'|'job_pulled' (ruling C1)
  interviewAt       DateTime?
  offer             Json?     // { base, currency, period, bonus?, equity?, deadline?, notes? } — user-entered
  tailoredVariantId String?
  coverLetterId     String?
  events            RATrackerEvent[]
  artifacts         RAApplicationArtifact[]
  @@index([userId, interviewAt])
}

model RATrackerEvent {
  id        String   @id @default(cuid())
  entryId   String
  entry     RATrackerEntry @relation(fields: [entryId], references: [id], onDelete: Cascade)
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  kind      String   // 'status'|'note'|'reminder'|'artifact'|'interview'|'outcome'
  fromValue String?
  toValue   String?
  payload   Json?
  createdAt DateTime @default(now())
  @@index([entryId, createdAt])
}

/// The exact file sent with an application (catalog Appendix A clone addition; fixes Jobright's "which resume did I send").
model RAApplicationArtifact {
  id             String   @id @default(cuid())
  userId         String
  user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  trackerEntryId String?
  trackerEntry   RATrackerEntry? @relation(fields: [trackerEntryId], references: [id], onDelete: SetNull)
  autofillRunId  String?
  kind           String   // 'resume' | 'cover_letter'
  variantId      String?
  coverLetterId  String?
  fileName       String
  format         String   // 'pdf' | 'docx'
  fileSha256     String
  storageKey     String?  // R2 key of the exact bytes (kept 180 days)
  channel        String   // 'extension' | 'download' | 'agent'
  createdAt      DateTime @default(now())
  @@index([userId, createdAt(sort: Desc)])
  @@index([trackerEntryId])
}
```

`RACareerInsight` moves to `ra-tracker.prisma` unchanged. It becomes the weekly card on `/applications?view=date` (ruling C40).

### 2.10 Network, copilot, agent, extension (NET, COP, AGENT, EXT)

```prisma
/// People at companies, from honest sources only (D3; §5 copilot tool `find_connections`).
model RAContact {                 // ra-network.prisma
  id                     String   @id @default(cuid())
  market                 String
  ownerUserId            String?  // set for user-imported/added contacts: private to the owner
  owner                  User?    @relation(fields: [ownerUserId], references: [id], onDelete: Cascade)
  source                 String   // 'user_connections_import' | 'user_added' | 'bank_recruiter'
  sourceRef              String?  // import id | recruiter-bank user id
  consentBasis           String?  // bank_recruiter only: set ONLY by the contacts-sync from an opt-in record read through a RoboHire/GoHire API (record id + timestamp in sourceRef); never backfilled
  companyNameNormalized  String
  companyId              String?
  fullName               String
  firstName              String?
  title                  String?
  linkedinUrl            String?
  pastCompaniesNormalized String[] @default([])
  schoolsNormalized      String[] @default([])
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt
  outreachDrafts         RAOutreachDraft[]
  @@index([ownerUserId, companyNameNormalized])
  @@index([market, companyNameNormalized, source])
}

model RAContactImport {
  id           String   @id @default(cuid())
  userId       String
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  kind         String   // 'linkedin_connections_csv'
  fileName     String
  rowCount     Int
  importedCount Int
  createdAt    DateTime @default(now())
}

model RAOutreachDraft {
  id             String   @id @default(cuid())
  userId         String
  user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  contactId      String?
  contact        RAContact? @relation(fields: [contactId], references: [id], onDelete: SetNull)
  jobId          String?
  trackerEntryId String?
  channel        String   // 'linkedin_note' | 'email' | 'referral_ask' | 'follow_up' | 'wechat'
  subject        String?
  body           String   @db.Text
  model          String?
  copiedAt       DateTime?
  markedSentAt   DateTime?
  createdAt      DateTime @default(now())
  @@index([userId, createdAt(sort: Desc)])
}

model RACopilotThread {           // ra-copilot.prisma
  id                   String    @id @default(cuid())
  userId               String
  user                 User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  brand                String
  title                String?
  contextJobId         String?
  summary              String?   @db.Text   // rolling summary of older turns
  summarizedThroughId  String?
  messageCount         Int       @default(0)
  tokensIn             Int       @default(0)
  tokensOut            Int       @default(0)
  costUsd              Decimal   @default(0) @db.Decimal(10, 6)
  lastMessageAt        DateTime  @default(now())
  archivedAt           DateTime?
  createdAt            DateTime  @default(now())
  messages             RACopilotMessage[]
  proposals            RACopilotProposal[]
  @@index([userId, lastMessageAt(sort: Desc)])
}

model RACopilotMessage {
  id          String   @id @default(cuid())
  threadId    String
  thread      RACopilotThread @relation(fields: [threadId], references: [id], onDelete: Cascade)
  role        String   // 'user' | 'assistant' | 'tool'
  content     String   @db.Text
  cards       Json     @default("[]")   // typed cards (§5.4)
  toolCalls   Json?                     // [{id, name, args, resultDigest, ms, ok}]
  model       String?
  tokensIn    Int?
  tokensOut   Int?
  feedback    String?  // 'up' | 'down'
  feedbackNote String?
  createdAt   DateTime @default(now())
  @@index([threadId, createdAt])
}

model RACopilotProposal {
  id          String   @id @default(cuid())
  threadId    String
  thread      RACopilotThread @relation(fields: [threadId], references: [id], onDelete: Cascade)
  userId      String
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  kind        String   // 'filter_change' | 'credit_action' | 'memory_add'
  payload     Json     // filter_change: {searchProfileId, baseVersion, ops:[{op:'add'|'remove'|'set', path, value}]}; credit_action: {action:'tailor'|'cover_letter'|'outreach', args, bucket, cost}
  status      String   @default("pending")   // pending | applied | dismissed | expired | conflict
  expiresAt   DateTime
  appliedAt   DateTime?
  createdAt   DateTime @default(now())
  @@index([userId, status])
}

/// User-visible, deletable long-term facts (catalog §6.2: CN wants long-term career memory).
model RACopilotMemory {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  fact      String    // ≤200 chars
  source    String    // 'user_said' | 'user_confirmed'
  createdAt DateTime  @default(now())
  deletedAt DateTime?
  @@index([userId, deletedAt])
}

model RAAgentSettings {           // ra-agent.prisma
  userId           String   @id
  user             User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  weeklyTarget     String   @default("lt20")         // 'lt20' | '20to50' | 'gt50' (a target, never a cap)
  resumeMode       String   @default("tailor_each")  // 'tailor_each' | 'use_primary' | 'pick'
  resumeFormat     String   @default("original")     // 'original' | 'template'
  coverLetterMode  String   @default("when_required")// 'when_required' | 'always' | 'never'
  setupStep        String   @default("profile")      // 'profile'|'calibrate'|'market_fit'|'autofill'|'settings'|'done'
  calibration      Json     @default("[]")           // [{jobId, verdict:'up'|'down', note?}]
  setupCompletedAt DateTime?
  updatedAt        DateTime @updatedAt
}

model RAAgentQueueItem {
  id              String   @id @default(cuid())
  userId          String
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  jobId           String
  trackerEntryId  String?
  /// added → preparing → needs_review → ready → opened → applied | skipped | expired | failed   (never 'submitted')
  state           String   @default("added")
  resumeVariantId String?
  coverLetterId   String?
  tailorSessionId String?
  missingFields   Json?
  addedVia        String   // 'suggestions' | 'feed' | 'copilot' | 'search'
  lastError       String?
  openedAt        DateTime?
  completedAt     DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@unique([userId, jobId])
  @@index([userId, state, updatedAt(sort: Desc)])
}

model RAAnswerBankItem {
  id           String   @id @default(cuid())
  userId       String
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  questionKey  String   // canonical key from server/src/features/agent/questionKeys.ts, or 'custom:<hash>'
  questionText String
  answer       String   @db.Text
  source       String   // 'user' | 'ai_confirmed'
  locale       String
  lastUsedAt   DateTime?
  updatedAt    DateTime @updatedAt
  @@unique([userId, questionKey])
}

model RAExtensionDevice {         // ra-extension.prisma
  id          String    @id @default(cuid())
  userId      String
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  brand       String
  tokenHash   String    @unique     // sha256 of 'rax_<32B base64url>'
  tokenPrefix String                // first 8 chars for the devices list
  name        String
  browser     String?
  extVersion  String?
  lastSeenAt  DateTime?
  revokedAt   DateTime?
  createdAt   DateTime  @default(now())
  autofillRuns RAAutofillRun[]
  @@index([userId, revokedAt])
}

model RAAutofillRun {
  id                 String   @id @default(cuid())
  userId             String
  user               User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  deviceId           String
  device             RAExtensionDevice @relation(fields: [deviceId], references: [id], onDelete: Cascade)
  jobId              String?
  trackerEntryId     String?
  host               String
  atsType            String
  fieldsTotal        Int      @default(0)
  fieldsFilled       Int      @default(0)
  aiAnswers          Int      @default(0)
  outcome            String   @default("started")   // started | filled | partial | failed
  userMarkedSubmitted Boolean @default(false)        // the USER says they submitted (D1)
  creditLedgerId     String?
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
  @@index([userId, createdAt(sort: Desc)])
}

model RASiteRequest {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  host      String
  url       String
  note      String?
  createdAt DateTime @default(now())
  @@index([host])
}
```

### 2.11 Credits and entitlements (`ra-credits.prisma`, CRED)

```prisma
/// Usage counter per bucket and window. Atomic conditional UPDATE enforces the cap (§7.3).
model RACreditWindow {
  userId     String
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  bucket     String   // §7.1 bucket list
  windowKey  String   // 'd:2026-10-09' | 'w:2026-W41' | 'm:2026-10' in the user's timezone
  used       Int      @default(0)
  reserved   Int      @default(0)
  updatedAt  DateTime @updatedAt
  @@id([userId, bucket, windowKey])
}

model RACreditLedger {
  id             String   @id @default(cuid())
  userId         String
  user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  bucket         String
  amount         Int                     // units (positive = consumption)
  status         String                  // 'reserved' | 'committed' | 'released'
  fromSource     String                  // 'window' | 'grant:<grantId>' | 'unlimited'
  windowKey      String?
  idempotencyKey String   @unique        // '<userId>:<bucket>:<client Idempotency-Key or server ref>'
  refType        String?                 // 'tailor_session' | 'cover_letter' | 'autofill_run' | …
  refId          String?
  sku            String?                 // UsageDeductionLog sku for cost join
  createdAt      DateTime @default(now())
  settledAt      DateTime?
  @@index([userId, bucket, createdAt(sort: Desc)])
  @@index([status, createdAt])
}

/// Bonus credits (referral rewards, admin grants, purchased packs) consumed after the window allowance.
model RACreditGrant {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  bucket    String    // a bucket, or '*' for any AI bucket
  amount    Int
  remaining Int
  reason    String    // 'referral' | 'admin' | 'pack' | 'compensation'
  expiresAt DateTime?
  createdAt DateTime  @default(now())
  @@index([userId, bucket, expiresAt])
}

model RAEntitlementOverride {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  key       String    // 'bucket:tailor' | 'feature:savedProfilesMax' | 'flag:coaching'
  value     Json      // number | boolean | 'unlimited'
  reason    String
  adminId   String?
  expiresAt DateTime?
  createdAt DateTime  @default(now())
  @@index([userId, key])
}
```

### 2.12 Notifications, growth, prep, SEO (NOTIF, GROW, PREP, SEO)

```prisma
model RAAlertDelivery {           // ra-notify.prisma
  id              String   @id @default(cuid())
  userId          String
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  searchProfileId String
  searchProfile   RASearchProfile @relation(fields: [searchProfileId], references: [id], onDelete: Cascade)
  kind            String   // 'instant' | 'digest_daily' | 'digest_weekly'
  jobIds          String[]
  emailLogId      String?
  sentAt          DateTime @default(now())
  @@index([userId, sentAt(sort: Desc)])
  @@index([searchProfileId, sentAt(sort: Desc)])
}

model RAPushSubscription {
  id          String   @id @default(cuid())
  userId      String
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  brand       String
  endpoint    String   @unique
  p256dh      String
  auth        String
  userAgent   String?
  failedCount Int      @default(0)
  lastOkAt    DateTime?
  createdAt   DateTime @default(now())
}

model RAAnnouncement {
  id        String   @id @default(cuid())
  brand     String
  key       String   @unique            // e.g. '2026-11-copilot-launch'
  locales   String[]
  content   Json                        // { [locale]: { title, body, ctaLabel?, ctaHref? } } — authored by admin, translated before publish
  cohort    Json     @default("{}")     // { plans?: string[], signedUpBefore?, flags?: string[] }
  priority  Int      @default(100)
  startsAt  DateTime
  endsAt    DateTime
  createdAt DateTime @default(now())
  @@index([brand, startsAt, endsAt])
}

/// Server-side UI state that follows the user across devices (catalog F-ACCT-05 extraConfigMap).
model RAUserUiState {
  userId    String   @id
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  state     Json     @default("{}")     // { tours: {key: seenAt}, dismissals: {key: {count, at}}, popupLastShownAt, announcementsSeen: string[] }
  updatedAt DateTime @updatedAt
}

model RAEmailLog {
  id         String   @id @default(cuid())
  brand      String
  userId     String?
  template   String
  toHash     String               // sha256(lowercase email); raw address not stored
  provider   String               // 'resend' | 'aliyun_dm'
  providerId String?
  status     String               // 'sent' | 'failed' | 'suppressed'
  error      String?
  createdAt  DateTime @default(now())
  @@index([template, createdAt])
  @@index([userId, createdAt])
}

model RAReferralCode {            // ra-growth.prisma
  userId    String   @id
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  brand     String
  code      String   @unique      // 8 chars, Crockford base32
  createdAt DateTime @default(now())
}

model RAReferral {
  id              String    @id @default(cuid())
  brand           String
  inviterUserId   String
  inviter         User      @relation("RAReferralInviter", fields: [inviterUserId], references: [id], onDelete: Cascade)
  inviteeUserId   String    @unique
  invitee         User      @relation("RAReferralInvitee", fields: [inviteeUserId], references: [id], onDelete: Cascade)
  status          String    @default("pending")   // pending | qualified | rewarded | rejected
  riskScore       Int       @default(0)
  riskReasons     String[]  @default([])
  qualifiedAt     DateTime?
  rewardedAt      DateTime?
  createdAt       DateTime  @default(now())
  @@index([inviterUserId, status])
}

model RAAttribution {
  userId      String   @id
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  anonId      String?
  firstTouch  Json     // { from, utmSource, utmMedium, utmCampaign, ref, inviteCode, landingPath, jobId, at }
  lastTouch   Json?
  createdAt   DateTime @default(now())
}

model RAInterviewQuestion {       // ra-prep.prisma
  id                    String   @id @default(cuid())
  market                String
  companyId             String?
  companyNameNormalized String?
  taxonomyId            String?
  category              String   // 'coding' | 'system_design' | 'domain_design' | 'behavioral'
  difficulty            String?  // 'easy' | 'medium' | 'hard'
  seniority             String?
  title                 String
  body                  String   @db.Text
  locale                String
  /// D3: 'user_report' (a candidate contributed it, moderated) | 'ai_practice' (generated; ALWAYS labelled, never attributed to a company) | 'curated' (staff-written, generic, labelled "Written by %BRAND% staff — not reported by candidates").
  /// Service check: ONLY sourceKind='user_report' may carry companyId / companyNameNormalized. Moderation rejects verbatim assessment/test content under NDA or copyright.
  sourceKind            String
  reportedPeriod        String?  // 'YYYY-MM' for user reports
  contributionId        String?
  guide                 Json?    // { approach, whatTheyTest, commonMistakes, rubric, followUps } — AI-generated, labelled
  guideModel            String?
  status                String   @default("published")   // published | hidden
  reportsCount          Int      @default(0)
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  reports               RAQuestionReport[]
  @@index([market, companyNameNormalized, category, status])
  @@index([market, taxonomyId, category])
}

model RAQuestionContribution {
  id            String   @id @default(cuid())
  userId        String
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  market        String
  companyName   String
  role          String
  interviewYm   String
  body          String   @db.Text
  status        String   @default("pending")   // pending | approved | rejected
  moderatorId   String?
  moderatedAt   DateTime?
  createdAt     DateTime @default(now())
  @@index([status, createdAt])
}

model RAQuestionReport {
  id         String   @id @default(cuid())
  questionId String
  question   RAInterviewQuestion @relation(fields: [questionId], references: [id], onDelete: Cascade)
  userId     String
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  reason     String
  note       String?
  createdAt  DateTime @default(now())
}

/// Coaching marketplace. Ships EMPTY and gated (flag `coaching`) until real coaches are approved (D3).
model RACoach {
  id           String   @id @default(cuid())
  userId       String   @unique
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  brand        String
  displayName  String
  headline     String
  bio          String   @db.Text
  languages    String[]
  specialties  String[]
  rates        Json     // { '30': amountMinor, '60': amountMinor, currency }
  introVideoUrl String?
  status       String   @default("applied")   // applied | approved | paused | rejected
  approvedAt   DateTime?
  approvedBy   String?
  createdAt    DateTime @default(now())
  slots        RACoachSlot[]
  bookings     RACoachBooking[]
}

model RACoachSlot {
  id          String   @id @default(cuid())
  coachId     String
  coach       RACoach  @relation(fields: [coachId], references: [id], onDelete: Cascade)
  startsAt    DateTime
  durationMin Int
  status      String   @default("open")   // open | held | booked | cancelled
  heldUntil   DateTime?
  booking     RACoachBooking?
  @@index([coachId, startsAt])
}

model RACoachBooking {
  id            String   @id @default(cuid())
  coachId       String
  coach         RACoach  @relation(fields: [coachId], references: [id], onDelete: Cascade)
  userId        String
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  slotId        String   @unique
  slot          RACoachSlot @relation(fields: [slotId], references: [id], onDelete: Cascade)
  durationMin   Int
  topic         String
  resumeVariantId String?
  contact       Json
  priceMinor    Int
  currency      String
  paymentRef    String?  // Stripe session id or AlipayOrder.outTradeNo
  status        String   @default("pending_payment") // pending_payment | pending_coach | confirmed | completed | cancelled | no_show
  meetingUrl    String?
  cancelledBy   String?
  refundPct     Int?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@index([userId, createdAt(sort: Desc)])
}

model RASeoPage {                 // ra-seo.prisma
  id          String   @id @default(cuid())
  brand       String
  locale      String
  type        String   // 'role'|'role_city'|'remote_role'|'company'|'segment'|'sponsorship_role'|'compare'|'campus'
  slug        String
  params      Json     // { taxonomyId?, city?, country?, companyId?, segment? }
  title       String
  h1          String
  intro       String   @db.Text          // generated from real stats + template text, never invented facts
  stats       Json     // { jobCount, newLast7d, medianSalary?:{value,currency,period,sampleSize}, topCompanies:[…], asOf }
  jobCount    Int
  indexable   Boolean  @default(false)
  lastBuiltAt DateTime @default(now())
  @@unique([brand, locale, type, slug])
  @@index([brand, indexable, type])
}

model RAPhoneOtp {                // ra-cn.prisma (AUTH writes)
  id         String    @id @default(cuid())
  brand      String
  phoneE164  String
  codeHash   String
  purpose    String    // 'login' | 'bind'
  attempts   Int       @default(0)
  ipHash     String
  expiresAt  DateTime
  consumedAt DateTime?
  createdAt  DateTime  @default(now())
  @@index([phoneE164, createdAt(sort: Desc)])
}

/// GoApply campus recruiting calendar (校招日历). Staff-curated; every row MUST carry an official URL (D3).
model RACampusEvent {
  id              String   @id @default(cuid())
  market          String   @default("cn")
  companyName     String
  companyId       String?
  graduationClass String   // '2027届'
  kind            String   // 'application' | 'test' | 'interview' | 'info_session'
  opensAt         DateTime?
  closesAt        DateTime?
  officialUrl     String
  sourceNote      String?
  verifiedAt      DateTime
  createdBy       String
  createdAt       DateTime @default(now())
  @@index([market, graduationClass, closesAt])
}
```

### 2.13 Reuse map

| Need | Reused model | Change |
|---|---|---|
| Brand on users | `User` | `brand`, `phoneE164`, `phoneVerifiedAt`, `lastActiveAt` |
| Onboarding stage | `SeekerProfile` | `onboarding*`, `timezone`, `acquisition*` |
| Consents (CN separate consents, marketing opt-in, sensitive autofill) | `SeekerConsentRecord` | none. New `consentType` values: `marketing_email` (exists), `ai_resume_parse`, `sensitive_fields`, `personalized_recommendation`, `share_with_employers`, `interview_recording`, `interview_video`, `autofill_sensitive`, `age_16_plus`, `tw_pdpa_notice`, `pipl_cross_border`, `intl_cross_border_cn_parse`, `copilot_memory`, `tips_reminders`, `auto_renew_ack`, `withdrawal_waiver`, `analytics` (plus the CN §4.1(4) set). The closed enum in `lib/seekerConsentTypes.ts` is extended (AUTH). |
| Message center | `SeekerNotification` | `userId`, `brand`, `category`, `templateKey`, `params`, `pushSentAt` |
| Subscriptions | `SeekerSubscription` | `brand`, `planKey`, `interval`, `rail` |
| CN-rail orders (Alipay + WeChat Pay) | `AlipayOrder` | `channel`, `brand`, `planKey`, `purpose`, `amountMinor`, `relatedId` |
| Interview minutes | `SeekerSubscription.mockCredits` + `MockInterviewCreditLedger` | none (the `interview_minutes` bucket delegates to `mockCreditService`) |
| LLM cost audit | `UsageDeductionLog` | none (new SKUs in `raFeatureCatalog.ts`, §7.5) |
| Saved/liked jobs | `RATrackerEntry` (`bookmarked`) | tracker fields above |
| Tailored resumes | `RAResumeVariant` (`kind='tailored_for_jd'`) | `layout`, `targetTitle`, `unverifiedClaims`, `analysisStatus` |
| Job index | `RAJob` | §2.4 |
| Score cache | `RAJobMatchScore` | §2.5 |
| Keywords | `RAKeywordExtraction` | finally written (MATCH) |
| Weekly insight | `RACareerInsight` | none |
| API keys (job-search partner product) | `ApiKey`, `ApiUsageRecord` | none; the extension does **not** use API keys |

Models left untouched and unused (the zero-reference `Seeker*` set in the backend map §9) stay in `legacy.prisma`. Dropping them is out of scope because it is a destructive change.

### 2.14 Provenance convention on the wire (D3)

Every number or factual claim that is not the user's own data is serialized as:

```ts
type Sourced<T> = { value: T; source: SourceTag; sampleSize?: number; asOf: string; method?: 'stated' | 'computed' | 'ai_estimate'; url?: string };
type SourceTag = 'posting' | 'provider:activejobs' | 'provider:linkedin' | 'provider:jsearch' | 'bank:robohire' | 'bank:gohire'
               | 'index' /* our own RAJob aggregate */ | 'dol_lca' | 'company_website' | 'user' | 'ai';
```

The UI renders a source line for every `Sourced` value. **`method: 'ai_estimate'` must render the word "Estimate" and the method sentence.** Aggregates computed from our index must state `sampleSize`, and they are suppressed when `sampleSize < MIN_SAMPLE` (20; one shared constant, pay medians included, one currency and period). Every aggregate and public count filters `visibility='public' AND isCanonical AND archivedAt IS NULL AND market = brand.market`. Shared formatter: `components/features/common/SourceNote.tsx` (FND creates it).

---

### 2.15 Onboarding stage machine (ONB, data owned by PROF/PREF)

`SeekerProfile.onboardingStep` is the server-side stage, mapped from catalog §3.1. Strings are used instead of Jobright's numeric codes. **Every step is idempotent and resumable.** `GET /auth/me` returns `{ onboarding: { step, path, completed } }`. `AuthGate` routes any authenticated user whose step is not `done` (and who is not on an exempt route) to `/onboarding/<step>`. The `next.config.mjs` redirect `/onboarding → /jobs` is removed (FND). The onboarding routes live in their own group, `app/(onboarding)/onboarding/[step]/page.tsx`, with a layout that sits **inside** the themed canvas. This avoids the white-on-white overlay bug from memory note 1e5b31f.

| Step | Route | Writes | Notes |
|---|---|---|---|
| `signup` | `/signup` (S0) | `User`, `SeekerProfile`, consents, `RAAttribution` | Brand auth methods; marketing opt-in **unchecked**; GoApply shows separate consents first (CN area). `from`/`jobId`/`action` carried in `onboardingEntry`. |
| `mode` | `/onboarding/mode` (S1) | `RAProfile.seekerType`, `onboardingPath` | Two cards; no skip. |
| `basics` | `/onboarding/basics` (S2) | default `RASearchProfile.filters` (taxonomyIds ≤3 specific titles, jobTypes, country/locations, workModels, needsSponsorship) and `RAProfile.workAuth` | Live market snapshot (`GET /onboarding/market-snapshot`; every number `Sourced`, suppressed under 20 postings). RoboApply generalizes "H-1B sponsorship" to "Needs visa sponsorship in {country}" (TW-09). GoApply replaces this step with the CN identity form (`RAProfile.cnFields`). |
| `goal` | `/onboarding/goal` (S3, `open` path only) | `RAProfile.careerGoal` | Next validates; Skip allowed. |
| `advanced` | `/onboarding/advanced` (S4, `open` only) | filters: industries, skills, companySizes | All optional. Company stage is replaced by **company size** because funding data is gated (D3). |
| `resume` | `/onboarding/resume` (S5) | `RAResumeVariant` (existing upload path), `RAProfile` sync draft | Reuses `ResumeStep.tsx` doors and `/v2/resumes/upload` (GoHire parse). Skip leads to preference-only matching. The daily upload cap is the existing parse idempotency plus a rate limit of 10 per day. |
| `matching` | `/onboarding/matching` (S6) | precompute kick-off | `POST /onboarding/match` runs the retrieval and pre-scores synchronously (≤10 s), enqueues AI scoring for the top 10, and returns the **real** count. The five progress lines map to real phases of that request (stream events), not to a timer. |
| `confirm` | modal on first `/jobs` visit (S7) | filters.seniority (from resume suggestion), extra taxonomyIds, LinkedIn URL, acquisition source | The CTA marks the step `welcome`. |
| `welcome` | modal (S8) | `RAUserUiState` | Tiles, then `done`. The copilot rail opens once, with dismiss memory. |
| `done` | — | `onboardingCompletedAt` | S9 calibration prompts are FEED/NOTIF features gated by the popup throttle. S10 (profile wizard) = PROF; S11 (extension) = EXT; S12 (agent setup) = AGENT. |

The current `/v2/onboarding/*` endpoints and `SetupPanel` are replaced. `bootstrap`'s deterministic resume seed (`lib/raResumeSeed.ts`) and the `RAOnboardingResumeSeedAgent` are reused by `POST /onboarding/resume` to suggest titles, seniority and skills.

---

## 3. API surface

### 3.1 Conventions (all new endpoints)

- **Mount:** new area routers are mounted by `server/src/features/index.ts` (FND) at `/api/v1/roboapply/<area>`. Public, unauthenticated routes go under `/api/v1/public/<area>`. Webhooks go under `/api/v1/webhooks/<provider>`. Crons go under `/api/v1/cron/*`. The extension API lives at `/api/v1/roboapply/ext/*`.
- **Envelope:** success → `{ success: true, data }`. Error → `{ success: false, code, error, details? }`. `lib/api/client.ts` already unwraps `{data}` and maps codes. New codes: `credits_exhausted` (402, `details: {bucket, resetsAt, upgradable}`), `feature_disabled` (404), `version_conflict` (409, `details: {currentVersion}`), `account_other_brand` (409), `auth_other_brand` (401), `rate_limited` (429, `Retry-After`), `provider_not_configured` (501), `brand_policy` (500, logged).
- **Auth:** `requireAuth` (session cookie / bearer JWT) plus `requireSeekerProfile` is mandatory for every new seeker route. This fixes V2's missing profile gate for new code. Admin routes add `requireAdmin`. Extension routes use `requireExtensionDevice` (§6.3).
- **Validation:** each route parses `req.body` and `req.query` with the zod schemas in `contract.ts`, then returns 422 `invalid_request` with the zod issues.
- **Idempotency:** every credit-consuming POST requires the header `Idempotency-Key` (a uuid the client generates per user intent). The credits service derives the ledger key from it (§7.3).
- **Rate limits:** `rateLimit({key, limit, windowSec})` from `server/src/platform/ratelimit/` is DB-backed (`RARateCounter`) and replaces the in-memory limiter for every route in this document. The existing auth limiter is migrated too (AUTH).
- **Brand:** every handler reads `getCurrentBrand()`. Responses never mix markets. A job, company or contact whose `market` differs from `brand.market` returns 404.

Legend: **Auth** S = seeker session, P = public, X = extension device token, A = admin, W = webhook signature, C = cron secret. **Credits** names the bucket (§7.1) consumed on success; "—" = free.

### 3.2 Brand, auth and account (AUTH)

| Method + path | Auth | Request → response | Credits / limits |
|---|---|---|---|
| GET `/api/v1/public/brand` | P | → `{ id, name, locales, defaultLocale, authMethods, paymentRails, flags }` | cached 5 min |
| GET `/api/v1/roboapply/auth/methods` | P | → `{ methods: AuthMethod[] }` | — |
| POST `/auth/signup` (existing) | P | + `{ marketingOptIn, consents[] (incl. required age_16_plus), attribution }` → `{ user, seekerProfile }`, sets cookie; when the email exists on the other brand: the normal "check your email" response + a cross-brand notice email (no 409) | 5/min/IP, 20/day/IP |
| POST `/auth/login` (existing) | P | → session, or `409 account_other_brand {otherBrandUrl}` **only after the password matches** the other-brand account | 10/min/IP |
| POST `/auth/password/forgot` | P | `{ email }` → 204 always; emails a 30-min `RAAuthToken(password_reset)` | 5/h/email-hash, 20/h/IP |
| POST `/auth/password/reset` | P | `{ token, password }` → session; revokes other sessions | 10/h/IP |
| POST `/auth/email/verify/send` | S | → 204 | 3/h |
| GET `/auth/email/verify?token=` | P | → 302 `/settings#account?verified=1` | — |
| GET `/auth/oauth/google/start?next=` | P | → 302 Google (state = `RAAuthToken(oauth_state)`, PKCE) | RoboApply only |
| GET `/auth/oauth/google/callback` | P | verifies the ID token (Google JWKS) → find or create `User` + `RAAuthIdentity` → cookie → 302 `next` or `/onboarding/mode` | — |
| GET `/auth/oauth/line/start`, `/callback` | P | same pattern (LINE Login v2.1) | RoboApply, `authMethods` includes `line` |
| POST `/auth/phone/send-code` | P | `{ phone, purpose }` → `{ resendInSec }`; SMS through `server/src/platform/sms/` (Aliyun or Tencent; OTP text only, no links, CN-L-07) | 1/60 s/phone, 10/day/phone, 30/day/IP |
| POST `/auth/phone/verify` | P | `{ phone, code }` → session (creates the user on first login; consents required in the body for new users) | 5 wrong codes per OTP |
| GET `/auth/wechat/qr?next=` | P | → 302 `open.weixin.qq.com/connect/qrconnect` (snsapi_login) | GoApply |
| GET `/auth/wechat/callback` | P | code → access token → openid/unionid → user + `RAAuthIdentity` → cookie → 302 | — |
| GET `/auth/me` (existing) | S | + `{ brand, onboarding:{step,path,completed}, entitlements: EntitlementSummary, flags, unreadCount }`; **drops** `mission` (V1) | — |
| POST `/auth/logout` (existing) | P | unchanged | — |
| GET `/account/identities` | S | → linked Google/WeChat/LINE/phone | — |
| DELETE `/account/identities/:id` | S | unlink (refused if it is the last login method) | — |
| GET/POST `/account/consents` | S | list; `{ type, granted, proseVersion }` → record | — |
| Existing `/account/*` | S | unchanged (password, sign-out-all, delete, wipe-data). Wipe and delete now also cover every table in §2 (AUTH extends `SeekerAccountDataWipeService`). | — |

### 3.3 Onboarding, profile, search profiles (ONB, PROF, PREF)

| Method + path | Auth | Request → response | Credits |
|---|---|---|---|
| GET `/onboarding/state` | S | → `{ step, path, entry, answers }` | — |
| PUT `/onboarding/steps/:step` | S | step-specific body → `{ nextStep }` (idempotent upsert) | — |
| GET `/onboarding/title-suggest?q=` | S | ≥2 chars → `[{taxonomyId, label, level, tooGeneral}]` (taxonomy + synonyms) | 60/min |
| GET `/onboarding/market-snapshot?taxonomyId&country` | S | → `{ medianSalary?: Sourced, topIndustries: Sourced[], topSkills: Sourced[], sampleSize, windowDays }`; 6 h cache | — |
| POST `/onboarding/resume` | S | `{ resumeVariantId }` → `{ suggestedSeniority[], suggestedTaxonomyIds[], profileDraft }` | — |
| POST `/onboarding/match` | S | → SSE phases `reading → preferences → profile → searching → ranking`, then `{ jobCount, topJobIds[] }` | — |
| POST `/onboarding/confirm` | S | `{ seniority[], extraTaxonomyIds[], linkedinUrl?, acquisitionSource?, note? }` → `{ step:'welcome' }` | — |
| POST `/onboarding/complete` · POST `/onboarding/skip` | S | → `{ step }` | — |
| GET `/profile` · PATCH `/profile` | S | `RAProfile` view (+ completeness, missing fields) | — |
| POST/PATCH/DELETE `/profile/education[/:id]` · `/profile/experience[/:id]` | S | rows | — |
| PUT `/profile/skills` | S | `[{name, group?, confirmed}]` | — |
| GET/PUT `/profile/sensitive` | S | EEO answers (RoboApply) or CN sensitive fields (GoApply), encrypted at rest; `GET` returns them only to the owner | — |
| POST `/profile/sync-from-resume` | S | `{ variantId }` → `{ diff }` (preview) | — |
| POST `/profile/sync-from-resume/apply` | S | `{ variantId, accept: fieldPaths[] }` → profile | — |
| GET `/search-profiles` | S | → profiles (creates the default from legacy prefs on first call, §2.8) | — |
| POST `/search-profiles` | S | `{ name, filters }` → profile (cap = entitlement `savedProfilesMax`) | — |
| PATCH `/search-profiles/:id` | S | `{ baseVersion, filters?, name?, alertInstantMax?, alertDigest? }` → profile, or `409 version_conflict` | — |
| POST `/search-profiles/:id/activate` · DELETE `/search-profiles/:id` | S | (cannot delete the last one or the default) | — |
| POST `/search-profiles/count` | S | `{ filters }` → `{ count, capped }` | 30/min |
| GET `/search-profiles/:id/limiting` | S | zero-results diagnostics → `[{field, value, removalGain: count}]` (each candidate relaxation measured with a count query) | 10/min |
| GET `/taxonomy?locale&q` | S/P | taxonomy subtree with localized labels | cached |
| GET `/api/v1/public/preferences/manage?token=` · PATCH (same) | P (magic link) | the passive-candidate page (F-ACCT-07), using `RAAuthToken(magic_prefs)` | 10/h/token |

### 3.4 Feed, jobs, companies, match (FEED, JOB, MATCH, INGEST)

| Method + path | Auth | Request → response | Credits |
|---|---|---|---|
| POST `/feed/query` | S | `{ searchProfileId?, sort, q?, overrides?: Partial<FilterSet>, cursor? }` → `{ items: FeedItem[], cursor, endOfFeed, hiddenByTier, sessionId }` | 60/min; refresh with no cursor 20/10 min (Jobright's 43004-style limit, with a polite message) |
| GET `/feed/counts` | S | → `{ forYou, saved, external, applied }` | — |
| POST `/feed/jobs/:id/hide` | S | `{ reasonCode, detail? }` → `{ proposedFilterDiff? }` | — |
| POST `/feed/jobs/:id/unhide` | S | → 204 | — |
| POST `/feed/jobs/:id/report` | S | `{ reason, note? }` → 204 | 20/day |
| POST `/feed/impressions` | S | `{ sessionId, positions:[{jobId, position, ms}] }` (beacon, batched) | — |
| POST `/feed/rating` | S | `{ score, reasons[], note? }` → 204 (one per day) | — |
| GET `/feed/explore` | S | → L1 categories with live counts | cached 10 min |
| GET `/jobs/:id` | S | → `{ job: JobDetail, company: CompanySummary, fit: FitView \| null, tracker, similarIds[], autofill: { supported, atsType } }` (replaces `/v2/jobs/:id`) | — |
| POST `/jobs/:id/score` | S | `{ resumeVariantId?, force? }` → `{ fit: FitView }` (scorer v3) | platform-paid; 80/day/user |
| GET `/jobs/:id/similar` | S | → `FeedItem[]` (same taxonomy L3 + country, excluding hidden) | — |
| POST `/jobs/:id/save` · DELETE `/jobs/:id/save` | S | tracker `bookmarked` upsert/delete | — |
| POST `/jobs/:id/apply-click` | S | → `{ applyUrl, atsType, extensionSupported }`; records `applyClickedAt`, moves the tracker to `applied` **immediately with undo** (ruling R1) | — |
| POST `/jobs/:id/applied` · DELETE `/jobs/:id/applied` | S | mark or undo (the "Did you apply?" correction) | — |
| POST `/jobs/:id/share` | S | → `{ url }` (public page if `publicDisplay`, else an app link) | — |
| POST `/jobs/import` | S | `{ url }` or `{ manual: { title, company, description, applyUrl?, location? } }` → `{ importId }`; the work runs in the request (Firecrawl scrape → enrich), ≤60 s; hosts on `IMPORT_FETCH_DENYLIST` (LinkedIn, Indeed, Glassdoor, BOSS直聘, 智联, 猎聘, 51job, 脉脉, 104, 1111, Cake, Yourator) are never fetched → `needs_text`; no Firecrawl for GoApply when `DEPLOY_REGION=cn-mainland` | `job_import`; 10/h, a 1 h lock after 20 failures |
| GET `/jobs/import/:importId` | S | → `{ status, jobId?, missingFields[] }` | — |
| GET `/companies/:idOrSlug` | S/P | → `CompanyProfile` (every fact `Sourced`; funding block absent unless `flags.companyFunding`) | — |
| GET `/companies/:id/h1b` | S/P | → `{ years: [{fiscalYear, certifiedCount, medianWage: Sourced}], disclaimer }` (RoboApply, `flags.h1bHistory`; DOL LCA) | — |
| GET `/companies/:id/jobs` | S/P | → live canonical jobs | — |
| POST `/match/jobs/:id/fit-analysis` | S | → `FitAnalysisCard` (dimension evidence, aligned vs missing skills, education, highlights) | `fit_analysis` |
| POST `/match/competitiveness` | S | `{ searchProfileId }` → `RAFitReport` (§5.3 honesty rules) | `competitiveness` |
| GET `/match/competitiveness/latest` | S | → report or null | — |
| GET `/api/v1/public/feed?role&city&country` | P | visitor list (20 items, no fit, `publicDisplay` jobs only) | cached 15 min, 60/min/IP |

### 3.5 Copilot (COP), detailed in §5

| Method + path | Auth | Request → response | Credits |
|---|---|---|---|
| GET `/copilot/threads` · POST `/copilot/threads` | S | list; `{ contextJobId? }` → thread | — |
| GET `/copilot/threads/:id/messages?before=` | S | → messages (with cards) | — |
| POST `/copilot/threads/:id/messages` | S | `{ text, chip?, contextJobId? }` → **SSE** (`meta`, `delta`, `tool`, `card`, `error`, `done`) | `copilot_message` (1 per user turn) |
| POST `/copilot/proposals/:id/apply` | S | → `{ applied, result }` (credit actions consume their own bucket here) | per action |
| POST `/copilot/proposals/:id/dismiss` | S | → 204 | — |
| POST `/copilot/messages/:id/feedback` | S | `{ value:'up'|'down', note? }` | — |
| GET `/copilot/memory` · DELETE `/copilot/memory/:id` | S | user-visible memory | — |
| DELETE `/copilot/threads/:id` | S | archive | — |
| POST `/api/v1/public/copilot` | P | `{ text, pageContext }` → SSE (visitor copilot: no persistence, limited tools) | 10/h/IP, 30/day/IP |

### 3.6 Resume suite and cover letters (RES, CL)

These extend `/api/v1/roboapply/v2/resumes` (RES keeps the existing paths, so `useResumes` keeps working).

| Method + path | Auth | Request → response | Credits |
|---|---|---|---|
| POST `/v2/resumes/:id/grade` | S | `{ targetTitle? }` → `{ gradeId }`; runs in the request (≤45 s); on failure → release | `resume_grade` |
| GET `/v2/resumes/:id/grade/latest` | S | → `RAResumeGrade` | — |
| POST `/v2/resumes/grades/:gradeId/cancel` | S | → released | — |
| POST `/v2/resumes/:id/issues/:issueId/fix` | S | `{ instruction?, variant:'ai'|'longer'|'shorter'|'stronger' }` → `{ suggestions[] }` | `resume_fix` |
| POST `/v2/resumes/:id/keyword-report` | S | `{ jobId }` or `{ jd: {title, company, text} }` → `{ score10, rows:[{label, status:'pass'|'warn'|'fail', detail}], keywords:{matched[], missing[]}, hardSkills:{matched[], missing[]} }` (deterministic + `RAKeywordExtraction`) | — |
| POST `/v2/resumes/tailor-sessions` | S | `{ baseVariantId, jobId \| jd, mode, sections[], customPrompt?, keywords[] }` → `RATailorSession` (`status: review`, claims pending) | `tailor` |
| PATCH `/v2/resumes/tailor-sessions/:id/claims/:claimId` | S | `{ status:'kept'|'removed'|'edited', text? }` | — |
| POST `/v2/resumes/tailor-sessions/:id/finalize` | S | → variant; `409 unverified_claims` while any claim is pending | — |
| PATCH `/v2/resumes/:id/layout` | S | `layout` → variant | — |
| GET `/v2/resumes/:id/export?format=pdf\|docx&nameStyle=` | S | existing; refuses when `unverifiedClaims > 0`; records an `RAApplicationArtifact` when `trackerEntryId` is passed. **Move** the raw-URL builder out of `lib/resumeDownload.ts` into `lib/api/resumes.ts` (AGENTS rule). | — |
| GET `/cover-letters` · POST `/cover-letters` | S | list; `{ jobId \| jd, resumeVariantId, tone, length }` → letter | `cover_letter` on POST |
| GET/PATCH/DELETE `/cover-letters/:id` | S | edit body (a version is snapshotted) | — |
| POST `/cover-letters/:id/rewrite` | S | `{ instruction }` → new version | 20/day/letter, otherwise free |
| POST `/cover-letters/:id/restore` | S | `{ versionIndex }` | — |
| GET `/cover-letters/:id/export?format=` | S | PDF/DOCX through `lib/resumeExport.ts` renderers (CJK fonts) | — |

### 3.7 Tracker, network, agent (TRK, NET, AGENT)

| Method + path | Auth | Request → response | Credits |
|---|---|---|---|
| GET `/v2/tracker` (existing, extended) | S | + `view=stage\|date`, `q`, `source` | — |
| PATCH `/v2/tracker/:id` (extended) | S | + `outcome`, `stageDetail`, `interviewAt`, `offer`; writes an `RATrackerEvent` per change | — |
| GET/POST `/v2/tracker/:id/events` | S | timeline; add a note | — |
| GET `/v2/tracker/:id/artifacts` | S | exact files sent | — |
| GET `/v2/tracker/follow-ups` | S | `[{entryId, reason:'no_reply_10d'|'interview_tomorrow'|'deadline_soon'}]` (facts; ruling C11) | — |
| GET `/v2/tracker/export.csv` | S | CSV | 5/day |
| GET `/network/jobs/:id/connections` | S | → `{ fromYourCompanies: Contact[], fromYourSchools: Contact[], recruiters: Contact[], searchLinks: [{label, url}] }` | — |
| POST `/network/imports/linkedin-connections` | S | multipart `Connections.csv` (the user's own LinkedIn data export) → `{ rowCount, importedCount }` | 3/day |
| GET/POST/DELETE `/network/contacts[/:id]` | S | user-owned contacts | — |
| POST `/network/outreach-drafts` | S | `{ contactId?, jobId, channel }` → draft | `outreach_draft` |
| PATCH `/network/outreach-drafts/:id` · POST `.../:id/copied` · POST `.../:id/sent` | S | edit; mark copied or sent (the product never sends) | — |
| POST `/network/contacts/:id/lookup-email` | S | `501 provider_not_configured` until `CONTACT_EMAIL_PROVIDER` is set and `flags.contactEmailLookup` (RoboApply only) | `contact_lookup` |
| GET/PUT `/agent/settings` | S | `RAAgentSettings` | — |
| GET `/agent/setup` | S | → `{ step, checks: { profileMissing[], calibrationDone, reportReady, extensionConnected } }` | — |
| POST `/agent/setup/calibration` | S | `{ jobId, verdict, note? }` (3 required) | — |
| GET `/agent/suggestions` | S | top-fit jobs not yet queued | — |
| GET/POST `/agent/queue` | S | list by state; `{ jobIds[] }` → items | ≤50 active items |
| POST `/agent/queue/:id/prepare` | S | → returns a **credit proposal** (`{bucket, cost}` for tailor and letter per settings); on confirm the work runs | `tailor` / `cover_letter` on confirm |
| POST `/agent/queue/:id/confirm` | S | `{ part:'resume'|'letter', decision:'use'|'revise', instruction? }` | — |
| POST `/agent/queue/:id/open` | S | → `{ applyUrl, handoff: { jobId, variantId, coverLetterId } }`; state `opened` **and the tracker entry moves to `applied` at once** (same path as `apply-click`, ruling C11) | — |
| POST `/agent/queue/:id/undo-applied` | S | reverts the tracker status ("Undo · I didn't apply") | — |
| POST `/agent/queue/:id/applied` · `/skip` · DELETE | S | user-declared outcome | — |
| GET/PUT `/agent/answers` | S | answer bank | — |

### 3.8 Extension API (EXT), detailed in §6

| Method + path | Auth | Request → response | Credits |
|---|---|---|---|
| POST `/ext/devices` | S | `{ name, browser, extVersion }` → `{ deviceId, token }` (raw token returned once) | 5/day |
| GET `/ext/devices` · DELETE `/ext/devices/:id` | S | list; revoke | — |
| POST `/ext/pair-codes` | S | → `{ code (8 chars), expiresAt (+10 min) }` | 10/h |
| POST `/ext/pair-codes/redeem` | P | `{ code, name, browser, extVersion }` → `{ token }` | 10/h/IP |
| GET `/ext/me` | X | → `{ user, brand, entitlements, flags, profileCompleteness }` | — |
| GET `/ext/autofill-profile` | X | → `AutofillProfile` (profile, education, experience, links, work auth, answer bank; EEO/CN sensitive only with consent `autofill_sensitive`) | — |
| POST `/ext/page-job` | X | `{ url, title, company, location?, descriptionText }` → `{ jobId?, fit?: FitView \| PreFitView }` (match on other boards, one scoring service, F-EXT-06) | 120/day |
| POST `/ext/jobs/save` | X | same body → tracker entry (`source:'extension'`, a private `RAJob` when unmatched) | 100/day |
| POST `/ext/autofill-runs` | X | `{ host, atsType, url, jobId?, fieldsTotal }` → `{ runId }` (**reserves** an `autofill` credit) | `autofill` |
| PATCH `/ext/autofill-runs/:id` | X | `{ fieldsFilled, outcome, userMarkedSubmitted? }` → commits (fieldsFilled > 0) or releases; `userMarkedSubmitted` → tracker `applied` with `appliedVia:'extension'` | — |
| POST `/ext/answers` | X | `{ runId, question, fieldType, maxLength?, options?[] }` → `{ answer, source:'bank'|'ai', saveable }` (bank hit = free). Protected question types (work authorization, sponsorship, criminal history, EEO/disability/veteran, salary history/expectation, years of experience, degrees, certifications, clearance, notice period) never return `source:'ai'` | `ai_answer` on an AI answer |
| POST `/ext/resume-for-job` | X | `{ jobId, runId }` → `{ variantId, isTailored, fileName, downloadUrl (signed, 5 min) }` | — |
| GET `/ext/files/:signedToken` | X | file bytes; records an `RAApplicationArtifact` | — |
| POST `/ext/site-requests` | X | `{ host, url, note? }` | 10/day |
| POST `/api/v1/public/ext/uninstall-survey` | P | `{ reasons[], note? }` → `RASurveyResponse` | 5/day/IP |

### 3.9 Credits, billing, notifications, growth, prep, SEO, CN, admin

| Method + path | Auth | Request → response | Credits |
|---|---|---|---|
| GET `/credits` | S | → `{ buckets: [{bucket, cap \| 'unlimited', used, reserved, bonus, resetsAt, window}], plan }` | — |
| GET `/credits/history?cursor` | S | ledger (committed) | — |
| GET `/billing/plans` | S/P | brand catalog with prices (from config) | — |
| POST `/billing/checkout` | S | `{ planKey }` → Stripe `{ url }` (RoboApply) or `{ orderId, payUrl \| qrCodeUrl }` (GoApply, `rail` chosen in the body from `brand.paymentRails`) | — |
| POST `/billing-cn/wechatpay` (new prefix; legacy `/billing` routes untouched) | S | `{ planKey \| purpose, relatedId? }` → `{ orderId, codeUrl }` (Native QR) or JSAPI params inside WeChat | flag `WECHATPAY_ENABLED` |
| POST `/api/v1/webhooks/wechatpay` | W | WeChat Pay v3 notify (AES-GCM resource decrypt + platform-cert signature verify) → idempotent completion on `AlipayOrder(channel:'wechatpay')` | — |
| Existing `/billing/*` | S | `plan`, `credits`, `alipay`, `alipay/callback`, `portal`, `cancel`, `history`, `invoices` (brand-locked rails; `alipayConfigured` bug fixed) | — |
| GET `/notifications?cursor` · GET `/notifications/unread-count` | S | message center | — |
| POST `/notifications/:id/read` · POST `/notifications/read-all` | S | — | — |
| POST `/notifications/:id/respond` | S | invitation reply `{ interested, form? }` (flag `invitations`) | — |
| GET `/push/vapid-public-key` · POST `/push/subscriptions` · DELETE `/push/subscriptions/:id` | S | web push (RoboApply only) | — |
| GET `/announcements/next` · POST `/announcements/:id/seen` | S | one announcement at most, popup-throttled | — |
| GET/PATCH `/ui-state` | S | tours, dismissals, popup timestamps | — |
| GET/POST `/api/v1/public/email/unsubscribe?token=` | P | one-click unsubscribe (RFC 8058 `List-Unsubscribe-Post`) + optional survey | — |
| GET `/referrals` | S | → `{ code, link, invites:[{status, at}], rewards }` | — |
| POST `/api/v1/public/events` | P/S | `{ anonId, events:[{name, props, path, at}] }` (≤50 per batch) | 120/min/anon |
| GET `/interview-bank/companies?q` · GET `/interview-bank/companies/:slug/questions?category&seniority&cursor` | S | lists (`sourceKind` shown on each item) | — |
| GET `/interview-bank/questions/:id` | S | → question + guide (AI guide generated on first view, labelled) | free; 30/day guide generations |
| POST `/interview-bank/contributions` · POST `/interview-bank/questions/:id/report` | S | moderated | 10/day |
| GET `/coaching/coaches` · GET `/coaching/coaches/:id/slots` | S | approved coaches only (flag `coaching`) | — |
| POST `/coaching/bookings` | S | `{ slotId, durationMin, topic, resumeVariantId?, contact }` → holds the slot for 15 min + checkout | — |
| GET `/coaching/bookings` · POST `/coaching/bookings/:id/cancel` | S | refund tiers per the published policy | — |
| POST `/coaching/apply` · GET/POST `/coaching/me/slots` | S | coach side | — |
| GET `/api/v1/public/seo/page?type&slug&locale` | P | → `RASeoPage` + up to 30 `PublicJobCard` (`publicDisplay` only); `Cache-Control: public, s-maxage=900, stale-while-revalidate=86400` | — |
| GET `/api/v1/public/seo/jobs/:id` | P | public job detail (only `publicDisplay` and canonical; 410 when closed) | same cache |
| GET `/api/v1/public/seo/sitemap/:part` | P | URL list for a sitemap partition | s-maxage 3600 |
| POST `/api/v1/public/tools/resume-check` | P | multipart resume + optional posting text → keyword/format report (parse via GoHire; nothing persisted beyond a 24 h hash cache) | 3/day/IP |
| GET `/cn/campus-events?class&company` | S/P | GoApply campus calendar | — |
| `/v2/admin/*` additions | A | `ingest` (queries, provider usage, run now), `queue` (depth, dead items, retry), `moderation/questions`, `coaches`, `campus-events`, `announcements`, `entitlement-overrides`, `reports` (job reports) | — |
| `/api/v1/webhooks/robohire/invitation` | W (HMAC `ROBOHIRE_INVITE_SECRET`) | recruiter invitation → `SeekerNotification(category:'invitation')` (flag `invitations`) | — |

### 3.10 Rate-limit defaults (config `RATE_LIMITS`, `server/src/platform/ratelimit/defaults.ts`)

| Key | Limit |
|---|---|
| signup per IP | 5/min, 20/day |
| login per IP | 10/min |
| OTP per phone / per IP | 1 per 60 s, 10/day / 30/day |
| password reset per email | 5/h |
| feed refresh (no cursor) | 20 per 10 min |
| copilot messages | the `copilot_message` bucket + 10/min burst |
| visitor copilot per IP | 10/h, 30/day |
| job import per user | 10/h; 20 consecutive failures → 1 h lock; 3 locks in 7 days → 7-day lock (F-TRK-04) |
| public tools per IP | 3/day |
| extension device token | 600 requests/h |
| events per anonId | 120/min |
| any authenticated route | 600/min/user (global guard) |

---

## 4. Job ingestion and matching pipeline

### 4.1 Problems being fixed (from the maps)

1. `RAJob` is written only by the unused cross-bank `/discover/run`. RapidAPI results are never saved.
2. `RAJobIndexService.search` loads every matching row with no `take` and paginates in memory (`:208`).
3. The browser fires one `POST /jobs/:id/score` per card.
4. `signals.location` is 95 or 80, `signals.salary` is 85, and `signals.experience` equals the total (`routes/jobs.ts:348-357`).
5. `RAKeywordExtraction` is never written.
6. Not Interested is client-local and forgotten on reload.

### 4.2 Providers per brand

| Brand | Providers (priority) | Countries | Notes |
|---|---|---|---|
| RoboApply | `activejobs` (10, ATS-direct) → `bank_robohire` (15, exclusive) → `linkedin` (20) → `jsearch` (30, `/search-v2`) | Demand-driven over `brand.countries`; TW included | One `RAPID_API_KEY`; each API must be subscribed on app 8974502. The existing clients `raRapidApiJobs.ts` and `raFantasticJobs.ts` are reused as fetchers. When the subscribed Active Jobs DB plan returns its AI-enrichment fields (experience level, key skills, work arrangement, visa sponsorship), INGEST maps them first and skips the LLM for those fields. TW salary rule TW-03 applies in normalization. |
| GoApply | `bank_gohire` (15, exclusive) → `user_import` (private) | CN | No external provider by default (CN-L-04 licensing). `CN_EXTERNAL_PROVIDERS=jsearch` can enable JSearch with `country=cn` for testing only. Never scrape BOSS/智联/猎聘/51job. `bank_gohire` must use TLS (CN-E-05). `GOHIRE_PUBLIC_JOB_BASE_URL` is corrected to `https://www.gohire.top`. |

Bank ingestion reuses `raBankProviders.searchBank` but **without** the LLM explorer. It is a cursor sync over the recruiter `Job` rows (`status='open' AND publishedAt IS NOT NULL`, `updatedAt > cursor` — drafts and private jobs never sync), stored as one `RAIngestQuery` per bank (`origin='bank_sync'`, `params.cursor`). The cross-tenant guard `RA_CROSSBANK_CROSS_TENANT_CONFIRMED` still applies. Bank jobs get `fromRecruiterBank = true`, `employerVerified` from the bank's verified-employer field, `market` from the bank, and `applyUrl` from `synthesizeApplyUrl`. A bank job gets `publicDisplay = true` only when the bank records the employer's consent to syndicate (OPS-A4).

### 4.3 Query planner (demand-driven)

`server/src/features/jobs/ingest/planner.ts`, run by `jobs-plan` daily at 02:00 UTC:
1. Collect `(market, primary taxonomy L3 label in English, country, city | remote)` from the **default** search profile of every user active in the last 14 days. Each tuple's `demandScore` = number of users.
2. Add SEO seed tuples: the top 300 taxonomy roles × the top cities per country, for SEO page inventory.
3. Upsert `RAIngestQuery` per provider that supports the country. Refresh interval = 6 h when `demandScore ≥ 5`, 12 h when ≥1, 24 h for seeds. `consecutiveEmpty ≥ 4` doubles the interval up to 7 days.
4. Disable queries for taxonomy/location pairs nobody has used in 30 days (except seeds).

### 4.4 Fetch → normalize → upsert (deterministic)

`jobs-ingest` cron, every 10 minutes:
- Lease up to N due `RAIngestQuery` rows with `UPDATE … SET nextRunAt = now() + interval '15 min' … WHERE id IN (SELECT id … FOR UPDATE SKIP LOCKED LIMIT N) RETURNING *`.
- Check the provider's daily budget in `RAProviderUsage` (env `INGEST_<PROVIDER>_DAILY_CALLS`; defaults activejobs 300, linkedin 150, jsearch 200).
- Run under a **240 s wall budget** (the function limit is 300 s).

Normalization (`server/src/features/jobs/normalize/*`, pure functions, 100% unit-tested):

| Field | Rule |
|---|---|
| `titleNormalized`, `companyNameNormalized` | NFKC, lowercase, strip seniority/location noise and legal suffixes (Inc, Ltd, 有限公司). |
| `taxonomyIds` | Dictionary match of the normalized title against taxonomy synonyms (L3 → L2 → L1). Unmatched rows are left for enrichment. |
| `seniority`, `minYears`/`maxYears`, `roleType` | Regex on title and description (`(\d+)\+?\s*(years|yrs|年)`, `intern|new grad|应届`, `senior|sr\.|资深`, `staff|principal|lead`, `manager|head of|director|vp|总监`). |
| Location | Parse to city, region, country using the static GeoNames `cities15000` subset at `server/src/features/jobs/geo/cities.json` (CC-BY; attribution in `/legal`). `geoLat`/`geoLng` from the table. `workModel` is set **only** when the provider or posting states it; otherwise null (the existing "unknown, never onsite" rule). |
| Salary | Keep the stated min/max/currency/period. Annualize into `salaryAnnualMin`/`Max` in the same currency. Text-derived salaries set `salarySource='posting_text'`. TW: 面議 → not disclosed, unless the posting gives a figure ≥ NT$40,000 (TW-03). CN: "15-25K·14薪" → monthly 15000–25000, `salaryMonths=14`. |
| `atsType` | From `applyUrl` host patterns (`boards.greenhouse.io`, `job-boards.greenhouse.io`, `jobs.lever.co`, `*.myworkdayjobs.com`, `jobs.ashbyhq.com`, `jobs.smartrecruiters.com`, `*.icims.com`, `apply.workable.com`, `*.taleo.net`, `*.successfactors.*`, `app.mokahr.com`, `*.zhiye.com`, `*.jobs.feishu.cn`, `*.dayee.com`). |
| `isAgency` | Company in `server/src/features/jobs/data/staffing-agencies.json`, or keywords "staffing", "recruitment agency", "猎头", "人力资源服务" in the company name. |
| `dedupeKey` | `sha1(companyNameNormalized + '|' + titleNormalized + '|' + (city ?? remoteScope ?? country))`. |
| `expiresAt` | Provider expiry when given; else `postedAt + 45 days`; bank jobs: none (closed by sync). |
| `searchText` | `titleNormalized + ' ' + companyNameNormalized + ' ' + top skills`. |
| `publicDisplay` | `true` only for providers listed in `PUBLIC_DISPLAY_PROVIDERS` (**default empty**), and for bank jobs only with recorded syndication consent, §9.4. |

**Upsert** uses one raw SQL statement per batch of 100: `INSERT … ON CONFLICT ("externalId","sourceBoard") DO UPDATE SET "lastSeenAt" = now(), …changed fields…`. It returns `(id, xmax = 0 AS inserted)` so new rows can be counted. Then:
- **Dedupe:** for the batch's `dedupeKey`s, pick the canonical row per key (lowest `sourcePriority`, then most recent `postedAt`). Set `isCanonical`/`canonicalJobId` on the others (`closeReason='duplicate'` is not set; duplicates stay live as alternates).
- **Company:** upsert `RACompany` on `(market, nameNormalized)`, write `logoUrl` and the provider's organization fields with provenance into `facts`, then set `companyId`.
- **Enqueue** `RAWorkItem{kind:'job.enrich', dedupeKey:'job.enrich:<id>:v<ver>'}` for new or materially changed rows.

### 4.5 Enrichment (LLM-light)

Drained as `job.enrich` work items by `queue-drain` (every 5 minutes), plus `waitUntil` after an ingest tick. Budget: env `ENRICH_DAILY_JOBS` (default 8,000 per market). Concurrency 10. Max 300 jobs per tick.

1. Skip the LLM when deterministic coverage is complete (taxonomy, seniority, and skills ≥5 from provider fields).
2. Otherwise make **one** structured call per job, `getTaskModel('enrich')` (a cheap model; CN profile uses DeepSeek or Qwen via `newapi`). Input: title, company, `descriptionPlain` truncated to 6,000 chars. Output (zod-validated JSON):
   - `taxonomyId` (from a provided candidate list of ≤15 ids preselected by keyword overlap, so the model cannot invent ids)
   - `seniority`
   - `skills[{skill, kind, required}]` (≤15)
   - `sponsorship{status: 'offered'|'not_offered'|'not_stated', quote}`. The quote must be a substring of the description; otherwise it is dropped (CitationGuard pattern). `not_offered` additionally needs a negation keyword in the quote (per-language list); without one the status falls back to `not_stated`. UI badges and filter tooltips show the quote itself.
   - intl scam signals (rule-based, `scamSignals.ts`): fees, "pay to apply", messaging-app-only contact → quote-backed `fraudFlags`; flagged jobs leave Recommended and enter the admin "Reports to review" list.
   - `citizenshipRequired`, `clearanceRequired`, each with a quote rule
   - `summary` (≤2 sentences, in the job's language)
   - `educationLevel`
   - CN only: `employerTags` with a quote
3. Write the fields, `enrichedAt`, `enrichVersion`, `enrichModel`, and the `RAKeywordExtraction` row (top 30 keywords from skills plus TF-IDF over the description).
4. Log cost to `UsageDeductionLog` with SKU `ra_job_enrich` and `userId` = the system user for the brand (`RA_SYSTEM_USER_ID_<BRAND>`).

### 4.6 Scheduling on Vercel (limits honoured)

- Vercel Cron runs at most once per minute per entry, may deliver a call twice, and each call is bounded by `maxDuration` (300 s here). Every handler is therefore **idempotent**, **lease-based** and **time-boxed at 240 s** through `server/src/platform/queue/runForBudget.ts`.
- `server/src/platform/queue/` (FND) provides:
  - `enqueue(kind, payload, {dedupeKey, runAfter, priority})`
  - `drain(kinds, {budgetMs, concurrency})`, which leases with `FOR UPDATE SKIP LOCKED`, sets `leasedUntil = now() + 5 min`, and retries with exponential backoff up to `maxAttempts`, then marks the item `dead`
  - a handler registry: each area registers handlers in `server/src/features/<area>/workers.ts`, imported by `server/src/platform/queue/registry.ts` (FND writes the import list)
- Request-time kick: `waitUntil(drain([...], { budgetMs: 20_000 }))` from `@vercel/functions` (added by FND). Off Vercel it is a no-op, and the cron completes the work.

**Final `vercel.json` cron set** (FND writes all entries with stub handlers; CLEAN deletes the V1 ones):

| Path | Schedule | Owner | Work |
|---|---|---|---|
| `/api/v1/cron/interview-reconcile` | `*/10 * * * *` | Wave 0 / CLEAN | `reconcileInterviewSessions` (moved off `/digest` and `/catchup`) |
| `/api/v1/cron/jobs-plan` | `0 2 * * *` | INGEST | planner |
| `/api/v1/cron/jobs-ingest` | `*/10 * * * *` | INGEST | fetch/normalize/upsert |
| `/api/v1/cron/queue-drain` | `*/5 * * * *` | FND (platform) | drains `job.enrich`, `job.score`, `resume.grade`, `email.send`, `seo.rebuild` |
| `/api/v1/cron/jobs-maintain` | `30 3 * * *` | INGEST | expire/archive, dedupe repair, release stale credit reservations, prune `RAFeedSession`/`RARateCounter`/`RAProductEvent` (>180 d) |
| `/api/v1/cron/score-precompute` | `*/15 * * * *` | MATCH | §4.7 |
| `/api/v1/cron/job-alerts` | `*/15 * * * *` | NOTIF | §8.2 |
| `/api/v1/cron/reminders` | `0 * * * *` | TRK/NOTIF | follow-up and interview reminders |
| `/api/v1/cron/seo-rebuild` | `0 4 * * *` | SEO | `RASeoPage` stats + revalidate tags |
| `/api/v1/cron/billing-renewal-reminder` | `0 6 * * *` | CRED (existing) | runs per user inside `runWithBrand` |
| `/api/v1/cron/billing-friday-nudge` | `0 16 * * 5` | CRED (existing) | same |
| `/api/v1/cron/account-purge` | `0 4 * * *` | AUTH (existing) | must purge the new tables' R2 artifacts (`RAApplicationArtifact.storageKey`) |

Removed by CLEAN: `daily-matcher`, `digest`, `submitter`, `catchup`, `cache-cleanup`.

### 4.7 Scoring: pre and AI, real dimensions

**Rubric** (ruling C6; weights are config `MATCH_WEIGHTS`): title and level 35, skills 30, industry experience 15, location/pay/visa ("logistics") 10, career path 10.

**Pre-score** (`server/src/features/match/preScore.ts`, deterministic, about 0.1 ms per job; computed for every retrieved candidate):

| Dimension | Pre computation |
|---|---|
| title_level | taxonomy overlap (same L3 = 1.0, same L2 = 0.6, same L1 = 0.3) × seniority distance factor (0 levels = 1, 1 = 0.7, 2 = 0.3, else 0); unknown seniority = factor 0.8 |
| skills | `|job.skills ∩ user.skills| / min(|job.skills|, 10)`; user skills = profile skills ∪ the primary resume's parsed skills |
| industry | job company industries ∩ the industries of the user's past employers (profile/resume); unknown = `not_stated` |
| logistics | **deterministic, also used by the AI score:** location (within radius / remote match / country match), pay (job annual max ≥ user min in the same currency; undisclosed = `not_stated`), visa (if the user needs sponsorship: `offered` = 1, `not_offered` = 0, no statement = `not_stated`). Never a constant. |
| career_path | `not_stated` in pre |

Dimensions with `not_stated` drop out, and the remaining weights are renormalized. The UI shows "Not stated in the posting" for each one.

**AI score — scorer v3** (`RAJobMatchScorerAgent`, MATCH rewrites its prompt and schema; model `getTaskModel('matching')`):
- Input: resume markdown (PII-stripped: name, email, phone and address removed), job fields, the **pre-computed logistics dimension**, and the user's targets.
- Output: `{ dimensions: { title_level, skills, industry, career_path }: {score 0-100, evidence:[{text, source:'resume'|'posting'}] (≤3)}, strengths ≤5, gaps ≤5, keywordsMatched ≤10, keywordsMissing ≤10, summary ≤400 chars, second person, no number }`.
- **The server computes the total** as the weighted sum including deterministic logistics. The LLM never emits the total.
- Tier: great ≥ 85, good 70–84, possible 50–69, unlikely < 50 (config).
- Evidence strings must be substrings, after whitespace normalization, of the resume or posting. Otherwise they are dropped (CitationGuard).
- The cache key stays `(userId, jobId, resumeVariantId)` with hash and model checks, plus `searchProfileVersion` for logistics staleness. A logistics-only change recomputes the total without an LLM call.
- `routes/jobs.ts` stops synthesizing `signals`. The response returns `dimensions`.

**Precompute** (`score-precompute` cron):
- Users with `lastActiveAt` in the last 7 days, ordered by recency.
- For each: retrieval on the default profile, then the top 25 by pre-score that have no fresh AI score; enqueue `job.score`.
- Per-user cap `SCORE_PRECOMPUTE_PER_USER_DAY` (25); global cap `SCORE_DAILY_BUDGET_<BRAND>` (default 20,000 calls) in `RARateCounter`. The AI score is a platform cost, not a user credit.
- On-demand: opening a job detail scores it if needed (per-user cap 80 per day; beyond it, the detail shows the pre-score with a "Quick estimate" label).

### 4.8 Feed query (indexed, paginated)

`server/src/features/feed/FeedQueryService.ts`:
1. **Retrieval.** One parameterized SQL query via `prisma.$queryRaw` over `RAJob`:
   - `market = brand.market`, `isCanonical`, `archivedAt IS NULL`, `visibility='public' OR ownerUserId = me`
   - filter predicates on indexed columns: `taxonomyIds && $ids`, `workModel = ANY`, `employmentType = ANY`, `seniority = ANY`, country/city or geo radius (bounding box, then haversine), salary floor (same currency `salaryAnnualMax ≥ min`, or include undisclosed when the toggle is on), `postedAt ≥ now() - window`, `isAgency IS NOT TRUE` when excluded, `skills && $skills` when required, `NOT (skills && $excludedSkills)`, `companyNameNormalized <> ALL($excluded)`, `sponsorship <> 'not_offered'` when `needsSponsorship`, and trigram `searchText % $q` when `q` is set
   - `NOT EXISTS (SELECT 1 FROM "RAJobUserState" s WHERE s."userId"=$me AND s."jobId"=j.id AND s."hiddenAt" IS NOT NULL)`
   - `ORDER BY "postedAt" DESC LIMIT 400` within a window. The window starts at 14 days; if fewer than 60 rows come back, widen it to the filter's window or 45 days.
2. **Ranking in process.** Pre-score all candidates; join cached AI scores (one `SELECT` by `jobId IN`).
   - `fit = ai ?? (pre - 5)`, so verified scores are preferred.
   - Recommended: `rank = 0.55·fit + 0.20·freshness + 0.15·affinity + 0.10·sourceQuality` + a goal adjustment from `onboardingAnswers.goal`, with `freshness = 100·e^(−ageHours/72)`. **No boost for recruiter-bank jobs** (a boost for our own paying customers would need disclosure under UCPD Annex I 11a and the PRC algorithm-recommendation rules); every factor is listed on the public `/help/ranking` page. GoApply users who have not chosen 个性化推荐 (or chose off) get recency + filters only.
   - Recent: `postedAt` desc. Top fit: `fit` desc.
   - Company scatter: at most 2 per company in any 20 consecutive items.
   - `fitTier` filter applies here, and the response states how many rows were hidden (ruling C3).
3. **Session.** Write `RAFeedSession{jobIds, ranks, windowEndsAt, expiresAt: now()+30 min}`. Return page 1 (20 items) and `cursor = <sessionId>:<offset>`.
   - Next pages slice the session.
   - When the session is exhausted, the server runs retrieval for the next older window and appends to the session ("infinite" scroll). A final page returns `endOfFeed: true`.
4. **Counts.** `POST /search-profiles/:id/count` runs the retrieval predicates as `SELECT count(*)` capped at 5,000 (`{count, capped}`). It powers the drawer's "Show N jobs" and onboarding's "We found N roles".
5. **Item shape** (`FeedItem`): job card fields (`salaryPeriod`, `employmentType` and `workModel` included, fixing C37), company mini (logo, name, size band, `Sourced` facts), `fit{tier, score, kind, topGap, topOverlap}` (ruling R2: the card leads with the gap), badges (`directFromEmployer` only when `fromRecruiterBank && employerVerified && !isAgency`, `agency`, `sponsorship` only for users who need it and with its quote, `autofillSupported` from `atsType`; no applicant count), tracker state, and `feedSessionId` + `position` for feedback.

### 4.9 Feedback loop

| Signal | Effect |
|---|---|
| Not Interested with reason | `RAJobUserState.hiddenAt` (hard exclusion; never reappears) plus a **deterministic** filter mutation, returned to the client as a diff it shows before saving. Reasons: `company` → `excludedCompanies`; `industry` → `excludedIndustries`; `skills_lack` → `excludedSkills` (the user picks which); `location` → location editor; `level` → seniority editor; `sponsorship` → `needsSponsorship=true`; `citizenship`/`clearance` → `excludeRequirements`; `title` → `excludedTitles`; `other` → note only. |
| Save / apply click / applied | Affinity +0.1 / +0.15 / +0.25 for the job's taxonomy L3, company and top skills (decay ×0.98 per day, applied lazily). |
| Hide with no reason | Affinity −0.1. |
| Daily rating < 8 with reasons | Stored in `RAFeedRating`. The reason `title` → copilot suggestion card; `level` → seniority re-ask. |
| Report (`scam`, `incorrect`, `not_available`, `not_remote`, `wrong_location`, `posting_date_incorrect`) | `RAJobInteraction` + `RAJobUserState.hiddenAt`. Three distinct users reporting `scam` or `not_available` → job `closedAt`, `closeReason='reported'`, reviewed in admin. After a scam report, offer `excludeAgencies`. |
| Skill confirmation chips | `RAProfile.skills[].confirmed=true`, and the pre-score uses confirmed skills. |

---
## 5. Copilot architecture (COP)

### 5.1 Shape

```
Browser (CopilotRail / /copilot page)
  │ POST /api/v1/roboapply/copilot/threads/:id/messages   (fetch + ReadableStream; EventSource cannot POST)
  ▼
Express route (thin) → CopilotService.handleTurn(threadId, text, ctx)  [inside the brand ALS context]
  1. consume('copilot_message')                         (credits §7; 402 → card "daily limit reached")
  2. build context (§5.3)                               (profile snapshot, active FilterSet, job context, memory, history)
  3. loop ≤ 4 rounds:
       LLMService.streamChatWithTools(task='copilot')  → stream text deltas to SSE `delta`
       on tool_call → ToolRegistry.run(name, args, ctx) → SSE `tool` (start/end) + `card`
       append tool result (data-only, truncated) to messages
  4. guardrail post-pass (§5.5) on the final text; persist the message, cards, tool calls and usage
  5. SSE `done` { messageId, usage, creditsRemaining }
```

**LLM plumbing (COP owns `server/src/services/llm/**` during the feature waves).** `LLMService` gains `streamChatWithTools(messages, { tools, task, signal, maxTokens, onDelta, onToolCall })`. It is implemented for the OpenAI-compatible providers: `OpenRouterProvider`, `DeepSeekProvider`, `KimiProvider` and `OpenAICompatibleProvider`, using the `openai` SDK's `stream: true` plus `tools`. Google and Anthropic adapters throw `ToolsUnsupportedError`. The startup check `assertCopilotModelSupportsTools()` fails loudly if `getTaskModel('copilot')` resolves to an unsupported provider for a brand. Retry follows the existing `withRetry` rules, but **only before the first delta is emitted**. After that, an error ends the turn with an `error` event and a retry button.

**SSE helper** (`server/src/platform/sse.ts`, FND): sets `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`, calls `res.flushHeaders()`, sends a 15 s heartbeat comment, and aborts the LLM call on client disconnect (`req.on('close')`). Vercel Node functions stream `res.write` output. INT verifies end-to-end streaming on a preview deploy; the dev rewrite already has `proxyTimeout: 600000`.

### 5.2 Tools (`server/src/features/copilot/tools/*.ts`; each is a zod schema exported to JSON Schema with `z.toJSONSchema`)

Every tool calls an **existing area service** and never writes to the database directly. Mutations become proposals.

| Tool | Calls | Output card | Mutates? | Credits |
|---|---|---|---|---|
| `search_jobs` `{q?, filters?: Partial<FilterSet>, sort?, limit≤8}` | `FeedQueryService.preview` (no session) | `job_list` | no | — |
| `top_fit_jobs` `{limit≤8}` | `FeedQueryService` sorted by `top_fit` | `job_list` | no | — |
| `get_current_filters` | `SearchProfileService.getActive` | `filters` | no | — |
| `propose_filter_change` `{ops:[{op, path, value}], reason}` | validates against FilterSet, computes `count` before and after | `filter_diff` (proposal; Confirm/Not now; shows `Show N jobs`) | proposal only | — |
| `set_sort` `{sort}` | — | `action` (client applies it) | no | — |
| `get_job` `{jobId}` | `JobService.get` | none (context only) | no | — |
| `analyze_fit` `{jobId}` | `MatchService.fitAnalysis` | `fit_analysis` | no | `fit_analysis` |
| `company_insights` `{jobId \| companyId}` | `CompanyService.profile` (+ H-1B when flagged) | `company` (sourced facts only) | no | — |
| `find_connections` `{jobId}` | `NetworkService.connectionsForJob` | `contacts` (+ LinkedIn search deep links) | no | — |
| `draft_outreach` `{jobId, contactId?, channel}` | → proposal | `credit_action` | proposal | `outreach_draft` on confirm |
| `tailor_resume` `{jobId}` | → proposal | `credit_action` → on apply → `tailor_ready` link | proposal | `tailor` on confirm |
| `write_cover_letter` `{jobId, tone?, length?}` | → proposal | `credit_action` → `cover_letter` | proposal | `cover_letter` on confirm |
| `interview_prep` `{jobId}` | `PrepService.planForJob` (questions from the bank, labelled by `sourceKind`) | `interview_plan` + "Practice for this job" link | no | — |
| `salary_context` `{jobId \| taxonomyId, country, city?}` | `MarketStatsService` (index aggregates) | `salary` (`Sourced`, suppressed when n < 20) | no | — |
| `application_summary` | `TrackerService.summary` + follow-ups | `applications` | no | — |
| `add_external_job` `{url}` | → proposal | `credit_action` → `job_imported` | proposal | `job_import` on confirm |
| `remember` `{fact}` | → proposal | `memory_add` (the user confirms what is stored) | proposal | — |
| `get_profile_gaps` | `ProfileService.completeness` | `profile_gaps` | no | — |

Visitor copilot (`/api/v1/public/copilot`) gets only `search_jobs` (public jobs only), `salary_context`, and a static `explain_feature`. No memory and no persistence.

### 5.3 Context and memory

- **Profile snapshot:** a ≤1,500-token compact text (target roles, seniority, years, top 20 skills, last three titles/companies, education, work-auth answers, career goal). It is cached in memory per `(userId, profile.updatedAt, primaryVariant.contentHash)` and rebuilt on change. **PII is stripped** (no email, phone, address or sensitive answers). EEO and CN sensitive fields are never included.
- **Filters:** the active `FilterSet` as compact JSON with `version`.
- **Job context:** when `contextJobId` is set, the title, company, summary, skills, the requirement lines, and the user's fit dimensions if scored.
- **History:** the last 12 messages verbatim, plus `thread.summary`. A summary refresh runs every 10 messages with `getTaskModel('onboarding')` or the `LLM_FAST` model.
- **Long-term memory:** `RACopilotMemory` facts the user confirmed (max 50; shown and deletable in Settings → Copilot).
- **Language:** `getStrictOutputLanguageDirective(locale, 'content')` (memory note: the `analysis` scope silently ships English).
- **Persona:** `brandPersona(brand, 'assistant')`. It has no human name, is not first-person-heavy and has no emoji (rulings C9 and D4). The UI label is i18n `copilot.name` = "%BRAND% Assistant".

### 5.4 Card vocabulary (wire contract in `server/src/features/copilot/contract.ts`)

`job_list`, `filters`, `filter_diff`, `fit_analysis`, `company`, `contacts`, `credit_action`, `tailor_ready`, `cover_letter`, `interview_plan`, `salary`, `applications`, `job_imported`, `memory_add`, `profile_gaps`, `action`, `notice`. Every card carries `{ type, id, data, sources?: Sourced[] }`. Unknown card types render as nothing, so the server can ship ahead of the client.

### 5.5 Guardrails

- **System prompt rules:** never claim to have applied, submitted or contacted anyone; never state a number unless it comes from a tool result; job ids and company facts may appear only if a tool returned them; refuse unrelated tasks briefly; never ask for passwords or financial details.
- **Post-pass** (`server/src/features/copilot/guard.ts`):
  - A regex pass over the final text finds submission claims (EN/zh/zh-TW/ja/ko/es/fr/pt/de phrase lists, e.g. "I applied", "submitted your application", "已为你投递"). A hit replaces that sentence with a neutral fact line and logs `copilot_guard_hit`.
  - A number guard: a sentence containing a number that appears in neither the tool results nor the user's text is **removed** and replaced with "No source found for that number." (no first-person system copy), and the hit is logged. Fixture: an invented "$145k median".
  - Card job ids must come from tool results.
- **Prompt injection:** tool results (job descriptions, imported pages) are wrapped as `<data source="…">…</data>`, and the system prompt says data never carries instructions. No tool can call another tool. Mutations require a user click (proposals). `add_external_job` fetches only http(s) URLs through Firecrawl, never directly, so there is no SSRF.
- **Proposal safety:** applying a `filter_change` checks `baseVersion`. On mismatch it returns `conflict` and the card re-renders with a fresh diff. Proposals expire after 24 h.

### 5.6 Cost control

- **Models:** `LLM_COPILOT_MODEL` (mid-tier, tool-capable). Summaries use `LLM_FAST`. Max output 900 tokens per round. Context is capped at 12k tokens (oldest history is summarized first). Tool results are truncated to 2,000 tokens each.
- **Caps:** the `copilot_message` bucket (free 40/day, Pro 300/day, config). A global `COPILOT_DAILY_BUDGET_USD_<BRAND>` is tracked in `RARateCounter`; when exhausted, new turns get a polite busy notice with no charge.
- **Telemetry:** cost per turn goes to `UsageDeductionLog` with SKU `ra_copilot_turn`, and to the thread totals.

### 5.7 Frontend

- `components/features/copilot/` (COP): `CopilotRail` is a right-rail drawer mounted through FND's `CopilotRailSlot` in `app/(auth)/layout.tsx`. It remembers its open/closed state in `RAUserUiState` and does **not** re-open on navigation (fixes Jobright's annoyance). The folder also has `CopilotThread`, `MessageList` (harvests the dead `components/chat/MessageBubble.tsx` and `components/ui/StreamingText.tsx`), `cards/*` (one file per card type), `ChipBar` (per-job chips: fit, resume tips, connections, tailor, cover letter, prepare), `Cheatsheet`, and `VoiceInput` (Web Speech API where available; hidden otherwise).
- `lib/api/copilot.ts` exports `streamTurn()` (an SSE parser over fetch) and `hooks/copilot/useCopilot.ts`. `ASK` buttons on cards and the detail page call `openCopilot({ jobId, chip })`.

---

## 6. Chrome extension (EXT)

### 6.1 Package

```
extension/
  package.json            own deps + lockfile (react 19, react-dom, esbuild, @types/chrome, vitest, jsdom); NOT in the root workspace
  tsconfig.json
  scripts/build.mjs       node scripts/build.mjs --brand=roboapply|goapply --target=chrome|edge [--dev]
  src/
    brand/registry.generated.ts a full copy of the registry, written by scripts/gen-brand-mirror.mjs (same parity test)
    manifest.base.json          templated per brand (name, icons, host_permissions, externally_connectable)
    background/sw.ts            MV3 service worker: token storage (chrome.storage.local), API client, message router, badge
    content/
      detect.ts                 ATS detection by URL pattern + DOM probe → adapter
      panel/                    React panel mounted in a Shadow DOM (Clarity tokens copied into the shadow root)
      boards/                   job-board readers (linkedin.ts, indeed.ts, greenhouse-board.ts …) → save job + fit
    adapters/
      _kit/                     field model, value setters (React/Vue-safe native setter + input/change/blur events),
                                file attach (DataTransfer), combobox/select helpers, interact.ts (the ONLY file allowed to call .click())
      greenhouse.ts lever.ts workday.ts ashby.ts smartrecruiters.ts icims.ts workable.ts taleo.ts successfactors.ts
      moka.ts beisen.ts feishu.ts dayee.ts generic.ts (label-heuristic fallback; requested hosts only)
    mapping/                    field classifier: label/name/autocomplete/aria → canonical FieldKey; value resolver from AutofillProfile
    i18n/<locale>.json          extension UI strings (staging rule §10.1)
    _locales/<lang>/messages.json  manifest name/description per language (generated)
  test/fixtures/<ats>/*.html    saved, anonymized application forms
  test/*.test.ts
```

The root `vitest.config.mts` excludes `extension/**` (FND). The extension runs its own `vitest`.

### 6.2 Manifest (per brand)

- `manifest_version: 3`. Permissions: `storage`, `activeTab`, `scripting`. **No `cookies`. No `tabs`.**
- `host_permissions`: the brand API origin plus the ATS host list for that brand's market:
  - RoboApply: Greenhouse, Lever, Workday, Ashby, SmartRecruiters, iCIMS, Workable, Taleo, SuccessFactors. **No LinkedIn or Indeed host permissions**: save/fit on job boards runs only on a toolbar click under `activeTab` (§6.7).
  - GoApply: Moka, Beisen, Feishu, Dayee, plus the big-tech career portals that EXT verifies.
- `optional_host_permissions: ["https://*/*"]` is requested at runtime only when the user enables "Use on this site" for a requested host.
- `externally_connectable.matches`: the brand's production hosts (+ dev hosts in `--dev` builds).
- Content scripts are registered per ATS host. The panel is injected only after detection succeeds.

### 6.3 Authentication (token exchange)

1. The user opens `/extension` (web, logged in). The page detects the extension with `chrome.runtime.sendMessage(EXT_ID, {type:'ping'})`, using per-brand extension ids from env `NEXT_PUBLIC_EXT_ID_<BRAND>`.
2. On "Connect", the page calls `POST /ext/devices` (cookie auth) → `{ token }`, then `chrome.runtime.sendMessage(EXT_ID, {type:'pair', token, apiOrigin})`. The token never touches page storage.
3. Fallback when messaging is unavailable (some Chromium forks, Edge policy): the extension popup shows "Enter code". The web page shows an 8-character code from `POST /ext/pair-codes`, and the popup redeems it with `POST /ext/pair-codes/redeem`.
4. The service worker stores the token in `chrome.storage.local` and sends `Authorization: Bearer rax_…`. Server middleware `requireExtensionDevice` hashes the token, loads `RAExtensionDevice` (not revoked), sets `req.user` and the brand (`device.brand` must equal the resolved brand of `apiOrigin`), and updates `lastSeenAt` at most every 10 min. A device can reach **only** `/ext/*` routes.
5. Revocation from `/settings#devices` (DELETE) takes effect on the next call; the extension shows "Reconnect".

### 6.4 Autofill flow (supervised; D1)

```
detect(url, dom) → adapter
panel: job card (POST /ext/page-job → fit) · "Autofill this page" button · completion checklist
user clicks Autofill → POST /ext/autofill-runs (reserve credit) → adapter.listFields() → classify → resolve values:
    profile fields (name, email, phone, address, links, education, work, work-auth, EEO only with consent)
    resume file: POST /ext/resume-for-job → signed URL → File → DataTransfer → input.files → change event
    cover letter: existing letter for the job, else offer "Write one" (opens the web app; cover_letter credit there)
    free-text questions: answer bank match (questionKeys) → fill; else POST /ext/answers (ai_answer credit) → shown ONLY in the side panel;
        the field is filled only when the user clicks "Use this answer" for that field; protected question types are never AI-generated
→ fill each field (adapter setters) → panel checklist (filled / needs you / skipped) → PATCH run {fieldsFilled, outcome}
user reviews every field and presses the site's own Submit.
panel then asks "Did you submit this application?" → Yes → PATCH run {userMarkedSubmitted:true} → tracker applied
(the extension never listens for form submits on employer pages; this answer is the only signal)
```

- Multi-page ATSs (Workday, SuccessFactors): the user moves between pages with the site's own buttons. The panel offers "Fill this page" on each page. The extension **never** clicks Next, Continue, Save, Review or Submit.
- Filled values are tagged in a local log (selector, field key, source) so "Undo autofill" can restore the previous values.
- Sensitive fields (EEO/CN) are filled only when the user consented to `autofill_sensitive`, and are highlighted for review.

### 6.5 ATS adapter contract

```ts
interface AtsAdapter {
  id: AtsType;
  matches(url: URL, doc: Document): boolean;
  readJob(doc: Document): { title?: string; company?: string; location?: string; descriptionText?: string } | null;
  listFields(root: Document | ShadowRoot): FieldHandle[];           // stable order, each with label text + input kind
  fill(field: FieldHandle, value: FieldValue): Promise<FillResult>; // uses _kit setters only
  attachFile(field: FieldHandle, file: File): Promise<FillResult>;
  // NO submit(), NO next(): deliberately absent from the interface.
}
```

Coverage order: Greenhouse, Lever, Ashby, Workday, SmartRecruiters, iCIMS, Workable, then Taleo and SuccessFactors (RoboApply); Moka, Beisen, Feishu, then Dayee (GoApply). Every adapter ships with ≥3 saved HTML fixtures and tests that assert `listFields` coverage and value round-trip.

### 6.6 The D1 guarantee (enforced in CI)

`extension/scripts/check-no-submit.mjs` runs in the extension test script and in root `npm run check` (FND adds `check:extension`). It fails the build when:
- any file other than `src/adapters/_kit/interact.ts` contains `.click(`, `.submit(`, `requestSubmit(`, `dispatchEvent(new MouseEvent('click'`, `dispatchEvent(new SubmitEvent` or `KeyboardEvent` with `Enter` on a form element;
- `interact.ts` exposes anything other than `openListbox(el)` and `chooseOption(el)`;
- either function lacks the guard that refuses an element (or an ancestor ≤3 levels up) that is a `button`/`input[type=submit|button|image]`, has `type=submit`, has role `button`, or whose accessible name matches the localized submit/apply/next/continue/review/提交/投递/下一步 list.

A unit test feeds submit-like elements to `chooseOption` and asserts it throws.

### 6.7 Save job and fit on job boards

`content/boards/*` run **only when the user clicks the toolbar button** ("Check fit" or "Save") on a job page, under `activeTab` — nothing is read or sent on page load, and only the fields the user saves are sent. The store listing declares "website content, user-initiated only". They show a compact fit chip from `POST /ext/page-job`, which uses the **same scorer service** as the app (pre-score immediately, AI score if cached), so scores never diverge (F-EXT-06). "Save" calls `POST /ext/jobs/save`, which creates a private `RAJob` (`visibility:'private'`, `sourceBoard:'user_import'`) when no public match exists by `dedupeKey`; such jobs never enter public inventory or any count.

### 6.8 Distribution

- **RoboApply:** Chrome Web Store listing "RoboApply Autofill". Edge Add-ons uses the same package. The listing copy says the user submits (D1).
- **GoApply:** Microsoft Edge Add-ons (reachable in mainland) is primary, with the Chrome Web Store as secondary. A signed CRX, self-hosted on `goapply.top/extension/goapply.crx` with an update manifest, serves 360/QQ browsers that accept manual install (documented, best-effort). Reachability is tested on the three carriers before launch (CN ops).
- Versioning: `extension/package.json` version; the web app checks `extVersion ≥ MIN_EXT_VERSION_<BRAND>` and shows "Update the extension" below it.
- Uninstall URL: `chrome.runtime.setUninstallURL('<origin>/extension/uninstall')` (survey page, SEO area hosts the route, EXT owns the component).

---

## 7. Credits, entitlements and billing (CRED)

### 7.1 Buckets and default caps (config `CREDIT_CATALOG`, overridable per brand via `AppConfig` key `credits.catalog.v1`)

| Bucket | Window | Free | Pro (fair-use cap) | Consumed by |
|---|---|---|---|---|
| `tailor` | day | 2 | unlimited (50) | tailor session generate |
| `cover_letter` | day | 2 | unlimited (50) | cover letter generate |
| `resume_grade` | day | 1 | unlimited (20) | resume analysis run |
| `resume_fix` | day | 5 | unlimited (200) | AI fix / rewrite suggestions (existing `/rewrite` joins this bucket) |
| `autofill` | day | 4 | unlimited (100) | extension autofill run with ≥1 field filled |
| `ai_answer` | day | 10 | unlimited (200) | extension AI answers (answer-bank hits are free) |
| `outreach_draft` | day | 3 | unlimited (50) | outreach drafts |
| `fit_analysis` | day | 10 | unlimited (100) | copilot/detail fit analysis card |
| `competitiveness` | week | 1 | 3/day | competitiveness report |
| `job_import` | day | 10 | 50 | external job import |
| `copilot_message` | day | 40 | 300 | each user turn |
| `contact_lookup` | day | 0 | 0 | gated until a provider exists |
| `interview_minutes` | month | delegates to `mockCreditService` (existing plans and credits) | | interview engine |

Feature entitlements (not counters): `savedProfilesMax` (free 1, Pro 10), `alertInstantMax` (free 1/day, Pro 100), `competitivenessFull` (Pro). (The recruiter-jobs filter is free with no entitlement; there is no LinkedIn report.)

**Plans.** The catalog lives in `server/src/platform/billing/planCatalog.ts`:
- RoboApply: `free`, `pro_week`, `pro_month`, `pro_quarter` (USD; Stripe recurring prices from env `STRIPE_RA_PRO_{WEEK,MONTH,QUARTER}_PRICE_ID`).
- GoApply: `free`, `pro_week`, `pro_month`, `pro_quarter` (CNY one-time passes; amounts from env `RA_CN_PRO_{WEEK,MONTH,QUARTER}_FEN`).

Display names come from i18n and must not reuse Jobright's plan names. Prices are owner decisions; the code ships with env-required values and refuses to sell a plan whose price is unset. Legacy `starter`/`growth` subscribers keep their interview credits and map to the `pro` entitlement profile until renewal (grandfathering). Interview packs remain purchasable as one-time `interview_pack` products.

### 7.2 Entitlement resolution

`EntitlementService.resolve(userId)` → `{ planKey, interval, buckets: { [bucket]: { cap: number | 'unlimited', fairUse?, window } }, features }`. Resolution order:
1. Base catalog for the brand.
2. The plan profile (`free` or `pro`) from the active `SeekerSubscription` (`status ∈ active|trialing`, `currentPeriodEnd > now`).
3. `RAEntitlementOverride` rows that have not expired.

The result is memoized per request. `/auth/me` returns the summary; the client never computes entitlements.

### 7.3 Atomic consumption (reserve → commit/release)

`server/src/platform/credits/CreditService.ts`:

```ts
reserve({ userId, bucket, units = 1, idempotencyKey, refType, refId, sku }): Promise<Reservation>   // throws CreditsExhaustedError
commit(reservationId, { refId? }): Promise<void>
release(reservationId, reason): Promise<void>
withCredit(opts, fn)  // reserve → fn() → commit on success / release on throw (the usual call site)
```

Inside one READ COMMITTED transaction:
1. `INSERT INTO "RACreditLedger" (… idempotencyKey …) ON CONFLICT ("idempotencyKey") DO NOTHING RETURNING id`. If nothing is returned, the request is a replay: return the existing reservation (idempotent).
2. If unlimited: record `fromSource='unlimited'`. The fair-use cap is still enforced with step 3 against the fair-use number.
3. `INSERT INTO "RACreditWindow" (userId, bucket, windowKey) … ON CONFLICT DO NOTHING`, then `UPDATE "RACreditWindow" SET reserved = reserved + $u WHERE … AND used + reserved + $u <= $cap RETURNING used, reserved`. One row means success, `fromSource='window'`.
4. Otherwise try a grant: `UPDATE "RACreditGrant" SET remaining = remaining - $u WHERE id = (SELECT id FROM "RACreditGrant" WHERE userId=$1 AND bucket IN ($b,'*') AND remaining >= $u AND (expiresAt IS NULL OR expiresAt > now()) ORDER BY expiresAt NULLS LAST LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id`. Success means `fromSource='grant:<id>'`.
5. Otherwise roll back and throw `CreditsExhaustedError{bucket, resetsAt, upgradable}`. The route maps it to 402 `credits_exhausted`, and the client shows the three-way modal (upgrade / come back at `resetsAt` / continue without the AI feature).

- `commit` moves `reserved → used` (or keeps the grant decrement) and sets `status='committed'`. It also writes the `UsageDeductionLog` row (existing audit; success-only billing preserved).
- `release` reverses the window's `reserved` or restores the grant's `remaining`, and sets `status='released'`.
- `jobs-maintain` releases reservations older than 15 minutes.
- **Window keys** use the user's timezone (`SeekerProfile.timezone` ?? `brand.defaultTimezone`): `d:YYYY-MM-DD`, `w:GGGG-[W]WW`, `m:YYYY-MM`. `resetsAt` is the next local midnight, Monday or month start.
- **Pre-spend notice:** every credit-consuming button shows "Uses 1 of your N left today" from `/credits`, and a credit-consuming copilot action is always a proposal (§5.2).

### 7.4 Billing changes

- **Rail lock:** `resolveBillingRegion` is replaced by `resolveRail(brand, requestedRail?)`, which validates against `brand.paymentRails`.
- **Rail interface:** `PaymentRail` (`server/src/platform/billing/rails/*`) exposes `createCheckout(order) → { url } | { qrCodeUrl } | { jsapiParams }` and `verifyCallback(req) → { orderId, paid, amountMinor }`.
- **Implementations:**
  - `StripeRail`: existing, subscriptions; metadata gains `brand` and `planKey`.
  - `AlipayWorkerRail`: existing GoHire worker. `platform` stays `'gohire'` until the worker supports a GoApply platform; the subject, receipts and the 用户协议 name the **actual collecting entity**, and GoApply charging stays off until that entity matches the merchant (no 二清; OPS C-13). No coaching payments on CN rails.
  - Extension points: `registerRail(id, impl)` and an exported `fulfilPass(order)` (WP-21a) so a later wave can add WeChat Pay without editing billing files.
  - `WechatPayRail`: new. If the GoHire worker supports `pay_channel:'wxpay'` (CRED verifies the worker contract first), use it. Otherwise call WeChat Pay API v3 directly (Native QR on desktop, JSAPI inside the WeChat browser) with env `WECHATPAY_MCH_ID`, `WECHATPAY_APP_ID`, `WECHATPAY_API_V3_KEY`, `WECHATPAY_CERT_SERIAL`, `WECHATPAY_PRIVATE_KEY`, signed with node `crypto`. Behind `WECHATPAY_ENABLED`.
- **GoApply renewals** stay manual passes (no auto-debit); the existing T-5 day reminder covers them. Renewal reminder emails must be **sent and logged** (`RAEmailLog`), per X-31.
- **Pricing page:** `/pricing` (SEO) is public, shows brand currency, and states the free caps from the same catalog endpoint (D3: numbers come from config, not copy).
- **Offers:** only real, server-timed offers (`server/src/platform/billing/offers.ts`): a start time persisted in `RAUserUiState`, no fake countdown resets (catalog D-07). The first version ships with **no** offers; the seam exists. An optional "Welcome price" (owner decision) shows no comparison price and ends 7 days after signup.
- **Checkout acknowledgements:** unticked auto-renewal acknowledgement on every auto-renewing plan (consent record `auto_renew_ack`, kept 3 years); EU/UK/TW withdrawal-waiver acknowledgement (`withdrawal_waiver`); public `/cancel` flow (email → signed one-time link → confirm).
- **Referral rewards:** a qualified referral grants the inviter **and** the invitee an `RACreditGrant(bucket:'*', amount:10, reason:'referral', expiresAt:+90d)`. This needs no Stripe balance, so it works on both brands. The inviter cap is 10 qualified referrals. The amounts are config (an owner decision).

### 7.5 New SKUs (pre-registered in `server/src/roboapply/v2/lib/raFeatureCatalog.ts` by FND)

`ra_job_enrich`, `ra_match_score_v3`, `ra_fit_analysis`, `ra_competitiveness`, `ra_copilot_turn`, `ra_copilot_summary`, `ra_resume_grade`, `ra_resume_fix`, `ra_tailor_v2`, `ra_cover_letter`, `ra_outreach_draft`, `ra_ext_answer`, `ra_job_import`, `ra_interview_guide`, `ra_seo_intro`, plus the missing `ra_crossbank_score` and `ra_crossbank_insight` mappings.

---

## 8. Notifications (NOTIF)

### 8.1 Email platform

- **Module:** `server/src/platform/email/`:
  - `EmailService.send({ template, to, userId?, locale, params })` reads the current brand (or takes `brand` explicitly in workers) and picks the transport by `brand.email.transport`.
  - `ResendTransport` refactors the existing `services/EmailService.ts` HTTP call.
  - `AliyunDirectMailTransport` is behind `CN_EMAIL_TRANSPORT=aliyun_dm` with `ALIYUN_DM_*` env. Until then GoApply sends through Resend from `noreply@mail.goapply.top`.
- **From:** `brand.email.fromName <EMAIL_FROM_<BRAND>>`. The RoboHire fallbacks at `EmailService.ts:22`, `RoboApplyDigestService.ts:130-137` and `RoboApplyBillingReminderService.ts:27,30` are deleted.
- **Templates:** `server/src/platform/email/templates/<template>.ts` returns `{ subject, html, text }` from strings in `server/src/i18n/email/<locale>.json` (9 locales for RoboApply; GoApply needs zh and en, but all 9 are kept for parity), with `%BRAND%` substituted. Layout: one shared HTML shell with brand logo, footer, legal address and an unsubscribe link (marketing and alerts only). CRED owns `templates/billing/*` and moves `server/src/roboapply/lib/billingEmails.ts` (4 locales today) into it, expanded to 9.
- **Template list:** `welcome`, `verify_email`, `password_reset`, `job_alert_instant`, `job_alert_digest`, `followup_reminder`, `interview_reminder`, `referral_qualified`, `coaching_booking_*`, `prefs_magic_link`, and the existing billing set (`renewal_reminder`, `friday_nudge`, `receipt`, `account_deletion`).
- **Compliance:** every send writes `RAEmailLog`. Marketing and alert emails carry `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` with a signed `RAAuthToken(email_unsub)`. `SeekerProfile.notificationPreferences` and `marketingOptIn` (a consent record) are checked before every non-transactional send.

### 8.2 Job alerts (instant + digest)

`job-alerts` cron (every 15 min), per brand, users ordered by `lastActiveAt`:
- **Instant:** for profiles with `alertInstantMax > 0`, if the count sent in the user's local day is below the cap and the last instant send was ≥ 3 h ago, find canonical jobs in the profile's filters with `firstSeenAt > alertLastInstantAt` (and posted within 24 h), not hidden, not yet delivered (`RAAlertDelivery.jobIds`), fit tier ≥ `possible` (pre-score). If there are ≥1, send up to 5 jobs, then record the delivery and update `alertLastInstantAt`.
- **Digest:** `alertDigest = daily` sends at 08:00 user-local; `weekly` sends Monday 08:00. Up to 10 jobs ranked by `rank`.
- Each email lists real fields only. Each job link goes to `/jobs/<id>?src=alert&imp=<deliveryId>`. An unauthenticated click lands on login with `next`; email links to a public job page work without login when `publicDisplay` is true.
- An in-app `SeekerNotification(category:'job_alert')` mirrors each delivery. Web push mirrors it when subscribed.
- Logged-out alert subscription (F-NOTIF-03) is **not** in phase 1. It needs an anonymous identity (ruling C36 pattern) and is listed as a follow-on.

### 8.3 Message center

- Reuses `SeekerNotification` (§2.2).
- Producers: alerts, tracker reminders (`reminders` cron: `followUpAt` due, `interviewAt` in 24 h, deadline in 48 h), billing events, referral qualified, announcements, coaching bookings, recruiter invitations (flag).
- UI: `components/features/notifications/MessageCenterButton.tsx` (the FND slot in the Topbar) with an unread dot (`/notifications/unread-count`, polled every 60 s while visible, and refreshed on focus). The drawer list is localized client-side from `templateKey` + `params`, with stored `title`/`body` as fallbacks.

### 8.4 Web push and PWA

- RoboApply only (`flags.webPush`). FCM and Mozilla push endpoints are unreliable from the mainland, so GoApply uses WeChat service-account messages later (gated; not in this branch).
- `web-push` with `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`. `public/sw.js` handles only push and notification clicks; no offline caching.
- `app/manifest.webmanifest/route.ts` is host-aware (name, icons and theme color from the brand).
- Permission is asked only after a user action ("Get alerts on this device" in alert settings). Never on load.

### 8.5 Announcements and popup throttle

- `RAAnnouncement` is authored in admin, one per brand × cohort, translated before publish.
- `lib/ui/popupGate.ts` (FND) is the single client arbiter for every modal, prompt and offer. It enforces: at most one per page view; a 24 h gap between non-essential popups (`RAUserUiState.popupLastShownAt`); a priority order (announcement < survey < extension prompt < offer). Every area that shows an unprompted modal must go through `requestPopup(key, priority)`.

---

## 9. SEO and programmatic pages (SEO)

### 9.1 URL scheme (both brands; the locale prefix follows the existing landing convention: no prefix for the default locale, `/{locale}` otherwise)

| Type | Path | Source |
|---|---|---|
| Landing | `/`, `/{locale}` (existing) | — |
| Pricing | `/pricing` | plan catalog |
| Role hub | `/roles`, `/roles/{role}` | `RASeoPage(type:'role')`, taxonomy L3 |
| Role × city | `/roles/{role}/{city}` | `role_city` |
| Remote role | `/remote/{role}` | `remote_role` |
| Company | `/companies/{slug}` | `RACompany` + live jobs |
| Public job | `/job/{slug}-{id}` (singular, to avoid the protected `/jobs` prefix) | `RAJob` with `publicDisplay` |
| Segments | `/entry-level`, `/internships`, `/new-grad` (RoboApply); `/campus` = 校招日历 (GoApply) | `segment`, `RACampusEvent` |
| Sponsorship | `/visa-sponsorship/{country}/{role}` | jobs with `sponsorship='offered'` (quote-backed) + DOL LCA history for US employers |
| Interview questions | `/interview-questions/{company}` | `RAInterviewQuestion` (`user_report` and `curated` only; AI practice questions are not indexed) |
| Compare | `/compare/{competitor}` | hand-authored, dated, factual; every claim about a competitor links a public source; no ratings we cannot cite |
| Tools | `/tools`, `/tools/resume-checker`, `/tools/cover-letter`, `/tools/job-tracker` | the resume checker actually works pre-signup (§3.9) |
| Legal | `/legal/terms`, `/legal/privacy`, `/legal/refunds`, `/legal/coaching`, `/legal/referrals`, `/legal/attributions` | per brand |
| Extension | `/extension`, `/extension/uninstall` | EXT |

None of these paths are in `PROTECTED_PREFIXES`. Every public page shows the logged-out app shell with a signup CTA (`/signup?from=<type>:<slug>`).

### 9.2 Rendering and caching

- The root layout reads request headers (brand, locale), so pages are dynamically rendered. Cost is controlled by caching the data, not the HTML:
  - Express public endpoints send `Cache-Control: public, s-maxage=900, stale-while-revalidate=86400`. Vercel's CDN keys on host + path, so brands never mix.
  - **`app/layout.tsx:102` sets `dynamic = 'force-dynamic'`, which makes every `fetch` in layouts and pages `no-store`**, so `fetch(…, { next: { revalidate, tags } })` would do nothing. Instead, Next server components fetch through `lib/server/publicApi.ts` (server-only) wrapped in **`unstable_cache`** keyed by brand × page type × slug with tags `seo:${brand}:${type}:${slug}`. The API is fetched via the public origin (`brand.canonicalOrigin`; preview: `https://${VERCEL_URL}`) so Vercel's CDN honours its `Cache-Control`. Each request sends `X-RA-Brand`.
- `seo-rebuild` (daily) recomputes `RASeoPage.stats`/`indexable` and calls `POST /api/revalidate` (`app/api/revalidate/route.ts`, secret-gated; it is not under `/api/v1`, so Next serves it), which runs `revalidateTag` on the changed `unstable_cache` tags. Acceptance checks response headers, not ISR.
- **Indexability floor** (real inventory only, no thin pages):
  - role ≥ 20 live canonical jobs; role×city ≥ 5; company ≥ 1 live job **or** ≥ 3 published user-reported questions; sponsorship pages ≥ 5 quote-backed jobs.
  - Below the floor the page renders `noindex`, stays out of the sitemap, and links upward.
- **Intros:** `RASeoPage.intro` is built from a template plus real stats ("{n} open {role} roles in {city} posted in the last 30 days; {k} list pay; the median listed pay is …"). An LLM may paraphrase the template (SKU `ra_seo_intro`) but may not add facts. Every number is checked against `stats` before saving.

### 9.3 Structured data

- `JobPosting` JSON-LD only on `publicDisplay` jobs: `datePosted` = `postedAt` (omitted when `postedAtEstimated`), `validThrough` = real `expiresAt` (Jobright's fake +1 month is not copied), `baseSalary` only when `salaryDisclosed`, `jobLocationType: TELECOMMUTE` only when `workModel='remote'`, `hiringOrganization` from `RACompany`.
- Plus `BreadcrumbList`, plus `Organization`/`WebSite` (existing `landingJsonLd`, brand-aware). `FAQPage` only on pages with real FAQ content.

### 9.4 Provider licensing gate (D3 / legal)

A job from a third-party provider is shown on a **public, indexable** page only if its provider is listed in `PUBLIC_DISPLAY_PROVIDERS`. The default is **empty**. Bank jobs are public only when RoboHire/GoHire record the employer's consent to syndicate (their customers never agreed to republication on another brand). The owner adds a RapidAPI provider only after confirming its terms allow public redisplay; the existing `JOB_SEARCH_API_PROVIDERS` env reflects similar licensing caution. Inside the logged-in app, all providers are shown as today.

### 9.5 Sitemaps, robots, llms.txt

- `app/sitemap.ts` is deleted. In its place:
  - `app/sitemap.xml/route.ts`: a host-aware sitemap index listing the static set plus partitions.
  - `app/sitemaps/[file]/route.ts`: serves `static.xml`, `roles-{n}.xml`, `companies-{n}.xml`, `jobs-{n}.xml`, `campus.xml` (GoApply), with ≤45,000 URLs each. Each fetches `/api/v1/public/seo/sitemap/:part`. Hreflang alternates are included only for locales in `brand.seoLocales`, plus the cross-domain alternates of §1.6.
- `app/robots.ts` becomes host-aware (it already may use `headers()`):
  - `sitemap: <origin>/sitemap.xml`.
  - Disallow app paths (`APP_PATHS` mirrors `PROTECTED_PREFIXES` + `/onboarding`, `/copilot`, `/agent`, `/network`, `/messages`, `/profile`, `/api/`).
  - GoApply adds Baiduspider-specific allowances.
  - AI crawlers are allowed on marketing pages; they are **disallowed on `/job/*`** until recruiter-bank syndication consent exists (OPS-A4).
- `app/llms.txt/route.ts` replaces `public/llms.txt`. It is brand-aware and accurate: no auto-apply claims (the current file is stale, R1).

### 9.6 GoApply SEO specifics

Baidu verification meta; ICP and PSB footer; `zh-CN` canonical at `/`; no Google-only assumptions; Baidu push API submission of new sitemap URLs (`BAIDU_PUSH_TOKEN`, from `seo-rebuild`); the `/campus` calendar as the flagship SEO surface.

### 9.7 Recorded follow-on (not this branch)

True static ISR for programmatic pages requires a second root layout that does not read headers: `app/(seo)/b/[brand]/[locale]/layout.tsx`, with the proxy rewriting public SEO paths to `/b/{brand}/{locale}/…`. It would also require moving every current route into `app/(site)/`, which breaks 132 relative imports in `app/`. Trigger it only if crawl volume makes dynamic rendering costly; it needs a codemod wave of its own.

---
## 10. Cross-cutting: i18n staging, design system, testing, observability, security, dead code

### 10.1 i18n staging convention

#### 10.1.1 Files

| Path | Who writes | Content |
|---|---|---|
| `i18n/staging/<namespace>.en.json` | exactly one area per namespace (§11.4) | `{ "<namespace>": { …English strings… } }`. One top-level key, equal to the file's namespace. |
| `i18n/staging/<namespace>.remove.json` | the namespace owner | `["jobs.discovery.localHint", …]`: dotted paths to delete from **all** 9 bundles at merge |
| `server/src/i18n/email/staging/<area>.en.json` | the area that owns those emails (auth, billing, notify, growth, coaching) | email strings, merged into `server/src/i18n/email/en.json`. They live inside `server/src` because `server/tsconfig.json` has `rootDir: ./src` and Vercel ships only `server/**`. |
| `i18n/staging/extension.en.json` | EXT | extension UI strings, merged into `extension/src/i18n/en.json` |
| `i18n/brands/goapply/{zh,en}.json` | CN | market overrides (not staging; translated by CN directly in both languages) |
| `i18n/staging/index.ts` | **FND only (generated)** | `export const STAGING_EN = deepMerge(...)` with static imports of every planned staging file (FND pre-creates each as `{ "<ns>": {} }`) |

#### 10.1.2 Runtime

`lib/i18n.ts` (FND) merges `STAGING_EN` over `en.json` before deriving the other locales with `mergeOverEn`. New keys therefore render in English in every locale during the feature waves, and nothing shows a raw dotted path. Server email bundles are loaded the same way from `server/src/i18n/email/` plus `server/src/i18n/email/staging/`. Extension bundles are loaded the same way.

#### 10.1.3 Merge script: `scripts/i18n-merge-staging.mjs` (FND writes it, INT runs it)

1. Validate every staging file: valid JSON; a single top-level key equal to the namespace; ICU syntax parses (`intl-messageformat` is already a next-intl dependency); no literal `RoboApply`/`GoApply` (use `%BRAND%`/`%OTHER_BRAND%`); `RoboHire`/`GoHire` are real source names (D3) and may appear only as `{sourceName}` params or under `legal.*`, `jobsCn.source*` and `people.source*`; no empty strings.
2. Deep-merge into `i18n/messages/en.json`. Staging wins. Changed English values are recorded.
3. Apply each `*.remove.json` across all nine bundles.
4. Write `i18n/staging/_pending-translation.json`: `[{ path, en, reason:'new'|'changed' }]`. For changed keys, delete the stale translation in the 8 other locales so the translator cannot leave it behind.
5. Merge the email staging (`server/src/i18n/email/staging/`) and extension staging into their bundles with the same rules.
6. Empty the merged staging files back to `{ "<ns>": {} }` (they stay as future scratch space) and regenerate `index.ts`.
7. `--dry-run` prints the plan; `--check` exits non-zero if any staging file is non-empty (INT's final gate).

INT then runs the `i18n-locale-sync` skill over `_pending-translation.json` for the 8 locales (and the GoApply overrides are reviewed in zh). After that, `npm run check` must pass with **zero** staging content.

#### 10.1.4 Check-script changes (FND)

- `check-copy.mjs`:
  1. Banned-word scan also covers `i18n/staging/*.json`, `i18n/brands/**`, `server/src/i18n/**`, `extension/src/i18n/**`.
  2. Call-site resolution resolves keys against `en.json ∪ STAGING_EN`, scanning `app/`, `components/`, `hooks/`, `lib/` and `extension/src/`.
  3. Locale parity stays over `i18n/messages/*.json` only. Staging is English-only by design.
  4. New rule: no literal `RoboApply`/`GoApply` in any bundle (source names allowed as above), and the count of `%BRAND%` per key is equal across locales.
  5. `BANNED` becomes a list of `{term, locales, regex, reason}`; terms use word-boundary regexes (`\bats\b`, `\bjd\b`, `\bunlimited\b`) instead of space-padded substrings.
- **Proposed BANNED additions** (D1; minimal and explicit):

| Term | Why |
|---|---|
| `apply for you`, `applies for you`, `applied for you` | D1: the user submits |
| `submit for you`, `submits for you`, `submitted for you` | D1 |
| `auto-submit`, `auto submit` | D1 |
| `one-click apply`, `1-click apply` | implies submission; the extension fills, the user submits |
| `guaranteed`, `guarantee` (affirmative only: "no guarantee", "can't guarantee", "cannot guarantee" pass) | D3: no outcome promises |
| `\bunlimited\b` + native equivalents, every locale | caps are printed, never "unlimited" |
| ja 自動応募, 代わりに応募 · ko 자동 지원, 대신 지원 · es postulación automática, postulamos por ti · fr candidature automatique, postule pour vous · pt candidatura automática, candidatamo-nos por si · de automatische Bewerbung, bewirbt sich für Sie | D1 in every locale (zh/zh-TW lists in CN plan §9.1) |
| zh 北森, 牛客 | implies affiliation |

- **Proposed ALLOW additions**, two only. Each is scoped to SEO search-intent strings that must match what people type into search engines:
  - `seo.tools.resumeChecker.meta.*` may contain `applicant tracking`, needed in the meta title for the query "applicant tracking system resume checker". Body copy still uses "the company's software" (ruling C8).
  - ~~`seo.compare.*` may contain `auto-apply`~~ — **dropped** (compare pages are deferred; `TASK_PLAN.md` R-12). Admin copy avoids existing bans ("Reports to review", "alert level"), so no admin allow is added.
- **No existing ban is removed.** Feature names were chosen to avoid conflicts: the Work model option is "On-site" (hyphenated; `onsite` stays banned), the fit ladder is Great/Good/Possible/Unlikely (`strong match` stays banned), and the score breakdown is "What we compared" (`dimension` stays banned).
- `check-design.mjs`: also scan `components/features/**/*.module.css` and `styles/brands/*.css`. Brand files may only redefine the token list in §1.6.
- New `scripts/check-extension-no-submit.mjs` (§6.6), wired as `check:extension` inside `npm run check`.
- New `scripts/check-api-boundary.mjs`: fails on raw `/api/v1/` string literals outside `lib/api/**` and `lib/server/publicApi.ts` (AGENTS rule), and on `prisma as any` in `server/src/features/**` and `server/src/platform/**`. It ignores comments and reads `scripts/api-boundary-baseline.json` (today's offenders, each with an owning WP), failing only on new offenders.
- Root `tsconfig.json` excludes `extension` and `deploy`; the extension's own typecheck and tests run with `npm --prefix extension run typecheck && npm --prefix extension test`.

### 10.2 Design-system usage rules (all frontend areas)

1. **Tokens only.** Use `var(--*)` from `app/globals.css`, the `--fs-*` type scale (8 sizes), and the spacing scale 4/8/12/16/24/32/48/64. No literal colors, font families or font sizes in new code.
2. **Styling:** CSS Modules colocated with components (`components/features/<area>/*.module.css`). No new global stylesheets, no new inline style objects beyond dynamic values (positions, widths), and no new Tailwind palette classes. This removes the hot `globals.css` import list from the critical path.
3. **Primitives first:** `PageHeader`, `Btn`, `Tag`, `Pill`, `Chip`, `StatStrip`, `ScoreDonut`, `EmptyState`, `Modal`, `Markdown`, `MetricGrid`, `Iconset` (`components/v3/primitives/`). New shared primitives (e.g. `Drawer`, `Tabs`, `Toast`, `SourceNote`, `CreditNotice`, `FitMeter`) are created by FND in `components/v3/primitives/` so no two areas build their own.
4. **Fit display rules:** the four-word ladder; the score secondary (`87 / 100 — how well your resume lines up with this job post`); the permanent line `This is not your chance of getting hired.` (ruling C5); the card leads with the gap (R2); the 4 px fit strip on the card's top edge (C41).
5. **Honesty in UI:** unknown or loading values render `—`, never 0 (Clarity rule); every `Sourced` value has its source line; estimates say "Estimate".
6. **Both themes and both brands:** every screen is verified in light and dark × `data-brand` roboapply and goapply, plus one CJK locale, at 375 px and 1280 px.
7. **Copy:** plain language per rulings B (C1–C22); no first-person persona; contractions are fine; no idioms; product nouns are job · application · resume · practice interview · assistant.
8. **Accessibility:** native controls; `aria-*` for state; focus management in drawers (copilot rail, filters drawer, message center); 44 px touch targets on mobile; `prefers-reduced-motion` respected (the S6 loader animates only real phase changes).

### 10.3 Testing strategy

| Layer | Tool | Rule |
|---|---|---|
| Pure logic (normalizers, preScore, ranking, filter diff, credit windows, brand resolution, taxonomy match, guardrail regex, adapters' classify) | vitest | ≥90% branch coverage on `normalize/`, `preScore.ts`, `CreditService.ts`, `brand/`; table-driven tests with real anonymized fixtures |
| Services | vitest with `vi.mock('../../lib/prisma.js')` (existing pattern) + a typed in-memory fake for the 3–4 models a service touches | one happy path + every error code per public method |
| Raw SQL (feed query, credit consume, queue lease) | vitest: `server/src/test/sqlSnapshot.ts` asserts the generated SQL text and parameters. pg-mem is not used because it lacks GIN/trigram support. INT runs a live smoke test against a Neon **branch** database, never the main DB; the owner creates the branch. | |
| Routes | `server/src/test/routeHarness.ts` (FND): invokes an Express router with a fake req/res, a brand context and an auth user; asserts envelope + codes | each new route ≥1 test; auth and `feature_disabled` paths covered once per router |
| Contracts | the zod schemas in `contract.ts` validate the fixtures used by frontend tests (`__tests__/fixtures/<area>/*.json`), so client and server fixtures cannot drift | |
| Frontend components and hooks | vitest + Testing Library + jsdom; `vi.mock('@/lib/api/<area>')`. New areas do **not** extend `lib/stub/raV2.stub.ts`; only areas that change V2 types must update it (C37) | |
| Brand | `brandParity.test.ts`, `brandFromHost.test.ts`, the contrast test over both brands × themes, and a layout test rendering metadata for each brand | |
| Extension | adapter fixture tests, no-submit check, a manifest snapshot per brand | |
| i18n | `check:copy`, the merge script `--check`, and a test that every `templateKey` used by producers exists in the bundles | |
| End-to-end (INT) | the in-app Browser pane on `localhost:3611` and `goapply.localhost:3611`: signup → onboarding → feed → detail → tailor → cover letter → copilot (streaming) → tracker → billing page (no real payment) → extension pairing (unpacked dev build); both themes; zh and en | |

Each work package runs the smallest affected tests first, then `npm test`, `npm run typecheck:server` and `npm run check` (AGENTS). Only INT runs `npm run build` (never while `next dev` shares `.next`).

### 10.4 Observability

- **Logs:** the existing `LoggerService`, with every line auto-tagged with `[req:<id> brand:<id> user:<id8>]` now that the ALS context is live (§1.4). Workers tag `[work:<kind>:<id>]`.
- **LLM cost:** every LLM call goes through `writeDeductionLog` with a SKU (§7.5) and `brand` in metadata. The admin operations console groups cost by SKU × brand × day (ADMIN).
- **Pipeline health** (ADMIN panel "System"):
  - ingest: queries due/overdue, provider calls vs budget, new jobs per day per market, enrich backlog, percentage enriched
  - queue: depth by kind, dead items with retry
  - precompute: AI scores per day vs budget
  - alerts: sent and failed per day
  - email: `RAEmailLog` failures
  - copilot: turns, guard hits, cost
  - credits: exhaustion events per bucket (pricing signal)
- **Product funnels:** `RAProductEvent` from a typed registry (`server/src/features/growth/events.ts`, shared to the client by type-only import):
  - onboarding step views and completions
  - feed impressions and actions
  - tailor and cover letter starts and completions
  - extension paired and autofill runs
  - upgrade modal shown and clicked
  - Events go to our own database only; no third-party pixels on either brand (CN-E-02; RoboApply would need a consent banner first).
- **Alerting:** `jobs-maintain` emails the admin list (`ADMIN_ALERT_EMAILS`) a daily health summary when thresholds trip: ingest new jobs < 50% of the 7-day average, dead queue items > 100, LLM cost > budget × 0.9.

### 10.5 Security and abuse

| Risk | Control |
|---|---|
| Brand spoofing | Production ignores client brand headers and cookies; `requireAuth` rejects cross-brand sessions; extension tokens are bound to the brand |
| Credential stuffing / signup farms (credit farming) | DB rate limits (§3.10); disposable-email blocklist (`disposable-email-domains` is already a dependency) on signup; referral risk scoring (same IP or UA hash or device within 24 h, disposable domain, no onboarding completion) holds rewards for review |
| OTP abuse / SMS pumping | per-phone and per-IP limits; mainland numbers only on GoApply (`+86`); a daily SMS spend counter (`SMS_DAILY_MAX`) that fails closed |
| Prompt injection via job text or imported pages | data-wrapping, no autonomous mutations, proposals, guard post-pass (§5.5) |
| SSRF via job import | only http(s) URLs; fetched by Firecrawl (`FIRECRAWL_API_KEY`), never by our server directly; response size cap |
| PII to LLMs | resume text is PII-stripped (name, email, phone, address) before scoring, copilot, outreach and cover letters; sensitive answers never reach any model; GoApply prompts run on domestic providers only (§1.8) |
| Sensitive data at rest | `RASensitiveAnswers` AES-GCM (`server/src/lib/crypto.ts`, key `SENSITIVE_DATA_KEY`, versioned); OAuth/LINE/WeChat tokens are not stored; extension tokens and auth tokens are stored as hashes only |
| Extension | minimal permissions; no `cookies`; per-device revocable tokens scoped to `/ext/*`; signed 5-minute file URLs; the no-submit CI gate |
| Fake or scam jobs | agency detection; reports with a 3-user threshold auto-close; admin review queue; GoApply anti-fraud keyword classifier for 培训贷/招转培 (CN-E-08) at enrichment, setting `closedAt` + `closeReason='reported'` pending review |
| Data deletion | `SeekerAccountDataWipeService` and `SeekerAccountPurgeService` cover every new table and R2 key (artifacts, original resumes); cascade relations are declared for all user-owned models (§2) |
| Webhooks | Stripe signature (existing); Alipay callback secret (existing); WeChat Pay v3 signature + AES-GCM; RoboHire invitation HMAC; all idempotent on provider reference |
| Admin | existing `requireAdmin`; overrides and moderation write an audit `SeekerActivityLog` row (reused) |

### 10.6 Dead-code and cron removal plan (CLEAN; runs after Wave 0 merges and after AUTH removes the `/auth/me` mission field)

Order matters (ruling C27): each step must keep `npm run typecheck:server` green.

1. **Interview reconciler first.** If Wave 0 has not already done so, add `/api/v1/cron/interview-reconcile` (every 10 min) and a node-cron mirror in `RoboApplyCronService.ts`, calling `interviewSessionService.reconcileExpiredSessions()`.
2. Move the `RoboApplyRun` cleanup used by `SeekerAccountDataWipeService` into `v2/lib/v1Bridge.ts` (or inline it); repoint `raMockCatalog.ts` and `RAIntegrationsService.ts` imports away from `RAQueueService`.
3. Delete the V1 routers and their mounts in `server/src/app.ts`: `routes/{missions,runs,digest,settings}.ts`. Delete the services `RoboApply{Mission,DailyMatcher,Author,Submitter,Digest}Service.ts`, the agents `RoboApply{Author,Digest,IntentParser}Agent.ts`, `engine/agents/SeekerResumeTailorAgent.ts` (after CL has ported the claim-checker helper it needs into `server/src/features/coverletter/claimCheck.ts`), and `engine/services/boards/*`.
4. Delete the V2 dead surfaces: `v2/routes/{queue,activity,integrations}.ts`, `v2/services/{RAQueueService,RAActivityService,RAIntegrationsService}.ts`, `search/saved` routes, and their mounts in `v2/routes/index.ts`.
5. Delete the frontend dead code listed in the frontend map §5: `lib/api/{missions,runs,digest,settings,types}.ts`, `components/mock-interview/v3/*`, `components/v3/activity/*`, `hooks/{useActivity,useIntegrations,useCrossBankDiscover,useHomeJobs,useMockInterviews,usePipeline}.ts`, `lib/hooks/{useTracker,useStatusFunnel}.ts`, `components/chrome/Logo.tsx`, `components/ui/{Card,OptionPill}.tsx`. **Do not** delete `components/chat/MessageBubble.tsx` or `components/ui/StreamingText.tsx` (COP harvests them). Do not delete `components/v3/mock/*` (Wave 0).
6. `vercel.json`: remove `daily-matcher`, `digest`, `submitter`, `catchup`, `cache-cleanup`. Remove the matching handlers in `cron/handlers.ts` and node-cron entries.
7. Signup no longer creates a shell `RoboApplyMission` (AUTH changes `routes/auth.ts`). V1 tables stay in `legacy.prisma` (no destructive DDL).
8. Scrub the PII anecdote in the header comment of `server/src/services/GoHireResumeParseService.ts`.
9. Delete the dead `server/src/lib/anthropicClientFactory.ts` (no callers), after a final grep.
10. Update or delete the tests listed for these files. Each deletion commit states the grep that proved zero importers.

---

## 11. File ownership map

### 11.1 Directory conventions

```
server/src/
  platform/                     # shared plumbing (FND creates; owners noted per subfolder)
    brand/      registry.ts runtime.ts brandContext.ts persona.ts            (FND, then BRAND)
    queue/      enqueue.ts drain.ts runForBudget.ts registry.ts              (FND)
    ratelimit/  rateLimit.ts defaults.ts                                     (FND)
    credits/    CreditService.ts EntitlementService.ts catalog.ts windows.ts (CRED)
    billing/    planCatalog.ts offers.ts rails/{stripe,alipayWorker,wechatpay}.ts  (CRED)
    email/      EmailService.ts transports/* templates/* (templates/billing/* = CRED)  (NOTIF)
    sms/        SmsService.ts providers/{aliyun,tencent}.ts                  (AUTH)
    llm/        brandPolicy.ts                                               (FND)
    sse.ts flags.ts http.ts (envelope + zod parse helpers)                   (FND)
  features/<area>/                # one folder per area; the area owns everything inside it
    routes.ts            Express router (thin; parse → service → envelope)
    contract.ts          zod schemas + wire types (imported type-only by the frontend)
    *Service.ts          business logic
    agents/*.ts          LLM agents (extend BaseAgent)
    workers.ts           queue handlers (registered by platform/queue/registry.ts)
    cron.ts              cron entry functions (called by cron/handlers.ts stubs)
    *.test.ts
  features/index.ts      mounts every area router at /api/v1/roboapply/<area> or /api/v1/public/<area>  (FND)
  i18n/email/<locale>.json                                                    (INT merges; NOTIF/CRED via staging)

app/(auth)/<route>/page.tsx            thin page: composes components/features/<area>/*
app/(onboarding)/onboarding/[step]/    ONB
app/<public route>/                    SEO (public pages), EXT (/extension*)
components/features/<area>/*.tsx + *.module.css
hooks/<area>/use*.ts
lib/api/<area>.ts                      fetch wrappers via roboApi (client.ts)
lib/api/contracts/<area>.ts            `export type * from '../../../server/src/features/<area>/contract'`
__tests__/fixtures/<area>/*.json
i18n/staging/<namespace>.en.json
```

### 11.2 Hot files (FND creates or edits them before the feature waves; afterwards **only INT** touches them)

> **2026-10-10:** the authoritative hot list is `TASK_PLAN.md` §4.0. It adds every `.prisma` file (edited only by the orchestrator's SCHEMA-n steps), `tsconfig.json`, the frozen legacy client `lib/api/v2/**` + `lib/stub/raV2.stub.ts`, `hooks/shared/**`, `server/src/platform/consent/`, `server/src/platform/email/i18n.ts` and `scripts/api-boundary-baseline.json`. FND-6a owns `app/globals.css` and adds `@import '../styles/brands/goapply.css';` with an empty placeholder that the brand WP fills. Each WP works in its own git worktree (`TASK_PLAN.md` §2.4).

`server/prisma/schema/_datasource.prisma`, `server/prisma/schema/legacy.prisma`, `prisma.config.ts`, `package.json`, `package-lock.json`, `vercel.json`, `next.config.mjs`, `proxy.ts`, `lib/proxyPaths.ts`, `app/layout.tsx`, `app/providers.tsx`, `app/(auth)/layout.tsx`, `app/globals.css`, `app/robots.ts`, `lib/i18n.ts`, `lib/config.ts`, `lib/api/client.ts`, `lib/localeConfig.ts`, `lib/serverLocale.ts`, `i18n/messages/*.json`, `i18n/staging/index.ts`, `components/v3/shell/{Sidebar,MobileNav,Topbar,CommandPalette,AvatarMenu}.tsx`, `components/v3/primitives/**`, `server/src/app.ts`, `server/src/features/index.ts`, `server/src/cron/handlers.ts`, `server/src/roboapply/schedulers/RoboApplyCronService.ts`, `server/src/middleware/auth.ts`, `server/src/lib/requestContext.ts`, `server/src/lib/cookieOptions.ts`, `server/src/lib/llm/{llmModels,llmTaskSettings,llmStackConfigSchema}.ts`, `server/src/roboapply/v2/lib/raFeatureCatalog.ts`, `server/src/roboapply/v2/routes/index.ts`, `server/src/platform/queue/registry.ts`, `scripts/check-*.mjs`, `vitest.config.mts`, `.env.example`, `app/(auth)/settings/page.tsx` (it renders a registry of per-area section components; see the slots below).

**Slots FND creates so areas never edit hot files:**

| Slot (FND) | Renders (area-owned file) |
|---|---|
| `CopilotRailSlot` in `app/(auth)/layout.tsx` | `components/features/copilot/CopilotRail.tsx` (COP) |
| `MessageCenterSlot` in `Topbar` | `components/features/notifications/MessageCenterButton.tsx` (NOTIF) |
| `PlanBadgeSlot` in `Sidebar` | `components/features/credits/PlanBadge.tsx` (CRED) |
| `ExtensionPromptSlot` in the auth layout | `components/features/extension/InstallPrompt.tsx` (EXT) |
| `AnnouncementSlot` in the auth layout | `components/features/notifications/AnnouncementModal.tsx` (NOTIF) |
| `WrongBrandNudgeSlot` in the root layout | `components/features/brand/WrongBrandNudge.tsx` (BRAND) |
| Settings section registry `components/features/settings/registry.ts` | `components/features/<area>/SettingsSection.tsx` for search/alerts (PREF/NOTIF), account and security (AUTH), billing and credits (CRED), devices (EXT), copilot memory (COP), sensitive answers (PROF), referrals (GROW) |
| Nav registry `components/v3/shell/destinations.ts` (FND) | Static entries with `flag` and `href`; areas never edit it. Order: Jobs, Resume, Applications, Interview prep, Agent, Network, Profile; lower group: Messages, Invite friends, Get the extension, Settings |
| Queue handler registry `server/src/platform/queue/registry.ts` | imports `server/src/features/<area>/workers.ts` for every area |
| Cron stubs in `server/src/cron/handlers.ts` | call `server/src/features/<area>/cron.ts` exports |
| `server/src/features/index.ts` mounts | `server/src/features/<area>/routes.ts` (FND pre-creates each as `Router()` exporting nothing but the router) |

### 11.3 Area ownership table

`PROTECTED_PREFIXES` additions (FND): `/onboarding`, `/profile`, `/copilot`, `/agent`, `/network`, `/messages`, `/referrals`, `/cover-letters`, `/extension/connect`, `/coaching`. `/jobs`, `/resume`, `/applications`, `/practice` and `/settings` already exist.

| Area | Server (exclusive) | Prisma file | API mount | Frontend routes | Components / hooks / lib/api | i18n namespaces |
|---|---|---|---|---|---|---|
| FND | `server/src/platform/{queue,ratelimit,llm,sse.ts,flags.ts,http.ts}`, `platform/brand/*` (initial), hot files | `_datasource`, `legacy`, `ra-platform` | — | page shells for every new route | `components/v3/primitives/*` additions, `components/features/common/*`, `components/features/settings/registry.ts`, `lib/brand/*`, `lib/server/*`, `lib/flags.ts`, `lib/ui/popupGate.ts` | `nav`, `common` |
| BRAND | `platform/brand/{registry,persona}.ts` (values), `server/src/lib/brand.ts` stays recruiter-only | — | `/public/brand` | `app/[locale]/page.tsx` locale clamp | `components/landing/*` (wordmark only, shared with SEO: SEO owns content, BRAND owns `BrandWordmark`), `components/chrome/BrandSymbol.tsx`, `components/v3/shell/BrandLogo.tsx`, `components/features/brand/*`, `styles/brands/*`, `public/goapply-*` | `brand` |
| AUTH | `roboapply/routes/{auth,account}.ts`, `roboapply/engine/services/SeekerAuthService.ts`, `features/auth/*`, `platform/sms/*`, `SeekerAccount{DataWipe,Purge}Service.ts`, `lib/seekerConsentTypes.ts` | `ra-cn` (`RAPhoneOtp`), `ra-platform` (`RAAuthToken`, `RAAuthIdentity` fields) | `/auth/*`, `/account/*` | `app/(public)/{login,signup,forgot,reset}`, `app/auth/*` callbacks | `components/auth/*`, `components/v3/account/{security,deleteAccountModal}.tsx`, `lib/api/auth.ts`, `lib/auth/*`, `hooks/auth/*` | `auth`, `authExtra` |
| ONB | `v2/routes/onboarding.ts` (retire), `v2/services/RAOnboarding*`, `features/onboarding/*` | `ra-onboarding` | `/onboarding/*` | `app/(onboarding)/**` | `components/features/onboarding/*` (harvest `components/v3/setup/{ResumeStep,IngestRecap,EditableChipGroup}.tsx`, then delete `components/v3/setup/*`), `hooks/onboarding/*`, `lib/api/onboarding.ts`; deletes `hooks/useSetup*.ts` | `onboarding` |
| PROF | `features/profile/*` | `ra-profile` | `/profile/*` | `app/(auth)/profile/**` | `components/features/profile/*`, `hooks/profile/*`, `lib/api/profile.ts` | `profile` |
| PREF | `v2/routes/{preferences,goal}.ts`, `v2/services/{RAPreferencesService,RACareerGoalService}.ts`, `features/search/*`, `features/jobs/taxonomy/*` (taxonomy data shared read-only with INGEST) | `ra-search` | `/search-profiles/*`, `/taxonomy`, `/public/preferences` | `app/preferences/manage` (public) | `components/features/filters/*` (drawer, quick bar, chips), `components/v3/preferences/*` (rework into SettingsSection), `hooks/search/*`, `lib/api/search.ts` | `filters`, `settings` (owner of the existing namespace) |
| INGEST | `features/jobs/{ingest,normalize,enrich,geo,data,companies,h1b}/*`, `v2/lib/{raRapidApiJobs,raFantasticJobs,raJobProviders,raBankClients,raBankProviders,raCrossBankMatch,raExternalJobTypes}.ts`, `v2/services/RACrossBankSearchService.ts`, `v2/agents/RACrossBank*`, `server/src/job-search/{validation,agent}.ts` (country defaults only) | `ra-jobs` | `/companies/*` | — | — (company UI is JOB's) | `taxonomy` |
| FEED | `features/feed/*`, `v2/routes/search.ts` + `v2/services/RAJobIndexService.ts` (retire after cut-over) | `ra-feed` | `/feed/*`, `/public/feed` | `app/(auth)/jobs/page.tsx`, `/jobs/saved`, `/jobs/external`, `/jobs/explore` | `components/v3/today/*` (rework), `components/features/feed/*`, `hooks/feed/*`, `hooks/useTodayMatches.ts` (retire), `lib/api/feed.ts` | `jobs` (existing owner), `feed` |
| MATCH | `features/match/*`, `v2/agents/RAJobMatchScorerAgent.ts` | `ra-match` | `/match/*` | — | `components/features/match/*` (FitMeter, DimensionList, CompetitivenessReport), `hooks/match/*`, `lib/api/match.ts` | `fit` |
| JOB | `features/jobs/detail/*`, `features/jobs/import/*`, `v2/routes/jobs.ts` (retire) | — (reads `ra-jobs`) | `/jobs/*` | `app/(auth)/jobs/[id]/page.tsx` | `components/features/job/*`, `components/features/company/*`, `hooks/job/*`, `hooks/useJobDetail.ts` (retire), `lib/api/jobs.ts` | `jobDetail`, `company` |
| COP | `features/copilot/*`, `server/src/services/llm/**` (streaming + tools) | `ra-copilot` | `/copilot/*`, `/public/copilot` | `app/(auth)/copilot/page.tsx` | `components/features/copilot/*`, `components/chat/*`, `components/ui/StreamingText.tsx`, `hooks/copilot/*`, `lib/api/copilot.ts` | `copilot` |
| RES | `v2/routes/resumes.ts`, `v2/services/{RAResumeService,RAResumeAIService}.ts`, `v2/agents/{RAResumeTailorAgent,RAResumeRewriteAgent}.ts`, `v2/lib/{resumeExport,raResumeSeed,raResumeAIMessages}.ts`, `features/resume/*` | `ra-resume` | `/v2/resumes/*` | `app/(auth)/resume/**` | `components/v3/resume-editor/*`, `components/v3/resumes/*`, `components/resumes/*`, `components/features/resume/*`, `hooks/useResumes.ts`, `lib/{resumeStructure,resumeDownload,resumeAnalyzer}.ts`, `lib/api/resumes.ts` | `resume` (existing owner), `resumeGrade`, `tailor` |
| CL | `features/coverletter/*` | `ra-coverletter` | `/cover-letters/*` | `app/(auth)/cover-letters/**` | `components/features/coverletter/*`, `hooks/coverletter/*`, `lib/api/coverLetters.ts` | `coverLetter` |
| NET | `features/network/*` | `ra-network` | `/network/*` | `app/(auth)/network/**` | `components/features/network/*`, `hooks/network/*`, `lib/api/network.ts` | `network` |
| TRK | `v2/routes/{tracker,insights}.ts`, `v2/services/{RATrackerService,RAInsightService}.ts`, `v2/agents/RACareerInsightAgent.ts`, `features/tracker/*` | `ra-tracker` | `/v2/tracker/*`, `/v2/insights/*` | `app/(auth)/applications/**` | `components/v3/pipeline/*`, `components/features/tracker/*`, `hooks/{usePipelineBoard}.ts`, `hooks/tracker/*`, `lib/api/tracker.ts` | `applications` (existing owner) |
| AGENT | `features/agent/*` | `ra-agent` | `/agent/*` | `app/(auth)/agent/**` | `components/features/agent/*`, `hooks/agent/*`, `lib/api/agent.ts` | `agent` |
| EXT | `features/extension/*`, `extension/**` (entire package) | `ra-extension` | `/ext/*`, `/public/ext/*` | `app/extension/**` (public), `app/(auth)/extension/connect` | `components/features/extension/*`, `hooks/extension/*`, `lib/api/extension.ts` | `extensionWeb`, `extension` (bundle) |
| CRED | `platform/credits/*`, `platform/billing/*`, `roboapply/routes/{billing,stripeWebhook}.ts`, `roboapply/services/{RoboApplyBillingService,RoboApplyBillingReminderService}.ts`, `roboapply/lib/{billingEmails,invoiceReceipt}.ts`, `lib/{billingRegion,mockCreditService,mockInterviewPlans,rateCard}.ts`, `features/credits/*` | `ra-credits` | `/credits/*`, `/billing/*`, `/webhooks/wechatpay` | `app/(auth)/settings/billing/**`, `app/pricing` (content from SEO's template, owned by CRED) | `components/v3/account/{billing,planCatalog,CreditsCard,usage,billingHistory}.tsx`, `components/features/credits/*`, `hooks/useAccount.ts` (billing parts), `lib/{pricing,serverMarket}.ts`, `lib/api/account.ts` (billing functions), `lib/api/credits.ts` | `credits`, `pricing`, `email-billing` |
| NOTIF | `platform/email/*` (minus `templates/billing`), `services/EmailService.ts` (shim), `features/notifications/*`, `features/alerts/*` | `ra-notify` | `/notifications/*`, `/push/*`, `/announcements/*`, `/ui-state`, `/public/email/*` | `app/(auth)/messages/**`, `app/manifest.webmanifest/route.ts`, `public/sw.js` | `components/features/notifications/*`, `hooks/notifications/*`, `lib/api/notifications.ts` | `messages`, `alerts`, `email` |
| SEO | `features/seo/*`, `features/tools/*` | `ra-seo` | `/public/seo/*`, `/public/tools/*` | `app/{roles,remote,companies,job,entry-level,internships,new-grad,campus,visa-sponsorship,interview-questions,compare,tools,legal}/**`, `app/sitemap.xml`, `app/sitemaps/**`, `app/llms.txt`, `app/api/revalidate`, `app/robots.ts` (content; FND wires it) | `components/landing/*` (content), `components/features/seo/*`, `lib/seo.ts`, `lib/server/publicApi.ts` | `landing` (existing owner), `seo`, `tools`, `legal` |
| GROW | `features/growth/*` | `ra-growth` | `/referrals`, `/public/events` | `app/(auth)/referrals/**` | `components/features/growth/*`, `lib/analytics.ts`, `hooks/growth/*`, `lib/api/growth.ts` | `referral` |
| PREP | `features/prep/*`, `features/coaching/*` | `ra-prep` | `/interview-bank/*`, `/coaching/*` | `app/(auth)/practice/questions/**`, `app/(auth)/practice/companies/**`, `app/(auth)/coaching/**` (NOT `practice/page.tsx` or `practice/[id]/**`: Wave 0) | `components/features/prep/*`, `components/features/coaching/*`, `hooks/prep/*`, `lib/api/prep.ts` | `interviewBank`, `coaching` |
| CN | `features/cn/*` (campus calendar, CN onboarding validators, consents copy), `i18n/brands/goapply/*` | `ra-cn` (`RACampusEvent`) | `/cn/*` | `app/campus` content | `components/features/cn/*` | `cn` |
| ADMIN | `v2/routes/admin.ts`, `v2/services/RAAdmin*`, `features/admin/*` | — | `/v2/admin/*` | `app/(auth)/admin/**` | `components/v3/admin/*`, `hooks/useAdmin*.ts`, `lib/api/{admin,adminOperations}.ts` | `admin`, `adminOps` |
| CLEAN | the deletions in §10.6 only | — | — | — | — | — |
| Wave 0 (Track A) | `server/src/interview-engine/**`, `interview-agent/**`, `v2/routes/mock.ts`, `v2/services/{RAMockService,RAInterviewPromptService}.ts`, `v2/agents/RAMockInterviewer*`, `RAInterview*` | `ra-mock` | `/api/v1/interview-engine/*`, `/v2/mock/*` | `app/(auth)/practice/page.tsx`, `practice/[id]/**` | `components/v3/mock/*`, `lib/api/interviewEngine.ts`, `hooks/useMockV3.ts`, `hooks/useInterviewPreview.ts` | `practice` |

### 11.4 Collision rules

1. **One owner per file.** If a work package needs a change in a file it does not own, it writes the requested change into its handoff ("Requests for <AREA>/INT") instead of editing the file.
2. **Shared reads, single writers.** Areas may import another area's **service** (e.g. COP imports `FeedQueryService`) through `server/src/features/<area>/index.ts`, the area's public surface. They never import its internals. FND creates each `index.ts` exporting nothing; owners add exports. A missing export is a handoff request.
3. **Contracts first.** In the foundation wave, every area's `contract.ts` exists as a skeleton with the types named in §3 (empty bodies allowed), so consumers can compile against names.
4. **Existing V2 endpoints** remain live until the owning area's frontend no longer calls them. The retiring area deletes the old route in the same commit as the last caller.
5. **The stub** `lib/stub/raV2.stub.ts` is updated only by an area that changes `lib/api/v2/types.ts` (RES, TRK), and only for its own types (C37 build rule).
6. **Commits:** feature agents do not commit or push (memory note). The orchestrator commits per area after verifying the seam, staging explicit paths only (concurrent-session note).

---

## Appendix A. Environment variables introduced (FND adds names to `.env.example`; values are owner-supplied)

| Group | Names |
|---|---|
| Brand | `BRAND_HOST_MAP`, `BRAND_FORCE`, `BRAND_LOCK`, `COOKIE_DOMAIN_ROBOAPPLY`, `COOKIE_DOMAIN_GOAPPLY`, `EMAIL_FROM_ROBOAPPLY`, `EMAIL_FROM_GOAPPLY`, `GOAPPLY_ICP_NUMBER`, `GOAPPLY_PSB_NUMBER`, `BAIDU_SITE_VERIFICATION`, `BAIDU_PUSH_TOKEN`, `FLAG_<BRAND>_<FLAG>`, `INTERNAL_API_ORIGIN`, `INTERNAL_API_SECRET`, `RA_SYSTEM_USER_ID_ROBOAPPLY`, `RA_SYSTEM_USER_ID_GOAPPLY` |
| Auth | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `LINE_CHANNEL_ID`, `LINE_CHANNEL_SECRET`, `WECHAT_WEB_APP_ID`, `WECHAT_WEB_APP_SECRET`, `WECHAT_MP_APP_ID`, `WECHAT_MP_APP_SECRET`, `SMS_PROVIDER`, `ALIYUN_SMS_ACCESS_KEY_ID`, `ALIYUN_SMS_ACCESS_KEY_SECRET`, `ALIYUN_SMS_SIGN_NAME`, `ALIYUN_SMS_TEMPLATE_OTP`, `SMS_DAILY_MAX`, `SENSITIVE_DATA_KEY` |
| LLM | `LLM_COPILOT_MODEL`, `LLM_ENRICH_MODEL`, `LLM_WRITING_MODEL`, `CN_LLM_PROVIDER`, `CN_LLM_MODEL`, `CN_LLM_FALLBACK_MODEL`, `CN_LLM_{MATCHING,EXTRACT,ONBOARDING,REWRITE,INTERVIEW,COPILOT,ENRICH,WRITING}_MODEL`, `CN_LLM_ALLOW_OFFSHORE`, `COPILOT_DAILY_BUDGET_USD_ROBOAPPLY`, `COPILOT_DAILY_BUDGET_USD_GOAPPLY` |
| Jobs | `INGEST_ACTIVEJOBS_DAILY_CALLS`, `INGEST_LINKEDIN_DAILY_CALLS`, `INGEST_JSEARCH_DAILY_CALLS`, `ENRICH_DAILY_JOBS`, `SCORE_DAILY_BUDGET_ROBOAPPLY`, `SCORE_DAILY_BUDGET_GOAPPLY`, `SCORE_PRECOMPUTE_PER_USER_DAY`, `PUBLIC_DISPLAY_PROVIDERS`, `CN_EXTERNAL_PROVIDERS`, `FIRECRAWL_API_KEY` (exists), `MATCH_WEIGHTS` |
| Contacts | `CONTACT_EMAIL_PROVIDER`, `CONTACT_EMAIL_PROVIDER_KEY` (gated; unset by default) |
| Billing | `STRIPE_RA_PRO_WEEK_PRICE_ID`, `STRIPE_RA_PRO_MONTH_PRICE_ID`, `STRIPE_RA_PRO_QUARTER_PRICE_ID`, `RA_CN_PRO_WEEK_FEN`, `RA_CN_PRO_MONTH_FEN`, `RA_CN_PRO_QUARTER_FEN`, `WECHATPAY_ENABLED`, `WECHATPAY_MCH_ID`, `WECHATPAY_APP_ID`, `WECHATPAY_API_V3_KEY`, `WECHATPAY_CERT_SERIAL`, `WECHATPAY_PRIVATE_KEY` |
| Notifications | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `CN_EMAIL_TRANSPORT`, `ALIYUN_DM_ACCESS_KEY_ID`, `ALIYUN_DM_ACCESS_KEY_SECRET`, `ALIYUN_DM_ACCOUNT`, `ADMIN_ALERT_EMAILS` |
| Extension | `NEXT_PUBLIC_EXT_ID_ROBOAPPLY`, `NEXT_PUBLIC_EXT_ID_GOAPPLY`, `MIN_EXT_VERSION_ROBOAPPLY`, `MIN_EXT_VERSION_GOAPPLY` |
| Integrations | `ROBOHIRE_INVITE_SECRET` |

Fix in the same commit: `GOHIRE_PUBLIC_JOB_BASE_URL=https://www.gohire.top` (it currently says gohire.io, which is dead).

## Appendix B. Owner confirmations this plan needs (nothing proceeds silently)

1. Run `server/prisma/sql/000_extensions.sql` (pg_trgm), then **db push #1** (FND) and **db push #2** (INT) against the RoboApply Neon project, plus a Neon branch for INT's SQL smoke tests.
2. Pro plan prices per brand and interval; Stripe price ids; CNY amounts; referral reward size.
3. Providers allowed on public SEO pages (`PUBLIC_DISPLAY_PROVIDERS`).
4. Resend sending domains `mail.roboapply.io` and `mail.goapply.top`; Google OAuth client; LINE channel; WeChat Open Platform apps; Aliyun SMS signature; WeChat Pay merchant (or GoHire worker WeChat channel).
5. DOL LCA disclosure files to import (US public data; ADMIN runs `server/scripts/import-dol-lca.ts`).
6. Chrome Web Store and Edge Add-ons publisher accounts per brand.
7. GoApply hosting and licensing track (CN-L-01..09, CN-E-01): this branch ships GoApply on the shared stack with domestic LLM routing and the `BRAND_LOCK` seam, not mainland hosting.
