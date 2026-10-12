// @vitest-environment node
// The preparer hook (MARKET_TASK_PLAN 3.3): async loaders the synchronous estimate depends on run once per process,
// are retried after a failure, and are awaited before MatchService.userContext answers.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../../platform/brand/registry.js';
import { createMatchService } from './MatchService.js';
import { registerMatchPreparer, resetMatchPreparersForTests, runMatchPreparers } from './prepare.js';
import { createMemoryRepo } from './testkit.js';

beforeEach(() => resetMatchPreparersForTests());

function service() {
  return createMatchService({ repo: createMemoryRepo(), resolveModel: () => null, aiAllowed: async () => true, brand: () => getBrand('roboapply'), env: {}, now: () => new Date('2026-10-10T08:00:00Z') });
}

describe('runMatchPreparers', () => {
  it('with nothing registered it resolves at once', async () => {
    await expect(runMatchPreparers()).resolves.toBeUndefined();
  });

  it('runs each registered preparer once, in order, however often it is called', async () => {
    const order: string[] = [];
    const a = vi.fn(async () => void order.push('a'));
    const b = vi.fn(async () => void order.push('b'));
    registerMatchPreparer(a);
    registerMatchPreparer(b);
    registerMatchPreparer(a); // the same function again: not a second entry
    await runMatchPreparers();
    await runMatchPreparers();
    await Promise.all([runMatchPreparers(), runMatchPreparers()]);
    expect(order).toEqual(['a', 'b']);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('concurrent callers share one run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const loader = vi.fn(async () => gate);
    registerMatchPreparer(loader);
    const first = runMatchPreparers();
    const second = runMatchPreparers();
    release();
    await Promise.all([first, second]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('a failed preparer rejects the call and is retried on the next one; finished ones are not run again', async () => {
    const ok = vi.fn(async () => undefined);
    const flaky = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('vocabulary not reachable')).mockResolvedValue(undefined);
    const after = vi.fn(async () => undefined);
    registerMatchPreparer(ok);
    registerMatchPreparer(flaky);
    registerMatchPreparer(after);
    await expect(runMatchPreparers()).rejects.toThrow('vocabulary not reachable');
    // It stopped at the failure: what comes after has not run yet.
    expect(after).not.toHaveBeenCalled();
    await expect(runMatchPreparers()).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(after).toHaveBeenCalledTimes(1);
    await runMatchPreparers();
    expect(flaky).toHaveBeenCalledTimes(2);
  });
});

describe('MatchService.userContext awaits the preparers', () => {
  it('with no preparer registered it behaves as before', async () => {
    const { user, resume } = await service().userContext('u1');
    expect(user.userId).toBe('u1');
    expect(resume?.id).toBe('v1');
  });

  it('a registered preparer has finished before userContext resolves, and before the first estimate', async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    registerMatchPreparer(async () => {
      events.push('preparer started');
      await gate;
      events.push('preparer done');
    });
    const svc = service();
    const pending = svc.userContext('u1').then((c) => {
      events.push('userContext resolved');
      return c;
    });
    // The context is not answered while the preparer is still loading.
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual(['preparer started']);
    release();
    await pending;
    expect(events).toEqual(['preparer started', 'preparer done', 'userContext resolved']);

    // Every path that estimates goes through it, and it ran once.
    const loader = vi.fn(async () => undefined);
    registerMatchPreparer(loader);
    await svc.fits.getFits('u1', ['job1']);
    await svc.fits.getFit('u1', 'job1');
    await svc.preScoreJobs('u1', []);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('a failing preparer does not take the read down: it is logged, the read answers, and the next read runs it again', async () => {
    const flaky = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('vocabulary not reachable')).mockResolvedValue(undefined);
    registerMatchPreparer(flaky);
    const svc = service();
    expect((await svc.userContext('u1')).user.userId).toBe('u1');
    expect(flaky).toHaveBeenCalledTimes(1);
    expect((await svc.fits.getFits('u1', ['job1'])).get('job1')?.score).not.toBeNull();
    expect(flaky).toHaveBeenCalledTimes(2);
    await svc.userContext('u1');
    expect(flaky).toHaveBeenCalledTimes(2);
  });
});
