# Jobright clone: document index

**Branch:** `feat/jobright-clone`. **Revised:** 2026-10-10.

We are cloning jobright.ai (an AI job-search copilot) into one codebase that serves two brands. Every product feature and onboarding flow is in scope.
- **RoboApply** at `roboapply.io`: the international market, **including Taiwan**.
- **GoApply** at `goapply.top`: mainland China.

The brand is resolved per request from the Host header. Older research notes say "RoboHire.io" for the international brand. That was a typo. RoboHire stays our separate recruiter product.

## Binding owner decisions (2026-10-09)

| ID | Decision |
|---|---|
| **D1** | The product never submits an application for the user. "Ready to apply" and the extension find jobs, prepare materials and fill forms. The user always clicks Submit. Copy never claims auto-apply. |
| **D2** | Existing code may be overwritten where it conflicts with the clone. We keep the parts that work: resume editor, tailor and export, tracker, AI mock interview, Stripe and Alipay billing, job providers, cross-bank search, design tokens, 9-locale i18n, and the copy and design gates. |
| **D3** | Honesty. We never fabricate data a user would rely on. Every number shows its source. Features that need data we lack are either rebuilt on honest substitutes or gated on a real provider. |
| **D4** | The live AI mock-interview fixes are Wave 0 (Track A), already running on `main`. This plan does not re-plan them. |

## The documents

| File | What it is | Read it when |
|---|---|---|
| [`TASK_PLAN.md`](TASK_PLAN.md) | **The executable plan.** Covers precedence and conflict rulings (§1), rules for every work package (§2), waves 0–5 and INT (§3–§9), the owner/OPS track (§10), dependencies and seams (§11), risks (§12), the coverage matrix (§13), the machine-readable WP list (Appendix A) and the Revision log. | Always. It is the plan of record for the orchestrator and every coding agent. |
| [`PRODUCT_PLAN.md`](PRODUCT_PLAN.md) | User-facing behaviour: positioning, naming, information architecture, onboarding screens O0–O9 and G0–G7, the feature matrix with one decision per catalog ID and brand, pricing and credits, notifications, metrics, and cross-cutting product rules. | You build a screen, write copy, or need a feature's scope. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Engineering design: brand infrastructure, the multi-file Prisma data model, API surface, the ingestion and matching pipeline, the Assistant (copilot), the Chrome extension, credits and billing, notifications, SEO, i18n staging, testing, and file ownership. | You write server or data code, or need a contract. |
| [`CN_TW_LAUNCH_PLAN.md`](CN_TW_LAUNCH_PLAN.md) | Market specifics: brand registry values, capabilities, launch stages CN-0 and CN-1, mainland legal and filing steps, credentials, data residency, Taiwan specifics, and the zh / zh-TW glossary. It maps its work packages to `TASK_PLAN` IDs at the top. | You touch GoApply, Taiwan, consent, residency or Chinese copy. |
| [`FEATURE_CATALOG.md`](FEATURE_CATALOG.md) | The reverse-engineered Jobright catalog: about 200 feature IDs, onboarding S0–S12, pricing, and CN deltas. | You need to know what Jobright does for a given ID. |
| [`research/`](research/) | Eight raw research notes: product surface, onboarding, matching and jobs, Orion/agent/extension, resume suite, network/tracker/interview, business/growth/SEO, and China market. | Background only. Its claims are folded into the plans above. |

## How to read them

1. **Precedence.** D1–D4 come first. Then `TASK_PLAN.md` §1–§2. Then `PRODUCT_PLAN.md` for behaviour, names, routes and prices. Then `ARCHITECTURE.md` for code layout, data and API. Then `CN_TW_LAUNCH_PLAN.md` for market and legal specifics. Where CN_TW is stricter on legal, residency or data egress, CN_TW wins. Last comes `FEATURE_CATALOG.md`.
2. **Coding agents** read three things: their own WP section and Appendix A entry in `TASK_PLAN.md`, `TASK_PLAN.md` §1–§2, and the sections of the other plans that the WP cites. Each WP runs in its own git worktree (§2.4). It edits only the paths it owns, writes English strings to `i18n/staging/<namespace>.en.json`, and never commits or pushes. Always cite the full path `docs/jobright-clone/TASK_PLAN.md`; the repo also has an unrelated `docs/TASK_PLAN.md`.
3. **The orchestrator** follows `TASK_PLAN.md` §4.0 for setup, hot files and the gates G0–G7 with the SCHEMA-n steps, §2.5 for merges, and §11 for ordering.
4. **The owner** reads `TASK_PLAN.md` §10 (OPS) and the open decisions at the end of this file.
5. **What changed on 2026-10-10:** three reviews (feasibility, honesty, completeness) raised 102 items. All were accepted; a few took an alternative the critic offered. The full list is the Revision log at the end of `TASK_PLAN.md`.

## Shape of the plan

| Wave | WPs | Content |
|---|---|---|
| 0 | Track A | Interview and LLM resilience (on `main`) |
| 1 | 10 | Foundation: schema move and additions, brand core (server, web), platform plumbing, credits and the preference store, area scaffolds, web plumbing, shell and IA, route shells and stubs |
| 2 | 17 | Auth (both brands), brand UI, compliance, LLM routing and egress, content safety, residency, inventory (2 parts), enrichment, scoring, profile, filters, billing (2 parts), resume check, events |
| 3 | 16 | Onboarding (both brands), feed API and UI, job detail, job import, tailoring and the resume hub, cover letters, tracker, notifications (2 parts), marketing, CN and TW jobs, practice entry |
| 4 | 16 | Assistant (API, UI), Ready to apply (API, UI), people, extension (web, package), SEO, tools, campus calendar, question bank, PWA and push, WeChat Pay, interview seam, resume builder, GoApply AI-interview format |
| 5 | 13 | Extension adapters (intl, CN), coaching, WeChat notices, admin, cleanup, CN deploy kit, competitiveness report, visitor surfaces, account V2, invite friends, offer comparison, interview-agent backend |
| INT | 15 | Schema reconciliation and db push #2, i18n merge plus 8 translations, final wiring, gates and build, browser verification per brand, cleanup |

## Open owner decisions

Most of these have a safe default, so the code does not wait on them.
1. **Neon branch and pushes.** Create the clone branch and run `pg_trgm`. Then confirm db push #1, the additive push at each wave gate (SCHEMA-2…5) and push #2 (OPS-A1).
2. **Prices** for each brand and interval, the 7-day pass, packs and the referral reward. Also whether to offer an optional "Welcome price". Default: plans stay hidden until prices are set, and there is no offer (OPS-B1).
3. **Public display of jobs.** Decide which providers' terms allow public pages (default: none). RoboHire/GoHire also need an employer consent-to-syndicate field before any bank job goes public or is opened to AI crawlers (OPS-A4).
4. **Recruiter opt-in in RoboHire/GoHire** for being contactable by candidates. Until it exists, hiring contacts stay as deep links only (OPS-A10).
5. **GoHire parsing for RoboApply resumes**, which sends them to a mainland server (OD-3). Default: off.
6. **Track A** (OPS-A7):
   - ship recording off by default;
   - sign off WP-43, WP-63a/b and WP-66.
7. **Copy-gate additions**, including the per-locale bans and the 北森/牛客 ban (OPS-A8).
8. **Stripe test-mode prices** for every plan key before INT (OPS-A9).
9. **Counsel and privacy program** (OPS-C/D):
   - EU/UK representative;
   - DPAs with every processor;
   - auto-renewal, withdrawal and `/cancel` flows;
   - AI-generated markers on exports;
   - GoApply CN-0 cross-border consent text, or a PIPL standard contract if any sensitive data is transferred;
   - the collecting entity for GoApply payments (no 二清).
10. **GoApply staging:**
    - campus calendar in `off` mode, plus curation staff (OPS-B4/B6);
    - the Chinese brand name (OPS-B3);
    - the mainland filing sequence C-1…C-17.

## Owner decisions — 2026-10-10 (binding; answers to the plan's open items)

| Item | Decision |
|---|---|
| OPS-A1 clone database | **Neon branch** of the RoboApply project. The owner creates it and puts `DATABASE_URL` / `DIRECT_DATABASE_URL` in the clone worktree's `.env`; every additive push goes to the branch first, each diff shown to the owner. The main DB is pushed only at release. |
| Track A recording default | **Off.** Shipped on `main` in `8278e5f` (`INTERVIEW_ENGINE_RECORDING_ENABLED` is opt-in). WP-43 adds per-session consent, WP-63a the 90-day purge. |
| OPS-B1 prices | **Use the PRODUCT_PLAN §6.3 proposals in test mode:** RoboApply Pro $9.99/week, $24.99/month, $59.99/quarter; 7-day pass $6.99; practice packs 5 for $9.99, 15 for $24.99. GoApply non-renewing passes ¥12 week / ¥39 month / ¥99 quarter; practice packs ¥29 / ¥79 (GoApply charging stays off until `CN_PAYMENTS_ENABLED`). No launch offer. Amounts live in the plan catalog config; Stripe test price IDs attach via `STRIPE_PRICE_<PLANKEY>` once a `sk_test_` key is in the clone `.env` (empty today — OPS-A9). |
| OPS-A8 copy-gate additions | **Approved as listed in TASK_PLAN R-12** (incl. `unlimited`, `guarantee` affirmative, standalone ATS/JD, per-locale auto-apply bans, zh 北森/牛客). |

## D5 — Brand parity (owner, 2026-10-11; binding, overrides TASK_PLAN R-13 / R-14 / R-15 and CN_TW gating)

> "Both GoApply and RoboApply should have the same robust functionalities; the differences are the job board, job sources, job search APIs."

- A capability that is on for RoboApply is **on for GoApply by default**. GoApply never ships a feature dark because a China-specific credential or licence is missing.
- China-specific providers (`CN_LLM_*`, `CN_EMAIL_*`, `CN_LIVEKIT_*` / `CN_VOICE_*`, SMS, WeChat) are **optional overrides**: when set they are used; when absent GoApply **falls back to the shared stack** (the same LLM routing, email transport and voice infrastructure RoboApply uses).
- What legitimately differs: the **job board, job sources and job-search APIs** per brand, and what follows from the market (default language, currency, payment rail, additional sign-in methods, legal footer).
- Consent prompts, AI-generated labels and GoApply's additional features (campus calendar, 内推码, 一键填表, AI 面试 format) stay: they add to the product, they do not remove from it.
- D1 (never submit an application) and D3 (never fabricate data) are unchanged and apply to both brands.
