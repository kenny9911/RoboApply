# RoboApply Overhaul Spec

> Status: **BINDING**. Author: Design Lead. Date: 2026-07-26. Base commit: `127da1d`.
> This document supersedes every prior design note, panel report, and recon memo. Where an expert
> recommendation is not reflected here, it lost. Reasons are stated inline.
> Pre-launch: no user data, no migration debt, no back-compat obligation. Delete freely.

---

## 0. The one-sentence product

**RoboApply reads your resume, finds the jobs you can actually get, tells you honestly why you fit and what's missing, fixes your resume for each one, and drills you for the interview.**

In the user's words, on the landing page:

> **"Stop guessing which jobs are worth your time."**
> Drop your resume. We read 1,000+ open roles and show you the ones you can actually get — with the
> real reasons you fit, and the exact words your resume is missing. Then we help you fix it and
> practice the interview.

Everything downstream serves that sentence. Four verbs, in order: **find → understand → fix → practice.**
Four destinations, one per verb. Anything that is not one of those four verbs is a view, a tab, a
filter, or it is deleted.

What we are **not**: a robot that submits applications for you. We do not say "We apply. You interview."
again until a real submission engine exists, and it does not exist in this spec.

---

## 1. Decisions (the binding list)

### D1 — RoboApply does not apply on your behalf. Auto-apply is deleted, not deferred.

**DECISION.** The product never claims to submit anything to an employer. The primary job action is
`Apply on company site` (opens `job.applyUrl` in a new tab). A secondary action `Mark as applied`
writes the tracker row. The tagline becomes `Stop guessing which jobs are worth your time.`

**WHY.** Three independent reasons, any one of which is sufficient.
(a) It does not work. `POST /v2/jobs/:id/apply` (`server/src/roboapply/v2/routes/jobs.ts:119-141`) is
one line: `raTrackerService.upsertForJob(userId, jobId, { status:'applied' })`. Nothing leaves the
building. The UI then renders `today.appliedBanner` = *"Sent. Cover, tailored resume, and screening
answers submitted."* — three fabricated artifacts in nine words, on the first screen a new user sees.
A user who believes it stops applying and loses the role. That is a liability, not a bug.
(b) It is a losing hill. Simplify owns the mechanical form-fill, free, as a browser extension living
where the forms are. Sonara and LazyApply own the category and its reputation.
(c) It is the root noun. `agent` exists to have an `aggressiveness`; `aggressiveness` exists to feed
an `orb`; the `queue` exists to hold what the agent sent; `threshold` exists to gate the queue;
`consent layer` / `review hold` / `veto` / `staging` exist to reassure you about the queue. Pull
auto-apply out and **eleven user-facing nouns fall over with it.** No other single cut buys that much.

**WHAT DIES.** `/queue` route + `app/(auth)/queue/page.tsx` + `components/v3/queue/*` + the `queue`
i18n namespace (37 keys × 4 locales) + `QUEUE_REVIEW_ENABLED` + `JobApplyingGate` + the
`Schedule auto-apply` button + `today.appliedBanner` + `today.stats.autoApplied` +
`preferences.agent.aggressiveness` + `dcTheme.aggressiveness` + `OrbCard` + `dailyCap` +
9 landing hero-log lines + 6 landing "review hold" claims + `app.tagline`.

**NOT DYING (this is an AI capability, not theatre).** `RoboApplyAuthorAgent`
(`server/src/roboapply/agents/RoboApplyAuthorAgent.ts`) and its CitationGuard survive, repointed:
cover-letter generation becomes an explicit on-demand action on a job detail page
(`Write a note to the hiring manager`), not an automatic per-application artifact. See D13.

---

### D2 — Four top-level destinations. Not five, not six. Settings is not a destination.

**DECISION.** `/jobs` · `/resume` · `/applications` · `/practice`. Plus an avatar menu (top-right on
desktop, top-right on mobile) containing Settings, Billing, Sign out. The mobile bottom bar holds
exactly the four, same labels, same order. **The mobile bar is the IA.** If it does not fit in the
bar, it is not a destination.

**WHY.** Each destination answers a question a job seeker says out loud: *what should I apply to? ·
is my resume good enough? · where did I apply? · am I ready to talk to them?* Today's ten
destinations (Today, Review queue, Resume builder, Mock interview, Pipeline, Activity log, Replay
onboarding, Tweaks, Preferences, Plans, Account) answer none of them — they are our object model
(match table, run table, tracker table, event table) wearing nav labels. Also: `styles/v3.css:3041`
hides the sidebar below 760px and `MobileNav` ships 4 tabs, so a phone user today **cannot reach
billing or cancel a subscription at all.** Making the mobile bar the source of truth closes that
permanently.

**WHAT DIES.** `/home`, `/queue`, `/tracker`, `/activity`, `/preferences`, `/plans`, `/account`,
`/choose-plan` as destinations. The `Replay onboarding` nav item. The `Tweaks` slide-over.

---

### D3 — One noun per object. Route = nav label = page H1 = i18n namespace.

**DECISION.** The five product nouns are: **job · application · resume · practice interview · match**.
Nothing else may name a first-class object. `/jobs` is labelled `Jobs`, its H1 is a sentence about
jobs, and its namespace is `jobs`.

**WHY.** Today 8 of 10 destinations have 2-4 names. "Today" routes to `/home` with namespace `today`
and a dead namespace `home` whose `page_title` is "Home", and an H1 reading *"I worked the night shift ☕"*.
A user who bookmarks it cannot find it again; a user who reads the URL bar gets a fifth answer. A
screen a user cannot name is a screen they cannot return to.

**WHAT DIES.** 12 dead namespaces (501 en strings, 20.3% of `en.json`) — they are where the competing
vocabulary lives ("Mission Control", "Job Tracker", "funnel", "bucket", "Coming in V2.1"), so any
future writer grepping for prior art finds contradictions.

---

### D4 — No agent persona. The AI is plumbing, a verb layer, and exactly one place.

**DECISION.**
- **Plumbing (invisible):** matching, scoring, ranking, parsing. Zero nav presence, zero status lines,
  zero orb, and the word `agent` never appears in the UI.
- **Verbs (attached to objects):** `Tailor to this job` on a resume, `Practice for this role` on a job,
  `Why this fits` on a match, `Rewrite this bullet` in the editor.
- **A place, exactly once:** `/practice`, because a live voice interview genuinely has a start, an end,
  and a result.

**WHY.** In 2023 an orb with a personality signalled "there is a model in here." In 2026 every product
has models in it, so a persona signals only that you had nothing else to show. The orb is worse than
neutral: `OrbCard.tsx:47` renders `Agent · full auto` from a **localStorage** value that controls
nothing, above `Idle · queue clear ✓` referring to a disabled route, while the server-side preference
may say Manual. Every claim on that always-visible card is false.

**WHAT DIES.** `components/v3/shell/OrbCard.tsx`, `components/dc/AiOrb.tsx`, `nav_v3.agent_state`,
`nav_v3.status_idle`, `nav_v3.status_crosscheck`, `nav_v3.aggr_*`, `nav_v3.brand_tagline`
("YOUR AI JOB HUNTER"), `--grad-orb`, `--grad-tri`, `.orb-*` CSS.

---

### D5 — First person survives in exactly two surfaces. Everywhere else the product speaks neutrally.

**DECISION.** "I" / "we" is permitted **only** in (a) match reasoning — `Why this fits` — and (b) the
resume coach's suggestions. Everywhere else: neutral product voice, second person for the user.
All five error strings are rewritten to say what happened and what to do.

**WHY.** 95 strings currently speak in first person and the persona is applied inconsistently, so it
reads as sloppy rather than warm. It is actively harmful in two places: errors
(*"Something hiccuped on my end"* makes a 500 sound like a colleague's excuse and gives no next step)
and settings labels (*"When I should tap your shoulder"* — a form field is not a conversation).
Worst of all, first person makes false claims sound like personal promises: *"I'll auto-submit each
one when its timer runs out"* is a lie told in the first person. Also: ja already drops the "I", zh
keeps 我, and ja/ko force a politeness-register decision the English source never makes — so every
translator guesses differently.

**WHAT DIES.** 93 of the 95 first-person strings. "on your behalf" (×5), "on my end" (×5),
"while you slept" (×3), "you're the boss", "babysit".

---

### D6 — One typeface. Inter Variable. Mono and serif are not UI fonts.

**DECISION.** `app/fonts/inter-100-900.woff2` (48,432 B, wght 100-900, already in the repo) becomes
the single UI family, exposed as `--font-ui`. JetBrains Mono and Instrument Serif are removed from the
UI entirely. Numeric alignment is achieved with `font-variant-numeric: tabular-nums`, which costs zero
bytes. Resume-picker faces are lazy-loaded inside `/resume/[id]` only.

**WHY.** The CEO's "fonts are too random" is a measurable condition, not a mood: 3 families rendering
simultaneously, **31 distinct sizes** (8 of them half-pixel), 23 letter-spacing values, 18
line-heights, 6 weights. 82 declarations argue over the half-pixel between 12.5px and 13px. And
Space Grotesk is a geometric display face with closed apertures that degrades below 14px — while 38%
of the app's text is set below 12px. Those two facts cannot coexist. "Natural to users" has a precise
typographic meaning: a face the reader's eye is already trained on, high x-height, open apertures,
unambiguous 1/l/I. Inter is the closest the web has, and being everywhere is the feature.

**WHAT DIES.** 8 of 11 loaded families on the critical path; 710.5 KB of preloaded fonts (of which
295.2 KB is **byte-identical duplicates** — `space-grotesk-400/500/600/700` are the same file, ditto
`jetbrains-mono-400/500/600`, `roboto-400/500/700`, `merriweather-400/700`) becomes ~48 KB.
137 `var(--mono)` rule-blocks. 15 `var(--serif)` rules + 25 `<em>` call sites across 24 files.

---

### D7 — Eight type sizes. 12px hard floor. No uppercase micro-labels. No half-pixels.

**DECISION.** The token table in §4 is the complete set. Any `font-size` outside it fails CI.
`text-transform: uppercase` is banned in the app UI (all 78 declarations removed).

**WHY.** 141 declarations sit below 12px; 78 of those are also ALL-CAPS; 86 of them are painted in
`--muted` #7C7E91 which computes to **4.37:1 on `--surface`** and **3.99:1 on `--surface-2`** — a fail.
The shipped worst case is 9.5px, uppercase, 0.16em tracking, in a failing grey, on a card. All-caps
destroys word-shape cues at exactly the sizes where the reader most needs them. Uppercase + monospace
+ wide tracking + 10px is the visual grammar of a terminal, applied to a consumer product used by
anxious people.

**WHAT DIES.** 23 of 31 sizes, all 8 half-pixel values, all 141 sub-12px declarations, all 78
uppercase declarations, 20 of 23 tracking values, 15 of 18 line-heights, weights 300 and 800.

---

### D8 — Two themes. Light is the default. One brand colour, not user-selectable.

**DECISION.** Light (default) and Dark. The `warm` theme is deleted. `data-accent` is deleted. Brand
is `#0B6E8C` (light) / `#4FC3E8` (dark). Theme control lives in Settings → Appearance and in the
topbar toggle. Nothing else is themeable.

**WHY.** Four accents × three themes = 15 accent definitions and a 12-way QA surface — and two of the
four ship illegible buttons in the *default* theme: white on pink `#FF6B9D` = **2.68:1**, white on
violet `#8B5BFF` = **4.17:1**. A brand the user can repaint is a brand that never had a position.
Light default because the product is used in daylight, on phones, by people deciding whether to trust
it with their career; dark-neon reads as a crypto dashboard. Dark stays first-class — that is where
"modern" lives, and job seekers do search at night.

**WHAT DIES.** 12 `[data-accent]` blocks, the `warm` scope (~90 declarations), the `--vb-*` palette
(30 tokens), the `--dc-*` shim (~35 aliases), 46 accent-glow box-shadows, 126 raw gradient calls
minus one.

---

### D9 — The product never displays a number it did not measure.

**DECISION.** Every figure on screen must be traceable to a real row or a real computation. Any metric
we cannot compute is removed from the UI, not zeroed, not estimated.

**WHY.** `RAActivityService.orbStats()` hardcodes `scannedOvernight: 0` and `replies: 0` with in-code
comments admitting the gap; `matchedAboveThreshold` reads the pending count of a disabled queue;
`hoursSaved = sent × 9 / 60`. Net effect for a new user on the front door: headline
*"0 applications shipped overnight."*, sub *"0 jobs scanned, 0 cleared your threshold, 0 auto-applied."*,
three stat tiles at 0. A job seeker who has been rejected ninety times has a very fine detector for a
product flattering itself, and a wall of zeros describing work that never happened is the worst
possible first impression.

**WHAT DIES.** `TodayStatStrip` entirely. `activity.stats.hoursSaved`. `today.stats.scanned`.
`today.stats.matched` ("Matched ≥ 80"). `today.stats.matchedDelta` ("{count} above bar").
`today.stats.inQueue`. The overnight narrative in every headline. `preferences.plan.usage_hours`
("LIFETIME 42h"), `preferences.plan.payment_sub` ("Visa ending in 4242"),
`preferences.plan.next_bill_sub` ("$19.00 · June 14, 2026"), `preferences.hunt.salary_median`.

---

### D10 — Value before account. Anonymous resume drop → 5 real scored jobs, no signup.

**DECISION.** The landing hero **is** the resume drop zone. Parse anonymously, run one
`RAOnboardingRecommendService` round with zero elicitation, render 5 real open jobs with score,
one-sentence reason, and a working `View job` link. Ask for an email only when the user tries to keep
something (Save, Practice, or scroll past card 5). Plan choice appears only at the paywall moment.

**WHY.** Today the product collects five commitments — account, plan tier, resume, twelve preference
fields, automation aggressiveness — before showing a single job: 7 screens, ~8 clicks, 5-9 minutes,
against a landing claim of "Three minutes of setup". Every one of those commitments can move after the
cards, and the cards need only a parsed resume — which the code already proves, since the resume alone
yields `targetRoles` + `seniority` + `location` and `pickNextTopic` already reads them from the draft.
`RECOMMEND_MIN_TURN = 2` is therefore an artificial gate: the server holds a fully parsed resume and
asks a question instead.

**WHAT DIES.** `RECOMMEND_MIN_TURN`, `FORCED_RECOMMEND_TURN`, `SESSIONS_PER_DAY` lockout,
`/choose-plan` as a step, the aggressiveness exit toll, the invisible `dailyCap: 10`, `ResumeGate` as a
wall, the Skip→/home→upload-wall trap.

---

### D11 — Setup is a panel, not a gate. The chat refines results; it never precedes them.

**DECISION.** `/onboarding` ceases to exist as a route. The onboarding chat becomes a dismissible
`Tune my matches` panel inside `/jobs`, opened from the filter bar. Preferences are primarily captured
as **filter chips on visible results** (`Remote only`, `$150k+`, `More like this`, `Must sponsor`).

**WHY.** Same data, paid for with a click on evidence the user can see, instead of five minutes of
trust they have no reason to extend yet. It also deletes an entire class of dead ends: the two-tab
supersede ("This conversation continued in another window") with `retry: false` and no recovery
control; the daily-limit 429; the Skip trap.

**WHAT DIES.** `app/onboarding/`, `app/onboarding/layout.tsx`, `OnboardTop`, the 4-dot stage
derivation, `onboarding.chat.error_daily_limit`, the wrap-CTA aggressiveness commitment.
**NOT DYING:** `RAOnboardingKickoffAgent`, `RAOnboardingPrefExtractAgent`, `RAOnboardingChatAgent`,
`RAOnboardingSearchPlannerAgent`, `RAOnboardingRecommendService` — all AI capability, all retained,
all re-mounted inside `/jobs`.

---

### D12 — The match score stays, and it must always show its gaps.

**DECISION.** Keep the 0-100 number. Rename `Matched ≥ 80` → `Strong matches`. On the **card face**,
not behind an expand: score + one concrete overlap + one concrete gap + up to 3 `keywordsMissing`
chips. An expander `How this was scored` shows the real weights (35 role/seniority · 30 skills ·
15 domain · 10 logistics · 10 trajectory).

**WHY — and why the opposing view loses.** The agency recruiter argued for deleting the number
outright: an "87" makes a candidate believe they will probably get it, they relax, they stop
networking, and false confidence is the most expensive error in a job search. That risk is real, but
the answer is a mandatory gap, not a hidden number. Deleting the score costs us the one thing the
scorer does that nobody else does — `RAJobMatchScorerAgent` has published weights, bidirectional
seniority penalties, "absence of evidence is a gap, not a guess", and an explicit
"an honest 58 protects the candidate's time better than a flattering 70" — and a `parseOutput` that
throws rather than persisting a flattering fallback. That rubric is the most credible artifact in the
repo and it is currently visible only as a donut. Publishing the rubric is the cheapest credibility
purchase available to us. An AI that only flatters reads as fake to the audience we most want.

**WHAT DIES.** `threshold` (8 strings), `above bar`, `cleared your bar`, `tier`, `fit`, `FIT`,
`Matched ≥ 80`, the score donut with its 8.5px label, `matchedDelta`.

---

### D13 — CitationGuard becomes a visible product feature, and it covers screening answers.

**DECISION.** Every tailored resume line carrying a quantitative claim renders a small marker linking
to the source line in the base resume; any line failing the guard blocks export until resolved.
Labelled in plain words: **"Traced to your real resume."** The same guard is applied to generated
screening-question answers.

**WHY.** `runCitationGuard` in `RAResumeTailorAgent` is the only genuinely anti-slop mechanism in the
product and it is currently invisible except for the word "citation-checked" on the landing page. It
is spent on cover letters, which almost nobody reads, instead of screening answers, where one wrong
claim ends a candidacy. This is AI capability made legible — the opposite of theatre.

---

### D14 — The interview grade must be produced by a model that read the transcript.

**DECISION.** Build `RAInterviewEvalAgent` (configured interview task model, temp 0.1). Input: the transcript **and** the
`RAInterviewBlueprint` that generated the questions. Output contract: every dimension score must cite
a **verbatim quote** from the candidate's own turn; no quote, no claim. `heuristicScore()` is retained
only as the never-throws fallback and, when it fires, the UI labels it
`Quick estimate — rerun for a full report`. The report itself becomes homework, not a grade: your
sentence verbatim → what a hiring manager hears → the rewritten version. Three things to stop saying,
one story to have ready, one number to memorise.

**WHY.** `RAMockService.heuristicScore()` (lines 376-540) is the payoff of the flagship feature and it
is a regex word-counter. "Specificity" = does the answer match `/\b\d[\d.,%]*\b/`. "Communication" =
`30 + 60*(1-e^(-avgWords/45))`. "Confidence" contains zero confidence signal. "Role fit" = the
fraction of questions you didn't skip — it never looks at the role. No model ever reads the
transcript. An ML engineer will break this in one session and screenshot it, and we lose that segment
loudly. This is the single clearest instance of theatre sitting directly on top of real machinery
(the 5-agent blueprint chain is genuinely differentiated).

---

### D15 — Work authorization, currency, and posting age become first-class on every job card.

**DECISION.** `workAuth` is passed into `RAJobMatchScorerAgent.formatInput` and into the prefilter,
with a hard rule: *if the job states a work-authorization requirement the candidate cannot meet, cap
the score at 35 and name it as the first gap.* Each card shows a badge:
`Sponsors visas` / `No sponsorship stated` / `Requires local work permit`.
Salary renders through `Intl.NumberFormat` with the user's locale, always with the ISO code when the
symbol is ambiguous, always with the period (`/month`, `/year`), and no `k` compaction outside
USD/EUR/GBP. Every card shows `Posted {n} days ago`; anything over 45 days is greyed with
`may already be filled`.

**WHY.** `RAPreferencesService` stores `workAuth` and `RAJobIndexService.search` never reads it, so the
product will hand a Manila candidate needing sponsorship a 91% match on a US-onsite role that
explicitly refuses sponsorship — in second-person prose explaining why they are a great fit. That is
not a ranking bug; it is the product telling a vulnerable person a comfortable falsehood about their
own eligibility. And `components/v3/today/lib.ts:28-63` returns an **empty** currency symbol for INR,
PHP, PLN, MXN, SGD, BRL, IDR, VND, renders USD/AUD/CAD identically as `$`, and never renders
`salaryPeriod` at all — so ₱90,000/month and ₹1,800,000/year both display as an unlabelled number.
A factor-of-twelve ambiguity on the one number the user cares most about.

---

### D16 — Rejections are never hidden. Duplicate applications are blocked.

**DECISION.** The board gains a **Closed** column. `HIDDEN_STATUSES` is deleted. Columns:
`Saved · Applied · Recruiter screen · Hiring manager · Onsite · Offer · Closed`. Two always-visible
counts above the board that **filter, never delete**: `No reply (14+ days)` and `Closed`. Applying to a
company where a tracker entry already exists shows `You already applied here on {date}` and blocks
re-apply within 60 days (company + fuzzy-title match).

**WHY.** Real searches are 80-95% rejection, and the *pattern* of where you die — always at the
hiring-manager call, never at the panel — is the only diagnostic a candidate has. A board that deletes
that is a mood board, not a tracker. On duplicates: syndicated reqs appear three times in any index; a
candidate at volume applies to all three, which in an ATS reads as spray-and-pray and is the fastest
route onto an internal do-not-progress list.

---

### D17 — Follow-ups are the flagship automation, replacing auto-apply.

**DECISION.** Rule: `status = applied` + 10 days + no status change → a card at the top of `/jobs`
with a drafted 3-line follow-up. **The candidate sends it from their own mail client.** Each tracker
card gains a contact name/email field and a next-step date. Nudges at 10 days after applied and 3 days
after an interview.

**WHY.** `RATrackerEntry` already has `followUpAt`, `deadline`, `notesMarkdown`, `dateApplied`,
`excitementStars` (`server/prisma/schema.prisma:5203-5214`) and the UI throws all of it away. The
schema already knows what a real job search is. This is real, safe, legal, measurably raises response
rates, needs no consent layer and no ATS integration, and is a fraction of the engineering of
auto-apply.

---

### D18 — Settings is one route with four sections. Billing has exactly one home.

**DECISION.** `/settings` with `#account`, `#preferences`, `#billing`, `#appearance`. Every other
settings surface redirects into it.

**WHY.** 21 settings surfaces across 4 screens + a slide-over, with 6 duplicated controls (profile
identity ×2, delete-account modal ×2 — literally the same `DeleteAccountModal` — theme ×2, language
×3, replay-onboarding ×2, and **four** plan/billing surfaces one of which shows
`Free $0 / Pro $19 / Premium $49`: tiers that exist nowhere else and cannot be purchased).

**WHAT DIES.** `/preferences` (8 sections), `/account` (5 sections), `/plans`, `/choose-plan`, the
Tweaks slide-over, `components/v3/preferences/sections/IntegSection.tsx` (six tiles whose `connect()`
throws `IntegrationUnavailableError` by design for every provider), `PlanSection.tsx`.

---

### D19 — All nine locales reach full app parity. No landing-only locales.

**DECISION.** After the copy purge, translate the surviving ~13 namespaces into all 9 locales.

**WHY.** Today `de, es, fr, ko, pt` ship 8 namespaces while `en, ja, zh, zh-TW` ship 32 — we market in
Spanish and Portuguese and then hand the user an English-only app the moment they log in. That is the
exact moment a Guadalajara candidate decides the product is not for them. The purge makes parity
affordable: `en.json` goes from 2,462 leaf strings to roughly 1,100 (dead namespaces −501, tone fork
−18, queue −37, and the merges), so five new full bundles is a smaller job than maintaining today's
four. Use the `i18n-locale-sync` skill.

---

### D20 — Copy patterns that break in nine languages are banned outright.

**DECISION.** Banned, with no exceptions: (a) split headlines (`headline.before` / `.accent` /
`.after` with an `<em>` in the middle — 25 call sites); (b) contractions and slang; (c) idioms;
(d) math symbols in labels; (e) meaning-bearing emoji; (f) US-only formats and defaults; (g) the
first-person machine persona outside D5's two surfaces. One key = one whole sentence.

**WHY.** Japanese and Korean put the verb last and German splits it — a sentence chopped into three
ordered fragments only reassembles in English SVO. `lib/fixtures/preferences.ts:60` defaults work auth
to `US Citizen — no sponsorship needed` in a nine-language product.

---

## 2. Information architecture

### 2.1 Top-level destinations

| Route | Nav label | One-line purpose | i18n ns |
|---|---|---|---|
| `/jobs` | **Jobs** | The jobs worth your time, ranked, with the reason and the gap. | `jobs` |
| `/resume` | **Resume** | Your resume, and a version tailored to each job you care about. | `resume` |
| `/applications` | **Applications** | Everywhere you've applied and what happened next. | `applications` |
| `/practice` | **Practice** | Live voice interview practice for a specific role. | `practice` |

Avatar menu (not nav destinations): `Settings` → `/settings` · `Billing` → `/settings#billing` ·
`Sign out`. Admins additionally see `Admin` → `/admin`.

### 2.2 Full route map

**Public**

| Route | State | Notes |
|---|---|---|
| `/` | live, rebuilt | Hero is the resume drop zone (D10). |
| `/[locale]` ×8 | live | `zh, zh-TW, ja, ko, es, fr, pt, de`. `/en` → `/` (301). Unchanged. |
| `/login` | live, recopy | H1 `Sign in`. Sub `Welcome back.` Honors `?next=`. |
| `/signup` | live, recopy | 2 fields (email, password). Honors `?next=`. Defaults to `/jobs`. |
| `/preview/[token]` | **NEW** | Anonymous match results from a resume drop. TTL 24h, no account. |

**Authenticated** (`app/(auth)`, wrapped `AuthGate` → `RoboApplyAccessGate` only)

| Route | Nav | State |
|---|---|---|
| `/jobs` | Jobs | **NEW** (absorbs `/home`, `/queue`, ⌘K job search, onboarding cards) |
| `/jobs/[id]` | — | **NEW** — `JobDetailModal` promoted to a real page |
| `/resume` | Resume | renamed from `/resumes` |
| `/resume/[id]` | — | renamed from `/resumes/[id]` |
| `/applications` | Applications | **NEW** (absorbs `/tracker` + `/activity`); `?view=board\|history` |
| `/applications/[id]` | — | **NEW** — one application + its event trail |
| `/practice` | Practice | renamed from `/mock-interview` |
| `/practice/[id]` | — | live interview, fullscreen, no shell |
| `/practice/[id]/report` | — | rebuilt per D14 |
| `/settings` | avatar | **NEW** — `#account` `#preferences` `#billing` `#appearance` |
| `/settings/billing/history` | — | invoices |
| `/admin`, `/admin/users/[id]`, `/admin/sessions/[id]` | avatar (admin) | unchanged |

**Redirects (all 301/`permanentRedirect`, added to `next.config.js`)**

```
/home                       -> /jobs
/queue                      -> /jobs
/tracker                    -> /applications
/activity                   -> /applications?view=history
/resumes                    -> /resume
/resumes/:id                -> /resume/:id
/mock-interview             -> /practice
/mock-interview/:id         -> /practice/:id
/mock-interview/:id/report  -> /practice/:id/report
/preferences                -> /settings#preferences
/account                    -> /settings#account
/account/billing/history    -> /settings/billing/history
/plans                      -> /settings#billing
/choose-plan                -> /jobs
/onboarding                 -> /jobs
/mission /apps /search /insights -> /            (and REMOVED from PROTECTED_PREFIXES)
```

`lib/proxyPaths.ts` `PROTECTED_PREFIXES` becomes exactly:
`['/jobs', '/resume', '/applications', '/practice', '/settings', '/admin']`.
Today it lists six prefixes with no pages (`/mission`, `/apps`, `/settings`, `/search`, `/jobs`,
`/insights`) — an anonymous hit gets a login redirect and then a **404 after successfully
authenticating**, because `/login` honors `?next=`. That is fixed by construction.

### 2.3 Mobile nav

`components/v3/shell/MobileNav.tsx` renders exactly four tabs, identical labels/order/routes to the
sidebar: **Jobs · Resume · Applications · Practice**. The avatar moves into the mobile topbar and
opens a sheet with Settings / Billing / Sign out. No hidden destinations, no "More" tab, no
`QUEUE_REVIEW_ENABLED`-style filtering. Minimum tap target 44×44.

### 2.4 Where AI lives

| Layer | Surface | Example |
|---|---|---|
| **Plumbing (invisible)** | ranking, scoring, parsing, search planning | `RAJobMatchScorerAgent`, `RAOnboardingSearchPlannerAgent`, `ingestCandidateResume` |
| **Output (visible, cited)** | the score, `Why this fits`, `What's missing`, `How this was scored` | job card face + expander |
| **Verbs on objects** | `Tailor to this job`, `Rewrite this bullet`, `Practice for this role`, `Write a note to the hiring manager`, `Tune my matches` | resume editor, job detail, jobs filter bar |
| **A place (once)** | `/practice` — a live voice interview, start/end/result | LiveKit worker + 18 domain playbooks |

**Theatre vs capability — the operative test.** A capability changes what the user gets. Theatre
changes only what the user is told. `heuristicScore` presented as an AI grade is theatre; the same
function labelled a fallback estimate is honest engineering. An orb narrating "Scanning Lever,
Greenhouse, Ashby…" while nothing runs is theatre. A citation marker linking a tailored line to line 3
of your real resume is capability made legible. **No AI agent, model call, or prompt in this codebase
is deleted by this spec.**

---

## 3. Naming & copy rules

### 3.1 Old term → new term (exhaustive)

**Destinations and objects**

| Old | New |
|---|---|
| Today / Home / dashboard / briefing / digest / morning report | **Jobs** (`/jobs`) |
| Pipeline / Tracker / Job Tracker / funnel / board / bucket / "conversations" / stages | **Applications** (`/applications`) |
| Activity log / receipts / ledger / log / "no black box" / "quiet decision" | **History** (a tab inside Applications) |
| Resume builder / resume library / resumes_v2 / variant | **Resume** (`/resume`); versions are **versions** |
| Mock interview / interview gym / interview studio / STUDIO / reps / session | **Practice interview** (`/practice`) |
| Review queue / queue / staging / staged / runs / review window / review hold / consent layer / veto | *(deleted — no replacement)* |
| Preferences / Hunt rules / Job target / Intent / Tweaks / settings | **Settings** (`/settings`) |
| Plans & credits / choose-plan / Plan & usage | **Billing** (`/settings#billing`) |
| Mission Control / mission / Today's runs | *(deleted)* |

**Concepts**

| Old | New |
|---|---|
| agent / "YOUR AI JOB HUNTER" / co-pilot / orb / the machine persona | **RoboApply**, or "we", or name the action |
| aggressiveness (chill/balanced/intense) + (manual/balanced/aggressive) + "full auto" | *(deleted — one setting survives, see below)* |
| threshold / "Matched ≥ 80" / "{count} above bar" / bar / tier | **Strong matches**; the setting reads `Only show jobs scoring at least {n}` |
| match score / fit / FIT / score | **Match** (keep the word, drop the synonyms) |
| Strong / Good / Stretch / Long shot | **Great fit / Good fit / A stretch / Long shot** |
| auto-apply / autopilot / full auto / ship / ships / shipped / fire now / submit | **Apply on company site** · **Mark as applied** · **sent** |
| consent layer / review hold / hard daily caps | `Nothing is sent for you — you apply on the company's site.` |
| citation-checked / cited / claim checker | **Traced to your real resume** |
| JD (20 strings) | **the job post** — e.g. `Matches {pct}% of the skills they list` |
| intent / intent filter / intent statement | **What you're looking for** |
| hunt / hunt rules / hunting / Hunt active / Pause the hunt | **your job search** / **Search settings** / **Pause search** |
| shift / night shift / sample shift / "while you slept" / sweep | *(deleted)* |
| triage | **sorting** |
| receipts / ledger | **history** |
| Hours saved | *(deleted)* |
| Scanned overnight | *(deleted)*; the feed carries `Updated {time}` |
| Coach loudness / "how chatty your AI co-pilot should be" | **How often should we suggest improvements?** |
| "tap your shoulder" | **When we notify you** |
| Stealth / blocklist | **Hidden from recruiters** / **Companies to block** |
| Density: Compact / Regular / Comfy | *(deleted)* |
| Tone: formal / casual / witty | *(deleted)* |
| credit / "1 credit = one 20-minute mock interview" | **credit** — keep verbatim; it is the best-written string in the product and the template for the rest |
| Apply now → "Sent. Cover, tailored resume, and screening answers submitted." | **Apply on company site** → `Opening the job post. Mark it applied when you've sent it.` / **Mark as applied** → `Saved to Applications.` |

**The one automation setting that survives** (`/settings#preferences`):
`How often should we check for new jobs?` → `Every day` / `Twice a week` / `Only when I open the app`.
That is a schedule, which is legible. `aggressiveness` was an internal parameter name wearing a UI.

### 3.2 Banned words

Banned in all user-facing copy, all locales. CI greps `i18n/messages/*.json` and fails on any hit.

| Banned | Reason |
|---|---|
| agent, agentic, orb, autopilot, full auto | names a persona, not a benefit; 2026 plumbing word |
| queue, staging, staged, review hold, review window, veto, consent layer | describe a feature that does not exist |
| auto-apply, auto-applied, submit on your behalf, we apply | we do not do this |
| threshold, above bar, cleared your bar, bar | engineering noun for "minimum score" |
| JD | ATS/recruiter abbreviation leaking from the recruiter product |
| hunt, hunter, hunting | predatory metaphor aimed at anxious people; 9 divergent translations |
| shift, night shift, while you slept, overnight, sweep | narrates work the user cannot verify |
| receipts, ledger, no black box, quiet decision | defensive; answers an accusation not yet made |
| ship, ships, shipped, fire, fire now | deploy slang; "fire" is dangerous next to jobs |
| intent (as a noun for the user's goal) | nobody describes their job search as an "intent" |
| triage, funnel, bucket, pipeline | internal / sales vocabulary |
| Mission Control, mission, runs, SYSTEM NOMINAL | mission-control cosplay |
| citation-checked, claim checker | internal mechanism, not a user benefit |
| Hours saved | fabricated metric |
| ≥, ≤, >=, <= in labels | math symbols are skimmed past |
| babysit, you're the boss, hiccuped, brewed coffee | patronizing / evasive on high-stakes screens |
| Coming in V2.1, coming soon (in shipped UI) | either it ships or it is not mentioned |

### 3.3 Voice rules

1. **Person.** Second person for the user ("your resume", "you applied"). Neutral third for the
   product ("RoboApply checks…") or plural first ("we found"). **First-person singular "I" is
   permitted only in `Why this fits` and the resume coach** (D5).
2. **Tense.** Present for state, simple past for events, no future promises. Never "I'll", "we'll",
   "will be".
3. **Length.** H1 ≤ 8 words, one sentence, no `<em>` fragment splitting. Sub ≤ 20 words. Button labels
   ≤ 3 words. Empty-state body ≤ 25 words. Error body ≤ 20 words and must contain a next action.
4. **One key = one whole sentence.** No `before`/`accent`/`after` triples. Emphasis, if needed, is
   markup inside the string.
5. **Numbers.** Always with a unit and a period. Currency via `Intl.NumberFormat`. Never a bare `k`
   outside USD/EUR/GBP. Never a computed "estimate" presented as a measurement.
6. **Humour** is allowed on empty states only. Never on errors, destructive actions, money, or
   rejection.
7. **The product is NEVER allowed to say:** that it sent, submitted, or filed anything with an
   employer; that it saved the user time (as a number); that it worked while they slept; that
   something is "coming soon" inside the shipped app; that a job is a match without also naming a gap;
   that a score means the user will get the job.

### 3.4 i18n namespace disposition

**DELETE outright (dead, 0 consumers):** `app`, `nav` (the old V1 one), `home`, `tracker`, `search`,
`jobs` (old), `insights`, `resumes_v2`, `mission`, `apps`, `settings` (old). — 495 en strings.

**DELETE (feature removed):** `queue` (37 keys), `choosePlan` (folded into `settings`), plus the
18 tone-forked keys inside `today`/`pipeline`.

**RENAME:** `nav_v3` → `nav` · `onboarding` → `setup` · `today` → `jobs` · `pipeline` →
`applications` · `mock` → `practice`.

**MERGE:** `ie` → `practice` · `activity` → `applications` · `resumes` + `resumeEditor` +
`resumeGate` → `resume` · `preferences` + `account` + `plans` → `settings`.

**KEEP:** `common`, `auth`, `landing`, `admin`, `palette`, `errors` (rewritten, and it becomes live —
it currently has zero consumers).

**Final namespace list (13):** `common` · `nav` · `landing` · `auth` · `setup` · `jobs` ·
`applications` · `resume` · `practice` · `settings` · `admin` · `errors` · `palette`.

---

## 4. Typography

### 4.1 Families

```css
--font-ui: 'InterVariable', Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui,
           'Hiragino Sans', 'Yu Gothic', 'PingFang SC', 'PingFang TC', 'Microsoft YaHei',
           'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif;
--font-mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace;  /* ⌘K kbd glyph ONLY, 0 bytes */
```

**Why Inter Variable.** High x-height, open apertures, low stroke contrast, unambiguous 1/l/I, and a
skeleton every reader has absorbed from every operating system. It is already in the repo at
`app/fonts/inter-100-900.woff2` (48,432 B, wght 100-900, v4.001, verified). Upgrade the file to the
rsms.me Inter v4 build (`InterVariable.woff2`) which adds the `opsz` 14-32 axis and the `cv05` tailed-l
feature that Google's CSS2 build strips, and set `font-optical-sizing: auto`. The CJK tail is
mandatory: four of nine locales currently render in undeclared system fallback, so ja/zh/ko users get
whatever the OS picks and it changes per platform. "Natural" has to include them.

### 4.2 Type scale (complete; nothing outside this table may ship)

| Token | px | weight | line-height | letter-spacing | Usage |
|---|---|---|---|---|---|
| `--fs-hero` | `clamp(40px, 5.5vw, 64px)` | 700 | 1.04 | -0.03em | Landing + auth split-hero **only** |
| `--fs-display` | `clamp(28px, 3vw, 36px)` | 600 | 1.12 | -0.022em | Page H1 |
| `--fs-stat` | 28px | 600 | 1.0 | -0.02em | Stat values only; `font-variant-numeric: tabular-nums` |
| `--fs-title` | 20px | 600 | 1.25 | -0.014em | Card + section titles (absorbs 17, 19, 20, 22, 24, 26) |
| `--fs-subtitle` | 17px | 500 | 1.35 | -0.01em | Sub-headers, lead paragraphs |
| `--fs-body` | 15px | 400 | 1.55 | -0.006em | Default body + all inputs (absorbs 14, 14.5, 15, 15.5, 16) |
| `--fs-meta` | 13px | 400 | 1.5 | 0 | Secondary/supporting copy (absorbs 12.5, 13, 13.5) |
| `--fs-label` | 12px | 500 | 1.35 | +0.01em | **HARD FLOOR** — chips, counts, timestamps, captions (absorbs all 141 sub-12px declarations) |

**Weights:** 400 body · 500 UI text/labels/buttons · 600 titles and display · 700 hero only.
Never mix 500 and 600 inside one component. 300 and 800 are deleted.
**Tracking:** exactly the 6 values above, derived from size, never chosen freely.
**Line-height:** exactly 1.04 / 1.12 / 1.25 / 1.35 / 1.5 / 1.55.
**Base:** raise `html { font-size }` from 14px (`app/globals.css:524`) to 15px.
**Tailwind:** add a `fontSize` key to `tailwind.config.ts` mirroring these 8 tokens. It has none today,
which is why 16 arbitrary `text-[Npx]` exist. Also update the file's header comment — it still
describes the "Cool Graphite" system from two redesigns ago.

### 4.3 Disposition of the 11 currently-loaded families

| Family | Size | Disposition |
|---|---|---|
| **Inter** | 47.3 KB | **PROMOTED** → `--font-ui`, the only UI family. Also the default resume face. |
| Space Grotesk | 87.2 KB (4 identical files) | **DELETED.** Geometric display face, closed apertures, quirky single-storey g/a; degrades at 13px where 82 declarations live. Primary cause of "fonts feel random". |
| Instrument Serif | 30.0 KB | **DELETED.** The italic accent-word tic (15 CSS rules, 25 `<em>` sites, 24 files) and it has already leaked into 12px body copy in `Scorecard.tsx` and `LiveTranscript.tsx`. |
| JetBrains Mono | 91.8 KB (3 identical) | **DELETED.** 114 of 137 rule-blocks set labels or prose, 73 also uppercase. Replaced by `font-variant-numeric: tabular-nums`. |
| Geist | 28.6 KB | **DELETED** (legacy; one resume-picker option). |
| Geist Mono | 29.3 KB | **DELETED** — referenced by nothing at all. |
| Poppins | 30.7 KB (4 files) | **DELETED** from the resume picker. |
| Roboto | 109.9 KB (3 identical) | **DELETED** from the resume picker. |
| Source Sans 3 | 28.1 KB | **KEPT**, lazy-loaded in `/resume/[id]` only. |
| Lora | 36.9 KB | **KEPT**, lazy-loaded in `/resume/[id]` only. |
| Merriweather | 190.6 KB (2 identical statics) | **KEPT but re-downloaded as one variable file**, lazy-loaded in `/resume/[id]` only. |

Resume picker final options: **Inter · Source Sans 3 · Lora · Merriweather** (4, was 8).
Delete the per-weight loop in `app/fonts/_download.py` — it queried Google CSS2 with `wght@400;500;600;700`
against *variable* families and saved the same file N times, producing 8 byte-identical woff2 files
(295.2 KB, 42% of the payload, fetched under different URLs so the cache never hits).

**Wire payload: 710.5 KB preloaded on all 23 routes → 48 KB on all routes, +~100 KB deferred to
`/resume/[id]`.**

### 4.4 The mono rule

Monospace is **never** a design choice. It is permitted in exactly one place: the `<kbd>` glyph in the
⌘K palette, using the zero-byte system stack. Column alignment of numbers is achieved with
`font-variant-numeric: tabular-nums` on the ~20 genuinely numeric selectors (counts, timestamps,
salary, score, durations). No downloaded monospace face ships.

### 4.5 The serif rule

There is no serif in the UI. Not for accent words, not for quotes, not for empty states. Emphasis
comes from size and weight inside one family. `.page-h h1 em`, `.dc-serif`, `.serif-human`,
`.iv-persona-role`, `.pref-intent-line` and the other 10 serif rules are deleted along with all 25
`<em>` wrappers. Serif survives **only** inside the resume document itself (Lora, Merriweather), where
the user is choosing the typography of their own artifact and choice is legitimate.

**Also fix, in `styles/v3-resume.css`:** `'Newsreader'` at `:861, :867, :908` is never loaded anywhere,
so **every resume preview and PDF export currently renders in Times New Roman**; and the literal
`'JetBrains Mono'` at `:879, :888, :897, :923` never matches next/font's generated family
`jetbrainsMono`, so it falls through to Courier. The product's primary output artifact — the document
users send to employers — is typeset in browser defaults. Point them at `var(--resume-serif)` /
`var(--font-ui)`.

---

## 5. Colour, surface, motion

### 5.1 Themes

**Two.** `light` (default) and `dark`. `warm` is deleted. `data-accent` is deleted. All ratios below
are computed sRGB-linearised, not eyeballed; every foreground token passes 4.5:1 against every surface
it is permitted on.

**LIGHT (default)**

```css
--bg:          #FBFBFC;
--surface:     #FFFFFF;
--surface-2:   #F1F2F4;
--surface-3:   #E8EAEE;
--rule:        #E4E6EA;
--rule-strong: #D3D6DC;
--text:        #14161A;  /* 18.11 on surface · 17.51 bg · 16.17 s2 · 15.04 s3 */
--text-2:      #4A4F58;  /*  8.23 ·  7.96 ·  7.35 ·  6.84 */
--text-muted:  #676D78;  /*  5.20 ·  5.03 ·  4.65 ·  4.32 — AA on all four */
--disabled:    #949AA5;  /*  2.83 — placeholders and disabled ONLY, never live text */
--brand:       #0B6E8C;  /*  5.80 as foreground on surface AND 5.80 as a fill under white ink */
--brand-hover: #095A73;  /*  7.72 with white ink */
--brand-ink:   #FFFFFF;
--brand-subtle: rgba(11,110,140,0.08);
--ok:          #0F7A3D;  /*  5.42 */
--warn:        #9A5B00;  /*  5.43 */
--danger:      #B3261E;  /*  6.54 both directions */
```

**DARK**

```css
--bg:          #0F1115;
--surface:     #16181D;
--surface-2:   #1E2127;
--surface-3:   #262A31;
--rule:        #2A2E35;
--rule-strong: #363B44;
--text:        #F2F3F5;  /* 17.02 on bg · 15.99 surface · 14.53 s2 · 12.97 s3 */
--text-2:      #ADB3BD;  /*  8.96 ·  8.42 ·  7.65 ·  6.83 */
--text-muted:  #949AA5;  /*  6.68 ·  6.28 ·  5.70 ·  5.09 — replaces #7C7E91 which FAILED at 3.99 */
--brand:       #4FC3E8;  /*  9.27 ·  8.71 ·  7.91 ·  7.07 */
--brand-hover: #6ED0EF;
--brand-ink:   #08131A;  /*  9.21 on the brand fill */
--brand-subtle: rgba(79,195,232,0.10);
--ok:          #46C97D;  /*  8.92 */
--warn:        #E0A83C;  /*  8.85 */
--danger:      #F2695E;  /*  6.26 */
```

**Resume paper** (non-themed, `styles/tokens.css:60-67`): `--paper-muted` changes `#847C6E` → `#6B6459`
(currently 3.94:1 on `#FAFAF6` — a fail, applied at 9.5px). `--paper-faint` #B7AE9D (2.10) is deleted;
there is no third greyscale on a document people print.

**Accent policy:** one brand colour per theme, defined once, not user-selectable, never used as a
shadow colour, never used for large fills behind body text.

### 5.2 Geometry

Spacing scale: **4 · 8 · 12 · 16 · 24 · 32 · 48 · 64**. Nothing off-grid.
Radii: `--r-sm 8px` (inputs, buttons, chips) · `--r-md 12px` (cards) · `--r-lg 16px` (modals, sheets) ·
`--r-pill 999px` (avatars, pills). The six current 1px-apart radii are deleted.
Control heights: 32 sm / 36 md (default) / 44 touch + primary CTA. Minimum tap target 44×44 on mobile.
Card padding 20px. Card gap 12px. List-row min-height 56px. Page gutter 24px mobile / 40px ≥1024px.
Max content width 1120px. Prose max-width 68ch.
Borders: 1px `var(--rule)` default, 1px `var(--rule-strong)` on hover/active. No 2px borders.
`--density` is deleted (it is consumed by exactly one declaration in 8,103 lines of CSS,
`styles/v3.css:562`).

### 5.3 Elevation and glow

**Glow is banned.** No `box-shadow` may reference `--brand`, `--accent`, or any hue. Three levels:

```css
/* light */
--e1: 0 1px 2px rgba(16,20,28,.06), 0 1px 1px rgba(16,20,28,.04);   /* resting cards */
--e2: 0 4px 12px -2px rgba(16,20,28,.08), 0 2px 4px -2px rgba(16,20,28,.06); /* hover, dropdowns */
--e3: 0 16px 40px -12px rgba(16,20,28,.18);                          /* modals, sheets */
/* dark: elevation is a surface step + 1px solid var(--rule); only e3 keeps a shadow */
--e3-dark: 0 24px 60px -20px rgba(0,0,0,.7);
```

Focus ring — identical in both themes, and the **only** ring in the system:
`box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--brand);`

This replaces 80 raw `box-shadow` declarations resolving to 48 distinct values, 46 of them accent
glows, plus 5 bare `0 0 Npx var(--accent)` halos.

**Gradients:** exactly one survives.
`--grad-brand: linear-gradient(135deg, #0B6E8C 0%, #1E9BBF 100%)` (light) /
`linear-gradient(135deg, #4FC3E8 0%, #7FD8F0 100%)` (dark), used on the marketing hero panel only.
`--grad-orb`, `--grad-tri`, `--grad-page-wash` and the two ellipse washes behind every authed page are
deleted. A page background is a colour.

### 5.4 Motion

| Purpose | Duration | Easing |
|---|---|---|
| Hover / focus / colour | 120ms | `cubic-bezier(0.2, 0, 0, 1)` |
| Enter (dropdown, chip, toast) | 180ms | `cubic-bezier(0.2, 0, 0, 1)` |
| Exit | 140ms | `cubic-bezier(0.4, 0, 1, 1)` |
| Modal / sheet | 240ms | `cubic-bezier(0.2, 0, 0, 1)` |
| Skeleton sheen | 1400ms loop | `linear` |

Rules: nothing loops forever; every loading animation is bound to a real in-flight request and is
replaced by content or an error within its timeout; `@media (prefers-reduced-motion: reduce)` disables
all of the above except opacity fades. No parallax, no floating orbs, no rotating gradients.

**The four sanctioned "AI reads as AI" mechanics** (nothing else):
1. **Stream** — machine-authored text arrives at token pace with a 2px `--brand` caret; the caret
   disappears when the stream ends. Nothing else in the UI streams.
2. **Work** — a 2px indeterminate bar in `--brand` pinned to the top edge of the card doing the work.
3. **Provenance** — every AI claim carries a 1px dotted `--brand` underline and a hover chip naming its
   source (`from your resume · Experience, line 3`).
4. **Score** — a 4px full-width meter in `--brand` over `--surface-3`, plus the number at `--fs-stat`
   in tabular figures. The donut with its 8.5px label is deleted.

**Silence** — when nothing is running, show nothing.

---

## 6. Screen-by-screen

### 6.0 New first-run flow — **5 steps, 4 concepts, target 90 seconds**

| # | Where | What the user does | Concepts introduced |
|---|---|---|---|
| 1 | `/` hero | Drops a resume file. No account, no email. | **resume** |
| 2 | `/preview/[token]` (auto) | Waits ~15-25s while it parses and scores. Progressive card reveal. | — |
| 3 | `/preview/[token]` | Reads 5 real open jobs: title + company, match score, one sentence why, one sentence what's missing, `View job`. | **job**, **match** |
| 4 | inline gate | Tries to Save / Practice / scroll past card 5 → email + password inline (2 fields). Account created, preview claimed. | — |
| 5 | `/jobs` | Refines with filter chips on results already visible. | — |
| — | later | Plan appears **only** when Practice is clicked with 0 credits. | **credit** |

Compare today: 7 screens, ~8 clicks, 10 concepts, 5-9 minutes, 3 blocking LLM round-trips before the
first *question*, ~11 LLM calls before the first *card*, ending on a dashboard of zeros.

Backend contract for step 2: `POST /v2/preview/resume` (multipart, unauthenticated, rate-limited by
IP, 5/hour) → `{ token, status }`; `GET /v2/preview/:token` → `{ status, cards[] }`. It runs
`ingestCandidateResume` then one `RAOnboardingRecommendService.runRound` with an empty elicitation
draft. TTL 24h. On signup, `POST /v2/preview/:token/claim` attaches the parsed resume + scores to the
new user.

---

### 6.1 `/` — Landing

**Purpose.** Prove in 20 seconds that we can find jobs this person can actually get.

**Layout (top to bottom).**
1. **Hero.** H1 `Stop guessing which jobs are worth your time.` Sub, ≤20 words. **The resume drop
   zone is the primary CTA** — a 44px-tall dashed target reading `Drop your resume — PDF, DOCX, or TXT`
   with a secondary text link `or type what you're looking for`. Second CTA: `Sign in`.
2. **Proof.** Three real `JobCard` components (the same component `/jobs` renders) with score + one
   sentence of reasoning + company name. This replaces the fake terminal.
3. **How it works.** Four steps, one sentence each, mapped to the four verbs: find → understand → fix
   → practice.
4. **Practice.** One panel for the voice interviewer — the feature every persona understood cold.
5. **Pricing.** Three tiers, credits explained in the one sentence that already works:
   `1 credit = one 20-minute practice interview.`
6. **FAQ**, 6 questions max. **Footer**, plain.

**Removed.** The `roboapply — overnight.log` terminal and all 9 `LOG_LINES`. The
SCOUT/MATCH/DRAFT/QUEUE/HOLD/SUBMIT/DIGEST taxonomy. `guarantees.conf — read-only`.
`SYSTEM NOMINAL · CONSENT LAYER ENFORCED`. `See a sample shift` (an `href="#how"` anchor that only
scrolls — worse than no secondary CTA). Every auto-apply, review-hold and consent-layer claim. All 7
`href="/onboarding"` CTAs (they 302 anonymous visitors to a page reading *"Welcome back"*).

### 6.2 `/login`, `/signup`

**Login.** H1 `Sign in`. Sub `Welcome back.` — never "mission". Honors `?next=` with the existing
open-redirect protection. `New here? Create an account` is a full-width secondary button, not a
footnote link, and it forwards `?next=`.
**Signup.** Two fields: email, password. Name is collected later in Settings. Honors `?next=`;
`app/(public)/signup/page.tsx:39`'s unconditional `router.replace('/choose-plan')` is replaced with
`router.replace(next ?? '/jobs')`. No plan step.

### 6.3 `/jobs` — Jobs

**Purpose.** The jobs worth your time, ranked, with the reason and the gap.

**Layout.**
- **Header:** H1 `{n} jobs that fit you.` Sub: `Updated {relative time}.` No stat strip. No eyebrow pill.
- **Action row (top of feed, conditional):** follow-up nudges (D17) — `3 applications have gone quiet.
  Send a follow-up.`
- **Filter bar (sticky):** `Remote` · `Salary` · `Location` · `Role` · `Sponsors visas` · `More filters`
  · `Tune my matches` (opens the setup chat panel, D11). **These are wired**, unlike today's dead
  `Filters` button (`MatchFeed.tsx:94`, no `onClick`).
- **Feed:** `JobCard` list.

**`JobCard` face (all visible without expanding).** Title · company · location · salary (correct
currency + period, D15) · posting age · work-auth badge · **match score with the 4px meter** ·
one line `Why this fits` · one line `What's missing` · up to 3 `keywordsMissing` chips ·
`Apply on company site` (primary, opens `applyUrl`) · `Save` · `Pass` · `Tailor my resume`.
Expander: `How this was scored` showing the real weights.

**Changed.** The feed is wired to the user's actual preferences: `useTodayMatches` currently calls
`search.run({ sortBy:'match_desc', limit })` with **no** `q`, `location`, `salaryMin`, `workType` or
`employmentType`, so `RAJobIndexService.search` returns the entire unarchived index. It must pass the
stored `RACareerGoal` / `RAPreferences`. Today the conversation's only durable payoff is that the five
cards the user already triaged float to the top, followed by an unfiltered dump.

**Removed.** The overnight headline and sub. `TodayStatStrip` (all 4 tiles). `Schedule auto-apply`
(no `onClick`). `today.appliedBanner`. The tone fork. The `In your queue` tile.

### 6.4 `/jobs/[id]` — Job detail

**Purpose.** Everything about one job, on a URL you can share and bookmark.

`JobDetailModal` is promoted from a modal to a page. Contents: the full posting, the score breakdown,
`Why this fits` / `What's missing` in full, the work-auth verdict, `Apply on company site`,
`Mark as applied`, `Tailor my resume for this`, `Practice for this role`, and — on demand only —
`Write a note to the hiring manager` (D1, D13).

**Why this exists.** `CommandPalette.tsx:150` currently maps every job search hit to `href: '/home'`.
Searching a company, pressing Enter on the exact posting you wanted, and landing on a generic feed is
indistinguishable from the search being broken — while the topbar advertises it with
`Search jobs, companies…`. This route gives ⌘K somewhere to land.

### 6.5 `/resume`, `/resume/[id]` — Resume

**Purpose.** Your resume, and a version tailored to each job you care about.

`/resume` — the list. `/resume/[id]` — the existing split-pane editor with AI tailor / analyze / coach,
kept whole. Changes:
- **CitationGuard is visible** (D13): markers on tailored lines, export blocked on unresolved
  violations, labelled `Traced to your real resume`.
- **Tailoring is diff-first:** max 5 proposed changes, each shown beside the base-resume line it cites,
  each requiring explicit Accept. Accepted claims become the interview-prep list
  (`you claimed this — be ready to defend it`).
- **Cap: 3 tailored versions per target role family**, enforced in the UI. Forty near-identical PDFs
  with no record of which one was sent is a trap.
- **New export: `ATS-safe PDF`** — single column, no tables, no text boxes, no icons, standard section
  headings — plus a `What a parser sees` preview.
- Resume font picker: 4 options, lazy-loaded (§4.3). The `Newsreader` / `JetBrains Mono` literals are
  fixed (§4.5).
- `ResumeGate` becomes an inline empty state on `/jobs`, not a full-screen wall that replaces the shell.

### 6.6 `/applications` — Applications

**Purpose.** Everywhere you've applied and what happened next.

**Two views, one route,** toggled by `?view=board|history`.

**Board.** Seven columns: `Saved · Applied · Recruiter screen · Hiring manager · Onsite · Offer ·
Closed`. Two counts above the board that **filter, never hide**: `No reply (14+ days)` and `Closed`.
`HIDDEN_STATUSES` is deleted (D16). `schema.prisma` `RATrackerEntry.status` gains `recruiter_screen`
and `hiring_manager`.
Each card: company · role · applied date · next-step date · contact · follow-up state.

**History.** The former `/activity` timeline, day-grouped, neutral voice.
H1 `Everywhere you've applied.` Sub `A record of every job you saved, applied to, and heard back on.`
No "receipts", no "no black box", no hours-saved tile.

**`/applications/[id]`** — one application, its event trail, its notes, its follow-up draft.

**Removed.** The `Synced automatically from inbox replies and calendar invites` sub-headline — it
depends entirely on integrations that cannot be connected.

### 6.7 `/practice` — Practice

**Purpose.** Live voice interview practice for a specific role.

`/practice` — setup. Two entry points, and **the second is the important one**: (a) pick a role
manually; (b) arrive from an application card that moved to `Recruiter screen` / `Hiring manager` /
`Onsite` via `Prep for this one`, preloaded with that job post, that company, that stage. Format and
interviewer archetype are **derived from the stage** — a candidate who has never interviewed cannot
choose between 28 formats and 18 domains. The full pickers remain, collapsed behind `Change setup`.

`/practice/[id]` — the live interview. Fullscreen, no shell. Unchanged; this works.

`/practice/[id]/report` — **rebuilt (D14).** One page of homework:
1. Three sentences you said, verbatim → what a hiring manager hears → the rewritten version.
2. One story to have ready.
3. One number to memorise.
4. Scores per dimension, **each with the verbatim quote that justifies it**, produced by
   `RAInterviewEvalAgent`. If the fallback fired, the page says `Quick estimate — rerun for a full report`.
The five-spoke radar chart and the raw transcript-as-deliverable are removed (the transcript stays,
collapsed, as a reference).

### 6.8 `/settings` — Settings

One route, four sections, reachable from the avatar menu on both desktop and mobile.

| Section | Contents |
|---|---|
| `#account` | Name, email, password, language, delete account (**one** `DeleteAccountModal`) |
| `#preferences` | `What you're looking for` — roles, location, work mode, salary floor (locale currency), employment type, **work authorization (country-aware, no US default)**, must-haves, dealbreakers, companies to block, `Only show jobs scoring at least {n}`, `How often should we check for new jobs?`, notifications, `Redo setup chat` |
| `#billing` | The **only** billing surface: current plan, credits, upgrade, invoices. `/settings/billing/history` for receipts. |
| `#appearance` | Light · Dark · System. Nothing else. |

**Removed.** `IntegSection` (6 tiles that throw by design). `PlanSection`'s fictional
`Free $0 / Pro $19 / Premium $49`. The Tweaks slide-over. Accent picker. Density. Tone.
Cosmetic aggressiveness. The duplicate identity form. The duplicate danger zone.

### 6.9 `/admin`

Unchanged in function. Gets the new type scale, the new palette, a real breadcrumb
(`Topbar.CRUMB_MAP` currently has no entry for `/plans`, `/account`, `/admin`, so the Account page
breadcrumbs as **"Workspace"**), and an entry in the avatar menu for admins.

---

## 7. What gets deleted

### Routes / pages
```
app/(auth)/queue/page.tsx
app/(auth)/home/page.tsx            (content moves to app/(auth)/jobs/page.tsx)
app/(auth)/tracker/page.tsx         (-> applications)
app/(auth)/activity/page.tsx        (-> applications?view=history)
app/(auth)/preferences/page.tsx     (-> settings)
app/(auth)/account/page.tsx         (-> settings)
app/(auth)/plans/page.tsx           (-> settings#billing)
app/choose-plan/                    (whole dir incl. layout.tsx)
app/onboarding/                     (whole dir incl. layout.tsx)
```

### Components
```
components/v3/shell/OrbCard.tsx
components/dc/AiOrb.tsx
components/dc/TweaksPanel.tsx
components/dc/                      (dir is then empty — remove)
components/v3/queue/                (whole dir)
components/v3/today/TodayStatStrip.tsx
components/v3/preferences/sections/IntegSection.tsx
components/v3/preferences/sections/PlanSection.tsx
components/JobApplyingGate.tsx
components/v3/onboarding/OnboardTop.tsx
components/v3/primitives/PageHeader.tsx   -> rewritten without the <em> accent
```

### Lib / config
```
lib/dcTheme.tsx                     -> replaced by lib/theme.tsx (light|dark only)
lib/jobApplying.ts                  (QUEUE_REVIEW_ENABLED, JOB_APPLYING_ENABLED)
lib/proxyPaths.ts                   -> PROTECTED_PREFIXES rewritten (6 dead prefixes removed)
app/fonts/_download.py              -> per-weight loop removed
```

### Font files
```
app/fonts/space-grotesk-{400,500,600,700}.woff2
app/fonts/instrument-serif-400.woff2
app/fonts/instrument-serif-400-italic.woff2
app/fonts/jetbrains-mono-{400,500,600}.woff2
app/fonts/geist-100-900.woff2
app/fonts/geist-mono-100-900.woff2
app/fonts/poppins-{400,500,600,700}.woff2
app/fonts/roboto-{400,500,700}.woff2
app/fonts/merriweather-{400,700}.woff2   (replace with one variable file)
```

### CSS
```
app/globals.css     : all 12 [data-accent] blocks; the html[data-theme='warm'] scope;
                      --vb-* palette (786-832) + .vibrant-display-* (842-843);
                      --dc-* shim (594-639); .dc-display-xl/-lg/-md (643-645);
                      --density (70); .resume-builder-scope (900-903)
styles/tokens.css   : .robo-eyebrow, .robo-table-caption; the --robo-* shim once call sites move
styles/v3.css       : .orb-*, .nav-section uppercase, .crumbs mono, .page-h h1 em, .eyebrow pill,
                      all sub-12px and half-pixel font-sizes, all uppercase, all glow shadows
styles/v3-resume.css: 'Newsreader' (×3), literal 'JetBrains Mono' (×4), 18 uppercase decls
styles/v3-preferences.css : .pref-mode-desc, .pref-blocked-reason, 7 uppercase decls
styles/landing.css  : .serif-human, the terminal block
```

### Settings
`accent` · `density` · `tone` · `aggressiveness` (both the localStorage one and the server enum) ·
`dailyCap` · `theme: warm` · `huntActive` (renamed `searchActive`).

### i18n keys
Delete namespaces: `app`, `nav` (old), `home`, `tracker`, `search`, `jobs` (old), `insights`,
`resumes_v2`, `mission`, `apps`, `settings` (old), `queue`, `choosePlan`. — **~530 en strings.**
Delete within surviving namespaces: the 18 tone-forked keys (`today.headline.*`, `today.sub*`,
`pipeline.headline.*`, `pipeline.sub` × direct/playful/formal); every key on the banned-words list;
`today.appliedBanner`; `today.stats.*`; `activity.stats.hoursSaved`; `preferences.plan.*`;
`preferences.integ.*`; `preferences.hunt.plain_label`; `nav_v3.status_*`, `nav_v3.agent_state`,
`nav_v3.aggr_*`, `nav_v3.brand_tagline`, `nav_v3.tweaks`.
Then apply the rename/merge map in §3.4 and re-translate to all 9 locales (D19).

### Backend
`RECOMMEND_MIN_TURN`, `FORCED_RECOMMEND_TURN`, `SESSIONS_PER_DAY` (`RAOnboardingService.ts:75-82`);
`MINUTES_SAVED_PER_APPLY` + `hoursSaved` + `scannedOvernight` + `replies` from
`RAActivityService.orbStats()`; `RAIntegrationsService` routes;
`RAQueueService` + its routes. **No agent files are deleted.**

---

## 8. Implementation plan

Each wave is independently shippable and independently revertible. Waves 1-3 have no dependency on
each other and can run in parallel by different engineers.

---

### Wave 1 — Truth and the funnel *(highest leverage; ship today)*

**Goal.** Stop lying, and stop sending new users to a sign-in page. No design dependency, no
migration, under a day of work, and it independently unblocks launch.

**Files.**
- `components/landing/LandingContent.tsx` — all 7 CTAs `href="/onboarding"` → `href="/signup"`
  (lines 125, 180, 501, 697, 703, 780, 828).
- `app/(public)/signup/page.tsx:39` — `router.replace('/choose-plan')` →
  `router.replace(next ?? '/jobs')`, reading `useSearchParams` with the same open-redirect guard
  `login` already uses.
- `app/(public)/login/page.tsx` — sub copy; promote the signup link to a button; forward `?next=`.
- `lib/proxyPaths.ts` — remove `/mission`, `/apps`, `/settings`, `/search`, `/jobs`, `/insights` from
  `PROTECTED_PREFIXES`; add redirects in `next.config.js`.
- `components/v3/today/MatchCard.tsx` — split the primary action: `Apply on company site`
  (`window.open(job.applyUrl, '_blank', 'noopener')`) + secondary `Mark as applied`
  (existing `useApplyJob`). Delete the `Schedule auto-apply` button.
- `i18n/messages/*.json` — rewrite `today.appliedBanner`; delete `today.stats.*` keys.
- `components/v3/today/TodayStatStrip.tsx` — delete; remove from `app/(auth)/home/page.tsx`.
- `app/(auth)/home/page.tsx` — replace the overnight headline with
  `{n} jobs that fit you.` / `Updated {time}.`
- `server/src/roboapply/v2/services/RAActivityService.ts` — remove `hoursSaved`, `scannedOvernight`,
  `replies` from the payload.

**Verification.** Anonymous click on every landing CTA reaches `/signup`. Signup with
`?next=/jobs/123` lands on `/jobs/123`. `Apply on company site` opens the real posting in a new tab.
No screen renders a hardcoded 0. `grep -rn "appliedBanner\|hoursSaved\|scannedOvernight" i18n app components server/src` returns nothing.
**Build risk:** removing `orbStats` fields breaks `OrbCard` and `ActivityStatStrip` typing — delete
`OrbCard` in the same commit and stub `ActivityStatStrip` to the two real numbers.

---

### Wave 2 — Typography

**Goal.** One family, eight sizes, 12px floor, no uppercase, no half-pixels.

**Files.** `app/layout.tsx` (delete 7 `localFont` blocks, keep Inter as `--font-ui`) ·
`app/fonts/*` (delete per §7) · `tailwind.config.ts` (add `fontSize`, update the stale header comment) ·
`app/globals.css` (`:root` token table, raise base 14px→15px) · `styles/v3.css`,
`styles/v3-resume.css`, `styles/v3-preferences.css`, `styles/landing.css`, `styles/auth.css`,
`styles/tokens.css` (codemod every `font-size` onto the 8 tokens; delete every
`text-transform: uppercase`; delete every `var(--mono)` and `var(--serif)` rule) ·
25 `<em>` call sites across 24 TSX files · `lib/resumeTheme.ts` (8 options → 4) ·
`app/(auth)/resume/[id]/` (lazy `localFont` for the 3 resume faces).

**Verification.** `.next/server/next-font-manifest.json` lists **one** woff2 for the app routes and
three additional only for `/resume/[id]`. `grep -c "font-family" styles/*.css app/globals.css` returns
only `--font-ui` / `--font-mono` / `--resume-*`. Zero `text-transform:uppercase` in the app scope.
Zero font-size values outside the 8 tokens. Zero `.5px` sizes.
**Build risk:** `lib/resumeTheme.ts` references `--font-geist-sans` etc.; update it in the same commit
or the resume Designer tab renders unstyled.

---

### Wave 3 — Colour, surface, motion

**Goal.** Two themes, one brand, three shadows, no glow.

**Files.** `app/globals.css` (token tables per §5.1; delete 12 `[data-accent]` blocks, the `warm`
scope, `--vb-*`, `--dc-*`, `--density`, `.dc-display-*`, `.vibrant-display-*`) ·
`styles/tokens.css` (`--paper-muted`, delete `--paper-faint`, delete `.robo-eyebrow`,
`.robo-table-caption`) · `lib/dcTheme.tsx` → `lib/theme.tsx` (theme only) ·
`app/(auth)/layout.tsx` (stop writing `data-accent`, `data-density`, `data-tone`,
`data-aggressiveness`) · all 6 stylesheets (replace 80 `box-shadow` decls with `--e1/--e2/--e3` and
the single focus ring; 126 gradients → 1).

**Verification.** Automated contrast check over every documented fg/bg pair passes 4.5:1. No
`box-shadow` in the codebase contains `--brand`/`--accent`/`glow`. `data-accent` and `data-theme="warm"`
appear nowhere. Screenshot diff of every route in light and dark.

---

### Wave 4 — Information architecture

**Goal.** Four destinations, real routes, working redirects, mobile parity.

**Files.** Create `app/(auth)/jobs/{page.tsx,[id]/page.tsx}`, `app/(auth)/applications/{page.tsx,[id]/page.tsx}`,
`app/(auth)/settings/page.tsx`; rename `resumes`→`resume`, `mock-interview`→`practice`;
delete the routes in §7 · `next.config.js` redirects · `lib/proxyPaths.ts` ·
`components/v3/shell/{Sidebar,MobileNav,Topbar,CommandPalette}.tsx` (4 items + avatar menu;
`CRUMB_MAP` gets every route; ⌘K job hits point at `/jobs/[id]`) ·
`components/v3/pipeline/columns.ts` (7 columns, delete `HIDDEN_STATUSES`) ·
`server/prisma/schema.prisma` (`recruiter_screen`, `hiring_manager` statuses — **needs
`prisma db push`, confirm before running**).

**Verification.** Every old URL 301s to its new home. `/jobs` search from ⌘K lands on the posting.
Mobile bar shows 4 tabs and the avatar sheet reaches Settings and Billing. No route 404s after login.

---

### Wave 5 — Copy and i18n

**Goal.** One noun per object, nine locales at parity.

**Files.** `i18n/messages/en.json` (delete 13 namespaces, apply the rename/merge map, rewrite every
surviving string against §3.3) · all page/component `useTranslations` call sites · then the
`i18n-locale-sync` skill for the other 8 bundles.

**Verification.** `en.json` leaf count ≤ 1,200. The banned-words grep across all 9 bundles returns
zero. Every `useTranslations(ns)` argument appears in the final 13-namespace list. Every locale bundle
has the same key set (structural diff = empty).
**Build risk:** next-intl throws on a missing key in dev — delete keys only after their call sites are
rewritten, namespace by namespace.

---

### Wave 6 — Value before account

**Goal.** Anonymous resume → 5 scored jobs in under 90 seconds.

**Files.** `server/src/roboapply/v2/routes/preview.ts` (new; 3 endpoints per §6.0) ·
`RAOnboardingService.ts` (delete `RECOMMEND_MIN_TURN`, `FORCED_RECOMMEND_TURN`, `SESSIONS_PER_DAY`;
allow a zero-elicitation round) · `components/landing/LandingContent.tsx` (hero drop zone) ·
`app/(public)/preview/[token]/page.tsx` (new) · `components/ResumeGate.tsx` (wall → inline empty state) ·
the setup chat re-mounted as a panel in `/jobs`.

**Verification.** A logged-out browser drops a PDF and sees 5 real cards with working `View job` links
in <90s. Signup claims the preview and the same 5 cards appear on `/jobs`. Rate limit holds at 5/hour/IP.

---

### Wave 7 — Feed truth

**Goal.** The results reflect what the user asked for, and every number on a card is correct.

**Files.** `hooks/useTodayMatches.ts` (pass `q`, `location`, `salaryMin`, `workType`,
`employmentType` from `RACareerGoal`/`RAPreferences`) · `RAJobIndexService.ts` (accept `workAuth`) ·
`RAJobMatchScorerAgent.ts` (`formatInput` takes `workAuth`; add the cap-at-35 rule) ·
`components/v3/today/lib.ts` (`Intl.NumberFormat`, ISO codes, `salaryPeriod`, drop `k` outside
USD/EUR/GBP) · `RATrackerService` (duplicate detection by company + fuzzy title, 60-day block) ·
`JobCard` (posting age, 45-day grey-out, work-auth badge).

**Verification.** A user with `salaryMin: 150000, workType: remote` sees only matching jobs. A PHP job
renders `₱90,000 PHP / month`. A US-onsite no-sponsorship job scores ≤35 for a candidate needing
sponsorship, with work auth as the first gap. Applying to a company already in the tracker shows the
warning.

---

### Wave 8 — Real interview evaluation

**Goal.** The grade is produced by a model that read the transcript.

**Files.** `server/src/roboapply/v2/agents/RAInterviewEvalAgent.ts` (new; configured interview task model, temp 0.1,
quote-citation output contract, `parseOutput` throws) · `RAMockService.ts` (`score()` calls the agent;
`heuristicScore` becomes the labelled fallback) · `app/(auth)/practice/[id]/report/page.tsx` +
`components/mock-interview/v3/Scorecard.tsx` (homework layout per §6.7).

**Verification.** Two sessions — one with a specific quantified answer, one padded with the same digits
— produce materially different scores and different quotes. Every dimension score renders a verbatim
quote. Killing the LLM produces the labelled fallback, never a crash.

---

### Wave 9 — Follow-ups

**Goal.** Replace auto-apply with the automation that actually helps.

**Files.** `RATrackerService` (`followUpAt` computation, contact fields) ·
`RoboApplyCronService` (10-day / 3-day sweep) · a follow-up draft agent (reuse
`RAResumeRewriteAgent` plumbing) · the `/jobs` action row · `/applications` card fields.

**Verification.** An application set to `applied` 10 days ago with no status change produces a nudge
with a drafted 3-line message and a `Copy` button. Nothing is ever sent by the product.

---

## 9. Open questions for the CEO

**Q1. Auto-apply: dead, or parked?**
This spec deletes it as a concept, a promise, and a vocabulary. Rebuilding it later means a real
submission engine (per-ATS form automation, CAPTCHA, account creation on employer sites) — months, not
weeks, and legally fraught.
**Recommendation: dead.** Sell targeting and preparation, which we are already good at, and which
nobody in the competitive set does well. Auto-apply is a commodity Simplify gives away free.

**Q2. Light theme as the default, dark as an option.**
The product is currently dark-first with an electric-lime accent. This spec flips the default.
**Recommendation: light default.** A stressed person deciding whether to trust us with their career
reads neon-on-black as a crypto dashboard. Dark stays first-class and fully designed. If you want
dark-first for brand reasons, say so now — it is a one-line change in Wave 3, but not later.

**Q3. Brand colour: teal `#0B6E8C` / `#4FC3E8` replaces electric lime `#C9FF3B`.**
Lime is unusable as a foreground and forces near-black ink on every fill.
**Recommendation: approve the teal.** If lime must survive for brand recognition, it can be retained
as a single decorative fill on the landing hero only, never as an interactive colour.

**Q4. Do we translate all nine locales to full app parity?**
Today five locales are landing-only, which means we market in Spanish and then hand the user an
English app. The purge makes parity affordable (~1,100 strings × 5 new bundles).
**Recommendation: yes, full parity in Wave 5.** The alternative — deleting the de/es/fr/ko/pt landing
pages — costs us SEO surface we already own.

**Q5. Pricing is denominated in practice-interview credits, but the product now leads with matching.**
A user who came for job matching is asked to price-compare interview credits.
**Recommendation: no repricing this cycle.** Keep credits for Practice (it is the one thing people
already pay for and the copy is the clearest in the product), make matching + resume tailoring
unlimited on Free, and revisit pricing after we see how many free users hit Practice. But the
plan picker must move out of the signup path regardless — that decision is already binding (D10).
