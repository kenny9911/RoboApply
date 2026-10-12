# Jobright.ai teardown: job recommendation feed and job detail

Research angle: the job recommendation feed (`/jobs/recommend` and sibling tabs), the job card, the match score and its explanations, the job detail page, filters and search, the feedback loop, freshness and sources, alerts and emails, and the apply flow.

Research date: 2026-10-09. Researcher: RoboApply research agent. No account was created and nothing was signed in or submitted.

---

## 0. Method, evidence and confidence

**Confidence legend**
- **[confirmed]**: seen in a primary source. That means a jobright.ai page, the server-rendered `__NEXT_DATA__` on a public jobright.ai page, Jobright's public production JavaScript bundles on `static.jobright.ai`, or Jobright's own store listings.
- **[likely]**: reported by two or more independent secondary sources.
- **[inferred]**: my own reasoning from the evidence.

**Primary evidence used**
1. **Public marketing pages.** `jobright.ai/`, `/ai-job-match`, `/h1b-jobs`, `/job-referral`, `/orion-copilot`, `/compare/simplify` and `/blog/is-jobright-legit/`.
2. **Server-rendered data on public SEO pages.**
   - `https://jobright.ai/jobs/data-analyst` and `https://jobright.ai/jobs/machine-learning-engineer` are taxonomy pages with 16 jobs each.
   - `https://jobright.ai/jobs/info/6aac8b023e3ce93970c7ddcb` is a public job detail page.
   - Their `__NEXT_DATA__` JSON shows the full job and company data model, including match-score feature names and internal ranking notes.
3. **Next.js build manifest.** `https://static.jobright.ai/_next/static/GQd0ykV_IrfhtmCjLOY2m/_buildManifest.js` gives the complete route list.
4. **Public production JS chunks.** These are served to every visitor from `https://static.jobright.ai/_next/static/chunks/...` and were read only for UI strings, enums, option lists, thresholds and endpoint paths. The key ones are cited inline. The build hash captured on 2026-10-09 is `GQd0ykV_IrfhtmCjLOY2m`.
5. **Store listings.**
   - App Store `https://apps.apple.com/app/id6738236788`.
   - Chrome extension mirror `https://www.extscope.org/extension/odcnpipkhjegpefkfplmedhmkmmhmoko`.

**Caveat.** After about 6 server-rendered page fetches, `jobright.ai/jobs/info/*` began returning a Cloudflare "Security check" interstitial. I stopped fetching those pages and did not try to bypass the check. Everything after that point comes from the static bundles (CDN), WebFetch of marketing pages, and secondary sources.

**Secondary sources**
- `https://jobity.io/blog/jobright-review`: hands-on test, 2026-08-31.
- `https://favtutor.com/jobright-ai-review/`: Turbo account, 2026-08-21.
- `https://hirecarta.com/blog/jobright-review`: 2026-04 with a 2026-09 update.
- `https://www.wobo.ai/blog/jobright-review/`: 2026-07-09.
- `https://www.adzuna.co.uk/blog/jobright-review-better-alternative-in-2025/`: 2025-11-24.
- `https://www.careerkit.me/blog/jobright-review`: 2026-07-15.
- `https://techcrunch.com/2024/06/25/jobright-uses-ai-to-help-foreign-workers-navigate-the-us-job-market/`
- `https://www.theregister.com/2025/06/24/ai_may_take_jobs_but/`
- `https://news.bloomberglaw.com/artificial-intelligence/new-ai-startup-will-suggest-jobs-and-even-fill-out-applications`: 2025-07-02.

Most review sites sell a competing product, so I treat their opinions with caution and use them for observed facts such as screenshots, labels and prices.

---

## 1. Headline numbers

| Claim | Value | Where | Confidence / note |
|---|---|---|---|
| Total jobs | "8,000,000+" | homepage, `/ai-job-match`, `/h1b-jobs`, `/job-referral` | [confirmed] as marketing copy. Favtutor found it unchanged in 22 archived homepage snapshots from 2024-09 to 2026-08 and believes it is hardcoded (favtutor.com, hirecarta.com). |
| New jobs per day | "400,000+" (labelled "Today's new jobs") | same pages | [confirmed] as marketing copy, also static. The Register (2025-06) reported the agent scans 400k+ posts per day. |
| Visitor upsell | "over 1 million jobs" | `/jobs/[visit]` chunk (`pages/jobs/%5Bvisit%5D-60b39c9edcd02283.js`) | [confirmed] Inconsistent with the 8M claim. Likely an older string. |
| Taxonomy page totals | Data Analyst 6,838 and ML Engineer 6,428 jobs (US, live on 2026-10-09) | `__NEXT_DATA__.totalJobs` | [confirmed] Realistic per-function inventory. |
| Matching roles after onboarding (one tester) | 8,624 | jobity.io (2026-08-31) | [likely] |
| Users | "3,000,000+" (homepage). Earlier: 50k (2024-06, TechCrunch), 500k+ (App Store) | various | [confirmed] Numbers grew over time. |
| Agent volume | up to 50 listings per week | Bloomberg Law 2025-07-02 | [likely] Agent-era claim. |
| Feed page size | 10 jobs per request by default. Infinite scroll uses `position` and `count`. | `_app` chunk, `/swan/recommend/list/jobs` | [confirmed] |
| Time to first matches | "less than 1 min" | homepage | [confirmed] marketing |
| Match score users | about 60% of users check scores daily | TechCrunch 2024-06 | [likely] |
| Foreign-worker share | about 30% of users | TechCrunch 2024-06 | [likely] Drives the H1B features. |

---

## 2. Information architecture and routes

Source: the build manifest, `https://static.jobright.ai/_next/static/GQd0ykV_IrfhtmCjLOY2m/_buildManifest.js` [confirmed].

### Job seeker app routes

| Area | Routes |
|---|---|
| Job tabs | `/jobs/recommend`, `/jobs/liked`, `/jobs/applied`, `/jobs/external` |
| Explore (Beta) | `/jobs/explore` |
| Job detail | `/jobs/info/[id]` (public, SEO-indexed, shareable). A deep link into the feed also exists: `/jobs/recommend?id=:id`. |
| Public search and SEO results | `/jobs/[visit]`, used for taxonomy slugs such as `/jobs/data-analyst`. Also `/remote-jobs/:path*` and `/minisites-jobs/[...slug]`. |
| Email job list landing | `/jobs/email-list/:id`. It is a rewrite, which suggests a job list built from an email digest [inferred]. |
| Profile and resume | `/jobs/profile`, `/jobs/resume`, `/jobs/resume/edit/[id]` |
| Settings | `/settings` |
| Job alerts | `/tools/job-alert` (SEO) and `/tools/job-alert/unsubscribe` |
| Onboarding v3 | `/onboarding-v3/signup`, `/mode-selection`, `/diagnostics`, `/career-goals`, `/advanced-preferences`, `/resume-upload` |
| Other | `/matching` (resume parsing wait screen), `/agent` (AI Agent), `/interview`, `/coaching`, `/tnt` (talent network), `/candidate-preferences` (magic-link preference editor) |

### Left navigation

The left nav is built from `_app` module 23107 [confirmed].
- Primary items: **Jobs**, **Resume**, **Profile** and **Interview**.
- Other items in chunk 10344: **Agent**, **Coaching**, **Explore (Beta)**, **Messages**, **Refer & Earn**, **Download App**, **Feedback** and **Settings**.
- A "Free Plan" or Turbo badge and an "Ask Orion" side panel also appear.

### Jobs page tabs

The tabs are **Recommended / Liked / Applied / External**, and each shows a count.
- Strings are in chunk `10344-7630c6c855467801.js`.
- The route constants `reco`, `liked`, `applied` and `external` are in `_app` module 85289 [confirmed].
- A cached copy of `jobright.ai/jobs/liked` shows a header of the form "Recommended · Liked 0 · Applied 0 · External 0" (seen in search results).
- **Counts:** Liked, Applied and External show counts. I found no evidence of a "N new" badge on Recommended [inferred].
- **Count endpoints:** `/swan/job/like/count`, `/swan/job/apply/count` and `/swan/job/statistic`. The statistic endpoint returns per-status applied counts used by the tracker [confirmed].

---

## 3. The Recommended feed (`/jobs/recommend`)

### 3.1 Layout

[confirmed: strings in `pages/jobs/recommend-73cab9378acfb3f3.js`, `10344-…js`, `83417-…js`, `3530-…js` and `42214-…js`]

**Left column: the job list**
- Card list with infinite scroll. When the list is exhausted it shows a "No more jobs to load" style message.
- **Top bar**, above the list:
  - The tabs.
  - A **sort** selector.
  - Quick filter buttons (TopbarButton components with a label, a current value and an arrow).
  - A **"Hidden Jobs" toggle** with an info icon. Its tooltip says it shows only hidden, quality jobs that are not listed on major boards like LinkedIn and Indeed.
  - **"All Filters"**, which opens the full preference modal (section 7).
- **Saved filters:** the "Your Saved Filters" switcher. You can add filters for different roles and switch between them instantly, and must keep at least one. Free accounts get 1 saved filter and Turbo gets unlimited (favtutor, jobity) [likely].

**Right column (desktop) or drawer (mobile)**
- Clicking a card opens the job detail in place (`/jobs/recommend?id=…`), with a "close detail" control.
- The Orion copilot panel can be opened ("Ask Orion"). Its guide card tells users to ask Orion to adjust recommendations and get better matches.

### 3.2 Sort

The three sort options [confirmed: `_app` modules 98052, 20227 and 85289].

| UI label | Client enum | Server value |
|---|---|---|
| Recommended (default) | `RECOMMENDED=0` | `RELEVANCE` |
| Most Recent | `MOST_RECENT=1` | `FRESHNESS` |
| Top Matched | `TOP_MATCHED=2` | `MATCH_SCORE` |

Orion can also change the sort from chat. Its confirmation says it has updated your sorting preference to the chosen value (chunk 10344).

### 3.3 Fetching, refresh and daily cadence

[confirmed: `_app` module 23428]
- **Feed request:** `GET /swan/recommend/list/jobs?refresh&sortCondition&position&deeplink&reqJobIds&count=10&syncRerank`. The `syncRerank` and `refresh` flags show the list can be re-ranked on demand after feedback or a preference change.
- **Rate limit:** too many refreshes return error code 43004. The page then shows a rate-limit modal telling the user to slow down so the list keeps loading smoothly (`_app` chunk) [confirmed].
- **Cadence:** "updated daily" appears in marketing. The App Store listing says the feed refreshes "every few minutes" [confirmed, App Store].
- **Lifecycle stages:** the client tracks a daily browse context (`dailyBrowsing.viewedCount` and `viewedJobIds`, chunk 10344) and two stages, `list_reached_within_1_days` and `list_reached_over_1_days`. These drive first-day guides and offers (for example a first-day upgrade discount and a resume-analysis banner) [confirmed].
- **Deleted jobs:** if a clicked job is no longer available, a notice says recommendations were updated with fresh opportunities instead (chunk 91191) [confirmed].

### 3.4 In-feed modules and prompts

All confirmed from the recommend chunk and chunk 10344.

- **Daily match-quality survey**
  - The card asks the user to rate the job matches they have seen today on a **0–10** scale, from "Not satisfied" to "Extremely satisfied".
  - A score **below 8** opens a follow-up asking which aspects missed. The options are "Irrelevant Title", "Low-quality company", "Experience Level Mismatch", "Skill Mismatch" and "Outdated Job Listing", plus free text.
  - API: `/swan/feedback/job-match/show` and `/swan/feedback/job-match/submit` with `{score, reason[], description, impressionId}`.
- **Skill confirmation prompt**
  - Asks whether the user has a set of skills and lets them tap the ones they have.
  - Adding a skill shows a "Skill added!" toast promising more tailored results.
  - APIs: `/swan/filter/user-skill/add` and `/swan/filter/user-skill/exclude`.
- **Resume analysis banner (new users)**
  - Graded A, B, C or D, with Urgent, Critical and Optional issue counts.
  - The headline is either an alert that the resume needs attention or that the analysis is ready.
  - Only shown when the resume was uploaded rather than imported from LinkedIn, and only on day 1 (chunk 19182).
- **LinkedIn URL banner.** "Unlock Better Matches": adding a LinkedIn URL personalizes matches and surfaces referral connections.
- **Orion guide card.** Prompts the user to ask Orion when they are not seeing the right jobs.
- **Empty state.**
  - Says no jobs match the current preferences.
  - A "What's limiting your search" list names each blocking criterion and its current value.
  - A "How you may adjust" list follows, with an **"Update Now"** button.
- **Unparseable preferences.** If preferences cannot be learned, an "Update Preferences" CTA asks the user to restate them.
- **Upsell surfaces.** Turbo special-offer countdown banners, a first-day offer, and win-back offers.

### 3.5 Explore (Beta) (`/jobs/explore`)

[confirmed: `pages/jobs/explore-c1756f1f653a1a7b.js`]
- An AI-driven browse page ("Explore Jobs with AI") with 20 emoji-labelled job-function categories.
- The categories are: Software Engineering, Engineering and Development, Data Analyst, Business Analyst, Accounting and Finance, Machine Learning and AI, Consulting, Marketing, Project Manager, Product Management, Arts and Entertainment, Legal and Compliance, Education and Training, Creatives and Design, Customer Service and Support, Human Resources, Public Sector and Government, Management and Executive, Data Engineer and Sales.

---

## 4. Job card anatomy

Primary evidence:
- Public list `__NEXT_DATA__` (the `jobList[]` item shape).
- Score ring and tags: chunk `12523-2672b0db982e25a0.js`.
- Tag priority and labels: chunk `30004-1f1c720fd216f7ed.js`.
- Thresholds: chunk `3530-56459b383af38dfc.js`.
- Applicant text: chunk `12523` and `_app` module 41166.

Secondary corroboration: favtutor and jobity screenshots.

### 4.1 Fields shown on a card

From left to right and top to bottom [confirmed unless noted]:

1. **Freshness stamp.** Uses `publishTimeDesc` (for example "7 minutes ago" or "1 hour ago").
   - If `repost=true` it reads "Reposted 3 hours ago", with a highlighted background and a tooltip explaining that the date reflects the employer's most recent repost.
2. **Company logo** (`jdLogo`, often a LinkedIn CDN logo) and **company name**.
3. **Company descriptor line.**
   - The short GPT company description (`gptShortDescription`), or the first 2 `companyCategories` joined with " · ", plus the funding stage. For example: "Energy · Renewable Energy · Late Stage".
4. **Job title** (`jobTitle`).
5. **Meta row.**
   - Location (`jobLocation`, or several via `jobLocations`).
   - Work model (`Remote`, `Hybrid` or `Onsite`).
   - Employment type (`Full-time`, `Contract`, `Part-time` or `Internship`).
   - Seniority (`jobSeniority`, for example "Entry, Mid Level").
   - Salary (`salaryDesc`, for example "$61K/yr - $98K/yr" or "$30/hr - …").
   - Years of experience (for example "1+ years exp", from `minYearsOfExperience`).
6. **Applicants line.**
   - `applicantsCount` up to 25 shows "Less than 25 applicants".
   - 26 to 199 shows "N applicants".
   - 200 or more shows "200+ applicants".
   - A server-provided `applicantsDisplayText` overrides all of these.
   - Constants: `E_=200`, `ee=25`.
7. **Urgency CTA line** (detail header and some cards), based on applicant count. The bands are under 50, 50–99, 100–199 and 200 or more. The copy moves from "stand out easily, few applicants" through "interest is picking up" to "high demand, filling quickly", with star or warning emoji (chunk 12523 module 91092) [confirmed].
8. **Badges.**
   - "Posted by Agency" when `companyResult.isAgency` is set.
   - "External" for imported jobs.
   - "Direct Apply", for Jobright employer-customer jobs (`isToB`).
   - "Applied by Agent".
   - "High Response Rate" and "Invite-Only for Top Talent", for TNT or employer jobs.
   - A "hidden job" flashlight badge for hidden jobs.
9. **Insider connection teaser.** For example "N former <company or school>" connections at the company (`personalSocialConnections`, chunk 3530).
10. **Match block** (right side of the card; see 4.2).
11. **Actions.**
    - Heart/like toggle ("Save job" or "Unsave job").
    - **Primary apply button.**
    - A "…" more menu.
    - **"ASK ORION"** on the card.

### 4.2 Match block (score ring, rank label and reason tags)

[confirmed: chunk 12523]

- **Score ring**
  - A circular "dashboard" progress ring 70px wide, showing `Math.floor(displayScore)` plus "%".
  - The stroke gradient runs `#00F0A0` to `#17BAFF` to `#00F0A0`.
- **Rank label** under the ring, uppercased from the server's `rankDesc`.
  - Reviews observed **"STRONG MATCH"**, **"GOOD MATCH"** and **"FAIR MATCH"** (favtutor 2026-08-21; jobity showed an 88% "STRONG MATCH") [likely].
  - Hirecarta (2026-04) showed a 10-point scale with a "Poor" label for 5.5/10. This suggests an older or alternate display variant [likely, changed over time].
- **Colour bands** via CSS class: up to 70 is `less-match`, over 70 up to 85 is `match`, and over 85 is `strong-match` (chunk 3530 module 23508) [confirmed].
  - Mapping these to the labels gives roughly ≤70 Fair, 71–85 Good and >85 Strong [inferred].
- **Visitors** (not logged in) see a **lock icon** and "MATCH SCORE" instead of a number, as a sign-up hook.
- **Closed jobs** show a "JOB CLOSED" illustration in place of the ring. The whole card is styled `expired-job`.
- **Reason tags.** Up to **3** tags with check icons, sorted by a fixed priority (chunk 30004 module 42380):
  1. Unicorn, for example "Unicorn ($XB val.)".
  2. "Top Investors". Its tooltip says the company is backed by investors on Jobright's Top Investors list.
  3. H1B-positive tags: "H1B Sponsored" and "H1B Sponsor Likely".
  4. "Comp. & Benefits".
  5. "Growth Opportunities".
  - When industry tags are on, a **company stage** tag is prepended ("Early Stage Co.", "Growth Stage Co.", "Late Stage Co." or "Public Company").
  - The funding helper can also show "Recently raised $XM (Series B)" (a round in the last 6 months), "Raised $XM" (≥ $50M total) or "Public company".
  - **Negative tags** use a "disappointed" icon. These are **"No H1B"**, **"U.S. Citizen Only"** and **"Security Clearance Required"**, the last shown as "Security Clearance".
  - Each tag has a tooltip definition (`_app` module 23107):
    - **H1B Sponsored:** the job description explicitly supports sponsorship.
    - **H1B Sponsor Likely:** the description does not mention it, but the company sponsored similar roles in the **past three years**.
    - **No H1B:** the description explicitly rules out sponsorship.
    - **U.S. Citizen Only:** citizens only.
    - **Security Clearance:** requires an active clearance.
- **Job tags.** `jobTags` includes **"Early applicant"**, observed on every public job with ≤25 applicants. The copy constant "Be an early applicant" also exists (`_app` 41166) [confirmed].

Observed live tag mixes on 2026-10-09 (ML Engineer list) [confirmed]:
- Capgemini: "H1B Sponsor Likely".
- Anduril: "No H1B".
- AbbVie: "Comp. & Benefits" and "H1B Sponsor Likely".
- Google: "Growth Opportunities" and "H1B Sponsor Likely", with 45 applicants and no Early applicant tag.

### 4.3 More menu ("…")

[confirmed: chunks 12523, 81430 and 79519]

| Item | Effect |
|---|---|
| Already Applied | Marks the job applied: `/swan/job/apply`. Toast says the job moved to Applied. |
| Not Interested | Opens the reasons drawer (section 8.2). |
| Report Issue | Opens the report flow: `/swan/job/report`. |
| Remove From List | Used in Liked and Applied lists. Calls `/swan/job/ignore` with feedback code 13, then shows a removal toast. |
| Share | Gets a share link via `/swan/share/job/link`. A toast says the link was copied, or shows the link. |

### 4.4 Apply button variants

[confirmed: chunks 3530, 42214, 91191, 12523 and 9484]
- **"APPLY NOW"** with an external-jump icon, which opens the employer or source site.
  - The detail header variant reads **"Apply on Employer Site"** when `isCompanySiteLink=true`.
  - When the URL host is LinkedIn or Indeed (feed opened with `?easy=true`), the label becomes **"Apply on Linkedin"** or **"Apply on Indeed"**.
- **"APPLY WITH AUTOFILL"** when the Chrome extension supports the ATS. Tooltip: the job supports fast applications with the Autofill plugin.
- **"Jobright Easy Apply"** for supported Greenhouse jobs. Tooltip: the job supports quick applications with Easy Apply.
  - A `/swan/greenhouse/*` runtime exists with file-type and size checks: at most 5 files and 1 GiB total (`_app` 41695).
  - **JobTarget** feed jobs have an Easy Apply questionnaire: `/api/jobtarget/questions` and `/swan/job/jt-apply`.
- **"Direct Apply"** (flash icon) for jobs posted by Jobright's employer customers (`isToB`). It becomes **"Send My Profile"** in some states, with the promise of skipping the applicant queue and being reviewed like a referral.
- **"Apply To Similar Jobs"** when the job is closed (`isDeleted`). A tooltip explains why: the employer may not be accepting applications, may not be actively hiring, or may be reviewing applications.
- **"Add to Agent"** sends the job to the AI Agent's application queue. Toasts confirm it was added or say it is already in Agent (chunks 12523 and 10344).

---

## 5. Match score: model, breakdown and explanations

### 5.1 What feeds the score

**Marketing** [confirmed, `/ai-job-match`]
- The score estimates fit by comparing skills, experience, seniority, industry background and preferences against job requirements.
- It shows which skills align and which requirements to review.
- The App Store listing describes a 0–100 scale comparing skills, experience and salary range [confirmed].

**Data model** [confirmed: public `__NEXT_DATA__` on `/jobs/info/6aac8b023e3ce93970c7ddcb`]
- `displayScore` (0–100) and `rankDesc` sit on the list item.
- `recommendationScores[]` holds the breakdown as `{featureName, displayName, score}`. Feature names, with display labels from `_app` 41166:
  - `q_seniority_match`: "Experience Level".
  - `q_job_skill_match`: "Skill" or "Skills".
  - `q_industry_match`: "Industry Exp." or "Industry Experience".
  - `education_match_score`: "Education Match". It exists in the label map but was not present in sampled jobs, so it is probably shown only when education requirements exist [inferred].
- `skillMatchingScores[]`: per-skill `{featureName: "Advanced Excel", score}` for the job's top 5 core skills (`jdCoreSkills[]` with `{skill, score (1–3), type: hard_skill|soft_skill}`).
- `industryMatchingScores[]`: per-industry scores.
- Example from a review (favtutor and jobity screenshots) [likely]:
  - One job scored 82% overall, split into Experience Level 100%, Skill 69% and Industry Experience 80%.
  - Another scored 88% "STRONG MATCH", split into 100%, 98% and 45%.
  - The overall score is **not** a simple mean of the three components. The weighting is undisclosed [inferred].

### 5.2 "Why this job is a match" banner

[confirmed: chunk 12523]
- A card with an AI star icon, the title **"Why this job is a match"**, a 2-line `jobSummary` (an LLM summary of the role), and the component score bars from `recommendationScores`.

### 5.3 Qualification skill chips ("your-skill match")

[confirmed: chunks 42214 and 91191 and the public page]
- In the Qualification section, the top required skills render as chips.
- Chips for skills **the user has** are highlighted. The legend reads "Represents the skills you have".
- Requirements are split into **"Required"** and **"Preferred"** lists, using `qualifications.mustHave[]` and `preferredHave[]`.
- `detailQualifications` structures them further into `{yoe[], education[], hardSkill[], softSkill[]}`.

### 5.4 Orion explanations (chat)

[confirmed: `/ai-job-match` and chunk 97342]

**Preset prompts on a job**
- "Tell me why this job is a good fit for me."
- "Give me some resume tips to stand out."
- "Show me Connections for potential referral."
- "Write a cover letter for this job."
- "Generate custom resume tailored to this job."
- Feed level: "Show me jobs where I am top candidates."

**Answer templates and cards:** `JOB_HIGHLIGHTS`, `RESUME_TIPS`, `SOCIAL_CONNECTIONS`, `TOP_CANDIDATES`, `TAIL_RESUME` and `WRITE_COVER_LETTER` (`_app` 20227).

**Fit analysis.** The marketing page names the sections Relevant Experience, Seniority, Skills and Potential Gaps. Favtutor saw relevant experience, seniority, education and core skills split into aligned and not aligned [likely].

**Orion can edit the feed from chat** (chunk 10344) [confirmed].
- Examples: "Add 'Software Engineer' to my job titles." and "Exclude 'Java Developer' roles from my search."
- Shortcut topics include "Salary too low?" and "Tired of scam jobs?". The scam topic suggests excluding staffing agencies.
- Card types include `UPDATE_FILTER`, `SHOW_FILTER` and `CONFIRM_FILTER`, plus "ADD FILTER", "✅ Preferences Updated" and "🔍 Basic Preferences / 💎 Advanced Preferences" panels.
- After changes, Orion asks how the user likes the updated job list ("Looks better" or "Not quite").

### 5.5 Competitiveness report ("You vs. Other Applicants")

[confirmed: `pages/agent-70b6a9ee45390efe.js`; agent context]
- The "Job Search Competitiveness Report" takes about 30–40 seconds to generate.
- "Where You Stand at a Glance" gives an overall rating: Exceptional, Great, Strong, Promising or Emerging.
- It lists strengths and "Level-Up" items.
- The applicant comparison has three parts:
  - **Education:** what percentage of the applicant pool holds your degree.
  - **Experience Level:** your years against the share of applicants.
  - **Skills.**
- The job detail right rail (section 6.3) shows a light version: "Your Score" against "Top Applicants".

---

## 6. Job detail page (`/jobs/info/[id]` and the in-feed panel)

Primary: the public page text and `__NEXT_DATA__` for `jobs/info/6aac8b023e3ce93970c7ddcb`, plus chunks 9484, 42214 and 91191 [confirmed].

### 6.1 Header

- **Two tabs or anchors:** "Overview" and "Company".
- **Company line:** logo, name and "· 24 minutes ago". Shows "Reposted …" for reposts.
- **Title.**
- **Meta chips:** location, employment type, work model, seniority, salary and "N+ years exp".
- **Applicants count** and a "Posted by Agency" chip when applicable.
- **Hiring Manager card**, when `jobRecruiter` and `jobRecruiterProfileUrl` exist. It shows the name, a "Hiring Manager" label and a LinkedIn icon link.
- **Optional "Expires in N hrs" chip.** It appears only when the URL has `?expire=true` (likely from email or ad links).
  - The number is **not real data**. It is a pseudo-random pick from [6, 8, 12, 18, 24] based on a hash of the job ID (chunk 12523 module 91092) [confirmed].
  - It works as an urgency device. RoboApply should not copy it [inferred].
- **Primary CTA:** "APPLY NOW" or "Apply on Employer Site" (see 4.4), a like button and a share button.

### 6.2 Overview body (in order)

1. **Summary paragraph.** `jobSummary`, an LLM rewrite of the role in two sentences with the company name bolded.
2. **Industry and category chips.** `companyCategories`, for example "Energy", "Renewable Energy", "Energy Management" and "Oil and Gas".
3. **Recommendation tags.** For example "Growth Opportunities" and "No H1B". Each has a tooltip.
4. **"Why Join Us".** Uses `whyJoinUs` when present.
5. **"Responsibilities".** `coreResponsibilities[]`, LLM-extracted bullets (16 in the sample).
6. **"Qualification".**
   - Top-5 skill chips, highlighted when the user has them.
   - A "Required" list (`mustHave`) and a "Preferred" list (`preferredHave`).
   - Work-authorization lines from the JD are kept verbatim, for example a statement that sponsorship is not available.
7. **"Benefits".** `benefitsSummaries[]` bullets (18 in the sample).
8. **Education requirements.** Shown when `educationSummaries` is non-empty.
9. **"Not interested in this role?"** at the bottom, which opens the Not Interested flow.

### 6.3 Right rail tools

Seen on the public page text: "Boost Your Interview Chances" [confirmed].

- **Resume match score card.** Labelled "Improve Resume Match Score" and **FREE**.
  - Shows "Your Score" against "Top Applicants".
  - Lists "Must-Have Skills for This Role", the 5 core skills.
  - CTA: "Optimize my Resume", which opens the resume tailor. The logged-in variant is "Customize Your Resume" (favtutor).
- **Referral card.** Labelled "Get Referral Via linkedIn" and **FREE**.
  - Pitches 3× higher response via email outreach.
  - Lists insider connection mini-cards (first name, last initial and title) and a "Draft Message to Connect" CTA.
- **Autofill card.** Labelled "Apply Faster with Autofill Plugin" and **FREE**, with an "Apply With Autofill" CTA.
- **Logged-in tool list.** Favtutor reports "Customize Your Resume", "Build Cover Letter" and "Analyze How Well You Fit" [likely]. Chunk 10344 strings include "TailorResume", "Build Cover Letter" and "Make your application stand out" [confirmed].

### 6.4 Insider connections

[confirmed: chunks 10344, 91191 and 97342; `/job-referral`]

- **Panel:** "Insider Connection @ <Company>". It explains that these people work at the company and may offer insights and referrals.
- **Groups:** **"Beyond Your Network"**, **"From Your Previous Company"** and **"From Your School"**. A "Find More Connections" prompt appears when groups are empty (favtutor) [likely].
- **Data:** `socialConnections[]` holds `{firstName, fullName (last initial only), logoUrl, companyName, jobTitle, linkedinUrl}`. Public pages expose up to 5 [confirmed].
- **Actions:**
  - "Connect On LinkedIn".
  - "Prepare a LinkedIn message for X", an AI-drafted note.
  - "Find X's email", the email finder.
    - It shows "📧 Fetching Contact Info", then "✅ Contact Info Found!" or "😨 Contact Info Not Found".
    - Backed by `/swan/email/linkedin-to-email`.
  - "Find Any Email", which takes any LinkedIn URL (`/swan/email/external-linkedin-to-email`).
  - The panel pitches about 3× more responses from email than from LinkedIn.
- **Gating:**
  - The LinkedIn email finder is limited to 2 per day on free and unlimited on Turbo (jobity, favtutor) [likely].
  - A "Locked contact preview" exists (chunk 10344) [confirmed].
- **Personalization:** better connections require the user's LinkedIn URL (`/swan/resume/update-linkedin-url`).

### 6.5 Company tab and section

[confirmed: public page plus `companyResult` schema]

- **Header.** Company name and a **Glassdoor rating** with link (`grating.rating`, `url` and `count`; 4.1 in the sample).
- **Profile line.** GPT short description, "Founded in YYYY", HQ location, employee range (for example "1001-5000 employees") and website.
- **Funding.**
  - **Current Stage:** Early Stage, Growth Stage, Late Stage or Public Company.
  - **Total funding**, **Key investors** and **Latest rounds**, each with `investmentType`, `announcedOn` and `raisedAmountUsd`.
- **"Leadership Team" or "Founding Team".** Name, title, LinkedIn and photo.
- **"Recent News".** `pressReferences[]` with publisher, title, date and URL.
- **Attribution.** "Company data provided by crunchbase".
- **Social links.** Twitter, LinkedIn and Crunchbase URLs.
- **H1B sponsorship history.**
  - `h1bAnnualJobCount[]` holds `{year, count}` and `h1bTitleDistribution[]` holds the titles sponsored.
  - The SEO JSON-LD renders it as a "Company H1B Sponsorship" paragraph. It says the company has a track record of sponsorship, lists counts by year, and adds a disclaimer that this does not guarantee sponsorship for this role (`pages/jobs/info/%5Bid%5D-6492e6b9f6c4c5ca.js`) [confirmed].
  - The data comes from USCIS records of companies that have sponsored H-1B (TechCrunch 2024) [likely].
  - The `h1BStatus` list field takes values like "Past Sponsorship", which maps to "H1B Sponsor Likely" [confirmed value; mapping inferred].
- **Flags.** `isAgency` (staffing agency), `isTnt` (in Jobright's talent network) and `companyRecommendationTags` (Unicorn and Top Investors).

### 6.6 Similar jobs and other recommendations

[confirmed]
- **API:** `/swan/recommend/similar/jobs`.
- **Visitor rails:** "You May Also Like" and "Hot Jobs in Popular Locations" (chunk 10344), using card types `VISITOR_SIMILAR_JOBS` and `VISITOR_HOT_JOBS`.
- **Closed jobs:** "Apply To Similar Jobs" CTA (4.4).

### 6.7 SEO and public detail

[confirmed]
- Job detail pages are public. Logged-out visitors see the full JD, company data and partial connections, but the match score is locked.
- JSON-LD `JobPosting` is emitted with:
  - `validThrough` set to the publish time plus 1 month.
  - `baseSalary`.
  - `jobLocationType` set to TELECOMMUTE for remote jobs.
  - An HTML description that concatenates Responsibilities, Qualification, Skills, Education, Benefits, Company Overview and H1B history.

---

## 7. Filters and preferences (the "All Filters" modal)

Primary: chunk `79590-8c2f0d2a5023ceda.js` (modal), chunk `83417-f57e27494e59bf0c.js` (quick bar) and `_app` module 68343 (option lists) [confirmed].

The modal has a left-hand anchor nav with four sections, each with a short subtitle. "Reset" and "Confirm(N)" buttons sit at the bottom, where N is the live count of matching jobs from `/swan/recommend/count-filter-jobs`.

### 7.1 Basic Job Criteria

Anchor `#basic`. Subtitle: "Job Function / Job Type / Work Model...".

| Field (key) | Control | Options and validation |
|---|---|---|
| **Job Function** (`jobTaxonomyList`) — required | Job-title selector with typeahead. Hint: "(select from drop-down for best results)". | A 3-level taxonomy (L1/L2/L3 IDs such as `01-08-01`; for example Software/Internet/AI › Data & Analytics › Data Analyst). Onboarding allows max 3. Warns "Too general" when a title is very broad. Validates overlap with excluded titles. |
| **Excluded Title** (`excludedTitle`) | Autocomplete, collapsible | Free entry of titles to exclude. |
| **Job Type** (`jobTypes`) — required | Checkbox group | Full-time, Contract, Part-time, Internship |
| **Work Model** (`workModel`) — required | Checkbox group | Onsite, Hybrid, Remote |
| **Location** (`locations` / `cityRadius`) | Multi-location selector with country picker, cities or states, and radius | Countries: **United States, Canada, United Kingdom, Australia, Ireland, New Zealand**. Each has an "All locations within X" option. Radius: **0, 5, 25, 50, 100 mi** (default 25 when added through feedback). There is a cap on how many cities can be added. |
| **Experience Level** (`seniority`) — required | Checkbox group, with suggestions from the resume (`suggestedSeniority`) | Intern/New Grad, Entry Level (1–3 yrs), Mid Level (2–5 yrs), Senior Level (5+ yrs, project leader), Lead/Staff (cross-team leader or domain expert), Director/Executive (Director/VP/CXO). Each has a long tooltip definition. |
| **Required Experience** (`minYearsOfExperienceRange`) | Range slider | 0–11 years, suffix "Years", default "Any requirements" |
| **Date Posted** (`daysAgo`) | Radio | Past 24 hours, Past 3 days, Past week, Past month. Default is any. |

### 7.2 Compensation & Sponsorship

Anchor `#compensation`. Subtitle: "Annual Salary / H1B Sponsorship".

| Field | Control | Options |
|---|---|---|
| **Minimum Annual Salary** (`annualSalaryMinimum`) | Slider, prefix "Min" | $10k to $800k in $10k steps, default "Any salary". Displayed as "$Nk/yr". |
| **Work Authorization** (`isH1BOnly`) | Checkbox "H1B sponsorship" | The description says it matches jobs that state sponsorship ("H1B Sponsored") or come from companies with recent sponsorship of similar roles ("H1B Sponsor Likely"). |
| **Exclude Jobs with Limitations** (`excludeByAuthorization`) | Checkbox group | Security Clearance Required, US Citizen Only |

### 7.3 Areas of Interests

Anchor `#interests`. Subtitle: "Industry / Skill / Role(IC/Manager)...".

| Field | Control | Notes |
|---|---|---|
| **Industry** (`companyCategory`) | Searchable multi-select with suggestions (`industryCandidates`) | Mutually exclusive with Excluded Industry |
| **Excluded Industry** (`excludeCompanyCategory`) | Searchable multi-select, collapsible | |
| **Skill** (`skills`) | Searchable multi-select with custom input and suggestions (`skillCandidates`) | |
| **Excluded Skill** (`excludedSkills`) | Searchable multi-select, collapsible | Also filled by Not Interested → skills |
| **Role Type** (`roleType`) | Radio | IC, Manager |

### 7.4 Company Insights

Anchor `#company`. Subtitle: "Company Search / Exclude Staffing Agency...".

| Field | Control | Options |
|---|---|---|
| **Company** (`companies`) | Search, select and checkbox with logos | Include only these companies |
| **Company Stage** (`companyStages`) | Checkbox group, with a tooltip table | Early Stage (Seed/Series A, 1–50 employees), Growth Stage (Series B/C, 51–200), Late Stage (Series D+, more than 500), Public Company. When stage is unknown it is estimated from headcount. |
| **Job Source** (`excludeStaffingAgency`) | Checkbox "Exclude Staffing Agency" | Hides all staffing-agency listings |
| **Exclude Company** (`excludedCompanies`) | Search, select and checkbox | Also filled by Not Interested → company |

### 7.5 Other filter facts

- **Hidden Jobs toggle.** Top bar. Shows only jobs not on LinkedIn or Indeed. Turbo-only. Jobity says it was promoted as 5,360 recent roles [likely].
- **Quick filter bar** [confirmed, chunk 83417]. Uses a subset of fields:
  - Country, Company, Experience Level, Job Type, Work Model and Date Posted.
  - Other presets: Location, Work Model and Experience; and Company, Work Model, Location and Salary.
- **Active filter chips** read "N miles", "Exclude Staffing Agency", "H1B Only" and "Min $Nk/yr" (chunk 95257) [confirmed].
- **Save to default.** In the Agent, users are asked whether to save a change to their default job-match filters [confirmed].
- **Filter label map** (used in chat, chips and empty-state explanations): Industry, Required Experience, Date Posted, Role Type, Company Stage, Skill, Company, Job Type, Work Model, H1b, Salary, Experience Level, Job Title, Job Function (`_app` 41166) [confirmed].

### 7.6 Search

[confirmed: chunk 95257 and `_app` 23428]
- **Search box** with placeholder "Search by title or company".
- **Typeahead** starts after at least 2 characters with a 400ms debounce. It suggests **job titles** (`searchType=job_title`) and **companies** (`searchType=company`), with logos.
- **APIs:** `POST /swan/recommend/search?searchType&refresh&count=10&position&sortCondition`. A matching count is available from `/swan/recommend/count-search-filter-jobs`.
- **Search results** use the same card list and the same sorts. The end of results says no more jobs are related to the search.
- **Applied tab** has its own search ("Search in Applied jobs").
- **Visitor search** (logged out, `/jobs/[visit]`): `/swan/recommend/visitor-search` and `/swan/recommend/visitor-list/jobs`. The homepage hero search form takes Job Title, Work Model, Country, City and Experience Level, then "GO".

---

## 8. Feedback loop

### 8.1 Like or save

[confirmed]
- A heart toggle on cards and on the detail page: `/swan/job/like` and `/swan/job/unlike`.
- Liked jobs go to the Liked tab.
- Applying to a liked job removes it from Liked. An error shows if that removal fails.

### 8.2 Not Interested

[confirmed: chunk `79519-9a4e0e2986bab470.js`; enum in `_app` 98052]

A drawer or modal titled "Not Interested". Its subtitle asks why the job is not a fit so matches can be refined, and notes that some choices will update filters and refresh matches. There is a single-choice radio list. Choices that need more detail expand an inline editor.

| Option (UI, paraphrased) | Enum | What happens |
|---|---|---|
| Not interested in this **company** | `company=1` | Adds the company to `excludedCompanies`. Toast says jobs from this company will be hidden. |
| Not interested in this **industry** | `industry=11` | Shows industry checkboxes plus "Add industry...". Adds to `excludeCompanyCategory`. Toast says jobs from those industries will be filtered out. |
| I don't have the **required skills** | `skill=3` | Shows skill checkboxes plus "Add skill...". Adds to `excludedSkills`. Toast says jobs requiring those skills will be filtered out. |
| This job is not at my **target locations** | `location=8` | Opens a location editor ("Add location..."). Adds cities or states with a 25 mi radius. Toast says recommendations will refresh for the target locations. |
| This doesn't match my **experience level** | `experiencelevel=12` | Toast points to the experience level filter. |
| I don't meet the work **authorization requirements**, with sub-choices: | `work_authorization=10` | |
| · This job doesn't provide **H1B sponsorship** | `h1b=101` | Sets `isH1BOnly=true`. Toast says non-sponsoring jobs will be filtered out. |
| · This job requires **security clearance** | `security=102` | Adds to `excludeByAuthorization`. |
| · This job requires **US citizenship** | `us_citizen=103` | Adds to `excludeByAuthorization`. |
| (title variant) | `title=2` | Toast says jobs with the same title will be hidden. Used when the title is the issue. |
| **Other** | `other=6` | Free text ("Please specify..."). |

Other codes: `applied=5`, `report=9`, `fake_job=91`, `incorrect_info=92`, `job_expired=93`, and 13 for remove from list.

- **API:** `POST /swan/job/ignore {jobId, feedback, companyId?, jobTitle?, skills?, locations?, excludeCompanyCategory?, msg?}`.
- **Effect on recommendations:** most reasons write straight into the user's saved filter, which changes recommendations deterministically. The job disappears from the list immediately.
- **Variants:** the Explore page hides the industry and skill options.
- **Repeated rejections:** some Play Store reviewers complain that rejected jobs reappear several times a day (reported via search summary) [likely, unverified].

### 8.3 Report Issue

[confirmed enum, `_app` 98052]
- Reasons are `scam`, `offensive`, `incorrect`, `not_availiable` (sic), `not_remote`, `not_in_us` and `posting_date_incorrect`.
- **API:** `/swan/job/report`.
- After a scam report, the user is prompted to turn on the staffing-agency exclusion filter.

### 8.4 Applied confirmation loop

[confirmed: chunk 30004]
- After clicking an external apply, a **"Did you apply ?"** modal asks the user to confirm so the application can be tracked and future recommendations refined.
- The buttons are "Yes, I applied!" and "No, I didn't apply".
- Yes calls `/swan/job/apply` and shows a toast that the job is now in the Applied list. It may also trigger a Trustpilot review invite, with a 60-day cooldown.

### 8.5 Feed-level and agent feedback

[confirmed]
- The daily 0–10 match satisfaction survey (3.4).
- Orion asks how the user likes the updated list after a filter change ("Looks better" or "Not quite").
- **Agent onboarding:** the user rates 3 strong matches with thumbs up or down. After a dislike, the agent asks what was disliked and then serves 3 refined roles (agent chunk).
- **Job-list rating (marketing pages):** a 1–5 rating. For scores ≤3, improvement chips appear: "Need more variety/roles", "Info is not detailed enough", "Filter/Search is hard to use" and "Need more fresh jobs". There is also an offer of a $10 gift card for a 10-minute feedback call (`pages/marketing-jobs-…js`).

---

## 9. Ranking internals (reverse engineered)

Public SEO list items include a `jobNotes` object [confirmed, `__NEXT_DATA__` on `/jobs/data-analyst` and `/jobs/machine-learning-engineer`]:

```
jobNotes: {
  boostedFactor: 1.8296,
  rankScore: 1.8296,
  notesMap: {
    retriever: "titleTaxonomy",
    retriever_key: "titleTaxonomy",
    retriever_score: "1.00",
    retrieve_score: "1.0",
    taxonomy_ids: "01-08-01",
    freshness_weight: "1.21975",
    mix_rank_weight: "1.5",
    company_scatter_demote: "1.0",
    linkedin_job_id: "<id>"
  }
}
```

**Interpretation** [inferred]
- **Multi-retriever candidate generation.** For example, `titleTaxonomy` retrieves jobs whose taxonomy ID matches the user's job function.
- **Freshness multiplier.** It decays smoothly with age: about 1.2198 at 7 minutes and about 1.207 at around 1 hour.
- **Mixing weight** across retrievers.
- **Company diversity demotion** (`company_scatter_demote`), so one company does not flood the list.
- **Final score.** `rankScore` is roughly retrieval × freshness × mix × demote, then re-ranked for logged-in users by `displayScore` (`TOP_MATCHED`) or time (`FRESHNESS`).
- The presence of `linkedin_job_id` on every sampled public listing shows many listings are **ingested from LinkedIn** (see section 10).

---

## 10. Freshness and sources

- **Sources.**
  - Jobright says listings are aggregated from LinkedIn, Indeed, company career pages and more (blog post "Is Jobright Legit?") [confirmed].
  - The App Store adds "major job boards, company career sites, and public listings" [confirmed].
  - `isCompanySiteLink` flags a direct employer link. `source` and `sourceId` are numeric source codes (for example 140 / "1400") [confirmed].
  - There are separate integrations for **JobTarget** (Easy Apply questionnaires) and **Greenhouse** (Easy Apply) [confirmed].
  - Employer-posted jobs (`isToB`) come from Jobright's own recruiting product (`/employers`) [confirmed].
- **Freshness.**
  - Public lists show jobs minutes old ("7 minutes ago", "24 minutes ago") [confirmed].
  - A tester saw a job labelled "3 minutes ago" that the employer had posted the same afternoon. Their freshest feed job was 2 hours old (jobity) [likely].
  - Instant job alert emails are sent within the first hour of posting (settings chunk) [confirmed].
- **Quality filtering.**
  - Marketing claims "no fake listings" and the removal of suspicious or outdated listings [confirmed marketing].
  - Reddit and Trustpilot users report stale, month-old LinkedIn-sourced posts and listings that don't match the career page (adzuna and jobity review summaries) [likely].
- **Closed jobs.** `isDeleted=true` shows JOB CLOSED and offers similar jobs. The Liked tab splits "Active" and "Closed" jobs [confirmed].
- **Reposts.** `repost=true` is labelled "Reposted …" [confirmed].
- **Coverage.**
  - Historically US-only (App Store, Play Store and reviews).
  - **As of the 2026-10 bundle, the country picker includes Canada, United Kingdom, Australia, Ireland and New Zealand** (`_app` 68343 and chunk 83417) [confirmed in code]. Live inventory in those countries is not verified.
  - Jobright's own blog says the focus is the US with global plans.
  - This looks like a 2026 expansion in progress [inferred].

---

## 11. Liked, Applied and External tabs

### Liked (`/jobs/liked`)

[confirmed: `pages/jobs/liked-f634fa150b100201.js`]
- A list of saved jobs with **Active / Closed(N)** segments.
- Empty state: no liked jobs yet, with a prompt to explore recommendations and a "View Recommended Jobs" button.
- The same card actions apply. Marking a liked job applied moves it to Applied.

### Applied (`/jobs/applied`), the tracker

[confirmed: `pages/jobs/applied-618e558dc6557856.js`, chunk 42214 and `_app` 85289]
- **Status dropdown** on each card: Applied, Interviewing, Offer Received, Rejected, Archived. Saved via `/swan/job/apply-status/save`.
- **Status line:** "Applied on MMM D, YYYY", or a "Marked as <status> on <date>" line.
- **Summary row** with counts per status (`/swan/job/statistic`).
- **Search** ("Search in Applied jobs"). Empty states cover both no applications and no matches.
- **Source tags:** "Direct Apply" and "Applied by Agent".
- **Undo:** "unapply" is available via `/swan/job/unapply`.
- **Reviewer criticism:** no notes and no sorting (hirecarta) [likely].

### External (`/jobs/external`)

[confirmed: `pages/jobs/external-67a5b06de9b7acc6.js`]
- **Purpose:** import job postings from other sources to tailor a resume and get match analysis.
- **Steps:**
  1. Paste a job URL into the input, then "Add Job".
  2. "Get Job Details" scrapes the page (`/swan/import/job-by-url`, polling the crawler status).
  3. Possible results: details are ready to review, some details were found and the rest must be filled in, or no details were found. The user can enter the company name manually.
  4. On success, "✅ External Job Added" with "View Job" to see the match score, tailor the resume and apply.
- **Abuse limits:** too many attempts trigger a 1-hour cooldown, and repeated abuse suspends the feature for **7 days**.
- **Orion follow-up:** offers to update filters to find more jobs like the imported one.

---

## 12. Apply flow end to end

1. **Click APPLY NOW** (card or detail).
   - The job opens on the employer or source site in a new tab.
   - The `/swan/job/apply` call is deferred until the user confirms in the "Did you apply ?" modal. Choosing "No" keeps the job unapplied.
   - Analytics track a `TRUE_APPLY` event [confirmed, chunk 30004].
2. **Autofill path.** "APPLY WITH AUTOFILL" requires the **Jobright Autofill** Chrome extension (Chrome only).
   - Setup steps from chunk 10344: (1) install the extension, (2) complete initial setup and activate, (3) find autofill-compatible jobs.
   - The extension fills ATS forms from the profile and resume and tracks applications synced to the account. The user still reviews and submits [confirmed: extscope mirror; jobity].
   - The extension has about 200k–300k users with a 4.7–4.8 rating (extscope, favtutor) [likely].
   - Free accounts get 4 autofills per day and Turbo gets unlimited (jobity, favtutor) [likely].
3. **Easy Apply** (Greenhouse or JobTarget). Applies in-app, with uploads and screening questions.
4. **Direct Apply / Send My Profile.** For employer-customer jobs, the profile goes straight to the employer's queue.
5. **Agent.** "Add to Agent" puts the job in a queue that the AI agent applies to. Applications are tagged "Applied by Agent" [confirmed]. Testers report waitlists and paywalls (jobity) [likely].
6. **Manual mark.** "Already Applied" in the more menu.

---

## 13. Job alerts, emails and notifications

- **Settings → "Instant Job Alerts Notifications"** [confirmed: `pages/settings-d1abc17acf0503a8.js`].
  - Email notifications on fresh, tailored job opportunities, sent within the first hour of posting.
  - **Job Alerts Frequency:** up to 1 per day, up to 2 per day, up to 5 per day, or Unlimited.
  - **Gating:** free members get up to 1 alert per day and Turbo members get up to unlimited.
- **Unsubscribe page** (`/tools/job-alert/unsubscribe`) [confirmed: `pages/tools/job-alert/unsubscribe-7618324c80540f5d.js`].
  - Reasons: recommendations don't match what I'm looking for; jobs are not relevant; too many emails; already found a job; Other (please specify).
  - **APIs:** `/swan/feedback/job-alert/unsub` and `/swan/resume/job-alert/unsub`.
- **Email digest landing** via `/jobs/email-list/:id` [confirmed route; content inferred].
  - Email links may carry `?expire=true`, which shows the fake "Expires in N hrs" chip [confirmed logic; email origin inferred].
- **Agent-era claim.** Up to 50 matched listings per week (Bloomberg Law 2025-07) [likely].
- **Mobile apps** (iOS `id6738236788`, Android `ai.jobright.orion`). They promise "instant job alerts" [confirmed listing] and have shipped regularly since about June 2025 (iOS 1.8 → 1.15). Version 1.9.0 (2025-07-07) added multiple resumes and a strengths-and-gaps report [confirmed, App Store].
- **Sender.** One third-party guide says newsletters come from an address at `jobrightai.com` [likely, unverified].

---

## 14. Free vs Turbo gating (feed-relevant)

From jobity (2026-08-31) and favtutor (2026-08-21), corroborated by wobo, adzuna and careerkit [likely]. The settings copy confirms the alert limits [confirmed].

| Capability | Free | Turbo |
|---|---|---|
| Recommended feed, match scores, tags, filters (incl. H1B) | ✓ | ✓ |
| Saved filters | 1 | Unlimited |
| Hidden Jobs filter | ✗ | ✓ |
| Instant job alerts | 1/day | Unlimited (1/2/5/unlimited picker) |
| One-click autofill | 4/day | Unlimited |
| AI custom resume | 2/day | Unlimited |
| AI cover letter | 2/day | Unlimited |
| LinkedIn email finder | 2/day | Unlimited |
| AI Agent | Limited or waitlist | Unlimited |
| Orion chat | Unlimited | Unlimited |
| LinkedIn profile report (full) | Partial | Full |

**Pricing history** [likely]:
- 2025: Turbo $29.99/month, with "$30/month" in The Register 2025-06.
- Late 2025 to 2026: $39.99/month, $17.99/week and $89.99 per 3 months. Jobity's screenshot shows $39.99 struck through from $49.99.
- Credits reset at midnight and do not roll over.

---

## 15. API surface relevant to this angle

All from public bundle `_app` module 23428 and nearby modules. Base path is `/swan` [confirmed].

| Purpose | Endpoint |
|---|---|
| Feed | `GET /swan/recommend/list/jobs` |
| Search | `POST /swan/recommend/search` |
| Visitor feed | `POST /swan/recommend/visitor-list/jobs` |
| Visitor search | `POST /swan/recommend/visitor-search` |
| Filter counts | `POST /swan/recommend/count-filter-jobs`, `/count-search-filter-jobs` |
| Similar jobs | `POST /swan/recommend/similar/jobs` |
| TNT jobs | `GET /swan/recommend/tnt/jobs` |
| Agent jobs | `GET /swan/recommend/auto-apply/jobs` |
| Like / unlike / count / list | `/swan/job/like`, `/swan/job/unlike`, `/swan/job/like/count`, `/swan/job/liked/jobs-v2` |
| Apply / unapply / count / list / status | `/swan/job/apply`, `/swan/job/unapply`, `/swan/job/apply/count`, `/swan/job/applied/jobs-v3`, `/swan/job/applied/search-jobs`, `/swan/job/apply-status/save`, `/swan/job/statistic` |
| Not interested / report | `/swan/job/ignore`, `/swan/job/report` |
| Skill feedback | `/swan/filter/user-skill/add`, `/swan/filter/user-skill/exclude` |
| Match survey | `/swan/feedback/job-match/show`, `/swan/feedback/job-match/submit` |
| Alerts unsubscribe | `/swan/feedback/job-alert/unsub`, `/swan/resume/job-alert/unsub` |
| External import | `/swan/import/job`, `/swan/import/job-by-url`, `/swan/import/job-by-url/status`, `/swan/import/status`, `/swan/import/list`, `/swan/import/remove` |
| Share | `/swan/share/job/link`, `/swan/share/job/{shareId}`, `/swan/share/job/batch` |
| Email finder | `/swan/email/linkedin-to-email`, `/swan/email/external-linkedin-to-email` |
| LinkedIn URL | `/swan/resume/update-linkedin-url` |
| Easy Apply | `/swan/greenhouse/*`, `/api/jobtarget/questions`, `/swan/job/jt-apply` |
| Popups | `/swan/popup/updates` |

Every list response item has the shape `{impId, jobResult, companyResult, displayScore, rankDesc?, isLiked?, applyStatus?, jobNotes?}`. `impId` is an impression ID, for example `0_search_<ts>_<n>`, used for feedback attribution [confirmed].

---

## 16. Data model summary (for RoboApply schema design)

**`jobResult`** [confirmed]

| Group | Fields |
|---|---|
| Identity and title | `jobId`, `jobTitle`, `jobNlpTitle` |
| Seniority and location | `jobSeniority`, `jobLocation`, `jobLocations[]`, `isRemote`, `workModel`, `lat`, `lng`, `countryCode` |
| Timing | `publishTime`, `publishTimeDesc`, `repost` |
| Pay and type | `salaryDesc`, `minSalary`, `maxSalary`, `employmentType` |
| Summaries | `jobSummary`, `jdResponsibilitySummary`, `coreResponsibilities[]` |
| Experience and applicants | `minYearsOfExperience`, `maxYearsOfExperience`, `applicantsCount`, `applicantsDisplayText?` |
| Tags | `recommendationTags[]`, `jobTags[]` |
| Match | `recommendationScores[]`, `skillMatchingScores[]`, `industryMatchingScores[]` |
| Requirements | `skillSummaries[]`, `educationSummaries[]`, `benefitsSummaries[]`, `jdCoreSkills[{skill, score, type}]`, `qualifications{mustHave[], preferredHave[]}`, `detailQualifications{mustHave, preferredHave: {yoe[], education[], hardSkill[], softSkill[]}}` |
| Taxonomy | `firstTaxonomy`, `jobTaxonomyV3[]` (L1–L3) |
| Source and links | `source`, `sourceId`, `isCompanySiteLink`, `url`, `applyLink`, `originalUrl` |
| Authorization | `isWorkAuthRequired`, `isH1bSponsor`, `isCitizenOnly`, `isClearanceRequired`, `h1BStatus` |
| Status flags | `isToB`, `hiddenJob`, `isDeleted` |
| Recruiter | `jobRecruiter`, `jobRecruiterProfileUrl` |
| Content and integrations | `whyJoinUs`, `jobtargetEasyapply`, `socialConnections[]` |

**`companyResult`** [confirmed]

| Group | Fields |
|---|---|
| Identity | `companyId`, `companyName`, `companySize` |
| Descriptions | `companyDesc`, `gptShortDescription`, `companyCategories`, `companyGptCategories[]`, `companyRecommendationTags[]` |
| Links | `companyTwitterURL`, `companyLinkedinURL`, `companyCrunchbaseURL`, `companyURL` |
| Profile | `companyFoundYear`, `companyLocation` |
| Funding | `fundraisingCurrentStage`, `fundraisingTotalFunding`, `fundraisingKeyInvestors[]`, `fundraisingLatestRounds[]` |
| People and press | `leadership[{pname, ptitle, plinkedinUrl, plogoUrl}]`, `pressReferences[{url, postedOn, title, publisher}]` |
| H1B | `h1bAnnualJobCount[{year, count}]`, `h1bTitleDistribution[]` |
| Flags | `isAgency`, `isTnt`, `isForceJobLinkedinVerify`, `linkedinCompanyId` |
| Glassdoor | `grating{rating, url, count}` |

**Taxonomy.** 3 levels with IDs like `01-00-00` › `01-08-00` › `01-08-01`. Public SEO pages exist for about 4.5k taxonomy and location slugs (`sitemap-taxonomy.xml` lists 4,548 URLs) [confirmed].

---

## 17. Changes over time

- **2024-04:** public beta. The 2024-06 TechCrunch piece covers match scores, the H1B filter and insider connections, with "Orion" as the copilot [likely].
- **2025-06-24:** Jobright Agent launches (auto-apply). The feed gains "Add to Agent" and "Applied by Agent" [likely, The Register].
- **2025-07 to 08:** the mobile app adds multiple resumes and a strengths-and-gaps report (1.9.0) and dark mode (1.10.0) [confirmed, App Store].
- **Late 2025:** Turbo rises from $29.99 to $39.99 per month [likely].
- **2026:**
  - The score label set observed is Strong / Good / Fair Match with a % ring. Hirecarta's 10-point "Poor" observation suggests a different or older variant [likely].
  - Company-stage, Unicorn, Top Investors and "Recently raised" tags appear [confirmed in code].
  - The Hidden Jobs filter becomes Turbo-only [likely].
  - The country picker expands to CA, UK, AU, IE and NZ [confirmed in code].
  - The homepage "400,000+ / 8,000,000+" figures are static throughout [likely].

---

## 18. Implications for RoboApply (dual brand: RoboHire.io international, GoApply.Top mainland China)

All of the following is [inferred].

- **Ship the four tabs** (Recommended / Liked / Applied / External), the three sorts, and the four-section filter modal with exact parity of fields. This is the core retention loop.
- **Score explainability**
  - Show an overall % ring, a rank label, and a 3–4 component breakdown (experience level, skills, industry, education).
  - Show per-skill chips that highlight skills the user has.
  - Show a "Why this job is a match" summary.
  - Add up to 3 reason tags with a deterministic priority order.
- **Make Not Interested write to filters**, as Jobright does. It is simple, explainable and immediate.
  - Add a daily 0–10 satisfaction pulse with reason chips for scores below 8 to collect ranking labels.
- **Market-specific authorization tags**
  - International (RoboHire.io, which includes Taiwan): keep the H1B Sponsored / Likely / No H1B triad for the US. Add equivalents for other markets, such as UK Skilled Worker sponsor licence, Canada LMIA, and Taiwan work permit or Gold Card.
  - GoApply.Top (mainland China): replace with relevant flags such as 户口 / 编制 / 五险一金 / 双休 / 外企 and 国企 / 央企 tags, and salary in 万/月 × months.
- **Company tab sources.** Use Crunchbase-like funding, leadership, news and Glassdoor ratings internationally. For China, use 天眼查 / 企查查-style registration, funding and risk data, and 看准 / 脉脉-style ratings. Source availability and licensing need verification.
- **Ranking.** Retrieval by taxonomy ID, a freshness multiplier, a company-diversity demotion and a mix weight are a sound, cheap baseline. Re-rank with the match score for "Top Matched".
- **Avoid copying**
  - The pseudo-random "Expires in N hrs" urgency chip.
  - Hardcoded inventory counters.
  - Both damage trust, and reviewers already flag Jobright's static numbers.
- **Sources.** Prefer ATS and career-site ingestion (Greenhouse, Lever, Workday, Ashby; Moka and 北森 in China) over LinkedIn reposts, to avoid the "stale listing" complaints Jobright gets.

---

## 19. Open questions

1. Exact score-to-label thresholds for Strong, Good and Fair. The label is server-provided (`rankDesc`). The CSS bands are ≤70, 71–85 and >85, but the label cutoffs are not verified.
2. How the overall `displayScore` combines the components. The weights are unknown.
3. Whether Recommended shows a "N new" badge or a daily cap. No evidence of a daily cap on browsing was found, apart from the alert caps.
4. Content and cadence of the daily or instant alert email: subject lines, number of jobs per email, and whether there is a separate weekly digest. Only the settings copy and unsubscribe reasons were confirmed.
5. Report Issue UI labels. Only the enum was seen; the lazily loaded chunk was not fetched.
6. Live job inventory for CA, UK, AU, IE and NZ. The picker exists, but inventory was not verified (it may be behind a feature flag).
7. Exact rendering of `h1bTitleDistribution` on the Company tab (chart vs list). The lazily loaded chunk was not captured.
8. Whether Not Interested also trains a per-user model, beyond the deterministic filter edits.

---

## 20. Source index

**Primary (Jobright)**
- https://jobright.ai/
- https://jobright.ai/ai-job-match
- https://jobright.ai/h1b-jobs
- https://jobright.ai/job-referral
- https://jobright.ai/orion-copilot
- https://jobright.ai/compare/simplify (updated May 2026)
- https://jobright.ai/blog/is-jobright-legit/
- https://jobright.ai/sitemap.xml and https://jobright.ai/sitemap-pages.xml
- https://jobright.ai/jobs/data-analyst (`__NEXT_DATA__`, 2026-10-09)
- https://jobright.ai/jobs/machine-learning-engineer (`__NEXT_DATA__`, 2026-10-09)
- https://jobright.ai/jobs/info/6aac8b023e3ce93970c7ddcb (`__NEXT_DATA__` and page text, 2026-10-09)
- https://static.jobright.ai/_next/static/GQd0ykV_IrfhtmCjLOY2m/_buildManifest.js

**JavaScript chunks** (prefix each with `https://static.jobright.ai/_next/static/chunks/`)

| Chunk | What it shows |
|---|---|
| `pages/_app-ff4b18b98295f6d5.js` | Modules 23107, 23428, 41166, 68343, 85289, 98052 and 20227 |
| `pages/jobs/recommend-73cab9378acfb3f3.js` | The recommend page |
| `pages/jobs/liked-f634fa150b100201.js` | The Liked tab |
| `pages/jobs/applied-618e558dc6557856.js` | The Applied tab |
| `pages/jobs/external-67a5b06de9b7acc6.js` | The External tab |
| `pages/jobs/explore-c1756f1f653a1a7b.js` | The Explore page |
| `pages/jobs/info/%5Bid%5D-6492e6b9f6c4c5ca.js` | The job detail page |
| `pages/jobs/%5Bvisit%5D-60b39c9edcd02283.js` | The visitor search page |
| `pages/settings-d1abc17acf0503a8.js` | Settings |
| `pages/tools/job-alert/unsubscribe-7618324c80540f5d.js` | Alert unsubscribe |
| `pages/agent-70b6a9ee45390efe.js` | The AI Agent |
| `pages/marketing-jobs-a6c9096f0a7de5fd.js` | Job-list rating on marketing pages |
| `pages/onboarding-v3/diagnostics-fc025d692df73b81.js` | Onboarding diagnostics |
| `79590-8c2f0d2a5023ceda.js` | Filter modal |
| `83417-f57e27494e59bf0c.js` | Quick filters and the hidden-jobs toggle |
| `79519-9a4e0e2986bab470.js` | Not Interested |
| `12523-2672b0db982e25a0.js` | Card score, more menu, urgency copy and apply tooltips |
| `30004-1f1c720fd216f7ed.js` | Tag priority and the "Did you apply" modal |
| `3530-56459b383af38dfc.js` | Score bands, apply-source labels and card badges |
| `42214-1d004cc959ad987f.js` | Detail header, hiring manager and agency |
| `9484-643a19ecd78e5948.js` | Detail sections |
| `91191-0245d1db4448b39a.js` | Insider connections and the email finder |
| `10344-7630c6c855467801.js` | Tabs, Orion, saved filters and the LinkedIn banner |
| `97342-7f758d8ed7830b3e.js` | Orion presets |
| `95257-b76910c6140f0fbb.js` | Search box and filter chips |
| `19182-3517085055152b49.js` | Resume-analysis banner eligibility |

**Store listings**
- https://apps.apple.com/app/id6738236788
- https://www.extscope.org/extension/odcnpipkhjegpefkfplmedhmkmmhmoko (Chrome Web Store mirror)

**Press**
- https://techcrunch.com/2024/06/25/jobright-uses-ai-to-help-foreign-workers-navigate-the-us-job-market/
- https://www.theregister.com/2025/06/24/ai_may_take_jobs_but/
- https://news.bloomberglaw.com/artificial-intelligence/new-ai-startup-will-suggest-jobs-and-even-fill-out-applications

**Reviews**
- https://jobity.io/blog/jobright-review
- https://favtutor.com/jobright-ai-review/
- https://hirecarta.com/blog/jobright-review
- https://www.wobo.ai/blog/jobright-review/
- https://www.adzuna.co.uk/blog/jobright-review-better-alternative-in-2025/
- https://www.careerkit.me/blog/jobright-review
