// @vitest-environment node
// WP-41: the cn.jobs.fraudCheck worker is registered and runs the check.

import { afterEach, describe, expect, it } from 'vitest';
import { PermanentWorkError } from '../../../../platform/queue/index.js';
import { CN_JOBS_WORK_KINDS, fraudCheckWorker, setCnJobsDepsForTests, workers } from '../workers.js';
import { CN_MODEL_ENV, cnJob, fakeDeps, fakeLlm, fakeRepo } from './testkit.js';

afterEach(() => setCnJobsDepsForTests(null));

const item = (payload: unknown) => ({ id: 'w1', payload, attempts: 1, maxAttempts: 5 }) as unknown as Parameters<typeof fraudCheckWorker.handler>[0];

describe('cn.jobs workers', () => {
  it('registers the fraud check kind', () => {
    expect(workers.map((w) => w.kind)).toEqual([CN_JOBS_WORK_KINDS.fraudCheck]);
    expect(CN_JOBS_WORK_KINDS.fraudCheck).toBe('cn.jobs.fraudCheck');
  });

  it('rejects a bad payload permanently', async () => {
    await expect(fraudCheckWorker.handler(item({}), {} as never)).rejects.toBeInstanceOf(PermanentWorkError);
  });

  it('runs one check', async () => {
    const llm = fakeLlm();
    setCnJobsDepsForTests(fakeDeps({ env: CN_MODEL_ENV, llm, repo: fakeRepo([cnJob()]) }));
    await fraudCheckWorker.handler(item({ jobId: 'job_1' }), {} as never);
    expect(llm.chatWithUsage).toHaveBeenCalledTimes(1);
  });
});
