// @vitest-environment node
// WP-41: blacklist + review log adapter over AppConfig (fake client; no DB).

import { describe, expect, it } from 'vitest';
import { BLACKLIST_CONFIG_KEY, BlacklistConflictError, MAX_REVIEWS, REVIEWS_CONFIG_KEY, blacklistHit, createCnJobsStore, type ConfigDb } from '../store.js';
import { employerKey } from '../text.js';

function fakeConfig() {
  const rows = new Map<string, string>();
  const reads = { count: 0 };
  const db = {
    appConfig: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        reads.count += 1;
        const v = rows.get(where.key);
        return v === undefined ? null : { value: v };
      },
      upsert: async ({ where, create, update }: { where: { key: string }; create: { value: string }; update: { value: string } }) => {
        rows.set(where.key, rows.has(where.key) ? update.value : create.value);
        return {};
      },
    },
  } as unknown as ConfigDb;
  return { db, rows, reads };
}

describe('CnJobsStore', () => {
  it('blacklist add / duplicate / remove', async () => {
    const { db, rows } = fakeConfig();
    let t = 0;
    const store = createCnJobsStore(async () => db, { now: () => new Date(Date.UTC(2026, 9, 10) + t) });
    const e = await store.addBlacklist({ employerName: ' 某某教育咨询有限公司 ', reason: '培训贷', createdBy: 'a1' });
    expect(e).toMatchObject({ employerName: '某某教育咨询有限公司', employerKey: '某某教育咨询', reason: '培训贷', createdBy: 'a1' });
    expect(JSON.parse(rows.get(BLACKLIST_CONFIG_KEY)!)).toHaveLength(1);
    await expect(store.addBlacklist({ employerName: '某某教育咨询公司', reason: 'x', createdBy: 'a1' })).rejects.toBeInstanceOf(BlacklistConflictError);
    expect(await store.removeBlacklist('nope')).toBeNull();
    expect((await store.removeBlacklist(e.id))?.id).toBe(e.id);
    expect(await store.listBlacklist()).toEqual([]);
    t += 1;
  });

  it('cached reads reuse the value for a minute and drop it on writes', async () => {
    const { db, reads } = fakeConfig();
    let now = Date.UTC(2026, 9, 10);
    const store = createCnJobsStore(async () => db, { now: () => new Date(now) });
    await store.blacklistCached();
    await store.blacklistCached();
    expect(reads.count).toBe(1);
    now += 61_000;
    await store.blacklistCached();
    expect(reads.count).toBe(2);
    await store.addBlacklist({ employerName: 'X公司名称', reason: 'r', createdBy: 'a' });
    expect((await store.blacklistCached()).map((e) => e.employerName)).toEqual(['X公司名称']);
  });

  it('review log is capped and filtered per job; bad JSON reads as empty', async () => {
    const { db, rows } = fakeConfig();
    const store = createCnJobsStore(async () => db);
    rows.set(REVIEWS_CONFIG_KEY, 'not json');
    expect(await store.listReviews()).toEqual([]);
    const many = Array.from({ length: MAX_REVIEWS }, (_, i) => ({ jobId: `j${i}`, decision: 'clear', note: null, at: 'x', by: 'a', clearedKeys: [] }));
    rows.set(REVIEWS_CONFIG_KEY, JSON.stringify(many));
    await store.addReview({ jobId: 'last', decision: 'confirm', note: null, at: 'y', by: 'a', clearedKeys: [] });
    const all = await store.listReviews();
    expect(all).toHaveLength(MAX_REVIEWS);
    expect(all[0]!.jobId).toBe('j1');
    expect(await store.reviewsFor('last')).toHaveLength(1);
  });

  it('cached review reads are dropped on addReview', async () => {
    const { db, reads } = fakeConfig();
    const store = createCnJobsStore(async () => db, { now: () => new Date(Date.UTC(2026, 9, 10)) });
    expect(await store.reviewsCached()).toEqual([]);
    await store.reviewsCached();
    expect(reads.count).toBe(1);
    await store.addReview({ jobId: 'j', sourceKey: 'gohire:1', decision: 'clear', note: null, at: 'x', by: 'a', clearedKeys: ['k'] });
    expect((await store.reviewsCached()).map((r) => r.sourceKey)).toEqual(['gohire:1']);
  });
});

describe('blacklistHit', () => {
  const entries = [{ id: '1', employerName: '黑心培训有限公司', employerKey: employerKey('黑心培训有限公司'), reason: 'r', createdAt: '', createdBy: '' }];
  it('matches the legal-suffix-free name, and branch names that contain it', () => {
    expect(blacklistHit('黑心培训公司', entries)?.id).toBe('1');
    expect(blacklistHit('黑心培训有限公司（上海分公司）', entries)?.id).toBe('1');
    expect(blacklistHit('白心培训有限公司', entries)).toBeNull();
    expect(blacklistHit('', entries)).toBeNull();
  });

  it('a 2-3 character key matches only at the start (after a short city prefix) and before a line-of-business word', () => {
    const short = [{ id: 's', employerName: '华为', employerKey: employerKey('华为'), reason: 'r', createdAt: '', createdBy: '' }];
    expect(blacklistHit('华为技术有限公司', short)?.id).toBe('s');
    expect(blacklistHit('深圳华为科技有限公司', short)?.id).toBe('s');
    expect(blacklistHit('华为', short)?.id).toBe('s');
    expect(blacklistHit('中华为民服务中心', short)).toBeNull();
    expect(blacklistHit('华为之家餐厅', short)).toBeNull();
  });
});
