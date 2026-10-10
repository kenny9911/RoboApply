# RoboApply + GoApply: Product Plan for the Jobright Clone

**Status:** binding product plan for implementation agents. **Owner:** Head of Product. **Date:** 2026-10-09, revised 2026-10-10 after three critic reviews (see `TASK_PLAN.md` → Revision log). Brand ids in code are `roboapply`/`goapply` with `market` `intl`/`cn` (`TASK_PLAN.md` R-01); where this plan says brand `intl`/`cn`, read the market.
**Branch:** `feat/jobright-clone`. **Inputs:** `FEATURE_CATALOG.md` (feature IDs, onboarding S0–S12), `research/*.md`, the five codebase maps, `docs/roboapply/OVERHAUL_RULINGS.md`, `docs/design-system.md` (Clarity), `AGENTS.md`.

> **Brand correction.** Some research notes say "RoboHire.io" for the international brand. That was a typo. The international seeker brand is **RoboApply at roboapply.io**, and it **includes Taiwan**. RoboHire.io stays our separate recruiter product. The mainland China brand is **GoApply at goapply.top**. Internal brand ids are **`intl`** and **`cn`**. Do not reuse the recruiter ids `robohire`/`gohire` or the `APP_NAME` env var; those select recruiter job banks and databases.

> **2026-10-10 revision (binding).** Open application moves the job to Applied at once with Undo; the extension never detects submits and never types AI answers without per-field approval; no LinkedIn URL import and no applicant counts; "Recruiter-posted" replaces "Direct from employers" as the filter, with no ranking boost; one sample rule (≥20) for every aggregate; public counts use public rows only; no launch offer and no competitor price comparisons; auto-renewal, withdrawal-waiver, age-16 and analytics consents; "Tips and reminders" preference for promotional nudges; 个性化推荐 has no default; CN-0 names its offshore processors; sensitive CN/EEO fields never enter a prompt. `TASK_PLAN.md` §1–§2 carry the full rules.

> **2026-10-11 revision (binding): owner rulings D5 and D6.** **D5:** GoApply and RoboApply have the same robust functionality; the differences are the job board, job sources and job-search APIs, plus what follows from the market (language, currency, prices, payment rail, extra sign-in methods, legal lines). A feature that is on for RoboApply is on for GoApply by default, on the shared stack; a China-specific provider is an optional override. GoApply's extras (校招日历, 内推码, 一键填表, the AI 面试 format), its consent prompts and its AI-generated labels stay: they add, they never remove. **D6:** job sources, prices and payment rails are set per market; GoApply pays through the existing Alipay rail and RoboApply through Stripe. Specifications: `GOAPPLY_PARITY_PLAN.md` and `market/MARKET_STRATEGY.md`. In this document that changes: §0, the GoApply `/pricing` row of §3.2, the legend of §5.0, the note of §5.3, the GoApply column of the rows marked "D5" in §5, §6.2 (practice), §6.3 (GoApply prices), §7.1 (channels) and §8.2 (staged depth). Anywhere else, a GoApply cell that makes a feature wait for a licence, a filing, a domestic model, mainland voice infrastructure or a payments switch is no longer the rule.

> **How to use this document.** Section 5 (feature matrix) is the scope contract: every catalog feature ID has one decision per brand. Section 4 (onboarding) is screen-level spec. Section 6 (pricing) defines credit keys and plan keys that the foundation wave creates. Section 8 (MVP vs full) says how deep each area goes in each release, so the build can stop after any release without leaving dead ends. Where this plan and the catalog disagree, this plan wins. Where this plan and the binding owner decisions D1–D4 disagree, D1–D4 win.

---

## 0. Binding decisions this plan implements

| # | Decision | What it means in this plan |
|---|---|---|
| D1 | **The product never submits an application.** | Jobright's Agent is cloned as **Ready to apply**: we find jobs, prepare a tailored resume, cover letter and answers, and fill forms through the extension. The user clicks Submit on the employer's site. No server-side Easy Apply, no Automated Mode, no Gmail code reading. Copy never claims auto-apply. |
| D2 | Existing code may be overwritten where it conflicts. | We keep the resume editor/tailor/export, tracker, voice/video practice interviews, Stripe + Alipay billing, job providers, cross-bank search, Clarity tokens, 9-locale i18n and the copy/design gates. We replace the 8-card feed, the setup panel, the disconnected `/job-search` workspace, the dead V1 auto-apply engine and the fake integrations. |
| D3 | **Never fabricate data a user relies on.** | Every number on screen has a named source (§9.3). Features that depend on proprietary data we lack are either rebuilt on honest sources or marked DEFER with the unblocking data source. |
| D4 | Live interview fixes are **Wave 0** (Track A, already running). | This plan does not re-plan them. It only states the product requirements that depend on them (practice from a job, first practice free) and the success metrics they must hit. |
| D5 | (2026-10-11) **Both brands have the same robust functionality**; only the job board, job sources and job-search APIs differ, plus what follows from the market. | Every "= intl" in the GoApply column means the same feature at the same depth, on by default. GoApply is never a reduced, seeker-tools-only product waiting for a licence or credential. Its additional features and consent prompts stay. |
| D6 | (2026-10-11) **Sources, prices and payment rails are per market.** | GoApply: CNY ladder, one-time passes through the existing Alipay rail, purchasable by default. RoboApply: USD ladder through Stripe. A plan is never "price not set" (§6.3). |

Also resolved from the catalog's open decisions: D-01 (supervised only, both brands), D-02 (international brand is RoboApply), D-06 (public pricing page, renewal reminders actually sent, one-click cancel), D-07 (no fake urgency, no fake anchors, no static counters). D-03, D-04, D-08 are addressed in §5 and §10.

---

## 1. Product thesis and positioning

### 1.1 RoboApply (international, roboapply.io, including Taiwan)

RoboApply is a job-search copilot for people who apply and hear nothing back. It reads open roles from several sources, ranks the ones that fit, and leads every job with **the gap**: what the employer asks for that the resume doesn't show, and what already overlaps. It then fixes that gap for the specific job (tailored resume, cover letter, answers to application questions), prepares a weekly list of jobs that are **ready to apply**, and lets the user **practice the interview** for that exact job in a live voice or video session. It works in 9 languages and many countries, generalizes the US-only H-1B filter into a visa and work-permit question for any country, and never invents data: no fake applicant counts, no fake funding tags, no fake contacts. The user always makes the final click.

**Positioning against Jobright.** Jobright says "we find jobs that fit you and apply for you". RoboApply says "we show you why you're not getting interviews, fix it for each job, and get you ready for the interview". The differences we sell, in order:
1. **Gap first, explained.** Jobright shows an opaque percentage. Our fit score is a published, weighted rubric with an evidence line per component (ruling C6), and the card leads with the gap (ruling R2).
2. **Practice interviews.** Jobright has no self-serve scored mock interview (catalog F-INT-06, X-11). We have live voice and video practice with a report, briefed by domain playbooks. This is the moat; the first full practice is free (ruling C42).
3. **Honest by construction.** Real counts, sourced numbers, verified tailoring (every inserted claim must be confirmed by the user before export), no countdown tricks, public pricing, one-click cancel.
4. **Multi-country and multilingual.** 9 UI languages; the job search, pay currency and sponsorship question follow the target country. Taiwan gets zh-TW copy, NT$ salary handling and (later) LINE Login.
5. **Lower price.** Pro is priced well below Jobright Turbo (§6.3). This is an internal positioning note: UI and marketing copy never name competitors or compare prices (competitor prices change and we cannot keep them sourced).

### 1.2 GoApply (mainland China, goapply.top)

GoApply is an employer-neutral 求职助手 for 应届生, 在校生 and 社招 job seekers in mainland China. It does three jobs that no single board does: it keeps the **校招日历** (which campus programmes are open for your 届别, when 网申 closes, where the official link is) and reminds you before deadlines; it turns **one profile into many 网申 forms** (Chinese resume builder, tailored versions, and later a 一键网申 extension, with the user submitting every form); and it lets you **practice the AI面试** in the formats employers commonly use (user-facing copy: "模拟企业常用的 AI 面试形式"; vendors such as 北森 or 牛客 are never named), audio-first. In the CN-0 offshore beta, data is processed outside the mainland (named in the consent and privacy notice); from CN-1 it stays in mainland infrastructure; every job shows its source, expiry and pay (or "薪资未披露"), the copilot can remember your search across sessions with your consent, and the free tier is generous because the incumbent (智联's 职悟空) is free. GoApply never auto-greets or auto-applies on BOSS直聘/智联, and never scrapes them.

**Positioning against Jobright and local incumbents.** Jobright is US-only and English-only. 职悟空 is tied to 智联's inventory. GoApply wins on being cross-platform: one profile, one tracker and one deadline calendar across official portals, imported JDs, GoHire jobs and 内推 codes, plus interview practice nobody else does in the employers' own format.

### 1.3 What we keep from current RoboApply (both brands)

| Keep | Why | Where it goes |
|---|---|---|
| Gap-first fit explanations (ruling R2), the four-word tier ladder `Great fit · Good fit · Possible · Unlikely` (C2), the permanent line "This is not your chance of getting hired." (C5) | Our honest answer to Jobright's opaque score | Job card, job detail, assistant |
| Voice/video practice interviews (Interview Engine + LiveKit worker, domain playbooks, reports) | The differentiator; Jobright lacks it | `/practice`, entry from every job ("Practice for this job") |
| Resume upload and parse (GoHire parse API first), structured editor, inline AI rewrite, tailor-diff with before/after rescore, CitationGuard, PDF/DOCX export | Already better than Jobright on grounding | `/resume`, tailor from any job |
| Tracker with 8 statuses, notes, follow-up date, salary, board view (`By stage` / `By date`) | Jobright's tracker has no notes or reminders (F-TRK-02) | `/applications` |
| Stripe (USD) and Alipay (CNY) billing, renewal reminders, invoice history, credit ledger | Working rails | Plans in §6 |
| RapidAPI providers (JSearch `/search-v2`, ActiveJobsDB, LinkedIn) and the cross-bank RoboHire/GoHire search | Inventory | Now **persisted** into `RAJob` by a scheduled ingest |
| Clarity design tokens, 9 locales, `npm run check` gates, the plain-language rulings (section B of the rulings) | Quality bar | Everything |
| Admin console | Ops | Plus new admin tools (§3.5) |

---

## 2. Naming

### 2.1 Brands

| | International | Mainland China |
|---|---|---|
| Brand id (code) | `intl` | `cn` |
| Display name | RoboApply | GoApply (Chinese contexts: GoApply 求职助手) |
| Primary domain | `www.roboapply.io` | `www.goapply.top` (fallback `goapply.cn` if .top cannot be ICP-filed, CN-L-02) |
| Default locale | `en` (Accept-Language and `/{locale}` decide; zh-TW for Taiwan) | `zh` (Simplified); `en` as a secondary UI language |
| Allowed UI locales | all 9 | `zh`, `en` |
| Markets | Everyone outside mainland China, including Taiwan, Hong Kong, Macau | Mainland China |
| A visitor in the "other" market | Mainland visitor on roboapply.io sees a dismissible notice linking to goapply.top. Never auto-redirect. | zh-TW or non-CN visitor on goapply.top sees a notice linking to roboapply.io. Never auto-redirect. |

### 2.2 The copilot (Jobright's "Orion")

**Decision: the copilot is a feature, not a character. It is called "Assistant" in the UI on both brands.**

| | RoboApply | GoApply |
|---|---|---|
| Feature name (UI) | **Assistant** | **求职助手** (en UI: Assistant) |
| Marketing form | RoboApply Assistant | GoApply 求职助手 |
| Per-job entry button | **Ask about this job** | **问问这个职位** |
| Global entry | Topbar button "Ask" + floating button; shortcut Cmd/Ctrl+J | Same; mobile: floating button |
| Avatar | The brand symbol in a neutral circle. No face, no name, no emoji persona. | Same |

Why: "Assistant" translates cleanly into all 9 locales (助手 / 助理 / アシスタント / 어시스턴트 / Asistente / Assistant / Assistente / Assistent) and is a generic word, so "RoboApply Assistant" does not clash with any trademark. We avoid "Copilot" (Microsoft/GitHub trademark), "Orion" (Jobright's), and any human name. Rulings D4 and C9 deleted the agent persona and first-person system copy; this keeps that intact.

Voice rules:
- **System copy** (empty states, toasts, buttons, headings, onboarding, errors) has no speaker: no "I", no "me", no self-introduction. Example: "3 jobs match the new filter." not "I found 3 jobs for you!"
- **Chat replies** answer the question directly. They may use "you" freely and a functional "I" only when unavoidable ("I can't see your resume yet; add one to compare."). They never introduce themselves, never claim feelings, and never claim to act on the user's behalf.
- Onboarding screens use plain headings. No avatar speaks during onboarding.

### 2.3 Plans

| | RoboApply | GoApply |
|---|---|---|
| Free tier | **Free** | **免费版** |
| Paid tier | **Pro** (Weekly, Monthly, Quarterly; plus a one-time **7-day pass**, no renewal) | **会员** (周卡, 月卡, 季卡; all one-time passes, no auto-renew) |
| Interview add-on | **Practice pack** (5 or 15 practice credits) | **面试练习包** (5 or 15) |
| Plan key prefix (code) | `pro_*` | `pro_*` (same keys; brand decides price, currency and rail) |

"Pro" is a loanword in every target language, so it needs no translation. Chinese users expect 会员 for a membership.

### 2.4 Feature names (canonical English; translators localize)

| Jobright name | RoboApply name | GoApply name (zh guidance) | Note |
|---|---|---|---|
| Recommended / For you | **For you** | 为你推荐 | Feed tab |
| Match score, STRONG/GOOD/FAIR MATCH | **Fit score**, tier `Great fit / Good fit / Possible / Unlikely` | 匹配度 + 很合适 / 比较合适 / 可以试试 / 差距较大 | Never "match" in UI (C4); never "strong match" (banned) |
| Why this job is a match | **Why you fit** + **What you're missing** | 为什么推荐 + 还缺什么 | PIPL Art. 24 explanation on cn |
| Liked | **Saved** (action: "Save for later", C7) | 收藏 | Lives in Applications |
| Not Interested | **Not interested** | 不感兴趣 | |
| External jobs / Job Clipper | **Added by you** (action: "Add a job") | 我添加的 | |
| Explore | **Explore** | 发现 | |
| Hidden Jobs | **Recruiter-posted** (filter) · **Direct from employer** (badge, only when verified) | 招聘方发布 · 企业直招 (badge, only when verified) | Filter = jobs from the RoboHire/GoHire banks (`fromRecruiterBank`), free. The badge "Direct from employer"/企业直招 shows only when the poster is not an agency and the posting company equals the account's verified employer; otherwise the source line reads "Posted on {sourceName} by a recruiter" / "来源：GoHire". Never "not on other job boards". |
| Custom Resume | **Tailored resume** (action: "Tailor my resume") | 定制简历 | |
| Resume Analysis / ATS score | **Resume check** | 简历体检 | "ATS" is banned in UI (C8) |
| Resume-vs-JD ATS report | **Keyword check** ("They ask for these and your resume doesn't mention them:", C17) | 关键词对照 | |
| Cover letter | **Cover letter** | 求职信 | cn: rarely needed; kept for 外企 |
| Insider Connections | **People at {company}** | 内推 (cn has its own hub) | Never "insider" (proposed ban, §5.25) |
| Agent | **Ready to apply** (list) + **Application kit** (per job) | 待投递 + 投递材料包 | Supervised by design |
| Autofill extension | **RoboApply for Chrome** (action: "Fill this form") | 一键网申插件 | User submits |
| Application tracker | **Applications** (views `By stage` / `By date` / `List`) | 投递记录 | |
| Interview (question bank) | **Practice questions** | 面试题库 | AI-written questions are labelled |
| AI mock interview | **Practice interview** (destination: Interview prep, C14) | AI面试练习 | |
| Coaching | **Coaching** | 求职辅导 | Hidden until a real roster exists |
| Job alerts | **Job alerts** (instant, daily, weekly) | 职位提醒 / 网申截止提醒 | |
| Refer & Earn | **Invite friends** | 邀请好友 | |
| Saved filters | **Saved searches** | 订阅搜索 | |
| — (new, cn) | — | **校招日历** (campus calendar) | cn first value |
| — (new, cn) | — | **Offer 对比** | V2 |

---

## 3. Information architecture

### 3.1 Brand resolution (product rules)

- Brand is resolved per request from the Host header (`x-forwarded-host` first). Dev/preview may force it with `?brand=cn` (sets a dev cookie) or `goapply.localhost:3611`. Production never accepts an override.
- The brand **locks**: allowed locales, default locale, currency, payment rails, auth methods, job sources and default country, LLM model profile, interview LiveKit project and agent name, email From and templates, legal footer, SEO host. Country headers only drive the cross-brand notice (§2.1).
- Users carry `brand`. A user who signs in on the other brand's host gets "This account belongs to {otherBrand}. Continue there." with a link. One database, one account per brand.

### 3.2 Marketing site maps

All marketing pages are public, server-rendered, localized under `/{locale}/…` for non-default locales (intl) and hreflang-linked. Every CTA goes to `/signup?from=<page-slug>` and preserves `job`, `ref` and `utm_*`.

**RoboApply (roboapply.io)**

| Route | Page | Phase |
|---|---|---|
| `/`, `/{locale}` | Home: gap-first hero (ruling R2), a labelled interactive sample, the four verbs (find, understand, fix, practice), real counters (§9.3), pricing summary, FAQ | MVP (rewrite of current landing) |
| `/features/job-matches` | Fit-ranked jobs with explanations | MVP |
| `/features/resume-tailoring` | Tailored resume per job, verified claims | MVP |
| `/features/cover-letters` | Cover letters from the posting and your resume | MVP |
| `/features/ready-to-apply` | Weekly prepared applications; you submit | MVP |
| `/features/interview-practice` | Voice/video practice interviews | MVP |
| `/features/assistant` | The Assistant | MVP |
| `/features/visa-sponsorship` | Sponsorship question and posting signals, per country | MVP |
| `/features/referrals` | People at a company, outreach drafts | V2 |
| `/features/chrome-extension` | Form filling; you submit | V2 (with the extension) |
| `/pricing` | Public pricing, credits table, fair-use caps, refund policy summary | MVP |
| `/tools` + `/tools/resume-check`, `/tools/resume-job-match`, `/tools/job-alerts` | Free tools (no `/tools/cover-letter` lander: cover letters need an account and a job); resume check and resume–job match **work without an account** (rate-limited) | V2 (resume check MVP) |
| `/job/[id]-[slug]` | Public, indexable job detail with JobPosting JSON-LD | V2 |
| `/browse/[role]`, `/browse/[role]/[city]`, `/browse/remote/[role]`, `/browse/visa-sponsorship/[country]/[role]` | Programmatic job lists from live inventory; page exists only when ≥10 live jobs | V2 |
| `/about`, `/security`, `/help`, `/help/ranking` | Company, security practices, help FAQ + support email, "How ranking works" (every Recommended factor; linked from the sort menu) | MVP |
| `/cancel` | Cancel a subscription without signing in (email → one-time link → confirm; German footer label "Verträge hier kündigen") | MVP |
| `/legal/terms`, `/legal/privacy`, `/legal/cookies`, `/legal/refunds`, `/legal/subscription-terms`, `/legal/referral-terms` | Legal | MVP (referral terms V2) |
| `/compare/[competitor]` | Only with dated, sourced facts; no ratings we can't cite | Later |
| `/blog` | Content | Later |

**GoApply (goapply.top)**

| Route | Page | Phase |
|---|---|---|
| `/`, `/en` | Home: 少填表、不错过截止、面试不慌 positioning; 校招日历 preview; AI面试 practice; free-core statement | MVP |
| `/features/campus-calendar`, `/features/resume`, `/features/interview-practice`, `/features/assistant`, `/features/form-filler` | Feature pages (extension page V2). **D5:** GoApply also gets the pages RoboApply has for the same functions (`/features/job-matches`, `/features/resume-tailoring`, `/features/cover-letters`, `/features/ready-to-apply`) and one for 内推, and its home page offers the same visitor functions over GoApply data (quick search, counters, pricing summary, feature cards, ticker) | MVP / V2 |
| `/campus`, `/campus/[company]` | Public 校招日历 (Baidu-indexable): programmes, 届别 windows, dates, official links, source and last-verified date | MVP |
| `/pricing` | Free core + 会员 fee schedule (published as the network-recruitment rules require). **D5 / D6:** the plans are purchasable by default through Alipay at the catalog's CNY amounts; "暂未开放" is shown only when the operator has switched charging off (`CN_PAYMENTS_ENABLED=false`) or the Alipay credential is not yet set | MVP |
| `/legal/agreement`, `/legal/privacy`, `/legal/ai-disclosure`, `/legal/personal-info-list` | 用户协议, 隐私政策, AI 生成内容说明 and model disclosure, 个人信息收集清单 | MVP |
| `/help` | Help + support | MVP |
| Footer (all pages) | ICP 备案号, 公安备案号, 人力资源服务许可证号 (when held), AI model names and filing numbers | MVP (values from brand config) |

No compare pages, no GitHub lists, no Google-only assumptions on GoApply.

### 3.3 Logged-in navigation

**RoboApply desktop sidebar** (top group, in order):

| # | Label | Route | Badge / note |
|---|---|---|---|
| 1 | Jobs | `/jobs` | Count of new jobs that fit since last visit (real, from the feed query) |
| 2 | Ready to apply | `/ready` | Count of kits ready and not yet opened |
| 3 | Applications | `/applications` | Count of applications with no reply after 10 days (existing `countAwaitingReply`) |
| 4 | Resume | `/resume` | — |
| 5 | Interview prep | `/practice` | — |
| 6 | Profile | `/profile` | "Incomplete" dot until required autofill fields are filled |

Lower group: `Coaching` (only when the brand's coach roster has ≥1 active coach), `Invite friends` (V2), `Get the extension` (V2), `Settings`, plan badge (`Free · Upgrade` or `Pro`) with today's credits summary. Admin entry for admins.
Topbar: crumb, Cmd-K search, **Ask** (Assistant), **Inbox** bell (only real items: alerts, reminders, announcements, billing notices; V2 adds employer messages), theme, language, avatar menu.
Floating: Assistant button bottom-right (remembers dismissal; never auto-opens on route change, fixing F-ORION-01's known issue).

**RoboApply mobile bottom nav** (≤760 px): `Jobs · Applications · Resume · Interview prep · More`. `More` opens a sheet: Ready to apply, Profile, Coaching (if any), Invite friends, Settings, Plan. The Assistant is the floating button and a full-screen sheet (`/assistant`). Every feature works on mobile (no "use a computer" gates, unlike F-MOB-04); dense editors (resume editor) get a stacked mobile layout.

**GoApply desktop sidebar:** 职位 (`/jobs`), 校招日历 (`/campus`), 待投递 (`/ready`), 投递记录 (`/applications`), 简历 (`/resume`), 面试练习 (`/practice`), 我的资料 (`/profile`). Lower: 内推 (`/referrals`, V2), 邀请好友 (V2), 设置, 会员 badge.
**GoApply mobile bottom nav:** `职位 · 校招 · 投递 · 面试 · 我的` (简历, 资料, 待投递, 设置 live under 我的).
When the cn job feed is switched off (licensing, §5.3 note), 职位 is hidden and 校招日历 becomes the home destination.

### 3.4 Route table (Jobright → ours)

Authenticated routes are added to `PROTECTED_PREFIXES` and the robots disallow list. Existing redirects in `next.config.mjs` are updated (remove `/onboarding → /jobs`).

| Jobright route | Purpose | RoboApply route | GoApply route | Phase |
|---|---|---|---|---|
| `/onboarding-v3/signup` | Sign up | `/signup` | `/signup` (phone/WeChat) | MVP |
| (sign-in modal) | Sign in | `/login` | `/login` | MVP |
| `/onboarding-v3/mode-selection` | S1 | `/onboarding/situation` | `/onboarding/identity` | MVP |
| `/onboarding-v3/diagnostics` | S2 | `/onboarding/basics` | `/onboarding/intent` | MVP |
| `/onboarding-v3/career-goals` | S3 | `/onboarding/goal` | — (folded into intent) | MVP |
| `/onboarding-v3/advanced-preferences` | S4 | `/onboarding/preferences` | `/onboarding/tags` | MVP |
| `/onboarding-v3/resume-upload` | S5 | `/onboarding/resume` | `/onboarding/resume` | MVP |
| `/matching` | S6 | `/onboarding/matching` | `/onboarding/matching` | MVP |
| — | Consent (cn) | — | `/onboarding/consent` | MVP |
| — | Education (cn) | — | `/onboarding/education` | MVP |
| `/jobs/recommend` (+`?id=`) | Feed + in-place detail | `/jobs` (+`?job=<id>` split detail on desktop) | `/jobs` | MVP |
| `/jobs/info/[id]` | Job detail | `/jobs/[id]` (app) and `/job/[id]-[slug]` (public, V2) | `/jobs/[id]` | MVP |
| `/jobs/liked` | Liked tab | `/applications?status=saved` | same | MVP |
| `/jobs/applied` | Applied tab | `/applications?view=list` | same | MVP |
| `/jobs/external` | External jobs | `/jobs/added` | `/jobs/added` | MVP |
| `/jobs/explore` | Category browse | `/jobs/explore` (absorbs `/job-search`; `/job-search` redirects here, `/job-search/developers` stays) | `/jobs/explore` | MVP |
| `/jobs/profile` | Profile | `/profile` | `/profile` | MVP |
| `/jobs/resume`, `/jobs/resume/edit/[id]` | Resume hub/editor | `/resume`, `/resume/[id]` | same | MVP (exists) |
| — | Resume check report | `/resume/[id]/check` | same | MVP |
| — | Cover letter editor | `/resume/letters/[id]` | same | MVP |
| `/agent` | Agent | `/ready`, `/ready/setup`, `/ready/[jobId]` | same | MVP |
| `/interview`, `/interview/[companyId]` | Question bank | `/practice/questions`, `/practice/questions/[company]` | same | V2 |
| `/voice-chat` | Employer intake call | — (SKIP; see F-INT-05) | — | — |
| — | Practice interview | `/practice`, `/practice/[id]`, `/practice/[id]/report` | same | exists (Wave 0 fixes) |
| `/coaching`, `/coaching/discover`, `/coaching/bookings` | Coaching | `/coaching`, `/coaching/bookings` | `/coaching` | V2 |
| (message drawer) | Messages | `/inbox` | `/inbox` | MVP (system items) |
| — | Assistant full page | `/assistant` | `/assistant` | MVP |
| — | Campus calendar | — | `/campus`, `/campus/[company]` | MVP |
| — | 内推 hub | — | `/referrals` | V2 |
| `/settings` | Settings | `/settings` (sections `#account`, `#security`, `#notifications`, `#billing`, `#credits`, `#privacy`, `#appearance`, `#danger`) | same + `#consents` | MVP (exists, extended) |
| `/return` | Payment return | `/settings/billing/return` | same | MVP |
| `/reset-password` | Reset | `/forgot-password`, `/reset-password/[token]` | same (email fallback only) | MVP |
| `/verify-email/[code]`, `/email-verification` | Verify | `/verify-email/[token]` | — | MVP |
| `/auth/callback/*` | OAuth | `/auth/callback/google`, `/auth/callback/line` (V2) | `/auth/callback/wechat` | MVP / V2 |
| `/verify-referral/[code]`, `/s/{code}` | Referral | `/r/[code]` | `/r/[code]` | V2 |
| `/tools/job-alert`, `/tools/job-alert/unsubscribe` | Alerts | `/tools/job-alerts`, `/unsubscribe/[token]` | `/unsubscribe/[token]` | MVP (unsubscribe), V2 (logged-out alerts) |
| `/autofill/uninstall` | Exit survey | `/extension/uninstalled` | same | V2 |
| — | Extension install/status | `/extension` | `/extension` | V2 |
| `/candidate-preferences` | Passive candidate magic link | — (Later, RoboHire loop) | — | Later |
| — | Invite | `/invite` | `/invite` | V2 |
| — | Admin | `/admin` + `/admin/coaches`, `/admin/announcements`, `/admin/credits` | + `/admin/campus` (calendar curation) | MVP/V2 |

### 3.5 New admin tools (both brands, admin-gated)

- `/admin/campus` (cn MVP): create, edit, verify and expire 校招日历 entries. Each entry needs an official source URL and a "last verified" date; an entry older than 14 days without re-verification shows "待核实" to users.
- `/admin/announcements` (V2): server-driven "What's new" records per brand, locale and cohort.
- `/admin/coaches` (V2): coach roster (name, photo, bio, languages, specialties, session lengths and prices, booking link or request email, active flag). Coaches are real people who agreed to be listed.
- `/admin/credits` (MVP): per-brand, per-plan credit caps (§6.2), editable without a deploy.

---
## 4. Onboarding flows

### 4.1 Shared mechanics (both brands)

- **Server-driven stage machine** (F-ONB-01). The server stores `onboardingStage` (string) and `onboardingAnswers` (JSON) on the seeker record. After any sign-in, `GET /onboarding/state` returns `{stage, nextRoute, answers, branch}` and the client routes there. Every step `POST` is idempotent (re-submitting a step overwrites its answers and never duplicates rows). Steps are resumable from any device and any entry point.
- **Entry attribution carried through every step** (F-ONB-02): `from`, `job` (job id to land on at the end), `action=apply`, `ref` (referral code), `utm_source/medium/campaign`, `alert` (email deep-link token). Stored once on the user at signup (`signupAttribution`).
- **Landing at the end.** If `job` was carried, the last step lands on `/jobs/[job]`. Otherwise `/jobs` (intl) or `/campus` / `/jobs` (cn, see G7).
- **Leaving early.** A user who closes onboarding after the account step lands on `/jobs` with a persistent banner "Finish setting up — {n} steps left" and a resume link. After two dismissals the banner becomes a line in Settings. No forced re-routing on every page view.
- **Skipping.** Every step after the account step has `Skip`, except the intl situation step and the cn identity step (one tap each). A skipped step leaves its answers empty; the feed uses whatever exists (preferences only, resume only, or both). The matching step always runs.
- **Back** always works and keeps answers.
- **Copy rules.** Plain headings, no speaking avatar, no idioms, no first person (§2.2). English copy intent below is a paraphrase brief for writers; final strings go in `i18n/staging/onboarding.en.json`.
- **Analytics** (first-party only, no ad pixels; for EEA/UK/CH visitors on RoboApply only after the analytics consent banner — Reject as prominent as Accept; before consent no anonymous-ID cookie and no linking to the account; events kept ≤13 months and deleted with the account): `onboarding_step_viewed`, `onboarding_step_completed {stage, durationMs, skipped}`, `onboarding_abandoned {stage}`.

### 4.2 RoboApply stage codes

| Order | Stage code | Route | Shown when |
|---|---|---|---|
| 10 | `account` | `/signup` | Always |
| 20 | `situation` | `/onboarding/situation` | Always |
| 30 | `basics` | `/onboarding/basics` | Always |
| 40 | `goal` | `/onboarding/goal` | Branch `explore` only (timing ≠ "As soon as possible") |
| 50 | `preferences` | `/onboarding/preferences` | Branch `explore` only |
| 60 | `resume` | `/onboarding/resume` | Always |
| 70 | `matching` | `/onboarding/matching` | Always |
| 80 | `confirm` | `/onboarding/confirm` | Always |
| 90 | `tour` | `/jobs` (first visit overlay) | Always, once |
| 100 | `done` | — | — |

Branch `urgent` = timing "As soon as possible" (Jobright's rush). Branch `explore` = the other two timings (Jobright's no-rush).

### 4.3 RoboApply screens

#### O0 — Create account (`/signup`, stage `account`)

Layout: Clarity split screen (brand panel + form). The brand panel's headline and three proof points change with `from` (e.g. `from=resume-check` emphasizes tailoring; `from=job` shows the job title and company the user came from). Proof points are capabilities, never unverified multipliers or user counts.

| # | Element | Rules |
|---|---|---|
| 1 | Title | Contextual: default "Create your free account"; with `action=apply`: "Create a free account to see how you fit {job title}" |
| 2 | `Continue with Google` | Google OIDC. New Google users skip password and email verification (Google verified the email). |
| 3 | `Continue with LINE` | Shown only when locale is `zh-TW` or country is TW. Phase V2 (needs a LINE Login channel); hidden until configured. |
| 4 | Divider "or" | — |
| 5 | Email | Valid email; normalized lowercase; error "Enter a valid email address." |
| 6 | Password (show/hide) | ≥8 characters with at least one letter and one digit; inline rule checklist |
| 7 | Checkbox "Send me product news and tips" | **Unchecked by default** everywhere (we do not vary by region; simpler and compliant everywhere). Job alerts are configured separately and are not marketing. |
| 8 | Primary button `Create account` | Disabled while submitting |
| 9 | Legal line + age | "By creating an account you agree to the Terms and Privacy Policy." with links, plus a required checkbox "I'm 16 or older" (`age_16_plus`; the terms state 16 or the local age of digital consent where higher). zh-TW/TW signups also see the PDPA notice line and its consent row (`tw_pdpa_notice`). |
| 10 | Sign-in link | "Already have an account? Sign in" (keeps all query params) |

Errors and edges:
- Email already registered: "An account with this email already exists. Sign in instead." with a sign-in link (no account enumeration beyond this standard pattern; rate limit 5/min/IP, persisted, not in-memory).
- Account belongs to GoApply: signup answers with the normal "check your email" response and emails that inbox the cross-brand notice; sign-in shows the cross-brand message (§3.1) **only after the password checks out**, so nobody can learn which emails hold a GoApply account.
- In-app browser guard (F-ONB-11): inside LinkedIn/Instagram/TikTok/Facebook/WeChat webviews, Google and LINE buttons are replaced by "Open in your browser to continue with Google" plus a copy-link button; email signup still works.
- Email verification: a verification email is sent for email/password accounts. It **does not block onboarding**. It is required before (a) the first free practice interview credit is granted and (b) referral rewards (V2).
- No partial-signup capture on blur (F-ONB-12 SKIP).

On success → stage `situation`.

#### O1 — Your situation (`/onboarding/situation`, stage `situation`)

Heading intent: "Two quick questions so we search the right way."

| Field | Control | Options | Required | Default |
|---|---|---|---|---|
| `timing` | 3 large cards, single select | `As soon as possible` (branch urgent) · `In the next few months` · `Just looking at what's out there` | Yes | none |
| `seekerType` | 4 chips, single select | `Student` · `Recent graduate (graduated in the last 2 years)` · `Experienced professional` · `Changing careers or returning to work` | Yes | none |

Rules: no Skip; `Next` enabled when both are answered. `seekerType` = Student or Recent graduate pre-selects Internship (student) or Full-time + Entry level (graduate) on later screens. Saves `{timing, seekerType}`. → `basics`.

#### O2 — What you're looking for (`/onboarding/basics`, stage `basics`)

Heading intent (urgent): "What job do you want next?" (explore): "What kind of role would you consider?"

| Field | Control | Options / validation | Required | Default |
|---|---|---|---|---|
| `jobFunctions` | Typeahead over the job-function taxonomy (3 levels); Enter adds a custom title | 1–3 specific titles. A broad title (taxonomy level 1, e.g. "Engineering") shows "This is broad. Pick a more specific title for better results." and offers its children as chips. >3: "Pick up to 3 titles." | Yes (≥1) | Suggested from resume if one exists from an earlier session |
| `jobTypes` | Checkbox chips | Full-time · Part-time · Contract · Internship | Yes (≥1) | Full-time (Internship if Student) |
| `countries` | Multi-select country picker | MVP set: US, CA, GB, IE, AU, NZ, SG, HK, TW, JP, KR, DE, FR, ES, PT, NL, plus "Remote anywhere" | Yes (≥1) | From locale/country header (TW → Taiwan; zh-TW → Taiwan) |
| `locations` | City picker per selected country, with "Anywhere in {country}" | ≤5 cities total | No | "Anywhere in {country}" |
| `remoteOk` | Checkbox "Include remote jobs" | — | No | Checked |
| `needsSponsorship` | Per selected country: "Will you need a company to sponsor a visa or work permit to work in {country}?" `Yes` · `No` · `Not sure` | One answer per country | No | unanswered (= not used) |

Live **"Open roles right now"** panel (honest market snapshot, F-SAL-02 adapted). Appears after a title and a country are chosen. Computed from our own `RAJob` inventory for the last 30 days:
- "{N} open roles for {title} in {place} in the last 30 days" (always shown when N ≥ 1; if N = 0: "No open roles yet for this title here. Try a broader title or another city." with suggestion chips).
- "Pay listed on {X} of {N} posts. Middle of the listed ranges: {currency} {low}–{high} per {period}." Shown only when X ≥ 20 (the shared `MIN_SAMPLE`); period is the most common posted period; never mixes currencies. All counts here use public, canonical, live rows of the brand's market only (users' imported jobs never count).
- "Most requested skills: …" (top 6 from per-job skill extraction). Shown only when N ≥ 20.
- Footnote: "From job posts in RoboApply's index. Updated daily."
Footer: `Back` · `Skip` · `Next`. Skip keeps whatever was entered. → `goal` (explore) or `resume` (urgent).

#### O3 — Your goal (`/onboarding/goal`, stage `goal`, branch explore only)

Heading intent: "What should your next job do for you?" Single select, cards in three groups:

| Group | Options |
|---|---|
| Move up | A more senior role · A management role · Higher pay |
| Change direction | A new industry · A different kind of role · Learn new skills |
| Better day-to-day | Work–life balance · Job security · Flexible hours or location |

Validation: `Next` with nothing selected shows "Pick one, or skip this step." Footer `Back · Skip · Next`. The answer goes into the Assistant's context and nudges ranking (e.g. "A management role" boosts manager-titled jobs one tier step; "Higher pay" boosts jobs with listed pay above the user's minimum). → `preferences`.

#### O4 — Nice to have (`/onboarding/preferences`, stage `preferences`, branch explore only)

Heading intent: "Anything else that makes a job right for you? All optional."

| Field | Control | Options / rules | Default |
|---|---|---|---|
| `industries` | Searchable multi-select (closed 19-item industry taxonomy already in `raOnboardingDraft.ts`) | ≤5 | none |
| `skills` | Searchable multi + custom entry | ≤15; prefilled later from the resume | none |
| `companySizes` | Chips | 1–50 · 51–200 · 201–1,000 · 1,001–10,000 · 10,000+ · `Any size`. Tooltip: "Many posts don't say company size. Jobs without size information are still shown." | Any size |
| `minPay` | Amount + currency (follows the first selected country) + period (year/month/hour) | Optional. Tooltip: "Jobs that don't list pay are still shown, marked 'Pay not listed'." | empty |
| `workModels` | Chips | Remote · Hybrid · On-site | all |

Footer `Back · Skip · Next`. No company "stage/funding" field (we have no funding data; F-ONB-06 ADAPT). → `resume`.

#### O5 — Your resume (`/onboarding/resume`, stage `resume`)

Heading intent: "Add your resume so we can compare it with each job." Reuses `components/v3/setup/ResumeStep.tsx` (4 doors).

| Door | Rules |
|---|---|
| Upload | `.pdf .doc .docx .txt`, ≤15 MB (existing limit). Local parser by default; GoHire parse only if the owner opts RoboApply in (OD-3), and then only after the `intl_cross_border_cn_parse` consent, with local parse / manual entry offered when it is declined. |
| Paste text | ≥200 characters |
| LinkedIn | The user's own LinkedIn "Save to PDF" (or data-export) file, uploaded like any resume, with a short how-to. **No LinkedIn URL import** (the only providers scrape LinkedIn). |
| Reuse | Pick an existing resume (returning users) |

Privacy line: "Your resume is used to rank jobs and draft materials for you. It is not shared with employers unless you send it." + Privacy link.
CTA `Find my jobs`; secondary `Skip — use my answers only`. Errors: unreadable file ("We couldn't read this file. Try a PDF, or paste the text."), too large, wrong type, daily upload limit (10/day, persisted). → `matching`.

#### O6 — Finding jobs (`/onboarding/matching`, stage `matching`)

A progress list where **each line is checked only when the server reports that step done** (no timed fake steps):
1. Reading your resume (skipped line if no resume)
2. Saving what you're looking for
3. Searching job sources for {title} in {place}
4. Comparing jobs with your resume
5. Ranking your list

Server work: save preferences → run a targeted ingest for the user's titles × countries (providers + banks, persisted into `RAJob`) → deterministic pre-score of candidates → LLM fit analysis for the top 20. Target time-to-feed: p50 ≤ 45 s, hard cap 120 s; after 120 s, continue to O7 with whatever is ranked; the remaining work is queued and finished by the background queue runner.
Side panel: three capability cards (tailored resume, practice interview, ready to apply). Error state: "Something went wrong while searching." `Try again` · `Continue anyway` (to the feed) · support email. → `confirm`.

#### O7 — Check your setup (`/onboarding/confirm`, stage `confirm`)

Heading intent: "We found {N} jobs that fit you. Check these details." N is the real count of ranked jobs at Good fit or better (if N = 0: "We didn't find strong fits yet. Adjust your search below." and the panel opens with the zero-results diagnostics of F-FEED-10).

| Field | Control | Rules | Default |
|---|---|---|---|
| `experienceLevels` | Chips, multi | Internship · Entry level (0–2 yrs) · Mid level (2–5 yrs) · Senior (5+ yrs) · Lead / Staff · Director and above. Error if none: "Pick at least one level." | Suggested from resume (`suggestedSeniority`) |
| `extraFunctions` | Suggested title chips derived from the resume, toggle on/off | ≤3 added | none selected |
| `linkedinUrl` | Text, optional | `https://www.linkedin.com/in/…` pattern | empty |
| `alertFrequency` | Single select "Email me new jobs that fit" | Daily · Weekly · Off (Daily is a service message with no upsell blocks; promotional tips are a separate "Tips and reminders" preference) | Daily |
| `heardFrom` | Single select, **optional** | Search engine · LinkedIn · Instagram · TikTok · YouTube · Reddit · A friend or colleague · An AI assistant (e.g. ChatGPT) · School or career center · Other (text) | none |

CTA `Show my jobs`. → stage `tour`, route `/jobs` (or `/jobs/[job]` when carried).

#### O8 — First visit (`/jobs`, stage `tour`)

A dismissible 4-card overlay, shown once: "Why you fit and what's missing" · "A tailored resume for each job" · "Ready-to-apply kits — you submit" · "Practice the interview". CTA `Start`. Then inline, one at a time (shared 24-hour popup budget; never two prompts at once):
1. **Score tip** on the first card: explains the tier and the line "This is not your chance of getting hired." (permanent under the meter anyway).
2. **Resume check banner** (only if a resume was uploaded): "Your resume check is ready: {k} things to fix." → `/resume/[id]/check`. The check runs free once during onboarding.
3. **Feed rating card** after 10 cards scrolled: "How good is today's list?" 0–10. Below 8 opens reasons (wrong titles · wrong level · wrong location · missing skills I have · jobs look old · companies I don't want) + free text; reasons that map to filters offer a one-tap filter change.
4. **Skills check**: "Do you have these skills?" chips from frequent requirements not on the resume, each with "asked in X of Y" → yes adds to profile skills (not to the resume), no adds the skill to the saved search's excluded skills (shown as a filter change first).
5. **Getting started checklist** (missions, F-GROW-05 adapted): Tailor a resume for a job · Do a practice interview · Save a job for later. Completing all three grants **1 practice credit** (deterministic reward, not a raffle).
6. No first-day countdown and no launch offer (§6.4).

Stage → `done` when the overlay is dismissed.

#### O9 — Later, optional

- **Profile completion** (`/profile`, F-ACCT-03): sections Personal, Education, Work, Skills, Links, Work authorization, Application answers, Equal-opportunity answers (US-targeting users only, optional). Missing required autofill fields show "Missing". Prompted from Ready to apply and the extension, not on first day.
- **Ready to apply setup** (`/ready/setup`, F-AGENT-02 adapted, §5.8).
- **Extension install** (`/extension`, V2).

### 4.4 GoApply stage codes

| Order | Stage code | Route | Shown when |
|---|---|---|---|
| 10 | `account` | `/signup` | Always |
| 15 | `consent` | `/onboarding/consent` | Always |
| 20 | `identity` | `/onboarding/identity` | Always |
| 25 | `education` | `/onboarding/education` | Always (prefilled from resume when available; 社招 may skip) |
| 30 | `intent` | `/onboarding/intent` | Always |
| 35 | `tags` | `/onboarding/tags` | Always (skippable) |
| 60 | `resume` | `/onboarding/resume` | Always |
| 70 | `matching` | `/onboarding/matching` | Always |
| 80 | `confirm` | `/onboarding/confirm` | Always |
| 90 | `tour` | first-value screen | Always, once |
| 100 | `done` | — | — |

### 4.5 GoApply screens

#### G0 — 登录 / 注册 (`/signup`, stage `account`)

| # | Element | Rules |
|---|---|---|
| 1 | Agreement checkbox | "我已阅读并同意《用户协议》《隐私政策》" — **required, unchecked by default**; buttons stay disabled until checked |
| 2 | Phone number | +86 only (MVP). Validation `^1[3-9]\d{9}$`. Error "请输入正确的手机号" |
| 3 | `获取验证码` | 6-digit SMS OTP, no links in the SMS (CN-L-07). Resend after 60 s. Limits: 5 sends/phone/day, 10 sends/IP/hour, code valid 5 min, 5 wrong tries → 30-min lock. Rate limits persisted in the DB. |
| 4 | OTP input + `登录 / 注册` | New phone = new account; existing phone = sign-in (one flow) |
| 5 | `微信登录` | Desktop: WeChat web QR (snsapi_login). Inside WeChat browser: 公众号 OAuth. After WeChat auth, **bind a phone number** (real-name requirement) before continuing. Phase: V2 (needs WeChat Open Platform verification, CN-L-08); hidden until configured. |
| 6 | `其他方式` | Email + password fallback (same rules as intl); hidden behind a link |

SMS delivery failure: "验证码发送失败，请稍后重试" + support link. On success → `consent`.

#### G1 — 授权说明 (`/onboarding/consent`, stage `consent`)

Separate, unbundled consents (PIPL):

| Consent | Control | Required | Default | Effect if declined |
|---|---|---|---|---|
| 用户协议 + 隐私政策, and 我已年满16周岁 (`age_16_plus`) | Checkbox | **Yes** | Unchecked | Cannot continue |
| 跨境传输 (`pipl_cross_border`) — CN-0 only, while data is processed outside the mainland | Checkbox whose prose names every offshore processor **this deployment is configured to use** and its country or region. The list is never typed into the text: it is filled per request from the same configuration the `/legal` disclosures render (`configuredProcessors()`), so the consent and `/legal` cannot disagree. A processor whose country is not known is named in its own sentence ("以下处理方的所在国家/地区未披露：…") and is not called offshore. (Wave FIX, FIX-8; the earlier draft listed Neon us-east, Vercel, LiveKit Cloud, Deepgram/Cartesia and Resend by hand.) | **Yes** in CN-0 | Unchecked | Cannot continue; withdrawing it later closes and purges the account |
| AI 处理简历与求职资料 ("Use AI to read my resume and prepare materials") | Toggle with a plain explanation of what is processed, where (the configured models from `llmEndpointFacts()` and, in CN-0, the offshore processors; no model row when routing is mainland-only), and retention | No | Off until tapped | User can continue in manual mode: no resume parsing, no tailoring; profile filled by hand (the manual profile form). A banner explains what is unavailable. |
| 个性化推荐 ("Rank jobs using my profile") | Two-option choice 开启 / 关闭, with "you can change this anytime in 设置" | No (but a choice is required to continue) | **Unset — no preselection** | Off, or not yet chosen = jobs sorted by recency and filters only, no fit scores (PIPL Art. 24 non-personalized option) |
| 营销消息 ("Product news by message/email") | Toggle | No | Off | — |

No toggle is pre-checked. A required consent already granted at sign-up **for the text served today** is shown as given and not asked twice; a grant of an earlier text is an unticked box again, with the date of the earlier grant (the stored hash is compared with today's text under the record's own version, so a version bump with unchanged words still counts as current). Not asked here: employer sharing, interview recording and long-term Assistant memory (`copilot_memory`) — asked in context, at the moment they apply. `下一步` → `identity`.

#### G2 — 你的身份 (`/onboarding/identity`, stage `identity`)

| Field | Control | Options / rules | Required | Default |
|---|---|---|---|---|
| `cnIdentity` | 3 cards | 应届生（找正式工作）· 在校生（找实习）· 社招（有全职工作经验） | Yes, no skip | none |
| `graduationClass` (届别) | Select (应届/在校 only) | 2025届 … 2030届 | Yes for 应届/在校 | 应届: the current campus class (Oct 2026 → **2027届**); 在校: 2028届 |
| `graduationMonth` | Select (应届/在校) | 1–12 | No | 6 |
| `yearsExperience` | Chips (社招 only) | 1年以内 · 1–3年 · 3–5年 · 5–10年 · 10年以上 | Yes for 社招 | none |
| `jobSearchStatus` (求职状态) | Chips (社招 only) | 离职-随时到岗 · 在职-月内到岗 · 在职-考虑机会 · 在职-暂不考虑 | Yes for 社招 | none |

→ `education`.

#### G3 — 教育背景 (`/onboarding/education`, stage `education`)

| Field | Control | Options / rules | Required | Default |
|---|---|---|---|---|
| `degree` (学历) | Chips | 大专 · 本科 · 硕士 · 博士 · 其他 | 应届/在校: yes; 社招: no | none |
| `fullTime` (统招) | Toggle | — | No | On. *As built (Wave FIX, FIX-8): an optional 是 / 否 with nothing preselected. Whether to restore the "On" default is an open owner decision (`requests/waveFIX-carryover.md`, Owner item 1); this row is updated when the owner rules.* |
| `school` | Typeahead over the Ministry of Education's public list of higher-education institutions (985/211/双一流 marks from the official MOE lists, shown as information; the data file states its source and as-of date); free text allowed | School tier is **display and a user-side filter only, never a ranking input** | 应届/在校: yes | none |
| `major` (专业) | Typeahead + free text | — | No | none |
| Overseas school | Toggle "海外院校" switches the school field to free text | — | No | Off |

`跳过` allowed for 社招. → `intent`.

#### G4 — 求职期望 (`/onboarding/intent`, stage `intent`)

| Field | Control | Options / rules | Required | Default |
|---|---|---|---|---|
| `targetRoles` (期望职位) | Typeahead over a zh job taxonomy | 1–3; broad-title warning as intl | Yes | from resume if present |
| `cities` (期望城市) | Province → city picker grouped by province (no 一线/新一线 tiers: they come from a commercial ranking we cannot cite), plus `不限` | ≤5 | Yes | none |
| `industries` (期望行业) | Multi-select | ≤3 | No | none |
| `workType` (工作性质) | Chips | 全职 · 实习 · 兼职 | Yes | 在校 → 实习; else 全职 |
| `salaryMonthlyK` (期望薪资, 全职) | Two selects min–max in K/月 (1–30K step 1K, then 35–100K step 5K) + `面议` | min ≤ max | No | empty |
| `salaryMonths` (·N薪) | Select 12–20 | Optional suffix; displayed as "15-25K·13薪" | No | empty |
| `internDailyPay` (实习, 元/天) | Two selects 100–1000 step 50 + `不限` | — | No | 不限 |
| `internDaysPerWeek` | Chips 2 · 3 · 4 · 5 天/周 | 实习 only | Yes for 实习 | 4 |
| `internMonths` | Chips 1–2个月 · 3个月 · 6个月及以上 | 实习 only | Yes for 实习 | 3个月 |
| `startDate` (到岗时间) | Chips 随时 · 一个月内 · 指定日期 | — | No | 随时 |
| `acceptReassignment` (接受调剂) | Toggle (应届/在校) | — | No | Off |

Live panel "现在开放的机会": from our cn inventory only (GoHire bank + curated calendar + imported jobs): "{N} 个在招职位" and "{M} 个校招项目正在网申" for the chosen roles and cities; pay median only when ≥20 postings list pay, shown with N, labelled "来自 %BRAND% 收录的职位，按发布薪资统计". → `tags`.

#### G5 — 更看重什么 (`/onboarding/tags`, stage `tags`, skippable)

| Field | Control | Options / rules | Default |
|---|---|---|---|
| `employerTypes` | Chips, multi | 央国企 · 外企 · 民企大厂 · 创业公司 · 事业单位 · `都可以` | 都可以 |
| `wantsHukou` | Toggle "希望能解决户口" | Tooltip: "只在官方信息注明可落户时显示该标签" | Off |
| `civilServiceTrack` | Toggle "也在准备考公/考编" | Phase Later (needs a 考公/考编 data source); hidden | — |

Tags filter and label jobs **only** when an official source in the posting or programme supports them (CN-E-08 discipline, D3). → `resume`.

#### G6 — 上传简历 (`/onboarding/resume`, stage `resume`)

Same four doors as intl, minus LinkedIn. Accepts PDF/Word; images (JPG/PNG) are sent to the GoHire parse API only; if that fails, ask for a PDF (no local vision OCR for Chinese scans — known to fabricate). Requires the AI consent from G1; without it the screen offers "手动填写资料" instead. In CN-0 the original file is not kept and no photo is stored; the parsed text is redacted (ID numbers, health keywords) before storage. Optional-field reminder: "照片、籍贯、政治面貌都不是必填项，我们不会用它们来推荐职位。" `跳过` allowed. → `matching`.

#### G7 — 匹配中 and 确认 (`/onboarding/matching`, `/onboarding/confirm`)

Matching: same honest progress list as O6, cn sources only (GoHire bank, calendar, imported jobs).
Confirm: "找到 {N} 个合适的职位，{M} 个校招项目正在网申" (real counts); 届别 eligibility check ("以下项目要求 2027届，与你一致"); suggested extra roles; optional "你从哪里知道我们" (小红书 · 抖音 · 微信 · 知乎 · B站 · 朋友推荐 · 学校就业指导 · 其他). CTA `开始`.

**First value (stage `tour`):**
- 应届/在校 users land on **`/campus`** filtered to their 届别, roles and cities: the programmes open now, sorted by 网申 close date, each with official link, source and "最后核实" date, and a `截止提醒` button.
- 社招 users land on `/jobs`.
- One prompt: "开启网申截止提醒" — in-app inbox always; WeChat subscribe message when inside WeChat (V2); email if given. Then a 3-card tour: 校招日历 · 定制简历 · AI面试练习.

If the cn job feed is off (licensing, §5.3), the confirm screen shows only calendar and practice counts, and everyone lands on `/campus`.

---
## 5. Feature matrix

### 5.0 Legend

**Decisions:** **BUILD** (full clone, new code) · **ADAPT** (cloned with a stated change) · **UPGRADE** (extend an existing RoboApply module, named) · **DEFER** (not now; says why and what unblocks it) · **SKIP** (never; says why).
**Phases:** **MVP** (release 1) · **V2** (parity release) · **Later** (after parity, or gated on an external dependency) · **—** (not built).
**cn column:** "= intl" means the same decision and phase as RoboApply, on by default on the shared stack (D5). The job feed is **on** on GoApply; `CN_RECRUITMENT_INFO_MODE=off` is the operator's off switch (see the §5.3 note). A cell marked **D5** was changed on 2026-10-11 to remove a GoApply-only reduction. Every F-B2B ID is out of scope.

**Honesty rules applied in every row (D3):**
1. A number is shown only with its source (§9.3). Unknown is shown as "Not listed" / "未披露", never as zero or an estimate without a label.
2. Tags and badges come only from a real field of the posting, the provider record or the user. No tag from absence of data (ruling C18).
3. AI estimates are labelled as AI, show what they were computed from, and are never presented as facts about a company or person.
4. People shown to users are real records from a named source (the user's own import, a recruiter who opted in on RoboHire/GoHire, or a coach who agreed to be listed). No generated people, no purchased contact data in MVP.

### 5.1 Marketing (F-MKT)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-MKT-01 | Marketing shell + shared landing template | ADAPT: one landing template for all feature pages (hero, capability sample labelled "Example", how it works, FAQ with FAQPage JSON-LD, CTA). No testimonials until we have real, consented ones; no stat strip unless from §9.3. hreflang per locale. | = intl, zh-first; Baidu meta; ICP footer | MVP |
| F-MKT-02 | Homepage with quick search + live job ticker | ADAPT: rewrite `components/landing/LandingContent.tsx`; quick search (title, country, city, remote) routes to `/browse/…` (V2) or signup (MVP). Ticker of newest real jobs that we may display publicly (`publicDisplay`), worded "Found {n} min ago · posted {date}" (the posted date is omitted when it is estimated) — V2 with public job pages. | **D5:** = intl over GoApply data (quick search, counters, ticker of publicly displayable jobs), plus the "正在网申" calendar strip. No number is invented: a counter with no data shows its honest empty state | MVP / V2 |
| F-MKT-03 | Feature landing pages | ADAPT: the `/features/*` set in §3.2; no H1B-only page (generalized visa page), no TNT page | ADAPT: cn feature set in §3.2. **D5:** it includes the pages for job matches, resume tailoring, cover letters, Ready to apply and 内推 | MVP |
| F-MKT-04 | Company and trust pages | BUILD: about, security (what we actually do), help, legal set per brand | BUILD: + 个人信息收集清单, AI disclosure, licence numbers | MVP |

### 5.2 Onboarding (F-ONB)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-ONB-01 | Server stage machine | BUILD per §4.1–4.2; replaces `SetupPanel` overlay; reuses `/v2/onboarding/*` service for persistence | BUILD per §4.4 | MVP |
| F-ONB-02 | Entry attribution carry-through | BUILD (`from`, `job`, `action`, `ref`, `utm_*`, `alert`) | = intl | MVP |
| F-ONB-03 | Rush / no-rush mode | ADAPT: O1 timing + seeker type, no avatar | ADAPT: G2 identity (应届/在校/社招) | MVP |
| F-ONB-04 | Basic preferences + market snapshot | ADAPT: O2 with per-country sponsorship question and an inventory-based snapshot (§4.3) | ADAPT: G4 with K/月·N薪 | MVP |
| F-ONB-05 | Career goal | ADAPT: O3 paraphrased options | SKIP (cn users answer 求职状态 instead) | MVP |
| F-ONB-06 | Advanced preferences (industry, skill, company stage) | ADAPT: O4; company stage replaced by company size (no funding data) | ADAPT: G5 employer types and 户口 | MVP |
| F-ONB-07 | Resume / LinkedIn intake, daily cap | UPGRADE `ResumeStep.tsx` (4 doors), cap 10/day persisted | ADAPT: no LinkedIn; image via GoHire only; requires AI consent | MVP |
| F-ONB-08 | Matching loader | ADAPT: steps tick on real server events (O6), no timed animation | = intl | MVP |
| F-ONB-09 | "We found N roles" confirm | ADAPT: O7, real N, acquisition source optional | ADAPT: G7 + 届别 eligibility | MVP |
| F-ONB-10 | Copilot-mode welcome tour | ADAPT: O8 4 cards, no "unlocked chat" toast | ADAPT: first value is `/campus` | MVP |
| F-ONB-11 | In-app browser guard | BUILD | ADAPT: inside WeChat, use 公众号 OAuth instead of blocking (V2); phone OTP works everywhere | MVP |
| F-ONB-12 | Abandoned-signup email capture on blur | SKIP: collecting an email the user did not submit conflicts with our privacy stance | SKIP (PIPL) | — |

### 5.3 Feed (F-FEED)

> **cn feed note (rewritten for D5 and D6, 2026-10-11).** The GoApply job feed, recommendations and alerts are **on by default**; every cn row marked "(feed)" ships on. What makes that honest and lawful is how postings are shown, not a flag: every posting that does not come from GoHire shows its original publisher (`来源`), the original link and the date it was last verified; GoHire rows carry the licence line only when the licence values are configured; a posting with no working apply link is never listed; the feed header says where postings come from ("来自 N 家企业招聘官网") and never implies full-market coverage; nothing is scraped from a mainland job board. Today the feed is filled by public employer boards (postings located in mainland China, opened on the employer's own page), the user's imports and search deep links. GoHire's own jobs join once GoHire has a candidate-facing posting page: its `/jobs/<id>` address is "Page not found" today, so those rows are held, not shown. The operator's off switch is `CN_RECRUITMENT_INFO_MODE=off`; with it GoApply falls back to the seeker tools (校招日历, resume, tailoring against user-imported jobs, tracker, practice interviews, Assistant). Whether a public mainland launch needs the 人力资源服务许可证 or a licensed partner first remains counsel's question (CN-L-04).

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-FEED-01 | Four-tab jobs workspace, infinite scroll, in-place detail | ADAPT: `/jobs` tabs `For you · Explore · Added by you`; Saved/Applied live in `/applications` (our tracker is richer). Replace `MatchFeed.tsx` (8 rows) with a DB-paginated list (20 per page, cursor), split detail on desktop (`?job=`), full page on mobile. Feed refresh rate-limited (persisted). | = intl (feed) | MVP |
| F-FEED-02 | Sort: Recommended / Most recent / Top fit | BUILD: `Recommended` (fit × freshness × diversity) · `Newest` · `Best fit` · `Highest pay` (pay-listed jobs first) | = intl + `网申截止最近` for campus jobs | MVP |
| F-FEED-03 | Saved filters (named) | UPGRADE existing `RASavedSearch` API (no UI today): named saved searches, switcher in the filter bar, ≥1 always exists (the default from onboarding); alerts attach to a saved search. Free 1, Pro 10. | = intl | MVP |
| F-FEED-04 | Hidden Jobs (not on major boards), paid | ADAPT: **Recruiter-posted** filter = jobs from the RoboHire/GoHire banks (`fromRecruiterBank`). Free on every plan, no entitlement. Never claims "not on other job boards". These jobs get **no ranking boost** in Recommended (§5.3 F-FEED-02 ranking factors are public at `/help/ranking`). | ADAPT: 招聘方发布 (GoHire) | MVP |
| F-FEED-05 | Job card anatomy | ADAPT: card leads with the gap line and overlap line (R2), full-bleed score strip (C41), tier + score corner, past-tense work line (C38), then logo, company, title, location, work model, type, level, pay (or "Pay not listed"), posted/last-checked, source. Badges only from real fields: `Direct from employer` (only when the poster is not an agency and the posting company equals the account's verified employer; otherwise the source line "Posted on {sourceName} by a recruiter"), `Visa sponsorship mentioned` (only shown to users who need sponsorship; tooltip quotes the post: "The post says: '…'"), `Pay listed`, `Remote`, `Agency post` (when the provider flags it). Actions: Save for later, Apply on company site, Ask about this job, `…` (Not interested, Already applied, Report a problem, Share). | ADAPT: pay as "15-25K·13薪", source line "来源：…", 网申截止 date when known, 薪资未披露 | MVP |
| F-FEED-06 | Score ring, rank label, colour bands | ADAPT: our tier ladder `Great fit ≥80 · Good fit 65–79 · Possible 45–64 · Unlikely <45` (server-configurable), number as "87 / 100", permanent "This is not your chance of getting hired." Visitors see no score. | = intl; hidden when 个性化推荐 consent is off | MVP |
| F-FEED-07 | Recommendation tags (unicorn, investors, H1B, comp, growth) | ADAPT: funding/investor/unicorn tags SKIP (no data; DEFER to a licensed company-data provider). Keep posting-derived tags only: `Visa sponsorship mentioned` / `Says no visa sponsorship` (extracted text, shown only to users who need sponsorship), `Security clearance required`, `Citizens only` (extracted), `Pay listed`, `Benefits listed`. Max 3, fixed priority. | ADAPT: 央国企 / 外企 / 可落户 / 事业编 only from official text; 应届可投 / 届别 from programme data | MVP |
| F-FEED-08 | Applicant count and urgency | SKIP both. The only applicant counts available come from third-party LinkedIn scraping, and LinkedIn's "applicants" figure counts clicks, not applications. Never "Expires in N hrs". | SKIP | — |
| F-FEED-09 | In-feed calibration (daily rating, skill confirm, guide card, after-change check) | BUILD: rating card (0–10, <8 reasons), skills check chips, "Looks better / Not quite" after an Assistant filter change. Feedback writes to the saved search and to a per-user feedback table used by ranking. | = intl | MVP |
| F-FEED-10 | Zero-results diagnostics | BUILD: "What's limiting your results" lists each active filter with how many jobs it removes (real counts from count queries) and one-tap relax buttons | = intl | MVP |
| F-FEED-11 | Not Interested with reasons that edit filters | UPGRADE `usePassMatch` (today client-only): server-persisted hard exclusions. Reasons: This company · This industry · Skills I don't have (pick) · Not my location · Wrong level · Needs visa sponsorship I can't get · Already seen this title · Other. Each reason shows exactly which filter it will change before saving. | = intl (sponsorship reason replaced by 户口/届别 不符) | MVP |
| F-FEED-12 | Report Issue | BUILD: Scam or fake · Job is closed · Wrong location · Wrong pay · Not remote · Other. A scam report hides the job for the reporter, queues it for admin review, and offers "Hide agency posts". | ADAPT: + 招转培/培训贷/收费 reasons feeding the anti-fraud list (CN-E-08) | MVP |
| F-FEED-13 | Explore category browse | UPGRADE `/job-search` workspace into `/jobs/explore`: 20 function categories with live counts; provider results are **persisted to RAJob** so every result can be saved, scored, tailored and tracked | = intl | MVP |
| F-FEED-14 | Ranking pipeline | BUILD: candidate retrieval (title taxonomy + keyword FTS + bank search) → deterministic fit components (§5.4) → freshness decay → company diversity → personal feedback adjustments. LLM is used for the fit narrative on top results, not for ranking every job. | = intl | MVP |
| F-FEED-15 | Job ingestion, sources, freshness | BUILD scheduled ingest: RapidAPI providers + RoboHire bank (intl) persisted to `RAJob` with source, external id, posted date, last-seen date, apply URL; stale jobs archived after 2 missed refreshes or 45 days. Per-job extraction (skills, level, years, sponsorship text, pay) runs once per job. Card shows source and "Last checked {date}". | ADAPT (**D5 / D6**): public employer boards through their documented job-board APIs for postings located in mainland China (the source that fills the feed today) + the GoHire bank (synced over TLS or HTTPS; listed only once GoHire has a candidate-facing posting page) + curated calendar + user imports. No RapidAPI provider. Never scrape BOSS/智联/51job/猎聘/拉勾. Anti-fraud classifier before indexing, on every mainland row. Board and bank rows close when the source stops listing them, not by age | MVP |
| F-FEED-16 | Visitor feed and search | DEFER to V2 with public job pages: visitors see real lists, no score, gate actions at signup after 20 cards | = intl (feed) | V2 |
| F-FEED-17 | Explore AI (natural-language) search | UPGRADE the job-search agent planner: "remote data jobs in Berlin paying over €70k" → a filter diff card the user confirms (same card as F-ORION-04) | = intl | MVP |

### 5.4 Fit scoring (F-MATCH)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-MATCH-01 | Score breakdown | UPGRADE `RAJobMatchScorerAgent` + replace the fake `signals` in `routes/jobs.ts`: five published components with weights (ruling C6) — The job title and level 35 · The skills they ask for 30 · Experience in this industry 15 · Location, pay and visa 10 · How your career has moved so far 10. Score = weighted sum (transparent). Each component shows one evidence line ("They ask for 5+ years; your resume shows 6."). Education is shown inside "title and level" when the posting states a degree requirement. | ADAPT: + 届别/学历 eligibility inside "title and level"; school tier never scored | MVP |
| F-MATCH-02 | "Why this is a match" banner | UPGRADE: "Why you fit" (overlap) + "What you're missing" (gap) on detail; 2-line summary written from evidence, no first person | = intl ("为什么推荐") | MVP |
| F-MATCH-03 | Your-skill chips in qualifications | BUILD: required vs preferred skills from per-job extraction; chips the user has are marked; heading "They ask for these and your resume doesn't mention them:" (C17) | = intl | MVP |
| F-MATCH-04 | Competitiveness report (vs other applicants) | ADAPT: **"You and what employers ask"** — computed from our inventory for the user's saved search: share of postings whose degree/years/skill requirements the user meets, most requested skills with counts ("asked for in 64 of 212 posts"), and "Broaden your search" options with real extra-job counts. No "you outperform X% of applicants" (we have no applicant pool data). | = intl | V2 |
| F-MATCH-05 | "Top candidate" jobs | ADAPT: "Your best fits" (sort/filter by Great fit). No claim about ranking among candidates. | = intl | MVP |

### 5.5 Job detail (F-JOB)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-JOB-01 | Header and layout | BUILD `/jobs/[id]` (CommandPalette already expects it): company, title, meta chips, pay or "Pay not listed", posted + last checked, source, primary action `Apply on company site`, Save, Share, Ask. Tabs: Overview · Company · People (V2). | = intl + 网申 window and 届别 for campus jobs | MVP |
| F-JOB-02 | Overview body | UPGRADE `JobDetailModal` content: short summary (labelled "Summary written by AI from the job post"), then the posting's own Responsibilities, Qualifications, Benefits verbatim (cleaned Markdown). Work-authorization lines quoted verbatim. | = intl | MVP |
| F-JOB-03 | Right rail "Boost your chances" | ADAPT: **Get ready for this job** checklist (the loop, ruling C43): `Saved → Resume tailored → Practiced → Applied` with actions Tailor my resume · Write a cover letter · Practice for this job · People at {company} (V2) · Add to Ready to apply. Credit cost shown on each action. | = intl (cover letter de-emphasized) | MVP |
| F-JOB-04 | Company tab (Glassdoor, Crunchbase, leadership, news, H1B history) | ADAPT: only sourced facts — name, logo, website, size and industry when the provider gives them (source named), description from the posting, "{n} open jobs at {company} in RoboApply" (our count). Recent news (V2): web search via Tavily with publisher, date and link, labelled "Search results, not verified by RoboApply". Glassdoor, funding, leadership: SKIP until a licensed data provider (DEFER). Sponsorship history: DEFER to an ingest of US DOL OFLC public LCA disclosure files (government data, cited per year); not MVP. | ADAPT: company info from the posting and its source record (employer board or GoHire); 企业性质 from official registration data only (Later, needs a data source). **D5:** recent company news follows its flag only, as on RoboApply | MVP / V2 |
| F-JOB-05 | Similar jobs, closed-job handling | BUILD: similar jobs (same function, nearby fit); closed job shows "This job is no longer listed (last seen {date})" + similar jobs; tracker entry kept | = intl | MVP |
| F-JOB-06 | Apply button variants, apply intercept | ADAPT: `Apply on company site` (opens applyUrl, moves to Applied with inline Undo, ruling R1/C11) · `Fill with extension` (V2) · `Add to Ready to apply`. Easy Apply and Direct Apply SKIP (D1). Intercept: if no tailored resume exists for this job, a one-time sheet offers "Tailor my resume first" / "Apply with my current resume" / "Don't ask again". | = intl | MVP |
| F-JOB-07 | "Did you apply?" capture | ADAPT: ruling C11 — the card moves to Applied immediately on click with `Undo · I didn't apply`; no return modal | = intl | MVP |
| F-JOB-08 | Share job | BUILD: copy link to the public job page (V2) or app link (MVP) | ADAPT: + WeChat share card (V2) | MVP |
| F-JOB-09 | JobPosting structured data | BUILD on public `/job/[id]` pages; `validThrough` = last seen + 30 days; no invented salary | **D5:** = intl. Public job pages, browse pages, the ticker and sitemaps follow the same gates as RoboApply (`PUBLIC_DISPLAY_PROVIDERS`, publicly listable rows); Baidu-specific markup can follow | V2 |

### 5.6 Filters and search (F-FILT)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-FILT-01 | Basic criteria (function, excluded title, type, work model, country, location + radius, level, years, date posted) | BUILD server-side filters (replaces client-only `DiscoveryControls`): all listed fields; radius in km or mi by country; "Filters" panel with live count on `Show {N} jobs` | ADAPT: + 届别, 学历, 工作性质, 实习天数 | MVP |
| F-FILT-02 | Compensation and sponsorship | ADAPT: minimum pay with currency and period (jobs without pay kept unless "Only jobs that list pay" is on); "I need visa sponsorship in {country}" → shows jobs that mention sponsorship first and hides jobs that say no sponsorship; exclude "clearance required" / "citizens only". Sponsorship filters and badges show the quote they rest on; "says no sponsorship" hides a job only when a negation keyword appears in the quote as well as in the AI label. | ADAPT: K/月 floor, 元/天 for 实习; tags 央国企/外企/可落户/事业编; school-tier filter (user-side, on postings that state a requirement; never a ranking input) | MVP |
| F-FILT-03 | Interests (industry, excluded industry, skills, excluded skills, IC/manager) | BUILD | = intl | MVP |
| F-FILT-04 | Company insights (companies, stage, agency, excluded companies) | ADAPT: include/exclude companies, company size (when known), hide agency posts; no funding stage | ADAPT: employer type tags. **D5:** the company-size filter is kept beside them (when the size is known) | MVP |
| F-FILT-05 | Quick filter bar + active chips | BUILD: quick buttons (Country/location, Level, Job type, Work model, Date posted, Pay) + chips + fit-tier view filter `Great fits only · Good fits and better · Everything` with "Hiding {n} weaker fits. Show them." (ruling C2/C3) | = intl | MVP |
| F-FILT-06 | Title/company search with typeahead | BUILD: typeahead ≥2 chars, 300 ms debounce, titles and companies from our index | = intl | MVP |
| F-FILT-07 | "Save to default" from Agent | ADAPT: when filters change inside Ready to apply, ask "Use this for your main search too?" | = intl | MVP |

### 5.7 Assistant (F-ORION)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-ORION-01 | Floating chat panel | BUILD: right drawer on desktop, full-screen sheet on mobile; streaming answers; Stop; never auto-opens on navigation; threads persisted (Jobright has no history); "New chat". Voice input V2. Harvest `MessageBubble`, `StreamingText`, `Markdown`. | = intl. **D5:** on the shared model stack by default (a domestic model is an optional override); the AI consent prompt, the AI-generated label and the content-safety filter stay; voice input is enabled as on RoboApply | MVP |
| F-ORION-02 | Per-job quick actions | BUILD chips: Why I fit · What I'm missing · Resume tips for this job · Tailor my resume · Write a cover letter · Practice for this job · Similar jobs | = intl | MVP |
| F-ORION-03 | Job fit analysis | UPGRADE scorer explanation into a structured card (experience, level, skills aligned / missing, education, gaps, highlights); credit `fit_analysis` | = intl | MVP |
| F-ORION-04 | Chat-to-filter with diff | BUILD: Assistant proposes a diff card (added / changed / removed per field); nothing changes until `Apply changes`; then "Looks better / Not quite" | = intl | MVP |
| F-ORION-05 | Sort and show preferences via chat | BUILD | = intl | MVP |
| F-ORION-06 | Cheatsheet of example prompts | BUILD: "What you can ask" sheet, 6 groups | = intl | MVP |
| F-ORION-07 | Company insights card in chat | ADAPT: only the sourced company fields of F-JOB-04 | = intl | V2 |
| F-ORION-08 | Proactive nudges | ADAPT: at most one nudge per session, from real signals: low feed rating → "Adjust your search?"; scam report → "Hide agency posts?"; pay filter empty and many jobs list pay → "Add a minimum pay?" | ADAPT: + 网申截止 nudges | MVP |
| F-ORION-09 | Career, interview, salary advice | BUILD: free-form chat with context (profile, resume, saved search, tracker). Salary advice cites posted ranges with counts; never invents market data. | ADAPT: + long-term career memory with explicit consent and a "What the assistant remembers" page with delete (职悟空 parity) | MVP (cn memory V2) |
| F-ORION-10 | Message and list feedback | BUILD thumbs up/down per answer + optional reason; forwards to admin review | = intl | MVP |
| F-ORION-11 | Orion persona for onboarding and agent | SKIP: no persona (rulings D4/C9); onboarding uses plain screens | SKIP | — |
| F-ORION-12 | Full card vocabulary | ADAPT the useful subset: `FILTER_DIFF`, `SORT`, `PREFERENCES`, `JOB_LIST`, `FIT_ANALYSIS`, `RESUME_TIPS`, `TAILOR_RESULT`, `COVER_LETTER`, `ADD_EXTERNAL_JOB`, `SKILL_SUGGESTION`, `TITLE_SUGGESTION`, `PRACTICE_LINK`, `UPGRADE_NOTICE` (credit exhausted only), `FEEDBACK`. SKIP email-contact cards and the retention-offer card. | = intl + `CAMPUS_DEADLINES` | MVP |
| F-ORION-13 | Visitor (logged-out) Orion | DEFER: needs public job pages and per-IP cost control; when built, answers only about the page and never about the visitor's fit | DEFER | Later |

### 5.8 Ready to apply (F-AGENT, supervised)

The whole area follows D1: we prepare, the user submits. Every screen states it in one line: "You submit each application yourself."

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-AGENT-01 | Agent intro and access gate | ADAPT: `/ready` intro explains the weekly list and kits; no waitlist; Free gets 3 kits/week, Pro up to 30/week | = intl (待投递) | MVP |
| F-AGENT-02 | Setup wizard | ADAPT `/ready/setup`, 4 steps: (1) Confirm profile (required autofill fields, "Missing" flags) · (2) Check your search: rate 3 picked jobs 👍/👎 with reason, `Show 3 more` · (3) Application answers (common questions bank, F-AGENT-03) · (4) Weekly settings · (5) Get the extension (V2, skippable; install, detect and version check). Done → first list generated. | = intl, cn question bank (家庭成员/政治面貌 optional) | MVP |
| F-AGENT-03 | Agent settings | ADAPT: no modes (supervised only). Settings: jobs per week target (5 · 10 · 20 · 30), minimum tier (Good fit default), tailor resume for each job (on), write a cover letter only when the post asks for one (on), base resume, file naming. Common application questions (why this company, notice period, salary expectation per currency, work authorization, relocation, start date). | = intl + 网申 fields | MVP |
| F-AGENT-04 | Run queue | ADAPT: weekly list (generated Monday 06:00 local, or on demand): jobs picked from the saved search; user can add any job; `Prepare kits` runs tailoring for selected jobs; tabs `To prepare · Ready · Done`; expired jobs flagged with `Remove`. | = intl | MVP |
| F-AGENT-05 | Per-application state machine | ADAPT: `picked → preparing → ready_for_review → approved → opened → applied` (+ `skipped`, `expired`). Review screen: tailored resume diff with **Verify details** (mandatory for every inserted claim), cover letter, answers with copy buttons, chosen file name. `Open application` behaves exactly like `Apply on company site`: it opens the employer site, moves the job to Applied at once and shows an inline `Undo · I didn't apply` (ruling C11). In V2 the extension also asks "Did you submit this application?" — the job is marked submitted only when the user says so; the extension never watches form submits. | = intl | MVP |
| F-AGENT-06 | Hand-off branches | ADAPT: two branches only — extension fill (V2) or manual with copy-ready answers (MVP). Missing info → ask the user. | = intl | MVP |
| F-AGENT-07 | Server-side Easy Apply | SKIP: submits on the user's behalf (D1) | SKIP | — |
| F-AGENT-08 | Agent tracker + progress widget | ADAPT: kit preparation progress in `/ready` and a small status in the sidebar badge; applied kits appear in `/applications` with their files attached | = intl | MVP |
| F-AGENT-09 | Gmail connection for verification codes | SKIP: only needed for unattended submission (D1) | SKIP | — |
| F-AGENT-10 | Credit gates during runs | BUILD: cost shown before `Prepare kits` ("Uses 5 tailoring credits; you have 2 left today"); out-of-credit sheet with three honest options (§6.4) | = intl | MVP |
| F-AGENT-11 | Chat vocabulary / event stream | ADAPT: kit events stored as an audit log per job (what was generated, what the user approved, which file was opened); visible as a history list on the kit | = intl | MVP |

### 5.9 Resume suite (F-RES)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-RES-01 | Intake and parsing + sync to profile | UPGRADE upload/parse (GoHire first) + new `Update my profile from this resume` with a field-by-field review | = intl, Chinese sections | MVP |
| F-RES-02 | Resume hub (5 slots, primary) | UPGRADE `/resume`: up to 5 base resumes (Free and Pro), one primary, target title per resume; tailored versions listed per job, not counted in the 5; cover letters tab | = intl | MVP |
| F-RES-03 | Resume analysis report card | UPGRADE `AnalyzerPanel` (today a local heuristic) into **Resume check**: LLM + rules report with grade (Excellent / Good / Fair / Needs work), issues by severity (Fix first · Important · Nice to have) per section; credit `resume_check`; cancel refunds | ADAPT: Chinese conventions (自我评价, 实习, CET) | MVP |
| F-RES-04 | Issue taxonomy | BUILD: layout risks (tables, columns, images — "Company software may not read this"), missing contact/sections, weak verbs, no numbers, buzzwords, spelling, bullet length, summary, too few skills | ADAPT: + photo/籍贯 optional notes, 1–2 pages | MVP |
| F-RES-05 | Fix panel with AI rewrite | UPGRADE existing inline rewrite (`RAResumeRewriteAgent`): issue → why it matters → how to fix → AI version → Use / Edit / Shorter / Longer; CitationGuard blocks invented numbers | = intl | MVP |
| F-RES-06 | Re-check and progress comparison | BUILD: previous vs current check, change per severity | = intl | MVP |
| F-RES-07 | Product tour for analysis | BUILD: 4-step coach marks, stored server-side per user | = intl | V2 |
| F-RES-08 | Resume-vs-job report (gauge out of 10) | ADAPT: **Keyword check** on job detail and in tailoring: requirements met / not met rows (title, years, education, skills n/m, keywords n/m) using the same fit components; no second scale — uses the 0–100 fit score | = intl | MVP |
| F-RES-09 | Tailor wizard | UPGRADE `TailorModal`: launchable from any job; steps: sections to change (Summary, Skills, Experience quick/full, Projects) → optional instruction (≤1000 chars) → missing keywords to add (only ones the user confirms they have) → generate; `Fast tailor` one-click default for repeat users | = intl | MVP |
| F-RES-10 | Tailored result: diff, compare, verify | UPGRADE tailor-diff: before/after score, change cards, compare, **Verify details** mandatory before export/use (Yes, keep · Remove · I did something similar → edit), saved per job | = intl | MVP |
| F-RES-11 | AI rewrite chat for the resume | ADAPT: resume-scoped Assistant thread ("Change my resume…") with element scoping; voice V2 | = intl | V2 |
| F-RES-12 | Structured editor | UPGRADE existing editor (markdown ↔ structure) with all sections incl. custom sections and reorder | ADAPT: Chinese section set (基本信息, 求职意向, 教育, 实习, 项目, 校园经历, 技能证书, 获奖, 自我评价), optional photo | MVP |
| F-RES-13 | Templates and formatting | UPGRADE: 5 templates (Standard recommended, Compact, Centered, Structured, Two-column with a warning), fonts limited to bundled resume fonts, Letter/A4 by country, spacing, accent, date format | ADAPT: A4, CJK fonts, Chinese templates, zh/en bilingual export | MVP (cn templates V2) |
| F-RES-14 | Fit to one page | BUILD: adjusts spacing/size/margins only, with undo | ADAPT: 1–2 pages | V2 |
| F-RES-15 | Export PDF/DOCX, file names | UPGRADE existing export; file-name presets; the exact exported file is recorded on the kit/tracker entry; move the raw URL into `lib/api/` | ADAPT: + AI-content metadata in exports (CN-E-07) | MVP |
| F-RES-16 | LinkedIn profile report | DEFER with **no seam**: the `LINKEDIN_ENRICH_*` import uses a scraping provider and is removed; unblocked only by an official, licensed profile source (or the user's own LinkedIn data export) | SKIP (LinkedIn not used in cn) | Later |
| F-RES-17 | From-scratch builder | BUILD: guided form builder (role, education, experience bullets with prompts) → editor | BUILD: Chinese 应届 builder (most cn users start from scratch) | V2 (cn MVP) |

### 5.10 Cover letters (F-CL)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-CL-01 | Cover letter generator | BUILD new endpoint reusing the `RoboApplyAuthorAgent` prompt + CitationGuard, input = resume variant + job; tone (Plain · Warm · Formal) and length (Short · Standard) presets; facts from the job are never written as the candidate's own; credit `cover_letter` | ADAPT: for 外企 and English applications; zh version optional | MVP |
| F-CL-02 | Editor + AI rewrite, export | BUILD `/resume/letters/[id]`: edit, rewrite prompts, versions, copy, PDF/DOCX, attach to kit | = intl | MVP |

### 5.11 People and referrals (F-NET)

D-04 resolved: **no purchased people data and no email finder in MVP.** People features rest on three honest sources: LinkedIn search deep links built from the user's own profile, the user's own connections export, and opted-in recruiters from RoboHire/GoHire.

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-NET-01 | LinkedIn URL capture | ADAPT: optional field in profile and O7; used for deep links and outreach drafts, not for matching | SKIP | MVP |
| F-NET-02 | Insider panel (3 buckets) | ADAPT: **People at {company}** tab with three buttons that open LinkedIn people search: people in this role at {company} · people at {company} who worked at {your past companies} · alumni of {your schools} at {company}. V2 adds "People you know" from the user's **own LinkedIn connections CSV export** (only name, company, position and connected-on date are kept — the email column is discarded; matched by company name; stored privately; deletable; explained in the privacy notice as third-party data). V2 adds the job's **hiring contact** for RoboHire-bank jobs only when the recruiter opted in through a RoboHire/GoHire opt-in record that we read by API (never backfilled); hidden until such a record exists. | ADAPT: 内推 hub (F-NET-08 cn). **D5:** the People tab also shows hiring contacts and people-you-know from the user's own import under the same mode as RoboApply, with 内推码 added | MVP (deep links), V2 (import, hiring contact) |
| F-NET-03 | "Find more" deep link | BUILD (this is the MVP mechanism of F-NET-02) | SKIP | MVP |
| F-NET-04 | Connect-on-LinkedIn note | ADAPT: AI-drafted note within LinkedIn's length limit, grounded in the job post and the user's resume ("Written from the job post and your resume."), Copy + Open LinkedIn; never sent by us; credit `outreach` | SKIP | MVP |
| F-NET-05 | Work-email finder | DEFER: needs a licensed people-data provider and a privacy review (owner decision D-04); unblocked by a signed provider contract with opt-out handling | SKIP (PIPL) | Later |
| F-NET-06 | Connect via email composer | ADAPT: AI drafts (short note, email, referral request) per contact, opened as prefilled `mailto:` (ruling C44); the user supplies the address; draft saved on the tracker entry | ADAPT: 内推请求 message drafts for WeChat/脉脉 (copy) | MVP |
| F-NET-07 | Find any email | DEFER with F-NET-05 | SKIP | Later |
| F-NET-08 | Send My Profile (TNT direct referral) | DEFER: "Send my profile" to a RoboHire employer for RoboHire-bank jobs. Unblocked by a RoboHire candidate-intake API and an owner check that a user-clicked send with a full preview of what is sent satisfies D1. | ADAPT later: **内推 hub** — collect and share employer 内推码 (user-contributed, moderated, with date), alumni referral requests within an opt-in school network; partnerships with 牛客/脉脉 Later | Later (cn 内推码 V2) |
| F-NET-09 | Messages inbox with employer invitations | ADAPT: `/inbox` ships in MVP for real system items (alerts, reminders, deadlines, billing, announcements). Employer invitations DEFER until RoboHire/GoHire recruiter outreach integrates (Later); employers see only what the candidate chooses to share. | = intl | MVP (inbox), Later (invites) |
| F-NET-10 | Candidate verification (LinkedIn OAuth, work email) | DEFER: only valuable once employers see candidates (F-NET-08/09) | DEFER | Later |

### 5.12 Applications tracker (F-TRK)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-TRK-01 | Liked list | UPGRADE: Save for later on cards/detail writes tracker status `bookmarked` (wire the unused `useSaveJob`); `/applications?status=saved`; closed jobs grouped | = intl | MVP |
| F-TRK-02 | Applied list with 5 statuses | UPGRADE `/applications`: views `By stage` (existing board, columns per ruling C1) · `By date` · `List` (search, status filter, counts); detail drawer with notes, dates, salary, files sent, follow-up draft, "who ended it" (They said no / I withdrew / Job was pulled) | ADAPT: stages 网申 → 测评 → 笔试 → AI面试 → 面试 → Offer → 三方 (+ 未通过 / 放弃) | MVP |
| F-TRK-03 | Auto-capture into Applied | ADAPT: on `Apply on company site` and on kit `Open application` (both with Undo), when the user tells the extension they submitted (V2), on "Already applied" | = intl | MVP |
| F-TRK-04 | External job import | BUILD `/jobs/added`: paste a URL (fetched with Firecrawl, extracted, user confirms fields) or enter manually; boards whose terms forbid scraping (LinkedIn, Indeed, Glassdoor, BOSS直聘, 智联, 猎聘, 51job, 脉脉, 104, 1111, Cake, Yourator — `IMPORT_FETCH_DENYLIST`) are never fetched: the user pastes the job text or saves it with the extension; imported jobs are private and never counted; the job becomes a full `RAJob` (user-owned source) with fit score, tailoring, practice and tracking; limits 10/day Free, 50/day Pro | = intl (the only job input on GoApply when the operator has switched the feed off) | MVP |

### 5.13 Interview prep (F-INT)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-INT-01 | Company question bank | ADAPT: **Practice questions** per job and per company: AI-written questions generated from the job post and the company's other postings, labelled "Written by AI from the job post — not reported by candidates"; plus user-contributed questions (moderated, labelled "Shared by a RoboApply user, {month year}"). No scraped community reports. | ADAPT: + HR面 bank (V2); 笔试/测评 practice sets DEFER (needs an item source we may use) | V2 |
| F-INT-02 | In-browser coding runner | DEFER: needs a sandboxed code-execution service; unblocked by choosing a provider (e.g. Judge0-style) and a cost cap | DEFER | Later |
| F-INT-03 | Report and contribute questions | BUILD with F-INT-01 | = intl | V2 |
| F-INT-04 | Interview passes | SKIP as a separate product: folded into Pro and Practice packs (§6.3) | SKIP | — |
| F-INT-05 | AI Interviewer voice intake for employers | SKIP as employer intake (no employer loop yet). Its call state machine is the reference for the Wave 0 live-interview fixes (D4). | SKIP | — |
| F-INT-06 | Scored AI mock interview | UPGRADE (differentiator): `Practice for this job` from every job, kit and tracker entry (prefills the job and resume); first full practice free after email verification (C42); report questions per ruling C16; depends on **Wave 0** reliability fixes | ADAPT: **AI面试 simulation** in the formats employers commonly use (copy: "模拟企业常用的 AI 面试形式"; no vendor names) (20–30 min, communication / logic / behaviour questions, STAR completeness, filler words); audio-first; video opt-in, analysed in session only; no face analysis; recordings off by default (both brands: recording only with `interview_recording` consent at setup, video needs a second opt-in, purge after 90 days); **D5:** voice and video practice run on the shared LiveKit project, worker and speech models by default (a mainland media plane is an optional override), and the camera and video policy is the same as RoboApply's behind the per-session consents; `CN_INTERVIEW_CAMERA_PUBLISH=false` restores audio only | MVP (both brands) |

### 5.14 Coaching (F-COACH)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-COACH-01 | 1:1 coaching booking | ADAPT: admin-managed roster of real coaches (`/admin/coaches`); `/coaching` lists active coaches with real bios; booking = the coach's own Cal.com (or similar) link, or a request form emailed to the coach and admin; payment handled by the coach in V2, by Stripe one-time checkout Later. Nav item and all upsells hidden while the roster is empty. No ratings until we have real post-session ratings (shown with count). | = intl, cn roster and WeChat contact instead of Cal.com. **D5:** on by default on GoApply under the same rule (hidden while the roster is empty) | V2 |
| F-COACH-02 | Coaching policies | BUILD a policy page per brand when coaching launches (lead time, cancellation, no-show) | = intl | V2 |
| F-COACH-03 | Group deep-dive sessions | DEFER: needs real hosts and an events model | DEFER | Later |
| F-COACH-04 | Weekly Pro office hour | DEFER: only if a real host commits; never advertised before | DEFER | Later |
| F-COACH-05 | Coaching upsells and bundles | SKIP bundles; one contextual link "Prefer a person? See coaches" on the practice report when the roster is non-empty | = intl | V2 |
| F-COACH-06 | Coach free trial / in-tailor upsell | SKIP the trial popup; the practice interview is our first step before a human coach | SKIP | — |

### 5.15 Pay and company data (F-SAL)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-SAL-01 | Salary on cards/detail, min-pay filter, chat commands | BUILD: pay from the posting or provider with currency and period (fix the list projection that drops `salaryPeriod`, ruling C37); "Pay not listed"; TW 面議 parsed as unknown, monthly < NT$40,000 must have a range (if a TW post says 面議 below that, show "Pay not listed") | ADAPT: K/月·N薪, 元/天, 薪资未披露 | MVP |
| F-SAL-02 | Market snapshot | ADAPT: inventory-based snapshot (O2, G4) with N shown | = intl | MVP |
| F-SAL-03 | H1B history + LCA median salary | DEFER: US-only DOL OFLC LCA public data ingest, shown per employer per year with source link and the line "Past sponsorship does not mean this job sponsors." Unblocked by a data job + legal review of presentation. | SKIP | Later |
| F-SAL-04 | Funding, valuation, investors, Glassdoor | SKIP until a licensed data provider; never estimated by AI | SKIP | — |
| F-SAL-05 | Data-report blog posts | DEFER with the blog; reports only from our own aggregated, anonymized inventory with method notes | DEFER | Later |
| — (gap) | Offer comparison / negotiation | BUILD (V2): tracker offer fields (base, bonus, equity text, currency, start date) + side-by-side comparison + a negotiation draft grounded in posted ranges for the role (N shown) | BUILD: **Offer 对比** (V2) with 13薪/年终/公积金 fields | V2 |

### 5.16 Notifications (F-NOTIF)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-NOTIF-01 | Instant job alerts with frequency caps | BUILD: per saved search; frequency Off · 1/day · 2/day · 5/day · As they arrive (checked hourly after ingest); Free max 1/day, Pro all | ADAPT: in-app inbox + WeChat subscribe message (V2). **D5:** email alerts work by default through the shared transport, for users who have an email address | MVP |
| F-NOTIF-02 | Daily / weekly digest | BUILD: the user picks Daily · Weekly · Off at onboarding O7 (Daily preselected because the digest is a service message with no upsell blocks); top new fits since the last email | = intl (in-app) | MVP |
| F-NOTIF-03 | Logged-out job-alert signup | DEFER: needs double opt-in and resume-less matching; with public tools | SKIP | V2 |
| F-NOTIF-04 | Unsubscribe with reason survey | BUILD: one-click unsubscribe (List-Unsubscribe header) + optional reason | = intl | MVP |
| F-NOTIF-05 | Transactional emails | BUILD per §7 (verification, reset, receipts, renewal reminders, deletion, etc.) | ADAPT: SMS OTP only; others in-app/email | MVP |
| F-NOTIF-06 | In-app nudges and offer banners | ADAPT: toasts and a shared one-prompt-per-24h budget; **no countdown banners**; offers only per §6.4 | = intl | MVP |
| F-NOTIF-07 | Mobile push | DEFER with native apps; web push V2 for alerts and reminders | **D5:** = intl (web push on the shared keys) **plus** WeChat subscribe messages as an additional channel (V2) | V2 |
| F-NOTIF-08 | Follow-up and interview reminders (gap at Jobright) | BUILD: follow-up reminder after 10 days without a reply (uses existing `followUpAt`), interview-date reminders, kit-not-opened reminder | ADAPT: + 网申截止 3-day and 1-day reminders | MVP |
| F-NOTIF-09 | "What's new" announcements | BUILD server-driven announcements per brand/locale/cohort, max one shown, shares the prompt budget | = intl | V2 |
| F-NOTIF-10 | SMS channel | SKIP for intl | ADAPT: OTP only, no links | MVP (cn OTP) |

### 5.17 Browser extension (F-EXT)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-EXT-01 | Listing and distribution | BUILD "RoboApply for Chrome" (MV3, Chrome Web Store; Edge Add-ons too); minimal permissions (activeTab, scripting, storage); store copy states that the user submits | BUILD 一键填表 (the name ruled in TASK_PLAN R-11) on Edge Add-ons + Chrome Web Store; test reachability on 3 carriers. **D5:** the navigation entry and `/extension` page exist on GoApply under the same gates as RoboApply, with a store-listing fallback until the GoApply build is published | V2 |
| F-EXT-02 | Autofill side panel | BUILD: side panel with job, fit tier, `Fill this form`, per-field checklist, editable answers; never clicks submit | ADAPT: modes 全部填写 / 只填空白 / 填写选中区域 | V2 |
| F-EXT-03 | ATS coverage + site requests | BUILD for Greenhouse, Lever, Workday, Ashby, SmartRecruiters, iCIMS, Workable; "Request this site" | ADAPT: 北森, Moka, 大易, 飞书, big-tech portals | V2 |
| F-EXT-04 | AI answers to questions | BUILD from the Application answers bank; new answers drafted per job appear **only in the side panel** and go into a field only when the user clicks `Use this answer` for that field; saved back on approval. Never AI-generated: work authorization, sponsorship, criminal history, EEO/disability/veteran, salary history or expectation, years of experience, degrees, certifications, clearance, notice period (bank/profile only, or left for the user). Credit `ai_answer` | = intl | V2 |
| F-EXT-05 | Tailored resume attached | BUILD: attaches the kit's verified tailored PDF; shows a preview of the exact file; records the file sent | = intl | V2 |
| F-EXT-06 | Fit score on other job boards | BUILD: when the user clicks the toolbar button on a job page ("Check fit" / "Save"), read that page (`activeTab`) and show a fit chip from the same scoring service; nothing runs or is sent on page load; saved jobs are private | ADAPT: official portals only | V2 |
| F-EXT-07 | Install hand-off and detection | BUILD `/extension` with detection, version check, session handoff (short-lived token) | = intl | V2 |
| F-EXT-08 | Uninstall exit survey | BUILD | = intl | V2 |
| F-EXT-09 | Save a job from any site | BUILD: one click → `Added by you` | = intl | V2 |

### 5.18 Mobile (F-MOB)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-MOB-01 | iOS app | DEFER: responsive web + installable PWA first; native apps after V2 metrics prove retention | DEFER | Later |
| F-MOB-02 | Android app | DEFER as above | DEFER (fragmented stores) | Later |
| F-MOB-03 | Mobile web prompts and bottom nav | ADAPT: bottom nav §3.3; PWA install prompt once, after the second session; no app-download modal | ADAPT: + "在浏览器中打开" guidance banner on actions WeChat's webview blocks (downloads, the extension) | MVP |
| F-MOB-04 | Desktop-only gates | SKIP: every feature works on mobile (stacked layouts) | SKIP | — |
| F-MOB-05 | Native Orion/Agent unknowns | — (no native apps) | — | — |
| F-MOB-06 | Store facts | — (reference only) | **WeChat mini program**: DEFER to Later, gated on ICP + mini-program filing (CN-L-06); H5 first | Later |

### 5.19 Account and profile (F-ACCT)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-ACCT-01 | Auth: Google, email, Apple | BUILD: email/password (exists) + Google OIDC (seeker flavour, not the recruiter `oauthLogin`) MVP; LINE Login for Taiwan V2; Apple only with a native app (Later) | ADAPT (**D5**): email + password first, open sign-up, verification and password reset as on RoboApply; phone + SMS OTP and WeChat as additional methods that appear when their credentials are set (SMS signature CN-L-07). Google and LINE stay RoboApply's additional methods (a market difference; Google on GoApply is an owner decision) | MVP |
| F-ACCT-02 | Password reset, verification | BUILD: forgot/reset password, email verification (non-blocking), student email verification (V2, for student pricing) | ADAPT: reset for email-fallback accounts; change phone (OTP to the old number or identity re-verification, plus OTP to the new number; other sessions revoked) | MVP |
| F-ACCT-03 | Profile page + completion wizard | BUILD `/profile` (none exists): personal, education, work, skills, links, work authorization per country, application answers; profile ≠ resume (resume can update profile, never the reverse silently) | ADAPT: 基本信息 with optional 籍贯/政治面貌/照片 (never used for matching and never sent to any LLM; placed into documents by the renderer), 家庭成员 optional for 网申; photo field hidden in CN-0 | MVP |
| F-ACCT-04 | EEO answers | ADAPT: US-only optional section, shown only to users targeting the US, used only by the extension, never sent to an LLM, deletable | SKIP | V2 |
| F-ACCT-05 | Settings page | UPGRADE `/settings` sections (§3.4); prune dead agent knobs (aggressiveness, matchThreshold, dailyCap, quiet hours, autoDecline, autoSchedule); notification settings per channel; credits view | ADAPT: + 授权管理 (withdraw consents), 个性化推荐 switch, data export | MVP |
| F-ACCT-06 | Delete account | UPGRADE existing delete/wipe; confirmation email; relocate the V1 dependency before deleting the V1 engine (ruling C27) | = intl + PIPL deletion within 15 working days | MVP |
| F-ACCT-07 | Passive candidate magic-link preferences | DEFER: part of the RoboHire recruiter loop | DEFER | Later |

Note: the catalog's §3.4 cites "F-ACCT-12" for `/candidate-preferences`; no such entry exists. It is F-ACCT-07 above.

### 5.20 Billing and credits (F-BILL)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-BILL-01 | Typed daily credits | BUILD credits/entitlements service per §6.2 (brand × plan × credit key, admin-editable), success-only debits (existing pattern), "Uses 1 tailoring credit · 1 left today" before spending | = intl | MVP |
| F-BILL-02 | Plan picker (in-app only) | ADAPT: public `/pricing` + in-app plan sheet, real prices, "Save {x}%" computed from our own monthly price, no struck-through anchors | ADAPT (**D5 / D6**): 会员 passes with real CNY prices, shown and purchasable by default through Alipay; student passes for verified students; Alipay listed first, WeChat Pay when available | MVP |
| F-BILL-03 | Subscription management | UPGRADE existing billing settings: current plan, renewal date, **one-click Cancel** (no survey required; survey optional after), switch plan (a quote sheet — amount today, new renewal price, next renewal date — before `Confirm`), Stripe portal, payment-failed state with retry; public `/cancel` page linked in every footer that works without signing in (email → one-time link → confirm; confirmation email) | ADAPT: passes don't renew; "续费" button + reminder | MVP |
| F-BILL-04 | First-day countdown offer | SKIP the countdown; **no offer at launch**. An optional "Welcome price" is an owner decision (§6.4 rules) | SKIP at launch | — |
| F-BILL-05 | 7-day trial offer | ADAPT: the 7-day pass (one-time, no auto-renew) replaces trials | = intl (周卡) | MVP |
| F-BILL-06 | Winback / unsubscribe save / retention | ADAPT: at cancel, show once "Switch to the 7-day pass instead?" as a secondary link next to the primary Cancel button (never blocking); one winback email 30 days after churn, only with marketing consent | = intl | V2 |
| F-BILL-07 | Upgrade touchpoints | ADAPT: only at real limits (§6.4) | = intl | MVP |
| F-BILL-08 | Refund policy | BUILD per brand: first subscription purchase refundable within 7 days (weekly: 48 h) if fewer than 5 paid-only credits used; accidental renewal within 3 days; practice packs refundable if unused. **EU/UK:** 14-day right of withdrawal — full refund within 14 days unless the user ticked "Start now: I understand I lose my right of withdrawal once I use paid features" at checkout; **TW:** the digital-services exemption applies only with that prior agreement | ADAPT per CN consumer law; counsel review | MVP |
| F-BILL-09 | Plan/SKU catalog | BUILD plan keys §6.3; student SKU V2 | = intl | MVP |
| F-BILL-10 | In-subscription upsell/retention engine, AI-personalized offers | SKIP (dark-pattern risk); only the quarterly switch suggestion once after 30 days of monthly, dismissible forever | SKIP | — |
| F-BILL-11 | Checkout terms, coupons, balance | ADAPT: checkout shows price, period, renewal date, taxes; coupons via Stripe promotion codes (V2); referral rewards are credits, not cash balance | ADAPT: CNY, Alipay now, WeChat Pay V2 | MVP |

### 5.21 Free tools (F-TOOL)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-TOOL-01 | Tools hub + templated tool pages | ADAPT: a small hub with tools that **actually work**; no lander-only "tools" | ADAPT: 简历体检 + 校招日历 | V2 |
| F-TOOL-02 | ATS resume checker | ADAPT: **Free resume check** without an account (upload → short report; full report after signup); persisted per-IP limit 3/day; files deleted after 24 h unless the user signs up | = intl | MVP |
| F-TOOL-03 | Resume–job matcher | BUILD: paste a job link or text + resume → fit components and gap list; no account; same limits | = intl | V2 |
| F-TOOL-04 | Job alert form | DEFER with F-NOTIF-03 | **D5:** = intl (signed-out job alerts work through the feed and email defaults) | V2 |
| F-TOOL-05 | Grad jobs list | ADAPT: `/browse/graduate/[role]` with live inventory | ADAPT: `/campus` | V2 (cn MVP) |

### 5.22 SEO and programmatic pages (F-SEO)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-SEO-01 | Role taxonomy hubs | BUILD `/browse/[role]` from live inventory; page only when ≥10 live jobs; localized | **D5:** = intl, under the same gates (`PUBLIC_DISPLAY_PROVIDERS`, live inventory, the minimum-rows rule); Baidu submission later | V2 |
| F-SEO-02 | Role × city | BUILD `/browse/[role]/[city]` (incl. Taipei, Hsinchu, Taichung, Kaohsiung) | **D5:** = intl for mainland cities, under the same gates | V2 |
| F-SEO-03 | Keyword landings | DEFER: thin-content risk | SKIP | Later |
| F-SEO-04 | H1B role × city lists | ADAPT: `/browse/visa-sponsorship/[country]/[role]` from posting text that mentions sponsorship, with the method stated on the page | SKIP | V2 |
| F-SEO-05 | Indexable job detail | BUILD `/job/[id]-[slug]` with JSON-LD | DEFER | V2 |
| F-SEO-06 | Remote minisite | ADAPT: `/browse/remote/[role]` inside the main site | SKIP | V2 |
| F-SEO-07 | Segment hubs (entry level, intern, new grad) | ADAPT: `/browse/entry-level`, `/browse/internships` from live inventory | ADAPT: `/campus` by 届别 and industry | V2 (cn MVP) |
| F-SEO-08 | Competitor compare pages | DEFER: only with dated, cited facts and legal review | SKIP | Later |
| F-SEO-09 | Blog | DEFER: content operations | DEFER (公众号/知乎 instead) | Later |
| F-SEO-10 | Crawl policy | BUILD per-host robots/sitemap/`llms.txt` (fix stale auto-apply text); AI crawlers allowed on marketing pages | ADAPT: Baiduspider rules, Baidu verification | MVP |
| F-SEO-11 | GitHub job-list repos | DEFER: after public job pages exist | SKIP (牛客/公众号 later) | Later |
| F-SEO-12 | Satellite list domains | SKIP: brand dilution | SKIP | — |

### 5.23 Growth (F-GROW)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-GROW-01 | Refer & Earn | ADAPT: `/invite` link `/r/[code]`; when the invitee verifies (email or SSO) and finishes onboarding, both get **1 practice credit**; inviter cap 10/year; fraud checks (same device/IP/payment) | ADAPT: WeChat share card; same reward | V2 |
| F-GROW-02 | LinkedIn post reward | SKIP: incentivized testimonials | SKIP | — |
| F-GROW-03 | Attribution plumbing | BUILD (F-ONB-02) | = intl | MVP |
| F-GROW-04 | Review-velocity prompts | DEFER: an unincentivized review request once, after a user marks an offer received | DEFER | Later |
| F-GROW-05 | New-user missions | ADAPT: checklist with a deterministic reward (O8) | = intl | MVP |
| F-GROW-06 | Custom GPTs | SKIP | SKIP | — |
| F-GROW-07 | List rating with gift-card call offer | ADAPT: feed rating (F-FEED-09) only; user interviews recruited separately, not in product | = intl | MVP |
| F-GROW-08 | Referral-partner API intake | DEFER: the existing job-search API product is the partner seam; no partner data intake without contracts | DEFER | Later |
| F-GROW-09 | Product Hunt social proof | DEFER: launch event, not a feature; show badges only if real | SKIP | Later |
| F-GROW-10 | Reply to store reviews | DEFER with native apps | DEFER | Later |

### 5.24 Trust and safety (F-TRUST)

| ID | Jobright feature | RoboApply | GoApply | Phase |
|---|---|---|---|---|
| F-TRUST-01 | Security page, account safety | BUILD: security page describing real practices; new-device sign-in email | = intl | MVP |
| F-TRUST-02 | Bot challenge on job pages | ADAPT: persisted rate limits on public pages and tools (replace the in-memory limiter); Vercel firewall rules | ADAPT: CN WAF on the mainland host | V2 |
| F-TRUST-03 | Rate limits | BUILD DB-backed limits for auth, uploads, imports, tools, feed refresh, Assistant | = intl | MVP |
| F-TRUST-04 | Scam and quality controls | BUILD: report flow, "Reports to review" list in `/admin`, agency-post hiding, rule-based scam signals (fees, "pay to apply", messaging-app-only contact) | ADAPT: CN-E-08 classifier (招转培, 培训贷, MLM) with evidence retention and blacklist | MVP |
| F-TRUST-05 | Honesty disclaimers | BUILD: required strings (fit score line, AI-written labels, "Search results, not verified", sponsorship disclaimer, "You submit each application yourself") | ADAPT: + AI 生成内容标识 (CN-E-07) | MVP |
| F-TRUST-06 | Privacy notice commitments | BUILD per brand: named AI processors and their countries per brand (RoboApply user data never goes to a mainland-China model endpoint, primary or fallback), transfer countries, a published retention schedule (Assistant messages 12 months; interactions 13 months; soft-deleted rows 30 days; application artifacts 180 days; inactive accounts 24 months after notice; OTP/auth tokens 24 h; interview recordings 90 days; account data deleted within 30 days of deletion; backups 90 days), no ad pixels, analytics only after consent for EEA/UK/CH visitors, minimum age 16 | ADAPT: PIPL notice; in CN-0 the notice names every offshore processor and the US region (no "data stays in mainland" claim until CN-1) | MVP |
| F-TRUST-07 | Support channels | BUILD `/help` FAQ + support email per brand + in-app "Contact support" form; seeker 2FA (TOTP) V2 | = intl | MVP |
| F-TRUST-08 | Terms of service guardrails | BUILD per brand: user submits applications; truthful info; tailored content must be verified by the user; no scraping | ADAPT: 用户协议 per CN law | MVP |

### 5.25 Copy-gate amendments (`scripts/check-copy.mjs`)

No existing ban blocks a feature name in this plan: we use "Ready to apply", "Fit score", "Resume check", "Fill this form", "Great fit", "On-site" (hyphenated, so the `onsite` ban does not fire). We keep every current ban. Proposed **additions** (one commit, with reasons as the gate requires):

| Term | Reason |
|---|---|
| `apply for you`, `applies for you`, `we apply` | The product never submits an application (D1) |
| `auto-submit`, `one-click apply` | Implies submission; our action is "Fill this form" |
| `insider` | Implies privileged contacts we don't have; use "People at {company}" |
| `hidden jobs` | Implies secret inventory; use "Recruiter-posted" |
| `guarantee`, `guaranteed` (affirmative only; "no guarantee", "can't guarantee", "cannot guarantee" pass) | No outcome is guaranteed (refund policy, F-TRUST-05) |
| `\bats\b`, `\bjd\b` (word-boundary regexes, so "ATS.", "(ATS)" and a leading "ATS" match while "stats" and "chats" don't) | Extends ruling C8 (`ats-friendly`, `ats-safe` already banned) |
| `\bunlimited\b` and its native equivalents in every locale | Enforces §6.1 rule 3 |
| `not on other job boards` and equivalents | We cannot verify it (F-FEED-04) |
| Per-locale auto-apply wording — ja: 自動応募, 代わりに応募 · ko: 자동 지원, 대신 지원 · es: postulación automática, postulamos por ti · fr: candidature automatique, postule pour vous · pt: candidatura automática, candidatamo-nos por si · de: automatische Bewerbung, bewirbt sich für Sie (zh and zh-TW lists in CN plan §9.1) | English terms never match translated bundles (D1) |
| zh: 北森, 牛客 | Implies affiliation; user copy says "模拟企业常用的 AI 面试形式" |

`BANNED` becomes a list of `{term, locales, regex, reason}`. The gate also scans `i18n/staging/*.en.json` so feature agents hit it before integration. Admin copy is written without the existing bans ("Reports to review", "alert level"), so no admin allow is needed.

---
## 6. Pricing and entitlements

### 6.1 Principles

1. **Public prices.** `/pricing` on both brands shows every price, period, renewal rule, credit cap and refund rule. No price exists only inside the app.
2. **Real numbers only.** "Save 20%" is computed from our own monthly price. No struck-through anchor prices, no comparison prices we have never charged, no ticking countdowns, no "only N left", no competitor names or prices in UI or marketing copy.
3. **Show caps, not "unlimited".** Pro has daily caps that protect us from abuse; we print them ("Up to 50 a day") instead of claiming "Unlimited".
4. **Meter the per-call commodity, give away the moat once** (ruling C42): matching, feed and tracker are free; LLM-heavy actions are metered; the first full practice interview is free.
5. **Credits refill at local midnight** (user's timezone), never roll over, and are debited **only on success** (existing success-only billing). Cancelled or failed actions are not charged.
6. **Brand locks currency and rail.** RoboApply: USD via Stripe (TWD price list V2). GoApply: CNY via Alipay now, WeChat Pay V2. Existing RoboApply users who paid with Alipay keep that rail until their pass ends; it is not offered to new intl users.

### 6.2 Credits and limits (server-configured per brand × plan; admin-editable at `/admin/credits`)

| Credit / limit key | What it meters | RoboApply Free | GoApply 免费版 | Pro / 会员 (both) |
|---|---|---|---|---|
| — | Feed, fit scores and gap lines on cards, filters, search, Explore, tracker, calendar, alerts digest | Free, no cap | Free, no cap | Same |
| `fit_analysis` | Full LLM fit analysis on a job (detail / Assistant) | 10 / day | 10 / day | Up to 200 / day |
| `tailor` | Tailored resume for a job (incl. kit preparation) | 2 / day | 3 / day | Up to 50 / day |
| `cover_letter` | Cover letter generation or regeneration | 2 / day | 2 / day | Up to 50 / day |
| `resume_check` | Full resume check report | 1 / day (first one during onboarding is free) | 1 / day | Up to 20 / day |
| `rewrite` | Inline AI edits (bullet, summary, skills) | 20 / day | 20 / day | Up to 300 / day |
| `outreach` | Outreach / 内推 request drafts | 3 / day | 3 / day | Up to 50 / day |
| `assistant` | Assistant messages (messages that trigger a metered action also spend that credit) | 30 / day | 30 / day | Up to 300 / day |
| `autofill` | Extension form fills (V2) | 5 / day | 5 / day | Up to 100 / day |
| `job_import` | Added-by-you jobs | 10 / day | 10 / day | Up to 50 / day |
| `ready_kits` | Jobs in the Ready to apply weekly list that get a prepared kit | 3 / week | 3 / week | Up to 30 / week |
| `saved_searches` | Saved searches (count) | 1 | 1 | 10 |
| `instant_alerts` | Instant alert emails per day | 1 | 1 (email by default; also in-app and WeChat) | Up to "as they arrive" |
| `practice` | Practice interview credits (1 credit = 20 minutes, existing `RA_MOCK_CREDIT_MINUTES`) | 1 on signup after email verification + 1 for finishing the getting-started checklist | 1 after a verified email **or** a verified phone (D5) + checklist reward | Included per plan (§6.3) + packs |

Free-tool limits for visitors (no account): resume check 3 / day / IP, resume–job match 3 / day / IP (V2). All limits are persisted (not in-memory).

### 6.3 Plans and prices

**RoboApply (USD, Stripe)**

| Plan key | Name | Price | Renewal | Practice credits included | Notes |
|---|---|---|---|---|---|
| `free` | Free | $0 | — | §6.2 | — |
| `pro_weekly` | Pro, billed weekly (renews until you cancel) | **$9.99 / week** (shown with "about $43 a month") | Auto-renews weekly | 1 per week | Never the preselected plan |
| `pro_monthly` | Pro Monthly | **$24.99 / month** | Auto-renews monthly | 3 per month | Default selection |
| `pro_quarterly` | Pro Quarterly | **$59.99 / 3 months** | Auto-renews every 3 months | 3 per month (granted monthly) | "Save 20%" (vs 3 × $24.99 = $74.97) |
| `pro_week_pass` | 7-day pass (no renewal) | **$6.99 once** | Never renews | 1 | — |
| `practice_pack_5` | Practice pack (5) | **$9.99 once** | — | 5 credits, valid 12 months | Any plan |
| `practice_pack_15` | Practice pack (15) | **$24.99 once** | — | 15 credits, valid 12 months | Any plan |
| `student_*` | Student (V2) | 30% off Monthly/Quarterly | as base | as base | Requires verified school email |

TWD price list (V2, Taiwan, Stripe TWD prices; owner sets final values, target parity within 10% of USD): Weekly NT$299, Monthly NT$749, Quarterly NT$1,790, 7-day pass NT$219, packs NT$299 / NT$749. Watch the NT$600k B2C VAT threshold (TW-06).

**GoApply (CNY, Alipay; purchasable by default since D5 and D6, 2026-10-11)**

The amounts below are the plan catalog's defaults (`market/MARKET_STRATEGY.md` §4.2), so no GoApply plan is ever "price not set". Whole yuan, tax-inclusive, one-time, 到期不自动续费. An operator may override an amount with `CN_PRICE_<PLANKEY>_FEN` (whole yuan only) and stop charging with `CN_PAYMENTS_ENABLED=false`; unset means on. Opening a payment needs only the Alipay rail's own credential (`ALIPAY_CALLBACK_SECRET`): until it is set the plans and prices show and no payment can be started, exactly as RoboApply without its Stripe key. *The earlier heading read "switched on only after the operating ICP licence, CN-L-03"; that licence is still the owner's legal track, but the code no longer waits for it.*

| Plan key | Name | Price | Renewal | Practice credits included |
|---|---|---|---|---|
| `free` | 免费版 | ¥0 | — | §6.2 |
| `pro_week_pass` | 会员周卡 | **¥12** | One-time pass, no auto-renew | 1 |
| `pro_monthly` | 会员月卡 | **¥39** | One-time 30-day pass, renewal reminder 3 days before expiry | 3 |
| `pro_quarterly` | 会员季卡 | **¥99** (省 15% vs 3 × ¥39) | One-time 90-day pass | 3 per month |
| `practice_pack_5` | 面试练习包 5 次 | **¥29** | — | 5 |
| `practice_pack_15` | 面试练习包 15 次 | **¥79** | — | 15 |
| `student_monthly` (verified students) | 学生月卡 | **¥29** | One-time 30-day pass | 3 |
| `student_quarterly` (verified students) | 学生季卡 | **¥69** | One-time 90-day pass | 3 per month |

What follows from the rail and stays different from RoboApply: passes do not renew, there are no promotion codes, no failed-renewal banner and no TWD line. `pro_weekly` is not defined for GoApply by design (an auto-renewing plan; the weekly product is `pro_week_pass`). Capability is equal: every paid row unlocks the same Pro column of §6.2 for the time it is live.

**RoboApply prices under D6.** The USD ladder above is reviewed per market in `market/MARKET_STRATEGY.md` §4.1, which proposes $54.99 for the quarter and $9.99 for the 7-day pass and gives its reasons. Those values and the catalog defaults for RoboApply are applied in the market wave, not in the parity wave; until then this table is what the code sells.

Internal pricing anchors (never shown in UI or marketing; competitor prices change): 超级简历 about ¥39/month; 职悟空 free; Jobright $17.99 / $39.99 / $89.99 as of 2026-10. RoboApply Pro Monthly ($24.99) is 37.5% below Jobright Turbo monthly ($39.99); GoApply 月卡 matches the local membership anchor while the free tier stays generous.

**Checkout acknowledgements (RoboApply):** every auto-renewing plan needs an unticked box "I agree this renews automatically every {period} at {price} until I cancel" (stored as a consent record for 3 years); EU/UK/TW checkouts add the withdrawal-waiver box (F-BILL-08). Subscriptions running over 12 months get an annual reminder.

**Folding in the existing mock-interview plans** (`server/src/lib/mockInterviewPlans.ts`: `free` 1 credit, `starter` 10 credits $15/¥19, `growth` 28 credits $29/¥45):
- `starter` and `growth` stop being sold on launch day. Existing subscribers keep their plan, price and monthly credits unchanged, shown as "Practice plan (legacy)". They get Free-tier limits for everything else, plus "Switch to Pro": a confirmation sheet shows the amount charged today (Stripe proration), the new renewal price and the next renewal date, and nothing is charged until `Confirm`. No forced migration; any later change follows the price-change notice in our terms (30 days).
- The credit ledger, `gateMockInterview` and `debitForSession` stay the single source of truth for practice credits; Pro grants credits through `grantForPlan`.
- `SeekerSubscriptionTier` gains `pro` (additive enum change; foundation wave, owner confirms the push). Plan period (`week`, `month`, `quarter`, `pass`) is a separate field.

### 6.4 Upsell moments (allowed list; nothing else ships)

| Moment | What the user sees | Rules |
|---|---|---|
| Credit runs out | Sheet with three equal options: `Get Pro` · `Wait until {local time} tomorrow` · `Continue without it` (e.g. apply with the current resume) | Never blocks a non-metered action |
| Welcome price (**not shipped at launch**; owner option OPS-B1) | If enabled: "7-day pass: {price} for your first one", **no comparison price**, ending 7 days after signup and shown as a date; "instead of {price}" may appear only after that price has been charged for 30 days | Plan badge and `/pricing` only; one-time; no popup, no ticking timer |
| Second saved search, Pro-only frequency, >3 kits a week | Inline note at the control: "Pro includes up to 10 saved searches." + `See Pro` | Inline only |
| Practice report end | "Practice again for this job" uses a credit; if none: packs or Pro | One line, below the report |
| Monthly subscriber after 30 days | One dismissible suggestion to switch to Quarterly with the real saving | Once, ever |
| Cancel | Primary `Cancel subscription` button (completes in one click); secondary link "Switch to the 7-day pass instead?", shown once | Cancel is never hidden; no mandatory survey; confirmation email; also possible without signing in at `/cancel` |

Not allowed: countdown banners, fake scarcity, retention popups for active subscribers, AI-personalized offer copy, pre-checked add-ons, trials that need a card and auto-convert.

### 6.5 Renewal and billing hygiene

- Renewal reminder email **5 days before** every auto-renewal of monthly/quarterly plans and **2 days before** weekly ones (existing `RoboApplyBillingReminderService`, now brand-aware); delivery logged.
- One-click cancel in Settings and at the public `/cancel` page; access continues to the period end.
- Payment failed: banner + email, 3 automatic retries over 7 days (Stripe), features drop to Free after the last retry, credits already granted are kept.
- Receipts and invoice history per brand (existing history endpoint, brand-aware branding).

---

## 7. Notifications and lifecycle messages

### 7.1 Channels per brand

| Channel | RoboApply | GoApply |
|---|---|---|
| Email | Resend, per-brand From (`RoboApply <hello@…roboapply.io>`), per-brand templates in 9 locales | **D5:** on by default through the shared transport, sender name GoApply (verification, password reset, alerts, lifecycle mail); a domestic sender (e.g. Aliyun DirectMail) or a verified `goapply.top` address is an optional override |
| In-app inbox (`/inbox`) | Source of truth for every alert, reminder and notice | Same |
| Web push | V2 (alerts, reminders) | **D5:** = RoboApply |
| WeChat | — | An additional GoApply channel (it adds to email and web push, it does not replace them). V2: subscribe messages for 网申截止 and practice reminders (collected at "remind me" taps); service-account template messages for users who follow the 公众号 |
| SMS | None | OTP only, no links |

Global rules: at most **one lifecycle (non-alert, non-transactional) message per user per day**; alerts respect the user's frequency; quiet hours 21:00–08:00 local for anything non-transactional; every non-transactional email has one-click unsubscribe (RFC 8058 headers) and no emoji subject; lifecycle emails need no marketing consent only when they are about the user's own account activity (verification, finish setup, resume check ready, follow-up and interview reminders, Ready-to-apply list); **promotional nudges (§7.3 rows 5, 6 and 10, and the former Friday practice nudge) sit under one "Tips and reminders" preference — default off for EEA/UK/CH/CA visitors and GoApply, on elsewhere** (ePrivacy, CASL, PRC Advertising Law Art. 43); product news needs the opt-in.

### 7.2 Job alerts

| Alert | Trigger | Content | Free / Pro |
|---|---|---|---|
| Instant | New jobs at Good fit or better for a saved search, checked after each hourly ingest | Up to 5 jobs: title, company, place, pay or "Pay not listed", tier, gap line; deep link `/jobs/[id]?from=alert` | 1/day / up to as-they-arrive |
| Daily digest (chosen at O7; Daily preselected) | 08:00 local, if ≥1 new fit since the last digest | Top 10 new fits + count of others; "{N} new jobs fit your search since yesterday" (real count) | Free |
| Weekly digest | Monday 08:00 local | Top 15 + tracker summary ("2 applications have had no reply for 10 days") | Free |
| cn 网申截止提醒 | 3 days and 1 day before a saved calendar programme closes | Company, programme, close time, official link | Free |
| cn new programme | A followed company opens a programme matching 届别 | Programme + dates | Free |

Never sent: alerts with zero jobs, "you're missing out" alerts, alerts for jobs the user marked Not interested or already tracked.

### 7.3 Lifecycle and transactional sequence

| # | Message | When | Brand notes |
|---|---|---|---|
| 1 | Verify your email | At email/password signup; resend once after 24 h if unverified | intl |
| 2 | Welcome | Right after onboarding completes (or 1 h after signup if not completed): the 3 things to do first, each linking into the product | both (cn in-app) |
| 3 | Finish setup | 24 h after signup if stage < `resume`; once | both |
| 4 | Your resume check | When the onboarding resume check is ready and unopened after 24 h; once | both |
| 5 | First tailored resume nudge ("Tips and reminders") | Day 3 if no tailored resume yet: names the user's top-fit job | both |
| 6 | Practice interview nudge ("Tips and reminders"; replaces the old Friday nudge) | Day 5 if no practice yet and the free credit is unused | both |
| 7 | Follow-up reminders | 10 days after "applied" with no status change (respects `followUpAt`) | both |
| 8 | Interview date reminder | 24 h before an interview date in the tracker; links to "Practice for this job" | both |
| 9 | Ready-to-apply list ready | Monday when the weekly list is generated (if Ready to apply is set up) | both |
| 10 | Re-engagement ("Tips and reminders") | 14 and 30 days inactive: "{N} new jobs fit your search since {date}" with real N; stops after 2 unanswered sends; never sent if N < 3 | intl email; cn in-app/WeChat |
| 11 | Renewal reminder, receipt, payment failed, cancellation confirmation | Billing events | both (cn: pass-expiry reminder) |
| 12 | Password reset, new-device sign-in, account deletion confirmation, data export ready | Security events | both |
| 13 | Referral reward granted | V2 | both |

Templates are per brand and locale; links use the brand's canonical host; product name comes from the brand registry.

---

## 8. Success metrics and staged depth

### 8.1 Metrics (first-party events only)

**North-star:** weekly **prepared applications** — jobs a user marked applied this week that had a tailored resume or a kit. It captures the loop (find → understand → fix → apply) and rewards quality over volume.

| Area | Metric | MVP target (first 60 days) |
|---|---|---|
| Activation | Signup → onboarding `done` | ≥ 65% (intl), ≥ 55% (cn, longer flow) |
| Activation | Time from signup to first ranked feed | p50 ≤ 3 min |
| Activation | Users who tailor a resume within 24 h | ≥ 25% |
| Feed quality | Average feed rating (0–10) | ≥ 7.0; "Not interested" on < 25% of viewed cards |
| Feed quality | Feeds with ≥ 20 Good-fit-or-better jobs for the saved search | ≥ 80% of active users (intl) |
| Inventory | Live jobs indexed; median job age; share of jobs listing pay | ≥ 50k live intl jobs; median age ≤ 10 days; pay shown honestly (tracked, no target) |
| Engagement | Weekly active users who open ≥ 1 job | D7 retention ≥ 30%, D30 ≥ 15% |
| Loop | Jobs moving Saved → Tailored → Practiced → Applied | Tracked per job; ≥ 10% of applied jobs were practiced |
| Practice (Wave 0 dependency) | Practice sessions that connect and finish; sessions failing to connect | ≥ 90% finish; < 2% connection failures |
| Assistant | Answers with thumbs-down; filter diffs applied | < 15% thumbs-down; ≥ 40% of proposed diffs applied |
| Alerts | Alert email click-through; unsubscribe rate | ≥ 8% CTR; < 0.5% per send |
| Monetization | Free → paid within 30 days | 3–5% (intl); cn measured from the first Alipay order (plans are on sale by default, D5 / D6) |
| Trust | Refund rate; chargebacks; scam reports per 1k job views | < 3%; < 0.3%; tracked with admin SLA 48 h |
| Honesty | Tailored exports with unverified inserted claims | 0 (blocked by design; monitored) |

### 8.2 MVP vs full depth by area

"No dead ends" rule: any nav item, button or route that ships in a release works end to end in that release. Deferred features have **no UI entry** (no "coming soon" teasers), except the cn feed flag described in §5.3.

| Area | MVP (release 1) | V2 (parity) | Later |
|---|---|---|---|
| Brand | Host-based brand, registry, tokens, names, metadata, legal footers, per-brand email From, CORS, cookies, locale clamp, cross-brand notices | — | Separate mainland deployment for GoApply (CN-E-01) |
| Auth | Email/password, reset, verification (both brands, D5); Google (intl); phone OTP (cn, an additional method once the SMS signature exists) | LINE (TW), WeChat (cn), TOTP 2FA | Apple (with native apps) |
| Onboarding | All screens §4 both brands | Guided resume builder for intl | — |
| Inventory | Scheduled ingest (providers + RoboHire bank), per-job extraction, archive; cn: public employer boards (mainland postings) + GoHire bank (listed once it has a posting page) + calendar curation + imports | More providers by country; DOL sponsorship data prep | Licensed company data |
| Feed and detail | `/jobs` For you / Explore / Added by you, server filters, saved searches, sorts, cards, detail page, Not interested, Report, zero results, calibration | Visitor feed, public job pages, SEO | — |
| Fit scoring | Published 5-component score with evidence, tiers, Keyword check, LLM fit analysis | "You and what employers ask" report | — |
| Assistant | Drawer + full page, threads, job actions, filter diffs, sort, advice | Voice input, company cards, cn long-term memory | Visitor assistant |
| Resume | Hub, editor, tailor from any job with mandatory verification, resume check, export with file record | Templates polish, fit to page, from-scratch builder (cn in MVP) | LinkedIn profile report (only with an official source) |
| Cover letters | Generator + editor | — | — |
| Ready to apply | Setup, weekly list, kits, review, Open application (moves to Applied with Undo) | Extension fill, and "Did you submit?" asked in the extension (the user says so) | — |
| People | LinkedIn deep links, outreach drafts | Own-connections CSV import, opted-in RoboHire hiring contacts, cn 内推码 hub | Email finder (licensed), Send my profile, employer invitations |
| Applications | Saved/applied capture, By stage / By date / List, drawer, reminders, cn stages | Offer comparison | — |
| Interview prep | Practice for this job, first practice free (Wave 0 reliability), recording only with consent | Practice questions bank, cn AI面试 format (on the shared voice stack by default, D5) | Coding runner, cn 笔试/测评 sets |
| Coaching | — (hidden) | Admin roster + booking links | Paid booking, group sessions |
| Extension | — | RoboApply for Chrome; cn 一键填表 (entry and page on GoApply under the same gates, D5) | — |
| Notifications | Inbox, instant/daily/weekly alerts, lifecycle emails §7, reminders, unsubscribe | Web push, WeChat subscribe messages, announcements | Native push |
| Billing | Credits service, public pricing, Pro plans, 7-day pass, packs, legacy plan fold-in, renewal reminders, one-click cancel; cn: the same, with CNY passes purchasable through Alipay by default (D5, D6) | TWD, student (both brands), coupons, WeChat Pay | iOS mini-program IAP |
| Growth / SEO | Attribution, checklist reward, per-host robots/sitemap/llms.txt, free resume check | Invite friends, tools, programmatic browse pages | Compare pages, blog, GitHub lists |
| Trust | DB rate limits, report + admin review, disclaimers, privacy/terms per brand, retention schedule, analytics consent (EEA/UK/CH), age 16+, `/cancel`, help | Bot protection on public pages | — |

### 8.3 Dependencies and order (product view)

1. **Wave 0 (running, D4):** live interview fixes + LLM provider fallback. MVP's "Practice for this job" and "first practice free" ship only on top of it.
2. **Foundation:** brand registry and resolution, schema (brand on users, onboarding stage/answers, credits/entitlements, job extraction fields, saved searches, kits, assistant threads, inbox items, calendar entries, coach roster), mounted stub routers, route shells and nav per §3, credit keys and plan keys per §6, i18n staging convention.
3. **Inventory before feed:** the scheduled ingest and per-job extraction must land before the feed and onboarding O6 can meet their targets.
4. **Feed and fit scoring before Ready to apply and alerts** (both consume the ranked saved-search results).
5. **Delete the dead V1 engine** only after moving the interview reconciler off the `/digest` and `/catchup` crons and repointing the account-wipe dependency (ruling C27).

---

## 9. Cross-cutting product rules

### 9.1 Supervised application (D1), in UI terms

- Allowed verbs on buttons: Prepare, Tailor, Write, Fill this form, Open application, Apply on company site, I applied. `Open application` and `Apply on company site` move the job to Applied at once with an inline Undo.
- Never: Apply for me, Auto-apply, Submit for me, Send application (unless the user is on the employer's own form).
- The extension never clicks a submit, next-page-that-submits, or confirmation button. It stops at a filled form and says "Check the form, then submit it yourself."
- Ready to apply never contacts an employer, recruiter or contact.
- The extension never watches or detects submits on employer pages; "submitted" is only what the user tells us. AI-written answers stay in the side panel until the user approves each one for its field.

### 9.2 Verified tailoring

Every claim, number, skill or keyword the AI inserts into a resume or cover letter that is not already in the base resume is listed in **Verify details**. Export, attach-to-kit and extension upload are blocked until each is `Keep`, `Remove` or edited (ruling C12 copy: "One line has a number we couldn't find on your resume. Fix it or remove it before you download.").

### 9.3 Number provenance (every number on screen)

| Number | Source | Display rule |
|---|---|---|
| Jobs that fit (feed, O7, alerts, re-engagement) | Count over the user's ranked saved-search results at Good fit or better | Real count; "0" only after the query completes |
| Open roles snapshot (O2, G4) | `RAJob` public, canonical, live rows of the brand's market matching title × place, last 30 days (users' imported jobs never count) | Show N; pay median only when ≥ 20 rows list pay in one currency and period ("Pay listed on {X} of {N} posts"); skills only when N ≥ 20 |
| Pay | Posting or provider fields | Currency + period from source; else "Pay not listed" / "薪资未披露" |
| Fit score and components | Scoring service with stored evidence | Score + tier + "This is not your chance of getting hired." |
| "Asked for in X of Y posts" | Per-job extraction aggregated over the saved search | Show X and Y |
| Applicant count | — | Never shown (F-FEED-08 SKIP) |
| Company size / industry | Provider field, named | Otherwise not shown |
| Marketing counters ("{n} jobs added this week", hero "{count} open roles") | Public, canonical, live `RAJob` count, cached hourly | Rounded down to 2 significant figures; never a static number (the hero drops the clause below 1,000); no user counts until we choose to publish real ones |
| Job ticker | `firstSeenAt` and `postedAt` of `publicDisplay` jobs | "Found {n} min ago · posted {date}"; posted date omitted when estimated |
| Assistant numbers | Tool results or the user's text | A sentence with any other number is removed and replaced with "No source found for that number." |
| Practice report scores | Interview Engine report | As today, with question wording per ruling C16 |
| Credits left | Credit service | Exact |
| Calendar dates (cn) | Admin-curated entry with official source URL and last-verified date | "待核实" after 14 days without re-verification |
| Savings % on pricing | Our own prices | Computed, rounded down |

### 9.4 Data minimization per market

- intl: EEO answers (US only) stored separately, used only by the extension, never sent to an LLM. Sponsorship need is used for ranking and badge visibility only.
- cn: photo, 籍贯, 政治面貌, birth date, gender and family members are optional, never ranking inputs, and **never enter any prompt**: when the user generates a document that includes them, the export renderer places them after the model runs. School tier is display and user filter only. In CN-0 no photo or original upload is stored.
- Both: only one context builder (`profileSnapshotForLlm()`) feeds models, and it excludes everything above. On GoApply every AI feature needs the "Use AI" consent; with it off, scores fall back to the "Quick estimate" and nothing is sent to a model.
- Both: the user can export and delete everything from Settings.

---

## 10. Open items for the owner (not blocking MVP code)

| # | Item | Plan default until decided |
|---|---|---|
| O-1 | GoApply licensing path (D-03): GoHire's licensed entity vs new entity vs seeker-tools-only | **Changed by D5 (2026-10-11):** the job feed ships **on**, with a source line on every posting and no licence line unless the licence values are set. `CN_RECRUITMENT_INFO_MODE=off` gives the seeker-tools-only mode if the owner or counsel wants it |
| O-2 | GoApply hosting (HK standalone build vs mainland + ICP) and data residency (shared DB vs separate cn DB, CN-E-01) | One codebase; cn data path built behind brand-scoped config so it can move |
| O-3 | People-data provider for email lookup (D-04) | None; deep links + own-connections import |
| O-4 | AI labels on cn exports (D-08) | Visible "AI 辅助生成" marker in app; metadata in exported files; counsel to confirm |
| O-5 | Final TWD prices and whether to add ECPay/TapPay | USD in MVP; TWD via Stripe in V2 |
| O-6 | RoboHire candidate-intake API for "Send my profile" and employer invitations | Deferred (Later) |
| O-7 | LINE Login channel and WeChat Open Platform verification | Buttons hidden until configured (additional sign-in methods; email + password works on both brands without them) |
| O-9 | (D5) What GoApply still needs from the owner: the Alipay credential, optional mainland providers, three legal notes (cross-border processing, camera video, launch scope), a posting page in the GoHire product, listings, Google sign-in on GoApply | `GOAPPLY_PARITY_PLAN.md` §8. GoApply functions without any of them |
| O-8 | Copy-gate additions in §5.25 | Proposed; feature agents follow them anyway |
