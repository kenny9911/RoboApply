// backend/src/roboapply/v2/routes/jobs.ts
//
// Mounted at /api/v1/roboapply/v2/jobs.
//
//   GET  /:id            — job detail (with optional matchScore + keywords)
//   POST /:id/apply      — idempotent: flips tracker entry to 'applied'
//   POST /:id/save       — idempotent: ensures a 'bookmarked' tracker entry
//   POST /:id/score      — compute / cache a match score (LLM-backed)
//
// `/score` writes a `ra_match_score` deduction log row on success only —
// failures pay zero per the Resume Match Quota Rule precedent, and a UI
// language switch pays zero too: the score survives it, only the prose is in
// the old language (see the cache gate in POST /:id/score).

import { Router, type Request, type Response } from 'express';
import prisma from '../../../lib/prisma.js';
import { requireAuth } from '../lib/raAuth.js';
import { getRequestLocale, RA_DEFAULT_LOCALE, type RaLocale } from '../lib/raLocale.js';
import { writeDeductionLog } from '../../../lib/matchBilling.js';
import { costPatchFromTally } from '../../../lib/deductionCost.js';
import { getCurrentRequestId } from '../../../lib/requestContext.js';
import { logger } from '../../../services/LoggerService.js';
import { raJobIndexService, toJobView } from '../services/RAJobIndexService.js';
import { pickJobMatchScorerModel } from '../agents/RAJobMatchScorerAgent.js';
import {
  raTrackerService,
  TrackerNotFoundError,
  _internal_toTrackerView,
} from '../services/RATrackerService.js';

const router = Router();

function isoDate(d: any): string {
  if (d instanceof Date) return d.toISOString();
  return String(d);
}

// ── Match-explanation provenance stamp ──────────────────────────────────────
//
// A match explanation is LLM PROSE (rationale / strengths / gaps) written in
// the locale of the request that produced it. The score number is language
// independent; the words are not. With no stamp the cache could not tell, so a
// user who scored a job in English and then switched the UI to Chinese kept
// reading the English rationale forever — and the résumé-hash key never
// changes on a language switch, so nothing ever invalidated it.
//
// The generating locale is stamped INSIDE the existing `RAJobMatchScore.
// explanation` Json column (there is no column for it and none may be added).
// The key is `responseLanguage` — NOT a new name — because that is what
// RACrossBankSearchService already writes and what
// RAOnboardingRecommendService.evaluateCachedScore already reads for the same
// decision. All three write/read the same rows; a second key name would let a
// row be "fresh" for one reader and "stale" for another.
//
// `promptVersion` rides along for the same reason: evaluateCachedScore requires
// BOTH `responseLanguage === locale` AND a non-empty `promptVersion` before it
// returns `fresh`. Stamping only the locale left every row this route wrote
// permanently `scoreOnly` to that reader — it would re-score prose it already
// had. RACrossBankSearchService writes the pair; so do we.
const EXPLANATION_LOCALE_KEY = 'responseLanguage';
const EXPLANATION_PROMPT_VERSION_KEY = 'promptVersion';

// Bumped when the scorer prompt/output reshaping below changes in a way that
// makes older prose not worth reusing. Mirrors RACrossBankSearchService's
// module-local `SCORER_PROMPT_VERSION = 'crossbank_v1'` — same key, same shape,
// different producer, so the two values are deliberately distinct strings.
// (Neither constant is exported today; hoisting them into one shared module is
// the follow-up that would let a reader tell the producers apart by value.)
const SCORER_PROMPT_VERSION = 'v2_jobs_score_v1';

function stampExplanationLocale(explanation: any, locale: RaLocale): any {
  if (!explanation || typeof explanation !== 'object') return explanation;
  return {
    ...explanation,
    [EXPLANATION_LOCALE_KEY]: locale,
    [EXPLANATION_PROMPT_VERSION_KEY]: SCORER_PROMPT_VERSION,
  };
}

/**
 * Is a cached explanation's PROSE in this request's language?
 *
 * Stamped row → only when the languages match.
 * Unstamped row (written before this route stamped anything) → the generating
 * locale is unknowable. Rows from that era are overwhelmingly English (that WAS
 * the bug: this route never passed a locale hint at all until recently), so we
 * trust them for an English reader and treat them as wrong-language for
 * everyone else.
 *
 * NOT aligned with RAOnboardingRecommendService.evaluateCachedScore, and that
 * is deliberate: the two readers share the KEY NAMES (so a row is never fresh
 * for one and stale for the other on a *stamped* row) but not the UNSTAMPED-ROW
 * policy. evaluateCachedScore is strict equality — an unstamped row is never
 * fresh there — because it runs inside a ranking round with its own re-score
 * budget, where a wasted regeneration is bounded. This route is called once per
 * feed row by the client, so "unstamped == miss" would mean a wrong-language
 * verdict for every pre-existing English row and a stale badge on the whole
 * feed. Neither reader can bill on a mismatch any more (see the /score cache
 * policy below), so the divergence costs nothing but a badge.
 * A follow-up that wants one predicate has to export it from a module both can
 * import (evaluateCachedScore's file is the natural home) and decide which
 * unstamped-row policy wins; it cannot be done from this file alone.
 */
function isExplanationLocaleUsable(explanation: any, locale: RaLocale): boolean {
  const stamped =
    explanation && typeof explanation === 'object' && !Array.isArray(explanation)
      ? (explanation as Record<string, unknown>)[EXPLANATION_LOCALE_KEY]
      : null;
  if (typeof stamped === 'string' && stamped) return stamped === locale;
  return locale === RA_DEFAULT_LOCALE;
}

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const jobId = req.params.id;
    const p = prisma as any;

    const row = await p.rAJob.findUnique({ where: { id: jobId } });
    // Seed demo rows are never user-visible — even by direct id, even when
    // archived (fake postings with dead applyUrls). Real archived jobs stay
    // viewable so tracker deep-links keep working.
    if (!row || row.sourceBoard === 'seed') {
      return res.status(404).json({ error: 'not_found' });
    }

    const [trackerRow, scoreRow, keywordsRow] = await Promise.all([
      p.rATrackerEntry.findFirst({ where: { userId, jobId, deletedAt: null } }),
      // If a variant is requested, prefer that specific cached score;
      // otherwise surface the highest-score row for the (user, job).
      req.query.resumeVariantId
        ? p.rAJobMatchScore.findUnique({
            where: {
              userId_jobId_resumeVariantId: {
                userId,
                jobId,
                resumeVariantId: String(req.query.resumeVariantId),
              },
            },
          })
        : p.rAJobMatchScore.findFirst({
            where: { userId, jobId },
            orderBy: { score: 'desc' },
          }),
      p.rAKeywordExtraction.findUnique({ where: { jobId } }),
    ]);

    const includeKeywords =
      req.query.includeKeywords === 'true' || req.query.includeKeywords === '1';
    const userTier = (req.user as any)?.subscriptionTier ?? 'free';
    const isPremium = userTier !== 'free';
    let keywords: any[] | null = null;
    if (includeKeywords && keywordsRow && Array.isArray((keywordsRow as any).keywords)) {
      const all = (keywordsRow as any).keywords as any[];
      keywords = isPremium ? all : all.slice(0, 3);
    }

    // A wrong-language cached explanation is REPORTED, not suppressed. Hiding
    // it used to push the client onto POST /score — which re-ran the scorer and
    // billed for it — for every row in the feed. The number is language neutral
    // and still correct; only the prose is in the previous language. So serve
    // the row and flag it: `stale` still means "the résumé changed under this
    // score", `explanationStale` means "the score stands, the words are in
    // another language". The client decides whether that is worth a
    // regeneration (POST /score with an explicit opt-in).
    let matchScore: any = null;
    if (scoreRow) {
      const variant = await p.rAResumeVariant.findUnique({
        where: { id: (scoreRow as any).resumeVariantId },
        select: { resumeContentHash: true },
      });
      matchScore = {
        score: (scoreRow as any).score,
        explanation: (scoreRow as any).explanation,
        generatedAt: isoDate((scoreRow as any).generatedAt),
        resumeVariantId: (scoreRow as any).resumeVariantId,
        stale: variant
          ? variant.resumeContentHash !== (scoreRow as any).resumeContentHashAtScore
          : false,
        explanationStale: !isExplanationLocaleUsable(
          (scoreRow as any).explanation,
          getRequestLocale(req),
        ),
      };
    }

    let trackerEntry: any = null;
    if (trackerRow) {
      trackerEntry = _internal_toTrackerView(trackerRow, row);
    }

    return res.json({
      job: toJobView(row),
      trackerEntry,
      matchScore,
      keywords,
    });
  } catch (err) {
    logger.error('RA_V2_JOBS', 'get failed', {
      userId: req.user?.id,
      jobId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/:id/apply', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const jobId = req.params.id;
    const body = req.body ?? {};
    const appliedVia =
      body.appliedVia === 'extension' ? 'extension' : 'manual';
    const entry = await raTrackerService.upsertForJob(userId, jobId, {
      status: 'applied',
      appliedVia,
    });
    return res.json({ trackerEntry: entry });
  } catch (err) {
    if (err instanceof TrackerNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    logger.error('RA_V2_JOBS', 'apply failed', {
      userId: req.user?.id,
      jobId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/:id/save', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const jobId = req.params.id;
    const body = req.body ?? {};
    const entry = await raTrackerService.upsertForJob(userId, jobId, {
      status: 'bookmarked',
      excitementStars:
        typeof body.excitementStars === 'number' ? body.excitementStars : undefined,
    });
    return res.json({ trackerEntry: entry });
  } catch (err) {
    if (err instanceof TrackerNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    logger.error('RA_V2_JOBS', 'save failed', {
      userId: req.user?.id,
      jobId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/:id/score', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const jobId = req.params.id;
    const body = req.body ?? {};
    if (typeof body.resumeVariantId !== 'string' || !body.resumeVariantId) {
      return res.status(422).json({ error: 'resumeVariantId required' });
    }
    const force = !!body.force;
    const locale = getRequestLocale(req);
    const p = prisma as any;

    const [job, variant] = await Promise.all([
      p.rAJob.findUnique({ where: { id: jobId } }),
      p.rAResumeVariant.findFirst({
        where: { id: body.resumeVariantId, userId, deletedAt: null },
      }),
    ]);
    if (!job) return res.status(404).json({ error: 'not_found' });
    if (!variant) return res.status(404).json({ error: 'variant_not_found' });

    const existing = await p.rAJobMatchScore.findUnique({
      where: {
        userId_jobId_resumeVariantId: {
          userId,
          jobId,
          resumeVariantId: body.resumeVariantId,
        },
      },
    });
    const hashMatches =
      !!existing && existing.resumeContentHashAtScore === variant.resumeContentHash;
    // The cache is keyed on (user, job, variant) + résumé content hash, but the
    // explanation is PROSE — a row generated for another UI language still has
    // the right NUMBER and the wrong WORDS.
    const localeMatches =
      !!existing && isExplanationLocaleUsable(existing.explanation, locale);
    // A language switch must NOT bill. This endpoint is fired in bulk — the
    // Today feed calls it once per row on mount (MatchFeed's useQueries, which
    // MatchCard's useJobScore then shares) — so treating a locale mismatch as a
    // cache miss meant a zh/ja/ko user's first feed load after a deploy issued
    // N parallel scorer calls and wrote N `ra_match_score` deductions, for
    // scores that were already correct. Same semantics as
    // RAOnboardingRecommendService.evaluateCachedScore's `scoreOnly`: hash
    // matched but locale didn't ⇒ serve the row, mark the prose stale, and
    // regenerate only when the caller explicitly asks.
    //
    // Explicit = `force` (full recompute, already in the wire type) or
    // `regenerateExplanation` (narrow: pay only when the prose is in the wrong
    // language). The bulk path sends neither; the expanded card — one row, one
    // user gesture — is what is meant to send it.
    const proseRegenRequested = force || body.regenerateExplanation === true;
    if (existing && hashMatches && !force && (localeMatches || !proseRegenRequested)) {
      return res.json({
        matchScore: {
          score: existing.score,
          explanation: existing.explanation,
          generatedAt: isoDate(existing.generatedAt),
          resumeVariantId: existing.resumeVariantId,
          stale: false,
          explanationStale: !localeMatches,
        },
        cached: true,
      });
    }

    // Live recompute via BE3's RAJobMatchScorerAgent. Agent output shape
    // (score / summary / strengths / gaps / keywords) is reshaped to match
    // the frontend `RAJobMatchScoreView` contract.
    let score = 0;
    let explanation: any = null;
    const modelUsed = pickJobMatchScorerModel();
    let agentSucceeded = false;
    try {
      const { RAJobMatchScorerAgent } = await import(
        '../agents/RAJobMatchScorerAgent.js'
      );
      const agent = new RAJobMatchScorerAgent();
      const out = await agent.run({
        resumeMarkdown: variant.resumeMarkdown,
        jobTitle: job.title,
        jobDescription: job.description ?? '',
        jobQualifications: job.qualifications ?? '',
        jobBenefits: job.benefits ?? undefined,
      }, { locale });
      score = typeof out?.score === 'number' ? out.score : 0;
      // Reshape BE3 output to frontend `explanation` JSON: strengths/gaps
      // map 1:1; rationale comes from `summary`; signals decompose the
      // keyword-match ratio into the four-axis breakdown the FE expects.
      const matched = Array.isArray(out?.keywordsMatched) ? out.keywordsMatched.length : 0;
      const missing = Array.isArray(out?.keywordsMissing) ? out.keywordsMissing.length : 0;
      const total = matched + missing || 1;
      const skillsPct = Math.round((matched / total) * 100);
      explanation = stampExplanationLocale(
        {
          strengths: Array.isArray(out?.strengths) ? out.strengths : [],
          gaps: Array.isArray(out?.gaps) ? out.gaps : [],
          rationale: typeof out?.summary === 'string' ? out.summary : '',
          signals: {
            skills: skillsPct,
            experience: score,
            location: job.workType === 'remote' ? 95 : 80,
            salary: 85,
          },
        },
        locale,
      );
      agentSucceeded = true;
    } catch (err) {
      // Agent failure -> 502 with zero quota debit (Resume Match Quota Rule).
      logger.error('RA_V2_JOBS', 'score agent failed', {
        userId,
        jobId,
        variantId: body.resumeVariantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(502).json({
        error: 'agent_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const row = await p.rAJobMatchScore.upsert({
      where: {
        userId_jobId_resumeVariantId: {
          userId,
          jobId,
          resumeVariantId: body.resumeVariantId,
        },
      },
      create: {
        userId,
        jobId,
        resumeVariantId: body.resumeVariantId,
        score,
        explanation,
        resumeContentHashAtScore: variant.resumeContentHash,
        modelUsed,
        generatedAt: new Date(),
      },
      update: {
        score,
        explanation,
        resumeContentHashAtScore: variant.resumeContentHash,
        modelUsed,
        generatedAt: new Date(),
      },
    });

    // Denormalised cache on the variant when the score targets this variant's
    // targetJobId (common path: user just tailored for this exact job).
    if (variant.targetJobId === jobId) {
      await p.rAResumeVariant.update({
        where: { id: variant.id },
        data: { matchScoreCached: score },
      });
    }

    if (agentSucceeded) {
      const cost = costPatchFromTally(getCurrentRequestId());
      await writeDeductionLog({
        userId,
        sku: 'ra_match_score',
        source: 'plan',
        platformCostUsd: cost.platformCostUsd,
        units: 1,
        requestId: getCurrentRequestId() ?? null,
        relatedEntityType: 'ra_job',
        relatedEntityId: jobId,
        metadata: {
          ...cost.metadata,
          source: 'roboapply_v2',
          agent: 'RAJobMatchScorerAgent',
          resumeVariantId: body.resumeVariantId,
          cached: false,
          // Which cache verdict paid for this call. `locale_regen` is the one
          // the bulk feed path must never produce — if it shows up in volume,
          // something is sending the opt-in flag on mount again.
          reason: !existing
            ? 'first_score'
            : !hashMatches
              ? 'resume_changed'
              : force
                ? 'forced'
                : 'locale_regen',
        },
      });
    }

    return res.json({
      matchScore: {
        score: row.score,
        explanation: row.explanation,
        generatedAt: isoDate(row.generatedAt),
        resumeVariantId: row.resumeVariantId,
        stale: false,
        // Just generated for `locale`, by definition.
        explanationStale: false,
      },
      cached: false,
    });
  } catch (err) {
    logger.error('RA_V2_JOBS', 'score failed', {
      userId: req.user?.id,
      jobId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
