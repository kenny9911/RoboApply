// @vitest-environment node
//
// WP-59 production wiring (§2.2): the real `prepAiAvailable` — the user's AI
// consent through the real `aiAllowed` (GoApply needs a live
// `ai_resume_parsing` grant) AND the brand's `ai.text` capability — and a
// PrepService built from `defaultPrepDeps()` makes ZERO model calls (and
// spends no daily limit) when either is off. No database, no model: prisma,
// the agents, the job loader and the rate limiter are mocked; the consent and
// user-brand lookups use their test seams.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  rAInterviewQuestion: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
}));
vi.mock('../../lib/prisma.js', () => ({ default: db }));

const flags = vi.hoisted(() => ({ isEnabled: vi.fn() }));
vi.mock('../../platform/flags.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isEnabled: flags.isEnabled }));

const rate = vi.hoisted(() => ({ consumeRateLimit: vi.fn() }));
vi.mock('../../platform/ratelimit/index.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), consumeRateLimit: rate.consumeRateLimit }));

const model = vi.hoisted(() => ({ setRun: vi.fn(), guideRun: vi.fn() }));
vi.mock('./agents.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  PrepQuestionSetAgent: class {
    run = model.setRun;
  },
  PrepGuideAgent: class {
    run = model.guideRun;
  },
}));

vi.mock('../jobs/detail/index.js', () => ({
  jobDetailService: {
    get: vi.fn(async (_userId: string, jobId: string) => ({
      job: { id: jobId, title: 'Backend Engineer', companyName: 'Acme', sections: [{ body: 'Own database performance.' }], summary: null },
      company: { id: 'co_acme', name: 'Acme', slug: 'acme' },
    })),
  },
}));
vi.mock('../jobs/normalize/index.js', () => ({ normalizeCompanyName: (name: string) => name.trim().toLowerCase() }));
vi.mock('../cn/jobs/index.js', () => ({ cnPostingsWhere: () => undefined }));

import { setConsentLookup } from '../../platform/consent/aiAllowed.js';
import { setUserBrandLookup } from '../../platform/brand/userBrand.js';
import { HttpError } from '../../platform/http.js';
import { defaultPrepDeps, PrepService, prepAiAvailable } from './index.js';

const RA_USER = 'user_ra';
const GA_USER = 'user_ga';
let consent: boolean | null;

const QUESTION = {
  id: 'q1',
  market: 'intl',
  companyId: null,
  companyNameNormalized: null,
  taxonomyId: null,
  category: 'behavioral',
  difficulty: null,
  seniority: null,
  title: 'A hard bug',
  body: 'Tell me about a hard bug you fixed.',
  locale: 'en',
  sourceKind: 'curated',
  reportedPeriod: null,
  contributionId: null,
  guide: null,
  guideModel: null,
  status: 'published',
  reportsCount: 0,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
};

beforeEach(() => {
  for (const fn of [...Object.values(db.rAInterviewQuestion), flags.isEnabled, rate.consumeRateLimit, model.setRun, model.guideRun]) fn.mockReset();
  setUserBrandLookup(async (id) => (id === GA_USER ? 'goapply' : id === RA_USER ? 'roboapply' : null));
  consent = null;
  setConsentLookup(async () => (consent === null ? null : { consentType: 'ai_resume_parsing', granted: consent, createdAt: new Date('2026-10-01T00:00:00Z') }));
  flags.isEnabled.mockResolvedValue(true);
  rate.consumeRateLimit.mockResolvedValue({ allowed: true, retryAfterSec: 0 });
  db.rAInterviewQuestion.findUnique.mockResolvedValue({ ...QUESTION });
  db.rAInterviewQuestion.findMany.mockResolvedValue([]);
});

afterAll(() => {
  setUserBrandLookup(null);
  setConsentLookup(null);
});

async function expectAiUnavailable(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).code).toBe('ai_unavailable');
}

describe('prepAiAvailable (consent AND the ai.text capability)', () => {
  it('GoApply without a live ai_resume_parsing grant: false, before the capability is even read', async () => {
    expect(await prepAiAvailable(GA_USER)).toBe(false);
    consent = false; // revoked
    expect(await prepAiAvailable(GA_USER)).toBe(false);
    expect(flags.isEnabled).not.toHaveBeenCalled();
  });

  it('GoApply with a grant, and RoboApply: follows the ai.text capability for that user', async () => {
    consent = true;
    expect(await prepAiAvailable(GA_USER)).toBe(true);
    expect(await prepAiAvailable(RA_USER)).toBe(true);
    expect(flags.isEnabled).toHaveBeenCalledWith('ai.text', { userId: RA_USER });
    flags.isEnabled.mockResolvedValue(false);
    expect(await prepAiAvailable(GA_USER)).toBe(false);
    expect(await prepAiAvailable(RA_USER)).toBe(false);
  });

  it('an unknown user fails closed', async () => {
    expect(await prepAiAvailable('nobody')).toBe(false);
  });
});

describe('a PrepService built from defaultPrepDeps', () => {
  async function service() {
    return new PrepService(await defaultPrepDeps());
  }

  it('GoApply without consent: zero model calls and no limit spent (job set and guide)', async () => {
    const svc = await service();
    await expectAiUnavailable(svc.generateJobSet(GA_USER, 'job_1', 'zh'));
    await expectAiUnavailable(svc.generateGuide(GA_USER, 'q1', 'zh'));
    expect((await svc.getQuestion(GA_USER, 'q1')).guideStatus).toBe('ai_unavailable');
    expect((await svc.jobSet(GA_USER, 'job_1', 'zh')).status).toBe('ai_unavailable');
    expect(model.setRun).not.toHaveBeenCalled();
    expect(model.guideRun).not.toHaveBeenCalled();
    expect(rate.consumeRateLimit).not.toHaveBeenCalled();
    expect(db.rAInterviewQuestion.create).not.toHaveBeenCalled();
    expect(db.rAInterviewQuestion.update).not.toHaveBeenCalled();
  });

  it('ai.text off (RoboApply): zero model calls', async () => {
    flags.isEnabled.mockResolvedValue(false);
    const svc = await service();
    await expectAiUnavailable(svc.generateJobSet(RA_USER, 'job_1', 'en'));
    await expectAiUnavailable(svc.generateGuide(RA_USER, 'q1', 'en'));
    expect(model.setRun).not.toHaveBeenCalled();
    expect(model.guideRun).not.toHaveBeenCalled();
    expect(rate.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('with consent and ai.text on, the same wiring does reach the model (control)', async () => {
    consent = true;
    const guide = { approach: 'Pick one example.', whatTheyTest: [], commonMistakes: [], rubric: [], followUps: [] };
    model.guideRun.mockResolvedValue(guide);
    db.rAInterviewQuestion.update.mockResolvedValue({ ...QUESTION, guide });
    const svc = await service();
    const detail = await svc.generateGuide(GA_USER, 'q1', 'zh');
    expect(detail.guideStatus).toBe('ready');
    expect(model.guideRun).toHaveBeenCalledTimes(1);
    expect(rate.consumeRateLimit).toHaveBeenCalledTimes(1);
  });
});
