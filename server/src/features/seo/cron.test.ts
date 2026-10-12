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
// Both recruiter banks have a posting page in this file: a bank row is on a public page only then
// (feed/sourceLine.ts `heldBankBoards`; the held case is tested in seo.test.ts).
vi.stubEnv('ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE', 'https://jobs.robohire.example/p/{id}');
vi.stubEnv('GOHIRE_PUBLIC_JOB_URL_TEMPLATE', 'https://jobs.gohire.example/p/{id}');

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
  it('skips at once when seo.browse is off (either brand) and on GoApply with the recruitment-info mode off', async () => {
    const repo = inventory();
    expect(await createSeoRebuild({ repo, env: ENV, isEnabled: async () => false })(ctx())).toEqual({ skipped: 'disabled' });
    expect(await createSeoRebuild({ repo, env: ENV, isEnabled: async () => false })(ctx(BRANDS.goapply))).toEqual({ skipped: 'disabled' });
    const off = { ...ENV, CN_RECRUITMENT_INFO_MODE: 'off' };
    expect(await createSeoRebuild({ repo, env: off, isEnabled: async () => true })(ctx(BRANDS.goapply))).toEqual({ skipped: 'postings_off' });
    // The switch is GoApply's own: RoboApply still rebuilds with it set.
    expect(await createSeoRebuild({ repo: inventory(), env: off, fetch: okFetch(), isEnabled: async () => true })(ctx())).toMatchObject({ stoppedBy: 'done' });
    expect(repo.pages).toEqual([]);
  });

  it('GoApply rebuilds its own market with no CN_ switch set, stores zh pages, revalidates its own origin and pushes new pages to Baidu', async () => {
    const cnBackend = { ...backend, market: 'cn', sourceBoard: 'gohire', sourceName: 'GoHire', locationCountry: 'CN', locationCity: '上海', location: '上海' };
    const repo = createMemorySeoRepo([...seoJobs(22, cnBackend), ...seoJobs(30, backend)]);
    const fetch = okFetch();
    const env = { ...ENV, CN_BAIDU_PUSH_TOKEN: 'tok' };
    const result = await createSeoRebuild({ repo, env, fetch, isEnabled: async () => true })(ctx(BRANDS.goapply));
    const role = repo.pages.find((p) => p.type === 'role' && p.slug === 'backend-engineer')!;
    // Only the 22 cn rows count; the 30 intl rows belong to RoboApply.
    expect(role).toMatchObject({ brand: 'goapply', locale: 'zh', jobCount: 22, indexable: true });
    expect(repo.pages.every((p) => p.brand === 'goapply')).toBe(true);
    expect(result).toMatchObject({ stoppedBy: 'done', baiduPushed: expect.any(Number) });
    expect(Number(result.baiduPushed)).toBeGreaterThan(0);
    const urls = fetch.mock.calls.map(([url]) => url);
    expect(urls[0]).toBe('https://www.goapply.top/api/revalidate');
    expect(JSON.parse(fetch.mock.calls[0]![1].body).tags).toContain('seo:goapply:role:backend-engineer');
    const baidu = fetch.mock.calls.find(([url]) => url.startsWith('http://data.zz.baidu.com/'))!;
    expect(baidu[1].body).toContain('https://www.goapply.top/browse/backend-engineer');
    // RoboApply over the same repository still sees only its 30 rows and never calls Baidu.
    const fetchRa = okFetch();
    await createSeoRebuild({ repo, env, fetch: fetchRa, isEnabled: async () => true })(ctx());
    expect(repo.pages.find((p) => p.brand === 'roboapply' && p.type === 'role' && p.slug === 'backend-engineer')).toMatchObject({ jobCount: 30, locale: 'en' });
    expect(fetchRa.mock.calls.some(([url]) => url.includes('baidu'))).toBe(false);
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

  it('visa-sponsorship pages are built for RoboApply only: GoApply builds none, even for postings that quote sponsorship', async () => {
    const quoted = { ...backend, sponsorship: 'offered', sponsorshipEvidence: 'Visa sponsorship is available.' };
    const cnQuoted = { ...quoted, market: 'cn', fromRecruiterBank: false, sourceBoard: 'greenhouse', sourceName: 'Example careers', locationCountry: 'CN', locationCity: 'Shanghai', location: 'Shanghai' };
    const intlQuoted = { ...quoted, locationCountry: 'US', locationCity: 'Austin', location: 'Austin' };
    const repo = createMemorySeoRepo([...seoJobs(6, cnQuoted), ...seoJobs(6, intlQuoted)]);
    const boards = ['greenhouse'];
    const cn = await collectCandidates(repo, { market: 'cn', now: NOW, publicBoards: boards });
    // The six cn rows still make their role pages; only the sponsorship page is left out.
    expect(cn.some((x) => x.target.type === 'role' && x.target.slug === 'backend-engineer')).toBe(true);
    expect(cn.filter((x) => x.target.type === 'sponsorship_role')).toEqual([]);
    const intl = await collectCandidates(repo, { market: 'intl', now: NOW, publicBoards: boards });
    expect(intl.filter((x) => x.target.type === 'sponsorship_role').map((x) => x.target.slug)).toEqual(['us/backend-engineer']);

    // A full GoApply run stores no sponsorship page, and does not refresh one that was stored by mistake.
    const env = { ...ENV, PUBLIC_DISPLAY_PROVIDERS: 'ats_public' };
    repo.pages.push({ brand: 'goapply', locale: 'zh', type: 'sponsorship_role', slug: 'cn/backend-engineer', params: { taxonomyId: 'backend_engineer', country: 'CN', segment: 'visa-sponsorship' }, title: 'x', h1: 'x', intro: '', stats: {}, jobCount: 6, indexable: true, lastBuiltAt: new Date('2026-10-01T00:00:00Z') });
    await createSeoRebuild({ repo, env, fetch: okFetch(), isEnabled: async () => true })(ctx(BRANDS.goapply));
    const stored = repo.pages.filter((p) => p.brand === 'goapply' && p.type === 'sponsorship_role');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.lastBuiltAt.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(repo.pages.some((p) => p.brand === 'goapply' && p.type === 'role' && p.slug === 'backend-engineer')).toBe(true);
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
