# Jobright.ai: product surface map

Research angle: a full map of the public marketing site plus the logged-in web app's information architecture (IA).
Researched 2026-10-09. All text is paraphrased. Short UI labels such as button text, menu items and filter names are kept as written because they are functional facts, not prose.

Confidence legend:
- **confirmed** = seen in a primary source: a jobright.ai page, the site's own sitemap or robots.txt, its public Next.js build manifest or page bundles, or its legal/policy pages.
- **likely** = reported by several independent secondary sources.
- **inferred** = my own reasoning from the evidence.

---

## 0. Method, sources and caveats

- **Sitemaps.** I fetched `https://jobright.ai/sitemap.xml` and all 7 child sitemaps, plus the WordPress blog sitemaps at `https://jobright.ai/blog/post-sitemap.xml` and `.../category-sitemap.xml`.
- **robots.txt.** `https://jobright.ai/robots.txt` lists the private app routes it blocks, which also reveals them. It explicitly blocks `ClaudeBot` and `GPTBot` from `/jobs/`. Because of that, I did not crawl `/jobs/*` pages in bulk.
- **Next.js build manifest.** The marketing site and the web app are one Next.js app using the Pages Router. Its public build manifest (`https://static.jobright.ai/_next/static/<buildId>/_buildManifest.js`, buildId `GQd0ykV_IrfhtmCjLOY2m` on 2026-10-09) lists **every page route**, including the logged-in ones, plus the rewrites. I downloaded the public page bundles and extracted their UI strings to infer the logged-in IA. This is the strongest evidence in this document for app screens I could not log into.
- **Browser view.** I opened the homepage and `/tools` in the in-app browser.
  - Opening a `/jobs/info/<id>` job detail page triggered a **bot-detection interstitial** ("One quick security check", served at `/_jr/security/challenge`). I did not interact with it and navigated away.
  - The job-detail anatomy below comes from server-rendered HTML that a sibling research agent had already saved (`/jobs/info/6aac8b023e3ce93970c7ddcb`) and from the page's JS bundle.
- **A/B testing is visible.**
  - The server-rendered homepage shows a "Try For Free" hero and FAQ set A (LinkedIn comparison, data sharing, free?, listing sources, regions).
  - The live browser render showed "Sign up for free" + "Hire with Jobright" buttons and FAQ set B, which is about the Agent.
  - The app calls `/swan/ab/user`, and links carry `?ext-ab=` parameters.
  - Treat hero copy as variable.
- **No login, no signup, no forms submitted.**

---

## 1. Domains and hosts

| Host | Purpose | Evidence | Confidence |
|---|---|---|---|
| `jobright.ai` | Marketing site, SEO pages and the job-seeker web app, all in one Next.js app | build manifest | confirmed |
| `static.jobright.ai` | CDN for `_next` assets | page HTML | confirmed |
| `jobright.ai/blog/` | WordPress blog using Yoast sitemaps (post, category, tag, author) | `/blog/post-sitemap.xml` | confirmed |
| `business.jobright.ai` | Employer product. `/employer-signup` redirects to `business.jobright.ai/signup?ext-ab=a` | curl redirect | confirmed |
| `jobright.ai/remote-jobs/*` | A separate "minisite" app reached through a rewrite (`/remote-jobs/:path*`). It has its own nav: Home, Category, New Grad Jobs, Top AI/ML Jobs, AI Resume Builder, Share Your Feedback | build manifest rewrites + page HTML | confirmed |
| `/swan/*` | Backend API, proxied through a rewrite. Never indexed | robots.txt + `_app` bundle | confirmed |
| `/orion/*`, `/foxit/*` | Rewrites to other services: the Orion backend, and a Foxit PDF-to-DOCX converter (`/foxit/pdf-to-docx`) used for resume Word export | build manifest + `_app` bundle | confirmed |

---

## 2. Sitemap inventory (2026-10-09)

The root `sitemap.xml` is a sitemap index with 7 children:

| Child sitemap | URLs | Last modified | Content |
|---|---|---|---|
| `sitemap-pages.xml` | 15 | 2026-07-30 | Core marketing pages: `/`, `/employers`, `/employers/pricing`, `/ai-resume-builder`, `/ats-resume-checker`, `/job-autofill`, `/h1b-jobs`, `/about`, `/orion-copilot`, `/ai-job-match`, `/job-referral`, `/remote-jobs`, `/fake-candidate-detection`, `/coach-landing`, `/interview-landing` |
| `sitemap-comparison.xml` | 11 | 2026-04-24 | `/compare/{aiapply, careerflow, huntr, jobcopilot, jobscan, lazyapply, loopcv, scale-jobs, simplify, sonara, teal}` |
| `sitemap-blog.xml` | 16 | 2026-04-10 | A curated subset of blog posts (data and market reports, AI careers) |
| `sitemap-taxonomy.xml` | 4,548 | 2026-03-20 | Programmatic `/jobs/{slug}` SEO landing pages. This file is the union of `-1` and `-2` (exact duplicate) |
| `sitemap-taxonomy-1.xml` | 2,274 | 2026-03-20 | First half of the taxonomy pages |
| `sitemap-taxonomy-2.xml` | 2,274 | 2026-03-20 | Second half |
| `sitemap-remote-jobs.xml` | 17 | 2026-04-10 | `/remote-jobs` plus 12 category pages and a few role pages |

**How the taxonomy pages break down (confirmed by URL analysis):**
- **379 role/category pages**, such as `/jobs/data-analyst`, `/jobs/backend-engineering` and `/jobs/software-internet-ai`. They mix broad categories ("software-internet-ai", "banking", "construction") with specific roles ("ai-engineer", "court-clerk", "data-annotation-ai-tutor").
- **4,169 role-by-city pages**, of the form `/jobs/{role}-in-{city-st}`. That is the same 379 roles × 11 cities: Atlanta GA, Austin TX, Boston MA, Chicago IL, Dallas TX, Houston TX, Los Angeles CA, New York NY, Phoenix AZ, San Francisco CA, Seattle WA.
- **A second slug format exists outside the sitemap.** The homepage `recommendLinks` prop links pages like `/jobs/machine-learning-engineer-jobs-in-los-angeles-ca` and `/jobs/customer-service-sales-jobs-in-salt-lake-city-ut`. These cover many more cities, use a `-jobs-in-` infix, and are linked internally from the "Check Out Our Popular Job Lists" footer block. Both formats resolve to the `/jobs/[visit]` route (confirmed).

**Remote minisite categories (confirmed):**
- Software Engineering
- Data & AI. Its subcategories are Data Analyst, Data Scientist, Data Engineer, Machine Learning Engineer, AI Engineer and LLM Engineer.
- Infrastructure & Security. Its subcategories include Cyber Security Engineer and Analyst, and Cloud Security Engineer.
- Hardware, Electrical & Embedded
- Manufacturing & Industrial
- Product & Design
- Sales & Business Development
- Marketing & Growth
- Customer Support & Success
- Business, Finance, HR & Legal
- Healthcare & Life Sciences
- Public Sector & Education

**Blog (confirmed):**
- About **247 posts** in the WordPress post sitemap.
- **12 categories:** artificial-intelligence, ats, career, h1b, indeed, internship, interview, job-search, linkedin, product, resume, security-trust.
- **Publishing cadence by lastmod month:** a 78-post burst in 2025-01, steady output in 2025, then a second burst of 38/27/21 posts in 2026-01, -02 and -03, and a trickle since.
- The footer features four posts: "Is Jobright Legit?", "Success Stories…", "What Top AI Companies Are Looking For" and "Jobright AI Agent Launch".

**Not in any sitemap** (they exist as routes; see §3): all `/tools/*` pages, `/tnt`, `/partners`, `/security`, `/mobile-app`, `/entry-level-jobs`, `/intern-jobs`, `/top-jobs`, `/SWE-intern`, `/data-science`, `/marketing-jobs`, `/remote-jobs-usa`, `/jobs/info/*` job detail pages, `/interview/*` and `/role/*`.

Job detail pages (`/jobs/info/{24-hex id}`) are not listed in any sitemap. They are reachable through internal links, such as the homepage "latest jobs" ticker and the taxonomy pages (confirmed).

---

## 3. Complete route inventory (from `_buildManifest.js`, confirmed)

### 3.1 Marketing and feature landing pages
| Route | What it is |
|---|---|
| `/` | Homepage, with A/B variants |
| `/ai-job-match` | AI Job Match landing page |
| `/ai-resume-builder` | Resume AI landing page |
| `/ats-resume-builder` | ATS Resume Builder landing page, positioned around fixing ATS rejections |
| `/ats-resume-checker` | Free ATS Resume Checker landing page (upload a resume plus a target job) |
| `/job-autofill` | Autofill extension landing page |
| `/job-referral` | Insider Connections landing page |
| `/orion-copilot` | Orion AI copilot landing page |
| `/ai-agent` | AI Agent landing page |
| `/agent` | Logged-in Agent app. This bundle is huge; see §10 |
| `/h1b-jobs` | H1B jobs landing page |
| `/tnt` | TNT (Top Talent Network) landing page |
| `/coach-landing` | Coaching landing page |
| `/interview-landing` | Interview Questions landing page. `/interview` and `/interview_tip` serve the same page to visitors |
| `/fake-candidate-detection` | Employer-facing free Chrome extension for spotting fraudulent candidates |
| `/employers`, `/employers/pricing`, `/employer-v1`, `/employer-signup` | Employer marketing pages. `/employer-signup` redirects to `business.jobright.ai/signup` |
| `/about`, `/partners`, `/security`, `/mobile-app` | Company and trust pages |
| `/compare/[slug]` | 11 competitor comparison pages |
| `/entry-level-jobs`, `/intern-jobs`, `/top-jobs`, `/SWE-intern`, `/SWE-intern-video`, `/engineering-intern`, `/engineering-intern-video`, `/data-science`, `/marketing-jobs`, `/remote-jobs-usa` | Campaign and SEO list pages. The `-video` variants are likely paid-ad landing pages (inferred) |
| `/remote-jobs`, `/remote-jobs/:path*`, `/minisites-jobs/[...slug]` | Remote jobs minisite |
| `/tools` plus 20 `/tools/*` pages | Free tools hub; see §6 |
| `/legal/{service, privacy, cookie-policy, refund, sales}`, `/referral-policy`, `/coaching-policy` | Legal and policy pages |

### 3.2 SEO and data pages
| Route | What it is |
|---|---|
| `/jobs/[visit]` | Taxonomy and search landing pages, e.g. `/jobs/data-analyst-in-austin-tx`. For visitors they render inside the **app shell** |
| `/jobs/info/[id]` | Public job detail page. It works logged out; logged in, it adds personalized scores |
| `/role/[id]` | Role page. The bundle is tiny, with only generic meta text, so likely a legacy redirect (inferred) |
| `/interview/[companyId]` | Per-company interview question bank, with a paywall |

### 3.3 Logged-in web app (most are disallowed in robots.txt)
| Route | Screen |
|---|---|
| `/jobs/recommend` | Main job feed ("Recommended" tab). Alias: `/jobs/recommend?id=:id`, reached from email lists through the rewrite `/jobs/email-list/:id` |
| `/jobs/liked` | Liked (saved) jobs |
| `/jobs/applied` | Applied jobs (tracker) |
| `/jobs/external` | External jobs: import a job by URL |
| `/jobs/explore` | Explore jobs by industry/function (labeled "Beta" in the nav) |
| `/jobs/profile` | Profile |
| `/jobs/resume` | Resume manager (up to 5 resumes) |
| `/jobs/resume/edit/[id]` | Resume editor |
| `/agent` | AI Agent (chat-driven auto-apply) |
| `/coaching`, `/coaching/discover`, `/coaching/bookings` | Coaching marketplace and my bookings |
| `/interview` | Interview question bank (logged in) |
| `/voice-chat` | "Voice Chat - Jobright". Likely a voice mock interview or voice Orion (inferred) |
| `/settings` | Settings |
| `/matching` | Post-onboarding "building your matches" loading screen |
| `/candidate-preferences` | Email-link (magic link) preference page for passive candidates; see §10.12 |
| `/autofill/uninstall` | Exit survey shown after the Chrome extension is uninstalled |
| `/return` | Payment-return landing page (inferred from the name) |

### 3.4 Onboarding and auth
| Route | Screen |
|---|---|
| `/onboarding-v3/signup` | Signup. Accepts a `?from=` attribution tag (e.g. `from=jobmatching`, `from=copilot`, `from=jobmatching-orion-analysis`) |
| `/onboarding-v3/resume-upload` | Resume upload or LinkedIn URL |
| `/onboarding-v3/career-goals` | Career goal |
| `/onboarding-v3/mode-selection` | Orion asks "in a rush" vs "open, no rush" |
| `/onboarding-v3/advanced-preferences` | Company stage, funding, size, country |
| `/onboarding-v3/diagnostics` | Role, location, remote, work authorization, hot skills |
| `/auth/callback/email`, `/auth/callback/linkedin`, `/linkedin-verification/callback` | OAuth and magic-link callbacks |
| `/email-verification`, `/verify-email/[code]`, `/verify-referral/[code]`, `/work-email-verify`, `/reset-password` | Verification and password reset. `/work-email-verify` marks work experience as "verified / trusted candidate" |

### 3.5 Rewrites
- `/swan/:path*` → API
- `/foxit/:path*` → PDF/DOCX conversion
- `/orion/:path*` → Orion service
- `/remote-jobs/:path*` → minisite
- `/jobs/email-list/:id` → `/jobs/recommend?id=:id`
- `/robots.txt` → `/robots_prod.txt`

---

## 4. Marketing site IA

### 4.1 Global header (confirmed on every marketing page)
- Logo, which links to `/`.
- A segmented toggle between **Job seekers** (`/`) and **Employers** (`/employers`).
- **Employer links:** Pricing (`/employers/pricing`), Customer Stories (`/employers#customer-stories`) and FAQ (`/employers#employers-faq`). There is **no job-seeker pricing link anywhere**.
- **Features menu:** AI Agent (`/ai-agent`) and Resume AI (`/ai-resume-builder`).
- **Buttons:** `SIGN IN` and `JOIN NOW`. Both open the auth modal or `/onboarding-v3/signup`.
- **Trust badges under the hero:** Product Hunt (linked), "featured by OpenAI" (not linked) and Trustpilot (linked).

### 4.2 Global footer (confirmed)
- **Features:** Resume AI, AI Job Match, Insider Connections (`/job-referral`), AI Copilot Orion, Job Autofill, H1B Jobs, TNT Network, Interview Questions.
- **Blog:** Is Jobright Legit?, Success Stories, What Top AI Companies Are Looking For, Jobright AI Agent Launch, Top Entry Level Jobs (`/entry-level-jobs`), Top U.S. 100% Remote Jobs (`/remote-jobs`).
- **Related Tools:** AI Job Assistant, AI Cover Letter Generator, AI Resume Helper, AI Job Tracker, AI Fraud Detection.
- **Information:** About Us, Privacy Policy, Terms of Service, Partners.
- **Social:** LinkedIn, Instagram, TikTok, X, YouTube, Facebook.
- **Search widget on some pages:** Job Title, Work Model, Country (United States), City, Experience Level and a `GO` button that leads to the `/jobs/[visit]` SEO pages.
- **"Check Out Our Popular Job Lists":** 10 rotating role-in-city links.
- **A newer footer, seen in `_app` strings,** adds: Career Coaching, Ultimate Intern Jobs, Jobright for Good, Mastering Interviews, Energize Your Job Search, How To Write A Resume, Explore All and For Employers.

### 4.3 Recurring landing-page template (confirmed across about 30 pages)
Every page follows the same sequence:
1. Hero: headline, subhead, and a primary CTA ("…for FREE") that links to `/onboarding-v3/signup?from=<page>`.
2. A three-number stat strip.
3. Three alternating feature sections, each with a screenshot and a repeated CTA.
4. A "Join the largest job board" strip claiming 400,000+ new jobs today and 8,000,000+ total jobs.
5. A testimonial carousel. The same 7 to 8 testimonials are reused across pages.
6. A 4-step "How it works".
7. An FAQ accordion.
8. A closing CTA ("Try Jobright for Free").
9. The footer.

**Recurring claims used as numbers:**
- 3,000,000 users. Earlier pages and the App Store say 100,000+; the June 2025 press release said 520K.
- 3x interviews and 80% time saved.
- "No.1 Choice for 80% after first use".
- 9.1/10 quality rating, 5 hrs saved per job, 10M jobs trained on.
- 4x interview odds with referrals.

### 4.4 Homepage `/` (confirmed)
- **Hero:** the theme is not hunting for jobs alone, and doing it with AI. The promise is matched jobs, autofill, a tailored resume and insider connections in under a minute.
  - Variant A has one CTA, "Try For Free".
  - Variant B has "Sign up for free" plus "Hire with Jobright".
  - A video sits on the left of the hero.
- **"Real results" stats:** 3,000,000 users / 3x / 80% / No.1 choice.
- **"Access the largest job hub":** live counters for total jobs (8,000,000+) and today's new jobs (400,000+). A **live ticker of the newest jobs** shows company, minutes-ago and title, and each item links to `/jobs/info/<id>`.
- **"No.1 AI job hunting platform":** 5 feature cards, each with a CTA:
  - Personalized AI Job Matches → "Find My Matches"
  - 1-Click Application Autofill → "Start Autofilling"
  - Job Specific Tailored Resume, which claims "in 6 seconds" → "Upgrade My Resume"
  - Insider Referrals → "Get Connected"
  - 24/7 AI Career Copilot → "Ask Orion"
- **Testimonials:** includes HR-leader and author endorsements, such as Grammarly's CPO and a system-design author.
- **FAQ, variant A (server-rendered):** how Jobright differs from LinkedIn; whether it shares personal info; whether it is free; where listings come from; which regions it covers.
- **FAQ, variant B (live), with answers paraphrased:**
  - How the Agent differs: it plans the search, auto-completes applications and gives insights.
  - Are all features available: matching, tailoring and autofill are available now, with "the rest launching in June" (stale copy from 2025).
  - **Is it free: every feature gets daily free credits, and a paid option gives unlimited access.**
  - Countries: **U.S. only for now**, with global expansion "underway".
  - Time saved: up to 80%.
  - Data security: no sharing without consent.
- Evidence: https://jobright.ai/ (browser render, 2026-10-09).

### 4.5 Feature landing pages (all confirmed; URLs are on jobright.ai)

**`/ai-job-match`** (Find jobs that match your resume)
- **Stats:** 3 hrs saved per week, 2x more relevant jobs, 8M jobs.
- **Sections:**
  - Match Score compares skills, experience, seniority, industry and preferences, and shows aligned vs missing skills.
  - Listings are filtered for suspicious or outdated posts, with personalized alerts.
  - Orion explains fit; an "Insights Dashboard" shows alignment on skills, industry, seniority and years of experience.
  - Resume tailoring.
- **How it works:** pick target role and preferences (location, remote, job type, salary) → upload resume → ranked matches → review Match Score and ask Orion.
- **Sample Orion panel sections:** Relevant Experience, Seniority, Skills, Potential Gaps.
- **Views mentioned:** "Job Highlights" and "Top Match Jobs".
- **FAQ topics:** 9 questions, including how the Match Score is computed and whether it is free.

**`/ai-resume-builder`** (Resume AI)
- **Stats:** 9.1/10, 5 hrs, 10M.
- **Sections:**
  - "Fast Mode" builds an ATS-compatible resume in under 3 minutes.
  - "Guided AI Refinement": upload, get an instant "report card", and receive per-job add/remove suggestions from a "graph-based" AI.
  - Instant job matches after refining.
- **Steps:** upload → instant analysis → AI-refined resume → download.

**`/ats-resume-checker`**
- Pitch: find what holds your resume back, such as missing keywords and experience gaps.
- **Steps:** upload resume and target job → run the ATS test → review keyword, skill and experience gaps → improve.
- **About 9 FAQ answers**, including that there is no universal ATS score and that free ATS-friendly templates exist.
- This is one of the few tool pages that **does the analysis before signup**. The backend has `/swan/resume/upload-by-landing-diagnose`, `/swan/resume/landing/diagnose-report` and `/swan/resume/light-diagnose` (confirmed from the API list; that the flow runs pre-signup is inferred).

**`/job-autofill`**
- Promise: one click to autofill applications on "thousands of ATSs".
- **Stats:** 10x faster, 5 hrs per week, 10M applications autofilled.
- **Sections:** works on all major ATSs (none named); tailors a resume on any application site and autofills it; shows a Match Score before you fill.
- **Steps:** install extension → set up profile → open an application → click Autofill → submit.

**`/job-referral`** (Insider Connections)
- **Stats:** 4x interview odds, 70% better connections, 4 hrs per week.
- **Sections:**
  - Personalized referral suggestions: former coworkers, classmates and the hiring team.
  - Custom outreach templates.
  - **Email addresses unlocked for recommended connections**, claiming 3x response.
- **Steps:** sign up → connect LinkedIn → choose a job → get connection recommendations.
- **FAQ:** Jobright only uses public or shared LinkedIn profile data and does not read your contacts.

**`/orion-copilot`**
- Promise: 24/7 genuine career support.
- **Stats:** 10M JDs trained on, 4 hrs saved, 80% better interview-prepared.
- **Sections:** 24/7 guidance (resume tuning, interview prep, tactics, career paths); company-specific interview insights; instant expertise.
- **Steps:** sign up → chat → get recommendations → prep with company insights.
- **Example in-app prompts** (from bundle strings, confirmed):
  - "How closely do my skills match this job's requirements?"
  - "Add 'Software Engineer' to my job titles."
  - "Exclude 'Java Developer' roles from my search."

**`/ai-agent`**
- Promise: skip the hunt and land more interviews. The Agent finds roles, customizes the resume and applies for you.
- **Three cards:**
  - "90% Job Search Automation" → "Unlock Auto-Apply"
  - "Your Own AI Career Expert" (search plan, skills to sharpen, how to outshine peers) → "Boost My Job Search"
  - "Interview-worthy Job Matches" → "Start Matching"
- **FAQ:** the six Agent questions listed in §4.4 variant B.

**`/h1b-jobs`**
- Promise: never miss H1B jobs.
- Content: fresh postings, company sponsorship insights, and AI matching with resume edits.
- **10 "H1B Visa Sponsored {role} in {city}" list links.**

**`/tnt`** (Top Talent Network)
- Headline theme: "Team is the moat". A private network matching top talent with top AI startups.
- **Stats:** 200,000+ talents, 150+ AI startups, 90% match success.
- **Startup logos:** Mercor, Cresta, Genspark, OpusClip, Lindy, OpenArt.
- **Vetting stats:**
  - Talent: 71% top universities, 58% big tech, 43% startup experience.
  - Startups: 100% funded, 60% top-VC backed.
- **Benefits:** Interview Fast-Track, Hidden Opportunities, recruiters reach out to you.
- **Steps:** private profile → join TNT → one-click apply or startups pitch you → hiring team reviews first.
- **CTAs:** "Join as Talent" and "Start hiring".
- **FAQ:** is it free, privacy, can I join while employed, criteria.

**`/interview-landing`** (Real interview questions)
- **Stats:** 6,656+ questions across 328+ companies, "100% validated source".
- **Sample cards:** company, question title, difficulty (Medium/Hard), level (New Grad, L5, Lead/Staff) and role.
- **Company tiles with counts:** Apple 259, Netflix 141, Anthropic 320, NVIDIA 115, Uber 363, Stripe 320, LinkedIn 199, Salesforce 125, plus "+330 top firms".
- **Feature chips:** Fresh Question Bank, Company-Specific Prep, Step-by-Step Approaches, Verified AI Solutions.
- **Steps:** choose company → see real questions → practice with solutions → get the offer.
- **Growth:** FavTutor counted 10,033 questions across 434 companies on 2026-08-21, so the bank is growing fast (likely).

**`/coach-landing`** (1:1 career coaching and "Deep Dive" sessions)
- **Stats:** 5k+ sessions, 4.8/5, coaches average 12+ years of experience.
- **Sections:**
  - Find out why you aren't getting interviews (1:1 review).
  - Live Deep Dive sessions led by industry experts.
  - Turn applications into interviews.
- **Steps:** choose coach → share resume and target jobs → meet → get recruiter replies.
- **CTAs:** "Book a Coaching Session", "Explore Deep Dive Sessions".

**`/fake-candidate-detection`** (employer side)
- A free Chrome extension that runs inside Greenhouse, Lever, Ashby and other ATSs.
- Checks 230+ signals (LinkedIn, public records, phone, email) and flags stolen identities and fake work history.
- Claims 10,000+ recruiters.

**`/employers`** (AI recruiter)
- Positioned as "The AI recruiter for tech companies", built on the 3M-user network.
- **Agent pipeline:** Plan → Source → Verify → Evaluate → Outreach, with a live demo of sourcing "angles" (Precise, Competitor, Adjacent, Skill-based).
- Trial limited to one role, no credit card.

**`/employers/pricing`**
- **$499 per recruiter per month**, one active role per recruiter. First 10 matches within 24h, then 10 to 20 per week. ATS sync, cancel anytime.
- Annual plan: "Talk to us".
- Includes a cost-to-fill calculator.
- **Key insight:** the AI recruiter **contacts Jobright's own users "as Jobright"** about roles. This connects to the `/candidate-preferences` page in §10.12 (inferred).

**`/about`**
- **Mission:** equal opportunity to build a dream career.
- **Value props:** meaningful personalization, guided coaching, automating burdensome work, job coverage.
- **Origin story:** CEO Eric Cheng's 2021 gap year.
- **Founders:**
  - Eric Cheng, CEO: CMU MS, early at Box, founded Fangcloud.
  - Ethan (Yudian) Zheng, CTO: HKU PhD, NewsBreak feed, Twitter Ads ranking.
- **Values:** jobseeker first, job transparency, deep empathy, integrity.

**`/partners`:** a small AI-partner list (OpenArt, Collov AI, TemPolor).

**`/security`**
- Private profiles, suspicious-login alerts, regular assessments.
- Encryption at rest and in transit; hosted on AWS, GCP and Azure.
- Account safety tips, scam education, employer 2-step verification.
- Contact: support@jobright.ai.

**`/mobile-app`:** promotes the app (match, referrals, real-time alerts) with App Store and Google Play buttons.

**`/compare/{slug}`** (11 competitors, "Updated May 2026")
- **Structure:**
  1. Hero: "Jobright vs X".
  2. User ratings comparison: Jobright shown at 4.8 from 1,461 reviews.
  3. A "Bottom line" summary.
  4. A side-by-side mock.
  5. A 20-row feature table.
  6. "Why choose Jobright".
  7. A verdict ("Choose X if… / Choose Jobright if…").
  8. FAQ.
- **The 20-row table is Jobright's own canonical feature list**, which makes it a good checklist for us:
  - **Discovery:**
    - AI job matching with fit score
    - Proactive matching
    - Salary insights and market data
    - Hidden jobs filter
    - Multiple saved filters
    - Instant job alerts
    - Search across boards
  - **Resume and application:**
    - AI Agent auto-apply
    - AI custom resume
    - AI cover letter
    - ATS score / match rate
    - 1-click autofill
  - **Networking and interview:**
    - Email connection for referral
    - Live career coach
    - Insider referral discovery
    - AI mock interview
    - LinkedIn profile optimization
  - **Platform:**
    - Chrome extension
    - Application tracker
    - Free tier

**Campaign list pages:**
- `/entry-level-jobs` and `/intern-jobs`
  - Hourly-updated lists sourced from "200K+ company career sites, LinkedIn, Indeed etc.".
  - Show total and new-today counters; the intern page showed 80,013 total and 3,203 new.
  - Emoji category tabs: Software Engineering, Engineering and Development, Data Analyst, Business Analyst, Accounting and Finance, ML and AI, Consulting, Marketing, Project Manager, Product Management, Arts and Entertainment, Legal and Compliance, Education and Training, Creatives and Design, Customer Service, HR, Public Sector, Management and Executive, Data Engineer, Sales.
  - Side links to guides and to Jobright's custom GPTs ("ChatGPT - Resume", "ChatGPT - Interview Pro").
- `/marketing-jobs`
  - Industry tabs (E-commerce, Consumer Goods, Beauty, Tech & SaaS, Media and Gaming, Financial Services, Travel, Healthcare, Real Estate, Manufacturing, Education).
  - A table filter: Title, Company, Company Industry, Exp Level, Job Function, Role Type, Work Model.
- `/top-jobs`: alerts only when top companies hire.
  - Lists: "Top Opportunities", "Founding Roles", "Lightspeed Growth", "Established Leaders".
  - Function chips: AI Engineer, ML Engineer, Data Scientist, Full Stack, Backend, PM, Forward Deployment Engineer, Growth, Sales.
  - Experience chips: New Grad through Lead/Staff.
- `/SWE-intern`, `/data-science`, `/tools/grad-jobs`: homepage clones with segment-specific heroes.
- `/remote-jobs-usa`: "Real Remote Jobs" counter page, showing 339,163 total remote and 7,643 new.

---

## 5. Job-seeker pricing and gating (not public; reconstructed)

**There is no public job-seeker pricing page.** `/pricing` is not a route, and FavTutor reports it returned 404 on 2026-08-20. Prices appear only after login (likely). The paid plan is **Jobright Turbo** (confirmed in the refund policy, the settings bundle and the agent bundle).

| Item | Free | Turbo | Source / confidence |
|---|---|---|---|
| Custom (tailored) resume generation | 2/day | Unlimited | FavTutor 2026-08-21 (likely); "resume credits" with a "Free Daily Refill" in the agent bundle (confirmed) |
| Autofill | 4/day | Unlimited | FavTutor (likely); "autofill credit" daily refill (confirmed) |
| Cover letters | 2/day | Unlimited | FavTutor (likely) |
| Email finder / "Email Lookup" | 2/day | Unlimited | FavTutor (likely); "Email Lookup" credit label in the bundle (confirmed) |
| Saved filters | 1 | Unlimited | FavTutor (likely); "Your Saved Filters", "Add filter", must keep at least 1 (confirmed) |
| Instant job alerts | 1/day | Up to unlimited (options: 1, 2, 5 or unlimited per day) | `/settings` bundle copy (confirmed) |
| AI Agent | Limited by credits | Unlimited ("no more credit limits") | agent bundle (confirmed) |
| Orion chat | Unlimited | Unlimited | FavTutor (likely) |
| Hidden-jobs filter | No | Yes | FavTutor + compare page (likely) |
| LinkedIn Profile Report | Partial | Full report ("Upgrade to Turbo to view your full report") | bundle (confirmed) |
| Coaching | Paid per session; one 1:1 can be won through "missions" | Included live sessions with senior recruiters (FavTutor); "Turbo Office Hour" webinars | bundle + FavTutor (likely) |
| Resume slots | 5 max | 5 max | `/jobs/resume` bundle: "up to 5 resumes" (confirmed) |

**Turbo prices** (likely; from FavTutor 2026-08-21, OutApply 2026-05 and others):

| Plan | Price | Notes |
|---|---|---|
| Weekly | $17.99 | |
| Monthly | $39.99 | Raised from $29.99 in early 2026 |
| Quarterly | $89.99 | Has a "Save 40%" badge |
| 6-Month | Price unknown | The plan exists per the refund policy (confirmed) |

**Interview passes** (one-time; likely, FavTutor): Company Pass $19.99 for 7 days; All-Access Pass $39.99 for 30 days. The interview bank shows "Limited Access · Unlock Full Access Now" and locked solutions (confirmed in the bundle).

**Monetization mechanics seen in the bundles** (confirmed; API under `/swan/payment/*`):
- `price-v2`, `subscription` and `billing-portal`. Stripe is confirmed by the referral policy's mention of the "Stripe Customer Account Balance".
- **`first-day-offer`:** a "New User Special" countdown.
- **`trial-offer`:** "Welcome to Turbo Free Trial!" and "Try Turbo for 7 days with extra…". FavTutor says there is no public trial, so this may be offer-gated.
- **`winback-offer`.**
- **`unsub-offer`:** a retention discount shown at cancel.
- **`tg-offer`.**
- **`cancel-support-popup-eligibility`.**
- A countdown banner ("Your Special offer ends in…").
- "Get Unlimited Credits" and "Go Unlimited" upsells appear wherever a credit runs out.

**Policies:**
- **Refund policy** (confirmed; `/legal/refund`, updated 2026-07-29):
  - First purchase: full refund within 7 days for Monthly, Quarterly and 6-Month plans, and within 24h for Weekly.
  - Accidental renewal: refund window of 3 days.
  - Prorated refunds are discretionary.
  - No refunds for outcome-based complaints.
  - App-store purchases follow the store's policy, which implies **in-app purchase exists on mobile** (inferred).
- **Coaching policy** (confirmed; `/coaching-policy`):
  - 30-minute 1:1 sessions, booked at least 2 days ahead, with a live-edit Google Doc of your resume.
  - Cancellation refunds: 100% if 2 or more business days ahead, 50% if 1 to 2 days, 0% inside 1 day or for a no-show.
  - You must join within 10 minutes or you count as a no-show; 2 no-shows in 60 days can restrict booking.
  - Contact: coachsupport@jobright.ai.
- **Refer & Earn** (confirmed; `/referral-policy`):
  - Reached from the sidebar: "Refer & Earn", then "Invite Friends".
  - The inviter earns $3 per qualified referral, up to 10 referrals ($30). The invitee gets $3 once.
  - Credit goes to a non-withdrawable "Jobright Balance" that is applied to the next invoice.
  - A referral qualifies only after email verification and completed onboarding, and after passing a risk review (device, IP, payment method).
  - Progress UI shows 0 to 10 slots and "$3 Pending".

---

## 6. Free tools (`/tools` hub; all confirmed as routes)

**The hub is `/tools`.** The tool pages themselves are **mostly SEO landing pages with no working tool on the page.** They share the Resume AI template (9.1/10, Fast Mode, Guided Refinement, Smart Matching, 4 steps, 3 FAQ) and send users to signup with "Improve My Resume for FREE" or "Organize My Job Application". The table records which ones actually work before signup.

| Tool | URL | What the page actually is |
|---|---|---|
| Resume Summary Generator | `/tools/resume-summary-generator` | SEO lander → signup |
| Resume Bullet Point Generator | `/tools/resume-bullet-point-generator` | SEO lander → signup |
| Resume Headline Generator | `/tools/resume-headline-generator` | SEO lander → signup |
| Resume Parser | `/tools/resume-parser` | SEO lander → signup |
| Resume Helper | `/tools/resume-helper` | SEO lander → signup |
| Resume Tailor | `/tools/resume-tailor` | SEO lander → signup |
| Resume Fixer | `/tools/resume-fixer` | SEO lander → signup |
| Resume Checker | `/tools/resume-checker` | SEO lander → signup |
| Resume Rewriter | `/tools/resume-rewriter` | SEO lander → signup |
| Resume Matcher | `/tools/resume-matcher` → **redirects to** `/tools/resume-job-matcher` | Pitch: know your fit before you apply. "See My Resume Match" (upload). Possibly works pre-signup (inferred) |
| Resume Grammar Checker | `/tools/resume-grammar-checker` | SEO lander → signup |
| Resume Maker | `/tools/resume-maker` | SEO lander → signup |
| ATS Score Checker | `/tools/ats-score-checker` | Lander with "Check My Resume for FREE" |
| Check Your Resume Score | `/tools/check-your-resume-score` | Duplicate of the ATS Score Checker (keyword variant) |
| ATS Resume Checker | `/ats-resume-checker` | Pre-signup diagnosis (see §4.5) |
| ATS Resume Builder | `/ats-resume-builder` | Lander positioned on fixing ATS rejections |
| Cover Letter Generator ("Cover Letter Assistant") | `/tools/cover-letter-generator` | Lander. The real feature is in-app, chat-customizable |
| Job Clipper | `/tools/job-clipper` | Lander. In the app this is "External Jobs" (import by URL) |
| Job Tracker | `/tools/job-tracker` | Lander. Describes statuses: Applied, Interviewing, Offer Received, Rejected, Archived, plus external job upload |
| AI Job Assistant | `/tools/ai-job-assistant` | Lander for save/track |
| **Job Alert** | `/tools/job-alert` | **A working logged-out subscription form**, in 4 steps (see below) |
| Grad Jobs | `/tools/grad-jobs` | New-grad homepage clone |
| AI Fraud Detection | `/fake-candidate-detection` | Employer Chrome extension |

**Job Alert form steps:**
1. Email.
2. Upload a resume or give a LinkedIn URL.
3. Optional job filters.
4. Alert frequency: Daily Digest or Weekly Digest.

The form then subscribes the user; the unsubscribe page is `/tools/job-alert/unsubscribe`.

---

## 7. Public job list page (visitor mode): `/jobs/{slug}` (confirmed, from saved HTML of `/jobs/data-analyst`)

The page renders inside the real **app shell**, even for visitors.

- **Left nav:** Jobs (shows the count "1000+"), Resume, Profile, Agent, Coaching, Interview.
- **Title:** "Data Analyst in united states (1000+)", with a result count ("6838 results for 'Data Analyst'").
- **Filter bar:** sort dropdown (default "Recommended"), Location ("United States"), Company, Experience Level, Job Type, Work Model, Date Posted, "All Filters".
- **Sort options** (from the `/jobs/[visit]` bundle):
  - **Recommended**: balanced by relevance, quality and freshness.
  - **Top Matched**: sorted by match score.
  - **Most Recent**: newest first.
- **Job card anatomy**, top to bottom:
  1. Posted-ago ("7 minutes ago") and an **"Early applicant"** badge.
  2. Title.
  3. Company name with a one-line AI company tagline.
  4. Location ("+1 more" when there are several).
  5. Employment type (Full-time / Contract / Part-time / Internship).
  6. Salary, if known ("$98K/yr - $163K/yr" or "$30/hr - $33/hr").
  7. Work model (Onsite / Hybrid / Remote).
  8. Seniority (Entry Level, Mid Level, Senior Level, Director/Executive…).
  9. Years of experience ("2+ years exp").
  10. Applicant count ("Less than 25 applicants").
  11. `APPLY NOW` button.
  12. A `MATCH SCORE` ring, blank or locked for visitors.
  13. Highlight tags: company stage ("Late Stage Co.", "Growth Stage Co."), "H1B Sponsor Likely", "Raised $33B", "Comp. & Benefits", "Culture & Values".
- **After about 20 cards:** a gate saying more jobs are waiting, with a "JOIN NOW FOR FREE" button (copy says "over 1 million" or "over 8 million" jobs).
- **Floating Orion launcher:** "Orion — Your AI Copilot".
- **"Quick Guide" SEO paragraph** about the role in the market.
- **Other visitor states:** a "Not Interested" control; the empty state "No more jobs related to your search"; and a slow-search message ("It's taking us a while… Join Jobright…").
- **Mobile:** a "Mobile navigation" drawer with a Job seekers / Employers switch, Home and Pricing.

---

## 8. Public job detail page: `/jobs/info/{id}` (confirmed, from saved SSR HTML plus the page bundle)

**Page title format:** "{Job title} @ {Company} | Jobright.ai". The H1 breadcrumb reads "{Title} jobs in {Location}". The page has JobPosting JSON-LD: `baseSalary`, `jobLocation`.

**Layout, section by section:**
1. **Sticky header:** tabs `Overview` | `Company`, and buttons `Apply on Employer Site` and `APPLY NOW`.
2. **Hero block:**
   - Company logo and name, plus posted-ago ("24 minutes ago").
   - Job title.
   - Meta chips: location, employment type, work model, seniority ("Entry, Mid Level"), salary range, years-of-experience minimum ("1+ years exp").
   - AI summary paragraph: 2 to 3 sentences combining company and role.
   - Industry tags (e.g. Energy, Renewable Energy).
   - Highlight tags, e.g. "Growth Opportunities".
   - **Work authorization label.** Each has a tooltip explaining it:
     - "No H1B"
     - "H1B Sponsor Likely": the company has sponsored similar roles in the last 3 years
     - "H1B Sponsored": the JD states sponsorship
     - "U.S. Citizen Only"
     - "Security Clearance Required"
     - "Top Investor-backed"
3. **Responsibilities:** about 16 AI-extracted bullets.
4. **Qualification:**
   - Skill chips; chips the user has are highlighted ("Represents the skills you have").
   - **Required** list and **Preferred** list.
   - Under the hood, `detailQualifications` splits requirements into YOE / education / hard skill / soft skill.
5. **Benefits:** AI-extracted list (about 18 items).
6. **Company panel:**
   - Glassdoor rating (e.g. 4.1).
   - One-line description, founded year, HQ, size band, website.
   - **Funding:** current stage, total funding, key investors, latest rounds.
   - **Leadership Team** or **Founding Team**, each with name, title and LinkedIn link.
   - **Recent News:** about 3 press links with publisher and date.
   - H1B history: annual sponsored-job counts and title distribution.
   - Attribution: "Company data provided by crunchbase".
7. **Right rail: "Boost Your Interview Chances".** Three cards, each tagged `FREE`:
   - **Improve Resume Match Score:** "Your Score" vs "Top Applicants", "Must-Have Skills for This Role" chips, and an `Optimize my Resume` button.
   - **Get Referral Via LinkedIn:** "3× Higher Response via Email Outreach", 2 to 5 people at the company (name, title), and a `Draft Message to Connect` button.
   - **Apply Faster with Autofill Plugin:** an `Apply With Autofill` button.
8. **Below the fold, logged in** (bundle strings): "You May Also Like", "Hot Jobs in Popular Locations", "Make your application stand out" (AI Tools → "Build Cover Letter"), and "Apply To Similar Jobs".

**Variants and edge states** (bundle strings, confirmed):
- "This job has closed", with reasons (the employer may have stopped accepting, may not be hiring, or may be reviewing) and an `APPLY to similar jobs` button.
- A repost notice: the date reflects the most recent repost.
- "Posted by Agency".
- "Expires in …".
- "Hiring Manager" contact card.
- **"Direct Apply"** and **"Send My Profile"**, with the copy promise of skipping the applicant queue and being reviewed like a referral. These are TNT / B2B jobs.
- "Invite-Only for Top Talent".
- "Easy Apply" (Jobright Easy Apply) vs "Apply with Autofill" vs "APPLY NOW", which opens the employer site.
- "Apply on Linkedin" / "Apply on Indeed".
- "High Response Rate".
- "Be an early applicant".
- "Applied by Agent".
- Report Issue; Save job / Unsave job; Already Applied.
- JobTarget questionnaire integration (`jobtargetEasyapply`, `jobtargetQuestionnaire`).

**Data model** (from SSR props, confirmed):

`jobResult` fields:
- **Identity and timing:** jobId, jobTitle / jobNlpTitle, jobSeniority, jobLocation(s), isRemote, workModel, publishTime / publishTimeDesc.
- **Pay and type:** salaryDesc, min/maxSalary, employmentType.
- **Summaries:** jobSummary, jdResponsibilitySummary, coreResponsibilities[], skillSummaries[], educationSummaries[], benefitsSummaries[].
- **Recruiter and apply:** jobRecruiter + profile URL, applicantsCount, isCompanySiteLink.
- **Experience:** min/maxYearsOfExperience.
- **Tags:** recommendationTags[], jobTags[].
- **Scores:**
  - recommendationScores[]: featureName / displayName / score, e.g. "q_seniority_match" displayed as "Experience Level".
  - skillMatchingScores[].
  - industryMatchingScores[].
- **Social:** socialConnections[] (firstName, fullName, company, title, linkedinUrl).
- **Skills and taxonomy:** jdCoreSkills[] (skill, score, type hard_skill/soft_skill), firstTaxonomy, jobTaxonomyV3[].
- **Work authorization flags:** isWorkAuthRequired, isH1bSponsor, isCitizenOnly, isClearanceRequired.
- **Other:** repost, hiddenJob, isToB, source/sourceId, lat/lng, countryCode.
- **Qualifications:** qualifications{mustHave[], preferredHave[]}.

`companyResult` fields:
- **Basics:** companyId, name, size, desc, gptShortDescription, categories, gptCategories, foundYear, location, URL.
- **Links:** Twitter / LinkedIn / Crunchbase.
- **Funding:** fundraisingCurrentStage, totalFunding, keyInvestors, latestRounds.
- **People and press:** leadership[], pressReferences[].
- **H1B:** h1bAnnualJobCount[], h1bTitleDistribution[].
- **Flags:** isAgency, isTnt, isForceJobLinkedinVerify.
- **Ratings:** grating{rating, url, count} (Glassdoor).

---

## 9. Onboarding (IA only; another research angle covers it in depth)

Route sequence (confirmed routes; order inferred from bundle copy):
1. `/onboarding-v3/signup`
   - Value props: 2X more qualified matches, 60% time saved, 50% more interview invites.
   - SSO: Google, Apple and LinkedIn, or email + password. Passwords need letters and numbers, minimum 8 characters.
   - Marketing-email opt-in checkbox.
   - An "Account type" switch (Job seekers / Employers).
   - A TNT-specific signup variant.
2. `/onboarding-v3/resume-upload`: upload a resume (PDF/DOC/DOCX, 10MB) or enter a LinkedIn URL, then "Start Matching" or "Skip".
3. `/onboarding-v3/career-goals`: a career goal is required before Next.
4. `/onboarding-v3/mode-selection`: Orion introduces itself and asks whether you are looking in a rush or open with no rush.
5. `/onboarding-v3/diagnostics`:
   - Target role (shows what the role looks like in the market), job function and "Hot Skills".
   - City or area, an "Open to Remote" toggle, and work authorization.
6. `/onboarding-v3/advanced-preferences`: company stage / funding (Seed–A, B–C, D+) / size (500+) / public, and country (US, Canada, UK, India listed).
7. `/matching`: an animated loader that scans the resume or LinkedIn → identifies preferences → builds the matching profile → finds jobs → personalizes. It shows "Feature Highlights" (autofill, LinkedIn connections for referrals).
8. → `/jobs/recommend`.

**Seniority taxonomy** used everywhere (confirmed in `_app`), with descriptions:
- Intern/New Grad
- Entry Level (1 to 3 years)
- Mid Level (2 to 5 years)
- Senior Level (5+ years)
- Lead/Staff (cross-team leader or domain expert)
- Director/Executive

---

## 10. Logged-in web app IA (inferred from route list plus bundle strings; high-confidence inference)

### 10.1 App shell, left sidebar (confirmed labels in a shared bundle)
Top to bottom:
- **Jobs** → `/jobs/recommend`
- **Resume** → `/jobs/resume`
- **Profile** → `/jobs/profile`
- **Agent** → `/agent` ("Your Agent is now available")
- **Coaching** → `/coaching`
- **Interview** → `/interview`
- **Explore** (Beta) → `/jobs/explore`
- **Messages**: likely employer and TNT messages (inferred)

Lower section:
- **Refer & Earn / Invite friends**: "Invite friends to Jobright and earn up to $30"
- **Download App**
- **Feedback**
- **Settings** → `/settings`
- A plan badge ("Free Plan") with **Get Unlimited Credits** / Turbo upsell

Floating elements:
- **Orion** chat drawer, which opens with "Ask me anything…"
- **Smart Job Autofill** promo card ("Apply to jobs 5x faster and save hours every week")

Visitors see the same shell with Jobs, Resume, Profile, Agent, Coaching and Interview.

### 10.2 Jobs: `/jobs/recommend`
- **Top tabs, with counts:** **Recommended | Liked | Applied | External**. Counts come from likedJobCount / appliedJobCount / importedJobCount.
- **Saved filters ("Your Saved Filters"):**
  - Multiple named filter sets for different roles, with instant switching via "Add filter" and "New Filter".
  - At least one must remain.
  - Free: 1; Turbo: unlimited.
- **Filters drawer** ("Basic Preferences" / "Advanced Preferences", confirmed labels):
  - Job title(s) and **Excluded Title**
  - **Job Type**: Full-time, Part-time, Contract, Internship
  - **Work Model**: Onsite, Hybrid, Remote
  - **Location**: country, city selector, multiple locations, radius ("preferred distance around your chosen location")
  - **Experience Level**: the 6 levels in §9, plus **Required Experience** in years
  - **Date Posted**: e.g. Past week, Past month
  - **Minimum Annual Salary** ("Any salary")
  - **Work Authorization**: H1B sponsorship filter, plus **Exclude Jobs with Limitations** (hides citizen-only and clearance roles)
  - **Industry** / **Excluded Industry**
  - **Skill** / **Excluded Skill**
  - **Role Type**
  - **Job Source**
  - **Company Stage / Funding Stage / Company Size**: Early (Seed/A), Growth (B/C), Late (D+), Public
  - **Exclude Staffing Agency**
  - **Company** (include) / **Exclude Company**
  - **Hidden jobs** (Turbo, likely)
- **Sort:** Recommended / Top Matched / Most Recent. Orion can change the sort by chat.
- **Card actions:**
  - Like (save) / Unlike.
  - Apply. After applying, a confirm prompt moves the job to Applied ("You'll find this job in your 'Applied' list").
  - **Not Interested.** Reason picker: hide this company, hide the same title, no H1B, requires clearance, requires citizenship, experience level wrong. Some reasons auto-update the filters.
  - Report Issue (fake or scam). A scam report prompts the Exclude Staffing Agency filter.
  - Share a job (`/swan/share/job`).
- **Feed-level UX:**
  - **Daily satisfaction survey**: 0 to 10 scale ("How would you rate the job matches you've seen today?"). Scores below 8 ask for reasons.
  - **Skill nudges**: "Do you have these skills?" chips, then "Skill added! Expect more tailored results".
  - **Zero results**: shows what is limiting the search ("X is set to Y"), with suggested filter relaxations and "Update Now". Endpoint: `suggested-conditions-v2`.
  - **Resume health banner**: "Your Resume Needs Attention", with Urgent / Critical / Optional issue counts.
  - **LinkedIn nudges**: "Unlock Better Matches", "Unlock Your Network", add LinkedIn URL.
  - **Missions / gamification**: complete missions to win a 1v1 coaching session; "Your Personal Career Coach".
  - **Webinars**: "Turbo Office Hour" and "The Deep Dive Series" (Save My Spot / Seat confirmed / Fully Booked).
  - **Rate-limit toasts**: "You're refreshing too fast".
  - **Install-app prompt.**
- **Orion in the feed:**
  - "Not seeing the right jobs?" guide.
  - Quick chips: "Salary too low?", "Tired of scam jobs?", "Adjust current preference", "Top Match jobs", "Ask Orion".
  - Orion edits preferences in chat ("Preferences updated! Check out the latest job matches"), then asks "How do you like your updated job list? Looks better / Not quite".

### 10.3 Job detail (logged in)
Everything in §8, plus:
- **Personalized match score** with breakdown. Sub-scores: Experience Level, Skill, Industry Experience; `_app` also shows Education Match. Example per FavTutor: an 82% match broke down as 100 / 69 / 80. Tiers: Strong / Good / Fair (likely).
- **Orion tabs** in the drawer: "Analysis", "Job Highlights", "Resume Tips", "Recommended Jobs".
- **Insider Connection @ {Company}**, grouped as **Beyond your network / From your previous company / From your School**:
  - Email finder flow: "Fetching Contact Info" → "Contact Info Found!" or "Not Found".
  - Paste any LinkedIn URL to find an email.
  - "Prepare a LinkedIn message", "Connect On LinkedIn".
  - Locked contact preview for Free users.
- **Custom Resume flow:**
  1. Generate Custom Resume.
  2. Review the diff: "Missing Skills Added", "Summary Enhanced", "Relevant Skills Highlighted", "Recent Work Experience Enhanced".
  3. Per change, choose: Yes keep it / No remove it / "I used something similar" (then "Here is what I actually did").
  4. Optionally "I Want to Tweak It", using AI Rewrite chat chips such as "Use stronger action verbs…", "Shorten my summary…", "Remove skills not related…".
  5. Confirm Custom Resume.
  6. Download (PDF) or Export to Word.
- **Cover Letter:** Generate Cover Letter → Confirm → Download.
- **Application status:** Applied, then progress through the tracker statuses ("Application status updated! This job has been moved to your '…'").
- **Add to Agent:** "Job added to Agent. Open Agent to start applying".

### 10.4 Liked: `/jobs/liked`
- Saved jobs, each marked Active or Closed.
- Empty state: no liked jobs yet, with a link to Recommended.

### 10.5 Applied: `/jobs/applied`
- Application tracker with search ("Search in Applied jobs").
- **Statuses** (from the `/tools/job-tracker` page): Applied, Interviewing, Offer Received, Rejected, Archived.
- Empty state with a CTA.
- The Agent page also has its own "Application Tracker", with a search by title or company.

### 10.6 External: `/jobs/external`
- "Add a New Job": paste a job URL, then "Get Job Details".
- **States:**
  - Analyzing.
  - Details ready to review.
  - Partial: "Some details were found. Please fill in the rest", with a company-name field.
  - Nothing found on the page.
  - Invalid URL.
  - "External Job Added", then the job gets a match score, tailoring and apply.
- **Rate limits:** too many attempts locks the feature for 1 hour; repeated abuse suspends it for 7 days.
- After an import, the app may suggest updating the filter to see similar jobs.

### 10.7 Explore (Beta): `/jobs/explore`
Browse by the 18 emoji function categories: Software Engineering, Engineering and Development, Data Analyst, Business Analyst, Accounting and Finance, ML and AI, Consulting, Project Manager, Product Management, Arts and Entertainment, Legal and Compliance, Education and Training, Creatives and Design, Customer Service and Support, HR, Public Sector and Government, Management and Executive, Data Engineer.

### 10.8 Resume: `/jobs/resume` and `/jobs/resume/edit/[id]`
- **Manager:**
  - Up to **5 resumes**, with a "You have N saved out of 5 available slots" counter, **Primary Resume** and "Add Resume".
  - Per resume: Edit Resume Info, "Update to Profile" (syncs to the autofill profile), Export, Delete. The primary resume cannot be deleted until another is set as primary.
  - **Mobile gate:** advanced analysis and custom resume generation require a desktop ("Visit Jobright on PC").
- **Resume analysis / diagnosis:**
  - Issues ranked **Urgent / Critical / Optional**.
  - Overall rating Excellent / Good / Fair / Poor.
  - Three tone-graded headline messages, from "strong foundation" to "critical issues may be costing you".
  - Status: "Analysis Complete" or "Failed".
  - API: `/swan/resume-rewriter/diagnose/*`.
- **Editor sections:**
  - Personal Information, Summary, Education, Work Experience, Projects, Certification, Achievements, Languages, Publications, Extracurricular Experience, Reference.
  - Custom Section, either structured or text.
  - Skills, as skill groups.
  - Multiple roles at the same company merge on export.
- **Templates ("Quick Formats"):**
  - **Standard**: popular, ATS-friendly
  - **Compact**: one-page
  - **Centered**: header centered with an accent divider
  - **Structured**: section name left, content right
  - **Split**: two-column
  - **Color**
- **Formatting:**
  - Font picker: Inter, Helvetica, Arial, Georgia, Roboto, Carlito, Garamond, Poppins, Montserrat.
  - "Reset formatting".
  - **Fit Resume to One Page**, with too-long / too-short errors and a revert option.
- **AI Rewrite chat:** remembers chats and preferences; "Here are N new versions, pick one"; revert to the previous version.
- **Export:** PDF or Word (Word goes through `/foxit` conversion).
- **File-name presets:** Name + Job title + Date / Name + Job title / Name + Target company / Name only.

### 10.9 Profile: `/jobs/profile`
- **Sections:** Personal Information, Education, Work Experience, Skills, **Equal Employment** (EEO, including "I prefer to self-describe"), **Verified Work Experience**, LinkedIn URL, and Others (common application questions).
- **Verified Work Experience:** verify via work email at `/work-email-verify`; copy says verified candidates are 2x more likely to be viewed by recruiters.
- **Guided completion wizard:** basic info → review education → double-check work experience → the last step is EEO, used only for autofill.
- **Completion card:** "Complete Profile", "Install Extension", then "Congrats! You're all set".
- **Privacy note:** profile data is used only for matching and resume optimization and is never shared without consent.

### 10.10 Agent: `/agent` (the largest bundle, about 650KB)
- **Chat-led setup**, five steps per FavTutor (likely), matching the bundle copy (confirmed):
  1. **Confirm Profile.**
  2. **Refine Target Role**: rate 3 sample matches 👍/👎 and give reasons for 👎 → "Refine my matches".
  3. **Assess Job Market Fit**: a **Job Search Competitiveness Report**.
     - Takes 30 to 40 seconds to generate.
     - Compares your years of experience and degree against similar applicants and open roles.
     - Tier labels: Exceptional / Great / Strong / Promising / Emerging.
     - "Suggested Updates to Your Job Preferences", which can unlock N more quality jobs.
  4. **Activate Autofill**: install the Chrome extension in 3 steps, then "I've installed it". Version and installation are checked.
  5. **Agent Settings:**
     - **Agent Mode** vs **Supervised Mode** (pauses for confirmation at resume creation and at final submit).
     - Primary resume, with the option of the Jobright Template or the original file.
     - Toggles: "Customize my Resume for Each Application" and "Generate Cover Letter for Each Application".
     - **Common Application Questions.**
- **Run loop:**
  - Agent says it is fetching matches.
  - **Top Matches** list → Add / **Add All** → **Added List**.
  - Per job, a task state machine:
    1. Choose Resume
    2. Generate or Confirm Custom Resume ("1 resume credit will be used")
    3. Analyze application site
    4. Fill out application form ("1 autofill credit will be used")
    5. Fill in N missing fields
    6. **Submit Now**, or "I've applied" for manual jobs
    7. Job Application completed
  - Other job states: "This job requires manual application"; "autofill only on the application site".
  - Cancelling a task stops the agent and removes the job; this cannot be undone.
  - Status labels: Action Required / Completed / In Progress / Revise.
- **Credits:**
  - Resume Credits and Autofill Credits, with a **Free Daily Refill**.
  - Running out shows "Go Unlimited" (upgrade to Turbo).
  - After upgrading: "Congrats on Upgrading to Turbo! … unlimited access to the Agent".
- **Errors:** "Extension Not Detected"; task timeout; no jobs match → "Edit Preferences".

### 10.11 Coaching (`/coaching`, `/coaching/discover`, `/coaching/bookings`) and Interview (`/interview`, `/interview/[companyId]`)
- **Coaching:** browse coaches and Deep Dive sessions, book, and view my bookings. The policy is in §5.
- **Interview:**
  - Company directory ("Browse Companies").
  - Per company: questions filtered by **Topic**, **Seniority** and keyword search.
  - Lock states: Unlocked / Limited Access / Locked, with "Unlock Full Access Now".
  - **An in-browser coding runner:** pick a language, run sample cases, then Accepted / Failed / test results.
  - "Loading solution…", with a solution-language selector.
  - Report a question with reasons: unclear, wrong solution, wrong tags, duplicate or outdated, wrong test case, code won't run.
- **`/voice-chat`:** a voice session. Likely the AI mock interview, since "AI Mock Interview" appears in the compare table (inferred).

### 10.12 `/candidate-preferences` (new in 2026; confirmed strings, purpose inferred)
- A **logged-out, email-magic-link** page: "We sent a secure link to …", "Email me a link", with a resend timer.
- **Title:** "Manage job preferences" / "Tell me what you're looking for". A "Career agent is thinking" state.
- **Fields:**
  - Current status: Actively looking / Open to the right role / Not looking. "Not looking" offers **Pause for 6 months**.
  - Target roles.
  - "Where are you willing to be based?" Options: within or anywhere in the US, city search, and IP-suggested locations.
  - Work model.
  - Minimum base salary, or decline to share.
  - Visa sponsorship: Not needed / Will need it.
  - Company stage: Early (1–20), Growth (20–500), Late (500+), Public, or No preference.
  - "Dream opportunity" / "Ideal role & company", as free text.
  - "What matters most to you in your next job?"
  - Roles or companies to avoid.
  - **"Hide me from {current employer}"**.
  - An optional resume (PDF/DOC/DOCX ≤10MB).
- **Outcomes:** "Your job opportunity emails are paused", or "Create a free Jobright account"; your preferences carry over.
- **Interpretation (inferred):** this is the candidate-side endpoint of the employer AI recruiter's outreach emails. Passive users manage their preferences from email without logging in. This is a two-sided marketplace loop.

### 10.13 Settings: `/settings`
- **Job Alerts Frequency:** up to 1, 2 or 5 per day, or Unlimited. The copy says alerts go out within the first hour of posting. Free is capped at 1 per day.
- **Subscription management** (FavTutor): plan, price, renewal date, Unsubscribe (which triggers the unsub-offer), and the Stripe billing portal.
- **Preferences** (`_app` errors reference them): resume preference, Easy Apply preference, Easy Apply reminder, "user extra config".
- **Gmail connection** ("Please connect your Gmail to continue"). Likely used for email outreach or application tracking (inferred).
- **Danger zone:** Log out, and Delete my account (permanent deletion of the account and all data, with a confirm dialog).

---

## 11. Notifications and emails (confirmed unless noted)

- **Instant job alerts:** sent within the first hour of a posting; 1 per day on Free, up to unlimited on Turbo (`/settings`).
- **Daily or weekly digest** from the logged-out Job Alert tool (`/tools/job-alert`). Unsubscribe at `/tools/job-alert/unsubscribe`; feedback via `/swan/feedback/job-alert/unsub`.
- **Email job lists** that deep-link into the app through `/jobs/email-list/:id` → `/jobs/recommend?id=…`.
- **Resume job-alert** (`/swan/resume/job-alert`, plus unsub).
- **Verification emails:** account, edu email (`/swan/auth/edu/*`) and work email. Referral email verification (`/verify-referral/[code]`).
- **Subscription renewal reminders** (`/legal/sales`) and refund confirmations.
- **Coaching:** booking confirmation with meeting link, coach-cancel notification, follow-up survey (`/coaching-policy`).
- **Career-agent preference emails** with a magic link, which can be paused for 6 months (`/candidate-preferences`).
- **Marketing opt-in** at signup.
- **Mobile:** push and instant alerts (App Store copy).

---

## 12. Chrome extension and mobile app

**Chrome extension: "Jobright Autofill – Instant Job Applications, Job Match, AI Tailor Resume"** (likely)
- Store ID `odcnpipkhjegpefkfplmedhmkmmhmoko`, per extscope and chromeboard mirrors.
- Reported versions: 1.15.0, updated around 2026-06-29; FavTutor saw an update on 2026-08-18.
- About 200K users; rating 4.7 to 4.8 from about 150 to 326 ratings.
- **Features:**
  - Autofill on thousands of ATS sites.
  - Tailor the resume on the page.
  - Keyword-gap match score.
  - AI resume builder.
  - Job suggestions plus tracker.
- **Install handoff** from the web app ("Only job_apply_popup can create an Autofill install handoff") (confirmed).
- **Uninstall survey** at `/autofill/uninstall` (confirmed). Reasons offered: didn't work on my platforms, filled wrong info, too slow, not enough daily credits, didn't know how to start, pop-up too frequent, not enough matching jobs, found a job.
- **Chrome only** (agent copy says "Available For Chrome Browser Only", confirmed).

**iOS app: "Jobright - AI Job Search"**, id6738236788 (confirmed, App Store)
- Subtitle: skip the hunt, land interviews. Seller: Jobright Inc. Category: Business.
- Rating 4.8 from 1.6K ratings. Version 1.15.0. Requires iOS 13+. English only.
- **Features:** aggregated feed, match scores, insider hints, instant alerts, application status tracker, U.S. roles only.
- **Release history:** 1.10 added dark mode; 1.9 added multiple resumes and resume analysis.
- A Google Play button is on `/mobile-app`, but I did not verify the listing.

---

## 13. Backend API surface (confirmed path names from the `_app` bundle; useful for data-model planning)

| Area | Endpoints |
|---|---|
| auth | `/swan/auth/{login/pwd, login/apple, register/pwd-v3, register/sso-v3, logout, verify, verification/*, forget/password, reset/password, cancel-account, edu/email, edu/verify, newinfo, log-email}` |
| filters | `/swan/filter/{get/filter, update/filter-v2, get/suggested-conditions-v2, suggestion/{titles-v3, companies, industries-v2, skills, cities}, title-validation, user-skill/{add,exclude}, digest/{get,save}, job-alert/{get,save}}` |
| recommend | `/swan/recommend/{list/jobs, similar/jobs, tnt/jobs, auto-apply/jobs, count-filter-jobs, count-hidden-jobs, count-search-filter-jobs}` |
| jobs | `/swan/job/{like, unlike, liked/jobs-v2, like/count, apply, unapply, apply/count, apply-status/save, applied/jobs-v3, applied/search-jobs, ignore, report, statistic, direct-apply-v2}` |
| import | `/swan/import/{job, job-by-url, job-by-url/status}` |
| resume | `/swan/resume/{upload, upload-session, upload/status-v2, upload/cancel, onboarding, collection/*, collection/primary/set, export-style/{get,save}, pdf-to-doc, light-diagnose, landing/diagnose-report, upload-by-landing-diagnose, update-linkedin-url, name, job-alert, direct-apply-v2}` |
| resume rewriter / diagnosis | `/swan/resume-rewriter/{diagnose/start, status, result, report, issue, section, global-status, cancel, v2/, add, add/section, update, delete, delete/section, guidance/mark}` |
| resume tailor | `/swan/resume-tailor/{prep, overview, diff, new-diff, apply, save-section, regenerations/, reviews/, history, count, exists, expect-score, keywords-classification, custom-prompt, transcribe, file-name, popup-flag, v2/chat/requests/cancel}` (note: `transcribe` suggests voice input in the tailor chat) |
| payment | `/swan/payment/{price-v2, subscription, billing-portal, first-day-offer, trial-offer, winback-offer, unsub-offer, unsub-offer/activate, unsubscribe, tg-offer, tg-offer/check, cancel-support-popup-eligibility}`, `/swan/credit/{balance-v2, free}` |
| feedback | `/swan/feedback/{job-match/show, job-match/submit, auto-apply, tailor, resume-writer/submit-v2, submit-v2, unsubscribe, job-alert/unsub}` |
| other | `/swan/share/job/*`, `/swan/referral/host`, `/swan/user-settings/{get,save}`, `/swan/profile/sync-resume`, `/swan/email/linkedin-to-email`, `/swan/email/external-linkedin-to-email`, `/swan/popup/office-hour/registration`, `/swan/greenhouse/*` (Greenhouse Easy Apply submit), `/swan/aisearch`, `/swan/ab/user`, `/swan/event/submit` |

The `_app` bundle also contains a long list of careers-site path patterns (`/careers/`, `/hcmUI/CandidateExperience/` for Oracle, `/jobs/apply/`, Greenhouse and so on). They are used to recognize ATS and application sites for autofill and direct-apply (inferred).

---

## 14. Copy tone and design notes

- **Tone:**
  - Upbeat and outcome-focused; second person; lots of "FREE" in CTAs.
  - Emoji in toasts and Orion messages (🚨, 📌, ✅, 😨, 👋).
  - Big unverified multipliers (3x, 4x, 80%).
  - The empathetic "no more solo job hunting" framing is the brand line.
- **Orion persona:** "your AI Copilot for job search". It speaks in first person ("I'm fetching…", "Got it…").
- **Visual (from the homepage screenshot):**
  - Pale lime/mint background, black display type, black pill CTAs, rounded segmented "Job seekers / Employers" toggle.
  - Fonts: Inter is the main font; Montserrat on the Agent page; Poppins appears in the lists.
  - The app uses Ant Design-like components (centered modals, message toasts).
- **Market:** U.S.-only job inventory, stated explicitly in the FAQ and the App Store. English only.

---

## 15. Timeline (what changed over time)

| Date | Event | Source |
|---|---|---|
| 2023 | Founded in Santa Clara; $4.5M seed (Lanchi Ventures, UpHonest) | Jobright blog (likely) |
| 2024-04 to 07 | Public launch; "Jobright 1.0" press release with Orion; Product Hunt #1 Product of the Week and Month (July 2024) | streetinsider PR, blog (likely) |
| 2024 to 25 | The free-tools SEO pages (`/tools/*`) and the taxonomy pages are built out; 78-post blog burst (2025-01) | sitemaps (confirmed) |
| 2025-06-24 | **Jobright Agent** launches with a $3.2M round (Translink, plus Indeed's HR Tech Investments); 520K users claimed | blog, The Register (confirmed / likely) |
| 2025 to 26 | TNT network, Insider Connections email finder, Coaching (1:1 plus Deep Dive), Interview question bank, LinkedIn Profile Report, Refer & Earn | bundles, pages (confirmed) |
| Early 2026 | Turbo monthly price rises from $29.99 to $39.99 | reviews (likely) |
| 2026-04 | Compare pages refreshed ("Updated May 2026"); company acknowledges some sites need manual apply because of anti-bot measures | sitemap, FavTutor (likely) |
| 2026-07-29 | Refund policy rewritten (weekly, monthly, quarterly and 6-month plans) | `/legal/refund` (confirmed) |
| 2026 | Employer product pivots to "AI recruiter, $499 per role per month"; `/candidate-preferences` magic-link page for passive candidates; anti-bot challenge on job pages | pages, bundles (confirmed) |

---

## 16. Edge cases and error states worth cloning (confirmed bundle strings)

- **Rate limits:**
  - "You're refreshing too fast" on the job feed.
  - External import: locked for 1 hour, suspended for 7 days.
  - "Too many requests".
- **Network:** "unstable network" toast with a support contact.
- **Resume upload:** file too large; unsupported file; session expired; URL expired; S3 upload cancelled or timed out; parse failure (with "Failed to use the analyzed resume").
- **LinkedIn URL:** invalid, or the profile can't be found.
- **Free trial being provisioned:** "Your free trial is still being set up".
- **Job states:** closed or deleted job → "The job you clicked on is no longer available, we've refreshed your recommendations".
- **Preferences:** "It seems that we're unable to learn your preferences" → re-ask.
- **Session:** "Looks like your session timed out".
- **Saved filters:** you can't delete the last one. One developer string is in Chinese, which hints at a China-based engineering team (inferred).

---

## 17. Implications for RoboApply (dual brand: RoboHire.io international, GoApply.Top mainland China) (inferred)

- **Two inventories, not one.** Jobright is U.S.-only. Our international brand must aggregate multi-country jobs, with Taiwan in the international market. GoApply.Top needs mainland sources and should drop H1B in favor of hukou/visa-equivalent tags.
- **The SEO engine is a major growth surface.** It has three parts:
  - About 4.5K sitemap-listed role × city pages, plus more unlisted ones.
  - A remote minisite.
  - About 20 tool landing pages that are signup funnels, not real tools. Only the ATS checker, the resume-job matcher and the job-alert form do anything before signup.
- **The core loop to clone:**
  1. Onboarding (resume or LinkedIn → goals → mode → role, location, auth → company prefs).
  2. Feed with saved filters, sort, Not-Interested reasons and daily NPS.
  3. Job detail with a 3–4 dimension match score plus a right rail of three FREE actions.
  4. Custom resume diff review.
  5. Autofill extension.
  6. Agent state machine with credits.
  7. Tracker statuses.
- **Monetization pattern to mirror:**
  - Daily-refilling per-feature credits (resume, autofill, cover letter, email lookup, alerts, saved filters).
  - One paid tier sold weekly, monthly, quarterly and 6-month.
  - Aggressive offers (first-day, trial, winback, unsubscribe save).
  - Paid add-ons (coaching sessions, interview passes).
  - A referral balance.

---

## 18. Open questions

- The exact free credit counts as of October 2026 (FavTutor's August 2026 table may have changed), and the 6-month Turbo price.
- The exact Match Score formula and weights, and the tier thresholds (Strong / Good / Fair).
- What the "Messages" sidebar item contains: TNT and employer chats, or recruiter outreach replies.
- Whether `/voice-chat` is an AI mock interview, voice Orion, or the voice input for resume tailoring.
- The Google Play listing details; whether in-app purchase is offered on iOS; the mobile app's navigation.
- The content of `/coaching/discover` (coach profiles, prices per session) and Deep Dive session pricing.
- The Chrome extension's supported ATS list and its exact permissions. The official store page could not be fetched because of redirects.
- The full email lifecycle: welcome series, trial expiry, and winback cadences.
