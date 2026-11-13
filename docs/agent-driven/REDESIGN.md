# Agent-driven redesign

November 2026 · branch `feat/agent-driven` · status: in progress (section 9 says what is built)

The owner asked for the product to be redesigned around agents: faster onboarding, the resume refined for the jobs and companies the user wants, jobs searched and matched for the user, and applications prepared for the user. This file is the design record. The drawn flows are in [`flows.html`](flows.html).

Visual authority stays [Paper](../design-system.md). This redesign changes the information architecture and the flows, not the palette, the type or the tokens.

## 1. What was wrong (measured in the code on `main`, b89d5256)

| Finding | Evidence |
|---|---|
| No home. The signed-in landing is the job feed. | `/home` redirects to `/jobs` (`next.config.mjs`); `homeHref()` returns the first nav entry |
| 8 to 11 rail destinations, plus Ask, Inbox and the avatar menu | `components/v3/shell/destinations.ts` |
| 6 to 8 onboarding screens before the first job card, then a 4-card tour | `components/features/onboarding/flow.ts` |
| The feed opens with 3 tabs, a search box, saved searches, 7 filter buttons, the active chips, a tier switch and a sort menu above the first job | `components/features/feed/JobsWorkspace.tsx` |
| Two apply paths with different "applied" logic | card `Apply on company site` (`/jobs/:id/apply-click`) and `/ready` kits (`/agent/queue/:id/open`) |
| The same "get ready for this job" list in three places | `GetReadyChecklist`, `KitReview`, the tracker drawer's next steps |
| Search criteria editable in four places | onboarding, `/jobs` filters, Settings, Ready overrides |
| The first tailored resume takes 6 to 8 clicks after landing | Tailor → base → sections → instruction → skills → generate → verify → use |
| The Assistant cannot run the loop | no copilot tool saves a job, adds to the list or prepares a kit |

The user is the integrator: they carry a job from Jobs to Resume to Ready to Applications by hand. The agents exist on the server (search planner, fit scorer, tailor, cover letter, kit preparation, answer drafting), but the screens present them as separate tools.

## 2. The model

**Say what you want once. Three agents do the work. You decide and you submit.**

| Agent (a function, not a character) | Does, without being asked | Stops and waits for the user when |
|---|---|---|
| **Job search** | Reads new postings for the goal, scores them against the resume, ranks them, names the gap | The search returns too little, or the user rates the picks down |
| **Resume** | Checks the main resume, finds what the wanted jobs ask for that it does not mention, tailors a version per job | A tailored version adds a keyword, number or claim the base resume does not show ("Verify details") |
| **Applications** | For a job the user picked: tailors the resume, writes the letter when the post asks for one, collects the answers and files | The application is ready to check; the user opens it and submits it |

One object moves through one line, and every screen shows the same line:

`Found → Picked → Being prepared → Waiting for your OK → Ready to open → Opened → Applied → Reply`

The server already has this as the queue states (`picked → preparing → ready_for_review → approved → opened → applied`) followed by the tracker stages.

### Rulings that still bind

- **D1 / R1: the product never submits an application.** "Applications for the user" means prepared, filled by the extension, and submitted by the user. Nothing in this redesign adds a submit. Copy never says the product applies. The copy gate (`scripts/check-copy.mjs`) and the extension gate stay as they are.
- **D3: no invented data.** Every count on Today is a real count; a count that is not loaded renders `—`, never `0`.
- **C9 / naming: no persona.** Agents are named by their job (Job search, Resume, Applications). No first person, no face, no name. System copy has no speaker.
- **C38: evidence at rest.** A lane states work that was done, in the past tense, from real numbers. It narrates progress only while a request is really running.
- **R2: the gap leads.** A pick shows what is missing before its score.
- **C5:** a fit score is never shown without "This is not your chance of getting hired."

## 3. Information architecture

Before (RoboApply): Jobs · Ready to apply · Applications · Resume · Interview prep · Profile, then Coaching · Invite friends · Extension · Settings · Admin.

After:

| # | Destination | Route | What it is now |
|---|---|---|---|
| 1 | **Today** | `/today` | New. The desk: what waits for the user, what each agent did, the next best jobs. The signed-in home. |
| 2 | **Jobs** | `/jobs` | The full list. The search is one summary line until the user opens it. |
| 3 | **Applications** | `/applications`, `/ready` | One destination with two views: Getting ready (the former Ready to apply) and Sent (the tracker). |
| 4 | **Resume** | `/resume` | Unchanged hub. |
| 5 | **Interview prep** | `/practice` | Unchanged. |

Lower group: Profile · Settings, then Coaching · Invite friends · Extension · Admin under their existing gates. Mobile bottom bar: Today · Jobs · Applications · Resume · More.

GoApply gets the same change (D5): 今天 first, 待投递 folded into 投递记录; its campus calendar and referral entries stay.

No route is removed. `/ready` and everything under it keep working (e-mails and reminders link there); it is no longer a rail entry, and the Applications entry is current on it.

## 4. Onboarding: resume first, two screens

Before: situation → basics → (goal → preferences) → resume → matching → confirm → tour.

After, for RoboApply (`/onboarding/start`):

1. **Start with your resume.** Upload, paste, or a LinkedIn PDF; or "I don't have one yet".
2. **Is this what you're looking for?** One screen, filled in from the resume: job titles, level, where, kind of work, how soon. Every value is a chip the user can change. One button: "Find my jobs".

Then the search starts (`POST /onboarding/match`); the screen waits only for its first two real phases (the resume read, the search saved), setup is finished, and the user lands on the Dashboard while the search runs on. Its Job search lane shows the search until the first picks arrive.

The server stage machine stays the authority, with one exception added for this flow: RoboApply takes `confirm` while the stage is still `matching` (`CONFIRM_WHILE_MATCHING`; GoApply keeps the strict order). `POST /onboarding/resume` is accepted before any step and returns suggested titles, levels and skills. On "Find my jobs" the web saves the steps in the server's order: `situation` → `basics` → `resume` → `match` (started, not awaited) → `confirm` → `complete`. Questions that only the long flow asked (career goal, industries, company size, pay floor, LinkedIn URL, how they heard of us) are no longer asked up front; each has a home later (the search panel, Profile, Settings).

The classic screens stay for a user who left early and resumes mid-way, and for GoApply, whose consent and identity steps are legal requirements.

## 5. Today

Order on a phone; on desktop the first two share the main column and the rest sit beside them.

1. **Header.** The date, a title that states the count ("3 things are waiting for you" / "Nothing is waiting for you"), and the goal line ("Looking for Product designer · Senior · Remote or London") with `Change`.
2. **Waiting for you.** At most four cards, most urgent first, each one fact plus one action:
   - an application ready to check → `Check and open`
   - an approved application not opened → `Open application`
   - new details to verify in a tailored resume → `Verify details`
   - applications with no reply after 10 days → `See them`
   - profile details that forms need → `Add details`
   - no resume → `Add a resume`
   - setup left early → `Finish setting up`
   The first card carries the screen's one primary button.
3. **Job search.** One past-tense line with real counts, then the three best picks: gap line, overlap line, tier, and one action, `Prepare application`. `See all jobs` below.
4. **Applications.** Real counts: being prepared · waiting for you · sent this week, the kit allowance, "You submit each application yourself." and `Open applications`.
5. **Resume.** The main resume and its last check, what the picks ask for that the resume does not mention, `Improve my resume`.
6. **Ask.** One input that opens the Assistant with the question (flag `copilot`).

`Prepare application` (shared component `PrepareApplicationButton`) does in one tap what took a trip through three pages: it puts the job on the list (`POST /agent/queue`), shows the cost before anything is spent (the existing `PrepareSheet`), then starts the preparation. The result arrives under "Waiting for you".

## 6. Jobs

- The search collapses to one line: "Product designer · Remote · Senior · Past month" with `Change search`. The filter bar opens on demand and stays open while filters are being edited.
- The card's primary action becomes `Prepare application` when the `agent` flag is on. `Apply on company site` stays as the second action for a user who wants to go now. `Tailor resume` and `Ask about this job` move into the card's menu.

## 7. Applications

`/applications` and `/ready` share one switch at the top: **Getting ready** (with the count waiting for the user) and **Sent**. Each page keeps its own content and tests.

## 8. Use cases walked end to end

See `flows.html` for the drawings. The scenarios:

1. New user with a resume who needs a job now: sign up → resume → confirm goal → Today → Prepare application → Verify details → Open application → extension fills → user submits.
2. New user with no resume: answers only → Today shows jobs without fit scores → "Add a resume" waits.
3. Daily return: Today → 2 cards waiting → check, open, follow up → done in one screen.
4. Target companies: `Change` on the goal line → companies in the search → picks favour them.
5. "Why no interviews?": Resume lane → what postings ask for → tailor → verify.
6. Out of credits, AI unavailable, nothing fits, job closed: each state says what happened and offers the next step.
7. Phone: the same order in one column, five-slot bottom bar.

## 9. Build status

Built on `feat/agent-driven`, checked in the fixture preview (`node scripts/design-preview.mjs`: `/today`, `/jobs?agent=on`, `/applications?agent=on`, `/onboarding/start`) on desktop, at 375 px and in dark.

| Part | State | Where |
|---|---|---|
| Shared `PrepareApplicationButton` | built | `components/features/agent/PrepareApplicationButton.tsx` |
| Navigation: the home first (Today, then the Dashboard after §11), Ready folded into Applications, Profile in the lower group | built | `components/v3/shell/destinations.ts`, `lib/proxyPaths.ts`, `lib/auth/signInRoute.ts`, `next.config.mjs` (`/home` and `/today` → `/dashboard`), server `homeRoute()` |
| The desk (first `/today`, now drawn inside `/dashboard`, §11) | built | `components/features/today` (`TodayDesk variant="dashboard"`), `components/features/dashboard`, `hooks/today` |
| `/onboarding/start` (resume first, two screens) | built, RoboApply | `components/features/onboarding/express`, `hooks/onboarding/useExpressOnboarding.ts` |
| Jobs: search collapsed to one line, card and job page lead with `Prepare application` | built | `components/features/filters/SearchSummary.tsx`, `components/features/feed`, `components/features/job/JobDetailPanel.tsx` |
| Applications: Getting ready · Sent switch | built | `components/features/tracker/ApplicationsSwitch.tsx` |
| Translations | all nine locales | `i18n/messages/*.json` (129 strings) |
| Assistant tools that add to the list and prepare | built (capability `agent`) | `application_status`, `add_to_list`, `prepare_application` in `server/src/features/copilot/tools/applications.ts`, applied in `proposals.ts` through the agent's `addToQueue` / `prepare` (kit reservation keyed `copilot:<proposalId>`); the cost on the card is the agent's `quoteJob`, the cost sheet's own lines; cards `ListAddCard`, `PrepareApplicationCard`, `ApplicationStatusCard` in `components/features/copilot/cards` |
| Preparing the weekly list with no tap ("Prepare my weekly list automatically") | built as an opt-in, off by default (the owner asked for it, November 2026): the user's own switch is the confirmation, given after the cost is stated | server `autoPrepare.ts` (the plan; the switch and the last run kept in `RAUserUiState.state.values`, keys `agent.autoPrepare*`, no schema change) and `service.ts` (`autoPrepareNew` inside `generateList`: the jobs a build newly picked, in pick order, through `prepare` with keys `autoprep:<itemId>:<attempt>`), `GET`/`PUT /agent/auto-prepare`; web `AutoPrepareSetting` (weekly settings) and `AutoPrepareState` (Getting ready, the Dashboard's Applications lane) |
| A first-class "target company" | not built | companies stay a list inside the saved search |

### What the build turned up

- **Setup no longer waits for the search (fixed).** RoboApply's `confirm` is accepted while the stage is `matching`, so the two-screen start finishes setup once the search has saved what it looks for, and the user lands on the Dashboard while it runs on. The search records its run (`answers.matchRun`); `GET /onboarding/state` says `searchRunning` within bounded windows (3 min live, 8 min queued), and the Job search lane waits for it. A search that failed or never started no longer leaves setup paused: confirm is taken anyway and queues one; a live run that fails after setup, or whose client left, hands its rest to the queue, which is kicked at once.
- **A user who says "in the next few months"** is on the server's longer branch. The web saves its two extra steps (`goal`, `preferences`) as skipped, in order, so the two screens hold for every answer.
- **Today without Ready to apply read the top of the feed, and that read counted as a visit to Jobs** (it cleared the Jobs badge). Fixed on `feat/resumeio-clone`: `POST /feed/query` takes `visit: false`, which leaves `lastFeedVisitAt` as it is, and the Dashboard's picks read with it under their own cache key, so the list's own read on /jobs stamps the visit.
- **Picks on Today could be up to five minutes behind a search change made on Jobs** (the suggestions cache was not cleared by that change). Fixed on `feat/resumeio-clone`: every saved-search write resets the suggestions (`hooks/search/useSearchProfiles.ts`, `afterWrite`), whichever page made it.
- **A job already on the list showed `Prepare application` until tapped**: the feed item did not carry the list state. Fixed on `feat/resumeio-clone`: with the `agent` capability on, each card of `POST /feed/query` carries `application` (`{ state, trackerEntryId }`, null when the job is not on the list), read in one statement per page; the agent suggestions carry null. The card, the split pane and the Dashboard picks show "Being prepared" or "Check and open" up front; a job that can still be prepared keeps the tap.
- **"Today" was a deleted destination.** The July 2026 overhaul removed the old home and two tests asserted it never returns. This redesign brings a home back on purpose, as the place where the agents report; those tests now say so.
- **One word for what the Applications agent prepares (fixed)**: "kit" is now "application" in all nine languages (de Bewerbung, es/pt candidatura, fr candidature, ja 応募, ko 지원서, zh 申请材料, zh-TW 應徵資料), in the web bundles, the reminder e-mail and the API messages; the feminine noun carries its agreement into the Getting ready tabs and states. Keys and identifiers keep `kit`.
- **Preparing with no tap, and the rules it keeps.** With "Prepare my weekly list automatically" on, each list build (the Monday cron, one built on demand, setup's first list) prepares the jobs it newly picked, in pick order, while every credit they need fits what is left: one application each from the weekly allowance, and tailoring and cover letters exactly as a tapped Prepare uses them (AI availability, "Tailor my resume for each job", the letter setting). The first job that does not fit stops the run (it never skips ahead to a cheaper one); the rest stay in To prepare. It never touches a job past To prepare, never runs without the `agent` capability, never submits (D1), and is recorded (date, applications started, jobs left and why) for Getting ready and the Dashboard. Turning it off stops later runs and undoes nothing.
- **The credit gate pays from bonus credits when the week's allowance is full**, so "never beyond the weekly allowance" needed one more rule: an automatic run reserves with `useGrants: false` (`CreditService.reserve`, default unchanged), and its plan counts the window's own remaining. A tapped Prepare may still use bonus applications.
- **The generic `PATCH /ui-state` refuses `agent.autoPrepare*`** (`SERVER_OWNED_VALUE_PREFIXES`), so the option is switched on only where its cost is stated.
- **An unrelated test has failed on `main` since 1 November 2026**: `server/src/roboapply/v2/lib/raFantasticJobs.test.ts` hard-coded a billing date that is now in the past, while the client reads the real clock. Fixed on this branch (the date is now set from the clock), because it turns the pull request's CI red.

## 10. Open decision for the owner

"Apply jobs for the user" was built inside D1: the agents prepare and fill, the user submits. Submitting for the user would reverse a ruling confirmed in July and October 2026, needs server-side submission that does not exist, and changes the copy gate and the extension gate. It is a product and legal decision, not a design detail.

## 11. In the resume.io layout (branch `feat/resumeio-clone`)

In November 2026 this redesign was merged into the resume.io clone (`docs/resume-io/TEARDOWN.md` on the teardown branch; the Desk design system in `docs/design-system.md`). Both branches had added a signed-in home, so they now share one:

- **The home is the Dashboard (`/dashboard`)**, first in the rail on both brands. `/today` and `/home` redirect to it, the server's `homeRoute()` and the two-screen setup land there, and the ready-not-opened count sits on its nav entry.
- **The desk is drawn inside the Dashboard** (`TodayDesk` with `variant="dashboard"`): the greeting with the count of what waits and the goal line, Waiting for you, then resume.io's "What do you want to move forward today?" goal tabs with the Progress and hero cards, then the Job search picks (each with Prepare application) as cards, then the Applications and Resume lanes side by side, and a floating ask bar instead of the Ask box.
- **One primary button still holds**: the first waiting card's; when nothing waits, the hero card's call to action (no pick takes it on the Dashboard).
- The resume.io job-match grid was replaced by the agent's picks, so the home shows one list of jobs, with the gap first (R2) and the honesty line (C5).
