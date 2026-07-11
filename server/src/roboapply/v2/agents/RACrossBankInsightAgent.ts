// backend/src/roboapply/v2/agents/RACrossBankInsightAgent.ts
//
// Insight Analyst — explains the shortlist honestly. A portfolio-level
// coverage-vs-accuracy narrative + per-job "why matched" + the ONE lever that
// would raise the candidate's odds. Sonnet.
//
// CitationGuard (spec §3.6): every perJob.jobId MUST be in the input shortlist
// or it is stripped (no fabricated jobs); every raiseOddsNote may cite ONLY a
// lever in that job's deterministic raiseOddsLevers set. Applied in run() where
// the input context is available. parseOutput NEVER throws.

import { BaseAgent } from '../../../agents/BaseAgent.js';
import { RA_MODEL_SONNET } from './raModels.js';
import type { CrossBankInsightInput, CrossBankInsight } from '../types/crossBank.js';

const ENV_MODEL = 'RA_V2_CROSSBANK_INSIGHT_MODEL';
// No trailing \b: `%` is a non-word char, so a boundary after it never
// matches (would miss "95%"). Each alternative self-delimits.
const SCORE_PATTERN = /\b\d{1,3}\s*(?:\/\s*100\b|%|\spoints?\b|\spts?\b)/gi;

export function pickCrossBankInsightModel(): string {
  return process.env[ENV_MODEL]?.trim() || RA_MODEL_SONNET;
}

function scrubProse(s: string): string {
  return s.replace(SCORE_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
}

export class RACrossBankInsightAgent extends BaseAgent<
  CrossBankInsightInput,
  CrossBankInsight
> {
  constructor() {
    super('RACrossBankInsightAgent');
  }

  protected getTemperature(): number {
    return 0.4;
  }

  protected getMaxTokens(): number | undefined {
    return 1400; // CJK headroom for a portfolio summary + per-job notes
  }

  protected getResponseFormat(): 'json_object' | undefined {
    return 'json_object';
  }

  protected getLocaleDirective(locale: string): string | null {
    return (
      this.language.getStrictOutputLanguageDirective(locale) ??
      super.getLocaleDirective(locale)
    );
  }

  protected getAgentPrompt(): string {
    return `You are RoboApply's job-match analyst. You explain a candidate's cross-bank job
shortlist to THEM, in second person, honestly.

## Hard rules
1. portfolioSummary: 2-3 sentences on the overall shape of the shortlist — how
   many are strong-odds "apply now" vs adjacent/stretch "worth a look", and the
   coverage-vs-odds tradeoff. Never state numeric scores; the cards carry them.
2. For EACH job in the shortlist, write:
   - acceptanceNote: 1 sentence on why this is a fit and how your odds look,
     grounded in the strengths given. Second person. No numeric scores.
   - raiseOddsNote: at most 1 concrete action that would most improve your odds
     for THIS job — and it MUST name one of the job's listed raiseOddsLevers.
     If a job has no levers, set raiseOddsNote to null.
3. Never invent a job, a skill, a company, or a lever not present in the input.
4. Never promise an interview or offer — frame as odds/fit, not a guarantee.

## Output schema (STRICT JSON, no prose, no fences)
{
  "portfolioSummary": "...",
  "perJob": [ { "jobId": "...", "acceptanceNote": "...", "raiseOddsNote": "..." | null } ]
}
Output ONLY the JSON object.`;
  }

  protected formatInput(input: CrossBankInsightInput): string {
    const parts: string[] = [];
    parts.push(`## Candidate\n${input.candidateHeadline.slice(0, 300)}`);
    parts.push(
      `## Coverage\nBanks: ${input.coverage.banksSwept.join(', ')} · Recommended: ${input.coverage.recommendedCount} · Explore: ${input.coverage.exploreCount}`,
    );
    parts.push('## Shortlist');
    for (const s of input.shortlist.slice(0, 12)) {
      parts.push(
        [
          `- jobId: ${s.jobId}`,
          `  title: ${s.title} @ ${s.companyName} (${s.bank}, ${s.tier})`,
          `  band: ${s.acceptanceBand}`,
          `  strengths: ${s.strengths.slice(0, 4).join('; ') || '(none)'}`,
          `  gaps: ${s.gaps.slice(0, 4).join('; ') || '(none)'}`,
          `  raiseOddsLevers: ${s.raiseOddsLevers.join('; ') || '(none — set raiseOddsNote null)'}`,
        ].join('\n'),
      );
    }
    parts.push('Explain this shortlist. Output ONLY the JSON object.');
    return parts.join('\n');
  }

  protected parseOutput(response: string): CrossBankInsight {
    const cleaned = (response ?? '')
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          parsed = {};
        }
      }
    }
    const perJobRaw = Array.isArray(parsed.perJob) ? parsed.perJob : [];
    const perJob = perJobRaw
      .map((r) => {
        if (!r || typeof r !== 'object') return null;
        const o = r as Record<string, unknown>;
        if (typeof o.jobId !== 'string') return null;
        return {
          jobId: o.jobId,
          acceptanceNote: typeof o.acceptanceNote === 'string' ? o.acceptanceNote.slice(0, 400) : '',
          raiseOddsNote:
            typeof o.raiseOddsNote === 'string' && o.raiseOddsNote.trim()
              ? o.raiseOddsNote.slice(0, 300)
              : null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return {
      portfolioSummary:
        typeof parsed.portfolioSummary === 'string' ? parsed.portfolioSummary.slice(0, 800) : '',
      perJob,
    };
  }

  /**
   * CitationGuard + scrub. Drops perJob rows whose jobId is not in the
   * shortlist, nulls a raiseOddsNote that names no in-set lever, and strips
   * numeric scores from prose. Never throws — returns a deterministic-ish
   * shape the orchestrator can fill.
   */
  async run(
    input: CrossBankInsightInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<CrossBankInsight> {
    let out: CrossBankInsight;
    try {
      out = await this.executeWithJsonResponse(
        input,
        input.candidateHeadline,
        options.requestId,
        pickCrossBankInsightModel(),
        options.locale,
        undefined,
      );
    } catch {
      return { portfolioSummary: '', perJob: [] };
    }
    return applyCitationGuard(out, input);
  }
}

/** Exported for unit testing the guard in isolation. */
export function applyCitationGuard(
  out: CrossBankInsight,
  input: CrossBankInsightInput,
): CrossBankInsight {
  const allowed = new Map(input.shortlist.map((s) => [s.jobId, s]));
  const perJob = out.perJob
    .filter((r) => allowed.has(r.jobId))
    .map((r) => {
      const s = allowed.get(r.jobId)!;
      const levers = new Set(s.raiseOddsLevers.map((l) => l.toLowerCase()));
      let raiseOddsNote = r.raiseOddsNote ? scrubProse(r.raiseOddsNote) : null;
      // Keep the note only if it references at least one allowed lever (or the
      // job legitimately has none, in which case there is nothing to cite).
      if (raiseOddsNote && levers.size > 0) {
        const cites = [...levers].some((l) => raiseOddsNote!.toLowerCase().includes(l));
        if (!cites) raiseOddsNote = null;
      } else if (raiseOddsNote && levers.size === 0) {
        raiseOddsNote = null;
      }
      return { jobId: r.jobId, acceptanceNote: scrubProse(r.acceptanceNote), raiseOddsNote };
    });
  return { portfolioSummary: scrubProse(out.portfolioSummary), perJob };
}

export const raCrossBankInsightAgent = new RACrossBankInsightAgent();
export default raCrossBankInsightAgent;

export const __test = { pickCrossBankInsightModel, scrubProse, applyCitationGuard };
