// @vitest-environment node
//
// WP-35 — the import service end to end over the fake Prisma, the memory
// credit stack and a spy `fetch` (no network, no database, no LLM):
//   - SSRF: the only outbound call is the Firecrawl API; the job link itself
//     is never fetched; denylisted, private and PI-carrying links never reach it;
//   - drafts store nothing and spend nothing; saves are private RAJobs that no
//     public count can see (checked through the company page's real count);
//     dedupe to the user's own import (same content or link) or a public job;
//   - the `job_import` credit, the hourly limit (a draft confirms once) and
//     the persisted locks, for the import route and the shared saveJob alike;
//   - warnings (rule-based scam signals, GoApply market hooks);
//   - enrichment in the request, the queue when it is slow.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createFakePrisma } from '../../../test/fakePrisma.js';
import { getBrand } from '../../../platform/brand/index.js';
import { HttpError } from '../../../platform/http.js';
import { createCreditTestKit } from '../../../platform/credits/testkit.js';
import type { EnrichOutcome } from '../enrich/index.js';
import type { MarketHookJob } from '../marketHooks.js';
import { FIRECRAWL_SCRAPE_URL, scrapeJobPage } from './firecrawl.js';
import { draftImportId } from './importId.js';
import { createImportLimitStore, type CounterDelegate } from './limits.js';
import { createPrismaImportRepository } from './repository.js';
import { createJobImportService, type JobImportDeps } from './service.js';
import { createCompanyReadService, type CompaniesDb } from '../companies/index.js';
import type { ImportJobResponse, ManualJob } from './contract.js';

const NOW = new Date('2026-10-10T12:00:00Z');
const LINK = 'https://careers.acme.example/jobs/42';
const LONG =
  'You will build and run the data platform that powers our analytics. You will work with product and engineering every day, and own the pipelines end to end.';

function ldPage(over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) {
  const posting = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Senior Data Engineer',
    hiringOrganization: { name: 'Acme' },
    description: `<p>${LONG}</p>`,
    jobLocation: { address: { addressLocality: 'Austin', addressRegion: 'TX', addressCountry: 'US' } },
    ...over,
  };
  return {
    success: true,
    data: {
      markdown: `# Senior Data Engineer\n\n${LONG}`,
      rawHtml: `<script type="application/ld+json">${JSON.stringify(posting)}</script>`,
      metadata: { title: 'Senior Data Engineer | Acme', sourceURL: LINK, statusCode: 200, ...meta },
    },
  };
}

let fake: ReturnType<typeof createFakePrisma>;
let kit: ReturnType<typeof createCreditTestKit>;
let fetchSpy: ReturnType<typeof vi.fn>;
let enrich: ReturnType<typeof vi.fn>;
let enqueueEnrich: ReturnType<typeof vi.fn>;
let afterNormalize: ReturnType<typeof vi.fn>;
let publicOn: boolean;
let hourlyAllowed: boolean;
let hourlyCalls: number;
let env: Record<string, string | undefined>;
let brandId: 'roboapply' | 'goapply';

function service(over: Partial<JobImportDeps> = {}) {
  return createJobImportService({
    repo: createPrismaImportRepository(() => fake as never),
    limits: createImportLimitStore({
      counters: fake.rARateCounter as unknown as CounterDelegate,
      brandId: 'roboapply',
      consume: async () => {
        hourlyCalls += 1;
        return { allowed: hourlyAllowed, retryAfterSec: hourlyAllowed ? 0 : 1800, remaining: 0, windows: [] };
      },
    }),
    credits: kit.credits,
    scrape: (url, e) => scrapeJobPage(url, { apiKey: e.FIRECRAWL_API_KEY, fetch: fetchSpy as never }),
    enrich: enrich as never,
    enqueueEnrich: enqueueEnrich as never,
    afterNormalize: afterNormalize as never,
    publicListingsOn: async () => publicOn,
    brand: () => getBrand(brandId),
    env,
    now: () => NOW,
    enrichTimeoutMs: 50,
    ...over,
  });
}

const manual = (over: Partial<ManualJob> = {}): ManualJob => ({
  title: 'Senior Data Engineer',
  company: 'Acme',
  description: LONG,
  applyUrl: LINK,
  location: 'Austin, TX',
  ...over,
});

beforeEach(() => {
  fake = createFakePrisma({
    seed: { user: [{ id: 'u1', name: 'Ada Lovelace', email: 'ada@example.test' }, { id: 'u2', name: 'Grace Hopper', email: 'grace@example.test' }] },
    uniqueFields: { rAJob: ['externalId'] },
  });
  kit = createCreditTestKit({ now: NOW });
  fetchSpy = vi.fn(async () => new Response(JSON.stringify(ldPage()), { status: 200 }));
  enrich = vi.fn(async (): Promise<EnrichOutcome> => ({ status: 'enriched', model: 'test', costUsd: 0 }));
  enqueueEnrich = vi.fn(async () => ({}));
  afterNormalize = vi.fn(async (job: MarketHookJob) => job);
  publicOn = true;
  hourlyAllowed = true;
  hourlyCalls = 0;
  env = { FIRECRAWL_API_KEY: 'fc-test', JWT_SECRET: 'jwt-test' };
  brandId = 'roboapply';
});
afterEach(() => vi.clearAllMocks());

const jobs = () => fake.$rows('rAJob');

const company = () => ({
  id: 'co_acme',
  market: 'intl',
  nameNormalized: 'acme',
  displayName: 'Acme',
  slug: 'acme',
  domain: null,
  logoUrl: null,
  website: null,
  industries: [],
  sizeBand: null,
  hqLocation: null,
  foundedYear: null,
  description: null,
  facts: null,
});

/** A live public listing of Acme with another link and title, so the import is not deduped onto it. */
const publicAcmeJob = () => ({
  id: 'pub_acme',
  externalId: 'aj:acme',
  sourceBoard: 'activejobs',
  visibility: 'public',
  publicDisplay: true,
  market: 'intl',
  companyId: 'co_acme',
  archivedAt: null,
  isCanonical: true,
  title: 'Office Manager',
  companyName: 'Acme',
  applyUrl: 'https://boards.example/acme/office-manager',
  sourceUrl: null,
  dedupeKey: 'acme-office',
  sourcePriority: 10,
  postedAt: NOW,
  lastSeenAt: NOW,
  fromRecruiterBank: false,
  employerVerified: false,
  isAgency: false,
  salaryDisclosed: false,
});
async function used(userId = 'u1') {
  const usage = await kit.credits.usage(userId);
  return usage.find((u) => u.bucket === 'job_import')!.used;
}

describe('reading a link (draft)', () => {
  it('calls only the Firecrawl API, returns a draft to confirm, stores nothing and spends nothing', async () => {
    const r = await service().importJob('u1', { url: LINK });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual([FIRECRAWL_SCRAPE_URL]);
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('acme.example'))).toBe(false);
    expect(r).toMatchObject({ status: 'needs_fields', jobId: null, reason: null, missingFields: [], matched: null });
    expect(r.draft).toMatchObject({ title: 'Senior Data Engineer', company: 'Acme', location: 'Austin, TX, US', applyUrl: LINK });
    expect(r.draft?.sources.title).toBe('job_data');
    expect(r.importId.startsWith('draft_')).toBe(true);
    expect(jobs()).toHaveLength(0);
    expect(await used()).toBe(0);
  });

  it('never sends a denylisted link to Firecrawl: LinkedIn → needs_text, link kept for the paste form', async () => {
    const r = await service().importJob('u1', { url: 'https://www.linkedin.com/jobs/view/3900000000' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: 'needs_text', reason: 'blocked_site' });
    expect(r.draft?.applyUrl).toBe('https://www.linkedin.com/jobs/view/3900000000');
  });

  it('discards a page that redirected onto a denylisted board', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(ldPage({}, { sourceURL: 'https://uk.indeed.com/viewjob?jk=1' }))));
    const r = await service().importJob('u1', { url: 'https://short.example/abc' });
    expect(r).toMatchObject({ status: 'needs_text', reason: 'blocked_site', draft: { title: null } });
  });

  it('refuses private and IP addresses without any outbound call', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data', 'http://localhost:4611/api', 'http://10.1.2.3/']) {
      const r = await service().importJob('u1', { url });
      expect(r).toMatchObject({ status: 'failed', reason: 'not_a_web_address', draft: null });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('runs the no-PI check before Firecrawl: a link with the user’s email is refused', async () => {
    const r = await service().importJob('u1', { url: `${LINK}?ref=ada@example.test` });
    expect(r).toMatchObject({ status: 'failed', reason: 'personal_info_in_link' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('GoApply on the mainland stack never calls Firecrawl', async () => {
    brandId = 'goapply';
    env = { ...env, DEPLOY_REGION: 'cn-mainland' };
    const r = await service().importJob('u1', { url: 'https://campus.example.cn/job/1' });
    expect(r).toMatchObject({ status: 'needs_text', reason: 'fetch_unavailable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('without a Firecrawl key the user is asked to paste the text', async () => {
    env = { JWT_SECRET: 'jwt-test' };
    const r = await service().importJob('u1', { url: LINK });
    expect(r).toMatchObject({ status: 'needs_text', reason: 'fetch_unavailable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps unreadable pages to failed with a reason', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('oops', { status: 502 }));
    expect(await service().importJob('u1', { url: LINK })).toMatchObject({ status: 'failed', reason: 'fetch_failed' });
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { markdown: 'Log in', rawHtml: '', metadata: {} } })));
    expect(await service().importJob('u1', { url: LINK })).toMatchObject({ status: 'failed', reason: 'nothing_found' });
  });

  it('lists missing fields when the page does not name them', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(ldPage({ hiringOrganization: undefined }))));
    const r = await service().importJob('u1', { url: LINK });
    expect(r.status).toBe('needs_fields');
    expect(r.missingFields).toEqual(['company']);
    expect(r.draft?.company).toBeNull();
  });

  it('warns before saving: rule-based scam signals (intl) and market hooks (GoApply fraud rules)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(ldPage({ description: `${LONG} You must pay a $50 fee to apply for this role.` }))),
    );
    const r = await service().importJob('u1', { url: LINK });
    expect(r.warnings.map((w) => w.rule)).toContain('intl_pay_to_apply');
    expect(r.warnings[0]?.evidence).toMatch(/fee to apply/);

    brandId = 'goapply';
    afterNormalize.mockImplementation(async (job: MarketHookJob) => ({ ...job, fraudFlags: [{ rule: 'cn_training_loan', evidence: '入职需办理培训贷', at: NOW.toISOString() }] }));
    const cn = await service().importJob('u1', { url: 'https://hr.example.cn/job/9' });
    expect(cn.warnings).toEqual([{ rule: 'cn_training_loan', evidence: '入职需办理培训贷' }]);
    expect(afterNormalize).toHaveBeenLastCalledWith(expect.objectContaining({ market: 'cn', provider: 'user_import' }), expect.objectContaining({ stage: 'import', brand: 'goapply', userId: 'u1' }));
  });
});

describe('saving a job', () => {
  it('creates a private user_import RAJob that no public count can see, spends one credit and enriches it', async () => {
    fake.$rows('rACompany').push(company());
    fake.$rows('rAJob').push(publicAcmeJob());
    const r = await service().importJob('u1', { manual: manual({ applyUrl: 'https://careers.acme.example/jobs/77' }) }, 'idem-1');
    expect(r).toMatchObject({ status: 'done', matched: null, missingFields: [], draft: null });
    expect(r.importId).toBe(`job_${r.jobId}`);
    const row = jobs().find((j) => j.id === r.jobId)!;
    expect(row).toMatchObject({
      id: r.jobId,
      visibility: 'private',
      ownerUserId: 'u1',
      sourceBoard: 'user_import',
      publicDisplay: false,
      fromRecruiterBank: false,
      employerVerified: false,
      applicantCount: null,
      sourceName: null,
      market: 'intl',
      companyId: 'co_acme',
      applyUrl: 'https://careers.acme.example/jobs/77',
      expiresAt: null,
      sourcePriority: 90,
    });
    // The company page's real "open jobs" count (liveJobWhere) still sees only the public job,
    // for a signed-in viewer and for anyone (D3: imports never appear in counts).
    const companies = createCompanyReadService(fake as unknown as CompaniesDb, () => NOW);
    expect((await companies.profile('intl', 'co_acme', { publicOnly: false })).openJobs.value).toBe(1);
    expect((await companies.profile('intl', 'co_acme')).openJobs.value).toBe(1);
    expect((await companies.jobs('intl', 'co_acme', undefined, { publicOnly: false })).items.map((i) => i.jobId)).toEqual(['pub_acme']);
    expect(await used()).toBe(1);
    expect(enrich).toHaveBeenCalledWith(r.jobId);
    expect(enqueueEnrich).not.toHaveBeenCalled();
  });

  it('a job typed without a link is saved with an empty apply link', async () => {
    const r = await service().importJob('u1', { manual: manual({ applyUrl: undefined }) });
    expect(jobs().find((j) => j.id === r.jobId)?.applyUrl).toBe('');
  });

  it('links an existing company record of the market but never creates one', async () => {
    fake.$rows('rACompany').push({ id: 'co_acme', market: 'intl', nameNormalized: 'acme', displayName: 'Acme' });
    const r = await service().importJob('u1', { manual: manual() });
    expect(jobs().find((j) => j.id === r.jobId)?.companyId).toBe('co_acme');
    await service().importJob('u1', { manual: manual({ company: 'Brand New Startup', title: 'Designer' }) });
    expect(fake.$rows('rACompany')).toHaveLength(1);
  });

  it('the same job twice → the first one back, no second charge; a removed one is restored', async () => {
    const svc = service();
    const first = await svc.importJob('u1', { manual: manual() });
    const again = await svc.importJob('u1', { manual: manual({ description: `${LONG} (copied again)` }) });
    expect(again).toMatchObject({ status: 'done', jobId: first.jobId, matched: 'yours' });
    expect(jobs()).toHaveLength(1);
    expect(await used()).toBe(1);

    await svc.removeAdded('u1', first.jobId!);
    expect(jobs()[0]?.archivedAt).toBeInstanceOf(Date);
    const back = await svc.importJob('u1', { manual: manual() });
    expect(back).toMatchObject({ jobId: first.jobId, matched: 'yours' });
    expect(jobs()[0]?.archivedAt).toBeNull();
    expect(await used()).toBe(1);
  });

  it('dedupes to a live public job of the same market (by link or same title, company and place) without charging', async () => {
    fake.$rows('rAJob').push(
      { id: 'pub_1', externalId: 'aj:1', sourceBoard: 'activejobs', visibility: 'public', market: 'intl', archivedAt: null, isCanonical: true, applyUrl: LINK, sourceUrl: null, dedupeKey: 'x', sourcePriority: 10 },
      { id: 'other_private', externalId: 'u:u2:zzz', sourceBoard: 'user_import', visibility: 'private', ownerUserId: 'u2', market: 'intl', archivedAt: null, isCanonical: true, applyUrl: 'https://only.u2.example/job', sourceUrl: null, dedupeKey: 'y', sourcePriority: 90 },
    );
    const r = await service().importJob('u1', { manual: manual() });
    expect(r).toMatchObject({ status: 'done', jobId: 'pub_1', matched: 'public' });
    expect(await used()).toBe(0);

    // Another user's private import is never a match.
    const mine = await service().importJob('u1', { manual: manual({ applyUrl: 'https://only.u2.example/job', title: 'Other role' }) });
    expect(mine.matched).toBeNull();
    expect(mine.jobId).not.toBe('other_private');
  });

  it('does not surface public listings where the brand may not show them (GoApply recruitment-info mode off)', async () => {
    fake.$rows('rAJob').push({ id: 'pub_cn', externalId: 'g:1', sourceBoard: 'gohire', visibility: 'public', market: 'cn', archivedAt: null, isCanonical: true, applyUrl: LINK, sourceUrl: null, dedupeKey: 'x', sourcePriority: 15 });
    brandId = 'goapply';
    publicOn = false;
    const r = await service().importJob('u1', { manual: manual() });
    expect(r.matched).toBeNull();
    expect(jobs().find((j) => j.id === r.jobId)).toMatchObject({ visibility: 'private', market: 'cn' });
  });

  it('stores the warnings on the job and returns them', async () => {
    const r = await service().importJob('u1', { manual: manual({ description: `${LONG} An application fee is required to apply.` }) });
    expect(r.warnings.map((w) => w.rule)).toContain('intl_pay_to_apply');
    expect(jobs()[0]?.fraudFlags).toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'intl_pay_to_apply', at: NOW.toISOString() })]));
  });

  it('slow or deferred enrichment continues in the queue', async () => {
    enrich.mockImplementationOnce(() => new Promise(() => undefined));
    const slow = await service().importJob('u1', { manual: manual() });
    expect(slow.status).toBe('done');
    expect(enqueueEnrich).toHaveBeenCalledWith(slow.jobId, 'intl');

    enrich.mockResolvedValueOnce({ status: 'deferred', retryAfterMs: 1000 });
    const deferred = await service().importJob('u1', { manual: manual({ title: 'Analytics Engineer' }) });
    expect(enqueueEnrich).toHaveBeenLastCalledWith(deferred.jobId, 'intl');
  });

  it('out of credits → 402 credits_exhausted and nothing saved (free: 10 a day)', async () => {
    const svc = service();
    for (let i = 0; i < 10; i += 1) await svc.importJob('u1', { manual: manual({ title: `Role ${i}` }) });
    expect(jobs()).toHaveLength(10);
    await expect(svc.importJob('u1', { manual: manual({ title: 'Role 11' }) })).rejects.toMatchObject({ code: 'credits_exhausted', bucket: 'job_import' });
    expect(jobs()).toHaveLength(10);
    expect(enrich).toHaveBeenCalledTimes(10);
  });

  it('saveJob is the shared save for the extension (F-EXT-09), under the same hourly limit', async () => {
    const r = await service().saveJob('u1', manual(), { source: 'extension', idempotencyKey: 'ext-1' });
    expect(r).toMatchObject({ status: 'done', matched: null });
    expect(await used()).toBe(1);
    expect(hourlyCalls).toBe(1);

    hourlyAllowed = false;
    const err = await service().saveJob('u1', manual({ title: 'Other role' }), { source: 'extension' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'rate_limited', details: { reason: 'import_hourly_limit' }, headers: { 'Retry-After': '1800' } });
    expect(jobs()).toHaveLength(1);
  });

  it('a second posting with the same title, company and place is a new job, not "already added"', async () => {
    const svc = service();
    const first = await svc.importJob('u1', { manual: manual() });
    const second = await svc.importJob('u1', { manual: manual({ applyUrl: 'https://careers.acme.example/jobs/43', description: `${LONG} This one is on the platform team.` }) });
    expect(second.matched).toBeNull();
    expect(second.jobId).not.toBe(first.jobId);
    expect(jobs()).toHaveLength(2);
    expect(await used()).toBe(2);

    // Typed in without a link, same title, company and place but another post: also new.
    const typed = await svc.importJob('u1', { manual: manual({ applyUrl: undefined, description: `${LONG} Contract role.` }) });
    expect(typed.matched).toBeNull();
    expect(jobs()).toHaveLength(3);
  });
});

describe('limits', () => {
  it('the hourly limit answers 429 with a reason; a save confirming a signed draft is not counted again', async () => {
    const svc = service();
    const draft = await svc.importJob('u1', { url: LINK });
    expect(hourlyCalls).toBe(1);
    await svc.importJob('u1', { manual: manual(), importId: draft.importId });
    expect(hourlyCalls).toBe(1);
    // The same draft again is a new import: the nonce was used.
    await svc.importJob('u1', { manual: manual({ title: 'Second save' }), importId: draft.importId });
    expect(hourlyCalls).toBe(2);
    // A forged or other user's draft id is counted.
    const foreign = draftImportId({ userId: 'u2', status: 'needs_fields', missingFields: [], reason: null }, { env, now: NOW });
    await svc.importJob('u1', { manual: manual({ title: 'Other' }), importId: foreign });
    expect(hourlyCalls).toBe(3);

    hourlyAllowed = false;
    const err = await svc.importJob('u1', { url: LINK }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ code: 'rate_limited', details: { reason: 'import_hourly_limit', retryAfterSec: 1800 }, headers: { 'Retry-After': '1800' } });
  });

  it('a draft id cannot be replayed to get around the hourly limit, and a failed read never confirms', async () => {
    const svc = service();
    // A refused link costs one unit and returns a signed 'failed' draft.
    const failed = await svc.importJob('u1', { url: 'http://10.0.0.1/' });
    expect(failed.status).toBe('failed');
    expect(hourlyCalls).toBe(1);
    for (let i = 0; i < 3; i += 1) await svc.importJob('u1', { manual: manual({ title: `Role ${i}` }), importId: failed.importId });
    expect(hourlyCalls).toBe(4);

    // A real draft confirms once; every replay is counted, and over the limit is refused.
    const draft = await svc.importJob('u1', { url: LINK });
    await svc.importJob('u1', { manual: manual({ title: 'Kept' }), importId: draft.importId });
    expect(hourlyCalls).toBe(5);
    hourlyAllowed = false;
    const err = await svc.importJob('u1', { manual: manual({ title: 'Replay' }), importId: draft.importId }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'rate_limited', details: { reason: 'import_hourly_limit' } });
    expect(jobs().map((j) => j.title)).not.toContain('Replay');
    expect(fake.$rows('rARateCounter').filter((r) => String(r.key).startsWith('rl:roboapply:jobImportDraftUsed:user:u1:'))).toHaveLength(1);
  });

  it('the shared saveJob (extension, Assistant) is refused while the user is locked', async () => {
    const svc = service();
    for (let i = 0; i < 20; i += 1) await svc.importJob('u1', { url: `http://10.0.0.${i}/` });
    const err = await svc.saveJob('u1', manual(), { source: 'extension' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'rate_limited', details: { reason: 'import_locked' } });
    expect(jobs()).toHaveLength(0);
  });

  it('20 failed imports in a row lock imports for an hour (persisted), even saves', async () => {
    const svc = service();
    for (let i = 0; i < 20; i += 1) await svc.importJob('u1', { url: `http://10.0.0.${i}/` });
    const err = await svc.importJob('u1', { manual: manual() }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'rate_limited', details: { reason: 'import_locked', lockedUntil: new Date(NOW.getTime() + 3_600_000).toISOString() } });
    expect(fake.$rows('rARateCounter').some((r) => String(r.key).includes('jobImportLock:user:u1'))).toBe(true);
    // Another user is not affected.
    expect((await svc.importJob('u2', { manual: manual() })).status).toBe('done');
  });

  it('a successful read resets the failure run; needs_text is not a failure', async () => {
    const svc = service();
    for (let i = 0; i < 19; i += 1) await svc.importJob('u1', { url: `http://10.0.0.${i}/` });
    await svc.importJob('u1', { url: 'https://www.linkedin.com/jobs/view/1' });
    await svc.importJob('u1', { url: LINK });
    for (let i = 0; i < 19; i += 1) await svc.importJob('u1', { url: `http://10.0.1.${i}/` });
    expect((await svc.importJob('u1', { manual: manual() })).status).toBe('done');
  });
});

describe('status, list and remove', () => {
  it('status: a saved job, a signed draft, and not found otherwise', async () => {
    const svc = service();
    const saved = await svc.importJob('u1', { manual: manual() });
    expect(await svc.status('u1', saved.importId)).toEqual({ status: 'done', jobId: saved.jobId, missingFields: [], warnings: [], reason: null });
    await expect(svc.status('u2', saved.importId)).rejects.toMatchObject({ code: 'not_found', details: { reason: 'import_not_found' } });

    const blocked = await svc.importJob('u1', { url: 'https://www.glassdoor.com/job-listing/x' });
    expect(await svc.status('u1', blocked.importId)).toEqual({
      status: 'needs_text',
      jobId: null,
      missingFields: ['title', 'company', 'description'],
      warnings: [],
      reason: 'blocked_site',
    });
    await expect(svc.status('u1', 'garbage')).rejects.toMatchObject({ code: 'not_found' });
    await expect(svc.status('u1', 'job_missing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lists only the user’s live imports, newest first, with tracker status and a cursor', async () => {
    const svc = service();
    const made: ImportJobResponse[] = [];
    for (let i = 0; i < 3; i += 1) {
      made.push(await svc.importJob('u1', { manual: manual({ title: `Role ${i}` }) }));
      jobs()[jobs().length - 1]!.createdAt = new Date(NOW.getTime() + i * 1000);
    }
    await svc.importJob('u2', { manual: manual({ title: 'Theirs' }) });
    fake.$rows('rATrackerEntry').push({ id: 't1', userId: 'u1', jobId: made[2]!.jobId, status: 'applied', deletedAt: null });

    const p1 = await svc.listAdded('u1', { limit: 2 });
    expect(p1.items.map((i) => i.title)).toEqual(['Role 2', 'Role 1']);
    expect(p1.items[0]).toMatchObject({ trackerStatus: 'applied', sourceHost: 'careers.acme.example', applyUrl: LINK, warnings: [] });
    expect(p1.cursor).toBeTruthy();
    const p2 = await svc.listAdded('u1', { limit: 2, cursor: p1.cursor! });
    expect(p2.items.map((i) => i.title)).toEqual(['Role 0']);
    expect(p2.cursor).toBeNull();

    await svc.removeAdded('u1', made[1]!.jobId!);
    expect((await svc.listAdded('u1', { limit: 10 })).items.map((i) => i.title)).toEqual(['Role 2', 'Role 0']);
    await expect(svc.removeAdded('u2', made[0]!.jobId!)).rejects.toMatchObject({ code: 'not_found' });
  });
});
