# resume.io teardown

Reverse-engineering notes on the resume.io web app (`https://resume.io/app`), taken on 2026-11-11 from a signed-in **free** account.

Two sources were used:

- **Static:** all 36 production frontend bundles (10.3 MB of JavaScript, 2,335 modules) downloaded from the public asset path and analysed without running them, plus the public English copy bundle (6,090 strings).
- **Live:** a read-only walk through the signed-in app, recording which requests each screen makes and the *shape* of each response (field names and types, not values).

Each claim below is marked where it matters as **observed** (seen on screen or in a response), **in code** (the client contains it, but it was not exercised), or **inferred**. The full endpoint list is in [API_SURFACE.md](API_SURFACE.md). Gaps are listed in [What is not known](#what-is-not-known).

## What resume.io is now

resume.io is no longer only a resume builder. It is branded "resume.io by career.io" and the app is a job-search suite the code calls the **super app** (`superApp` is the most-referenced feature flag). The resume builder is the entry point and the paywall; everything else is there to keep a subscriber busy between "resume done" and "job found".

The suite, in the order the sidebar presents it:

| Sidebar item | Route under `/app` | Flag | What it does |
|---|---|---|---|
| Dashboard | `/` | `dashboardV2`–`V4` | Four goal tabs with progress meters, then recommended jobs |
| Documents → My Resumes / My Cover Letters | `/resumes`, `/cover-letters` | — | Document list, score badge, export, "Tailor to job listing" |
| Documents → Hire Resume Writer | external link (not followed) | `resumeWriting` (inferred) | Hand-off to a paid resume-writing service; the code points at the sister brand TopResume |
| Jobs | `/job-search` | `jobSearch`, `jobSearchV2` | Job board: 8.07 M searchable jobs, 100 recommended, two-pane list and detail |
| Job Tracker | `/job-tracking` | `jobTracking` | Kanban board of job cards |
| Auto Apply | `/auto-apply` | `autoApply` | Prepared-then-reviewed applications, paid for in credits |
| Interview Prep | `/interview-preparation` | `interviewPrep` | Spoken mock interviews with transcription |
| Salary Analyzer | `/offer-analyzer` | `salaryAnalyzer` | Three-step offer check, US only |
| Resume Distribution | `/resume-distribution` | `resumeDistribution` | Sends the resume to recruiters, six countries |
| Job Search Method | `/career-plans/execute-a-job-search` (inferred) | `jobSearchPlan` | A five-part written course (Master Plan, Brand Yourself, Get More Meetings, Interview and Win, Close the Deal) |
| Coaching | `/career-coaching` | `careerCoaching` | Human coach marketplace, sold per session |
| Other | `/career-plans/*`, `/career-path`, `/explore-careers` | `careerPlans`, `careerPath` | Custom career plan, First 90 Days, Get a Promotion, career pathways, role explorer |
| Profile (avatar) | `/career-profile/profile` | `careerProfile` | Career profile, completeness meter, assessment, insights |

An "Ask AI coach anything" chat bar floats over most screens, and "Ask AI writer" floats over the editor.

## How it is built

### Frontend

- Single-page React **18.3.1** app mounted at `/app`, built with **rspack 1.7.6** (project name `resume-io-frontend`). One 6 KB runtime entry loads seven chunks up front and 26 more on demand. Named lazy chunks show how the team splits the product: `career-coaching`, `career-plans`, `career-profile`, `critiques`, `job-tracking-board`, `offer-analyzer`, `resume-distribution`, `pdf-preview-renderer`, `rendering-core`, `new-rich-text`, `session-replay`, `misc`.
- No source maps are published. Sentry debug IDs are embedded; the release id is the literal string `staging`.
- State: Redux with **redux-saga** for the older builder code, and a query-cache library whose options match **TanStack Query v4** (inferred from option names) for newer features such as Auto Apply and the dashboard. Both live side by side.
- Routing: react-router v6, about 105 route patterns. Feature-gated routes redirect to `/` when the flag is off.
- Styling: styled-components. Rich text: ProseMirror with tiptap. Forms and validation: zod and yup. Other bundled libraries: axios, pdf.js, Adyen Web drop-in, swiper, lottie, DOMPurify, moment, date-fns, lodash.
- Copy: fetched at boot from `GET /api/app/translations/en/builder`. 37 locales are offered in the editor.

### Backend, as seen from the client

- CloudFront in front of an AWS load balancer. Response headers (`x-runtime`, `x-request-id`, `etag`) are consistent with a Rails app (inferred).
- The client uses three HTTP bases:
  - `/api/app/*` — the original builder API. camelCase JSON.
  - `/api/*` — newer services. Mostly snake_case, and versioned per service: `jobs/v1`, `career/v1`, `career-data/v1`, `job-alerts/v1`, `ai_coach/v1`, `interview_prep`.
  - `/app/billing/*` — billing controller.
- `career-data/v1` returns validation errors in the FastAPI/pydantic format (`{"error":{"detail":[{"type","loc","msg","input"}]}}`), so at least that service is Python behind the same gateway (inferred).
- Separate hosts do the heavy or specialised work:

| Host | Job |
|---|---|
| `ssr.resume.tools` | Server rendering: `to-pdf`, `to-docx`, `to-image`; also issues voice-dictation tokens |
| `spell.resume.io` | Spellcheck |
| `bg-service.resume.io` | Photo background removal (`/rembg`) |
| `mcp.resume.io` | Their MCP server; the guest builder imports resumes drafted through it |
| `cio-rendering-fonts.resume.io` | Fonts for the renderer |
| `headsome.resume.tools` | Generated avatars |
| `s3.resume.io` | Uploads |
| `lloyd.career.io` | Cross-product sign-in with career.io |

### Auth

- A JWT is kept in `localStorage` under `API_ACCESS_TOKEN` and sent as `Authorization: Bearer`. `GET /api/app/account` returns the user plus a fresh `jwt` and `jwtExpiresAt`; `POST /api/app/auth/refresh` and `POST /api/app/account/extend-jwt` renew it; `DELETE /api/app/auth` logs out.
- Session cookies also authenticate: plain cookie-only GETs succeeded during the walk (observed).
- Sign-in methods in code: password, emailed magic link, Google, LinkedIn, Facebook, and a token hand-off between resume.io and career.io.
- reCAPTCHA Enterprise is loaded in the app.
- A response may carry an `x-api-token` header; when it does, the client replaces its stored token with it.
- A test hook ships in production code: when `window.isPlaywright` is set, each request gets an `x-playwright-request-counter` header.

### Third parties loaded in the app (observed)

Mixpanel, Google Tag Manager served first-party from `/metrics` (via Stape), GA4, VWO for A/B tests, Microsoft Clarity, Sentry, Help Scout Beacon, ActiveCampaign, Impact (affiliates), LinkedIn Insight, Bing UET, an OpenAI measurement pixel (`bzr.openai.com`), Trustpilot. Billing is Chargebee with Adyen (a `paddleBilling` flag on plans routes some plans to Paddle). Coaching bookings use Calendly.

## Documents and the editor

### Data model

A resume is one flat record plus ordered sections. Fields seen on `GET /api/app/resumes/:id`:

- Identity and layout: `id`, `name`, `template`, `color`, `spacing`, `locale`, `sectionsOrder[]`, `sectionTitles{}`, `templateSettings{}`, `version`, `renderingToken`.
- Person: `firstName`, `lastName`, `position`, `email`, `phoneNumber`, `city`, `countryName`, `address`, `postalCode`, `linkedin`, `avatar{}`, `profile` (the summary), plus many locale-specific fields (`birthDate`, `nationality`, `drivingLicense`, `married`, `commutingTime`, name pronunciation — these support Japanese and European formats).
- Scoring and lineage: `score`, `averageScore`, `originalResumeId`, `autoTailored`, `aiTaskId`.

Section types in code: `profile`, `workExperiences`, `educations`, `courses`, `internships`, `activities`, `conferences`, `volunteerings`, `skills`, `skillCategories`, `languages`, `hobbies`, `references`, `socialProfiles`, `accomplishments`, `publications`, `powerStatement`, `qualifications`, `technicalSkills`, `custom`.

The document list merges four sources: `/api/app/resumes`, `/api/app/cover-letters`, `/api/documents` (uploaded and TopResume-written files), and `/api/tailored_resumes`.

### Templates are data

`GET /api/app/general/editor-payload` returns the whole catalogue: **38 resume templates, 30 cover-letter templates, 37 locales, 23 resume categories**, skill and language level scales. Each template carries its own capability flags and limits rather than the client hard-coding them:

- Flags such as `isAts`, `hasTwoColumns`, `supportsPhoto`, `supportsCustomColor`, `supportsSkillCategories`, `premium`, `isExpertTemplate`, `supportedFormats` (PDF, DOCX).
- Ranged settings with `default/min/max/step`: page margins, spacing between sections and cards, four font sizes.
- Choice settings: fonts, font weights, date format, header/date/location alignment, skills layout, education layout and order.

The editor's Customize tab (Template & Colors, Text, Layout) is generated from this. Template filters shown: All, With photo, Two column, ATS, DOCX, Experts, Customizable, Free.

### Editor layout (observed)

- Top tabs: **Edit**, **Customize**, **AI Review**, **Tailor** (badged NEW). A Download menu offers PDF, DOCX, TXT.
- Left: collapsible form sections. Right: a live page preview with page navigation.
- A completeness bar sits above the form with scored nudges: "+5 Add job title", "+3 Add languages", "+2 Add internships", and AI shortcuts ("Try AI profile summary", "Create quick cover letter").

### Rendering pipeline

This is the most reusable engineering idea in the product.

1. **Preview, in the browser.** The resume JSON is posted to a Web Worker (`/assets/workers/rendering.<hash>.js`). The worker builds a React element for the chosen template and calls `pdf().updateContainer(...).toBlob()` with a hyphenation callback — the public API of `@react-pdf/renderer` (library identity inferred from the API shape). The result is a real PDF, in memory.
2. **Display.** pdf.js paints that PDF onto two stacked `<canvas>` elements (1320×1708 on a retina screen), a primary and a secondary, and swaps between them so an edit does not blank the page (the swap is read from code, not timed). Tasks are queued one at a time with a 10-second timeout; on failure the worker is killed and the preview falls back to server images.
3. **Download, on the server.** The final file comes from `ssr.resume.tools/to-pdf/<renderingToken>` or `/to-docx/…`, authorised with a token the client fetches just before the download. Thumbnails everywhere else are `to-image/<renderingToken>-<page>.webp`.

So what the user sees while typing is the same PDF layout engine that produces the download, and the paywall sits only on the server-side download step.

### Scores

- **Resume score** (the 95% badge): a completeness score computed server-side, with the per-field nudges above.
- **AI Review**: `GET /api/app/resumes/:id/ai-resume-full-review/last-review` returns `scoreHeadline`, `scoreContent`, `topStrengths`, `priorityFixes`, `quickTips`. The tab renders these as a one-word rating, Strengths, "Make these changes", and Quick tips, with a Refresh button (`POST …/ai-resume-full-review`).
- **Job match score**: produced by the tailoring flow below.

## AI features

All AI calls are plain request/response. No streaming was found in the client.

| Feature | Call | Notes |
|---|---|---|
| AI writer chat in the editor | `POST /api/app/ai-copilot/chat` | Reply includes `assistantMessage` and `changes[]` the user can apply to the resume; can also save an AI review |
| AI coach chat | `POST /api/ai_coach/v1/ai_coach/prompt` with `{prompt, chat_history, database_history}` | Reply is `{response, url_links}`; history at `…/history` |
| Phrase and field suggestions | `GET /api/app[/section]/suggest/:field`, `GET /api/app/phrases/:section/search` | Pre-written phrases, usage tracked per phrase |
| AI cover letter | `POST /api/job-postings/generate-cover-letter`, `…/regenerate-cover-letter` | Generated against a job posting. An AI profile summary also exists; its call was not traced |
| AI resume draft by questionnaire or voice | `PUT /api/app/ai-resume-draft/:id` | See below |
| LinkedIn prefill | `PATCH /api/app/linkedin-data-profile/prefill-resume?linkedin_profile=…&ai_enhanced=true` | Builds a resume from a LinkedIn URL |
| Resume upload and parse | `POST /api/builder/resume_upload/upload_and_parse`, `POST /api/app/resume-parser/parse-resume` | |
| Expert critique | `POST /api/app/resumes/:id/critique`, `send-to-review` | Appears to be routed to the TopResume side (inferred from `tr-*` endpoint names) |

**Voice dictation** is direct browser-to-OpenAI: the client asks `ssr.resume.tools/openai-realtime-token` for a short-lived key and opens `wss://api.openai.com/v1/realtime` itself for speech-to-text. Their servers never carry the audio.

Free accounts hit a limit modal: "You've reached the AI limit for your free account."

## Tailoring a resume to a job

Called "resume optimizer" in code. The Tailor tab takes a pasted job link or a pick from the job board. The sequence, from the sagas:

1. `POST /api/job-postings` — creates a job posting from the URL, from manual title/company/description, or from a board job. If the link cannot be read, the UI falls back to manual entry.
2. `POST /api/resumes/:id/scoring` with `{jobPostingId}` — returns the match: `requirements[]` and `niceToHave[]`, each with an `evidence` string drawn from the resume, plus `score.finalWeightedScore`. The UI bands the score as "Needs work", "Strong match", or "Excellent match".
3. The user may edit the evidence per requirement.
4. `POST /api/resumes/:id/tailoring` with the score, the edited evidence and the posting id — returns `updatedResume`. Tailoring writes to a **copy**; the original is kept.
5. A before/after review per section (Job Title, Professional Summary, Skills, Work Experience) with "Discard changes" / "Reapply changes" and a short "why we changed this" note for each.

Tailoring refuses to start without a summary and at least one work experience.

## Jobs

- Search: `GET /api/jobs/v1/search` (filters: workplace type, employment type, posted date, experience level, minimum salary, radius). Recommendations: `GET /api/career/v1/recommended-jobs`. Both return the same job record.
- A job record has two layers. Raw feed fields: `job_title`, `company`, `location`, `url`, `feed_name`, `posted_at`, `expired_at`, `external_slug_id`. Enriched fields, present when `enriched` is true: `job_summary`, `requirements[]`, `nice_to_have[]`, `skills[]`, `seniority_level`, `employment_type`, `job_location_type`, `hiring_scope`, `industry`, `occupation`, salary range, and a normalised `location_details` object with coordinates.
- Each job carries **`auto_apply_compatible`**, which drives the "Auto Apply" badge on cards.
- Recommendations report whether they were derived from the resume (`location_from_resume`, `target_role_from_resume`).
- Job alerts: one recommendation subscription per user (frequency, channels) plus custom saved-search subscriptions.

## Job tracker

A Kanban board. Card statuses in code: `recommended`, `wishlist` (labelled Shortlist), `auto_apply`, `applied`, `interview`, `offer`, `rejected`, `deleted`. Columns seen: Recommended, Shortlist (with "Apply To All"), Auto Apply, Applied.

A card holds the job, notes, salary, tags, a linked resume and cover letter, and all Auto Apply state. Free accounts are capped at 3 cards (from the paywall copy). Shortlist cards show a "Does your resume match well with this job?" score teaser.

## Auto Apply

The largest feature by volume of copy (359 string keys referenced) and one of the most instrumented (59 `aa_*` analytics events).

### Flow

1. **Setup wizard**, four steps: documents, screening, recommendations, notifications.
   - *Screening* collects the answers employers ask for: name, email, phone, address, LinkedIn, current title, current and desired salary, experience summary, countries eligible to work in, visa sponsorship, languages, driving licence, GPA, security clearance, date of birth, and the US equal-opportunity set (gender, ethnicity, disability, veteran status).
   - *Recommendations* sets target job titles and locations or remote.
   - *Notifications* sets email frequency. SMS is marked "coming soon".
2. **Pick jobs.** From the board or tracker; "Apply To All" on the shortlist.
3. **Preparing.** "We're tailoring your documents and collecting the employer's questions."
4. **Prepared.** The user opens an application drawer, reviews the tailored resume, cover letter and every answer, edits anything, and submits. An answer can be saved "for all" future applications (`memoryAnswers`).
5. **Processing.** "We'll submit your application within 1 working day."
6. **Outcome.**

The copilot record has a `reviewBeforeSubmit` setting, so skipping step 4 is modelled; the marketing copy leads with review ("Stay in control: review and edit every AI-generated answer before we apply on your behalf").

### States

`autoApplyStatus` on a job card:

| Status | Shown to the user as |
|---|---|
| `preparing` | Preparing — tailoring documents and collecting questions |
| `prepared` | Ready to submit |
| `processing` | Applying — submitted within one working day |
| `information_required` | Action required — "check your email inbox" |
| `auto_applied` | Auto applied — submitted documents are attached to the card |
| `error` | Error — details in the card's notes |
| `no_application_made` | No application made — "Your credit has been refunded" |
| `auto_tailoring_failed` | Tailoring failed — retry, or continue with the untailored version |

The client polls `GET /api/job-cards/statuses` every 15 seconds while any card is `preparing` or `processing`.

### Who actually submits

The job card has an `autoApplyProvider`. Two values appear in code: `manual`, which the UI labels "prepared by team", and `universal_aa`, which has its own status field. There is also an `isAgentAssigned` flag, and older copy says "Human expert apply for you" and "Our expert Job Specialists". So submission is a mix of people and automation (inferred); the split is not visible from the client.

### Credits

`account.user.scopes.autoApply` holds `creditCount`, `creditCountMax`, `creditCountUsed`, `creditResetTimes`, `autoApplyPlanType`. A free account has 1 credit. Premium includes 20 per day. Extra packs are sold as recurring add-ons (below).

## Other modules

- **Interview Prep.** Enter a job title and optional company; questions come from a per-title template bank. Questions are read aloud (`…/stream_audio`). Answers are spoken: an AudioWorklet chunks microphone audio and sends base64 frames over a WebSocket obtained from `GET /api/interview_prep/ws/presigned_url`; the server pushes back `transcription` messages. Follow-up questions, a question library and company-specific interviews are in code.
- **Salary Analyzer.** Three steps starting with title, company, location. US only. In code it posts to `offer-analyzer/internal_create` and reads `career-data/v1/salary`.
- **Resume Distribution.** A questionnaire (name, title, location, industry, remote preference, excluded companies), then the resume is sent to recruiters. Works in the US, UK, Canada, Australia, the Netherlands and Germany. Pitched as "50 recruiters per week".
- **Career profile.** A second copy of the person's data, separate from any resume (`GET /api/career/profile`), with target roles, salary range, work-authorisation and screening answers. It feeds recommendations and Auto Apply. Completeness is scored and nudged the same way as the resume.
- **Coaching.** Marketplace of human coaches in 10 service areas and 3 seniority levels.
- **Career plans and pathways.** Mostly written content with progress tracking (`career-planning/*`), plus a role explorer backed by `career-data/v1`.

## Dashboard

The home screen asks "What's your goal today?" and offers four tabs. Each tab is a list of services with a progress value, from `GET /api/stepper/dashboard`:

| Tab | Services tracked |
|---|---|
| Resume Building | Resume Building, Resume Tailoring, Resume Distribution, Cover Letter Crafting |
| Job Search | Apply for Jobs, Resume Distribution, Job Search Strategy |
| Interview Prep | Interviews Practiced, Questions Practiced, Interview Strategy, Interviews Passed |
| Learning | 90 Days Plan, Get Promotion, Change Careers |

Selecting a service swaps the hero card beside it for one call to action. Below sits "Your job matches". The effect is that every product in the suite has a visible, incomplete meter on the first screen.

## Monetisation

Prices as returned for this US-dollar account on 2026-11-11.

| Plan | Price | Notes |
|---|---|---|
| 7-day trial | $2.95 | Renews at $29.95 every 4 weeks. Labelled "Most popular" |
| Quarterly | $49.95 per 3 months | Shown as $16.65/mo. No trial |

Both include 20 Auto Apply credits per day and resume distribution.

| Add-on | Price |
|---|---|
| Auto Apply credit packs, recurring: 10 / 20 / 50 | $8 / $10 / $35 |
| Resume review | $20 |
| Coaching: 1 / 4 / 6 sessions | $79 / $269 / $359 |

How the paywall works:

- **The download is the gate.** Building, editing, previewing, AI review and job search are free. The plans page is framed as step 2 of four: Create resume → Choose plan → Payment details → Download resume.
- The plans page uses live-looking social proof ("2,936 people chose this in the last 24 hours"), a Trustpilot count and a money-back line.
- Which plans page a user sees is server-chosen: `GET /api/app/billing/plans/scenario` returned `default`. A similar `scenario` switch exists for the resume-review feature.
- **Cancelling is a funnel**, now in its sixth version by flag name. The client can offer: a reminder of unused Auto Apply credits, feature social proof, a percentage discount on future payments, a free pause period, and a "stay in touch" discount (the order was not traced). The account record tracks which offers a user has already taken.
- Once a cancelled subscription lapses, the copy says the user "will no longer have access to your documents" on the free plan; a "Keep my data" button restarts the subscription.

## Analytics and experiments

- **627 distinct first-party event names** are sent with `navigator.sendBeacon('/api/reporting/event/<name>', {params})`, each stamped with screen size, referrer and UTM values. This runs alongside Mixpanel and GTM, so product analytics do not depend on third-party scripts loading.
- Feature flags arrive in the boot config. About 70 flags are named in code, including `superApp`, `autoApply`, `aiWriter`, `aiReviewV2`, `aiCoverLetters`, `aiResumeDraft`, `aiProfileSummary`, `resumeOptimizer`, `builderAutotailoring`, `autotailoringFromJobBoard`, `jobSearchV2`, `jobAlerts`, `companyPages`, `careerProfile`, `professionalHeadshot`, `subCancellationV4`–`V6`, `plansPageAbandonment`, `inBuilderAbandonment`, `disableSignUp`.
- Per-user UI state (tours seen, promos dismissed, stepper progress) is stored server-side in `account.user.uiStates` and patched through `PATCH /api/app/account/ui-states`.

## What is not known

- **Flag values for this account.** `GET /api/app/config` returned `{}` when requested directly, so flag names come from code only.
- **Anything behind the paywall.** The account is free: no real download, no Auto Apply run, no interview session, no coaching booking was performed. Those flows are described from code and copy.
- **How Auto Apply submits.** The provider names are visible; the automation, the human team's tooling, and the share of each are not.
- **The scoring response in full.** Field names come from how the client reads it, not from a captured response.
- **Server internals.** Rails and FastAPI are inferences from headers and error formats. Which model or vendor powers each AI feature is not visible, apart from OpenAI Realtime for dictation.
- **The rendering library.** The worker's calls match `@react-pdf/renderer`; the package name itself does not appear in the minified worker.
- A path in [API_SURFACE.md](API_SURFACE.md) is one the client can call. It is not proof the route is enabled for every account. Four cancellation calls are written in the client as `/api/api/builder/subscription/*`, which may be a client bug.

## Method and evidence

- Bundles: entry `https://resume.io/assets/js/builder-729c146b.js`, its 33 chunks and 3 stylesheets, and the rendering worker. Parsed with REA `analyze_javascript_application` (34 files, 33 parsed, 2,335 modules, no parse failures; session evidence `ev_4882bc3a…f774e`, coverage reported as partial for cross-module relationships). Endpoints, routes, enums and flags were then pulled with targeted searches over the same files.
- Copy: `https://resume.io/api/app/translations/en/builder`, public, 88 namespaces.
- Live walk: the signed-in session in Chrome. Screens visited: dashboard (all four tabs), documents, the editor's four tabs and download menu, jobs, job tracker, Auto Apply landing, interview prep start, salary analyzer, resume distribution, plans, career profile, coaching, career path, explore careers, account settings. No form was submitted, nothing was edited, no setting changed, nothing downloaded or purchased.
- Response shapes were recorded value-free. No personal data from the account is reproduced here.
- One incident: after a burst of 26 parallel read-only requests, resume.io answered 503 for several minutes, then recovered. Whether that was a rate limit or an unrelated outage is unknown. Any repeat of this work should pace its requests.
- Raw downloads were kept outside the repository in a temporary folder and are not committed. They can be fetched again from the URLs above; chunk hashes will change with each resume.io release.

## Reading this for RoboApply

My interpretation, not findings.

- **Their Auto Apply is "prepare, review, submit", not blind auto-submit.** The default has the user approve tailored documents and every answer, then promises submission within a working day and refunds the credit on failure. That is close to RoboApply's "Prepare application" stance, and it suggests the market leader also found unattended submission hard to stand behind.
- **Saved answers are the durable asset.** The screening profile plus "save for all" answers is what makes the second application faster than the first. Their field list above is a ready checklist.
- **Credits make cost and value legible.** One credit per application, a daily allowance, refund on failure, add-on packs.
- **Preview and download share one layout engine**, with only the download on the server. It gives an honest preview and a clean paywall point.
- **Tailoring shows its evidence.** Requirement-by-requirement evidence that the user can correct before the rewrite, a copy rather than an overwrite, and a per-section reason for each change.
- **Things not to copy.** The six-step cancellation funnel and "chosen in the last 24 hours" counters are pressure tactics; they sit badly with a product positioned on transparency.
