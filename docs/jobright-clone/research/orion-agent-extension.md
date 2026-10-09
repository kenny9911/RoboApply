# Jobright research: Orion copilot, Jobright Agent (auto-apply), Chrome extension, mobile apps

Research angle: Orion (AI copilot), autonomous agent / auto-apply, the "Jobright Autofill" Chrome
extension, and the iOS / Android apps.
Researched: 2026-10-09. Public pages only. No account was created, no sign-in, no form submitted.

## 0. Method, confidence legend, caveats

**Sources used**
- Jobright public marketing pages (fetched 2026-10-09): `/`, `/ai-agent`, `/orion-copilot`,
  `/job-autofill`, `/ai-job-match`, `/job-referral`, `/coach-landing`, `/interview-landing`, `/tnt`,
  `/compare/*`, `robots.txt`, `sitemap*.xml`.
- Jobright's public front-end JavaScript bundles on `static.jobright.ai` (Next.js build ID
  `GQd0ykV_IrfhtmCjLOY2m`, observed 2026-10-09). I read only the user-facing strings (button labels,
  step messages, enum names) to reconstruct logged-in screens without signing in. These are the
  strongest evidence for in-app UI because they are the shipping product's own copy. I did not run
  the app.
- Marketing screenshots and marketing videos hosted on `static.jobright.ai` (viewed frame by frame).
- Chrome Web Store listing and reviews page; App Store listing; Google Play listing.
- Press: PR Newswire (2025-06-24), The Register (2025-06-24), Bloomberg Law (2025-07-02),
  TechCrunch (2024-06-25), Product Hunt.
- Third-party reviews (2025-2026). Most are written by **competitors** (Jobity, Wobo, Scoutify,
  JobHire, LoopCV, Careerkit, Sprout, ResumeJudge, Adzuna, ATS Verification). Treat their claims as
  secondary; several conflict.
- Trustpilot review search pages (agent / orion / extension), read through WebFetch.

**Not reachable / skipped**
- Reddit is blocked to my fetcher; Reddit claims below are relayed through secondary reviews.
- Product Hunt and Trustpilot block scripted fetches with bot checks; I did not try to get around
  them (WebFetch summaries only).
- `robots.txt` disallows `/onboarding-v3/{diagnostics,mode-selection,career-goals,advanced-preferences,resume-upload}`,
  `/jobs/*` (for ClaudeBot), `/legal/*`, `/matching`. I did not fetch those pages. Route names come from
  the public build manifest.
- I did not download the extension CRX file, so I have no first-hand manifest. Permissions come
  from a secondary mirror (extscope).

**Confidence legend**
- **confirmed**: primary source (Jobright page, Jobright JS bundle, store listing, press release).
- **likely**: two or more independent secondary sources agree.
- **inferred**: my reasoning from the evidence.

---

## 1. Executive summary

1. **In-app Orion is now the agent.** In 2024 Jobright launched Orion as a 24/7 chat copilot. By
   2026 the in-app copy merges the two: the Agent page greets the user as Orion and calls it a
   personal AI job search *agent*. Four pillars sit under that greeting: a search plan, matched roles,
   autopilot applications, and ask-me-anything coaching. The Android package ID is
   `ai.jobright.orion`. Reviewers often mix up "Orion" and "Agent" for this reason.
   (confirmed: agent bundle, Google Play)
2. **The Agent does submit applications itself, but only part of the time.** It has two modes:
   - **Supervised Mode** stops for the user's confirmation at resume creation and again at final
     submission.
   - **Automated Mode** runs every step and stops only when it needs information.

   When a site supports automation, Jobright submits from its own servers. It may ask the user for
   an email verification code partway through. When a site does not, the Agent hands off: the user
   opens the employer site, the Chrome extension autofills the form, the user submits, then clicks
   "I've Applied". Many jobs require a fully manual application. (confirmed: agent and shared bundles)
3. **Usage is metered in credits.** Free users get small daily refills of resume, autofill and
   email credits. Turbo (paid) is unlimited. Turbo cost $39.99/month in Aug 2026 and was $29.99
   earlier; weekly and quarterly plans exist and promotions run often. The Agent was waitlisted for
   many users from mid-2025 to at least Aug 2026. The current bundle contains no waitlist strings.
   (likely / inferred)
4. **The extension is the most-praised surface.** As of 2026-10-08 it was v1.24.0 with 300,000
   users and a 4.9 rating from 372 ratings. It fills ATS forms in one click, including EEO and
   veteran fields and generated free-text answers. It can attach a tailored resume, shows a match
   score, and has a field-by-field completion checklist. Jobright names Workday, Greenhouse, Lever,
   iCIMS, Ashby and Workable. It is Chrome-only. (confirmed: CWS listing, Jobright meta tags)
5. **The mobile apps are a lighter surface for finding and tracking jobs.** They cover the job
   feed, match scores, alerts, the tracker, insider hints, multiple resumes and resume analysis.
   They are US-only. The iOS app is 4.8 from 1.6K ratings; Android is 4.6 from about 719 reviews
   with 50K+ downloads. One App Store reviewer describes the intended workflow: save jobs on the
   phone, then apply on desktop with the extension. (confirmed: store listings)

---

## 2. Timeline / evolution

| Date | Event | Evidence | Confidence |
|---|---|---|---|
| 2023 | Jobright founded in Santa Clara by Eric (Yuan) Cheng (CEO, early Box engineer) and Ethan (Yudian) Zheng, PhD (CTO, former AI lead at Twitter/NewsBreak). $4.5M seed led by Lanchi Ventures. | https://techcrunch.com/2024/06/25/jobright-uses-ai-to-help-foreign-workers-navigate-the-us-job-market/ ; https://www.theregister.com/2025/06/24/ai_may_take_jobs_but/ | confirmed |
| Apr 2024 | Public beta; ~50K registered users by June 2024; ~30% foreign workers; H1B filter popular. | TechCrunch (above) | confirmed |
| Jun 2024 | "Jobright 1.0" launch press release. | https://www.newswire.com/news/launching-jobright-1-0-revolutionizing-the-job-search-experience-with-22368935 | likely |
| Jul 16 2024 | Product Hunt launch, tagline "Your AI Job Search Copilot". It ranked #2 of the day, #1 of the week and #1 of the month (July 2024). The maker comment presents Orion as a 24/7 personal AI career assistant. | https://www.producthunt.com/products/jobright-ai-2 | confirmed |
| 2024 | Jobright GPT listed in ChatGPT's GPT directory. Jobright markets itself as the only job-search tool featured in the ChatGPT plugin store. | CWS listing copy; https://whatplugin.ai/gpts/job-7baab | confirmed (claim) |
| 2024-2025 | Pricing tiers reported as Plus $29/mo and Premium $59/mo, later consolidated into a single paid tier, "Turbo". | https://scoutify.com/blog/jobright-review/ | likely |
| Jun 2025 | iOS app 1.8.x shipping (first versions listed Jun 2025). | https://apps.apple.com/us/app/id6738236788 | confirmed |
| Jun 24 2025 | Jobright Agent launched, billed as the first AI career agent that finds, customizes and submits applications. $3.2M round led by Translink Capital, with HR Tech Investments (Indeed's venture affiliate) participating. 520K+ users claimed. Coverage at launch: US tech, education and government roles. | https://www.prnewswire.com/news-releases/jobright-launches-first-ai-agent-to-make-job-hunting-searchless-302488544.html ; The Register | confirmed |
| Jul 2025 | iOS 1.9.0: multiple resumes, on-phone AI resume check, strengths/gaps report. | App Store version history | confirmed |
| Jul 22 2025 | Blog post describes the Agent's 3 pillars: Diagnoses and Plans, Daily Job Scan, Hands-Free Apply. | https://jobright.ai/blog/what-is-the-jobright-agent-automate-your-job-search/ | confirmed |
| Aug 2025 | iOS 1.10.0 adds dark mode. Blog says autofill covers about 90% of major ATSs. | App Store; https://jobright.ai/blog/supercharge-your-job-search-with-jobright-autofill/ | confirmed |
| Nov 2025 | Reviews say auto-apply is still beta and waitlisted. | https://www.usesprout.com/blog/jobright-ai-review | likely |
| Early 2026 | Turbo monthly raised from $29.99 to $39.99. | Wobo, Scoutify, Adzuna, Jobity | likely |
| Mar-Apr 2026 | Trustpilot reviews call it the "beta Job Application Agent". Jobright replies that the Agent has not yet reached everyone and that anti-bot sites force manual applications. | https://www.trustpilot.com/review/jobright.ai?search=agent | likely |
| May 2026 | Trustpilot reviewer mentions autofill with "staged approvals" (matches Supervised Mode). | Trustpilot (agent search) | likely |
| Aug 2026 | Jobity test (2026-08-31) still shows a "You're on the Waitlist" badge with a paid "skip waiting" path. Extension reaches about 200K users. | https://jobity.io/blog/jobright-review ; https://favtutor.com/jobright-ai-review/ | likely |
| Sep 21 2026 | Extension v1.23.1. | https://extpose.com/ext/odcnpipkhjegpefkfplmedhmkmmhmoko | likely |
| Oct 8 2026 | Extension v1.24.0, 300K users, 4.9 rating from 372 ratings. | Chrome Web Store | confirmed |
| Oct 9 2026 | Current web build: Agent copy speaks as Orion. No waitlist strings found in the Agent bundle. "Easy Apply" (in-platform apply) and voice chat routes exist. | JS bundles (see section 3+) | confirmed / inferred |

---

## 3. Orion (AI copilot)

### 3.1 Positioning and evolution
- **Marketing page `/orion-copilot`** (confirmed, https://jobright.ai/orion-copilot):
  - Hero headline is about 24/7 genuine career support. The CTA is "Ask Orion for FREE", which
    links to `/onboarding-v3/signup?from=copilot`.
  - Feature sections cover 24/7 personalized guidance, company-specific insights for interviews,
    and instant expertise.
  - Four highlight tiles: Real-Time Insights, Secured Data Privacy, Continuous Growth with evolving
    AI, Instant Improvements.
  - Claimed stats: trained on 10 million job descriptions, 4 hours saved, 80% of users better
    prepared for interviews.
  - Four how-it-works steps: Sign Up, engage with the chat interface, receive personalized
    recommendations, prepare for interviews with company insights.
  - The FAQ asks whether Orion costs anything, but only the first answer (about personalization)
    is rendered in the HTML.
- **Home page tile**: a "24/7 AI Career Copilot" card with an "Ask Orion" CTA. (confirmed,
  https://jobright.ai/)
- **2024 framing**: a copilot that answers questions, automates search tasks and gives job and
  company insights, but does not submit applications. (confirmed: Product Hunt maker comment; The
  Register)
- **2026 framing**: the Agent page greets the user as Orion, "your personal AI job search agent".
  It lists four promises:
  - crafting an interview-winning search plan
  - finding roles you love that also fit you
  - autopilot applications (resume, cover letter and one-click apply)
  - ask-me-anything career coaching, 24/7

  (confirmed: `static.jobright.ai/_next/static/chunks/pages/agent-70b6a9ee45390efe.js`)
- **Onboarding**: the mode-selection step opens with Orion introducing itself as the AI copilot and
  asking which situation fits. The two options are "I'm looking for jobs in a rush" and "I'm open to
  new opportunities, no rush". (confirmed: `.../pages/onboarding-v3/mode-selection-98ce4c29955b4786.js`)
- **Brand mark**: Orion is a mint-green speech bubble with two dot eyes. It is the avatar in chat
  and in every Agent message bubble. (confirmed: marketing images `orion_1.png`, agent videos)

### 3.2 Where Orion lives in the UI
- **Floating copilot container on job pages.** CSS module names `job-copilot-container` and
  `job-copilot-container-floating` exist. The aria-labels "Open Orion", "Close Orion" and "Orion
  chat" exist. (confirmed: shared chunk `10344-7630c6c855467801.js`)
- **Orion recommendation guide.** A dismissible guide or bubble on the recommended-jobs list
  ("Close Orion recommendation guide"). Its display is gated by a daily-browsing counter, roughly
  "show the bubble after N jobs viewed today". (confirmed string; counter logic inferred)
- **"Ask Orion" on a job.** The Orion cheatsheet tells users to tap "Ask Orion" on a job listing to
  learn more about it or get a tailored resume. (confirmed: shared chunk 10344)
- **Reviewer report:** Orion sits in a corner of the app and "reappears on nearly every page
  change", which the reviewer found intrusive. (likely: https://jobity.io/blog/jobright-review ;
  https://favtutor.com/jobright-ai-review/)
- **Agent workspace (`/agent`)** is a chat-first page with Orion as narrator. Its input placeholder
  invites the user to say what jobs they want or ask anything. (confirmed: agent bundle)
- **Marketing chat mock** (confirmed image `orion_1.2096a255.png`):
  - header: avatar plus "Orion"
  - welcome bubble: Orion introduces itself as a personal AI job search copilot and asks how it can
    help
  - user-side prompt bubbles, e.g. AI-startup jobs in Silicon Valley, H1B-sponsored data analyst
    jobs, behavioral interview prep
  - bottom input with an "Ask me anything..." placeholder and a send arrow

### 3.3 Capabilities (what Orion can do)

| Capability | How it shows up | Evidence | Confidence |
|---|---|---|---|
| Explain job fit or gaps | "Job Fit Analysis" panel with sections Relevant Experience, Seniority, Skills (aligned vs not aligned), Potential Gaps, Job Highlights. A reviewer saw Relevant Experience / Seniority / Education / Core Skills in about 15 s. | https://jobright.ai/ai-job-match ; https://favtutor.com/jobright-ai-review/ | confirmed / likely |
| Compare top matches | "Top Match Jobs" plus a "Show me jobs where I am top candidates" chip and a "Top Candidates" card type. | ai-job-match page; chunk `97342-7f758d8ed7830b3e.js` | confirmed |
| Company insights | Card with Funding (stage, key investors), Basic Info, Leadership Team. In-app job detail also shows Glassdoor rating, H1B Sponsorship, Funding, Leadership Team and Recent News. | marketing image `orion_3.png`; agent bundle strings | confirmed |
| Resume tips / tailoring | Chips for resume tips (to apply, to stand out) and for generating a custom resume tailored to the job. A "1-Click Improvement" visual shows the resume score going from about 5 to 9.0 "EXCELLENT". | chunk 97342; `orion_2.png` | confirmed |
| Cover letters | Chip to write a cover letter for this job. | chunk 97342 | confirmed |
| Insider connections / referrals | Chip to show connections for referral. Results are grouped as From Your Previous Company, From Your School, Beyond Your Network. Contact info lookup states: fetching / found / not found. "Connect On LinkedIn" CTA with a templated outreach message and a Copy button. | chunks 97342, 10344; `connect_*.png` | confirmed |
| Search jobs / edit preferences in chat | Natural-language edits to filters: job type, remote, location, H1B, sector, minimum salary, required skills, IC-only. Orion confirms the change ("Preferences updated!"), re-ranks the list, then asks how the updated list looks ("Looks better" / "Not quite"). | chunk 10344 | confirmed |
| Sort the job list | Requests such as recommended first, most recent first, best match first. Orion confirms the new sort preference. | chunk 10344 | confirmed |
| Show current preferences | Request to show my current job preferences. | chunk 10344 | confirmed |
| Interview prep | Behavioral interview prep in marketing. Reviewers report question generation, behavioral coaching and salary negotiation guidance; good on technical prep, shallow for executive interviews. | `orion_1.png`; https://www.adzuna.co.uk/blog/jobright-review-better-alternative-in-2025/ ; resumehog | confirmed / likely |
| Salary advice | Reviewers say Orion answers salary-negotiation questions. In-product nudges such as "Salary too low?" open preferences at the salary field. | Adzuna review; chunk 10344 | likely / confirmed |
| Career advice / career change | Cheatsheet example: moving from IC to manager with a salary floor and remote preference. | chunk 10344 | confirmed |
| External job actions | Orion can act on imported external jobs (error string "Orion external job action error"). | chunk 10344 | confirmed |
| Job-list feedback | "Orion job list feedback". Users can say what didn't meet expectations (multi-select). | chunks 10344, recommend page | confirmed |
| Scam warnings | A "Tired of scam jobs?" nudge. | chunk 10344 | confirmed |
| Resume audit | Reviewers recommend sending the resume to Orion for an audit before applying. | https://jobhire.ai/blog/jobright-ai-review-and-decision-guide-2026 | likely |

### 3.4 Suggested prompts (product's own cheatsheet, paraphrased)
Source: the "Cheatsheet for Orion, your AI Copilot" quick-guide modal (confirmed, shared chunk
`10344-7630c6c855467801.js`). It encourages users to write in their own words. Sections:

1. **Learn more about a specific job listing.** Tap "Ask Orion" on a job and ask for more about the
   job, its responsibilities, the company's stage, or how well your skills match. You can also have
   Orion customize your resume for it.
2. **Refining your job recommendations, basic filters.** Include part-time roles; prefer remote;
   set location to a city; focus on mid-level roles; only H1B-sponsoring employers; a specific
   sector such as AI; a minimum annual salary.
3. **Advanced filters.** Require specific skills (e.g. Python and SQL); IC roles only, no managers;
   add a job title; exclude a job title.
4. **Using Orion to its full potential.** A free-form multi-constraint request, e.g. a career
   change plus a salary floor plus remote.
5. **How to sort your job list.** Recommended first, most recent first, best match first.
6. **Understanding your job preferences.** Show my current preferences.

Per-job quick-action chips: "Job Highlights", "Resume Tips", "Insider Connections", "Top
Candidates", "Tailored Resume". Each maps to a canned prompt: why this job fits me; resume tips to
apply or stand out; generate a custom resume for this job; show referral connections; write a cover
letter; show jobs where I'm a top candidate. (confirmed: chunk `97342-7f758d8ed7830b3e.js`)

### 3.5 Memory and context
- Orion personalizes from onboarding answers, the resume and other user-provided information.
  (confirmed: `/orion-copilot`)
- A reviewer found Orion beat generic ChatGPT prompting because it had the profile **and
  application history** as context. (likely: resumehog / wobo summaries)
- Chat edits write straight into the saved job preferences and saved filters. The chat is a control
  surface over the same preference model as the filter UI, not a separate memory. (confirmed:
  "Preferences updated", "Your new filters have been saved", and the requirement to keep at least
  one saved filter)
- An optional LinkedIn URL lets matching be personalized and alumni or ex-colleague connections be
  highlighted. Validation messages cover an invalid URL or a profile not found. (confirmed: chunk
  10344, agent bundle)
- No evidence of long-term episodic memory across chats, or of visible chat history. (inferred:
  gap)
- Messages have a "Message feedback" control. (confirmed: chunk 10344)

### 3.6 Limits and gating
- Orion chat is available on both Free and Turbo, without a stated message cap.
  (likely: https://jobity.io/blog/jobright-review ; https://favtutor.com/jobright-ai-review/ —
  "unlimited, 24/7" on both)
- One competitor review claims the free tier allows only "a few copilot interactions per day".
  This conflicts with the above. (unverified: https://scoutify.com/blog/jobright-review/)
- Actions that Orion triggers spend credits: custom resume, cover letter, autofill, email lookup.
  Chat itself appears free. (confirmed credit strings; inferred mapping)
- Upsells that appear inside Orion surfaces:
  - "Upgrade to Turbo Now"
  - LinkedIn Profile Report: partial on Free; "Unlock Full Report With Turbo"; rate-limited with
    "Review limit reached. Try again in …"
  - Turbo Office Hour: a weekly AMA webinar, Thursdays 6:30 PM PST, Turbo-only
  - "1v1 Coaching With Senior Recruiters", with a free-trial popup variant
  - "The Deep Dive Series", booked with a "Free Pass (1 Left)" or "Save My Spot Now"

  (confirmed: chunk 10344)

### 3.7 Reception
- Reviewers praise how specific the fit analysis is: it names missing tools and explains why.
  (likely: favtutor)
- Answers can feel generic for niche technical roles; Orion is most useful for early-career or
  career-switching users. (likely: https://www.vmeg.ai/blog/jobright-ai-review ; scoutify)
- Trustpilot reviews that mention Orion (Feb-Sep 2026): mostly 4-5 stars, for resume edits,
  preference setting (including OPT-friendly filters) and cover letters. One asked for keyword-based
  restructuring outside a job description. (likely: https://www.trustpilot.com/review/jobright.ai?search=orion)

---

## 4. Jobright Agent (auto-apply, "apply for me")

### 4.1 What Jobright claims
- **Press release (2025-06-24):** the Agent scans thousands of sources, matches skills and goals,
  drafts recruiter-ready applications, and submits them. It claims to cut job-search time by 80%
  and double interview rates. (confirmed: PR Newswire)
- **The Register:** the Agent scans 400K+ posts a day and submits on its own **only when the
  candidate appears qualified**. It respects sites that block bots and tells the user to apply
  manually there. Hosted on AWS. Uses OpenAI, Anthropic and Google models plus fine-tuned Llama
  models. In early testing with about 200 users it reportedly saved about 80% of time. The premium
  plan started at $30/month. (confirmed)
- **Bloomberg Law (2025-07-02):** after a resume upload and some basic questions, the bot compiles
  matching postings and sends up to 50 listings a week. (confirmed, partial article)
- **`/ai-agent` page (live 2026-10-09):**
  - hero "SKIP THE HUNT / Land More Interviews" with a promo video
  - "Job Search Agent That's Always On"
  - three feature blocks: "90% Job Search Automation" (CTA "Unlock Auto-Apply"), "Your Own AI
    Career Expert" (CTA "Boost My Job Search"), "Interview-worthy Job Matches" (CTA "Start
    Matching")
  - stats: 3,000,000 users, 3x interviews, 80% time saved
  - FAQ: how the Agent differs; whether all features are available today; free?; countries; time
    saved; data security

  (confirmed: https://jobright.ai/ai-agent)
- **Blog (2025-07-22):** three pillars: Diagnoses and Plans (resume, LinkedIn and goals into a
  plan); Daily Job Scan (scores new posts; only high scorers reach the dashboard); Hands-Free Apply
  (tailors resume, writes cover letter, fills forms, submits, sends follow-up nudges). (confirmed)

### 4.2 Agent setup wizard (in-app `/agent`)
Reconstructed from the shipping bundle (confirmed:
`static.jobright.ai/_next/static/chunks/pages/agent-70b6a9ee45390efe.js`). A reviewer independently
saw the same five-step left rail: Confirm Profile, Refine Target Role, Assess Job Market Fit,
Activate Autofill, Agent Settings. (likely: favtutor) The internal step enum is `INIT`,
`CONFIRM_PROFILE_INFO`, `CONFIRM_JOB_FILTER` / `ALIGN_JOB_PREFERENCES`, `COMPETITIVE_GAP_ANALYSIS`,
`MISSING_SKILLS`, `FILL_APPLICATION_INFO`, `INSTALL_EXTENSION`, `SET_AUTOMATION_PREFERENCE`,
`ENABLE_AUTO_APPLICATION`.

Each step is an Orion chat bubble plus an inline card:

1. **Intro.** Orion introduces itself as the user's job search agent and lists the four pillars from
   3.1.
2. **Confirm Profile.** Orion asks to verify the profile before it starts. The card shows the
   profile, a "Looks Good" button, and a "select or unselect skills to reflect your actual
   expertise" control.
3. **Refine Target Role.** Orion confirms the target roles and shows the current preferences
   ("Edit Preferences").
   - It then shows **3 strong matches** and asks for a thumbs-up or thumbs-down on each. It will not
     continue until each is rated.
   - A thumbs-down opens "What didn't work for you about this job?" with a free-text follow-up.
   - "Refine my matches" produces 3 new roles from the feedback.
   - Empty state: no jobs found, with advice to loosen company, skill or industry filters.
4. **Assess Job Market Fit.** A "Job Search Competitiveness Report", generated in about 30-40 s.
   Report anatomy (from `report.mp4` frames and bundle strings):
   - a percentile headline ("You outperform 82% of applicants targeting similar roles") with a
     gauge labeled GREAT
   - a Strength card and a Level-Up card
   - "You vs. Other Applicants" distributions by Education and Experience Level, with the user's
     bucket highlighted
   - "Boost Resume Score By Adding Missing Skills": selectable skill chips
   - "Broaden Your Job Search": checkboxes such as adding a related job function or enabling more
     work models, with a projected count of extra quality jobs (e.g. up to 1,900)
   - "Confirm & Proceed"; after a change, "Preference updated — running Market Fit analysis…"
5. **Missing skills / tips.** "Improve My Fit" quick tips.
6. **Activate Autofill.** Orion explains that turning on Autofill lets it start applying.
   - The user fills application info: Personal Information, Education, Work Experience, Skills,
     Equal Employment, Profile, and **Common Application Questions**. Required fields are
     validated.
   - The extension install sub-step has three steps: open the Chrome Web Store, "Add to Chrome",
     then "I've installed it".
   - The page detects the extension. Errors: "Extension Not Detected", "Autofill extension not
     installed", "isn't the correct version".
   - Data syncs to the extension; an error string covers a failed sync of employment info to
     autofill.
7. **Agent Settings** ("You're almost done. Choose how you'd like the Agent to work for you"):
   - **Agent Mode**:
     - *Supervised Mode*: the Agent pauses for confirmation at resume creation and at final
       submission.
     - *Automated Mode*: the Agent runs all steps and stops only when it needs information.
   - **Job Application Objective** (button group): `<20`, `20-50`, `>50` "Jobs per week". The
     tooltip says it is a weekly target, not a hard cap.
   - **Resume Preference For Each Application**: "Generate custom resume" (a new job-specific
     resume each time) or "Select from my own resumes" (attach one of the uploaded resumes).
     - Default-resume format choice: original file or a **Jobright-formatted** version
       ("Original Version" / "Jobright Template").
     - A toggle has the Agent customize the resume per job (keywords, relevant experience).
     - A toggle has the Agent generate a cover letter for jobs that require one.
   - The settings are always reachable later ("Access Agent Settings").
8. **Set up Completed.** Confetti animation; Orion says the Agent is ready.

### 4.3 The run loop (daily operation)
(confirmed: agent bundle strings and the `automation.mp4` / `job-match.mp4` marketing videos)
- **Daily batch:**
  - On first visit Orion fetches tailored matches and asks the user to click **Add** on any job they
    want applied to. On later visits it fetches fresh matches for today.
  - Loading copy: "Matching your skills and preferences…", "Preparing your best matches…".
  - Video copy announces the top job matches for today.
- **Job match card:**
  - company logo, "· N hours ago"
  - applicant-count chip (e.g. "43 applicants", "200+ applicants", or "Be an early applicant")
  - location, employment type, level, onsite/remote, years required, salary band, company stage
    (e.g. "Growth Stage", "Early Stage")
  - match % ring
- **Job detail:**
  - "Here's why we picked this" AI rationale
  - score tiles: overall % labeled "STRONG MATCH", Exp. Level %, Skill %, Industry Exp. %
  - location, type, salary, level
  - company block: founded, HQ, size, website, social links, Glassdoor rating; Funding (current
    stage, key investors, total funding, round timeline)
  - "Insider Connection @Company"; Responsibilities; Qualification; Benefits
- **Queue controls:**
  - "Add job to apply", "Browse Top Matches", search by title or company, "Begin Auto-Apply"
  - counters: "N Added", "N Jobs Remaining"
  - tabs: **Active / Completed**; link to the **Application Tracker**
  - "Some Jobs Have Expired" → "Remove & Continue"
  - Cancel a task: a confirmation warns this stops the Agent and removes the job permanently
  - "Reset Agent" returns to setup
  - "Back to Main Site"
- **Per-application pipeline** (task status enum): `JOB_APPLICATION_INITATED` → `GENERATE_RESUME` →
  `CONFIRM_RESUME` → `GENERATE_COVER_LETTER` → `CONFIRM_COVER_LETTER` → `ANALYZE_APPLICATION_SITE` →
  `FILL_OUT_APPLICATION` → `SUBMIT_APPLICATION`, plus `SKIPPED` / `TERMINATED`. Displayed step names
  include "Analyze application site", "Fill out application form", "Generating custom resume...",
  "Generating Cover Letter...", "Submit application" and "Job Application completed".
  - Marketing video sequence: "I'll auto-apply this job for you." → job card → "Generating Custom
    Resume" (preview with highlighted changes) → "Autofilling & Submitting Applications" (form
    fields ticked) → "Application submitted!"
- **Resume confirmation (Supervised):**
  - "Confirm Custom Resume" / "Confirm Resume" / "View Resume"; download as PDF or Word (.docx)
  - Free-text revision: Orion asks what to adjust
  - When a form has a cover-letter field, Orion asks whether to create one or skip and continue
    with autofill
  - Preview limitation: Word documents cannot be previewed but are usable
- **Resume-generation modes** (shared chunk 39128):
  - "Quick Edit": first 2 key experiences only
  - "Full Edit": all experiences, slower
  - an optional box for extra instructions to the AI
  - progress copy: "Making your resume a stronger fit…", "Finalizing your new resume…" (10-20 s);
    "Using advanced AI model now, this may take longer than usual"
- **Hand-off branches when full automation isn't possible:**
  - *Autofill-only sites.* The Agent says autofill works only on the application site. The user
    presses "Apply Now" and the site opens in a new tab with the extension popping up. The user hits
    "Autofill", reviews, submits, and comes back to click "I've Applied".
  - *Manual-only sites.* The Agent says the job requires a manual application: "Apply Now", apply
    in the browser, then "I've Applied", after which the Agent takes over tracking.
  - *Missing fields.* "Fill in Missing Fields": the Agent counts missing fields and asks the user to
    finish them in the browser.
  - *Errors.* A timeout message ("this task took too long… try again") and a message that the
    extension isn't running properly.
  - *Status sync.* "Application status updated! This job has been moved to your '<list>'".

### 4.4 "Easy Apply": server-side submission inside Jobright
(confirmed: shared chunk `39128-8499616773d6f37f.js`)
- Upsell copy promises applying to jobs on certain platforms without leaving Jobright, and
  "Unlimited access to Easy Apply". "Turbo lets you apply to multiple jobs at once" means **bulk
  apply is Turbo-only**.
- Live status steps: getting the application ready → opening the application page → uploading
  your resume → filling in your details → **confirming verification code** → submitting →
  "Application submitted".
- A **"Please enter your verification code" / "Enter code now"** prompt shows that Jobright drives
  the employer site from its own infrastructure. When the ATS emails a one-time code to the
  candidate, the user must paste it back into Jobright. (confirmed strings; mechanism inferred)
- "You have an application in progress" acts as a concurrency guard. "Refresh status" and
  "Checking application status..." poll for results. Easy Apply uses a separate credit
  (`jobright:easy-apply-credit`).

### 4.5 Does it submit autonomously? Verdict
- **Yes, on sites Jobright can automate (server-side Easy Apply), in Automated Mode.** In
  Supervised Mode it waits for approval at resume creation and final submit.
  (confirmed: bundle strings)
- **On many jobs, no.** It falls back to extension-assisted autofill with the user's final click, or
  to fully manual application. Jobright told a Trustpilot reviewer that anti-bot sites require
  manual applications and that it is "continuously working to expand full automation". (likely:
  Trustpilot company reply, Apr 2026)
- **Reviewer evidence of partial automation:**
  - an April 2026 one-star review says jobs must be added manually and most redirect to company
    sites
  - a Reddit user (via favtutor) says it does not submit until the user presses the button
  - Scoutify saw auto-apply break on Workday in a 30-application test
  - Wobo reports weak submission tracking

  (likely)
- **Submission scope:** applies only when the candidate seems qualified (company statement, 2025).
  At launch it covered US tech, education and government roles. (confirmed: The Register)

### 4.6 Availability, waitlist and gating
- **Waitlist history:**
  - Nov 2025: Sprout says most users were stuck on a waitlist and only a small fraction of
    postings were supported.
  - Apr 2026: a Trustpilot reviewer says Turbo users were promised the Agent first but still lacked
    access after almost a year, and Jobright apologized.
  - Aug 2026: Jobity saw a "You're on the Waitlist" badge plus a "Skip Waiting and Enable Agent Now"
    button that led to payment.

  (likely)
- **Current build (2026-10-09):** no "waitlist" or "Skip Waiting" strings in the agent bundle or
  shared chunks. There is an upsell for Turbo members to upgrade the Agent with "no more credit
  limits", and an "Auto-generate Cover Letter" feature announcement with a "Try it Now" CTA.
  (confirmed strings; that the waitlist is retired is **inferred**)
- **Plan gating (Aug 2026 screenshots):** Free gets "AI Agent: Limited Access"; Turbo gets
  unlimited, tagged "New". (likely: jobity, favtutor, jobhire)
- **Credit gates inside the Agent:**
  - Separate **Resume Credits**, **Autofill Credits** and **Email Credits**. Each autofill, resume
    customization or email lookup costs credits; Turbo is unlimited.
  - Before spending, the UI says "1 resume credit will be used." / "1 autofill credit will be used."
  - When credits run out:
    - **Go Unlimited**: upgrade to Jobright Turbo
    - **Free Daily Refill**: come back tomorrow; resume credit and autofill credit refill up to a
      cap
    - **Proceed without Custom Resume / without Autofill / without Premium Features**: apply with
      the original resume and no autofill

  (confirmed: agent bundle)

### 4.7 Reception summary
- **Positive (Trustpilot, Mar-Oct 2026):** fast; "smart and accurate"; aligns keywords without
  over-editing; finds jobs beyond the major boards; staged approvals.
- **Negative:** frequent failures that need oversight; redirects to company sites; autofill losing
  saved info; confusing UI; the waitlist after paying; weak tracking; resume tailoring that invents
  skills or metrics (several reviewers).

(likely: https://www.trustpilot.com/review/jobright.ai?search=agent ; https://www.wobo.ai/blog/jobright-review/ ; https://hirecarta.com/blog/jobright-review)

---

## 5. Chrome extension: "Jobright Autofill – Instant Job Applications, Job Match, AI Tailor Resume"

### 5.1 Listing facts
(confirmed: https://chromewebstore.google.com/detail/odcnpipkhjegpefkfplmedhmkmmhmoko, fetched 2026-10-09)

| Field | Value |
|---|---|
| Extension ID | `odcnpipkhjegpefkfplmedhmkmmhmoko` |
| Version / updated | 1.24.0 / Oct 8, 2026 |
| Users | 300,000 |
| Rating | 4.9 from 372 ratings ("Featured" badge; "Follows recommended practices"; publisher verified as owner of jobright.ai, good record) |
| Size | 2.72 MiB |
| Category | Extension > Tools |
| Languages | English (United States) |
| Monetization | "Offers in-app purchases" |
| Trader status | Non-trader (EU consumer-rights note shown) |
| Support | support@jobright.ai; Terms at jobright.ai/legal/service; Privacy at jobright.ai/legal/privacy |
| Data disclosures | Handles **Personally identifiable information, User activity, Website content**. Declares no sale to third parties, no unrelated use, no credit use. |
| Manifest | MV3 (extscope) |

**Store description (paraphrased).** One click fills "millions" of applications. "Trusted by 500K+
job seekers". It completes every field on thousands of ATS sites. Feature bullets: One-Click
Autofill (up to 10x faster), Resume Matching (missing keywords, ATS score), AI Resume Builder
(tailored, recruiter-optimized), Smart Job Match and Tracker. A privacy promise: only what's
necessary, never sold, encrypted.

**Version and stat history (secondary):**
- 1.15.0, about late June 2026 (chromeboard mirror)
- 1.23.0 (extscope); 1.23.1 on 2026-09-21 (extpose)
- 1.24.0 on 2026-10-08 (CWS)
- Users: 100K+ (early 2026 reviews) → ~200K (Aug 18-20, 2026, favtutor) → 300K (Oct 2026)
- Rating: 4.6 from 41 reviews (jobhire, early 2026) → 4.8 from 326 (Aug 2026) → 4.9 from 372 (Oct 2026)

(likely)

### 5.2 Permissions
- Declared: `storage`, `tabs`, `cookies`, `activeTab`, `scripting`. Broad host permissions, with
  the exact host list paywalled on the mirror; rated high-risk by extscope. (likely:
  https://www.extscope.org/extension/odcnpipkhjegpefkfplmedhmkmmhmoko)
- `cookies` plus broad hosts implies the extension reads the jobright.ai session to sync the
  profile, and runs on any ATS domain. (inferred)

### 5.3 UI anatomy: side panel / popup on an application page
(confirmed: marketing screenshots `autofill_landing/autofill_1.png`, `autofill_2.png`)
- A right-side floating panel over the employer's form:
  - **Header**: Jobright logo; a chevron to collapse
  - **Status pill**: green "Autofill Supported" when the page's ATS is recognized
  - **Job card**: company logo, name and industry; job title; chips for location, salary range,
    seniority, employment type and remote; a **match score ring** (e.g. 80%)
  - **Primary button**: "Autofill", which turns into "Autofilling..." while it runs
  - **Application Dashboard**: a "Completion" bar (e.g. 40%) and a per-field checklist (Name,
    Email, Resume/CV, Cover Letter, Experience, LinkedIn Profile, Full Address). Each field is
    checked, spinning, or pending.
- The form behind it shows the fill: name, phone, resume file attached as
  `<Name>_<Company>_<Role>.pdf`, cover letter attach control.
- Logos shown below the panel: Workday, Greenhouse, Ashby, Lever, iCIMS, "…".
- A related "1-Click Improvement" visual shows a tailored resume with highlighted inserted phrases
  and skills, and a score gauge of 9.0 "EXCELLENT".
- A match card visual: "1 hour ago"; 96% Overall; Exp. Level 100% / Skill 92% / Industry Exp. 96%;
  "Why You Are A Good Fit" chips (✓ Experience Level, ✓ Relevant Experience, ✗ Education, ✓ Core
  Skills).
- Usability complaint: clicking the toolbar icon sometimes does nothing and gives no feedback.
  (likely: CWS review, 2026-09-15, via extpose)

### 5.4 ATS coverage
- Jobright's own `/job-autofill` meta description names MYWORKDAYJOBS, GREENHOUSE, LEVER, ICIMS,
  ASHBY and WORKABLEJOB "and more". (confirmed: page source, https://jobright.ai/job-autofill)
- Blog: about 90% of major ATSs (Workday, Greenhouse, Lever, iCIMS, Ashby, Workable); new platforms
  added regularly; users can **request support for a site from inside the extension**. The blog
  says the extension mimics normal typing so sites won't flag it (company claim). (confirmed:
  https://jobright.ai/blog/supercharge-your-job-search-with-jobright-autofill/, 2025-08-22)
- **Taleo, SmartRecruiters, SuccessFactors, BambooHR, Jobvite: not named** by Jobright. One
  low-quality review lists Taleo and iCIMS. (unverified: atsverification)
- Field reports:
  - Greenhouse and Lever handled reasonably well; custom portals sometimes mis-filled or skipped
    (scoutify)
  - Workday: mostly correct, but a custom start-date question was left blank (secondary)
  - Workday: "autofills annoying Workday fields super fast" (CWS review, 2026-08-06)

  (likely)

### 5.5 What gets filled (incl. question answering)
- Standard contact, work history, education, links, resume upload and cover letter.
  (confirmed: screenshot checklist)
- **EEO and demographic fields** ("pronouns, not a veteran", citizenship, race, veteran, disability)
  that plain resume autofill misses. Dates are remembered correctly across applications. (likely:
  CWS review 2026-10-08; App Store review 2025-02-19)
- **AI-generated free-text answers**: the extension pre-fills "Why are you applying"-style fields
  with reasonable text the user lightly edits. (confirmed: CWS review, Mark Green, 2026-10-08)
- The answer bank is the "Common Application Questions" section in the Agent's application profile,
  synced to the extension. (confirmed string; sync inferred)
- Users are unsure how to answer salary and currency questions for non-US contexts. (likely: CWS
  review 2026-08-13)
- Wrong answers do happen: reviews mention wrong details, so users must review before submitting.
  (likely: Trustpilot, App Store summaries, scoutify)

### 5.6 Resume tailoring inside the extension
- The extension can create a tailored resume in under a minute and **autofill that tailored resume
  into the application**. (confirmed: `/job-autofill`, blog)
- **Edge case / trust issue:** a 2026-10-01 CWS review says applications went out with the resume
  reformatted into **Jobright's template**: a one-page resume became two pages. The user was not
  clearly told and could not find which resume had been submitted. They asked for a final preview.
  This matches the "Original Version / Jobright Template" setting in 4.2. (confirmed)

### 5.7 Match score on other job boards
- The extension shows match scores while browsing LinkedIn and other boards. On one LinkedIn job,
  the extension's score **differed** from the in-platform score. (likely:
  https://hirecarta.com/blog/jobright-review, Apr-Sep 2026)
- The panel shows the match ring on application pages. (confirmed: screenshot)

### 5.8 Saving and importing jobs from other sites
- **External job import** (`/jobs/external`):
  - paste the "URL for Original Posting", then "Get Job Details"
  - the parser fills title, company and description; partial results ask the user to fill the rest
  - the description **must be English**
  - rate limits: retry after 1 hour; **suspension for 7 days** after repeated attempts
  - success: "External Job Added", then check match score, tailor resume and apply; can mark as
    applied ("Done! You'll find this job in your 'Applied' list")

  (confirmed: `.../pages/jobs/external-67a5b06de9b7acc6.js`)
- **Job Clipper** (`/tools/job-clipper`): an SEO tool page. Save jobs into a personal list, track
  status from submission to outcome, upload external postings (it generates a job page for each).
  (confirmed)
- Whether the extension has a one-click "save this LinkedIn/Indeed job" button is **not confirmed**
  by any source. The CWS bullet "Smart Job Match & Tracker" and the external-import flow suggest it
  exists or is planned. (inferred)
- App Store reviewer workflow: save jobs in the phone app, then apply on desktop with the
  extension. (confirmed: App Store review 2025-02-19)

### 5.9 Insider connections and LinkedIn
- Insider connections live in the **web app and Orion**: previous company, school, beyond network,
  and hiring manager or recruiter. There are outreach templates; free gets 2 email-finder uses a
  day, Turbo unlimited. (confirmed: `/job-referral`; likely limits)
- LinkedIn is connected by pasting a profile URL or via LinkedIn OAuth (`/auth/callback/linkedin`
  route). Jobright says it uses only data the user published. (confirmed: build manifest,
  `/job-referral` FAQ)
- No evidence that the extension overlays connections on LinkedIn pages. (inferred: gap)

### 5.10 Install, activation, uninstall flows
- **Install guide** (shared chunk 10344):
  1. Install from the Chrome Web Store.
  2. Open any Jobright page with the extension and click **"Start Applying"** inside the extension
     to activate it.
  3. Find jobs with the **"APPLY WITH AUTOFILL"** button.

  Prompts: "Complete Profile" and "Install Extension". (confirmed)
- Job cards show either **APPLY WITH AUTOFILL** (opens the real employer form, prefilled, user
  submits) or **Apply Now** (employer site, manual). (confirmed: string; jobity, favtutor)
- Install handoff tracking: only the in-app `job_apply_popup` surface may create an install handoff
  with a UUID intent. (confirmed: chunk 39128)
- **Uninstall survey** (`/autofill/uninstall`) reasons, a useful map of failure modes:
  - Autofill didn't work on my target job platforms
  - Autofill filled incorrect information
  - Autofill was too slow
  - Not enough daily credits for me
  - I didn't know how to get started
  - Pop-up was too frequent
  - Not enough jobs that matched my preferences
  - I found a job / No longer job searching

  Ends with a thank-you message. (confirmed: `.../pages/autofill/uninstall-8f4ba7fde454b46a.js`)

### 5.11 Limits / credits for autofill
- Reported free autofill limits differ by source and date:
  - 4 per day (Jobity 2026-08-31; Favtutor 2026-08-21)
  - 2 shared credits per day across tailoring, autofill and insider email (Wobo 2026-07; JobHire)
  - about 1 per day (Careerkit 2026-07)

  Credits reset at midnight and do not roll over. (likely; the allowance has varied over time or by
  A/B test)
- Turbo: unlimited autofill. (likely)
- Some reviews praise free autofill as enough without a subscription. (likely: Trustpilot
  2026-09-21)

### 5.12 Browser support
- Chrome only. A Mozilla Connect thread and CWS reviews ask for Firefox. (likely:
  https://connect.mozilla.org/t5/discussions/is-the-jobright-ai-extension-available-for-firefox/td-p/96011)
- Edge and other Chromium browsers can presumably install from the CWS. (inferred)

### 5.13 Review themes (CWS, Trustpilot)
- **Praise:** big time saver on repetitive fields; better than Simplify Copilot (several reviews);
  good resume upgrades; fills Workday fields; "worth it with Turbo".
- **Complaints:** silent toolbar icon; resume template swap; wrong fields; stopped working after
  paying (anecdote); extension not working after install; the Auto Apply button not working
  (Trustpilot 2026-07-22).

(confirmed CWS reviews page; likely Trustpilot)

---

## 6. Mobile apps

### 6.1 iOS: "Jobright - AI Job Search"
(confirmed: https://apps.apple.com/us/app/id6738236788, fetched 2026-10-09)
- **Listing basics:** subtitle "Skip the hunt, land interviews". iPhone only. Free. Category
  Business, age 4+, English. 64.1 MB. Developer Jobright Inc. (developer ID 1779845454, which has
  only this one app).
- **Rating:** 4.8 from 1.6K ratings.
- **Description (paraphrased):** a single feed of fresh jobs from boards and company sites; match
  scores; insider connection hints for referrals; instant job alerts; an application status
  tracker. Notes that only US roles are listed. Claims 400K new jobs a day and 500K+ US users.
- **FAQ in listing:**
  - browsing, match scores and tracking are free; premium tools are labeled in-app
  - the feed refreshes every few minutes
  - remote and hybrid roles via a location filter
  - the match score compares skills, experience and **salary range** to job requirements, on a
    **0-100** scale
  - the profile is visible only to employers you apply to or choose to share with
- **Version history highlights:**
  - 1.8.0 (2025-06-01)
  - 1.9.0 (2025-07-07): multiple resumes with a "Primary" flag, delete; AI resume analysis on any
    resume; strengths and gaps report
  - 1.10.0 (2025-08-18): dark mode, or follow the system setting
  - then bug-fix releases to 1.12.10 (Feb 2026), 1.13.0 (Apr 26), 1.14.0 (Jul 3), 1.15.0 (Jul 20,
    2026)
- **App Privacy:** "Other Data" may be used for tracking. Linked to identity: contact info (email,
  name), search history, identifiers (user ID, device ID), other data, diagnostics (crash data).
- **Reviews:**
  - Positive (2025-02-19): set an exact number of years of experience; no repeated jobs; finds
    small companies and labs. Use the phone to search and save, because the browser is laggy, then
    the extension on desktop.
  - Positive (2025-03-06): got a summer offer.
  - Negative (Apr 2026): job-alert email links don't detect the installed app and keep prompting
    to install. Universal-link / deep-link bug.

### 6.2 Android: "Jobright - AI Job Search" (package `ai.jobright.orion`)
(confirmed: https://play.google.com/store/apps/details?id=ai.jobright.orion, fetched 2026-10-09)
- **Listing basics:** 4.6 from 719 reviews (709 verified on phone). 50K+ downloads. Rated
  Everyone, Business. Updated Aug 21, 2026.
- **Description (paraphrased):** 400K+ new jobs daily in one feed; AI matching with resume
  scoring; status tracker; insider connections; instant alerts.
- **How-it-works steps:** create profile and import resume → daily AI-ranked feed → **auto-apply
  or fine-tune each application in seconds** → track progress and schedule interviews. Audiences:
  new grads, mid-career, career switchers. US only.
- **Data safety:** may share personal info, app info and performance, and device IDs with third
  parties. Collects personal info, app activity and more. Encrypted in transit. Deletion can be
  requested.
- **Reviews:**
  - May 2026: autofill great, but recommendations ignore skills the user says they lack; rejected
    jobs reappear; remote mislabeling.
  - Dec 2025: no location-based search for local and hospitality jobs. Jobright replied in Feb 2026
    that nearby-job discovery is being improved.
  - Aug 2026: no interviews.

### 6.3 Mobile vs web vs extension: differences

| Capability | Web | Extension | Mobile |
|---|---|---|---|
| Job feed + match score | yes (score breakdown) | score on panel / boards | yes (0-100) |
| Orion chat | yes (floating) | not evidenced | **not evidenced** in listings (inferred gap) |
| Agent setup / settings | yes (`/agent`) | executes autofill | Google Play says "auto-apply or fine-tune"; depth unknown |
| Form autofill on employer sites | via extension or Easy Apply | yes | no (no extension); Easy Apply possibly (inferred) |
| Resume tailoring | yes | yes | resume analysis + multiple resumes (iOS 1.9) |
| Insider connections | yes | not evidenced | "hints" |
| Alerts | email + in-app; 1/2/5 per day | n/a | push alerts |
| Tracker | yes | syncs | yes |
| Dark mode | unknown | n/a | yes (iOS 1.10) |

- The web has a `/mobile-app` route (download landing). App-store deep links come from job-alert
  emails. (confirmed: build manifest; App Store review)
- No mobile app is marketed for Chinese or other non-US stores: the listings are US-only. (inferred)

---

## 7. Pricing and gating (as relevant to this angle)

| Item | Free | Turbo | Evidence | Confidence |
|---|---|---|---|---|
| Orion chat | yes | yes | jobity, favtutor | likely |
| AI custom resume | 2/day | unlimited | jobity, favtutor | likely |
| AI cover letter | 2/day | unlimited | jobity, favtutor | likely |
| 1-click autofill | 4/day (other reports: 2/day shared, ~1/day) | unlimited | jobity, favtutor, wobo, careerkit | likely |
| LinkedIn / insider email finder | 2/day | unlimited | jobity, favtutor | likely |
| AI Agent | "Limited Access" (waitlisted for many) | unlimited ("New") | jobity, jobhire | likely |
| Easy Apply bulk apply | single | multi-apply | chunk 39128 | confirmed |
| Saved filters | 1 | unlimited | jobity; bundle requires at least 1 | likely |
| Instant job alerts | 1/day | unlimited (settings offer up to 1, 2 or 5 per day) | jobity; settings bundle | likely / confirmed |
| Hidden Jobs filter | no | yes | jobity; compare pages | likely |
| Resume slots | ? | 5 | favtutor | likely |
| LinkedIn Profile Report | preview | full | chunk 10344 | confirmed |
| Live coaching | no | listed as included, but 30-min sessions with named recruiters are sold at $69.99-79.99. Weekly Turbo Office Hour AMA. | jobity; chunk 10344 | likely |
| Interview question bank passes | n/a | Company Pass $19.99 / 7 days; All-Access $39.99 / 30 days | favtutor | likely |

- **Turbo prices (Aug 2026, in-app only; `/pricing` 404s):**
  - $39.99/month, shown against a struck-through $49.99
  - $17.99/week
  - $89.98-89.99 per quarter ("Most Popular", "Save 40%" against $149.97)
  - no annual plan in Aug 2026 (one review mentions about $20/month billed annually)

  (likely: jobity, favtutor, wobo)
- Older and promo prices: $29.99/month, $14.99/week, $69.99/quarter. Price constants `29.99` and
  `119.99` appear in the current bundle. (likely / confirmed)
- **Checkout patterns:** countdown timers; "Special offer ends soon"; win-back offers ("Get Turbo
  again with your exclusive discount"); free-trial plumbing ("Your free trial is still being set
  up"); referral rewards ("Invite friends or share on LinkedIn"). Cancel via Settings >
  Subscriptions > Unsubscribe. A `/legal/refund` route exists. Billing and cancellation complaints
  are a common negative-review theme. (confirmed: chunk 10344; likely: favtutor, resumly)

---

## 8. Notifications and emails
- **Job alert settings:** "Instant Job Alerts Notifications", with frequency choices "Up to 1 / 2 / 5
  alerts /day". A confirmation toast follows a change. (confirmed: settings bundle)
- **Agent cadence:** about 50 listings a week (2025); daily scan; follow-up nudges are claimed.
  (confirmed: Bloomberg; Jobright blog)
- **Email deep links** into the mobile app; there is a link-detection bug on iOS. (confirmed: App
  Store review)
- **Signup page:** a marketing opt-in checkbox for updates about job offers is **pre-checked**. Sign
  up with Google or with email and password. (confirmed: viewed
  https://jobright.ai/onboarding-v3/signup?from=copilot; nothing submitted)
- **Daily email of curated matches.** (likely: zeroskillai)

---

## 9. Copy tone and persona
- Orion speaks in the first person, warm and concise, and narrates the process ("Let me…", "I've
  found…", "I'll auto-apply this job for you."). Emoji is used sparingly in system states (thumbs,
  expired-trash, plug, waving hand). Marketing is aggressive and stat-heavy (3M users, 3x
  interviews, 80% time saved, 90% automation, "No.1 choice").
- Voice chat exists: route `/voice-chat` ("Voice Chat - Jobright"). Controls: Start Voice Chat,
  mic on/off, End call, Restart call (progress is lost), Rate your conversation, Need help. It is
  built on **Retell** (a voice-agent platform). Its purpose is not disclosed. It could be
  voice-based onboarding or coaching intake with Orion, or mock interviews; the compare pages list
  an "AI Mock Interview" feature. (confirmed strings; purpose inferred)
- Other Orion-adjacent surfaces in the build manifest:
  - `/interview`, `/interview/[companyId]`: question bank of 6,656+ questions across 328+ companies
  - `/coaching`, `/coaching/discover`, `/coaching/bookings`
  - `/tnt`: Top Talent Network, a two-sided network of vetted talent and AI startups

  (confirmed)

---

## 10. Edge cases and failure modes worth designing for
1. **ATS anti-bot / unsupported site.** Degrade gracefully: server apply → extension autofill →
   manual. Each branch needs an "I've Applied" reconciliation. (confirmed)
2. **ATS email verification codes during server-side apply.** Prompt the user for the code in-app.
   (confirmed)
3. **Expired jobs in the queue.** Bulk remove and continue. (confirmed)
4. **Extension missing or outdated.** Detect it, show versioned install steps, re-check on "I've
   installed it". (confirmed)
5. **Credits exhausted mid-pipeline.** Offer upgrade / wait for refill / proceed without premium
   steps. (confirmed)
6. **Resume format substitution.** Users need a visible choice between original and platform
   template, plus a per-application record of the exact file sent. Jobright gets this wrong today.
   (confirmed complaint)
7. **AI-invented skills and metrics in tailoring.** Multiple reviewers. Needs grounding, a diff
   view and user confirmation. (likely)
8. **Score inconsistency** between the extension and the platform. (likely)
9. **Rejected jobs reappearing; remote mislabeled; no hourly or local jobs.** (likely: Google Play)
10. **External import abuse:** rate limit plus 7-day suspension; English-only JDs. (confirmed)
11. **Long-running tasks:** a timeout message with retry; a concurrency guard ("application in
    progress"). (confirmed)
12. **Non-US salary and currency questions.** (likely)
13. **Billing:** auto-renew complaints; win-back flows. (likely)

---

## 11. Implications for RoboApply (inferred recommendations)

> These are my recommendations, not findings. **Conflict to resolve:** RoboApply's binding Overhaul
> Ruling R1 (2026-07-26, `docs/roboapply/OVERHAUL_RULINGS.md`) says the product **never submits**
> applications ("The final click is yours"). The user now asks for *all* Jobright features and
> allows overwriting the current implementation. Cloning Jobright's Automated Mode or server-side
> Easy Apply reverses R1. Jobright's **Supervised Mode** (pause at resume confirmation and before
> final submit) plus extension autofill is the closest R1-compatible equivalent.

Build checklist, mirroring Jobright's surfaces:
1. **Copilot ("Orion" equivalent)**
   - a floating chat container on job pages
   - per-job quick-action chips: fit, resume tips, tailor, connections, cover letter, top candidates
   - a structured Job Fit Analysis card
   - a company insight card: funding, leadership, news, H1B
   - a chat-to-filter control plane that writes to saved preferences, re-ranks, then asks "Looks
     better / Not quite"
   - a cheatsheet modal
   - message feedback
2. **Agent workspace**
   - a 5-step setup: profile, 3-match thumbs calibration, competitiveness report with percentile
     plus missing skills plus broaden-search, application profile and extension install, settings
   - settings: mode, weekly target `<20 / 20-50 / >50`, resume preference (custom or own; original
     or template), cover-letter toggle, common Q&A
   - a run queue with Active/Completed tabs and the pipeline states above
3. **Extension (MV3)**
   - side panel: status pill, job card with score ring, Autofill button, completion bar with
     per-field checklist
   - an answer bank for EEO and common questions, plus AI-generated free text
   - attach the tailored resume
   - "request support for this site"
   - profile sync with the web app
   - uninstall survey
   - start with Workday, Greenhouse, Lever, iCIMS, Ashby, Workable; add SmartRecruiters, Taleo,
     SuccessFactors to beat Jobright
4. **Credits model**
   - separate resume, autofill, email and easy-apply credits
   - a pre-spend notice ("1 credit will be used")
   - daily refill at midnight
   - a three-way out-of-credit modal
5. **Mobile**
   - feed, score, alerts, tracker, multiple resumes, resume analysis, dark mode
   - fix universal links from alert emails
6. **Dual-brand / market notes (inferred)**
   - **International (RoboHire.io, incl. Taiwan):** follows the Jobright pattern; LinkedIn
     connections; Chrome Web Store distribution.
   - **Mainland China (GoApply.Top):**
     - The Chrome Web Store and LinkedIn are not usable, so insider connections need a different
       source (e.g. Maimai).
     - Extension distribution needs alternatives: Edge Add-ons, a self-hosted CRX or enterprise
       policy, or domestic browsers.
     - Target ATS / job sites differ (BOSS Zhipin, Liepin, Zhaopin, 51job, Moka, Beisen).
     - The mobile app may need a WeChat mini-program rather than an App Store app.

---

## 12. Open questions
1. Is the Agent waitlist fully retired as of Oct 2026? The bundle has no waitlist strings, but
   reviewers saw it on 2026-08-31.
2. Which ATS platforms does server-side Easy Apply support (vs extension-only)? The upsell copy's
   platform name is a runtime variable.
3. Does the Chrome extension have a "save job" button or score overlay on LinkedIn/Indeed in v1.24?
   Only one secondary source mentions an overlay.
4. Do the mobile apps include Orion chat and the Agent, or only the feed and tracker?
5. What is the voice chat (`/voice-chat`, Retell) for: onboarding, coaching or mock interviews?
6. Exact current free credit allowances. Reports range from 1 to 4 autofills a day; possibly A/B
   tested.
7. Does Automated Mode require explicit legal consent (ToS clause) to submit on the user's behalf?
   `/legal/*` is disallowed by robots and was not read.
8. How does RoboApply reconcile Overhaul Ruling R1 ("never submit") with the clone mandate?

---

## 13. Source list
Primary (Jobright):
- https://jobright.ai/ ; https://jobright.ai/ai-agent ; https://jobright.ai/orion-copilot ; https://jobright.ai/job-autofill ; https://jobright.ai/ai-job-match ; https://jobright.ai/job-referral ; https://jobright.ai/coach-landing ; https://jobright.ai/interview-landing ; https://jobright.ai/tnt ; https://jobright.ai/compare/simplify ; https://jobright.ai/compare/lazyapply
- https://jobright.ai/robots.txt ; https://jobright.ai/sitemap.xml ; https://jobright.ai/sitemap-pages.xml ; https://jobright.ai/sitemap-comparison.xml
- https://jobright.ai/onboarding-v3/signup?from=copilot (viewed only)
- https://jobright.ai/blog/jobright-launches-first-ai-agent-to-put-job-search-on-autopilot/ (2025-06-24)
- https://jobright.ai/blog/what-is-the-jobright-agent-automate-your-job-search/ (2025-07-22)
- https://jobright.ai/blog/supercharge-your-job-search-with-jobright-autofill/ (2025-08-22)
- https://jobright.ai/blog/is-jobright-worth-it-a-detailed-comparison/ (2025-07-11)
- https://jobright.ai/blog/ai-tools-for-linkedin-job-search/ (2026-03-06)
- JS bundles (build `GQd0ykV_IrfhtmCjLOY2m`):
  - https://static.jobright.ai/_next/static/GQd0ykV_IrfhtmCjLOY2m/_buildManifest.js
  - https://static.jobright.ai/_next/static/chunks/pages/agent-70b6a9ee45390efe.js
  - https://static.jobright.ai/_next/static/chunks/pages/onboarding-v3/mode-selection-98ce4c29955b4786.js
  - https://static.jobright.ai/_next/static/chunks/pages/jobs/external-67a5b06de9b7acc6.js
  - https://static.jobright.ai/_next/static/chunks/pages/settings-d1abc17acf0503a8.js
  - https://static.jobright.ai/_next/static/chunks/pages/autofill/uninstall-8f4ba7fde454b46a.js
  - https://static.jobright.ai/_next/static/chunks/pages/tools/job-clipper-e94028c07e578ff8.js
  - https://static.jobright.ai/_next/static/chunks/pages/voice-chat-40a17118e80b379b.js
  - https://static.jobright.ai/_next/static/chunks/75381.dadac4ad49737ca3.js (voice chat; Retell)
  - shared chunks 10344-7630c6c855467801.js, 97342-7f758d8ed7830b3e.js, 39128-8499616773d6f37f.js, 44444-29fb4701c9bbbe29.js (under https://static.jobright.ai/_next/static/chunks/)
- Marketing media:
  - https://static.jobright.ai/_next/public/newimages/autofill_landing/autofill_{1..4}.png
  - https://static.jobright.ai/_next/static/media/orion_1.2096a255.png
  - https://static.jobright.ai/_next/public/newimages/orion_landing/orion_{2..4}.png
  - https://static.jobright.ai/_next/public/newimages/jobmatch_landing/jobmatch_{4,5}.png
  - https://static.jobright.ai/_next/static/media/connect_1.3ef86438.png
  - https://static.jobright.ai/_next/public/newimages/connect_landing/connect_3.png
  - https://static.jobright.ai/static/videos/agent_0614/{automation,report,job-match}.mp4

Stores:
- https://chromewebstore.google.com/detail/odcnpipkhjegpefkfplmedhmkmmhmoko (+ /reviews)
- https://apps.apple.com/us/app/id6738236788 ; https://apps.apple.com/us/developer/jobright-inc/id1779845454
- https://play.google.com/store/apps/details?id=ai.jobright.orion
- https://extpose.com/ext/odcnpipkhjegpefkfplmedhmkmmhmoko ; https://www.extscope.org/extension/odcnpipkhjegpefkfplmedhmkmmhmoko

Press:
- https://www.prnewswire.com/news-releases/jobright-launches-first-ai-agent-to-make-job-hunting-searchless-302488544.html
- https://www.theregister.com/2025/06/24/ai_may_take_jobs_but/
- https://news.bloomberglaw.com/artificial-intelligence/new-ai-startup-will-suggest-jobs-and-even-fill-out-applications
- https://techcrunch.com/2024/06/25/jobright-uses-ai-to-help-foreign-workers-navigate-the-us-job-market/
- https://www.producthunt.com/products/jobright-ai-2

Secondary reviews (mostly competitors; dates as stated):
- https://jobity.io/blog/jobright-review (test 2026-08-31)
- https://favtutor.com/jobright-ai-review/ (captured 2026-08-21)
- https://www.wobo.ai/blog/jobright-review/ (2026-07-09)
- https://scoutify.com/blog/jobright-review/ (updated 2026-09-29)
- https://hirecarta.com/blog/jobright-review (2026-04/09)
- https://jobhire.ai/blog/jobright-ai-review-and-decision-guide-2026 (2026-06/07)
- https://www.usesprout.com/blog/jobright-ai-review (2025-11-19)
- https://www.adzuna.co.uk/blog/jobright-review-better-alternative-in-2025/ (2025-11-24)
- https://www.careerkit.me/blog/jobright-review (2026-07-15)
- https://www.loopcv.pro/directory/jobright/ (2026-07)
- https://zeroskillai.com/jobright-ai-review/ (2026-02-05)
- https://atsverification.com/blog/jobright-ai-review-2026/ (2026-05-20; low quality, conflates Orion and Agent)
- https://www.vmeg.ai/blog/jobright-ai-review
- https://www.trustpilot.com/review/jobright.ai?search=agent ; ?search=orion ; ?search=extension
- https://connect.mozilla.org/t5/discussions/is-the-jobright-ai-extension-available-for-firefox/td-p/96011
