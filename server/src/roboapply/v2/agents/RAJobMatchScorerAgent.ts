// backend/src/roboapply/v2/agents/RAJobMatchScorerAgent.ts
//
// RoboApply V2 Agent #1 — Score a (resume, job) pair for the Job Detail
// match-score card. Per docs/roboapply/v2/04-backend-spec.md §6, this is
// the Sonnet-tier scoring agent that backs the `RAJobMatchScore` cache.
//
// Contract (BE3 Wave 4):
//   Input  : { resumeMarkdown, jobTitle, jobDescription, jobQualifications, jobBenefits? }
//   Output : { score 0-100, summary, strengths[], gaps[], keywordsMatched[], keywordsMissing[] }
//
// Notes:
//   - Temperature 0.1 (scoring → determinism, per project convention)
//   - Model: Sonnet 4.6 (via LLMService model override; provider routing
//     is the LLMService's job — we just emit the model name)
//   - Max output ~600 tokens (cap kept small; structured output is short)
//   - No CitationGuard: pure scoring; no fabricated narrative to verify
//   - Quota: BE2's service writes the `ra_job_match_score` SKU after
//     this agent's `.run()` returns successfully (failure costs zero)
//   - Prompt v2.1 (onboarding-chat prompt pack §5): live band boundaries
//     kept VERBATIM (cached rows stay calibration-consistent), plus explicit
//     dimension weights, second-person address, gaps-as-observations, and a
//     summary that no longer states the numeric score (the score lives on
//     the card; restating it third-person was the R11 root cause)
//   - getLocaleDirective override (E12b): the strict enum-safe directive
//     makes summary/strengths/gaps follow the user's UI locale. This
//     intentionally changes the output language of every caller —
//     POST /jobs/:id/score and the raScoreRefresh scheduler included —
//     whenever a locale is threaded into run()

import { BaseAgent } from '../../../agents/BaseAgent.js';
import { RA_MODEL_SONNET } from './raModels.js';

// ─── Public types ───────────────────────────────────────────────────────

export interface RAJobMatchScorerInput {
  resumeMarkdown: string;
  jobTitle: string;
  jobDescription: string;
  jobQualifications: string;
  /** Optional — benefits text adds signal for fit calculation. */
  jobBenefits?: string;
}

export interface RAJobMatchScorerOutput {
  /** 0-100 overall match. Integer. */
  score: number;
  /** One-sentence rationale summarising the score. */
  summary: string;
  /** Up to 5 candidate strengths relative to the JD. */
  strengths: string[];
  /** Up to 5 gaps / weaknesses relative to the JD. */
  gaps: string[];
  /** Keywords from the JD that the resume covers. */
  keywordsMatched: string[];
  /** Keywords required by the JD that the resume lacks. */
  keywordsMissing: string[];
}

// Default model. Used when the env override below is unset. Exported so
// BE2's scheduler / on-demand route / tests can reference the default
// without reaching into the agent's internals.
export const RA_JOB_MATCH_SCORER_MODEL = RA_MODEL_SONNET;

// Env var that overrides the model at runtime.
const ENV_MODEL = 'RA_V2_JOB_MATCH_SCORER_MODEL';

/**
 * Resolve the job-match-scorer model. Reads `process.env` at CALL TIME (not
 * module-load) so it picks up dotenv values regardless of ESM import order —
 * the backend's `dotenv.config()` runs after this module is hoisted, so a
 * module-level read would miss the override. Falls back to the default above.
 */
export function pickJobMatchScorerModel(): string {
  return process.env[ENV_MODEL]?.trim() || RA_JOB_MATCH_SCORER_MODEL;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function clipString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function clampScore(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
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

// ─── Agent ──────────────────────────────────────────────────────────────

export class RAJobMatchScorerAgent extends BaseAgent<
  RAJobMatchScorerInput,
  RAJobMatchScorerOutput
> {
  constructor() {
    super('RAJobMatchScorerAgent');
  }

  protected getTemperature(): number {
    // Scoring → deterministic. Mirrors ResumeMatchAgent / SkillMatchAgent.
    return 0.1;
  }

  protected getMaxTokens(): number | undefined {
    // 1500, NOT 600. The old 600 cap was English-centric: a full score JSON
    // (summary + up to 5 strengths + 5 gaps + up to 20 keywords) in a
    // token-dense language like Chinese overruns 600 completion tokens, so the
    // response was truncated mid-JSON → parseOutput threw "unparseable scorer
    // response" on every CJK pair (completion pinned at exactly 600). 1500
    // gives comfortable headroom for the full structured output in any
    // supported locale. Keep ≥ 1200 (guarded by a unit test).
    return 1500;
  }

  /**
   * E12b — strict enum-safe output-language directive: the user's selected UI
   * locale wins over any in-body language tendency, so summary/strengths/gaps
   * arrive in-locale (onboarding whyMatched cards, the job-detail score
   * panel). Keywords stay verbatim per rules 4/6; falls back to the base
   * one-line hint (and ultimately auto-detection) for unrecognized locales.
   */
  protected getLocaleDirective(locale: string): string | null {
    return (
      this.language.getStrictOutputLanguageDirective(locale) ??
      super.getLocaleDirective(locale)
    );
  }

  // Prompt v2.1 — pack §5.2 verbatim minus the {{LANGUAGE_DIRECTIVE}} slot
  // (BaseAgent.buildSystemPrompt prepends the real directive). Band
  // boundaries are the live values, unchanged.
  protected getAgentPrompt(): string {
    return `You are RoboApply's match scorer — an experienced recruiter scoring how well ONE
candidate's resume fits ONE job description. Your summary, strengths, and gaps are
shown to the candidate as the reason this job was recommended, so every claim must
be defensible from the two texts you were given. Write summary, strengths, and gaps
in SECOND PERSON, addressed to the candidate ("your payments experience", never
"the candidate").

## Hard rules

1. **Calibrate the score.** 0-100 integer, as a weighted judgment:
   - 35% ROLE & SENIORITY: does the job's title/scope match your read of the
     candidate's level and discipline? Penalize both directions — a senior engineer
     against a junior posting is NOT a good match, and neither is a 3-year
     mid-level against a director role.
   - 30% SKILLS & STACK: the job's REQUIRED skills evidenced in the resume,
     weighted toward the most recent 2-3 years. Nice-to-have skills count half.
     Absence of evidence is a gap, not a guess.
   - 15% DOMAIN: direct industry/domain experience beats adjacent; adjacent beats
     unrelated. Name the transfer logic when crediting adjacency (e.g. payments →
     exchanges), never silently credit it.
   - 10% LOGISTICS: the job's stated location/work-mode versus the resume's
     location signals. Judge only facts stated in the job and resume.
   - 10% TRAJECTORY: does the career arc point toward this role, and is the
     achievement scope proportional to the job's scope?

   Bands:
   - 90+ → exceptional fit; resume directly demonstrates every "must-have"
     (rare — do not give these casually)
   - 75-89 → strong fit; meets most requirements with room to grow
   - 60-74 → reasonable fit; gaps are real but bridgeable — your summary MUST name
     both the real overlap and the material gap
   - 40-59 → mixed fit; significant gaps
   - 0-39 → poor fit; missing core requirements
   Most honest shortlists center in the 60-85 range. Never inflate a score to be
   encouraging; an honest 58 protects the candidate's time better than a
   flattering 70.

2. **Never invent skills.** Only count skills/experience that the resume actually
   mentions. If the JD asks for K8s and the resume has no K8s, that's a gap — do
   NOT claim it as a strength. Never mention salary, benefits, culture, or
   work-mode facts the job text does not state.

3. **Strengths / gaps cap.** Max 5 each. Be specific — name the actual skill,
   tool, or experience, ideally as an evidence pairing ("your 5 yrs of Go services
   against the JD's Kubernetes requirement"). Avoid generic "good communicator"
   filler. Phrase gaps as OBSERVATIONS about the resume ("no Kubernetes experience
   shown"), never verdicts about the person ("you lack the skills"). An 85+ match
   may have one gap or none — never pad.

4. **Keywords.** Pull concrete terms from the JD (skills, tools, domains,
   certifications). \`keywordsMatched\` = JD term that appears in the resume.
   \`keywordsMissing\` = JD term that the resume lacks. Cap each list at 10. Keep
   keywords verbatim in the job posting's original language.

5. **Summary.** 1-2 sentences (≤ 45 words), candidate-facing and self-contained.
   Lead with the strongest CONCRETE overlap (a named skill, domain, or seniority
   signal present in BOTH texts). For 60-74 scores use worth-a-look framing: real
   strength first, then the gap plainly ("Strong payments-domain fit and your Go
   experience matches, though this JD centers on Java — worth a look if you're
   open to switching stacks."). Do NOT state the numeric score in the summary —
   the score field carries it.

6. **Language.** summary/strengths/gaps follow the language directive above;
   keywords stay as written in the job posting.

## Output schema (STRICT JSON, no prose around it, no code fences)

{
  "score": 0..100,
  "summary": "1-2 sentences, second person, no numeric score.",
  "strengths": ["...", "..."],
  "gaps": ["...", "..."],
  "keywordsMatched": ["python", "fastapi", "..."],
  "keywordsMissing": ["kubernetes", "..."]
}

Output ONLY the JSON object. No prose, no fences, no trailing newline noise.`;
  }

  protected formatInput(input: RAJobMatchScorerInput): string {
    const parts: string[] = [];
    parts.push(`## Job\nTitle: ${clipString(input.jobTitle, 500)}\n\nDescription:\n${clipString(input.jobDescription, 6_000)}`);
    parts.push(`## Qualifications\n${clipString(input.jobQualifications, 3_000)}`);
    if (input.jobBenefits && input.jobBenefits.trim()) {
      parts.push(`## Benefits\n${clipString(input.jobBenefits, 1_500)}`);
    }
    parts.push(`## Candidate resume\n${clipString(input.resumeMarkdown, 8_000)}`);
    parts.push('Score this resume against this job. Output ONLY the JSON object.');
    return parts.join('\n\n');
  }

  protected parseOutput(response: string): RAJobMatchScorerOutput {
    // Malformed output THROWS (never a score-0 fallback) — a zero fallback
    // would be persisted as a permanent cache row AND billed. Every caller
    // (scoreRows, raScoreRefresh, the /jobs/:id/score route) try/catches
    // around run() and skips the pair on throw, costing the user nothing.
    if (!response || typeof response !== 'string') {
      throw new Error('RAJobMatchScorerAgent: unparseable scorer response');
    }

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
      throw new Error('RAJobMatchScorerAgent: unparseable scorer response');
    }
    if (!Number.isFinite(parsed.score)) {
      throw new Error('RAJobMatchScorerAgent: unparseable scorer response');
    }

    return {
      score: clampScore(parsed.score),
      summary: clipString(parsed.summary, 400),
      strengths: sanitizeStringArray(parsed.strengths, 240, 5),
      gaps: sanitizeStringArray(parsed.gaps, 240, 5),
      keywordsMatched: sanitizeStringArray(parsed.keywordsMatched, 80, 10),
      keywordsMissing: sanitizeStringArray(parsed.keywordsMissing, 80, 10),
    };
  }

  /**
   * Public convenience wrapper. BE2's service will call `.run()` (with
   * the model pinned to Sonnet) and apply quota / cache write semantics
   * around it. Failures throw — caller does NOT debit on throw.
   */
  async run(
    input: RAJobMatchScorerInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<RAJobMatchScorerOutput> {
    return this.execute(
      input,
      input.jobDescription,
      options.requestId,
      options.locale,
      pickJobMatchScorerModel(),
      options.signal,
    );
  }
}

export const raJobMatchScorerAgent = new RAJobMatchScorerAgent();
export default raJobMatchScorerAgent;

// Test surface — keep tight.
export const __test = {
  pickJobMatchScorerModel,
  clampScore,
  sanitizeStringArray,
  clipString,
};
