# Interview prep agents and skills

Status: built on `feat/practice-prep` (2026-10-12). Owner request: practice for the
real job (searched in the candidate's market and language), requirements and
strategy written per job, interviewers and focuses generated per job instead of
fixed lists, more industries with free entry, a target company whose interview
style is researched, reusable agents and skills, and 15/20/30-minute practices
with 20 as the default.

## What the candidate sees

1. **Which job.** They type the job in their own words ("AI FDE", "前端工程师",
   "資料科學家"). The search reads it the way employers post it and lists the
   roles that match and real openings in their job market. With nothing typed
   they can browse 27 industries (ordered per market) or type their own. They can
   also paste a post, or come from a job (`/practice?job=`).
2. **Target company (optional).** Filled from a chosen posting, or typed.
3. **The plan**, written for that job: the interviewers a real loop for it would
   include (recruiter, hiring manager, senior peer, a customer stand-in …), the
   angles it is tested on, the company's interview style, and a strategy. The
   recommended interviewer and focus are preselected; every chip can be changed.
4. **The prep brief** (coaching before the interview): what the job tests, how the
   company interviews (with its sources, or an honest "no reliable public
   description — usual practice for companies like it"), how this practice will
   run (stage minutes for the chosen length), and what to prepare (aimed at the
   gaps between the resume and the must-haves).
5. **Start.** The session keeps the plan; the questions, the live interviewer, the
   written fallback, the live coach and the report all follow it.

## Architecture

```
server/src/interview-engine/
  skills/            the directive modules agents compose (no company is named here)
    index.ts         registry: compact index for planners, directives per stage, persona mapping
    patterns.ts      23 interview-loop patterns (values loop, bar raiser, project deep dive,
                     customer role-play, decomposition, case + PEI, group discussion, HR final …)
    markets.ts       12 market norms (US, UK/IE/AU/NZ, DACH, French-, Spanish-speaking,
                     Brazil/Portugal, mainland China, Taiwan, Japan, Korea, India, SG/HK/SEA)
  catalog/           the existing skills: archetypes (HOW), formats (STRUCTURE), domains (SUBSTANCE)
  prep/
    contract.ts      types, request schemas, sanitizers, StoredPrep, 15/20/30 snapping
    agents.ts        RoleResolverAgent · IndustryRolesAgent · CompanyStyleAgent · InterviewPlannerAgent
    jobFinder.ts     query → taxonomy + resolver → our index (the market's country) → job boards only
                     when the index has <6 postings located in the market → open career sites
                     when still <4 → ranked by title, company, locality, freshness
    companyStyle.ts  3 public searches → CompanyStyleAgent (must cite) → cached style
    industries.ts    27 industries, labels in 9 locales, per-market order
    industryRoles.ts an industry (listed or typed) → roles, cached
    planner.ts       target → post/research + company style + domain + resume → plan (catalog fallback)
    marketContext.ts which market: the job's country, then the candidate's search/profile, language, brand
    webSearch.ts     Tavily for postings and research; IMPORT_FETCH_DENYLIST hosts excluded
    promptContext.ts StoredPrep → blueprint / voice / evaluation directives
    routes.ts        GET /industries · POST /roles · POST /search · POST /plan
    cache.ts         TTL + LRU, shared computations
```

Mounted at `/api/v1/interview-engine/v1/practice/prep/*` (cookie session only, the
brand's AI gate, per-user rate limits in `RARateCounter`).

### Agents

| Agent | In | Out | Model | Cache |
|---|---|---|---|---|
| RoleResolverAgent | typed text, company, industry, market | canonical titles (UI language + English), market-language queries | `intentParser` / `fast` | 24 h per text+market+locale |
| IndustryRolesAgent | industry (listed or typed), market | 12 roles with a context line | `intentParser` / `fast` | 30 days |
| CompanyStyleAgent | company, role, numbered search results, pattern index | summary, stages, published values, what they look for, themes, tips, patterns, cited sources, basis | blueprint model | 7 days per brand+company+field+locale |
| InterviewPlannerAgent | job (post or evidence), company style, domain lens, market norms, resume summary, skill index | requirements, 3–4 interviewers, 4–6 focuses, recommendation, strategy, prep tips | blueprint model | per target in the browser (30 min) |

Every agent is a `BaseAgent` (JSON mode, content-language directive, retries,
per-agent cost lines) with a tolerant parser; the orchestrators clean every value
through `contract.ts` (ids checked against the skill registry, lengths capped,
keys made unique, the recommendation made valid).

### Skills

Five kinds, one registry (`skills/index.ts`):

| Kind | Carries | Source |
|---|---|---|
| archetype | how an interviewer probes | `catalog/interviewArchetypes.ts` (7) |
| format | the structure of one interview | `catalog/interviewFormats.ts` (28 + GoApply's AI-interview format) |
| domain | the substance of a field | `catalog/domainExperts.ts` (18) |
| pattern | a recurring shape of real loops | `skills/patterns.ts` (23) |
| market | how interviews run in a market | `skills/markets.ts` (12) |

Planners read the compact index (`renderSkillIndex`: ids + one line each) and answer
with ids; the stages that run the interview receive the full directives of the
chosen ids. Each skill has three directives: `blueprintDirective` (question design),
`voiceDirective` (the live interviewer), `evaluationLens` (grading). Adding a skill
is a data change in one of those files.

A company's style is never hard-coded: it is researched per company and expressed
as patterns plus the specifics found (its stage names, its published values).

### Storage (no schema change)

- `InterviewSession.blueprint.prep` — the `StoredPrep` (requirements, company style,
  the chosen interviewer and focus, strategy, market), written at create and kept by
  prepare. The row keeps a catalog persona id (`baseId`: same archetype, voice and
  difficulty) and a format id, so every older reader keeps working.
- `RAMockSession.blueprint.prep` — the same for the written practice (also when a
  live practice switches to writing: `fromSessionId`).
- Session DTOs add `interviewer {name,title}`, `focusLabel`, `company`, `jobId`.

### Durations and credits

First-party practices run 15, 20 or 30 minutes (a longer request from an older link
snaps to the nearest); 20 is the default (one credit at the standard 20-minute rate).
GoApply's AI-interview format runs 20 or 30 (`CN_FORMAT_DEFAULT_MINUTES` is 20 on
both sides). External API sessions keep 5–120. A planned GoApply practice runs the
AI-interview format only when the plan chose it.

## Rules the layer keeps

- **No fabrication (D3).** "From public sources" only with sources to show; the
  company agent must cite the results it used, and an uncited answer becomes the
  usual practice for companies like it, labelled as such, with no stages or values.
  Questions are never presented as a company's real questions.
- **No impersonation.** Interviewer names are invented and culturally plausible for
  the market; titles describe a seat in the loop. The brief says the interviewers are
  simulated.
- **No scraping.** Postings come from our index, the licensed job boards and open
  career sites; IMPORT_FETCH_DENYLIST hosts (LinkedIn, Indeed, Glassdoor, BOSS直聘,
  104 …) are excluded from the search request and dropped from the answer.
- **The job boards are metered.** JSearch and Active Jobs DB share the brand's daily
  job-search budget with the job search itself, so the practice search asks them only
  when our index has fewer than six postings located in the candidate's market (remote
  roles "open anywhere" pass the market filter but do not count).
- **The market is the job's.** A posting's country decides the interview norms (a
  Tokyo job is a Japanese interview whatever the interface language); without one, the
  candidate's active search, their profile country, the interface language and the
  brand decide, in that order.
- **No personal data in searches.** Queries carry a job title and a company name;
  `assertNoPiInPayload` refuses anything else and applies the brand's residency rule.
- **Same functionality on both brands (D5).** GoApply searches its own index (no
  RapidAPI), plans with its formats (the AI-interview format included) and mainland
  China's norms; the AI gate (bound phone + consent) applies to every route.

## Latency and cost (measured on the dev stack, 2026-10-12)

| Step | Time | Model cost |
|---|---|---|
| Search ("AI FDE", US) | ~8 s (resolver 5–6 s, index + job boards in parallel) | ~$0.0003 |
| Industry roles | ~8 s, then cached | ~$0.0004 |
| Company style | ~10 s (3 searches ~4 s, agent ~6–12 s), then cached | ~$0.0005–0.0007 + 3 searches |
| Plan | ~21–24 s | ~$0.002 |
| Session prepare (questions) | unchanged path, now with the plan in the prompt | ~$0.003 |

## Extending

- A new interview pattern or market: add an entry to `skills/patterns.ts` or
  `skills/markets.ts` (three directives + a one-line summary + when to use).
- A new industry: add it to `prep/industries.ts` with its nine labels and, if it
  should lead a market, to that market's order.
- A new posting source: add a leg in `jobFinder.ts` (`JobFinderDeps`) returning
  `PrepPosting`s; ranking and de-duplication are shared.

## Open items

- The company-style cache is per instance; a durable store (a table) would make the
  first plan for a popular company instant on every instance.
- Company research could start as soon as a company is typed, before a job is chosen.
- A full interview loop (several rounds back to back with the same plan) and a report
  section that grades against the plan's focus are natural next steps.
