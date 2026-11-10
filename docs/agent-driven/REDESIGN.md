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

Then the matching runs on the same screen (the real phases of `POST /onboarding/match`), and the user lands on Today with the first picks.

The server stage machine is unchanged and stays the authority. `POST /onboarding/resume` is accepted before any step and returns suggested titles, levels and skills. On "Find my jobs" the web saves the steps in the server's order: `situation` → `basics` → `resume` → `match` → `confirm` → `complete`. Questions that only the long flow asked (career goal, industries, company size, pay floor, LinkedIn URL, how they heard of us) are no longer asked up front; each has a home later (the search panel, Profile, Settings).

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
| Navigation: Today first and home, Ready folded into Applications, Profile in the lower group | built | `components/v3/shell/destinations.ts`, `lib/proxyPaths.ts`, `lib/auth/signInRoute.ts`, `next.config.mjs` (`/home` → `/today`), server `homeRoute()` |
| `/today` | built | `app/(auth)/today`, `components/features/today`, `hooks/today` |
| `/onboarding/start` (resume first, two screens) | built, RoboApply | `components/features/onboarding/express`, `hooks/onboarding/useExpressOnboarding.ts` |
| Jobs: search collapsed to one line, card and job page lead with `Prepare application` | built | `components/features/filters/SearchSummary.tsx`, `components/features/feed`, `components/features/job/JobDetailPanel.tsx` |
| Applications: Getting ready · Sent switch | built | `components/features/tracker/ApplicationsSwitch.tsx` |
| Translations | all nine locales | `i18n/messages/*.json` (129 strings) |
| Assistant tools that add to the list and prepare | not built | needs new copilot tools on the server |
| Preparing the weekly list with no tap | not built | spends credits without a confirmation: an owner decision |
| A first-class "target company" | not built | companies stay a list inside the saved search |

### What the build turned up

- **The first result still takes the length of the search.** The server refuses the last onboarding step until matching has finished, so the wait (server target 45 s, cap 2 min) cannot be moved behind Today from the web. If the search stream fails, the same rule means setup cannot be finished: the user lands on Today with setup paused and a "Finish setting up" card. Accepting `confirm` while the stage is `matching` would fix both.
- **A user who says "in the next few months"** is on the server's longer branch. The web saves its two extra steps (`goal`, `preferences`) as skipped, in order, so the two screens hold for every answer.
- **Today without Ready to apply reads the top of the feed**, and that read counts as a visit to Jobs (it clears the Jobs badge). A read that does not stamp the visit needs a small server endpoint.
- **Picks on Today can be up to five minutes behind a search change made on Jobs** (the suggestions cache is not cleared by that change; a change made from Today clears it).
- **A job already on the list shows `Prepare application` until tapped**: the feed item does not carry the list state. The tap is safe (the server returns the existing application and the button becomes a link); showing the right label up front needs one more field on the feed item.
- **"Today" was a deleted destination.** The July 2026 overhaul removed the old home and two tests asserted it never returns. This redesign brings a home back on purpose, as the place where the agents report; those tests now say so.
- **Words drift between new and old screens**: Today says "application"; the cost sheet and the Getting ready pages still say "kit" (350 translated strings). One copy pass should rename them in all nine languages.
- **An unrelated test fails on `main` since 1 November 2026**: `server/src/roboapply/v2/lib/raFantasticJobs.test.ts` hard-codes a billing date that is now in the past. Not touched here.

## 10. Open decision for the owner

"Apply jobs for the user" was built inside D1: the agents prepare and fill, the user submits. Submitting for the user would reverse a ruling confirmed in July and October 2026, needs server-side submission that does not exist, and changes the copy gate and the extension gate. It is a product and legal decision, not a design detail.
