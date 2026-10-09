# Jobright.ai: business model, pricing, growth loops, SEO

Research angle: monetization, growth and SEO. Researched 2026-10-09. Sources are public pages only. No account was created and no form was submitted.

Confidence tags:
- **[confirmed]**: primary source (jobright.ai, its GitHub org, store listings, the company's own press releases).
- **[likely]**: two or more independent secondary sources agree.
- **[inferred]**: my own reasoning from the evidence.

Method notes and limits:
- Jobright has **no public job-seeker pricing page**. `jobright.ai/pricing` returns 404 (checked 2026-10-09). Turbo prices appear only in the in-app plan picker after sign-up, so every job-seeker price below comes from dated third-party checkouts.
- `jobright.ai/robots.txt` blocks ClaudeBot and GPTBot from `/jobs/`, and blocks all crawlers from `/legal/*`. I did **not** fetch `/jobs/*` or the Terms page. Facts about those pages come from search-result titles, the sitemap and secondary sources.
- Many secondary reviews are written by competitors (OutApply, Jobity, ResumeHog, HiringReach, scale.jobs, Wobo). Their numbers are used only where several agree, and that bias is flagged.

---

## 1. Executive summary

- **Model.** Consumer freemium. A free tier with **daily credits that reset at midnight** sits under one paid tier, **"Turbo"**, sold as weekly ($17.99), monthly ($39.99) or quarterly (about $89.99) plans. Two kinds of paid add-ons sit on top: interview-question **passes** and paid **1:1 coaching sessions**. Since 2026 a separate **B2B line** sells an **AI Recruiter** at $499 per active role per month, a free recruiter-side **Fraud Detection** Chrome extension, and **TNT (Top Talent Network)**, a two-sided marketplace between talent and AI startups. [confirmed for B2B; likely for B2C prices]
- **Traction (company claims).** 50K users (Jun 2024), 100K (Sep 2024), 500–520K (Jun 2025), about 3M "trusted users" on the homepage (Oct 2026). Third-party estimates put traffic at about 4.1–4.5M visits a month in mid-2026, roughly 87% from the US. Funding is $7.7M in total: a $4.5M seed in 2023 and $3.2M in June 2025 with Indeed's venture affiliate participating. [confirmed / likely]
- **Growth engine.** Organic first:
  1. 36 bot-updated **GitHub job-list repos**, committed hourly.
  2. Four **satellite SEO domains**: newgrad-jobs.com, intern-list.com, entrylevel-jobs.com and careerin.ai.
  3. About 4.5K **programmatic `/jobs/{role}[-in-{city}]` taxonomy pages**, plus indexable job-detail pages.
  4. About 210 **blog posts**, many piggybacking on LinkedIn and Indeed how-to queries and competitor "review 2026" queries.
  5. 11 **`/compare/{competitor}` pages**.
  6. **Free tool landing pages** such as the ATS checker and cover letter generator.
  7. A **Chrome extension** with 300K users.
  8. **iOS and Android apps**.
  9. A **Trustpilot review-invite** program, which went from about 1.4K to 3.5K reviews in 2026.
  10. Founder-led **LinkedIn content** and a **Reddit** presence.
- **Markets.** **US-only** job inventory, English-only UI, no hreflang. The satellite list sites add a US/Canada toggle. There is no China, Taiwan or EU product. [confirmed]

---

## 2. Company facts and timeline

| Fact | Value | Confidence | Evidence |
|---|---|---|---|
| Legal entity | Jobright Inc. (the app stores list "© 2023 Jobright Inc.") | confirmed | https://apps.apple.com/app/id6738236788 |
| HQ | Santa Clara, CA. Third-party trackers give the address as 3120 Scott Blvd. | confirmed (HQ) / likely (address) | https://jobright.ai/blog/is-jobright-legit/ ; https://jobspipe.dev/hiring/jobright.ai |
| Co-founder and CEO | **Eric (Yuan) Cheng**: CMU MS CS, early engineer at Box, previously co-founder and CEO of Fangcloud (enterprise file-collaboration SaaS in China) | confirmed | https://jobright.ai/about |
| Co-founder and CTO | **Ethan (Yudian) Zheng**: HKU PhD (AI and DB), formerly ran the local news feed at NewsBreak and was an ads-ranking tech lead at Twitter | confirmed | https://jobright.ai/about ; https://www.theregister.com/2025/06/24/ai_may_take_jobs_but/ |
| Origin | The About page says the idea came from Eric's 2021 gap-year trip, during which he helped about 10 young people land jobs. The company was founded in 2023. | confirmed | https://jobright.ai/about ; https://techcrunch.com/2024/06/25/jobright-uses-ai-to-help-foreign-workers-navigate-the-us-job-market/ |
| Team | About 69 employees (Revelio, Mar 2026) to about 96 (jobspipe, Sep 2026). The team is split between China and the US (Linkloud podcast). | likely | https://www.reveliolabs.com/companies/jobright/employees ; https://podwise.ai/episodes/7101577 |
| Funding: seed | **$4.5M, mid-2023**, led by Lanchi Ventures, with UpHonest Ventures and Source Code Capital | confirmed | https://jobright.ai/blog/is-jobright-legit/ ; TechCrunch link above |
| Funding: 2025 | **$3.2M, 24 Jun 2025**, led by Translink Capital, with **HR Tech Investments (Indeed's venture affiliate)**. Tracxn labels it Series A; others call it seed. | confirmed | https://jobright.ai/blog/jobright-launches-first-ai-agent-to-put-job-search-on-autopilot/ ; https://www.finsmes.com/2025/06/jobright-raises-3-2m-in-funding.html |
| Total raised | $7.7M (the company's figure, matching CB Insights and Tracxn). Caplight shows $12.2M, which is unverified. | confirmed | https://jobright.ai/blog/is-jobright-legit/ |
| Valuation | $15.5–20M (Aug 2023), a CB Insights estimate | likely (third-party only) | https://www.cbinsights.com/company/jobright/financials |
| Revenue | Not disclosed. GetLatka claims "$1M ARR (bootstrapped) 2025", which is low quality and contradicts the funding history. The founders told The Register only that revenue growth was strong. | inferred / unverified | https://getlatka.com/companies/jobrightai ; The Register link |
| Tech | Runs on AWS. Uses OpenAI, Anthropic and Google models plus fine-tuned Llama models (2025). Zilliz Cloud vector DB is a published customer case study. SOC 2 audit completed Dec 2025 (auditor Advantage Partners, via Vanta). | confirmed | The Register ; https://zilliz.com/customers/jobright.ai ; https://jobright.ai/blog/jobright-has-completed-its-soc-2-audit/ |

### Timeline, 2023 to 2026

| Date | Event | Evidence |
|---|---|---|
| 2023 (mid) | Company founded; $4.5M seed | is-jobright-legit blog |
| 2023-03 | GitHub org `jobright-ai` created | `gh api orgs/jobright-ai` (created_at 2023-03-06) |
| 2023-10 | `Daily-H1B-Jobs-In-Tech` repo created, the first GitHub SEO and community asset | GitHub API |
| Early 2024 | Custom GPTs in OpenAI's GPT Store. The company claims 1M+ uses and later markets itself as "featured by OpenAI". | is-jobright-legit blog; Chrome Web Store listing |
| 2024-04 | Public beta. 50K registered users within about 2 months with "no marketing spend". | TechCrunch, 2024-06-25 |
| 2024-06 | TechCrunch feature on the H-1B filter. Founder AMA on r/csMajors. | TechCrunch; is-jobright-legit blog |
| 2024-07-16 | Product Hunt launch: #1 Product of the Week and of the Month (July 2024); 2.2K followers; 4.8 rating from 12 reviews; hunted by Ben Lang | https://www.producthunt.com/products/jobright-ai-2 |
| 2024-08 | The 2026 intern and new-grad GitHub repos are created | GitHub API (created 2024-08-26) |
| 2024-09-18 | **Jobright 1.0** launch post: 100K+ users, 8M listings, 400K new a day | https://jobright.ai/blog/launching-jobright-1-0-revolutionizing-the-job-search-experience-with-ai/ |
| Late 2024 to mid 2025 | iOS app (id 6738236788). Earliest visible version 1.8.0 on 2025-06-01; 1.9.0 (Jul 2025) adds multiple resumes and strengths/gaps reports; 1.10.0 (Aug 2025) adds dark mode. | App Store listing |
| 2025-06-24 | **Jobright Agent** (auto-apply) launched with the $3.2M round. Claims 520K+ users and 30x YoY growth. Coverage: US tech, education and government roles. | Press release on blog; The Register; https://finance.yahoo.com/news/jobright-launches-first-ai-agent-120000547.html |
| 2025-07-02 | Bloomberg Law coverage: the agent sends up to 50 listings a week | https://news.bloomberglaw.com/artificial-intelligence/new-ai-startup-will-suggest-jobs-and-even-fill-out-applications |
| 2025 (by Nov) | **Turbo monthly price raised from $29.99 to $39.99** (some reviews date it to early 2026) | https://www.adzuna.co.uk/blog/jobright-review-better-alternative-in-2025/ ; https://zplatform.ai/ai-reviews/jobright-ai/ |
| 2025-12 | SOC 2 audit announced (Dec 18). Trustpilot profile claimed (Dec). | SOC 2 blog post; https://www.trustpilot.com/review/jobright.ai |
| 2026-02-05 | CTO on the Linkloud podcast (in Chinese) describes the growth playbook: LinkedIn, H-1B community, Reddit, SEO, "sub-site keywords" | https://podwise.ai/episodes/7101577 |
| 2026 H1 | Content wave: about 100 new blog posts (competitor reviews, ChatGPT prompt guides, FAANG interview guides). `/compare/*` pages added (sitemap lastmod 2026-04-24; the pages say "Updated May 2026"). | Blog sitemap; https://jobright.ai/compare/simplify |
| 2026 | B2B launches: **AI Recruiter** at $499 per role per month, **Fraud Detection** extension, **TNT** network, **Coaching** (1:1 sessions and Deep Dive), **Interview Questions** bank with paid passes | https://jobright.ai/employers ; /employers/pricing ; /fake-candidate-detection ; /tnt ; /coach-landing ; /interview-landing |
| 2026-10 | Homepage claims **3,000,000 trusted users**, 8M+ jobs, 400K+ new a day. Chrome extension v1.24.0 (Oct 8), 300K users. | https://jobright.ai/ ; Chrome Web Store |

### User-count claims over time (all self-reported)

| When | Claim | Source |
|---|---|---|
| Jun 2024 | 50K registered users | TechCrunch |
| Sep 2024 | 100K+ users | Jobright 1.0 post |
| Jun 2025 | 500K+ registered, 520K+ professionals, about 60% engaging daily, about 30% international (H-1B seekers) | is-jobright-legit blog; agent press release |
| May 2026 | "1.25M users" (a weak third-party figure) | https://atsverification.com/blog/jobright-ai-review-2026/ |
| Aug 2026 | About 2M on the homepage (one review reported this; unverified) | search summary of reviews |
| Oct 2026 | **3,000,000 trusted users** on the homepage. The app store and Play listings still say 500K. | https://jobright.ai/ ; HiringReach (Oct 2) |

---

## 3. Business model map

| Line | Buyer | Price | Status | Evidence |
|---|---|---|---|---|
| Free tier | Job seeker | $0, daily credits | Live; "free forever", not a trial | favtutor (Aug 2026) |
| **Turbo** | Job seeker | $17.99/wk, $39.99/mo, about $89.99/qtr | Live | §4 |
| Interview passes | Job seeker | $19.99 for a 7-day single-company pass; $39.99 for a 30-day All-Access pass. One-time, no auto-renew. | Live (Aug 2026) | https://favtutor.com/jobright-ai-review/ |
| 1:1 coaching | Job seeker | $69.99–$79.99 per 30-minute session with named senior recruiters, coach ratings 4.87–4.95 (Aug 31 2026). Some reviews say coaching is "included in Turbo", which conflicts. | Live | https://jobity.io/blog/jobright-review ; https://jobright.ai/coach-landing |
| Agent waitlist skip | Job seeker | A "Skip Waiting and Enable Agent Now" button leads to payment; price unknown | Observed Aug 2026 | jobity |
| **AI Recruiter** | Employer (growing tech companies) | **$499 per recruiter (one active role) per month**. 2-week free trial, no card. Annual plan is "talk to us". | Live | https://jobright.ai/employers/pricing |
| Fraud Detection extension | Recruiters | Free (Chrome extension in the ATS); paid tier unclear | Live; claims 10K+ recruiters | https://jobright.ai/fake-candidate-detection |
| TNT (Top Talent Network) | Talent (free?) and AI startups | Not shown ("Is Jobright TNT free?" FAQ has no visible answer) | Live; claims 200K+ talent, 150+ AI startups | https://jobright.ai/tnt |
| Cross-promo "Partners" | Other AI startups (OpenArt, Collov AI, TemPolor) | Link exchange, no fee shown | Live | https://jobright.ai/partners |

**[inferred]** The B2B recruiter product uses the B2C user base as its supply. It pitches a "Jobright network (about 3M professionals)" first, then about 200M external profiles. Candidates verify LinkedIn ownership at sign-up, which the employer FAQ says is used for candidate verification. Job pages carry a `candidatePreferenceToken` handler in the page JavaScript; I saw it in the homepage HTML, scoped to `/jobs/info/{id}`. This suggests recruiter-outreach links deep-link candidates onto Jobright job pages, which is a B2B-to-B2C acquisition loop. Job IDs prefixed `b2b_` (for example `jobright.ai/jobs/info/b2b_1784889469389_579`, seen in search results) indicate that employer-posted roles are mixed into the seeker feed.

---

## 4. Job-seeker pricing (Free vs Turbo)

### 4.1 Plan picker (in-app; no public page)

| Plan | Price | Displayed anchor or badge | Effective rate | Evidence (date checked) |
|---|---|---|---|---|
| Free | $0 | "Free forever" | — | favtutor (2026-08-21) |
| Turbo weekly | **$17.99 / week** | No strikethrough | about $72–78/mo; the worst per-day value | jobity (2026-08-31); outapply (2026-05-12); favtutor |
| Turbo monthly | **$39.99 / month** | Struck-through $49.99 with "Save 20%"; the default selection | $1.33/day | jobity; favtutor; resumehog (2026-10-03) |
| Turbo quarterly | **$89.98–$89.99 / 3 months** | Struck-through $149.97 with "Save 40%" and a **"Most Popular"** badge. Banner reads "less than $1 a day". | about $30/mo | jobity; favtutor |
| Annual / 6-month | Not offered publicly (2026). A third-party refund summary mentions "six-month first purchases", so a 6-month SKU may exist for some cohorts. | — | — | outapply; jobnova (unretrievable) |

- **Anchor critique [likely]:** the quarterly "Save 40%" compares against a $49.99 anchor. Against the real $39.99 monthly price the saving is 25% (favtutor's arithmetic).
- **Price history [likely]:**
  - Early 2024: free (an old LinkedIn post said "entirely FREE right now").
  - 2025: about $29.99/mo. An older snapshot showed $14.99/wk, $29.99/mo and $69.99/qtr.
  - Late 2025 to 2026: $39.99/mo.
  - Jobright's own July 2025 blog contradicts itself, giving $29.99 in one place and $19.99 in another: https://jobright.ai/blog/is-jobright-worth-it-a-detailed-comparison/ . The Register (Jun 2025) quoted "from $30/month".
- **Trial:** no Turbo free trial is advertised (outapply, jobity, Wobo). One competitor (scale.jobs) claims a 7-day trial, but this is not corroborated. [likely: no trial]
- **Student discount:** none advertised as of May 2026 (outapply). simplycodes lists no active promo codes. [likely]
- **Regional pricing:** none. USD only. [likely]

### 4.2 Free-tier daily limits vs Turbo (most detailed snapshot: favtutor 2026-08-21, matching jobity 2026-08-31)

| Capability | Free | Turbo |
|---|---|---|
| Job board browse, AI match scores, filters, job tracker, company insights | Yes | Yes |
| **Orion** AI copilot chat | **Unlimited** | Unlimited |
| AI custom (tailored) resume generation | **2 / day** | Unlimited (storage capped at **5 resume slots**) |
| 1-click application autofill (extension) | **4 / day** | Unlimited |
| AI cover letter | **2 / day** | Unlimited |
| LinkedIn email finder (insider-connection emails) | **2 / day** | Unlimited |
| AI Agent (auto-apply) | "Limited access" (in practice, a waitlist) | "Unlimited" (still waitlisted for some payers) |
| Saved filters | **1** | Unlimited |
| Instant job alerts | **1 / day** | Unlimited |
| **Hidden Jobs filter** (marketed as about 5,360 roles not on LinkedIn or Indeed) | Locked | Included |
| Live career coach | Not included | Listed as included, but the coaching tab sells sessions |
| Interview question bank | Upsell | Still shows "Upgrade to Unlock Interview Questions" (a separate pass) |

- Credits reset at midnight and do not roll over. Several reviewers summarize this as "about 2 credits a day". [likely]
- The free tier is described as a usable funnel, not a crippled demo. Orion stays unlimited, presumably for engagement and data. [inferred]

### 4.3 Billing, cancellation, refunds

- **Auto-renew:** all Turbo plans auto-renew. Cancel under Settings > Subscriptions, which shows price, renewal date and an Unsubscribe button. Cancellation takes effect at the end of the term. [likely] (favtutor; trustpilot-based summaries)
- **Refunds:** inconsistent. One cached Terms snapshot said all sales are final. A reading on 2026-08-20 found no such clause, with refunds at Jobright's discretion. A third-party summary cites windows of 7 days (first monthly or quarterly purchase), 24 hours (first weekly purchase) and 3 days for an accidental renewal. **Unverified**, because `/legal` is robots-blocked and not fetched. [likely: discretionary refunds with short windows]
- **Complaints:** billing and cancellation dominate one-star reviews. Themes are renewal without a warning email, a hard-to-find cancel button, charges after attempted cancellation, and email-only support. One review says 72% of one-star reviews concern billing. [likely] https://zplatform.ai/ai-reviews/jobright-ai/
- **Lesson for us [inferred]:** send a pre-renewal reminder email, offer one-click cancel, and publish a public pricing page. Each is a cheap trust differentiator against Jobright.

### 4.4 Paywall touchpoints observed (where the upsell appears) [likely]

1. A daily-credit exhaustion modal on resume, cover letter, autofill and email-finder actions.
2. The Hidden Jobs filter toggle (locked).
3. The Agent tab: a waitlist screen with "Skip Waiting and Enable Agent Now" leading to payment.
4. The Interview Questions tab: "Upgrade to Unlock Interview Questions", which sells passes.
5. The Coaching tab: book a paid 30-minute session.
6. Saved filters and job alerts after the first one.
7. Homepage and feature-page CTAs ("Unlock Auto-Apply" on /ai-agent).

Sources: favtutor, jobity, https://jobright.ai/ai-agent

---

## 5. Employer pricing (B2B), confirmed from https://jobright.ai/employers/pricing and https://jobright.ai/employers

- **Single recruiter: $499 per recruiter per month**, billed monthly, cancel anytime.
  - One AI recruiter per active role, reassignable when the role fills.
  - Includes sourcing, verification, outreach and delivery of **10–20 interview-ready candidates a week**, plus ATS sync with Ashby, Greenhouse, Lever and others.
  - The first 10 matches arrive within 24 hours.
- **Free trial:** 2 weeks, one role, no credit card. Cancel before day 14 and pay nothing.
- **Annual:** multiple roles, priority support, "Talk to us" / "Book 15 min demo".
- **No** placement fees, per-candidate fees or salary percentage.
- **Positioning:**
  - Cost comparison: an agency at 20% of a $180K salary is $36K; job boards cost $1.5–4K; sourcing tools $2.5–5.5K; Jobright $499 ("about 1%" of agency cost).
  - Vendor stats: 35% interview rate vs under 5% for job boards; 15% response vs 4–5%.
  - Not built for nursing, driving, retail or executive search.
- **Logos:** Cresta, PLAUD, Perplexity, Writer, OpenArt, Suno, Genspark.

---

## 6. Referral, affiliate, partnerships, B2B education

| Program | What exists | Confidence | Evidence |
|---|---|---|---|
| **User referral ("Refer & Earn")** | A dashboard section. Both referrer and invitee reportedly receive **5 Resume Analysis credits, 10 Custom Resume credits and 5 Insider Connection Email credits**. Credits, not Turbo days. Eligibility reportedly requires completing onboarding. | likely (one third-party page, Aug 2026; the page now returns 401) | https://invitation.codes/jobright.ai |
| Invite codes in URLs | `jobright.ai/?inviteCode=68723914&utm_source=1006` is used on the H-1B GitHub repo. This confirms an `inviteCode` query parameter in the sign-up attribution. | confirmed | https://github.com/jobright-ai/Daily-H1B-Jobs-In-Tech |
| UTM source IDs | Numeric `utm_source` per channel: 1103 (SWE new-grad repo), 1006 (H-1B repo), 1146 (remote-jobs page), plus `utm_campaign={category}` | confirmed | GitHub READMEs; /remote-jobs HTML |
| Affiliate or creator commission program | **None found** | likely (absence) | searches; simplycodes |
| Campus ambassador | None found | likely (absence) | searches |
| University or career-center licences | None found publicly. B2B effort goes to employers instead. | likely (absence) | searches |
| Newsletter partnerships | At least one newsletter (Unemployed / Beehiiv) partnered with Jobright to share internship roles | likely | search results (unemployed.beehiiv.com) |
| `/partners` page | Lists OpenArt, Collov AI and TemPolor (AI startups), apparently a link exchange or cross-promo | confirmed | https://jobright.ai/partners |
| TNT talent network | A two-sided referral of vetted talent to AI startups: one-click "invite to apply" and startup pitches to talent | confirmed | https://jobright.ai/tnt |

---

## 7. Growth loops (how Jobright acquires and retains)

1. **GitHub list loop** [confirmed]
   - 36 public repos under `github.com/jobright-ai`, totalling about 1,944 stars.
   - New Grad and Internship lists for 2026 across about 17 categories each: SWE, Data Analysis, PM, Business Analyst, Consultant, Engineering, Design, Marketing, Sales, Accounting, HR, Legal, Public Sector, Education, Support, Management, Art.
   - Updated **hourly by `jobright-ai-bot`** (latest commit 2026-10-09T13:40Z).
   - Each row links to `jobright.ai/jobs/info/{id}?utm_campaign=…&utm_source=1103`, so traffic and backlinks flow to job pages. The README sends readers to the full sortable list on **newgrad-jobs.com** (an Airtable embed).
   - Lists show only the last 7 days "due to capacity", which creates a reason to click through.
   - Largest repos: 2026-Software-Engineer-New-Grad (491 stars, about 566 rows), Data-Analysis-Internship (218), Data-Analysis-New-Grad (188), PM-Internship (150), SWE-Internship (141). Daily-H1B-Jobs-In-Tech (325 stars, 1,318 rows) was last pushed 2026-05-06, so it is now stale.
   - Compare SimplifyJobs, the category leader: Summer2026-Internships about 47.9K stars; New-Grad-Positions about 18.2K. Jobright is a distant follower here.
   - Evidence: `gh api orgs/jobright-ai/repos`; https://github.com/jobright-ai/2026-Software-Engineer-New-Grad
2. **Satellite-domain ("sub-site keyword") loop** [confirmed]. Hourly-updated list sites, each linking to jobright.ai and to each other. The CTO called this a "sub-site keyword strategy" (podcast).
   - **newgrad-jobs.com**: US/Canada new-grad (0–2 yrs) list, about 24 categories, H-1B flags, email alerts, Airtable view, company and city "hot lists".
   - **intern-list.com**: 2027 internships, 21 categories, US/Canada, two email-alert forms.
   - **entrylevel-jobs.com**: entry-level list with the same template.
   - **careerin.ai**: AI/ML jobs from about 20K AI-company career sites; shows 178,670 openings and 14,642 AI companies; filters for city, experience and work model; a "Companies" directory.
   - Evidence: https://newgrad-jobs.com/ ; https://intern-list.com/ ; https://www.entrylevel-jobs.com/ ; https://careerin.ai/
3. **Programmatic SEO loop** (§8). Taxonomy role/city pages, remote-jobs category pages, H-1B "{role} in {city}" lists and indexable job pages capture long-tail "X jobs in Y" queries.
4. **Content and competitor-capture loop**:
   - "{Competitor} review 2026" posts: Simplify, Teal, Careerflow, Jobscan, Sonara, AIApply, Scale.jobs, Rezi, Wonsulting, Lensa, ZipRecruiter, Indeed, Dice, Wellfound, Built In, Hiring.cafe, EarnBetter, Mercor, JobLeads, Jobhire, LockedIn AI, Jack & Jill, Surge AI.
   - `/compare/{x}` pages.
   - LinkedIn and Indeed how-to posts that capture platform-intent traffic.
5. **Free tool to sign-up loop**. ATS Resume Checker, Cover Letter Generator, Resume Helper, Job Tracker and AI Job Assistant pages carry "…for FREE" CTAs that lead into `/onboarding-v3/signup?from=`. [confirmed]
6. **Extension loop**. The Chrome extension (300K users, 4.9 from 372 ratings, "Featured" badge) autofills on thousands of ATS sites. Daily use in-ATS keeps Jobright top-of-mind and pushes upsells for tailored resumes. [confirmed] https://chromewebstore.google.com/detail/odcnpipkhjegpefkfplmedhmkmmhmoko
7. **Mobile loop**. iOS (4.8 from about 1.6K ratings) and Android (`ai.jobright.orion`, 50K+ downloads, 4.6 from 719 reviews) send instant job alerts as push re-engagement. [confirmed]
8. **Referral credits loop**. Two-sided credit reward via "Refer & Earn" and `inviteCode`. [likely]
9. **Review-velocity loop**. Trustpilot moved from 1,461 reviews (May 2026 compare page) to 2,341 (Jul 21 2026) to **3,560 (Oct 9 2026; 3,549 in the last 12 months)**, at TrustScore 4.8. The company invites reviews and replies to 96% of negatives. Ratings are then reused on `/compare/*` and landing pages. [confirmed] https://www.trustpilot.com/review/jobright.ai
10. **Founder-led LinkedIn and community loop**:
    - Early users came from LinkedIn.
    - The H-1B filter seeded an international-student community; about 30% of users were international.
    - The CTO grew his LinkedIn following from about 4K to about 50K using an internal AI agent for content planning.
    - A Reddit AMA on r/csMajors.
    - [likely] https://podwise.ai/episodes/7101577 ; TechCrunch
11. **Paid social** [likely, light]. A Google Play reviewer (Dec 2025) mentions seeing Jobright ads on Instagram. The company has claimed "no paid advertising" historically, so paid social is probably newer.
12. **AI-assistant distribution (GEO)**. Custom GPTs in the GPT Store (claimed 1M+ uses; links from /entry-level-jobs to `chatgpt.com/g/g-GHq4vRrgH-interview-pro` and `g-MrgKnTZbc-resume`). The "featured by OpenAI" badge is used across the site. A 2026 blog post about using Claude Cowork with Jobright. [confirmed]
13. **B2B-to-B2C loop** [inferred]. The AI Recruiter sends outreach to candidates in Jobright's network and beyond. That outreach brings candidates onto Jobright job pages (see `candidatePreferenceToken`) and grows the candidate network that the B2B product sells.

---

## 8. SEO and content architecture

### 8.1 Sitemap inventory (fetched 2026-10-09)

`https://jobright.ai/sitemap.xml` is an index of 7 child sitemaps.

| Child sitemap | lastmod | URLs | Content |
|---|---|---|---|
| sitemap-pages.xml | 2026-07-30 | 15 | `/`, `/employers`, `/employers/pricing`, `/ai-resume-builder`, `/ats-resume-checker`, `/job-autofill`, `/h1b-jobs`, `/about`, `/orion-copilot`, `/ai-job-match`, `/job-referral`, `/remote-jobs`, `/fake-candidate-detection`, `/coach-landing`, `/interview-landing` |
| sitemap-comparison.xml | 2026-04-24 | 11 | `/compare/{aiapply, careerflow, huntr, jobcopilot, jobscan, lazyapply, loopcv, scale-jobs, simplify, sonara, teal}` |
| sitemap-blog.xml | 2026-04-10 | 16 | Data-report posts (selected) |
| sitemap-taxonomy.xml (+ -1, -2) | 2026-03-20 | 4,548 unique (9,096 including duplicates across the 3 files) | `/jobs/{role-slug}` and `/jobs/{role-slug}-in-{city}-{st}` |
| sitemap-remote-jobs.xml | 2026-04-10 | 17 | `/remote-jobs`, `/remote-jobs/{category}`, `/remote-jobs/{category}/{role}` |

The blog is WordPress and has its own index at `https://jobright.ai/blog/sitemap_index.xml`: post, category, tag and author sitemaps, about 211 posts and 12 categories (artificial-intelligence, ats, career, h1b, indeed, internship, interview, job-search, linkedin, product, resume, security-trust). There is an RSS feed at `/blog/feed/`.

### 8.2 Programmatic page types and URL templates

| Page type | URL template | Scale | Notes | Confidence |
|---|---|---|---|---|
| Role taxonomy hub | `/jobs/{role}`, e.g. `/jobs/backend-engineer`, `/jobs/llm-engineer`, `/jobs/warehouse-manager` | **379 roles** | Covers tech and non-tech (nursing-adjacent, warehouse, sales, accounting) | confirmed (sitemap) |
| Role × city | `/jobs/{role}-in-{city}-{st}` | 379 × **11 cities** = 4,169 | Atlanta GA, Austin TX, Boston MA, Chicago IL, Dallas TX, Houston TX, Los Angeles CA, New York NY, Phoenix AZ, San Francisco CA, Seattle WA | confirmed (sitemap) |
| Keyword search landing | `/jobs/{keyword}-jobs-in-united-states`, `/jobs/{keyword}-jobs-in-{city},-{st}` | Open-ended long tail; not in the sitemap | Seen in search results, e.g. "Affiliate Sales Jobs in United States", "Campus Ambassador Jobs in california,-united-states" | likely (search results) |
| H-1B role × city | `/jobs/h1b-visa-sponsored-{role}-jobs-in-{city}-{st}` | 10 shown on /h1b-jobs, e.g. data-engineer in Miami FL | Linked from /h1b-jobs as "Popular Job Lists" | confirmed (/h1b-jobs HTML) |
| Job detail | `/jobs/info/{24-hex id}` (also `b2b_{ts}_{n}` IDs for employer jobs). `?visit={search-landing-slug}` links back to its hub. | About 8M | Title pattern "{Title} @ {Company}". Shows "H1B Sponsor Likely" with yearly sponsorship-trend chart (DOL data) and company info. Robots-blocked for AI crawlers only. | likely |
| Remote category | `/remote-jobs/{category}[/{role}]` | 12 categories plus role children | Title "Top U.S. 100% Remote Jobs (Verified & Updated Hourly)". Shows 296,582 openings / 18,655 new today. No login needed. "Subscribe To Fresh Remote Alerts". Typeform feedback. | confirmed |
| Segment hubs | `/h1b-jobs`, `/entry-level-jobs`, `/intern-jobs`, `/new-grad-jobs`, `/remote-jobs` | 5 | /intern-jobs claims "largest internship job hub" (about 79.7K openings in one snapshot) | confirmed |
| Competitor compare | `/compare/{competitor}` | 11 | One template: "Jobright vs X — Feature Comparison (2026)", Trustpilot rating vs rating, "3.6x SimilarWeb US traffic", a 20-row feature table scoring Jobright 20/20, a verdict ("Choose X if… / Choose Jobright if…"), a 5-question FAQ, and a job-search form footer | confirmed |
| Feature landing pages | `/ai-agent`, `/ai-resume-builder`, `/ai-job-match`, `/job-referral`, `/orion-copilot`, `/job-autofill`, `/ats-resume-checker`, `/interview-landing`, `/coach-landing`, `/tnt` | about 10 | Each has stats, testimonials and an FAQ (FAQPage JSON-LD on /ats-resume-checker) | confirmed |
| Free-tool pages | `/tools`, `/tools/ai-job-assistant`, `/tools/cover-letter-generator`, `/tools/resume-helper`, `/tools/job-tracker` | 5 | "…for FREE" CTA leads to sign-up | confirmed |
| Interview question bank | `/interview-landing`, then in-app | About 6,656+ questions and 328+ companies on the landing page; about 10,033+ in the app (Aug 2026) | Per-company counts (Uber 363, Anthropic 320, Stripe 320, Apple 259 …) | confirmed / likely |
| Salary pages | — | **None found** | Salary appears only inside job cards and "salary insights" | likely (absence) |
| Company pages | — | **No standalone public company directory found on jobright.ai.** careerin.ai has `/discover` companies. | Company info is embedded on job pages | likely (absence) |

### 8.3 Technical SEO details [confirmed from HTML]

- Next.js; `<html lang="en">`; **no hreflang**. Canonical on the homepage.
- Meta descriptions are present and keyword-led, e.g. "/remote-jobs: Browse verified 100% remote jobs… Updated hourly from 200K+ company career sites."
- FAQPage JSON-LD on tool pages.
- Static assets on `static.jobright.ai`.
- robots.txt blocks app routes (`/onboarding-v3/*`, `/matching`, `/jobs/recommend|profile|resume|liked|applied`, `/swan/`, `/api/`, `/monitoring`, `/legal`). It **blocks Bytespider entirely** and **blocks ClaudeBot and GPTBot from `/jobs/`**, which protects the job corpus from AI training while keeping Google access.
- The sign-up route is `/onboarding-v3/signup?from=`; onboarding sub-routes cover diagnostics, mode selection, career goals, advanced preferences and resume upload (named in robots.txt).

### 8.4 Blog topic clusters (about 211 posts) [confirmed from post sitemap]

| Cluster | Examples (slugs) | Purpose |
|---|---|---|
| LinkedIn how-to (largest, about 60) | how-to-add-certifications-on-linkedin, linkedin-premium-vs-sales-navigator, linkedin-headline-examples-for-students, how-to-cold-message-linkedin-internship | Capture platform-intent queries |
| Indeed how-to | how-to-apply-for-jobs-on-indeed, indeed-vs-glassdoor, how-to-delete-indeed-account | Same |
| Competitor reviews ("{X} review 2026") | simplify-copilot-review-2026…, teal-review-2026…, sonara-review-2026…, aiapply-review-2026…, jobleads-review-2026…, lockedin-ai-pricing (a 7-post LockedIn AI cluster) | Bottom-of-funnel alternative intent |
| ChatGPT prompts | chatgpt-tailor-resume-job-description-2026, chatgpt-job-search-prompts-2026, chatgpt-prompts-ats-friendly-resume | Ride AI-prompt search demand |
| Big-tech interview guides | google/meta/amazon/microsoft/openai/anthropic/uber/bytedance technical interview questions 2026 | Feed the interview-bank upsell |
| H-1B | an-ultimate-guide-to-h1b-jobs-for-product-managers…, the-ultimate-h1b-salary-guide…, how-to-choose-the-right-job-title-for-your-h1b… | International-student wedge |
| Remote and side jobs | remote-jobs-no-experience-2026, data-annotation-jobs-remote, virtual-assistant-jobs-remote-2026, concentrix-remote-jobs | Broad top-of-funnel |
| Data reports (proprietary data PR) | the-intern-new-grad-job-market-unpacked…, inside-the-2025-tech-salary-landscape…, the-companies-hiring-the-most-in-2025…, ais-most-efficient-innovators-revenue-per-employee | Linkable assets from the job corpus |
| AI and jobs | what-jobs-will-ai-replace, will-ai-replace-graphic-designers | Trend traffic |
| Product and trust | is-jobright-legit, jobright-vs-linkedin, is-jobright-worth-it…, jobright-has-completed-its-soc-2-audit, success-stories… | Brand-query defence |

Seven bylines: dora, rabecca, grace, tiffany, gigi, luke, wp-admin. There is also a Medium mirror at jobright.medium.com.

### 8.5 Free tools as SEO magnets

- **ATS Resume Checker**: title "Free ATS Resume Checker — Check Your Resume Match | Jobright". Nine FAQs with JSON-LD. Stats: 9.1/10 quality rating, 5 hrs saved per job, "10M jobs trained". https://jobright.ai/ats-resume-checker
- **Cover Letter Generator**: funnels into Orion chat ("Write a cover letter for this job"). https://jobright.ai/tools/cover-letter-generator
- **Resume Helper, Job Tracker, AI Job Assistant**: same template.
- **Fraud Detection**: a free recruiter Chrome extension, positioned as a B2B SEO magnet ("Start Detecting for FREE"). It claims 230+ signals and support for Greenhouse, Ashby, Workday, Bullhorn and Lever.

---

## 9. Distribution and app-store presence [confirmed]

| Surface | Name / ID | Metrics | Notes |
|---|---|---|---|
| Web | jobright.ai | About 4.1–4.5M visits/mo (ToolMage Jun 2026; Creati.ai Apr–Jun 2026), about 87% US | https://www.toolmage.com/ja/tool/jobright/ (third-party estimate) |
| Chrome extension | "Jobright Autofill – Instant Job Applications, Job Match, AI Tailor Resume" (`odcnpipkhjegpefkfplmedhmkmmhmoko`) | **300,000 users; 4.9 from 372 ratings**; v1.24.0, updated 2026-10-08; "Featured"; offers in-app purchases; English (US) only | Listing copy says "Trusted by 500K+ job seekers" |
| iOS | "Jobright - AI Job Search" (id6738236788), Business category | **4.8 from about 1.6K ratings**; v1.15.0 (Jul 20 2026); about 25 releases since Jun 2025; English only; US storefront | "Currently lists U.S.-based roles only" |
| Android | `ai.jobright.orion` | **50K+ downloads; 4.6 from 719 reviews**; updated 2026-08-21 | Package name keeps the original "Orion" brand |
| ChatGPT GPT Store | Interview Pro and Resume GPTs | Claimed 1M+ uses | Used for the "featured by OpenAI" badge |
| Social | LinkedIn, Instagram, TikTok, X, YouTube, Facebook (all @jobright / jobrightai) | — | Footer links |
| Product Hunt | jobright-ai-2 | #1 Week and #1 Month, July 2024 | Badge reused sitewide |

---

## 10. Localization and markets

- **Job inventory:** US-only. The App Store and Play listings both say US-based roles only, and the homepage search form defaults Country to "United States". [confirmed]
- **Satellite sites:** add a **US / Canada** toggle (newgrad-jobs, intern-list). [confirmed]
- **Languages:** English only (`lang="en"`, no hreflang, English-only store listings). [confirmed]
- **Expansion talk:** the June 2025 press release mentions "expanding into new markets for global reach", but no countries are named and nothing had shipped by October 2026. [confirmed]
- **User geography:** about 87% of traffic is US (Creati.ai estimate). About 30% of users are international students or workers in the US seeking H-1B sponsorship (TechCrunch 2024). The H-1B filter is popular with job seekers from India and China. [likely]
- **Team:** split across China and the US (podcast). The founders have China SaaS backgrounds. [likely]
- **No China, Taiwan, EU, UK or India product exists.** This is an open field for RoboApply's GoApply.Top (mainland) and RoboHire.io (international including Taiwan). [inferred]

---

## 11. Trust and reputation signals (as of Oct 2026)

| Signal | Value | Evidence |
|---|---|---|
| Trustpilot | **4.8**, 3,560 reviews; 84% five-star, 1% one-star; replies to 96% of negatives within about a week; invites reviews; profile claimed Dec 2025 | https://www.trustpilot.com/review/jobright.ai |
| Product Hunt | 4.8 (12 reviews), 2.2K followers | Product Hunt |
| Chrome | 4.9 (372) | CWS |
| iOS / Android | 4.8 (about 1.6K) / 4.6 (719) | stores |
| SOC 2 | Completed Dec 2025 | blog |
| Recurring criticism | Auto-renew and cancellation friction; the Agent waitlist even for payers; "remote" mislabels; rejected or irrelevant jobs reappearing; US-only coverage | Google Play reviews; Trustpilot; jobity; zplatform |

---

## 12. Competitor positioning vs Jobright (brief)

| Competitor | Core positioning | Pricing (2026, third-party) | How Jobright positions against it | Evidence |
|---|---|---|---|---|
| **Simplify** (simplify.jobs) | Free autofill extension and tracker. Owns the **GitHub new-grad and intern lists** (SimplifyJobs repos about 48K and 18K stars). | Free autofill. **Simplify+ $19.99/wk, $39.99/mo, $89.99/3 mo** (identical ladder to Jobright). Autopilot beta capped at 20 a week. | "Auto-fill vs AI copilot": Simplify only fills forms; Jobright discovers, ranks, tailors, refers and auto-applies. Scored 7/20 vs 20/20. | https://jobright.ai/compare/simplify ; search summary |
| **Teal** | Resume builder and job tracker | Teal+ $13 / 7 days, $29 / 30 days, $79 / 90 days | "Good for tracking" with no AI matching | https://jobright.ai/compare/teal |
| **Huntr** | Job-application tracker (free up to 100 jobs) | Pro $40/mo, $90/qtr, $160 / 6 mo | Compare page exists | https://jobright.ai/compare/huntr |
| **LazyApply** | Bulk auto-apply (volume) | No free tier. Annual Basic $99, Premium $149, Ultimate $999 (15/150/1,500 apps a day). | Quality and matching vs spray-and-pray | https://jobright.ai/compare/lazyapply |
| **Careerflow** | LinkedIn optimization, tracker, ATS checker | Premium $23.99/mo ($172.99/yr); Premium Plus $44.99/mo ($299.99/yr); weekly $8.99 / $19.99 | Compare page and review post | https://jobright.ai/compare/careerflow |
| **Final Round AI** | Real-time **interview copilot** and mock interviews | About $150/mo, about $83/mo quarterly, $25/mo annual; 3-day refund on quarterly and annual | No compare page. Jobright counters with the interview bank, an "AI Mock Interview" row and blog clusters on interview assistants (LockedIn AI). | https://ophyai.com/blog/career-advice/final-round-ai-pricing |
| **Sonara** | Fully automated auto-apply. Shut down Feb 2024, acquired by BOLD in mid-2024, relaunched. | About $2.95 trial, then $23.95 every 4 weeks (contested) | Compare page and review post | https://resumly.ai/answers/what-happened-to-sonara-ai ; https://jobright.ai/compare/sonara |
| Others with Jobright compare pages | AIApply, JobCopilot, Jobscan, LoopCV, Scale.jobs | — | — | sitemap-comparison.xml |

**Takeaway [inferred]:** Jobright's Turbo price ladder ($17.99, $39.99, $89.99) is essentially the market-standard Simplify+ ladder. Differentiation rests on matching quality, the referral and email finder, H-1B data, and breadth (coach, interview bank, agent), not on price.

---

## 13. Implications for RoboApply (RoboHire.io international / GoApply.Top mainland China) [inferred]

1. **Pricing skeleton to mirror (international):**
   - Free with daily credits: 2 tailored resumes, 4 autofills, 2 cover letters and 2 contact lookups a day; 1 saved search; 1 alert a day; unlimited copilot chat.
   - One paid tier with weekly, monthly and quarterly SKUs ($17.99 / $39.99 / $89.99 is the market norm).
   - One-time passes for the interview bank; paid 1:1 coaching sessions.
   - **Publish a public pricing page.** Jobright's hidden pricing is a top complaint and a cheap differentiator for us.
   - TWD pricing for Taiwan.
2. **GoApply.Top (mainland):**
   - Credit model in CNY with Alipay and WeChat Pay. RoboApply already has Alipay callbacks and currency-aware payments.
   - Weekly SKUs map well to the urgency of the 秋招/春招 (campus recruiting) seasons.
   - Distribution channels differ completely: Baidu SEO, a WeChat mini-program, Xiaohongshu, Zhihu and Bilibili instead of GitHub, Product Hunt or Trustpilot. Jobright's GitHub-list trick translates to campus job lists on 牛客 (Nowcoder) and 应届生 (new-grad) communities, and WeChat 公众号 (official-account) daily posts.
3. **SEO build list (international):**
   - Programmatic `/jobs/{role}` and `/jobs/{role}-in-{city}` pages (start with about 380 roles × top cities; for Taiwan use Taipei, Hsinchu, Taichung, Kaohsiung).
   - Indexable job-detail pages with sponsorship or visa signals.
   - `/remote-jobs/{category}` pages.
   - `/compare/{competitor}` pages (including Jobright itself).
   - Free tools: ATS checker, cover letter, tracker.
   - A competitor-review blog cluster and data-report posts built from our own job corpus.
   - Hourly bot-updated GitHub new-grad and intern repos with UTM and invite-code attribution.
   - Optional satellite list domains.
4. **Growth mechanics to clone:**
   - Two-sided referral credits (`inviteCode`).
   - Per-channel numeric `utm_source` IDs.
   - Trustpilot or app-store review prompts after success moments.
   - Push alerts in the mobile app.
   - An extension-first autofill wedge.
5. **B2B:** Jobright's $499-per-role AI Recruiter and free fraud-detection extension overlap directly with the sister product **RoboHire**. Plan the seeker-to-recruiter network loop (verified candidates feed recruiter sourcing) across the RoboApply and RoboHire brands.
6. **Policy conflict to resolve:** RoboApply's July 2026 overhaul killed auto-apply, while Jobright monetizes an "Agent" tier, even though it is waitlisted. Decide whether the clone includes auto-apply.

---

## 14. Open questions

- What the exact current refund and cancellation terms say. `/legal/service` is robots-blocked; read it manually.
- Whether a 6-month Turbo SKU or student or regional pricing appears for some cohorts. A/B tests are possible, so checkouts may differ.
- The current referral reward and whether "Refer & Earn" is still live; the third-party page now returns 401.
- What the AI Agent waitlist bypass costs, and whether the Agent is generally available to Turbo users in Oct 2026.
- Whether coaching is included in Turbo or sold per session; sources conflict.
- How many `/jobs/{keyword}-jobs-in-…` search-landing pages are indexed (not in the sitemap; needs a Google `site:` count).
- Whether TNT charges talent or startups.
- Real revenue and paid-conversion rate (not disclosed).
- How the user figure jumped from about 520K (Jun 2025) to 3M (Oct 2026), and whether the definition changed, for example to count extension installs.

---

## 15. Source list (primary first)

Primary (jobright.ai and owned properties):
- https://jobright.ai/ ; https://jobright.ai/robots.txt ; https://jobright.ai/sitemap.xml (+ sitemap-pages/-comparison/-blog/-taxonomy/-remote-jobs.xml)
- https://jobright.ai/blog/sitemap_index.xml ; https://jobright.ai/about ; https://jobright.ai/employers ; https://jobright.ai/employers/pricing
- https://jobright.ai/ai-agent ; https://jobright.ai/h1b-jobs ; https://jobright.ai/remote-jobs ; https://jobright.ai/entry-level-jobs ; https://jobright.ai/intern-jobs
- https://jobright.ai/ats-resume-checker ; https://jobright.ai/tools/cover-letter-generator ; https://jobright.ai/fake-candidate-detection ; https://jobright.ai/tnt ; https://jobright.ai/coach-landing ; https://jobright.ai/interview-landing ; https://jobright.ai/partners
- https://jobright.ai/compare/simplify ; https://jobright.ai/compare/teal
- https://jobright.ai/blog/is-jobright-legit/ ; https://jobright.ai/blog/is-jobright-worth-it-a-detailed-comparison/ ; https://jobright.ai/blog/jobright-launches-first-ai-agent-to-put-job-search-on-autopilot/ ; https://jobright.ai/blog/launching-jobright-1-0-revolutionizing-the-job-search-experience-with-ai/ ; https://jobright.ai/blog/jobright-has-completed-its-soc-2-audit/ ; https://jobright.ai/blog/automate-job-search-claude-cowork/
- https://github.com/jobright-ai (36 repos) ; https://github.com/jobright-ai/2026-Software-Engineer-New-Grad ; https://github.com/jobright-ai/Daily-H1B-Jobs-In-Tech
- https://newgrad-jobs.com/ ; https://intern-list.com/ ; https://www.entrylevel-jobs.com/ ; https://careerin.ai/
- https://apps.apple.com/app/id6738236788 ; https://play.google.com/store/apps/details?id=ai.jobright.orion ; https://chromewebstore.google.com/detail/odcnpipkhjegpefkfplmedhmkmmhmoko
- https://www.producthunt.com/products/jobright-ai-2 ; https://www.trustpilot.com/review/jobright.ai

Press and secondary:
- https://techcrunch.com/2024/06/25/jobright-uses-ai-to-help-foreign-workers-navigate-the-us-job-market/
- https://www.theregister.com/2025/06/24/ai_may_take_jobs_but/
- https://www.finsmes.com/2025/06/jobright-raises-3-2m-in-funding.html
- https://news.bloomberglaw.com/artificial-intelligence/new-ai-startup-will-suggest-jobs-and-even-fill-out-applications
- https://podwise.ai/episodes/7101577 (Linkloud Talk E02, CTO interview, Feb 2026)
- Pricing checks: https://jobity.io/blog/jobright-review (2026-08-31) ; https://favtutor.com/jobright-ai-review/ (2026-08-21) ; https://outapply.com/blog/jobright-ai-pricing (2026-05-12) ; https://resumehog.com/blog/posts/jobright-ai-review-2026-is-this-job-search-copilot-worth-it.html (2026-10-03) ; https://zplatform.ai/ai-reviews/jobright-ai/ (2026-09-14) ; https://www.adzuna.co.uk/blog/jobright-review-better-alternative-in-2025/ (2025-11-24) ; https://hiringreach.com/reviews/jobright-ai-review (2026-10-02)
- Referral: https://invitation.codes/jobright.ai
- Traffic: https://www.toolmage.com/ja/tool/jobright/ ; https://creati.ai/ai-tools/jobright-ai/
- Headcount: https://www.reveliolabs.com/companies/jobright/employees ; https://jobspipe.dev/hiring/jobright.ai
- Competitors: https://ophyai.com/blog/career-advice/final-round-ai-pricing ; https://resumly.ai/answers/what-happened-to-sonara-ai ; comparison summaries (fastapply, angld, scale.jobs) via search
