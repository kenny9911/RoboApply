// @vitest-environment node
// WP-56 seo-rebuild: candidate pages from real inventory, floors, stored
// intros checked against stats, revalidate only what changed, Baidu push
// only where configured, fast skips.

import { describe, expect, it, vi } from 'vitest';
import { BRANDS } from '../../platform/brand/registry.js';
import { createBudget } from '../../platform/queue/index.js';
import { collectCandidates, createSeoRebuild, postRevalidate, pushToBaidu, type FetchLike } from './cron.js';
import type { SeoPageStats } from './contract.js';
import { introNumbersMatch } from './stats.js';
import { createMemorySeoRepo, seoJobs } from './testkit.js';

const NOW = new Date('2026-10-10T04:00:00.000Z');
const ENV = { INTERNAL_API_SECRET: 'sec' };
const backend = { taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'] };

function ctx(brand = BRANDS.roboapply, budgetMs = 240_000) {
  return { name: 'seo-rebuild', brand, budget: createBudget(budgetMs), now: NOW };
}

function inventory() {
  return createMemorySeoRepo([
    ...seoJobs(21, backend),
    ...seoJobs(6, { ...backend, locationCity: 'Hsinchu' }),
    ...seoJobs(2, { ...backend, locationCity: 'Kaohsiung' }),
    ...seoJobs(40, { ...backend, visibility: 'private' }),
    ...seoJobs(6, { ...backend, workModel: 'remote', remoteScope: 'global', locationCity: null, locationCountry: null }),
    ...seoJobs(5, { ...backend, sponsorship: 'offered', sponsorshipEvidence: 'Visa sponsorship is available.', locationCountry: 'US', locationCity: 'Austin' }),
  ]);
}

function okFetch() {
  return vi.fn<FetchLike>(async () => ({ ok: true, status: 200 }));
}

describe('seo-rebuild', () => {
  it('skips at once on GoApply (browse deferred) and when seo.browse is off', async () => {
    const repo = inventory();
    expect(await createSeoRebuild({ repo, env: ENV, isEnabled: async () => true })(ctx(BRANDS.goapply))).toEqual({ skipped: 'not_for_market' });
    expect(await createSeoRebuild({ repo, env: ENV, isEnabled: async () => false })(ctx())).toEqual({ skipped: 'disabled' });
    expect(repo.pages).toEqual([]);
  });

  it('builds pages from inventory with floors; private rows never count', async () => {
    const repo = inventory();
    const fetch = okFetch();
    const result = await createSeoRebuild({ repo, env: ENV, fetch, isEnabled: async () => true })(ctx());
    const page = (type: string, slug: string) => repo.pages.find((p) => p.type === type && p.slug === slug);

    const role = page('role', 'backend-engineer')!;
    expect(role.jobCount).toBe(21 + 6 + 2 + 6 + 5);
    expect(role.indexable).toBe(true);
    expect(page('role', 'software-engineering')?.indexable).toBe(true);
    expect(page('role_city', 'backend-engineer/hsinchu')).toMatchObject({ jobCount: 6, indexable: true });
    // Kaohsiung has 2 jobs: below the role × city pre-filter, no page.
    expect(page('role_city', 'backend-engineer/kaohsiung')).toBeUndefined();
    expect(page('remote_role', 'backend-engineer')).toMatchObject({ jobCount: 6, indexable: true });
    expect(page('sponsorship_role', 'us/backend-engineer')).toMatchObject({ jobCount: 5, indexable: true });
    // No entry-level jobs yet: no row (pages with 0 jobs are stored only when they existed before).
    expect(page('segment', 'entry-level')).toBeUndefined();

    for (const p of repo.pages) {
      expect(p.locale).toBe('en');
      if (p.intro) expect(introNumbersMatch(p.intro, p.stats as SeoPageStats, [p.title, 'Backend engineer', 'Software engineering', 'Hsinchu', 'Taipei', 'US', 'Austin'])).toBe(true);
    }
    expect(result).toMatchObject({ revalidated: expect.any(Number), baiduPushed: 0, stoppedBy: 'done' });
    // The revalidate call carries the shared secret and seo:<brand>:<type>:<slug> tags.
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://www.roboapply.io/api/revalidate');
    expect(init.headers['x-ra-internal']).toBe('sec');
    const tags = JSON.parse(init.body).tags as string[];
    expect(tags).toContain('seo:roboapply:role:backend-engineer');
    expect(tags).toContain('seo:roboapply:sitemap:index');
  });

  it('a second run with the same inventory revalidates nothing', async () => {
    const repo = inventory();
    await createSeoRebuild({ repo, env: ENV, fetch: okFetch(), isEnabled: async () => true })(ctx());
    const fetch = okFetch();
    const again = await createSeoRebuild({ repo, env: ENV, fetch, isEnabled: async () => true })(ctx());
    expect(again).toMatchObject({ changed: 0, revalidated: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a page whose jobs closed drops to noindex and is revalidated', async () => {
    const repo = inventory();
    await createSeoRebuild({ repo, env: ENV, fetch: okFetch(), isEnabled: async () => true })(ctx());
    for (const j of repo.jobs) if (j.locationCity === 'Hsinchu') j.closedAt = NOW;
    const fetch = okFetch();
    await createSeoRebuild({ repo, env: ENV, fetch, isEnabled: async () => true })(ctx());
    expect(repo.pages.find((p) => p.type === 'role_city' && p.slug === 'backend-engineer/hsinchu')).toMatchObject({ jobCount: 0, indexable: false });
    expect(JSON.parse(fetch.mock.calls[0]![1].body).tags).toContain('seo:roboapply:role_city:backend-engineer/hsinchu');
  });

  it('stops starting pages when the budget runs low', async () => {
    const repo = inventory();
    const r = await createSeoRebuild({ repo, env: ENV, fetch: okFetch(), isEnabled: async () => true })(ctx(BRANDS.roboapply, 1000));
    expect(r).toMatchObject({ processed: 0, stoppedBy: 'budget' });
  });

  it('candidates come only from publicly listable jobs', async () => {
    const repo = createMemorySeoRepo(seoJobs(50, { ...backend, visibility: 'private' }));
    const c = await collectCandidates(repo, { market: 'intl', now: NOW, publicBoards: [] });
    expect(c.map((x) => x.target.type)).toEqual(['segment', 'segment']);
  });
});

describe('revalidate and Baidu push', () => {
  it('revalidate is skipped without the shared secret', async () => {
    const fetch = okFetch();
    expect(await postRevalidate(BRANDS.roboapply, ['seo:roboapply:role:x'], {}, fetch)).toEqual({ revalidated: 0, skipped: 'no_internal_secret' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('Baidu push only for brands Baidu indexes, only with CN_BAIDU_PUSH_TOKEN', async () => {
    const fetch = okFetch();
    expect(await pushToBaidu(BRANDS.roboapply, ['https://www.roboapply.io/x'], { BAIDU_PUSH_TOKEN: 't' }, fetch)).toMatchObject({ pushed: 0, skipped: 'not_indexed_by_baidu' });
    expect(await pushToBaidu(BRANDS.goapply, ['https://www.goapply.top/x'], {}, fetch)).toMatchObject({ pushed: 0, skipped: 'not_configured' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await pushToBaidu(BRANDS.goapply, ['https://www.goapply.top/campus'], { CN_BAIDU_PUSH_TOKEN: 'tok' }, fetch)).toEqual({ pushed: 1 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://data.zz.baidu.com/urls?site=https%3A%2F%2Fwww.goapply.top&token=tok');
    expect(init.body).toBe('https://www.goapply.top/campus');
  });
});
