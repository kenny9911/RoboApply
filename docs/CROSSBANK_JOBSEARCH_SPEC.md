All fatal-flaw facts are confirmed against the live codebase. I now have everything needed. Here is the final authoritative architecture.

---

# RoboApply Cross-Bank Job-Search Agent Team — FINAL Architecture (v1, authoritative)

Status: implement verbatim. Winner spine = **coverage-first** (unanimous judge pick: 42 / 41.5 / 41.5). Grafted from **accuracy-first**: the acceptance-odds ranking composite, CitationGuard raise-odds levers, `INVITE_SCALE_OFFSET`, default-bar degeneracy handling, `canonicalizeTag`, `alsoOnBank`, the `BankJobProvider` seam shape, and the tenancy gate. Every fatal flaw the three judges raised is resolved below and cross-referenced as **[FIX-n]**.

All facts in this spec were verified by direct read on 2026-07-11 against `server/prisma/schema.prisma`, `server/src/lib/prisma.ts`, `server/src/lib/databaseUrl.ts`, `server/src/lib/matchBilling.ts`, `server/src/roboapply/v2/services/RAOnboardingRecommendService.ts`, `server/src/roboapply/v2/agents/RAJobMatchScorerAgent.ts`, and `server/src/types/semanticLabels.ts`.

---

## 1. Overview & the coverage/accuracy thesis

RoboHire and GoHire are the **same product white-labelled onto two physically separate Postgres DBs with an identical Prisma schema**. Today the app connects to exactly one bank at a time (`APP_NAME` → `databaseUrl.ts`). This feature reads the recruiter-side `Job` (+`Company`) rows out of **both** banks, materializes matched jobs into the candidate-side `RAJob` index, LLM-scores them into `RAJobMatchScore`, and thereby **becomes the job inventory** — instantly filling `/home`, `/search`, onboarding recs and `/tracker` with real, scored jobs. This is the highest-leverage fix for the P0 "matcher reads an empty internal table" gap (LOCKED DECISION 4 / recon §30-31).

**Thesis — coverage is the invariant, accuracy is a re-rank-and-label layer on top, never an upfront filter.**

1. **Retrieval is high-recall and non-starving.** The only hard `WHERE` cuts are true dealbreakers: `status='open'`, `publishedAt` present and fresh (≤45d). Salary / level / work-mode are *soft weights*, never SQL cuts — this is the documented starvation trap from the onboarding pipeline. Tag/keyword overlap is *one OR-signal* in retrieval and *one term* in a deterministic pre-score, **never a hard drop**.
2. **We never gamble the funnel on the recruiter tag grammar.** The producers of `requiredTagSet`/`matchInviteScore` (`JobSemanticTagAgent`, `JobKeywordService`, `JobBankMatchService`) **do not exist in this repo**, so those arrays may be empty `[]` and the bar may be the untuned `@default(60)`. Accuracy-first's design staked its whole funnel on a hard `requiredTagCoverage≥0.70` gate against a grammar this repo cannot confirm — a mass false-negative hazard that reintroduces the exact empty-inventory bug **[FIX-5]**. We keep tags soft; a grammar miss degrades *ranking*, never *recall*.
3. **Accuracy arrives in two layers over the wide pool:** (a) the reused `RAJobMatchScorerAgent` (calibrated 0-100 Sonnet), and (b) the recruiter's own `matchInviteScore` turned into an honest **acceptance-odds** band. Both are directional "odds / above-the-bar" signals, explicitly *not* an invite guarantee (the two rubrics are only heuristically comparable) **[FIX cross-scale]**.
4. **Everything above a low `PRE_FLOOR` is materialized** into `RAJob` so it is visible in `/search` even if the Sonnet budget never reaches it. Two output buckets: **Recommended** (scored, good odds, "apply now") and **Explore** (adjacent/stretch, honestly labeled "worth a look / would need X"). Coverage guaranteed; accuracy surfaced; nothing silently dropped.

The grafted upgrade: **within the Recommended bucket, jobs are ordered by accuracy-first's acceptance-odds composite** (invite-margin sigmoid dominant, anchored by a *scale-free* required-coverage term), not by a flat `0.6·llm + 0.4·odds` blend — so "a job far above ITS recruiter's own bar outranks a higher-raw-score job below its bar," the mandated behavior.

---

## 2. Multi-DB layer (exact signatures)

Three physical Postgres: `DATABASE_URL` = the **active brand's candidate DB** (User, RAResumeVariant, **all writes**: RAJob, RAJobMatchScore, RATrackerEntry); `DATABASE_URL_ROBOHIRE` / `DATABASE_URL_GOHIRE` = the two recruiter banks (**read-only** `Job`/`Company`). One generated Prisma client, three pools.

### 2.1 `server/src/lib/prisma.ts` — MODIFY

**[FIX-2] `ExtendedPrismaClient` is currently a local unexported `type` at line 443 — it MUST be exported** or `raBankClients.ts` cannot type its client map.

```ts
// line 443: add `export`
export type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

// NEW: extract the 3 $extends (transient-error-retry, role-invariant-guard,
// seeker-append-only-guard) verbatim into one helper, reused by both paths.
function applyExtensions(base: PrismaClient): ExtendedPrismaClient { /* the existing .$extends chain, byte-identical */ }

// NEW exported factory. Same Pool sizing (max: process.env.VERCEL?1:10),
// same pool.on('error', ()=>{}), same adapter. keepalive defaults OFF for
// bank clients (read-mostly, Vercel-safe). Throws only on empty url.
export function createPrismaClientForUrl(rawUrl: string, opts?: { keepalive?: boolean }): ExtendedPrismaClient {
  const url = cleanConnectionString(rawUrl);
  if (!url) throw new Error('createPrismaClientForUrl: empty connection string');
  const pool = new Pool({ connectionString: url, max: process.env.VERCEL ? 1 : 10,
    idleTimeoutMillis: 90_000, connectionTimeoutMillis: 30_000, keepAlive: true });
  pool.on('error', () => {});
  const base = new PrismaClient({ adapter: new PrismaPg(pool),
    log: process.env.NODE_ENV === 'development' ? ['error','warn'] : ['error'] });
  if (opts?.keepalive) { /* the existing setInterval SELECT 1 .unref() block */ }
  return applyExtensions(base);
}

// UNCHANGED public surface — singleton derives from the factory, keeping the
// fail-fast missing-url error message identical.
function createPrismaClient() {
  const runtimeUrl = pickRuntimeUrl();
  if (!runtimeUrl) throw new Error('DATABASE_URL is not set — …'); // existing message verbatim
  return createPrismaClientForUrl(runtimeUrl, { keepalive: shouldEnableKeepalive() });
}
export const prisma = global.prisma || createPrismaClient(); // unchanged

// NEW small exports so raBankClients can dedup pools against the active DB:
export function activeRuntimeUrl(): string | undefined { return pickRuntimeUrl(); }
export { cleanConnectionString };
```

### 2.2 `server/src/lib/databaseUrl.ts` — MODIFY

Mirror the existing `resolveDbBrand()` / `resolvePooledDatabaseUrl()` style. Returning `undefined` = that bank is disabled (round degrades to the other).

```ts
export function resolveRoboHireDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL_ROBOHIRE
      || (resolveDbBrand() === 'robohire' ? process.env.DATABASE_URL : undefined);
}
export function resolveGoHireDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL_GOHIRE
      || process.env.DATABASE_URL_LIGHTARK
      || (resolveDbBrand() === 'gohire' ? process.env.DATABASE_URL : undefined);
}
export function resolveDirectRoboHireDatabaseUrl(): string | undefined {
  return process.env.DIRECT_DATABASE_URL_ROBOHIRE || resolveRoboHireDatabaseUrl();
}
export function resolveDirectGoHireDatabaseUrl(): string | undefined {
  return process.env.DIRECT_DATABASE_URL_GOHIRE || resolveGoHireDatabaseUrl();
}
export function activeBank(): 'robohire' | 'gohire' { return resolveDbBrand() === 'gohire' ? 'gohire' : 'robohire'; }
```

### 2.3 `server/src/roboapply/v2/lib/raBankClients.ts` — NEW

Lazy, per-cleaned-URL cached clients. **[FIX-6] The extra-pool optimization is now real, not a false claim:** when a bank's cleaned URL equals the active runtime URL, `getBankClient` returns the existing singleton `prisma` instead of opening a second pool.

**Tenancy gate [FIX legal]:** the active brand's own bank is always allowed; the *foreign* bank requires `RA_CROSSBANK_CROSS_TENANT_CONFIRMED==='true'` (the contractual white-label sign-off, enforced in code, not just documented).

```ts
export type BankId = 'robohire' | 'gohire';
const cacheByUrl = new Map<string, ExtendedPrismaClient>();

function urlForBank(b: BankId): string | undefined {
  return b === 'robohire' ? resolveRoboHireDatabaseUrl() : resolveGoHireDatabaseUrl();
}
export function isBankEnabled(b: BankId): boolean {
  if (!urlForBank(b)) return false;
  if (process.env.RA_CROSSBANK_DISABLED?.trim().toLowerCase() === 'true') return false;
  if (process.env[`RA_CROSSBANK_${b.toUpperCase()}_DISABLED`]?.trim().toLowerCase() === 'true') return false;
  if (b !== activeBank() && process.env.RA_CROSSBANK_CROSS_TENANT_CONFIRMED?.trim().toLowerCase() !== 'true') return false; // legal gate
  return true;
}
export function listEnabledBanks(): BankId[] { return (['robohire','gohire'] as BankId[]).filter(isBankEnabled); }
export function getBankClient(b: BankId): ExtendedPrismaClient | null {
  const url = urlForBank(b); if (!url) return null;
  const key = cleanConnectionString(url); if (!key) return null;
  if (key === cleanConnectionString(activeRuntimeUrl())) return prisma; // reuse singleton, no 2nd pool
  let c = cacheByUrl.get(key);
  if (!c) { c = createPrismaClientForUrl(url, { keepalive: false }); cacheByUrl.set(key, c); }
  return c;
}
```

**Cold-start connection budget note [FIX-6]:** a foreign bank still opens one extra pool (`max:1` on Vercel). Worst case per cold instance = 2 pools (active singleton + one foreign bank), or 3 only if *both* bank env URLs differ from `DATABASE_URL`. Bounded and read-only; watch Neon/LightArk pooler limits under `/discover` burst (mitigated by the route rate-limit in §8).

---

## 3. The agent team

Five components. Deterministic ones use `model: none`. LLM agents extend `BaseAgent` and read their model via `pick*Model()` **at call time** (dotenv/ESM ordering rule).

### 3.1 `RACrossBankSearchService` — Orchestrator · model: none (deterministic)

- **Goal:** own one cross-bank round end-to-end — sequence the team, enforce budgets/concurrency, dedup across banks, materialize + score within budget, blend coverage & accuracy into the ranking, persist, return the DTO. **Never throws.**
- **Role:** deterministic coordinator (a service class, not a `BaseAgent`) mirroring `RAOnboardingRecommendService.runRound`'s never-throw + `emit()` streaming + budget contract. Reads candidate context from the default `prisma`; reads `Job`/`Company` via the two bank clients; **all writes go only to the default `prisma`**.
- **Rules:**
  - Every stage `try/caught`; one bank down → other-bank-only; both disabled/down/empty → `{ zeroResults:true }`. `RA_CROSSBANK_DISABLED` short-circuits to zeroResults.
  - Bank clients are strictly read-only (`findMany` on `Job`/`Company`). RAJob upsert, RAJobMatchScore upsert, deduction logs → default `prisma` only.
  - **[FIX-4] Do NOT reuse `scoreRows` verbatim** — it does `Promise.all(rows.map(...))` over the *whole* array (RAOnboardingRecommendService.ts:829), so a budget of 16 would fire 16 concurrent Sonnet calls. The orchestrator owns its own `scoreWave` using `mapWithConcurrency(rows, SCORER_CONCURRENCY=8, fn)` so in-flight ≤ 8 regardless of budget.
  - Respect `SCORER_BUDGET` (default 16, env `RA_CROSSBANK_SCORER_BUDGET`), `PER_BANK_QUERY_TAKE 60`, `PER_BANK_CANDIDATE_CAP 120`, `MATERIALIZE_CAP 120` (total, top-preScore).
  - Cache-first scoring via `evaluateCachedScore` (reused, RAOnboardingRecommendService.ts:183); failed scorer pairs skipped, debit zero.
  - Per fresh score: `writeDeductionLog({sku:'ra_crossbank_score', source:'free_tier', …costPatchFromTally(requestId)})`. Per insight call: `{sku:'ra_crossbank_insight'}`.
- **Input:** `CrossBankDiscoverInput` (§3.7). **Output:** `CrossBankDiscoverResult` (§3.7).
- **Receives from:** `routes/discover.ts`. **Sends to:** `routes/discover.ts` → `res.json`; side-effect RAJob + RAJobMatchScore rows into `/home`, `/search`, `/tracker`.

### 3.2 `RACrossBankExplorerAgent` — Opportunity Explorer · model: HAIKU

- **Goal:** widen recall. Turn `candidateHeadline` + resume-derived titles/skills + draft prefs into an expansion plan of **primary + adjacent + transferable-skill-stretch** titles plus a normalized tag/keyword vocabulary used as both banks' OR-union + set-overlap net.
- **Role:** `BaseAgent<CrossBankExplorerInput, CrossBankExplorerPlan>`. The only component allowed to broaden beyond the stated target. `getTemperature()` 0.3, `getMaxTokens()` 700 (CJK headroom for the tag/keyword arrays), `getResponseFormat()` `'json_object'`, `getLocaleDirective()` → `null`.
- **Rules:**
  - Internal tokens **always English/ASCII** (CJK matches nothing in the normalized corpus); translate role/city words to English (the `RAOnboardingSearchPlannerAgent` rule).
  - Adjacency must be skill-graph-justified: every `stretchTitle` shares ≥1 `transferableSkillTag` with the candidate; never invent unrelated roles.
  - Never narrow below the stated target: `primaryTitles` always include the candidate's stated/target role.
  - Emit `transferableSkillTags` in **both** grammars we might meet — bare canonical (`python`, `kubernetes`) AND, where natural, namespaced (`lang:python`) — because the recruiter grammar is unverifiable; `canonicalizeTag()` (§5.1) reconciles both sides downstream. Under-claiming is safer than over-claiming since these feed soft overlap only.
  - Caps: `primaryTitles ≤4`, `adjacentTitles ≤6`, `stretchTitles ≤4`, `transferableSkillTags ≤20`, `mustKeywords ≤15`, `niceKeywords ≤15`.
  - `parseOutput` NEVER throws — `run()` back-fills every empty slot from `buildExplorerFallback(signals, draft)` (deterministic).
  - `pickCrossBankExplorerModel()` reads `RA_V2_CROSSBANK_EXPLORER_MODEL || RA_MODEL_HAIKU` at call time.

```ts
interface CrossBankExplorerInput {
  candidateHeadline: string; currentTitles: string[]; topSkills: string[];
  seniority: 'entry'|'mid'|'senior'|'lead'|'exec'|'unknown'; yearsExperience: number | null;
  draft: OnboardingDraftPreferences; marketCountry: string; banks: BankId[];
}
interface CrossBankExplorerPlan {
  primaryTitles: string[]; adjacentTitles: string[]; stretchTitles: string[];
  transferableSkillTags: string[]; mustKeywords: string[]; niceKeywords: string[];
  seniorityBands: string[]; rationale: string;
}
```
- **Receives from:** Orchestrator (`deriveCandidateSignals(variant)` + draft + enabled banks). **Sends to:** the bank retrieval sweep (query net) and the Insight Analyst (`rationale`).

### 3.3 `RACrossBankPreMatcher` — Pre-Matcher · model: none (pure module `raCrossBankMatch.ts`)

- **Goal:** score the wide retrieved pool cheaply, assign a coverage tier (core/adjacent/stretch), compute the acceptance-odds inputs against each job's `matchInviteScore`, dedup cross-bank twins, and reserve the LLM budget across tiers so accuracy never starves recall.
- **Role:** pure, heavily unit-tested set-algebra + arithmetic (no I/O, no `BaseAgent`). Owns `canonicalizeTag`, `computePreScore`, `assignTier`, `resolveMatchInviteScore`, `crossBankDedup`, `reserveScorerBudgetByTier`, `computeAcceptanceOdds`, `inviteBand`, and the raise-odds lever extraction.
- **Rules:**
  - Set-algebra on `requiredTagSet`/`preferredTagSet`/`requiredKeywordSet` vs `(candidateTagSet ∪ plan.transferableSkillTags)` after `canonicalizeTag()` on **both** sides.
  - **[FIX-5] No hard drops on tags/keywords/salary/level/work-mode.** The only exclusions: dealbreaker companies + avoided industries (token containment) and `preScore < PRE_FLOOR`.
  - **Belt-and-suspenders keyword coverage (grafted):** a `requiredKeyword` counts as satisfied if it is in the candidate keyword set OR appears as a normalized token in the resume text (`resumeTokens`), so a vocabulary miss never silently zeroes a real fit.
  - **[FIX-3] Seniority ladder maps recruiter `'executive'` → `'exec'`.** `Job.experienceLevel` is `entry|mid|senior|lead|executive` (schema:1202). `bandIdx`/`levelIdx` over `['entry','mid','senior','lead','exec']`; `parseSeniorityBand()` maps `intern/junior→entry`, `intermediate→mid`, `staff/principal/lead→lead`, `executive/exec/vp/director/head→exec`, unknown→`0.6` neutral.
  - **[FIX resolver]** `resolveMatchInviteScore(job)` NEVER reads `Job.matchInviteScore` raw (schema:1231 warns of un-hydrated fakes). Returns `{ inviteBar: clamp(raw ?? 60, 55, 80), barIsDefault: (raw == null || raw === 60) }`.
  - Cross-bank dedup by `jobFingerprint` (reused, `raOnboardingDraft.ts:614`) keeping max `preScore`; ties → bank order `[robohire, gohire]` → newer `publishedAt`; an already-scored twin beats an unscored twin; winner records `alsoOnBank` = loser's bank (grafted attribution).
  - Reserve the scorer budget by tier and guarantee `MIN_STRETCH_SCORED` (§5).
  - Compute per-job `missingRequiredTags` / `missingRequiredKeywords` = the exact unsatisfied predicates — the ONLY citable "raise your odds" levers downstream (grafted).

```ts
interface PreMatchInput { rows: BankJobRow[]; plan: CrossBankExplorerPlan; signals: CandidateSignals;
  draft: OnboardingDraftPreferences; resumeTokens: Set<string>; scorerBudget: number;
  aggressiveness: 'balanced'|'coverage'|'precision'; }
interface PreMatchedCandidate {
  bank: BankId; job: BankJobRow['job']; company: BankJobRow['company'];
  preScore: number; tier: 'core'|'adjacent'|'stretch';
  requiredCoverage: number; keywordCoverage: number; preferredOverlap: number;
  projectedScore: number; inviteBar: number; barIsDefault: boolean;
  fingerprint: string; alsoOnBank: BankId | null; recency01: number;
  missingRequiredTags: string[]; missingRequiredKeywords: string[];
}
interface PreMatchResult { coverageSet: PreMatchedCandidate[]; toScore: PreMatchedCandidate[]; droppedTwins: number; }
```
- **Receives from:** the retrieval sweep (BankJobRow[]) + Explorer plan + candidate signals. **Sends to:** Orchestrator → materialize `coverageSet` into RAJob; feed `toScore` to the Precise Matcher.

### 3.4 Bank retrieval seam — deterministic (`raBankProviders.ts`)

- **Goal:** high-recall retrieval of open recruiter `Job` rows per bank; never throws → returns `null` on failure so the orchestrator degrades.
- **Role:** the `BankJobProvider` seam (grafted shape: `bank` / `isEnabled()` / `search()`), but **`search` takes an injected client** (coverage-first testability) so it is unit-testable against a fake bank client with no live DB. Pure `buildBankJobWhere(plan, freshnessCutoff)` is separately unit-tested.

```ts
interface BankJobProvider {
  readonly bank: BankId;
  isEnabled(): boolean;                       // = isBankEnabled(this.bank)
  search(client: ExtendedPrismaClient, intent: BankSearchIntent,
         ctx: { requestId?: string; signal?: AbortSignal }): Promise<BankJobRow[] | null>;
}
```
- **`buildBankJobWhere`** ORs (non-starving): each expanded title `{ title: { contains, mode:'insensitive' } }` over `primaryTitles ∪ adjacentTitles ∪ stretchTitles`; each `mustKeyword` against `description` + `qualifications`; `{ requiredTagSet: { hasSome: canonicalized tags } }`; `{ preferredTagSet: { hasSome: canonicalized tags } }`. **Only hard filters:** `status:'open'`, `publishedAt:{ not:null, gte: cutoff }`. **No salary/level/work-mode in SQL.** `include:{ company:{ select:{ name:true, logoUrl:true } } }`, `orderBy:{ publishedAt:'desc' }`, `take: 60`. Within-bank dedup on `Job.id`, cap 120.
- **Output** `BankJobRow` selects the full recruiter signal set: `id, title, description, qualifications, hardRequirements, niceToHave, benefits, location, locationCity, locationCountry, workType, employmentType, experienceLevel, salaryMin/Max/Currency/Period, requiredTagSet, preferredTagSet, requiredKeywordSet, preferredKeywordSet, matchInviteScore, matchWeights, publishedAt` + `{ companyName, companyLogoUrl }` + `bank` + `retrievedVia:'title'|'keyword'|'tag'`.
- **Receives from:** Orchestrator (client via `getBankClient(bank)` + `BankSearchIntent`). **Sends to:** Pre-Matcher.

### 3.5 `RAJobMatchScorerAgent` — Precise Matcher · model: SONNET · **REUSED VERBATIM**

- **Goal:** produce the calibrated 0-100 accuracy score + `summary/strengths/gaps/keywordsMatched/keywordsMissing` for each `(resume, materialized job)` pair in the budgeted subset.
- **Role:** existing `BaseAgent`, **no new scorer, no modification**. Temp 0.1; **its own `getMaxTokens()` (~600 output cap — do NOT re-describe as 1500; the agent comment at line 15 caps output ~600)**; throws on malformed output so a bad pair is never cached or billed. Model via `pickJobMatchScorerModel()` (`RA_V2_JOB_MATCH_SCORER_MODEL || RA_MODEL_SONNET`).
- **Rules:** called only from the orchestrator's `scoreWave` (`mapWithConcurrency ≤8`); each success upserts `RAJobMatchScore` + writes `ra_crossbank_score`; each throw caught → pair skipped, debit zero. Fed the candidate's primary `RAResumeVariant.resumeMarkdown` + the **materialized RAJob's** title/description/qualifications/benefits. Cache accepted only when `evaluateCachedScore → fresh`.

```ts
interface RAJobMatchScorerInput { resumeMarkdown: string; jobTitle: string; jobDescription: string; jobQualifications: string; jobBenefits?: string; }
interface RAJobMatchScorerOutput { score: number; summary: string; strengths: string[]; gaps: string[]; keywordsMatched: string[]; keywordsMissing: string[]; }
```
- **Receives from:** Orchestrator (`toScore` cache-miss pairs). **Sends to:** Orchestrator (score+prose → RAJobMatchScore + acceptance-odds compute) and the Insight Analyst (strengths/gaps).

### 3.6 `RACrossBankInsightAgent` — Insight Analyst · model: SONNET

- **Goal:** explain the shortlist honestly — a portfolio-level coverage-vs-accuracy narrative, and per-job "why matched" + **"the ONE thing that would raise your odds."**
- **Role:** `BaseAgent<CrossBankInsightInput, CrossBankInsight>`. Sonnet temp 0.4, `getMaxTokens()` 1400 (CJK), `getResponseFormat()` `'json_object'`. Reuses the `RACareerInsightAgent` CitationGuard discipline.
- **Rules (grafted CitationGuard):**
  - `perJob[].jobId` MUST be in `input.shortlist` or it is stripped (no fabricated jobs).
  - `raiseOddsNote` must name only a lever in that job's `raiseOddsLevers` set (the deterministic `missingRequiredTags ∪ missingRequiredKeywords`); any hint naming an out-of-set lever is stripped. When `requiredTagSet`/`requiredKeywordSet` are empty for a job, fall back to the Sonnet scorer's `gaps[]` for that job's note.
  - Second person, in-locale (`getStrictOutputLanguageDirective`); prose scrubbed of numeric scores (`SCORE_PATTERN`) and third-person address — the card carries the number.
  - `parseOutput` never throws → `{ portfolioSummary: deterministic fallback, perJob: [] }`; the orchestrator fills missing notes with deterministic `composeWhyMatched` + a gap/invite-gap line.
  - `pickCrossBankInsightModel()` reads `RA_V2_CROSSBANK_INSIGHT_MODEL || RA_MODEL_SONNET` at call time.

```ts
interface CrossBankInsightInput { candidateHeadline: string; locale: RaLocale; coverage: CrossBankCoverageStats;
  shortlist: Array<{ jobId: string; title: string; companyName: string; bank: BankId;
    matchScore: number; inviteBar: number; barIsDefault: boolean; acceptanceOdds: number;
    acceptanceBand: 'strong'|'on_the_bar'|'reach'|'bar_unset'; tier: 'recommended'|'adjacent'|'stretch';
    strengths: string[]; gaps: string[]; raiseOddsLevers: string[]; }>; }
interface CrossBankInsight { portfolioSummary: string;
  perJob: Array<{ jobId: string; acceptanceNote: string; raiseOddsNote: string | null; }>; }
```
- **Receives from:** Orchestrator (scored shortlist + coverage + acceptance-odds). **Sends to:** Orchestrator (`portfolioSummary` → view; per-job notes → `DiscoverJobCard.whyMatched` / `raiseOdds`).

### 3.7 Orchestrator input/output contracts

```ts
interface CrossBankDiscoverInput {
  userId: string; resumeVariantId: string | null; locale: RaLocale;
  requestId?: string; signal?: AbortSignal; limit?: number; /* recommended cap, default 12 */
  aggressiveness?: 'balanced'|'coverage'|'precision'; emit?: (e: RAOnboardingStreamEvent) => void;
}
interface CrossBankDiscoverResult {
  recommended: DiscoverJobCard[]; explore: DiscoverJobCard[];
  coverage: CrossBankCoverageStats; insight: CrossBankInsightView | null;
  banksSwept: BankId[]; banksDegraded: BankId[];
  scorerCallsUsed: number; scorerCacheHits: number; zeroResults: boolean;
}
```

---

## 4. Orchestration sequence (concurrency · budget · failure handling)

`RACrossBankSearchService.run(input): Promise<CrossBankDiscoverResult>` — one never-throwing round. Top-level `try/catch → zeroResults`; `finally → logger.info('RA_V2_CROSSBANK', summary)`.

- **STEP 0 — GATE + SWEEP.** If `RA_CROSSBANK_DISABLED==='true'` → zeroResults. `const p = prisma`. **Lazy archival sweep [FIX-8 bloat/staleness]:** best-effort bounded `p.rAJob.updateMany({ where:{ sourceBoard:{ in:['robohire','gohire'] }, archivedAt:null, postedAt:{ lt: now − FRESHNESS_DAYS } }, data:{ archivedAt: now } })` so expired mirrors drop out of `/search`.
- **STEP 1 — CONTEXT.** Load resume variant (`resumeVariantId ?? primary`, `userId`, `deletedAt:null`; select `id, resumeMarkdown, resumeContentHash, parsedData, summary`). No `resumeMarkdown` → zeroResults. `signals = deriveCandidateSignals(variant)` (pure) → `{ currentTitles, topSkills, candidateTagSet, candidateKeywords, seniority, years }`. Precompute `resumeTokens = new Set(normalizeTokens(resumeMarkdown))` once (belt-and-suspenders keyword coverage).
- **STEP 2 — BANKS.** `banks = listEnabledBanks()`. Empty → zeroResults. `emit({type:'status',key:'searching_internal'})`.
- **STEP 3 — EXPLORER (Haiku, 1 call).** `marketCountry = draft.locations.countries[0] ?? locale default`. `plan = await explorer.run({candidateHeadline, ...signals, draft, marketCountry, banks}, {requestId, signal})`; throw → `buildExplorerFallback(signals, draft)`.
- **STEP 4 — RETRIEVAL SWEEP (both banks in parallel, each try/caught).**
  ```ts
  const pools = await Promise.allSettled(banks.map(b =>
    BANK_PROVIDERS[b].search(getBankClient(b)!, buildIntent(plan, signals),
      { requestId, signal })));
  ```
  A rejected/`null` pool → that bank degraded (record in `banksDegraded`), its rows `[]`. All banks empty/null → zeroResults.
- **STEP 5 — PRE-MATCH (deterministic).** `preMatch = preMatchCandidates({ rows: pools.flat(), plan, signals, draft, resumeTokens, scorerBudget: SCORER_BUDGET, aggressiveness })` → preScore + tier + projectedScore + `{inviteBar, barIsDefault}` per row; cross-bank fingerprint dedup; filter `preScore ≥ PRE_FLOOR` → `coverageSet`; tier-reserved budget split → `toScore`. `coverageSet` capped to `MATERIALIZE_CAP` top-preScore.
- **STEP 6 — MATERIALIZE (default prisma).** For each `coverageSet` row: `p.rAJob.upsert({ where:{ externalId_sourceBoard:{ externalId: job.id, sourceBoard: bank } }, create/update: mapRecruiterJobToRAJobUpsert(job, company, bank, verdict) })`. Collect `rAJobId` keyed by `(bank, job.id)`. **This is the P0 inventory fix** — `coverageSet` is visible in `/search` even when unscored.
- **STEP 7 — SCORING (Sonnet, cache-first, waves ≤8).** `emit({type:'status',key:'scoring'})`. Batch-load `RAJobMatchScore` cache for the `toScore` RAJob ids (`userId, resumeVariantId`). `evaluateCachedScore → fresh` → reuse score+prose (count `cacheHits`). Misses (bounded by remaining budget) → **`scoreWave(rows) = mapWithConcurrency(rows, SCORER_CONCURRENCY=8, scorePair)`** **[FIX-4]**. Each success upserts `RAJobMatchScore` (explanation stamped, §6) + `writeDeductionLog('ra_crossbank_score')`; each throw → skip, debit zero. Budget-exhausted `toScore` rows keep `preScore` as a proxy and are flagged `scored:false` (they land in Explore).
- **STEP 8 — ACCEPTANCE-ODDS (deterministic).** For every scored job compute `computeAcceptanceOdds(llmScore, verdict)` + `inviteBand()` (§5.3).
- **STEP 9 — INSIGHT (Sonnet, 1 call).** `shortlist = ` top ~12 scored by acceptance-odds. `insight = await insightAgent.run({...}, {requestId, locale, signal}).catch(() => null)`; CitationGuard to shortlist jobIds + raiseOddsLevers; missing notes → deterministic fallback. `writeDeductionLog('ra_crossbank_insight')`.
- **STEP 10 — RANK + BUCKET (deterministic, §5.4).** Recommended = scored & `llmScore ≥ SCORE_FLOOR`, ordered by **acceptanceOdds desc**, sliced to `limit`. Explore = `coverageSet` minus Recommended, ordered by `preScore desc`, sliced to 24, tier-labeled. Batch-load `RATrackerEntry` bookmark state. Build `DiscoverJobCard[]` per bucket.
- **STEP 11 — RETURN** `{ recommended, explore, coverage, insight, banksSwept, banksDegraded, scorerCallsUsed, scorerCacheHits, zeroResults: recommended.length + explore.length === 0 }`.

**Concurrency/budget ceiling:** ≤2 bank sweeps ∥ · 1 Haiku · ≤16 Sonnet scores in `≤8`-wide waves (hard-capped by `mapWithConcurrency`) · 1 Sonnet insight. Per-run ≈ **$0.30–0.35** (see §8). Route enforces a per-user daily cap + rate limit.

**`mapWithConcurrency` (new util, `raCrossBankMatch.ts`):**
```ts
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers); return out;
}
```

---

## 5. Coverage × accuracy ranking algorithm (exact formulas, thresholds, dedup)

**CONSTANTS:** `FRESHNESS_DAYS=45`, `PER_BANK_QUERY_TAKE=60`, `PER_BANK_CANDIDATE_CAP=120`, `MATERIALIZE_CAP=120`, `PRE_FLOOR=25`, `SCORE_FLOOR=60`, `SCORER_BUDGET=16` (env), `SCORER_CONCURRENCY=8`, recommended `limit=12`, explore cap `24`. Budget split (balanced) core `0.60`/adjacent `0.25`/stretch `0.15`, `MIN_STRETCH_SCORED=3`; `coverage`→`0.45/0.35/0.20`; `precision`→`0.75/0.18/0.07`. Odds: `INVITE_CONF_SPREAD=8`, `INVITE_SCALE_OFFSET=0` (env `RA_CROSSBANK_INVITE_OFFSET`, tunable).

### 5.1 `canonicalizeTag(tag)` — grammar reconciliation (both sides)

The recruiter grammar is **unverifiable** (schema:1296 shows `lang:python`/`seniority:senior+`; `semanticLabels.ts:4,225` says title-case canonical enums `Python`, and the producer is absent). So canonicalization must accept **both**:
1. lowercase, trim, collapse whitespace/underscores→`-`.
2. If a known namespace prefix (`lang:`, `framework:`, `skill:`, `category:`, `domain:`, `tool:`) is present, keep a namespaced form AND emit a bare form (strip prefix). If absent, emit the bare form. Comparison succeeds if either form matches.
3. Apply a small synonym map: `k8s→kubernetes`, `golang→go`, `js→javascript`, `ts→typescript`, `postgres/psql→postgresql`, `py→python`, `reactjs→react`, `node/nodejs→node`. (Extensible; ship the initial map.)
4. Predicate-aware for seniority tags: `seniority:senior+` is satisfied iff `bandIdx(candidate) ≥ bandIdx(senior)`.

Applied to **both** candidate tags and job tag sets before every overlap — so a grammar mismatch degrades to zero *overlap on that tag*, never a hard drop (tags are soft).

### 5.2 Pre-score (deterministic, LLM-free) — `raCrossBankMatch.ts`

Let `candTags = canonicalize(signals.candidateTagSet ∪ plan.transferableSkillTags)`; `candKw = normalize(signals.candidateKeywords ∪ plan.mustKeywords)`. Per job:

```
requiredCoverage  = |canon(requiredTagSet)  ∩ candTags| / |requiredTagSet|         (= 1.0 if requiredTagSet empty)
keywordCoverage   = |{k ∈ requiredKeywordSet : k ∈ candKw OR k ∈ resumeTokens}| / |requiredKeywordSet|   (= 1.0 if empty; belt-and-suspenders)
preferredOverlap  = |canon(preferredTagSet) ∩ candTags| / |preferredTagSet|         (= 0.0 if empty — it is a bonus)
titleAffinity     = 1.0 if title matches a primaryTitle, 0.75 adjacent, 0.45 stretch;
                    else clamp(maxTokenOverlap(title, primary∪adjacent), 0, 0.5)
seniorityFit      = max(0, 1 − 0.35·|levelIdx(map(job.experienceLevel)) − bandIdx(signals.seniority)|)   (unknown → 0.6)
projectedScore    = 100·(0.5·requiredCoverage + 0.3·keywordCoverage + 0.2·preferredOverlap)   // LLM-free stand-in
{inviteBar, barIsDefault} = resolveMatchInviteScore(job)
inviteReadiness   = clamp01(0.5 + (projectedScore − inviteBar)/80)
recency01         = clamp01(1 − ageDays/FRESHNESS_DAYS)
preScore = 100·(0.34·requiredCoverage + 0.16·keywordCoverage + 0.14·preferredOverlap
              + 0.18·titleAffinity + 0.08·seniorityFit + 0.10·inviteReadiness) · (1 + 0.05·recency01)
```
`levelIdx` maps `entry|mid|senior|lead|executive` → `0..4` (**`executive`→`exec` slot 4 [FIX-3]**).

**TIER:** `core` if `titleAffinity ≥ 0.85 && requiredCoverage ≥ 0.6`; else `adjacent` if `titleAffinity ≥ 0.55 || requiredCoverage ≥ 0.5`; else `stretch` (requires `requiredCoverage > 0 || keywordCoverage > 0` — some transferable overlap).

**COVERAGE GUARANTEE:** keep all `preScore ≥ PRE_FLOOR(25)` → `coverageSet`; all materialized (up to `MATERIALIZE_CAP`), visible in `/search` regardless of LLM scoring.

**BUDGET RESERVATION:** `SCORER_BUDGET` split by tier per `aggressiveness`; within each tier take top-preScore; under-filled tier spills to the next; enforce `MIN_STRETCH_SCORED=3` so adjacent/stretch always get Sonnet attention — the knob that stops accuracy from silently deleting recall.

### 5.3 Acceptance-odds (accuracy-first composite, grafted) — computed after Sonnet scoring

```
margin           = (llmScore − INVITE_SCALE_OFFSET) − inviteBar
inviteConfidence = 1 / (1 + exp(−margin / INVITE_CONF_SPREAD))          // llm==bar → 0.5; +8 → ~0.73; +16 → ~0.88
reqCoverageAnchor= 0.6·requiredCoverage + 0.4·keywordCoverage            // scale-FREE recruiter predicate
// DEFAULT-BAR DEGENERACY HANDLING [FIX-3(bar)]: an untuned @default(60) bar makes inviteConfidence collapse to "llm>60".
(W_INVITE, W_REQCOV, W_PREF) = barIsDefault ? (0.35, 0.55, 0.10) : (0.60, 0.30, 0.10)
acceptanceOdds01 = W_INVITE·inviteConfidence + W_REQCOV·reqCoverageAnchor + W_PREF·preferredOverlap   ∈ (0,1)
acceptanceOddsPct= round(100 · acceptanceOdds01)
```
**Band (honest label, never a guarantee):** `barIsDefault → 'bar_unset'`; else `llmScore ≥ inviteBar+8 → 'strong'`; `|llmScore−inviteBar| < 8 → 'on_the_bar'`; `llmScore ≤ inviteBar−8 → 'reach'`.

**Worked example (mandated JobB > JobA):** JobA `llm=92, bar=80, reqCov=0.5, kwCov=0.5, pref=0.2` (tuned): margin +12 → conf ≈ 0.83; anchor = 0.5 → odds ≈ `0.60·83 + 0.30·50 + 0.10·20 = 66.8`. JobB `llm=78, bar=60(tuned), reqCov=0.95, kwCov=0.9, pref=0.7`: margin +18 → conf ≈ 0.90; anchor ≈ 0.93 → odds ≈ `0.60·90 + 0.30·93 + 0.10·70 = 88.9`. **JobB (lower raw score, far above its recruiter's bar, near-full required coverage) outranks JobA** — the required exact behavior. (If JobB's bar were the untuned default, weights shift to 0.35/0.55/0.10 and JobB still wins on the anchor.)

### 5.4 Final ranking / buckets

- **RECOMMENDED** = scored jobs with `llmScore ≥ SCORE_FLOOR(60)`, ordered by **`acceptanceOddsPct` desc** (grafted composite replaces the flat `0.6·llm+0.4·odds` blend), tie-break `recency01 desc` → bank order. Sliced to `limit(12)`. "Apply now, good odds."
- **EXPLORE** = `coverageSet` minus Recommended (unscored OR `llmScore < 60`), ordered by `preScore desc`, labeled `tier: adjacent|stretch` with a "worth a look / would need X" note. Sliced to 24. The recall safety net.

### 5.5 Cross-bank dedup

`jobFingerprint({ title, companyName, locationCity, location, isRemote: workType==='remote' })` (reused, null-city tolerant, `raOnboardingDraft.ts:614`) groups cross-posted twins. Keep max `preScore`; ties → bank order `[robohire, gohire]` → newer `publishedAt`; an already-LLM-scored twin beats an unscored twin. Winner records `alsoOnBank = loser's bank` (grafted) so the card shows "also on GoHire" without double-scoring or double-billing. `RAJob @@unique([externalId, sourceBoard])` with `sourceBoard ∈ {robohire, gohire}` keeps `Job.id` collision-free across the two physical DBs.

---

## 6. Job→RAJob mapping · RAJobMatchScore persistence · plug-in surfaces · DTO

### 6.1 `mapRecruiterJobToRAJobUpsert(job, company, bank, verdict)` — pure, unit-tested

- `sourceBoard = bank`; `externalId = job.id`; `applyUrl = synthesizeApplyUrl(bank, job.id)` (`${ROBOHIRE_PUBLIC_JOB_BASE_URL | GOHIRE_PUBLIC_JOB_BASE_URL}/jobs/${id}`, defaults `https://www.robohire.io/jobs/{id}` / the GoHire host — `Job` has no `applyUrl`).
- `title`; `titleNormalized = normalizeForSearch(title)` (reused, `raJobSearch.ts:186`); `companyName = job.companyName ?? company?.name ?? ''`; `companyNameNormalized`; `companyLogoUrl = company?.logoUrl ?? null`.
- `location/locationCity/locationCountry`; `workType = normalizeWorkMode(job.workType) ?? 'onsite'` (`remote|hybrid|onsite`, default `onsite` — RAJob:5148); `employmentType = normalizeEmploymentType(job.employmentType)`.
- **`salaryPeriod = normalizeSalaryPeriod(job.salaryPeriod)` [FIX-7, load-bearing]:** recruiter `Job.salaryPeriod` default `'monthly'`, values `monthly|yearly` (schema:1224); RAJob default `'year'` (schema:5156). Map `monthly→month`, `yearly|annual→year`, `weekly→week`, `hourly|hour→hour`, default→`year`. **Dedicated unit test required** (a wrong map silently corrupts the downstream salary prefilter). `salaryMin/Max/Currency` pass through (`Currency ?? 'USD'`).
- `description`; `descriptionPlain = stripControl(stripHtml(description))`; `qualifications = [qualifications, hardRequirements].filter(Boolean).join('\n\n')`; `responsibilities = null`; `benefits`; `postedAt = job.publishedAt`; `archivedAt = null`.
- **`seedTags` JSON** carries the recruiter signals so ranking/insight read them off RAJob without re-querying the bank:
  `{ bank, sourcePublisher: bankDisplayName(bank), requiredTagSet, preferredTagSet, requiredKeywordSet, preferredKeywordSet, matchInviteScore: verdict.inviteBar, barIsDefault: verdict.barIsDefault, alsoOnBank: verdict.alsoOnBank, retrievedVia, ingestedVia: 'crossbank_v1', missingRequiredTags: verdict.missingRequiredTags, missingRequiredKeywords: verdict.missingRequiredKeywords }`.

Upsert into default `prisma` keyed `@@unique([externalId, sourceBoard])` — idempotent; re-runs refresh the row.

### 6.2 RAJobMatchScore persistence (reuse the onboarding write verbatim)

Upsert on `@@unique([userId, jobId, resumeVariantId])` (`jobId` = materialized RAJob id, bank-namespaced): `{ score: llmScore, explanation, resumeContentHashAtScore, modelUsed: pickJobMatchScorerModel(), generatedAt }`. `explanation = { strengths, gaps, rationale: summary, signals:{skills,experience,location,salary}, responseLanguage: locale, promptVersion: SCORER_PROMPT_VERSION, crossBank:{ bank, inviteBar, barIsDefault, requiredCoverage, keywordCoverage, acceptanceOdds, acceptanceBand, aboveBar } }`. **The `crossBank` sub-object is additive; `evaluateCachedScore`'s fresh/scoreOnly staleness gates (resumeContentHash + `responseLanguage===locale` + `promptVersion` present) are untouched** — caching works identically.

### 6.3 Billing

`server/src/lib/matchBilling.ts` `DeductionSku` union (line 617) gains **`'ra_crossbank_score'`** and **`'ra_crossbank_insight'`** (both audit-only, `source:'free_tier'`, like `ra_match_score`). Per fresh score: `writeDeductionLog({ userId, sku:'ra_crossbank_score', source:'free_tier', units:1, relatedEntityType:'ra_job', relatedEntityId: rAJobId, ...costPatchFromTally(requestId), metadata:{ source:'roboapply_v2_crossbank', agent:'RAJobMatchScorerAgent', bank } })` (`costPatchFromTally` at `deductionCost.ts:60`, `writeDeductionLog` at `matchBilling.ts:710`). Insight call → `sku:'ra_crossbank_insight'`. Failed LLM calls debit zero.

### 6.4 Plug-in surfaces (two, one code path)

1. **Greenfield discover surface** (the agent-team home). `routes/discover.ts`: `router.post('/run', requireAuth, handler)`, mounted `router.use('/discover', discoverRouter)` in `routes/index.ts` → `POST /api/v1/roboapply/v2/discover/run`. Inline `typeof` validation → 422 `{error:'invalid_resume_variant'}`; 500 `{error:'internal_error'}`; `res.json(CrossBankDiscoverResponse)`. Frontend: `hooks/useCrossBankDiscover.ts` (`raV2Api.discover.run`, queryKey `['v2','discover',...]`) → a `DiscoverResults` component with **Recommended / Explore** sections, acceptance-odds badge, "clears the bar" / "bar not set" chip, "via {bank}" + "also on {X}" attribution, and the raise-odds line.
2. **Live feed (zero new UI, the P0 fix).** Because `coverageSet` is materialized into RAJob (`sourceBoard robohire/gohire`) + scored into RAJobMatchScore, the same rows immediately appear in `/home` Today feed, `/search` (`RAJobIndexService` reads RAJob), onboarding recs, and are savable to `/tracker`. Only change there: widen the wire `source` union from `'internal'|'jsearch'` to include `'robohire'|'gohire'` (`OnboardingJobCard.source` / `RAJobListItem`) so the two banks render with proper source chips.

**Dead-posting reconciliation [FIX-8].** Materialized RAJob has no live status mirror; bank `Job.status` can flip to `closed/filled` after the sweep. Ship `reconcileCrossBankJobStatus(bank, externalId): Promise<'open'|'gone'>` — on card apply-click (and on job-detail open), re-query the bank `Job.status` via `getBankClient(bank)`; if not `'open'`, mark the RAJob `archivedAt` and surface "no longer open" instead of opening the synthesized `applyUrl`. Cheap, prevents dead applies.

### 6.5 Candidate DTO (wire — `lib/api/v2/types.ts`)

```ts
interface DiscoverJobCard {
  id: string; title: string; companyName: string; companyLogoUrl: string | null;
  location: string | null; workType: RAWorkType;
  salaryMin: number | null; salaryMax: number | null; salaryCurrency: string | null;
  salaryPeriod: 'month'|'year'|'week'|'hour' | null; postedAt: string | null;
  isBookmarked: boolean; matchScoreCached: number | null;
  matchScore: number;            // llmScore 0-100 (null-ish 0 when unscored → Explore)
  acceptanceOdds: number;        // 0-100
  acceptanceBand: 'strong'|'on_the_bar'|'reach'|'bar_unset';
  inviteBar: number; barIsDefault: boolean; aboveBar: boolean; requiredCoverage: number;
  matchTier: 'recommended'|'adjacent'|'stretch';
  whyMatched: string; raiseOdds: string | null;
  source: 'robohire'|'gohire'; sourcePublisher: string; alsoOnBank: 'robohire'|'gohire'|null;
  applyUrl: string; isExternal: true;
}
interface CrossBankCoverageStats { banksSwept: string[]; banksDegraded: string[];
  totalRetrieved: number; materialized: number; recommendedCount: number; exploreCount: number;
  droppedTwins: number; metSolidTarget: boolean;
  perBank: Record<string, { retrieved: number; recommended: number }>; }
interface CrossBankInsightView { portfolioSummary: string; }
interface CrossBankDiscoverResponse { recommended: DiscoverJobCard[]; explore: DiscoverJobCard[];
  coverage: CrossBankCoverageStats; insight: CrossBankInsightView | null;
  banksSwept: string[]; scorer: { callsUsed: number; cacheHits: number; budget: number };
  zeroResults: boolean; }
```

---

## 7. Complete file manifest

**NEW**
| File | Responsibility |
|---|---|
| `server/src/roboapply/v2/services/RACrossBankSearchService.ts` | Orchestrator `run()`: never-throw, bank sweep ∥, pre-match, materialize, cache-first `scoreWave` (own `mapWithConcurrency ≤8`), acceptance-odds, insight, rank/bucket, persist, DTO. Exports `raCrossBankSearchService` singleton + `__test` seams. |
| `server/src/roboapply/v2/agents/RACrossBankExplorerAgent.ts` | Haiku `BaseAgent<CrossBankExplorerInput,CrossBankExplorerPlan>`; temp 0.3, maxTokens 700, `json_object`, locale→null; `buildExplorerFallback`; `pickCrossBankExplorerModel`; `__test`. |
| `server/src/roboapply/v2/agents/RACrossBankInsightAgent.ts` | Sonnet `BaseAgent`; temp 0.4, maxTokens 1400; CitationGuard (jobId + raiseOddsLevers), score/third-person scrub, parse-lenient; `pickCrossBankInsightModel`; `__test`. |
| `server/src/roboapply/v2/lib/raBankClients.ts` | `BankId`, `getBankClient` (singleton-reuse + per-URL cache), `isBankEnabled` (+ tenancy gate), `listEnabledBanks`. |
| `server/src/roboapply/v2/lib/raBankProviders.ts` | `BankJobProvider` seam + `robohireBankProvider`/`gohireBankProvider`; `search(client, intent, ctx)` (injected client) with `buildBankJobWhere` + `normalizeBankJobRow`; returns `null`, never throws. |
| `server/src/roboapply/v2/lib/raCrossBankMatch.ts` | Pure heart: `canonicalizeTag`, `parseSeniorityBand`(executive→exec), `deriveCandidateSignals`, `computePreScore`, `assignTier`, `resolveMatchInviteScore` (clamp 55–80 + `barIsDefault`), `crossBankDedup`(jobFingerprint + alsoOnBank), `reserveScorerBudgetByTier`(MIN_STRETCH_SCORED), `computeAcceptanceOdds`(default-bar reweight + INVITE_SCALE_OFFSET), `inviteBand`, `computeRaiseOddsLevers`, `mapRecruiterJobToRAJobUpsert`, `synthesizeApplyUrl`, `normalizeWorkMode`, `normalizeEmploymentType`, `normalizeSalaryPeriod`, `bankDisplayName`, `mapWithConcurrency`, `buildCoverageStats`. Wide `__test` export. |
| `server/src/roboapply/v2/lib/raCrossBankMatch.test.ts` | Vitest: canonicalizeTag both-grammars + synonyms; `salaryPeriod monthly→month/yearly→year`; preScore weights; tier assignment; `resolveMatchInviteScore` clamp + `barIsDefault`; acceptanceOdds worked example (**JobB > JobA**) + default-bar reweight; dedup keep-max + bank tie-break + alsoOnBank; budget reservation incl. MIN_STRETCH_SCORED; `executive→exec`; `mapWithConcurrency` never exceeds limit. |
| `server/src/roboapply/v2/lib/raBankProviders.test.ts` | `buildBankJobWhere`: only status/published/fresh as hard filters; no salary/level/work-mode WHERE; OR-union title+keyword+tag hasSome. |
| `server/src/roboapply/v2/agents/__tests__/RACrossBankInsightAgent.test.ts` | CitationGuard strips out-of-set jobIds and out-of-set raiseOdds levers; score/third-person scrub. |
| `server/src/roboapply/v2/routes/discover.ts` | `POST /discover/run` (requireAuth, inline validation→422, service call, 500 internal_error, `getRequestLocale`). |
| `server/src/roboapply/v2/types/crossBank.ts` | `CandidateSignals, BankJobRow, BankSearchIntent, BankJobProvider, PreMatchInput/PreMatchedCandidate/PreMatchResult, CrossBankExplorerInput/Plan, CrossBankInsightInput/Insight, CrossBankCoverageStats, DiscoverJobCard, CrossBankDiscoverInput/Result, SeniorityBand, AcceptanceBand`. |
| `hooks/useCrossBankDiscover.ts` | `useMutation`/`useQuery` over `raV2Api.discover.run`. |
| `components/v3/onboarding/DiscoverResults.tsx` (+ `DiscoverJobCard.tsx`, may extend `OnboardingJobCard.tsx`) | Recommended/Explore sections; odds-band badge; "clears the bar"/"bar not set" chip; via-bank + also-on attribution; raiseOdds line. |

**MODIFY**
| File | Change |
|---|---|
| `server/src/lib/prisma.ts` | **[FIX-2]** `export` `ExtendedPrismaClient`; extract `applyExtensions`; add `export createPrismaClientForUrl(url, opts)`; derive singleton from it (public surface unchanged); export `activeRuntimeUrl()` + `cleanConnectionString`. |
| `server/src/lib/databaseUrl.ts` | Add `resolveRoboHire/GoHireDatabaseUrl` (+ `resolveDirect*`) + `activeBank()`. |
| `server/src/lib/matchBilling.ts` | Add `'ra_crossbank_score'` + `'ra_crossbank_insight'` to `DeductionSku`. |
| `server/src/roboapply/v2/routes/index.ts` | `import discoverRouter; router.use('/discover', discoverRouter)`. |
| `server/src/roboapply/v2/types/onboarding.ts` | Widen `OnboardingJobCard.source` to `'internal'|'jsearch'|'robohire'|'gohire'`. |
| `server/prisma/schema.prisma` | Update `RAJob.sourceBoard` doc comment to include `'robohire'|'gohire'` (**no migration/DDL** — `sourceBoard` is a `String`). |
| `lib/api/v2/types.ts` | Add `DiscoverJobCard` + `CrossBankDiscoverResponse`; widen `RAJobListItem`/`OnboardingJobCard` source handling. |
| `lib/api/v2/_real.ts` | `discover.run = roboApi.post(\`${BASE}/discover/run\`, body)`. |
| `lib/stub/raV2.stub.ts` | `discover.run` stub returning the identical `CrossBankDiscoverResponse` shape (keeps `NODE_ENV=test` component tests green). |
| `.env.example` | `DATABASE_URL_ROBOHIRE`, `DATABASE_URL_GOHIRE` (+ `DIRECT_*`), `ROBOHIRE_PUBLIC_JOB_BASE_URL`, `GOHIRE_PUBLIC_JOB_BASE_URL`, `RA_CROSSBANK_DISABLED`, `RA_CROSSBANK_ROBOHIRE_DISABLED`, `RA_CROSSBANK_GOHIRE_DISABLED`, `RA_CROSSBANK_CROSS_TENANT_CONFIRMED`, `RA_CROSSBANK_SCORER_BUDGET`, `RA_CROSSBANK_INVITE_OFFSET`, `RA_V2_CROSSBANK_EXPLORER_MODEL`, `RA_V2_CROSSBANK_INSIGHT_MODEL`. |

---

## 8. Cost / billing + observability

- **Per-run cost:** 1 Haiku explorer (~$0.002) + ≤16 Sonnet scores (~$0.018 each ⇒ ≤$0.29, minus cache hits) + 1 Sonnet insight (~$0.01) ≈ **$0.30 typical, ~$0.35 ceiling**. Cache-first scoring makes repeat runs near-free. Compromise budget 16 (between accuracy-first's 12 and coverage-first's 24) preserves tier reservation while roughly halving coverage-first's cost/bloat.
- **Billing rows:** `ra_crossbank_score` per fresh score, `ra_crossbank_insight` per insight call — both audit-only `source:'free_tier'` (deliberately NOT the gated V1 `resume_match`; if this later bills real credit it must route through `runMatchWithQuota`'s gate→commit-on-success, not this audit SKU). Cost via `costPatchFromTally(requestId)`; failed calls debit zero.
- **Route guard:** `POST /discover/run` enforces a **per-user daily cap + rate limit** (mirror the mission daily-cap pattern) so the ≤$0.35/run path is not abusable.
- **Structured log (one line per run):** `logger.info('RA_V2_CROSSBANK', { userId, banksSwept, banksDegraded, retrieved, materialized, droppedTwins, scorerCalls, cacheHits, recommended, explore, gateDroppedByPreFloor, defaultBarShare, durationMs, platformCostUsd })`. `AGENT_LLM` per-agent cost lines are automatic via `chatLogged`.
- **Monitor before GA (the calibration debts):** `defaultBarShare` (how many banks ship the untuned 60 bar — drives which odds weights dominate), acceptance-odds vs **real invite outcomes** (to set `INVITE_SCALE_OFFSET`), adjacent/stretch surfaced ratio (Explorer over-broadening), and materialized-row growth (bloat/archival).

---

## 9. Open risks & mitigations

1. **Recruiter matching-signal producers are absent from this repo** (`JobSemanticTagAgent`/`JobKeywordService`/`JobBankMatchService`), so `requiredTagSet`/`requiredKeywordSet` may be `[]` and `matchInviteScore` the untuned `@default(60)`. **Mitigation [FIX-5]:** tags/keywords are *soft* — one OR-clause in retrieval, one term in a 6-term preScore, never a hard drop; keyword coverage falls back to raw resume tokens; `barIsDefault` reweights odds to lean on the scale-free required-coverage anchor. A signal-empty bank degrades ranking, never recall.
2. **Tag grammar is unverifiable** (schema `lang:python` vs `semanticLabels.ts` title-case `Python`). **Mitigation:** `canonicalizeTag()` accepts both namespaced and bare forms + a synonym map, applied to both sides; because tags are soft, a residual mismatch only softens a bonus term.
3. **Cross-scorer scale mismatch:** our Sonnet 0-100 rubric (35/30/15/10/10) vs the recruiter's `matchInviteScore` are only heuristically comparable. **Mitigation:** label everything "odds / above the bar", never "you will be invited"; `INVITE_SCALE_OFFSET` (env) corrects systematic drift once validated against real invite outcomes; the 0.30–0.55 required-coverage anchor keeps ranking honest if the LLM-vs-bar comparison is noisy.
4. **Concurrency [FIX-4]:** `scoreRows` is NOT chunked (`Promise.all` over the whole array). The orchestrator owns `mapWithConcurrency(rows, 8, fn)` so in-flight ≤ 8 regardless of the 16-budget — no rate-limit breach.
5. **Materialization bloat + dead postings [FIX-8]:** up to ~120 rows/run into the shared candidate index, no live status mirror. **Mitigation:** shipped `archivedAt` sweep at STEP 0 (postedAt < now−45d); `MATERIALIZE_CAP=120`; `reconcileCrossBankJobStatus` on apply-click/detail-open archives closed jobs and blocks dead applies. Add a periodic hard-purge of unreferenced crossbank RAJob rows as a V2.5 follow-up.
6. **Connection budget [FIX-6]:** `getBankClient` returns the singleton when a bank URL equals the active DB (no 2nd pool); a genuinely-foreign bank opens one extra `max:1` pool. Worst cold-start = 2 pools (3 only if both bank URLs differ from `DATABASE_URL`), all read-only. Watch Neon/LightArk pooler limits under `/discover` burst; the route rate-limit bounds it.
7. **White-label tenancy / legal boundary [FIX legal]:** reading the *foreign* brand's `Job` rows into a candidate index and synthesizing apply links crosses a contractual boundary. **Mitigation:** `isBankEnabled(foreign)` returns false unless `RA_CROSSBANK_CROSS_TENANT_CONFIRMED==='true'` — the sign-off is enforced in code; the active brand's own bank is always allowed, so single-bank cross-DB (the safe default) ships without the flag.
8. **Retrieval at scale:** the wide OR + `hasSome` sweep is a sequential scan (no pg_trgm/GIN on `Job.title`/`requiredTagSet` — cross-team recruiter-DB migration, V2.5-deferred). Fine at seed scale; load-test before GA. Per-bank `take 60` / cap 120 bound the scan.
9. **`resolveMatchInviteScore` must be self-defined [FIX resolver]:** `lib/matchInviteScore.ts` does NOT exist (schema:1231 mandates it aspirationally). Our resolver lives in `raCrossBankMatch.ts`, clamps 55–80 default 60, and NEVER reads the raw column elsewhere. If RoboHire later ships the canonical resolver, swap the import in one place.
10. **Brand-scoped double scoring:** cross-bank results write to the active brand's candidate DB, so the same candidate on both brands is scored twice. Accepted (accounts are brand-scoped); documented, not fixed.