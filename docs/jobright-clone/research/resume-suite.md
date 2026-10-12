# Jobright.ai: resume and document suite (reverse-engineering notes)

Research date: 2026-10-09. Scope: everything about resumes and documents in Jobright. That covers the free public "tools" SEO pages, resume upload and parsing, the base-resume Resume Analysis report (score, grade, issue taxonomy, the Fix flow), the per-job match and ATS keyword gap, the job-tailored "Custom Resume" wizard and editor, templates and formatting, export, multiple resume versions, the cover letter generator, the LinkedIn Profile Report, related Orion/Agent/extension touchpoints, credits and gating, and complaints.

## How this was researched (method and confidence)

- **Primary sources (marked "confirmed"):**
  - Jobright's public marketing and tool pages, and their JSON-LD FAQ blocks.
  - The publicly served Next.js build manifest and static JS chunks on `static.jobright.ai`. These are public CDN assets. No login, account or form submission was used.
  - The Chrome Web Store listing and screenshots.
  - Jobright's own blog posts.
  - The UI strings in the shipped bundle (labels, tooltips, error messages, enums) are the strongest evidence of the logged-in experience.
  - Caveat: some bundle strings sit behind A/B flags (`abTestConfig`), so a given user may not see every variant.
- **Secondary sources (marked "likely" when 2+ agree):** hands-on reviews (Hirecarta, Wobo, ResumeHog, Scoutify, Techraisal, OutApply, ResumeJudge, Adzuna) and Trustpilot. Most are written by competitors, so treat their framing with care.
- **Marked "inferred":** my own reasoning from code structure or class names.
- **Copyright:** UI control labels are reproduced as short identifiers (in backticks) because they are functional names. Longer tooltip and marketing copy is paraphrased.

Key evidence URLs, cited below by short name:

| Short name | URL |
|---|---|
| MANIFEST | https://static.jobright.ai/_next/static/GQd0ykV_IrfhtmCjLOY2m/_buildManifest.js |
| C-RESUMEPAGE | https://static.jobright.ai/_next/static/chunks/pages/jobs/resume-c3ffaea4592389be.js |
| C-ANALYSIS-FIX | https://static.jobright.ai/_next/static/chunks/93312-7d140bd65b5b74ac.js |
| C-ANALYSIS-RUN | https://static.jobright.ai/_next/static/chunks/89347-4f9898448e21ea0b.js |
| C-ISSUES | https://static.jobright.ai/_next/static/chunks/80566-a968261ddaf1a887.js |
| C-TAILOR-EDITOR | https://static.jobright.ai/_next/static/chunks/26242-732e4aaff5deb295.js |
| C-TAILOR-COMPARE | https://static.jobright.ai/_next/static/chunks/40226-9139e60adf97d7d0.js |
| C-TAILOR-WIZARD | https://static.jobright.ai/_next/static/chunks/39128-8499616773d6f37f.js |
| C-TAILOR-RESULT | https://static.jobright.ai/_next/static/chunks/34296-212485a35c0df2a9.js |
| C-COVERLETTER | https://static.jobright.ai/_next/static/chunks/62332-85f3247d58c5597e.js |
| C-SHELL | https://static.jobright.ai/_next/static/chunks/10344-7630c6c855467801.js (app shell, Orion, LinkedIn report, offers) |
| C-ORION | https://static.jobright.ai/_next/static/chunks/97342-7f758d8ed7830b3e.js |
| C-TARGET | https://static.jobright.ai/_next/static/chunks/92086-5b3e3230c924d7b3.js |
| C-AGENT | https://static.jobright.ai/_next/static/chunks/pages/agent-70b6a9ee45390efe.js |
| C-APP | https://static.jobright.ai/_next/static/chunks/pages/_app-ff4b18b98295f6d5.js (enums) |
| C-PREFS | https://static.jobright.ai/_next/static/chunks/pages/candidate-preferences-cbe0f7daddfcedac.js |
| C-ONB-UPLOAD | https://static.jobright.ai/_next/static/chunks/pages/onboarding-v3/resume-upload-eb73c5762854e84f.js |
| C-PROFILE | https://static.jobright.ai/_next/static/chunks/pages/jobs/profile-eb8fb2767cddd292.js |
| C-SETTINGS | https://static.jobright.ai/_next/static/chunks/pages/settings-d1abc17acf0503a8.js |
| C-REFUND | https://static.jobright.ai/_next/static/chunks/pages/legal/refund-36fb1af56beb0e5c.js |
| C-JOBDETAIL | https://static.jobright.ai/_next/static/chunks/42214-1d004cc959ad987f.js |
| BLOG-ATS | https://jobright.ai/blog/ats-friendly-resumes-how-to-get-past-the-bots-with-ais-help/ (2025-08-15) |
| CWS | https://chromewebstore.google.com/detail/jobright-autofill-%E2%80%93-insta/odcnpipkhjegpefkfplmedhmkmmhmoko |
| HIRECARTA | https://hirecarta.com/blog/jobright-review |
| WOBO | https://www.wobo.ai/blog/jobright-review/ |
| RESUMEHOG | https://resumehog.com/blog/posts/jobright-ai-review-2026-is-this-job-search-copilot-worth-it.html |

---

## 1. Resume-related route map (confirmed: MANIFEST, robots.txt)

Logged-in app routes (Next.js pages router):

- `/jobs/resume`: the "My Resume" hub (resume list, analysis, editing). Page title is "My Resume | Jobright AI".
- `/jobs/resume/edit/[id]`: full editor for a given resume.
- `/jobs/recommend`: job feed. Hosts the job detail panel with the "Customize Your Resume", "Build Cover Letter" and "Analyze How Well You Fit" entry points.
- `/jobs/profile`: profile page (resume upload, LinkedIn URL).
- `/candidate-preferences`: preferences, with an optional resume upload.
- `/jobs/external`: imported external jobs ("Import job postings from other sources to customize your resume and receive job matching analysis").
- `/agent`: the auto-apply Agent (resume and cover letter automation settings).
- `/onboarding-v3/resume-upload`: onboarding resume or LinkedIn step.
- `/settings`: job alert frequency, account deletion.

Public SEO "tools" routes (all `/tools/*`, allowed in robots.txt):

- **Resume tools:** `resume-checker`, `check-your-resume-score`, `ats-score-checker`, `resume-job-matcher`, `resume-matcher`, `resume-tailor`, `resume-rewriter`, `resume-fixer`, `resume-helper`, `resume-maker`, `resume-parser`, `resume-summary-generator`, `resume-bullet-point-generator`, `resume-headline-generator`, `resume-grammar-checker`.
- **Other tools:** `cover-letter-generator`, `ai-job-assistant`, `job-tracker`, `job-clipper`, `job-alert`, `grad-jobs`.
- **Top-level landing pages:** `/ai-resume-builder`, `/ats-resume-builder`, `/ats-resume-checker`.

robots.txt disallows `/jobs/resume*` and the onboarding sub-steps from crawling. The tool pages are explicitly SEO surfaces (https://jobright.ai/robots.txt).

Note: there is **no** public LinkedIn optimizer page. `/tools/linkedin-profile-optimizer` returns 404. LinkedIn optimization exists only in-app, as the "LinkedIn Profile Report" (section 12).

---

## 2. Free public tools (the SEO funnel)

**Shared pattern (confirmed: every /tools page fetched 2026-10-09).** None of the public tools runs in the browser without an account. Every CTA links to `/onboarding-v3/signup`, so the tools are SEO landing pages that funnel into signup, onboarding and the in-app Resume AI. Each page shares one template:

1. **Hero:** "Free X" headline, sub-promise, primary CTA (most often `Improve My Resume for FREE`; variants include `Check My Resume for Free`, `See My Resume Match`, `Create My Cover Letter For FREE`, `Organize My Job Application`). Trust badges: Product Hunt Product of the Month, "featured by OpenAI" (the ChatGPT plugin store), Trustpilot.
2. **Stat strip:** "9.1/10 Quality Improvement Rating", "5 Hrs editing hours saved per job" (2 Hrs on the cover letter page, 20 mins on Job Clipper), "10 million jobs our AI is trained on".
3. **Three feature blocks with screenshots:**
   - "Build A New Resume In Fast Mode": the claim is a polished, ATS-compatible resume in under 3 minutes.
   - "Guided AI Refinement For Every Job": an instant report card, plus add/remove skill guidance per JD.
   - "Instant Job Matches Based On Your Resume".
4. **Job board stat:** "400,000+ Today's new jobs / 8,000,000+ Total jobs".
5. **Six-item "Why choose us" grid:** "Endorsed by HR Professionals", "We Protect Your Data", "ATS Friendly", "Resumes Match Industry Standards", "Better Response Rates", "Optimized Skills for Your Resume".
6. **Four testimonials** (first name, last initial, title).
7. **Four-step "how it works":** for most resume tools, upload the resume, get an instant analysis, get a new AI-refined resume, download it.
8. **Three-question FAQ (accordion).** The answers live in the JS bundle, not the HTML.
9. **Footer "Related Tools":** AI Job Assistant, AI Cover Letter Generator, AI Resume Helper, AI Job Tracker, AI Fraud Detection.

**Per-tool specifics (confirmed: the page URLs below, plus FAQ answers extracted from each page's JS chunk):**

| Tool URL | Positioning | Notable FAQ / claims (paraphrased) |
|---|---|---|
| https://jobright.ai/ai-resume-builder | "AI Resume Builder / AI Resume Editor". Fast Mode, guided refinement with "AI graph technology" | AI editor saves about 2 hrs per application; claims it beats ChatGPT on being concise. Includes a match score to the job and an instant "report card" on keywords |
| https://jobright.ai/ats-resume-checker | Newest and most "honest" copy. Finds missing ATS keywords and experience gaps before you apply | No universal ATS score exists. Jobright's score compares the resume to one specific JD. Add keywords only when truthful. Free ATS-friendly templates are offered. Steps: upload resume plus target job, run the ATS test, review keyword/skills/experience gaps, then improve |
| https://jobright.ai/tools/resume-job-matcher (also `/tools/resume-matcher`) | "Match your resume to a job description". Lists six report factors: Overall Resume Match, Experience and Seniority, Skills Alignment, Industry Experience, Job Keyword Gaps, Why the Job Fits | Compares skills, experience, industry background and ATS keywords. A high score is guidance, not a guarantee. Says the AI does not invent experience. A "resume match" covers one JD, while an "ATS check" also covers file and format readability. Has a "More Tools" cross-link grid: ATS Resume Checker, Resume Checker, Resume Rewriter, Resume Tailor, Resume Summary Generator, Resume Bullet Point Generator |
| https://jobright.ai/tools/resume-checker, `/tools/check-your-resume-score`, `/tools/ats-score-checker` | Instant score plus suggestions | The basic check is free and premium adds deeper analysis. Feedback covers formatting, content and keyword optimization, adapting to industry and target JDs |
| https://jobright.ai/tools/resume-tailor | Tailor to a JD | You can tailor one base resume many times through "guided AI refinement" |
| https://jobright.ai/tools/resume-rewriter | Rewrite with AI | The rewritten resume stays fully editable |
| https://jobright.ai/tools/resume-fixer | Fix issues | Says it keeps your unique experience, so the result is not generic |
| https://jobright.ai/tools/resume-helper, `/tools/resume-maker` | Fast Mode builder | About 3 minutes. Free with basic features; premium plans unlock AI-driven optimization and job matching (resume-maker FAQ) |
| https://jobright.ai/tools/resume-parser | Parser | Recommends that users review the parsed data |
| https://jobright.ai/tools/resume-summary-generator | "Resume profile generator" | Recommends updating the summary per application |
| https://jobright.ai/tools/resume-bullet-point-generator | Bullet generator | Aim for 3 to 5 bullets per role; bullets are editable |
| https://jobright.ai/tools/resume-headline-generator | Headline generator | Recommends skill keywords for the headline; suitable for all levels |
| https://jobright.ai/tools/resume-grammar-checker | Grammar and style | Also checks ATS formatting and industry terminology |
| https://jobright.ai/tools/cover-letter-generator | Cover letter "via interactive chat" | Steps: upload resume, see job recs, pick a job, click "Write a cover letter for this job" in Orion's chat, refine with Orion. Editing happens in the chat interface |

**Inference:** all "generator" tools map to just three in-app capabilities: (a) the Resume Analysis fix flow, (b) the Custom Resume tailor, and (c) Orion chat. The separate SEO pages target long-tail keywords. Confidence: inferred, strongly supported by the identical page templates and identical CTAs.

**Copy tone:** bold promises such as "Land More offers", stat-heavy, uppercase hero words, free-everything framing. The newest pages (ats-resume-checker, resume-job-matcher, both 2026) shift toward compliance and honesty ("no universal ATS score", "only add truthful keywords"). Confirmed. **Change over time:** older tool pages still claim free everything, and the Orion FAQ even says everything on Jobright is currently free. Newer pages and FAQs mention premium features. Confirmed by https://jobright.ai/orion-copilot vs https://jobright.ai/tools/resume-maker.

---

## 3. Resume intake: upload, parse, profile

- **Accepted file types:** `.pdf, .doc, .docx`. The preferences page states PDF, DOC or DOCX up to 10MB. The onboarding upload widget displays a "PDF" badge. Confirmed: C-PREFS and the accept constant in the app bundle.
- **Onboarding step `/onboarding-v3/resume-upload`:**
  - The user either uploads a resume or enters a LinkedIn URL ("level up your search").
  - `Skip` and `Next` are available.
  - The privacy note says the resume or LinkedIn data is used only for job matching and never shared with third parties.
  - Errors: invalid or unfound LinkedIn URL, "Please upload your resume to proceed", upload failure, and a file name that is too long.
  - Confirmed: C-ONB-UPLOAD.
- **Profile page `/jobs/profile`:**
  - Shows "Upload Your Resume". The tip says the resume improves matching and resume writing services.
  - Shows "Update Your Linkedin URL", used to find alumni or colleagues for referrals.
  - Heading: "Complete Your Profile for Perfect Matches & AutoFill".
  - Confirmed: C-PROFILE.
- **Parsing into structured sections:**
  - The parsed resume becomes structured data: personalInfo, summary, education, workExperience, skills, projects, certifications, achievements, languages, publications, extracurricularExperience, reference and customSections. These are the same enums the editor uses (confirmed: C-APP enum dump, C-ISSUES field map).
  - Parse-quality feedback options include "Some resume sections were missing after parsing" (confirmed: C-ANALYSIS-FIX).
- **Profile sync:**
  - `Update profile from resume` / `Update to Profile` pushes resume data into the profile that feeds Autofill.
  - Error strings mention "sync profile sections to autofill".
  - Confirmed: C-RESUMEPAGE.

---

## 4. "My Resume" hub (`/jobs/resume`), multi-resume management

Confirmed: C-RESUMEPAGE unless noted.

- **Slots:** up to **5 resumes**. A counter shows how many of the 5 slots are used. Explainer: multiple resume management lets you keep resumes for different job titles and pick the matching one when tailoring.
- **Primary resume:** one resume is the **Primary Resume**, the default for matching, Agent and Autofill.
  - You cannot delete the primary resume until you `Add Resume` or set another as primary.
  - An `Unable to Set as Primary Resume` error exists.
- **Add Resume:** blocked while an upload is still processing ("You can create a new resume once the current upload is complete"), and blocked at 5 resumes ("delete one before adding").
- **Per-resume actions:** `Edit Resume Info`, `Update to Profile`, `Export`, `Delete`.
  - A resume that is still processing shows "not ready to edit yet".
  - States: `Analysis Complete`, `Analysis Failed`, "Preparing your resume analysis...".
- **Mobile restriction:** on mobile, Resume Analysis and Custom Resume Generation are blocked. The user sees "Visit us on PC to view full analysis" / "Visit Jobright on PC" / "Visit PC and Enjoy". An upsell list shows four benefits: Gain In-Depth Resume Analysis, Generate Custom Resume For Each Job, Autofill Job Applications With 1-Click, Chat With AI Copilot For 24/7 Support (plus "Build Verified ATS-Compatible Resume").
- **Target job title:** the analysis is anchored to a "Target Job Title". There is an 18-category picker with emoji labels: Software Engineering, Engineering and Development, Data Analyst, Business Analyst, Accounting and Finance, Machine Learning and AI, Consulting, Project Manager, Product Management, Arts and Entertainment, Legal and Compliance, Education and Training, Creatives and Design, Customer Service and Support, Human Resources, Public Sector and Government, Management and Executive, Data Engineer. Further enum codes add sales and marketing (`mk`, `sales`). Confirmed: C-TARGET.
- **Versions:** tailored resumes are saved per job ("View Your Tailored Resume" with "Last updated MMM DD, YYYY"), separate from the five base-resume slots. Confirmed: C-TAILOR-RESULT. Inferred: tailored versions hang off the job and application record, not the five-slot list.
- When booking coaching, the resume picker labels show `Primary`, `Jobright Template` (the Jobright-formatted version) and `Original Version` (the uploaded file). Confirmed: https://static.jobright.ai/_next/static/chunks/44444-29fb4701c9bbbe29.js.

---

## 5. Resume Analysis (base-resume report card)

This is the "AI Resume Checker" or "report card" that the marketing pages promise.

### 5.1 Flow (sequence of screens)

1. **Entry.** Jobright's how-to says to open the Resume section of the dashboard, then open the uploaded resume, which shows the analysis (confirmed: BLOG-ATS, 2025-08-15). That guide names the CTA `Begin Improvements Now`. That exact string is not in the current bundle, so the CTA label has probably changed.
2. **Pre-flight completeness check, "Missing Information".**
   - Before the analysis runs, a modal asks the user to confirm that the Job Title and the Work Experience or Education are present.
   - Buttons: `Back to Resume`, proceed.
   - A "Ready for Analyze" state follows, with three bullets: insights into impact, brevity and structure; areas to improve across achievements, effectiveness and formatting; why each fix matters, with AI-generated improvements.
   - Confirmed: C-ANALYSIS-RUN.
3. **Credit charge.**
   - Each analysis run consumes **1 credit**. The toast reads "1 credit consumed. Earn more credits with Referral."
   - A separate pool is called "base resume credits". The error code is `out of base resume credits`.
   - Confirmed: C-ANALYSIS-RUN, C-ISSUES.
4. **Running.**
   - A progress card shows with `Cancel Analysis`.
   - Cancelling refunds any reserved credit. Messages: "Analysis canceled / Cancellation requested. Any reserved credit will be returned".
   - Failure: "Analysis Not Completed" with `Run Again` / `Yes, Run Again`.
5. **Report (drawer layout).** Inferred from CSS class names, which are confirmed in C-TARGET.
   - The drawer has a header, a feedback button and a workspace.
   - A left sidebar has tabs.
   - The summary card shows the score row, a rank badge (letter grade), the score text, an `analyze` button and the target job.
   - The summary text can collapse to a link to the full report.
   - An issues card shows severity totals.
   - Issues are grouped into collapsible sections, one per resume section, with issue rows.
   - A fix panel sits on the right.
   - A product tour runs over it: `Check Your Issues`, with labels like "(1 Critical, 1 Optional)", `NEXT`, `END TOUR`, then a pitch to find matching jobs and tailor a resume per job.
6. **Fix loop.** Click an issue, then `FIX`, then the fix panel opens (section 5.4).
   - After the user edits, the panel shows "Nice work! Content updated, issues cleared!" and `Submit New Version`.
   - Then `Progress & Re-analyze`.
7. **Re-analysis comparison.** The screen shows `Last Analysis` vs `Current Analysis`, with a delta tag of `Same` / `Increase` / `Decrease` and a matching message:
   - Score up: "You're one step closer..."
   - Same: an encouraging fine-tune message.
   - Score dropped: a refine-and-retry message.

   When every issue is resolved, it shows "Well done! You've successfully resolved all issues". Confirmed: C-ANALYSIS-RUN.
8. **Export.** `Export to ATS-friendly PDF` (confirmed: C-ANALYSIS-FIX). BLOG-ATS says the `Export` button sits in the top-right corner.

### 5.2 Score and grade (confirmed: C-ISSUES)

The four-tier letter grade, with a badge image and tooltip:

| Grade | Label | Meaning (paraphrased) |
|---|---|---|
| A | `EXCELLENT` | Top-notch; stands out against most applicants |
| B | `GOOD` | Strong; fine-tune the suggested details |
| C | `SATISFACTORY` | On the right track; refine and add detail |
| D | `IMPROVABLE` | Needs substantial work; fix the highlighted issues |

The banner "Your Resume Needs Attention" appears on the job feed and the resume page when the analysis flags issues (C-TARGET, `/jobs/recommend` chunk).

### 5.3 Severity levels and issue taxonomy (confirmed: C-ISSUES, C-ANALYSIS-FIX, C-APP)

There are three severities, each with its own color: **Urgent, Critical, Optional**. BLOG-ATS confirms the labels.

Each issue type ships with a short "report text" plus a "why it matters" tooltip. Paraphrased:

| Group | Issue key | What it detects (paraphrased) |
|---|---|---|
| ATS format | use of graphics/icons | Graphics or icons that ATS may misread |
| ATS format | use of tables | Tables that ATS may scramble |
| ATS format | use of multi-column layout | Columns read out of order; recommends single column |
| Completeness | missing personal info | Phone or email missing |
| Completeness | missing key sections | Personal Info, Work Experience, Skills or Education missing |
| Completeness | missing experience info / MISSING_FIELD | Job title or company (or school) missing on an entry |
| Content / impact | lack of action verbs | Passive or "responsible for" verbs |
| Content / impact | lack of accomplishment | No quantified results or milestones (**the quantification check**) |
| Content / impact | lack of methodology explanation | Does not explain *how* the work was done |
| Content / impact | IRRELEVANT_EXPERIENCE_TITLE | Experience titles not relevant to the target (enum only) |
| Language | incorrect spelling/grammar | Typos and grammar |
| Language | use of buzzwords | Clichés |
| Language | use of filler words | Filler words and adverbs |
| Brevity | bullet point too short | Not enough context |
| Brevity | bullet point too long | Recommends 10 to 30 words per bullet |
| Summary | missing summary | No summary; recommends 2 to 3 sentences |
| Summary | ineffective summary / SUMMARY_NEEDS_IMPROVEMENT | Should cover Job Title, Experience Level, Skills Highlight and Achievements |
| Skills | insufficient skills / INSUFFICIENT_RELEVANT_SKILLS | Fewer than 10 skills; shows `Recommended Skills` |

In addition, the analysis flags ATS-misread fonts. The tooltip advises standard fonts such as Arial, Times or Calibri.

### 5.4 Fix panel anatomy (confirmed: C-ANALYSIS-FIX)

For a selected issue, the panel shows:

- **Issue Detected:** the offending text is highlighted on the rendered PDF preview, with annotation frames.
- **Why This Is Important** and **How to Improve**.
- **Examples** with a `Before` / `After` pair. Example (paraphrased): a wordy bullet becomes a tight bullet with a number in it.
- **Scenario**.
- **Verb Choices:** suggested action verbs.
- **AI assist:**
  - `View AI-generated Version from orion`, `Write Your New Version`, `Write with AI`, "Orion writing in progress...".
  - Refinement buttons: `Write longer`, `Write shorter`, `Make this even stronger`.
  - Accept with `Use This Version`.
  - Free-text input: "Type what you want to improve...".
- **Per-suggestion feedback:** "Was This Suggestion Helpful?" with `Looks Great!` / `Not What I Expected`.
- **A general feedback drawer** with checkboxes. Options include:
  - AI-generated content is poor or too robotic.
  - The Resume Analysis Report is not actionable.
  - Some resume sections were missing after parsing.
  - Export problems.
  - "Need more resume templates".
- Rate-limit message: "You're moving a bit fast!"

---

## 6. Per-job Match Score and ATS keyword gap

### 6.1 Job Match Score (job cards and job detail)

Confirmed: CWS screenshots, landing images, and the FAQ in https://static.jobright.ai/_next/static/chunks/85987-6802cb7f52833360.js.

- An **overall %** ring sits on each job card. The tier label reads, for example, "STRONG MATCH".
- Three sub-scores: **Exp. Level**, **Skill**, **Industry Exp.**, each a % ring.
- **"Why You Are A Good Fit" chips** with check or cross: Experience Level, Relevant Experience, Education, Core Skills.
- The FAQ says the factors are relevant experience, skills, seniority, industry and years of experience. The score is a decision aid, not a guarantee. Matching and the Match Score are free.
- In the job feed, Orion prompts "Do you have these skills?" and asks the user to click the skills they have. A "Skill added!" toast follows. This is skill confirmation that improves matching. Confirmed: `/jobs/recommend` chunk.
- Complaint (HIRECARTA, likely): the components are shown without explanation, and the extension overlay score can differ from the in-app score.

### 6.2 Resume-vs-JD "ATS match report" (the gap grid)

Confirmed: the landing screenshots `ats_landing/ats_1.png`, `resume_landing/resume_3.png`, `jobmatch_landing/jobmatch_4.png` on https://jobright.ai/ats-resume-checker and https://jobright.ai/ai-resume-builder.

- **Header:** a verdict sentence (e.g. a "Good Match, Almost There" style line) plus a semicircle gauge scored **out of 10** with a tier label (e.g. 8.0 `FAIR`, 9.0 `EXCELLENT`).
- **A three-column grid:** `Overview` | target job (company logo, company, title) | `Your Resume` (file name, e.g. MyResume.docx).
- **Rows**, each with a check, cross or warning badge, showing JD requirement vs resume value side by side:
  - Job Title.
  - Years Of Experience (e.g. "7 Years+" vs "7 Years+").
  - Education.
  - ATS Job Keywords (n/m).
  - Hard Skills (n/m).
  - Industry Experience.
  - Summary or Qualifications.
- **Keyword chips:** chips with a thumbs-up icon are keywords already on the resume. Plain chips are missing keywords to add.
- Score tier enum in code: Excellent / Good / Fair / Poor (C-APP). HIRECARTA observed "5.5 Poor".
- The score tooltip says it measures how well the resume represents the candidate's qualifications for this specific JD (C-TAILOR-EDITOR).

### 6.3 Job Search Competitiveness Report (Agent, confirmed: C-AGENT)

- Generation takes about 30 to 40 seconds.
- Sections:
  - **"Where You Stand at a Glance"**: the share of peers the user outperforms for similar roles. Plus a Strength and a "Level-Up" (weakness) callout.
  - **"You vs. Other Applicants"**: Education, Experience Level (years vs the applicant pool) and Skills (how many of the peer skills the user has). A bar chart shows the % of competing applicants who have each skill.
  - **Market demand:** education and experience requirements across the market, plus a skill-demand bar chart (the % of jobs requesting each skill).
- This is skills-extraction analytics used for positioning.

---

## 7. Job-tailored "Custom Resume" (the core tailoring flow)

### 7.1 Entry points (confirmed unless noted)

- **Job detail panel:** a numbered action list starting with `1. Customize Your Resume`, plus `Analyze How Well You Fit` and `Build Cover Letter` (C-SHELL, C-TAILOR-RESULT). Adzuna's review lists the same three actions (likely).
- **Apply interception popup:** before applying, a popup offers `fix my resume now` or `apply without customizing for this role`. There is also `Proceed without Custom Resume`, and the preference to stop showing the popup is persisted (C-TAILOR-WIZARD, C-JOBDETAIL).
- **Orion copilot quick action:** "Generate custom resume tailored to this job". Orion's flow: `Generate Custom Resume`, then `Confirm Custom Resume`, then `I Want to Tweak It`, then `Download` (C-ORION, C-SHELL). A contextual nudge also suggests asking Orion to customize the resume for the current job.
- **Chrome extension:** the extension advertises tailoring a resume per job in under a minute and autofilling with that tailored version (CWS; https://jobright.ai/job-autofill).
- **Agent:** the toggle `Customize my Resume for Each Application` makes the Agent add keywords and highlight relevant experience per job. In semi-auto mode, the Agent pauses for confirmation at resume creation (`Confirm Custom Resume`, "1 resume credit will be used.") (C-AGENT).
- **External jobs:** imported postings can be tailored too (C-SHELL).

### 7.2 Tailor wizard screens (confirmed: C-TAILOR-WIZARD)

Screen layout: two cards side by side (`data-tut="tailor-step2"` suggests a guided tour). An earlier step selects the resume and job (inferred). The footer CTA is `Generate My New Resume`, with a return/back control.

1. **"1. Choose sections to enhance"**: checkboxes, each with an info tooltip. A section only appears if the backend's `suggestedSectionForTailor` includes it.
   - **Summary:** refine it toward the target job.
   - **Skills:** pre-selected and **locked**, because skills are essential for ATS keyword screening. Skills are updated from the keyword selection.
   - **Work Experience:** weave the selected skills into the bullets. A sub-choice offers `Quick Edit (First 2 key experiences)` or `Full Edit (All experiences with longer processing time)`.
   - **Projects:** strengthen the technical achievements and impact.
2. **"2. Add custom prompt (optional)"** (A/B flag `tailor_resume_custom_prompt`): a collapsible textarea with the placeholder "Add additional instructions to let AI generate you resume". The limit is 1,000 characters, and the CTA is disabled over the limit. The prompt is persisted per user (`custom_prompt`).
3. **"2. or 3. Add missing ATS job keywords (n/m)"**:
   - Skill chips are grouped by category, with a skeleton loader while keywords are classified.
   - `Select all` / `Unselect all`.
   - An `Add Keywords` input: press Enter to add, and a duplicate shows an error.
   - Empty state: the resume already includes all required skills.
   - A/B flag `tailor_multi_skill_selection`.
   - The wizard also passes `keyRequirements` with a `selected` flag, which is likely a list of key JD requirements the user can toggle (inferred).
4. **Credit gate:**
   - Each run costs 1 resume (TAILOR) credit.
   - When credits are gone, the user sees "You've used up your Custom Resume credits..." and a refill options modal.
   - The modal offers `Go Unlimited` (upgrade to Jobright Turbo) or `Free Daily Refill` ("come back tomorrow; your resume credit will be refilled up to N").
   - Confirmed: C-AGENT.
5. **Generation:**
   - "Making your resume a stronger fit for this job...", then "Finalizing your new resume...". It usually takes about 10 to 20 seconds.
   - When a slower model is used: "Using advanced AI model now, this may take longer than usual."
   - The launch press release claimed 10 seconds (https://jobright.ai/blog/launching-jobright-1-0-revolutionizing-the-job-search-experience-with-ai/, Sep 2024).

### 7.3 Tailored result screen

Confirmed: C-TAILOR-EDITOR, C-TAILOR-COMPARE, C-TAILOR-RESULT, landing images.

**Score and change summary**

- The score is shown before and after. In marketing images the gauge goes to 9.0 `EXCELLENT`, and HIRECARTA observed 5.5 rising to 9.0. The score is sent as `diagnoseScore` in the request.
- **Change summary cards** (collapsible), one per enhanced section:
  - `Summary Enhanced`: a new summary aligned to the JD.
  - `Missing Skills Added`: the skills the user selected were added to Skills.
  - `Relevant Skills Highlighted`: matching skills were added and highlighted in the bullets.
  - `Recent Work Experience Enhanced`: the two most recent roles were rewritten. In Full Edit mode, all roles are.
- **Inline diff highlighting:** changed spans are highlighted in green and underlined in the rendered resume (landing screenshots). `See What's Changed`.

**Compare and restore**

- `Compare to original` toggles `Your original version` against `Tailored version`.
- `Use Tailored Version` / `Restore tailored version` / revert ("Reverted to previous version").

**`Verify Details`: the truthfulness check (keyword verification)**

- For each AI-inserted keyword or claim, a question card asks whether the user really has it.
- Answers: `Yes, Keep it` / `No, remove it` / `I used something similar`.
- The third answer pre-fills the AI chat with "Here is what I actually did with ...:" so the user can describe the real experience.
- This is Jobright's mitigation for the fabrication complaints (section 13).

**`AI Rewrite` chat panel**

- Next to the resume, with placeholder "Tell me how you'd like to tweak your resume...".
- It remembers chats and preferences ("AI Rewrite remembers your chats and preferences").
- Quick-reply pills: "Use stronger action verbs for my latest experience", "Shorten my summary to remove filler words", "Remove skills not related to this job".
- Voice input supports a hold-to-talk shortcut and is transcribed server-side.
- Selecting a resume element attaches it to the chat as a "capsule" for scoped edits.
- `Regenerate` returns "N new versions, pick one you like". The user picks one, then `Update`.
- `Edit With AI` and a per-field "Make it stronger" regenerate.
- Each message gets feedback, and the user can stop generation.

**Other result-screen controls**

- `Edit on resume`: direct inline editing (switches between viewer and edit mode).
- Style panel and `Fit to one page` (section 8).
- **Export:** `Download New Resume`, `Download by PDF`, `Download by Word(.docx)`. File name presets: `Name + Job title + Date` (default), `Name + Job title`, `Name + Target company`, `Name only`. A `Resume Name` field lets the user rename it.
- **Next steps:** `Apply Now`, `Continue to Autofill`, `View Your Tailored Resume`, `Regenerate`.
- Error states: "We couldn't save your tailored resume", "Generation failed", "Change failed", session timed out, and rate-limited.

### 7.4 Summary of the tailoring pipeline (for our clone)

`Pick job → (auto) keyword extraction and classification from the JD → gap = JD keywords minus resume keywords → user selects sections + keywords (+ optional prompt) → LLM rewrite (summary, skills, bullets for the first two or all roles, projects) → diff + score delta → keyword truth-verification → chat refinement → style/fit → export PDF/DOCX → apply/autofill with that version → version saved against the job`. Confidence: confirmed for the steps above; the server internals are inferred.

---

## 8. Resume editor and formatting (base resume and tailored resume share it)

Confirmed: C-TAILOR-EDITOR, C-TAILOR-COMPARE, C-ANALYSIS-RUN, C-APP.

### 8.1 Content sections and fields

- **Personal info:** Full Name, Subtitle (e.g. a target title), Email, Phone, Location, LinkedIn, GitHub, Website.
- **Summary.**
- **Skills:**
  - Skill groups: "New Skill Group", with tags you add by pressing Enter. "Delete this skill group?".
  - Skills layout options: `inline`, `grouped`, `column`. Column mode has a `Number Of Columns` setting.
- **Work Experience:**
  - Fields: Company Name, Job Title, Location, Start Date, End Date (or "Present"), a summary, and Bullet Points (placeholder "Bullet points...").
  - Merge rule: several roles at the same company merge into one section on export or apply.
- **Education:** School Name, degree ("accreditation"), location, GPA, dates, Coursework, Achievements and descriptions. `Show Education By`: degree-first or institution-first.
- **Projects:** Project Name, Organization, Location, dates, Link URL and Link Text. A reminder asks for full URLs so the links are clickable.
- **Certifications, Achievements, Languages** (with level), **Publications** (Authors, link), **Extracurricular Experience**, **Reference**.
- **Custom Section:** a section name plus `Add Text Item` or `Add Structured Item` (fields: name, title, organization, location, dates, link, summary, bullets). Tags.
- **Layout editing:** `Edit Resume Layout`, `Add New Section`, drag to reorder (personal info stays pinned at the top), rename section, and delete section with a confirmation for each section type.

### 8.2 Templates (5)

All five are named in the C-APP enum. Preview images live at `https://static.jobright.ai/_next/static/media/{name}.png`. The style panel marks one template as `Recommended`.

| Template | Tooltip (paraphrased) | Visual (from preview image) |
|---|---|---|
| Standard | Popular and ATS-friendly | Single column, left-aligned header |
| Compact | Ideal for one-page resumes | Tighter spacing |
| Centered | Centered header with an accent divider | Centered name and contact |
| Structured | Section name on the left, content on the right | Right-aligned name; left label column |
| Split | Two-column layout | Main column (Summary, Work Experience) plus a right sidebar (Skills, Education) |

Note: Split is two-column even though the analyzer flags multi-column resumes as an ATS risk. That is a small internal contradiction.

### 8.3 Style controls (the "Content Style", "Font" and "Spacing & Margin" panels)

- **Font Family:** Helvetica, Arial, Times New Roman, Roboto, Georgia, Open Sans, Carlito (Calibri-like), Garamond (EB Garamond), Work Sans, Poppins, Inter. Older reviews (HIRECARTA, early 2026) saw only Helvetica, Times New Roman and Arial, so the font list has grown (change over time; likely).
- **Font sizes:** separate selects for Name, Section Headers, Sub-Headers and Body Text.
- **Page size:** Letter (8.5 x 11 in) or A4 (8.27 x 11.69 in).
- **Spacing sliders:**

  | Control | Range |
  |---|---|
  | Section Spacing | 0 to 10 pt |
  | Entry Spacing | 0 to 10 pt |
  | Line Spacing | 10 to 15 pt |
  | Top & Bottom Margin | 10 to 50 pt |
  | Side Margins | 30 to 50 pt |

- **`Align Text Left & Right`:** a justify toggle.
- **`Header Alignment`:** Left, Center or Right.
- **`Accent Color`:** a swatch row. It applies to `All Headings`, `Section name` or `Name`. Default is black. HIRECARTA said color could not be changed in early 2026, so color is a newer addition (change over time; likely).
- **`Bullet Icon`:** solid, hollow or dash.
- **`Hide Divider`:** a toggle.
- **`Date Format`:**
  - Short month name (Jan YYYY).
  - Long month name (January YYYY).
  - Year only (YYYY).
  - Numeric (MM/YYYY).
- **`Quick Formats`** presets, plus `Reset formatting`.
- **`Fit Resume to One Page` / `Fit to one page`:**
  - It adjusts spacing, fonts and margins without changing the content. The button shows "Fitting resume to one page..." while it runs, and an undo reverts to the previous style.
  - If the content is too long, the user must cut it manually. If it is too short to fill a page, the user must add content.
  - The toggle `Auto Fit After Custom Resume` auto-fits every tailored output.
  - HIRECARTA also confirms the one-page fit.
- The style scene is tracked as `base` vs `tailor`, so formatting can differ between the base resume and each tailored copy (inferred from the event payloads).
- A rich-text editor (ProseMirror/tiptap with markdown support) is used for bullets (inferred from the vendored editor code in https://static.jobright.ai/_next/static/chunks/15600-b57563ee265fe4a9.js).

### 8.4 Export

- **PDF:** generated in the browser. A pdfkit-like library is bundled ("Create PDF files on the browser and server"), and the preview renders through pdf.js with a page counter and a retry on render error. Inferred from the vendored code. **Word (.docx)** export is also offered. Word files cannot be previewed in-app, but the system can still use them.
- An export modal shows "Exporting your resume to PDF/Word" with a spinner.
- The analysis page labels its export "ATS-friendly PDF".
- For the Agent, users choose whether to apply with the **original uploaded file** or a **Jobright-formatted version** (C-AGENT).

---

## 9. Cover letter generator

Confirmed unless noted.

- **Entry points:**
  - Job detail `Build Cover Letter` / "Generate Your Cover Letter", with the hook "Make your application stand out" (C-TAILOR-RESULT, C-SHELL).
  - Orion quick action "Write a cover letter for this job". Orion's flow: `Generate Cover Letter`, then `Confirm Cover Letter`, then download (C-ORION, C-SHELL).
  - The Agent toggle `Generate Cover Letter for Each Application`, which only generates for jobs that require one (C-AGENT).
  - The extension autofills a "Cover Letter" field (autofill landing screenshot).
- **Inputs:** the user's resume (primary, or the tailored one) plus the job description. There are **no tone or length presets in the UI**. After generation, the assistant invites the user to adjust tone, length or details in chat (C-COVERLETTER). The public page says the same: "customize the details through an interactive chat" (https://jobright.ai/tools/cover-letter-generator).
- **Generation:** "Generating Your Cover Letter...", about 10 to 20 seconds. Each generation consumes a credit ("1 credit consumed", C-TAILOR-RESULT).
- **Editor:**
  - Two tabs: `Editor` (direct text) and `AI Rewrite` (chat).
  - Chat placeholder: "Tell me how you'd like to tweak your cover letter...". Quick prompts: "Improve the opening paragraph", "Make this more tailored to the job".
  - Status messages: "Updating your cover letter...", then "Done! Cover letter updated."
  - Version restore: `Restore`, "Successfully reverted to previous version".
  - `Copy cover letter` copies to the clipboard.
  - An availability counter shows "N available today" or "Unlimited", based on plan.
- **Export:** `Download by PDF` / `Download by Word(.docx)`, `Regenerate`, `APPLY NOW` / `Continue to Autofill`.
- **Output style** (marketing image, `cover_1.webp`):
  - Salutation "Dear Hiring Manager,".
  - The opening paragraph names the role and company.
  - A second paragraph covers the most recent role with a quantified result and JD-aligned skills.
  - Key phrases are bolded and underlined to show which parts were tailored.
  - Badges: "Tailored To Each Role", "Key Achievements Highlighted", "Ready In 3 Seconds".
- **Quality complaints (HIRECARTA, likely):** letters can be generic, and can borrow details from the JD (locations, domain experience) and present them as the candidate's own. Scoutify called the letters serviceable but formulaic.
- **Free-tier allowance:** one review lists 2 cover letters per day (secondary, single source). See section 11.

---

## 10. Orion copilot: resume-related actions (confirmed: C-ORION, C-SHELL)

- **Quick prompts on a job:**
  - "Tell me why this job is a good fit for me."
  - "Generate custom resume tailored to this job."
  - "Show me Connections for potential referral."
  - "Write a cover letter for this job."
  - "Give me some resume tips if I want to apply" / "...to stand out."
- **Result chips:** Job Highlights, Resume Tips, Insider Connections, Top Candidates, Tailored Resume.
- **Shell menu:** `Optimize My Linkedin Profile`, `Manage My Resume`, `Update Linkedin URL`, `View My Linkedin Report`.
- Orion also runs the Fix-panel AI rewrites in Resume Analysis ("View AI-generated Version from orion").

---

## 11. Gating, credits and plans

**Credit model (confirmed in code: C-AGENT, C-ANALYSIS-RUN, C-ISSUES, https://static.jobright.ai/_next/static/chunks/pages/autofill/uninstall-8f4ba7fde454b46a.js)**

- Typed daily credit buckets: `AUTOFILL`, `TAILOR` (Custom Resume), `EMAIL` (insider emails). Each has a `dailyFill` cap.
- Resume Analysis draws on a separate "base resume credits" pool.
- The out-of-credits modal reads "Out of {type} Credits" and offers `Go Unlimited` (Jobright Turbo, "unlimited access across all features") or `Free Daily Refill`.
- Credits can also be earned through referral ("Earn more credits with Referral", "Invite friends to Jobright and earn up to ...").
- An Autofill uninstall survey lists "Not enough daily credits for me" as an option, which shows that credit limits drive churn.

**Free-tier numbers (secondary; they conflict, so treat as variable or A/B):**

- 2 credits per day shared across tailoring, autofill and insider email, resetting at midnight with no rollover (WOBO, RESUMEHOG; likely).
- Free resume tweak credits limited to two (Jobright's own Trustpilot reply, July 2026, as reported in search results).
- 3 resume customizations in total on free (HIRECARTA, early 2026).
- Per-feature: 2 custom resumes, 4 autofills and 2 cover letters per day (one 2026 review via search summary; single source).
- Job alerts: free gets up to 1 alert per day; Turbo can choose 1, 2, 5 or Unlimited per day (confirmed: C-SETTINGS).

**What is free (confirmed: https://jobright.ai/ai-job-match FAQ, tools FAQs):** signup, resume upload, job matches, Match Score, the basic resume check, Orion chat, and the tracker. Premium adds deeper analysis and optimization (resume-checker FAQ), unlimited tailoring and autofill, the full LinkedIn report and recheck, and coaching discounts.

**Turbo pricing over time (secondary, consistent across 2026 sources):**

| Period | Weekly | Monthly | Quarterly | Other |
|---|---|---|---|---|
| Early 2026 (ResumeJudge, Mar 2026) | $14.99/week | $29.99/month | $69.99/quarter | a "Premium" tier up to $49.99/month was mentioned |
| May to Oct 2026 (WOBO, RESUMEHOG, OutApply, HIRECARTA) | $17.99/week | $39.99/month | $89.99/quarter | — |

- `$39.99/mo` appears in the shipped bundle (C-SHELL).
- Older tiers "Plus $29/month" and "Premium $59/month" were reported by Scoutify.
- In 2025, Jobright's blog described Premium at $30/month for full AI resume tweaks (https://jobright.ai/blog/is-jobright-legit/, 2025-06-18).
- The refund policy lists **Weekly, Monthly, Quarterly and 6-Month** plans. Weekly plans get a 24h full-refund window; the others get 7 days (C-REFUND). There is a 7-day Turbo trial offer with a % discount ("Try Turbo for 7 days with extra N% off"), plus win-back and holiday countdown offers (C-SHELL).
- There is no public pricing page: `/pricing` returns 404, and prices appear only after signup (WOBO, RESUMEHOG; likely).

**Other gates:**

- Resume Analysis and Custom Resume are desktop-only (section 4).
- Up to 5 base resumes.
- The full LinkedIn report and its recheck are Turbo-only (section 12).

---

## 12. LinkedIn profile optimizer (in-app "LinkedIn Profile Report")

Confirmed: C-SHELL.

- **Entry points:** Orion and shell actions `Optimize My Linkedin Profile` and `View My LinkedIn Report`; a report card "Upgrade Your Linkedin Profile" (it explains what is holding the profile back and how to fix it); and the banner "Your LinkedIn Profile Needs Attention". It needs a LinkedIn URL on the profile.
- **Report drawer, "LinkedIn Profile Report":**
  - **Identity header:** photo, name, headline, and a "View LinkedIn profile" link.
  - **Overall score out of 100,** plus counts of `urgent` / `critical` / `optional` fixes.
  - **"Overall assessment":** an AI summary title plus highlight bullets. If nothing is found: "No issues found in the content we could assess."
  - **Five dimensions,** each with a score, its highest severity, an issue count and an explanation:
    1. Positioning.
    2. Recent Experience.
    3. Career Narrative.
    4. Discoverability.
    5. Trust & Proof.
  - **Per issue:** "Why This Matters", "How to improve it", and an example with copy-to-clipboard.
- **Gating:**
  - Free users see the preview (score, counts, summary, dimensions). Expanding a dimension is locked behind a Turbo upgrade prompt.
  - The Turbo banner promises every finding, rechecks at any time, and personalized improvements with complete example rewrites.
  - A recheck requires active Turbo (HTTP 403 otherwise). It is rate-limited: "Review limit reached. Try again in X hr Y min". If a recheck fails, the previous report is kept.

---

## 13. Quality complaints and risks (what to do better)

- **Fabrication:** the tailor inserts skills, metrics or credentials that are not in the source resume (HIRECARTA observed a "construction safety" claim; WOBO and zplatform report the same; likely). Jobright's in-product mitigation is the keyword `Verify Details` question flow (section 7.3), and the 2026 marketing copy repeats "only add truthful keywords".
- **Opaque scoring:** sub-scores come without explanation, and scores differ between the extension and the app (HIRECARTA; likely).
- **Tailoring for poor-fit jobs:** the product still prompts the user to tailor for a 5.5 "Poor" match (HIRECARTA).
- **Generic, keyword-stuffed output and robotic AI text:** reported in reviews. The bundle's feedback options include an "AI-generated content is poor or too robotic" option.
- **Design weakness:** HIRECARTA's early-2026 test saw 3 fonts and no color. Since then 5 templates, 11 fonts and accent colors have been added (change over time).
- **Credits run out fast** on the free tier, roughly 10 minutes of active use (HIRECARTA). The uninstall survey lists "Not enough daily credits".
- **Parsing gaps:** sections can go missing after parsing (feedback option), and ATS-misread fonts are flagged.

---

## 14. Timeline / changes over time

- **2024-06 to 2024-09:** Jobright 1.0 ships with "Resume AI" (tailored resume in about 10 seconds) and Orion. Product Hunt #1 Product of the Week/Month in July 2024 (https://jobright.ai/blog/launching-jobright-1-0-revolutionizing-the-job-search-experience-with-ai/).
- **2025:** the public tools sprawl (one templated page per resume tool). The 2025-08 blog describes the Urgent/Critical/Optional Fix flow with Re-Analyze and Export. Premium at about $30/month.
- **Early 2026:** Turbo at $29.99/month, three fonts, no color, "fit to one page" (HIRECARTA).
- **Mid to late 2026:**
  - Turbo rises to $39.99/month.
  - The tailor gains Quick/Full Edit, an optional custom prompt (A/B), keyword verification, AI Rewrite chat with voice and multi-candidate regenerate, 5 templates, 11 fonts, accent colors, spacing sliders and auto-fit.
  - New pages: the LinkedIn Profile Report, the Competitiveness Report, and the ATS checker and resume-job-matcher pages with compliance-oriented copy.
  - Chrome extension v1.24.0, updated 2026-10-08 (CWS).

---

## 15. Clone implications for RoboApply (feature and task checklist)

Dual brand: RoboHire.io for international markets including Taiwan, and GoApply.Top for mainland China. Every string must be localized, and section names, date formats and page size defaults must be locale-aware. For example, GoApply defaults to A4 and Chinese section headings; RoboHire US defaults to Letter. Inferred recommendations:

1. **Resume intake:**
   - Upload PDF/DOC/DOCX up to 10MB, or a LinkedIn URL.
   - Parse into the section schema in 3/8.1. Parse-quality review lets the user confirm missing sections.
   - "Update profile from resume" syncs into autofill.
2. **Resume hub:**
   - 5 resume slots plus a primary resume with the delete and primary rules.
   - Per-resume target job category.
   - Status chips. A desktop-only gate is optional; do better with a responsive layout.
3. **Resume Analysis:**
   - Pre-flight completeness check.
   - Grade A/B/C/D, score, and severities Urgent/Critical/Optional.
   - The 16-issue taxonomy (localize the "why" and "how" copy).
   - A Fix panel with before/after, verb choices and an AI rewrite (longer, shorter, stronger).
   - Re-analyze with a delta. Export as ATS-friendly PDF.
   - Charge 1 analysis credit, refunding it on cancel.
4. **Match and gap:**
   - Overall % plus Exp Level / Skill / Industry sub-scores, "why you fit" chips, and a gap grid (title, years, education, ATS keywords n/m, hard skills n/m, industry, summary).
   - Make the scores explainable: show the evidence lines. This is a differentiator against Jobright's opaque scores.
5. **Tailor wizard:**
   - Sections (Skills locked), Quick/Full experience edit, an optional prompt (1,000 characters), and keyword selection grouped by category plus custom keywords.
   - Generation in 10 to 20 seconds. Result with change cards, inline diff, compare/restore, **truth verification per inserted keyword**, and AI Rewrite chat with quick prompts and regenerate-N.
   - Save the version per job. Apply or autofill with that version.
6. **Editor and style:**
   - 5 templates (keep Split, but warn that it is not ATS-safe), font list, four font-size tiers, Letter/A4, spacing sliders with the same ranges, justify, header alignment, accent color, bullet icon, skills layout, education order, date formats, hide divider, reset, fit to one page with undo, and auto-fit after tailoring.
   - The CJK font set is needed for GoApply.
7. **Export:** PDF and DOCX, file-name presets, "original vs platform-formatted" choice for applying.
8. **Cover letter:** generated from resume plus JD, with chat-based tone and length edits, an Editor/AI Rewrite split, versions, copy, PDF/DOCX, and daily allowance counters. Add explicit tone and length presets, which Jobright lacks.
9. **LinkedIn report:** score /100, five dimensions, severity counts, why/how/example; the full report and recheck are paid and rate-limited. GoApply equivalent: Maimai or BOSS profile, to be decided.
10. **Competitiveness report:** peer education, years and skills percentiles plus market skill demand.
11. **Credits:** typed daily buckets (tailor, autofill, email, analysis, cover letter), daily refill, referral top-ups, unlimited on paid; weekly/monthly/quarterly/6-month plans; refund windows.
12. **SEO tool pages:** one templated landing page per long-tail resume keyword, all funneling to signup. Consider making 1 or 2 of them actually work without login (instant ATS check) as a differentiator.

---

## 16. Open questions

- The exact free daily allowance for each credit type today. It is server-configured (`dailyFill`) and not in the bundle, and the sources conflict (2 shared vs 2/4/2 per feature vs 3 total).
- Whether a "Fast Mode" from-scratch builder (no upload, guided form) still exists in-app. Marketing promises it, but no from-scratch wizard strings were found. It may be the same editor started empty.
- The exact entry CTA label for Resume Analysis today: the 2025 blog says `Begin Improvements Now`, but the bundle lacks it.
- Whether tailored versions count against the 5-slot limit, and whether they can be promoted to a base resume.
- Whether there are emails or notifications about resume analysis or tailoring. None were found; the only email setting found is job alert frequency.
- Whether the cover letter shares the TAILOR credit bucket or has its own. The code shows "1 credit consumed" and an "N available today" counter, but the bucket name is unclear.
- How the Match Score's three components are weighted.
