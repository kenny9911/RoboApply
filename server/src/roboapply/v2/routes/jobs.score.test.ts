import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const CURRENT_MODEL = 'openrouter/openai/gpt-5.6-luna';

const mocks = vi.hoisted(() => ({
  existing: null as Record<string, unknown> | null,
  agentRun: vi.fn(),
  scoreUpsert: vi.fn(),
  variantUpdate: vi.fn(),
  writeDeductionLog: vi.fn(),
}));

vi.mock('../../../lib/prisma.js', () => ({
  default: {
    rAJob: {
      findUnique: vi.fn(async () => ({
        id: 'job1',
        title: 'Backend Engineer',
        description: 'Build APIs.',
        qualifications: 'TypeScript',
        benefits: null,
        workType: 'remote',
      })),
    },
    rAResumeVariant: {
      findFirst: vi.fn(async () => ({
        id: 'variant1',
        userId: 'user1',
        resumeMarkdown: '# Ada\nTypeScript',
        resumeContentHash: 'resume-hash',
        targetJobId: null,
      })),
      update: (...args: unknown[]) => mocks.variantUpdate(...args),
    },
    rAJobMatchScore: {
      findUnique: vi.fn(async () => mocks.existing),
      upsert: (...args: unknown[]) => mocks.scoreUpsert(...args),
    },
  },
}));

vi.mock('../lib/raAuth.js', () => ({
  requireAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.user = { id: 'user1', subscriptionTier: 'free' };
    next();
  },
}));

vi.mock('../lib/raLocale.js', () => ({
  RA_DEFAULT_LOCALE: 'en',
  getRequestLocale: () => 'en',
}));

vi.mock('../agents/RAJobMatchScorerAgent.js', () => ({
  resolvedJobMatchScorerModel: () => CURRENT_MODEL,
  RAJobMatchScorerAgent: class {
    run(...args: unknown[]) {
      return mocks.agentRun(...args);
    }
  },
}));

vi.mock('../../../lib/matchBilling.js', () => ({
  writeDeductionLog: (...args: unknown[]) => mocks.writeDeductionLog(...args),
}));

vi.mock('../../../lib/deductionCost.js', () => ({
  costPatchFromTally: () => ({ platformCostUsd: 0.01, metadata: {} }),
}));

vi.mock('../../../lib/requestContext.js', () => ({
  getCurrentRequestId: () => 'request1',
}));

vi.mock('../../../services/LoggerService.js', () => ({
  logger: { error: vi.fn() },
}));

vi.mock('../services/RAJobIndexService.js', () => ({
  raJobIndexService: {},
  toJobView: (row: unknown) => row,
}));

vi.mock('../services/RATrackerService.js', () => ({
  raTrackerService: {},
  TrackerNotFoundError: class extends Error {},
  _internal_toTrackerView: vi.fn(),
}));

describe('POST /jobs/:id/score model-aware cache', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const express = (await import('express')).default;
    const router = (await import('./jobs.js')).default;
    const app = express();
    app.use(express.json());
    app.use('/jobs', router);
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existing = null;
    mocks.agentRun.mockResolvedValue({
      score: 82,
      summary: 'Strong fit.',
      strengths: ['TypeScript'],
      gaps: [],
      keywordsMatched: ['TypeScript'],
      keywordsMissing: [],
    });
    mocks.scoreUpsert.mockImplementation(async (args: Record<string, any>) => ({
      ...args.update,
      resumeVariantId: 'variant1',
      generatedAt: new Date('2026-08-13T00:00:00.000Z'),
    }));
    mocks.writeDeductionLog.mockResolvedValue(undefined);
  });

  async function postScore(): Promise<{ status: number; body: any }> {
    const response = await fetch(`${baseUrl}/jobs/job1/score`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resumeVariantId: 'variant1' }),
    });
    return { status: response.status, body: await response.json() };
  }

  it('recomputes an old-model row and persists the current model', async () => {
    mocks.existing = {
      score: 94,
      resumeVariantId: 'variant1',
      resumeContentHashAtScore: 'resume-hash',
      modelUsed: 'anthropic/claude-sonnet-4.6',
      explanation: { responseLanguage: 'en', promptVersion: 'old' },
      generatedAt: new Date('2026-08-12T00:00:00.000Z'),
    };

    const result = await postScore();

    expect(result.status).toBe(200);
    expect(result.body.cached).toBe(false);
    expect(mocks.agentRun).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ model: CURRENT_MODEL }),
    );
    expect(mocks.scoreUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ modelUsed: CURRENT_MODEL }),
      update: expect.objectContaining({ modelUsed: CURRENT_MODEL }),
    }));
    expect(mocks.writeDeductionLog).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ reason: 'model_changed' }),
    }));
  });

  it('keeps a same-model, same-hash row cached', async () => {
    mocks.existing = {
      score: 94,
      resumeVariantId: 'variant1',
      resumeContentHashAtScore: 'resume-hash',
      modelUsed: CURRENT_MODEL,
      explanation: { responseLanguage: 'en', promptVersion: 'current' },
      generatedAt: new Date('2026-08-12T00:00:00.000Z'),
    };

    const result = await postScore();

    expect(result.status).toBe(200);
    expect(result.body.cached).toBe(true);
    expect(mocks.agentRun).not.toHaveBeenCalled();
    expect(mocks.scoreUpsert).not.toHaveBeenCalled();
    expect(mocks.writeDeductionLog).not.toHaveBeenCalled();
  });
});
