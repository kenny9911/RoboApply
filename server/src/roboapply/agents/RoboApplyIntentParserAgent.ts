// backend/src/roboapply/agents/RoboApplyIntentParserAgent.ts
//
// Agent #1 in docs/roboapply/02-architecture.md §2 — turns prose intent
// (the textarea in /onboarding step 2) into the structured
// `RoboApplyParsedIntent` shape consumed by the daily matcher + digest.
//
// Single LLM call, Sonnet 4.6, temperature 0.1. Cached by sha256(intentText
// + locale) — see backend/src/roboapply/lib/cacheKey.ts. Mission-edit bumps
// `intentVersion` which invalidates downstream cover-letter cache, but does
// NOT invalidate this row because the intentText + locale pair is the only
// thing that changes.
//
// Hard rules enforced in the prompt:
//   1. Strict JSON only — no prose, no markdown, no leading explanation.
//   2. Never invent constraints. Missing values are null, not false.
//   3. bestEffortFields[] for ambiguous parts.
//   4. Resolve seniority against the resume summary when present.
//
// Quota: writes one UsageDeductionLog row with sku='roboapply_intent' on
// successful parse. Failures (LLM error, parse error) cost zero.

import { BaseAgent } from '../../agents/BaseAgent.js';
import type { DeductionSku, DeductionSource } from '../../lib/matchBilling.js';
import { writeDeductionLog } from '../../lib/matchBilling.js';
import { costPatchFromTally } from '../../lib/deductionCost.js';

// ─── Public types ───────────────────────────────────────────────────────

export type RoboApplyLocale =
  | 'en'
  | 'zh'
  | 'zh-TW'
  | 'ja'
  | 'es'
  | 'fr'
  | 'pt'
  | 'de';

export interface RoboApplyIntentParserInput {
  intentText: string;          // 20–2000 chars, free-form
  resumeSummary?: string;       // optional — helps disambiguate seniority
  locale: RoboApplyLocale;
}

export type CompanyStage =
  | 'pre_seed'
  | 'seed'
  | 'series_a'
  | 'series_b_to_d'
  | 'series_e_plus'
  | 'public';

export type SeniorityLevel =
  | 'ic'
  | 'senior'
  | 'staff'
  | 'principal'
  | 'manager'
  | 'director'
  | 'vp'
  | 'cxo'
  | null;

export interface RoboApplyParsedIntent {
  roles: string[];
  seniority: SeniorityLevel;
  industries: string[];
  companyStages: CompanyStage[];
  excludeCompanies: string[];
  locations: {
    countries: string[];
    cities: string[];
    remoteOk: boolean | null;
    hybridOk: boolean | null;
  };
  compensation: {
    baseFloor: number | null;
    currency: string | null;
    equityImportant: boolean;
  };
  hardExclusions: string[];
  softPreferences: string[];
  confidence: 'high' | 'medium' | 'low';
  bestEffortFields: string[];
}

// ─── Errors ─────────────────────────────────────────────────────────────

export type RoboApplyIntentParseErrorCode =
  | 'parse_failed'
  | 'llm_error'
  | 'empty_intent';

export class RoboApplyIntentParseError extends Error {
  constructor(
    public readonly code: RoboApplyIntentParseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoboApplyIntentParseError';
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function clipString(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  return s.trim().slice(0, max);
}

function sanitizeStringArray(value: unknown, maxLen: number, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, maxLen));
    if (out.length >= maxItems) break;
  }
  return out;
}

function sanitizeCompanyStages(value: unknown): CompanyStage[] {
  if (!Array.isArray(value)) return [];
  const allowed: ReadonlyArray<CompanyStage> = [
    'pre_seed',
    'seed',
    'series_a',
    'series_b_to_d',
    'series_e_plus',
    'public',
  ];
  const set = new Set<CompanyStage>();
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const lower = v.trim().toLowerCase().replace(/[-\s]+/g, '_') as CompanyStage;
    if (allowed.includes(lower)) set.add(lower);
  }
  return Array.from(set);
}

function sanitizeSeniority(value: unknown): SeniorityLevel {
  if (typeof value !== 'string') return null;
  const allowed: ReadonlyArray<Exclude<SeniorityLevel, null>> = [
    'ic',
    'senior',
    'staff',
    'principal',
    'manager',
    'director',
    'vp',
    'cxo',
  ];
  const lower = value.trim().toLowerCase() as Exclude<SeniorityLevel, null>;
  return allowed.includes(lower) ? lower : null;
}

const DEFAULT_OUTPUT: RoboApplyParsedIntent = {
  roles: [],
  seniority: null,
  industries: [],
  companyStages: [],
  excludeCompanies: [],
  locations: { countries: [], cities: [], remoteOk: null, hybridOk: null },
  compensation: { baseFloor: null, currency: null, equityImportant: false },
  hardExclusions: [],
  softPreferences: [],
  confidence: 'low',
  bestEffortFields: ['Could not parse intent — falling back to keyword extraction'],
};

// ─── Agent ──────────────────────────────────────────────────────────────

export class RoboApplyIntentParserAgent extends BaseAgent<
  RoboApplyIntentParserInput,
  RoboApplyParsedIntent
> {
  constructor() {
    super('RoboApplyIntentParserAgent');
  }

  protected getTemperature(): number {
    return 0.1; // Scoring-style determinism — same intent should always parse the same.
  }

  protected getMaxTokens(): number | undefined {
    return 2000;
  }

  protected getAgentPrompt(): string {
    return `You are RoboApply's intent parser. The user has just told you, in their own words, what kind of job they want. Your job is to turn that prose into ONE strict JSON object matching the RoboApplyParsedIntent schema below — no prose, no markdown, no commentary, no leading apology.

## Hard rules — these are absolute

1. **Output strict JSON.** No \`\`\`json fences, no preface, no trailing notes. The first character of your response is \`{\` and the last is \`}\`.
2. **Never invent constraints the user did not state.** If the user did not say "remote", \`locations.remoteOk = null\`, NOT \`false\`. Null means "no preference"; the matcher treats null and true as both allowed.
3. **Populate \`bestEffortFields[]\` for ambiguous parts.** Example: "growth-stage companies" → \`companyStages: ['series_b_to_d']\` AND \`bestEffortFields: ['companyStages: inferred "growth-stage" as Series B–D']\`. The digest narrates these back to the user.
4. **Resolve seniority against the resume summary when present.** "Senior" with 4 YoE → \`seniority: 'senior'\`. "Senior" with 12 YoE → \`seniority: 'staff'\` (one rung up because the user undersold). When no resume summary, infer from the role string and use 'medium' confidence.
5. **Geography.** If user says "NYC or remote", \`cities: ['New York']\`, \`remoteOk: true\`, \`hybridOk: true\` (remote-ok always implies hybrid-ok). If they say "fully remote, no office", \`remoteOk: true\`, \`hybridOk: false\`.
6. **Compensation.** Parse "$200k+" as \`baseFloor: 200000\`, \`currency: 'USD'\`. If they don't name a currency, infer from the figure shape (¥ = JPY, € = EUR, etc.). If only equity matters, set \`equityImportant: true\` even with no baseFloor.
7. **Exclusions.** "No FAANG", "no big banks", "not Meta or Amazon" → keep the LITERAL token in \`excludeCompanies\` (lowercase) and emit a \`bestEffortFields\` note explaining how the matcher should interpret it. The matcher does fuzzy company-name matching downstream.
8. **Soft preferences.** Anything the user said that's a desirable signal but not a hard requirement ("founder-led", "small team", "shipping fast") goes into \`softPreferences\` as free-form sentences.
9. **Confidence rubric.** \`high\` = user gave concrete roles + at least one of (industry / location / comp). \`medium\` = user gave a role but otherwise vague. \`low\` = user said something like "any senior eng role".

## Output schema

\`\`\`
{
  "roles":            ["Senior PM", "Lead PM"],
  "seniority":        "ic"|"senior"|"staff"|"principal"|"manager"|"director"|"vp"|"cxo"|null,
  "industries":       ["fintech", "AI"],
  "companyStages":    ["series_b_to_d"],
  "excludeCompanies": ["meta", "amazon"],
  "locations": {
    "countries":  ["United States"],
    "cities":     ["New York"],
    "remoteOk":   true|false|null,
    "hybridOk":   true|false|null
  },
  "compensation": {
    "baseFloor":         220000,
    "currency":          "USD",
    "equityImportant":   false
  },
  "hardExclusions":   ["no on-call"],
  "softPreferences":  ["founder-led teams"],
  "confidence":       "high"|"medium"|"low",
  "bestEffortFields": ["companyStages: inferred ..."]
}
\`\`\`

## Locale

Inputs may be in any of: en, zh, zh-TW, ja, es, fr, pt, de. Always output the JSON in canonical English keys (the schema above), but you MAY transliterate user-named cities and industries to the user's locale where the matcher can match either form. Roles are best kept in canonical English ("Senior PM" not "シニアPM").

You output ONLY the JSON object.`;
  }

  protected formatInput(input: RoboApplyIntentParserInput): string {
    const blocks: string[] = [];
    blocks.push(`Locale: ${input.locale}`);
    blocks.push(`## Intent (user's own words)\n${input.intentText.slice(0, 4_000)}`);
    if (input.resumeSummary && input.resumeSummary.trim().length > 0) {
      blocks.push(`## Resume summary (for seniority disambiguation)\n${input.resumeSummary.slice(0, 2_000)}`);
    } else {
      blocks.push(`## Resume summary\n(none provided — infer seniority from role string)`);
    }
    blocks.push(`Parse this intent into the JSON schema. Output ONLY the JSON.`);
    return blocks.join('\n\n');
  }

  protected parseOutput(response: string): RoboApplyParsedIntent {
    if (!response || typeof response !== 'string') return DEFAULT_OUTPUT;
    const cleaned = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          parsed = null;
        }
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return DEFAULT_OUTPUT;
    }

    const locationsRaw = (parsed.locations ?? {}) as Record<string, unknown>;
    const compensationRaw = (parsed.compensation ?? {}) as Record<string, unknown>;

    return {
      roles: sanitizeStringArray(parsed.roles, 100, 6),
      seniority: sanitizeSeniority(parsed.seniority),
      industries: sanitizeStringArray(parsed.industries, 80, 8),
      companyStages: sanitizeCompanyStages(parsed.companyStages),
      excludeCompanies: sanitizeStringArray(parsed.excludeCompanies, 100, 30).map((s) => s.toLowerCase()),
      locations: {
        countries: sanitizeStringArray(locationsRaw.countries, 80, 10),
        cities: sanitizeStringArray(locationsRaw.cities, 80, 10),
        remoteOk:
          typeof locationsRaw.remoteOk === 'boolean'
            ? locationsRaw.remoteOk
            : null,
        hybridOk:
          typeof locationsRaw.hybridOk === 'boolean'
            ? locationsRaw.hybridOk
            : null,
      },
      compensation: {
        baseFloor:
          typeof compensationRaw.baseFloor === 'number' && Number.isFinite(compensationRaw.baseFloor)
            ? Math.max(0, Math.floor(compensationRaw.baseFloor))
            : null,
        currency: clipString(compensationRaw.currency, 8) || null,
        equityImportant: compensationRaw.equityImportant === true,
      },
      hardExclusions: sanitizeStringArray(parsed.hardExclusions, 200, 12),
      softPreferences: sanitizeStringArray(parsed.softPreferences, 200, 12),
      confidence:
        parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
          ? (parsed.confidence as 'high' | 'medium' | 'low')
          : 'medium',
      bestEffortFields: sanitizeStringArray(parsed.bestEffortFields, 200, 12),
    };
  }

  /**
   * Parse an intent string. Returns the structured form on success. Failures
   * throw RoboApplyIntentParseError; the caller does NOT bill the credit.
   *
   * On success, writes one `roboapply_intent` audit row (no quota gate —
   * intent parsing is cheap and infrequent; see arch §9).
   */
  async parse(
    input: RoboApplyIntentParserInput,
    ctx: {
      userId: string;
      requestId?: string | null;
      missionId?: string | null;
    },
  ): Promise<RoboApplyParsedIntent> {
    if (!input.intentText || input.intentText.trim().length < 5) {
      throw new RoboApplyIntentParseError('empty_intent', 'Intent text is empty or too short');
    }

    let output: RoboApplyParsedIntent;
    try {
      output = await this.execute(input, input.intentText, ctx.requestId ?? undefined, input.locale);
    } catch (err) {
      throw new RoboApplyIntentParseError(
        'llm_error',
        err instanceof Error ? err.message : 'Intent parser LLM call failed',
      );
    }

    // Success path. Write the audit row (best-effort; failure doesn't
    // unwind the parse).
    const sku: DeductionSku = 'roboapply_intent';
    const source: DeductionSource = 'plan';
    const cost = costPatchFromTally(ctx.requestId);
    await writeDeductionLog({
      userId: ctx.userId,
      sku,
      source,
      platformCostUsd: cost.platformCostUsd,
      tierAtCommit: null,
      requestId: ctx.requestId ?? null,
      relatedEntityType: 'roboapply_mission',
      relatedEntityId: ctx.missionId ?? null,
      metadata: {
        ...cost.metadata,
        source: 'roboapply.intent_parse',
        locale: input.locale,
        intentTextLength: input.intentText.length,
        confidence: output.confidence,
      },
    });

    return output;
  }
}

export const roboApplyIntentParserAgent = new RoboApplyIntentParserAgent();
export default roboApplyIntentParserAgent;
