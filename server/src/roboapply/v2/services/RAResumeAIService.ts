// server/src/roboapply/v2/services/RAResumeAIService.ts
//
// RoboApply V3 — inline resume-AI service. Backs two editor surfaces:
//
//   rewrite(userId, id, body)    → ResumeRewriteResponse  (bullet | summary | skills)
//   coachTips(userId, id)        → ResumeCoachTipsResponse
//
// Shapes match `lib/api/v2/types.ts`.
//
// LLM ops:
//   - rewrite is LLM-backed → writes the `ra_resume_tailor` SKU on SUCCESS only
//     (audit-only debit). Failures / graceful fallbacks pay zero.
//   - coachTips is FREE — a deterministic heuristic pass over the resume
//     markdown (no LLM call, no debit).
//
// Graceful degradation: when the LLM is not configured / errors / returns an
// unparseable shape, rewrite still returns a VALID response shape via a
// deterministic fallback. The fallback path does NOT write a deduction log.
//
// Ownership: every method loads the variant scoped to `{ id, userId }` and
// 404s otherwise (single-user product — no team scope; see raVisibility.ts).
//
// Tailoring is not here. `tailorDiff` (and the tailor-apply selection helpers)
// were deleted with the editor's TailorModal (INT-10): every tailored version
// now comes from a tailor session (server/src/features/resume/tailor, POST
// /v2/resumes/tailor-sessions — a `tailor` credit, claim verification,
// finalize).

import prisma from '../../../lib/prisma.js';
import { writeDeductionLog } from '../../../lib/matchBilling.js';
import { costPatchFromTally } from '../../../lib/deductionCost.js';
import { getCurrentRequestId } from '../../../lib/requestContext.js';
import { logger } from '../../../services/LoggerService.js';
import {
  RAResumeRewriteAgent,
  type RAResumeRewriteAction,
  type RAResumeRewriteMode,
} from '../agents/RAResumeRewriteAgent.js';
import { getResumeAIMessages } from '../lib/raResumeAIMessages.js';
import { loadLegacyVisibleJob } from '../lib/legacyJobScope.js';
import { resumeAiAvailable, resumeForLlm } from '../../../features/resume/index.js';

// ─── Public wire types (mirror lib/api/v2/types.ts) ───────────────────────

export interface RAResumeCoachTip {
  kind: 'good' | 'careful';
  /** Stable i18n code — the frontend renders `coach.tips.<code>` so the tip
   *  shows in the user's language. `text` stays as an English fallback for
   *  older clients / any unmapped code. */
  code?: string;
  /** Interpolation values for the i18n message (e.g. `{ count }`). */
  params?: Record<string, string | number>;
  text: string;
}

export interface ResumeRewriteResult {
  rewrite?: string;
  options?: Array<{ label: string; text: string }>;
  skills?: string[];
}

export interface ResumeCoachTipsResult {
  tips: RAResumeCoachTip[];
}

export interface RewriteInput {
  mode: RAResumeRewriteMode;
  text?: string;
  action?: RAResumeRewriteAction;
  targetJobId?: string;
}

// ─── Errors ───────────────────────────────────────────────────────────────

export class ResumeNotFoundError extends Error {
  constructor() {
    super('Resume not found');
    this.name = 'ResumeNotFoundError';
  }
}

/**
 * The user may not have AI run on their data (GoApply without the
 * `ai_resume_parsing` consent, or no domestic model configured). Thrown before
 * any LLM call; the route answers 503 `ai_unavailable` (TASK_PLAN.md §2.2).
 */
export class AiUnavailableError extends Error {
  readonly code = 'ai_unavailable' as const;
  constructor() {
    super('AI is not available for this account');
    this.name = 'AiUnavailableError';
  }
}

export class RewriteValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'RewriteValidationError';
  }
}

// ─── Constants ──────────────────────────────────────────────────────────

const VALID_MODES: RAResumeRewriteMode[] = ['bullet', 'summary', 'skills'];
const VALID_ACTIONS: RAResumeRewriteAction[] = [
  'improve',
  'metrics',
  'shorten',
  'expand',
  'confident',
  'junior',
];
// Locale-aware version tags (Tight / Numeric / Personality) for the 3 summary
// options — resolved per request from the catalog so a zh / ja user sees the
// label in their language. See raResumeAIMessages.ts.
function summaryLabelsFor(locale?: string): string[] {
  return getResumeAIMessages(locale).summaryLabels;
}

// ─── Deterministic fallbacks (graceful degradation) ───────────────────────
//
// These fire when the LLM is unconfigured / errors / returns an empty parse.
// They keep the response shape valid without billing the user.

function fallbackBulletRewrite(
  text: string | undefined,
  action: RAResumeRewriteAction,
  locale?: string,
): string {
  const m = getResumeAIMessages(locale);
  const base = (text ?? '').trim();
  // Strip a trailing sentence terminator (Latin '.' or CJK '。' / '．') before
  // appending a localized fragment, so CJK input doesn't double-punctuate.
  const stripTrailing = (s: string) => s.replace(/[.。．]$/, '');
  switch (action) {
    case 'shorten': {
      // Keep the first sentence / clause. Re-terminate with the LOCALE's
      // sentence mark — appending an ASCII '.' to a Chinese clause produced
      // "…用户." in the editor.
      const firstClause = base.split(/[.;。；]/)[0]?.trim();
      return firstClause
        ? `${firstClause}${m.sentenceEnd}`
        : base || m.bulletEmpty.shorten;
    }
    case 'metrics':
      return base
        ? `${stripTrailing(base)}${m.bulletMetricsSuffix}`
        : m.bulletEmpty.metrics;
    case 'expand':
      return base
        ? `${stripTrailing(base)}${m.bulletExpandSuffix}`
        : m.bulletEmpty.expand;
    case 'confident': {
      if (!base) return m.bulletEmpty.confident;
      // The hedge-verb DETECTOR is English-only — those words only occur in
      // English prose — so the clause it fires on is ALWAYS English. Splicing
      // the catalog's localized verb into it produces a mixed-language bullet
      // ("geleitet build the pipeline", "主导 build the pipeline"), which is
      // worse than leaving the line alone. So substitute only when the target
      // language is English too; otherwise return the bullet untouched and let
      // the LLM path own this action. Casing is a no-op on CJK either way.
      // Identity compare: getResumeAIMessages returns the shared `en` object
      // for 'en' AND for any unmapped locale, so this is exactly "the fallback
      // text we are about to emit is English".
      const isEnglishOutput = m === getResumeAIMessages('en');
      const swapped = isEnglishOutput
        ? base.replace(/\b(helped|assisted|involved in|worked on)\b/gi, m.bulletConfidentVerb)
        : base;
      return swapped.replace(/^./, (c) => c.toUpperCase());
    }
    case 'junior':
      return base
        ? `${m.bulletJuniorPrefix}${base.charAt(0).toLowerCase()}${base.slice(1)}`
        : m.bulletEmpty.junior;
    case 'improve':
    default:
      // The "already terminated?" class must include CJK marks, or a bullet
      // ending in '。' gets an ASCII '.' bolted on.
      return base
        ? base
            .replace(/^./, (c) => c.toUpperCase())
            .replace(/([^.!?。！？])$/, (_full, last: string) => `${last}${m.sentenceEnd}`)
        : m.bulletEmpty.improve;
  }
}

function fallbackSummaryOptions(current: string | undefined, locale?: string): string[] {
  const m = getResumeAIMessages(locale);
  const c = (current ?? '').trim();
  if (c) {
    // Options 2 + 3 augment the user's CURRENT summary, so they stay in the
    // user's own language; only the appended tagline comes from the catalog.
    const oneLine = c.replace(/\s+/g, ' ');
    return [
      oneLine.length > 200 ? oneLine.slice(0, 200).replace(/\s\S*$/, '') + '.' : oneLine,
      `${oneLine} ${m.summaryAugment[0]}`,
      `${oneLine} ${m.summaryAugment[1]}`,
    ];
  }
  return [...m.summaryFallback];
}

/** Pull candidate skill phrases deterministically from the resume markdown:
 *  prefer an explicit "Skills" section; else surface verb-led bullets. */
function fallbackSkills(resumeMarkdown: string, locale?: string): string[] {
  const md = resumeMarkdown || '';
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const v = s.trim().replace(/^[•\-*]\s*/, '').replace(/\.$/, '').trim();
    if (!v || v.length < 3 || v.length > 80) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };

  // 1) Explicit "Skills" section → split on common delimiters.
  const skillsMatch = md.match(/#+\s*skills?\b[^\n]*\n([\s\S]*?)(?:\n#+\s|\n\n#|$)/i);
  if (skillsMatch && skillsMatch[1]) {
    for (const tok of skillsMatch[1].split(/[,•·|\n]/)) push(tok.replace(/^[-*]\s*/, ''));
  }
  // 2) Backfill from leading verbs of bullets if we don't have enough.
  if (out.length < 6) {
    const bulletLines = md.split('\n').filter((l) => /^\s*[-*•]\s+/.test(l));
    for (const line of bulletLines) {
      const clean = line.replace(/^\s*[-*•]\s+/, '').trim();
      const firstFew = clean.split(/\s+/).slice(0, 4).join(' ');
      if (firstFew) push(firstFew);
      if (out.length >= 8) break;
    }
  }
  if (out.length === 0) {
    return [...getResumeAIMessages(locale).skillsDefault];
  }
  return out.slice(0, 8);
}

// ─── Number guard for rewrites ────────────────────────────────────────────

/** Fold full-width digits (U+FF10–U+FF19) onto ASCII so the numeric comparison
 *  below reads a CJK resume the same way it reads a Latin one. Without this a
 *  Japanese bullet written "３０％ 改善" whose rewrite says "30% 改善" looks like
 *  a fabricated number: the guard rejects a perfectly faithful rewrite and the
 *  user silently gets the placeholder template instead. DIGITS ONLY — folding
 *  full-width punctuation too would let "３０，効率２０" collapse into a bogus
 *  single "30,20" run and reintroduce the false positive from the other side. */
function foldFullWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (d) =>
    String.fromCharCode(d.charCodeAt(0) - 0xfee0),
  );
}

/** Detect a fabricated concrete number: a digit-run in `out` (excluding
 *  bracketed placeholders + plausible years) that does NOT appear in `src`.
 *  Used to reject a hallucinated metric and fall back deterministically. */
function hasFabricatedNumber(src: string, out: string): boolean {
  const srcFolded = foldFullWidthDigits(src);
  // Strip bracketed placeholders like [X], [n=__], [before → after].
  const stripped = foldFullWidthDigits(out).replace(/\[[^\]]*\]/g, ' ');
  const runs = stripped.match(/\d+(?:[.,]\d+)?/g) ?? [];
  for (const run of runs) {
    const plain = run.replace(/[.,]/g, '');
    const asNum = Number(plain);
    if (Number.isFinite(asNum) && asNum >= 1990 && asNum <= 2099) continue; // year
    if (!srcFolded.includes(run)) return true;
  }
  return false;
}

// ─── Service ────────────────────────────────────────────────────────────

export class RAResumeAIService {
  /** Load a non-deleted variant owned by the user, or throw 404-mapping error. */
  private async loadOwnedVariant(userId: string, id: string): Promise<any> {
    const p = prisma as any;
    const row = await p.rAResumeVariant.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!row) throw new ResumeNotFoundError();
    return row;
  }

  /** Resolve job context for tailor / rewrite bias: only a job this user may read (market, own import, R-14 mode). */
  private async loadJob(userId: string, jobId: string): Promise<any | null> {
    return loadLegacyVisibleJob(userId, jobId);
  }

  // ── rewrite ──
  async rewrite(userId: string, id: string, body: RewriteInput, locale?: string): Promise<ResumeRewriteResult> {
    if (!body || !VALID_MODES.includes(body.mode)) {
      throw new RewriteValidationError('mode must be one of: ' + VALID_MODES.join(', '));
    }
    const action: RAResumeRewriteAction =
      body.action && VALID_ACTIONS.includes(body.action) ? body.action : 'improve';
    if (body.mode === 'bullet' && body.action && !VALID_ACTIONS.includes(body.action)) {
      throw new RewriteValidationError('invalid action');
    }

    const variant = await this.loadOwnedVariant(userId, id);
    if (!(await resumeAiAvailable(userId))) throw new AiUnavailableError();

    // Optional job context to bias the rewrite.
    let jobContext: { title?: string; description?: string } | undefined;
    if (body.targetJobId) {
      const job = await this.loadJob(userId, body.targetJobId);
      if (job) jobContext = { title: job.title, description: job.descriptionPlain ?? job.description ?? '' };
    }

    const requestId = getCurrentRequestId() ?? undefined;
    const agent = new RAResumeRewriteAgent();
    const summaryLabels = summaryLabelsFor(locale);
    let agentSucceeded = false;
    let result: ResumeRewriteResult;

    try {
      const out = await agent.run(
        {
          mode: body.mode,
          text: body.text,
          action,
          // Prompt hygiene: no contact block, photo, 籍贯, birth date or family lines.
          resumeMarkdown: resumeForLlm(variant.resumeMarkdown ?? ''),
          jobContext,
        },
        { requestId, locale },
      );

      if (body.mode === 'bullet') {
        const rewrite = out.rewrite?.trim();
        // CitationGuard: reject fabricated numbers → deterministic fallback.
        if (rewrite && !hasFabricatedNumber(body.text ?? '', rewrite)) {
          result = { rewrite };
          agentSucceeded = true;
        } else {
          if (rewrite) {
            logger.warn('RA_V2_RESUME_AI', 'rewrite citation-guard rejected fabricated number', {
              userId,
              resumeId: id,
              action,
            });
          }
          result = { rewrite: fallbackBulletRewrite(body.text, action, locale) };
        }
      } else if (body.mode === 'summary') {
        const opts = out.options ?? [];
        if (opts.length > 0) {
          result = {
            options: opts.map((text, i) => ({ label: summaryLabels[i] ?? `Option ${i + 1}`, text })),
          };
          agentSucceeded = true;
        } else {
          result = {
            options: fallbackSummaryOptions(body.text, locale).map((text, i) => ({
              label: summaryLabels[i] ?? `Option ${i + 1}`,
              text,
            })),
          };
        }
      } else {
        // skills
        const skills = out.skills ?? [];
        if (skills.length > 0) {
          result = { skills };
          agentSucceeded = true;
        } else {
          result = { skills: fallbackSkills(variant.resumeMarkdown ?? '', locale) };
        }
      }
    } catch (err) {
      logger.warn('RA_V2_RESUME_AI', 'rewrite agent failed; deterministic fallback', {
        userId,
        resumeId: id,
        mode: body.mode,
        action,
        error: err instanceof Error ? err.message : String(err),
      });
      // Graceful degradation — valid shape, no debit.
      if (body.mode === 'bullet') {
        result = { rewrite: fallbackBulletRewrite(body.text, action, locale) };
      } else if (body.mode === 'summary') {
        result = {
          options: fallbackSummaryOptions(body.text, locale).map((text, i) => ({
            label: summaryLabels[i] ?? `Option ${i + 1}`,
            text,
          })),
        };
      } else {
        result = { skills: fallbackSkills(variant.resumeMarkdown ?? '', locale) };
      }
    }

    // Quota: commit-on-success only (audit-only debit, mirrors RAResumeService).
    if (agentSucceeded) {
      const cost = costPatchFromTally(requestId);
      await writeDeductionLog({
        userId,
        sku: 'ra_resume_tailor',
        source: 'plan',
        platformCostUsd: cost.platformCostUsd,
        units: 1,
        requestId: requestId ?? null,
        relatedEntityType: 'ra_resume_variant',
        relatedEntityId: id,
        metadata: {
          ...cost.metadata,
          source: 'roboapply_v2',
          agent: 'RAResumeRewriteAgent',
          op: 'rewrite',
          mode: body.mode,
          ...(body.mode === 'bullet' ? { action } : {}),
        },
      });
    }

    logger.info('RA_V2_RESUME_AI', 'rewrite complete', {
      userId,
      resumeId: id,
      mode: body.mode,
      agentSucceeded,
    });
    return result;
  }

  // ── coachTips ──  (FREE — deterministic, no LLM, no debit)
  async coachTips(userId: string, id: string): Promise<ResumeCoachTipsResult> {
    const variant = await this.loadOwnedVariant(userId, id);
    const md = (variant.resumeMarkdown ?? '') as string;
    const tips: RAResumeCoachTip[] = [];

    const lines = md.split('\n');
    const bullets = lines.filter((l) => /^\s*[-*•]\s+/.test(l)).map((l) => l.replace(/^\s*[-*•]\s+/, '').trim());
    const bulletsWithNumbers = bullets.filter((b) => /\d/.test(b)).length;
    const weakVerbRe = /\b(responsible for|helped with|involved in|worked on|assisted with)\b/i;
    const weakBullets = bullets.filter((b) => weakVerbRe.test(b));

    // 1) Quantification signal.
    if (bullets.length > 0 && bulletsWithNumbers / bullets.length >= 0.4) {
      tips.push({
        kind: 'good',
        code: 'metrics_good',
        text: 'Your bullets carry real numbers. Keep that quantified voice across the whole resume.',
      });
    } else {
      tips.push({
        kind: 'careful',
        code: 'metrics_missing',
        text: 'Most bullets have no metric. Add a number to your top 3 — recruiters skim for impact.',
      });
    }

    // 2) Summary length.
    const summaryMatch = md.match(/#+\s*(summary|profile|about)\b[^\n]*\n([\s\S]*?)(?:\n#+\s|\n\n#|$)/i);
    const summaryBody = summaryMatch?.[2]?.trim() ?? '';
    const summarySentences = summaryBody ? summaryBody.split(/[.!?]\s/).filter(Boolean).length : 0;
    if (summarySentences > 3) {
      tips.push({
        kind: 'careful',
        code: 'summary_long',
        text: 'Your summary runs long. Cut it to two sharp sentences — recruiters skim this first.',
      });
    } else if (summaryBody) {
      tips.push({
        kind: 'good',
        code: 'summary_tight',
        text: 'Your summary is tight. Lead with your strongest, most role-relevant line.',
      });
    } else {
      tips.push({
        kind: 'careful',
        code: 'summary_missing',
        text: 'No summary section yet. Two sentences up top frame everything below — add one.',
      });
    }

    // 3) Weak verbs.
    if (weakBullets.length > 0) {
      tips.push({
        kind: 'careful',
        code: 'weak_verbs',
        params: { count: weakBullets.length },
        text: `Found ${weakBullets.length} weak opener(s) like "responsible for" / "helped with". Click ✦ Confident to rewrite with ownership verbs.`,
      });
    } else if (bullets.length > 0) {
      tips.push({
        kind: 'good',
        code: 'strong_verbs',
        text: 'Strong verbs throughout — no "responsible for" or "helped with" anywhere. Keep it.',
      });
    }

    // 4) Length / density nudge (always at least one more tip).
    if (bullets.length === 0) {
      tips.push({
        kind: 'careful',
        code: 'no_bullets',
        text: 'This resume has no bullet points yet. Break experience into outcome-led bullets.',
      });
    } else if (bullets.length > 24) {
      tips.push({
        kind: 'careful',
        code: 'too_many_bullets',
        text: 'A lot of bullets here. Trim to the 3–5 strongest per role so the best work stands out.',
      });
    } else {
      tips.push({
        kind: 'good',
        code: 'good_density',
        text: 'Good density. Click ✦ on any bullet to sharpen it, or Tailor to target a specific job.',
      });
    }

    return { tips: tips.slice(0, 4) };
  }
}

export const raResumeAIService = new RAResumeAIService();
export default raResumeAIService;

export const __test = {
  hasFabricatedNumber,
  fallbackBulletRewrite,
  fallbackSummaryOptions,
  fallbackSkills,
  summaryLabelsFor,
};
