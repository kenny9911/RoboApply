# Jobright.ai Clone: Canonical Feature Catalog and Onboarding Spec

**Status:** canonical synthesis, deduplicated from 8 research files. **Compiled:** 2026-10-09. **Critic pass:** 2026-10-09. Additions are marked "critic pass" inline and summarised at the end of this document.
**Purpose:** a single source of truth for cloning Jobright.ai into RoboApply. It covers two brands: **RoboHire.io** (international market, which includes Taiwan) and **GoApply.Top** (mainland China).
**Copy policy:** all prose is paraphrased. Short functional UI labels (button text, tab names, enum values, field names) are kept verbatim inside backticks, because they are interface facts and not marketing copy. Do not lift Jobright marketing sentences into our product.

---

## 0. How to read this document

### 0.1 Confidence legend

| Tag | Meaning |
|---|---|
| **C** (confirmed) | Seen in a Jobright primary source: a live page, the sitemap or robots.txt, the public Next.js build manifest and JS chunks (build `GQd0ykV_IrfhtmCjLOY2m`, 2026-10-09), a store listing, or Jobright's own blog or press release. |
| **L** (likely) | Two or more independent secondary sources agree (most are competitor-written reviews, so they are used for observed facts only). |
| **I** (inferred) | Reasoning from evidence. Validate before relying on it. |

### 0.2 Evidence keys

Research notes are in `docs/jobright-clone/research/`:

| Key | File | Angle |
|---|---|---|
| [PS] | `product-surface.md` | Site map, route inventory, app IA |
| [ON] | `onboarding.md` | Signup, onboarding stage machine, profile, settings |
| [MJ] | `matching-jobs.md` | Feed, card, match score, detail, filters, feedback, ranking |
| [OAE] | `orion-agent-extension.md` | Orion, Agent, Chrome extension, mobile |
| [RS] | `resume-suite.md` | Resume analysis, tailoring, editor, cover letter, LinkedIn report |
| [NTI] | `network-tracker-interview.md` | Insider connections, tracker, interview bank, voice chat, coaching |
| [BGS] | `business-growth-seo.md` | Pricing, growth loops, SEO, company facts |
| [CN] | `china-market.md` | GoApply.Top requirements, Taiwan notes |

These primary URLs are cited often:
- Build manifest: https://static.jobright.ai/_next/static/GQd0ykV_IrfhtmCjLOY2m/_buildManifest.js
- JS chunks: `https://static.jobright.ai/_next/static/chunks/<file>`. File names are in the research notes. The ones cited most are `_app-ff4b18b98295f6d5.js`, `10344-7630c6c855467801.js` (app shell, Orion), `pages/agent-70b6a9ee45390efe.js`, `79590-…` (filters), `12523-…` (card) and `39128-…` (tailor/Easy Apply).
- Sitemap: https://jobright.ai/sitemap.xml ; robots: https://jobright.ai/robots.txt
- Stores: Chrome `odcnpipkhjegpefkfplmedhmkmmhmoko`, iOS `id6738236788`, Android `ai.jobright.orion`.

### 0.3 Feature ID scheme

`F-<AREA>-<NN>`. Areas: MKT, ONB, FEED, MATCH, JOB, FILT, ORION, AGENT, RES, CL, NET, TRK, INT, COACH, SAL, NOTIF, EXT, MOB, ACCT, BILL, TOOL, SEO, GROW, TRUST, B2B (reference only). Onboarding screens use `S0`–`S12`. China and Taiwan requirements use `CN-*` and `TW-*`.

Each feature entry gives **What** (description), **Flow**, **UI** (anatomy), **Data**, **Gate** (Free vs Turbo), **Conf** (confidence) and **Ev** (evidence).

---

## 1. Product overview and positioning

**What Jobright is.** A U.S.-focused, consumer AI job-search copilot. It is one Next.js (Pages Router) app that serves the marketing site, programmatic SEO pages and the logged-in web app. Jobright Inc. is in Santa Clara and was founded in 2023. It has raised $7.7M ($4.5M seed in 2023; $3.2M in Jun 2025 with Indeed's venture arm). It claims 3M users (Oct 2026) and gets about 4.1–4.5M visits a month. [BGS] C/L

**Company facts (critic pass, 2026-10-09):**
- **Entity and address.** Jobright Inc. is a Delaware corporation. Its complaints and notices address is 3120 Scott Blvd, Santa Clara, CA 95054. Disputes go to arbitration, with Santa Clara County courts as the fallback venue. C (ToS text in the `legal/service` page bundle).
- **Founders.** Eric (Yuan) Cheng is CEO; he was an early Box employee and is a serial founder. Ethan (Yudian) Zheng, PhD, is CTO and former AI lead at Twitter and NewsBreak. C (Chrome Web Store listing; The Register, 2025-06-24).
- **Funding detail.** Translink Capital **led** the Jun 2025 $3.2M round. HR Tech Investments (Indeed's venture arm) participated. C (The Register).
- **AI stack.** The privacy notice names OpenAI, Anthropic, Google Cloud AI and AWS AI as AI service providers. In 2025 the company said it runs on AWS and fine-tunes Llama-based models for resume and matching tasks. C (privacy page bundle; The Register).
- **Store copy lags the homepage.** The iOS, Android and Chrome listings still say "500K+" users; the homepage says 3M. Treat every user count as a marketing claim. C.
- **Headcount and revenue (unverified).** Revelio Labs estimates about 69 employees (Mar 2026). An arr.club post claims $7M ARR with fewer than 10 employees. The two conflict, so neither is reliable. L/I.

**Core promise (paraphrased).** You should not have to job-hunt alone. Jobright finds roles that fit you, explains why they fit, rewrites your resume for each role, finds insiders who can refer you, and fills in the application form. A named AI persona, **Orion**, delivers all of this. [PS §4.4] C

**The core loop to clone:**
1. **Onboard** in about 4–5 minutes: seeker type, role and location preferences, resume or LinkedIn URL, then an animated "matching" loader.
2. **Ranked feed** with a % match score per job, reason tags, filters, saved filters and feedback that rewrites filters.
3. **Job detail** with a score breakdown and a right rail of three free boosts: tailor resume, get a referral, autofill.
4. **Act**: tailored resume diff, then cover letter, then insider outreach, then apply. Apply happens by autofill extension, server-side Easy Apply or the external site, followed by a "Did you apply?" capture.
5. **Track**: Liked, Applied (5 statuses) and External imports.
6. **Escalate**: Agent (auto-apply queue), interview bank, human coaching.
7. **Monetize**: credits that refill daily, one paid tier ("Turbo"), add-on passes and sessions, and aggressive countdown offers.

**Positioning against competitors.** Jobright frames itself as an "AI copilot" against "autofill-only" tools (Simplify) and "tracker-only" tools (Teal, Huntr). It differentiates on match quality, insider referrals and email finder, H1B sponsorship data, and breadth (agent, coaching, interview bank). It does not compete on price: its ladder of $17.99/wk, $39.99/mo and $89.99/qtr is the same as Simplify+. [BGS §12] L

**Brand and persona.** Orion speaks in the first person, warm and short, and uses emoji sparingly. The visual style is a pale lime/mint background, black display type, black pill CTAs and Inter, built on Ant Design-like components. Marketing uses many unverified multipliers such as 3x, 4x and 80%. [PS §14] C

**Markets.** U.S.-only inventory and English-only UI (no hreflang). The 2026 code adds CA, GB, AU, IE and NZ to the country picker, but the stores still say U.S.-only. Jobright has no China, Taiwan or EU product. [BGS §10, MJ §10] C

**Clone stance for RoboApply (I).** Clone the loop and its surfaces, and fix Jobright's known trust failures:
- No fake "Expires in N hrs" chips and no hardcoded inventory counters [MJ §6.1].
- A public pricing page, renewal reminders that are actually sent, and one-click cancel [BGS §4.3]. (Correction: Jobright's own Terms of Sale *promise* a pre-renewal reminder with cancel instructions. The trust failure is billing execution and hidden pricing, not a missing policy.)
- Grounded tailoring with per-claim verification [RS §13].
- An explainable match score [RS §6.1].
- Reminders and notes in the tracker [NTI §3.2].
- LLM outreach drafts instead of static templates [NTI §2.6].

---

## 2. Information architecture

### 2.1 Hosts and rewrites [PS §1, §3.5] C

| Host / path | Purpose |
|---|---|
| `jobright.ai` | Marketing site, SEO pages and app, in one Next.js app |
| `jobright.ai/blog/` | WordPress blog (Yoast sitemaps) |
| `business.jobright.ai` | Employer product (AI recruiter) |
| `/remote-jobs/*` | Separate remote-jobs minisite, reached through a rewrite |
| `/swan/*` | Backend REST API (rewrite) |
| `/orion/*` | Orion service (rewrite) |
| `/foxit/*` | PDF-to-DOCX conversion for Word export |
| `/jobs/email-list/:id` | Rewrite to `/jobs/recommend?id=:id`, used by email deep links |

### 2.2 Marketing site map [PS §3–4, BGS §8] C

**Global header:**
- Logo.
- A segmented toggle between `Job seekers` and `Employers`.
- Employer links: `Pricing`, `Customer Stories`, `FAQ`.
- A Features menu with `AI Agent` and `Resume AI`.
- `SIGN IN` and `JOIN NOW` buttons.
- Trust badges: Product Hunt, "featured by OpenAI", Trustpilot.
- There is **no job-seeker pricing link**.

**Global footer:**
- Features: Resume AI, AI Job Match, Insider Connections, Orion, Job Autofill, H1B Jobs, TNT, Interview Questions.
- Blog picks.
- Related Tools.
- Information: About, Privacy, Terms, Partners.
- Social links: LinkedIn, IG, TikTok, X, YouTube, FB.
- An optional job search widget with fields Job Title, Work Model, Country, City and Experience Level, plus a `GO` button.
- A "Popular Job Lists" block with 10 rotating role-in-city links.

**Page inventory:**

| Group | Routes |
|---|---|
| Home | `/` (A/B tested hero and FAQ sets) |
| Feature landings | `/ai-job-match`, `/ai-resume-builder`, `/ats-resume-builder`, `/ats-resume-checker`, `/job-autofill`, `/job-referral`, `/orion-copilot`, `/ai-agent`, `/h1b-jobs`, `/tnt`, `/coach-landing`, `/interview-landing` |
| Employer | `/employers`, `/employers/pricing`, `/employer-v1`, `/employer-signup` (redirects to business.jobright.ai), `/fake-candidate-detection` |
| Company / trust | `/about`, `/partners`, `/security`, `/mobile-app` |
| Competitor compare | `/compare/{aiapply, careerflow, huntr, jobcopilot, jobscan, lazyapply, loopcv, scale-jobs, simplify, sonara, teal}` |
| Campaign / segment lists | `/entry-level-jobs`, `/intern-jobs`, `/new-grad-jobs`, `/top-jobs`, `/SWE-intern(-video)`, `/engineering-intern(-video)`, `/data-science`, `/marketing-jobs`, `/remote-jobs-usa` |
| Remote minisite | `/remote-jobs`, `/remote-jobs/{category}[/{role}]`, `/minisites-jobs/[...slug]` |
| SEO job pages | `/jobs/[visit]` (taxonomy, role×city and keyword slugs), `/jobs/info/[id]` (job detail), `/role/[id]` (legacy), `/interview/[companyId]`, `/interview_tip` |
| Free tools | `/tools` plus about 20 `/tools/*` pages (see F-TOOL) |
| Legal / policy | `/legal/{service, privacy, cookie-policy, refund, sales}`, `/referral-policy`, `/coaching-policy` |
| Blog | `/blog/*`: about 211–247 posts in 12 categories |

**Shared landing template** (about 30 pages): hero with a "…for FREE" CTA → 3-stat strip → 3 alternating feature blocks → jobs-count strip → testimonial carousel → 4-step how-it-works → FAQ accordion (FAQPage JSON-LD on some) → closing CTA → footer. Every CTA goes to `/onboarding-v3/signup?from=<page>`. [PS §4.3] C

### 2.3 Logged-in app navigation [PS §10.1, MJ §2, NTI §1, ON §11.3] C

**Desktop left sidebar, top group:**

| Label | Route | Notes |
|---|---|---|
| `Jobs` | `/jobs/recommend` | Count badge such as "1000+" |
| `Resume` | `/jobs/resume` | |
| `Profile` | `/jobs/profile` | |
| `Agent` | `/agent` | |
| `Coaching` | `/coaching` | Added 2026 |
| `Interview` | `/interview` | Badge "new"; added 2026 |
| `Explore` (Beta) | `/jobs/explore` | |
| `Messages` | (inbox) | Employer interview invitations (F-NET-09) |

**Desktop left sidebar, lower group:**
- `Refer & Earn` / `Invite Friends`
- `Download App`
- `Feedback`
- `Settings` → `/settings`
- A plan badge (`Free Plan` / `Turbo Plan`) with a `Get Unlimited Credits` upsell
- **Message center button with an unread dot** (critic pass). It opens a message drawer backed by `/swan/msg/{has-unread, list, read}`, and a message can be deep-opened by id (`messageCenterDefaultMessageId`). Employer invitation replies use `/swan/business/candidate/response/get`. C (chunk `10344`, CSS module `message-center-has-unread-dot`).

**Floating elements:**
- Orion chat drawer (`Open Orion` / `Close Orion`).
- The "Smart Job Autofill" promo card.
- Countdown offer banners.
- The Agent "Application progress" widget.

**Mobile web:**
- Bottom nav: `Jobs` · `Profile` · `Resume` · `Interview`.
- A smart "Install" banner.
- Job detail opens in a drawer.
- Some features are blocked with a "visit on PC" notice (F-MOB-04).

**Visitor (logged-out) shell.** The same shell with Jobs, Resume, Profile, Agent, Coaching and Interview. Actions are gated to signup.

### 2.4 Logged-in route table [PS §3.3–3.4] C

| Route | Screen |
|---|---|
| `/jobs/recommend` (`?id=`) | Feed, Recommended / "For you" tab, and in-place detail |
| `/jobs/liked` · `/jobs/applied` · `/jobs/external` | Tracker tabs |
| `/jobs/explore` | Category browse |
| `/jobs/info/[id]` | Job detail (public, personalized when logged in) |
| `/jobs/profile` | Profile and completion wizard |
| `/jobs/resume` · `/jobs/resume/edit/[id]` | Resume hub and editor |
| `/agent` | Agent setup and run queue |
| `/coaching` · `/coaching/discover` · `/coaching/bookings` | Human coaching |
| `/interview` · `/interview/[companyId]` | Question bank |
| `/voice-chat` | "AI Interviewer" voice intake |
| `/settings` | Settings |
| `/matching` | Post-onboarding loader |
| `/candidate-preferences` | Magic-link preferences page for passive candidates |
| `/autofill/uninstall` | Extension exit survey |
| `/return` | Payment return |
| `/onboarding-v3/{signup, mode-selection, diagnostics, career-goals, advanced-preferences, resume-upload}` | Onboarding |
| `/auth/callback/{email,linkedin}`, `/linkedin-verification/callback`, `/email-verification`, `/verify-email/[code]`, `/verify-referral/[code]`, `/work-email-verify`, `/reset-password` | Auth and verification |
| `/component-preview`, `/monitoring`, `/robots_prod.txt` | Internal (critic pass): a component preview page, a monitoring route (probably the Sentry tunnel, I) and the production robots file. Not product surfaces. C (build manifest) |
| `/jobs/search` | Route constant in the `main` bundle with no page in the build manifest. Probably legacy or rewritten to `/jobs/[visit]` (I) |

---

## 3. Onboarding spec

### 3.1 Architecture: a stage machine driven by the server [ON §2] C

The server stores onboarding progress as a numeric `currentStage`. After auth, the client reads the stage and routes the user. Any entry point (an email link, a job-detail apply, the mobile app or a referral link) therefore resumes at the right step, and A/B tests can reorder steps without a client release.

| Code | Enum | Route |
|---|---|---|
| 0 | — | `/` |
| 1 | `NO_FILTER` | mode-selection |
| 10 | `NO_RESUME` | mode-selection |
| 21 | `RESUME_PARSING` | `/matching` |
| 30 | `FILTE_RESUME_READY` | `/jobs/recommend` |
| 40 | `FAILED_RESUME` | resume fix / upload |
| 41 | `FAILED_WITHOUT_FILTER` | `/jobs/recommend` |
| 50 | `V3_TO_SEEKER_TYPE` | mode-selection |
| 51 | `V3_RUSH_TO_BASIC_PREF` | diagnostics |
| 52 | `V3_NO_RUSH_TO_BASIC_PREF` | diagnostics |
| 53 | `V3_TO_CAREER_GOAL` | career-goals |
| 54 | `V3_TO_ADVANCED_PREF` | advanced-preferences |
| 55 | `V3_RUSH_TO_RESUME` | resume-upload |
| 56 | `V3_NOT_RUSH_TO_RESUME` | resume-upload |

API endpoints (C):
- `/swan/landing/{seeker-type, basic/titles, basic/pref, career-goal, advanced/pref, pref/get, job/diagnostic, oneline/parse}`
- `/swan/recommend/landing/jobs`
- `/swan/resume/linkedin`
- `/swan/lensa/{decode,save}`, a partner-traffic import (I)

**Clone requirement (F-ONB-01).** Add `onboardingStage` to the seeker record, together with `brand` and `market`. Keep a client route table, and make every step idempotent and resumable.

### 3.2 Entry points and attribution (F-ONB-02) [ON §3] C

- Every surface links to `/onboarding-v3/signup?from=<source>`.
- **Observed `from` values:**
  - Feature landings: `homepage`, `jobmatching`, `jobmatching-orion-analysis`, `agent`, `copilot`, `connect`, `job-autofill`, `resume_landing`.
  - Tools: `ai-job-assistant`, `job-tracker`, `cover-letter-generator`, and 12 `resume-*` tool sources.
  - Job detail: `job_detail&action=apply&id=<jobId>` (optional `tob=true`, `banner=false`).
- **Other parameters:**
  - `inviter_id` / `inviteCode`: referral.
  - `retarget=jobalert|referral|membership`.
  - `utm_source`: numeric per-channel IDs, for example 1103 = SWE new-grad GitHub repo, 1006 = H1B repo, 1146 = remote page.
  - Email `imp_id` tokens: `instant_push`, `digest_job_alert`, `opentowork`.
  - Paid: `gad_source`, `ref=producthunt`.
- **Job-id carry-through.** The job id is carried through every step, so the user lands back on that job at the end.
- **Visitor carry-over (I).** Visitor filters are kept in localStorage (`visitor_filters`, `VISITOR_ID`) and logged as `user_incognito_*` events. They probably pre-fill onboarding.
- **Partial-signup capture.** When the email field blurs with a valid value, the email is posted to a lead or tracking endpoint (C code path; purpose I).

### 3.3 Canonical screen sequence

```
Entry (landing / tool / job "Apply" / email alert / referral / SEO list gate)
  → S0 Signup
  → S1 Mode selection (rush | no-rush)
  → S2 Basic preferences + market snapshot ("diagnostics")
  → [no-rush only] S3 Career goal → S4 Advanced preferences
  → S5 Resume upload or LinkedIn URL
  → S6 Matching loader
  → S7 "We found N roles" confirmation modal
  → S8 Copilot-mode welcome modal
  → S9 First feed (calibration prompts, first-day offer, install prompts)
  → Later: S10 Profile completion wizard → S11 Extension install
  → Later: S12 Agent setup wizard (second onboarding)
  → Ongoing: re-onboarding via Filters / Orion / zero-results / surveys
```

Order resolution: see §7, contradiction X-01. The order above comes from the stage enum and is **C**. The rush/no-rush branching is **L**.

---

#### S0. Signup: `/onboarding-v3/signup` [ON §4, OAE §8] C

**Layout.** Two columns.
- **Left:** a brand panel. Its headline and three stat bullets change with `from`:
  - Default: more qualified matches, time saved, more interview invites.
  - Resume landing: autofill and custom resume.
  - LinkedIn ad: today's new jobs, total jobs, trusted-users counter.
  - Agent.
  - TNT: a startup logo wall, a skip-the-queue promise and an FAQ.
- **Right:** the auth card.

**Above the card.** An `Account type` toggle: `Job seekers` | `Employers`. Employers are sent to business.jobright.ai.

**Contextual title variants.** "Sign up To Continue", "Sign up to continue to apply" (job apply gate) and "Sign up to view interview questions".

**Auth card, top to bottom:**

| # | Element | Rules |
|---|---|---|
| 1 | Greeting "Welcome to Jobright" | — |
| 2 | `Sign up with Google` | Google Identity ID-token flow |
| 3 | `OR` divider | — |
| 4 | Email | Must be a valid email; error on invalid |
| 5 | Password with show/hide | **≥8 characters, with at least one letter and one digit** |
| 6 | Checkbox: marketing updates about job offers (`emailSub`) | **Pre-checked** (C, observed on live page) |
| 7 | `SIGN UP` (variant `SIGN UP FREE`) | — |
| 8 | Legal line linking Terms and Privacy | — |
| 9 | "Already a member? Sign in now" | Opens the sign-in modal |

**Other auth methods:**
- `Continue with Apple` component (`/swan/auth/login/apple`): used on iOS and as a variant.
- LinkedIn is **not** a login method in 2026 (see X-03). Critic pass: the client A/B registry still has a `linkedin_signup` experiment key, but no LinkedIn sign-up button strings ship. Treat it as a dormant or server-only test.

**Errors and edges:**
- Duplicate email: a toast telling the user to sign in.
- Google failure: a toast.
- In-app browser guard: in LinkedIn, IG or TikTok webviews, an overlay tells the user to open the system browser (Google OAuth is blocked there).
- Existing SSO user: logged in, routed by `currentStage`, or returned to `/jobs/info/[id]`.

**Email verification** does not block onboarding. It is required only for Refer & Earn (L).

**Endpoints.** `/swan/auth/register/pwd-v3`, `/register/sso-v3`. The payload carries `utmSource`, `referralCode` and the A/B bucket from `/swan/ab/user`.

#### S1. Mode selection: `/onboarding-v3/mode-selection` (stage 50) [ON §5] C

- Orion's avatar introduces itself (chat-bubble style) and asks which statement describes the user's situation.
- Two large illustrated cards:
  - `I'm looking for jobs in a rush` (rush)
  - `I'm open to new opportunities, no rush` (no-rush)
- One tap saves via `/swan/landing/seeker-type` and advances. **No Skip.**
- The choice sets the copy on S2 and whether S3 and S4 are shown (L).
- An Appcast conversion pixel fires here (C). Our clone: use first-party analytics only.

#### S2. Basic preferences and market snapshot: `/onboarding-v3/diagnostics` (stage 51/52) [ON §6] C

**Header.** Orion asks what type of role the user wants. The no-rush variant first says it can aim for a perfect match.

**Fields:**

| Field | Control | Required | Options / validation | Default |
|---|---|---|---|---|
| Job Function | Typeahead over a 3-level taxonomy (`jobTaxonomyList`); Enter or `Add` creates a custom entry | Yes | Error if empty. Then a **specific-title confirmation sub-step**: pick ≤3 specific titles under the function (`specificTitles`); error if more than 3. A "Too general" warning tag appears on broad titles (`isGeneralTitle`). | — |
| Job Type | Multi-select | Yes (≥1) | `Full-time`, `Contract`, `Part-time`, `Internship` | I: Full-time |
| Location | City/area picker | Yes | Countries: US, CA, GB, AU, IE, NZ, each with an "Anywhere in <country>" option | Country US |
| Open to Remote | Checkbox with a helper saying remote broadens the search | No | — | Checked (I) |
| Work Authorization | Checkbox `H1B sponsorship` (`isH1BOnly`) | No | Restricts matches to H1B Sponsored or Likely | Unchecked |

**Live "Quick market snapshot" panel** (from `/swan/landing/job/diagnostic`). It appears once a function is chosen and shows:
- Median salary.
- Top industries for the title.
- A "Hot Skills" word cloud.

This is a value-before-effort moment.

**Footer.** `Previous` (disabled on the first step) · `Skip` · `Next`.

**Not asked here.** Experience level (inferred from the resume and confirmed at S7) and salary (asked in Filters).

#### S3. Career goal: `/onboarding-v3/career-goals` (stage 53, no-rush only) [ON §7] C

- Orion says "almost there" and asks for the goal of the next role.
- Single-select cards in 3 groups (`careerGoal`):

| Group | Options |
|---|---|
| Advance My Career | To A Senior Role · To A Manager Role · To A Higher Compensation |
| Shift My Career Path | Transit To A New Industry · Transit To A New Role · Explore New Skill |
| Enjoy Better Work Style | Work & Life Balance · Work Security · Work Flexibility |

- **Validation.** `Next` with no selection shows an error asking the user to select a goal. `Skip` bypasses the step.
- Footer: `Previous` · `Skip` · `Next`.
- The answer feeds Orion personalization.

#### S4. Advanced preferences: `/onboarding-v3/advanced-preferences` (stage 54, no-rush only) [ON §8] C

- Orion asks what would make the job ideal. Every field is optional.
- **Industry:** typeahead with `Add`, multi.
- **Skill:** typeahead with `Add`, multi.
- **Company Stage:** multi chips with a tooltip. When stage data is unknown, Jobright estimates it from size.

| Stage | Funding | Size |
|---|---|---|
| Early Stage | Seed / Series A | 1–50 |
| Growth Stage | Series B / C | 51–200 |
| Late Stage | Series D+ | 500+ |
| Public Company | IPO | — |

- `Open to all` default chip; `Clear All`.
- Footer: `Previous` · `Skip` · `Next`.
- The header shows the Orion avatar, "Your AI Copilot" and a **Logout** link. This proves the user is already authenticated at this point.

#### S5. Resume upload or LinkedIn URL: `/onboarding-v3/resume-upload` (stage 55/56) [ON §9, RS §3] C

- **Headline variants:**
  - Default: one last step to level up the search.
  - Variant: it already sees exciting opportunities, so add a resume or LinkedIn.
- **Primary: dropzone.**
  - `.pdf`, `.doc`, `.docx`, **≤10MB**.
  - The success state shows the file name.
- **Alternative: `Enter Linkedin URL`.**
  - Placeholder `https://www.linkedin.com/in/...`.
  - A helper link, "Get your Linkedin profile URL".
- **Privacy note.** The data is used only for matching and is never shared with third parties, plus a Privacy Policy link.
- **CTA.** `Start Matching`, plus `Skip`.
  - Skipping leads to `NO_RESUME` / `FAILED_WITHOUT_FILTER`: the feed is built from preferences only.
  - Re-prompts are throttled by `resume_last_popup_time`.
- **Errors:**
  - Please upload to proceed.
  - Upload failed.
  - File name too long.
  - File too large or wrong type.
  - **Daily upload limit reached.**
  - LinkedIn URL empty, invalid or not found; activation failed.
  - Hourly lookup limit.

#### S6. Matching loader: `/matching` (stage 21) [ON §10] C

- A Lottie animation and a linear progress bar step through 5 status lines, each with a sub-line:
  1. Scanning the resume or LinkedIn for skills, history and education.
  2. Identifying preferences: industry, role, location.
  3. Building the matching profile.
  4. Finding relevant jobs.
  5. Personalizing recommendations and insights.
- **Side panel, "Feature Highlights":** custom resume per job, 1-click autofill, LinkedIn referral connections.
- **Error state:**
  - A sad illustration.
  - `Try again`, `Upload Resume`, `Enter Linkedin URL`.
  - A support email for persistent failure.
- A ZipRecruiter conversion pixel fires here (C). Our clone: first-party analytics only.

#### S7. "Welcome! We found N roles" confirmation modal (first arrival at `/jobs/recommend`, stage 30) [ON §11.1] C

- **Title.** A clapping emoji plus "Welcome! We found **N** roles that fit you best". A subtitle asks the user to check that everything looks right.
- **Recommended Experience Levels.**
  - Chips preselected from the resume (`suggestedSeniority`); expand/collapse.
  - Error if none is selected.
  - Levels and their helper text:

| Level | Helper |
|---|---|
| Intern/New Grad | No experience required |
| Entry Level | 1–3 yrs |
| Mid Level | 2–5 yrs, not yet senior |
| Senior Level | 5+ yrs, project leader |
| Lead/Staff | Cross-team leader or domain expert |
| Director/Executive | Director / VP / CXO |

- **Additional Job Functions Matching Your Background:** suggested taxonomy titles derived from the resume (`getTaxonomySuggestionOnboard`).
- **LinkedIn URL:** optional.
- **"Where did you hear about us"** (single select; required in the A/B variant `onboarding_acquisition_source_survey_test`). Options:
  - Instagram, TikTok, YouTube.
  - LinkedIn (job posting), LinkedIn (someone's post).
  - Google search, Friend / colleague, Email.
  - AI tools (like ChatGPT).
  - Other, with a free-text box.
- **CTA.** `Confirm & See Jobs`.
- **Analytics.** Whether seniority or taxonomy changed, the source, and the LinkedIn URL. One A/B arm sets `recommendationPreference = 2`.

#### S8. Copilot-mode welcome modal [ON §11.2] C

- Title "Welcome to Jobright". The subtitle suggests starting in Copilot mode.
- Four tiles: `AI Job Matches` · `AI Custom Resumes` · `Insider Connections` · `1-Click Autofill Applications`.
- **Agent waitlist notice:** access rolls out in waves and the user will be notified. The Oct 2026 bundle has no waitlist strings (see X-07).
- CTA `Let's Go`.
- A toast unlocks Orion chat: "You've just unlocked your Chat with me, Orion!" (C; trigger I).

#### S9. First feed session [ON §11.3–11.5, MJ §3.4] C/L

**What appears on day 1:**
- **Feed.** Reviewers saw 5.9K–8.6K matches immediately.
- **Score tip.** A first-time tooltip on the score (`showScoreTip_v1`).
- **Resume-analysis banner.** Grade A–D with Urgent/Critical/Optional counts. Shown only on day 1, and only when a file was uploaded.
- **LinkedIn banner.** "Unlock Better Matches" (add a LinkedIn URL).
- **Orion recommendation guide.** Asks whether the user likes the matches so far: `Yes` / `No, not a good fit`.
- **Skill confirmation.** A "Do you have these skills?" chip prompt.
- **Daily match rating.** A 0–10 rating card.
- **First-day "New User Discount" offer.** An `mm:ss` countdown (A/B). It is suppressed after a ToB direct apply or a failed apply.

**Mobile web:**
- An `Install` smart banner.
- A "Get the Jobright App!" modal.

**Throttled popups** (localStorage timestamps):
- Office-hour registration (`TURBO_OFFICE_HOUR_LAST_POPUP_TIME`).
- Turbo survey (`TURBO_SURVEY_POPUPED`).
- Free-trial welcome (`FREE_TRIAL_WELCOME_POPUPED`).

**New-user missions** (unsubscribed users; F-GROW-05). A checklist: `Customize Your Resume` → `Enable Autofill Extension`. Completing both enters a draw for a free 30-min coaching session.

**Guided first tailor (critic pass).** The new-user product tour can open on a **pre-generated tailored resume** for a job in the feed. The tour stores `tourTailorResumeJobId`, and the tailor logs `tailorResumeEntrySource = tour_pregenerated`. This gives the user the "aha" of a tailored resume without spending a credit or making a choice first. Per-surface first-time guidance flags exist for tailor, cover letter, Add-to-Agent, Hidden Jobs and multiple filters. C (`_app` settings keys, chunk `26242`).

**Throttling (critic pass).** Popups share a 24-hour `lastPopupTime` gate, and the many offer and invite popups are checked against each other so only one shows at a time. C (chunk `10344`).

#### S10. Profile completion wizard: `/jobs/profile` (later, optional) [ON §12] C

- **Entry card.** "Complete your profile" for perfect matches and autofill, with `Start Now`.
- **Privacy note.** Used only for matching and resume optimization, never shared with recruiters without consent, editable and deletable.
- **Steps.** Each opens with an Orion line and emoji:
  1. Personal
  2. Education
  3. Work Experience ("halfway there")
  4. Skill
  5. Equal Employment (used only for autofill)
  6. Install extension (S11)
- Missing required fields show a red `MISSING` badge.
- Field lists are in F-ACCT-03 and F-ACCT-04.

#### S11. Extension install step [ON §13] C

- **Prompt.** "Just one last important step". It shows a social-proof install count and `Click to Install Extension`.
- **On success.** "Congrats! You're all set" with `View More Opportunities` / `APPLY NOW`.
- **3-step guide:**
  1. Install from the store.
  2. Open a Jobright page and click `Start Applying` in the extension to activate it.
  3. Look for `APPLY WITH AUTOFILL` buttons.
- **Status card:** profile incomplete → `Complete Profile`; no extension → `Install Extension`; done → `Explore Jobs`.

#### S12. Agent setup wizard (second onboarding, `/agent`)

See F-AGENT-02. The steps are Confirm Profile → Refine Target Role (rate 3 jobs) → Assess Job Market Fit (Competitiveness Report) → Activate Autofill → Agent Settings → `Set up Completed` (confetti).

### 3.4 Re-onboarding surfaces (ongoing)

All of these write to **one preference store** (the saved filter):
1. The Filters drawer (F-FILT-01..05).
2. Orion chat edits with a reviewable diff card (F-ORION-04).
3. The zero-results "What's limiting your search" panel with `Update Now` (F-FEED-10).
4. In-feed micro-surveys (F-FEED-09).
5. Not Interested reasons that mutate filters (F-FEED-11).
6. An "Update Preferences" re-ask when preferences can't be learned.
7. The `/candidate-preferences` magic-link page for passive users (F-ACCT-12).

### 3.5 Onboarding upsells and emails

- **Upsells:**
  - First-day countdown offer (S9).
  - Special one-time 7-day weekly trial offer (offer-gated).
  - Agent waitlist with a paid skip (historical).
  - Referral rewards after email verification.
- **Emails:**
  - Signup marketing opt-in.
  - Email verification (needed only for referral).
  - Instant or digest job alerts with deep links that resume onboarding.
  - "opentowork" outreach emails that deep-link into diagnostics or resume-upload with a job id.
  - Referral notifications (friend signed up, friend finished onboarding).
- **Unknown.** The welcome/drip sequence could not be observed (see §7).

### 3.6 Onboarding clone deltas (I)

- **RoboHire.io (international + Taiwan).**
  - Generalize `H1B sponsorship` into **"Needs visa / work-permit sponsorship in <country>"**.
  - Extend countries to TW, SG, HK, JP and EU markets.
  - Salary currency follows country.
  - Add **LINE Login** for Taiwan.
  - Zh-TW copy uses 履歷 / 職缺 / 待遇 / 面議.
- **GoApply.Top.** Replace S0–S5 with the CN flow in §6.2:
  - Consent → phone OTP / WeChat.
  - Identity: 应届 / 在校 / 社招.
  - 届别, school tier, 求职状态.
  - Salary in K/月·N薪.
  - 户口 / 央国企 / 编制 / 外企 tags.
  - Resume.
  - First value via the 校招日历.
- **Both brands.**
  - Marketing opt-in **unchecked by default** in EU, TW and CN contexts (PDPA/PIPL/GDPR prudence).
  - Acquisition-survey options per market (CN: 小红书 / 抖音 / 微信 / 知乎 / B站 / 朋友推荐).

---

## 4. Feature catalog

Gate notation:
- **Free** = available on the free tier.
- **Free(n/d)** = free with a daily credit cap of n per day, refilled at midnight with no rollover.
- **Turbo** = paid subscription only.
- **Add-on** = separate purchase.
- Credit numbers follow the canonical table in §5.2.

### 4.1 Marketing site (F-MKT)

#### F-MKT-01 Dual-audience marketing shell and landing template
- **What:** One codebase serves seeker and employer marketing. A header toggle switches audiences. About 30 landing pages share one template (§2.2).
- **Flow:** Land on the page → read the hero and stats → click a CTA → `/onboarding-v3/signup?from=<page>`.
- **UI:** Hero (headline, subhead, CTA, optional video), 3-stat strip, 3 alternating feature blocks with screenshots, jobs-count strip, testimonial carousel (the same 7–8 reused), 4-step how-it-works, FAQ accordion, closing CTA, footer.
- **Data:** Per-page `from` tag. A/B variant id (`/swan/ab/user`, `?ext-ab=`). Live counters (see F-SEO-07).
- **Gate:** Public. **Conf:** C. **Ev:** [PS §4.1–4.3].
- **Clone note (I):** The counters must be real (Jobright's 8M and 400K figures are static, per [MJ §1]). Ship hreflang for each locale.

#### F-MKT-02 Homepage with quick search and live job ticker
- **What:** Hero with CTA(s). A "real results" stat row. A live counter of total and new-today jobs. A **ticker of the newest jobs** (company, minutes ago, title), each linking to `/jobs/info/<id>`. Five feature cards (matches, autofill, tailored resume, insider referrals, copilot). Testimonials. FAQ (A/B sets).
- **UI:** A quick-search bar with Job Title, Work Model, Country (default US), City, Experience Level and `GO`. It routes to `/jobs/[visit]`.
- **Gate:** Public. **Conf:** C. **Ev:** [PS §4.4], https://jobright.ai/

#### F-MKT-03 Feature landing pages
- **What:** One page per pillar: `/ai-job-match`, `/ai-resume-builder`, `/ats-resume-builder`, `/ats-resume-checker`, `/job-autofill`, `/job-referral`, `/orion-copilot`, `/ai-agent`, `/h1b-jobs`, `/tnt`, `/coach-landing`, `/interview-landing`. Each has a pillar-specific stat strip, how-it-works steps and an FAQ.
- **Gate:** Public. **Conf:** C. **Ev:** [PS §4.5], [OAE §3.1, §4.1].

#### F-MKT-04 Company and trust pages
- **What:**
  - `/about`: mission, origin story, founders, values.
  - `/security`: private profiles, suspicious-login alerts, encryption, scam education.
  - `/partners`: cross-promo partners.
  - `/mobile-app`: store buttons.
  - Legal pages: terms, privacy, cookie, refund, sales, referral policy, coaching policy.
- **Gate:** Public. **Conf:** C. **Ev:** [PS §4.5, §5].

### 4.2 Onboarding (F-ONB)

| ID | Feature | Gate | Conf | Ev |
|---|---|---|---|---|
| F-ONB-01 | Stage machine driven by the server; routes resume from any entry point (§3.1) | Free | C | [ON §2] |
| F-ONB-02 | Entry-point attribution (`from`, job id, `action=apply`, invite, retarget, utm, imp_id) carried through all steps (§3.2) | Free | C | [ON §3] |
| F-ONB-03 | Seeker-type selection (rush / no-rush) with Orion persona (S1) | Free | C | [ON §5] |
| F-ONB-04 | Basic preferences with ≤3 specific-title confirmation, "too general" warning and a live market snapshot (S2) | Free | C | [ON §6] |
| F-ONB-05 | Career goal, 9 options in 3 groups (S3) | Free | C | [ON §7] |
| F-ONB-06 | Advanced preferences: industry, skill, company stage (S4) | Free | C | [ON §8] |
| F-ONB-07 | Resume or LinkedIn URL intake with daily upload cap (S5) | Free | C | [ON §9] |
| F-ONB-08 | 5-stage matching loader with error recovery (S6) | Free | C | [ON §10] |
| F-ONB-09 | "We found N roles" confirmation: seniority, extra functions, LinkedIn, acquisition survey (S7) | Free | C | [ON §11.1] |
| F-ONB-10 | Copilot-mode welcome tour (S8) | Free | C | [ON §11.2] |
| F-ONB-11 | In-app-browser guard for OAuth | Free | C | [ON §4.3] |
| F-ONB-12 | Abandoned-signup email capture on blur | Free | C (code) / I (purpose) | [ON §4.3] |

### 4.3 Job feed and matching (F-FEED, F-MATCH)

#### F-FEED-01 Four-tab jobs workspace
- **What:** `/jobs/*`, with tabs **Recommended** (also labelled `For you`) · `Liked {n}` · `Applied {n}` · `External {n}`.
- **Flow:** On desktop, clicking a card opens the detail in place (`?id=`) next to the list. On mobile it opens a drawer.
- **UI:**
  - Top bar: tabs, sort, quick-filter buttons, `Hidden Jobs` toggle, `All Filters`, saved-filter switcher, search box.
  - Infinite scroll of 10 per page.
  - End-of-list message.
- **Data:** `GET /swan/recommend/list/jobs?refresh&sortCondition&position&deeplink&reqJobIds&count=10&syncRerank`. Each item is `{impId, jobResult, companyResult, displayScore, rankDesc, isLiked, applyStatus, jobNotes}`. Counts come from `/swan/job/like/count`, `/apply/count` and `/statistic`.
- **Edges:** Refreshing too often returns error 43004 and a rate-limit modal. A deleted job that was clicked shows a "recommendations refreshed" notice.
- **Gate:** Free. **Conf:** C. **Ev:** [MJ §2–3], [PS §10.2].

#### F-FEED-02 Sort modes
- **What:**

| UI label | Server value |
|---|---|
| `Recommended` (default) | `RELEVANCE` |
| `Most Recent` | `FRESHNESS` |
| `Top Matched` | `MATCH_SCORE` |

- Recommended balances relevance, quality and freshness. Orion can change the sort from chat.
- **Gate:** Free. **Conf:** C. **Ev:** [MJ §3.2].

#### F-FEED-03 Saved filters (named search profiles)
- **What:** Several named filter sets, labelled "Your Saved Filters", for different target roles. `Add filter` / `New Filter`, with instant switching. **At least one must remain.** Alerts are tied to saved filters.
- **Gate:** Free: 1. Turbo: unlimited. **Conf:** C (UI) / L (limits). **Ev:** [MJ §3.1], [PS §10.2].

#### F-FEED-04 Hidden Jobs toggle
- **What:** A top-bar toggle with an info tooltip. It limits the feed to quality jobs that are **not listed on major boards** (LinkedIn, Indeed). These cards carry a flashlight badge. Promoted as about 5,360 roles.
- **Data:** `hiddenJob` flag; `/swan/recommend/count-hidden-jobs`.
- **Gate:** Turbo (upsell "Unlock the Hidden Jobs"). **Conf:** L. **Ev:** [MJ §7.5], [ON §15].

#### F-FEED-05 Job card anatomy
- **What, in order:**
  1. Freshness stamp (`publishTimeDesc`). Reposts read "Reposted X ago" with a tooltip.
  2. Logo and company name.
  3. Descriptor line: GPT short description, or 2 categories joined, plus funding stage.
  4. Title.
  5. Meta row: location (+N more), work model, employment type, seniority, salary (`$61K/yr - $98K/yr`, `$30/hr`), `N+ years exp`.
  6. Applicants line (F-FEED-08).
  7. Badges: `Posted by Agency`, `External`, `Direct Apply`, `Applied by Agent`, `High Response Rate`, `Invite-Only for Top Talent`, hidden-job flashlight.
  8. Insider teaser ("N former <company/school>").
  9. Match block (F-FEED-06).
  10. Actions: heart (`Save job`/`Unsave job`), primary apply button (F-JOB-06), `ASK ORION`, and a `…` menu.
- **`…` menu:** `Already Applied`, `Not Interested`, `Report Issue`, `Remove From List` (Liked/Applied only), `Share` (`/swan/share/job/link`).
- **Gate:** Free. **Conf:** C. **Ev:** [MJ §4], chunks `12523`, `30004`, `3530`.

#### F-FEED-06 Match score ring, rank label and colour bands
- **What:**
  - A 70px ring showing `floor(displayScore)%`, with a gradient stroke.
  - A server-provided rank label (`rankDesc`) in caps: `STRONG MATCH` / `GOOD MATCH` / `FAIR MATCH`.
  - CSS bands: ≤70 `less-match`, 71–85 `match`, >85 `strong-match`.
- **States:** Visitors see a lock and "MATCH SCORE". Closed jobs show a "JOB CLOSED" illustration and an `expired-job` style.
- **Gate:** Free (logged in). **Conf:** C (bands) / L (labels). **Ev:** [MJ §4.2].
- **Clone note:** Map Fair ≤70, Good 71–85, Strong >85 (I). Make the label threshold server-configurable.

#### F-FEED-07 Recommendation (reason) tags
- **What:** At most 3 positive tags, chosen in a fixed priority order:
  1. `Unicorn ($XB val.)`
  2. `Top Investors`
  3. `H1B Sponsored` / `H1B Sponsor Likely`
  4. `Comp. & Benefits`
  5. `Growth Opportunities`
- **Additions:**
  - A company-stage tag can be prepended: `Early/Growth/Late Stage Co.`, `Public Company`.
  - Funding helpers: "Recently raised $XM (Series X)" for a round within 6 months; "Raised $XM" when total funding is ≥$50M.
  - Negative tags with a disappointed icon: `No H1B`, `U.S. Citizen Only`, `Security Clearance Required`.
  - `jobTags`: `Early applicant` when there are ≤25 applicants.
- **Tooltips (paraphrased):**
  - H1B Sponsored: the JD says sponsorship is offered.
  - H1B Sponsor Likely: the JD is silent, but the company sponsored similar roles in the past 3 years.
  - No H1B: the JD rules sponsorship out.
- **Data:** `recommendationTags[]`, `companyRecommendationTags[]`, `h1BStatus`, `isH1bSponsor`, `isCitizenOnly`, `isClearanceRequired`.
- **Gate:** Free. **Conf:** C. **Ev:** [MJ §4.2], chunk `30004`.

#### F-FEED-08 Applicant count and urgency line
- **What:** Applicant text: `Less than 25 applicants` (≤25), `N applicants` (26–199), `200+ applicants` (≥200). The server can override it with `applicantsDisplayText`. An urgency line has 4 bands (<50, 50–99, 100–199, ≥200), moving from "stand out easily" to "filling quickly".
- **Do not clone:** the `?expire=true` "Expires in N hrs" chip. Its N is a fake pick from 6/8/12/18/24 based on a hash of the job id.
- **Gate:** Free. **Conf:** C. **Ev:** [MJ §4.1, §6.1].

#### F-FEED-09 In-feed calibration loop
- **What:**
  - **(a) Daily match survey.** A 0–10 card titled "rate today's matches". A score **<8** opens reason chips: `Irrelevant Title`, `Low-quality company`, `Experience Level Mismatch`, `Skill Mismatch`, `Outdated Job Listing`, plus free text. API: `/swan/feedback/job-match/{show,submit}` with `{score, reason[], description, impressionId}`.
  - **(b) Skill confirmation.** "Do you have these skills?" chips → `/swan/filter/user-skill/{add,exclude}`, followed by a "Skill added!" toast.
  - **(c) Orion guide card.** Do you like your matches? (`Yes` / `No, not a good fit`).
  - **(d) After an Orion filter change.** `Looks better` / `Not quite`.
- **Gate:** Free. **Conf:** C. **Ev:** [MJ §3.4, §8.5], [ON §11.4].

#### F-FEED-10 Zero-results diagnostics and preference re-ask
- **What:**
  - When no jobs match: a "What's limiting your search" list (each blocking criterion and its current value), a "How you may adjust" list, and `Update Now` (endpoint `suggested-conditions-v2`).
  - If preferences can't be learned: an `Update Preferences` re-ask.
  - A whimsical variant says the user has reached the edge of the job universe.
- **Gate:** Free. **Conf:** C. **Ev:** [MJ §3.4], [PS §10.2].

#### F-FEED-11 Not Interested with reasons that change filters
- **What:** A drawer with a subtitle saying some choices will update the user's filters. Single-choice reasons; the job disappears immediately.

| Reason | Code | Effect |
|---|---|---|
| This company | 1 | Add to `excludedCompanies` |
| This industry | 11 | Inline industry checkboxes → `excludeCompanyCategory` |
| Required skills I lack | 3 | Inline skill checkboxes → `excludedSkills` |
| Not my target locations | 8 | Location editor → add cities with a 25 mi radius |
| Experience level | 12 | Points to the level filter |
| Work authorization → H1B | 101 | Sets `isH1BOnly=true` |
| Work authorization → clearance | 102 | Adds to `excludeByAuthorization` |
| Work authorization → US citizenship | 103 | Adds to `excludeByAuthorization` |
| Same title | 2 | Hides the title |
| Other | 6 | Free text |

- **Data:** `POST /swan/job/ignore {jobId, feedback, companyId?, jobTitle?, skills?, locations?, excludeCompanyCategory?, msg?}`. Other codes: applied 5, report 9, fake 91, incorrect 92, expired 93, remove-from-list 13.
- **Variant:** Explore hides the industry and skill reasons.
- **Gate:** Free. **Conf:** C. **Ev:** [MJ §8.2], chunk `79519`.
- **Known issue (L):** Reviewers say rejected jobs reappear. Our clone must persist hides as hard exclusions.

#### F-FEED-12 Report Issue
- **What:** Enum reasons `scam`, `offensive`, `incorrect`, `not_available`, `not_remote`, `not_in_us`, `posting_date_incorrect` → `/swan/job/report`. After a scam report, the user is prompted to turn on `Exclude Staffing Agency`.
- **Gate:** Free. **Conf:** C (enum) / UI labels unknown. **Ev:** [MJ §8.3].

#### F-FEED-13 Explore (Beta) category browse
- **What:** `/jobs/explore`, "Explore Jobs with AI". 20 emoji-labelled function categories: Software Engineering, Engineering & Development, Data Analyst, Business Analyst, Accounting & Finance, ML & AI, Consulting, Marketing, Project Manager, Product Management, Arts & Entertainment, Legal & Compliance, Education & Training, Creatives & Design, Customer Service & Support, HR, Public Sector & Government, Management & Executive, Data Engineer, Sales.
- **Gate:** Free. **Conf:** C. **Ev:** [MJ §3.5].

#### F-FEED-17 Explore AI Search (experiment; added in the critic pass)
- **What:** A flag-gated "AI search" mode for Explore (experiment `explore_ai_search`). An invite popup on the Recommended feed (`explore_ai_search_invite_popup_exposure` / `_click`) sends the user to Explore. It is shown once, and only to users with Turbo access whose lowest selected seniority is at or above a threshold. It is suppressed when any other popup is pending.
- **UI:** The search UI strings are not in the shipped Explore page chunk, so the AI search is probably server-rendered or still a dark launch (I).
- **Clone note (I):** A natural-language job search ("remote ML roles at Series B startups paying over $180k") maps onto our filter schema through the same diff card as F-ORION-04.
- **Gate:** Turbo-leaning (experiment). **Conf:** C (flag, popup and events) / I (UI). **Ev:** `_app` A/B registry; chunk `10344`.

#### F-FEED-14 Ranking pipeline
- **What (I, from public `jobNotes`):**
  - Multi-retriever candidate generation (e.g. `titleTaxonomy` on the user's taxonomy IDs).
  - × freshness weight (decays with age, about 1.22 at 7 min and about 1.207 at 1 h).
  - × mix-rank weight (1.5).
  - × company-scatter demotion (diversity).
  - = `rankScore`.
  - Then a personal re-rank: by `displayScore` for Top Matched, by time for Most Recent. `syncRerank` runs after feedback.
- **Data:** `jobNotes{boostedFactor, rankScore, notesMap{retriever, retriever_score, taxonomy_ids, freshness_weight, mix_rank_weight, company_scatter_demote, linkedin_job_id}}`.
- **Gate:** n/a. **Conf:** C (fields) / I (formula). **Ev:** [MJ §9].

#### F-FEED-15 Job ingestion, sources and freshness
- **What:**
  - Sources: LinkedIn (every sampled job carried `linkedin_job_id`), Indeed, company career sites (claimed 200K+), JobTarget, Greenhouse, and employer-posted ToB jobs (`isToB`, ids prefixed `b2b_`).
  - Jobs as fresh as about 7 minutes.
  - Flags: `repost`, `isDeleted`, `isCompanySiteLink`, `source/sourceId`.
  - Real per-function inventory was about 6.4–6.8K per role in the US.
- **Gate:** n/a. **Conf:** C. **Ev:** [MJ §10].
- **Clone note (I):** Prefer ATS-direct ingestion (Greenhouse, Lever, Workday, Ashby; Moka and Beisen in CN) over LinkedIn reposts, to avoid the stale-listing complaints. Use RoboApply's existing provider seam (JSearch, ActiveJobsDB, LinkedIn RapidAPI) and the GoHire cross-bank.

#### F-FEED-16 Visitor (logged-out) feed and search
- **What:**
  - SEO and visitor lists render inside the app shell.
  - About 20 cards, then a `JOIN NOW FOR FREE` gate.
  - Locked match score.
  - Floating Orion launcher.
  - "Quick Guide" SEO paragraph.
  - Visitor endpoints: `/swan/recommend/visitor-list/jobs`, `/visitor-search`.
  - Visitor rails on detail: "You May Also Like" and "Hot Jobs in Popular Locations".
- **Gate:** Public. **Conf:** C. **Ev:** [PS §7], [MJ §7.6].

#### F-MATCH-01 Score breakdown (components)
- **What:** `recommendationScores[]` = `{featureName, displayName, score}`:
  - `q_seniority_match` → "Experience Level"
  - `q_job_skill_match` → "Skill"
  - `q_industry_match` → "Industry Exp."
  - `education_match_score` → "Education Match" (shown only when relevant, I)
- Plus `skillMatchingScores[]` for the job's top 5 core skills (`jdCoreSkills{skill, score 1–3, type hard_skill|soft_skill}`) and `industryMatchingScores[]`.
- The overall score is **not** a mean (examples: 82% from 100/69/80; 88% from 100/98/45). The weights are unknown.
- Critic pass: the iOS store FAQ says the 0–100 score compares skills, experience **and salary range** with the job. No salary sub-score is shown, so salary is probably a hidden factor or a filter-side signal (I). This may explain why some scores are not a mean of the visible components.
- **UI:** Sub-score % rings on detail. "Why You Are A Good Fit" chips with check or cross: Experience Level, Relevant Experience, Education, Core Skills.
- **Gate:** Free (logged in). **Conf:** C. **Ev:** [MJ §5.1], [RS §6.1].
- **Clone note (I):** Show the evidence line behind each component. Jobright's opacity is a known complaint.

#### F-MATCH-02 "Why this job is a match" banner
- **What:** A card with an AI star, a title, a 2-line LLM `jobSummary`, and component bars.
- **Gate:** Free. **Conf:** C. **Ev:** [MJ §5.2].

#### F-MATCH-03 Your-skill chips in Qualification
- **What:** The top-5 required skills render as chips. Skills the user has are highlighted, with the legend "Represents the skills you have". `Required` vs `Preferred` lists come from `qualifications.mustHave/preferredHave`. `detailQualifications` splits into `{yoe, education, hardSkill, softSkill}`.
- **Gate:** Free. **Conf:** C. **Ev:** [MJ §5.3].

#### F-MATCH-04 Job Search Competitiveness Report
- **What:** Generated in about 30–40 s. It contains:
  - "Where You Stand at a Glance": the share of similar applicants the user outperforms, with a gauge and a level of `Exceptional`/`Great`/`Strong`/`Promising`/`Emerging`.
  - A `Strength` card and a `Level-Up` card.
  - "You vs. Other Applicants": Education (% of pool), Experience Level (years vs distribution) and Skills (peer skill bar chart).
  - "You vs. What Employers Want": degree coverage %, experience coverage %, a most-requested-skills chart.
  - "Boost Resume Score By Adding Missing Skills" chips.
  - "Broaden Your Job Search" checkboxes with a projected count of extra jobs.
  - `Confirm & Proceed` / `Improve My Fit`. A change re-runs the market-fit analysis.
- **Light version on detail:** "Your Score vs Top Applicants".
- **Gate:** Part of the Agent setup (I: full report Turbo-leaning). **Conf:** C. **Ev:** [MJ §5.5], [OAE §4.2], [RS §6.3].

#### F-MATCH-05 "Top candidate" jobs
- **What:** An Orion prompt and card `TOP_CANDIDATES` that lists jobs where the user ranks as a top applicant. Also "Top Match Jobs" on marketing.
- **Gate:** Free. **Conf:** C. **Ev:** [OAE §3.3].

### 4.4 Job detail (F-JOB)

#### F-JOB-01 Header and layout
- **What:** `/jobs/info/[id]`, public and SEO-indexed. When logged in, it adds personal scores. Title format "{Title} @ {Company}". Sticky tabs or anchors: `Overview` | `Company` | Insider Connection.
- **Header:**
  - Logo, name and posted-ago (or "Reposted").
  - Title.
  - Meta chips: location, type, work model, seniority, salary, `N+ years exp`.
  - Applicants count and the `Posted by Agency` chip.
  - **Hiring Manager card** (name + LinkedIn) when `jobRecruiter` exists.
  - Primary CTA (`APPLY NOW` / `Apply on Employer Site`), like and share.
- **Gate:** Public. **Conf:** C. **Ev:** [MJ §6.1], [PS §8].

#### F-JOB-02 Overview body
- **What, in order:**
  1. LLM summary (company name bolded).
  2. Industry chips.
  3. Recommendation tags with tooltips.
  4. `Why Join Us` (when present).
  5. `Responsibilities` (LLM bullets, about 16).
  6. `Qualification` (skill chips, Required/Preferred, verbatim work-authorization lines).
  7. `Benefits` (about 18 bullets).
  8. Education.
  9. "Not interested in this role?" link.
- **Gate:** Public. **Conf:** C. **Ev:** [MJ §6.2].

#### F-JOB-03 Right rail: "Boost Your Interview Chances"
- **What:** Three cards, each tagged `FREE`:
  1. **Improve Resume Match Score:** `Your Score` vs `Top Applicants`, "Must-Have Skills for This Role", `Optimize my Resume`.
  2. **Get Referral Via LinkedIn:** a claim of higher response from email, 2–5 insider mini-cards, `Draft Message to Connect`.
  3. **Apply Faster with Autofill Plugin:** `Apply With Autofill`.
- **Logged-in extra list:** `1. Customize Your Resume`, `Build Cover Letter`, `Analyze How Well You Fit`, "Make your application stand out".
- **Gate:** Cards are free to view. Actions spend credits (resume, cover letter, email). **Conf:** C. **Ev:** [MJ §6.3], [PS §8].

#### F-JOB-04 Company tab
- **What:**
  - Glassdoor rating and count (link).
  - GPT short description, founded, HQ, headcount band, website, social links.
  - **Funding:** current stage, total, key investors, latest rounds (type, date, amount).
  - `Leadership Team` / `Founding Team` (name, title, LinkedIn, photo).
  - `Recent News` (publisher, date).
  - **H1B sponsorship history:** yearly counts (`h1bAnnualJobCount`), title distribution and median salary offered (DOL LCA data), with a disclaimer that past sponsorship is no guarantee.
  - "Company data provided by crunchbase".
- **Data:** `companyResult` (Appendix A).
- **Gate:** Free. **Conf:** C. **Ev:** [MJ §6.5], [NTI §6].

#### F-JOB-05 Similar jobs and closed-job handling
- **What:** `/swan/recommend/similar/jobs`. A closed job (`isDeleted`) shows `JOB CLOSED`, a tooltip listing likely reasons, and `Apply To Similar Jobs`. A removed job clicked from email shows a "recommendations refreshed" notice.
- **Gate:** Free. **Conf:** C. **Ev:** [MJ §6.6].

#### F-JOB-06 Apply button variants

| Variant | When | Behaviour |
|---|---|---|
| `APPLY NOW` / `Apply on Employer Site` / `Apply on Linkedin` / `Apply on Indeed` | Default, by source | New tab → "Did you apply?" on return |
| `APPLY WITH AUTOFILL` | Extension supports the ATS | Opens the form; extension fills it; user submits |
| `Jobright Easy Apply` | Greenhouse or JobTarget jobs | In-app server-side apply (F-AGENT-07) |
| `Direct Apply` / `Send My Profile` | Employer-customer (ToB) or TNT jobs | Profile goes to the employer queue "like a referral" |
| `Add to Agent` | Any | Queues the job for the Agent |
| `Apply To Similar Jobs` | Closed | Similar list |

- **Apply intercept popup:** before applying, a popup offers `fix my resume now` or `apply without customizing for this role`. A "don't show again" choice is persisted.
- **Gate:** Apply is free. Autofill Free(4/d). Easy Apply: single on Free, multi on Turbo. **Conf:** C. **Ev:** [MJ §4.4, §12], [RS §7.1].

#### F-JOB-07 "Did you apply?" capture
- **What:** After an external apply click, a return modal offers `Yes, I applied!` (→ `/swan/job/apply`, moves the job to Applied, refreshes recommendations; may trigger a Trustpilot invite with a 60-day cooldown and/or a student-plan popup) or `No, I didn't apply`. The apply call is deferred until the user confirms. Event `TRUE_APPLY`.
- **Gate:** Free. **Conf:** C. **Ev:** [MJ §8.4], [NTI §3.3].

#### F-JOB-08 Share job
- **What:** `/swan/share/job/{link,shareId,batch}`. A copy-link toast.
- **Gate:** Free. **Conf:** C. **Ev:** [MJ §4.3].

#### F-JOB-09 JobPosting structured data
- **What:** JSON-LD `JobPosting` with `validThrough` = publish + 1 month, `baseSalary`, `jobLocationType=TELECOMMUTE` for remote, and an HTML description that concatenates the sections plus H1B history.
- **Gate:** Public. **Conf:** C. **Ev:** [MJ §6.7].

### 4.5 Filters and search (F-FILT)

All filter sections live in an `All Filters` modal. It has a left anchor nav with 4 sections, each with a subtitle, plus `Reset` and **`Confirm(N)`**, where N is a live job count from `/swan/recommend/count-filter-jobs`. Save shows a "Preferences updated!" toast. [MJ §7], chunk `79590`. C

#### F-FILT-01 Basic Job Criteria (`#basic`)

| Field (key) | Control | Options / rules | Req |
|---|---|---|---|
| Job Function (`jobTaxonomyList`) | Typeahead (3-level taxonomy, IDs like `01-08-01`) | "Too general" warning; must not overlap Excluded Title | Yes |
| Excluded Title (`excludedTitle`) | Autocomplete | Two-way conflict check | — |
| Job Type (`jobTypes`) | Checkboxes | Full-time, Contract, Part-time, Internship | ≥1 |
| Work Model (`workModel`) | Checkboxes | Onsite, Hybrid, Remote | ≥1 |
| Country | Select | US, CA, UK, AU, IE, NZ | Yes |
| Location (`locations`, `cityRadius`) | Multi-location selector | City/state; radius 0/5/25/50/100 mi; "All locations within X"; city cap | — |
| Experience Level (`seniority`) | Checkboxes (suggested from resume) | 6 levels (S7 table) | ≥1 |
| Required Experience (`minYearsOfExperienceRange`) | Range slider | 0–11+ yrs; default "Any requirements" | — |
| Date Posted (`daysAgo`) | Radio | Past 24 hours / 3 days / week / month; default any | — |

#### F-FILT-02 Compensation & Sponsorship (`#compensation`)

| Field | Control | Options |
|---|---|---|
| Minimum Annual Salary (`annualSalaryMinimum`) | Slider | $10k–$800k in $10k steps; default "Any salary"; chip "Min $Nk/yr" |
| Work Authorization (`isH1BOnly`) | Checkbox `H1B sponsorship` | Matches H1B Sponsored and H1B Sponsor Likely (USCIS/DOL history) |
| Exclude Jobs with Limitations (`excludeByAuthorization`) | Checkbox group | Security Clearance Required, US Citizen Only |

#### F-FILT-03 Areas of Interests (`#interests`)

| Field | Control | Rule |
|---|---|---|
| Industry (`companyCategory`) | Searchable multi with suggestions | Cannot be combined with Excluded Industry |
| Excluded Industry (`excludeCompanyCategory`) | Searchable multi | — |
| Skill (`skills`) | Searchable multi + custom entry | — |
| Excluded Skill (`excludedSkills`) | Searchable multi | Also written by Not Interested |
| Role Type (`roleType`) | Radio | IC, Manager |

#### F-FILT-04 Company Insights (`#company`)

| Field | Control | Options |
|---|---|---|
| Company (`companies`) | Search + checkbox with logos | Include only these |
| Company Stage (`companyStages`) | Checkboxes with a tooltip table | Early / Growth / Late / Public; estimated from headcount when unknown |
| Job Source (`excludeStaffingAgency`) | Checkbox | Exclude Staffing Agency |
| Exclude Company (`excludedCompanies`) | Search + checkbox | Also written by Not Interested |

#### F-FILT-05 Quick filter bar and active chips
- **What:** Top-bar buttons (label, current value, arrow) for Country, Company, Experience Level, Job Type, Work Model, Date Posted, with alternate presets. Active chips such as "N miles", "Exclude Staffing Agency", "H1B Only", "Min $Nk/yr". A label map is shared by chat, chips and the empty state.
- **Full quick-filter registry (critic pass, chunk `83417`):** `jobTaxonomyList` (Job Function), `country` (Country / Location), `seniority` (Experience Level), `minYearsOfExperienceRange` (Years of Experience), `jobTypes`, `workModel`, `daysAgo` (Date Posted), `annualSalaryMinimum` (Salary, shown as "Min …" with a dropdown label "Minimum Annual Salary"), `companyCategory` (Industry), `companies` (Company). A preset decides which subset shows.
- **Not found:** a dedicated "early applicant" filter. A 2026 Jobright blog post lists early-applicant opportunities among its filter signals, but the code shows it only as the card tag and the "Be an early applicant" chip in Agent cards (≤25 applicants).
- **Gate:** Free. **Conf:** C. **Ev:** [MJ §7.5], chunks `83417`, `95257`.

#### F-FILT-06 Title and company search with typeahead
- **What:** Placeholder "Search by title or company". Typeahead starts at ≥2 characters with a 400 ms debounce and suggests titles (`searchType=job_title`) and companies with logos (`searchType=company`). `POST /swan/recommend/search` returns the same cards and sorts; `/count-search-filter-jobs` gives the count. The Applied tab has its own search.
- **Gate:** Free (visitors limited). **Conf:** C. **Ev:** [MJ §7.6].

#### F-FILT-07 "Save to default" in the Agent
- **What:** When filters change inside the Agent, the user is asked whether to save the change to the default job-match filter.
- **Gate:** Agent. **Conf:** C. **Ev:** [MJ §7.5].

### 4.6 Orion AI copilot (F-ORION)

#### F-ORION-01 Floating chat panel
- **What:** A slide-in or floating panel on job list and detail pages (`job-copilot-container[-floating]`). The avatar is a mint speech bubble.
- **UI:**
  - Input "Ask me anything…" with **voice input** (Start / Finish / Cancel via getUserMedia), Send and `Stop generating`.
  - Welcome block "Tasks I can assist you with": `Adjust current preference`, `Top Match jobs`, `Ask Orion`.
  - Drawer tabs on detail: Analysis, Job Highlights, Resume Tips, Recommended Jobs.
- **Known issue:** It re-opens on nearly every page change, which reviewers found annoying. Clone it with a dismiss memory.
- **Gate:** Free, unlimited chat. Actions it triggers spend credits. **Conf:** C (UI) / L (unlimited). **Ev:** [OAE §3.2], [NTI §5.1].

#### F-ORION-02 Per-job quick-action chips
- **What:**

| Chip | Prompt (paraphrased) | Card type |
|---|---|---|
| `Job Highlights` | Why this job fits me | `JOB_HIGHLIGHTS` |
| `Resume Tips` | Resume tips to apply / to stand out | `RESUME_TIPS` |
| `Insider Connections` | Show referral connections | `SOCIAL_CONNECTIONS` |
| `Top Candidates` | Jobs where I'm a top candidate | `TOP_CANDIDATES` |
| `Tailored Resume` | Generate a custom resume for this job | `TAIL_RESUME` |
| Cover letter | Write a cover letter | `WRITE_COVER_LETTER` |

- The `ASK ORION` button on each card opens the panel scoped to that job.
- **Gate:** Free (actions use credits). **Conf:** C. **Ev:** [OAE §3.4], chunk `97342`.

#### F-ORION-03 Job Fit Analysis
- **What:** A structured explanation with sections Relevant Experience, Seniority, Skills (aligned vs not aligned), Education, Potential Gaps and Job Highlights. It names specific missing tools. Takes about 15 s.
- **Gate:** Free. **Conf:** C/L. **Ev:** [OAE §3.3].

#### F-ORION-04 Chat-to-filter control with a reviewable diff
- **What:** Natural-language edits to the saved filter. Simple commands (part-time, remote, set city, mid-level, H1B, a sector, min salary, require skills, IC only, add or exclude a title, within 50 miles) and compound ones (IC→manager + salary floor + remote).
- **Flow:**
  1. Orion replies with an `UPDATE_FILTER` / `SHOW_FILTER` / `CONFIRM_FILTER` card listing diffs (added X to field; revised A→B; deleted X).
  2. The user picks `Confirm` or `UPDATE`.
  3. The toast "Preferences updated!" appears and the list re-ranks.
  4. Orion asks `Looks better` / `Not quite`.
- **Proactive suggestion:** Orion can suggest a filter change from a job detail (`suggest_condition`).
- **Gate:** Free. **Conf:** C. **Ev:** [OAE §3.3], [ON §15], [NTI §5.1].

#### F-ORION-05 Sort and "show my preferences" via chat
- **What:** Sort requests (recommended, recent, best match) with a confirmation, and `View Current Preferences`.
- **Gate:** Free. **Conf:** C. **Ev:** [OAE §3.3].

#### F-ORION-06 Orion cheatsheet modal
- **What:** A quick guide with example prompts in 6 groups: about this job; basic filters; advanced filters; complex multi-constraint; sorting; viewing preferences.
- **Gate:** Free. **Conf:** C. **Ev:** [OAE §3.4].

#### F-ORION-07 Company insights card in chat
- **What:** Funding, Basic Info, Leadership, News, Glassdoor and H1B, inside chat.
- **Gate:** Free. **Conf:** C. **Ev:** [OAE §3.3].

#### F-ORION-08 Proactive nudges
- **What:** The "Not seeing the right jobs?" guide bubble, gated by a daily-browsing counter. The chips "Salary too low?" (opens the salary field) and "Tired of scam jobs?" (suggests excluding staffing agencies). After an external job import, the suggestion "Update Your Filter".
- **Gate:** Free. **Conf:** C. **Ev:** [OAE §3.2–3.3], [NTI §3.4].

#### F-ORION-09 Career, interview and salary advice
- **What:** Free-form chat for behavioral prep, company-specific prep, salary negotiation, career change and resume audits. It uses onboarding answers, the resume and application history as context. There is no visible chat history or episodic memory (gap).
- **Gate:** Free. **Conf:** L. **Ev:** [OAE §3.3, §3.5].

#### F-ORION-10 Message feedback and job-list feedback
- **What:** Per-message feedback with an option to forward to support. "Orion job list feedback" multi-select.
- **Gate:** Free. **Conf:** C. **Ev:** [OAE §3.3].

#### F-ORION-11 Orion as the persona for onboarding and the Agent
- **What:** The same persona narrates onboarding (S1–S4), the profile wizard and every Agent step. The Android package name is `ai.jobright.orion`.
- **Gate:** Free. **Conf:** C. **Ev:** [OAE §3.1].

#### F-ORION-12 Full chat card vocabulary (added in the critic pass)
- **What:** The Orion chat renders typed cards. The `_app` enum has these types beyond F-ORION-02/04, and each is a small feature to clone:
  - `UPDATE_SALARY`: a salary-floor editor card (backs the "Salary too low?" chip).
  - `UPDATE_JOB_SOURCE`: the staffing-agency and source exclusion card (backs "Tired of scam jobs?" and the post-scam-report prompt).
  - `SKILL_SUGGESTION`, `TAXONOMY_SUGGESTION`, `TAXONOMY_ONBOARD_SUGGESTION`: suggested skills and job functions, with selection-change sub-events (`SELECTED_CHANGED`, `NON_TO_SELECTED`, `SELECTED_TO_UNSELECTED`).
  - `SEARCH_SUGGESTION`, `SEARCH_NOTICE`: suggestions and notices tied to keyword search.
  - `PREFERENCE_SHORTCUT`, `PRESET_OPTION(S)`, `QUICK_GUIDE`, `FILTER_ORDER`, `SORTER`: shortcut chips, the cheatsheet and sort control.
  - `ADD_EXTERNAL_JOB`, `EXTERNAL_JOB`, `EXTERNAL_JOB_CHECK_SUGGESTION`: the External import flow runs inside chat ("Analyzing New Job…" → "External Job Added" → `View Job`).
  - `EXTERNAL_LINKEDIN_EMAIL_INFO`, `EMAIL_CONTACT_INFO`, `CONTACT_INFO`: email-finder results.
  - `JOB_LIST_FEEDBACK`, `FEEDBACK_NOTICE`: list feedback.
  - `TURBO_POPUP_RETENTION`: Orion can deliver the Turbo retention offer in chat (see F-BILL-10).
  - `STREAM_MESSAGE`: streamed HTML answers.
- **Gate:** Free. **Conf:** C. **Ev:** `_app-ff4b18b98295f6d5.js` enum; chunks `10344`, `79519`, `jobs/external`.

#### F-ORION-13 Visitor Orion (logged out) (added in the critic pass)
- **What:** On SEO and visitor pages, a logged-out Orion uses its own card types: `VISITOR_WELCOME_MESSAGE`, `VISITOR_SEO_INTRO` (the page's "Quick Guide" intro), `VISITOR_HOT_JOBS`, `VISITOR_SIMILAR_JOBS` and `VISITOR_PRESET_OPTION`. It answers lightly and gates actions to signup.
- **Clone note (I):** This is an SEO-page conversion assistant. Ship it per brand and locale, and never let it make claims about the visitor's fit without a profile.
- **Gate:** Public. **Conf:** C (enum) / L (behaviour). **Ev:** `_app` enum; [PS §7].

### 4.7 Agent / auto-apply (F-AGENT)

> **Policy flag:** RoboApply Overhaul Ruling R1 (2026-07-26, `docs/roboapply/OVERHAUL_RULINGS.md`) says auto-apply is dead and the user always makes the final click. Jobright's Automated Mode and server-side Easy Apply submit on the user's behalf. See decision D-01 in §7. This catalog specs the full Jobright behaviour, and **Supervised Mode is the default** that is compatible with R1.

#### F-AGENT-01 Agent intro and access gate
- **What:** An intro card where Orion presents itself as a personal job-search agent with 4 pillars: search plan, matched roles, autopilot applications, 24/7 coaching. Buttons `See How Agent works` / `Start setting up my agent`.
- **Historical waitlist:** `You're on the Waitlist` / `Join the Waitlist`, with a paid escape `Skip Waiting and Enable Agent Now`.
- **Launch facts (critic pass):** The Agent launched on **2025-06-24** together with the $3.2M round. At launch it covered only U.S. roles in tech, education and government. The company claimed it scans about 400K postings a day, applies only when the candidate looks qualified, and hands the job back for a manual apply when a site blocks bots. Bloomberg Law (2025-07-02) reported that it sends up to **50 matched listings a week**. Access is now a per-user server flag (`enableAgent`) with a dismissible "agent access" popup (`hideAgentAccessPopup`).
- **Gate:** Free "Limited Access". Turbo unlimited. **Conf:** C (strings in the Aug build) / I (waitlist retired by Oct). **Ev:** [ON §14], [OAE §4.6], The Register 2025-06-24, Bloomberg Law 2025-07-02, chunk `10344`.

#### F-AGENT-02 Five-step setup wizard
- **What:** A left-rail stepper, chat-led. Internal enum: `CONFIRM_PROFILE_INFO`, `ALIGN_JOB_PREFERENCES`, `COMPETITIVE_GAP_ANALYSIS`, `MISSING_SKILLS`, `FILL_APPLICATION_INFO`, `INSTALL_EXTENSION`, `SET_AUTOMATION_PREFERENCE`, `ENABLE_AUTO_APPLICATION`.
  1. **Confirm Profile.** Personal, links, education, work, skills (select/unselect) and EEO. `MISSING` flags block progress. `Looks Good` / `Confirm & Proceed`.
  2. **Refine Target Role.** Shows preferences (`Looks Good` / `Edit Preferences`). **The user must rate 3 matches** 👍/👎. A 👎 asks what didn't work (free text). `Refine my matches` gives 3 new roles. When filters are too narrow, a hint suggests removing company, skill or industry conditions.
  3. **Assess Job Market Fit.** The Competitiveness Report (F-MATCH-04).
  4. **Activate Autofill.** The application profile, including **Common Application Questions**, then the 3-step extension install and `I've installed it` with version and detection checks.
  5. **Agent Settings** (F-AGENT-03).
  6. `Set up Completed` with confetti, then `Start Applying with Agent`.
- **Gate:** Agent access. **Conf:** C. **Ev:** [OAE §4.2], [ON §14].

#### F-AGENT-03 Agent Settings
- **What:**
  - **Agent Mode:** `Supervised Mode` (pauses at resume creation and at final submit) or `Automated Mode` (runs every step and stops only when it needs info).
  - **Job Application Objective:** `<20` / `20-50` / `>50` jobs per week. This is a target, not a cap.
  - **Resume Preference:** `Generate custom resume` per job, or `Select from my own resumes`. Default format `Original Version` | `Jobright Template`.
  - **Toggles:** `Customize my Resume for Each Application`; `Generate Cover Letter for Each Application` (only when the job requires one).
  - **Common Application Questions** answer bank.
  - Always reachable via `Access Agent Settings`.
- **Gate:** Agent access. **Conf:** C. **Ev:** [OAE §4.2].

#### F-AGENT-04 Run queue
- **What:**
  - Orion fetches today's matches ("Preparing your best matches…").
  - `Top Matches` list → `Add` / `Add All` → Added List.
  - Also `Add job to apply`, `Browse Top Matches`, search.
  - `Begin Auto-Apply`.
  - Counters `N Added` / `N Jobs Remaining`.
  - Tabs `Active` / `Completed`.
  - Expired-job cleanup ("Some Jobs Have Expired" → `Remove & Continue`).
  - Cancel a task (irreversible confirmation).
  - `Reset Agent`, `Back to Main Site`.
- **Job card in the queue:** logo, age, applicant chip, meta, company stage, % ring.
- **Detail:** "why we picked this", score tiles, company block, insider connections, JD sections.
- **Gate:** Agent; Free credit-limited. **Conf:** C. **Ev:** [OAE §4.3].

#### F-AGENT-05 Per-application pipeline state machine
- **What:** `JOB_APPLICATION_INITATED` → `GENERATE_RESUME` → `CONFIRM_RESUME` → `GENERATE_COVER_LETTER` → `CONFIRM_COVER_LETTER` → `ANALYZE_APPLICATION_SITE` → `FILL_OUT_APPLICATION` → `SUBMIT_APPLICATION`, plus `SKIPPED` and `TERMINATED`.
- **Display step names:**
  1. Choose Resume
  2. Generate/Confirm Custom Resume ("1 resume credit will be used")
  3. Generate Cover Letter
  4. Email Lookup
  5. Analyze application site
  6. Fill out application form ("1 autofill credit will be used")
  7. Fill in N missing fields
  8. `Submit Now` / `I've Applied`
  9. Job Application completed
- **Status labels:** Action Required, Completed, In Progress, Revise, Paused, Not Started.
- **Supervised confirm:** `Confirm Custom Resume`, a free-text revise, download PDF/Word, and a cover-letter create-or-skip choice.
- **Gate:** Credits per step on Free. **Conf:** C. **Ev:** [OAE §4.3], [NTI §3.6].

#### F-AGENT-06 Hand-off branches (degrade gracefully)
- **What:**
  - **Server apply** where possible.
  - Otherwise **autofill-only:** `Apply Now` → the site opens with the extension → `Autofill` → user reviews and submits → `I've Applied`.
  - Otherwise **manual:** apply in the browser → `I've Applied`.
  - **Missing fields:** the user completes them.
  - **Errors:** a timeout with retry; "extension not running properly".
  - **Status sync:** "This job has been moved to your '<list>'".
  - Jobright respects sites that block bots. It applies only when the candidate seems qualified.
- **Gate:** Agent. **Conf:** C. **Ev:** [OAE §4.3–4.5].

#### F-AGENT-07 Easy Apply (server-side apply inside the product)
- **What:** Applies on supported platforms (Greenhouse, JobTarget) without leaving the app.
- **Live status:** getting ready → opening page → uploading resume → filling details → **confirming verification code** (the user pastes the ATS email OTP: `Enter code now`) → submitting → `Application submitted`.
- **Guards:** one application in progress at a time; `Refresh status`.
- Uses a separate `easy-apply` credit. Greenhouse file checks: ≤5 files, ≤1 GiB.
- **Gate:** Free: single, credit-metered. Turbo: unlimited plus **multi-apply**. **Conf:** C. **Ev:** [OAE §4.4], [MJ §4.4].

#### F-AGENT-08 Agent application tracker and progress widget
- **What:** A tracker inside `/agent` with search by title or company and states Active, Completed, In Progress, Paused, Not Started. A floating "Application progress" widget ("Working on N applications") polls status.
- **Gate:** Agent. **Conf:** C. **Ev:** [NTI §3.6].

#### F-AGENT-09 Inbox connection for verification codes
- **What:** The Agent may require Gmail OAuth ("Connect Gmail to submit your application"), with the promise that it reads only one-time codes and verification links. Settings "Email Providers" can auto-receive Greenhouse codes; states Pending, Processing, Connected, Failed, Cancelled. Blocked-state messages exist.
- **Gate:** Agent. **Conf:** C. **Ev:** [NTI §3.6], [ON §16].

#### F-AGENT-10 Credit gates during runs
- **What:** A notice before spending. When credits run out, a 3-way modal: `Go Unlimited` (Turbo) / `Free Daily Refill` (come back tomorrow) / `Proceed without Custom Resume / Autofill / Premium Features`. After upgrading: "Congrats on Upgrading to Turbo", with unlimited Agent access.
- **Gate:** —. **Conf:** C. **Ev:** [OAE §4.6].

#### F-AGENT-11 Agent chat vocabulary and statuses (added in the critic pass)
- **What:** Beyond F-AGENT-05, the Agent chat enum (chunk `97342`) adds these cards and states:
  - `AGENT_COMPETITOR_ANALYSIS`: the competitiveness card inside a run.
  - `AGENT_SHOW_INSIDER_CONNECTIONS`: insider contacts per queued job.
  - `AGENT_UPDATE_RESUME`, `TASK_TWEAK_RESUME`: resume edits made in chat during a run.
  - `CHAT_GENERATE_RESUME`, `CHAT_GENERATE_COVER_LETTER`.
  - `SUGGEST_JOBS`, `SHOW_ME_MORE_MATCHES`, `I_WANT_SOMETHING_DIFFERENT`: refinement replies on the match list.
  - `REMOVE_DELETED_JOB`, `RETRY_ACTION`, `PROFILE_UPDATE`.
  - Assistant states `INIT`, `STANDBY`, `EXECUTING`, `TASK_START`, `TASK_STEP`, `TASK_PROGRESS`, `TASK_COMPLETED`, `TASK_SKIPPED`.
- **Clone note (I):** Model the Agent as a typed event stream. A chat transcript of these events is also the audit log of what was done on the user's behalf.
- **Gate:** Agent. **Conf:** C. **Ev:** chunk `97342-7f758d8ed7830b3e.js`.

### 4.8 Resume suite (F-RES)

#### F-RES-01 Resume intake and parsing
- **What:** Upload `.pdf/.doc/.docx` ≤10MB, or use a LinkedIn URL. Parsed into sections: `personalInfo`, `summary`, `education`, `workExperience`, `skills`, `projects`, `certifications`, `achievements`, `languages`, `publications`, `extracurricularExperience`, `reference`, `customSections`. `Update profile from resume` / `Update to Profile` syncs the data into the autofill profile.
- **Edges:** Daily upload cap. Parse-quality feedback ("sections missing after parsing"). Upload session expired or cancelled.
- **Gate:** Free. **Conf:** C. **Ev:** [RS §3], [PS §16].
- **Clone note:** RoboApply parses PDFs through GoHire's parse-resume API (memory). Keep that.

#### F-RES-02 My Resume hub (multi-resume)
- **What:** `/jobs/resume` holds up to **5 resumes**, with a counter "N saved out of 5". One is the `Primary Resume`, the default for matching, Agent and autofill. The primary can't be deleted until another resume is set as primary.
- **Per-resume actions:** `Edit Resume Info`, `Update to Profile`, `Export`, `Delete`.
- **States:** processing / `Analysis Complete` / `Analysis Failed`.
- `Add Resume` is blocked during an upload and at 5 resumes.
- Each resume has a **Target Job Title** from an 18-category emoji picker.
- Tailored versions are saved per job, separately from the 5 slots (I).
- **Gate:** Free (5 on every plan). **Conf:** C. **Ev:** [RS §4].

#### F-RES-03 Resume Analysis report card
- **What:**
  1. A pre-flight "Missing Information" check (job title plus work or education must be present).
  2. A "Ready for Analyze" explainer.
  3. Run, which charges **1 base-resume credit**. `Cancel Analysis` refunds the credit.
  4. A report drawer: letter grade, score, target job, and severity totals.
- **Grades:**

| Grade | Label |
|---|---|
| A | `EXCELLENT` |
| B | `GOOD` |
| C | `SATISFACTORY` |
| D | `IMPROVABLE` |

- Severities: `Urgent` / `Critical` / `Optional`. Issues are grouped per resume section.
- **Feed banner:** "Your Resume Needs Attention" or "Your Resume Analysis Is Ready".
- **Failure:** "Analysis Not Completed" → `Run Again`.
- **Gate:** Credit-gated ("1 credit consumed; earn more with Referral"). Deeper analysis is premium. **Conf:** C. **Ev:** [RS §5.1–5.2].

#### F-RES-04 Issue taxonomy (16+ types)
- **What:**
  - **ATS format:** graphics/icons, tables, multi-column, ATS-misread fonts.
  - **Completeness:** missing personal info, missing key sections, missing experience fields.
  - **Impact:** lack of action verbs, lack of accomplishment (quantification), lack of methodology, irrelevant experience title.
  - **Language:** spelling/grammar, buzzwords, filler words.
  - **Brevity:** bullet too short; bullet too long (target 10–30 words).
  - **Summary:** missing (target 2–3 sentences); ineffective (should cover title, level, skills, achievements).
  - **Skills:** fewer than 10 → `Recommended Skills`.
- Each issue type has short report text plus "why it matters".
- **Gate:** In analysis. **Conf:** C. **Ev:** [RS §5.3].

#### F-RES-05 Fix panel with AI rewrite
- **What:**
  - `Issue Detected` (highlighted on the PDF preview), `Why This Is Important`, `How to Improve`.
  - Examples `Before`/`After`, `Scenario`, `Verb Choices`.
  - AI: `View AI-generated Version from orion`, `Write Your New Version`, `Write with AI`, `Write longer`, `Write shorter`, `Make this even stronger`, `Use This Version`, plus free-text instructions.
  - "Was This Suggestion Helpful?" `Looks Great!` / `Not What I Expected`.
  - A general feedback drawer.
  - Rate-limit message "You're moving a bit fast!".
- **Gate:** Credit-gated. **Conf:** C. **Ev:** [RS §5.4].

#### F-RES-06 Re-analyze and progress comparison
- **What:** After fixes, "issues cleared" → `Submit New Version` → `Progress & Re-analyze`. Shows `Last Analysis` vs `Current Analysis` with a delta of `Same` / `Increase` / `Decrease` and a matching message. When all issues are resolved, a well-done state. `Export to ATS-friendly PDF`.
- **Gate:** Credit-gated. **Conf:** C. **Ev:** [RS §5.1].

#### F-RES-07 Resume analysis product tour
- **What:** Coach marks (`NEXT` / `END TOUR`): Check Your Issues, add details, skip, Fix, track progress, re-analyze, download. Completion is stored in localStorage (`JR_base_resume_v2_tour_seen`). It ends with a pitch to find jobs and tailor a resume.
- **Gate:** Free. **Conf:** C. **Ev:** [ON product tours], [RS §5.1].

#### F-RES-08 Resume-vs-JD ATS match report (gap grid)
- **What:** A verdict line plus a semicircle gauge **out of 10** with tiers Excellent / Good / Fair / Poor. A 3-column grid: `Overview` | job (logo, company, title) | `Your Resume` (file). Rows, each with a pass/fail/warn badge: Job Title, Years Of Experience, Education, **ATS Job Keywords (n/m)**, **Hard Skills (n/m)**, Industry Experience, Summary/Qualifications. Keyword chips are thumbs-up for matched and plain for missing.
- **Gate:** Free to view (L). Tailoring from it costs credits. **Conf:** C. **Ev:** [RS §6.2].

#### F-RES-09 Custom Resume tailor wizard
- **Entry points:**
  - Detail `1. Customize Your Resume`.
  - The apply intercept.
  - Orion `Tailored Resume`.
  - The extension.
  - The Agent toggle.
  - External jobs.
- **Steps:**
  1. **Choose sections to enhance.** A section appears only if the backend suggests it.
     - `Summary`.
     - `Skills`: **locked on**.
     - `Work Experience`: `Quick Edit (First 2 key experiences)` | `Full Edit (All experiences…)`.
     - `Projects`.
  2. **Add custom prompt (optional)** (A/B `tailor_resume_custom_prompt`). ≤1000 characters; persisted.
  3. **Add missing ATS job keywords (n/m).**
     - Category-grouped chips, `Select all` / `Unselect all`.
     - `Add Keywords` input with a duplicate check.
     - Empty state: all skills are already present.
     - Optional `keyRequirements` toggles.
  4. `Generate My New Resume` takes about 10–20 s ("Making your resume a stronger fit…"). A slower advanced-model message appears when applicable.
- **Live experiments on this flow (critic pass):**
  - `tailor_resume_fast_mode_abtest`: a "fast mode" tailor. The user's mode choice is persisted as `tailorResumeMode`, and a one-time tooltip explains it. I: it probably collapses steps 1–3 into one click.
  - `tailor_multi_skill_selection`: multi-select keyword chips.
  - `tailor_step_exp`.
  - A feedback card after tailoring (`resumeTailorFeedbackCardShownV2`).
  - Counters `/swan/resume-tailor/{count, exists}` decide whether to show the tailor or open an existing version.
  - For coaching-enabled users, a **career-coach upsell portal** sits inside the tailor view (`careerCoachTailorPortalDisabled` turns it off; see F-COACH-06).
- **Credits:** 1 TAILOR credit. When out of credits, the refill modal opens.
- **Gate:** Free(2/d). Turbo unlimited. **Conf:** C. **Ev:** [RS §7.1–7.2].

#### F-RES-10 Tailored result: diff, compare, verify
- **What:**
  - Score before → after (e.g. 5.5 → 9.0).
  - Collapsible change cards: `Summary Enhanced`, `Missing Skills Added`, `Relevant Skills Highlighted`, `Recent Work Experience Enhanced`.
  - Inline green highlights and `See What's Changed`.
  - `Compare to original` (`Your original version` vs `Tailored version`), `Use Tailored Version` / `Restore`.
  - **`Verify Details`.** For each inserted keyword or claim: `Yes, Keep it` / `No, remove it` / `I used something similar`. The last option pre-fills the chat with "Here is what I actually did with …".
  - `Edit on resume` (inline).
  - Next steps: `Apply Now`, `Continue to Autofill`, `View Your Tailored Resume`, `Regenerate`.
  - The version is saved per job ("Last updated …").
- **Gate:** Part of the tailor. **Conf:** C. **Ev:** [RS §7.3].
- **Clone note (I):** Make verification **mandatory before export** for inserted claims. Fabrication is the top complaint.

#### F-RES-11 AI Rewrite chat (resume)
- **What:**
  - Placeholder "Tell me how you'd like to tweak your resume…".
  - Remembers chats and preferences.
  - Quick pills: stronger action verbs, shorten summary, remove unrelated skills.
  - **Voice input** (hold-to-talk, server `transcribe`).
  - Element "capsule" scoping.
  - `Regenerate` → "N new versions, pick one" → `Update`.
  - Per-field "Make it stronger".
  - Revert, stop, and per-message feedback.
- **Gate:** Credit-gated. **Conf:** C. **Ev:** [RS §7.3], [PS §13] (`resume-tailor/transcribe`).

#### F-RES-12 Structured resume editor
- **What:**
  - **Personal:** name, subtitle, email, phone, location, LinkedIn, GitHub, website.
  - **Summary.**
  - **Skills:** groups with tags.
  - **Work:** company, title, location, dates/Present, summary, bullets. Roles at the same company merge on export.
  - **Education:** school, degree, location, GPA, dates, coursework, achievements.
  - **Projects:** link URL and text.
  - Certifications, Achievements, Languages (level), Publications (authors, link), Extracurricular, Reference.
  - **Custom Section:** `Add Text Item` / `Add Structured Item`.
  - `Edit Resume Layout`: add, rename, drag-reorder (personal info pinned) and delete sections.
  - Rich-text bullets (ProseMirror-style, I).
- **Gate:** Free (L). **Conf:** C. **Ev:** [RS §8.1], [PS §10.8].

#### F-RES-13 Templates and formatting
- **Templates (5):**

| Template | Description |
|---|---|
| Standard | ATS-friendly; flagged `Recommended` |
| Compact | One page |
| Centered | Centered header with accent divider |
| Structured | Labels left, content right |
| Split | Two columns. Conflicts with the multi-column ATS warning |

- **Fonts:** Helvetica, Arial, Times New Roman, Roboto, Georgia, Open Sans, Carlito, Garamond, Work Sans, Poppins, Inter, Montserrat.
- **Font sizes:** separate for Name, Section Headers, Sub-Headers and Body.
- **Page:** Letter or A4.
- **Spacing sliders:**

| Control | Range |
|---|---|
| Section spacing | 0–10 pt |
| Entry spacing | 0–10 pt |
| Line spacing | 10–15 pt |
| Top/bottom margin | 10–50 pt |
| Side margin | 30–50 pt |

- **Other controls:**
  - Justify toggle.
  - Header alignment L/C/R.
  - Accent color applied to all headings, section names or name.
  - Bullet icon: solid, hollow or dash.
  - Skills layout inline/grouped/column, with N columns.
  - Education order: degree-first or school-first.
  - Date format: Jan YYYY / January YYYY / YYYY / MM/YYYY.
  - Hide divider.
  - `Quick Formats`, `Reset formatting`.
- Base and tailored styles are tracked separately (I).
- **Gate:** Free (L). **Conf:** C. **Ev:** [RS §8.2–8.3], [PS §10.8].

#### F-RES-14 Fit to one page
- **What:** `Fit Resume to One Page` adjusts spacing, fonts and margins only, with undo. Errors when the content is too long or too short. Toggle `Auto Fit After Custom Resume`.
- **Gate:** Free. **Conf:** C. **Ev:** [RS §8.3].

#### F-RES-15 Export
- **What:** PDF (generated client-side) and Word `.docx` (through the `/foxit` conversion; no in-app preview). File-name presets: `Name + Job title + Date` (default) / `Name + Job title` / `Name + Target company` / `Name only`. Rename. An exporting modal. The apply-time choice is the original file vs the platform template, and the platform must record which file was sent (Jobright fails here).
- **Gate:** Free. **Conf:** C. **Ev:** [RS §8.4, §7.3].

#### F-RES-16 LinkedIn Profile Report
- **What:**
  - Entry points: `Optimize My Linkedin Profile`, `View My LinkedIn Report`, and the banner "Your LinkedIn Profile Needs Attention". Requires a LinkedIn URL.
  - The drawer shows identity, an overall score /100, urgent/critical/optional counts and an "Overall assessment".
  - **5 dimensions:** Positioning, Recent Experience, Career Narrative, Discoverability, Trust & Proof.
  - Per issue: Why This Matters, How to improve it, and an example with copy.
  - Recheck is rate-limited ("Review limit reached. Try again in X hr Y min"); the previous report is kept on failure.
- **Gate:** Free sees the preview (score, counts, summary, dimensions). Turbo gets full issue details and recheck (403 otherwise). **Conf:** C. **Ev:** [RS §12].

#### F-RES-17 From-scratch "Fast Mode" builder
- **What:** Several tool landers (resume maker, parser, helper, ATS checker) promise building a new resume "in Fast Mode" in under 3 minutes. No in-app from-scratch wizard strings exist. **Correction (critic pass):** the only "fast mode" in the app is the **tailor** experiment `tailor_resume_fast_mode_abtest` (F-RES-09), not a from-scratch builder. The marketing claim most likely refers to upload → parse → instant report → editor.
- **Gate:** —. **Conf:** C (landing copy and A/B key) / I (no standalone builder). **Ev:** [RS §16], tool page chunks, `_app` A/B registry.
- **Clone:** Ship a guided form builder, a cheap differentiator.

### 4.9 Cover letters (F-CL)

#### F-CL-01 Cover letter generator
- **What:** Generates a letter from the resume (primary or tailored) plus the JD.
- **Entry points:**
  - Job detail `Build Cover Letter`.
  - Orion "Write a cover letter for this job".
  - Agent toggle (only for jobs that require a letter).
  - Extension cover-letter field.
  - `/tools/cover-letter-generator` landing page, which funnels into Orion.
- **Behavior:** About 10–20 s, shown as "Generating Your Cover Letter…". The UI has **no tone or length presets**; tone and length are changed through chat.
- **Output shape:** "Dear Hiring Manager" salutation, then an opening that names the role, then a paragraph with a quantified result. Tailored phrases are highlighted.
- **Gate:** Free(2/d). Turbo unlimited. An "N available today" / "Unlimited" counter is shown. **Conf:** C (flow) / L (2/d). **Ev:** [RS §9].
- **Clone note (I):** Add explicit tone and length presets. Ground the letter so details from the JD are not presented as the candidate's own.

#### F-CL-02 Cover letter editor and AI Rewrite
- **What:**
  - Two tabs: `Editor` (direct editing) and `AI Rewrite` (chat).
  - Quick prompts: improve the opening; make it more tailored.
  - Statuses: "Updating…", then "Done!".
  - Version restore with `Restore`.
  - `Copy cover letter`.
  - `Download by PDF` / `Word(.docx)`, `Regenerate`, `APPLY NOW` / `Continue to Autofill`.
- **Orion flow:** `Generate Cover Letter` → `Confirm Cover Letter` → Download.
- **Gate:** Same as F-CL-01. **Conf:** C. **Ev:** [RS §9], [PS §10.3].

### 4.10 Insider connections and outreach (F-NET)

#### F-NET-01 LinkedIn URL capture ("Unlock Better Matches" / "Unlock Your Network")
- **What:** A modal where the user pastes their LinkedIn URL. This is **not OAuth**.
- **Validation states:** empty, invalid, no profile found, `Linkedin URL Verified`.
- **On success:** `View My Connections`, `Update Linkedin URL`.
- **Banner:** a dismissible "Add LinkedIn for smarter job matches".
- **Purpose:** past companies and schools are resolved to LinkedIn IDs.
- **Gate:** Free. **Conf:** C. **Ev:** [NTI §2.2].

#### F-NET-02 Insider Connection panel (3 buckets)
- **What:** Section "Insider Connection @ {Company}" on job detail and in Agent cards, with an Orion variant.

| Bucket key | Label | Match | Sub-line |
|---|---|---|---|
| `default` | Beyond your network | none | `{title} @{company}` |
| `company` | From your previous company | `matchCompanyName` | `Previously@X` |
| `school` | From your School | `matchSchoolName` | `@School` |

- **Card:** avatar (photo, or an initial on a tinted background), name, title, company. A mail icon (find email) and a LinkedIn icon (prepare message). A `blur` flag gives a **locked contact preview** with `Unlock`.
- **Volume:** only a few people per bucket. Coverage is thin, especially outside the US.
- **Data:** `socialConnections[]` `{firstName, fullName(last initial), logoUrl, companyName, jobTitle, linkedinUrl}`. Public pages expose at most 5.
- **Data source:** not named. Critic pass: the privacy notice lists "business-to-business data partners that provide professional contact and firmographic information" among recipients and sources. A separate section says Jobright collects professional information from public sources (public professional profiles, company websites) without bypassing access controls, and that people can ask it to stop and delete the data. This supports a **licensed B2B people-data provider plus public-web collection, with an opt-out channel**. The vendor is still unnamed. C (policy text) / I (vendor).
- **Gate:** Free with partial locking. Turbo full. **Conf:** C. **Ev:** [NTI §2.3–2.4], [MJ §6.4].

#### F-NET-03 "Find More Connections" deep link
- **What:** When a bucket is empty, the link opens LinkedIn people search with filters:
  - `currentCompany` + `keywords=jobTitle` for the default bucket.
  - `+pastCompany=[ids]` for the company bucket.
  - `+schoolFilter=[ids]` for the school bucket.
- **Gate:** Free. **Conf:** C. **Ev:** [NTI §2.4].

#### F-NET-04 Connect-on-LinkedIn note
- **What:** A modal with an editable note sized to LinkedIn's limit. It greets the contact by first name and adds a shared-company or alumni clause when one applies. It then states interest in the role and asks for help.
- **Buttons:** `Copy`, `Cancel`, `View Linkedin Profile`. The product **never sends the note**.
- **Gate:** Free. **Conf:** C. **Ev:** [NTI §2.5].

#### F-NET-05 Email lookup (work-email finder)
- **What:** The mail icon runs a lookup: "📧 Fetching Contact Info" → "✅ Contact Info Found!" / "😨 Not Found". Failure messages distinguish an unmatched profile from a matched profile with no email.
- **Found card:** `Copy` / `Connect Now`.
- **API:** `/swan/email/linkedin-to-email`.
- **Gate:** Free(2/d) ("Email Connection for Referral"). Turbo unlimited ("Linkedin Email Finder"). **Conf:** C. **Ev:** [NTI §2.6–2.7].

#### F-NET-06 Connect Via Email composer
- **What:**
  - Modal labelled "Connect Via Email", with a claim of higher response.
  - An accuracy disclaimer.
  - `To` field (with copy).
  - Subject prefilled as "Seeking Your Advice on {Role} Position at {Company}".
  - Rich-text body from **one of 3 static templates** (default, previous company, school). Each asks for insights and a resume forward.
  - Send opens `mailto:` in the user's own mail client. Nothing is attached and nothing is sent by Jobright.
- **Gate:** Free. **Conf:** C. **Ev:** [NTI §2.6].
- **Clone note (I):** Use LLM drafts in three variants (short note, email, referral ask), stored per contact and linked to the tracker entry.

#### F-NET-07 Find Any Email
- **What:** A box on job detail and in Orion. Paste any `linkedin.com/in/...` URL to get a work email (`/swan/email/external-linkedin-to-email`).
- **Gate:** Email credit. **Conf:** C. **Ev:** [NTI §2.3].

#### F-NET-08 Send My Profile (TNT direct referral)
- **What:** On TNT partner jobs (`isTnt`), the apply button becomes `Send My Profile` / `Direct Apply`. Framing: skip the queue and get reviewed like a referral, with the platform acting as referrer. TNT is a vetted network of AI, software, data and product talent matched with funded AI startups. Its benefits include fast-track interviews, hidden roles and startups reaching out to talent.
- **Gate:** Free (TNT jobs). **Conf:** C. **Ev:** [NTI §2.9], [PS §4.5].

#### F-NET-09 Messages inbox: employer interview invitations
- **What:** A card "Interview Invitation from {Company}" showing location, type, work mode, salary, seniority and years required. The user answers `Yes, I am interested` / `No, I am not interested`.
- **On Yes:** a form for email, phone, availability next week (Y/N plus details), earliest start (Immediately / 2 Weeks / 1 Month / >1 Month), work models (multi) and sponsorship need (now / future / none).
- **On No:** a free-text reason.
- **Mobile:** a "Full Invitation Available on Desktop" notice.
- **Plumbing (critic pass):** The inbox is a general **message center** opened from the sidebar, with an unread dot. APIs are `/swan/msg/has-unread`, `/swan/msg/list`, `/swan/msg/read` and `/swan/business/candidate/response/get`. The ToS reserves an SMS channel for interview-invitation reminders (F-NOTIF-10).
- **Privacy rule (privacy notice §4):** Employers see candidates in anonymized or limited form. Name and direct contact details are released only when the candidate applies, accepts an invitation or turns on visibility.
- **Gate:** Free. **Conf:** C. **Ev:** [NTI §2.10], chunk `10344`, `legal/privacy` bundle.

#### F-NET-10 Candidate verification
- **What:**
  - `Verify My LinkedIn` (OAuth ownership check; fails if the account doesn't match the URL on file; some employers require it).
  - `Verify Work Email Now` (`/work-email-verify`), which marks experience as verified and the user as a "trusted candidate".
  - In-app copy claims verified candidates get about 2× more recruiter views.
- **Gate:** Free. **Conf:** C. **Ev:** [NTI §2.2], [PS §10.9].

### 4.11 Application tracker (F-TRK)

#### F-TRK-01 Liked list
- **What:** `/jobs/liked`. The heart toggles save via `/swan/job/like` and `/unlike`. Segments: `Active` / `Closed(N)`. Empty state with `View Recommended Jobs`. Applying moves the job to Applied.
- **Gate:** Free. **Conf:** C. **Ev:** [MJ §11].

#### F-TRK-02 Applied list with status tracking
- **What:** `/jobs/applied` is a virtualized **list, not kanban**.
- **Status sub-tabs with counts:** `Applied(n)` | `Interviewing(n)` | `Offer Received(n)` | `Rejected(n)` | `Archived(n)`, backed by `/swan/job/statistic`.
- **Search:** `Search in Applied jobs`.
- **Card:** "Applied on {date}" or "Marked as {status} on {date}"; a borderless status dropdown that saves instantly (`/swan/job/apply-status/save`); `Direct Apply` / `Applied by Agent` tags; custom-resume download; `Remove`; undo apply (`/swan/job/unapply`).
- **Absent:** notes, reminders, interview dates, offer fields, kanban, CSV export.
- **Gate:** Free, no limits. **Conf:** C. **Ev:** [NTI §3.2], [MJ §11].
- **Clone note:** RoboApply's `RATrackerEntry` already has 8 statuses, notes, follow-up date and salary. Keep those as advantages and add reminders.

#### F-TRK-03 Auto-capture into Applied
- **What:** Jobs enter Applied in these ways:
  - The "Did you apply?" modal (F-JOB-07).
  - Automatically for Easy Apply, autofill, Send My Profile and Agent applications.
  - The `Already Applied` menu item.
- A toast says "You'll find this job in your 'Applied' list". There is no inbox parsing.
- **Gate:** Free. **Conf:** C. **Ev:** [NTI §3.3].

#### F-TRK-04 External job import (Job Clipper)
- **What:** `/jobs/external` "Add a New Job".
- **Input:** a posting URL with `Get Job Details`, or manual entry (Title required, Company, JD required, English only).
- **States:** Analyzing → details ready / **partial** (fill the rest; enter company manually) / nothing found / invalid URL → `External Job Added` with `View Job` (match score, tailor, apply, mark applied).
- **Abuse limits:** too many attempts → 1-hour lock; repeated abuse → **7-day suspension**.
- **After import:** Orion suggests a filter update to find similar jobs.
- **API:** `/swan/import/{job, job-by-url, job-by-url/status, status, list, remove}`.
- **Gate:** Free (rate-limited). **Conf:** C. **Ev:** [MJ §11], [NTI §3.4].

### 4.12 Interview prep and mock interviews (F-INT)

#### F-INT-01 Company interview question bank
- **What:**
  - Nav `Interview` (badge "new").
  - Size: 6,656+ questions / 328+ companies on the landing page; 9,851+ / 431+ in the pricing modal; 10,033 / 434 counted by FavTutor in Aug 2026 (about 1.1K added per 30 days).
  - **4 categories:** Coding, System Design, Low-Level & Domain Design, Behavioral & Experience.
- **Company page `/interview/[companyId]`:**
  - `Browse Companies`, a "Trusted Question Source" badge.
  - Filters: `Topic`, `Seniority`, role, keyword.
  - Cards: difficulty, seniority, role, "Updated Nh/d ago".
- **Question detail:**
  - Problem statement.
  - Step-by-step approach.
  - What the interviewer tests, plus common mistakes.
  - Rubric and follow-ups.
  - `Verified AI-Generated Solution` with a language selector.
- **Sourcing:** candidate reports from public communities, curated (I: legal and quality risk).
- **Gate:** Preview free. Full access through passes (F-INT-04), or Turbo Quarterly ("9k+ questions"). Logged out: "Sign Up to Unlock". **Conf:** C. **Ev:** [NTI §4.1], [PS §10.11].

#### F-INT-02 In-browser coding runner
- **What:** `Start Practice`, a language picker, sample cases ("Case n"), `Run`, results (Accepted/Failed, runtime), and a practice-list sidebar.
- **Gate:** With a pass. **Conf:** C. **Ev:** [NTI §4.1].

#### F-INT-03 Report and contribute questions
- **What:**
  - Report reasons: unclear statement, wrong solution, inaccurate tags, duplicate / outdated / inauthentic, wrong test case, code won't compile, plus free text.
  - "Contribute an Interview Question" form: company, role, interview date, question.
- **Gate:** Free. **Conf:** C. **Ev:** [NTI §4.1].

#### F-INT-04 Interview passes
- **What:** One-time, no auto-renew. **Company Pass** $19.99 for 7 days (one company). **All-Access Pass** $39.99 for 30 days. Upgrading Company → All-Access credits unused time pro rata. `Pass History`. A promo shows All-Access at $0.00, and a 3-day free trial is offered as a Turbo gift. The settings page has an "Interview Passes" section.
- **Pass rules (critic pass, chunk `19013`):**
  - Pass cards are pitched as "for one active interview" (Company) vs "for multiple active interviews" (All-Access).
  - Some companies are **All-Access-exclusive** and cannot be bought as a Company Pass (error 40101).
  - A second pass for a company that already has an active pass is blocked (error 40094).
  - The checkout is inline Stripe.js.
  - The pass bullets promise step-by-step solutions, company-specific insider tips and interview rubrics, and daily-added reported questions.
  - Experiment `interview_turbo_exp` (EXP1) shows an interview-access offer to some Turbo cohorts (see X-15).
- **Gate:** Add-on. **Conf:** C (product) / L (prices). **Ev:** [NTI §4.1], [BGS §3].

#### F-INT-05 "AI Interviewer" voice intake (`/voice-chat`)
- **What:** A **5-minute audio-only** call with Orion, built on Retell over LiveKit. It learns what the candidate wants and is best at, then connects them with hiring teams. It is employer-marketplace intake, **not practice**.
- **Entry:** email links (`entry=email`) or in-app with job context. Links can expire ("Link Expired" → `Explore Jobs`). Critic pass: the in-app entry is an **invite card or popup with dismiss throttling** (`voicechatInviteDismissCount`, `voicechatInviteDismissedAt`), so it backs off after the user declines.
- **States:**
  1. Intro "Get an Extra Edge Before You Apply" → `Start Voice Chat`.
  2. Sign-in gate.
  3. Mic test with a device picker → "I'm ready, start now".
  4. Mic-denied help.
  5. In-call: `AI Interviewer` label, timer, mute, hang-up, `Restart call` (progress lost), reconnecting / connection lost, leave confirm (`End Anyway` / `Continue the Call`).
  6. Success: thank-you, a **consent checkbox** to share the conversation with employers, a 1–5 star rating (hidden for email entry), `Close This Tab`.
  7. Rate limit on repeat attempts.
- **Gate:** Free (sign-in required). **Conf:** C. **Ev:** [NTI §4.3], [OAE §9].
- **Clone note:** This state machine is the reference for fixing RoboApply's video/voice interview reliability (§7 D-05).

#### F-INT-06 AI mock interview (scored)
- **What:** Jobright **does not offer** a self-serve scored AI mock interview. Its own Sept 2026 blog says the bank does not run or grade mock interviews, and its compare table's "AI Mock Interview" row is not backed by the product. Human mock interviews happen through coaching.
- **Gate:** —. **Conf:** L. **Ev:** [NTI §4.2].
- **Clone:** RoboApply already has voice/video mock interviews with scoring (`RAMockSession`, `InterviewSession`). Keep and harden them. This is a differentiator.

### 4.13 Human coaching (F-COACH)

#### F-COACH-01 1:1 coaching booking
- **What:** Routes `/coaching`, `/coaching/discover`, `/coaching/bookings`. Sessions are 30 or 60 minutes with "Senior Recruiters" or "Technical Recruiters". A 45-minute returning-member promo exists. The 30-minute session includes live Google Doc resume edits.
- **Flow:**
  1. Diagnose with "Identify Your Job-Search Blocker": first job / applying but hearing nothing / upcoming interview.
  2. Recommended coach card: avatar, seniority, rating to 2 decimals, `Watch Intro`, length options with prices, `Book Now`, "Or Explore Other Options".
  3. Contact info: name, email, phone, LinkedIn.
  4. Session topic (required).
  5. Resume: existing (`Jobright Template` / `Original Version`) or `Upload New Resume`.
  6. "Confirm Your N-min Session with {Coach}" → `Continue to Booking`.
  7. Stripe payment.
  8. Pending until the coach confirms; details sent by email.
- **My Bookings:** statuses Completed / In Progress / Seat confirmed / Up Next. Actions `View Details`, `Book Again`, `Join the Session`, `Cancel`.
- **Scheduling engine (critic pass):** Slot picking is a **Cal.com embed** (`app.cal.com/embed/embed.js`), opened as a modal with prefilled metadata and falling back to a new tab when the embed fails. It listens for booking-success, link-failed and booker-view events. `/coaching/bookings` polls every 5 s and redirects to `/coaching` when the user has no bookings. A coaching-intent questionnaire (`coachingIntent`, with options such as "General Consulting") feeds coach matching. The recommended-coach card has its own dismiss throttle (`coachProfileDismissCount`). C (chunks `44444`, `54642`).
- **Gate:** Paid per session (about $69.99–79.99 per 30 minutes). Turbo has a "claim your session" variant. **Conf:** C (flow) / L (prices). **Ev:** [NTI §5.2].

#### F-COACH-02 Coaching policies
- **What:**
  - Book at least 2 days ahead (the policy says "days" for the booking lead time; the cancellation tiers below use *business* days). The policy page describes the 30-minute session only. It includes a meeting link, a confirmation email, a Google Docs copy of the resume for live edits and an optional follow-up survey.
  - Refund 100% if cancelled ≥2 business days before, 50% at 1–2 business days, 0% inside 1 business day or for a no-show.
  - Joining within 10 minutes keeps the remaining time; after 10 minutes it is a no-show.
  - 2+ no-shows in 60 days can restrict booking.
  - If the coach cancels: reschedule or full refund.
  - A dedicated coach-support email.
- **Gate:** —. **Conf:** C. **Ev:** [NTI §5.2], `/coaching-policy`.

#### F-COACH-03 Deep Dive group sessions
- **What:** Live expert webinars on topics such as resume, SWE interviews, AI/data careers and sponsorship. Limited seats, `Save My Spot` / `Seat confirmed` / `Fully Booked`. A waitlist auto-refunds if no seat opens. The link is sent by email. Tickets are non-refundable. Free-pass promos exist ("Free Pass (1 Left)").
- **Gate:** Paid seat or promo. **Conf:** C. **Ev:** [NTI §5.2].

#### F-COACH-04 Turbo Office Hour
- **What:** A weekly live Q&A (observed Thursdays 6:30 PM PST) with session notes and templates. A registration popup is throttled.
- **Gate:** Turbo. **Conf:** C. **Ev:** [OAE §3.6], [NTI §5.2].

#### F-COACH-05 Coaching upsells
- **What:** "Live Coaching Masterclass", "1 Group Session Free Pass", "The Insider Upgrade" (front of the line), a loyal-member bundle (3 months Turbo + priority support + a session), and a Student Quarterly plan.
- **Gate:** Paid. **Conf:** C. **Ev:** [NTI §5.2].

#### F-COACH-06 Coaching free trial and in-product coach upsell (added in the critic pass)
- **What:**
  - A **coach free-trial** announcement popup for Turbo cohorts (experiment `coach_turbo_group`; key `JR_showCoachFreeTrialPopup_1223`).
  - The control arm instead sees a "1:1 coaching with senior recruiters" announcement.
  - A **coach upsell portal inside the resume tailor** (F-RES-09) for users in the coaching rollout (`showCoaching`).
  - A coaching guide tour (`tourCareerCoachGuideShownV2`).
  - A debug hook (`window.coachingDebug`) resets these on non-production hosts.
- **Clone note (I):** Coaching is sold at the moments of highest anxiety, during tailoring and before interviews. RoboHire.io can offer the same cross-sell to human coaches, or to RoboApply's AI mock interviewer as the cheaper first step.
- **Gate:** Turbo cohorts / paid. **Conf:** C (flags and events) / I (trial length and terms). **Ev:** chunks `10344`, `26242`, `54642`.

### 4.14 Salary and company insights (F-SAL)

| ID | Feature | Gate | Conf | Ev |
|---|---|---|---|---|
| F-SAL-01 | Salary on cards and detail (`salaryDesc`, min/max; `$K/yr` or `$/hr`); minimum-salary filter; Orion salary commands; "Salary too low?" nudge | Free | C | [MJ §7.2], [NTI §6] |
| F-SAL-02 | Market snapshot during onboarding: median salary, top industries, hot skills for the title (`/swan/landing/job/diagnostic`) | Free | C | [ON §6.3] |
| F-SAL-03 | H1B sponsorship history and median salary offered (DOL LCA data) on detail, company tab and JSON-LD | Free | C | [MJ §6.5], [NTI §6] |
| F-SAL-04 | Company funding, stage, unicorn/valuation, top investors, recently-raised tags, Glassdoor rating (Crunchbase-sourced) | Free | C | [MJ §6.5] |
| F-SAL-05 | Proprietary data-report blog posts on salary landscape and hiring trends (content, not a tool) | Public | C | [BGS §8.4] |
| — | **Gap:** no salary benchmark tool, no offer comparison, no negotiation assistant | — | C (absence) | [NTI §6] |

**Clone opportunity (I):** offer fields on the tracker, market benchmarks and an LLM negotiation script. For GoApply, add 职悟空-style "Offer 分析" (offer analysis).

### 4.15 Notifications, alerts and emails (F-NOTIF)

#### F-NOTIF-01 Instant job alerts
- **What:** In settings, `Enable Instant Job Alerts`. Emails about fresh tailored jobs arrive within about 1 hour of posting. **Frequency:** `Off` / `Up to 1/day` / `2/day` / `5/day` / `Unlimited`. Alerts are tied to saved filters. A toast confirms changes.
- **Gate:** Free: 1/day. Turbo: up to unlimited. **Conf:** C. **Ev:** [ON §16], [MJ §13].

#### F-NOTIF-02 Digest alerts
- **What:** `Enable Digest Job Alerts` with `Daily Digest` / `Weekly Digest`. Email lists deep-link through `/jobs/email-list/:id` to `/jobs/recommend?id=`.
- **Gate:** Free. **Conf:** C. **Ev:** [ON §16], [PS §11].

#### F-NOTIF-03 Logged-out job-alert subscription
- **What:** `/tools/job-alert`, 4 steps:
  1. Email.
  2. Resume upload or LinkedIn URL.
  3. Optional job filters.
  4. `Daily Digest` / `Weekly Digest`, then Subscribe.
- No account is needed. These users are funnelled into signup later. A similar form exists on the remote minisite.
- **Gate:** Free. **Conf:** C. **Ev:** [PS §6], [ON §17].

#### F-NOTIF-04 Unsubscribe with reason survey
- **What:** `/tools/job-alert/unsubscribe`. Reasons: recommendations don't match; jobs not relevant; too many emails; already found a job; Other (text). API `/swan/feedback/job-alert/unsub`.
- **Gate:** —. **Conf:** C. **Ev:** [MJ §13].

#### F-NOTIF-05 Transactional emails
- **What:**
  - Verification: account, `.edu`, work email, referral.
  - Password reset.
  - Account-deletion confirmation.
  - Renewal reminders and refund confirmations.
  - Coaching booking, coach cancel, follow-up survey.
  - Deep Dive link and waitlist.
  - Referral sign-up / onboarding-complete notices.
  - Application updates.
  - Interview invitations.
  - Career-agent preference magic links (pausable for 6 months).
  - Employer AI-recruiter outreach ("opentowork").
- **Gate:** —. **Conf:** C. **Ev:** [PS §11], [NTI §7], [ON §17].
- **Unknown:** welcome/drip cadence, trial-expiry and winback cadence.

#### F-NOTIF-06 In-app nudges and offer banners
- **What:**
  - Toasts.
  - Orion proactive bubbles.
  - Agent progress widget.
  - Countdown offers: first-day, weekly trial, winback, holiday ("Your Special offer ends in…").
  - Throttled popups (localStorage timestamps).
  - Rate-limit toasts: refresh, upload, analysis, tailor, email lookup, autofill (30 minutes), import.
- **Gate:** —. **Conf:** C. **Ev:** [ON §11.5, §18], [NTI §7].

#### F-NOTIF-07 Mobile push
- **What:** Instant job alerts as push notifications on iOS and Android. **Known bug:** alert-email links don't open the installed app (a universal-link failure). We should fix this.
- **Gate:** Free. **Conf:** C. **Ev:** [OAE §6.1].

#### F-NOTIF-08 Reminders (gap)
- **What:** No follow-up or interview reminders exist for tracked applications. There is no web push.
- **Clone:** add both.
- **Conf:** C (absence). **Ev:** [NTI §7], [ON §17].

#### F-NOTIF-09 "What's new" announcement popups (added in the critic pass)
- **What:** An in-app update log and feature-announcement modal. A localStorage flag `JR_updateLogPopup_needToShow` marks a pending announcement, the store has `updateLogOpen`, and `update_popup_exposure` / `_close` events are tagged per feature (examples: the coach free trial and the 1:1 coaching launch). It is how Jobright announces launches to existing users.
- **Clone note (I):** Ship a server-driven announcement record per brand, locale and cohort. Show at most one, and respect the shared popup throttle.
- **Gate:** —. **Conf:** C. **Ev:** chunk `10344`, `_app` store.

#### F-NOTIF-10 SMS channel (ToS only) (added in the critic pass)
- **What:** The Terms of Service have an "SMS text messaging" section. Opting in allows account-alert texts and occasional reminders when the user receives an **interview invitation**. Users opt out with STOP, and carrier rates apply. The program name is still a blank placeholder in the ToS, and the privacy notice says SMS opt-in data is never shared for marketing. No phone opt-in UI was found in the bundle apart from the phone field in the invitation reply form (F-NET-09).
- **Conf:** C (legal text) / I (whether it is live). **Ev:** `legal/service` and `legal/privacy` bundles.
- **Clone:** SMS only for OTP and interview logistics (GoApply: OTP only, CN-L-07).

### 4.16 Chrome extension (F-EXT)

#### F-EXT-01 Listing and distribution
- **What:** "Jobright Autofill – Instant Job Applications, Job Match, AI Tailor Resume".
  - **Listing:** `odcnpipkhjegpefkfplmedhmkmmhmoko`, v1.24.0 (2026-10-08), 300K users, 4.9★ from 372 ratings, Featured, 2.72 MiB, English, in-app purchases. **Re-verified 2026-10-09 by the critic pass.** The listing also shows "Follows recommended practices", a support address (support@jobright.ai), an EU **non-trader** declaration (so EU consumer-contract rights do not apply), and the claims of being featured in the ChatGPT plugin store and Product Hunt's #1 Product of the Month (July 2024).
  - **Listing pillars (paraphrased):** one-click autofill, resume keyword matching with an ATS score, an AI resume builder, and a job-match feed with a tracker.
  - **Data disclosures:** PII, user activity, website content.
  - **Permissions:** MV3; `storage`, `tabs`, `cookies`, `activeTab`, `scripting`, broad hosts (L).
  - **Browsers:** Chrome only (Firefox requested by users).
- **Gate:** Free install. **Conf:** C. **Ev:** [OAE §5.1–5.2].

#### F-EXT-02 Autofill side panel
- **What:** A floating right panel over the employer form. It contains:
  - Header and collapse control.
  - Green `Autofill Supported` pill.
  - Job card: logo, title, chips, **match score ring**.
  - `Autofill` button → `Autofilling...`.
  - Application Dashboard: `Completion` % bar and a per-field checklist (Name, Email, Resume/CV, Cover Letter, Experience, LinkedIn Profile, Full Address), each checked, spinning or pending.
- It fills EEO, veteran, citizenship and pronoun fields and remembers dates. The **user reviews and submits.**
- **Known issue:** clicking the toolbar icon sometimes gives no feedback.
- **Gate:** Free(4/d). Turbo unlimited. **Conf:** C. **Ev:** [OAE §5.3, §5.5].

#### F-EXT-03 ATS coverage and site requests
- **What:** Named platforms: Workday, Greenhouse, Lever, iCIMS, Ashby, Workable (Jobvite on one page). The claim is about 90% of major ATSs. Users can **request support for a site** from inside the extension. Field reports: Greenhouse and Lever are good; Workday sometimes leaves custom questions blank; custom portals mis-fill.
- **Gate:** —. **Conf:** C. **Ev:** [OAE §5.4], [RS §15].
- **Clone:** add SmartRecruiters, Taleo and SuccessFactors.

#### F-EXT-04 AI answers to application questions
- **What:** Pre-fills free-text questions (e.g. why are you applying) with editable AI text. The answer bank is the Common Application Questions set, synced from the profile and Agent. There is confusion on non-US salary and currency questions.
- **Gate:** Autofill credit. **Conf:** C/L. **Ev:** [OAE §5.5].

#### F-EXT-05 Tailored resume attached during autofill
- **What:** Generates a tailored resume in under a minute and uploads it as `Name_Company_Role.pdf`. Resume matching shows missing keywords and an ATS score.
- **Known issue:** the template swap happened without notice (one page became two). Our clone must show a final preview and record exactly which file was sent.
- **Gate:** Resume and autofill credits. **Conf:** C. **Ev:** [OAE §5.6].

#### F-EXT-06 Match score on other job boards
- **What:** Shows a match score while the user browses LinkedIn or other boards. It can differ from the in-app score.
- **Gate:** Free. **Conf:** L (single secondary source). **Ev:** [OAE §5.7].
- **Clone:** use one scoring service for both so scores never diverge.

#### F-EXT-07 Install hand-off, detection and versioning
- **What:**
  - The web app detects the extension ("Extension Not Detected", "not installed", "isn't the correct version").
  - Re-check with `I've installed it`.
  - Install attribution through postMessage `jobright:autofill-install-attribution-*`. Only `job_apply_popup` may create a hand-off.
  - Activation: click `Start Applying` inside the extension.
  - Profile sync through the session cookie (I).
- **Gate:** —. **Conf:** C. **Ev:** [ON §13], [OAE §5.10].

#### F-EXT-08 Uninstall exit survey
- **What:** `/autofill/uninstall`, 8 reasons:
  1. Didn't work on my platforms.
  2. Filled incorrect info.
  3. Too slow.
  4. Not enough daily credits.
  5. Didn't know how to start.
  6. Pop-up too frequent.
  7. Not enough matching jobs.
  8. Found a job.
- **Gate:** —. **Conf:** C. **Ev:** [ON §13].

#### F-EXT-09 Save a job from other sites (unconfirmed)
- **What:** The listing pitches "Smart Job Match & Tracker", but no source confirms a one-click save button on LinkedIn or Indeed.
- **Conf:** I. **Ev:** [OAE §5.8].
- **Clone:** build it. Its feed is the External tab (F-TRK-04).

### 4.17 Mobile (F-MOB)

| ID | Feature | Details | Gate | Conf | Ev |
|---|---|---|---|---|---|
| F-MOB-01 | iOS app | "Jobright - AI Job Search" id6738236788. iPhone only. 4.8★ from 1.6K ratings. v1.15.0. Feed, 0–100 score, insider hints, instant push alerts, tracker, multiple resumes with Primary, resume analysis with a strengths/gaps report (1.9.0), dark mode (1.10.0). US roles only. Probably supports in-app purchase (refund policy mentions store purchases). | Free core; premium labelled | C | [OAE §6.1] |
| F-MOB-02 | Android app | `ai.jobright.orion`. 4.6★ from 719 reviews. 50K+ downloads. Updated 2026-08-21. Reviewable Orion filter updates and better location autocomplete. Steps: profile → feed → auto-apply or fine-tune → track and schedule interviews. | Free core; Turbo in-app | C | [OAE §6.2] |
| F-MOB-03 | Mobile web prompts | Smart `Install` banner; "Get the Jobright App!" modal; bottom nav `Jobs · Profile · Resume · Interview`; job detail in a drawer | Free | C | [ON §11.5, §19] |
| F-MOB-04 | Desktop-only gates | Resume Analysis and Custom Resume are blocked on mobile ("Visit Jobright on PC"); the extension is desktop-only; some offers say "Unlock Your Offer on Computer"; invitations say "Full Invitation on Desktop" | — | C | [RS §4], [ON §19] |
| F-MOB-05 | Unknowns | Whether Orion chat and Agent controls exist in the native apps; native onboarding screens | — | I | [OAE §6.3] |
| F-MOB-06 | Store facts re-verified (critic pass) | **iOS** (iTunes lookup, 2026-10-09): first released 2025-01-13; v1.15.0 shipped 2026-07-20 with generic notes; 4.82★ from **1,572** ratings; English only; iOS 13+; 4+ rating; Business category; about 64 MB; no iPad screenshots (iPhone layout). Store FAQ: the 0–100 score compares skills, experience **and salary range**; only employers the user applies to, or chooses to share with, can see the profile; the feed refreshes every few minutes. **Android** (Play, updated 2026-08-21): 4.6★, 719 reviews, 50K+ installs. Data safety says it may share personal info, app info and performance data, and device IDs with third parties; data is encrypted in transit; deletion can be requested. Developer replies to reviews (for example, promising better nearby-job search). | — | C | App Store lookup API; Google Play listing |

**Clone note (I):** Build responsive layouts rather than desktop gates. GoApply needs a WeChat mini program as its primary mobile surface.

### 4.18 Account, profile and settings (F-ACCT)

#### F-ACCT-01 Authentication
- **What:**
  - Sign up / sign in with Google (ID token), email + password (≥8 characters with letters and digits), and Apple (component).
  - Sign-in modal with `Sign in with Google`, email/password, "Not a member? Sign up now".
  - Logout.
  - Endpoints `/swan/auth/{register/pwd-v3, register/sso-v3, login/pwd, login/sso, login/apple, logout}`.
- **Gate:** Free. **Conf:** C. **Ev:** [ON §2, §4].

#### F-ACCT-02 Password reset and verification flows
- **What:**
  - `/reset-password` (forget/reset).
  - Email verification: `/email-verification`, `/verify-email/[code]`. States: verified, already verified, expired (auto-resend), invalid, "return to the device you signed up on".
  - Student `.edu` verification unlocks the Student Turbo price.
  - Work-email verification.
- **Gate:** Free. **Conf:** C. **Ev:** [ON §4.7].

#### F-ACCT-03 Profile page and completion wizard
- **What:** `/jobs/profile`. Sections:
  - **Personal:** first, middle, last name; email; phone type (Home/Mobile/Work/Other) and country code; phone; address line, country, state, city (required), county, postal code (autocomplete via `/swan/address/*`); LinkedIn, GitHub and Portfolio URLs.
  - **Education** (repeatable): school (logo autocomplete), major, degree type, GPA, start/end YYYY-MM, `I currently study here`; end date ≥ start date.
  - **Work** (repeatable): title, company (autocomplete), job type (all required), location, dates, `I currently work here`, summary or bullets.
  - **Skills:** grouped editor.
  - **Equal Employment** (F-ACCT-04).
  - **Verified Work Experience.**
  - **Others:** common application questions.
  - Resume and LinkedIn block.
  - Airtable resume-template galleries (about 20 functions).
- The wizard steps are in S10.
- **Gate:** Free. **Conf:** C. **Ev:** [ON §12], [PS §10.9].

#### F-ACCT-04 Equal Employment (EEO) answers
- **What:** Button radios:
  - Authorized to work in the US.
  - Sponsorship now or later.
  - Disability.
  - Veteran.
  - Gender (M / F / non-binary / decline).
  - LGBTQ+.
  - Race (8 options including Two or More and Decline).
  - Hispanic/Latino.
  - Sexual orientation (multi).
  - Pronouns (He/Him, She/Her, They/Them, self-describe, prefer not).
- Copy says these are used only for autofill.
- **Gate:** Free. **Conf:** C. **Ev:** [ON §12.7].
- **Clone:** market-specific. Remove for CN. For TW and EU, use the local equivalents only.

#### F-ACCT-05 Settings page
- **What:** `/settings` sections:
  - Login & Security (password).
  - Subscriptions (F-BILL-03).
  - Interview Passes.
  - Job Alerts (F-NOTIF-01/02).
  - Email Providers (F-AGENT-09).
  - Easy Apply, resume and user extra config preferences.
  - Privacy link.
  - `Log Out`.
  - `Delete my account` (F-ACCT-06).
- API: `/swan/user-settings/{get,save}`.
- **Tab enum (critic pass):** `LOGIN`, `SUBSCRIPTION`, `INTERVIEW_PASS`, `JOB_ALERT`, `EMAIL`.
  - Instant-alert frequency values are `NONE=0`, `1_ALERT_A_DAY=1`, `2_ALERTS_A_DAY=2`, `5_ALERTS_A_DAY=5`, `UNLIMITED=100`. The labels read "Up to N alerts /day" and "Unlimited".
  - Turning the toggle on sets 1/day. The save toast confirms the new frequency.
  - Digest frequency is `DAILY` (default) or `WEEKLY`.
  - Many per-user UI states (tours, dismissals, missions, offer timestamps) are stored server-side in a settings `extraConfigMap`, so they follow the user across devices.
- **Gate:** Free. **Conf:** C. **Ev:** [ON §16], [PS §10.13], `_app` and `settings` bundles.

#### F-ACCT-06 Delete account
- **What:** A confirmation modal warns the deletion is irreversible and removes the profile, matches and settings. A confirmation email follows. API `/swan/auth/cancel-account`.
- **Gate:** Free. **Conf:** C. **Ev:** [ON §16].

#### F-ACCT-07 Candidate preferences page for passive candidates (magic link)
- **What:** `/candidate-preferences` works logged out through an emailed link ("Email me a link" with a resend timer). Title: "Manage job preferences". A "Career agent is thinking" state.
- **Fields:**
  - Status: Actively looking / Open to the right role / Not looking (→ `Pause for 6 months`).
  - Target roles.
  - Where willing to be based (US-wide, city, IP-suggested).
  - Work model.
  - Minimum base salary or decline.
  - Visa sponsorship: not needed / will need.
  - Company stage: Early 1–20, Growth 20–500, Late 500+, Public, or no preference.
  - Dream role (free text).
  - What matters most.
  - Roles or companies to avoid.
  - `Hide me from {current employer}`.
  - Optional resume ≤10MB.
- **Outcomes:** emails paused, or "Create a free account" with preferences carried over.
- **Purpose:** candidate-side endpoint of the employer AI recruiter loop (I).
- **Gate:** Free. **Conf:** C (strings) / I (purpose). **Ev:** [PS §10.12].

### 4.19 Billing, credits and offers (F-BILL)

| ID | Feature | Details | Gate | Conf | Ev |
|---|---|---|---|---|---|
| F-BILL-01 | Typed daily credits | Buckets `TAILOR`, `AUTOFILL`, `EMAIL`, easy-apply, "base resume" (analysis), cover letter. Each has a `dailyFill` cap and refills at midnight with no rollover. Notice before spending ("1 … credit will be used"). Out-of-credit modal: `Go Unlimited` / `Free Daily Refill` / proceed without. Counter "N available today". APIs `/swan/credit/{balance-v2, free}`. | — | C | [RS §11], [OAE §4.6] |
| F-BILL-02 | Turbo plan picker | Weekly, Monthly (default; anchor price struck through), Quarterly ("Most Popular", "Save 40%", "less than $1 a day"), 6-Month, Student. Badges "New User Exclusive" / "Loyal Member Exclusive". Price groups GroupA–G (A/B). Stripe checkout. Shown only in-app (no public page). | Paid | C (names) / L (prices) | [ON §18], [BGS §4] |
| F-BILL-03 | Subscription management | Current plan, price, renewal date, `Manage Subscription`, `Switch Plan`, `Unsubscribe` (exit survey → unsub offer), Stripe billing portal, "Not seeing your updated subscription?" refresh. Critic pass: a **payment-failed** state in the client store (`isPaymentFailed`, a dunning prompt, I); a dedicated weekly-plan unsubscribe call (`unsubWeeklyPlan`); and a separate "specials" unsubscribe popup. App-store purchases are cancelled and refunded through the store | Paid | C | [ON §16], `_app` store |
| F-BILL-04 | First-day new-user offer | Card "Turbo • New User Discount", value carousel, `Offer Ends in mm:ss`, `Upgrade Now`. Suppressed after a ToB direct apply or a failed true apply. `/swan/payment/first-day-offer` | Offer | C | [ON §18] |
| F-BILL-05 | One-time 7-day weekly trial | "Try Turbo for 7 days" at a discount; logos of companies where Turbo users interviewed; testimonials; countdown; renews monthly or quarterly. `trial-offer`. Offer-gated, not public | Offer | C | [ON §18] |
| F-BILL-06 | Winback, unsubscribe save and cancel retention | `winback-offer` ("A Special Offer to Restart Turbo"), `unsub-offer` (discount at cancel), `tg-offer`, `cancel-support-popup-eligibility`. Cancel-retention modal lists lost benefits (insider connections, coaching, etc.) | Offer | C | [PS §5], [NTI §9] |
| F-BILL-07 | Upgrade touchpoints | Credit exhaustion; Hidden Jobs; Agent; Interview bank; Coaching; 2nd saved filter or alert; LinkedIn full report; plan badge `Get Unlimited Credits` | — | L | [BGS §4.4] |
| F-BILL-08 | Refund policy | First purchase: 7 days (monthly / quarterly / 6-month), 24 h (weekly); 3 days for an accidental renewal; prorated refunds discretionary; app-store purchases follow store policy. **Re-verified in the 2026-10-09 bundle (critic pass), with more rules:** eligibility can be cut for substantial Turbo use, a consumed coaching session or a prior refund. No refund for missing job outcomes or for disliking AI output that was delivered. Prorated refunds are generally not offered on Weekly. Billing errors and long outages can be resolved with a refund, account credit or service extension. Refunds take 5–10 business days. A full refund may end access immediately. Discounted purchases are refunded at the amount paid. Users are asked not to file a chargeback while a request is open | — | C (`/legal/refund` bundle, 2026-10-09) | [PS §5] |
| F-BILL-09 | Plan/SKU catalog in code (critic pass) | Plan types `week`, `month`, `quarter`, `semiannual`, `student`. SKUs: `weekly`, `monthly`, `oldUserDiscountedMonthly`, `newUserDiscountedMonthly`, `quarterly`, `semiannualExp1/Exp2`, `studentMonthly`, `studentQuarterly`, `studentSemiannualExp1/Exp2`, plus price-cohort variants (`*1030_1`, `*1030_2`, `*1231`). Experiments `turbo_6month_exp`, `quarterly_student`. So the **Student plan exists monthly, quarterly and 6-monthly**, and the 6-month plan is an A/B with two price arms. A Student popup and reminder are driven by `.edu` verification state (`isUnVerifiedStudent`, `hasStudentPrice`) | — | C (enums) / I (prices) | `_app` bundle |
| F-BILL-10 | In-subscription upsell and retention engine (critic pass) | (a) **Quarterly switch:** an auto-prompt to move an active subscriber to Quarterly, shown once when the subscription is more than 7 days old (`quarterlySwitchExp4`). (b) **Turbo retention popup** for subscribers active more than 21 days (flag `turbo_retention_group_popup`, with copy variants and user tags; also an Orion card `TURBO_POPUP_RETENTION`). (c) **`tg-offer`** with **LLM-personalized offer copy**: the response's `turboPopupCopy` is marked `personalized_ai`, `generic_ai` or `static_fallback`, and an eligibility check runs first (`/swan/payment/tg-offer/check`). (d) Pricing exit-intent offer (`pricingExitOfferPopupLastShownAt`). (e) Holiday popup (Thanksgiving). (f) Top-bar special-offer and upgrade-bar tag experiments. All are throttled through settings timestamps | Offer | C (flags, endpoints, events) / I (copy) | chunk `10344`, `_app` |
| F-BILL-11 | Checkout terms, coupons and balance (critic pass) | Checkout shows price, period, renewal, taxes and total; the amount may be shown and charged in **local currency**. Wallets and other methods vary by country and device. **Coupons** can be applied at checkout: time-limited, one per purchase, no cash value. The Terms of Sale promise a **pre-renewal reminder** with cancel instructions. Price changes apply only at a future renewal, with notice where the law requires it. Jobright Balance (Stripe customer balance) holds referral rewards *and* refunds or compensation, and applies automatically to eligible invoices | Paid | C (`legal/service`, `legal/sales` bundles) | — |

**Clone notes (I):**
- Publish a public pricing page.
- Send a pre-renewal reminder email.
- Offer one-click cancel.
- Make credits server-configured per brand.
- RoboApply already has currency-aware payments and Alipay callbacks (recent commits).

### 4.20 Free public tools (F-TOOL)

| ID | Tool | Works before signup? | Details | Conf | Ev |
|---|---|---|---|---|---|
| F-TOOL-01 | `/tools` hub plus templated SEO tool landing pages | No (lander → signup) | Pages: resume-summary-generator, bullet-point-generator, headline-generator, parser, helper, tailor, fixer, checker, rewriter, matcher→`resume-job-matcher`, grammar-checker, maker, ats-score-checker, check-your-resume-score, cover-letter-generator, job-clipper, job-tracker, ai-job-assistant, grad-jobs; plus `/ai-resume-builder`, `/ats-resume-builder`. One template: hero CTA, stats, 3 features, "why us" grid, testimonials, 4 steps, 3-question FAQ (answers in JS), Related Tools. No public LinkedIn optimizer (404) | C | [PS §6], [RS §2] |
| F-TOOL-02 | ATS Resume Checker | **Likely yes** | Upload a resume plus a target job → ATS readability plus keyword / skill / experience gaps. Endpoints `upload-by-landing-diagnose`, `landing/diagnose-report`, `light-diagnose`. 9-question FAQ with FAQPage JSON-LD. Copy is compliance-flavoured (no universal ATS score; add only truthful keywords) | C (endpoints) / I (pre-signup) | [PS §4.5], [RS §2] |
| F-TOOL-03 | Resume–Job Matcher | Possibly | `See My Resume Match`. 6 report factors: overall match, experience and seniority, skills, industry, keyword gaps, why it fits | I | [RS §2] |
| F-TOOL-04 | Job Alert form | **Yes** | See F-NOTIF-03 | C | [PS §6] |
| F-TOOL-05 | Grad Jobs | Yes (list) | New-grad clone of the homepage | C | [PS §6] |

**Clone note (I):** Make 1–2 tools genuinely work without login (an instant ATS check and resume–JD match) as a differentiator. Keep the lander template for long-tail keywords.

### 4.21 SEO and programmatic pages (F-SEO)

| ID | Page type | Template / scale | Conf | Ev |
|---|---|---|---|---|
| F-SEO-01 | Role taxonomy hub | `/jobs/{role}` × 379 roles (tech and non-tech) | C | [PS §2], [BGS §8.2] |
| F-SEO-02 | Role × city | `/jobs/{role}-in-{city-st}` × 11 US metros = 4,169 (sitemap total 4,548) | C | [PS §2] |
| F-SEO-03 | Keyword search landings | `/jobs/{kw}-jobs-in-{place}`. Open-ended long tail; not in the sitemap; linked from "Popular Job Lists" | C/L | [PS §2], [BGS §8.2] |
| F-SEO-04 | H1B role × city lists | `/jobs/h1b-visa-sponsored-{role}-jobs-in-{city-st}`; `/h1b-jobs` hub | C | [BGS §8.2] |
| F-SEO-05 | Indexable job detail | `/jobs/info/{id}` (~8M; `b2b_` ids). JSON-LD; not in sitemap; reached through internal links; AI crawlers blocked | C/L | [PS §2], [MJ §6.7] |
| F-SEO-06 | Remote minisite | `/remote-jobs` + 12 categories with role children; live total and new-today counters; hourly updates; alert subscribe; no login wall; own nav | C | [PS §2], [BGS §8.2] |
| F-SEO-07 | Segment and campaign hubs | `/entry-level-jobs`, `/intern-jobs`, `/new-grad-jobs`, `/top-jobs` (curated alerts: Founding Roles, Lightspeed Growth, Established Leaders), `/SWE-intern`, `/data-science`, `/marketing-jobs` (industry tabs and table filter), `/remote-jobs-usa`; emoji category tabs; total and new counters; `-video` paid-ad variants | C | [PS §4.5] |
| F-SEO-08 | Competitor compare pages | `/compare/{11}`. Template: hero, rating vs rating, bottom line, side-by-side mock, **20-row feature table** (Appendix B), why choose, verdict, FAQ, "Updated May 2026" | C | [PS §4.5], [BGS §8.2] |
| F-SEO-09 | Blog | WordPress, about 211–247 posts, 12 categories. Clusters: LinkedIn/Indeed how-tos, competitor reviews, ChatGPT prompts, big-tech interview guides, H1B, remote/side jobs, proprietary data reports, brand defence. Medium mirror | C | [BGS §8.4] |
| F-SEO-10 | Crawl policy | Sitemap index of 7 children; robots blocks app routes, `/swan`, `/legal`; **blocks ClaudeBot/GPTBot from `/jobs/`** and Bytespider entirely; bot challenge on job pages | C | [BGS §8.3] |
| F-SEO-11 | GitHub job-list repos | 36 repos, updated hourly by a bot (new-grad and intern lists × ~17 categories; H1B list). Rows link to job pages with UTM; only the last 7 days are shown, pointing to a satellite site for more | C | [BGS §7] |
| F-SEO-12 | Satellite list domains | newgrad-jobs.com, intern-list.com, entrylevel-jobs.com, careerin.ai: hourly lists, US/CA toggle, alerts, cross-links | C | [BGS §7] |

**Clone notes (I):**
- RoboHire.io: hreflang per locale. TW cities: Taipei, Hsinchu, Taichung, Kaohsiung. Visa-sponsorship lists per country.
- GoApply: Baidu SEO, a 校招 calendar per company, campus lists on 牛客 / WeChat 公众号 instead of GitHub.
- Never copy Jobright's static counters.

### 4.22 Referral and growth (F-GROW)

| ID | Feature | Details | Gate | Conf | Ev |
|---|---|---|---|---|---|
| F-GROW-01 | Refer & Earn | Sidebar `Refer & Earn` → `Invite Friends`; link `/s/{code}`. Inviter earns $3 per qualified referral in a non-withdrawable balance (Stripe customer balance applied to the next invoice), capped at 10 / $30. Invitee gets $3 once. Qualifies after verified email + completed onboarding + risk review (device / IP / payment). Statuses Pending, Failed-Retrying, Pending Review; 0–10 progress meter. Email verification is required before the link is shown. **Critic-pass corrections (from `/referral-policy`):** Google, Apple and other SSO invitees count as already verified; only email-and-password invitees must verify. Re-registering after deletion cannot earn the invitee reward again (checked against the normalized email). The invitee still gets $3 even when the inviter has used all 10 slots. Pending rewards show separately (for example, "$3 Pending") until written to Stripe. Abuse cancels both rewards and frees the slot. Client states `inviteeGateStatus` and `inviteeVerifyPopupOpen` gate the invitee's reward on verification | Any user | C | [PS §5], [NTI §8], `referral-policy` bundle |
| F-GROW-02 | LinkedIn post reward | Prefilled testimonial post earns 5 days of Turbo (one per user, activated within 48 h) | Any user | C (earlier variant) | [NTI §8] |
| F-GROW-03 | Attribution plumbing | `from`, `inviteCode` / `inviter_id`, numeric `utm_source`, `retarget`, imp_ids; acquisition survey (S7) | — | C | [ON §3], [BGS §6] |
| F-GROW-04 | Review-velocity prompts | Trustpilot invite after "Yes, I applied" (60-day cooldown); ratings reused on landing and compare pages | — | C | [MJ §8.4], [BGS §7] |
| F-GROW-05 | New-user missions | Checklist with progress %: Customize Your Resume, Enable Autofill Extension → chance to win a 30-minute 1:1 coaching session | Free | C | [NTI §5.2] |
| F-GROW-06 | Custom GPTs | Resume and Interview Pro GPTs in the GPT Store; "featured by OpenAI" badge | — | C | [BGS §7] |
| F-GROW-07 | Job-list rating with feedback-call offer | Marketing list pages: 1–5 rating; ≤3 opens improvement chips; offer of a gift card for a 10-minute feedback call | Public | C | [MJ §8.5] |
| F-GROW-08 | Referral-partner API intake (critic pass) | The privacy notice says Jobright receives users from "authorized third-party referral partners", which it describes as AI tools and services that integrate by API and pass data for routing and attribution. Together with `/swan/lensa/{decode,save}` and the Appcast/ZipRecruiter conversion pixels, this shows a **partner-traffic network**: job boards and AI tools hand off seekers with a prefilled profile. No public developer API or MCP server was found (`api.jobright.ai` answers, but nothing is documented) | Partner | C (policy) / I (partners) | `legal/privacy` bundle; [ON §3] |
| F-GROW-09 | Product Hunt and social proof | Launched on Product Hunt in July 2024 and claims #1 Product of the Week and of the Month there. The claim is reused on the extension listing and badges | — | C (own blog, CWS) | Jobright blog; CWS |
| F-GROW-10 | Developer reviews and replies | Jobright replies publicly to Play Store reviews and also prompts Trustpilot reviews after an apply (F-GROW-04). Clone: route store reviews into the support queue | — | C | Google Play listing |

### 4.23 Trust, safety and abuse (F-TRUST)

| ID | Feature | Details | Conf | Ev |
|---|---|---|---|---|
| F-TRUST-01 | Security page and account safety | Private profiles, suspicious-login alerts, encryption at rest and in transit, scam education, employer 2-step verification; SOC 2 (Dec 2025) | C | [PS §4.5], [BGS §2] |
| F-TRUST-02 | Bot challenge on job pages | `/_jr/security/challenge` interstitial (Cloudflare-style) after about 6 fetches | C | [PS §0], [MJ §0] |
| F-TRUST-03 | Rate limits | Feed refresh (43004), daily upload, hourly analysis, hourly/daily tailor, hourly email lookup, autofill 30-minute wait, import 1 h / 7 d, voice chat, LinkedIn report recheck; 7-day ToS suspension notice | C | [ON §18], [PS §16] |
| F-TRUST-04 | Scam and quality controls | Report Issue → staffing-agency exclusion; "Tired of scam jobs?" nudge; claims to remove fake or stale listings (reviewers dispute this) | C/L | [MJ §8.3, §10] |
| F-TRUST-05 | Honesty disclaimers | Email accuracy not guaranteed; past H1B no guarantee; coaching no guarantee; score is a decision aid | C | [NTI §10] |
| F-TRUST-06 | Privacy notice commitments (critic pass) | AI processors are named: OpenAI, Anthropic, Google Cloud AI, AWS AI. Sharing categories include payment, auth, sales and marketing tools, anti-abuse, email and helpdesk, CDN, employer ATS integrations, AI processors, B2B contact and firmographic data partners, employers (anonymized until the candidate applies, accepts or opts into visibility), and ad networks. **Gmail is read only to find ATS verification codes** for an application the user started; no other email content is used. Data is kept **no longer than 6 months after account termination**. Not aimed at under-18s. EEA/UK transfers use SCCs, and GDPR legal bases are listed. Rights are explained for about 20 U.S. states. Do-Not-Track is not honoured. Employer-uploaded candidate data is processed as a processor. Third-party ad pixels are allowed | C | `legal/privacy` bundle |
| F-TRUST-07 | Support channels (critic pass) | **No help-center site** (`help.`/`support.`/`docs.` subdomains do not resolve, though one string still mentions a "Help Center"). Support goes through support@jobright.ai and an in-account support option. Coaching has coachsupport@jobright.ai; privacy requests go to legal@ or contact@. Vulnerabilities are reported to support@. The security page *advises* 2FA but offers it only to employers (2-step team logins and role-based dashboards); there is no seeker 2FA | C | `security`, `legal/*` bundles; DNS probe |
| F-TRUST-08 | Terms of Service guardrails (critic pass) | Jobright says it supplies software only and is not an employer or staffing agency. Seekers must keep information truthful and **authorize sharing application materials with employers for roles they apply to or opt into**. Seekers may not scrape. Users may link third-party accounts, including by giving credentials. Individual arbitration with a class-action waiver and a 1-year claim limit. The ToS has **no Agent- or auto-submit-specific consent clause** (partly answers open question 11) | C | `legal/service` bundle |

### 4.24 Employer side (F-B2B), reference only, not in the seeker clone scope

| ID | Feature | Details | Conf | Ev |
|---|---|---|---|---|
| F-B2B-01 | AI Recruiter | business.jobright.ai. Plan → Source → Verify → Evaluate → Outreach. $499 per recruiter (one active role) per month; 2-week / 1-role free trial; annual "talk to us". Sources from about 3M own users plus about 200M external profiles; outreach sent under the Jobright brand; 10–20 candidates a week; Ashby/Greenhouse/Lever sync | C | [BGS §5] |
| F-B2B-02 | Fake-candidate detection extension | Free; runs inside Greenhouse/Ashby/Workday/Bullhorn/Lever; 230+ signals; red/green report | C | [BGS §3] |
| F-B2B-03 | TNT two-sided network | See F-NET-08; claims 200K talent, 150+ startups | C | [PS §4.5] |

**Note (I):** the RoboHire recruiter product (a sister product) already covers this space. F-ACCT-07, F-NET-08/09 and F-INT-05 form the **seeker-side half** of the loop and should connect to RoboHire's recruiter side.

---

## 5. Pricing and plans

### 5.1 Plan ladder (canonical, latest evidence; Aug–Oct 2026)

| Plan | Price (USD) | Display | Conf | Notes |
|---|---|---|---|---|
| Free | $0 | "Free forever", daily credits | L | Not a trial |
| Turbo Weekly | **$17.99 / wk** | No anchor | L | 24 h refund window |
| Turbo Monthly | **$39.99 / mo** | Struck-through $49.99, "Save 20%", default selection | L | Was $29.99 in 2025 to early 2026 |
| Turbo Quarterly | **$89.98–89.99 / 3 mo** | Struck-through $149.97, "Save 40%", "Most Popular"; "less than $1 a day" | L | Since about Sep–Oct 2026 it includes interview-bank access ("9k+ questions") |
| Turbo 6-Month | Unknown | — | C (exists in refund policy and ToS; SKUs `semiannualExp1/Exp2` from experiment `turbo_6month_exp`) | Cohort-gated A/B with two price arms |
| Student | Unknown | `.edu` verification; Student Monthly, Quarterly and 6-Month SKUs (`studentMonthly`, `studentQuarterly`, `studentSemiannualExp1/2`; experiment `quarterly_student`) | C (exists) | Not advertised publicly |
| Discounted Monthly | Unknown | `newUserDiscountedMonthly` (first-day offer) and `oldUserDiscountedMonthly` (winback) SKUs | C (enum) | Offer-only |
| Interview Company Pass | $19.99 / 7 days | One-time, no auto-renew | L | Add-on |
| Interview All-Access Pass | $39.99 / 30 days | One-time | L | Add-on; pro-rata upgrade credit |
| 1:1 coaching | ~$69.99–79.99 / 30 minutes | Per session | L | Policies in F-COACH-02 |
| Deep Dive seat | Unknown | Per seat, non-refundable | C | Free-pass promos |
| Agent waitlist skip | Unknown | → Turbo checkout | C (Aug 2026) | Probably retired (X-07) |

Older ladder: $14.99/wk, $29.99/mo, $69.99/qtr (early 2026). Earlier still: Plus $29 / Premium $59 (2024–25). Price groups GroupA–G suggest live A/B pricing. [BGS §4.1], [ON §18], [RS §11]

### 5.2 Free vs Turbo limits (canonical)

| Capability | Free | Turbo | Conf |
|---|---|---|---|
| Feed, match scores, tags, all filters (incl. H1B), company insights, tracker, external import | ✓ | ✓ | L |
| Orion chat | Unlimited | Unlimited | L |
| AI custom (tailored) resume | **2/day** | Unlimited | C (refill text) / L (number) |
| AI resume enhancement (analysis-fix) | **1/day**, plus base-resume analysis credits | Unlimited | C |
| Autofill (extension) | **4/day** (reports range 1–4) | Unlimited | L |
| Cover letter | **2/day** | Unlimited | L |
| Email lookup / insider email | **2/day** | Unlimited | C |
| Easy Apply | Single, credit-metered | Unlimited + multi-apply | C |
| Saved filters | **1** | Unlimited | C/L |
| Instant job alerts | **1/day** | Up to unlimited (1/2/5/∞) | C |
| Hidden Jobs filter | ✗ | ✓ | L |
| AI Agent | Limited access | Unlimited | L |
| LinkedIn Profile Report | Preview | Full report + recheck | C |
| Insider connection cards | Partly blurred | Full | C |
| Resume slots | 5 | 5 | C |
| Interview bank | Preview | Quarterly only; otherwise passes | C/L |
| Live coaching | Missions raffle only | Weekly Office Hour + claim variant; 1:1 still sold | C/L |

Credits reset at midnight and do not roll over. Referral can top up credits (earlier variant). All numbers must be **server-configured per brand and plan** (they vary by A/B test and over time).

### 5.3 Recommended clone pricing (I, for decision)

- **RoboHire.io:**
  - Mirror the market ladder: $17.99 / $39.99 / $89.99, plus a 6-month SKU.
  - Publish the pricing page.
  - TWD pricing for Taiwan; Stripe on the international stack.
  - Passes and coaching as add-ons.
- **GoApply.Top:**
  - A free core to match 职悟空.
  - CNY weekly SKUs tied to 秋招/春招.
  - WeChat Pay / Alipay; iOS mini-program IAP at 15%.
  - No seeker deposits; publish the fee schedule.
  - Gated on the operating ICP licence (CN-L-03).

---

## 6. China market (GoApply.Top) deltas and Taiwan notes

### 6.1 Launch-gating requirements (P0) [CN §1, §9] L/C

| ID | Requirement |
|---|---|
| CN-L-01 | A mainland operating entity. Decide whether to operate under GoHire's entity (if licensed) or a new one. Check the cap table: a PRC-HQ majority owner could cost the **international** brand its Anthropic access. |
| CN-L-02 | ICP filing for goapply.top, after re-verifying that .top can be filed following the 2026 IANA sponsor change (fallback goapply.cn). Plus a 公安备案. |
| CN-L-03 | **Operating ICP licence (经营性ICP)** before charging any user. |
| CN-L-04 | **人力资源服务许可证 with 网络招聘 scope** before showing, recommending or forwarding jobs. Alternative: route inventory through a licensed partner (GoHire), or ship a seeker-tools-only mode. |
| CN-L-05 | Generative-AI 登记 with the local CAC. Show model names and filing numbers in the product. Algorithm filing for the recommendation feed if counsel advises. |
| CN-L-06 | Mini-program and app 备案. |
| CN-L-07 | SMS enterprise signature (7–10 working days). OTP-only texts with **no links**. |
| CN-L-08 | WeChat Open Platform verification; WeChat Pay and Alipay merchant accounts. |
| CN-L-09 | Privacy policy, user agreement, AI-labelling terms, PIA, data inventory. |
| CN-E-01 | A separate mainland deployment (Aliyun or Tencent, Shanghai or Beijing) with a CN Postgres and object storage. **No Vercel, Neon us-east-1, OpenRouter or Anthropic in the GoApply data path.** A brand guard hard-fails on any non-CN endpoint. |
| CN-E-02 | Self-hosted fonts and assets (Inter and Instrument Sans are currently on Google Fonts). No overseas analytics or CDNs. IPv6. |
| CN-E-03 | Per-brand model routing (the CN equivalent of `RA_MODEL_*`) to DeepSeek V4, Qwen3.x, Doubao Seed 2.0, GLM-5.x or Kimi through OpenAI-compatible clients. Pin snapshots; run a startup probe (`verify:llm`); schedule batch work off-peak; watch reasoning-token budgets. |
| CN-E-04 | Footer: ICP, 公安备案, HR licence and AI model disclosure. |
| CN-E-05 | GoHire bank over a private network with **TLS** (currently `sslmode=disable` over the public internet). RAJob gets source attribution, expiry and pay-missing flags. |
| CN-E-06 | `VoiceSessionProvider` seam. Path A: self-hosted LiveKit on an ICP domain (TURN/TLS:443) with Paraformer/Doubao ASR, Qwen/DeepSeek/Doubao LLM and CosyVoice/Doubao TTS. Path B: Volcano RTC or TRTC conversational AI. Use a **distinct agent name** per product. |
| CN-E-07 | AI-content labelling: an in-app marker, implicit metadata in PDF/DOCX, and 6-month logs for unlabelled export (needs a product and legal decision). |
| CN-E-08 | An anti-fraud classifier for 招转培, 培训贷, MLM and scams, with evidence retention and a blacklist. Ranking never boosts unverified postings. |

### 6.2 Feature-level deltas (Jobright → GoApply)

| Area | Jobright (international pattern) | GoApply.Top requirement |
|---|---|---|
| Auth (F-ACCT-01) | Google, email, Apple | **Phone + SMS OTP** (real-name); WeChat web QR plus mini-program phone quick-verify, with a fallback when the phone-verify balance runs out; no Google |
| Consent (S0) | Pre-checked marketing opt-in | Privacy + agreement, then **separate consent** for AI resume parsing and sensitive fields. Optional toggles for personalised recommendations (with an off switch), sharing with employers or GoHire, and recording. No bundling |
| Onboarding (S1–S5) | Rush/no-rush, function, job type, location, H1B, goals, stage, resume | Identity 应届/在校/社招; **毕业届别** and month; 学历 (大专/本科/硕士/博士, 统招); school with 985/211/双一流 flags (display and user filter only, never a ranking penalty); 专业; **求职状态** (离职-随时到岗 / 在职-月内到岗 / 在职-考虑机会 / 在职-暂不考虑); 期望职位/城市 (multi)/行业; salary **K/月·N薪**; 全职/实习; internship days per week and months; 到岗时间; 是否接受调剂. Then 户口/央国企/编制/外企 tag preferences and an optional 考公 track |
| Work-auth filter (F-FILT-02, F-FEED-07) | H1B Sponsored / Likely / No H1B; citizen and clearance | **可落户 / 央国企 / 事业编 / 外企** tags, only when an official source supports them; remove EEO and visa |
| Inventory (F-FEED-15) | LinkedIn, Indeed, career sites | **GoHire bank** (P0), user-imported JDs, a curated **校招日历** (company, 届别 window, 网申 open/close, 笔试/面试 waves, official link), 24365 / university partnerships (P1). **Never scrape** BOSS, 智联, 51job or 猎聘; deep-link only. Every card shows **source, expiry and basic pay** (or "薪资未披露") |
| Match explanations (F-MATCH) | Opaque components | A PIPL Art. 24 explanation ("为什么推荐") and a right to refuse automated decisions |
| Insider connections (F-NET) | LinkedIn buckets + email finder | **内推 hub**: employer 内推码, opt-in alumni referral requests by school, 牛客/脉脉 partnerships. **No email finder** (PIPL) |
| Autofill (F-EXT) | Chrome extension for US ATSs | **一键网申** extension for Beisen, Moka, 大易, Feishu and big-tech portals. Modes: fill all / fill blanks / fill selection. Fields for 家庭成员 / 政治面貌 / 生源地. Human submit. Distribute via **Edge Add-ons** plus the Chrome Web Store; test reachability on all 3 carriers |
| Agent (F-AGENT) | Auto-apply | **Never on BOSS/智联; no auto-greet.** Only an assisted 网申 queue the user confirms one by one |
| Resume (F-RES) | US templates, Letter | Chinese builder: optional photo; 基本信息 (籍贯 and 政治面貌 optional, never used in matching or sent to the LLM without opt-in); 求职意向; education first; 实习 separate; 项目 (STAR); 校园经历; certificates (CET-4/6); 获奖; 自我评价 (3–5 sentences); 1–2 pages; **zh/en bilingual export**; A4; CJK fonts; AI labels |
| Interview (F-INT) | Question bank + voice intake | **AI面试 simulation** in Beisen/牛客 format (20–30 minutes; communication, logic and behaviour dimensions; STAR completeness; filler words); 笔试/测评 practice; HR-interview bank. **Audio-first; no face recognition or face templates**; video opt-in and processed in session; transcripts kept in CN with about 90-day retention |
| Tracker (F-TRK) | 5 statuses | 网申 → 测评 → 笔试 → AI面试 → 一面/二面/HR面 → Offer → 三方; 网申截止 alerts; **Offer comparison** |
| Copilot (F-ORION) | Stateless chat | **Long-term career memory** and proactive deadline nudges through WeChat subscribe messages (the 职悟空 bar) |
| Notifications (F-NOTIF) | Email first | WeChat service-account or subscribe messages; SMS for OTP only |
| Surfaces (F-MOB) | iOS/Android apps | **WeChat mini program first**, then H5; native apps later (fragmented Android stores) |
| Payments (F-BILL) | Stripe USD | WeChat Pay (JSAPI/Native/H5), Alipay, iOS mini-program IAP (15%); CNY |
| SEO / growth (F-SEO, F-GROW) | GitHub lists, Trustpilot, PH | Baidu SEO, 小红书, 抖音, 知乎, B站, WeChat 公众号, 牛客 communities; acquisition survey options localised |
| Copy | Hype-heavy | Practical and reassuring (less form-filling, no missed deadlines, calmer interviews) |

### 6.3 Taiwan (part of the international RoboHire.io market) [CN §8]

| ID | Requirement |
|---|---|
| TW-01 | Taiwan users stay on the international stack. Route by brand and domain, not by IP. Never mix TW data into the CN database. |
| TW-02 | Inventory: **do not scrape 104** (no public jobs API). Use employer ATS feeds (Greenhouse, Lever, Workday) through the existing provider seam. Pursue partnerships with Cake, Yourator or 104. |
| TW-03 | Salary disclosure (Employment Services Act Art. 5): a regular monthly wage under **NT$40,000** must show a range or amount, never "面議". Parse 面議 honestly and treat ≥40k 面議 as unknown in the salary filter. Watch the pending 1.75× minimum-wage reform. |
| TW-04 | Resume conventions: a 自傳 field; optional photo (expected by local firms, dropped for foreign firms); 期望待遇 "依公司規定"/面議; a one-page English resume for foreign firms; core fields 希望職稱/職類/地點/待遇. |
| TW-05 | Login: add **LINE Login** alongside Google and Apple. |
| TW-06 | Payments: Stripe on the international stack first. Check whether a non-TW entity can use ECPay or TapPay for recurring billing. Cloud e-invoice and VAT registration once B2C sales exceed **NT$600k** a year. |
| TW-07 | Compliance: the PDPA amendment (breach notification, promulgated 2025-11-11) and the AI Basic Act (promulgated 2026-01-14, NSTC). Avoid AI-interview features that screen candidates (104 declined them over discrimination risk); self-practice is fine. |
| TW-08 | Copy in zh-TW: 履歷, 職缺, 薪資/待遇, 面議, 年終, NT$, 自傳, 應徵, 校園徵才. Never reuse Simplified-Chinese terms (简历/岗位/网申/校招). Use the `i18n-locale-sync` skill. |
| TW-09 | Work authorization: generalise the H1B filter into country-specific sponsorship. For TW: work permit / Employment Gold Card. For UK: Skilled Worker sponsor licence. For CA: LMIA. |

---

## 7. Contradictions, decisions and open questions

### 7.1 Contradictions between sources and how they are resolved

| # | Topic | Conflict | Resolution |
|---|---|---|---|
| X-01 | Onboarding step order | [PS] lists signup → resume → career goals → mode → diagnostics → advanced. [NTI] puts resume second. [ON] has the stage enum. | **Use [ON]:** mode → diagnostics → (no-rush: goals → advanced) → resume → matching. The stage codes 50–56 and the authenticated Logout on S4 are primary evidence. |
| X-02 | Is the career goal required? | "Required before Next" [PS] vs "skippable" [NTI]. | Both are true: `Next` validates a selection; `Skip` bypasses. |
| X-03 | LinkedIn as a login method | [PS] lists LinkedIn SSO. [ON] finds none in 2026. | No LinkedIn login. The LinkedIn routes serve URL intake, ownership verification and TNT. Apple exists as a component (iOS and variant). |
| X-04 | Fields at S2 | [OAE] says seniority and salary are asked. [ON] (bundle) says not. | **Use the bundle:** seniority is confirmed at S7; salary lives in Filters. [OAE]'s list reflects older v2 and filter flows. |
| X-05 | Countries | Stores and FAQ: US-only. 2026 code: US/CA/GB/AU/IE/NZ. [PS] S4 mention: US/CA/UK/India. | The code picker (6 countries) is current; live non-US inventory is unverified. Our clone is multi-country anyway. |
| X-06 | Free credit counts | 2 shared/day; 3 total; 2/4/2/2 per feature; about 1 autofill/day. | **Canonical:** the confirmed in-app refill text (custom resume 2, enhancement 1, email 2) plus the Aug 2026 FavTutor/Jobity per-feature table (autofill 4, cover letter 2, alerts 1, saved filter 1). Make all of them configurable. |
| X-07 | Agent waitlist | Seen 2026-08-31 with a paid skip. Absent from the 2026-10-09 bundle. | Treat it as retired by Oct 2026. The clone ships no waitlist. |
| X-08 | Turbo prices | $14.99/$29.99/$69.99 (early 2026) vs $17.99/$39.99/$89.99 (May–Oct 2026). | Use the latest. The $39.99 string is in the shipped bundle. |
| X-09 | Trial | "No public trial" (reviews) vs `trial-offer` code ("Try Turbo for 7 days"). | The trial exists but is **offer-gated**, not public. |
| X-10 | Student discount | "None advertised" vs `.edu` verification and a Student plan in code. | It exists in-app behind verification and is not marketed. |
| X-11 | AI mock interview | The compare-table row and some third parties claim it. Jobright's blog denies it. `/voice-chat` is unclear. | **No self-serve scored mock interview.** `/voice-chat` is a 5-minute employer-intake "AI Interviewer" ([NTI] decoded the bundle). |
| X-12 | "Messages" sidebar | Unknown in [PS]. | Resolved by [NTI]: the employer Interview Invitation inbox. |
| X-13 | Coaching in Turbo | "Included" vs sold per session. | Turbo includes the weekly group Office Hour plus a "claim a session" variant. 1:1 sessions are otherwise paid. |
| X-14 | Interview bank size | 6,656/328 vs 9,851/431 vs 10,033/434. | The bank grows about 1.1K questions a month. Marketing lags. Use live counts. |
| X-15 | Interview bank in Turbo | Separate passes (Aug) vs Quarterly includes 9k+ (Oct pricing modal). | A recent change: Quarterly includes it; other plans use passes. |
| X-16 | Referral reward | 5/10/5 AI credits each (third party, older) vs $3 balance capped at $30 (policy page). | **Current = $3 balance.** The credits and the LinkedIn-post 5-day Turbo were earlier variants. |
| X-17 | Resume templates | 6 including "Color" [PS] vs 5 [RS]. | 5 templates in the enum. "Color" is the accent-color control or a Quick Format. Fonts: use the union of both lists. |
| X-18 | Explore categories | 18 [PS] vs 20 [MJ]. | 20 (adds Marketing and Sales). The resume target-title picker has 18 plus enum codes for marketing and sales. |
| X-19 | Match label scale | % with Strong/Good/Fair vs a 10-point scale with "Poor" (Apr 2026). | Current: %, with CSS bands at 70 and 85. The /10 scale with Poor is the **resume-vs-JD gauge** (F-RES-08), a different score. |
| X-20 | Feed satisfaction scale | 0–10 [MJ] vs "Not satisfied…Extremely satisfied" [ON] vs 1–5 [MJ]. | Feed: a 0–10 scale with those end labels; <8 opens reasons. The 1–5 rating is the separate marketing list-page widget (F-GROW-07). |
| X-21 | Tracker view | A competitor claims kanban. | The code shows a list with status sub-tabs. No kanban, notes or reminders. |
| X-22 | Extension version and users | 1.15 / 200K vs 1.24.0 / 300K. | Latest: v1.24.0, 300K users, 4.9★/372 (CWS, 2026-10-08). |
| X-23 | Marketing opt-in default | Inferred [ON] vs observed pre-checked [OAE]. | **Pre-checked** (observed). Our clone defaults to unchecked where law or prudence requires. |
| X-24 | Email outreach claim | "2x" (composer) vs "3x" (landing). | A Jobright copy inconsistency. Ours: no unverified multipliers. |
| X-25 | Blog size | ~247 (post sitemap) vs ~211 (index). | A measurement difference. About 211–247 posts. |
| X-26 | Seeker tab label | "Recommended" vs "For you". | Both are live labels (variant). Use "For you" in the tab and "Recommended" for the sort. |
| X-27 | Agent autonomy | Marketing promises auto-submit. Reviewers say most jobs need a manual click. | **Hybrid:** server Easy Apply or Automated Mode where automatable; otherwise extension autofill plus the user's submit, or manual. |
| X-28 | User count (critic pass) | Homepage: 3M. iOS, Android and Chrome listings: 500K+. | The store copy is stale. Use neither as fact; the clone shows only counts it can prove. |
| X-29 | "Fast Mode" (critic pass) | Tool landers: build a new resume in Fast Mode in under 3 minutes. App code: `tailor_resume_fast_mode_abtest`. | No standalone from-scratch builder ships. In-app "fast mode" is a tailor experiment (F-RES-09, F-RES-17). |
| X-30 | Coaching lead time (critic pass) | Catalog said "≥2 business days". Policy says book "at least 2 days" ahead; cancellation tiers use business days. | Booking lead time is 2 calendar days. Refund tiers are in business days. |
| X-31 | Renewal reminders (critic pass) | Clone stance implied Jobright lacks them. Terms of Sale promise a pre-renewal reminder with cancel instructions. | The policy exists; reviewer complaints are about billing. Our clone must actually send it and log delivery. |
| X-32 | Referral verification (critic pass) | "Email verification required" vs the policy. | Only email-and-password invitees must verify; SSO sign-ups count as verified. The inviter's link is still gated behind the inviter's own verification [NTI §8]. |
| X-33 | Insider data source (critic pass) | "Unknown". | The privacy notice names B2B contact and firmographic data partners plus public professional profiles, with an opt-out. The vendor is still unnamed. |

### 7.2 Decisions needed from Kenny (product owner)

| ID | Decision | Options / recommendation (I) |
|---|---|---|
| **D-01** | **Auto-apply vs Overhaul Ruling R1** ("the final click is yours", 2026-07-26). The clone mandate asks for all features and allows overwriting the implementation. | (a) Keep R1: ship the Agent as **Supervised-only** (queue, tailor, autofill, the user submits) and Easy Apply that pauses before submit. (b) Reverse R1: ship Automated Mode and server-side submit behind an explicit ToS consent, starting with Greenhouse. **Recommended: (a) as the default, with (b) behind a flag if you explicitly reverse R1.** GoApply is always (a). |
| D-02 | **Brand name collision.** "RoboHire" is already the sister **recruiter** product. Using RoboHire.io as the international **seeker** brand overlaps it. | Confirm whether RoboHire.io becomes a two-sided brand (seeker + recruiter, like Jobright + business.jobright) or the seeker app gets its own sub-brand or domain. |
| D-03 | GoApply licensing path | Operate under GoHire's licensed entity vs a new entity vs a seeker-tools-only MVP. This blocks any job feed in CN (CN-L-04). |
| D-04 | People-data source for insider connections (international) | A licensed provider (PDL-like) vs a deep-link-only approach (F-NET-03) vs user-imported connections. Scraping is a legal risk. |
| D-05 | **Video live interview fix** (part of the user's ask) | Adopt F-INT-05's state machine (mic/cam test, device picker, permission help, reconnecting / connection-lost, restart warning, leave confirm, consent, rating, attempt rate limit). Add the `VoiceSessionProvider` seam (CN-E-06). Implementation belongs to a separate workstream (the LiveKit worker; memory notes the 30-second-session bug and the dev supervisor). |
| D-06 | Pricing transparency | A public pricing page and renewal reminders (recommended) vs Jobright's hidden in-app-only pricing. |
| D-07 | Urgency and dark patterns | Do **not** clone the fake "Expires in N hrs", static counters, or anchor prices with misleading "Save 40%". Countdown first-day offers are allowed only if they are real. |
| D-08 | AI labelling on exported resumes (CN) | Explicit "AI 辅助" label vs metadata-only with a ToS duty for unlabelled export. Needs counsel. |

### 7.3 Open questions (could not be resolved from public evidence)

1. The exact score-to-label thresholds and the component weights of `displayScore` (Strong/Good/Fair cutoffs are server-side).
2. Whether Not Interested also trains a per-user model beyond deterministic filter edits.
3. The live job inventory for CA/UK/AU/IE/NZ (the picker exists; inventory is unverified).
4. Exact current free credit allowances per bucket. Is the cover letter its own bucket or part of TAILOR?
5. Whether tailored resumes count against the 5 slots or can be promoted to a base resume.
6. The welcome/drip email sequence, alert email layout (jobs per email, subject), and trial-expiry and winback cadence.
7. Report Issue UI labels (only the enum was captured) and how `h1bTitleDistribution` is rendered.
8. Which ATSs server-side Easy Apply covers beyond Greenhouse and JobTarget.
9. Whether extension v1.24 has a save-job button and a score overlay on LinkedIn/Indeed.
10. Whether the native apps include Orion and Agent controls, and the native onboarding steps.
11. The ToS consent language for Automated Mode. *Partly answered by the critic pass:* the ToS (readable from the page bundle) has no Agent-specific clause. It relies on a general authorization to share application materials for roles the user applies to, plus third-party account linking. An in-app consent at Automated Mode activation is still unverified.
12. Whether the AI Interviewer voice conversation is shared with employers as a transcript or a score.
13. The insider-connection data source and the number of contacts per bucket on Free vs Turbo. *Partly answered:* B2B data partners plus public profiles (X-33); the per-bucket counts are still unknown.
14. The scope of Turbo's "Live Career Coach Consultation"; current 1:1 prices (no primary source).
15. Whether TNT charges talent or startups. The 6-month Turbo price. Regional pricing cohorts.
16. Whether the rush/no-rush rule ever shows S3/S4 to rush users. Whether email verification is ever enforced before onboarding (A/B).
17. **CN:** .top fileability after the IANA change; GoHire licence status; algorithm-filing threshold; 24365 partnership criteria; Chrome Web Store reachability in the mainland; self-hosted LiveKit vs Volcano/TRTC latency per carrier; model-churn budget.
18. **TW:** ECPay/TapPay eligibility for a foreign entity; 104 / Cake / Yourator feed partnerships.
19. *(critic pass)* What Explore AI Search (F-FEED-17) looks like and whether it is live for any cohort.
20. *(critic pass)* What "tg" means in `tg-offer` (a Turbo-gift / trial offer is the best guess), and what the personalized-AI offer copy says.
21. *(critic pass)* Coach free-trial terms (length, Turbo-only or not) and whether the in-tailor coach portal is a booking or a lead form.
22. *(critic pass)* Whether the SMS program (F-NOTIF-10) is live, and where phone opt-in is collected.
23. *(critic pass)* Which "referral partners" send users by API (F-GROW-08). Lensa is one probable partner.

---

## Appendix A: Core data model (from Jobright SSR props; use for schema planning) [MJ §16], [PS §8] C

**`jobResult`**

| Group | Fields |
|---|---|
| Identity | `jobId`, `jobTitle`, `jobNlpTitle`, `jobSeniority` |
| Location | `jobLocation`, `jobLocations[]`, `isRemote`, `workModel`, `lat`, `lng`, `countryCode` |
| Timing | `publishTime`, `publishTimeDesc`, `repost` |
| Pay and type | `salaryDesc`, `minSalary`, `maxSalary`, `employmentType` |
| Summaries | `jobSummary`, `jdResponsibilitySummary`, `coreResponsibilities[]`, `skillSummaries[]`, `educationSummaries[]`, `benefitsSummaries[]`, `whyJoinUs` |
| Experience and applicants | `min/maxYearsOfExperience`, `applicantsCount`, `applicantsDisplayText?` |
| Tags and scores | `recommendationTags[]`, `jobTags[]`, `recommendationScores[{featureName, displayName, score}]`, `skillMatchingScores[]`, `industryMatchingScores[]` |
| Skills and requirements | `jdCoreSkills[{skill, score, type}]`, `qualifications{mustHave[], preferredHave[]}`, `detailQualifications{…{yoe, education, hardSkill, softSkill}}` |
| Taxonomy | `firstTaxonomy`, `jobTaxonomyV3[]` (L1–L3 IDs such as `01-08-01`) |
| Source and links | `source`, `sourceId`, `isCompanySiteLink`, `url`, `applyLink`, `originalUrl`, `jobtargetEasyapply` |
| Authorization | `isWorkAuthRequired`, `isH1bSponsor`, `isCitizenOnly`, `isClearanceRequired`, `h1BStatus` |
| Status and people | `isToB`, `hiddenJob`, `isDeleted`, `jobRecruiter`, `jobRecruiterProfileUrl`, `socialConnections[]` |

**`companyResult`**

| Group | Fields |
|---|---|
| Identity | `companyId`, `companyName`, `companySize` |
| Descriptions | `companyDesc`, `gptShortDescription`, `companyCategories`, `companyGptCategories[]`, `companyRecommendationTags[]` |
| Links | `companyURL`, `companyLinkedinURL`, `companyTwitterURL`, `companyCrunchbaseURL`, `linkedinCompanyId` |
| Profile | `companyFoundYear`, `companyLocation` |
| Funding | `fundraisingCurrentStage`, `fundraisingTotalFunding`, `fundraisingKeyInvestors[]`, `fundraisingLatestRounds[{investmentType, announcedOn, raisedAmountUsd}]` |
| People and press | `leadership[{pname, ptitle, plinkedinUrl, plogoUrl}]`, `pressReferences[{url, postedOn, title, publisher}]` |
| H1B | `h1bAnnualJobCount[{year, count}]`, `h1bTitleDistribution[]` |
| Flags | `isAgency`, `isTnt`, `isForceJobLinkedinVerify` |
| Glassdoor | `grating{rating, url, count}` |

**List item.** `{impId, jobResult, companyResult, displayScore, rankDesc?, isLiked?, applyStatus?, jobNotes?}`. `impId` is used for feedback attribution.

**Saved filter (preference store) keys.** `jobTaxonomyList`, `excludedTitle`, `jobTypes`, `workModel`, `country`, `locations[{city, radius}]`, `seniority`, `minYearsOfExperienceRange`, `daysAgo`, `annualSalaryMinimum`, `isH1BOnly`, `excludeByAuthorization`, `companyCategory`, `excludeCompanyCategory`, `skills`, `excludedSkills`, `roleType`, `companies`, `companyStages`, `excludeStaffingAgency`, `excludedCompanies`, `hiddenJobsOnly`, `name`.

**Clone additions (I).** Brand and market on every entity. A market-generic `workAuthTags` field in place of H1B-only. CN fields (`graduationClass`, `schoolTier`, `hukouEligible`, `soeType`, `bianzhi`, `salaryMonths`, `sourceAttribution`, `expiresAt`, `basicPayDisclosed`). An application-artifact record (the exact resume and cover-letter file sent per application).

## Appendix B: Jobright's own 20-row feature checklist (from `/compare/*`) [PS §4.5] C

| Group | Rows → our IDs |
|---|---|
| Discovery | AI job matching with fit score (F-FEED-06, F-MATCH-01); proactive matching (F-NOTIF-01); salary insights and market data (F-SAL); hidden jobs filter (F-FEED-04); multiple saved filters (F-FEED-03); instant job alerts (F-NOTIF-01); search across boards (F-FEED-15) |
| Resume and application | AI Agent auto-apply (F-AGENT); AI custom resume (F-RES-09); AI cover letter (F-CL-01); ATS score / match rate (F-RES-08); 1-click autofill (F-EXT-02) |
| Networking and interview | Email connection for referral (F-NET-05); live career coach (F-COACH-01); insider referral discovery (F-NET-02); AI mock interview (F-INT-06: absent at Jobright, present in RoboApply); LinkedIn profile optimization (F-RES-16) |
| Platform | Chrome extension (F-EXT); application tracker (F-TRK); free tier (§5.2) |

## Appendix C: Live experiments and instrumentation (critic pass; build `GQd0ykV_IrfhtmCjLOY2m`) C

**Client A/B registry** (`_app` module 97542). Values are mostly `on`/`off` or `base`/`exp1`/`exp2`; one test uses `two_credits`.

| Key | What it tests (I unless noted) |
|---|---|
| `quarterly_student` | Student Quarterly plan |
| `linkedin_signup` | LinkedIn sign-up (no UI strings ship; X-03) |
| `turbo_6month_exp` | 6-month plan, two price arms (C: SKUs) |
| `turbo_special_offer_topbar_style_exp` | Style of the offer countdown bar |
| `membership_upgrade_bar_tag_exp` | Tag on the upgrade bar |
| `my_greenhouse_easy_apply_api` | Server Easy Apply via Greenhouse |
| `greenhouse_easy_apply_layout_abtest` | Easy Apply panel layout |
| `greenhouse_easy_apply_free_credit_abtest` | Free Easy Apply credits (`two_credits` arm) |
| `interview_turbo_exp` | Interview-bank access offered with Turbo (X-15) |
| `new_signup_onboarding_exp` | New sign-up onboarding variant |
| `explore_ai_search` | Explore AI Search (F-FEED-17) |
| `tailor_resume_fast_mode_abtest` | Fast-mode tailor (F-RES-09) |

Server-side flags seen elsewhere: `coach_turbo_group`, `turbo_retention_group_popup`, `tailor_multi_skill_selection`, `tailor_step_exp`, `diagnoseV2Group`, `onboarding_acquisition_source_survey_test`, `tailor_resume_custom_prompt`.

**Instrumentation:**
- Amplitude browser SDK (product events such as `update_popup_exposure`, `turbo_retention_popup`, `explore_ai_search_invite_popup_click`).
- Sentry (error tracking with session replay; debug IDs in every chunk).
- LinkedIn Insight, TikTok and Facebook pixels.
- Appcast and ZipRecruiter conversion pixels.
- A Stripe Climate badge link.

**Clone note (I):** Keep a typed experiment registry per brand. Never ship third-party ad pixels on GoApply (CN-E-02). The RoboHire.io brand needs a consent banner before any ad pixel fires in the EU or UK.

---

## Critic pass (2026-10-09)

**Method.** I re-read this catalog against the 8 research notes. I re-checked primary sources without signing up or logging in:
- the live homepage HTML and the same build manifest (`GQd0ykV_IrfhtmCjLOY2m`, unchanged);
- all 256 JS chunks it lists, including the `legal/*`, `referral-policy`, `coaching-policy` and `security` page bundles (robots blocks the rendered pages, but their text ships in the JS);
- the Chrome Web Store listing;
- the iTunes lookup API and the Google Play listing;
- the blog post sitemap;
- web search for 2025–2026 coverage (The Register, Bloomberg Law, FavTutor, Jobity, review sites).

All prose is paraphrased. Backticked strings are interface identifiers.

### Claims verified against primary sources

| Claim | Result |
|---|---|
| Route inventory (§2.2, §2.4) | **Confirmed.** The same build is live; every listed route is present. Only internal routes were missing (now added). |
| Extension v1.24.0, 2026-10-08, 300K users, 4.9★/372, 2.72 MiB, Featured, in-app purchases (F-EXT-01) | **Confirmed** on CWS. |
| iOS app id6738236788, v1.15.0, about 1.6K ratings, U.S.-only (F-MOB-01) | **Confirmed** (1,572 ratings, v1.15.0 on 2026-07-20, first release 2025-01-13). |
| Android 4.6★/719, 50K+, updated 2026-08-21 (F-MOB-02) | **Confirmed.** |
| Refund windows 7 d / 24 h / 3 d (F-BILL-08) | **Confirmed** in the current bundle; more rules added. |
| Referral $3 per referral, 10 slots / $30, Stripe balance (F-GROW-01) | **Confirmed**; SSO-verification nuance corrected. |
| Coaching refund tiers and no-show rules (F-COACH-02) | **Confirmed**; booking lead time corrected (X-30). |
| Agent Settings modes and weekly objective `<20` / `20-50` / `>50` (F-AGENT-03) | **Confirmed** in chunk `97342`. |
| 5 resume slots ("saved out of 5") (F-RES-02) | **Confirmed.** |
| Instant-alert frequencies 1/2/5/Unlimited (F-NOTIF-01) | **Confirmed** (enum values added). |
| Turbo $17.99/wk, $39.99/mo, $89.98–89.99/qtr; free 2/4/2/2 credits, 1 saved filter, 1 alert/day | **Consistent.** `$39.99/mo` is in the bundle; the rest come from FavTutor (2026-08-21) and Jobity (2026-08-31). Still **L**, since the plan picker is behind login. |
| Funding $3.2M (Jun 2025) with Indeed's arm | **Confirmed**; Translink Capital led the round. |
| 3M users; 8M+ total jobs; 400K+ new today | The homepage says so. The store listings still say 500K (X-28). |
| SOC 2 (Dec 2025) (F-TRUST-01) | Supported by the company blog only. The `/security` page does not mention it. |
| `STRONG/GOOD/FAIR MATCH` rank labels (F-FEED-06) | **Not found as literals** in the bundle. They are server-supplied (`rankDesc`), so the **L** rating stands. |

### Added (new IDs or new sub-sections)

- **§1** Company facts: Delaware entity and address, founders, funding lead, named AI vendors, store-copy lag, unverified headcount and ARR.
- **§2.3–2.4** Message-center button and its APIs; internal routes; the `/jobs/search` constant.
- **S9** Guided first tailor (a pre-generated tailored resume in the tour) and the shared 24-hour popup throttle.
- **F-FEED-17** Explore AI Search (experiment).
- **F-FILT-05** Full quick-filter registry; the "early applicant" filter was not found.
- **F-ORION-12** Full Orion chat card vocabulary. **F-ORION-13** Visitor Orion.
- **F-AGENT-01** Launch facts (2025-06-24, initial scope, up to 50 listings a week, `enableAgent` flag). **F-AGENT-11** Agent chat vocabulary and assistant states.
- **F-RES-09** Live tailor experiments (fast mode, multi-skill selection), the tailor count/exists checks, and the coach portal inside the tailor.
- **F-NET-02** Data source evidence. **F-NET-09** Message-center plumbing and the employer anonymization rule.
- **F-INT-04** Pass rules (All-Access-exclusive companies, duplicate-pass guard, inline Stripe). **F-INT-05** In-app voice-chat invite throttling.
- **F-COACH-01** Cal.com scheduling engine, coaching-intent questionnaire, bookings polling. **F-COACH-06** Coach free trial and in-product coach upsell.
- **F-NOTIF-09** "What's new" announcement popups. **F-NOTIF-10** SMS channel (ToS only).
- **F-EXT-01** Re-verified listing plus support email, EU non-trader status and claim lines.
- **F-MOB-06** iOS and Android store facts, including data-safety disclosures and the store FAQ saying salary range feeds the score.
- **F-ACCT-05** Settings tab enum, alert and digest enums, server-side `extraConfigMap`.
- **F-BILL-03** Payment-failed state, weekly unsubscribe. **F-BILL-09** Plan/SKU catalog (Student Monthly/Quarterly/6-Month, discounted monthly SKUs, 6-month A/B). **F-BILL-10** In-subscription upsell and retention engine, including LLM-personalized offer copy. **F-BILL-11** Checkout terms, coupons, local currency, Jobright Balance.
- **F-GROW-08** Referral-partner API intake. **F-GROW-09** Product Hunt proof. **F-GROW-10** Public review replies.
- **F-TRUST-06** Privacy-notice commitments (Gmail limited use, 6-month retention cap, AI processors, B2B data partners). **F-TRUST-07** Support channels (no help center; no seeker 2FA). **F-TRUST-08** ToS guardrails (no Agent-specific consent clause).
- **F-MATCH-01** Note that salary range may be a hidden score input.
- **§5.1** 6-Month and Student SKUs; discounted-monthly SKUs.
- **§7** Contradictions X-28 to X-33; open questions 11 and 13 partly answered; new open questions 19–23.
- **Appendix C** Client A/B registry, server flags, instrumentation stack.

### Corrected

- **Clone stance (§1):** Jobright's Terms of Sale do promise pre-renewal reminders. The gap is execution, not policy (X-31).
- **F-RES-17:** "Fast Mode" is a landing-page claim plus a *tailor* experiment, not an in-app from-scratch builder (X-29).
- **F-COACH-02:** The booking lead time is 2 days; only the refund tiers use business days (X-30).
- **F-GROW-01:** SSO invitees count as verified; invitees keep the $3 even when the inviter has no slots left (X-32).
- **F-NET-02:** The data source is no longer "unknown" (X-33).
- **S0 / X-03:** No LinkedIn login ships, but a `linkedin_signup` experiment key remains.
- **§1 funding:** Translink Capital led the 2025 round.

### Still unverifiable from public sources

- Exact current free-credit numbers and Turbo prices. Both sit behind login and change by A/B cohort, so they stay **L** from two dated third-party snapshots.
- What Explore AI Search, the coach free trial, `tg-offer` personalized copy and the SMS program look like in practice (open questions 19–22).
- Whether a consent step appears when Automated Mode is switched on.
- Insider-connection vendor names and contacts per bucket.
- Who the API referral partners are, other than the likely Lensa link.
- The native apps' Orion and Agent surfaces.
- The welcome and drip email cadence.
- The SOC 2 report itself (blog claim only).
- Headcount and ARR (conflicting third-party claims).
- No 2026 product-launch press releases were found. 2026 changes (interview bank, coaching, passes, `/candidate-preferences`, Explore AI Search) appear only in the shipped code and in reviews.
