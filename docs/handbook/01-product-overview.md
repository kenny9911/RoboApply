# 01 · Product overview

As of 2026-11-03 (main @ b89d5256).

## What RoboApply is

RoboApply is an AI job-search copilot for candidates. It reads a person's resume, finds open roles they can realistically get, explains the gap between the resume and each posting, helps fix the resume and practise interviews, and tracks applications. Its feature set is a deliberate clone of jobright.ai (the reverse-engineered catalog of about 200 feature IDs is [`../jobright-clone/FEATURE_CATALOG.md`](../jobright-clone/FEATURE_CATALOG.md)), with one hard difference: **it never submits an application** (D1, below).

Users are individual job seekers (students and graduates included; there are student plans and a GoApply campus calendar). Staff use the `/admin` console. There is no recruiter side in this product.

### Two brands, one codebase

The brand is resolved per request from the Host header (`server/src/platform/brand/registry.ts`, mirrored to the web in `lib/brand/registry.generated.ts` by `npm run gen:brand`).

| | RoboApply | GoApply |
|---|---|---|
| Hosts | `roboapply.io`, `www.roboapply.io` (canonical `https://www.roboapply.io`) | `goapply.top`, `www.goapply.top`; locally `goapply.localhost` |
| Market id | `intl` (international, **Taiwan included**) | `cn` (mainland China) |
| Locales | all 9 (default `en`) | `zh`, `en` (default `zh`; SEO in `zh` only) |
| Currency / rail | USD via Stripe (subscriptions, passes, packs) | CNY via Alipay (the existing implementation; WeChat Pay also listed), one-time passes only |
| Sign-in | email + password, Google, LINE | email + password, phone OTP, WeChat (each appears when its credentials exist) |
| Job sources | employer ATS boards, RoboHire bank, JSearch, Active Jobs DB, Taiwan open data, USAJobs | employer boards with mainland postings, GoHire bank, Active Jobs DB behind a paid-plan gate |

A deployment serves both brands unless `ALLOWED_BRANDS` narrows it (`server/src/platform/brand/runtime.ts`). `ALLOWED_BRANDS=roboapply` keeps GoApply closed; a mistyped value never opens GoApply (it falls back to RoboApply only and logs). [`../jobright-clone/HANDOFF.md`](../jobright-clone/HANDOFF.md) §6 records it as set on Vercel Production and Preview on 2026-10-12, to be removed on the day GoApply goes live (unverified today: this was not re-read from Vercel). Locally, `./scripts/dev-clone.sh` serves both brands (`http://localhost:3621`, `http://goapply.localhost:3621`).

The two brands are one product (D5). Brand-specific behaviour is a capability flag (`flags` in the registry, overridable with `FLAG_<BRAND>_<KEY>`) or a `CN_<NAME>` variable that optionally overrides the shared `<NAME>` (`server/src/platform/brand/brandEnv.ts`). Never branch on brand for something that is not a market difference.

### RoboHire and GoHire

- **RoboHire** (`robohire.io`) is our separate recruiter product. RoboApply was extracted from the RoboHire monorepo, which is why `server/prisma/schema/legacy.prisma` still carries recruiter models (`Job`, `Candidate`, `Resume`, …) and why some `server/src/lib/*` modules (for example `matchBilling.ts`, `matchScoreReconcile.ts`) are recruiter-side code. RoboHire's job table is read as a **recruiter bank** (`bank_robohire`).
- **GoHire** (`gohire.top`, never `gohire.io`) is the mainland sister product. RoboApply uses it for two things: the **resume parse API** (`GOHIRE_API_BASE`, default `https://api.gohire.top`) and its job table as the GoApply **bank** (`bank_gohire`, read through a syndication endpoint that the GoHire backend has not built yet: [`../jobright-clone/market/GOHIRE_SYNDICATION.md`](../jobright-clone/market/GOHIRE_SYNDICATION.md)).
- Bank jobs from either product are synced but **not listed** until that product has a candidate-facing posting page and `ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE` / `GOHIRE_PUBLIC_JOB_URL_TEMPLATE` is set. A job with no working apply link is never listed.

## Binding rulings

Read the full text in [`../jobright-clone/README.md`](../jobright-clone/README.md) ("Binding owner decisions") before changing behaviour. In short:

| Ruling | What it means in code |
|---|---|
| **D1: never submit an application** | No code path calls an employer's apply endpoint. "Apply on company site" opens the posting and moves the tracker entry to Applied with an Undo. The extension fills forms and never clicks Submit/Next (enforced by `npm run check:extension`). Copy never claims auto-apply (copy gate in `npm run check`). |
| **D2: keep what works** | Resume editor, tailoring, tracker, mock interview, both billing rails, job providers, design tokens, 9-locale i18n and the copy/design gates were kept through the clone. |
| **D3: no fabrication** | Every number shows its source. Missing data is shown as missing ("not stated"), never estimated into a figure. Features that need data we lack are gated off (for example `contact_lookup` has a cap of 0). AI text is labelled as AI-written. |
| **D5: brand parity** | A capability on for RoboApply is on for GoApply. China providers are optional overrides; GoApply falls back to the shared stack. Only job sources, language, currency, prices, payment rail, sign-in methods and legal lines differ. Spec: [`../jobright-clone/GOAPPLY_PARITY_PLAN.md`](../jobright-clone/GOAPPLY_PARITY_PLAN.md). |
| **D6: per-market sources, prices, rails** | Alipay keeps working exactly as it does (its tests `A<n> …` are frozen, its callback and `fulfilPass.ts` are not edited). Stripe serves RoboApply only. Spec: [`../jobright-clone/market/MARKET_STRATEGY.md`](../jobright-clone/market/MARKET_STRATEGY.md), which wins over earlier plan numbers. |

The July 2026 overhaul rulings ([`../roboapply/OVERHAUL_RULINGS.md`](../roboapply/OVERHAUL_RULINGS.md), binding over [`../roboapply/OVERHAUL_SPEC.md`](../roboapply/OVERHAUL_SPEC.md)) still govern product language and the job card:

- **R1** auto-apply is dead; the primary action is "Apply on company site", which moves the card to Applied at once with "Undo / I didn't apply".
- **R2** position on the gap, not on fit: the card leads with what the resume is missing, the score is secondary.
- Plain-language corrections: the tracker columns (C1: Saved · Applied · First call · Interviewing · Final round · Offer · Rejected), one fit ladder (C2: Great fit · Good fit · Possible · Unlikely), no numeric threshold control (C3), "fit" not "match" in UI copy (C4), the score is never the headline and always carries "This is not your chance of getting hired." (C5), the published rubric 35/30/15/10/10 (C6), "Not interested" instead of "Pass" (C7).
- Its colour and type rulings (R3, R4) are superseded by the current design system.

**Design direction.** The current system is **Paper** ([`../design-system.md`](../design-system.md)), adopted October 2026 from [skillry.dev](https://skillry.dev) (measured in [`../skillry-style-reference.md`](../skillry-style-reference.md)): warm paper canvas, near-black ink for text and primary actions, one lime highlighter (`--brand-mark`, a fill, never a text colour), Bricolage Grotesque for all UI text. It replaced "Clarity" (violet, September 2026) but kept Clarity's token names, so components did not change markup. GoApply swaps the action to jade and the highlighter to mint (`styles/brands/goapply.css`). Source of truth: `app/globals.css`, `styles/tokens.css`, `styles/workspace.css`. Gate: `npm run check:design`. The `roboapply-design` skill encodes the rules for agents.

Order of precedence when documents disagree: D1–D6, then the parity plan and market strategy, then `docs/jobright-clone/TASK_PLAN.md` §1–2, then [`PRODUCT_PLAN.md`](../jobright-clone/PRODUCT_PLAN.md), then [`ARCHITECTURE.md`](../jobright-clone/ARCHITECTURE.md), then the catalog ([`../jobright-clone/README.md`](../jobright-clone/README.md) "How to read them").

## The user journey

1. **Land.** A signed-out visitor sees the brand home (`/`, or `/{locale}`), can try free tools, browse public job lists (only when enabled; see below), and read pricing.
2. **Sign up** at `/signup` (`app/(public)`), then **onboarding** at `/onboarding/<step>` (`app/(onboarding)`). RoboApply steps: `situation → basics → goal → preferences → resume → matching → confirm`; GoApply: `consent → identity → education → intent → tags → resume → matching → confirm` (`components/features/onboarding/flow.ts`, kept equal to the server stage machine in `server/src/features/onboarding/contract.ts`). The resume is the one required input; the `matching` step triggers a targeted ingest for the new search profile so the first feed is not empty. Design rationale: [`../roboapply/ONBOARDING_SPEC.md`](../roboapply/ONBOARDING_SPEC.md).
3. **Jobs** (`/jobs`): the ranked feed with the gap-first card, filters, natural-language search, and job detail with fit explanation.
4. **Act** on a job: save, tailor the resume, write a cover letter, prepare a "Ready to apply" kit, open the employer page (moves the job to Applied), fill the form with the extension.
5. **Track** at `/applications`, **practise** interviews at `/practice`, ask the **Assistant**, get **alerts** by email, web push and the inbox.

### Signed-in routes

Every signed-in top-level path must be listed in `PROTECTED_PREFIXES` (`lib/proxyPaths.ts`); a test checks the list against the route tree, and `robots.txt` disallows the same set (`lib/seo.ts` `robotsFor`). The same list drives the stale-session redirect in `lib/api/client.ts`, so a missing entry strands users on a 401 page. The nav registry is `components/v3/shell/destinations.ts` (per brand, flag-gated). Frontend API calls go through `lib/api/*`. Seeker API routers mount under `/api/v1/roboapply/*` from the table in `server/src/features/index.ts`; older routers still live in `server/src/roboapply/`.

| Route | What it is | Main frontend | Main server module |
|---|---|---|---|
| `/onboarding/[step]` | First-run setup (RoboApply and GoApply screen sets) | `components/features/onboarding`, `onboarding-cn` | `features/onboarding`, `features/onboarding-cn`, `features/jobs/ingest` (targeted ingest) |
| `/jobs` | Ranked job feed, filters, NL search | `components/features/feed` (`JobsWorkspace`), `components/features/filters` | `features/feed`, `features/search`, `features/match` |
| `/jobs/[id]` | Job detail, fit, similar jobs, apply/save | `components/features/job` (`JobDetailPanel`) | `features/jobs/detail`, `features/match`, `features/jobs/liveness` |
| `/jobs/explore` | Category browse (also where `/job-search` redirects) | `components/features/feed` (`Explore`) | `features/feed` |
| `/jobs/added` | Jobs the user imported from a link or text | `components/features/jobimport` | `features/jobs/import` |
| `/jobs/report` | Competitiveness report | `components/features/match` | `features/match` (`CompetitivenessService`) |
| `/job-search/developers` | API keys for the public job-search API | `components/job-search/ApiKeyWorkspace` | `server/src/job-search` |
| `/ready`, `/ready/setup`, `/ready/[jobId]` | "Ready to apply": weekly list and prepared kits (flag `agent`) | `components/features/agent` | `features/agent` |
| `/applications` | Applications tracker (pipeline board) | `components/v3/pipeline`, `components/features/tracker` | `features/tracker` (+ legacy `roboapply/v2/routes/tracker.ts`) |
| `/resume`, `/resume/[id]`, `/resume/new`, `/resume/[id]/check` | Resume hub, editor, builder, resume check | `components/features/resume`, `components/v3/resumes`, `components/features/tailor` | `roboapply/v2/routes/resumes.ts` + `RAResumeService`, `features/resume` (tailor, check, builder) |
| `/resume/letters`, `/resume/letters/[id]` | Cover letters | `components/features/coverletter` | `features/coverletter` |
| `/assistant` | Full-page Assistant (also a rail opened from the top bar "Ask") | `components/features/copilot` | `features/copilot` |
| `/practice`, `/practice/[id]`, `/practice/[id]/report`, `/practice/questions` | Mock interviews (voice via LiveKit, or text), reports, question bank | `components/features/practice`, `practice-cn`, `prep`, `components/v3/mock` | `server/src/interview-engine`, `features/prep`; voice worker in `interview-agent/` |
| `/coaching` | Human coach booking (flag `coaching`, shown when a roster exists) | `components/features/coaching` | `features/coaching` |
| `/inbox` | Message center (opened from the bell) | `components/features/notifications` | `features/notifications` |
| `/profile` | Career profile | `components/features/profile` | `features/profile` |
| `/settings`, `/settings/billing[/history,/return]` | Search preferences, notifications, account, plans and billing | `components/features/settings`, `components/features/credits`, `components/v3/account` | `features/auth` (account), `features/credits`, `features/notifications`, `roboapply/routes/billing.ts` + `stripeWebhook.ts`, `platform/billing` |
| `/invite` | Invite friends (flag `invites`) | `components/features/growth` | `features/growth` |
| `/referrals` | GoApply 内推码 hub (flag `cn.referralCodes`, off on RoboApply) | `components/features/network` (`ReferralHub`) | `features/cn/referrals` |
| `/admin/*` | Staff console: users, sources, system health, credits, fraud, campus, coaches, questions, announcements, invites, reports, sessions | `app/(auth)/admin`, `lib/api/admin*.ts` | `features/admin` and the per-area admin routers under `/api/v1/roboapply/admin/*`; admin "view as" is read-only (`platform/viewAs`) |

Old paths (`/home`, `/tracker`, `/resumes`, `/mock-interview`, `/queue`, `/preferences`, `/account`, …) are permanent redirects in `next.config.mjs` `redirects()`, which is the only destination router. `proxy.ts` only gates auth and stamps `x-pathname`; do not add routing there.

### Public routes

Public pages that signed-in users also use render in `HybridShell` (app shell with a session, marketing chrome without one).

| Route | What it is | Server side |
|---|---|---|
| `/`, `/[locale]` | Brand home (RoboApply gap-first, GoApply 少填表 home), localized at `/{locale}`; live job ticker that renders nothing when there are no public rows | `components/features/marketing`, `features/seo` (ticker) |
| `/pricing` | Plans from the plans API, never hard-coded | `features/credits` (`GET /api/v1/roboapply/billing/plans`) |
| `/features/[slug]`, `/about`, `/security`, `/help/ranking` | Marketing and explainer pages (`/help/ranking` explains the ranking) | static/i18n |
| `/tools`, `/tools/[tool]`, `/tools/job-alerts` | Free tools (resume check, resume–job match, visitor job alerts) | `features/tools`, `features/visitor` |
| `/job/[idSlug]` | Public job page with JobPosting JSON-LD; 404 unless the row may be shown publicly, 410 when closed | `features/seo` (`/api/v1/public/seo/jobs/:id`) |
| `/browse/[...path]` | Programmatic job lists by role/city/remote/visa; behind flag `seo.browse` (off by default on both brands) | `features/seo` |
| `/campus`, `/campus/[company]` | GoApply campus calendar (empty until staff publish events) | `features/cn/campus` |
| `/developers/job-search` | Public reference for the job-search API | `server/src/job-search` (OpenAPI) |
| `/extension` | Extension install and pairing page | `features/extension` |
| `/legal/[doc]` | Legal documents from `content/legal/` | `features/compliance` |
| `/r/[code]` | Invite link landing (not indexed) | `features/growth` |
| `/alerts/confirm/[token]`, `/unsubscribe/[token]`, `/cancel` | Visitor alert confirmation, email unsubscribe, public cancel/withdrawal | `features/visitor`, `features/notifications`, `features/credits` |
| `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/verify-email`, `/bind-phone` | Auth (`app/(public)`) | `features/auth`, `features/auth-cn`, `roboapply/routes/auth.ts` |
| `/sitemap.xml`, `/sitemaps/[file]`, `/robots.txt`, `/llms.txt` | SEO plumbing | `features/seo` |

**Public job display is off by default.** `PUBLIC_DISPLAY_PROVIDERS` is empty, so no ingested posting gets a signed-out page, sitemap entry or ticker row. Only recruiter-bank jobs with syndication consent would, and those are held until the bank's posting page exists. The decision belongs to the owner after reading [`../job-search/SOURCE_REGISTER.md`](../job-search/SOURCE_REGISTER.md).

### Chrome extension

`extension/` is a separate MV3 package (own `package.json`, not part of the root workspace) with two brand builds: "RoboApply for Chrome" and GoApply 一键填表 (Edge first). It fills application forms on employer ATS pages from the user's profile and saved answers, then says "Check the form, then submit it yourself." The only submit signal is the user answering "Did you submit this application?". Adapters: `extension/src/adapters/intl` (Greenhouse, Lever, Ashby, Workday, iCIMS, SmartRecruiters, SuccessFactors, Taleo, Workable, generic) and `extension/src/adapters/cn` (Moka, 北森, Feishu, Dayee, generic). See [`../../extension/README.md`](../../extension/README.md) and [07a](07a-feature-guide-jobs.md#chrome-extension).

## Plans, credits and prices

Two layers, both in `server/src/platform/`:

- **Plans** (`billing/planCatalog.ts`): catalog default prices in code, one table per brand; an env value only overrides. RoboApply (USD, tax-inclusive, Stripe): Pro $9.99/week, $24.99/month, $54.99/quarter; 7-day pass $9.99; practice packs 5 for $9.99 and 15 for $24.99; student $17.49/month, $37.99/quarter (`ROBOAPPLY_DEFAULT_PRICE_USD_CENTS`). GoApply (CNY, non-renewing passes): ¥12 week, ¥39 month, ¥99 quarter; practice packs ¥29/¥79; student ¥29/¥69 (`GOAPPLY_DEFAULT_PRICE_FEN`). Overrides: `PRICE_<PLANKEY>_USD_CENTS`, `CN_PRICE_<PLANKEY>_FEN` (whole yuan only), optional `STRIPE_PRICE_<PLANKEY>` pin. Stripe prices are found or created at checkout by lookup key (`billing/stripeCatalog.ts`); no price id must be configured. Taiwan TWD prices exist only when `PRICE_<PLANKEY>_TWD_CENTS` is set.
- **Credits** (`credits/catalog.ts`): every AI action draws from a daily or weekly bucket with a free cap and a Pro cap (for example `tailor`, `cover_letter`, `assistant` 30/day free and 300/day Pro, `autofill` 20/day free on both brands, `ready_kits` per week). Every plan has a cap; UI copy prints it and never says "unlimited". Admins can override caps without a deploy via AppConfig `credits.catalog.v1`. Practice-interview credits are separate (`credits/practice.ts`, `mockCreditService`).
- **When a payment can open:** RoboApply needs a usable Stripe key and a verifiable webhook secret (a live key is refused outside production); GoApply needs `ALIPAY_CALLBACK_SECRET` (`CN_PAYMENTS_ENABLED=false` is its kill switch). Until then plans are listed with prices and "payments disabled".

Price ladders, renewal and refund rules: [`../jobright-clone/market/MARKET_STRATEGY.md`](../jobright-clone/market/MARKET_STRATEGY.md) §3–5; Stripe test recipe and Alipay cut-over in the same folder. Owner steps still open (live webhook, Stripe Tax, counsel on withdrawal) are in [`../jobright-clone/README.md`](../jobright-clone/README.md) "Owner steps still open".

## Locales and brand in copy

Nine locales: `en`, `zh`, `zh-TW`, `ja`, `ko`, `es`, `fr`, `pt`, `de` (`ALL_LOCALES` in the brand registry; bundles in `i18n/messages/<locale>.json`, email strings in `server/src/i18n/email/`, extension strings in `extension/src/i18n/`).

- URLs are flat (no locale prefix) except the home pages at `/{locale}`. The locale comes from the `robo_locale` cookie, else Accept-Language (`lib/serverLocale.ts`).
- **Bundles never contain a literal brand name.** They use `%BRAND%` and `%OTHER_BRAND%`, replaced at load time by `loadMessages(locale, brandId)` in `lib/i18n.ts`. GoApply may carry `i18n/brands/goapply/<locale>.json`, deep-merged before substitution; it changes the words of existing keys only (for example no LinkedIn import, passes instead of subscriptions) and never adds or hides keys. Hide a section with its capability flag, not with copy.
- New English strings go to `i18n/staging/<namespace>.en.json` and are merged by `node scripts/i18n-merge-staging.mjs`; then translate into the other locales (use the `i18n-locale-sync` skill) and run `npm run check` (copy rules, `zh` vs `zh-TW` variants, banned words such as auto-apply claims). GoApply-only namespaces (`authCn`, `billingCn`, `jobsCn`, `onboardingCn`, `practiceCn`, `notifyCn`, `campus`, `landing.cnHome`) are required in `en` and `zh` only.
- next-intl renders a missing dotted path silently as the key; rely on `npm run check`, not on a visual check.
- LLM output language: an agent that writes user-facing text must ask `LanguageService.getStrictOutputLanguageDirective(locale, 'content')` (`server/src/services/LanguageService.ts`; see `CoverLetterAgent.ts` and `features/prep/agents.ts`). The `'analysis'` scope does not force the output language, and the text ships in English.

## Stale or contradictory sources (as of this date)

- `AGENTS.md` and `README.md` name `server/prisma/schema.prisma`; the schema is the multi-file folder `server/prisma/schema/` (`prisma.config.ts`).
- `AGENTS.md` "Work in progress on this branch: `feat/practice-prep`": that work is merged (PR #5); this is `main`.
- `README.md` says the two brands are "on the `feat/jobright-clone` branch" and that `vercel.json` wires "7 cron jobs"; the clone is merged (PR #4, `355be094`) and `vercel.json` has 16 crons.
- `README.md`, `prisma.config.ts` and the header of `server/src/app.ts` say the database is shared with RoboHire. Team notes say RoboApply moved to its own Neon project; not verifiable from the repository.
- The `lib/proxyPaths.ts` header says a new route must also go into `APP_PATHS` in `app/robots.ts`; `robots.ts` now derives its rules from `PROTECTED_PREFIXES` via `lib/seo.ts`.
- [`../jobright-clone/HANDOFF.md`](../jobright-clone/HANDOFF.md) §2 says "Nothing from this work is on `main`"; it is on `main` now. Its §6 says `CRON_SECRET` was not set on Vercel, so production crons answered 401 (state on 2026-10-12; unverified today).
- [`../job-search/PRODUCT_SPEC.md`](../job-search/PRODUCT_SPEC.md) describes a `/job-search` workspace page; it is gone and redirects to `/jobs/explore`. [`../job-search/LINKEDIN_STRATEGY.md`](../job-search/LINKEDIN_STRATEGY.md) and [`../job-search/PROVIDER_EVALUATION.md`](../job-search/PROVIDER_EVALUATION.md) recommend the LinkedIn adapter; MARKET_STRATEGY M-4 dropped LinkedIn as a source on both brands, and the code refuses it.
