// @vitest-environment node
//
// POST /v2/resumes/:id/rewrite charges only for text a model wrote.
//
// The rewrite service never throws when the model fails: on a provider error,
// on a rewrite with a made-up number (its citation guard) and on an empty
// answer it returns a fixed fallback ("valid shape, no debit"). The route
// wrapped the call in `withCredit`, which commits whenever the call resolves,
// so each of those spent one of the day's 20 rewrite credits on canned text.
//
// Through the real route, the REAL RAResumeAIService and the platform credit
// service (test kit). Faked: the rewrite agent (no model), the resume row,
// auth, the audit-log writer. No network beyond 127.0.0.1, no database.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const RESUME_MD = ['# Maya Lindqvist', '## Skills', 'SQL, Tableau, Excel', '## Experience', '- Worked on dashboards for 12 dispatch managers.', ''].join('\n');

const m = vi.hoisted(() => ({ kit: null as any, agentRun: vi.fn(), deductionLog: vi.fn(async () => undefined) }));

vi.mock('../../../lib/prisma.js', () => ({
  default: {
    rAResumeVariant: {
      findFirst: vi.fn(async ({ where }: Row) => (where.id === 'rv_1' && where.userId === 'u1' ? { id: 'rv_1', userId: 'u1', name: 'Main', resumeMarkdown: RESUME_MD, deletedAt: null } : null)),
    },
  },
}));
vi.mock('../lib/raAuth.js', () => ({
  requireAuth: (req: Row, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', subscriptionTier: 'free' };
    next();
  },
}));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../services/llm/LLMService.js', () => ({ llmService: { chat: vi.fn(), getModel: () => 'test-model' }, LLMService: class {} }));
vi.mock('../agents/RAResumeRewriteAgent.js', () => ({
  RAResumeRewriteAgent: class {
    run = (...args: unknown[]) => m.agentRun(...args);
  },
}));
vi.mock('../../../features/resume/index.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resumeAiAvailable: async () => true,
}));
// The GoApply phone gate in front of the route (covered in resumes.rewriteCredit.test.ts): open here.
vi.mock('../../../features/auth-cn/index.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  requirePhoneBound: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../lib/matchBilling.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  writeDeductionLog: m.deductionLog,
}));
vi.mock('../../../lib/deductionCost.js', () => ({
  costPatchFromTally: () => ({ platformCostUsd: 0, metadata: {} }),
}));
vi.mock('../../../platform/credits/index.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    get creditService() {
      return m.kit.credits;
    },
  };
});
vi.mock('../../../features/compliance/index.js', () => ({ registerArtifactStorageDeleter: vi.fn(), complianceService: {} }));
vi.mock('../../services/SeekerAccountPurgeService.js', () => ({ setArtifactStorageDeleter: vi.fn() }));
vi.mock('../../../lib/candidateResumeIngest.js', () => ({
  isAcceptedResumeUpload: () => true,
  readCandidateResumeOriginal: vi.fn(),
  ingestCandidateResume: vi.fn(),
  CandidateResumeIngestError: class extends Error {},
}));

import { runWithBrand } from '../../../lib/requestContext.js';
import { createCreditTestKit } from '../../../platform/credits/testkit.js';
import { __test as fallbacks } from '../services/RAResumeAIService.js';

let server: Server;
let base: string;

beforeAll(async () => {
  m.kit = createCreditTestKit();
  const express = (await import('express')).default;
  const router = ((await import('./resumes.js')) as { default: import('express').Router }).default;
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runWithBrand('roboapply', next));
  app.use('/resumes', router);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/resumes`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  m.kit.store.ledger.length = 0;
  m.kit.store.windows.length = 0;
  m.agentRun.mockReset();
  m.deductionLog.mockClear();
});

const post = async (body: Row, id = 'rv_1') => {
  const res = await fetch(`${base}/${id}/rewrite`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  if (text.startsWith('<')) throw new Error(text.replace(/<[^>]+>/g, ' ').slice(0, 600));
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : null };
};
const committed = () => (m.kit.store.ledger as Row[]).filter((r) => r.bucket === 'rewrite' && r.status === 'committed');
const usage = async () => (await m.kit.credits.usage('u1')).find((u: Row) => u.bucket === 'rewrite') as Row;
const expectNothingSpent = async () => {
  expect(committed()).toHaveLength(0);
  const u = await usage();
  expect([u.used, u.reserved]).toEqual([0, 0]);
  expect(m.deductionLog).not.toHaveBeenCalled();
};

const BULLET = { mode: 'bullet', action: 'improve', text: 'worked on dashboards' };

describe('POST /v2/resumes/:id/rewrite: the canned fallback is free', () => {
  it('the model fails (provider down): the fallback text comes back and no credit is spent', async () => {
    m.agentRun.mockRejectedValue(new Error('provider down'));
    const res = await post(BULLET);
    expect(res.status).toBe(200);
    // The standard rewording is free and labelled: `source: 'fallback'`.
    expect(res.body).toEqual({ rewrite: fallbacks.fallbackBulletRewrite('worked on dashboards', 'improve', undefined), source: 'fallback' });
    expect(m.agentRun).toHaveBeenCalledTimes(1);
    await expectNothingSpent();
  });

  it('every bullet action and both other modes: a failing model never costs a credit', async () => {
    m.agentRun.mockRejectedValue(new Error('timeout'));
    for (const action of ['improve', 'metrics', 'shorten', 'expand', 'confident', 'junior']) {
      expect((await post({ mode: 'bullet', action, text: 'helped with dashboards for the team' })).status, action).toBe(200);
    }
    const summary = await post({ mode: 'summary', text: 'Data analyst with 4 years in logistics.' });
    expect(summary.body!.options).toHaveLength(3);
    const skills = await post({ mode: 'skills' });
    expect(skills.body).toEqual({ skills: fallbacks.fallbackSkills(RESUME_MD, undefined), source: 'fallback' });
    await expectNothingSpent();
  });

  it('a rewrite with a number the bullet does not have is rejected, replaced by the fallback, and free', async () => {
    m.agentRun.mockResolvedValue({ rewrite: 'Built dashboards that cut reporting time by 40%.' });
    const res = await post(BULLET);
    expect(res.status).toBe(200);
    expect(res.body!.rewrite).not.toContain('40%');
    await expectNothingSpent();
  });

  it('an empty answer (no rewrite, no options, no skills) is free', async () => {
    m.agentRun.mockResolvedValue({});
    expect((await post(BULLET)).status).toBe(200);
    expect((await post({ mode: 'summary', text: 'Analyst.' })).status).toBe(200);
    expect((await post({ mode: 'skills' })).status).toBe(200);
    await expectNothingSpent();
  });

  it('text the model wrote costs one credit each, in every mode', async () => {
    m.agentRun.mockResolvedValueOnce({ rewrite: 'Built dashboards used by 12 dispatch managers.' });
    const bullet = await post({ mode: 'bullet', action: 'improve', text: 'Worked on dashboards for 12 dispatch managers.' });
    expect(bullet.body).toEqual({ rewrite: 'Built dashboards used by 12 dispatch managers.', source: 'model' });
    expect(committed()).toHaveLength(1);

    m.agentRun.mockResolvedValueOnce({ options: ['Analyst who builds delivery dashboards.', 'Logistics data analyst.', 'Analyst, dashboards and SQL.'] });
    const summary = await post({ mode: 'summary', text: 'Analyst.' });
    expect(summary.body!.options.map((o: Row) => o.text)).toEqual(['Analyst who builds delivery dashboards.', 'Logistics data analyst.', 'Analyst, dashboards and SQL.']);

    m.agentRun.mockResolvedValueOnce({ skills: ['SQL', 'Tableau', 'Dashboard design'] });
    const skills = await post({ mode: 'skills' });
    expect(skills.body).toEqual({ skills: ['SQL', 'Tableau', 'Dashboard design'], source: 'model' });

    expect(committed()).toHaveLength(3);
    expect((await usage()).used).toBe(3);
    expect(m.deductionLog).toHaveBeenCalledTimes(3);
  });

  it('after a free fallback the same day’s allowance is intact', async () => {
    const cap = (await usage()).cap as number;
    m.agentRun.mockRejectedValue(new Error('provider down'));
    for (let i = 0; i < cap + 2; i += 1) expect((await post(BULLET)).status).toBe(200);
    await expectNothingSpent();
    m.agentRun.mockReset().mockResolvedValue({ rewrite: 'Built dashboards for the dispatch team.' });
    expect((await post(BULLET)).status).toBe(200);
    expect(committed()).toHaveLength(1);
  });
});
