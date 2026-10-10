// backend/src/roboapply/v2/agents/RAJobMatchScorerAgent.ts
//
// RoboApply V2 Agent #1 — Score a (resume, job) pair for the Job Detail
// match-score card.
//
// WP-18: the fit score now runs on scorer v3 (`RAJobMatchScorerV3Agent`,
// below; four judged components + quoted evidence, the server sums the
// total) through server/src/features/match. This v2 class is kept only for
// its existing callers (RACrossBankSearchService, RAResumeAIService.tailorDiff);
// new code must not call it. Per docs/roboapply/v2/04-backend-spec.md §6, this is
// the configured scoring agent that backs the `RAJobMatchScore` cache.
//
// Contract (BE3 Wave 4):
//   Input  : { resumeMarkdown, jobTitle, jobDescription, jobQualifications, jobBenefits? }
//   Output : { score 0-100, summary, strengths[], gaps[], keywordsMatched[], keywordsMissing[] }
//
// Notes:
//   - Temperature 0.1 (scoring → determinism, per project convention)
//   - Model: LLM_MATCHING_MODEL when configured, otherwise the LLM stack default
//     (via LLMService model override; provider routing is the LLMService's job)
//   - Max output 1500 tokens (CJK-safe structured-output headroom)
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
//     intentionally changes the output language of every caller whenever a
//     locale is threaded into run(). Callers today: the cross-bank search
//     (RACrossBankSearchService) and the tailor diff's re-score
//     (RAResumeAIService). The legacy POST /v2/jobs/:id/score route that
//     also called it was deleted in INT-13; the product's fit scoring is
//     features/match (scorer v3), not this agent.

import { BaseAgent } from '../../../agents/BaseAgent.js';
import {
  getTaskModel,
  getTaskReasoningEffort,
} from '../../../lib/llm/llmTaskSettings.js';
import { getDefaultModel } from '../../../lib/llm/llmModels.js';
import { currentBrandPersona } from '../../../platform/brand/persona.js';

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

/**
 * Resolve the job-match-scorer model at call time through the shared LLM stack:
 * the admin `matching` override wins, then `LLM_MATCHING_MODEL`. When neither
 * is configured, LLMService uses the configured stack default.
 */
export function pickJobMatchScorerModel(): string | undefined {
  return getTaskModel('matching');
}

/** Effective model label used when persisting a successful score. Mirrors the
 * exact task → stack-default chain that LLMService applies to the call. */
export function resolvedJobMatchScorerModel(): string {
  const taskModel = pickJobMatchScorerModel();
  const model = taskModel && taskModel !== 'default' ? taskModel : getDefaultModel();
  if (!model) {
    throw new Error(
      'Job-match scorer model is not configured. Set LLM_MATCHING_MODEL or LLM_MODEL.',
    );
  }
  return model;
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

  protected getReasoningEffort() {
    return getTaskReasoningEffort('matching');
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
    return `${currentBrandPersona('match scorer')} — an experienced recruiter scoring how well ONE
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
    // OMIT the label when there is no title. The rescore-the-tailored-resume
    // path (RAResumeAIService.tailorDiff) passes '' when the user tailored
    // against a pasted JD without naming a target title; a dangling "Title:"
    // reads as a blank field the model should fill and it scores against an
    // invented role.
    const title = clipString(input.jobTitle, 500);
    parts.push(
      `## Job\n${title ? `Title: ${title}\n\n` : ''}Description:\n${clipString(input.jobDescription, 6_000)}`,
    );
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
    // (the cross-bank search, the tailor diff's re-score) try/catches
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
   * the configured matching model) and apply quota / cache write semantics
   * around it. Failures throw — caller does NOT debit on throw.
   */
  async run(
    input: RAJobMatchScorerInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal; model?: string } = {},
  ): Promise<RAJobMatchScorerOutput> {
    return this.execute(
      input,
      input.jobDescription,
      options.requestId,
      options.locale,
      options.model ?? pickJobMatchScorerModel(),
      options.signal,
    );
  }
}

// ═══ Scorer v3 (WP-18; ARCHITECTURE.md §4.7) ════════════════════════════
//
// The v3 contract replaces the opaque single number with four judged
// components plus quoted evidence. The model NEVER emits a total: the server
// (server/src/features/match/MatchService.ts) sums the components with the
// published weights (MATCH_WEIGHTS) together with the deterministic
// "location, pay and visa" component it computed itself. Evidence must be a
// verbatim quote from the resume or the posting; the server drops anything
// else (CitationGuard). The resume arrives PII-stripped.
//
// `RAJobMatchScorerAgent` (v2, above) stays for its existing callers
// (RACrossBankSearchService, RAResumeAIService.tailorDiff); new code scores
// through the MATCH area, which uses this class.

export const SCORER_V3_PROMPT_VERSION = 'scorer_v3';

export type ScorerV3DimensionKey = 'title_level' | 'skills' | 'industry' | 'career_path';
export const SCORER_V3_DIMENSIONS: readonly ScorerV3DimensionKey[] = ['title_level', 'skills', 'industry', 'career_path'];

export interface RAJobMatchScorerV3Input {
  /** PII-stripped resume markdown. */
  resumeMarkdown: string;
  /** `profileSnapshotForLlm()` text when available (never sensitive fields). */
  profileContext?: string | null;
  job: {
    title: string;
    companyName: string;
    seniority?: string | null;
    educationLevel?: string | null;
    minYears?: number | null;
    skills?: string[];
    description: string;
    qualifications?: string | null;
    responsibilities?: string | null;
  };
  /** The deterministic location/pay/visa result, given to the model as fact. */
  logistics: { score: number | null; lines: string[] };
  targets: { titles: string[]; seniority: string[] };
}

export interface ScorerV3RawEvidence {
  text: string;
  source: 'resume' | 'posting';
}

export interface RAJobMatchScorerV3Output {
  dimensions: Record<ScorerV3DimensionKey, { score: number | null; evidence: ScorerV3RawEvidence[] }>;
  strengths: string[];
  gaps: string[];
  keywordsMatched: string[];
  keywordsMissing: string[];
  /** Second person, no number; null when the model's summary stated a score. */
  summary: string | null;
}

/** A summary that states a number-as-score is dropped (the card shows the number once). */
const SUMMARY_NUMBER = /\d+\s*(?:\/\s*100|%|分|points?\b|out of)/iu;

/**
 * Evidence kept per component at parse time. Deliberately above the 3 the
 * card shows: the CitationGuard (features/match/evidence.ts) drops invented
 * quotes first and then keeps the first 3 verbatim ones, so a valid 4th quote
 * still counts when an earlier one was made up.
 */
export const SCORER_V3_PARSE_EVIDENCE_CAP = 6;

function parseEvidence(value: unknown): ScorerV3RawEvidence[] {
  if (!Array.isArray(value)) return [];
  const out: ScorerV3RawEvidence[] = [];
  for (const e of value) {
    if (!e || typeof e !== 'object') continue;
    const { text, source } = e as { text?: unknown; source?: unknown };
    if (typeof text !== 'string' || !text.trim()) continue;
    if (source !== 'resume' && source !== 'posting') continue;
    out.push({ text: text.trim().slice(0, 240), source });
    if (out.length >= SCORER_V3_PARSE_EVIDENCE_CAP) break;
  }
  return out;
}

function parseNullableScore(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return clampScore(value);
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return clampScore(Number(value));
  return undefined;
}

export class RAJobMatchScorerV3Agent extends BaseAgent<RAJobMatchScorerV3Input, RAJobMatchScorerV3Output> {
  constructor() {
    super('RAJobMatchScorerV3Agent');
  }

  protected getTemperature(): number {
    return 0.1;
  }

  protected getMaxTokens(): number | undefined {
    // Four components × ≤3 quotes + lists + summary; CJK-safe headroom (see v2 note).
    return 2000;
  }

  protected getReasoningEffort() {
    return getTaskReasoningEffort('matching');
  }

  protected getLocaleDirective(locale: string): string | null {
    return this.language.getStrictOutputLanguageDirective(locale) ?? super.getLocaleDirective(locale);
  }

  protected getAgentPrompt(): string {
    return `${currentBrandPersona('fit scorer')} — you compare ONE candidate's resume with ONE job post and
judge four components separately. The candidate reads your words next to the job, so every
claim must be defensible from the two texts. Write strengths, gaps and summary in SECOND
PERSON ("your payments experience"), never "the candidate".

## Components (score each 0-100, or null when the texts give nothing to judge)

- title_level: does the role's title, scope and level fit the level and discipline the
  resume shows? Penalize both directions (too junior and too senior). When the post states
  a degree, years of experience or a graduation class (届别), judge eligibility here.
- skills: the post's REQUIRED skills that the resume evidences, weighted to recent work.
  Nice-to-have skills count half. Absence of evidence is a gap, not a guess.
- industry: direct industry experience beats adjacent; adjacent beats unrelated. Null when
  the post does not make the industry clear.
- career_path: does the career so far lead toward this role, and is the scope of past work
  proportional to this role? Null for a resume with no work history.

Location, pay and visa are NOT yours to judge: they were computed from the user's stated
preferences and are given below as facts. Do not repeat them as strengths or gaps.

## Hard rules

1. Never output a total or overall score. Only the four component scores.
2. Evidence: up to 3 per component, each an EXACT quote (copy the characters) from the
   resume ("source":"resume") or the job post ("source":"posting"), at most 200 characters.
   Never paraphrase inside evidence. Quotes that are not verbatim are discarded.
3. Never invent skills or experience. A skill the resume does not mention is a gap.
4. Never judge school name, school reputation or school tier (985/211/双一流, "top" or
   "elite" schools), nor age, gender, nationality, ethnicity, family, photo, birthplace
   (籍贯) or political status (政治面貌). They are not inputs, even if present.
5. Strengths and gaps: at most 5 each, specific (name the skill or experience). Gaps are
   observations about the resume ("no Kubernetes work shown"), never verdicts on the person.
6. Keywords: concrete terms from the post (skills, tools, certifications), verbatim in the
   post's language. keywordsMatched = in the resume; keywordsMissing = not in it. Max 10 each.
7. Summary: 1-2 sentences, at most 45 words, second person. Lead with the strongest concrete
   overlap, then the most material gap. Never state a number, percentage or score.

## Output (STRICT JSON only, no prose, no code fences)

{
  "dimensions": {
    "title_level": { "score": 0, "evidence": [{ "text": "...", "source": "posting" }] },
    "skills": { "score": 0, "evidence": [] },
    "industry": { "score": null, "evidence": [] },
    "career_path": { "score": 0, "evidence": [] }
  },
  "strengths": ["..."],
  "gaps": ["..."],
  "keywordsMatched": ["..."],
  "keywordsMissing": ["..."],
  "summary": "..."
}`;
  }

  protected formatInput(input: RAJobMatchScorerV3Input): string {
    const j = input.job;
    const facts = [
      `Title: ${clipString(j.title, 300)}`,
      `Company: ${clipString(j.companyName, 200)}`,
      j.seniority ? `Level stated or inferred from the post: ${j.seniority}` : '',
      j.educationLevel && j.educationLevel !== 'none' ? `Degree the post asks for: ${j.educationLevel}` : '',
      typeof j.minYears === 'number' ? `Years of experience the post asks for: ${j.minYears}+` : '',
      j.skills?.length ? `Skills extracted from the post: ${j.skills.slice(0, 30).join(', ')}` : '',
    ].filter(Boolean);
    const parts = [
      `## Job post\n${facts.join('\n')}\n\nDescription:\n${clipString(j.description, 6_000)}`,
      j.qualifications ? `## Qualifications\n${clipString(j.qualifications, 3_000)}` : '',
      j.responsibilities ? `## Responsibilities\n${clipString(j.responsibilities, 2_000)}` : '',
      `## Location, pay and visa (computed; given as fact)\n${
        input.logistics.lines.length ? input.logistics.lines.join('\n') : 'Nothing stated to compare.'
      }`,
      input.targets.titles.length || input.targets.seniority.length
        ? `## What the candidate is looking for\n${[
            input.targets.titles.length ? `Titles: ${input.targets.titles.slice(0, 10).join(', ')}` : '',
            input.targets.seniority.length ? `Levels: ${input.targets.seniority.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('\n')}`
        : '',
      input.profileContext ? `## Candidate profile\n${clipString(input.profileContext, 3_000)}` : '',
      `## Candidate resume\n${clipString(input.resumeMarkdown, 8_000)}`,
      'Judge the four components. Output ONLY the JSON object.',
    ];
    return parts.filter(Boolean).join('\n\n');
  }

  protected parseOutput(response: string): RAJobMatchScorerV3Output {
    // Malformed output THROWS (never a fallback score): the caller falls back
    // to the deterministic "Quick estimate" and persists nothing.
    if (!response || typeof response !== 'string') throw new Error('RAJobMatchScorerV3Agent: unparseable scorer response');
    const cleaned = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          parsed = null;
        }
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('RAJobMatchScorerV3Agent: unparseable scorer response');
    const dims = parsed.dimensions as Record<string, unknown> | undefined;
    if (!dims || typeof dims !== 'object') throw new Error('RAJobMatchScorerV3Agent: missing dimensions');
    const out = {} as RAJobMatchScorerV3Output['dimensions'];
    for (const key of SCORER_V3_DIMENSIONS) {
      const d = (dims[key] ?? null) as { score?: unknown; evidence?: unknown } | null;
      const score = d && typeof d === 'object' ? parseNullableScore(d.score) : undefined;
      // title_level and skills must be judged; industry and career_path may be null.
      if (score === undefined || (score === null && (key === 'title_level' || key === 'skills'))) {
        throw new Error(`RAJobMatchScorerV3Agent: missing ${key} score`);
      }
      out[key] = { score, evidence: parseEvidence(d?.evidence) };
    }
    const summary = clipString(parsed.summary, 400);
    return {
      dimensions: out,
      strengths: sanitizeStringArray(parsed.strengths, 240, 5),
      gaps: sanitizeStringArray(parsed.gaps, 240, 5),
      keywordsMatched: sanitizeStringArray(parsed.keywordsMatched, 80, 10),
      keywordsMissing: sanitizeStringArray(parsed.keywordsMissing, 80, 10),
      summary: summary && !SUMMARY_NUMBER.test(summary) ? summary : null,
    };
  }

  async run(
    input: RAJobMatchScorerV3Input,
    options: { requestId?: string; locale?: string; signal?: AbortSignal; model?: string } = {},
  ): Promise<RAJobMatchScorerV3Output> {
    return this.execute(
      input,
      input.job.description,
      options.requestId,
      options.locale,
      options.model ?? pickJobMatchScorerModel(),
      options.signal,
    );
  }
}

export const raJobMatchScorerAgent = new RAJobMatchScorerAgent();
export default raJobMatchScorerAgent;

// Test surface — keep tight.
export const __test = {
  parseNullableScore,
  parseEvidence,
  pickJobMatchScorerModel,
  resolvedJobMatchScorerModel,
  clampScore,
  sanitizeStringArray,
  clipString,
};
