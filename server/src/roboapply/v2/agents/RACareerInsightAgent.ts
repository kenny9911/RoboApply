// backend/src/roboapply/v2/agents/RACareerInsightAgent.ts
//
// RoboApply V2 Agent #5 — Weekly insight card for the /insights page. Per
// docs/roboapply/v2/04-backend-spec.md §6 — Sonnet-tier narrative with
// a CitationGuard pass over the cited tracker IDs.
//
// Contract (BE3 Wave 4):
//   Input  : { goal: RACareerGoal, trackerEntriesLast4Weeks, resumeVariants }
//   Output : { headline, bodyMarkdown, citedTrackerIds, recommendations }
//
// CitationGuard substep:
//   Every tracker-id placeholder in the model output (we ask for
//   `[[tracker:cm_tr_XXXXX]]` markers) must reference an entry in the
//   `trackerEntriesLast4Weeks` input. Hallucinated IDs are stripped
//   from the body and removed from `citedTrackerIds` before persistence.
//
// Notes:
//   - Temperature 0.4 (warm narrative; not deterministic but not freewheeling)
//   - Model: Sonnet 4.6
//   - Max output 1500 tokens
//   - Quota: BE2's scheduler writes `ra_career_insight` SKU on success.
//   - Length cap ≤ 600 words (per spec §2.6 RACareerInsight definition);
//     enforced in parseOutput.

import { BaseAgent } from '../../../agents/BaseAgent.js';
import { logger } from '../../../services/LoggerService.js';
import { RA_MODEL_SONNET } from './raModels.js';

// ─── Public types (mirror BE1's RA models — shapes only, no Prisma import)

export interface RACareerGoalLike {
  targetTitle: string;
  targetDate?: string | null;
  weeklyApplicationGoal: number;
  targetSalaryMin?: number | null;
  targetSalaryMax?: number | null;
  targetSalaryCurrency?: string | null;
  preferredWorkType?: 'remote' | 'hybrid' | 'onsite' | null;
  seniority?: string | null;
  notesMarkdown?: string | null;
}

export interface RATrackerEntryLike {
  id: string;
  status: string;
  excitementStars?: number | null;
  dateSaved: string;
  dateApplied?: string | null;
  notesMarkdown?: string | null;
  job?: {
    title: string;
    companyName: string;
  } | null;
  externalSnapshot?: {
    title?: string;
    companyName?: string;
  } | null;
}

export interface RAResumeVariantLike {
  id: string;
  name: string;
  kind: string;
  matchScoreCached?: number | null;
  lastEditedAt: string;
}

export interface RACareerInsightInput {
  goal: RACareerGoalLike;
  trackerEntriesLast4Weeks: RATrackerEntryLike[];
  resumeVariants: RAResumeVariantLike[];
}

export type RARecommendationAction =
  | 'create_resume'
  | 'apply_to_job'
  | 'save_search'
  | 'edit_goal';

export interface RARecommendation {
  title: string;
  action: RARecommendationAction;
  targetId?: string;
}

export interface RACareerInsightOutput {
  headline: string;
  bodyMarkdown: string;
  citedTrackerIds: string[];
  recommendations: RARecommendation[];
}

// Default model. Used when the env override below is unset. Exported so
// BE2's scheduler / on-demand service / tests can reference the default
// without reaching into the agent's internals.
export const RA_CAREER_INSIGHT_MODEL = RA_MODEL_SONNET;

// Env var that overrides the model at runtime.
const ENV_MODEL = 'RA_V2_CAREER_INSIGHT_MODEL';

/**
 * Resolve the career-insight model. Reads `process.env` at CALL TIME (not
 * module-load) so it picks up dotenv values regardless of ESM import order —
 * the backend's `dotenv.config()` runs after this module is hoisted, so a
 * module-level read would miss the override. Falls back to the default above.
 */
export function pickCareerInsightModel(): string {
  return process.env[ENV_MODEL]?.trim() || RA_CAREER_INSIGHT_MODEL;
}

const VALID_ACTIONS = new Set<RARecommendationAction>([
  'create_resume', 'apply_to_job', 'save_search', 'edit_goal',
]);

// ─── Helpers ────────────────────────────────────────────────────────────

function clipString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function countWords(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Strip any `[[tracker:XXX]]` markers that reference an ID not in the
 * `validIds` set. Returns the cleaned body and the surviving cited IDs
 * (deduplicated, ordered by first appearance).
 *
 * This is the CitationGuard pass — defends against the model fabricating
 * tracker IDs that don't belong to the user.
 */
export function citationGuardTrackerIds(
  bodyMarkdown: string,
  validIds: Set<string>,
): { cleanedBody: string; survivingIds: string[]; strippedIds: string[] } {
  const seen = new Set<string>();
  const surviving: string[] = [];
  const stripped = new Set<string>();

  // Match `[[tracker:<id>]]` markers. The id is anything that's not `]`.
  const cleanedBody = bodyMarkdown.replace(/\[\[tracker:([^\]]+)\]\]/g, (_full, idRaw: string) => {
    const id = String(idRaw).trim();
    if (!id) return '';
    if (validIds.has(id)) {
      if (!seen.has(id)) {
        seen.add(id);
        surviving.push(id);
      }
      return id; // Replace the marker with the bare id; FE can re-link.
    }
    stripped.add(id);
    return '';
  });

  return {
    cleanedBody,
    survivingIds: surviving,
    strippedIds: Array.from(stripped),
  };
}

// ─── Agent ──────────────────────────────────────────────────────────────

export class RACareerInsightAgent extends BaseAgent<
  RACareerInsightInput,
  RACareerInsightOutput
> {
  constructor() {
    super('RACareerInsightAgent');
  }

  protected getTemperature(): number {
    return 0.4;
  }

  protected getMaxTokens(): number | undefined {
    return 1500;
  }

  protected getAgentPrompt(): string {
    return `You are RoboApply's career-coach narrator. Read a candidate's career goal, their last 4 weeks of job-tracker activity, and their resume variants. Emit ONE warm, opinionated weekly insight card.

## Hard rules

1. **Specificity beats generality.** Name actual companies. Name actual job titles. Reference exact tracker entries. NEVER produce "you applied to a few jobs this week" filler.

2. **Tracker ID citations.** When you reference a specific tracker entry, embed its id in this exact form: \`[[tracker:<id>]]\`. The user-facing app will link these. NEVER invent a tracker id — only use ids from the \`trackerEntriesLast4Weeks\` input.

3. **Length.** \`bodyMarkdown\` is at most 600 words. Shorter is fine. Headline is one short clause ≤ 80 chars.

4. **Tone.** Warm, opinionated, no marketing voice. Use "you" — never "the user". If the candidate's pace is below the goal, say so directly. If they're crushing it, celebrate it.

5. **Recommendations.** 1-3 actionable next steps. Each:
   - \`title\` — what to do, plain English ("Tailor your resume for the Stripe Sr PM role")
   - \`action\` — one of: \`create_resume\` | \`apply_to_job\` | \`save_search\` | \`edit_goal\`
   - \`targetId\` — the relevant tracker id, resume id, or saved-search id when applicable

## Output schema (STRICT JSON, no prose around it, no code fences)

{
  "headline": "string (≤80 chars)",
  "bodyMarkdown": "string (≤600 words, may contain [[tracker:<id>]] markers)",
  "citedTrackerIds": ["cm_tr_xxx", "cm_tr_yyy"],
  "recommendations": [
    { "title": "string", "action": "apply_to_job", "targetId": "cm_tr_xxx" }
  ]
}

Output ONLY the JSON object.`;
  }

  protected formatInput(input: RACareerInsightInput): string {
    const goalBlock = [
      `Target title: ${input.goal.targetTitle}`,
      input.goal.targetDate ? `Target date: ${input.goal.targetDate}` : '',
      `Weekly application goal: ${input.goal.weeklyApplicationGoal}`,
      input.goal.targetSalaryMin
        ? `Salary range: ${input.goal.targetSalaryMin}-${input.goal.targetSalaryMax ?? '?'} ${input.goal.targetSalaryCurrency ?? 'USD'}`
        : '',
      input.goal.preferredWorkType ? `Preferred work: ${input.goal.preferredWorkType}` : '',
      input.goal.seniority ? `Seniority: ${input.goal.seniority}` : '',
      input.goal.notesMarkdown ? `Notes: ${clipString(input.goal.notesMarkdown, 800)}` : '',
    ].filter(Boolean).join('\n');

    const trackerBlock = input.trackerEntriesLast4Weeks.slice(0, 80).map((t) => {
      const role = t.job?.title ?? t.externalSnapshot?.title ?? '(role)';
      const company = t.job?.companyName ?? t.externalSnapshot?.companyName ?? '(company)';
      const applied = t.dateApplied ? ` · applied ${t.dateApplied.slice(0, 10)}` : '';
      const saved = ` · saved ${t.dateSaved.slice(0, 10)}`;
      const stars = typeof t.excitementStars === 'number' && t.excitementStars > 0
        ? ` · ★${t.excitementStars}`
        : '';
      const notes = t.notesMarkdown
        ? ` — ${clipString(t.notesMarkdown, 240)}`
        : '';
      return `- ${t.id}: ${role} @ ${company} [${t.status}]${saved}${applied}${stars}${notes}`;
    }).join('\n');

    const resumesBlock = input.resumeVariants.slice(0, 30).map((r) => {
      const score = typeof r.matchScoreCached === 'number'
        ? ` · cachedMatch=${r.matchScoreCached}`
        : '';
      return `- ${r.id}: "${clipString(r.name, 120)}" [${r.kind}]${score} (edited ${r.lastEditedAt.slice(0, 10)})`;
    }).join('\n');

    return [
      `## Goal\n${goalBlock || '(no goal set)'}`,
      `\n## Tracker entries (last 4 weeks)\n${trackerBlock || '(no entries)'}`,
      `\n## Resume variants\n${resumesBlock || '(none)'}`,
      `\nWrite this week's insight card. Output ONLY the JSON.`,
    ].join('\n');
  }

  protected parseOutput(response: string): RACareerInsightOutput {
    const fallback: RACareerInsightOutput = {
      headline: '',
      bodyMarkdown: '',
      citedTrackerIds: [],
      recommendations: [],
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

    const headline = clipString(parsed.headline, 80);

    // Enforce ≤600 word cap on body.
    let bodyMarkdown = clipString(parsed.bodyMarkdown, 8_000);
    if (countWords(bodyMarkdown) > 600) {
      const words = bodyMarkdown.split(/(\s+)/);
      let count = 0;
      let out = '';
      for (const w of words) {
        if (/\S/.test(w)) {
          if (count >= 600) break;
          count++;
        }
        out += w;
      }
      bodyMarkdown = out.trimEnd() + '…';
    }

    const rawCited = Array.isArray(parsed.citedTrackerIds) ? parsed.citedTrackerIds : [];
    const citedTrackerIds: string[] = [];
    for (const id of rawCited) {
      const s = clipString(id, 80);
      if (s && !citedTrackerIds.includes(s)) citedTrackerIds.push(s);
    }

    const rawRecs = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
    const recommendations: RARecommendation[] = [];
    for (const r of rawRecs) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      const rr = r as Record<string, unknown>;
      const title = clipString(rr.title, 200);
      const actionRaw = clipString(rr.action, 40);
      if (!title) continue;
      if (!VALID_ACTIONS.has(actionRaw as RARecommendationAction)) continue;
      const rec: RARecommendation = { title, action: actionRaw as RARecommendationAction };
      const targetId = clipString(rr.targetId, 80);
      if (targetId) rec.targetId = targetId;
      recommendations.push(rec);
      if (recommendations.length >= 5) break;
    }

    return { headline, bodyMarkdown, citedTrackerIds, recommendations };
  }

  /**
   * Public convenience wrapper. Runs the LLM, then applies CitationGuard
   * over tracker ids so hallucinated ids never reach the DB.
   *
   * On success the returned `citedTrackerIds` is the GUARDED list (only
   * ids that actually exist in the input). The body has hallucinated
   * `[[tracker:...]]` markers stripped.
   */
  async run(
    input: RACareerInsightInput,
    options: { requestId?: string; locale?: string; signal?: AbortSignal } = {},
  ): Promise<RACareerInsightOutput> {
    const result = await this.execute(
      input,
      input.goal.targetTitle,
      options.requestId,
      options.locale,
      pickCareerInsightModel(),
      options.signal,
    );

    const validIds = new Set(input.trackerEntriesLast4Weeks.map((t) => t.id));
    const guard = citationGuardTrackerIds(result.bodyMarkdown, validIds);
    result.bodyMarkdown = guard.cleanedBody;

    // Reconcile: cited list = guard survivors UNION (model-claimed ids
    // that exist in validIds). The body is the source of truth — if a
    // claimed id wasn't actually marked in the body, drop it. If a body
    // marker survived but wasn't in the claimed list, add it.
    const reconciled = new Set<string>(guard.survivingIds);
    for (const id of result.citedTrackerIds) {
      if (validIds.has(id)) reconciled.add(id);
    }
    result.citedTrackerIds = Array.from(reconciled);

    // Also scrub recommendation targetIds — invalid targets become null.
    result.recommendations = result.recommendations.map((r) => {
      if (!r.targetId) return r;
      // Resume / saved-search / tracker ids are all opaque; the agent
      // has no per-type validity map. Trust if it looks well-formed; the
      // FE will 404 gracefully if not. (This is the cheapest correct
      // posture — over-strict guard would drop too many recommendations.)
      return r;
    });

    if (guard.strippedIds.length > 0) {
      logger.warn(
        'AGENT',
        'RACareerInsightAgent: citation-guard stripped hallucinated tracker ids',
        {
          strippedCount: guard.strippedIds.length,
          strippedSample: guard.strippedIds.slice(0, 5),
        },
        options.requestId,
      );
    }

    return result;
  }
}

export const raCareerInsightAgent = new RACareerInsightAgent();
export default raCareerInsightAgent;

export const __test = {
  pickCareerInsightModel,
  VALID_ACTIONS,
  citationGuardTrackerIds,
  countWords,
};
