// backend/src/roboapply/v2/agents/RAResumeRewriteAgent.ts
//
// RoboApply V3 Agent — inline resume rewrite. Backs the three editor surfaces
// behind `resumes.rewrite({ mode })`:
//
//   - mode='bullet'  → rewrite ONE bullet per `action` (improve / metrics /
//                      shorten / expand / confident / junior). Returns one
//                      string.
//   - mode='summary' → 3 rewritten summary options (Tight / Numeric /
//                      Personality). Returns string[3].
//   - mode='skills'  → up to ~8 skill phrases inferred from the resume.
//                      Returns string[].
//
// This is a cheap Haiku-tier call (mirrors RAKeywordExtractorAgent) — the
// editor fires it on every button press, so latency + cost matter more than
// voice. The shape returned to the route layer is mode-agnostic
// (`RAResumeRewriteAgentOutput`); RAResumeAIService maps it to the wire
// `ResumeRewriteResponse`.
//
// CitationGuard discipline (per RAResumeTailorAgent): the model is told never
// to invent numbers. The 'metrics' action is the one that wants quantified
// claims, but it MUST express them as bracketed placeholders ([X], [n=__])
// when the source bullet has no number — it can only keep numbers that already
// appear verbatim in the input text. RAResumeAIService runs a lightweight
// numeric-leak check and falls back to a deterministic rewrite if the model
// fabricates a concrete figure.
//
// Quota: RAResumeAIService writes the `ra_resume_tailor` SKU on success (this
// is an inline tailor op). Failures pay zero.

import { BaseAgent } from '../../../agents/BaseAgent.js';
import { RA_MODEL_HAIKU } from './raModels.js';

// ─── Public types ───────────────────────────────────────────────────────

export type RAResumeRewriteAction =
  | 'improve'
  | 'metrics'
  | 'shorten'
  | 'expand'
  | 'confident'
  | 'junior';

export type RAResumeRewriteMode = 'bullet' | 'summary' | 'skills';

export interface RAResumeRewriteInput {
  mode: RAResumeRewriteMode;
  /** The bullet text or current summary. Omitted/empty for 'skills'. */
  text?: string;
  /** Required when mode === 'bullet'. */
  action?: RAResumeRewriteAction;
  /** The full resume markdown — context for 'skills' + 'summary' modes. */
  resumeMarkdown: string;
  /** Optional target-job context to bias the rewrite. */
  jobContext?: { title?: string; description?: string };
}

export interface RAResumeRewriteAgentOutput {
  /** mode === 'bullet' — the single rewritten line. */
  rewrite?: string;
  /** mode === 'summary' — up to 3 option strings (caller adds labels). */
  options?: string[];
  /** mode === 'skills' — inferred skill phrases. */
  skills?: string[];
}

// Haiku-tier default — cheap + fast, matches RAKeywordExtractorAgent. Used
// when the env override below is unset. Exported for callers / tests.
export const RA_RESUME_REWRITE_MODEL = RA_MODEL_HAIKU;

// Env var that overrides the model at runtime.
const ENV_MODEL = 'RA_V2_RESUME_REWRITE_MODEL';

/**
 * Resolve the resume-rewrite model. Reads `process.env` at CALL TIME (not
 * module-load) so it picks up dotenv values regardless of ESM import order —
 * the backend's `dotenv.config()` runs after this module is hoisted, so a
 * module-level read would miss the override. Falls back to the default above.
 */
export function pickResumeRewriteModel(): string {
  return process.env[ENV_MODEL]?.trim() || RA_RESUME_REWRITE_MODEL;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function clipString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

const ACTION_GUIDANCE: Record<RAResumeRewriteAction, string> = {
  improve:
    'Make the bullet sharper and more results-oriented. Lead with a strong verb, name the outcome, keep it to one line.',
  metrics:
    'Add quantification. ONLY keep numbers that already appear in the source bullet — if none exist, insert bracketed placeholders like [X], [n=__], [before → after] for the user to fill in. NEVER invent a concrete figure.',
  shorten:
    'Cut to the single sharpest version — one short line, no filler, no sub-clauses.',
  expand:
    'Add one layer of specificity (who you worked with, what stages, what the result was). 2–3 sentences max. Keep every number identical to the source.',
  confident:
    'Rewrite in a confident first-person-implied voice. Lead with ownership verbs (Led / Owned / Drove). No hedging ("helped", "assisted", "involved in").',
  junior:
    'Reframe for an early-career / new-grad candidate: translate scope into concrete deliverables, lean on initiative and learning, avoid overclaiming seniority.',
};

// ─── Agent ──────────────────────────────────────────────────────────────

export class RAResumeRewriteAgent extends BaseAgent<
  RAResumeRewriteInput,
  RAResumeRewriteAgentOutput
> {
  // The active input mode — set in run() so parseOutput knows which shape to
  // extract. Safe because each agent instance processes one call at a time
  // through `execute()` (no concurrent reentrancy on a single instance), and
  // RAResumeAIService constructs a fresh agent per request.
  private activeMode: RAResumeRewriteMode = 'bullet';

  constructor() {
    super('RAResumeRewriteAgent');
  }

  protected getTemperature(): number {
    // Low-creative: resume edits favour accuracy over voice. Slightly above
    // the scorer's 0.1 because we do want some lexical variety across the
    // three summary options.
    return 0.4;
  }

  protected getMaxTokens(): number | undefined {
    return 700;
  }

  /**
   * Honor the user's selected UI language over the auto-detected source
   * language. The base prompt is English-heavy (English mode descriptions +
   * English label words), and the editor often fires on an empty / English
   * summary, so the one-line LANGUAGE_INSTRUCTIONS hint loses often enough that
   * a Chinese-UI user gets English rewrites. The strict directive states the
   * user-selected language as the highest-priority rule (it keeps proper nouns
   * + technical terms in their original form). Mirrors RAJobMatchScorerAgent.
   * Falls back to the default one-line hint for unrecognized locales.
   */
  protected getLocaleDirective(locale: string): string | null {
    return (
      this.language.getStrictOutputLanguageDirective(locale) ??
      super.getLocaleDirective(locale)
    );
  }

  protected getAgentPrompt(): string {
    return `You are RoboApply's inline resume editor. You rewrite a single piece of a candidate's resume on demand. You return STRICT JSON.

## Absolute rules

1. **Never invent facts.** Do not add skills, employers, dates, titles, or numbers the candidate did not provide. Every concrete number in your output MUST appear verbatim in the input text. If a rewrite "wants" a metric the candidate didn't give, use a bracketed placeholder ([X], [n=__], [before → after]) — never a made-up figure.
2. **Stay truthful to scope.** Don't promote an intern to a director. Don't claim outcomes that aren't stated.
3. **One job only.** Rewrite exactly what is asked — don't rewrite the whole resume.

## Modes

- **bullet**: Rewrite the one provided bullet according to the requested ACTION. Output \`{ "rewrite": "..." }\` — a single line (or 2–3 short sentences for 'expand').
- **summary**: Produce exactly 3 rewritten professional-summary options. Option 1 = TIGHT (two crisp sentences). Option 2 = NUMERIC (lead with the candidate's real metrics). Option 3 = PERSONALITY (a touch of voice, still professional). Output \`{ "options": ["...","...","..."] }\`.
- **skills**: Read the whole resume and infer 6–8 concrete, resume-ready SKILL PHRASES the candidate demonstrably has (e.g. "Cohort retention analysis", "Cross-functional squad leadership"). No generic adjectives. Output \`{ "skills": ["...", "..."] }\`.

## Output

Return ONLY the JSON object for the active mode — no prose, no code fences.`;
  }

  protected formatInput(input: RAResumeRewriteInput): string {
    const parts: string[] = [];
    parts.push(`MODE: ${input.mode}`);

    if (input.jobContext?.title || input.jobContext?.description) {
      const ctx: string[] = [];
      if (input.jobContext.title) ctx.push(`Target role: ${clipString(input.jobContext.title, 200)}`);
      if (input.jobContext.description) {
        ctx.push(`Target JD (bias keywords toward this, do NOT copy claims from it):\n${clipString(input.jobContext.description, 2_000)}`);
      }
      parts.push(`## Job context\n${ctx.join('\n')}`);
    }

    if (input.mode === 'bullet') {
      const action = input.action ?? 'improve';
      parts.push(`ACTION: ${action}`);
      parts.push(`Guidance: ${ACTION_GUIDANCE[action] ?? ACTION_GUIDANCE.improve}`);
      parts.push(`## Bullet to rewrite\n${clipString(input.text, 1_200) || '(no bullet text provided)'}`);
      parts.push('Rewrite this single bullet. Output ONLY {"rewrite": "..."}.');
    } else if (input.mode === 'summary') {
      // The current summary (if any) plus the resume body for grounding.
      if (input.text) {
        parts.push(`## Current summary\n${clipString(input.text, 1_500)}`);
      }
      parts.push(`## Full resume (for grounding — use only facts present here)\n${clipString(input.resumeMarkdown, 8_000)}`);
      parts.push('Produce 3 summary options (Tight / Numeric / Personality). Output ONLY {"options": ["...","...","..."]}.');
    } else {
      // skills
      parts.push(`## Full resume\n${clipString(input.resumeMarkdown, 8_000)}`);
      parts.push('Infer 6–8 concrete skill phrases the candidate demonstrably has. Output ONLY {"skills": ["...", "..."]}.');
    }

    return parts.join('\n\n');
  }

  protected parseOutput(response: string): RAResumeRewriteAgentOutput {
    if (!response || typeof response !== 'string') return {};

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
      return {};
    }

    if (this.activeMode === 'bullet') {
      const rewrite = clipString(parsed.rewrite, 1_500);
      return rewrite ? { rewrite } : {};
    }

    if (this.activeMode === 'summary') {
      const raw = Array.isArray(parsed.options) ? parsed.options : [];
      const options = raw
        .map((o) => clipString(o, 1_200))
        .filter((o): o is string => o.length > 0)
        .slice(0, 3);
      return options.length > 0 ? { options } : {};
    }

    // skills
    const raw = Array.isArray(parsed.skills) ? parsed.skills : [];
    const seen = new Set<string>();
    const skills: string[] = [];
    for (const sRaw of raw) {
      const s = clipString(sRaw, 120);
      if (!s) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      skills.push(s);
      if (skills.length >= 10) break;
    }
    return skills.length > 0 ? { skills } : {};
  }

  /**
   * Run the rewrite. Failures throw — RAResumeAIService does NOT debit on
   * throw. An empty (unparseable) result is returned as `{}`; the service
   * detects the empty shape and applies its deterministic fallback (and
   * still skips the debit, since the LLM produced nothing usable).
   */
  async run(
    input: RAResumeRewriteInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<RAResumeRewriteAgentOutput> {
    this.activeMode = input.mode;
    // Use the bullet/summary text (or resume) for language detection so the
    // rewrite comes back in the candidate's language.
    const langSource = input.text || input.resumeMarkdown;
    return this.execute(
      input,
      langSource,
      options.requestId,
      options.locale,
      pickResumeRewriteModel(),
      options.signal,
    );
  }
}

export const raResumeRewriteAgent = new RAResumeRewriteAgent();
export default raResumeRewriteAgent;

export const __test = {
  pickResumeRewriteModel,
  ACTION_GUIDANCE,
};
