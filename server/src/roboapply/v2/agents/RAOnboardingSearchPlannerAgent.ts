// backend/src/roboapply/v2/agents/RAOnboardingSearchPlannerAgent.ts
//
// Onboarding-chat Agent #4 — convert the candidate headline + preference
// draft into ONE dual search plan: an internal RAJob query and an external
// JSearch (Google for Jobs) request. Runs once per recommendation round
// (≤3/session). Per the production prompt pack §4
// (docs/roboapply-onboarding-prompt-pack.md) with adversarial-review fixes:
//
//   E5/R3 — the internal plan NEVER carries salaryMin. The
//     `RAJobIndexService.search()` salary filter is currency-blind and its
//     Prisma `gte` excludes null-salary rows (every jsearch row), so a stated
//     TWD floor against the USD seed corpus would zero out every round.
//     Salary is enforced ONLY in the service-layer post-fetch prefilter
//     (null salary passes, currency mismatch skips the comparison). The
//     prompt never asks for it and parseOutput drops it if emitted.
//
//   R16 — a stated city that unambiguously implies a country sets the JSearch
//     `country` ("Singapore" → sg), overriding the locale market default;
//     a few-shot example pins the behavior.
//
// Notes:
//   - Haiku tier, temperature 0.2, maxTokens 400
//   - parseOutput never throws; run() back-fills empty plan slots from the
//     exported deterministic `buildFallbackPlan` (also the orchestrator's
//     whole-stage fallback when the LLM call itself fails)
//   - `alternates` from the pack draft are dropped: the wire type carries a
//     single query and an unbilled alternate can never be an LRU hit in
//     round 1 (critic finding 16)
//   - Locale: NO locale directive (getLocaleDirective → null). The prompt
//     body fully owns per-field language (internal plan ALWAYS English,
//     external query in the MARKET language); a user-language directive
//     would override the internal-English rule and zero out internal search
//     for CJK users. A code-level ASCII guard on internal.q/location backs
//     the rule up regardless of what the model emits.

import { BaseAgent } from '../../../agents/BaseAgent.js';
import { RA_MODEL_HAIKU } from './raModels.js';
import { asStringArray, clip, parseJsonObject } from '../lib/interviewGenShared.js';
import {
  normalizeEmploymentType,
  normalizeWorkMode,
} from '../lib/raOnboardingDraft.js';
import type {
  OnboardingEmploymentType,
  OnboardingExternalSearchPlan,
  OnboardingInternalSearchPlan,
  OnboardingPlannerInput,
  OnboardingSearchPlan,
} from '../types/onboarding.js';

// ─── Public types ───────────────────────────────────────────────────────

export interface RAOnboardingSearchPlannerInput extends OnboardingPlannerInput {
  /** Recommendation round number (1-3). Defaults to 1. */
  round?: number;
  /** External queries already billed this session — never repeated. */
  previousQueries?: string[];
  /** Present only after a zero-result round — the constraint to loosen. */
  relaxationHint?: string;
}

// Default model + env override (read at call time).
export const RA_ONBOARDING_PLAN_MODEL = RA_MODEL_HAIKU;
const ENV_MODEL = 'RA_V2_ONBOARDING_PLAN_MODEL';

export function pickOnboardingPlanModel(): string {
  return process.env[ENV_MODEL]?.trim() || RA_ONBOARDING_PLAN_MODEL;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Keep only printable-ASCII tokens — the internal corpus is
 *  English-normalized; CJK tokens match nothing (code-level twin of the
 *  prompt's "ALWAYS ENGLISH" rule). */
function asciiTokens(value: string): string {
  return value
    .split(/\s+/)
    .filter((token) => /^[\x21-\x7E]+$/.test(token))
    .join(' ')
    .trim();
}

function normalizeCountry(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return /^[A-Za-z]{2}$/.test(trimmed) ? trimmed.toLowerCase() : '';
}

const JSEARCH_EMPLOYMENT_TOKENS = new Set([
  'FULLTIME',
  'CONTRACTOR',
  'PARTTIME',
  'INTERN',
]);

const EMPLOYMENT_TO_JSEARCH: Record<OnboardingEmploymentType, string> = {
  full_time: 'FULLTIME',
  contract: 'CONTRACTOR',
  part_time: 'PARTTIME',
  internship: 'INTERN',
};

function normalizeJSearchEmploymentTypes(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const tokens = value
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter((t) => JSEARCH_EMPLOYMENT_TOKENS.has(t));
  return tokens.length > 0 ? Array.from(new Set(tokens)).join(',') : undefined;
}

/** Market language tag for the JSearch `language` param. */
const COUNTRY_LANGUAGE: Record<string, string> = {
  tw: 'zh-tw',
  jp: 'ja',
  cn: 'zh',
  hk: 'zh-tw',
  us: 'en',
  gb: 'en',
  sg: 'en',
  au: 'en',
  ca: 'en',
};

/**
 * Deterministic fallback plan from targetRoles[0] + raw draft fields + the
 * market default — used by run() to back-fill empty slots after a degraded
 * parse, and by the orchestrator as the whole-stage fallback when the LLM
 * call throws. CJK role/city text degrades gracefully: the internal q drops
 * non-ASCII tokens (possibly to ''), the external query keeps them (market
 * language is correct there).
 */
export function buildFallbackPlan(
  input: RAOnboardingSearchPlannerInput,
): OnboardingSearchPlan {
  const draft = input.draft ?? {};
  const roleText = clip(draft.targetRoles?.[0] ?? input.candidateHeadline, 120);
  const city = clip(draft.locations?.cities?.[0] ?? '', 60);

  const internal: OnboardingInternalSearchPlan = {
    q: asciiTokens(roleText).toLowerCase().split(/\s+/).slice(0, 6).join(' ').trim(),
  };
  if (draft.workModes?.length === 1) internal.workType = draft.workModes[0];
  if (draft.employmentTypes?.length === 1) {
    internal.employmentType = draft.employmentTypes[0];
  }
  const asciiCity = asciiTokens(city);
  if (asciiCity) internal.location = asciiCity;

  const country =
    normalizeCountry(draft.locations?.countries?.[0]) ||
    normalizeCountry(input.marketCountry) ||
    'us';
  const external: OnboardingExternalSearchPlan = {
    query: [roleText, city].filter(Boolean).join(' ').trim(),
    country,
    workFromHome:
      draft.workModes?.length === 1 && draft.workModes[0] === 'remote',
    datePosted: 'month',
  };
  const language = COUNTRY_LANGUAGE[country];
  if (language) external.language = language;
  if (draft.employmentTypes && draft.employmentTypes.length > 0) {
    external.employmentTypes = draft.employmentTypes
      .map((t) => EMPLOYMENT_TO_JSEARCH[t])
      .filter(Boolean)
      .join(',');
  }

  return { internal, external };
}

/** Back-fill empty load-bearing slots of a parsed plan from the fallback. */
function fillPlanGaps(
  plan: OnboardingSearchPlan,
  fallback: OnboardingSearchPlan,
): OnboardingSearchPlan {
  const internal = { ...plan.internal };
  const external = { ...plan.external };
  if (!internal.q) internal.q = fallback.internal.q;
  if (!external.query) external.query = fallback.external.query;
  if (!external.country) external.country = fallback.external.country;
  return { internal, external };
}

// ─── Agent ──────────────────────────────────────────────────────────────

export class RAOnboardingSearchPlannerAgent extends BaseAgent<
  RAOnboardingSearchPlannerInput,
  OnboardingSearchPlan
> {
  constructor() {
    super('RAOnboardingSearchPlannerAgent');
  }

  protected getTemperature(): number {
    // Structured planning — near-deterministic, with a little query variety.
    return 0.2;
  }

  protected getMaxTokens(): number | undefined {
    // Two small objects; 400 is generous.
    return 400;
  }

  /**
   * Deliberately NO locale directive (see file header): the prompt body owns
   * per-field output language, and the strict user-language directive would
   * override the internal-English rule and zero out internal search for CJK
   * users. run() also passes no jdContent, so no auto-detected directive is
   * prepended either.
   */
  protected getLocaleDirective(_locale: string): string | null {
    return null;
  }

  // Prompt pack §4.2 with: the {{LANGUAGE_DIRECTIVE}} slot removed, salaryMin
  // removed from the internal plan (E5/R3), `alternates` dropped (single
  // billed query — wire type carries no alternates), and the R16 stated-city
  // → country rule + Singapore few-shot added.
  protected getAgentPrompt(): string {
    return `You are a job-search query planner. You convert a candidate profile and their
partially-captured preferences into ONE plan with two parts: an internal database
search and an external JSearch (Google for Jobs) request. You do not chat, score,
or rank. Budgets and execution are decided elsewhere — you only plan.

You receive:
- HEADLINE: one-line candidate summary.
- DRAFT: preferences captured so far (any subset may be missing).
- MARKET_COUNTRY: default market (lowercase ISO code) derived from stated locations
  or the user's locale.
- ROUND: recommendation round number (1-3).
- PREVIOUS_QUERIES: external queries already used this session.
- RELAXATION_HINT: present only when the previous round returned nothing — names
  the constraint to loosen.

EXTERNAL QUERY ("query"):
- Shape: [seniority adjective] [role] in [city], or [seniority] [role] for
  remote-only searches. The query carries ROLE and PLACE only.
- NEVER put salary, company names, or industries into the query string — JSearch
  has no salary parameter and over-stuffed queries return junk. Salary and
  industry filtering happen after fetch, elsewhere in the system.
- Language follows the MARKET, not the app: for tw/jp/cn markets, write the query
  in the local language when the candidate's roles are stated in it (e.g.
  "資深後端工程師 台北" surfaces 104人力銀行 postings that an English query misses).
  For en markets, English. Globally-used technical terms (Python, SRE, PM,
  Kubernetes) stay in English even inside CJK queries.
- CAREER CHANGERS: when DRAFT.targetRoles point away from the HEADLINE's history,
  search the STATED destination — never silently revert to the old track.
- Never repeat anything in PREVIOUS_QUERIES. On ROUND 2-3, plan the next-best
  unexplored angle (secondary target role, adjacent title, broader geography).
- If RELAXATION_HINT is present, loosen exactly that constraint and keep the rest.

EXTERNAL PARAMETERS:
- country: DRAFT.locations.countries[0] lowercased if present. Otherwise, if a
  stated city UNAMBIGUOUSLY implies one country (Singapore → "sg", Taipei →
  "tw", Tokyo → "jp", London → "gb"), set the country from that city — the city
  the user actually named beats the locale default. Else MARKET_COUNTRY.
- language: the market's query language tag (e.g. "zh-tw", "ja", "en") or null.
- work_from_home: true ONLY when workModes is exactly ["remote"] (remote-only).
  Hybrid or mixed intent → false, with the city in the query.
- employment_types: map ONLY stated DRAFT.employmentTypes — full_time→FULLTIME,
  contract→CONTRACTOR, part_time→PARTTIME, internship→INTERN, comma-joined; null
  when unstated. Never default it.
- date_posted: always "month".

INTERNAL PLAN — ALWAYS ENGLISH, regardless of the user's language. The internal
corpus is English-normalized; non-English tokens match nothing. Translate role
words and city names to English yourself.
- q: 2-6 lowercase ENGLISH tokens for OR-overlap title/description matching: the
  core role tokens plus 1-2 strong synonyms or domain tokens (e.g. "senior backend
  engineer payments"). For career changers, include one bridge-domain token from
  their history. No filler words, no CJK or other non-English tokens — ever.
- location: stated city as its ENGLISH name ("Taipei", not "台北"), else null.
- workType: emit ONLY when exactly one work mode is stated; if two or more modes
  are acceptable, null — a single hard filter would wrongly exclude accepted modes.
- employmentType: emit ONLY when exactly one employment type is stated; if two or
  more types are accepted, null — same reason (the column holds one value).
- The internal plan has NO salary field. Salary filtering is enforced by the
  system after fetch — never emit salaryMin or any salary value anywhere in the
  plan.
- Unstated = null. Never invent constraints the user did not state; derive the role
  from HEADLINE only when DRAFT.targetRoles is empty.

Schema:
{"internal": {"q": "...", "workType": "remote"|"hybrid"|"onsite"|null, "employmentType": "full_time"|"contract"|"part_time"|"internship"|null, "location": "..."|null}, "external": {"query": "...", "country": "..", "language": "..."|null, "work_from_home": false, "employment_types": "..."|null, "date_posted": "month"}}

EXAMPLES:

HEADLINE: "Senior backend engineer, ~8 yrs, payments" / DRAFT: targetRoles ["Senior
Backend Engineer"], workModes ["remote"], industriesTarget ["Fintech"], salary
{min:150000, currency:"USD", period:"year"} / MARKET_COUNTRY: "us" / ROUND: 1 /
PREVIOUS_QUERIES: []
OUTPUT: {"internal":{"q":"senior backend engineer payments fintech","workType":"remote","employmentType":null,"location":null},"external":{"query":"senior backend engineer","country":"us","language":"en","work_from_home":true,"employment_types":null,"date_posted":"month"}}
(The stated salary floor is NOT in the plan — the system enforces it after fetch.)

HEADLINE: "資深後端工程師，約 8 年經驗，支付系統" / DRAFT: targetRoles ["資深後端工程師"],
workModes ["remote","hybrid"], locations {cities:["台北"], remoteOk:true}, salary
{min:90000, currency:"TWD", period:"month"}, employmentTypes ["full_time","contract"]
/ MARKET_COUNTRY: "tw" / ROUND: 1 / PREVIOUS_QUERIES: []
OUTPUT: {"internal":{"q":"senior backend engineer payments","workType":null,"employmentType":null,"location":"Taipei"},"external":{"query":"資深後端工程師 台北","country":"tw","language":"zh-tw","work_from_home":false,"employment_types":"FULLTIME,CONTRACTOR","date_posted":"month"}}
(Internal plan is ENGLISH: role translated, 台北 → "Taipei". workType null and
employmentType null because two of each are acceptable. No salary anywhere in
the plan. External query stays in the market language; hybrid acceptable →
work_from_home false, city anchors the query.)

HEADLINE: "Marketing manager, 6 yrs, B2C e-commerce" / DRAFT: {} (turn-5 forced
round, nothing captured) / MARKET_COUNTRY: "jp" / ROUND: 1 / PREVIOUS_QUERIES: []
OUTPUT: {"internal":{"q":"marketing manager ecommerce growth","workType":null,"employmentType":null,"location":null},"external":{"query":"マーケティングマネージャー","country":"jp","language":"ja","work_from_home":false,"employment_types":null,"date_posted":"month"}}
(Nothing stated → derive the role from HEADLINE, constrain nothing else.)

HEADLINE: "Data analyst, 5 yrs, banking" / DRAFT: targetRoles ["Data Analyst"],
locations {cities:["Singapore"]} / MARKET_COUNTRY: "us" / ROUND: 1 /
PREVIOUS_QUERIES: []
OUTPUT: {"internal":{"q":"data analyst banking","workType":null,"employmentType":null,"location":"Singapore"},"external":{"query":"data analyst in singapore","country":"sg","language":"en","work_from_home":false,"employment_types":null,"date_posted":"month"}}
(The stated city Singapore unambiguously implies the country: "sg" overrides
the en-locale market default "us".)

Output ONLY the JSON object. No prose, no fences, no trailing newline noise.`;
  }

  protected formatInput(input: RAOnboardingSearchPlannerInput): string {
    // Clips per pack §4.2: DRAFT_PREFS_JSON 1200, PREVIOUS_QUERIES 300.
    return [
      `HEADLINE: ${clip(input.candidateHeadline, 160)}`,
      `DRAFT: ${clip(JSON.stringify(input.draft ?? {}), 1200)}`,
      `MARKET_COUNTRY: ${normalizeCountry(input.marketCountry) || 'us'}`,
      `ROUND: ${input.round ?? 1}`,
      `PREVIOUS_QUERIES: ${clip(JSON.stringify(asStringArray(input.previousQueries, 6, 160)), 300)}`,
      `RELAXATION_HINT: ${clip(input.relaxationHint ?? '', 80) || '(none)'}`,
    ].join('\n');
  }

  protected parseOutput(response: string): OnboardingSearchPlan {
    const obj = parseJsonObject(response);
    const internalRaw =
      obj.internal && typeof obj.internal === 'object' && !Array.isArray(obj.internal)
        ? (obj.internal as Record<string, unknown>)
        : {};
    const externalRaw =
      obj.external && typeof obj.external === 'object' && !Array.isArray(obj.external)
        ? (obj.external as Record<string, unknown>)
        : {};

    // E5/R3: internalRaw.salaryMin is deliberately ignored even when emitted.
    const internal: OnboardingInternalSearchPlan = {
      q: asciiTokens(clip(internalRaw.q, 120)).toLowerCase(),
    };
    const workType = normalizeWorkMode(internalRaw.workType);
    if (workType) internal.workType = workType;
    const employmentType = normalizeEmploymentType(internalRaw.employmentType);
    if (employmentType) internal.employmentType = employmentType;
    const location = asciiTokens(clip(internalRaw.location, 80));
    if (location) internal.location = location;

    const external: OnboardingExternalSearchPlan = {
      query: clip(externalRaw.query, 160),
      country: normalizeCountry(externalRaw.country),
      datePosted: 'month',
    };
    const language = clip(externalRaw.language, 12).toLowerCase();
    if (/^[a-z]{2}(-[a-z]{2})?$/.test(language)) external.language = language;
    external.workFromHome =
      externalRaw.work_from_home === true || externalRaw.workFromHome === true;
    const employmentTypes = normalizeJSearchEmploymentTypes(
      externalRaw.employment_types ?? externalRaw.employmentTypes,
    );
    if (employmentTypes) external.employmentTypes = employmentTypes;

    return { internal, external };
  }

  /**
   * Public wrapper. A degraded parse (empty q/query/country) is back-filled
   * from the deterministic fallback; an LLM throw propagates so the
   * orchestrator's stage try/catch can substitute `buildFallbackPlan` whole.
   */
  async run(
    input: RAOnboardingSearchPlannerInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<OnboardingSearchPlan> {
    const enriched: RAOnboardingSearchPlannerInput = {
      ...input,
      round: input.round ?? 1,
      previousQueries: input.previousQueries ?? [],
    };
    const plan = await this.execute(
      enriched,
      undefined,
      options.requestId,
      options.locale,
      pickOnboardingPlanModel(),
      options.signal,
    );
    return fillPlanGaps(plan, buildFallbackPlan(enriched));
  }
}

export const raOnboardingSearchPlannerAgent = new RAOnboardingSearchPlannerAgent();
export default raOnboardingSearchPlannerAgent;

// Test surface — keep tight.
export const __test = {
  pickOnboardingPlanModel,
  buildFallbackPlan,
  fillPlanGaps,
  asciiTokens,
  normalizeCountry,
  normalizeJSearchEmploymentTypes,
};
