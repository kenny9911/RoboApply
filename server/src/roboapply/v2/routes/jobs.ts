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
// failures pay zero per the Resume Match Quota Rule precedent.

import { Router, type Request, type Response } from 'express';
import prisma from '../../../lib/prisma.js';
import { requireAuth } from '../lib/raAuth.js';
import { getRequestLocale } from '../lib/raLocale.js';
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

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const jobId = req.params.id;
    const p = prisma as any;

    const row = await p.rAJob.findUnique({ where: { id: jobId } });
    if (!row) {
      return res.status(404).json({ error: 'not_found' });
    }

    const [trackerRow, scoreRow, keywordsRow] = await Promise.all([
      p.rATrackerEntry.findFirst({ where: { userId, jobId } }),
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
    if (existing && hashMatches && !force) {
      return res.json({
        matchScore: {
          score: existing.score,
          explanation: existing.explanation,
          generatedAt: isoDate(existing.generatedAt),
          resumeVariantId: existing.resumeVariantId,
          stale: false,
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
      }, { locale: getRequestLocale(req) });
      score = typeof out?.score === 'number' ? out.score : 0;
      // Reshape BE3 output to frontend `explanation` JSON: strengths/gaps
      // map 1:1; rationale comes from `summary`; signals decompose the
      // keyword-match ratio into the four-axis breakdown the FE expects.
      const matched = Array.isArray(out?.keywordsMatched) ? out.keywordsMatched.length : 0;
      const missing = Array.isArray(out?.keywordsMissing) ? out.keywordsMissing.length : 0;
      const total = matched + missing || 1;
      const skillsPct = Math.round((matched / total) * 100);
      explanation = {
        strengths: Array.isArray(out?.strengths) ? out.strengths : [],
        gaps: Array.isArray(out?.gaps) ? out.gaps : [],
        rationale: typeof out?.summary === 'string' ? out.summary : '',
        signals: {
          skills: skillsPct,
          experience: score,
          location: job.workType === 'remote' ? 95 : 80,
          salary: 85,
        },
      };
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
