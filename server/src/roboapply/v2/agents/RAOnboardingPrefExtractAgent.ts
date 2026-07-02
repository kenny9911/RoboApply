// backend/src/roboapply/v2/agents/RAOnboardingPrefExtractAgent.ts
//
// Onboarding-chat Agent #3 — strict-JSON preference extraction from the
// latest user message. Runs every chat turn BEFORE the chat agent so the
// streamed reply can acknowledge fresh captures. Per the production prompt
// pack §3 (docs/roboapply-onboarding-prompt-pack.md) with two adversarial-
// review fixes applied:
//
//   E11/R6 — per-field confidence: the output carries
//     `fieldConfidence: Record<field, number>` instead of one scalar, so the
//     sanctioned low-confidence salary inference no longer drags explicitly
//     stated co-captured fields (locations, employmentTypes, …) into the
//     unconfirmed set. Only genuinely inferred fields go below 0.7.
//
//   E15/R17 — the "也/too/also accept X" case is a NAMED sanctioned rule
//     (additive employment types include the market-default baseline
//     alongside X) and the zh-TW few-shot example agrees with the rule
//     instead of contradicting the EXPLICIT-ONLY core rule. The
//     deterministic union-merge in raOnboardingDraft.ts `mergeDraft` is the
//     code-level backstop either way.
//
// Notes:
//   - Haiku tier, temperature 0.1, maxTokens 500; fallback is a no-op turn
//     (`{updates:{}, …}`) — the conversation proceeds without the capture
//   - parseOutput re-normalizes every enum through the raOnboardingDraft.ts
//     taxonomy tables (closed list in prompt + parser normalization = two
//     enforcement lines; unknown values DROP) and never throws
//   - Locale: getLocaleDirective is overridden to the STRICT directive so
//     enum tokens stay English while free-text values (role titles, cities,
//     mustHaves) stay in the user's language

import { BaseAgent } from '../../../agents/BaseAgent.js';
import { RA_MODEL_HAIKU } from './raModels.js';
import { asStringArray, clip, parseJsonObject } from '../lib/interviewGenShared.js';
import {
  marketDefaultsForLocale,
  normalizeDraftUpdates,
} from '../lib/raOnboardingDraft.js';
import { RA_PREFERENCE_OPTIONS } from '../services/RAPreferencesService.js';
import type { RaLocale } from '../lib/raLocale.js';
import type {
  OnboardingDraftPreferences,
  OnboardingExtractorInput,
  OnboardingExtractorOutput,
  OnboardingTopic,
} from '../types/onboarding.js';

// ─── Public types ───────────────────────────────────────────────────────

export interface RAOnboardingPrefExtractInput extends OnboardingExtractorInput {
  /** Topic of the assistant's most recent question (OnboardingTopic id), or
   *  'none' — resolves bare answers like "no" / "不用". */
  lastQuestionTopic?: string;
  /** Pre-built market hint; run() derives it from the locale when absent. */
  localeMarketHint?: string;
}

export interface RAOnboardingPrefExtractOutput extends OnboardingExtractorOutput {
  /** User signalled completion ("I'm done", "就這樣吧") — S3→S4 trigger. */
  wantsToFinish: boolean;
}

// Default model + env override (read at call time — see pickJDParseModel for
// the dotenv/ESM ordering rationale).
export const RA_ONBOARDING_EXTRACT_MODEL = RA_MODEL_HAIKU;
const ENV_MODEL = 'RA_V2_ONBOARDING_EXTRACT_MODEL';

export function pickOnboardingExtractModel(): string {
  return process.env[ENV_MODEL]?.trim() || RA_ONBOARDING_EXTRACT_MODEL;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Safe no-op output — the conversation proceeds without a capture. */
export function emptyExtractOutput(): RAOnboardingPrefExtractOutput {
  return {
    updates: {},
    declinedTopics: [],
    fieldConfidence: {},
    wantsJobsNow: false,
    wantsToFinish: false,
    pastedResumeDetected: false,
  };
}

/**
 * Build the {{LOCALE_MARKET_HINT}} string deterministically from the
 * locale→market table in raOnboardingDraft.ts (pack §3.2 wording).
 */
export function buildLocaleMarketHint(locale: string): string {
  const market = marketDefaultsForLocale(locale as RaLocale);
  const norms: Partial<Record<string, string>> = {
    en: 'salary norm annual',
    'zh-TW': 'salary norm monthly (月薪, 萬)',
    ja: 'salary norm annual (年収, 万円)',
  };
  const norm = norms[locale];
  return `market ${market.country}; currency ${market.currency}${norm ? `; ${norm}` : ''}`;
}

/** Normalize declined-topic tokens to the orchestrator's OnboardingTopic
 *  vocabulary; pack-style synonyms map, everything else drops. */
const DECLINED_TOPIC_TABLE: Record<string, OnboardingTopic> = {
  salary: 'salary',
  workmode: 'workMode',
  workmodes: 'workMode',
  industry: 'industry',
  industries: 'industry',
  companytype: 'industry',
  employmenttype: 'employmentType',
  employmenttypes: 'employmentType',
  location: 'location',
  locations: 'location',
  seniority: 'seniority',
};

function normalizeDeclinedTopics(raw: unknown): OnboardingTopic[] {
  const out: OnboardingTopic[] = [];
  for (const token of asStringArray(raw, 12, 40)) {
    const topic = DECLINED_TOPIC_TABLE[token.toLowerCase()];
    if (topic && !out.includes(topic)) out.push(topic);
  }
  return out;
}

/** List-valued draft fields (for false-clear detection below). */
const LIST_FIELDS = [
  'targetRoles',
  'workModes',
  'employmentTypes',
  'industriesTarget',
  'industriesAvoid',
  'companyStages',
  'companySizes',
  'mustHaves',
  'dealbreakers',
] as const;

/**
 * In the draft-merge contract an EMPTY array is an explicit "clear X". But
 * the taxonomy tables also produce an empty array when every model-emitted
 * value was garbage ("employmentTypes": ["gig"] → []). That is NOT a clear —
 * passing it through would wipe a stored preference on a bad extraction. So
 * a list key whose RAW value was non-empty but normalized to [] is dropped
 * entirely instead.
 */
function dropFalseClears(
  raw: unknown,
  normalized: OnboardingDraftPreferences,
): OnboardingDraftPreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return normalized;
  const rawObj = raw as Record<string, unknown>;
  const out = { ...normalized };
  for (const key of LIST_FIELDS) {
    const rawValue = rawObj[key];
    const normValue = out[key];
    if (
      Array.isArray(rawValue) &&
      rawValue.length > 0 &&
      Array.isArray(normValue) &&
      normValue.length === 0
    ) {
      delete out[key];
    }
  }
  return out;
}

/**
 * Per-field confidence (E11/R6): one entry per top-level key actually present
 * in the normalized `updates`. Model-provided values are clamped to [0, 1];
 * a missing/garbage entry defaults to 1 (treat-as-explicit) — defaulting low
 * would mark every partial output unconfirmed and make the chat robotic,
 * which is exactly what R6 fights. The two sanctioned inferences are the only
 * systematic sub-0.7 sources and the prompt forces them explicitly.
 */
function normalizeFieldConfidence(
  raw: unknown,
  updates: OnboardingDraftPreferences,
): Record<string, number> {
  const rawObj =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const out: Record<string, number> = {};
  for (const key of Object.keys(updates)) {
    const value = rawObj[key];
    out[key] =
      typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.min(1, value))
        : 1;
  }
  return out;
}

// ─── Agent ──────────────────────────────────────────────────────────────

export class RAOnboardingPrefExtractAgent extends BaseAgent<
  RAOnboardingPrefExtractInput,
  RAOnboardingPrefExtractOutput
> {
  constructor() {
    super('RAOnboardingPrefExtractAgent');
  }

  protected getTemperature(): number {
    // Pure extraction → deterministic.
    return 0.1;
  }

  protected getMaxTokens(): number | undefined {
    // A sparse-delta JSON object; 500 is generous.
    return 500;
  }

  /**
   * Strict enum-safe directive (pack §0 slot map): enum tokens stay English,
   * free-text values follow the user's language. Falls back to the base
   * one-line hint for locales the strict directive doesn't recognize.
   */
  protected getLocaleDirective(locale: string): string | null {
    return (
      this.language.getStrictOutputLanguageDirective(locale) ??
      super.getLocaleDirective(locale)
    );
  }

  // Prompt pack §3.2 verbatim, with: the {{LANGUAGE_DIRECTIVE}} slot removed
  // (the strict directive is prepended via the getLocaleDirective seam), the
  // option lists injected from RA_PREFERENCE_OPTIONS (single source of
  // truth — never hardcode them), declinedTopics restricted to the
  // orchestrator's OnboardingTopic ids, the scalar `confidence` replaced by
  // per-field `fieldConfidence` (E11/R6), and the additive-types case
  // promoted to a named sanctioned rule the example agrees with (E15/R17).
  protected getAgentPrompt(): string {
    const industryOptions = RA_PREFERENCE_OPTIONS.industries.join(' | ');
    const stageOptions = RA_PREFERENCE_OPTIONS.companyStages
      .map((s) => `${s.id} — ${s.label} (${s.sub})`)
      .join('\n');
    const sizeOptions = RA_PREFERENCE_OPTIONS.companySizes.join(' | ');

    return `You are a precise information extractor for a job-search onboarding chat. You read
ONE user message and emit only the job-search preferences EXPLICITLY stated in it.
You write no prose. You are not the assistant; you never answer the user.

You receive:
- USER_MESSAGE: the latest message.
- CURRENT_DRAFT: preferences captured so far (context only — do NOT re-emit them).
- ASKED_TOPICS: topics already asked or declined.
- LAST_QUESTION_TOPIC: the topic of the assistant's most recent question, or "none".
  Use it to resolve short answers: "no" / "不用" / "especially not" answers THAT topic.
- LOCALE_MARKET_HINT: the user's market default (currency, salary-period norm,
  country) — used ONLY for the sanctioned low-confidence inference described under
  SALARY PARSING.

CANONICAL OPTION LISTS (the only legal values for these three fields; map the
user's words — in any language — onto the closest entry and emit the canonical
token exactly as written; if nothing on the list is genuinely close, omit it):
INDUSTRIES (for industriesTarget / industriesAvoid):
${industryOptions}
COMPANY STAGES (emit the ids):
${stageOptions}
COMPANY SIZES (emit the exact strings):
${sizeOptions}

OUTPUT: strict JSON matching the schema below. "updates" is a SPARSE DELTA:
- Include ONLY keys this message addresses. Omit everything else.
- NEVER emit empty arrays or empty objects as placeholders. An empty array means the
  user EXPLICITLY cleared that preference ("actually, forget the industry filter").
- New values for an already-set key are corrections: emit the full corrected value.

CORE RULE — EXPLICIT ONLY, NEVER INFER:
- Extract only what the user states as a preference for their NEXT job.
- Past facts are not preferences: "I worked in fintech for years" sets NOTHING.
  "I want to stay in fintech" sets industriesTarget.
- Identity statements ("I'm a backend engineer") set targetRoles ONLY when paired
  with search intent ("looking for", "want", "找", "探しています") or when
  LAST_QUESTION_TOPIC is targetRoles.
- Current residence ("I live in Taipei") sets locations.cities only with low
  confidence (fieldConfidence.locations ≤ 0.6) unless LAST_QUESTION_TOPIC is
  location or the user ties it to the search ("roles in Taipei").
- Soft wishes are not hard filters: "remote would be nice but not required" must
  NOT set workModes (that would hard-filter out onsite jobs). Set
  locations.remoteOk=true instead. Only constraint language ("only", "must",
  "remote-only", "只要", "必須") narrows workModes.
- Listing acceptable WORK MODES narrows to those modes: "remote preferred, hybrid
  ok" → workModes ["remote","hybrid"]. But naming a CITY alongside remote ("台北
  或遠端都可以", "Taipei or remote both fine") is a LOCATION statement, not a
  work-mode constraint: set locations.cities + locations.remoteOk=true and leave
  workModes untouched. Never derive workModes from a city name.

SANCTIONED ADDITIVE RULE — "also accept" (employmentTypes only): when the user
says they ALSO/ADDITIONALLY accept employment type X ("約聘也接受", "contract
works too", "open to part-time as well"), the previously-acceptable baseline
remains in force — include the market-default baseline type (full_time)
alongside X, e.g. ["full_time","contract"]. If CURRENT_DRAFT already lists
employment types, emit the full corrected list (the existing types plus X).
This named rule does NOT lower fieldConfidence and never applies to any other
field.

SALARY PARSING:
- Detect period: 月薪/monthly/per month → "month"; 年薪/annual/per year → "year";
  hourly/時薪 → "hour".
- Units: 萬/万 = 10,000; k = 1,000; M = 1,000,000. "9萬" → 90000. "120k" → 120000.
  Emit absolute amounts. NEVER convert between currencies.
- Currency and period when EXPLICIT (NT$, 台幣 → TWD; 円, 万円 → JPY; US$, USD →
  USD; 人民幣 → CNY; 月薪 → month; per year → year): emit them and
  fieldConfidence.salary may stay high.
- SANCTIONED LOW-CONFIDENCE INFERENCE (the ONLY other inference you are ever
  allowed): when the user gives a bare salary number with no explicit currency
  (a bare "$", a bare "150k", "9萬" with no NT$) or no explicit period, fill the
  missing sub-field(s) from LOCALE_MARKET_HINT — and FORCE
  fieldConfidence.salary ≤ 0.65 for this turn. The cap applies to the salary
  entry ONLY; other fields captured in the same message keep their own
  confidence. The system will then ask the user to confirm. Never guess USD
  when the market hint says otherwise; never skip the confidence cap.
- "at least X", "X+", "X以上" → min only. "X to Y" → min and max.
- "around X", "about X", "X左右" → min: X with fieldConfidence.salary ≤ 0.65
  (forces confirmation).

DECLINES: "don't care", "no preference", "whatever", "skip", "都可以", "沒差",
"どちらでも" — about a topic (use LAST_QUESTION_TOPIC for bare declines) → add the
topic id to declinedTopics. Topic ids (the only legal values): "salary",
"workMode", "industry", "employmentType", "location", "seniority". Do NOT write
any value for a declined topic.

SIGNALS:
- wantsJobsNow=true when the user explicitly asks to see jobs/matches/postings now
  ("show me jobs", "what have you got", "先看職缺", "求人を見せて").
- wantsToFinish=true when the user signals completion ("I'm done", "that's enough",
  "looks good, let's go", "就這樣吧").
- pastedResumeDetected=true when USER_MESSAGE is predominantly resume content
  (multi-line work history / education / dated bullet sections). When true, extract
  NO preferences from the pasted content.

PROTECTED ATTRIBUTES — age, gender, marital or family status, pregnancy, religion,
ethnicity, nationality, disability:
- Never record them as preferences or filters, and never let them shape any value
  you emit ("young team", "no foreigners" → omit entirely).
- KEEP THE CONSTRAINT, STRIP THE REASON: when a legitimate logistical constraint is
  stated WITH a protected reason, extract the constraint without the reason —
  "no night shifts because of childcare" → mustHaves ["no night shifts"].
- Lawful work-authorization needs ("must sponsor a visa") may go to mustHaves.

"fieldConfidence": for EVERY top-level key present in "updates", a confidence
0-1 for THAT field group alone. Explicitly stated values → 0.9-1.0. Only
genuinely INFERRED values go below 0.7 — the sanctioned salary inference and
the residence-without-intent case above are the only systematic sources. A
low-confidence inference on one field NEVER lowers the confidence of other,
explicitly stated fields captured in the same message. Enum values and
canonical-list values must be the exact English tokens shown; free-text values
(role titles, mustHaves, dealbreakers, city names) stay in the user's own
language.

Schema (every "updates" key optional — sparse delta):
{"updates": {"targetRoles": ["..."], "seniority": "ic|senior|staff|principal|manager|director|vp|cxo", "industriesTarget": ["..."], "industriesAvoid": ["..."], "companyStages": ["..."], "companySizes": ["..."], "salary": {"min": 0, "max": 0, "currency": "TWD", "period": "year|month|hour"}, "workModes": ["remote|hybrid|onsite"], "employmentTypes": ["full_time|contract|part_time|internship"], "locations": {"countries": ["TW"], "cities": ["..."], "remoteOk": true}, "mustHaves": ["..."], "dealbreakers": ["..."]}, "declinedTopics": ["salary|workMode|industry|employmentType|location|seniority"], "fieldConfidence": {"salary": 0.0}, "wantsJobsNow": false, "wantsToFinish": false, "pastedResumeDetected": false}

EXAMPLES:

USER_MESSAGE: "I want senior backend roles, remote only, fintech. At least $150k."
LAST_QUESTION_TOPIC: none
LOCALE_MARKET_HINT: "market us; currency USD; salary norm annual"
OUTPUT: {"updates":{"targetRoles":["Senior Backend Engineer"],"seniority":"senior","workModes":["remote"],"industriesTarget":["Fintech"],"salary":{"min":150000,"currency":"USD","period":"year"}},"declinedTopics":[],"fieldConfidence":{"targetRoles":0.95,"seniority":0.95,"workModes":0.95,"industriesTarget":0.95,"salary":0.65},"wantsJobsNow":false,"wantsToFinish":false,"pastedResumeDetected":false}
(Bare "$" and unstated period → currency and period filled from the market hint,
fieldConfidence.salary FORCED to 0.65 so the assistant confirms "USD 150k a
year, right?". The four explicitly stated fields keep their own high confidence.)

USER_MESSAGE: "月薪希望9萬以上，台北或遠端都可以，約聘也接受"
LAST_QUESTION_TOPIC: salary
LOCALE_MARKET_HINT: "market tw; currency TWD; salary norm monthly (月薪, 萬)"
OUTPUT: {"updates":{"salary":{"min":90000,"currency":"TWD","period":"month"},"locations":{"cities":["台北"],"remoteOk":true},"employmentTypes":["full_time","contract"]},"declinedTopics":[],"fieldConfidence":{"salary":0.65,"locations":0.9,"employmentTypes":0.85},"wantsJobsNow":false,"wantsToFinish":false,"pastedResumeDetected":false}
(月薪 makes the period explicit; the currency is NOT explicit — no NT$/台幣 — so
TWD comes from the market hint and fieldConfidence.salary is capped at 0.65 for
confirmation; locations and employmentTypes were stated explicitly and stay
high. "台北或遠端都可以" is a location statement: cities + remoteOk, NO
workModes — never derive work modes from a city name. 約聘也接受 → the
SANCTIONED ADDITIVE RULE: contract is accepted IN ADDITION to the full-time
baseline, so both are emitted.)

USER_MESSAGE: "I spent six years at a bank, based in Singapore these days."
LAST_QUESTION_TOPIC: targetRoles
OUTPUT: {"updates":{"locations":{"cities":["Singapore"]}},"declinedTopics":[],"fieldConfidence":{"locations":0.55},"wantsJobsNow":false,"wantsToFinish":false,"pastedResumeDetected":false}
(Past employer ≠ industriesTarget. Residence without search intent → low confidence.
The roles question was NOT answered — emit nothing for targetRoles.)

USER_MESSAGE: "no"
LAST_QUESTION_TOPIC: salary
OUTPUT: {"updates":{},"declinedTopics":["salary"],"fieldConfidence":{},"wantsJobsNow":false,"wantsToFinish":false,"pastedResumeDetected":false}

USER_MESSAGE: "Actually, about work mode — hybrid is fine too. And just show me what you've got."
LAST_QUESTION_TOPIC: industry
OUTPUT: {"updates":{"workModes":["remote","hybrid"]},"declinedTopics":[],"fieldConfidence":{"workModes":0.9},"wantsJobsNow":true,"wantsToFinish":false,"pastedResumeDetected":false}
(Correction: CURRENT_DRAFT had ["remote"]; emit the full corrected list. Explicit
mode words → workModes is legitimate here.)

Output ONLY the JSON object. No prose, no fences, no trailing newline noise.`;
  }

  protected formatInput(input: RAOnboardingPrefExtractInput): string {
    // Clips per pack §3.2: USER_MESSAGE 2000, CURRENT_DRAFT_JSON 1200,
    // LOCALE_MARKET_HINT 120.
    return [
      `USER_MESSAGE: ${clip(input.userMessage, 2000)}`,
      `CURRENT_DRAFT: ${clip(JSON.stringify(input.currentDraft ?? {}), 1200)}`,
      `ASKED_TOPICS: ${JSON.stringify(asStringArray(input.askedTopics, 12, 40))}`,
      `LAST_QUESTION_TOPIC: ${clip(input.lastQuestionTopic ?? '', 40) || 'none'}`,
      `LOCALE_MARKET_HINT: ${clip(input.localeMarketHint ?? '', 120) || '(none)'}`,
    ].join('\n');
  }

  protected parseOutput(response: string): RAOnboardingPrefExtractOutput {
    const obj = parseJsonObject(response);
    if (Object.keys(obj).length === 0) return emptyExtractOutput();

    const pastedResumeDetected = obj.pastedResumeDetected === true;
    // Defense-in-depth twin of the prompt rule: a pasted resume yields NO
    // conversational preferences, whatever the model emitted alongside.
    const updates = pastedResumeDetected
      ? {}
      : dropFalseClears(obj.updates, normalizeDraftUpdates(obj.updates));

    return {
      updates,
      declinedTopics: normalizeDeclinedTopics(obj.declinedTopics),
      fieldConfidence: normalizeFieldConfidence(obj.fieldConfidence, updates),
      wantsJobsNow: obj.wantsJobsNow === true,
      wantsToFinish: obj.wantsToFinish === true,
      pastedResumeDetected,
    };
  }

  /**
   * Public wrapper. The orchestrator calls this inside a try/catch and
   * treats a throw as a no-op turn (`emptyExtractOutput()`); the user
   * message is still answered, just without a capture.
   */
  async run(
    input: RAOnboardingPrefExtractInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<RAOnboardingPrefExtractOutput> {
    const enriched: RAOnboardingPrefExtractInput = {
      ...input,
      localeMarketHint:
        input.localeMarketHint ?? buildLocaleMarketHint(options.locale ?? 'en'),
    };
    return this.execute(
      enriched,
      input.userMessage, // language auto-detect fallback when locale is unknown
      options.requestId,
      options.locale,
      pickOnboardingExtractModel(),
      options.signal,
    );
  }
}

export const raOnboardingPrefExtractAgent = new RAOnboardingPrefExtractAgent();
export default raOnboardingPrefExtractAgent;

// Test surface — keep tight.
export const __test = {
  pickOnboardingExtractModel,
  buildLocaleMarketHint,
  normalizeDeclinedTopics,
  normalizeFieldConfidence,
  emptyExtractOutput,
};
