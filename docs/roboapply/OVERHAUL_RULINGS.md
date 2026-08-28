# Overhaul Rulings — CEO decisions + critic corrections

> Status: **BINDING, and supersedes `OVERHAUL_SPEC.md` wherever they disagree.**
> Date: 2026-07-26. Read this file first, then the spec.
>
> The spec was written by the design lead from six expert panel reports. Three adversarial critics
> (plain-language, feasibility, differentiation) then attacked it and found 68 serious/fatal defects.
> This file records (A) the four decisions the CEO made, and (B) every critic correction that is
> accepted. Anything in the spec not contradicted here still stands.

---

## A. CEO rulings

### R1 — Auto-apply is dead. Not parked, not deferred.

Confirms spec D1. The product never claims to submit anything to an employer.

- Primary job action: **`Apply on company site`** → opens `job.applyUrl` in a new tab, and
  **immediately** moves the card to Applied with an inline `Undo` / `I didn't apply`
  (critic correction — see C11; do **not** ship the "remember to come back and mark it" instruction).
- `Mark as applied` survives only on the job detail page, for jobs found elsewhere.
- The tagline `We apply. You interview.` is retired.
- **No AI agent, prompt, or model call is deleted.** Auto-apply was never an AI capability. The
  cover-letter author + CitationGuard are repointed to an explicit on-demand action.

### R2 — Position on the gap, not on fit.

Overrides spec §0. Fit-ranked-jobs-with-reasons is the incumbent category line (LinkedIn, Indeed,
Otta, Teal, Jobright all say it). The gap is the one thing a competitor funded by employers is
structurally unable to ship.

**Hero H1:** `Find out why you're not getting interviews.`
**Sub:** `Drop your resume. We read 1,000+ open roles, show you the ones you can actually get, and
name exactly what's missing.`

Consequence, everywhere: **the job card leads with the gap, not the score.**

```
line 1   They ask for Kubernetes twice. Your resume never mentions it.   ← the gap, plain words
line 2   Your payments background matches the domain they name 3 times.  ← the overlap
corner   Great fit · 87 · 4px meter                                      ← present, not the headline
```

The four verbs are unchanged: **find → understand → fix → practice.**

### R3 — Split ink from identity.

Overrides spec D8/§5.1. The spec conflated "the colour text sits on" with "the colour the brand is",
and answered a legibility question with a safe cyan — the uniform of the category we are escaping.

Three separate roles, never confused again:

| Role | Token | Constraint | Value |
|---|---|---|---|
| **Ink** | `--text`, `--text-2`, `--text-muted` | must pass 4.5:1 on every surface | neutral greys only |
| **Action** | `--action`, `--action-hover`, `--action-ink` | must pass 4.5:1 as fill under its ink | furniture; nobody notices it |
| **Identity** | `--brand-mark` | **never carries text, ever** | free to be distinctive |

Because `--brand-mark` is never ink, contrast does not constrain it — **so electric lime survives as
the brand signature.** It appears on: the logo mark, the score meter fill at Great-fit, the streaming
caret, and the hero panel. Nowhere else, and never under a glyph.

- **Light is the default theme. Dark is first-class and fully designed.**
- `warm` theme: deleted. `data-accent` picker: deleted. Nothing else is themeable.

### R4 — Inter for reading, one display face for headlines.

Confirms spec D6 with the differentiation critic's amendment. Inter-only + white card + 12px radius
is the shadcn starter kit — modern, but not identifiable at thumbnail size.

- **`--font-ui` = Inter Variable** — 100% of read text: body, labels, buttons, inputs, tables, chips.
  This is what "natural to users" means: high x-height, open apertures, unambiguous `1 l I`, and a
  skeleton every reader has absorbed from every OS. Its CJK fallback tail is **mandatory** — four of
  nine locales currently render in undeclared system fallback.
- **`--font-display` = Instrument Sans** (`app/fonts/instrument-sans-400-700.woff2`, 29,904 B,
  variable 400–700) — used **only** at `--fs-hero` and `--fs-display`, applied to the **whole**
  headline. Never mid-sentence, never as an `<em>`, never below 28px.
- Space Grotesk, Instrument Serif, JetBrains Mono, Geist, Geist Mono, Poppins, Roboto: **deleted.**
- Total UI font payload: **710.5 KB → 78.3 KB.**

---

## B. Accepted critic corrections

These override the spec. Each was raised as fatal or serious and is accepted as stated.

### Plain language

- **C1 — Board columns.** `Saved · Applied · First call · Interviewing · Final round · Offer ·
  Rejected`. Not `Recruiter screen` / `Hiring manager` / `Onsite` / `Closed` — that is the ATS's own
  taxonomy, and "onsite" is factually wrong now that most final loops are video. Location is a
  property of an event, not a stage. Record *who* ended it on the card (`They said no` / `I withdrew`
  / `Job was pulled`) so the where-you-die diagnostic survives.
- **C2 — One quality ladder, four rungs, parallel in form, used everywhere:**
  **`Great fit · Good fit · Possible · Unlikely`.** Not `Strong/Stretch/Long shot` (idioms — the spec
  broke its own idiom ban in the row where it defined plain language). The `/jobs` filter uses the
  same four words: `Great fits only · Good fits and better · Everything`, defaulting to `Everything`.
- **C3 — Kill the numeric threshold control entirely.** Renaming `threshold` to
  "Only show jobs scoring at least {n}" renames the jargon and keeps the concept: pick an integer on
  a scale you have never seen, and silently never see what it removes. Replaced by the three-option
  tier filter above, in the `/jobs` filter bar (a view, not a preference). When it hides results, say
  so: `Hiding 40 jobs that are a weaker fit. Show them.`
- **C4 — Pick `fit`, kill `match` in user-facing copy.** Four vocabularies for one idea. Also,
  "match" borrows mutuality from dating apps — the employer does not know this person exists.
  `{n} jobs that fit you.` · `Great fit` · `Why you fit` · `What you're missing` · `Fit score 87/100`.
  Product nouns become: **job · application · resume · practice interview.**
- **C5 — The score is never the primary element.** A naked 0–100 next to a job has exactly one folk
  meaning: percentage chance of getting it. Lead with the tier word; the number reads
  `87 / 100 — how well your resume lines up with this job post`; and one permanent, non-dismissible
  line sits under the meter: **`This is not your chance of getting hired.`** Required string, not FAQ.
- **C6 — Publish the rubric in sentences, not analyst nouns.** `The job title and level — 35` ·
  `The skills they ask for — 30` · `Experience in this industry — 15` · `Location, pay, and visa — 10`
  · `How your career has moved so far — 10`. Ban `domain`, `stack`, `trajectory`, `logistics`,
  `dimension` from UI copy. Leave the internal prompt vocabulary alone.
- **C7 — `Pass` → `Not interested`.** "Pass" means *succeed* in job-search context and in all nine
  target languages; it is a guaranteed mistranslation in the exact spot where a wrong tap silently
  deletes a job. `Save` → `Save for later` (names the column it lands in).
- **C8 — No ATS/parser vocabulary.** `ATS-safe PDF` → **`PDF that scanners can read`**.
  `What a parser sees` → **`What the company's software reads`**. Ban `ATS`, `parser`, `parse`,
  `ATS-friendly` alongside `JD`.
- **C9 — Delete the first-person carve-out (spec D5).** D4 removes every cue that a character exists;
  D5 then had an unnamed "I" speaking the most-read sentence in the app. Match reasoning speaks about
  the evidence: `They ask for Kubernetes; it is not on your resume.` The coach says
  `This bullet has no number.`, not `I'd add a number here.` **Zero speakers anywhere.**
- **C10 — Contractions are permitted.** Overrides spec D20(b). English without contractions is the
  register of a benefits-denial letter, and this audience is reading rejection-adjacent copy.
  Banned instead: idioms, slang, wordplay, and any emphasis depending on English word order.
  §3.3 rule 6 (no humour on errors, money, or rejection) stands exactly as written.
- **C11 — Never instruct where you can act.** `Apply on company site` moves the card itself (R1).
  Follow-up copy is a fact plus an action: `3 companies haven't replied in 10 days.` — not
  "gone quiet" (idiom, and it anthropomorphises the employer). That row lives on `/applications`,
  with a count badge on the nav item — not on `/jobs`.
- **C12 — CitationGuard speaks in sources, not compliance.** Marker opens
  `From your resume — Experience, line 3`. Group label: `Every number here came from your resume.`
  Blocked export: `One line has a number we couldn't find on your resume. Fix it or remove it before
  you download.` + `Edit line` / `Remove line`. Ban `violation`, `resolve`, `guard`, `traced`,
  `citation` from UI copy.
- **C13 — Provenance must be tappable.** A 1px dotted underline is illegible on the platform the spec
  declares to be the IA. Use a tappable superscript source marker + an inline row, with one plain
  sentence above any cited block: `Tap any marked line to see where it came from.`
- **C14 — Destination #4 is `Interview prep`**, not `Practice` (a bare verb among three nouns reads
  as an instruction on a mobile tab bar). Route stays `/practice`. One action label everywhere:
  `Practice for this job`.
- **C15 — Board views named for what they show:** `By stage` / `By date`. Not `Board` / `History`
  (Trello vocabulary, and not a parallel pair). Ban `board`, `kanban` beside `pipeline`, `funnel`.
- **C16 — Interview scores are questions, not dimensions.** `Did you tell the story in order?` ·
  `Did you give real numbers?` · `Were your answers the right length?` · `Did you sound sure of
  yourself?` · `Did you answer the whole question?` Ban `dimension`; rename the transcript metric so
  it never collides with job fit.
- **C17 — Label the missing-keyword chips.** A bare chip cluster reads as *features*, which is
  exactly inverted. `They ask for these and your resume doesn't mention them:` then the words.
- **C18 — Work authorization.** No badge from absence of data — `No sponsorship stated` is a claim
  about *our data*, and every user reads it as "they don't sponsor". Badges shown **only** to users
  who said they need sponsorship, and only from a real extracted signal. Settings asks a question,
  not a label: `Do you need a company to sponsor a visa?`
- **C19 — Delete the `Hidden from recruiters` setting.** No recruiter-visible profile ships this
  cycle; a setting protecting against an exposure that does not exist is the same species of claim as
  `today.appliedBanner`. Keep `Companies you don't want to see jobs from`.
- **C20 — Version cap is per job and visible** (`2 of 3 versions used`), never per "role family" —
  an invisible taxonomy the user discovers only by hitting it.
- **C21 — Setup has one name in one place:** `Tell us what you're looking for`, in the `/jobs` filter
  bar. Settings links to the same panel with the same words. Delete `Tune my matches` and
  `Redo setup chat`.
- **C22 — Recount the concept budget honestly.** §6.0's "4 concepts" is really 12–15. Target
  **6**, named, and make the count a verification criterion.

### Feasibility (these are build-breakers)

- **C23 — `next/font/local` does not expose a literal family name.** The spec's
  `--font-ui: 'InterVariable', Inter, …` matches nothing; the generated family is a hashed token, so
  the app would silently fall through to system fonts and download 48 KB it never uses — byte-for-byte
  the bug the spec diagnoses elsewhere. Correct form:
  ```css
  --font-ui:      var(--font-inter), -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui,
                  'Hiragino Sans', 'Yu Gothic', 'PingFang SC', 'PingFang TC', 'Microsoft YaHei',
                  'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif;
  --font-display: var(--font-instrument-sans), var(--font-ui);
  ```
  Same for `--resume-serif` / `--resume-sans`: `var(--font-lora)`, `var(--font-source-sans)`.
  Add a CI gate: any quoted family in `styles/*.css` that is not a system stack fails.
- **C24 — Keep the existing 48 KB Google Inter build.** rsms.me's `InterVariable.woff2` is ~340 KB
  (7× the advertised win) and arrives with its own provenance step. Drop the `opsz`/`cv05` sentence —
  optical sizing has no visible effect across an 8-size scale.
- **C25 — `styles/v3-resume.css` is out of scope for the type system.** It is 1,492 lines of *résumé
  document* typography (104 font-sizes, 36 `--mono`, 4 `--serif`). Forcing it onto an 8-token UI scale
  with a 12px floor and no uppercase would reflow every template and delete the conventional
  `EXPERIENCE` headings that the scanner-readable PDF depends on. Instead introduce
  `--resume-sans` / `--resume-serif` / `--resume-mono` and codemod that file onto them. **This also
  fixes a live bug:** `'Newsreader'` (`:861, :867, :908`) is loaded nowhere, so every résumé preview
  and PDF export currently renders in **Times New Roman**, and the literal `'JetBrains Mono'`
  (`:879, :888, :897, :923`) never matches next/font's hashed family, so it falls back to Courier.
  The document users send to employers is typeset in browser defaults.
- **C26 — `AiOrb` is imported by `CoachNudge.tsx:13`** (a KEEP). Replace with `IconSparkle` + the 2px
  indeterminate bar in the same commit, or the build breaks. `grep -rl AiOrb app components` first.
- **C27 — `RAQueueService` is imported by `SeekerAccountDataWipeService`** (GDPR account deletion),
  `v1Bridge.ts`, `raMockCatalog.ts`, `RAIntegrationsService.ts`. Deleting it fails
  `tsc -p server/tsconfig.json` — step 2 of `npm run build` — and if force-patched, silently breaks
  account deletion. Move the RoboApplyRun cleanup into `v1Bridge.ts`, repoint the wipe service, *then*
  delete. Also delete `hooks/useQueue.ts`.
- **C28 — Wave 1 must not touch `/jobs` or `/settings` in `PROTECTED_PREFIXES`.** The spec contradicts
  itself; shipping it as written un-gates the primary destination and breaks the `auth_expired`
  recovery that commit `212a2e6` landed to fix. Wave 1 removes only the four dead prefixes
  (`/mission`, `/apps`, `/search`, `/insights`). The rest moves in Wave 4, with the route moves.
- **C29 — `proxy.ts` holds a second router.** `REDIRECT_TO_HOME_WHEN_AUTHED = new Set(['/mission'])`
  sends authed visitors to `/home`, which Wave 4 deletes. Remove it there. Note the file is
  `next.config.mjs` (not `.js`) and its `redirects()` currently returns `[]` with an explanatory
  comment — append, don't replace.
- **C30 — next-intl does NOT throw on a missing key.** `lib/i18n.ts` deep-merges over English and
  `app/providers.tsx` sets no `onError`, so a deleted key ships to production as the literal string
  `jobs.headline`, in all nine locales, and neither `npm run build` nor `npm test` catches it. The
  spec's stated safety net does not exist. Add `scripts/check-i18n-callsites.mjs` **before** Wave 5
  and set `onError` to throw in development.
- **C31 — There is no CI.** `.github/workflows` is empty. Every enforcement mechanism in the spec is
  currently a sentence. Wave 0 creates the checks. Also: `scripts/check-plans-i18n-parity.mjs`
  hard-fails the moment Wave 5 lands — it asserts `plans`, `nav_v3.plans`, `choosePlan.*` and
  `account.billing.explore.*` exist, all of which are deleted. Rewrite it in the same commit.
- **C32 — Tracker status is a `String`, not a Prisma enum.** No `prisma db push` is required; drop
  that confirmation gate. The real blast radius is four enumeration sites: `RATrackerService.ts:120`
  (`ALL_STATUSES`) and its zeroed counts map at `:133`, `VALID_STATUSES` in `routes/tracker.ts:46`,
  `RATrackerStatus` in `lib/api/v2/types.ts`, plus `components/v3/pipeline/columns.ts` and
  `lib/stub/raV2.stub.ts`.
- **C33 — `JOB_APPLYING_ENABLED` is a server flag, not a client constant** — delivered on `/auth/me`,
  with six live routing consumers. Its death must be explicit and server-side too, and the env var
  removed from Vercel in the same deploy, or the deploy lands with `/jobs` unreachable.
- **C34 — Every wave carries a Tests line.** ~12 test files die: `Dc.test.tsx`,
  `JobApplyingGate.test.tsx`, `Sidebar.test.tsx`, `MobileNav.test.tsx`, `home.test.tsx`,
  `tracker.test.tsx`, `preferences.test.tsx`, `onboarding.test.tsx`, `PlanCatalog.test.tsx`,
  `PreferenceTray.test.tsx`, `proxyPaths.test.ts`. `e2e/verify-accent-picker.py` tests a deleted
  feature; `e2e/v3-uc-dry-run.py` is ~1,600 lines keyed to deleted routes and `data-accent` /
  `data-density`.
- **C35 — `app/(public)/layout.tsx` is the login split-screen**, not a neutral group layout. The
  anonymous preview page must live at `app/preview/[token]/` (root level), or it renders inside a
  400px form column beside a "Welcome back" panel.
- **C36 — The anonymous preview needs a data model, not a file list.** `ingestCandidateResume`
  requires a `userId` (FK, cascade) and `runRound` resolves the variant by `{id, userId}`. There is no
  anonymous identity. Needs an `RAPreviewSession` model and an `owner` discriminator — its own wave.
  Also: the API is a single Vercel function, so a token+poll shape never completes (the instance
  freezes after the response) and the in-memory rate limiter is per-instance by its own admission —
  i.e. an unauthenticated endpoint spending LLM + RapidAPI budget in a loop. Run the work
  inside the POST; persist the limit.
- **C37 — `RAJobListItem` drops `salaryPeriod` and `employmentType`** in the list projection, so the
  card cannot render `/month` vs `/year`. Add to the projection, `lib/api/v2/types.ts`, and
  `lib/stub/raV2.stub.ts` (2,042 lines, typechecked by `next build` — a types change without the stub
  change fails the build).

### Differentiation

- **C38 — Artifact at rest, not silence at rest.** Killing the orb is right; mandating silence is not.
  Three of the four "AI reads as AI" mechanics only exist during a request, so a user opening the app
  on a quiet Tuesday sees a static list and no trace anything was done. Replace with **evidence of
  work completed, never narration of work in progress**: the rail slot holds the real next action
  computed from tracker rows (`2 applications haven't had a reply in 10 days.`), and each job card
  carries one past-tense factual line (`Read the full posting. Compared against your 2019–2026
  experience.`).
- **C39 — Compute one real number rather than deleting them all.** D9's rule is right; blanket
  deletion is the lazy response and leaves `/jobs` opening with a header identical to every job board.
  Instrument, then display: `Read 1,240 new postings since Tuesday. 6 are worth your time.` — a
  `SELECT COUNT`, not a story.
- **C40 — Give the orphaned agents a home.** The spec claims "no AI agent is deleted" and then strips
  `/insights` (sole home of `RACareerInsightAgent`, an already-billed SKU) and never once mentions the
  entire cross-bank stack (`RACrossBankExplorerAgent`, `RACrossBankInsightAgent`,
  `RACrossBankSearchService`, `POST /v2/discover/run`, `hooks/useCrossBankDiscover.ts`).
  Both become **views**, which D2 explicitly permits: cross-bank becomes a `Search everywhere` mode on
  the `/jobs` filter bar; the weekly insight becomes the top card of `/applications?view=date`.
- **C41 — One ownable card signature.** Promote the 4px score meter to a full-bleed strip along the
  top edge of every job card, so the feed has a recognizable silhouette at thumbnail size. Costs
  nothing, teaches nothing.
- **C42 — Give away the moat once; meter the commodity.** Practice is the differentiator (82 KB of
  hand-authored domain playbooks, a five-agent blueprint chain, a live voice worker — nobody in the
  competitive set has any of it) and it is the feature every test persona understood cold. The first
  full practice interview is free after email capture; credits meter volume, not first taste. Surface
  the playbook as a fact, not a picker: `Your interviewer is briefed on medical-device regulatory
  work.` Per-call-expensive matching/tailoring is what gets a schedule, not the fixed-cost asset.
- **C43 — Render the loop between the four destinations.** Four nouns are four filing cabinets, each
  individually a commodity. The uncopyable thing is the loop — this job produced this gap, which
  produced this resume edit, which produced this practice question. Put a four-tick trail on the job
  object itself, in both `/jobs` and `/applications`:
  **`Saved → Resume tailored → Practiced → Applied`.** No new noun, nothing to learn, self-evident in
  every language.
- **C44 — Name the grounding on the follow-up.** One tap to a prefilled `mailto:`, not a clipboard
  round trip, with one line beneath: `Written from the job post and your resume.` The differentiator
  was never the drafting — ChatGPT drafts a follow-up free. It is that the draft knows the posting,
  the resume, and the real applied date.

---

## C. Wave order (amended)

| Wave | Goal | Status |
|---|---|---|
| **0** | Enforcement: CI + type-scale, banned-words, i18n call-site checks | prerequisite for 2 & 5 |
| **1** | Truth + funnel — stop lying, stop sending new users to a sign-in page | ship first |
| **2** | Typography — Inter + Instrument Sans, 8 sizes, 12px floor | |
| **3** | Colour, surface, motion — ink / action / identity split, 2 themes | |
| **4** | Information architecture — 4 destinations, redirects, mobile parity | |
| **5** | Copy + i18n — one noun per object, 9 locales at parity | |
| 6 | Value before account (needs `RAPreviewSession` — see C36) | follow-on |
| 7 | Feed truth (filters actually applied, salary period, work auth) | follow-on |
| 8 | Real interview evaluation (a model that read the transcript) | follow-on |
| 9 | Follow-ups (the automation that replaces auto-apply) | follow-on |

Waves 0–5 are the design overhaul. Waves 6–9 are product capabilities the overhaul unblocks.
