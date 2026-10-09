// @vitest-environment node
//
// Retention schedule: one test per row (TASK_PLAN.md WP-13 acceptance).

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RETENTION_BATCH,
  RETENTION_RULES,
  backupRetentionFromEnv,
  registerArtifactStorageDeleter,
  retentionCutoff,
  setResumeOriginalDeleterForTests,
  retentionSchedule,
  retentionScheduleMarkdown,
  runRetention,
  type RetentionDb,
} from './retention.js';

const NOW = new Date('2026-10-10T05:00:00.000Z');

type Call = { model: string; method: string; args: Record<string, unknown> };

/** A recording fake: `findMany` returns the queued id rows once, deletes count the ids. */
function recorder(queued: Record<string, Array<Record<string, unknown>>> = {}, counts: Record<string, number> = {}) {
  const calls: Call[] = [];
  const db = new Proxy(
    {},
    {
      get(_t, model: string) {
        return {
          findMany: async (args: Record<string, unknown>) => {
            calls.push({ model, method: 'findMany', args });
            const rows = queued[model] ?? [];
            queued[model] = [];
            return rows;
          },
          deleteMany: async (args: { where: { id: string | { in: string[] } } }) => {
            calls.push({ model, method: 'deleteMany', args });
            const id = args.where.id;
            return { count: typeof id === 'string' ? 1 : id.in.length };
          },
          count: async (args: Record<string, unknown>) => {
            calls.push({ model, method: 'count', args });
            return counts[model] ?? 0;
          },
        };
      },
    },
  ) as unknown as RetentionDb;
  return { db, calls };
}

function rule(id: string) {
  const r = RETENTION_RULES.find((x) => x.id === id);
  if (!r) throw new Error(`no rule ${id}`);
  return r;
}

const firstWhere = (calls: Call[], model: string) => calls.find((c) => c.model === model && c.method === 'findMany')!.args.where as Record<string, unknown>;

afterEach(() => {
  registerArtifactStorageDeleter(null);
  setResumeOriginalDeleterForTests(null);
});

describe('retention schedule (published values)', () => {
  const fmt = (env: Record<string, string | undefined>) =>
    Object.fromEntries(retentionSchedule(env).map((r) => [r.id, `${r.keep ? `${r.keep.amount} ${r.keep.unit}` : 'Not listed'} · ${r.enforcedBy}`]));

  it('matches PRODUCT_PLAN F-TRUST-06 / TASK_PLAN WP-13', () => {
    expect(fmt({})).toEqual({
      assistant_messages: '12 months · compliance-daily',
      job_interactions: '13 months · compliance-daily',
      feed_impressions: '13 months · compliance-daily',
      product_events: '13 months · compliance-daily',
      closed_accounts: '30 days · account-purge',
      soft_deleted_rows: '30 days · compliance-daily',
      application_artifacts: '180 days · compliance-daily',
      inactive_accounts: '24 months · not_automated',
      auth_tokens: '24 hours · compliance-daily',
      ai_label_logs: '180 days · compliance-daily',
      content_safety_events: '180 days · compliance-daily',
      // WP-63a's job is still a stub: not claimed as automatic.
      interview_recordings: '90 days · not_automated',
      data_exports: '7 days · compliance-daily',
      // The provider's window is not assumed: "Not listed" until ops sets it.
      backups: 'Not listed · provider',
    });
  });

  it('every compliance-daily row (except the export sweep in dataExport.ts) has a run here; no other row claims automation', () => {
    for (const r of RETENTION_RULES) {
      if (r.enforcedBy === 'compliance-daily' && r.id !== 'data_exports') expect(r.run, r.id).toBeTypeOf('function');
      if (r.enforcedBy !== 'compliance-daily') expect(r.run, r.id).toBeUndefined();
    }
    expect(RETENTION_RULES.some((r) => r.enforcedBy === 'interview-retention')).toBe(false);
  });

  it('backups: BACKUP_RETENTION_DAYS when set and valid, else null', () => {
    expect(fmt({ BACKUP_RETENTION_DAYS: '14' }).backups).toBe('14 days · provider');
    expect(backupRetentionFromEnv({ BACKUP_RETENTION_DAYS: ' 7 ' })).toEqual({ amount: 7, unit: 'days' });
    for (const v of [undefined, '', '0', 'seven', '-3', '1.5']) expect(backupRetentionFromEnv({ BACKUP_RETENTION_DAYS: v })).toBeNull();
  });

  it('cutoffs: hours, days, calendar months', () => {
    expect(retentionCutoff({ amount: 24, unit: 'hours' }, NOW).toISOString()).toBe('2026-10-09T05:00:00.000Z');
    expect(retentionCutoff({ amount: 180, unit: 'days' }, NOW).toISOString()).toBe('2026-04-13T05:00:00.000Z');
    expect(retentionCutoff({ amount: 13, unit: 'months' }, NOW).toISOString()).toBe('2025-09-10T05:00:00.000Z');
  });

  it('month cutoffs clamp to the last day of the target month (never early)', () => {
    const at = (iso: string, months: number) => retentionCutoff({ amount: months, unit: 'months' }, new Date(iso)).toISOString();
    expect(at('2027-03-31T05:00:00.000Z', 13)).toBe('2026-02-28T05:00:00.000Z');
    expect(at('2028-03-31T05:00:00.000Z', 1)).toBe('2028-02-29T05:00:00.000Z');
    expect(at('2026-12-31T23:59:59.999Z', 12)).toBe('2025-12-31T23:59:59.999Z');
    expect(at('2026-10-31T05:00:00.000Z', 24)).toBe('2024-10-31T05:00:00.000Z');
    expect(at('2026-05-31T05:00:00.000Z', 3)).toBe('2026-02-28T05:00:00.000Z');
  });

  it('the notice table has one row per rule in both languages', () => {
    for (const locale of ['en', 'zh'] as const) {
      const md = retentionScheduleMarkdown(locale, {});
      expect(md.split('\n')).toHaveLength(RETENTION_RULES.length + 2);
      expect(md).not.toMatch(/\| [a-z_]+ \|/); // every id has a label
    }
    expect(retentionScheduleMarkdown('en', {})).toContain('| Database backups | Not listed |');
    expect(retentionScheduleMarkdown('zh', { BACKUP_RETENTION_DAYS: '14' })).toContain('| 数据库备份 | 14 天 |');
    expect(retentionScheduleMarkdown('en', {})).toContain('| Resumes, cover letters, tracked jobs and Assistant memories you delete | 30 days |');
  });
});

describe('retention rows', () => {
  const ctx = (db: RetentionDb) => ({ db, brand: 'goapply' as const, now: NOW });

  it('assistant_messages: 12 months, brand via thread owner', async () => {
    const { db, calls } = recorder({ rACopilotMessage: [{ id: 'm1' }, { id: 'm2' }] });
    expect(await rule('assistant_messages').run!(ctx(db))).toEqual({ deleted: 2 });
    expect(firstWhere(calls, 'rACopilotMessage')).toEqual({ createdAt: { lt: new Date('2025-10-10T05:00:00.000Z') }, thread: { user: { brand: 'goapply' } } });
    expect(calls.find((c) => c.method === 'deleteMany')!.args).toEqual({ where: { id: { in: ['m1', 'm2'] } } });
  });

  it('job_interactions: 13 months, brand via user', async () => {
    const { db, calls } = recorder({ rAJobInteraction: [{ id: 'i1' }] });
    expect(await rule('job_interactions').run!(ctx(db))).toEqual({ deleted: 1 });
    expect(firstWhere(calls, 'rAJobInteraction')).toEqual({ createdAt: { lt: new Date('2025-09-10T05:00:00.000Z') }, user: { brand: 'goapply' } });
  });

  it('feed_impressions: 13 months', async () => {
    const { db, calls } = recorder();
    expect(await rule('feed_impressions').run!(ctx(db))).toEqual({ deleted: 0 });
    expect(firstWhere(calls, 'rAFeedSession')).toEqual({ createdAt: { lt: new Date('2025-09-10T05:00:00.000Z') }, user: { brand: 'goapply' } });
    expect(calls.some((c) => c.method === 'deleteMany')).toBe(false);
  });

  it('product_events: 13 months, brand column', async () => {
    const { db, calls } = recorder({ rAProductEvent: [{ id: 'e1' }] });
    await rule('product_events').run!(ctx(db));
    expect(firstWhere(calls, 'rAProductEvent')).toEqual({ brand: 'goapply', createdAt: { lt: new Date('2025-09-10T05:00:00.000Z') } });
  });

  it('closed_accounts: enforced by account-purge (no run here)', () => {
    expect(rule('closed_accounts').run).toBeUndefined();
    expect(rule('closed_accounts').enforcedBy).toBe('account-purge');
  });

  describe('soft_deleted_rows: rows the user deleted, hard-deleted 30 days later', () => {
    const cutoff = new Date('2026-09-10T05:00:00.000Z');
    const due = { deletedAt: { lt: cutoff }, user: { brand: 'goapply' } };

    it.each([
      ['cover letters', 'rACoverLetter'],
      ['tracker entries', 'rATrackerEntry'],
      ['Assistant memories', 'rACopilotMemory'],
    ])('%s', async (_label, model) => {
      const { db, calls } = recorder({ [model]: [{ id: 'x1' }, { id: 'x2' }] });
      expect(await rule('soft_deleted_rows').run!(ctx(db))).toEqual({ deleted: 2 });
      expect(firstWhere(calls, model)).toEqual(due);
      expect(calls.find((c) => c.model === model && c.method === 'deleteMany')!.args).toEqual({ where: { id: { in: ['x1', 'x2'] } } });
    });

    it('resumes without a stored original or a live cover letter go in batches', async () => {
      const { db, calls } = recorder({ rAResumeVariant: [{ id: 'v1' }] });
      expect(await rule('soft_deleted_rows').run!(ctx(db))).toEqual({ deleted: 1 });
      expect(firstWhere(calls, 'rAResumeVariant')).toEqual({ ...due, originalFileKey: null, coverLetters: { none: { deletedAt: null } } });
    });

    it('resumes with a stored original: file first, row held back when the file delete fails', async () => {
      let n = 0;
      const { db, calls } = recorder({}, { rAResumeVariant: 1 });
      const db2 = new Proxy(db as object, {
        get(t, model: string) {
          const d = (t as Record<string, Record<string, (a: Record<string, unknown>) => unknown>>)[model]!;
          if (model !== 'rAResumeVariant') return d;
          return {
            ...d,
            findMany: async (args: Record<string, unknown>) => {
              n += 1;
              calls.push({ model, method: 'findMany', args });
              if (n === 2) {
                return [
                  { id: 'f1', originalFileProvider: 's3', originalFileKey: 'k1', originalFileName: 'a.pdf', originalFileMimeType: 'application/pdf' },
                  { id: 'f2', originalFileProvider: 's3', originalFileKey: 'k2', originalFileName: 'b.pdf', originalFileMimeType: 'application/pdf' },
                ];
              }
              return [];
            },
          };
        },
      }) as unknown as RetentionDb;
      const deleter = vi.fn(async (ref: { key: string }) => {
        if (ref.key === 'k2') throw new Error('s3 down');
        return true;
      });
      setResumeOriginalDeleterForTests(deleter);
      // f1 deleted; f2 held back (file delete failed); 1 more held back by a live cover letter.
      expect(await rule('soft_deleted_rows').run!(ctx(db2))).toEqual({ deleted: 1, blocked: 2 });
      expect(deleter).toHaveBeenCalledWith({ provider: 's3', key: 'k1', fileName: 'a.pdf', mimeType: 'application/pdf' });
      const resumeFinds = calls.filter((c) => c.model === 'rAResumeVariant' && c.method === 'findMany');
      expect(resumeFinds[1]!.args.where).toEqual({ ...due, originalFileKey: { not: null }, coverLetters: { none: { deletedAt: null } } });
      expect(calls.filter((c) => c.model === 'rAResumeVariant' && c.method === 'deleteMany').map((c) => c.args)).toEqual([{ where: { id: 'f1' } }]);
      expect(calls.find((c) => c.model === 'rAResumeVariant' && c.method === 'count')!.args).toEqual({
        where: { ...due, coverLetters: { some: { deletedAt: null } } },
      });
    });

    it('rows deleted less than 30 days ago (or on the other brand) are not selected', async () => {
      const { db, calls } = recorder();
      await rule('soft_deleted_rows').run!({ db, brand: 'roboapply', now: NOW });
      for (const c of calls.filter((x) => x.method === 'findMany')) {
        expect((c.args.where as { deletedAt: { lt: Date } }).deletedAt.lt).toEqual(cutoff);
        expect((c.args.where as { user: { brand: string } }).user.brand).toBe('roboapply');
      }
      expect(calls.some((c) => c.method === 'deleteMany')).toBe(false);
    });
  });

  it('application_artifacts: 180 days; stored files deleted first, held back without a deleter', async () => {
    const queued = { rAApplicationArtifact: [{ id: 'a1' }] };
    const { db, calls } = recorder(queued);
    // second findMany (stored rows) returns two rows
    let n = 0;
    const db2 = new Proxy(db as object, {
      get(t, model: string) {
        const d = (t as Record<string, Record<string, (a: Record<string, unknown>) => unknown>>)[model]!;
        if (model !== 'rAApplicationArtifact') return d;
        return {
          ...d,
          findMany: async (args: Record<string, unknown>) => {
            n += 1;
            if (n === 2) return [{ id: 's1', storageKey: 'k1', userId: 'u1' }, { id: 's2', storageKey: 'k2', userId: 'u2' }];
            return d.findMany!(args);
          },
        };
      },
    }) as unknown as RetentionDb;
    expect(await rule('application_artifacts').run!(ctx(db2))).toEqual({ deleted: 1, blocked: 2 });
    expect(firstWhere(calls, 'rAApplicationArtifact')).toEqual({ createdAt: { lt: new Date('2026-04-13T05:00:00.000Z') }, storageKey: null, user: { brand: 'goapply' } });

    n = 0;
    const deleter = vi.fn(async (row: { id: string }) => row.id === 's1');
    registerArtifactStorageDeleter(deleter);
    expect(await rule('application_artifacts').run!(ctx(db2))).toEqual({ deleted: 1, blocked: 1 });
    expect(deleter).toHaveBeenCalledWith({ id: 's1', storageKey: 'k1', userId: 'u1' });
  });

  it('inactive_accounts: published, not automated (honest)', () => {
    expect(rule('inactive_accounts').run).toBeUndefined();
    expect(rule('inactive_accounts').enforcedBy).toBe('not_automated');
  });

  it('auth_tokens: tokens and phone codes 24 hours after expiry', async () => {
    const { db, calls } = recorder({ rAAuthToken: [{ id: 't1' }], rAPhoneOtp: [{ id: 'o1' }, { id: 'o2' }] });
    expect(await rule('auth_tokens').run!(ctx(db))).toEqual({ deleted: 3 });
    const cutoff = new Date('2026-10-09T05:00:00.000Z');
    expect(firstWhere(calls, 'rAAuthToken')).toEqual({ brand: 'goapply', expiresAt: { lt: cutoff } });
    expect(firstWhere(calls, 'rAPhoneOtp')).toEqual({ brand: 'goapply', expiresAt: { lt: cutoff } });
  });

  it('ai_label_logs: 180 days', async () => {
    const { db, calls } = recorder({ rAAiContentLabelLog: [{ id: 'l1' }] });
    expect(await rule('ai_label_logs').run!(ctx(db))).toEqual({ deleted: 1 });
    expect(firstWhere(calls, 'rAAiContentLabelLog')).toEqual({ brand: 'goapply', createdAt: { lt: new Date('2026-04-13T05:00:00.000Z') } });
  });

  it('content_safety_events: 180 days', async () => {
    const { db, calls } = recorder();
    await rule('content_safety_events').run!(ctx(db));
    expect(firstWhere(calls, 'rAContentSafetyEvent')).toEqual({ brand: 'goapply', createdAt: { lt: new Date('2026-04-13T05:00:00.000Z') } });
  });

  it('interview_recordings: not automated until WP-63a replaces its stub', () => {
    expect(rule('interview_recordings').enforcedBy).toBe('not_automated');
    expect(rule('interview_recordings').run).toBeUndefined();
  });

  it('data_exports: 7 days, swept by compliance-daily (dataExport.ts)', () => {
    expect(rule('data_exports').keep).toEqual({ amount: 7, unit: 'days' });
  });

  it('backups: provider setting, period from configuration only', () => {
    expect(rule('backups').enforcedBy).toBe('provider');
    expect(rule('backups').keep).toBeNull();
  });
});

describe('runRetention', () => {
  it('batches until a short page, totals per rule, survives a failing rule', async () => {
    const full = Array.from({ length: RETENTION_BATCH }, (_, i) => ({ id: `p${i}` }));
    const pages = [full, [{ id: 'last' }]];
    const log = vi.fn();
    const db = new Proxy(
      {},
      {
        get(_t, model: string) {
          return {
            findMany: async () => {
              if (model === 'rAJobInteraction') throw new Error('boom');
              if (model === 'rAProductEvent') return pages.shift() ?? [];
              return [];
            },
            deleteMany: async (a: { where: { id: { in: string[] } | string } }) => ({ count: typeof a.where.id === 'string' ? 1 : a.where.id.in.length }),
            count: async () => 0,
          };
        },
      },
    ) as unknown as RetentionDb;
    const res = await runRetention({ db, brand: 'roboapply', now: NOW }, log);
    expect(res.deleted).toEqual({ product_events: RETENTION_BATCH + 1 });
    expect(res.total).toBe(RETENTION_BATCH + 1);
    expect(log).toHaveBeenCalledWith('retention rule failed', { rule: 'job_interactions', error: 'boom' });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('stops when the budget is nearly spent', async () => {
    const { db, calls } = recorder();
    await runRetention({ db, brand: 'roboapply', now: NOW, budget: { remainingMs: () => 1000 } });
    expect(calls).toEqual([]);
  });
});
