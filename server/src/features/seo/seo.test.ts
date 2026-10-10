// @vitest-environment node
// WP-56 pure logic: browse paths and slugs, the public-job predicate (both
// evaluators), floors, the median sample rule and intro number checks.

import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { INDEX_FLOORS, type SeoPageStats } from './contract.js';
import { citySlug, classifyBrowsePath, jobIdSlug, jobPath, parseIdSlug, resolveBrowsePath, resolveCity, seoCacheTag, targetFromParams } from './paths.js';
import { allowedPublicBoards, basePublicWhere, matchesScope, publicJobWhere, type ScopeContext } from './scope.js';
import { introFor, introNumbersMatch, introText, isIndexable, median, medianPay, statsView } from './stats.js';
import { createSeoService, publicListingsOpen } from './service.js';
import { createMemorySeoRepo, seoJob } from './testkit.js';
import { findCity } from '../jobs/geo/index.js';

const NOW = new Date('2026-10-10T00:00:00.000Z');
const CTX: ScopeContext = { market: 'intl', now: NOW, publicBoards: [] };

describe('job slugs (R-05)', () => {
  it('builds <id>-<slug> and parses the id back', () => {
    expect(jobIdSlug('cmabc123', 'Senior Backend Engineer (Go)', 'Acme')).toBe('cmabc123-senior-backend-engineer-go-acme');
    expect(jobPath('cmabc123', 'Data Analyst')).toBe('/job/cmabc123-data-analyst');
    expect(parseIdSlug('cmabc123-senior-backend-engineer')).toBe('cmabc123');
    expect(parseIdSlug('cm_job1-data-analyst')).toBe('cm_job1');
    expect(parseIdSlug('../etc')).toBeNull();
  });

  it('keeps the bare id for a title without ASCII letters', () => {
    expect(jobIdSlug('cm1', '产品经理')).toBe('cm1');
  });
});

describe('browse paths', () => {
  it('classifies every route shape', () => {
    expect(classifyBrowsePath('backend-engineer')?.type).toBe('role');
    expect(classifyBrowsePath('backend-engineer/taipei')?.type).toBe('role_city');
    expect(classifyBrowsePath('remote/backend-engineer')?.type).toBe('remote_role');
    expect(classifyBrowsePath('visa-sponsorship/us/backend-engineer')?.type).toBe('sponsorship_role');
    expect(classifyBrowsePath('graduate/data-analyst')?.type).toBe('graduate_role');
    expect(classifyBrowsePath('entry-level')?.type).toBe('segment');
    expect(classifyBrowsePath('internships')?.type).toBe('segment');
    expect(classifyBrowsePath('a/b/c/d')).toBeNull();
    expect(classifyBrowsePath('remote/a/b')).toBeNull();
  });

  it('resolves taxonomy role slugs and the Taiwan cities', () => {
    for (const city of ['taipei', 'hsinchu', 'taichung', 'kaohsiung']) {
      const r = resolveBrowsePath(`backend-engineer/${city}`);
      expect(r.ok, city).toBe(true);
      if (!r.ok) continue;
      expect(r.target.type).toBe('role_city');
      expect(r.target.path).toBe(`/browse/backend-engineer/${city}`);
      expect(r.target.city?.country).toBe('TW');
      expect(r.redirect).toBe(false);
      expect(r.target.scope.city?.names).toContain(city);
    }
  });

  it('maps a free-text title to the canonical role and asks for a redirect', () => {
    const r = resolveBrowsePath('backend-developer');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target.role?.id).toBeTruthy();
      expect(r.redirect).toBe(r.target.path !== '/browse/backend-developer');
    }
  });

  it('reports unknown roles, cities and countries', () => {
    expect(resolveBrowsePath('zzqx-not-a-role')).toEqual({ ok: false, reason: 'unknown_role' });
    expect(resolveBrowsePath('backend-engineer/atlantis-city-zz')).toEqual({ ok: false, reason: 'unknown_city' });
    expect(resolveBrowsePath('visa-sponsorship/zz/backend-engineer')).toEqual({ ok: false, reason: 'unknown_country' });
  });

  it('builds sponsorship, remote, graduate and segment targets with the right scope', () => {
    const s = resolveBrowsePath('visa-sponsorship/us/backend-engineer');
    expect(s.ok && s.target).toMatchObject({ type: 'sponsorship_role', slug: 'us/backend-engineer', sponsorCountry: 'US', scope: { sponsorshipCountry: 'US' } });
    const r = resolveBrowsePath('remote/backend-engineer');
    expect(r.ok && r.target.scope).toMatchObject({ remote: true, taxonomyId: 'backend_engineer' });
    const g = resolveBrowsePath('graduate/backend-engineer');
    expect(g.ok && g.target.scope).toMatchObject({ seniority: ['intern_newgrad'], internship: false });
    const i = resolveBrowsePath('internships');
    expect(i.ok && i.target.scope).toEqual({ internship: true });
  });

  it('round-trips stored params to the same target', () => {
    const r = resolveBrowsePath('backend-engineer/taipei');
    if (!r.ok) throw new Error('unresolved');
    expect(targetFromParams('role_city', r.target.params)?.path).toBe(r.target.path);
    expect(targetFromParams('role', { taxonomyId: 'nope' })).toBeNull();
  });

  it('city slugs drop the country prefix and resolve back', () => {
    const taipei = findCity('Taipei')!;
    expect(citySlug(taipei)).toBe('taipei');
    expect(resolveCity('taipei')?.id).toBe(taipei.id);
    expect(resolveCity('new-york')?.country).toBe('US');
  });

  it('tags pages per brand × type × slug', () => {
    expect(seoCacheTag('roboapply', 'role', 'backend-engineer')).toBe('seo:roboapply:role:backend-engineer');
    expect(seoCacheTag('goapply', 'role', 'backend-engineer')).not.toBe(seoCacheTag('roboapply', 'role', 'backend-engineer'));
  });
});

describe('public-job predicate (TASK_PLAN §2.2, ARCH §9.4)', () => {
  it('the Prisma where carries every base clause', () => {
    const w = basePublicWhere({ ...CTX, publicBoards: ['activejobs'] });
    expect(w).toMatchObject({ market: 'intl', visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null, publicDisplay: true, sourceBoard: { not: 'seed' } });
    const and = JSON.stringify(w.AND);
    expect(and).toContain('"fromRecruiterBank":true');
    expect(and).toContain('"in":["activejobs"]');
    expect(w.AND).toEqual(expect.arrayContaining([{ OR: [{ fraudFlags: { equals: Prisma.AnyNull } }, { fraudFlags: { equals: [] } }] }]));
  });

  it('page narrowing adds its clauses on top of the base', () => {
    const w = publicJobWhere({ taxonomyId: 'backend_engineer', city: { names: ['taipei'], country: 'TW' } }, CTX);
    const and = JSON.stringify(w.AND);
    expect(and).toContain('"has":"backend_engineer"');
    expect(and).toContain('"locationCountry":"TW"');
    expect(and).toContain('"mode":"insensitive"');
    expect(w.visibility).toBe('public');
  });

  it('planted rows: private imports, duplicates, closed, expired, flagged, seed and undisplayable rows never match', () => {
    const ok = seoJob();
    expect(matchesScope(ok, {}, CTX)).toBe(true);
    const planted = [
      seoJob({ visibility: 'private' }),
      seoJob({ isCanonical: false }),
      seoJob({ closedAt: NOW }),
      seoJob({ archivedAt: NOW }),
      seoJob({ expiresAt: new Date('2026-10-09T00:00:00Z') }),
      seoJob({ fraudFlags: [{ rule: 'x' }] }),
      seoJob({ sourceBoard: 'seed', fromRecruiterBank: false }),
      seoJob({ publicDisplay: false }),
      seoJob({ market: 'cn' }),
      // A provider row flagged at ingest but whose provider is no longer listed.
      seoJob({ fromRecruiterBank: false, sourceBoard: 'jsearch' }),
    ];
    for (const row of planted) expect(matchesScope(row, {}, CTX)).toBe(false);
  });

  it('a provider row is public only while its provider is in PUBLIC_DISPLAY_PROVIDERS', () => {
    const row = seoJob({ fromRecruiterBank: false, sourceBoard: 'greenhouse' });
    expect(allowedPublicBoards({})).toEqual([]);
    expect(matchesScope(row, {}, { ...CTX, publicBoards: allowedPublicBoards({ PUBLIC_DISPLAY_PROVIDERS: 'jsearch' }) })).toBe(false);
    expect(matchesScope(row, {}, { ...CTX, publicBoards: allowedPublicBoards({ PUBLIC_DISPLAY_PROVIDERS: 'ats_public, jsearch' }) })).toBe(true);
  });

  it('sponsorship needs a quote; remote honours the country scope', () => {
    expect(matchesScope(seoJob({ sponsorship: 'offered', sponsorshipEvidence: null, locationCountry: 'US' }), { sponsorshipCountry: 'US' }, CTX)).toBe(false);
    expect(matchesScope(seoJob({ sponsorship: 'offered', sponsorshipEvidence: 'We sponsor H-1B visas.', locationCountry: 'US' }), { sponsorshipCountry: 'US' }, CTX)).toBe(true);
    expect(matchesScope(seoJob({ workModel: 'remote', remoteScope: 'GB' }), { remote: true, country: 'US' }, CTX)).toBe(false);
    expect(matchesScope(seoJob({ workModel: 'remote', remoteScope: 'global' }), { remote: true, country: 'US' }, CTX)).toBe(true);
  });
});

describe('floors and the sample rule', () => {
  it('indexable only at or above the floor and never when filtered', () => {
    expect(INDEX_FLOORS).toMatchObject({ role: 20, role_city: 5, sponsorship_role: 5 });
    expect(isIndexable('role', 19)).toBe(false);
    expect(isIndexable('role', 20)).toBe(true);
    expect(isIndexable('role_city', 5)).toBe(true);
    expect(isIndexable('role_city', 4)).toBe(false);
    expect(isIndexable('sponsorship_role', 5)).toBe(true);
    expect(isIndexable('role', 500, { filtered: true })).toBe(false);
  });

  it('median pay needs ≥ 20 yearly rows in one currency', () => {
    const pay = (n: number, currency: string, value: number) =>
      Array.from({ length: n }, (_, i) => ({ salaryMin: value + i * 1000, salaryMax: value + i * 1000, salaryCurrency: currency, salaryPeriod: 'year', salaryDisclosed: true }));
    expect(medianPay(pay(19, 'USD', 100_000))).toBeNull();
    expect(medianPay([...pay(15, 'USD', 100_000), ...pay(15, 'EUR', 80_000)])).toBeNull();
    const m = medianPay(pay(21, 'USD', 100_000));
    expect(m).toMatchObject({ currency: 'USD', period: 'year', sampleSize: 21, value: 110_000 });
    // Hourly and undisclosed rows never enter a yearly median.
    expect(medianPay(pay(25, 'USD', 50).map((r) => ({ ...r, salaryPeriod: 'hour' })))).toBeNull();
    expect(medianPay(pay(25, 'USD', 100_000).map((r) => ({ ...r, salaryDisclosed: false })))).toBeNull();
    expect(median([1, 3, 2, 4])).toBe(2.5);
  });

  it('the stats view sources every number and carries N with the median', () => {
    const stats: SeoPageStats = { jobCount: 30, newLast7d: 4, payListed: 22, medianSalary: { value: 120000, currency: 'USD', period: 'year', sampleSize: 22 }, topCompanies: [{ name: 'Acme', count: 3 }], asOf: NOW.toISOString() };
    const v = statsView(stats);
    expect(v.jobCount).toMatchObject({ value: 30, source: 'index', asOf: NOW.toISOString() });
    expect(v.medianPay).toMatchObject({ sampleSize: 22, source: 'aggregate' });
    expect(v.payListed).toMatchObject({ value: 22, sampleSize: 30 });
    expect(statsView({ ...stats, medianSalary: undefined }).medianPay).toBeNull();
  });
});

describe('intros never add facts', () => {
  const stats: SeoPageStats = { jobCount: 42, newLast7d: 6, payListed: 21, medianSalary: { value: 130000, currency: 'USD', period: 'year', sampleSize: 21 }, topCompanies: [], asOf: NOW.toISOString() };
  const target = (() => {
    const r = resolveBrowsePath('backend-engineer/taipei');
    if (!r.ok) throw new Error('unresolved');
    return r.target;
  })();

  it('the template intro passes the number check', () => {
    const text = introText(target, stats);
    expect(text).toContain('42 open');
    expect(introNumbersMatch(text, stats, [target.role!.label, target.city!.name])).toBe(true);
  });

  it('a paraphrase with an invented number is rejected', () => {
    expect(introNumbersMatch('42 open roles; 90% of them pay well.', stats)).toBe(false);
    expect(introNumbersMatch('Over 50 open roles.', stats)).toBe(false);
  });

  it('template params are exactly the stats fields', () => {
    const intro = introFor(target, stats);
    expect(intro).toEqual({ template: 'role_city', params: { count: 42, newLast7d: 6, payListed: 21, median: 130000, currency: 'USD', sampleSize: 21 } });
    expect(introFor(target, { ...stats, jobCount: 0 }).template).toBe('empty');
  });
});

describe('one predicate for both markets (D5)', () => {
  const CN: ScopeContext = { market: 'cn', now: NOW, publicBoards: [] };

  it('a cn row is judged by the same clauses as an intl row, each in its own market only', () => {
    const cn = seoJob({ market: 'cn', sourceBoard: 'gohire' });
    expect(matchesScope(cn, {}, CN)).toBe(true);
    expect(matchesScope(cn, {}, CTX)).toBe(false);
    expect(matchesScope(seoJob(), {}, CN)).toBe(false);
    for (const row of [
      seoJob({ market: 'cn', visibility: 'private' }),
      seoJob({ market: 'cn', publicDisplay: false }),
      seoJob({ market: 'cn', fraudFlags: [{ rule: 'cn_fee' }] }),
      seoJob({ market: 'cn', closedAt: NOW }),
      seoJob({ market: 'cn', fromRecruiterBank: false, sourceBoard: 'greenhouse' }),
    ]) {
      expect(matchesScope(row, {}, CN)).toBe(false);
    }
    // A cn board row is public only while its provider is listed, like an intl one.
    const board = seoJob({ market: 'cn', fromRecruiterBank: false, sourceBoard: 'greenhouse' });
    expect(matchesScope(board, {}, { ...CN, publicBoards: allowedPublicBoards({ PUBLIC_DISPLAY_PROVIDERS: 'ats_public' }) })).toBe(true);
    expect(basePublicWhere(CN)).toMatchObject({ market: 'cn', visibility: 'public', publicDisplay: true });
  });

  it('publicListingsOpen: always for intl; for cn unless CN_RECRUITMENT_INFO_MODE is literally off', () => {
    expect(publicListingsOpen({ market: 'intl' }, { CN_RECRUITMENT_INFO_MODE: 'off' })).toBe(true);
    expect(publicListingsOpen({ market: 'cn' }, {})).toBe(true);
    expect(publicListingsOpen({ market: 'cn' }, { CN_RECRUITMENT_INFO_MODE: 'licensed' })).toBe(true);
    expect(publicListingsOpen({ market: 'cn' }, { CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' })).toBe(true);
    expect(publicListingsOpen({ market: 'cn' }, { CN_RECRUITMENT_INFO_MODE: 'off' })).toBe(false);
  });

  it('the service reads the hub and sitemap for GoApply from its own stored pages and rows', async () => {
    const { BRANDS } = await import('../../platform/brand/registry.js');
    const at = new Date('2026-10-09T04:00:00.000Z');
    const page = (brand: string) => ({
      brand,
      locale: brand === 'goapply' ? 'zh' : 'en',
      type: 'role',
      slug: 'backend-engineer',
      params: { taxonomyId: 'backend_engineer' },
      title: 'Backend engineer jobs',
      h1: 'Backend engineer jobs',
      intro: '',
      stats: {},
      jobCount: brand === 'goapply' ? 31 : 44,
      indexable: true,
      lastBuiltAt: at,
    });
    const repo = createMemorySeoRepo([seoJob({ id: 'cn1', market: 'cn', sourceBoard: 'gohire', title: '后端工程师', companyName: '示例' }), seoJob({ id: 'us1' })], [page('goapply'), page('roboapply')] as never);
    const svc = createSeoService({ repo, env: {}, now: () => NOW, isEnabled: async () => true });
    const hub = await svc.hub(BRANDS.goapply);
    expect(hub.pages).toEqual([expect.objectContaining({ kind: 'role', path: '/browse/backend-engineer', jobCount: expect.objectContaining({ value: 31 }) })]);
    expect((await svc.hub(BRANDS.roboapply)).pages[0]!.jobCount).toMatchObject({ value: 44 });
    const idx = await svc.sitemapIndex(BRANDS.goapply);
    expect(idx.parts.map((p) => p.name)).toEqual(['roles-1', 'jobs-1']);
    expect((await svc.sitemapPart(BRANDS.goapply, 'roles-1')).urls.map((u) => u.path)).toEqual(['/browse/backend-engineer']);
    expect((await svc.sitemapPart(BRANDS.goapply, 'jobs-1')).urls.map((u) => u.path)).toEqual(['/job/cn1']);
    // Mode off: every list is empty and every part is missing.
    const off = createSeoService({ repo, env: { CN_RECRUITMENT_INFO_MODE: 'off' }, now: () => NOW, isEnabled: async () => true });
    expect((await off.hub(BRANDS.goapply)).pages).toEqual([]);
    expect((await off.ticker(BRANDS.goapply)).items).toEqual([]);
    expect((await off.sitemapIndex(BRANDS.goapply)).parts).toEqual([]);
    await expect(off.sitemapPart(BRANDS.goapply, 'jobs-1')).rejects.toMatchObject({ code: 'not_found' });
    await expect(off.page(BRANDS.goapply, { path: 'backend-engineer' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(off.job(BRANDS.goapply, 'cn1')).rejects.toMatchObject({ code: 'not_found' });
    expect((await off.hub(BRANDS.roboapply)).pages).toHaveLength(1);
  });
});
