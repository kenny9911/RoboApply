// @vitest-environment node
//
// MKT-2F: the Ready to apply list reads THE fit (match/fit.ts `getFits`), live,
// through the production seam `defaultAgentDeps().fitsFor`:
//   - the same score, tier and kind as the feed card and the job page (I1);
//   - an AI fit when one is stored, never an estimate next to it (I2);
//   - on GoApply no fit is read without a live 个性化推荐 grant;
//   - never a model call: the only match function it calls is the list read.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  personalized: vi.fn(async (_userId: string, _market: string) => true),
  getFits: vi.fn(),
  getFit: vi.fn(),
  scoreJob: vi.fn(),
  preScoreMany: vi.fn(),
}));

vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../feed/index.js', () => ({ isFeedPersonalized: (userId: string, market: string) => m.personalized(userId, market) }));
vi.mock('../../match/index.js', () => ({
  getFits: (...args: unknown[]) => m.getFits(...args),
  getFit: (...args: unknown[]) => m.getFit(...args),
  matchService: { scoreJob: (...args: unknown[]) => m.scoreJob(...args), preScoreMany: (...args: unknown[]) => m.preScoreMany(...args) },
}));

import { runWithBrand } from '../../../lib/requestContext.js';
import { fitFixture, fitsFixture } from './fitFixture.js';
import { defaultAgentDeps } from '../deps.js';
import { queueFits } from '../store.js';

beforeEach(() => {
  m.personalized.mockReset().mockResolvedValue(true);
  m.getFits.mockReset();
  m.getFit.mockReset();
  m.scoreJob.mockReset();
  m.preScoreMany.mockReset();
});

describe('Ready to apply: fitsFor reads getFits', () => {
  it('each row shows the Fit of getFits: score, tier and kind (an estimate is `pre` on the wire), with its confidence', async () => {
    m.getFits.mockResolvedValue(
      fitsFixture([
        fitFixture({ jobId: 'j1', score: 63, tier: 'possible', kind: 'ai' }),
        fitFixture({ jobId: 'j2', score: 71, tier: 'good', kind: 'estimate', confidence: 'low', confidenceReason: 'no_skills_listed' }),
        // Nothing to compare: the row shows no fit, never 0.
        fitFixture({ jobId: 'j3', score: null, tier: null, kind: 'estimate' }),
      ]),
    );
    const out = await runWithBrand('roboapply', () => defaultAgentDeps().fitsFor('u1', ['j1', 'j2', 'j2', 'j3']));
    expect(Object.fromEntries(out)).toEqual({
      j1: { tier: 'possible', score: 63, kind: 'ai', confidence: 'high' },
      j2: { tier: 'good', score: 71, kind: 'pre', confidence: 'low' },
    });
    // One list read with the ids once each; nothing that could call a model.
    expect(m.getFits).toHaveBeenCalledTimes(1);
    expect(m.getFits).toHaveBeenCalledWith('u1', ['j1', 'j2', 'j3']);
    expect(m.getFit).not.toHaveBeenCalled();
    expect(m.scoreJob).not.toHaveBeenCalled();
    expect(m.preScoreMany).not.toHaveBeenCalled();
  });

  it('GoApply without a live 个性化推荐 grant: no fit is read at all', async () => {
    m.personalized.mockResolvedValue(false);
    const out = await runWithBrand('goapply', () => defaultAgentDeps().fitsFor('u1', ['j1']));
    expect(out.size).toBe(0);
    expect(m.personalized).toHaveBeenCalledWith('u1', 'cn');
    expect(m.getFits).not.toHaveBeenCalled();
  });

  it('GoApply with the grant reads the same list; no ids, or a failing read, answers no fits and never throws', async () => {
    m.getFits.mockResolvedValue(fitsFixture([fitFixture({ jobId: 'j1', score: 80, tier: 'great', kind: 'estimate' })]));
    const out = await runWithBrand('goapply', () => defaultAgentDeps().fitsFor('u1', ['j1']));
    expect(out.get('j1')).toEqual({ tier: 'great', score: 80, kind: 'pre', confidence: 'high' });
    expect((await defaultAgentDeps().fitsFor('u1', [])).size).toBe(0);
    expect(m.getFits).toHaveBeenCalledTimes(1);
    m.getFits.mockRejectedValue(new Error('scores down'));
    expect((await runWithBrand('roboapply', () => defaultAgentDeps().fitsFor('u1', ['j1']))).size).toBe(0);
  });

  it('queueFits: a fit without a tier or a finite score has no entry; an unknown confidence is left out', () => {
    const out = queueFits(
      new Map([
        ['a', { jobId: 'a', score: 55, tier: 'possible' as const, kind: 'estimate' as const }],
        ['b', { jobId: 'b', score: Number.NaN, tier: 'good' as const, kind: 'ai' as const }],
        ['c', { jobId: 'c', score: 70, tier: null, kind: 'ai' as const }],
      ]),
    );
    expect(Object.fromEntries(out)).toEqual({ a: { tier: 'possible', score: 55, kind: 'pre' } });
  });
});
