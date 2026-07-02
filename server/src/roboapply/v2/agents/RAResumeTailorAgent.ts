// backend/src/roboapply/v2/agents/RAResumeTailorAgent.ts
//
// RoboApply V2 Agent #3 — Tailor a base resume to a specific JD. Per
// docs/roboapply/v2/04-backend-spec.md §6 — Sonnet-tier for `standard`
// complexity, Opus-tier for `deep_rewrite` (Premium+ only).
//
// Contract (BE3 Wave 4):
//   Input  : { baseResumeMarkdown, jobTitle, jobDescription, parsedJD?,
//              complexity: 'standard' | 'deep_rewrite' }
//   Output : { tailoredResumeMarkdown, changeSummary,
//              citationsByLine: Record<lineIndex, citationSource> }
//
// Notes:
//   - Temperature 0.3 (low-creative — accuracy beats voice for resumes)
//   - Model: tiered, env-configurable. `standard` → Sonnet 4.6 default,
//     `deep_rewrite` → Opus 4.8 default (see raModels.ts). Override per tier
//     with RA_V2_RESUME_TAILOR_MODEL_STANDARD / RA_V2_RESUME_TAILOR_MODEL_DEEP.
//   - Max output 2000 tokens (full resume can be long)
//   - CitationGuard pattern from assessmentPipeline/CitationGuardAgent —
//     every quantitative claim in the tailored output must map back to
//     a line in the base resume. We capture `citationsByLine` from the
//     model and validate it locally (string-presence check) — no extra
//     LLM round-trip needed for V2.
//   - Quota: BE2's service writes `ra_resume_tailor` SKU on success.

import { BaseAgent } from '../../../agents/BaseAgent.js';
import { logger } from '../../../services/LoggerService.js';
import { RA_MODEL_OPUS, RA_MODEL_SONNET } from './raModels.js';

// ─── Public types ───────────────────────────────────────────────────────

export type RAResumeTailorComplexity = 'standard' | 'deep_rewrite';

export interface RAResumeTailorParsedJD {
  qualifications?: string;
  responsibilities?: string;
  benefits?: string;
  keywords?: string[];
}

export interface RAResumeTailorInput {
  baseResumeMarkdown: string;
  jobTitle: string;
  jobDescription: string;
  parsedJD?: RAResumeTailorParsedJD;
  complexity: RAResumeTailorComplexity;
}

/** Where a tailored line traces back to in the base resume. */
export interface RACitationSource {
  /** 0-based line index in `baseResumeMarkdown.split('\n')`. -1 means
   *  "structural / unchanged from base" (headings, blank lines, etc.). */
  sourceLineIndex: number;
  /** Optional verbatim copy of the base line for double-check. */
  sourceText?: string;
}

export interface RAResumeTailorOutput {
  /** The full tailored resume in markdown. */
  tailoredResumeMarkdown: string;
  /** Human-readable changelog: "Reworded bullet 2 of Stripe role to..."
   *  Up to ~200 words. */
  changeSummary: string;
  /** Per-tailored-line citations back into the base resume. Keys are the
   *  0-based line index in `tailoredResumeMarkdown.split('\n')`. */
  citationsByLine: Record<number, RACitationSource>;
  /** True if every line with a quantitative claim has a citation that
   *  string-matches the base resume. Soft-failure: false = caller may
   *  retry or fall back to base resume. */
  citationGuardPassed: boolean;
  /** Lines (by tailored index) that failed citation. Empty when
   *  citationGuardPassed = true. */
  citationGuardViolations: number[];
}

// Default model IDs per tier. Used when the corresponding env var is unset.
// Exported so BE2's service / tests can reference the defaults without
// reaching into the agent's internals.
export const RA_RESUME_TAILOR_MODEL_STANDARD = RA_MODEL_SONNET;
export const RA_RESUME_TAILOR_MODEL_DEEP = RA_MODEL_OPUS;

// Env var names that override the per-tier model at runtime.
const ENV_MODEL_STANDARD = 'RA_V2_RESUME_TAILOR_MODEL_STANDARD';
const ENV_MODEL_DEEP = 'RA_V2_RESUME_TAILOR_MODEL_DEEP';

// ─── Helpers ────────────────────────────────────────────────────────────

function clipString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

/** Lightweight detector for "quantitative claims" — numbers, percentages,
 *  dollar amounts, time ranges. Used by CitationGuard to decide which
 *  lines MUST have a base-resume citation. */
function lineHasQuantitativeClaim(line: string): boolean {
  if (!line || typeof line !== 'string') return false;
  // \d → "5 years", "30%", "$1M", "120ms", "200+ users"
  // Year ranges like "2019-2024", "Jan 2020 – Present" also trip the match.
  return /\d/.test(line);
}

/**
 * Resolve the model for a tailor complexity tier. Reads `process.env` at
 * CALL TIME (not module-load) so it picks up dotenv values regardless of ESM
 * import order — the backend's `dotenv.config()` runs after the agent module
 * is hoisted/evaluated, so a module-level `process.env` read would miss it.
 *   - `standard`     → RA_V2_RESUME_TAILOR_MODEL_STANDARD (default Sonnet 4.6)
 *   - `deep_rewrite` → RA_V2_RESUME_TAILOR_MODEL_DEEP      (default Opus 4.8)
 */
export function pickTailorModel(complexity: RAResumeTailorComplexity): string {
  if (complexity === 'deep_rewrite') {
    return process.env[ENV_MODEL_DEEP]?.trim() || RA_RESUME_TAILOR_MODEL_DEEP;
  }
  return process.env[ENV_MODEL_STANDARD]?.trim() || RA_RESUME_TAILOR_MODEL_STANDARD;
}

/**
 * Verify every quantitative claim in the tailored output traces back to
 * a line in the base resume. The check is intentionally lenient:
 *   - Lines without numbers are skipped (they can't fabricate metrics)
 *   - For lines WITH numbers, every digit-run in the tailored line MUST
 *     appear in the cited base line (verbatim substring) OR be a calendar
 *     year between 1990-2099 (years are safe to repeat).
 *
 * Returns the violation indices (empty when guard passes).
 */
export function runCitationGuard(
  baseResumeMarkdown: string,
  tailoredResumeMarkdown: string,
  citationsByLine: Record<number, RACitationSource>,
): { passed: boolean; violations: number[] } {
  const baseLines = baseResumeMarkdown.split('\n');
  const tailoredLines = tailoredResumeMarkdown.split('\n');
  const violations: number[] = [];

  for (let i = 0; i < tailoredLines.length; i++) {
    const tLine = tailoredLines[i];
    if (!lineHasQuantitativeClaim(tLine)) continue;

    const citation = citationsByLine[i];
    if (!citation || citation.sourceLineIndex === undefined) {
      violations.push(i);
      continue;
    }
    // -1 = structural; only allowed if the tailored line is itself
    // structural (no digits) — but we already gated on `lineHasQuantitativeClaim`
    // so structural citation for a digit-bearing line is a violation.
    if (citation.sourceLineIndex < 0) {
      violations.push(i);
      continue;
    }
    if (citation.sourceLineIndex >= baseLines.length) {
      violations.push(i);
      continue;
    }
    const sourceLine = baseLines[citation.sourceLineIndex];

    // Extract digit runs from the tailored line. Each must appear in
    // the source line (verbatim substring) OR be a plausible year.
    const digitRuns = tLine.match(/\d+(?:[.,]\d+)?/g) ?? [];
    let allOk = true;
    for (const run of digitRuns) {
      const plain = run.replace(/[.,]/g, '');
      const asNum = Number(plain);
      const isYear = Number.isFinite(asNum) && asNum >= 1990 && asNum <= 2099;
      if (isYear) continue;
      if (!sourceLine.includes(run)) {
        allOk = false;
        break;
      }
    }
    if (!allOk) violations.push(i);
  }

  return { passed: violations.length === 0, violations };
}

// ─── Agent ──────────────────────────────────────────────────────────────

export class RAResumeTailorAgent extends BaseAgent<
  RAResumeTailorInput,
  RAResumeTailorOutput
> {
  constructor() {
    super('RAResumeTailorAgent');
  }

  protected getTemperature(): number {
    return 0.3;
  }

  protected getMaxTokens(): number | undefined {
    return 2000;
  }

  protected getAgentPrompt(): string {
    return `You are RoboApply's senior resume tailor. Take a candidate's base resume and rewrite it to win the listed JD.

## Hard rules — these are absolute

1. **Never invent skills, employers, dates, or numbers.** Every quantitative claim ("led 5-person team", "cut latency 30%", "shipped in 2023") in the tailored output MUST appear verbatim in the base resume. Numbers cannot drift. Dates cannot drift. Employer names cannot drift.

2. **What you CAN change:**
   - Reorder bullets within a role
   - Rewrite framing / verb choice / emphasis
   - Surface JD keywords that the candidate already demonstrates
   - Drop bullets that don't help the application
   - Tighten the summary line
   - Add a tailored objective if the base has none

3. **What you CANNOT change:**
   - Job titles (use the candidate's actual title)
   - Employer names / dates / role durations
   - Concrete numbers (team size, latency, revenue, etc.)
   - Education / certifications
   - Adding skills the candidate doesn't have

4. **Citation table.** For every line in the tailored resume that contains a NUMBER, emit one entry in \`citationsByLine\` mapping the tailored line's 0-based index → the base resume's source line index. Use \`sourceLineIndex: -1\` for purely structural lines (headings, blank, etc.) — but lines with digits MUST cite a real source line.

5. **Change summary.** ≤ 200 words. Bullet list of what you changed and why. E.g. "Reordered Stripe bullets to lead with payments work (matches JD)". "Cut sentence about Jira admin work (not relevant)".

## Output schema (STRICT JSON, no prose around it, no code fences)

{
  "tailoredResumeMarkdown": "string — the full tailored resume, markdown",
  "changeSummary": "string — bullet list, ≤200 words",
  "citationsByLine": {
    "0": { "sourceLineIndex": 0, "sourceText": "verbatim base line" },
    "5": { "sourceLineIndex": 12, "sourceText": "verbatim base line" }
  }
}

Output ONLY the JSON object.`;
  }

  protected formatInput(input: RAResumeTailorInput): string {
    const parts: string[] = [];
    parts.push(`Complexity: ${input.complexity}`);
    parts.push(`## Target job\nTitle: ${clipString(input.jobTitle, 240)}\n\nDescription:\n${clipString(input.jobDescription, 6_000)}`);
    if (input.parsedJD) {
      const pj = input.parsedJD;
      const blocks: string[] = [];
      if (pj.qualifications) blocks.push(`Qualifications:\n${clipString(pj.qualifications, 2_500)}`);
      if (pj.responsibilities) blocks.push(`Responsibilities:\n${clipString(pj.responsibilities, 2_500)}`);
      if (Array.isArray(pj.keywords) && pj.keywords.length > 0) {
        blocks.push(`Keywords to address:\n${pj.keywords.slice(0, 30).map((k) => `- ${clipString(k, 80)}`).join('\n')}`);
      }
      if (blocks.length > 0) parts.push(`## Parsed JD signals\n${blocks.join('\n\n')}`);
    }
    // Number the base resume so the model can cite by line index.
    const baseNumbered = clipString(input.baseResumeMarkdown, 12_000)
      .split('\n')
      .map((line, idx) => `${idx}\t${line}`)
      .join('\n');
    parts.push(`## Base resume (NUMBERED — cite these line indices in citationsByLine)\n${baseNumbered}`);
    parts.push('Tailor this resume for this job. Output ONLY the JSON object.');
    return parts.join('\n\n');
  }

  protected parseOutput(response: string): RAResumeTailorOutput {
    const fallback: RAResumeTailorOutput = {
      tailoredResumeMarkdown: '',
      changeSummary: '',
      citationsByLine: {},
      citationGuardPassed: false,
      citationGuardViolations: [],
    };
    if (!response || typeof response !== 'string') return fallback;

    const cleaned = response.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');

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
      return fallback;
    }

    const tailoredResumeMarkdown = clipString(parsed.tailoredResumeMarkdown, 16_000);
    const changeSummary = clipString(parsed.changeSummary, 1_500);

    const citationsByLine: Record<number, RACitationSource> = {};
    const rawCitations = parsed.citationsByLine;
    if (rawCitations && typeof rawCitations === 'object' && !Array.isArray(rawCitations)) {
      for (const [k, v] of Object.entries(rawCitations as Record<string, unknown>)) {
        const lineIdx = Number(k);
        if (!Number.isFinite(lineIdx) || lineIdx < 0) continue;
        if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
        const vv = v as Record<string, unknown>;
        const src = Number(vv.sourceLineIndex);
        if (!Number.isFinite(src)) continue;
        const entry: RACitationSource = { sourceLineIndex: Math.trunc(src) };
        const sourceText = clipString(vv.sourceText, 600);
        if (sourceText) entry.sourceText = sourceText;
        citationsByLine[lineIdx] = entry;
      }
    }

    return {
      tailoredResumeMarkdown,
      changeSummary,
      citationsByLine,
      citationGuardPassed: false,
      citationGuardViolations: [],
    };
  }

  /**
   * Public convenience wrapper. Picks the model from `input.complexity`,
   * runs the LLM, then applies CitationGuard against the base resume.
   * Failures throw — caller does NOT debit on throw.
   *
   * On CitationGuard violations the agent returns a successful output
   * with `citationGuardPassed: false` and `citationGuardViolations`
   * populated. BE2's service may retry with a stricter prompt or fall
   * back to the base resume on its own discretion; in both cases the
   * SKU should still be debited because the LLM call did succeed.
   */
  async run(
    input: RAResumeTailorInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<RAResumeTailorOutput> {
    const model = pickTailorModel(input.complexity);
    const result = await this.execute(
      input,
      input.jobDescription,
      options.requestId,
      options.locale,
      model,
      options.signal,
    );

    // Apply CitationGuard string-presence check.
    const guard = runCitationGuard(
      input.baseResumeMarkdown,
      result.tailoredResumeMarkdown,
      result.citationsByLine,
    );
    result.citationGuardPassed = guard.passed;
    result.citationGuardViolations = guard.violations;

    if (!guard.passed) {
      logger.warn(
        'AGENT',
        'RAResumeTailorAgent: citation-guard found unsupported numeric claims',
        {
          model,
          violationCount: guard.violations.length,
          violationLines: guard.violations.slice(0, 10),
        },
        options.requestId,
      );
    }

    return result;
  }
}

export const raResumeTailorAgent = new RAResumeTailorAgent();
export default raResumeTailorAgent;

export const __test = {
  pickTailorModel,
  runCitationGuard,
  lineHasQuantitativeClaim,
};
