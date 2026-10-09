# Jobright.ai: signup and onboarding teardown

Research date: 2026-10-09. Angle: signup, onboarding, first-match generation, tours, extension prompts, upsells, notifications, mobile onboarding, re-onboarding (edit preferences), and profile fields.

All copy here is paraphrased. Short UI labels (button text, field names, option values) are listed as functional labels. They are not marketing prose.

Confidence labels:
- **confirmed**: seen in a primary jobright.ai source, meaning the live site, its public JS bundles, the store listings, or its own blog.
- **likely**: reported by more than one secondary source, or primary evidence that needs a small inference.
- **inferred**: my own reasoning from indirect evidence.

---

## 0. Method and primary evidence

No account was created and no form was submitted. I used four kinds of source:

1. **Public Next.js build of jobright.ai (primary).** The site is a Next.js Pages Router app. Its build manifest lists every route, and the per-page and lazy chunks hold the UI strings, form schemas, enums, and API paths. The current build id is `GQd0ykV_IrfhtmCjLOY2m`.
   - Build manifest (full route list): https://static.jobright.ai/_next/static/GQd0ykV_IrfhtmCjLOY2m/_buildManifest.js
   - Chunks cited below sit under `https://static.jobright.ai/_next/static/chunks/...`.
2. **Wayback CDX for `jobright.ai/onboarding*`.** This gives URL history, entry-point `from=` params, and version dates: https://web.archive.org/cdx/search/cdx?url=jobright.ai/onboarding*
3. **Store listings.**
   - Chrome Web Store: https://chromewebstore.google.com/detail/odcnpipkhjegpefkfplmedhmkmmhmoko
   - Google Play: https://play.google.com/store/apps/details?id=ai.jobright.orion
   - Apple App Store: https://apps.apple.com/us/app/jobright-ai-job-search/id6738236788
4. **Secondary reviews (2025-2026).** Sources: jobity.io, favtutor, wobo.ai, jobhire.ai, autogpt.net, Product Hunt, The Register. Several are written by competitors, and I flag them where they appear.

---

## 1. TL;DR: the canonical 2026 web onboarding sequence

```
Landing CTA / job-detail "Apply" / tool page / email alert / referral link
        │  (all land on /onboarding-v3/signup?from=<source>[&id=<jobId>&action=apply][&inviter_id=..])
        ▼
[S0] /onboarding-v3/signup   — Google OAuth  OR  email + password (+ marketing opt-in checkbox)
        │  server returns currentStage → client routes by stage table
        ▼
[S1] /onboarding-v3/mode-selection — Orion asks: "in a rush" vs "open, no rush"   (stage 50)
        ▼
[S2] /onboarding-v3/diagnostics — basic prefs: Job Function (≤3 specific titles), Job Type,
        Location (+Open to Remote), Work Authorization (H1B checkbox) + "Quick market snapshot"
        │                                     (stage 51 rush / 52 no-rush)
        ├── rush ───────────────────────────────┐
        ▼ no-rush                               │
[S3] /onboarding-v3/career-goals (stage 53)     │
        ▼                                       │
[S4] /onboarding-v3/advanced-preferences (54)   │
        ▼                                       ▼
[S5] /onboarding-v3/resume-upload — upload PDF/Word ≤10MB OR paste LinkedIn URL (stage 55 rush / 56 no-rush)
        ▼
[S6] /matching — animated 5-stage "analyzing" loader (stage 21 RESUME_PARSING)
        ▼
[S7] /jobs/recommend (stage 30 FILTE_RESUME_READY)
        → "Welcome! We found N roles…" review modal (seniority + extra job functions + optional LinkedIn
          + "Where did you hear about us") → "Confirm & See Jobs"
        → "Welcome to Jobright — Copilot mode" modal (feature tour; Agent-mode waitlist notice) → "Let's Go"
        → first-day "New User Discount" Turbo offer with countdown (A/B) ; app-install banner on mobile web
        ▼
[Later, optional] Profile completion wizard (Personal → Education → Work Experience → Skills → Equal Employment)
        → "Install the AutoFill Chrome Extension" step
[Later, optional] Agent setup wizard (Confirm Profile → Refine Target Role → Assess Job Market Fit →
        Activate Autofill → Agent Settings) — gated by waitlist / Turbo
```

Confidence: **confirmed** for the route list, the stage enum, and the route table. Sources: build manifest; `_app` chunk https://static.jobright.ai/_next/static/chunks/pages/_app-ff4b18b98295f6d5.js.

The rush versus no-rush branching (rush users skip career goals and advanced preferences) is **likely**. The enum names spell it out (`V3_RUSH_TO_BASIC_PREF`, `V3_NO_RUSH_TO_BASIC_PREF`, `V3_TO_CAREER_GOAL`, `V3_TO_ADVANCED_PREF`, `V3_RUSH_TO_RESUME`, `V3_NOT_RUSH_TO_RESUME`). The server decides `currentStage`, so I can't see the exact transitions.

Reviewers clock signup-to-first-matches at **about 4-5 minutes**. Sources: https://autogpt.net/jobright-ai-can-it-really-help-you-find-a-job/ (updated June 2026), and https://jobity.io/blog/jobright-review (account created 2026-08-31), which calls it the shortest onboarding in its category. **likely**

---

## 2. Server-driven onboarding state machine

Onboarding progress lives on the server as a numeric `currentStage`. After login the client looks up the route in a table. **confirmed** (`_app` chunk).

| Code | Enum name | Route the client sends the user to |
|---|---|---|
| 0 | (none) | `/` |
| 1 | `NO_FILTER` | `/onboarding-v3/mode-selection` |
| 10 | `NO_RESUME` | `/onboarding-v3/mode-selection` |
| 21 | `RESUME_PARSING` | `/matching` |
| 30 | `FILTE_RESUME_READY` (sic) | `/jobs/recommend` |
| 40 | `FAILED_RESUME` | resume page (route constant; resume upload or fix) |
| 41 | `FAILED_WITHOUT_FILTER` | `/jobs/recommend` |
| 50 | `V3_TO_SEEKER_TYPE` | `/onboarding-v3/mode-selection` |
| 51 | `V3_RUSH_TO_BASIC_PREF` | `/onboarding-v3/diagnostics` |
| 52 | `V3_NO_RUSH_TO_BASIC_PREF` | `/onboarding-v3/diagnostics` |
| 53 | `V3_TO_CAREER_GOAL` | `/onboarding-v3/career-goals` |
| 54 | `V3_TO_ADVANCED_PREF` | `/onboarding-v3/advanced-preferences` |
| 55 | `V3_RUSH_TO_RESUME` | `/onboarding-v3/resume-upload` |
| 56 | `V3_NOT_RUSH_TO_RESUME` | `/onboarding-v3/resume-upload` |

Onboarding API endpoints under the `swan` backend. **confirmed** (mode-selection, career-goals, and recommend chunks):
- `/swan/landing/seeker-type`: saves rush or no-rush.
- `/swan/landing/basic/titles`: job-function and title suggestions.
- `/swan/landing/basic/pref`: saves basic preferences.
- `/swan/landing/career-goal`
- `/swan/landing/advanced/pref`
- `/swan/landing/pref/get`
- `/swan/landing/job/diagnostic`: the market snapshot.
- `/swan/recommend/landing/jobs`: first matches.
- `/swan/resume/linkedin`: LinkedIn URL as a resume substitute.
- `/swan/lensa/decode` and `/swan/lensa/save`: partner-traffic import. The partner is Lensa, a job board. My inference is that it pre-fills preferences for users arriving from Lensa.
- `/swan/landing/oneline/parse`: likely parses the one-line search into filters. **inferred**

Auth endpoints. **confirmed** (`_app`):
- Registration: `/swan/auth/register/pwd-v3` (email and password) and `/swan/auth/register/sso-v3` (Google ID token).
- Login: `/swan/auth/login/pwd`, `/swan/auth/login/sso`, `/swan/auth/login/apple`.
- Password: `/swan/auth/forget/password`, `/swan/auth/reset/password`.
- Verification: `/swan/auth/verification/{email,status,confirm,resend}`, `/swan/auth/verify/email`.
- Student verification: `/swan/auth/edu/email` and `/swan/auth/edu/verify`.
- Account: `/swan/auth/cancel-account` (delete) and `/swan/auth/logout`.
- Registration requests carry `utmSource`, a `referralCode` taken from `inviter_id`, and an A/B bucket fetched from `/swan/ab/user`.

Design implication for RoboApply. **inferred**: keep onboarding as a server-side stage machine. Then any entry point (email deep link, job detail, mobile app) can resume at the right step, and A/B tests can reorder steps without a client release.

---

## 3. Entry points into signup

Every acquisition surface points at `/onboarding-v3/signup` with a `from=` tag. The signup page swaps its left-panel layout to match. **confirmed** via the Wayback CDX list and the signup chunk.

Observed `from=` values (Wayback, 2024-10 to 2026-10):
- **Feature landings:** `homepage`, `jobmatching`, `jobmatching-orion-analysis`, `agent`, `copilot`, `connect` (insider connections), `job-autofill`, `resume_landing`.
- **Free SEO tools:** `ai-job-assistant`, `job-tracker`, `cover-letter-generator`, and `resume-*`. The resume-* set covers checker, fixer, grammar-checker, headline-generator, helper, maker, matcher, parser, rewriter, summary-generator, tailor, and bullet-point-generator.
- **Job detail:** `job_detail&action=apply&id=<jobId>`, sometimes with `tob=true` (employer-posted "ToB" jobs) and `banner=false`. The job id rides along through mode-selection, diagnostics, and resume-upload, so the user can land back on that job after onboarding. Archived examples: `/onboarding-v3/diagnostics?id=…&from=job_detail` and `/onboarding-v3/resume-upload?id=…&from=job_detail`.
- **Email-driven:** `imp_id=…__instant_push__…`, `…__digest_job_alert__…`, and `…__opentowork__…` with `utm_medium=email`. These point to job-alert and outreach emails that bring non-users or lapsed users straight into onboarding.
- **Referral:** `inviter_id=<userId>`, from the referral program.
- **Retargeting:** `retarget=jobalert`, `retarget=referral`, `retarget=membership`.
- **Paid and affiliate:** `gad_source` (Google Ads), `ref=producthunt`, plus many `utm_source=<newsletter>` values.

Signup-page layout variants. **confirmed** (signup chunk https://static.jobright.ai/_next/static/chunks/pages/onboarding-v3/signup-43cfc6d4ee4c933d.js):
- **Default / homepage.** Heading invites the user to join Jobright. The left panel shows three stat bullets: 2X more qualified matches, 60% time saved, 50% more interview invites.
- **Resume landing.** The heading is about improving your resume and applying to top matches. Stat bullets cover faster autofill and more interviews with a custom resume.
- **LinkedIn-ad layout.** Shows "Today's new jobs", "Total jobs", and a "1 Million+ Trusted Users" counter.
- **Agent layout.**
- **TNT layout.** TNT is Jobright's curated "Top-talent × Top AI startups" network. This layout shows a startup logo wall, "Skip the normal applicant queue" benefits, and a TNT FAQ.
- **Contextual titles.** Variants include "Sign up To Continue", "Sign up to continue to apply" (job-detail apply gate), and "Sign up to view interview questions" (interview-bank gate).

Logged-out (visitor) surfaces gate actions behind signup. Visitors can browse SEO job lists and job details (`/jobs/info/[id]`). Clicking Apply, Unlock interview questions, and similar actions opens signup. **confirmed** (strings in signup and interview chunks).

The visitor's own search choices are logged as `user_incognito_*` events, for example `user_incognito_location_city_update` and `user_incognito_h1b_check`. I infer that pre-signup visitor filters (stored in localStorage under `visitor_filters`) carry over into onboarding. **inferred** from the `_app` enum (`VISITOR_FILTERS`, `VISITOR_ID`).

The homepage hero has a quick-search bar: **Job Title, Work Model, Country (default United States), City, Experience Level, GO**. **confirmed** (homepage HTML https://jobright.ai/).

---

## 4. [S0] Signup screen: `/onboarding-v3/signup`

### 4.1 Layout
- Two columns.
  - **Left:** brand panel with a background image, the logo, a context-specific headline (section 3), and a benefits list.
  - **Right:** the auth card.
- Above the card sits an **"Account type" toggle: Job seekers | Employers**. Employers go to `business.jobright.ai/landing/signup`. **confirmed** (strings `auth-audience-toggle`, `Account type`, `Job seekers`, `Employers`, plus the business URLs in the profile chunk).

### 4.2 Auth card fields and actions
Source: **confirmed**, signup form chunk https://static.jobright.ai/_next/static/chunks/94567-19ddb3c024e7dc13.js. Top to bottom:
1. Greeting: "Welcome to Jobright".
2. **"Sign up with Google"** button (Google Identity, ID-token flow). Two Google OAuth client IDs appear in `_app`, probably web and another surface.
3. Divider: **"OR"**.
4. **Email** input. Validation message: "Please provide a valid email address!"
5. **Password** input with a show/hide toggle. Rule: at least 8 characters, containing both letters and numbers. The client enforces this with two regexes, one for a digit and one for a letter.
6. **Checkbox, marketing opt-in.** Its label offers updates from Jobright about the latest job offers. Form field: `emailSub`. I could not determine the default state; I infer it is pre-checked, which is common. **inferred**
7. **SIGN UP** button. Some variants show "SIGN UP FREE".
8. Legal line: continuing means agreeing to the Terms of Service (`/legal/service`) and the Privacy Policy (`/legal/privacy`).
9. Footer link: "Already a member? Sign in now". It opens the sign-in modal (section 4.4).

### 4.3 Errors and edge cases
Source: **confirmed** (94567, 32802, 11384 chunks).
- **Duplicate email.** Toast tells the user the email is already registered and to sign in.
- **Google failure.** A "Google login failed." toast.
- **On-blur email capture.** When the email field loses focus with a valid value, the client posts it to a tracking or lead endpoint. This is a partial-signup or abandoned-lead hook. **confirmed** (code path in 94567); the purpose is **inferred**.
- **Google SSO with an existing account.** The user is logged straight in and routed by `currentStage`. If the user came from a job detail page, they return to `/jobs/info/[id]`.
- **In-app browser guard.** Inside LinkedIn, Instagram, or TikTok webviews, where Google OAuth is blocked, an overlay tells the user to open the page in the system browser, then sign up with Google. **confirmed** (chunk 32725: "Tap the menu above… Open in Browser… sign up with Google").

### 4.4 Sign-in modal
Source: **confirmed**, chunk https://static.jobright.ai/_next/static/chunks/11384.8100c48a35afce07.js.
- "Welcome to Jobright".
- "Sign in with Google".
- Email and password fields.
- **SIGN IN** button.
- Footer: "Not a member? Sign up now".
- Forgot-password flow via `/reset-password`, backed by `/swan/auth/forget/password`.

### 4.5 Apple sign-in
- A "Continue with Apple" / "Sign in with Apple" component exists. It uses `react-apple-signin-auth` and loads Apple's JS SDK; the backend endpoint is `/swan/auth/login/apple`. **confirmed** (chunks 81504 and 96852).
- On web it is probably used on mobile surfaces or as an A/B variant. It is required for the iOS app. **inferred**

### 4.6 LinkedIn
- **LinkedIn is not a login method in 2026 builds.** LinkedIn appears in two ways:
  - **(a)** A profile URL used instead of a resume ("Continue with Linkedin" plus an "Enter Linkedin URL" form).
  - **(b)** `/auth/callback/linkedin` and `/linkedin-verification/callback` routes. These are probably used for TNT profile verification or a legacy LinkedIn OAuth.
- Confidence: **confirmed** that the routes exist; their purpose is **inferred**.
- Secondary sources list only email and Google sign-up: https://jobhire.ai/blog/jobright-ai-review-and-decision-guide-2026 (July 2026). **likely**

### 4.7 Email verification
- Signing up does not block on email verification.
- Verification (`/email-verification`, `/verify-email/[code]`) gates the **referral program**: you must verify before you can share an invite link.
- The page handles these states: verified, already verified, link expired (auto-resends), invalid link, and "go back to the device you signed up on".
- Confidence: **likely**. The referral chunk 78734 requires verification, and the email-verification page strings are confirmed. Whether the core flow is unblocked is **inferred**, because no reviewer mentions a verification step.
- A **student `.edu` verification** exists and unlocks a Student Turbo price. **confirmed** (strings "Verify your student status", "Get Turbo at Student Price").

---

## 5. [S1] Mode selection: `/onboarding-v3/mode-selection`

**confirmed**, chunk https://static.jobright.ai/_next/static/chunks/pages/onboarding-v3/mode-selection-98ce4c29955b4786.js

- **Speaker:** Orion, Jobright's AI copilot persona, greets the user in a chat-bubble style.
- **Question:** which option best describes the user's current situation.
- **Two large option cards** with illustrations:
  1. **"I'm looking for jobs in a rush"** (rush icon). This is the "rush" seeker type.
  2. **"I'm open to new opportunities, no rush"** (trophy icon). This is the "no rush" type.
- Selecting a card saves via `/swan/landing/seeker-type` and advances. No Skip button.
- An Appcast conversion pixel loads on this page. That is a recruitment-ad network attribution pixel. **confirmed**

The choice changes the copy on the next step and decides whether career goals and advanced preferences appear. **likely**

---

## 6. [S2] Basic preferences, or "diagnostics": `/onboarding-v3/diagnostics`

**confirmed**, chunk https://static.jobright.ai/_next/static/chunks/pages/onboarding-v3/diagnostics-fc025d692df73b81.js

### 6.1 Header copy (Orion voice)
- **Rush:** a short "what type of role are you looking for?" prompt.
- **No-rush:** first says that with time on its side it can aim for the perfect match, then asks the same question.
- Mobile uses a compact header class (`onboarding-v4-diagnostic-page-header-text`). That suggests a v4 variant is being tested. **inferred**

### 6.2 Fields
1. **Job Function.** Required. Hint: "(select from drop-down for best results)".
   - Typeahead over Jobright's job taxonomy (`jobTaxonomyList`).
   - An Enter key or "Add" button creates a custom function. Dropdown hint: "Create a custom job function with …".
   - Validation: "Please select/enter your expected job function" and "Please select at least one job function".
   - **Specific-title confirmation sub-step.** After a function is picked, Orion asks which of the specific job functions under it fit the user's expertise, **max 3**. The options come from `specificTitles`. Error: "Please select at most three titles."
   - **"Too general" warning.** A broad title shows a tag warning that it may significantly affect matches (`isGeneralTitle`). **confirmed** (`_app` constants).
2. **Job Type.** Required, multi-select: **Full-time, Contract, Part-time, Internship**. Error: "Please select at least one job type."
3. **Location.** Required.
   - City or area picker with the placeholder "Select a city or area" or "Enter your city".
   - Country is implied by the supported-country list: **US, CA, GB, AU, IE, NZ**. Each has an "Anywhere in the US/Canada/UK/Australia/Ireland/New Zealand" option. **confirmed**, `diagnostics` country helper, which defaults to US.
   - Error: "Please select a location option to continue".
4. **Open to Remote.** Checkbox. Its helper text says including remote roles broadens the search and improves odds.
   - Unchecking it fires `user_incognito_opentoRemote_uncheck`. It appears checked by default. **inferred**
5. **Work Authorization.** One checkbox, **"H1B sponsorship"** (`isH1BOnly`). When checked, matches are restricted to sponsoring employers. Event `user_incognito_h1b_check`.

### 6.3 "Quick market snapshot" panel
Shown beside or after the inputs once a function is chosen:
- An Orion lead-in saying "here is how [role] looks in the job market".
- **Median salary** (`medianSalary`).
- **Top industries** for the title (`topIndustriesUnderTitle`).
- **"Hot Skills"** word cloud (`wordCloud`, `skillCloud`).
- Data comes from `/swan/landing/job/diagnostic`. This is the "diagnostics" in the route name: a value-before-signup moment that shows market intelligence while the user answers.

### 6.4 Footer
**Previous** (disabled on the first step), **Skip**, **Next** (class names `previous-button`, `skip-button`, `next-button`).

### 6.5 Absent from basic preferences
Experience level and salary are **not** asked on this screen in v3:
- Seniority is inferred from the resume and confirmed later in the first-landing modal (section 10.1).
- Salary lives in the filter editor (section 15).

This matches jobity's account (job function, job type, location, then seniority confirmation; created 2026-08-31) and jobhire.ai's list (function, job type, location, work authorization). Confidence: **likely**, two secondary sources plus the bundle.

Older reviews (2024-2025) describe preferences as "titles, industries, locations, salary". That likely describes the v2 flow or the filter editor. **likely**, per autogpt.net. Treat it as a change over time.

---

## 7. [S3] Career goals: `/onboarding-v3/career-goals` (no-rush branch)

**confirmed**, chunk https://static.jobright.ai/_next/static/chunks/pages/onboarding-v3/career-goals-a011e6475bc60333.js

- **Orion prompt:** "almost there", then a question about the user's career goal for the next role.
- **Three grouped card sets**, single selection (`careerGoal`):
  - **Advance My Career:** To A Senior Role · To A Manager Role · To A Higher Compensation
  - **Shift My Career Path:** Transit To A New Industry · Transit To A New Role · Explore New Skill
  - **Enjoy Better Work Style:** Work & Life Balance · Work Security · Work Flexibility
- **Validation:** if Next is pressed with nothing chosen, "Please select your career goal before advancing."
- **Footer:** Previous · Skip · Next.

---

## 8. [S4] Advanced preferences: `/onboarding-v3/advanced-preferences` (no-rush branch)

**confirmed**, chunk https://static.jobright.ai/_next/static/chunks/pages/onboarding-v3/advanced-preferences-62d9a56b315ba28f.js

- **Orion prompt:** finally, what would make an ideal job. Subtext says the user can specify industries, company stage, or skills, and that it is optional.
- **Industry:** typeahead with "Add" (multi).
- **Skill:** typeahead with "Add" (multi).
- **Company Stage:** multi-select chips with a tooltip. The tooltip says that when stage data is missing, Jobright estimates it from company size.

  | Stage | Funding | Size |
  |---|---|---|
  | Early Stage | Seed / Series A | 1-50 employees |
  | Growth Stage | Series B / Series C | 51-200 employees |
  | Late Stage | Series D and beyond | more than 500 employees |
  | Public Company | IPO | N/A |

- **"Open to all"** default chip and a **"Clear All"** link.
- **Footer:** Previous · Skip · Next.
- **Header:** Orion avatar plus "Your AI Copilot", and a **Logout** link. So the user is already authenticated at this point, which confirms that signup comes **before** the preference steps in v3.

---

## 9. [S5] Resume upload: `/onboarding-v3/resume-upload`

**confirmed**, chunk https://static.jobright.ai/_next/static/chunks/pages/onboarding-v3/resume-upload-eb73c5762854e84f.js

- **Headline:** the default variant presents this as one last step to "level up your search" by uploading a resume.
- **Variant headline:** says it already sees exciting opportunities, and offers a resume upload **or** a LinkedIn URL.
- **Primary: "Upload Resume" dropzone.**
  - **PDF or Word**, max **10MB** (`.pdf, .doc, .docx`). A success state shows an "upload_ok" icon and the file name.
  - Errors:
    - "Please upload your resume to proceed"
    - "Failed to upload your resume."
    - "File name is too long, please rename it and try again."
    - Daily upload cap: "You've reached your daily resume upload limit…" (from `_app`).
- **Alternative: "Enter Linkedin URL".**
  - Input placeholder is `https://www.linkedin.com/in/...`.
  - A helper link, "Get your Linkedin profile URL", opens LinkedIn people search.
  - Copy says the profile is used only to improve matching.
  - Errors:
    - "Please enter your LinkedIn URL"
    - "Please enter a valid LinkedIn profile link"
    - "Linkedin URL is invalid…"
    - "We couldn't find a LinkedIn profile with this URL…"
    - "Failed to activate Linkedin URL"
- **Privacy note under the dropzone:** data privacy is a top priority, the resume is used only for matching and never shared with third parties, plus a Privacy Policy link.
- **CTA:** **"Start Matching"**, plus **Skip**.
  - Skipping leads to `NO_RESUME` or `FAILED_WITHOUT_FILTER` style states. Matches still show, based on preferences only.
  - Prompts to add a resume reappear later via `resume_last_popup_time` throttling. **confirmed** (localStorage keys in `_app`).

---

## 10. [S6] Analyzing loader: `/matching`

**confirmed**, chunk https://static.jobright.ai/_next/static/chunks/pages/matching-0e5831fa2adf071c.js

- A Lottie animation plus a linear progress bar.
- **Five sequential status lines**, each with a subline:
  1. Scanning your resume or LinkedIn profile for key skills, work history, and education.
  2. Identifying your job preferences: industry, role, and location.
  3. Building your job-matching profile with AI ("unique suitability profile").
  4. Finding relevant jobs for you by matching the profile against postings.
  5. Personalizing your job recommendations and generating insights.
- **Side panel, "Feature Highlights":** generate a custom resume for each job; autofill application forms in one click; find LinkedIn connections for referrals.
- **Error state:** a sad illustration, and copy saying there was an issue analyzing your resume or LinkedIn profile.
  - Buttons: **Try again**, **Upload Resume**, **Enter Linkedin URL**.
  - Escalation line: if the issue persists, contact support@jobright.ai.
- A ZipRecruiter conversion pixel fires here (`track.ziprecruiter.com/conversion`). Jobright buys signups via ZipRecruiter. **confirmed**

---

## 11. [S7] First landing on `/jobs/recommend`

### 11.1 "Welcome! We found N roles" review modal (new-user tour)
**confirmed**, chunk https://static.jobright.ai/_next/static/chunks/7769.473e59e25642d341.js. Classes `new-tour-welcome-container`.

- **Title:** a clapping emoji, then "Welcome! We found **N** roles that fit you best." Subtitle asks the user to take a moment to check everything looks right.
- **Recommended Experience Levels:** chips preselected from the resume (`suggestedSeniority`).
  - Expand/collapse control.
  - Error: "Please select at least one experience level."
  - Levels and their helper text (from `_app`):
    - **Intern/New Grad:** no experience required.
    - **Entry Level:** 1-3 yrs.
    - **Mid Level:** 2-5 yrs, not yet senior.
    - **Senior Level:** 5+ yrs, project leader.
    - **Lead/Staff:** cross-team leader or domain expert.
    - **Director/Executive:** Director/VP/CXO.
- **Additional Job Functions Matching Your Background:** suggested extra taxonomy titles derived from the resume (`getTaxonomySuggestionOnboard`).
- **Add your LinkedIn URL for smart job matching (Optional):** an input with an example placeholder.
- **"Where did you hear about us"** attribution survey, single select:
  - Instagram, TikTok, YouTube
  - LinkedIn (job posting), LinkedIn (someone's post)
  - Google search, Friend / colleague, Email
  - AI tools (like ChatGPT)
  - Other, which opens a free-text "Please specify" field.
  - Validation messages exist, so the survey is required in at least one variant (`onboarding_acquisition_source_survey_test`).
- **CTA:** **"Confirm & See Jobs"**.
- **Analytics on submit:**
  - whether seniority or taxonomy changed (before/after)
  - the selected source
  - the LinkedIn URL
- **Recommendation-preference flag:** an A/B variant sets `recommendationPreference = 2`.

### 11.2 "Welcome to Jobright: Copilot mode" modal
Same chunk.
- **Title:** Welcome to Jobright. Subtitle: start with Copilot mode to supercharge your search.
- **Four feature tiles:** AI Job Matches · AI Custom Resumes · Insider Connections · 1-Click Autofill Applications.
- **Waitlist notice:** "You're on the waitlist for Agent mode." Supporting text says access rolls out in waves because of demand, and users will be notified.
- **CTA:** **"Let's Go"**.

### 11.3 First job feed anatomy
Seen in reviews. **likely**: favtutor (2026-08-21), jobity (2026-08-31), autogpt (2026-06). Labels **confirmed** in `_app`.

- **Tabs:** **For you · Liked · Applied · External** (External = jobs saved from other sites via the extension).
- **Side nav:** Profile, Settings, Resume. **confirmed** (recommend chunk).
- **Mobile bottom nav:** **Jobs · Profile · Resume · Interview**. **confirmed** (`_app`).
- **Card contents:**
  - company logo, title, company, location, work model, salary when available, job type, seniority, minimum years
  - posted-time stamp
  - applicant count ("Less than 25 applicants", "Be an early applicant" / "Early applicant" flag)
  - company stage tag
  - **H1B tags:** "H1B Sponsored" (the job says so) and "H1B Sponsor Likely" (the company sponsored similar roles in the past 3 years)
  - limitation tags: "No H1B", "U.S. Citizen Only", "Security Clearance Required"
  - "Top Investors" tag
- **Match score:** a 0-100% ring labelled Strong / Good / Fair Match.
  - The detail page breaks it into **Experience Level, Skill, Industry Experience**, and in some builds **Education Match**.
  - A first-time "score tip" tooltip is tracked by the `showScoreTip_v1` key. **confirmed**
- **Initial volume:** reviewers saw **5,903** matches (autogpt) and **8,624** (jobity) right after onboarding. Bloomberg Law (July 2025) cited up to 50 curated jobs per week for an earlier version. Treat that as a change over time. **likely**

### 11.4 In-feed calibration micro-surveys
**confirmed**, recommend chunk https://static.jobright.ai/_next/static/chunks/pages/jobs/recommend-73cab9378acfb3f3.js

- **Orion recommendation guide:** asks whether the user likes the matches so far, with **Yes** / **No, not a good fit**.
- **"Do you have these skills?"** Clickable skill chips; tapping one adds the skill to the profile and shows a toast.
- **Daily rating:** how satisfied the user is with today's matches, on a scale from "Not satisfied" to "Extremely satisfied".
- **Per-job dislike reasons:** Irrelevant Title · Low-quality company · Experience Level Mismatch · Skill Mismatch · Outdated Job Listing, plus a free-text box.
- **Zero-results state:** a "What's limiting your search" panel naming each over-tight preference, a "How you may adjust" panel, and an **Update Now** button. A whimsical variant says the user has reached the edge of the job universe.
- **Unknown preferences:** an "Update Preferences" prompt saying Jobright can't learn the user's preferences and asking them to state them again. This is the **re-onboarding trigger**.
- **Resume-analysis nudge banners:** "Your Resume Analysis Is Ready" / "Your Resume Needs Attention", in four severity tiers.

### 11.5 Other first-session popups
- **Mobile-web smart banner:** "Jobright — Your AI Job Search Copilot" with **Install**, linking to `/mobile-app`. **confirmed** (recommend chunk).
- **"Get the Jobright App!" modal:** App Store and Google Play buttons; copy says access jobs anywhere, with instant alerts and application tracking. **confirmed** (chunk 77645).
- **Orion chat unlock toast:** "Great! You've just unlocked your Chat with me, Orion!" **confirmed** (`_app`). The trigger is not visible; I infer it fires on completing onboarding.
- **Throttled popups:** office-hour registration, Turbo survey, and free-trial welcome, each limited by localStorage timestamps:
  - `TURBO_OFFICE_HOUR_LAST_POPUP_TIME`
  - `TURBO_SURVEY_POPUPED`
  - `FREE_TRIAL_WELCOME_POPUPED`
  - Source: **confirmed**.

---

## 12. Profile page and completion wizard: `/jobs/profile`

**confirmed**:
- Page chunk: https://static.jobright.ai/_next/static/chunks/pages/jobs/profile-eb8fb2767cddd292.js
- Form schemas: https://static.jobright.ai/_next/static/chunks/57949-35ea3644d374b35a.js

### 12.1 Entry card
- Title: complete your profile for perfect matches and autofill.
- Body: the profile is nearly done; confirm a few details.
- **Start Now** button.
- Privacy note: profile data is used only for matching and resume optimization, is never shared with recruiters without consent, and can be edited or deleted anytime.

### 12.2 Wizard steps
Each step has its own Orion emoji intro line:
1. **Personal**: let's start with basic info.
2. **Education**: review and confirm education history.
3. **Work Experience**: "halfway there", double-check work experience.
4. **Skill**: the more complete the skillset, the better the matching.
5. **Equal Employment**: last step; used only for autofill and never shared.
6. **Install extension** final step: "Just one last important step." All info is ready, so install the AutoFill Chrome Extension. Shows a social-proof install count, **"Click to Install Extension"**, then "Congrats! You're all set" with **View More Opportunities** / **APPLY NOW**.

Missing required fields show a red **MISSING** badge. The agent wizard blocks on these.

### 12.3 Personal fields
- First Name, Middle Name, Last Name
- Email
- Phone Type (Home / Mobile / Work / Other) and Country Code (+1 US/Canada, +44 UK, +86 China, +91 India, +61 Australia, +49 Germany, and more)
- Phone
- Address Line, Country/Region, State/Province, City, County, Postal Code. Address autocomplete uses `/swan/address/autocomplete` and `/swan/address/resolve`.
- LinkedIn URL, GitHub URL, Portfolio URL
- Required-ness: City is required for location, and there are validation messages for country, state, and city.

### 12.4 Education (repeatable, "Add Education")
- School Name (autocomplete with a logo)
- Major
- Degree Type
- GPA
- Start Date / End Date (YYYY-MM), with an "I currently study here" checkbox
- Delete asks for confirmation.
- Validation: end date can't be earlier than start date.

### 12.5 Work Experience (repeatable, "Add Work Experience")
- Job Title (required)
- Company (required; company autocomplete with the tip to pick a company from the list for accuracy)
- Job Type (required: Full-time / Contract / Part-time / Internship)
- Location
- Start Date / End Date, with an "I currently work here" checkbox
- Experience Summary / bullet points

### 12.6 Skills
Grouped skill editor (`skillGroupEditor`).

### 12.7 Equal Employment
Answers are button-style radios.
- Authorized to work in the US?
- Will you need visa sponsorship now or later?
- Disability?
- Veteran?
- Gender (male / female / non-binary / decline)
- LGBTQ+?
- Race, with options:
  - American Indian or Alaskan Native
  - Asian
  - Black or African American
  - Hispanic or Latino
  - White
  - Native Hawaiian or Other Pacific Islander
  - Two or More Races
  - Decline to state
- Hispanic or Latino?
- Sexual orientation (multi)
- Pronouns: He/Him, She/Her, They/Them, self-describe, prefer not to say

### 12.8 Resume and LinkedIn block
- Upload or replace the resume (PDF/Word ≤10MB), with **View** and **Download**.
  - Success toast: resume uploaded successfully and recommendations will update from the latest info.
- **Update Your Linkedin URL**, with a "Verified LinkedIn URL" state. Tip text says the LinkedIn URL helps find alumni and ex-colleagues at target companies for referrals.

### 12.9 Templates panel
Airtable-embedded resume galleries by function: Software Engineering, Data Analyst, Product Management, Sales, and so on, about 20 categories. This is a soft content upsell. **confirmed**

---

## 13. Chrome extension install prompts

### Install points
**confirmed**:
- Profile wizard final step.
- Agent wizard step 4.
- "How to Use Jobright Autofill Extension" modal (chunk 10344).
- Job cards marked **"APPLY WITH AUTOFILL"**, which open the install pop-up when the extension is missing (`NEED_INSTALL_PLUGIN`).

### 3-step guide (chunk 10344)
1. Install the extension from the Chrome Web Store.
2. Open any Jobright page with the extension and click **Start Applying** inside it to activate.
3. Find jobs with the **APPLY WITH AUTOFILL** button.

Status card states:
- profile incomplete → **Complete Profile**
- profile complete but no extension → **Install Extension**
- all done → **Explore Jobs**

### Version check (agent wizard)
- "not the correct version": the user is told to remove the old extension and reinstall the latest.
- "not detected": the user is told to refresh and click **I've installed it** again.

### Install attribution
Hand-off via postMessage events `jobright:autofill-install-attribution-*`. Only the `job_apply_popup` surface may create an install hand-off. **confirmed** (uninstall chunk).

### Uninstall survey at `/autofill/uninstall`
**confirmed**, https://static.jobright.ai/_next/static/chunks/pages/autofill/uninstall-8f4ba7fde454b46a.js. Reasons offered:
- Autofill didn't work on my target platforms
- Autofill filled incorrect information
- Autofill was too slow
- Not enough daily credits
- I didn't know how to get started
- Pop-ups were too frequent
- Not enough matching jobs
- I found a job / no longer searching

### Chrome Web Store listing (2026-10-09)
"Jobright Autofill – Instant Job Applications, Job Match, AI Tailor Resume":
- 4.9★ from 372 ratings, 300,000 users
- v1.24.0, updated 2026-10-08
- Offers in-app purchases
- Data disclosures: PII, user activity, and website content
- Source: https://chromewebstore.google.com/detail/odcnpipkhjegpefkfplmedhmkmmhmoko. **confirmed**
- Change over time: about 100K users (autogpt, mid-2026) and about 200K (favtutor, Aug 2026) before 300K now.

---

## 14. Agent-mode onboarding (second onboarding, `/agent`)

**confirmed**, chunk https://static.jobright.ai/_next/static/chunks/pages/agent-70b6a9ee45390efe.js. Seen by favtutor (2026-08-21): https://favtutor.com/jobright-ai-review/

### Intro card
- Orion introduces itself as a personal AI job-search agent.
- Four bullets: craft a search plan; find roles you love; autopilot applications (resume, cover letter, 1-click apply); ask anything, 24/7 coach.
- Buttons: **See How Agent works** / **Start setting up my agent**.

### Waitlist gate
- States: "You're on the Waitlist" / "Join the Waitlist".
- Paid escape: **"Skip Waiting and Enable Agent Now"**, which leads to Turbo checkout. Also reported by jobity (2026-08-31). **confirmed**

### Five-step stepper
1. **Confirm Profile.** Orion wants to make sure the profile is accurate first. It shows personal info, LinkedIn/GitHub, education, work experience, skills, and EEO. Missing required fields are flagged. **Confirm & Proceed**.
2. **Refine Target Role.**
   - Shows the job preferences picked earlier, with **Looks Good** or edit.
   - Then shows **3 matches to rate thumbs-up/down**. Rating is mandatory. A thumbs-down asks what didn't work. **Refine my matches** iterates with 3 new roles.
   - If filters are too narrow: a hint to remove company, skill, or industry conditions, plus **Edit Preferences**.
3. **Assess Job Market Fit.** A "Job Search Competitiveness Report" that takes about 30-40s to generate:
   - "Where You Stand at a Glance": the percentage of applicants the user outperforms, plus a strength and a level-up item.
   - **You vs. Other Applicants:** education, experience years, skill coverage bars.
   - **You vs. What Employers Want:** degree coverage percentage, experience coverage percentage, most-requested skills.
   - "Add Missing Skills to Your Profile" chips.
   - "Suggested Updates to Your Job Preferences": add/delete/update suggestions said to unlock N more quality jobs.
   - CTA **Improve My Fit**.
4. **Activate Autofill.**
   - Answer common application questions once.
   - Install the Chrome extension in 3 steps, then confirm with **I've installed it**.
5. **Agent Settings.**
   - **Agent Mode:**
     - **Supervised Mode**: pauses for confirmation at resume creation and at final submission.
     - **Automated Mode**: runs all steps and stops only when it needs info.
   - **Job Application Objective:** a jobs-per-week target (a goal, not a hard cap).
   - **Resume preference:** generate a custom resume per application, or select one of the user's own resumes. Primary resume can be the Jobright Template or the Original Version.
   - **Toggles:** Customize resume per application; Generate cover letter per application.
   - Finish: **Set up Completed** then **Start Applying with Agent**.

### Credit gates during agent runs
- Out-of-credits modals for custom resume, autofill, or email.
- Options: **Proceed without Custom Resume/Autofill**, **Go Unlimited / Upgrade to Turbo**, or come back tomorrow for the free daily refill.

---

## 15. Re-onboarding: the job preferences / Filters editor

The user reopens onboarding answers through **Filters** on `/jobs/recommend`, or by asking Orion in chat. **confirmed**, chunks:
- https://static.jobright.ai/_next/static/chunks/79590-8c2f0d2a5023ceda.js
- https://static.jobright.ai/_next/static/chunks/95257-b76910c6140f0fbb.js
- https://static.jobright.ai/_next/static/chunks/10344-7630c6c855467801.js

The drawer has **four collapsible sections**, each with a subtitle summary.

### A. Basic Job Criteria (Job Function / Job Type / Work Model / Location / …)
- **Job Function:** taxonomy multi-select, required.
- **Excluded Title:** free text plus suggestions. Conflict check against job functions in both directions, with errors when they overlap.
- **Job Type:** Full-time / Contract / Part-time / Internship (≥1).
- **Work Model:** Onsite / Hybrid / Remote (≥1).
- **Country:** one of 6, required.
- **Location:**
  - City Selector with a **radius**: 0, 5, 25, 50, or 100 mi (`cityRadius`).
  - Multiple Location Selector.
  - "Anywhere in <country>" and "Within US" options.
- **Experience Level:** the six levels from section 11.1 (≥1).
- **Required Experience:** range slider 0-11+ years (`minYearsOfExperienceRange`), can be switched off.
- **Date Posted:** Past 24 hours / Past 3 days / Past week / Past month.

### B. Compensation & Sponsorship
- **Minimum Annual Salary:** slider; "Any salary" when off.
- **Work Authorization:** "H1B sponsorship" checkbox (`isH1BOnly`). Tooltip explains the H1B Sponsored vs. H1B Sponsor Likely logic.
- **Exclude Jobs with Limitations:** checkbox group to exclude "Security Clearance Required" and "U.S. Citizen Only" (`excludeByAuthorization`). Tooltip: hide roles with special work-authorization limits.

### C. Areas of Interests (Industry / Skill / Role (IC/Manager) …)
- Industry (`companyCategory`) and Excluded Industry
- Skill and Excluded Skill
- **Role Type:** IC or Manager, single
- Company Stage (four stages; Top Investors tag elsewhere)

### D. Company Insights (Company Search / Exclude Staffing Agency …)
- **Company:** include specific companies.
- **Exclude Company**
- **Job Source:** "Exclude Staffing Agency" toggle.
- A tip suggests using this section when applying to specific companies.

### Saving and gating
- Save shows the toast "Preferences updated! Check out the latest job matches."
- **Saved filters:** Free gets 1, Turbo gets "Multiple Saved Filters". **confirmed** in strings. Reviewers report Free has 1 saved filter (favtutor, jobity). **likely**
- **"Hidden Jobs" filter:** Turbo-only, with an "Unlock the Hidden Jobs" upsell. Jobity (2026-08-31) saw a promo for 5,360 hidden jobs. **likely**

### Natural-language editing with Orion
- The filter-help panel suggests Orion prompts, for example:
  - add a job title
  - prefer remote
  - set location to a city
  - focus on mid-level
  - find H1B jobs
  - set a minimum salary
  - require Python and SQL
  - exclude a title
  - IC roles only
- Orion replies with a reviewable "UPDATE_FILTER / SHOW_FILTER" card: **Confirm** or **UPDATE**. **confirmed** (agent and `10344` chunks).
- Google Play release notes (updated 2026-08-21) mention reviewable filter updates from Orion. **confirmed**
- Orion can also proactively suggest a filter change from a job detail (`suggest_condition`, `suggest_value` analytics). **confirmed**

---

## 16. Settings page: `/settings`

**confirmed**:
- https://static.jobright.ai/_next/static/chunks/pages/settings-d1abc17acf0503a8.js
- https://static.jobright.ai/_next/static/chunks/28508.14b1b6ed7b4277b8.js

Sections:
- **Login & Security:** Password, Reset password.
- **Delete my account:** confirmation modal. It warns the action is irreversible and removes profile, matches, and settings, and says a confirmation email will follow.
- **Subscriptions:** current plan, Manage Subscription, Switch Plan, Unsubscribe with an exit survey, and a "Not seeing your updated subscription?" refresh.
- **Interview Passes**
- **Job Alerts Preference:**
  - **Instant Job Alerts:** toggle "Enable Instant Job Alerts". Copy promises fresh tailored alerts within an hour of posting.
  - **Job Alerts Frequency:** Off / Up to 1 per day / Up to 2 per day / Up to 5 per day / Unlimited. Free is capped at 1 per day; Turbo can go unlimited.
  - **Digest Job Alerts:** toggle "Enable Digest Job Alerts", **Daily Digest** or **Weekly Digest**.
- **Email Providers:** connect an inbox so Jobright can automatically receive the **verification codes** Greenhouse sends during applications. States: Pending, Processing, Connected, Failed, Cancelled.
- Privacy Policy link, **Log Out**.

---

## 17. Notifications and emails

Very few public sources cover email content. Here is what the evidence supports:

- **Marketing opt-in at signup:** the checkbox described in section 4.2. **confirmed**
- **Instant job alert emails** go out within roughly an hour of a matching posting. **Digest emails** go out daily or weekly. Links carry `imp_id=…__instant_push__…` and `…__digest_job_alert__…` and deep-link to `/onboarding-v3/signup?…&from=job_detail&action=apply` when the user isn't logged in. **confirmed** (settings strings plus Wayback URLs).
- **Visitor job-alert subscription** at `/tools/job-alert`, no account needed:
  1. email
  2. resume upload or LinkedIn URL
  3. optional "Job Filters"
  4. Daily or Weekly Digest
  5. Subscribe
  - Unsubscribe lives at `/tools/job-alert/unsubscribe`.
  - These are top-of-funnel emails that later pull people into signup.
  - Source: https://jobright.ai/tools/job-alert. **confirmed**
- **"opentowork" outreach emails** (`imp_id=…__opentowork__…`, `utm_campaign=tal`) deep-link into `/onboarding-v3/diagnostics` or `resume-upload` with a job id. I infer this is talent-outreach or employer-side "open to work" campaigns. **inferred**
- **Referral emails:** the referrer gets an email when a friend signs up and when they finish onboarding. Both earn $3 off Turbo, up to $30. **confirmed** (chunk 78734).
- **Account deletion confirmation email.** **confirmed** (settings).
- **Verification emails:** account and referral verification, student `.edu` verification, and work-email verification for TNT. **confirmed**
- **Sender and unsubscribe:** a third-party guide says emails come from a jobrightai.com sender with a footer unsubscribe link. Source: https://leavemealone.com/how-to-unsubscribe-from/jobrightai. **likely**, single secondary source.
- **No web push or browser notification permission prompt was found** in the bundles. Mobile apps send push for instant alerts, per the store listings ("Instant job alerts"). **likely**
- **Welcome / drip email sequence:** not observable from public sources. **open question**

---

## 18. Upsell and paywall moments in and around onboarding

Account-gated pricing: prices appear only after signup. Reviewers note that `/pricing` returns 404 for seekers. Source: favtutor 2026-08-21. **likely**

### First-day "New User Discount" offer
**confirmed**, chunk https://static.jobright.ai/_next/static/chunks/23996.345a00a73ddce197.js, plus `/swan/payment/first-day-offer`.
- Card titled "Jobright Turbo • New User Discount", showing a percentage off per month or per quarter.
- Value-prop carousel: unlimited 1-click autofill, AI resume tailoring, live career coach, and so on.
- **"Offer Ends in mm:ss"** countdown, **Upgrade Now**, and a close button.
- It is skipped if a ToB direct apply just happened or a "True Apply" failed. **confirmed** (strings).

### Special one-time weekly trial
**confirmed**, chunk 7576:
- "Try Turbo for 7 days" at a discounted weekly price.
- "Turbo users landed interviews at these companies" logos: Google, P&G, OpenAI, Microsoft.
- Testimonials and a countdown.
- Billing note that it renews monthly or quarterly after the trial.
- Stripe checkout.

### Plans
**confirmed** names in chunk 8482: Weekly, Monthly, Quarterly ("Most Popular 🔥"), 6-Month, Student; "Loyal Member Exclusive" and "New User Exclusive" badges.

Reported prices:

| Source | Date | Weekly | Monthly | Quarterly | Notes |
|---|---|---|---|---|---|
| jobity | 2026-08-31 | $17.99 | $39.99 (strikethrough $49.99) | $89.98 (strikethrough $149.97) | |
| favtutor | 2026-08-21 | $17.99 | $39.99 | $89.99 | |
| jobhire | 2026-07 | $14.99 | $29.99 | $69.99 | competitor source |
| The Register | 2025-06 | | ~$30/mo premium | | |

These figures are **likely**; prices vary by A/B group and over time. In-code price group buckets run GroupA-GroupG. **confirmed**

### Free-plan credits
Text is **confirmed** in chunk 8482. Each AI feature costs 1 credit and refills daily up to a cap:
- AI Resume Enhancement: 1 per day
- AI Custom Resume Generation: 2 per day
- Email Connection for Referral: 2 per day

Reviewers also report 4 autofills, 2 cover letters, and 1 alert per day on Free, with a midnight reset and no rollover. **likely**: favtutor, jobity, wobo.

### Other paywalls and upsells
**confirmed** (chunks 9387, 78734, `_app`):
- **Interview question bank:** an "All-Access Interview Question Pass" with a **"Start My 3-Day Free Trial"** offer as a Turbo-member gift. Content is locked behind "Sign Up / Upgrade to Unlock".
- **Insider Connections:** email finder credits.
- **Agent:** waitlist skip.
- **Hidden Jobs**
- **Student plan:** via `.edu` verification.
- **Referral rewards**
- **Win-back:** "A Special Offer to Restart Turbo", plus a loyal-member discount.
- **Cancel-support offer:** `/swan/payment/cancel-support-popup-eligibility`, `/swan/payment/winback-offer`.

Abuse and rate limits shown as toasts. **confirmed** (`_app`):
- daily resume upload limit
- hourly resume-analysis limit
- hourly and daily tailor limits
- hourly email-lookup limit
- hourly job-list refresh limit
- autofill: wait 30 minutes after the limit
- a 7-day suspension notice for ToS violations

---

## 19. Mobile app onboarding

Apps: iOS "Jobright - AI Job Search" (id6738236788) and Android `ai.jobright.orion`.

| | iOS | Android |
|---|---|---|
| Rating | 4.8★ (~1.6K ratings) | 4.6★ (~719 reviews) |
| Notes | age 4+, requires iOS 13 | 50K+ downloads, updated 2026-08-21 |

Sources: https://apps.apple.com/us/app/jobright-ai-job-search/id6738236788 and https://play.google.com/store/apps/details?id=ai.jobright.orion. **confirmed**

- **Store "How it works" (Play):** create a profile and import a resume, then get a daily feed of AI-ranked jobs, auto-apply or fine-tune, and track progress. Both stores say only **U.S.-based roles** are listed. That conflicts with the web bundle's 6-country support, so country expansion may be web-first. **confirmed** for both statements; the reason is **inferred**.
- **Sign-in:** Google sign-in is named in the Play release notes ("smoother Google sign-in"). Apple Sign-In comes from the shared auth component and is required by App Store rules. Email and password is probably also supported. **likely**
- **Mobile onboarding screens:** not publicly documented. The web onboarding pages ship mobile-specific CSS modules (`mobile_onboarding-v3-resume-upload-*`, `job-title-confirmation-checkbox-group-mobile`). So the mobile-web flow mirrors desktop. The native app likely reuses the same stage machine through the API. **inferred**
- **iOS version notes:** multi-resume upload and instant resume analysis (1.9.0, 2025-07-07); Dark Mode (1.10.0, 2025-08-18). **confirmed**
- **Desktop-only steps:** some offers say "Unlock Your Offer on Computer", and the extension is desktop Chrome only. Mobile users are pushed to finish autofill setup on desktop. **confirmed** (strings).

---

## 20. Visitor and logged-out gates (pre-onboarding)

- SEO job pages and job detail are public. Apply, interview questions, and connections require signup. **confirmed**
- Free tools such as the resume checker, cover letter, and job tracker are usable without an account, up to the point of save or export, where signup is required (`from=<tool>`). **likely**, based on the archived `from=` values.
- Lensa-partner visitors are decoded via `/swan/lensa/decode`. **inferred**

---

## 21. Changes over time

| When | Change | Evidence |
|---|---|---|
| Mar 2024 | `/onboarding-v2/signup` in use | Wayback CDX |
| Apr-May 2024 | `/onboarding-v3/*` (signup, mode-selection, diagnostics, career-goals, advanced-preferences, resume-upload) live | Wayback CDX |
| Jul 2024 | Product Hunt #1 Product of the Month; the maker said it was completely free then | https://www.producthunt.com/products/jobright-ai-2 |
| Jun 2025 | Jobright Agent launch (invite beta about 200 users; US tech, education, government jobs); Turbo about $30/mo | https://www.theregister.com/2025/06/24/ai_may_take_jobs_but/ |
| Jul-Aug 2025 | `from=agent` onboarding entry; iOS multi-resume and dark mode | Wayback; App Store |
| 2025 → 2026 | Homepage FAQ still says all features are free and the US is the primary region (stale copy); the in-app product is credit-metered freemium with Turbo | homepage FAQ in a JS chunk vs. reviews |
| 2026 | Country support in onboarding and filters expands to CA, GB, AU, IE, NZ with "Anywhere in X"; store listings still say US-only | diagnostics chunk; store listings |
| 2026 | First-landing "Welcome! We found N roles" review modal with seniority confirmation and acquisition survey; Agent setup wizard; Copilot vs. Agent mode with waitlist | chunks 7769 and agent page; favtutor and jobity |
| Mid 2026 | Monthly Turbo price reported rising from $29.99 to $39.99 | wobo, autogpt, jobhire (competitor sources) |
| Aug 2026 | Android: Orion reviewable filter updates; better location autocomplete | Play "What's new" |

---

## 22. Copy tone

- **Persona-led:** every onboarding step is "spoken" by **Orion** (bird logo, "Your AI Copilot") in first person, with chatty encouragement ("almost there", "one last step", "halfway there", emojis on profile steps).
- **Value before effort:** market snapshot during preferences; "we found N roles" before asking for confirmation; "Seeing some exciting opportunities for you already!" before the resume request.
- **Reassurance at data-entry points:** privacy notes under resume upload, LinkedIn URL, profile, and EEO.
- **Gamified completion:** step counters, "Congrats! You're all set", progress bars, install counts with star ratings.
- **Urgency in monetization:** countdown timers, "New User Exclusive", "Last chance".

---

## 23. Edge cases and error states (summary)

- Duplicate email on signup leads to sign in. Google SSO failure shows a toast. In-app browsers get "Open in Browser" guidance.
- Weak password: fails the 8-character letters-plus-digits rule.
- Job-function rules: none selected; more than 3 specific titles; a too-general title (warning only); conflict with an excluded title.
- No location; no job type; no career goal when advancing (no-rush branch).
- Resume upload failures: file name too long; file too large (over 10MB); wrong type (only .pdf, .doc, .docx accepted); daily upload limit; parse failure, which offers Try again, Upload Resume, or Enter LinkedIn URL.
- LinkedIn URL failures: invalid; not found; activation failed; hourly lookup limit.
- No matches with current preferences: a "what's limiting your search" diagnosis with one-click relaxations.
- Preferences not learnable: an "Update Preferences" re-prompt.
- Expired job clicked from email: copy says the job is no longer available and the recommendations were refreshed.
- Email verification link expired: auto-resend. Opened on another device: "go back to the device where you signed up".
- Extension missing or outdated: install or reinstall flow.
- Account deletion: irreversible warning plus confirmation email.

---

## 24. Implications for the RoboApply clone (dual brand: RoboHire.io international, GoApply.Top mainland China)

All of the following is **inferred**, as recommendations:

1. **Copy the server stage machine.** Use a `currentStage` enum on the seeker record and a client route table, with every step resumable from deep links (job id, `from`, invite code, UTM). RoboApply should add brand and market to the stage context.
2. **Steps to replicate:**
   - signup (Google + email/password; on GoApply.Top use WeChat, phone + SMS OTP, and email, because Google is blocked in mainland China)
   - seeker type (rush / no rush)
   - basic preferences (job function ≤3 specific titles, job type, location + remote, work authorization)
   - optional career goal
   - optional advanced preferences (industry, skills, company stage)
   - resume or LinkedIn URL (Maimai or Liepin profile import on GoApply.Top)
   - analyzing loader
   - "We found N roles" confirmation (seniority, extra functions, acquisition survey)
3. **Market-specific fields:**
   - **International (RoboHire.io, including Taiwan):** generalize "H1B sponsorship" into **visa / work-permit sponsorship by country**. Extend the country list beyond US, CA, GB, AU, IE, NZ to include TW, SG, HK, JP, and the EU. Salary currency should follow the country.
   - **Mainland (GoApply.Top):** replace the H1B and EEO steps. US EEO questions don't apply. Use hukou/city, expected salary in CNY per month with a 13th-month count, notice period, and 应届/社招 (new grad vs. experienced). Acquisition survey options: 小红书, 抖音, 微信, 知乎, B站, 朋友推荐.
4. **Value-before-effort moments:** market snapshot (median salary, hot skills, top industries) during preference entry; matches count before the resume ask.
5. **Profile completion as a separate later wizard,** tied to autofill (the extension) rather than blocking onboarding. Keep EEO optional and market-specific.
6. **Re-onboarding:** a single preference store edited by (a) a 4-section filter drawer, (b) Orion chat with reviewable diffs, (c) zero-result relaxations, and (d) in-feed micro-surveys (thumbs, skill chips, dislike reasons).
7. **Notifications:** marketing opt-in at signup; instant alerts with a frequency cap by plan; daily or weekly digest; visitor email-only alert signup as a funnel. GoApply.Top needs WeChat service-account template messages and SMS in place of email-first.
8. **Monetization moments to decide on:** first-day countdown offer; agent waitlist with paid skip; credit-metered free tier; student verification. RoboApply has an "auto-apply killed" ruling from July 2026 (see memory), so the Agent automated mode and its waitlist should probably map to a supervised "assist" mode only.

---

## 25. Open questions (not resolvable from public sources)

- The exact default state of the marketing opt-in checkbox, and whether it differs by region.
- Whether email verification is ever required before onboarding continues (A/B).
- Native mobile onboarding screens: do they reuse the v3 steps or use a shorter path?
- Welcome and drip email sequence: subjects, cadence, content.
- The exact rule the server uses to pick the rush vs. no-rush path, and whether career goals and advanced preferences are ever shown to rush users.
- Whether `/auth/callback/linkedin` is an active LinkedIn OAuth login, or only for TNT or LinkedIn profile verification.
- How the "opentowork" emails source recipients.
- Current exact Turbo prices per A/B group (GroupA-G) and the first-day discount percentage.
