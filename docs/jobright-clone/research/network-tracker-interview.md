# Jobright.ai: networking, application tracking, interview prep and career coaching

Research date: 2026-10-09. Angle: Insider Connections and referrals, outreach generation, application tracker, interview preparation (question bank, mock or AI interview), salary help, career coaching (Orion AI plus human coaches), notifications and reminders, and per-plan gating.

## 0. Method, confidence, caveats

- **Public pages only.** No account was created, nobody signed in, and no form was submitted. Jobright's logged-in screens (job detail, Applied list, Orion panel, Coaching, Interview bank) are reconstructed from the public Next.js JavaScript bundles at `static.jobright.ai`, which are shipped to every visitor. UI labels quoted below are short functional labels (button and tab names). Longer copy is paraphrased.
- **Confidence levels.**
  - **confirmed**: seen in a Jobright primary source, either a jobright.ai page or Jobright's own shipped bundle code.
  - **likely**: reported by several secondary sources.
  - **inferred**: my own reasoning.
- **Bot check on job pages.** Logged-out job detail pages (`/jobs/info/{id}`) now return a Cloudflare "Security check" interstitial to non-browser clients. It was not bypassed, so job detail anatomy comes from the bundle code.
- **Bundle build.** Build ID `GQd0ykV_IrfhtmCjLOY2m` (route manifest: https://static.jobright.ai/_next/static/GQd0ykV_IrfhtmCjLOY2m/_buildManifest.js).

### Bundle citation keys (prefix `https://static.jobright.ai/_next/static/chunks/`)

| Key | File | What it contains |
|---|---|---|
| B-orion | `10344-7630c6c855467801.js` | Orion chat panel, contact cards, missions, coaching promos, office hour, saved filters |
| B-email | `57949-35ea3644d374b35a.js` | "Connect Via Email" composer modal, connection buckets, email-accuracy disclaimer |
| B-conn | `77153-d96c2e19330e5fe4.js` | Connection card actions, "Find More Connections" LinkedIn deep-link builder |
| B-li | `43594.64ca4b5fcd94fde1.js` | "Connect on LinkedIn" note modal |
| B-jobdetail | `91191-0245d1db4448b39a.js` | Job detail: Insider Connection section, Find Any Email, Send My Profile |
| B-status | `30004-1f1c720fd216f7ed.js` | Applied-card status dropdown, "Did you apply?" modal |
| B-app | `pages/_app-ff4b18b98295f6d5.js` | Application-status enum and labels, Gmail-connect gating |
| B-tabs | `19182-3517085055152b49.js` | Jobs tab bar (For you / Liked / Applied / External) |
| B-applied | `pages/jobs/applied-618e558dc6557856.js` | Applied list page |
| B-external | `pages/jobs/external-67a5b06de9b7acc6.js` | External job import (Job Clipper) |
| B-voice | `75381.dadac4ad49737ca3.js` | `/voice-chat` "AI Interviewer" voice call (Retell) |
| B-iq | `pages/interview/[companyId]-b851dadcd08d1865.js` | Interview question bank company page and code runner |
| B-ipass | `19013-be76c70b52202e83.js` | Interview Company Pass / All-Access Pass purchase UI |
| B-ilanding | `11371.f155cebb42740e32.js` | Interview landing FAQ |
| B-coachland | `40345.58993c04c4ec8f92.js` | Coaching landing page |
| B-coach | `54642-faf091491cfea9a2.js` | Coaching Discover / My Bookings, cancellation copy |
| B-coachpol | `pages/coaching-policy-85c07909c96a4f8f.js` | Coaching booking, cancellation and refund policy |
| B-deepdive | `21893.3a6b8dae20a51a9a.js` | Deep Dive group-session registration and waitlist |
| B-upsell | `42410.17a353ce660b63b0.js` | Loyal-member upsell (masterclass, group pass, student quarterly) |
| B-pricing | `8482.3246aea86dd9f354.js` | Pricing modal, free daily refills, Turbo feature list |
| B-cancel | `54649.28f0f3270fc52b8d.js` | Turbo cancel-retention modal |
| B-invite | `39506.59d25a247cf126f9.js` | Employer "Interview Invitation" inbox response form |
| B-invitemob | `11290.217ba4b80965800e.js` | Mobile notice for an interview invitation |
| B-settings | `pages/settings-d1abc17acf0503a8.js` | Job-alert frequency settings |
| B-unsub | `pages/tools/job-alert/unsubscribe-7618324c80540f5d.js` | Job-alert unsubscribe reasons |
| B-refer | `78734.174b123e7ef1c200.js` | Refer & Earn panel |
| B-referpol | `pages/referral-policy-40a1c4e58725ccd0.js` | Refer & Earn policy |
| B-agent | `pages/agent-70b6a9ee45390efe.js` | Agent page: Application Tracker, Competitiveness Report, agent modes |
| B-goals | `pages/onboarding-v3/career-goals-a011e6475bc60333.js` | Onboarding career-goal step |
| B-tracker | `pages/tools/job-tracker-34f019afeadbf407.js` | Public Job Tracker tool page with FAQ answers |
| B-workemail | `pages/work-email-verify-ac36a77d11e0c8bb.js` | Work-email verification |

---

## 1. Surface map (routes relevant to this angle)

From the route manifest (confirmed, build manifest):

- **Jobs.**
  - `/jobs/recommend` is the "For you" tab.
  - `/jobs/liked`, `/jobs/applied` and `/jobs/external` are the tracker tabs.
  - `/jobs/info/[id]` is job detail.
  - `/tools/job-tracker` and `/tools/job-clipper` are SEO landing pages for the tracker.
- **Networking.**
  - `/job-referral` is the Insider Connections landing page.
  - `/linkedin-verification/callback` handles LinkedIn OAuth ownership verification.
  - `/work-email-verify` handles work-email verification.
  - `/verify-referral/[code]` and `/referral-policy` belong to the Refer & Earn program, which is a different feature from job referrals.
- **Interview.**
  - `/interview-landing` is the marketing page.
  - `/interview` is the in-app index.
  - `/interview/[companyId]` is a company question bank.
  - `/interview_tip` is an SEO page.
  - `/voice-chat` is the "AI Interviewer" voice call.
- **Coaching.**
  - `/coach-landing` is the marketing page.
  - `/coaching`, `/coaching/discover` and `/coaching/bookings` are the in-app pages.
  - `/coaching-policy` is the policy page.
- **AI copilot.**
  - `/orion-copilot` is the marketing page.
  - Orion itself is a slide-in chat panel on most app pages, not a route.
  - `/agent` is the Agent page, which has its own Application Tracker.
- **Settings and alerts.** `/settings` holds alert frequency and account deletion. `/tools/job-alert` and `/tools/job-alert/unsubscribe` handle job-alert email.
- **Top navigation (logged in).** Jobs (badge "1000+"), Resume, Profile, Agent, Coaching, Interview (badge "new") (confirmed from https://jobright.ai/coaching and https://jobright.ai/interview/1441 renders). The Coaching and Interview top-nav items are 2026 additions. The June 2025 blog lists neither.

---

## 2. Insider Connections (networking and referrals)

### 2.1 Positioning and claims

- **Landing page.** The `/job-referral` page is headed "Unlock Personalized Insider Connections". Its 4-step flow is Sign up → Connect LinkedIn → Select a job → Get recommendations. The CTA is "Start Connecting for FREE".
- **Marketing claims.**
  - 4x interview chances with a referral.
  - 3x higher email response rate.
  - 70% better connection quality.
  - 4 hours a week saved.
- **Evidence.** The claims and flow are confirmed at https://jobright.ai/job-referral. The 4x claim also appears in the Jobright 1.0 launch post: https://jobright.ai/blog/launching-jobright-1-0-revolutionizing-the-job-search-experience-with-ai/. These are vendor figures and were not independently verified.
- **Testimonials.** The landing-page testimonials stress that Jobright surfaces LinkedIn profiles of people from the user's school and previous companies (confirmed, page bundle `pages/job-referral-be33e2e1090473d4.js`).

### 2.2 Prerequisite: the user's LinkedIn URL ("Unlock Your Network")

- **Input is a pasted URL, not OAuth.** The connection engine needs the user's own LinkedIn profile URL. The app asks for it in a modal with two variants (confirmed, B-orion):
  - **"Unlock Better Matches".** Asks for the LinkedIn URL so Jobright can personalize matches and find people in the user's network who may help with referrals.
  - **"Unlock Your Network".** Asks for the LinkedIn URL so Jobright can find alumni or past colleagues at the desired company.
- **Validation states (confirmed, B-orion and B-agent).**
  - Empty URL.
  - Invalid URL.
  - Well-formed URL but no LinkedIn profile found.
  - Success, labeled "Linkedin URL Verified".
- **Success copy.** Two variants: matches are now personalized, or the user should go to job detail to see who works at the target company.
- **Follow-up actions.** "View My Connections" and "Update Linkedin URL".
- **Profile header banner.** A dismissible "Add LinkedIn for smarter job matches" banner nudges users who have not added a URL (confirmed, B-orion).
- **Separate LinkedIn OAuth (confirmed, B-orion and the linkedin-verification callback chunk).** "Continue with Linkedin" and "Verify My LinkedIn" exist, but they serve candidate-authenticity verification for employers, not the connection graph.
  - The flow fails if the LinkedIn account used to sign in does not match the profile URL on file.
  - Some employers require this ownership check before an application.
  - In-app copy claims verified candidates are 2x more likely to be viewed by recruiters.
- **Data source (inferred).**
  - Jobright does not read the user's LinkedIn connection list. The privacy FAQ on `/job-referral` says only public profile data the user shared is used.
  - The bucket logic in 2.4 matches the user's past company and school IDs (parsed from the resume and LinkedIn profile) against a people index of employees at the job's company. That index is probably scraped or bought from public LinkedIn data.
  - OutApply's pricing post flags the feature's standing under LinkedIn's terms as uncertain (likely: https://outapply.com/blog/jobright-ai-pricing).

### 2.3 Entry points

1. **Job detail section "Insider Connection @ {Company}"** (confirmed, B-jobdetail). The subtitle offers connections who might provide insights and potential referrals.
   - The section sits in the job detail anchor nav alongside Overview and Company.
   - It also appears on Agent job cards with an "inside edge" wording variant (B-agent).
2. **Orion quick-action chip "Insider Connections"** (confirmed, B-orion). On job detail the chip sends the prompt "Show me Connections for potential referral."
   - The other chips are Job Highlights, Resume Tips, Top Candidates, Tailored Resume and a cover-letter action.
   - Orion replies with a heading "Here are some Insider Connections at {Company}" followed by grouped contact cards.
3. **"Find Any Email" box** on job detail and in Orion (confirmed, B-jobdetail).
   - The user pastes any `linkedin.com/in/...` URL to get a work email.
   - It is pitched as getting about 3x more responses by email than by LinkedIn.
4. **Agent workflow.** An "Email Lookup" step exists in the Agent's per-job task list (confirmed, B-agent).
5. **Mobile app.** The App Store listing describes "insider connection hints" (confirmed: https://apps.apple.com/app/id6738236788).

### 2.4 Buckets and contact card anatomy (confirmed, B-email, B-conn, B-orion)

**Buckets.** Each bucket is a tab or group. Its type is chosen by which match field is present.

| Type key | Label in job detail | Label in Orion | Match field | Card sub-line |
|---|---|---|---|---|
| `default` | Beyond your network | Beyond Your Network | none | `{jobTitle} @{company}` |
| `company` | From your previous company | From Your Previous Company | `matchCompanyName` | `Previously@{matchCompanyName}` |
| `school` | from your School | From Your School | `matchSchoolName` | `@{matchSchoolName}`, phrased in Orion as a fellow alumnus |

**Card contents.**
- **Header.** An avatar (photo, or an initial on a bucket-tinted background) plus full name, job title and current company.
- **Action buttons.**
  - A mail icon ("Connect Via Email" / "Find {name}'s email"). It is disabled when the user has no credits or email lookup is unavailable.
  - A LinkedIn icon ("Connect On Linkedin" / "Prepare a LinkedIn message for {name}"). It falls back to opening the profile directly, or to a disabled icon when no profile URL is known.
- **"Locked contact preview".** Free or over-limit users see blurred or locked contact cards (`blur` flag) with an "Unlock" action, which is an upsell to Turbo.

**Counts.**
- Jobright does not publish a count.
- The code renders a list per bucket. The compact card shows the first connection, with the rest in a dropdown, so each bucket appears to show only a few people.
- FavTutor's paid test (2026-08-21) found 1 person in total, with the other two buckets empty (likely: https://favtutor.com/jobright-ai-review/).
- Jobity saw named contacts at Rippling "beyond the author's own network" (https://jobity.io/blog/jobright-review).
- Coverage is reported to be weakest for people who did not study or work in the US (FavTutor).

**Empty bucket: "Find More Connections"** (confirmed, B-conn). This deep-links to LinkedIn's own people search on linkedin.com in a new tab:
- `default`: `linkedin.com/search/results/people/?currentCompany=<companyLinkedInId>&keywords=<jobTitle>`
- `company`: `currentCompany=<companyId>&pastCompany=[<user's past company IDs>]`
- `school`: `currentCompany=<companyId>&schoolFilter=[<user's school IDs>]`

So Jobright resolves the user's past companies and schools to LinkedIn company and school IDs. It hands off to LinkedIn search when its own index has nobody.

### 2.5 "Connect on LinkedIn" modal (confirmed, B-li)

- **Title and intro.** The title is "Connect on LinkedIn". An intro line says Jobright has prepared a connection message for the request.
- **Prefilled note.** The editable note is short and fits LinkedIn's connection-note limit. It is built from one template with an optional "shared background" clause:
  - Greeting by first name.
  - If the bucket is `company`: a clause noting that the user also worked at the matched company.
  - If the bucket is `school`: a clause noting that the user is a fellow alumnus of the matched school.
  - Interest in the {applyTitle} role at the contact's company, plus a polite request for help reaching the right contact.
  - A thank-you and the user's first name.
- **Buttons.** "Copy" (toast "Text copied successfully."), "Cancel" and "View Linkedin Profile" (opens the contact's profile). Jobright does **not** send the message itself. The user pastes it into LinkedIn.
- **Analytics.** `reco_detail_connect_click` / `ask_orion_connect_click` with `channel: linkedin|email` and the bucket type.

### 2.6 "Connect Via Email" flow and composer (confirmed, B-orion, B-email, B-conn)

**1. Email lookup.** Clicking the mail icon consumes an email credit.
- Orion shows a "Fetching Contact Info" card saying it is getting the email for {Name} at {Company}.
- The result is either "Contact Info Found!" or "Contact Info Not Found".
- Failure messages distinguish an unmatched LinkedIn URL from a profile that matched but has no email.
- A found card shows the company and email. Buttons are "Copy" (toast "Email copied.") or "Connect Now", which opens the composer.

**2. Composer modal.**
- **Title.** "Connect Via Email", with a sub-label claiming a 2x higher response rate than LinkedIn. The landing page says 3x, so the number is inconsistent across surfaces.
- **Description.** Reach the contact's work email directly with personalized content.
- **Info banner.** The email was retrieved from publicly available information and may not be 100% accurate.
- **Fields.**
  - **To.** The found email or emails, comma-joined, with a Copy icon.
  - **Subject.** Prefilled as "Seeking Your Advice on {Job Title} Position at {Company}".
  - **Body.** A rich-text editor (Quill), prefilled from one of **three static templates** chosen by bucket. These are not LLM-generated, which matches reviewers calling them boilerplate (likely: https://zplatform.ai/ai-reviews/jobright-ai/). The templates:
    - **Default.** Greet the contact, say the user came across the role and it fits their background, ask for insights about the role and team, mention the attached resume, ask them to forward it to the hiring team, then thank them and sign off with the user's full name.
    - **Previous company.** Same structure, opening with the shared employer and asking for advice on the strength of that shared background.
    - **School.** Same structure, opening with the shared school and appreciation for connecting with alumni.
  - The phrase about the attached resume is auto-bolded so the user remembers to attach it.
- **Send.** Submitting builds a `mailto:` link (to, subject and plain-text body) and opens the user's own mail client. Jobright does not send email for the user and attaches nothing.

### 2.7 Gating and credits for networking

**Free plan.**
- A daily refilled "Email Connection for Referral" credit, refilled up to 2 a day (confirmed, B-pricing).
- Secondary sources agree on 2 LinkedIn email lookups a day for Free and unlimited on Turbo (likely: FavTutor 2026-08-21, Jobity 2026-08-31).
- Viewing connection cards appears free but partly locked or blurred.
- Older Jobright copy calls Insider Connections "free with daily credits" and says users can earn more through Refer & Earn (confirmed, bundle text in the B-refer area).

**Turbo.**
- The pricing modal lists the "Linkedin Email Finder" as unlimited, pitched as perfect for cold outreach and referrals.
- The cancel-retention modal lists "Insider Connections: direct email & LinkedIn contacts" as a Turbo benefit you lose (confirmed, B-pricing and B-cancel).

**Refer & Earn bonus.** Credits include "Insider Connection Email" (confirmed, B-refer).

**History.**
- 2024: Insider Connections launched as a core free feature in Jobright 1.0.
- Mid-2025: older reviews put it in a $59 "Premium" tier (Scoutify, possibly stale).
- 2026: the feature is credit-metered, with Turbo unlimited.

### 2.8 Reported quality issues (likely, secondary)

- Contacts are often alumni or ex-colleagues rather than the hiring manager (https://hiringreach.com/reviews/jobright-ai-review).
- Coverage is thin outside the US (FavTutor).
- The feature fails silently when nobody is found (FavTutor).
- Templates are generic (zplatform).
- Suggestions can feel random or unrelated to the user's department (https://www.remotejobassistant.com/blog/jobright-ai-review, March 2026).

### 2.9 "Send My Profile": the referral-like direct route (confirmed, B-jobdetail)

- **Where it appears.** On jobs from TNT partner companies (`companyResult.isTnt`), the apply button becomes "Send My Profile" with the tagline "Skip the applicant queue, get reviewed like a referral".
- **TNT.** TNT (Top Talent Network, https://jobright.ai/tnt) is Jobright's curated, invite-reviewed pool connecting AI talent with partner startups.
- **Model.** This is Jobright acting as the referrer, a two-sided marketplace play rather than peer networking.

### 2.10 Employer-initiated "Interview Invitation" inbox (confirmed, B-invite, B-invitemob)

**Message.** The header reads "Interview Invitation from {Company}", and the body says a Jobright partner company thinks the candidate is a great fit.

**Job facts shown.** Location, Job Type, Work Mode, Salary, Seniority and Years Required.

**Responses.** "Yes, I am interested" or "No, I am not interested". A response is recorded afterwards.

**On Yes: "Please Provide Additional Interview Information".**
- Email address.
- Phone.
- Available for an interview next week (Yes/No).
- Availability details.
- Earliest start date: Immediately, Within 2 Weeks, Within 1 Month, or More than 1 Month.
- Work models, multi-select: Remote, Hybrid, Onsite.
- Sponsorship: requires now, requires in the future, or does not require.
- Submit.

**On No.** A free-text reason, used to tune preferences.

**Mobile.** Phones show a "Full Invitation Available on Desktop" notice telling the user to respond from the desktop "Messages" inbox.

**Employer side (confirmed, https://jobright.ai/employers).** The employer product's AI recruiter emails candidates from `talent@jobright.ai` with a "View role & connect" link. Candidates who respond flow into the employer's ATS (Ashby, Greenhouse, Lever).

---

## 3. Application tracker

### 3.1 Jobs area tab bar (confirmed, B-tabs)

The tab bar is "For you" | "Liked {count}" | "Applied {count}" | "External {count}". The counts come from `likedJobCount`, `appliedJobCount` and `importedJobCount`.

### 3.2 Applied list (`/jobs/applied`) (confirmed, B-applied, B-app, B-status)

**Layout.**
- A **list view, not a kanban board.** It is a virtualized vertical list of job cards (default card height about 176px, 12px gaps) with infinite load.
- A competitor's claim of a kanban board (https://www.autoapplymax.com/compare/autoapplymax-vs-jobright) is **not** supported by the shipped code.
- Status sub-tabs across the top show counts in the form `Applied(n) | Interviewing(n) | Offer Received(n) | Rejected(n) | Archived(n)`. Counts come from a `statisticByStatus` object.
- A collapsible search, "Search in Applied jobs", sits on the right.

**Card anatomy.**
- Job card content, with an "Applied on {date}" line.
- A **borderless status dropdown** with exactly 5 options: Applied, Interviewing, Offer Received, Rejected, Archived.
  - A change saves immediately via API (`jobId`, `applyStatus`) and logs `applied_list_status_update` (old and new status).
  - The click does not open the job.
- "Direct apply" and custom-resume download buttons. A remove button.

**Empty states.**
- No applied jobs yet, with a hint to explore recommended jobs and a "View Recommended Jobs" button.
- No matching applications, with a hint to update the search.

**Statuses (confirmed).**
- The enum keys are `APPLIED`, `INTERVIEWING`, `OFFER_RECEIVED`, `REJECTED` and `ARCHIVED`.
- The public tracker FAQ confirms the five predefined stages (B-tracker; https://jobright.ai/tools/job-tracker).

**Not found anywhere in the bundles:**
- Notes per application.
- Follow-up dates or reminders.
- Interview dates or contacts per application.
- Salary or offer details.
- Excitement or priority ratings.
- Calendar sync.
- Email-inbox parsing to auto-advance status.
- A kanban view.
- CSV export.

The one tracker-adjacent date field is "Interview Date", which belongs to the interview-question **contribution** form (section 4.1), not the tracker. Third-party claims of "follow-up dates and notes" (devtoollab and similar) look unfounded (inferred).

**Limits.** The tracker FAQ says there are no strict limits on saved or tracked jobs (confirmed, B-tracker). The tracker is free on every plan (likely: App Store listing, FavTutor, remotejobassistant).

### 3.3 How jobs get into "Applied" (auto-tracking)

1. **"Did you apply?" return prompt** (confirmed, B-status).
   - After a user clicks out to an employer site and comes back, a modal asks whether they applied, explaining that the answer helps Jobright track the application and refine recommendations.
   - "Yes, I applied!" moves the job to Applied. "No, I didn't apply" dismisses it. A student-plan popup can be chained after a Yes.
2. **Toasts.** "Done! You'll find this job in your 'Applied' list" appears on recommend, liked and external lists after an apply (confirmed, B-applied and the liked and external chunks).
3. **In-app apply paths** count as applied automatically (confirmed, B-jobdetail):
   - Jobright Easy Apply.
   - Autofill-extension applies.
   - "Send My Profile" (TNT).
4. **Agent.** It moves jobs and shows "Application status updated! This job has been moved to your '{list}'" (confirmed, B-agent).
5. **Chrome extension.** The Jobright Autofill extension listing also pitches a job-match and application tracker (likely, from mirrors of the Chrome Web Store listing, extension ID `odcnpipkhjegpefkfplmedhmkmmhmoko`, v1.15.0 dated 2026-06-29; https://chromeboard.com/extension/jobright-autofill-%E2%80%93-insta-odcnpipkhjegpefkfplmedhmkmmhmoko).
6. **Liked to Applied.** Applying from Liked moves the job. One edge-case error covers a job that was applied but could not be removed from Liked (confirmed, B-orion string list).
7. **No email-based tracking found.** Gmail OAuth exists, but only for the Agent (section 3.6).

### 3.4 External jobs ("External" tab, `/jobs/external`, marketed as "Job Clipper") (confirmed, B-external)

**"Add a New Job" form.**
- Original posting URL, with a "Get Job Details" button.
- Or manual entry: Job Title (required), Company Name, and Job Description (required, must be in English, paste the full JD).

**Processing states.**
- "Analyzing New Job.."
- "External Job Added", which says the user can now check the match score, tailor the resume and apply, with a "View Job" button.
- "Failed to Add New Job".

**Rate limiting.**
- Too many attempts in a short time blocks the user for 1 hour.
- Repeated abuse suspends the feature for 7 days.

**After import.** Jobright parses the job, creates a job page with a match score and tailoring, and the job becomes trackable (confirmed: https://jobright.ai/tools/job-tracker).

**Orion follow-up.** After an import, Orion may suggest filter changes ("Update Your Filter") so similar jobs show up in recommendations (B-orion).

### 3.5 Liked list (`/jobs/liked`) (confirmed)

- The heart or like icon on any job saves it here.
- Filters: Active and Closed.
- Empty state: no liked jobs yet, with a "View Recommended Jobs" button.

### 3.6 Agent "Application Tracker" (confirmed, B-agent, B-orion, B-app)

**What it is.** A second, task-oriented tracker inside `/agent` for jobs the AI Agent applies to.

**Contents.**
- Search by title or company.
- Task states: Active, Completed, In Progress, Paused, Not Started.
- A floating "Application progress" widget ("Working on {n} applications", "Open application status for {job}") that polls status ("Checking application status...", "Refresh status").

**Per-job steps.**
- Choose Resume.
- Confirm Custom Resume.
- Generate Cover Letter.
- Email Lookup.
- Fill out application form.
- Submit Now, or Apply Manually then "I've Applied".

**Agent modes.**
- "Supervised Mode" pauses for confirmation at the resume and at submission.
- "Agent Mode" runs autonomously.
- Weekly "Jobs per week" target.

**Gmail connect.**
- The Agent can require the user's Gmail ("Connect Gmail to submit your application").
- Its stated use is reading only one-time codes and verification links from job platforms. It promises never to read or store other email.
- Blocked states: "Please connect your Gmail to continue" and "Your Gmail connection needs attention".

**Availability (likely).** Jobright Agent was waitlisted or in limited beta through Aug–Oct 2026 (https://jobity.io/blog/jobright-review; https://resumehog.com/blog/posts/jobright-ai-review-2026-is-this-job-search-copilot-worth-it.html).

---

## 4. Interview preparation

### 4.1 Interview Question Bank (nav "Interview", badge "new"; added in 2026)

**Size over time.**

| Source and date | Questions | Companies | Added in last 30 days |
|---|---|---|---|
| Landing page, live 2026-10-09 (confirmed: https://jobright.ai/interview-landing) | 6,656+ | 328+ | not stated |
| Pricing modal (confirmed, B-pricing) | 9,851+ | 431+ | not stated |
| Landing FAQ (confirmed, B-ilanding) | not stated | not stated | 1,184+ |
| FavTutor, 2026-08-21 (likely) | 10,033 | 434 | 1,040 |

FavTutor's per-company counts: Google 570, Meta 573, Amazon 565, Anthropic 269, Apple 228.

**Categories (confirmed, B-ilanding).** Four main categories: Coding, System Design, Low-Level & Domain Design, and Behavioral & Experience. Sub-topics include data structures and algorithms, SQL and others. The landing page shows the three headline categories System Design, Coding and Behavioral.

**Sourcing claim (confirmed, B-ilanding, and B-iq disclosure).**
- The FAQ says questions come from interview experiences that real candidates reported.
- The Jobright team reviews, categorizes and tags each question by company, role and seniority, and adds a solution.
- A separate disclosure says questions are built from publicly shared interview reports in job-seeker communities and then organized by Jobright (inferred: scraped from sources like forums, which is a legal and quality risk to note).

**Company page anatomy (`/interview/[companyId]`) (confirmed, B-iq; partial render at https://jobright.ai/interview/1441?questionId=1249).**
- **Header.** "Interview" with a "Browse Companies" button. A "Trusted Question Source" badge. Search across 330-plus companies.
- **Filters.** "Topic" and "Seniority" (for example New Grad, Mid Level, L5, Lead/Staff), plus a role field (example placeholder: Software Engineer, Machine Learning Engineer), keyword search, and a clear-search button.
- **Question list card.**
  - Company logo and question title.
  - Difficulty tag (Medium/Hard).
  - Seniority, role, and an "Updated {n}h/d ago" freshness label.
- **Question detail.**
  - Problem statement (Input / Output / Explanation for coding).
  - "A clear step-by-step plan for how to think through and answer this question."
  - What the interviewer is really testing, plus common mistakes to avoid.
  - Rubric and follow-up questions, per testimonials and the pass copy.
  - "Verified AI-Generated Solution".
  - A solution-language selector.
- **Coding practice (built-in runner).**
  - Prompt to solve it yourself, then "Start Practice".
  - Language picker.
  - Sample cases ("Case n") and Run.
  - Test results with runtime.
  - An editor using the JetBrains Mono and Fira Code fonts.
  - A practice question list sidebar.
- **Report a problem.** Reasons: unclear statement, incorrect solution, inaccurate tags, duplicated, outdated or inauthentic, wrong test case, code that fails to compile. Plus free text.
- **"Contribute an Interview Question" form.** Select Company, role, Interview Date and the question text (crowd-sourcing loop).
- **Gating UI.**
  - Logged-out: "Sign Up to Unlock Interview Questions" / "SIGN IN TO VIEW MORE".
  - Logged-in without a pass: "Limited Access · Unlock Full Access Now", "Unlock to view the full solution", "Upgrade to Unlock Interview Questions".
  - Some companies are exclusive to the All-Access Pass.

**Monetization: one-time passes, separate from the Turbo subscription.**

| Pass | Price | Duration | Notes | Evidence |
|---|---|---|---|---|
| Company Pass | $19.99 | 7 days | No auto-renew; "best for one active interview" | B-ipass (confirmed for the product, duration and no-auto-renew); FavTutor (likely, price) |
| All-Access Pass | $39.99 | 30 days | Covers multiple interview loops; one-time | B-ipass (confirmed); FavTutor (likely, price) |

Further pass details (confirmed, B-ipass and B-orion):
- **Upgrade credit.** Upgrading from Company to All-Access credits unused pass time pro-rata.
- **Pass History.** Users have a "Pass History" view.
- **Promo variant.** The All-Access pass was shown at $0.00 "originally $39.99".
- **Quarterly plan bundle.** The Turbo Quarterly plan includes "Plus access to 9k+ interview questions" while the plan is active (B-pricing). FavTutor (August 2026) reported passes as separate from Turbo, so this bundle is likely a September–October 2026 change.

### 4.2 AI mock interview: not offered as a self-serve AI product

- **Jobright's own statement.** Jobright's September 2026 blog states that the Question Bank finds questions but does not run an AI mock interview or grade answers (likely, quoted by search results from https://jobright.ai/blog/chatgpt-job-interview-prompts/ or https://jobright.ai/blog/chatgpt-prompts-for-job-interviews/). Its recommended workflow is to pull questions from Jobright and rehearse with ChatGPT.
- **Orion is prep only.** Orion is positioned as pre-interview preparation (company insights, story prep), not a live interview assistant (confirmed: https://jobright.ai/blog/best-ai-interview-assistants-2026/, 2026-02-25).
- **Human mock interviews.** These are offered through **paid human coaching** (section 5.2). The coaching topic "I need to practice questions with a recruiter so I can pass the interview" and a testimonial about a "brutal" mock interview confirm this (confirmed, B-coach and B-coachland).
- **No scoring.** No text, voice or video AI mock interview with scoring exists in the bundles.
- **Conflicting secondary claims.** Verve Copilot and Linkjob claim AI mock interviews with scoring. These are unsupported and contradicted by Jobright's own blog.

### 4.3 "AI Interviewer" voice chat (`/voice-chat`) (confirmed, B-voice)

This is the closest thing to an AI interview, but it is a **candidate-intake screen for Jobright's employer marketplace, not practice.**

**Tech.**
- Retell AI web-call client (`useRetellClient`) over a LiveKit transport (active-speaker events, microphone pre-connect buffer).
- Audio only. No video.

**Entry points.**
- Email links (`entry=email`), plausibly the employer outreach emails.
- In-app with job context (`businessId`, `companyName`, `jobTitle`, `candidateName`).
- Links can expire: "Link Expired", with an "Explore Jobs" button.

**Flow.**
1. **Intro card.** Headline "Get an Extra Edge Before You Apply". Copy describes a quick 5-minute call with Orion to learn what the candidate wants and is strongest at, used to connect them with relevant hiring teams. A tag notes it only needs doing once. Button: "Start Voice Chat".
2. **Sign-in gate.** "Sign in to continue".
3. **Mic check.** "Let's test your microphone": a device selector (System default) and a prompt to say a few words. Then "Ready for a quick voice chat?" and "I'm ready, start now".
4. **Mic denied.** Help steps (lock icon, then allow, then refresh).
5. **In-call screen.**
   - Labeled "AI Interviewer", with a timer and a hang-up button.
   - Mic on/off.
   - "Restart call", which warns that progress is lost.
   - Reconnecting / connection lost states.
   - Leave confirmation: leaving now loses progress, so finish the call so Jobright can help applications stand out. Buttons "End Anyway" and "Continue the Call".
6. **Success screen.**
   - Thank-you message.
   - Consent checkbox: use the conversation for better job matches and to showcase strengths to potential employers.
   - "Close This Tab".
   - 1–5 star "How was your conversation?" rating. Hidden for the email entry.
7. **Abuse guard.** A rate limit on repeated voice-chat attempts.

**Relevance for RoboApply's live video interview work (inferred).**
- Jobright uses a hosted voice agent (Retell on LiveKit) with simple states: mic test, consent, reconnect, restart and rating.
- This is a useful minimal reference for the voice and video interview UX and its failure states. Jobright does **not** do video.

---

## 5. Career coaching

### 5.1 Orion: AI career copilot (free and unlimited)

**Marketing (confirmed: https://jobright.ai/orion-copilot).**
- 24/7 personalized guidance.
- Career path exploration, search tactics and industry trends.
- Resume fine-tuning.
- Company-specific interview insights.
- Explaining why a user fits a job.
- Trained on 10M job descriptions.
- CTA "Ask Orion for FREE".

**Panel anatomy (confirmed, B-orion, `pages/jobs/recommend` chunk).**
- **Shell.** A slide-in chat ("Orion chat", "Close Orion").
- **Input.** "Ask me anything...", with **voice input** (Start / Finish / Cancel voice input via `getUserMedia`), Send, and "Stop generating".
- **Welcome block "Tasks I can assist you with".**
  - Adjust current preference.
  - Top Match jobs (jobs where the user is a top candidate).
  - Ask Orion, which gets detailed insights on a specific job.
- **Job-detail chips.**
  - Job Highlights.
  - Resume Tips.
  - Insider Connections.
  - Top Candidates.
  - Tailored Resume.
  - Cover letter.
  - Plus prompts such as why this job is a good fit, how closely the user's skills match, and the company's stage.
- **Preference commands.**
  - **Simple intent commands.** For example: include part-time jobs, prefer remote, set location, find H1B-sponsoring jobs, show AI-sector jobs, set a minimum salary, require Python and SQL, set contract roles, search within 50 miles.
  - **Complex intent commands.** Several criteria in one sentence, for example a move from IC to manager with a salary floor and remote work.
  - **Sort commands.** Recommended / Most Recent / Top Match.
  - "View Current Preferences".
- **Rich cards in chat.**
  - Contact cards (section 2.4).
  - Email lookup states.
  - Resume and cover-letter generation with "Confirm" / "I Want to Tweak It" / Regenerate.
  - Preference-diff confirmations: added X to field, revised field from A to B, deleted X from field.
  - Job-list feedback: "How do you like your updated job list?" with Looks better / Not quite.
  - Message feedback, with an option to forward feedback to support.
- **Proactive nudges.**
  - "Not seeing the right jobs?", which asks Orion to adjust recommendations.
  - "Salary too low?" / "Tired of scam jobs?" prompt chips.
  - A reviewer found Orion re-opening on nearly every page change annoying (likely: Jobity).
- **Quality (likely).** It uses profile and application context, which makes it better than generic ChatGPT prompts (zplatform). One test found it compared resume and JD across Relevant Experience, Seniority, Education and Core Skills (FavTutor). Answers can be generic for niche roles.
- **Gating.** Orion chat is unlimited on Free and Turbo (likely: FavTutor table). Actions it triggers consume the matching credits: resume, cover letter and email.

### 5.2 Human coaching ("Coaching" top-nav, added 2026)

**Products (confirmed, B-coachland, B-coach, B-deepdive, B-orion; https://jobright.ai/coach-landing).**

1. **1:1 coaching.**
   - Live sessions with "Senior Recruiters" and "Technical Recruiters", sold as "1-on-1 Coaching With Senior Recruiters".
   - Lengths are **30 or 60 minutes**. A returning-member promo offers a 45-minute claim.
   - The 30-minute product is a live resume and career session. It includes a Google Docs copy of the user's resume for live editing.
2. **Deep Dive Series.**
   - Live **group** webinars on a topic, for example resume strategy, SWE interviews, AI and data careers, or sponsorship-aware search.
   - Limited seats, a waitlist, and email delivery of the webinar link.
3. **Turbo Office Hour.**
   - A weekly live group Q&A for Turbo members.
   - Benefits include session notes and resume and cover-letter templates.
   - Non-Turbo users are told to upgrade before joining.

**Landing stats (confirmed, coach-landing).**
- 5,000+ sessions completed.
- 4.8/5 average rating.
- 12+ years average coach experience.
- Steps: Choose Your Coach → Share Your Resume & Target Jobs → Meet With Your Coach → Start Getting Recruiter Replies.
- The FAQ says coaching cannot guarantee an offer.

**Booking flow (confirmed, B-orion booking strings, B-coach).**
1. **Diagnose.** "Identify Your Job-Search Blocker" → "Where do you need the most help?" The topic options are:
   - Trying to find a first job (needs a resume, LinkedIn profile and game plan).
   - Applying but hearing nothing (why no callbacks).
   - An upcoming interview (practice questions with a recruiter).
2. **Coach recommendation card.**
   - Avatar, seniority description and rating average (shown to 2 decimals).
   - "Meet My Coach" / "Watch Intro" video.
   - Session-length options (30 Mins / 60 Mins), "-min for $" pricing, "Book Now".
   - "Or Explore Other Options".
3. **Contact Info.** Name, email, phone and LinkedIn URL, with validation.
4. **Session Topics.** A required select.
5. **Resume.** Pick an existing resume ("Jobright Template" or "Original Version") or "Upload New Resume".
6. **Confirm.** "Confirm Your {n}-min Session with {Coach}" → "Continue to Booking". A Turbo benefit variant reads "Claim Your {n}-min session".
7. **Payment.** Stripe.
8. **Pending.** "We have received your booking request". The coach and time are confirmed afterwards, and email details follow.
9. **My Bookings.** Statuses Completed / In Progress / Seat confirmed / Up Next, plus "View Details", "Book Again", "Join the Session" and "Cancel".

**Policies (confirmed, B-coachpol and B-coach).**
- Sessions must be booked at least 2 days ahead so coaches can review the resume.
- To reschedule, cancel and rebook.
- Refunds:
  - Full refund for cancellations made 2 or more business days before the session.
  - 50% refund for cancellations made between 1 and 2 business days before.
  - No refund inside 1 business day or for a no-show.
- Joining late (within 10 minutes) still runs the remaining time. Not joining within 10 minutes counts as a no-show.
- Two or more missed sessions within 60 days can temporarily restrict booking.
- If a coach cancels, the user is offered a reschedule with an available coach or a full refund.
- Support: `coachsupport@jobright.ai`.
- Deep Dive tickets are non-refundable and cannot be rescheduled, except when the user is waitlisted and no seat opens, in which case the refund is automatic.

**Prices and gating.**

| Item | Price / access | Evidence |
|---|---|---|
| 1:1 sessions | $69.99–$79.99 per 30-minute session with named senior recruiters (checked 2026-08-31) | Jobity (likely) |
| Turbo coaching benefit | "Live Career Coach Consultation, Weekly personalize sessions" and "Exclusive Career Coaching: weekly expert-led sessions" | B-pricing, B-cancel (confirmed) |
| Free plan | No live coach | Secondary sources (likely) |

- The Turbo benefit most likely means weekly **group** Office Hours plus an occasional included or discounted 1:1 claim. Jobity could not reconcile "included" with the per-session prices (inferred).
- Upsells (confirmed, B-upsell):
  - "Live Coaching Masterclass".
  - "1 Group Session Free Pass".
  - "The Insider Upgrade" (front-of-the-line access).
  - "Exclusive Offer for Loyal Turbo Members", bundling 3 months of Turbo, priority support and a coaching session for a one-time fee.
  - A "Student Quarterly Plan".

**Gamified acquisition: "missions" (confirmed, B-orion).**
- Unsubscribed new users get a two-mission checklist with a progress percentage:
  - Customize Your Resume.
  - Enable Autofill Extension.
- Completing both grants **"a chance to win a 30-min 1v1 coaching session with a Senior Recruiter"**, and winners are emailed. Another variant awards a "1v1 Private Coaching session" outright.
- A "Use My Free Pass (1 Left)" variant exists for group sessions.

### 5.3 Diagnostic "coaching" reports (confirmed, B-orion, B-agent)

- **LinkedIn Profile Report.**
  - Reviews the user's LinkedIn profile against recruiter expectations.
  - Severity labels: Urgent, Critical, Optional, No issues, Not assessed.
  - Has an "Overall assessment" and a review rate limit.
  - The full report is Turbo-only ("Upgrade to Turbo to view your full report"). It is surfaced as "Optimize My Linkedin Profile".
- **Job Search Competitiveness Report.**
  - Generated in about 30–40 seconds.
  - Compares the user with other applicants for similar roles on education, experience and degree fit.
  - Shows a "Strength" and a "Level-Up" item, plus "You vs. Other Applicants".
- **Market Fit analysis.** Runs after a preference change. It suggests broader preferences that would unlock N more quality jobs.
- **Resume diagnostics.** A severity banner ("Your Resume Needs Attention"). This overlaps the resume angle.

### 5.4 Career-goal capture in onboarding (confirmed, B-goals and the mode-selection chunk)

- **Mode selection.** Orion introduces itself and asks whether the user is in a rush or open to opportunities with no rush.
- **Career goal.**
  - Grouped as Advance My Career / Shift My Career Path / Enjoy Better Work Style.
  - Options: senior role, manager role, higher compensation, new industry, new role, new skill, work-life balance, job security, flexibility.
  - The step can be skipped.
- **Use.** These answers feed Orion's personalization (confirmed: the `/orion-copilot` FAQ mentions onboarding answers).
- **No long-term path tool.** No dedicated "career path explorer" product exists beyond Orion chat.

---

## 6. Salary insights and negotiation

**Found (confirmed, B-orion, `pages/jobs/info/[id]` chunk, B-status).**
- A salary range or minimum annual salary in preferences and filters. "Any salary" is the default. Salary can be set via Orion commands.
- Job cards and detail show salary when posted, plus a "Comp. & Benefits" company tag.
- An H1B block on job and company pages: company H1B sponsorship track record, an "Annual Salary / H1B Sponsorship" section, and "Median annual salary offered". These come from public DOL LCA data, per the "US Department of Labor" string.
- Company stage tags: Early / Growth / Late Stage, Public, Unicorn with valuation, "Recently raised".
- "Founding Team" / "Leadership Team" lists on company detail, which are useful for networking.
- An Orion prompt chip "Salary too low?" that tunes salary preferences.

**Not found anywhere.**
- No salary-benchmark tool for a role and city.
- No offer comparison and no negotiation assistant or script generator. A competitor states the same (likely: https://www.orbytjobs.ai/orbyt-jobs/compare/orbyt-jobs-vs-jobright).
- Negotiation help is only possible ad hoc through Orion chat or a human coach (inferred).
- The tracker has no salary or offer fields.

---

## 7. Notifications, reminders and emails

**Instant Job Alerts (email) (confirmed, B-settings).**
- Email notifications on fresh tailored jobs, sent within the first hour after posting.
- Frequency: up to 1, 2 or 5 alerts a day, or Unlimited.
- The settings copy says Free members get up to 1 alert a day and Turbo members up to unlimited.
- The pricing modal frames this as "Instant Job Alerts: Always be the first to apply" (Turbo).

**Saved filters.** Free has 1 saved filter and Turbo has unlimited ("Multiple Saved Filters"). Alerts are tied to saved search preferences. The user cannot delete the last filter (confirmed, B-orion and B-pricing).

**Unsubscribe page (confirmed, B-unsub).** Reasons:
- Recommendations don't match.
- Jobs not relevant.
- Too many emails.
- Already found a job.
- Other (free text).

**Daily recommendations.** Shown on the dashboard and by email (likely, remotejobassistant March 2026).

**Mobile push.** Instant job alerts through the iOS app (confirmed: https://apps.apple.com/app/id6738236788, v1.15.0 Jul 20 [2026]).

**Transactional emails (confirmed, bundle strings).**
- Coaching booking confirmation and details.
- Deep Dive webinar link and waitlist emails.
- Referral sign-up notification.
- Email, student and work-email verification links.
- Account deletion confirmation.
- Application updates ("check your email inbox for updates on your application").
- Interview invitations (also in the in-app Messages inbox).

**In-app.**
- Toasts.
- Orion proactive bubbles.
- The Agent "Application progress" widget.
- Countdown-timer offers: first-day offer, weekly trial, winback, Thanksgiving (confirmed, B-orion; `23996.345a00a73ddce197.js`, `65257.9fcf6770549b9289.js`).

**Reminders.** No follow-up or interview reminders were found for tracked applications. This is a gap RoboApply can beat (inferred).

---

## 8. Refer & Earn: user referral program (do not confuse with job referrals)

Confirmed in B-refer and B-referpol.

**Current rewards.**
- Each **Qualified Referral** gives the inviter **$3** of "Jobright Balance", credited to the Stripe customer balance. It cannot be withdrawn and is applied to the next Turbo payment automatically.
- The inviter is capped at **10 slots ($30)**.
- The invitee gets a one-time $3.

**Qualification.**
- The referral code is valid, and inviter and invitee are different accounts.
- The invitee has verified their email (SSO sign-ups count as verified) and completed onboarding.
- The referral has passed a risk review covering device, IP and payment method.

**Statuses.** Pending, Failed-Retrying, Pending Review. A progress meter (0–10) shows a "next goal" message.

**Earlier variants.**
- Inviting earned extra AI credits: Resume Analysis, Custom Resume Generation and Insider Connection Email.
- **"Post on LinkedIn"** with a prefilled testimonial post (hashtags #jobright #jobsearch) earned **5 days of Turbo** (one reward per user, activated within 48 hours).

**Share link.** Short links of the form `jobright.ai/s/{code}`, with share to LinkedIn.

---

## 9. Gating matrix (as of 2026-08/10)

| Capability | Free | Turbo | Separate purchase |
|---|---|---|---|
| Insider connection cards | Visible, partly locked or blurred | Full | – |
| Email lookup / "Connect Via Email" | 2 a day refilled ("Email Connection for Referral") | Unlimited ("Linkedin Email Finder") | – |
| LinkedIn note template, "Find More Connections" | Yes | Yes | – |
| Application tracker (Liked / Applied / External, 5 statuses) | Yes, no stated limit | Yes | – |
| External job import | Yes (rate-limited) | Yes | – |
| Agent Application Tracker | Limited / waitlist | Unlimited (Agent still waitlisted for many) | "skip queue" paid option reported |
| Orion AI chat | Unlimited | Unlimited | – |
| Interview Question Bank | Preview / limited | Included only on **Quarterly** (9k+ questions); otherwise passes | Company Pass $19.99 / 7 days; All-Access $39.99 / 30 days |
| Coding practice runner | With pass | With pass | – |
| AI Interviewer voice chat | Yes (sign-in required) | Yes | – |
| Human 1:1 coaching | Pay per session (missions raffle for new users) | "Live career coach consultation" benefit plus claims | About $69.99–$79.99 per 30 minutes (Jobity) |
| Deep Dive group sessions | Paid seats, waitlist | Free-pass promos | Paid |
| Turbo Office Hour (weekly) | No | Yes | – |
| LinkedIn Profile Report | Summary | Full report | – |
| Job alerts | 1 a day, 1 saved filter | Unlimited alerts and filters | – |

Other free daily refills (confirmed, B-pricing): AI Custom Resume Generation up to 2 a day, AI Resume Enhancement up to 1 a day, plus autofill and cover-letter credits.

**Turbo prices (likely).**
- $17.99 a week.
- $39.99 a month (raised from $29.99 in early 2026).
- $89.99 a quarter.
- A Student plan and a Student Quarterly plan exist (confirmed, B-pricing, B-upsell).
- No public pricing page.
- Sources: FavTutor, Jobity, OutApply, Wobo.

---

## 10. Copy tone and UX patterns

**Tone.**
- Upbeat, benefit-led, numbers everywhere: "4x", "3x", "2x", "71% land more interviews", "less than $1 a day".
- Emoji-prefixed status titles: 📧 Fetching Contact Info, ✅ Contact Info Found!, 😨 Contact Info Not Found, ⏰ Limited Seats.

**Orion's voice.** First person and helpful ("I'm working on…", "Done! I've updated…"). It confirms preference changes as diffs.

**Upsell density is high.**
- Countdown offers.
- Locked previews.
- Credit-exhaustion modals ("Out of credits", "Free Daily Refill… or Go Unlimited").
- A cancel-retention modal listing lost benefits.
- Reviewers complain about repeated subscription pop-ups (likely: Jobity, Trustpilot quote).

**Honesty disclaimers in product.**
- Email accuracy is not 100%.
- AI-inferred profile details are unverified.
- Coaching does not guarantee an offer.

---

## 11. Timeline and changes

| Date | Change |
|---|---|
| 2024 | Jobright 1.0 launches with Insider Connections, using LinkedIn hiring managers, schoolmates and ex-colleagues, plus templates. |
| June 2025 | Blog lists Insider Connections, Orion and premium "coaching" at $30 a month. |
| Mid-2025 | iOS app ships: tracker, connection hints, alerts. |
| Early 2026 | Turbo raised from $29.99 to $39.99 a month. Weekly and quarterly plans added. |
| 2026 | "Interview" question bank added with one-time passes. FavTutor counted 10,033 questions on 2026-08-21. |
| 2026 | "Coaching" tab added: 1:1 recruiter sessions, Deep Dive webinars and weekly Office Hours. Coach landing reports 5,000+ sessions. |
| Aug–Oct 2026 | Agent still waitlisted for many users. |
| Aug–Oct 2026 | Gmail connect for Agent verification codes. |
| Aug–Oct 2026 | AI Interviewer voice intake (Retell) tied to the employer marketplace. |
| Aug–Oct 2026 | Quarterly plan bundles interview-bank access. |
| Aug–Oct 2026 | Refer & Earn moved from credits to $3 Stripe balance (cap $30). |

---

## 12. Implications for RoboApply (inferred)

These are recommendations, not Jobright facts.

**Existing models.** RoboApply already has a richer tracker model than Jobright (`RATrackerEntry`, with 8 statuses, notes, follow-up date, salary, excitement and `appliedVia`) and video/voice mock interviews (`RAMockSession`, `SeekerMockInterview`, `InterviewSession`). Parity work should focus on the **networking layer**, the **"Did you apply?" capture**, the **question bank** and **coaching commerce**.

### 12.1 Insider Connections

**Seeker profile data.**
- Collect the user's LinkedIn URL in onboarding (international) and resolve past companies and schools to normalized IDs from the parsed resume.
- For **GoApply.Top (mainland China)**, LinkedIn is unavailable. Use 脉脉 (Maimai) and school / ex-employer matching from the resume, plus a search hand-off (deep link) instead of a scraped index.
- Treat email finding as a PIPL-sensitive feature. Consider disabling it or making it opt-in for China.

**Connection buckets and UI.**
- Three buckets: default, previous company and school.
- Per contact: name, title, sub-line, avatar, and email and LinkedIn actions.
- A locked-preview upsell.
- When a bucket is empty, a "Find more" deep link to the network's search with company, past-company and school filters.

**Outreach.**
- Generate outreach with an **LLM**, not static templates. This is Jobright's weak spot.
- Keep a short connection-note variant within LinkedIn's note limit, an email variant with a subject, and a referral-ask variant.
- Store drafts and sent state per contact, linked to the tracker entry. Jobright stores none of this.

**Credits.** Email lookup credits: Free 2 a day, paid unlimited, consistent with the existing credit ledger.

### 12.2 Tracker

- **Return prompt.** Add Jobright's "Did you apply?" prompt (on tab refocus after an external apply click). It is the key low-friction capture.
- **Keep RoboApply's advantages.** Keep the kanban/list toggle, notes, follow-up reminders and interview dates. Add **reminder notifications**, which Jobright lacks.
- **Status tabs.** Status sub-tabs with counts, plus a search.

### 12.3 Interview

- **Company question bank.** Topic and seniority filters, step-by-step answer, "what the interviewer is testing", rubric and follow-ups, a coding runner, report-issue and contribute forms.
- **Monetization.** Mirror Jobright's pass model (7-day company / 30-day all-access) or include the bank in the paid tier.
- **Differentiation: real AI mock interviews.** RoboApply already has voice and video mock interviews with scoring, which Jobright does not offer.
- **Voice/video reliability (relates to the user's "video live interview issues" item).** Adopt Jobright's state machine:
  - Mic or camera test.
  - Device picker.
  - Permission-denied help.
  - Reconnecting / connection-lost.
  - Restart warning.
  - Leave-confirmation.
  - Consent checkbox.
  - Post-call rating.
  - An attempt rate limit.

### 12.4 Coaching

- **Two layers.** The AI coach (Orion-like chat with voice input, prompt chips and preference-diff confirmations) and human coaching commerce (diagnose-blocker topic, then coach recommendation, contact, resume, confirm, pay, then a pending booking, then My Bookings).
- **Policies.** A 2-business-day refund window, no-show rules and a waitlist for group sessions.
- **Localization.** Per brand: pricing in CNY via Alipay for GoApply and USD/TWD via Stripe for RoboHire. Taiwan belongs to the international market.

### 12.5 Salary and negotiation (open opportunity)

Jobright has no negotiation tool. RoboApply could add:
- Offer fields on the tracker entry.
- Market benchmarks (H1B LCA data for the US; other sources by region).
- An LLM negotiation-script and email generator.

### 12.6 Notifications

Ship job-alert frequency settings (1/2/5/unlimited, gated by plan), an unsubscribe-reason page, and **follow-up / interview reminders**, which Jobright lacks.

---

## 13. Open questions

1. **Connection data source.** It is unclear whether Jobright licenses a people-data provider (People Data Labs, Apollo, Proxycurl-like) or scrapes LinkedIn. Neither the bundles nor the pages say.
2. **Bucket sizes.** The exact number of contacts per bucket, and whether Turbo shows more than Free beyond un-blurring, is unknown.
3. **Turbo coaching scope.** Whether "Live Career Coach Consultation" covers one 1:1 per period, only group Office Hours, or discounted 1:1s is unresolved, and current 1:1 prices have no primary source.
4. **Pass prices and plan bundles.** Whether interview-pass prices (Company $19.99 / 7 days, All-Access $39.99 / 30 days) are still current, and whether monthly or weekly Turbo now includes question-bank access or only Quarterly does.
5. **Voice-chat routing.** Whether the AI Interviewer conversation is shared with employers as a screening transcript or score. The consent checkbox implies it is, but the employer page does not mention it.
6. **Email-based tracking.** Whether Jobright plans email-based auto status updates. Gmail scope is currently limited to verification codes.
7. **Public job page anatomy.** Logged-out job detail now sits behind a Cloudflare challenge, so the full logged-out anatomy could not be observed.

## 14. Sources (primary first)

**Jobright pages.**
- https://jobright.ai/
- https://jobright.ai/job-referral
- https://jobright.ai/tools/job-tracker
- https://jobright.ai/interview-landing
- https://jobright.ai/interview/1441?questionId=1249
- https://jobright.ai/orion-copilot
- https://jobright.ai/coach-landing
- https://jobright.ai/coaching
- https://jobright.ai/tnt
- https://jobright.ai/employers
- https://jobright.ai/sitemap.xml

**Jobright blog.**
- https://jobright.ai/blog/is-jobright-legit/ (2025-06-18)
- https://jobright.ai/blog/best-ai-interview-assistants-2026/ (2026-02-25)
- https://jobright.ai/blog/launching-jobright-1-0-revolutionizing-the-job-search-experience-with-ai/

**Bundles.**
- Route manifest: https://static.jobright.ai/_next/static/GQd0ykV_IrfhtmCjLOY2m/_buildManifest.js
- Chunk keys: see section 0.

**App store.** https://apps.apple.com/app/id6738236788

**Secondary reviews.**
- https://favtutor.com/jobright-ai-review/ (2026-08-21)
- https://jobity.io/blog/jobright-review (2026-09-01)
- https://outapply.com/blog/jobright-ai-pricing (2026-05-12)
- https://www.wobo.ai/blog/jobright-review/ (2026-07)
- https://www.remotejobassistant.com/blog/jobright-ai-review (2026-03)
- https://resumehog.com/blog/posts/jobright-ai-review-2026-is-this-job-search-copilot-worth-it.html (2026-03 / 10-03)
- https://hiringreach.com/reviews/jobright-ai-review
- https://zplatform.ai/ai-reviews/jobright-ai/
- https://scoutify.com/blog/jobright-review
- https://www.autoapplymax.com/compare/autoapplymax-vs-jobright (competitor; kanban claim contradicted)
- https://www.orbytjobs.ai/orbyt-jobs/compare/orbyt-jobs-vs-jobright (competitor)
- https://chromeboard.com/extension/jobright-autofill-%E2%80%93-insta-odcnpipkhjegpefkfplmedhmkmmhmoko (extension mirror)
