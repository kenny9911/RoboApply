# RoboApply Onboarding

> Status: **BINDING.** Subordinate to `OVERHAUL_RULINGS.md`, superior to `OVERHAUL_SPEC.md`
> wherever the two touch first-run setup.
> Date: 2026-07-29. Author: design lead. Written from four expert panel reports plus a
> line-level audit of the shipped server and client.

---

## 0. The one sentence

Onboarding exists to collect the one input the product cannot work without — a resume — and to
**show the user what was read back to them for correction**, so that the first job list they ever
see is aimed at them instead of at everyone.

**The single number it is optimised for:**

> **Median seconds from account created to the first scored job card visible on `/jobs`.**
> **Target: ≤ 60 s p50, of which ≤ 30 s is user input time.**

Everything in this document is judged against that number. Today it is unbounded, because the
number is never reached: a new user lands on the entire unarchived `RAJob` corpus in reverse posting
order with no scores at all.

Two things follow immediately, and they are the whole design:

1. Every question the product asks that the resume already answers is a public admission that it
   did not read the resume.
2. Every field captured that the destination screen discards is theatre. The retrieval wire ships
   first (Wave 1), before any new pixel.

---

## 1. Decisions

### D1 — Setup is two steps, and it is a panel inside `/jobs`, not a route and not a shell replacement.

**WHY.** The panel occupies the page slot inside the authenticated shell (`app/(auth)/layout.tsx`
renders `<div className="main-inner">{children}</div>`). Topbar, Sidebar, MobileNav, avatar menu,
sign out, theme toggle and locale switch stay mounted behind it. Today `ResumeGate` wraps the whole
shell and replaces it, so a first-run user has no sign-out and cannot self-recover from the stale
session class of bug that commit `212a2e6` exists to fix. `OVERHAUL_SPEC.md`'s own WHAT-DIES list
already retires "ResumeGate as a wall"; this is that deletion, executed.

**WHAT DIES.** `components/ResumeGate.tsx` as a shell wrapper. The `/onboarding` route stays dead.

---

### D2 — The D11 tension is not a conflict. Ruling D11 bans elicitation before value; it does not ban the input without which there is no value. The CEO wins on the trigger; D11 wins on the shape.

**WHY.** D11 reads: *"Setup is a panel, not a gate. The chat refines results; it never precedes
them."* Its object is the seven-turn interrogation — five minutes of typed trust extracted before
any evidence is offered. Three facts settle the reading:

- The literal reading ("nothing may precede `/jobs`") is **already false in shipped production
  code**: `ResumeGate` precedes `/jobs` today, replaces the entire shell, and captures nothing in
  return. The choice on the table was never gate-versus-no-gate. It is what the unavoidable resume
  step is allowed to accomplish while the user is standing there.
- The ruling is self-refuting under the literal reading: it says the chat *refines results*;
  refinement requires results; results require a resume scored against something. A preference
  panel over an empty result set has nothing to refine.
- D10 (anonymous resume → 5 scored jobs, Wave 6, not built) puts the resume drop in the **landing
  hero** — as far before the app as a step can physically go. The rulings already accept that the
  resume comes first.

So: the resume step precedes the feed, the *chat* does not. Zero conversational turns before
results. What we build is one component, one name (`Tell us what you're looking for`, C21), one
place (the `/jobs` filter bar), auto-opened on first run and opened by tap thereafter. D11's
sentence is satisfied literally, and the CEO's request is satisfied completely.

**WHAT DIES.** The reading that no screen may precede `/jobs`. Nobody was defending it in practice.

---

### D3 — Confirmation, not interrogation. The draft is seeded from the parsed resume before the user is asked anything.

**WHY.** `RAOnboardingService.pickNextTopic` walks seven topics one LLM round-trip at a time
(`targetRoles → workMode → salary → industry → employmentType → location → seniority`). A chat turn
costs a read, a decision, typing and a round trip — 12 to 16 seconds each when nothing goes wrong.
Seven of them is 90–180 s of user time, 8+ blocking round trips, ~10 Haiku + up to 25 Sonnet calls.
Meanwhile `bootstrap()` already reads `parsedData`, `summary` and `resumeMarkdown` and uses them for
two cosmetic things — display rows and a prose headline — then writes `draftPreferences: {}`.
`RAOnboardingKickoffAgent`'s own prompt instructs the model to determine role, trajectory, tenure
and *"Location and work-mode hints"*, and then emits them **only as a sentence**.

A correct prefilled chip costs a one-second glance. A wrong one costs one tap. That asymmetry is a
4× difference in user time, not a 15% one.

**WHAT DIES.** `pickNextTopic` and every caller. The seven topics as a user-facing sequence.

---

### D4 — There is no chat in onboarding at all. `/chat/stream` is deleted, not shortened.

**WHY.** This is where the panel reports were split and I am overruling the softest of them. Three
panels proposed keeping the chat "downstream, after results". That is a real product — it is what
D11 describes — but it is not this wave, and the last time this codebase shipped a component in
advance of its consumer we got `components/v3/onboarding/*`: nine components, 455 lines of hook,
five test files, 60 translated strings, imported by nothing. Ship the surface with its consumer or
do not ship it.

Deleting the chat also deletes the flow's entire LLM wall-clock: bootstrap becomes **1 Haiku**
(often 0 — see D5), confirm becomes **0 or 1 Haiku**.

**WHAT DIES.** `POST /onboarding/chat/stream`, `RAOnboardingChatAgent`,
`RAOnboardingSearchPlannerAgent`, `RAOnboardingKickoffAgent`, `RAOnboardingService.runTurn` and its
composers, `hooks/useOnboardingChat.ts`. If the refinement chat ships later, restore
`consumeNdjsonStream` / `applyStreamEvent` from git at `868dc6a` — they are correct and tested.

---

### D5 — Seeding is deterministic first, LLM second. The LLM never blocks the confirm screen.

**WHY.** Roles, employment types, city and years are all sitting in `ParsedResume` as structured
fields (`experience[].role`, `.company`, `.location`, `.employmentType`, `address`), and
`estimateYears` in `raOnboardingIngestRows.ts` already computes total years and then renders it into
a display string. `EMPLOYMENT_TYPE_TABLE` in `raOnboardingDraft.ts` already maps `'full-time'` and
`'freelance'`. Zero new normalization is required for four of the five seeded fields.

So the deterministic seed runs in-process, in single-digit milliseconds, and the confirm screen
renders off it. One Haiku agent (`RAOnboardingResumeSeedAgent`) runs in parallel and contributes
only `industriesTarget`, plus a role list when the deterministic path found none (thin resume). If
it fails or is slow, the screen is already correct.

**WHAT DIES.** The idea of reusing `RAOnboardingPrefExtractAgent` on the resume. Its prompt is
built to refuse: *"Past facts are not preferences"*, plus a hard `pastedResumeDetected` stop with a
code-level twin in `parseOutput` that discards updates. Reusing it is a prompt inversion, not a
config change. Keep everything below the prompt — `normalizeDraftUpdates`, `dropFalseClears`,
`normalizeFieldConfidence`, `mergeDraft`, the whole taxonomy layer, and the protected-attributes
rule, which matters *more* on a resume.

---

### D6 — Three controls decide the result set. Everything else is seeded silently or not captured.

The confirm screen shows: **Job titles**, **Where and how**, **Direction**. Plus two optional rows:
**Companies you'd like to work for** (the CEO's explicit ask) and one free-text line.

**WHY.** I traced what can actually move a first result set, and the answer is brutal.
`RAJobMatchScorerInput` is `{resumeMarkdown, jobTitle, jobDescription, jobQualifications,
jobBenefits}` — **no preference field of any kind reaches the scorer**. Preferences can only move
*retrieval*. Retrieval is `RAJobIndexService.search`, whose only preference-shaped parameters are
`q`, `location`, `workType`, `employmentType`, `salaryMin`. Of those:

| Field | Effect on the first result set | Verdict |
|---|---|---|
| `targetRoles` → `q` | Token-OR across `titleNormalized`, `companyNameNormalized`, `descriptionPlain`. Decisive. | **Ask** |
| `workModes` → `workType` | Exact column match. Decisive, and safe when unset. | **Ask** |
| `locations.cities` → `location` | Substring `contains` on `location`/`locationCity`. Decisive **and destructive** when wrong. | **Suggest, never assert** |
| `seniority` | Appears nowhere in retrieval. | Ask as **Direction**, which rewrites the titles |
| `employmentTypes` | `where.employmentType` exact-matches a column most external rows leave null. | Seed silently, never filter |
| `salary` | `where.salaryMax = { gte: min }`; a null `salaryMax` fails `gte`, so a floor silently deletes every posting without salary data — and senior postings publish ranges least often. | **Never ask, never filter** |
| `industriesTarget` | Absent from `passesPrefilter` entirely. Only `industriesAvoid` appears. | Seed silently |
| `companyStages`, `companySizes`, `mustHaves` | No topic asks for them today; no retrieval reads them. | Free text only |

**WHAT DIES.** Asking for salary, employment type, target industries, company stage and company
size during setup. Four of them are inert; salary is worse than inert.

---

### D7 — Salary is never asked, never inferred, never used as a filter.

**WHY.** A resume does not state pay, so any seeded number is a guess. As a filter it is
destructive for the reason in D6's table — and the failure is invisible: the user never sees what
was removed. Candidates also misstate comp predictably in both directions, and the ones who
understate are disproportionately the people this product exists to help.

**WHAT DIES.** `jobs.setup.fields.salary` as a setup control. `salaryMin` is never passed from
`useTodayMatches`. Pay stays editable in Settings → Hunt, where it already lives.

---

### D8 — Location is seeded as a question, not as an answer.

**WHY.** Current city is the most inferable-*looking* field that is most often wrong about intent.
The resume says Bangalore; the goal is remote EU/US. A prefilled "Places: Bangalore" that the user
taps past silently inverts their entire search, and a `contains` filter on a city outside the corpus
geography returns zero rows — turning the aha moment into "no jobs found". The shipped extractor
prompt already encodes this instinct (residence without search intent → confidence ≤ 0.6); the seed
must not throw it away.

This overrules the conversation panel, which proposed prefilling `locations.cities` as a confirmed
value. It loses because the failure is silent and the blast radius is the entire result set.

**WHAT DIES.** Any code path that writes `locations.cities` at confidence ≥ 0.7 without an
affirmative user tap.

---

### D9 — Level is never asked. Direction is asked, and it rewrites the title chips in front of the user.

**WHY.** Title inflation swings a full band between a 20-person startup and a bank, and candidates
self-report about one level high. What a resume genuinely cannot know is *direction*: an 8-year QA
resume reads identically whether the person wants QA lead or wants out of QA forever.

But a control that changes nothing on screen is worse than no control. So Direction is wired to a
visible, deterministic effect: tapping **A step up** rewrites the seeded title chips through a
role-ladder table (`ic → senior → staff → principal`, `manager → director → vp → cxo`), in place,
with no round trip. "Senior Software Engineer" becomes "Staff Software Engineer" and the user
watches it happen. Tapping **Open to less senior** strips the level prefix, widening `q`.

**WHAT DIES.** The 8-value seniority picker as a setup control.

---

### D10 — Nothing is shown inside the flow that `/jobs` will show one second later.

**WHY.** All four panels agreed and I am ratifying it. The orchestrator's S3 renders the same list
twice, delays the only screen that matters, and forces back the `{score} / 100` card headline that
commit `1f4fb83` deliberately deleted.

Consequence: **the recommend round does not run inside onboarding.** Confirm persists and closes;
`/jobs` runs its normal preference-driven search and lazily scores each visible card with the
`useJobScore` path that already ships. This removes 1 Haiku planner + up to 8 Sonnet scorers and
12–25 s of blocking wall-clock from the first-run path.

To keep the corpus from being thin for a brand-new query, `POST /onboarding/confirm` fires **one
fire-and-forget external provider fetch** keyed to the confirmed roles + location — retrieval only,
no scorers, no user-visible wait.

**WHAT DIES.** `RAOnboardingRecommendService.runRound` and `rehydrateCards` in the first-run path;
`OnboardingJobCard.tsx`; `JobCardStack.tsx`; `POST /onboarding/pass`.

---

### D11 — Work authorization is captured in Wave 7, with the badge it feeds, and not before.

**WHY.** The recruiter panel is right on substance: for an international candidate the actual
reason they are not getting interviews is very often sponsorship, and the published rubric already
advertises *"Location, pay, and visa — 10"* (`i18n/messages/en.json:71`). `RAPreferences.workAuth`
exists and is rendered in Settings → Hunt. But ruling C18 permits badges **only** from a real
extracted signal, and no job row carries one yet. Shipping the question now captures an answer that
changes nothing visible — the exact failure this spec bans everywhere else.

The recruiter panel loses on **sequencing only**. The question ships in the same wave as the
sponsorship badge (Rulings wave 7, "Feed truth"), phrased per C18: `Do you need a company to
sponsor a visa?` Until then it remains reachable in Settings and through the free-text line.

**WHAT DIES.** Nothing. This is a deferral with a named home.

---

### D12 — "Ideal companies" ships as `targetCompanies`, and it boosts; it never filters.

**WHY.** This is the CEO's literal words, and there is no such field anywhere today —
`preferencesBlob` has only `blockedCompanies`. As a where-clause a wish list returns an empty page
on day one, which is the worst possible first-run outcome. So it renders as one labelled row above
the feed: `Jobs at companies you named`, resolved by a new exact `company` parameter on
`search.run`, capped at 3 companies × 3 jobs. When a named company has nothing open, the row states
that plainly and does not promise a future notification — no watcher exists, and promising one is
the same species of claim as the deleted `today.appliedBanner`.

**WHAT DIES.** The recruiter panel's "we'll tell you when they post". It loses because the product
cannot currently keep it.

---

### D13 — The daily session cap stops being a first-run wall.

**WHY.** `SESSIONS_PER_DAY = 3`, counted from UTC midnight. Three resume re-picks with a turn each
and a four-minute-old account is 429'd out of setup for the rest of the day, with copy that says
"Come back tomorrow." With the chat gone, a session costs at most 2 Haiku calls.

**WHAT DIES.** `SESSIONS_PER_DAY = 3` → `20`. `jobs.setup.error_daily_limit` is rewritten to name a
recovery instead of a date.

---

### D14 — The retrieval wire ships first, alone, before any new pixel.

**WHY.** `hooks/useTodayMatches.ts:66` calls `raV2Api.search.run({ sortBy: 'match_desc', limit })`
with no `q`, no `location`, no `workType`, ever. `grep -rn preferencesBlob server/src` returns three
consumers and `/jobs` is not one of them. Without this, every screen in this document produces a
beautifully confirmed preference set that the destination discards — which reads to the user as the
product ignoring everything they just said, and that is worse than never having asked.

**WHAT DIES.** The assumption that onboarding is the missing piece. It is the second missing piece.

---

## 2. The trigger

### 2.1 What starts it

The signal already ships and has zero consumers: `GET /api/v1/roboapply/auth/me` returns
`onboardingState { completed, completedSteps[] }`, derived from a live `RAResumeVariant` count
(`hasResume`) and `preferencesBlob.onboarding.completedAt` (`hasIntent`).
`lib/auth/AuthProvider.tsx` already threads it to `useAuth()`.

On mount of `app/(auth)/jobs/page.tsx`:

| Condition | Result |
|---|---|
| `!completedSteps.includes('resume')` | Panel auto-opens at **Step 1**. |
| `completedSteps.includes('resume')` && `!completedSteps.includes('preferences')` && `autoOpens < 2` | Panel auto-opens at **Step 2**, bootstrapped against the user's primary variant. Step 1 is never rendered. |
| `onboardingState.completed` | Panel closed. Opens only from the filter bar. |
| `preferencesBlob.onboarding.skippedAt` set within the last 7 days | Panel closed, regardless of the above (except no-resume, which always opens). |

`autoOpens` is a new integer on `preferencesBlob.onboarding`, incremented server-side on every
`POST /onboarding/bootstrap` that the client flags `auto: true`. **Hard cap: 2 auto-opens ever.**
After that the panel is reachable only by tap, forever.

No other route gates. `/applications`, `/practice` and `/resume` render normally with no resume —
their own empty states already do the right thing. Gating only `/jobs` is what "ResumeGate as a
wall dies" means in code.

### 2.2 What ends it

- **Confirm.** `POST /onboarding/confirm` returns 200 → panel closes → the feed query invalidates
  and refetches with preferences → `onboardingState.completed` becomes true on the next `/auth/me`.
- **Skip.** Available on Step 2 only. `POST /onboarding/skip` stamps
  `preferencesBlob.onboarding.skippedAt`, flushes nothing else, and closes the panel. `/jobs` then
  renders with the banner `jobs.setup.skipped_banner`.
- **Step 1 has no skip.** Not because setup is a toll, but because with no parsed resume the scorer
  has literally nothing to compare and the feed is the whole corpus in posting order. There is no
  honest skip to design. The user is never trapped: the shell is mounted, every other destination
  is one tap away, and Step 1 offers four ways in.

### 2.3 Re-entry

- **Mid-Step-1 reload.** No session exists yet; the panel reopens at Step 1.
- **Mid-Step-2 reload.** `GET /onboarding/session` restores the session, the seeded draft, the
  ingest rows and any edits already persisted by the autosave in §3.3. `RESTORE_WINDOW_DAYS = 7`.
- **Second device, same session.** The existing supersede semantics stand: the newer bootstrap wins
  and the older client shows `jobs.setup.superseded_notice`.
- **Has a resume, no preferences** (the `/resume`-first path, and every user created before this
  ships): Step 2 only, one screen, bootstrapped from the primary variant. This is the single most
  common state in the existing user base and it is a one-screen onboarding.
- **Resume deleted down to zero variants.** `hasResume` flips false and the panel returns at
  Step 1. This is correct: the product cannot score anything.

---

## 3. The flow, screen by screen

**Total: 2 steps.** One when a resume already exists.

**Defence of 2.** One is impossible: the product cannot both read a resume it does not have and
confirm what it read. Three is what shipped before and it is where users leave — the panel walkthrough
put abandonment on the empty composer and on the pay question at turn 3. The only candidate third
step is "show scored jobs inside the flow", which is the destination rendered twice (D10). Two is the
floor, and the second one requires zero typing.

---

### Step 1 — Add your resume

**Purpose.** Get one parseable document, by whichever of four doors the user can actually reach.

**On screen.**
- Title `jobs.setup.resume_title`, lead `jobs.setup.resume_lead`.
- A real drop zone: `onDragOver` / `onDragLeave` / `onDrop` **plus** click-to-browse. Today
  `UploadStep.tsx` is a `<label>` wrapping an `<input>` — the copy says "Drop your resume here" and
  dropping does nothing.
- `jobs.setup.resume_or`, then three text buttons: `resume_paste`, `resume_linkedin`,
  and `resume_pick_existing` (rendered **only** when `resumes.length > 0`, i.e. never on first run).
- `jobs.setup.resume_formats` — the accept list must match `ACCEPT_RESUME`: PDF, DOC, DOCX, TXT, MD,
  up to 15 MB (`MAX_RESUME_UPLOAD_BYTES`, `server/src/roboapply/v2/routes/resumes.ts:54`).
- One privacy line, `jobs.setup.resume_privacy`. Nothing today tells a user what happens to a
  document carrying their home address and nine employers, uploaded 90 seconds after signup.

**Interactions.** Drop file · browse file · paste text (textarea → `useCreateResumeMutation`) ·
LinkedIn URL (`useImportLinkedInMutation`, deployment-gated as today) · pick existing variant.

**Skippable.** No (§2.2).

**Errors, each naming its real recovery.** `empty_text` → `error_empty_text` **with the paste
textarea opened inline underneath**, because pasting is the actual fix for a scanned PDF and
"retry or write one from scratch" is not. `unsupported_format`, `file_too_large`, `parse_failed`,
`save_failed` as in §4.

**Server.** `POST /v2/resumes` (upload) or `POST /v2/resumes` (paste) or the LinkedIn import route —
all unchanged. On success the client immediately calls `POST /v2/onboarding/bootstrap
{ resumeVariantId, auto }`.

**While parsing.** The card does not swap yet. `IngestRecap` streams the server-built rows
("What your resume says": identity, experience, skills, education, links, summary) with the existing
staggered reveal. This is not a spinner — it is the evidence that justifies the prefill on Step 2,
and it is the single trust device in the flow.

**Target seconds.** 10 s user + 8–15 s parse.

---

### Step 2 — Check what your resume says

**Purpose.** One glance, zero-to-three taps, no required typing.

The card swaps **in place**. No route change, no second modal, so the pre-upload state survives an
app switch to Files/Drive and back on mobile.

**On screen.**

- Title `jobs.setup.confirm_title`, lead `jobs.setup.confirm_lead` (or `confirm_lead_returning` when
  reopened from the filter bar).
- **Evidence column** — `IngestRecap`, unchanged, under `jobs.setup.upload_ingest_title`. On mobile
  it collapses above the controls.
- **Control 1 · Job titles** (`fields.targetRoles`). 1–3 prefilled chips from the resume, each with
  a remove control (`chip_remove`). Below: `chip_suggested` and up to 4 tappable alternates. Below
  that: an add input (`chip_input_placeholder`). Evidence line: `why_roles`.
- **Control 2 · Where and how** (`fields.where`). Three mode pills — `values.remote`,
  `values.hybrid`, `values.onsite` — **none selected by default**, and the empty state says so
  (`chip_none`). Then the resume's city as an **unselected suggestion chip** (`where_city_suggest`),
  plus an add-a-place input. Evidence line: `why_locations`.
- **Control 3 · Direction** (`fields.direction`). Three pills: `values.dir_same` (selected by
  default), `values.dir_up`, `values.dir_down`. Note underneath: `direction_note`. Tapping
  rewrites the Control 1 chips in place via the role ladder (D9).
- **Optional · Companies you'd like to work for** (`fields.targetCompanies`). Empty chip group, add
  input, empty prompt `empty.targetCompanies`.
- **Optional · Anything else** (`notes_label`). One line, `notes_placeholder`. The only place the
  extractor runs during setup. After submit, what it captured is echoed: `notes_added`.
- Primary button `jobs.setup.submit`. **Never disabled.** Secondary text button `jobs.setup.skip`
  with `skip_note` underneath.

**Chip classes — three, visually distinct.**

| Class | Rendering | Applies to |
|---|---|---|
| Read from the resume | Filled chip, evidence line adjacent | Job titles, when `experience[].role` produced them |
| Inferred | Filled chip + `uncertain` marker + 1px dashed outline | Direction's starting position, roles derived from the LLM seed |
| No evidence | Empty group, `empty.*` prompt, never blocking | Where, companies, notes |

An inferred value rendered as a read value is exactly where "fast and respectful" flips to
"presumptuous". The marker is not decoration.

**Interactions.** Tap × to remove · tap a suggestion to add · type + Enter to add · tap a mode pill
to toggle · tap a direction pill (rewrites titles) · type one free-text line · Submit or Skip.

**Skippable.** Yes, entirely. Not touching anything and pressing Submit accepts the prefill —
which is why there is no separate "accept" affordance.

**Thin resume.** When the deterministic seed and the LLM seed both produce zero roles, the screen
degrades: title `thin_title`, lead `thin_lead`, and Control 1 renders 6–8 tappable role chips
derived from whatever weak signal exists (education field, one internship, skills). No apology
attached to individual empty rows — an unfilled row just shows its `empty.*` prompt. An open
question is the most expensive thing in the UI and the user with the thinnest resume is the least
able to answer it.

**Server on submit.** `POST /v2/onboarding/confirm` — deterministic merge, one optional Haiku for
the free-text line, persist to `RACareerGoal` + `preferencesBlob`, set the variant primary,
fire-and-forget the external provider warm. No scorers, no planner.

**Target seconds.** 15 s user + 1.5 s submit.

---

### After: `/jobs`

Panel closes. `todayKeys.all` invalidates. The feed refetches with `q`, `workType` and `location`
resolved from the stored preferences (§6.5), renders scored rows first, and `useJobScore` fills each
visible card. First scored card visible ≈ 4 s later.

**Total p50: ≈ 45 s from account created.** Budget: 10 s (Step 1 user) + 12 s (parse) + 15 s
(Step 2 user) + 1.5 s (confirm) + 4 s (feed + first score).

---

## 4. The copy

Namespace: **`jobs.setup`** (C21 — one name, one place). This block **replaces** the existing
`jobs.setup` object in `i18n/messages/en.json` in full. Keys marked `// KEEP` exist today with this
exact value; everything else is new or rewritten. `jobs.filter.setup_cta` is unchanged and is the
label on the button that opens this panel.

Voice check run on every string: zero speakers (no "I", no "we"), second person, contractions
allowed, no idioms, sentence case, no banned term from `scripts/check-copy.mjs`
(no `threshold`, `ATS`, `parser`, `onsite` as a word, `aggressiveness`, `pipeline`, `trajectory`,
`dimension`, `on your behalf`, `long shot`). Every error string is under 20 words and names an
action.

```json
"setup": {
  "title": "Tell us what you're looking for",
  "sub": "The more you say, the fewer jobs you have to read. You can change any of this later.",
  "close": "Close",
  "back": "Back",
  "skip": "Skip for now",
  "skip_note": "Skipping shows every open job, newest first.",
  "skipped_banner": "Showing every open job, newest first.",

  "resume_title": "Add your resume",
  "resume_lead": "One read is enough to stop showing you jobs you would never take.",
  "resume_drop": "Drop your resume here, or click to browse",
  "resume_formats": "PDF, DOC, DOCX, TXT, or MD — up to 15 MB",
  "resume_or": "or",
  "resume_paste": "Paste the text instead",
  "resume_paste_placeholder": "Paste your resume text here. Plain text works.",
  "resume_paste_submit": "Use this text",
  "resume_paste_name": "Pasted resume",
  "resume_linkedin": "Import from LinkedIn",
  "resume_linkedin_placeholder": "https://www.linkedin.com/in/your-profile",
  "resume_pick_existing": "Use a resume you already have",
  "resume_primary_badge": "Main resume",
  "resume_last_edited": "Last edited {date}",
  "resume_received": "{name} · {size}",
  "resume_privacy": "Your resume stays in your account. It is never shown to an employer.",

  "reading_title": "Reading your resume",
  "reading_sub": "This takes a few seconds.",
  "upload_ingest_title": "What your resume says",

  "error_empty_text": "No text came out of that file. It may be a scan.",
  "error_empty_action": "Paste the text instead",
  "error_unsupported_format": "That format cannot be read. PDF, DOC, DOCX, TXT, and MD all work.",
  "error_file_too_large": "That file is over 15 MB. Try a smaller export.",
  "error_parse_failed": "That resume could not be read. Try another file, or paste the text.",
  "error_retry": "Try another file",
  "error_save_failed": "That did not save. Try again.",
  "error_daily_limit": "Setup has been restarted many times today. Go straight to your jobs, or change this in settings.",
  "error_load_failed": "Setup could not load. Try again.",

  "confirm_title": "Here is what your resume says",
  "confirm_lead": "Fix anything that is wrong. Nothing here is required.",
  "confirm_lead_returning": "These decide which jobs you see. Changes take effect right away.",

  "source_resume": "From your resume",
  "source_missing": "Not on your resume",
  "uncertain": "Check this one",

  "why_roles": "Your last jobs were {roles}.",
  "why_years": "About {years} years of work on the resume.",
  "why_locations": "{city} is on your resume.",

  "chip_add": "Add",
  "chip_remove": "Remove {value}",
  "chip_input_placeholder": "Type, then press enter",
  "chip_suggested": "Or pick one",
  "chip_none": "Nothing set. Every option stays in.",

  "fields": {
    "targetRoles": "Job titles you want",
    "where": "Where and how you want to work",
    "direction": "Where you want to go next",
    "targetCompanies": "Companies you would like to work for"
  },

  "empty": {
    "targetRoles": "Add a job title",
    "where": "Add a city, or leave this open",
    "targetCompanies": "Name a few. Their jobs go to the top."
  },

  "values": {
    "remote": "Remote",
    "hybrid": "Hybrid",
    "onsite": "In an office",
    "dir_same": "About the same level",
    "dir_up": "A step up",
    "dir_down": "Open to something smaller"
  },

  "where_city_suggest": "Still in {city}?",
  "where_add_place": "Add a place",
  "direction_note": "This changes the job titles above.",

  "notes_label": "Anything else that matters",
  "notes_placeholder": "Visa sponsorship, no agencies, within an hour of home, want out of consulting…",
  "notes_hint": "One line is enough. It becomes filters like the ones above.",
  "notes_added": "Added from what you wrote: {fields}",

  "thin_title": "That resume did not say much",
  "thin_lead": "Pick the closest job titles. That is enough to start.",

  "submit": "Show me the jobs",
  "submitting": "Finding jobs that fit you…",
  "restore_notice": "Picked up where you left off.",
  "superseded_notice": "This setup continued in another window. Reload to see it."
}
```

Two strings live outside this namespace and are added in the same commit:

```json
"jobs": {
  "named_companies_row": "Jobs at companies you named",
  "named_companies_empty": "Nothing open at {company} right now."
}
```

**Mandatory follow-up.** Run the `i18n-locale-sync` skill immediately after `en.json` lands.
`scripts/check-copy.mjs` fails the build on any key-set mismatch across the nine bundles, and
next-intl renders the literal dotted path rather than throwing (C30) — a missed locale ships the
string `jobs.setup.confirm_title` to production silently.

---

## 5. Preference capture

### 5.1 The table

| Field | Seeded from | Confidence | Shown? | User corrects it by |
|---|---|---|---|---|
| `targetRoles` | `parsedData.experience[0..1].role`, deduped, cap 3 | 0.8 | **Yes**, filled chips | One tap on × ; one tap on a suggestion; type + Enter |
| `seniority` | `estimateYears()` + level tokens in the most recent title | 0.7 | **No** — surfaced as Direction | Direction pills, which rewrite the title chips |
| `locations.cities` | `parsedData.address`, else `experience[0].location` | **0.5, unselected** | Yes, as a question | One tap to accept; type + Enter to add another |
| `locations.remoteOk` | — | — | Via the Remote pill | Tap |
| `workModes` | Never seeded | 1.0 when tapped | Yes, three pills, none preselected | Tap |
| `employmentTypes` | `parsedData.experience[].employmentType` through `EMPLOYMENT_TYPE_TABLE` | 0.6 | **No** | Settings → Hunt |
| `industriesTarget` | `RAOnboardingResumeSeedAgent`, from employers | 0.6 | **No** | Settings → Hunt, or the notes line |
| `industriesAvoid` | Never | — | **No** | Notes line only |
| `targetCompanies` **(new)** | Never | 1.0 | Yes, empty group | Type + Enter; tap × |
| `salary` | **Never** | — | **No** | Settings → Hunt |
| `companyStages`, `companySizes`, `mustHaves`, `dealbreakers` | Never | — | **No** | Notes line only |

### 5.2 Confidence handling

Today `CONFIDENCE_FLOOR = 0.7` means "the assistant must ask about this before it counts", and
`complete()` / `skip()` **delete** every field still listed in `meta.unconfirmedFields` before
persisting. A resume-seeded field at 0.6 would be silently discarded at the finish line.

Fix, with no schema change (`chips` is already a Json column carrying `SessionMeta`):

- `SessionMeta` gains `proposedFields: string[]` — seeded, not yet confirmed. Parse-tolerant, same
  pattern as the existing `unconfirmedFields`.
- `POST /onboarding/confirm` is the confirmation event. Every field **present in the submitted
  draft** is written at confidence 1.0; `proposedFields` and `unconfirmedFields` are both cleared.
- A field the user removed entirely is submitted as `[]`, which `mergeDraft` already treats as an
  explicit clear.
- A seeded field the user never looked at is still present in the submitted draft, so it is
  confirmed by omission of correction. That is the whole point of a confirm screen — but it is only
  legitimate because §5.3 holds.

### 5.3 What is not asked, and why

- **Salary** — D7. A guessed floor silently deletes jobs the user would have taken.
- **Employment type** — over 90% want full-time, the resume already carries it, and the retrieval
  column is null on most external rows, so filtering on it deletes good results.
- **Target industries** — absent from `passesPrefilter` entirely; what candidates mean by it is
  almost always a company or product preference, and it mostly restates the role.
- **Level** — D9. Title inflation makes self-reported level unreliable; direction is the part no
  document contains.
- **Company stage / size** — no topic asks for them today, no retrieval reads them, and the product
  has no company-size data to match against.
- **Work authorization** — D11, deferred to Wave 7 with the badge it feeds.
- **Anything the resume already answers** — every such question is an admission it was not read.

The rule, stated once: **propose where the resume carries evidence; leave honestly empty where it
does not; never fill a field the resume cannot know.**

---

## 6. Server changes

No Prisma migration. `RAOnboardingSession.draftPreferences` and `.chips` are Json;
`RACareerGoal.preferencesBlob` is Json.

### 6.1 New — deterministic seed

**`server/src/roboapply/v2/lib/raResumeSeed.ts`**

```ts
export interface ResumeSeedResult {
  draft: OnboardingDraftPreferences;
  fieldConfidence: Record<string, number>;
  proposedFields: string[];
  /** Deterministic, token-free evidence for the confirm screen. */
  evidence: { roles?: string[]; years?: number; city?: string };
  thin: boolean;
}

export function seedDraftFromParsedResume(
  parsed: ParsedResume | null,
  markdown: string | null,
): ResumeSeedResult;
```

Behaviour: `targetRoles` from `experience[0..1].role` (deduped, cap 3, `cleanFreeText`);
`employmentTypes` via the existing `EMPLOYMENT_TYPE_TABLE`; `locations.cities` from `address` /
`experience[0].location` at confidence 0.5 and listed in `proposedFields` but **never** written into
`workModes`; `seniority` from `estimateYears` (lifted out of `raOnboardingIngestRows.ts` and
exported) plus a level-token table. Output passes through `normalizeDraftUpdates` unchanged.
`thin = true` when `targetRoles.length === 0`.

**`server/src/roboapply/v2/lib/roleLadder.ts`** — `LEVEL_LADDER`, `applyDirection(titles, dir)`.
Exported and mirrored client-side in `lib/setup/roleLadder.ts` so Direction taps are instant; the
server re-applies it on confirm so the two can never drift.

### 6.2 New — `RAOnboardingResumeSeedAgent`

`server/src/roboapply/v2/agents/RAOnboardingResumeSeedAgent.ts`. Haiku, temp 0.1, max 700 tokens.
Input: `parsedData` JSON clipped to 6000 chars + `resumeMarkdown` clipped to 1200.
Output: `{ updates: OnboardingDraftPreferences, fieldConfidence }` — reuses `parseOutput`,
`normalizeDraftUpdates`, `dropFalseClears`, `normalizeFieldConfidence` from
`RAOnboardingPrefExtractAgent` / `raOnboardingDraft.ts` verbatim, including the protected-attributes
rule (age, gender, family status, nationality — more important on a resume, which carries graduation
years and sometimes nationality).

The prompt is the inverse of the extractor's: input is evidence about the past, output is a
*proposal* for the next job. `pastedResumeDetected`, `declinedTopics`, `wantsJobsNow`,
`wantsToFinish` are all dropped. It contributes **only** `industriesTarget`, plus `targetRoles` when
the deterministic seed found none. It runs with `Promise.allSettled` alongside the bootstrap write;
a rejection or timeout is not an error.

### 6.3 `RAOnboardingService.ts` — rewritten

**`bootstrap(userId, resumeVariantId, locale, auto)`**
- Keeps: variant lookup, `resume_unusable` guard, supersede-previous-session, `buildIngestRows`.
- Drops: the `RAOnboardingKickoffAgent` call, `openingPrompt`, `chips`, `topicSuggestions`,
  `meta.headline`.
- Adds: `seedDraftFromParsedResume` → `draftPreferences` on `create` (today it is never set, so
  Prisma defaults it to `{}`); `meta.proposedFields`; `meta.evidence`; `meta.thin`;
  increments `preferencesBlob.onboarding.autoOpens` when `auto === true`.
- Response (`OnboardingBootstrapResponse`, rewritten):
  ```ts
  { sessionId, resumeVariant: {id,name}, ingestRows,
    draft: OnboardingDraftPreferences,
    proposedFields: string[],
    evidence: { roles?: string[]; years?: number; city?: string },
    thin: boolean, returning: boolean }
  ```

**`confirm(userId, sessionId, draft, freeText, locale)` — new**
1. `normalizeDraftUpdates(draft)` → `mergeDraft(session.draftPreferences, …, [])`.
2. If `freeText` is non-empty: **one** `RAOnboardingPrefExtractAgent` call with
   `lastQuestionTopic: 'none'`, merged on top. Returns the captured field names so the client can
   render `notes_added`. This is the only LLM call in the confirm path.
3. `applyDirection` re-applied server-side.
4. All present fields → confidence 1.0; `meta.proposedFields = []`; `meta.unconfirmedFields = []`.
5. `persistPreferences(...)` — extracted verbatim from today's `complete()`: `draftToGoalInput` →
   `RACareerGoalService.upsert`; `draftToPreferencesPatch` + `targetCompanies` →
   `RAPreferencesService.update` with `onboarding: { completedAt, version: 'v5-confirm',
   completedSteps, sessionId, autoOpens }`; `RAResumeService.setPrimary`.
6. Session → `completed`.
7. Fire-and-forget `raJobIngestService.warmFromPreferences(userId, { roles, city, workMode })`.
8. Returns `{ goal, preferences, capturedFromNotes: string[] }`.

**`skip(userId, sessionId?)`** — unchanged except it now also stamps `autoOpens`.

**Deleted from this file**: `runTurn`, `pickNextTopic`, `composeChips`, `composeQuickReplies`,
`resolveQuickReply`, `composeSummary`, the wrap state machine, and the constants
`RECOMMEND_MIN_TURN`, `FORCED_RECOMMEND_TURN`, `MAX_ROUNDS`, `ROUND_SPACING_TURNS`, `MAX_TURNS`,
`MAX_SCORER_PER_ROUND`, `MAX_SCORER_PER_SESSION`, `MAX_JSEARCH_PER_SESSION`. `SESSIONS_PER_DAY`
becomes `20`. `RESTORE_WINDOW_DAYS` stays `7`.

### 6.4 `routes/onboarding.ts`

| Endpoint | Change |
|---|---|
| `POST /bootstrap` | Body gains `auto?: boolean`. New response shape (§6.3). |
| `POST /confirm` | **New.** Body `{ sessionId, draft, freeText?, targetCompanies? }`. 400 `invalid_draft`, 404 `no_active_session`, 409 `not_active`. |
| `GET /session` | Returns the same shape as `/bootstrap` plus `draft`; no card rehydration. |
| `POST /skip` | Unchanged. |
| `POST /complete` | **Deleted** — folded into `/confirm`. |
| `POST /chat/stream` | **Deleted.** |
| `POST /pass` | **Deleted.** |

Client mirror: `lib/api/v2/_real.ts:341-360` and the stub `lib/stub/raV2.stub.ts` must both change
in the same commit — the stub is typechecked by `next build` (C37 precedent).

### 6.5 Retrieval — the wire (Wave 1, ships alone and first)

**`server/src/roboapply/v2/services/RAJobIndexService.ts`**
- `SearchRunParams` gains `company?: string` → `where.companyNameNormalized = { contains: company }`.
  Exact-company row for D12; deliberately not folded into `q`, which also matches descriptions.
- No other filter semantics change. `salaryMin` keeps its current (destructive) behaviour and simply
  is never sent.

**`server/src/roboapply/v2/routes/search.ts`** — forward `company`.

**`hooks/useTodayMatches.ts`** — the feed query resolves preferences from `usePreferences()` and
sends:
```ts
raV2Api.search.run({
  sortBy: 'match_desc',
  limit,
  q: prefs.roleTitles[0],                                  // undefined when unset
  workType: onlyRemote(prefs.workModes) ? 'remote' : undefined,
  location: prefs.cities[0],                               // only when the user tapped it
})
```
**Never** `salaryMin` (D7). **Never** `employmentType` (D6). `q` is a single title because
`RAJobIndexService` token-ORs it across title, company and description — two titles would widen to
noise, not narrow.

**`components/v3/today/MatchFeed.tsx`** — feed composition: render scored rows first and stop at
the score floor rather than padding to `limit` with reverse-chronological strangers. Above them,
when `prefs.targetCompanies.length > 0`, one labelled row `jobs.named_companies_row`, resolved by up
to 3 extra `search.run({ company, limit: 3 })` calls.

**`server/src/roboapply/v2/services/RAJobIngestService.ts` (new)** — `warmFromPreferences()`. Moves
`upsertExternalJob` out of `RAOnboardingRecommendService` (do not copy it) and calls
`searchAllProviders` / `enabledExternalProviders` from `../lib/raJobProviders.js`. Retrieval and
upsert only; no scorers; fire-and-forget; failures logged, never surfaced.

### 6.6 `targetCompanies`, end to end

1. `OnboardingDraftPreferences.targetCompanies?: string[]` — `types/onboarding.ts`.
2. `normalizeDraftUpdates` passthrough — free text, cap 10, reuse `cleanFreeText`.
3. `draftToPreferencesPatch`: `if (draft.targetCompanies !== undefined) patch.targetCompanies = …`.
4. `RAPreferences.targetCompanies: string[]` + `defaults` `[]` — `RAPreferencesService.ts:69` region
   and `:190` region.
5. `lib/api/v2/types.ts:536` region — same key.
6. `lib/stub/raV2.stub.ts` — same key, or `next build` fails.
7. Rendered in Settings → Hunt beside `blockedCompanies`, which it must never be confused with.

### 6.7 Schema

**None required.** Flag for review only: nothing here needs `prisma db push`.

---

## 7. Client build

### Re-mounted unchanged
- `components/v3/onboarding/IngestRecap.tsx` → **move** to `components/v3/setup/IngestRecap.tsx`.
  Real server-built rows, 3-tier degradation ladder, reduced-motion aware. No edits.

### Lifted
- `formatDraftFieldValue` + `ENUM_VALUE_KEYS` out of `components/v3/onboarding/PreferenceTray.tsx`
  → `components/v3/setup/formatDraftField.ts`. Exported and unit-tested today; the component around
  them is discarded.
- `estimateYears` out of `server/src/roboapply/v2/lib/raOnboardingIngestRows.ts` → exported for
  `raResumeSeed.ts`.

### New
| Path | What it is |
|---|---|
| `components/v3/setup/SetupPanel.tsx` | Container. Owns the two-step state, bootstrap, confirm, skip. Consumes `jobs.setup.*`. |
| `components/v3/setup/ResumeStep.tsx` | Step 1. Real `onDrop`, browse, paste, LinkedIn, pick-existing. Rewritten from `UploadStep.tsx` + the non-`list` branches of `ResumeSelectPanel.tsx`. |
| `components/v3/setup/ConfirmStep.tsx` | Step 2. Evidence column + three controls + two optional rows. |
| `components/v3/setup/EditableChipGroup.tsx` | Removable chips + suggestions + add input. Rewritten from `ChipRow.tsx`, keeping its `OptionPill` machine-id contract. |
| `components/SetupGate.tsx` | Replaces `ResumeGate`. Mounted **inside** `main-inner`, gating `/jobs` only. |
| `hooks/useSetup.ts` | bootstrap / confirm / skip mutations, draft reducer, autosave. Replaces `useOnboardingChat.ts`. |
| `lib/setup/roleLadder.ts` | Client mirror of the server ladder, so Direction taps are instant. |

### Rewritten
- `app/(auth)/layout.tsx` — remove `ResumeGate` from the gate stack; render `<SetupGate>` around
  `{children}` inside `<div className="main-inner">`.
- `app/(auth)/jobs/page.tsx` — mounts `SetupPanel` per §2.1 and passes an `openSetup` callback down.
- `components/v3/today/MatchFeed.tsx:91` — the `Btn variant="ghost"` labelled `actions.filters` has
  **no `onClick`** today and is the first thing a curious first-run user taps. Relabel it to
  `jobs.filter.setup_cta` and wire it to `openSetup` (C21: one name, one place).
- `hooks/useTodayMatches.ts` — §6.5.

### Deleted (client)
`components/v3/onboarding/OnboardingChat.tsx`, `OnboardTop.tsx`, `OnboardingJobCard.tsx`,
`JobCardStack.tsx`, `PreferenceTray.tsx`, `UploadStep.tsx`, `ResumeSelectPanel.tsx`, `ChipRow.tsx`,
`index.ts`, `hooks/useOnboardingChat.ts`, `components/ResumeGate.tsx`, and the directory
`components/v3/onboarding/` itself.

Tests deleted with them: `__tests__/components/OnboardingChat.test.tsx`,
`OnboardingJobCard.test.tsx`, `ChipRow.test.tsx`, `PreferenceTray.test.tsx`,
`__tests__/hooks/useOnboardingChat.test.ts`. The `formatDraftFieldValue` cases in
`PreferenceTray.test.tsx` move to a new `__tests__/components/formatDraftField.test.ts` — that
function is still load-bearing.

### Design-system debt paid on the way (all inside the rewritten Step 1)

`ResumeGate.tsx` passes `npm run check:design` — which only inspects font size, weight, transform,
legacy font vars and deleted concepts — while being off-system everywhere the gate does not look.
The replacement must use tokens:
- `borderRadius: 18` → `var(--r-lg)` (18 is not on the 8/12/16/999 scale at all); the hardcoded
  `16` → `var(--r-lg)`.
- `var(--surface, #0f1117)` → `var(--surface)`. `#0f1117` is a stale V3-dark-only value; light theme
  is `#FFFFFF` and dark is `#16181D`, so a resolution failure paints a near-black card in the
  default theme.
- `var(--warn, #f59e0b)` → `var(--warn)`; `var(--text-2, #6b7280)` → `var(--text-2)`.
- Spacing literals `36px 28px`, `18px`, `22px`, `gap: 6` are off the 4/8/12/16/24/32/48/64 scale →
  `--sp-*`.
- `letterSpacing: '-0.02em'` → `var(--ls-title)`; `lineHeight: 1.55` → `var(--lh-body)`.
- The panel is `role="dialog" aria-modal="true"` with no shadow → `var(--e3)`.
- Icon sizes `26 / 15 / 13` → the shell's 13/14/16/20/22.
- Drop `className="dark-canvas"` — the panel has no `main`, so the retint rules never applied.

---

## 8. What gets deleted

**Server**
- `POST /v2/onboarding/chat/stream`, `POST /v2/onboarding/complete`, `POST /v2/onboarding/pass`
- `server/src/roboapply/v2/agents/RAOnboardingChatAgent.ts`
- `server/src/roboapply/v2/agents/RAOnboardingKickoffAgent.ts`
- `server/src/roboapply/v2/agents/RAOnboardingSearchPlannerAgent.ts`
- `server/src/roboapply/v2/services/RAOnboardingRecommendService.ts` + its test
  (`passesPrefilter`, `composeWhyMatched`, `evaluateCachedScore` and `upsertExternalJob` move to
  `RAJobIngestService.ts` first; `runRound`, `rehydrateCards`, `scoreRows`, `toCard` die)
- `RAOnboardingService`: `runTurn`, `pickNextTopic`, `composeChips`, `composeQuickReplies`,
  `resolveQuickReply`, `composeSummary`, the wrap state machine, 8 cap constants
- The `aggressiveness` parameter and the `manual`/`balanced`/`aggressive` quick-reply ids (dead
  since R1)
- Stale comments in `server/src/roboapply/routes/auth.ts:81`, `:116`, `:229` and
  `RoboApplyIntentParserAgent.ts:4` that still route the reader to `/onboarding`

**Client** — the list in §7, plus the stale `/onboarding` reasoning comments in
`components/ui/OptionPill.tsx:10`, `components/chat/MessageBubble.tsx:10`,
`components/v3/primitives/Chip.tsx:3`, `components/chrome/Logo.tsx:4`.

**Copy** — every `jobs.setup` key not in §4, in all nine locales: `card_fit` (the deleted
`{score} / 100` framing), `progress_resume`, `progress_chat`, `progress_matches`, `progress_done`,
`composer_placeholder`, `send`, `opening_prompt_hint`, `tray_title`, `tray_edit_prefix`,
`tray_dismiss`, `error_turn_failed`, `resume_continue`, `resume_upload_new`, `resume_paste_text`,
`resume_back`, `resume_retry`, `upload_title`, `upload_lead`, `upload_drop_title`,
`upload_drop_sub`, `upload_received`, `upload_reading`, `upload_error`, `reading_resume`,
`status_searching_internal`, `status_searching_external`, `status_scoring`, `wrap_cta`,
`card_via`, `card_save`, `card_saved`, `card_not_interested`, `card_removed`, `card_apply`,
and the `fields.*` / `values.*` entries superseded by §4.

---

## 9. Implementation waves

Each wave is independently shippable and independently verifiable. Per the repo rule: every wave
ends with `npm run build`, `npm run check`, atomic commits, push, and verification data cleaned up.

---

### Wave 1 — The retrieval wire

**Why first.** It is the only wave that improves the product for a user who never sees a new pixel,
and without it every later wave is theatre.

**Changes.** §6.5, minus the `targetCompanies` row (nothing writes that field yet):
`SearchRunParams.company`, `routes/search.ts` forwarding, `useTodayMatches` sending
`q` / `workType` / `location` from stored preferences, `MatchFeed` composition (scored rows first,
cut at the score floor).

**Verify.**
1. `npm run build` and `npm test` green.
2. Fixture user `claude-ui-check@example.com` with `preferencesBlob.roleTitles = ['Product Manager']`
   → `/jobs` network tab shows `search.run` carrying `q: 'Product Manager'`; every row's title,
   company or description contains a query token.
3. Same user with `salaryMinK = 150` → the request carries **no** `salaryMin`, and the row count
   does not drop.
4. A user with empty preferences → the request is byte-identical to today's.
5. Playwright: `/jobs` renders no unscored row above a scored one.

---

### Wave 2 — Server: seed, confirm, and the deletions

**Changes.** §6.1, §6.2, §6.3, §6.4, §6.6. `RAJobIngestService.warmFromPreferences`.
`SESSIONS_PER_DAY = 20`.

**Verify.**
1. `tsc -p server/tsconfig.json` clean; `npm run build` green (catches the `lib/stub/raV2.stub.ts`
   and `lib/api/v2/types.ts` drift).
2. New unit test `raResumeSeed.test.ts`: a fixture `ParsedResume` with two roles, a city, one
   `full-time` and one `contract` entry, and a 2016–2024 duration → `targetRoles.length === 2`,
   `employmentTypes` contains both, `locations.cities` present with `fieldConfidence.locations
   === 0.5` and `'locations'` in `proposedFields`, `seniority` non-null. An empty resume →
   `thin === true`.
3. `POST /bootstrap` against a real variant returns `draft` non-empty and costs **≤ 1** Anthropic
   call (assert on `writeDeductionLog` rows).
4. `POST /confirm` with `freeText: ''` costs **0** Anthropic calls and writes `roleTitles`,
   `workModes`, `cities`, `targetCompanies`, `onboarding.completedAt` into `preferencesBlob`.
5. `POST /confirm` with `freeText: 'no agencies, not defense'` → `dealbreakers` populated,
   `capturedFromNotes` non-empty, exactly 1 Haiku call.
6. `grep -rn "pickNextTopic\|runTurn\|chat/stream" server/src` returns nothing.

---

### Wave 3 — Copy

**Changes.** §4 into `i18n/messages/en.json`; then the `i18n-locale-sync` skill for the other eight
bundles; then delete the superseded keys from all nine.

**Verify.**
1. `npm run check:copy` green — this covers banned words in all nine bundles, exact leaf parity, and
   every `t()` call-site resolving.
2. `node -e` diff of leaf-key sets across the nine bundles is empty.
3. Manual read of the nine `submit` / `confirm_title` / `error_*` strings for register.

---

### Wave 4 — Client: the panel

**Changes.** §7 — new components, `SetupGate`, layout change, `MatchFeed` filters button wired,
`jobs/page.tsx` trigger.

**Verify.**
1. `npm run build`, `npm run check`, `npm test` green.
2. Playwright, fixture `claude-ui-check@example.com` reset to zero variants: sign up → `/jobs` shows
   the panel at Step 1 **with the Topbar and avatar menu mounted** (assert `[data-testid="topbar"]`
   exists — this is the stale-session recovery regression).
3. Drop a PDF onto the zone (not the input) → upload fires. Then: ingest rows appear, card swaps to
   Step 2, title chips are non-empty, the city chip is **unselected**, no salary control exists.
4. Tap **A step up** → at least one title chip text changes with no network request.
5. Press Submit having touched nothing → panel closes, feed refetches with `q`, first scored card
   within 5 s. Stopwatch the whole run from signup: **assert ≤ 60 s**.
6. Existing user with a resume and no preferences → panel opens at **Step 2**, Step 1 never renders.
7. Skip → banner renders, panel does not reopen on reload.
8. Third auto-open never happens (`autoOpens` capped at 2).
9. Mobile 375px: sticky Submit, evidence collapses above controls, no horizontal scroll.

---

### Wave 5 — Deletions and debt

**Changes.** §8 in full — orphan components, orphan agents, orphan services, stale comments, dead
tests, the `aggressiveness` remnants.

**Verify.**
1. `npm run build`, `npm run check`, `npm test` green.
2. `grep -rn "onboarding" app components hooks lib --include=*.tsx --include=*.ts | grep -v setup`
   returns only `onboardingState` consumers.
3. `grep -rn "/onboarding" server/src` returns no comment routing a reader to a deleted route.
4. Bundle size on `/jobs` does not increase versus the Wave 1 baseline.

---

### Deferred, with named homes

| Item | Home |
|---|---|
| Work authorization question + sponsorship badge | Rulings wave 7 (feed truth) |
| The refinement chat inside `/jobs` (D11's actual subject) | After Wave 5, with its consumer, or never |
| Anonymous resume → 5 scored jobs, no signup (D10) | Rulings wave 6, needs `RAPreviewSession` (C36) |
| Progressive capture — pay on the first posting with a published range, industries-to-avoid after two "Not interested" taps in one industry | Rulings wave 7 |
