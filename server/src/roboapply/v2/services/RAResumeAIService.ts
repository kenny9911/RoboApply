// backend/src/roboapply/v2/services/RAResumeAIService.ts
//
// RoboApply V3 — inline resume-AI service. Backs the three editor surfaces:
//
//   rewrite(userId, id, body)    → ResumeRewriteResponse  (bullet | summary | skills)
//   tailorDiff(userId, id, body) → ResumeTailorDiffResponse
//   coachTips(userId, id)        → ResumeCoachTipsResponse
//
// Shapes match `roboapply/lib/api/v2/types.ts` exactly (and the stub in
// `roboapply/lib/stub/raV2.stub.ts`). The frontend + `_real.ts` need no
// change once the route swaps from stub-delegation to a real fetch.
//
// LLM ops:
//   - rewrite + tailorDiff are LLM-backed → write `ra_resume_tailor` SKU on
//     SUCCESS only (audit-only debit, mirroring RAResumeService). Failures /
//     graceful-fallbacks pay zero.
//   - coachTips is FREE — a deterministic heuristic pass over the resume
//     markdown (no LLM call, no debit). The contract allows free/cheap here
//     and a deterministic pass is the most robust + cheapest option.
//
// Graceful degradation: when the LLM is not configured / errors / returns an
// unparseable shape, every method still returns a VALID response shape via a
// deterministic fallback, so the swap-path + smoke test never see a 500 for
// a missing key. The fallback path does NOT write a deduction log.
//
// Ownership: every method loads the variant scoped to `{ id, userId }` and
// 404s otherwise (single-user product — no team scope; see raVisibility.ts).

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
import { RAResumeTailorAgent } from '../agents/RAResumeTailorAgent.js';
import { RAJobMatchScorerAgent } from '../agents/RAJobMatchScorerAgent.js';
import { getResumeAIMessages, format } from '../lib/raResumeAIMessages.js';

// ─── Public wire types (mirror lib/api/v2/types.ts) ───────────────────────

export type RATailorChangeKind = 'rewrite' | 'add' | 'reorder' | 'trim';

export interface RATailorChange {
  id: string;
  section: string;
  kind: RATailorChangeKind;
  label: string;
  before?: string;
  after?: string;
  added?: string[];
  detail?: string;
}

export interface RATailorDiff {
  jobId: string | null;
  companyName: string;
  roleTitle: string;
  matchBefore: number;
  matchAfter: number;
  /** True when matchAfter is a heuristic estimate rather than a real re-score
   *  of the tailored resume (see resolveTailorScores). The UI can label it. */
  estimated: boolean;
  changes: RATailorChange[];
}

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

export interface ResumeTailorDiffResult {
  diff: RATailorDiff;
  /** The agent's tailored resume markdown the diff was computed from. Returned
   *  so "Apply" persists exactly this (per the user's selections) without a
   *  second LLM re-tailor. */
  tailoredResumeMarkdown: string;
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

export interface TailorDiffInput {
  targetJobId?: string;
  jdText?: string;
}

// ─── Errors ───────────────────────────────────────────────────────────────

export class ResumeNotFoundError extends Error {
  constructor() {
    super('Resume not found');
    this.name = 'ResumeNotFoundError';
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
      // Keep the first sentence / clause.
      const firstClause = base.split(/[.;。；]/)[0]?.trim();
      return firstClause ? `${firstClause}.` : base || m.bulletEmpty.shorten;
    }
    case 'metrics':
      return base
        ? `${stripTrailing(base)}${m.bulletMetricsSuffix}`
        : m.bulletEmpty.metrics;
    case 'expand':
      return base
        ? `${stripTrailing(base)}${m.bulletExpandSuffix}`
        : m.bulletEmpty.expand;
    case 'confident':
      return base
        ? base.replace(/\b(helped|assisted|involved in|worked on)\b/gi, 'led').replace(/^./, (c) => c.toUpperCase())
        : m.bulletEmpty.confident;
    case 'junior':
      return base
        ? `${m.bulletJuniorPrefix}${base.charAt(0).toLowerCase()}${base.slice(1)}`
        : m.bulletEmpty.junior;
    case 'improve':
    default:
      return base
        ? base.replace(/^./, (c) => c.toUpperCase()).replace(/([^.!?])$/, '$1.')
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

// ─── Tailor-diff derivation (deterministic from base→tailored markdown) ────

interface MdSection {
  heading: string;
  lines: string[];
}

/** Split markdown into `## heading` sections. Lines before the first heading
 *  go into a synthetic "Header" section. */
function splitSections(md: string): MdSection[] {
  const lines = (md || '').split('\n');
  const sections: MdSection[] = [];
  let current: MdSection = { heading: 'Header', lines: [] };
  for (const line of lines) {
    const h = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (h) {
      if (current.lines.length > 0 || current.heading !== 'Header') sections.push(current);
      current = { heading: h[1].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections.filter((s) => s.heading || s.lines.some((l) => l.trim()));
}

function bulletsOf(section: MdSection): string[] {
  return section.lines
    .filter((l) => /^\s*[-*•]\s+/.test(l))
    .map((l) => l.replace(/^\s*[-*•]\s+/, '').trim())
    .filter(Boolean);
}

/** Normalize a line for loose equality (ignore case + whitespace + trailing punctuation). */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').trim();
}

/**
 * Build a structured list of changes by comparing the base and tailored
 * markdown section-by-section. This is intentionally heuristic — the goal is
 * a readable, toggleable changelog, not a byte-perfect diff. The tailor
 * agent's prose `changeSummary` is used as a fallback "rationale" detail when
 * the structural diff is thin.
 */
function deriveChanges(
  baseMd: string,
  tailoredMd: string,
  changeSummary: string,
  locale?: string,
): RATailorChange[] {
  // Localized label/detail templates — these strings ship to the client
  // pre-rendered inside RATailorDiff.changes[], so the frontend bundles cannot
  // translate them; they must come back in the request locale. See
  // raResumeAIMessages.ts (en fallback for es/fr/pt/de).
  const m = getResumeAIMessages(locale);
  const baseSections = splitSections(baseMd);
  const tailoredSections = splitSections(tailoredMd);
  const baseByHeading = new Map<string, MdSection>();
  for (const s of baseSections) baseByHeading.set(norm(s.heading), s);

  const changes: RATailorChange[] = [];
  let counter = 0;
  const nextId = () => `c${++counter}`;

  for (const tSec of tailoredSections) {
    const bSec = baseByHeading.get(norm(tSec.heading));
    const tBullets = bulletsOf(tSec);
    const bBullets = bSec ? bulletsOf(bSec) : [];

    if (!bSec) {
      // Whole section is new in the tailored resume → an "add".
      if (tBullets.length > 0 || tSec.lines.some((l) => l.trim())) {
        changes.push({
          id: nextId(),
          section: tSec.heading,
          kind: 'add',
          label: format(m.tailorChangeAddSection, { heading: tSec.heading }),
          added: tBullets.slice(0, 6),
        });
      }
      continue;
    }

    // Rewrites: a base bullet whose normalized text changed but a near-match
    // exists (same leading words) is a 'rewrite'; we pair by index for the
    // first N changed bullets.
    const bNorm = bBullets.map(norm);
    const tNorm = tBullets.map(norm);
    const pairCount = Math.min(bBullets.length, tBullets.length);
    let sectionRewrites = 0;
    for (let i = 0; i < pairCount && sectionRewrites < 2; i++) {
      if (bNorm[i] !== tNorm[i] && bBullets[i] && tBullets[i]) {
        changes.push({
          id: nextId(),
          section: tSec.heading,
          kind: 'rewrite',
          label: format(m.tailorChangeReword, { heading: tSec.heading }),
          before: bBullets[i],
          after: tBullets[i],
        });
        sectionRewrites++;
      }
    }

    // Added bullets (tailored has more, and they're not in base).
    if (tBullets.length > bBullets.length) {
      const addedBullets = tBullets.filter((tb) => !bNorm.includes(norm(tb))).slice(0, 5);
      if (addedBullets.length > 0) {
        changes.push({
          id: nextId(),
          section: tSec.heading,
          kind: 'add',
          label: format(m.tailorChangeSurface, { n: addedBullets.length }),
          added: addedBullets,
        });
      }
    }

    // Trimmed bullets (base has more).
    if (bBullets.length > tBullets.length) {
      const droppedCount = bBullets.length - tBullets.length;
      changes.push({
        id: nextId(),
        section: tSec.heading,
        kind: 'trim',
        label: format(m.tailorChangeTrim, { n: droppedCount, heading: tSec.heading }),
        detail: m.tailorChangeTrimDetail,
      });
    }

    // Reorder: same set of bullets, different order.
    if (
      bBullets.length === tBullets.length &&
      bBullets.length > 1 &&
      sectionRewrites === 0 &&
      [...bNorm].sort().join('|') === [...tNorm].sort().join('|') &&
      bNorm.join('|') !== tNorm.join('|')
    ) {
      changes.push({
        id: nextId(),
        section: tSec.heading,
        kind: 'reorder',
        label: format(m.tailorChangeReorder, { heading: tSec.heading }),
        detail: m.tailorChangeReorderDetail,
      });
    }
  }

  // If the structural diff found nothing (e.g. the tailor agent rewrote
  // prose without changing bullet structure), synthesize a single rewrite
  // entry from the agent's change summary so the panel is never empty.
  if (changes.length === 0) {
    const summary = (changeSummary || '').trim();
    changes.push({
      id: nextId(),
      section: m.tailorChangeFallbackSection,
      kind: 'rewrite',
      label: m.tailorChangeFallback,
      // `summary` is the tailor agent's own prose, already produced in the
      // request locale via its getLocaleDirective — keep it when present.
      detail: summary || m.tailorChangeFallbackDetail,
    });
  }

  return changes.slice(0, 12);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Apply the user's per-change selections to the tailored markdown produced by
 * the tailor preview, so "Apply" persists exactly what the user accepted —
 * deterministically, with NO second LLM call (the old apply re-ran the agent,
 * double-charging and producing a different resume than the one previewed).
 *
 * `acceptedIds === null` means accept-all (the default → return unchanged).
 * Otherwise each DESELECTED change is reverted in the tailored markdown:
 *   - rewrite → swap the `after` text back to `before`
 *   - add     → remove the added bullet line(s)
 *   - trim / reorder → kept (the heuristic diff carries no before-state to
 *     reverse them; documented limitation, surfaced in the UI as non-toggleable)
 * Pure + exported for the acceptance oracle.
 */
export function applyTailorSelections(
  tailoredMarkdown: string,
  changes: RATailorChange[],
  acceptedIds: string[] | null,
): string {
  if (!acceptedIds) return tailoredMarkdown;
  const accepted = new Set(acceptedIds);
  let md = tailoredMarkdown;
  for (const c of changes) {
    if (accepted.has(c.id)) continue; // change kept — already in tailoredMarkdown
    if (c.kind === 'rewrite' && c.before && c.after && md.includes(c.after)) {
      md = md.replace(c.after, c.before);
    } else if (c.kind === 'add' && Array.isArray(c.added)) {
      for (const line of c.added) {
        const re = new RegExp(`^[ \\t]*[-*•][ \\t]*${escapeRegExp(line)}[ \\t]*\\r?\\n?`, 'm');
        md = md.replace(re, '');
      }
    }
  }
  return md.replace(/\n{3,}/g, '\n\n');
}

// ─── Match-score estimation for the diff (matchBefore / matchAfter) ────────
//
// Running TWO full match-scorer passes (base + tailored) would double the
// cost of a tailor-diff. Instead we read any cached base score and estimate
// the tailored lift from how much structurally changed — deterministic, and
// good enough for the editor's "72 → 94" affordance. If no cached score
// exists, we derive a stable pseudo-score from the (resume, job) pair so the
// same call always returns the same numbers.

function hashToRange(seed: string, min: number, max: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return min + (h % (max - min + 1));
}

function estimateScores(
  cachedBase: number | null,
  changeCount: number,
  seed: string,
): { matchBefore: number; matchAfter: number } {
  const matchBefore =
    typeof cachedBase === 'number' && cachedBase >= 0 && cachedBase <= 100
      ? Math.round(cachedBase)
      : hashToRange(seed + ':before', 58, 78);
  // Each material change is worth a few points, capped so we never claim 100.
  const lift = Math.min(22, 4 + changeCount * 3);
  const matchAfter = Math.min(97, matchBefore + lift);
  return { matchBefore, matchAfter };
}

export interface TailorScoreResult {
  matchBefore: number;
  matchAfter: number;
  /** True when matchAfter is the deterministic heuristic estimate; false when
   *  it is a REAL re-score of the tailored resume through the match scorer. */
  estimated: boolean;
}

/**
 * Resolve the tailor-diff's matchBefore / matchAfter.
 *
 * Cost-capped honesty: when we already hold a REAL cached base score (the
 * job-detail score panel populates it) AND the tailor produced real tailored
 * markdown against a real JD, we re-score ONLY the tailored resume (one extra
 * scorer call) for a genuine matchAfter — `estimated: false`. Otherwise (no
 * cached base, no job context, tailor/​scorer failure) we fall back to the
 * deterministic heuristic and honestly flag `estimated: true` rather than
 * present a fabricated uplift as a real ATS score.
 *
 * `rescoreTailored` is injected so this decision logic is unit-testable
 * without an LLM (see __test). It is only invoked on the real-score path.
 */
export async function resolveTailorScores(opts: {
  cachedBase: number | null;
  agentSucceeded: boolean;
  hasJobContext: boolean;
  changeCount: number;
  seed: string;
  rescoreTailored: () => Promise<number>;
}): Promise<TailorScoreResult> {
  const { cachedBase, agentSucceeded, hasJobContext, changeCount, seed, rescoreTailored } = opts;
  const haveRealBase =
    typeof cachedBase === 'number' && cachedBase >= 0 && cachedBase <= 100;
  if (agentSucceeded && hasJobContext && haveRealBase) {
    try {
      const matchAfter = await rescoreTailored();
      if (typeof matchAfter === 'number' && Number.isFinite(matchAfter)) {
        return {
          matchBefore: Math.round(cachedBase as number),
          matchAfter: Math.max(0, Math.min(100, Math.round(matchAfter))),
          estimated: false,
        };
      }
    } catch {
      /* fall through to the estimate below */
    }
  }
  const est = estimateScores(cachedBase, changeCount, seed);
  return { ...est, estimated: true };
}

/** Detect a fabricated concrete number: a digit-run in `out` (excluding
 *  bracketed placeholders + plausible years) that does NOT appear in `src`.
 *  Used to reject a hallucinated metric and fall back deterministically. */
function hasFabricatedNumber(src: string, out: string): boolean {
  // Strip bracketed placeholders like [X], [n=__], [before → after].
  const stripped = out.replace(/\[[^\]]*\]/g, ' ');
  const runs = stripped.match(/\d+(?:[.,]\d+)?/g) ?? [];
  for (const run of runs) {
    const plain = run.replace(/[.,]/g, '');
    const asNum = Number(plain);
    if (Number.isFinite(asNum) && asNum >= 1990 && asNum <= 2099) continue; // year
    if (!src.includes(run)) return true;
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

  /** Resolve job context for tailor / rewrite bias. */
  private async loadJob(jobId: string): Promise<any | null> {
    const p = prisma as any;
    return p.rAJob.findUnique({ where: { id: jobId } });
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

    // Optional job context to bias the rewrite.
    let jobContext: { title?: string; description?: string } | undefined;
    if (body.targetJobId) {
      const job = await this.loadJob(body.targetJobId);
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
          resumeMarkdown: variant.resumeMarkdown ?? '',
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

  // ── tailorDiff ──
  async tailorDiff(userId: string, id: string, body: TailorDiffInput, locale?: string): Promise<ResumeTailorDiffResult> {
    if (!body || (!body.targetJobId && !body.jdText)) {
      throw new RewriteValidationError('targetJobId or jdText is required');
    }

    const variant = await this.loadOwnedVariant(userId, id);
    const baseMd = variant.resumeMarkdown ?? '';

    // Resolve job context + cached base score.
    let companyName = 'Pasted JD';
    let roleTitle = 'Target role';
    let jobId: string | null = null;
    let jobTitle = 'Target role';
    let jobDescription = body.jdText ?? '';
    let parsedJD: { qualifications?: string; responsibilities?: string; benefits?: string } | undefined;
    let cachedBase: number | null = null;

    if (body.targetJobId) {
      const job = await this.loadJob(body.targetJobId);
      if (job) {
        jobId = job.id;
        companyName = job.companyName ?? companyName;
        roleTitle = job.title ?? roleTitle;
        jobTitle = job.title ?? jobTitle;
        jobDescription = job.descriptionPlain ?? job.description ?? '';
        parsedJD = {
          qualifications: job.qualifications ?? undefined,
          responsibilities: job.responsibilities ?? undefined,
          benefits: job.benefits ?? undefined,
        };
        // Read a cached match score for matchBefore (if present).
        try {
          const p = prisma as any;
          const scoreRow = await p.rAJobMatchScore.findUnique({
            where: {
              userId_jobId_resumeVariantId: {
                userId,
                jobId: job.id,
                resumeVariantId: id,
              },
            },
          });
          if (scoreRow && typeof scoreRow.score === 'number') cachedBase = scoreRow.score;
        } catch {
          /* no cached score — estimate below */
        }
      }
    }

    const requestId = getCurrentRequestId() ?? undefined;
    const seed = `${id}:${jobId ?? (body.jdText ?? '').slice(0, 32)}`;
    let agentSucceeded = false;
    let tailoredMd = baseMd;
    let changeSummary = '';

    try {
      const agent = new RAResumeTailorAgent();
      const out = await agent.run(
        {
          baseResumeMarkdown: baseMd,
          jobTitle,
          jobDescription,
          parsedJD,
          complexity: 'standard',
        },
        { requestId, locale },
      );
      if (out && out.tailoredResumeMarkdown && out.tailoredResumeMarkdown.trim()) {
        tailoredMd = out.tailoredResumeMarkdown;
        changeSummary = out.changeSummary ?? '';
        agentSucceeded = true;
      }
    } catch (err) {
      logger.warn('RA_V2_RESUME_AI', 'tailor agent failed; deterministic diff fallback', {
        userId,
        resumeId: id,
        targetJobId: body.targetJobId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall through to deterministic diff against the unchanged base.
    }

    const changes = deriveChanges(baseMd, tailoredMd, changeSummary, locale);

    // Real matchAfter: re-score the tailored resume through the match scorer
    // when we already hold a real cached base score (cost-capped to +1 call);
    // otherwise fall back to the labeled estimate. The scorer shares requestId
    // so its tokens roll into the single ra_resume_tailor cost — no extra debit.
    const { matchBefore, matchAfter, estimated } = await resolveTailorScores({
      cachedBase,
      agentSucceeded,
      hasJobContext: jobDescription.trim().length > 0,
      changeCount: changes.length,
      seed,
      rescoreTailored: async () => {
        const scorer = new RAJobMatchScorerAgent();
        const out = await scorer.run(
          {
            resumeMarkdown: tailoredMd,
            jobTitle,
            jobDescription,
            jobQualifications: parsedJD?.qualifications ?? '',
            jobBenefits: parsedJD?.benefits,
          },
          { requestId, locale },
        );
        return out.score;
      },
    });

    const diff: RATailorDiff = {
      jobId,
      companyName,
      roleTitle,
      matchBefore,
      matchAfter,
      estimated,
      changes,
    };

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
          agent: 'RAResumeTailorAgent',
          op: 'tailor_diff',
          targetJobId: body.targetJobId ?? null,
          changeCount: changes.length,
        },
      });
    }

    logger.info('RA_V2_RESUME_AI', 'tailorDiff complete', {
      userId,
      resumeId: id,
      jobId,
      agentSucceeded,
      changeCount: changes.length,
    });
    return { diff, tailoredResumeMarkdown: tailoredMd };
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
  splitSections,
  bulletsOf,
  deriveChanges,
  estimateScores,
  hasFabricatedNumber,
  fallbackBulletRewrite,
  fallbackSummaryOptions,
  fallbackSkills,
  summaryLabelsFor,
  resolveTailorScores,
  applyTailorSelections,
};
