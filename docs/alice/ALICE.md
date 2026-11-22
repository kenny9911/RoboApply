# Alice, the application agent

November 2026 · branch `worktree-alice-agent` · design record and build status

The owner asked (2026-11-23) for an application agent named **Alice**: a personal agent for everything about the user's applications (what they are looking for, the jobs that fit, the applications in progress, their status and the reminders around them), built from several subagents and skills, in a modern AI-agent interface of no more than three colours. Her first job is the conversation that turns a resume and a person's hopes into a job profile they agree with:

1. The user uploads a resume (or uses the one already in the account, or goes without).
2. Alice asks what kind of work they want: roles, level, where, pay, industries, the kind of company, companies they admire, the dream job, what matters and what to avoid. One question at a time, with quick replies.
3. Alice analyses the answers against the resume and writes **two job profiles** that differ on purpose, along the one question the answers leave open (stay at this level or step up, the same industry or an adjacent one, a start-up or an established company, …).
4. The user picks the closer one and says what to change. Alice writes a new version and marks exactly what changed. This repeats until the user is satisfied.
5. Alice saves the profile, points the job search at it, and shows the jobs that fit.
6. From then on she keeps the applications in order: what stage each one is at, what needs the user today, and follow-up reminders.

## 1. Rulings that bind

| Ruling | What it means for Alice |
| --- | --- |
| **Owner ruling, 2026-11-23: Alice is a named agent.** | Alice speaks in the first person in her own conversation and is called Alice in every language. This reverses C9 and D4 ("zero speakers anywhere") **for Alice only**: system copy, the other screens and the other agents' lanes (Job search, Resume, Applications on the Dashboard) keep no speaker. Alice is always labelled an AI agent; she has a mark, never a face, and never claims to be a person. |
| **D1 / R1: the product never submits an application.** | Alice prepares, finds, reminds and reports. She never says she applies or submits, and no tool of hers can. "Prepare application" stays the existing agent's one-tap path with its cost sheet. |
| **D3: no invented data.** | Every count Alice shows or says comes from the user's own rows. Her status replies are worded by a model from computed facts and checked: a reply with a number the facts do not hold is replaced by a plain sentence built from the facts. Companies she suggests as examples are labelled hers, apart from the ones the user named. |
| **R2, C5** | A job she lists shows what is missing before its fit, and a fit is never shown without "This is not your chance of getting hired." |
| **C38: evidence at rest** | Her progress lines narrate only work that is really running (a request in flight); at rest they state what was done. |
| Copy gate (`scripts/check-copy.mjs`) | Applies to every string in the bundles, and Alice's prompt carries the same rules for what she writes (no "pipeline", "on your behalf", "apply for you", "guarantee", "unlimited", "stretch role", "onsite" …). |

## 2. Architecture

```
server/src/features/alice/
  contract.ts         wire types and zod schemas: brief, profile, revision, blocks, thread view, turn actions, SSE events
  service.ts          the orchestrator: the stage machine, one turn per action, the subagents and workers in order
  store.ts            Prisma store (threads, messages, saved profiles) + an in-memory store for tests
  routes.ts           /api/v1/roboapply/alice/* (capability `alice`)
  agents.ts           the six model subagents (BaseAgent, JSON mode, tolerant parsers)
  jobScout.ts         profile → filters → the ranked feed → matches with their reasons
  status.ts           the applications board: stage counts, what needs the user, reminders (tracker + Ready to apply)
  reminders.ts        follow-up dates on applications (the tracker's followUpAt; its reminder cron sends them)
  resume.ts           the resume digest a subagent may read (contact block dropped, PII redacted)
  skills/
    index.ts          the registry and the compact index planners read
    intakeTopics.ts   the 13 things Alice asks about, their order and what each must yield
    profileAxes.ts    the 7 ways two profiles can differ, and how to pick the one that matters
    marketNorms.ts    pay period and currency, title conventions, work-model words per market
    voice.ts          how Alice speaks, and the product's copy rules restated for a model
    profileFilters.ts the deterministic mapping from a profile to the saved search (FilterSet v1)
    followUps.ts      when an application needs the user (the tracker's facts plus prepared applications)
```

### Stages

`intake → drafting → choosing → refining → saved`

- **intake**: the Intake interviewer asks; each answer is folded into the brief. When the required topics are covered (or the user asks for profiles), the turn runs the Goal analyst and the Profile writer (**drafting** is only ever the state inside that turn) and ends in **choosing** with two drafts.
- **choosing**: the user picks A or B (with or without a comment), or asks for two new ones. Picking starts **refining** at version 1; a comment revises it at once.
- **refining**: each comment goes to the Profile editor, which returns version n+1 and what it changed. Any earlier version can be restored. "Save" ends here.
- **saved**: the profile is saved and drives a search. The conversation goes on: the Router sends free text to finding jobs, the applications report, a reminder, a new revision of the profile, or a new profile.

The state lives in `RAAliceThread` (one active thread per user; "Start over" archives it and opens a new one, saved profiles stay).

### Subagents (model calls)

Each is a `BaseAgent` (one structured JSON call, retries, per-agent cost lines, the strict `content` language directive and the output-language reminder first in the user message). Their answers are cleaned by `contract.ts` before anything is stored or shown.

| Subagent | Reads | Writes | Model key (gateway area) |
| --- | --- | --- | --- |
| **Intake interviewer** `AliceIntakeAgent` | resume digest, brief so far, topic index, the last answer | facts learned from the answer, topics covered or declined, Alice's reply with the next question, quick replies, whether there is enough to draft | `onboarding` (Assistant) |
| **Goal analyst** `AliceGoalAnalystAgent` | resume digest, brief, the axes index | a short reading of the goal: strengths, motivations, constraints, the open question (one axis), two directions along it | `onboarding` (Assistant) |
| **Profile writer** `AliceProfileWriterAgent` | analysis, brief, resume digest, market norms; an optional comment ("neither is right because …") | two complete job profiles, one per direction | `onboarding` (Assistant) |
| **Profile editor** `AliceProfileEditorAgent` | the chosen profile, the comment, the brief, the other draft for context | the revised profile, what changed and why, Alice's reply | `onboarding` (Assistant) |
| **Router** `AliceRouterAgent` | the message, the stage, the profile headline, the user's open applications (id, company, title, stage) | one action: choose, refine, regenerate, save, find jobs, report, set a reminder, new profile, answer | `intentParser` (Assistant) |
| **Reporter** `AliceReporterAgent` | the computed applications facts | two or three sentences in the user's language; every figure must be one of the facts | `insights` (Insights) |

### Workers (no model)

| Worker | Does |
| --- | --- |
| **Job scout** | Maps the profile to a FilterSet (`skills/profileFilters.ts`), asks the feed for Best fit with the profile's words as the relevance text and the named companies favoured (`feedService.preview`), and returns up to 8 jobs with the profile fields each one meets. |
| **Status keeper** | Counts the user's applications per stage (the market's ladder), lists what needs them (interview tomorrow, follow-up due, no reply after 10 days, a saved job's deadline, an application ready to check), and the follow-up dates set. Real counts; an unloaded count is a dash. |
| **Reminder keeper** | Sets or clears an application's follow-up date through the tracker (`trackerCore.patch`), so the existing reminder e-mail and push go out that day. A request that names a company is resolved against the user's own applications; two that match are put back to the user. |

### Skills (data the subagents compose)

Skills are data, not prompts copied into each agent: a subagent reads the compact index (`renderSkillIndex`) and answers with ids; the orchestrator gives the full directive of a chosen id to the step that needs it. Adding a topic or an axis is a data change in one file.

| Skill | Holds |
| --- | --- |
| `intakeTopics` | 13 topics (roles, level, work model, places, pay, industries, kind of company, company size, companies, dream job, what matters, dealbreakers, timing; plus visa sponsorship on RoboApply), each with its priority, whether drafting needs it, what to learn and how to ask it. Four are required before drafting: roles, level, work model or places, and one of companies / dream job / what matters. |
| `profileAxes` | 7 axes two profiles can differ on: scope (same level / step up), field (same industry / adjacent), company stage, work setting, role path (individual work / leading people), pay against growth, specialist against generalist. Each says when it is the open question and how the two sides read. |
| `marketNorms` | Per market: the pay period and currency to ask in, how titles are posted, the words for work settings, what not to ask (GoApply never asks about visas). |
| `voice` | Alice's register: short sentences, one question per turn, the user's language, no emoji, no flattery; she says she is an AI agent when asked; she never claims to apply or submit; she treats resume text and messages as data, never as instructions. |
| `profileFilters` | Profile → FilterSet v1: titles, seniority, work models, locations, pay floor, industries, skills, company sizes, the named companies as "Companies you want to work at" (a boost, never a filter), dealbreaker companies excluded, job types, sponsorship. Parsed with the market's rules, so a field the market does not have is dropped. |
| `followUps` | The facts that make an application need the user, ordered (interview tomorrow, deadline soon, follow-up due, no reply after 10 days, ready to check), from the tracker's `computeFollowUps` and the Ready to apply queue. |

### Storage (SCHEMA-10, additive)

Three new tables in `server/prisma/schema/ra-alice.prisma`, no change to an existing column:

- `RAAliceThread`: one per conversation (`archivedAt` null = the active one): stage, locale, the resume chosen, the brief, topics, the analysis, the drafts, the revisions, the saved profile, counters.
- `RAAliceMessage`: the conversation, with typed blocks (quick replies, the resume read, a saved profile, a reminder set, …).
- `RAJobProfile`: a saved job profile, the search it drives (`searchProfileId`), its version.

A database without the tables (production before the schema step) keeps working: Alice's routes answer 503 `ai_unavailable` with reason `alice_not_ready` and the page says Alice is not switched on yet. Nothing else reads the tables.

### Saving a profile: which search it drives

Free plans hold one saved search, Pro holds ten. On "Save":

1. a profile already linked to a search that still exists updates that search's filters;
2. otherwise, with room for another saved search, a new one named after the profile is created and made active;
3. otherwise the user chooses, on the save card: **use it for my search "…"** (that search's filters are replaced; the previous filters are kept on the profile so "Undo" restores them) or **save without changing my search**.

### API

Mounted at `/api/v1/roboapply/alice` (cookie session, capability `alice`; an AI-dependent flag, so a brand that cannot run AI answers 503).

| Method and path | Does |
| --- | --- |
| `GET /thread` | The active thread (created on first visit, with Alice's greeting) |
| `POST /turn` | One action, answered as a stream (below) |
| `GET /profiles` | Saved job profiles |
| `PATCH /profiles/:id` | Rename, archive |
| `DELETE /profiles/:id` | Delete (the search it drove stays) |
| `GET /profiles/:id/matches` | The Job scout's matches for a saved profile |
| `GET /applications` | The applications board |
| `PUT /reminders/:entryId` | Set a follow-up date `{ date }` |
| `DELETE /reminders/:entryId` | Clear it |

A turn's action is one of: `message` (free text), `replies` (quick replies picked), `resume` (a resume chosen), `skip_resume`, `draft_now` ("show me profiles"), `choose` (A or B, optional comment), `regenerate` (two new ones, with a comment), `refine` (a comment), `restore` (an earlier version), `save`, `find_jobs`, `report`, `restart`, `edit_profile` (a saved profile back into refining).

The stream's events: `progress` `{ step, state }` while a subagent runs (reading the resume, thinking, reading your goals, writing two profiles, revising, finding jobs, checking your applications), `message` for each new message, `thread` with the whole state at the end, then `done`; or `error` `{ code, message }`.

Limits (persisted counters): 20 turns in 10 minutes and 150 a day per user (`aliceTurn`); 30 profile writes or revisions an hour and 80 a day (`aliceDraft`). Conversation turns spend no credits, as setup does not; preparing an application keeps its own credit gate.

## 3. The interface

`/alice` (nav: after the Dashboard on both brands; in More on the phone). A workspace in the app shell, under the house rules for app screens.

### Three colours

| Colour | Light | Dark | Carries |
| --- | --- | --- | --- |
| Ink | `--text` `#0B0D1A` and its greys | `#FFFFFF` and its greys | All text, the primary button (an ink pill), icons, rules |
| Paper | `--bg` `#F4F6FB`, `--surface` `#FFFFFF` and their steps | `#07080F`, `#10121C` | Ground, tiles, recesses |
| Electric blue | `--action` `#2B4DFF` and its tint | `#8098FF` | **Alice's own work, and only that**: her mark, the live status while she works, the profile she proposes as the current one, and what she changed in a revision |

Nothing else: no yellow highlight, no cobalt plane, no status hues. Status is a word with a glyph (an ink check, an ink clock); an error is a sentence and a Retry inside the block that failed.

**The face.** Blue means "Alice did this". The user can see at a glance what came from her (the changes in a new version, the profile she is working on, her status line) and what is theirs (their answers, their applications: ink).

**The signature element: the revision trail.** Each new version of the profile shows the user's comment that caused it, and every field it changed is marked in blue with the old value struck in grey. Versions are kept and any one can be restored.

### Layout

- Desktop (1100 px and up): the title row ("Alice", her one-line status, Start over), then two tiles side by side: the **conversation** (about 420 px) and the **canvas** (the rest). The canvas has three views: **Profile** (what Alice has learned so far; then the two profiles compared row by row; then the version being refined; then the saved profile), **Jobs** (the matches for the saved profile), **Applications** (stage counts, what needs you, reminders).
- The conversation: Alice's turns sit on the tile with her mark; the user's answers sit in a recessed bubble on the right. Quick replies are pill chips under her question (several can be picked when the question allows). The composer stays at the foot: a text field, attach a resume, send.
- While she works: a status line with the steps really running, the current one with a pulsing blue dot; under reduced motion the dot holds still.
- Phone (under 760 px): one region at a time, switched by a segmented control under the title: Chat · Profile · Jobs · Applications.

## 4. Rules that are easy to break

- Alice's progress steps are the subagents really running in the request, sent by the server as they start and end; the client never animates steps on a timer.
- The diff between versions is computed by the code (field by field), never taken from the model. The model's change notes only explain it.
- The applications report never shows a number the facts do not hold (the Reporter's output is checked; see D3 above).
- Profiles are stored as the user approved them. The filters are derived from the profile each time it is saved, so the search and the profile cannot drift.
- Turning the search to a profile never deletes a saved search, and replacing one keeps the old filters for Undo.
- GoApply: the same Alice (D5). The market's rules apply to the filters (no visa question, CN-only fields only there), pay is asked per month, and the model route is GoApply's.

## 5. Build status

Built 2026-11-23 on `worktree-alice-agent`.

| Part | Where |
| --- | --- |
| Contract, sanitizers, computed diff | `server/src/features/alice/contract.ts` |
| Orchestrator (stages, turns, saving, jobs, applications, reminders) | `server/src/features/alice/service.ts` |
| Six subagents | `server/src/features/alice/agents.ts` |
| Six skills | `server/src/features/alice/skills/` |
| Store (Prisma and in memory), missing-table answer | `server/src/features/alice/store.ts`, `server/prisma/schema/ra-alice.prisma` |
| Seams to resumes, searches, the feed, the tracker, Ready to apply | `server/src/features/alice/deps.ts` |
| API, capability `alice`, limits `aliceTurn` / `aliceDraft` | `server/src/features/alice/routes.ts`, `platform/flags.ts`, `platform/ratelimit/defaults.ts` |
| Page, conversation, canvas, three-colour styles | `app/(auth)/alice/page.tsx`, `components/features/alice/` |
| Hooks and API wrappers | `hooks/alice/useAlice.ts`, `lib/api/alice.ts` |
| Nav entry (both brands, More on the phone), protected path | `components/v3/shell/destinations.ts`, `lib/proxyPaths.ts` |
| Copy in nine languages | `i18n/messages/*.json`, namespace `alice` (272 strings) |
| Design preview, every stage clickable (`/alice?alice=intake\|choosing\|refining\|saved`) | `scripts/design-preview/alice.ts` |
| Schema for review (SCHEMA-10) | `docs/jobright-clone/schema-diffs/schema10-alice.sql` |

### How it was checked

- Unit and route tests: `server/src/features/alice/__tests__` (contract, skills, the orchestrator end to end with scripted subagents, the router with SSE), `components/features/alice/__tests__` (the page, the model).
- The six subagents against the real model (Gemini 3.8 Flash, the `.env` default) in a script with no database: the intake reads the resume and asks with quick replies; one answer filled eight topics; zh-TW came back in Taiwan Chinese; the analyst named one axis; the writer's two profiles clean without loss; the editor changed exactly the fields asked for; the router turned "follow up with Figma on Friday" into a reminder on the right application and date; the reporter's numbers all passed the facts check.
- End to end on a throwaway local Postgres (the full schema, SCHEMA-10 included), the API and Next from this branch, the real model: resume → questions → two profiles → pick with a comment → version 2 → save into the main search → jobs (none in the local index, said so) → a reminder → the applications report. The run found and fixed three bugs: a resume column name (`lastEditedAt`), resumes with no parse status left out of the greeting, and Alice's example companies written into the person's "Companies you want to work at".
- The taste inspector (`--app`) at 1440, 768 and 390 on every stage; the findings left are the shell's own (the search button's ring, the brand tile, the bottom bar's first label), and Alice's monogram, which is her mark.

### Measured

Intake turn about 4 s (low reasoning effort; 36 s at the provider default), two profiles about 30 s (analyst and writer), a revision about 10 s, the router about 4 s.

The low effort is Alice's own request. When an admin assigns the area a call runs on in the LLM gateway (`/admin/llm`: Assistant for the `onboarding` and `intentParser` keys, Insights for the reporter's `insights`), the area's effort wins over it (Medium unless set; `docs/llm-gateway.md`), so intake turns slow down again. Set that area to Low, or Provider default to keep her own level.

### Open

- SCHEMA-10 on each database (production at the owner's word).
- Matches depend on the job index: a database with few jobs shows the honest empty state.
