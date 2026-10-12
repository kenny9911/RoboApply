// @vitest-environment node
//
// server/src/features/jobs/liveness/check.test.ts — the on-demand posting
// check (MKT-5C; JI-10). No network and no database: the ATS is a fake fetch
// that records every request, the database a fake Prisma.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../../test/fakePrisma.js';
// The ingest upsert's own rule for "a source lists a closed row again" (a test may read another area's internals).
import { REVIVED_CLOSE_REASONS, revivesOnRelist } from '../ingest/upsert.js';
import {
  LIVENESS_BOARD_CLOSE_REASON,
  LIVENESS_CLOSE_REASON,
  LIVENESS_HOSTS,
  LIVENESS_HOST_PAUSE_MAX_MS,
  LIVENESS_HOST_PAUSE_MS,
  LIVENESS_HOST_REQUESTS_PER_MINUTE,
  LIVENESS_JOB_SELECT,
  applyLiveness,
  checkJobLive,
  checkPostingLive,
  confirmListing,
  createLivenessCache,
  createLivenessHosts,
  ingestDedupeRepair,
  isBoardRowOfKey,
  livenessRecheckHours,
  postingTargetOf,
  requestPosting,
  resetLivenessForTests,
  retryAfterMs,
  type LiveResult,
  type LivenessDb,
  type LivenessFetch,
  type LivenessJob,
} from './index.js';

const NOW = new Date('2026-10-12T08:00:00.000Z');
const HOUR = 3_600_000;
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * HOUR);
const UUID = 'f2ab14ed-0258-4dc6-bd52-c96eb7d968e5';

/**
 * SYNTHETIC rows: no real employer, board or posting. The default row is an
 * aggregator's copy of a Greenhouse posting (`job()`); `boardRow()` is the row
 * of our own sync of that Greenhouse board.
 */
function job(over: Partial<LivenessJob> = {}): LivenessJob {
  return {
    id: 'j1',
    market: 'intl',
    visibility: 'public',
    sourceBoard: 'jsearch',
    externalId: 'jsearch:abc',
    fromRecruiterBank: false,
    atsPostingKey: 'greenhouse:acme:1',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    sourceUrl: null,
    lastSeenAt: hoursAgo(30),
    archivedAt: null,
    closedAt: null,
    ...over,
  };
}

const boardRow = (over: Partial<LivenessJob> = {}): LivenessJob => job({ id: 'board-row', sourceBoard: 'greenhouse', externalId: 'acme:1', ...over });

interface Call {
  url: string;
  headers: Record<string, string>;
  redirect: string | undefined;
}

/** A fake ATS: `answer(url)` decides the status and the body; every request is recorded. */
function fakeAts(answer: (url: string) => { status: number; body?: unknown; text?: string; headers?: Record<string, string> } | Promise<never>) {
  const calls: Call[] = [];
  const fetch: LivenessFetch = async (url, init) => {
    calls.push({ url, headers: init.headers ?? {}, redirect: init.redirect });
    const res = await answer(url);
    const sent = Object.fromEntries(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: res.status, text: async () => res.text ?? JSON.stringify(res.body ?? {}), headers: { get: (name: string) => sent[name.toLowerCase()] ?? null } };
  };
  return { fetch, calls };
}

const listed = (id: string | number, extra: Record<string, unknown> = {}) => ({ status: 200, body: { id, title: 'SYNTHETIC posting', ...extra } });
const GH_GONE = { status: 404, body: { status: 404, error: 'Job not found' } };
const LEVER_GONE = { status: 404, body: { ok: false, error: 'Document not found' } };

const check = (j: LivenessJob, fetch: LivenessFetch, extra: Parameters<typeof checkPostingLive>[1] = {}) =>
  checkPostingLive(j, { fetch, env: {}, now: () => NOW, ...extra });

beforeEach(() => resetLivenessForTests());

describe('the request: one documented JSON endpoint per ATS, built from the stored key', () => {
  it('Greenhouse: GET boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}', async () => {
    const ats = fakeAts(() => listed(1));
    const res = await check(job(), ats.fetch);
    expect(ats.calls.map((c) => c.url)).toEqual(['https://boards-api.greenhouse.io/v1/boards/acme/jobs/1']);
    expect(res).toMatchObject({ state: 'open', via: 'ats_api', reason: 'listed', requested: true });
    expect(res.checkedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('Lever: GET api.lever.co/v0/postings/{site}/{id}', async () => {
    const ats = fakeAts(() => listed(UUID));
    const res = await check(job({ atsPostingKey: `lever:acme:${UUID}`, applyUrl: `https://jobs.lever.co/acme/${UUID}/apply` }), ats.fetch);
    expect(ats.calls.map((c) => c.url)).toEqual([`https://api.lever.co/v0/postings/acme/${UUID}`]);
    expect(res.state).toBe('open');
  });

  it('SmartRecruiters: GET api.smartrecruiters.com/v1/companies/{id}/postings/{postingId}', async () => {
    const ats = fakeAts(() => listed('744000000000123', { active: true }));
    const res = await check(job({ atsPostingKey: 'smartrecruiters:acmegroup:744000000000123', applyUrl: 'https://jobs.smartrecruiters.com/AcmeGroup/744000000000123-engineer' }), ats.fetch);
    expect(ats.calls.map((c) => c.url)).toEqual(['https://api.smartrecruiters.com/v1/companies/AcmeGroup/postings/744000000000123']);
    expect(res.state).toBe('open');
  });

  it('asks for JSON, says who is asking, and never follows a redirect', async () => {
    const ats = fakeAts(() => listed(1));
    await check(job(), ats.fetch);
    await check(job({ id: 'j2', market: 'cn', atsPostingKey: 'greenhouse:acme:2', applyUrl: 'https://boards.greenhouse.io/acme/jobs/2' }), fakeAts(() => listed(2)).fetch);
    const [intl] = ats.calls;
    expect(intl!.headers.Accept).toBe('application/json');
    expect(intl!.headers['User-Agent']).toMatch(/^RoboApplyJobs\/1\.0 \(\+/);
    expect(intl!.redirect).toBe('error');
    // The row's market signs the request: a mainland row is asked as GoApply.
    const cn = fakeAts(() => listed(3));
    await check(job({ id: 'j3', market: 'cn', atsPostingKey: 'greenhouse:acme:3', applyUrl: null }), cn.fetch);
    expect(cn.calls[0]!.headers['User-Agent']).toMatch(/^GoApplyJobs\/1\.0 \(\+/);
  });

  it('the URL comes from the stored key, not from where the row links to', async () => {
    const ats = fakeAts(() => listed(1));
    // The apply link names another board, the posting page is the employer's own site: neither reaches the URL.
    await check(job({ applyUrl: 'https://boards.greenhouse.io/othercorp/jobs/999', sourceUrl: 'https://careers.acme.example/jobs/1?gh_jid=1' }), ats.fetch);
    expect(ats.calls.map((c) => c.url)).toEqual(['https://boards-api.greenhouse.io/v1/boards/acme/jobs/1']);
  });

  it('a link that names the same key lends only its letter case (Lever reads the site name with regard to case)', async () => {
    const ats = fakeAts(() => listed(UUID));
    await check(job({ atsPostingKey: `lever:acmelabs:${UUID}`, applyUrl: `https://jobs.lever.co/AcmeLabs/${UUID}` }), ats.fetch);
    expect(ats.calls.map((c) => c.url)).toEqual([`https://api.lever.co/v0/postings/AcmeLabs/${UUID}`]);
  });

  it('an employer-board row is asked under its own board token and posting id (its page may live on the employer site)', async () => {
    const ats = fakeAts(() => listed('744000000000123'));
    const row = job({ sourceBoard: 'smartrecruiters', externalId: 'AcmeGroup:744000000000123#cn', atsPostingKey: 'smartrecruiters:acmegroup:744000000000123', applyUrl: 'https://careers.acme.example/apply/123', market: 'cn' });
    expect(postingTargetOf(row)).toEqual({
      ok: true,
      target: {
        ats: 'smartrecruiters',
        key: 'smartrecruiters:acmegroup:744000000000123',
        tenant: 'AcmeGroup',
        postingId: '744000000000123',
        url: 'https://api.smartrecruiters.com/v1/companies/AcmeGroup/postings/744000000000123',
        spelling: 'board',
      },
    });
    // The other two sources of a spelling: a link that names the key, and the key itself.
    expect(postingTargetOf(job())).toMatchObject({ ok: true, target: { spelling: 'link' } });
    expect(postingTargetOf(job({ applyUrl: null }))).toMatchObject({ ok: true, target: { spelling: 'key', tenant: 'acme' } });
    await check(row, ats.fetch);
    expect(ats.calls).toHaveLength(1);
  });

  it('every request goes to one of the three hosts, whatever the key holds', async () => {
    const ats = fakeAts(() => listed(1));
    const keys = [
      'greenhouse:acme:1',
      `lever:acme:${UUID}`,
      'smartrecruiters:acme:744000000000123',
      'greenhouse:acme/../../evil:1',
      'greenhouse:acme:1/../../x',
      'greenhouse:evil.example:1',
      'greenhouse:acme:1?x=https://evil.example',
      'https://evil.example/a:b:1',
      'workday:acme:R-1',
      'ashby:acme:4a1b2c3d-0000-4000-8000-000000000000',
    ];
    for (const [i, key] of keys.entries()) {
      await check(job({ id: `k${i}`, atsPostingKey: key, applyUrl: key.startsWith('lever') ? `https://jobs.lever.co/acme/${UUID}` : null }), ats.fetch);
    }
    expect(ats.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of ats.calls) {
      const u = new URL(call.url);
      expect(u.protocol).toBe('https:');
      expect(LIVENESS_HOSTS).toContain(u.hostname);
    }
    expect([...LIVENESS_HOSTS].sort()).toEqual(['api.lever.co', 'api.smartrecruiters.com', 'boards-api.greenhouse.io']);
    // A tenant that looks like a host is still only a path segment of the Greenhouse API.
    expect(ats.calls.map((c) => c.url)).toContain('https://boards-api.greenhouse.io/v1/boards/evil.example/jobs/1');
    expect(ats.calls.some((c) => c.url.includes('..') || c.url.includes('evil.example/a'))).toBe(false);
  });

  it('requestPosting refuses any URL that is not https on one of the three hosts, before a request', async () => {
    const ats = fakeAts(() => listed(1));
    for (const url of [
      'http://boards-api.greenhouse.io/v1/boards/acme/jobs/1',
      'https://boards.greenhouse.io/acme/jobs/1',
      'https://api.ashbyhq.com/posting-api/job-board/acme',
      'https://api.eu.lever.co/v0/postings/acme/x',
      'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/site/jobs',
      'https://boards-api.greenhouse.io.evil.example/v1/boards/acme/jobs/1',
      'https://user:pw@boards-api.greenhouse.io/v1/boards/acme/jobs/1',
      'https://boards-api.greenhouse.io:8443/v1/boards/acme/jobs/1',
      'not a url',
    ]) {
      const answer = await requestPosting(url, { fetch: ats.fetch, env: {} });
      expect(answer.kind).toBe('error');
    }
    expect(ats.calls).toEqual([]);
  });
});

describe('what the answer means', () => {
  it('200 with the posting is open; the API\'s own 404 is closed', async () => {
    expect((await check(job(), fakeAts(() => listed(1)).fetch)).state).toBe('open');
    resetLivenessForTests();
    const gone = await check(job(), fakeAts(() => GH_GONE).fetch);
    expect(gone).toMatchObject({ state: 'closed', via: 'ats_api', reason: 'not_found', requested: true });
    resetLivenessForTests();
    // Lever: a row of our own board sync (the site name is the one the board API answered under).
    const leverBoardRow = job({ sourceBoard: 'lever', externalId: `AcmeLabs:${UUID}`, atsPostingKey: `lever:acmelabs:${UUID}`, applyUrl: 'https://careers.acme.example/jobs/1' });
    const lever = fakeAts(() => LEVER_GONE);
    expect(await check(leverBoardRow, lever.fetch)).toMatchObject({ state: 'closed', reason: 'not_found' });
    expect(lever.calls.map((c) => c.url)).toEqual([`https://api.lever.co/v0/postings/AcmeLabs/${UUID}`]);
  });

  it('Lever answers the same 404 for a site name in another letter case: under a spelling read from a link, a 404 is unknown, and a 200 still confirms', async () => {
    const linked = job({ atsPostingKey: `lever:acmelabs:${UUID}`, applyUrl: `https://jobs.lever.co/AcmeLabs/${UUID}/apply` });
    const gone = fakeAts(() => LEVER_GONE);
    expect(await check(linked, gone.fetch)).toEqual({ state: 'unknown', checkedAt: null, via: null, reason: 'not_found_unconfirmed', requested: true });
    expect(gone.calls).toHaveLength(1);
    resetLivenessForTests();
    expect((await check(linked, fakeAts(() => listed(UUID)).fetch)).state).toBe('open');
    // Greenhouse and SmartRecruiters read the tenant without regard to case: a 404 is the posting, whatever the spelling came from.
    resetLivenessForTests();
    expect((await check(job({ applyUrl: null }), fakeAts(() => GH_GONE).fetch)).state).toBe('closed');
    resetLivenessForTests();
    const sr = job({ atsPostingKey: 'smartrecruiters:acme:744000000000123', applyUrl: 'https://jobs.smartrecruiters.com/Acme/744000000000123' });
    expect((await check(sr, fakeAts(() => ({ status: 404, body: { message: 'not found' } })).fetch)).state).toBe('closed');
  });

  it.each([
    ['a 500', { status: 500, body: { error: 'oops' } }, 'http_500'],
    ['a 503', { status: 503, text: 'Service Unavailable' }, 'http_503'],
    ['a 429', { status: 429, body: { error: 'slow down' } }, 'http_429'],
    ['a 400 (SmartRecruiters for an id of no posting of the company)', { status: 400, body: { code: 'ILLEGAL_ARGUMENT' } }, 'http_400'],
    ['a 403', { status: 403, text: 'Forbidden' }, 'http_403'],
    ['a redirect', { status: 302, text: '' }, 'redirect'],
    ['a 404 that is not the API\'s JSON answer (a page from something in between)', { status: 404, text: '<html><body>Not Found</body></html>' }, 'http_404_not_json'],
    ['a 404 whose JSON is not an object', { status: 404, text: '"nope"' }, 'http_404_not_json'],
    ['a 200 that is not JSON', { status: 200, text: '<html>careers</html>' }, 'not_json'],
    ['a 200 with another posting', { status: 200, body: { id: 2 } }, 'unexpected_shape'],
    ['a 200 with a list', { status: 200, body: { jobs: [] } }, 'unexpected_shape'],
  ])('%s is unknown and nothing is concluded', async (_name, response, reason) => {
    const ats = fakeAts(() => response);
    const res = await check(job(), ats.fetch);
    expect(res).toEqual({ state: 'unknown', checkedAt: null, via: null, reason, requested: true });
    expect(ats.calls).toHaveLength(1);
  });

  it('a timeout is unknown', async () => {
    const hang: LivenessFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const res = await checkPostingLive(job(), { fetch: hang, env: {}, now: () => NOW, timeoutMs: 5 });
    expect(res).toMatchObject({ state: 'unknown', reason: 'timeout', requested: true });
  });

  it('a network failure is unknown', async () => {
    const res = await check(job(), async () => Promise.reject(new Error('ECONNRESET')));
    expect(res).toMatchObject({ state: 'unknown', reason: 'network' });
  });

  it('a SmartRecruiters posting the API marks inactive is neither confirmed nor closed', async () => {
    const res = await check(job({ atsPostingKey: 'smartrecruiters:acme:744000000000123', applyUrl: null }), fakeAts(() => listed('744000000000123', { active: false })).fetch);
    expect(res.state).toBe('unknown');
  });
});

describe('which rows are asked about', () => {
  const never = () => fakeAts(() => Promise.reject(new Error('no request expected')) as Promise<never>);

  it.each([
    ['a Workday-keyed row', { atsPostingKey: 'workday:acme:R-12345', applyUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Austin/Engineer_R-12345' }, 'ats_not_supported'],
    ['an iCIMS-keyed row', { atsPostingKey: 'icims:careers-acme:4321', applyUrl: 'https://careers-acme.icims.com/jobs/4321/job' }, 'ats_not_supported'],
    ['an Ashby-keyed row', { atsPostingKey: 'ashby:acme:4a1b2c3d-0000-4000-8000-000000000000' }, 'ats_not_supported'],
    ['a Workable-keyed row', { atsPostingKey: 'workable:acme:ABC123DEF4' }, 'ats_not_supported'],
    ["a Lever EU row (its host is not one of the three)", { atsPostingKey: `lever_eu:acme:${UUID}`, applyUrl: `https://jobs.eu.lever.co/acme/${UUID}` }, 'ats_not_supported'],
    ['a row with no key', { atsPostingKey: null }, 'no_key'],
    ['a key that is not three parts', { atsPostingKey: 'greenhouse:acme' }, 'no_key'],
    ['a Greenhouse key whose id is not a number', { atsPostingKey: 'greenhouse:acme:abc' }, 'key_not_valid'],
    ['a Lever key whose id is not a uuid', { atsPostingKey: 'lever:acme:123', applyUrl: null }, 'key_not_valid'],
    ['a Lever key with no link that spells its site name', { atsPostingKey: `lever:acmelabs:${UUID}`, applyUrl: 'https://careers.acme.example/jobs/1', sourceUrl: null }, 'tenant_case_unknown'],
    ["a user's own import", { visibility: 'private', sourceBoard: 'user_import' }, 'not_checked'],
    ['a public row of a user import board', { sourceBoard: 'user_import' }, 'not_checked'],
    ["a recruiter bank's row", { fromRecruiterBank: true, sourceBoard: 'gohire' }, 'not_checked'],
  ])('%s makes no request and is unknown', async (_name, over, reason) => {
    const ats = never();
    const res = await check(job(over as Partial<LivenessJob>), ats.fetch);
    expect(res).toEqual({ state: 'unknown', checkedAt: null, via: null, reason, requested: false });
    expect(ats.calls).toEqual([]);
  });

  it('a row that is closed already is closed, from the row, with no request', async () => {
    const ats = never();
    const closedAt = hoursAgo(50);
    expect(await check(job({ archivedAt: closedAt, closedAt }), ats.fetch)).toEqual({ state: 'closed', checkedAt: closedAt, via: 'sync', reason: 'row_closed', requested: false });
    expect(ats.calls).toEqual([]);
  });

  it('the kill switch stops every request', async () => {
    const ats = never();
    for (const value of ['true', '1', 'yes', 'on']) {
      const res = await checkPostingLive(job(), { fetch: ats.fetch, env: { LIVENESS_CHECK_DISABLED: value }, now: () => NOW });
      expect(res).toMatchObject({ state: 'unknown', reason: 'disabled', requested: false });
    }
    expect(ats.calls).toEqual([]);
    const on = fakeAts(() => listed(1));
    expect((await checkPostingLive(job(), { fetch: on.fetch, env: { LIVENESS_CHECK_DISABLED: 'false' }, now: () => NOW })).state).toBe('open');
  });

  it('the switch that stops every read of a public job board stops this read too: no request, for a board row and for an aggregator\'s copy', async () => {
    const ats = never();
    // A board row whose sighting is older than the recheck window (the sync is stopped, so it stays old) is not asked either.
    for (const row of [job(), boardRow({ lastSeenAt: hoursAgo(30) }), boardRow({ id: 'cn', market: 'cn', externalId: 'acme:1#cn', lastSeenAt: hoursAgo(30) })]) {
      for (const value of ['true', '1', 'yes', 'on']) {
        const res = await checkPostingLive(row, { fetch: ats.fetch, env: { ATS_PUBLIC_SOURCES_DISABLED: value }, now: () => NOW });
        expect(res).toEqual({ state: 'unknown', checkedAt: null, via: null, reason: 'disabled', requested: false });
      }
    }
    expect(ats.calls).toEqual([]);
    // Nothing is written for such an answer, so no posting is closed while the switch is on.
    const db = createFakePrisma({ seed: { rAJob: [{ ...job(), dedupeKey: 'k1' }] } });
    const res = await checkPostingLive(job(), { fetch: ats.fetch, env: { ATS_PUBLIC_SOURCES_DISABLED: 'true' }, now: () => NOW });
    expect(await applyLiveness(db as unknown as LivenessDb, job(), res)).toEqual({ archived: 0, refreshed: false });
    expect(await db.rAJob.findMany({ where: { archivedAt: { not: null } } })).toEqual([]);
    // Off or unset: the check runs.
    const on = fakeAts(() => listed(1));
    expect((await checkPostingLive(job(), { fetch: on.fetch, env: { ATS_PUBLIC_SOURCES_DISABLED: 'false' }, now: () => NOW })).state).toBe('open');
  });
});

describe('throttles', () => {
  it("the ATS's own board row seen listed two hours ago makes no request and is answered from the row", async () => {
    const ats = fakeAts(() => listed(1));
    const seen = hoursAgo(2);
    expect(isBoardRowOfKey(boardRow(), 'greenhouse:acme:1')).toBe(true);
    expect(await check(boardRow({ lastSeenAt: seen }), ats.fetch)).toEqual({ state: 'open', checkedAt: seen, via: 'sync', reason: 'seen_recently', requested: false });
    // Its mainland copy is the same board's row.
    expect(await check(boardRow({ id: 'cn', market: 'cn', externalId: 'acme:1#cn', lastSeenAt: seen }), ats.fetch)).toMatchObject({ state: 'open', via: 'sync' });
    expect(ats.calls).toEqual([]);
    // Seven hours ago is past the six-hour default.
    expect((await check(boardRow({ lastSeenAt: hoursAgo(7) }), ats.fetch)).requested).toBe(true);
  });

  it("another source's sighting proves nothing: an aggregator's row seen an hour ago is still asked, and a 404 closes it", async () => {
    // JSearch answers from a search index that keeps a posting after the ATS dropped it, and it has no closure signal.
    expect(isBoardRowOfKey(job(), 'greenhouse:acme:1')).toBe(false);
    const gone = fakeAts(() => GH_GONE);
    expect(await check(job({ lastSeenAt: hoursAgo(1) }), gone.fetch)).toMatchObject({ state: 'closed', via: 'ats_api', reason: 'not_found', requested: true });
    expect(gone.calls).toHaveLength(1);
    resetLivenessForTests();
    const live = fakeAts(() => listed(1));
    expect(await check(job({ lastSeenAt: hoursAgo(1) }), live.fetch)).toMatchObject({ state: 'open', via: 'ats_api', requested: true });
    // A board row of ANOTHER posting, or of another board, is not this key's board row either.
    resetLivenessForTests();
    expect((await check(job({ sourceBoard: 'greenhouse', externalId: 'acme:2', lastSeenAt: hoursAgo(1) }), live.fetch)).requested).toBe(true);
    resetLivenessForTests();
    expect((await check(job({ sourceBoard: 'lever', externalId: 'acme:1', lastSeenAt: hoursAgo(1) }), live.fetch)).requested).toBe(true);
  });

  it('LIVENESS_RECHECK_HOURS moves the window; a value that is not a number keeps six hours', async () => {
    expect(livenessRecheckHours({})).toBe(6);
    expect(livenessRecheckHours({ LIVENESS_RECHECK_HOURS: '1' })).toBe(1);
    expect(livenessRecheckHours({ LIVENESS_RECHECK_HOURS: '0.5' })).toBe(0.5);
    expect(livenessRecheckHours({ LIVENESS_RECHECK_HOURS: '0' })).toBe(0);
    for (const bad of ['', 'six', '-1', '1e3', '9999']) expect(livenessRecheckHours({ LIVENESS_RECHECK_HOURS: bad })).toBe(6);
    const ats = fakeAts(() => listed(1));
    const res = await checkPostingLive(boardRow({ lastSeenAt: hoursAgo(2) }), { fetch: ats.fetch, env: { LIVENESS_RECHECK_HOURS: '1' }, now: () => NOW });
    expect(res.requested).toBe(true);
    resetLivenessForTests();
    const wide = await checkPostingLive(boardRow({ lastSeenAt: hoursAgo(20) }), { fetch: ats.fetch, env: { LIVENESS_RECHECK_HOURS: '24' }, now: () => NOW });
    expect(wide).toMatchObject({ state: 'open', via: 'sync', requested: false });
  });

  it('a "listed" answer of the ATS is reused for the recheck window: one request per posting per process per window, whatever row asks', async () => {
    const ats = fakeAts(() => listed(1));
    let at = NOW;
    const deps = { fetch: ats.fetch, env: {}, now: () => at };
    expect(await checkPostingLive(job(), deps)).toMatchObject({ state: 'open', requested: true });
    // Five hours on: the same row (its lastSeenAt is the aggregator's, so it is not what answers), and another provider's row.
    at = new Date(NOW.getTime() + 5 * HOUR);
    expect(await checkPostingLive(job({ lastSeenAt: at }), deps)).toEqual({ state: 'open', checkedAt: NOW, via: 'ats_api', reason: 'cached', requested: false });
    expect(await checkPostingLive(job({ id: 'j9', sourceBoard: 'activejobs', externalId: 'aj:9' }), deps)).toMatchObject({ state: 'open', via: 'ats_api', requested: false });
    expect(ats.calls).toHaveLength(1);
    // Past six hours the ATS is asked again.
    at = new Date(NOW.getTime() + 6 * HOUR + 1);
    expect((await checkPostingLive(job(), deps)).requested).toBe(true);
    expect(ats.calls).toHaveLength(2);
  });

  it('LIVENESS_RECHECK_HOURS=0 still reuses a "listed" answer for ten minutes', async () => {
    const ats = fakeAts(() => listed(1));
    let at = NOW;
    const deps = { fetch: ats.fetch, env: { LIVENESS_RECHECK_HOURS: '0' }, now: () => at };
    await checkPostingLive(job(), deps);
    at = new Date(NOW.getTime() + 9 * 60_000);
    expect((await checkPostingLive(job(), deps)).requested).toBe(false);
    at = new Date(NOW.getTime() + 11 * 60_000);
    expect((await checkPostingLive(job(), deps)).requested).toBe(true);
    expect(ats.calls).toHaveLength(2);
  });

  it('an answer is reused for ten minutes for the same key: one request, also for another row of the same posting', async () => {
    const ats = fakeAts(() => GH_GONE);
    let at = NOW;
    const deps = { fetch: ats.fetch, env: {}, now: () => at };
    const first = await checkPostingLive(job(), deps);
    at = new Date(NOW.getTime() + 9 * 60_000);
    const again = await checkPostingLive(job(), deps);
    const twin = await checkPostingLive(job({ id: 'board-row', sourceBoard: 'greenhouse', externalId: 'acme:1', market: 'intl' }), deps);
    expect(ats.calls).toHaveLength(1);
    expect(first).toMatchObject({ state: 'closed', requested: true });
    expect(again).toEqual({ state: 'closed', checkedAt: NOW, via: 'ats_api', reason: 'cached', requested: false });
    expect(twin).toMatchObject({ state: 'closed', via: 'ats_api', requested: false });
    at = new Date(NOW.getTime() + 11 * 60_000);
    expect((await checkPostingLive(job(), deps)).requested).toBe(true);
    expect(ats.calls).toHaveLength(2);
  });

  it('an unknown answer is reused too, so a failing ATS is not asked again by every opening of the job', async () => {
    const ats = fakeAts(() => ({ status: 503, text: '' }));
    await check(job(), ats.fetch);
    const again = await check(job(), ats.fetch);
    expect(ats.calls).toHaveLength(1);
    expect(again).toEqual({ state: 'unknown', checkedAt: null, via: null, reason: 'cached', requested: false });
  });

  it('a posting found gone a moment ago closes a twin row even though that row was seen listed two hours ago', async () => {
    const ats = fakeAts(() => GH_GONE);
    await check(job(), ats.fetch);
    const twin = await check(boardRow({ lastSeenAt: hoursAgo(2) }), ats.fetch);
    expect(twin).toMatchObject({ state: 'closed', via: 'ats_api' });
    expect(ats.calls).toHaveLength(1);
  });

  it("only the board's own listing after a \"gone\" answer reopens the question; an aggregator listing the posting again does not", async () => {
    const ats = fakeAts(() => GH_GONE);
    let at = NOW;
    const deps = { fetch: ats.fetch, env: {}, now: () => at };
    await checkPostingLive(job(), deps);
    at = new Date(NOW.getTime() + 5 * 60_000);
    const relisted = new Date(NOW.getTime() + 2 * 60_000);
    // The aggregator returned the posting again two minutes after the ATS said it is gone: still gone.
    expect(await checkPostingLive(job({ lastSeenAt: relisted }), deps)).toMatchObject({ state: 'closed', via: 'ats_api', requested: false });
    // The board API itself listed it again: that is the ATS, and it is newer than the answer.
    expect(await checkPostingLive(boardRow({ lastSeenAt: relisted }), deps)).toEqual({ state: 'open', checkedAt: relisted, via: 'sync', reason: 'seen_recently', requested: false });
    expect(ats.calls).toHaveLength(1);
  });

  it('two calls for one key at the same moment share the request', async () => {
    let release: (v: { status: number; body: unknown }) => void = () => {};
    const calls: string[] = [];
    const fetch: LivenessFetch = (url) => {
      calls.push(url);
      return new Promise((resolve) => {
        release = (v) => resolve({ status: v.status, text: async () => JSON.stringify(v.body) });
      });
    };
    const a = checkPostingLive(job(), { fetch, env: {}, now: () => NOW });
    const b = checkPostingLive(job({ id: 'j2' }), { fetch, env: {}, now: () => NOW });
    await Promise.resolve();
    release({ status: 200, body: { id: 1 } });
    const [ra, rb] = await Promise.all([a, b]);
    expect(calls).toHaveLength(1);
    expect(ra).toMatchObject({ state: 'open', requested: true });
    expect(rb).toMatchObject({ state: 'open', requested: false });
  });

  it('beyond the in-flight cap a call is unknown and asks nothing; it is not remembered', async () => {
    const releases: Array<() => void> = [];
    const calls: string[] = [];
    const fetch: LivenessFetch = (url) => {
      calls.push(url);
      return new Promise((resolve) => releases.push(() => resolve({ status: 200, text: async () => JSON.stringify({ id: Number(url.split('/').pop()) }) })));
    };
    const deps = { fetch, env: {}, now: () => NOW, maxInFlight: 2 };
    const open = [1, 2].map((n) => checkPostingLive(job({ id: `j${n}`, atsPostingKey: `greenhouse:acme:${n}`, applyUrl: null }), deps));
    await Promise.resolve();
    const third = await checkPostingLive(job({ id: 'j3', atsPostingKey: 'greenhouse:acme:3', applyUrl: null }), deps);
    expect(third).toEqual({ state: 'unknown', checkedAt: null, via: null, reason: 'busy', requested: false });
    expect(calls).toHaveLength(2);
    releases.forEach((r) => r());
    await Promise.all(open);
    // With room again the same row is asked.
    const later = checkPostingLive(job({ id: 'j3', atsPostingKey: 'greenhouse:acme:3', applyUrl: null }), deps);
    await Promise.resolve();
    releases[2]?.();
    expect((await later).requested).toBe(true);
  });

  it('one host is sent a bounded number of new requests a minute by one process: beyond it a call is unknown, asks nothing and is not remembered', async () => {
    expect(LIVENESS_HOST_REQUESTS_PER_MINUTE).toBe(60);
    const ats = fakeAts((url) => listed(url.split('/').pop()!));
    let at = NOW;
    const deps = { fetch: ats.fetch, env: {}, now: () => at, hosts: createLivenessHosts(3) };
    const gh = (n: number) => job({ id: `g${n}`, atsPostingKey: `greenhouse:acme:${n}`, applyUrl: null });
    // One account walking the job list: three postings of one host are asked, the fourth and fifth are not.
    for (const n of [1, 2, 3]) expect(await checkPostingLive(gh(n), deps)).toMatchObject({ state: 'open', requested: true });
    for (const n of [4, 5]) expect(await checkPostingLive(gh(n), deps)).toEqual({ state: 'unknown', checkedAt: null, via: null, reason: 'host_budget', requested: false });
    expect(ats.calls).toHaveLength(3);
    // An answer this process already has costs nothing and is still given.
    expect(await checkPostingLive(gh(1), deps)).toMatchObject({ state: 'open', requested: false, reason: 'cached' });
    // Another host has its own budget.
    const leverId = UUID;
    expect((await checkPostingLive(job({ id: 'l1', atsPostingKey: `lever:acme:${leverId}`, applyUrl: `https://jobs.lever.co/acme/${leverId}` }), deps)).requested).toBe(true);
    expect(ats.calls).toHaveLength(4);
    // Half a minute later the host is still full; a minute after the first requests there is room, and the posting held back is asked.
    at = new Date(NOW.getTime() + 30_000);
    expect((await checkPostingLive(gh(4), deps)).reason).toBe('host_budget');
    at = new Date(NOW.getTime() + 60_000);
    expect(await checkPostingLive(gh(4), deps)).toMatchObject({ state: 'open', requested: true });
    expect(ats.calls).toHaveLength(5);
  });

  it('the process\'s own budget is the default: the 61st new posting of one host inside a minute is not asked', async () => {
    const ats = fakeAts((url) => listed(url.split('/').pop()!));
    const deps = { fetch: ats.fetch, env: {}, now: () => NOW };
    const gh = (n: number) => job({ id: `g${n}`, atsPostingKey: `greenhouse:acme:${n}`, applyUrl: null });
    for (let n = 1; n <= LIVENESS_HOST_REQUESTS_PER_MINUTE; n += 1) expect((await checkPostingLive(gh(n), deps)).requested).toBe(true);
    expect(await checkPostingLive(gh(61), deps)).toMatchObject({ state: 'unknown', reason: 'host_budget', requested: false });
    expect(ats.calls).toHaveLength(LIVENESS_HOST_REQUESTS_PER_MINUTE);
  });

  it('the cache forgets its oldest answer past its size', () => {
    const cache = createLivenessCache(1_000, 2);
    cache.set('a', { state: 'open', reason: 'listed', at: 0 });
    cache.set('b', { state: 'open', reason: 'listed', at: 0 });
    expect(cache.get('a', 10)).not.toBeNull();
    cache.set('c', { state: 'closed', reason: 'not_found', at: 0 });
    expect(cache.get('b', 10)).toBeNull();
    expect(cache.get('a', 10)).not.toBeNull();
    expect(cache.get('c', 999)).not.toBeNull();
    expect(cache.get('c', 1_000)).toBeNull();
  });
});

describe('a host that says to slow down, or stops answering, is left alone', () => {
  const gh = (n: number, over: Partial<LivenessJob> = {}) => job({ id: `g${n}`, atsPostingKey: `greenhouse:acme:${n}`, applyUrl: null, ...over });
  const lever = (n: number) => {
    const id = `${UUID.slice(0, -1)}${n}`;
    return job({ id: `l${n}`, atsPostingKey: `lever:acme:${id}`, applyUrl: `https://jobs.lever.co/acme/${id}` });
  };

  it('after a 429 no other posting of that host is asked for 60 seconds; other hosts are', async () => {
    let status = 429;
    const ats = fakeAts((url) => (status === 429 ? { status: 429, body: { error: 'slow down' } } : listed(url.split('/').pop()!)));
    let at = NOW;
    const deps = { fetch: ats.fetch, env: {}, now: () => at };
    expect(await checkPostingLive(gh(1), deps)).toMatchObject({ state: 'unknown', reason: 'http_429', requested: true });
    // Another Greenhouse posting a moment later: no request, and nothing is concluded.
    at = new Date(NOW.getTime() + 30_000);
    expect(await checkPostingLive(gh(2), deps)).toEqual({ state: 'unknown', checkedAt: null, via: null, reason: 'host_paused', requested: false });
    expect(ats.calls).toHaveLength(1);
    // Lever is another host.
    status = 200;
    expect((await checkPostingLive(lever(1), deps)).requested).toBe(true);
    expect(ats.calls).toHaveLength(2);
    // After the pause the posting that was held back is asked (a pause is not remembered as that posting's answer).
    at = new Date(NOW.getTime() + LIVENESS_HOST_PAUSE_MS);
    expect(await checkPostingLive(gh(2), deps)).toMatchObject({ state: 'open', requested: true });
    expect(ats.calls).toHaveLength(3);
  });

  it("the host's Retry-After is honoured when it asks for longer, up to fifteen minutes", async () => {
    expect(retryAfterMs('120', NOW)).toBe(120_000);
    expect(retryAfterMs(new Date(NOW.getTime() + 90_000).toUTCString(), NOW)).toBe(90_000);
    for (const bad of [null, undefined, '', 'soon', '-5', '1.5', new Date(NOW.getTime() - 1_000).toUTCString()]) expect(retryAfterMs(bad, NOW)).toBeUndefined();

    let retry = '120';
    const ats = fakeAts(() => ({ status: 429, text: '', headers: { 'Retry-After': retry } }));
    let at = NOW;
    const deps = { fetch: ats.fetch, env: {}, now: () => at };
    await checkPostingLive(gh(1), deps);
    at = new Date(NOW.getTime() + 119_000);
    expect((await checkPostingLive(gh(2), deps)).reason).toBe('host_paused');
    at = new Date(NOW.getTime() + 120_000);
    // Asked again; this time the host asks for a day, which is cut to fifteen minutes.
    retry = '86400';
    expect((await checkPostingLive(gh(2), deps)).requested).toBe(true);
    const second = at.getTime();
    at = new Date(second + LIVENESS_HOST_PAUSE_MAX_MS - 1);
    expect((await checkPostingLive(gh(3), deps)).reason).toBe('host_paused');
    at = new Date(second + LIVENESS_HOST_PAUSE_MAX_MS);
    expect((await checkPostingLive(gh(3), deps)).requested).toBe(true);
    expect(ats.calls).toHaveLength(3);
    // A shorter Retry-After never shortens the 60 seconds.
    resetLivenessForTests();
    retry = '1';
    at = NOW;
    await checkPostingLive(gh(4), deps);
    at = new Date(NOW.getTime() + 59_000);
    expect((await checkPostingLive(gh(5), deps)).reason).toBe('host_paused');
  });

  it.each([
    ['timeouts', 'timeout'],
    ['500s', 500],
    ['dropped connections', 'network'],
  ])('three %s in a row pause the host for 60 seconds', async (_name, kind) => {
    const calls: string[] = [];
    const fetch: LivenessFetch = (url, init) => {
      calls.push(url);
      if (kind === 'timeout') return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      if (kind === 'network') return Promise.reject(new Error('ECONNRESET'));
      return Promise.resolve({ status: kind as number, text: async () => '' });
    };
    let at = NOW;
    const deps = { fetch, env: {}, now: () => at, timeoutMs: 5 };
    for (const n of [1, 2, 3]) expect((await checkPostingLive(gh(n), deps)).requested).toBe(true);
    expect(await checkPostingLive(gh(4), deps)).toMatchObject({ state: 'unknown', reason: 'host_paused', requested: false });
    expect(calls).toHaveLength(3);
    at = new Date(NOW.getTime() + LIVENESS_HOST_PAUSE_MS);
    expect((await checkPostingLive(gh(4), deps)).requested).toBe(true);
  });

  it('an answer that shows the host working clears the count: two failures, a posting, two failures do not pause it', async () => {
    const script = [500, 503, 200, 500, 404, 502, 503];
    const ats = fakeAts((url) => {
      const status = script.shift()!;
      return status === 200 ? listed(url.split('/').pop()!) : status === 404 ? GH_GONE : { status, text: '' };
    });
    const deps = { fetch: ats.fetch, env: {}, now: () => NOW };
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect((await checkPostingLive(gh(n), deps)).requested).toBe(true);
    // A 4xx that is not a 429 (403, 400) is the host answering, not the host failing.
    expect(ats.calls).toHaveLength(7);
  });
});

describe('applyLiveness: the one writer', () => {
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    market: 'intl',
    visibility: 'public',
    ownerUserId: null,
    sourceBoard: 'jsearch',
    externalId: `x:${id}`,
    fromRecruiterBank: false,
    atsPostingKey: 'greenhouse:acme:1',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    sourceUrl: null,
    dedupeKey: `dk-${id}`,
    lastSeenAt: hoursAgo(30),
    archivedAt: null,
    closedAt: null,
    closeReason: null,
    ...over,
  });
  const dbWith = (rows: Array<Record<string, unknown>>) => createFakePrisma({ seed: { rAJob: rows } });
  const asDb = (db: ReturnType<typeof dbWith>) => db as unknown as LivenessDb;
  const read = async (db: ReturnType<typeof dbWith>, id: string) => (await db.rAJob.findUnique({ where: { id } })) as Record<string, unknown>;
  const answer = (state: LiveResult['state'], via: LiveResult['via'] = 'ats_api'): LiveResult => ({ state, checkedAt: state === 'unknown' ? null : NOW, via: state === 'unknown' ? null : via, reason: 'test', requested: via === 'ats_api' });

  it('open: lastSeenAt becomes the moment of the check ("last confirmed listed")', async () => {
    const db = dbWith([row('j1')]);
    const out = await applyLiveness(asDb(db), job(), answer('open'));
    expect(out).toEqual({ archived: 0, refreshed: true });
    const after = await read(db, 'j1');
    expect(after.lastSeenAt).toEqual(NOW);
    expect(after.archivedAt).toBeNull();
    // An older answer never moves the date back.
    await applyLiveness(asDb(db), job(), { ...answer('open'), checkedAt: hoursAgo(1) });
    expect((await read(db, 'j1')).lastSeenAt).toEqual(NOW);
  });

  it('open: a row that already says so (an answer reused from memory) costs no database call', async () => {
    const touched = vi.fn();
    const db = { rAJob: { findMany: touched, updateMany: touched } } as unknown as LivenessDb;
    expect(await applyLiveness(db, job({ lastSeenAt: NOW }), answer('open'))).toEqual({ archived: 0, refreshed: false });
    expect(await applyLiveness(db, job({ lastSeenAt: new Date(NOW.getTime() + 1) }), answer('open'))).toEqual({ archived: 0, refreshed: false });
    expect(touched).not.toHaveBeenCalled();
  });

  it("closed: the ATS's own board row is archived as source_removed and the dedupe group is repaired for its key", async () => {
    const db = dbWith([row('board-row', { sourceBoard: 'greenhouse', externalId: 'acme:1' })]);
    const repaired: Array<[string, string[]]> = [];
    const out = await applyLiveness(asDb(db), boardRow(), answer('closed'), { repairDedupe: async (market, keys) => void repaired.push([market, keys]) });
    expect(out).toEqual({ archived: 1, refreshed: false });
    expect(await read(db, 'board-row')).toMatchObject({ archivedAt: NOW, closedAt: NOW, closeReason: 'source_removed' });
    expect(repaired).toEqual([['intl', ['dk-board-row']]]);
    expect(LIVENESS_BOARD_CLOSE_REASON).toBe('source_removed');
  });

  it("closed: a row of any other source is archived as ats_removed, a reason no re-listing by that source undoes", async () => {
    const db = dbWith([row('j1')]);
    const out = await applyLiveness(asDb(db), job(), answer('closed'));
    expect(out).toEqual({ archived: 1, refreshed: false });
    expect(await read(db, 'j1')).toMatchObject({ archivedAt: NOW, closedAt: NOW, closeReason: 'ats_removed' });
    expect(LIVENESS_CLOSE_REASON).toBe('ats_removed');
    // The ingest upsert's own rule: the board's reason is one a new listing reopens, the other is not.
    const relisting = { sourceBoard: 'jsearch', expiresAt: null };
    expect(revivesOnRelist(LIVENESS_CLOSE_REASON, relisting, NOW)).toBe(false);
    expect(revivesOnRelist(LIVENESS_CLOSE_REASON, { sourceBoard: 'jsearch', expiresAt: new Date(NOW.getTime() + 30 * 24 * HOUR) }, NOW)).toBe(false);
    expect(revivesOnRelist(LIVENESS_CLOSE_REASON, { sourceBoard: 'greenhouse', expiresAt: null }, NOW)).toBe(false);
    expect(REVIVED_CLOSE_REASONS as readonly string[]).not.toContain(LIVENESS_CLOSE_REASON);
    expect(revivesOnRelist(LIVENESS_BOARD_CLOSE_REASON, { sourceBoard: 'greenhouse', expiresAt: null }, NOW)).toBe(true);
  });

  it('an aggregator listing the posting again after the ATS said it is gone does not bring it back; the board listing it again does', async () => {
    // The sequence of the defect: the check archives the board row B and the JSearch row J; the next JSearch run
    // of that query returns the posting again (its index keeps a posting the ATS dropped).
    const db = dbWith([row('J'), row('B', { sourceBoard: 'greenhouse', externalId: 'acme:1', dedupeKey: 'dk-J' })]);
    await applyLiveness(asDb(db), job({ id: 'J' }), answer('closed'));
    /** What the ingest upsert does to a stored row when its own source lists it again (upsert.ts `REVIVE_ON_RELIST_SQL`). */
    const relist = async (id: string) => {
      const stored = await read(db, id);
      const revived = revivesOnRelist(stored.closeReason as string | null, { sourceBoard: stored.sourceBoard as string, expiresAt: null }, NOW);
      await db.rAJob.update({ where: { id }, data: { lastSeenAt: new Date(NOW.getTime() + HOUR), ...(revived ? { archivedAt: null, closedAt: null, closeReason: null } : {}) } });
      return (await read(db, id)) as unknown as LivenessJob & { closeReason: string | null };
    };
    const j = await relist('J');
    expect(j).toMatchObject({ archivedAt: NOW, closedAt: NOW, closeReason: 'ats_removed' });
    // Opened an hour later in another process (nothing remembered): closed from the row, no request, no Apply.
    resetLivenessForTests();
    const never = fakeAts(() => Promise.reject(new Error('no request expected')) as Promise<never>);
    expect(await checkPostingLive(j, { fetch: never.fetch, env: {}, now: () => new Date(NOW.getTime() + 2 * HOUR) })).toMatchObject({ state: 'closed', via: 'sync', requested: false });
    expect(never.calls).toEqual([]);
    // The board's API is the authority on its own postings: its listing reopens its row.
    expect(await relist('B')).toMatchObject({ archivedAt: null, closedAt: null, closeReason: null });
  });

  it('closed: every other open public row of the same posting is archived with it, in either market; nothing else is', async () => {
    const db = dbWith([
      row('j1'),
      row('board', { sourceBoard: 'greenhouse', externalId: 'acme:1', dedupeKey: 'dk-j1' }),
      row('cn-copy', { market: 'cn', sourceBoard: 'greenhouse', externalId: 'acme:1#cn', dedupeKey: 'dk-cn' }),
      row('other-posting', { atsPostingKey: 'greenhouse:acme:2' }),
      row('no-key', { atsPostingKey: null, dedupeKey: 'dk-j1' }),
      row('import', { visibility: 'private', sourceBoard: 'user_import', ownerUserId: 'u1' }),
      row('bank', { fromRecruiterBank: true, sourceBoard: 'gohire' }),
      row('reported', { closedAt: hoursAgo(5), closeReason: 'reported' }),
      row('archived', { archivedAt: hoursAgo(9), closedAt: hoursAgo(9), closeReason: 'expired' }),
    ]);
    const repaired: Array<[string, string[]]> = [];
    const out = await applyLiveness(asDb(db), job(), answer('closed'), { repairDedupe: async (market, keys) => void repaired.push([market, keys.sort()]) });
    expect(out.archived).toBe(3);
    // Each with the reason that says who may reopen it: the board's two rows by the board, the aggregator's by nobody.
    expect(await read(db, 'j1')).toMatchObject({ archivedAt: NOW, closedAt: NOW, closeReason: 'ats_removed' });
    for (const id of ['board', 'cn-copy']) expect(await read(db, id)).toMatchObject({ archivedAt: NOW, closedAt: NOW, closeReason: 'source_removed' });
    for (const id of ['other-posting', 'no-key', 'import', 'bank']) expect(await read(db, id)).toMatchObject({ archivedAt: null, closeReason: null });
    expect(await read(db, 'reported')).toMatchObject({ archivedAt: null, closeReason: 'reported' });
    expect(await read(db, 'archived')).toMatchObject({ closeReason: 'expired' });
    // Each market's groups are repaired on their own: dedupe never crosses markets.
    expect(repaired.sort()).toEqual([
      ['cn', ['dk-cn']],
      ['intl', ['dk-j1']],
    ]);
  });

  it('closed twice writes once; a failing repair leaves the archive in place', async () => {
    const db = dbWith([row('j1')]);
    const log = vi.fn();
    await applyLiveness(asDb(db), job(), answer('closed'), { repairDedupe: async () => Promise.reject(new Error('boom')), log });
    expect(await read(db, 'j1')).toMatchObject({ closeReason: 'ats_removed' });
    expect(log).toHaveBeenCalledTimes(1);
    const again = await applyLiveness(asDb(db), job(), answer('closed'), { repairDedupe: async () => Promise.reject(new Error('not called')) });
    expect(again).toEqual({ archived: 0, refreshed: false });
  });

  it('unknown writes nothing, and neither does an answer from our own records', async () => {
    const db = dbWith([row('j1')]);
    const before = await read(db, 'j1');
    expect(await applyLiveness(asDb(db), job(), answer('unknown'))).toEqual({ archived: 0, refreshed: false });
    expect(await applyLiveness(asDb(db), job(), answer('open', 'sync'))).toEqual({ archived: 0, refreshed: false });
    expect(await applyLiveness(asDb(db), job(), answer('closed', 'sync'))).toEqual({ archived: 0, refreshed: false });
    expect(await read(db, 'j1')).toEqual(before);
  });

  it("a user's import and a bank row are never written, whatever answer is handed in", async () => {
    const db = dbWith([row('imp', { visibility: 'private', sourceBoard: 'user_import' }), row('bank', { fromRecruiterBank: true, sourceBoard: 'robohire' })]);
    await applyLiveness(asDb(db), job({ id: 'imp', visibility: 'private', sourceBoard: 'user_import' }), answer('closed'));
    await applyLiveness(asDb(db), job({ id: 'bank', fromRecruiterBank: true, sourceBoard: 'robohire' }), answer('closed'));
    expect(await read(db, 'imp')).toMatchObject({ archivedAt: null });
    expect(await read(db, 'bank')).toMatchObject({ archivedAt: null });
  });
});

describe('the seams other areas call', () => {
  const seed = (over: Record<string, unknown> = {}) =>
    createFakePrisma({
      seed: {
        rAJob: [
          {
            id: 'j1',
            market: 'intl',
            visibility: 'public',
            sourceBoard: 'jsearch',
            externalId: 'jsearch:abc',
            fromRecruiterBank: false,
            atsPostingKey: 'greenhouse:acme:1',
            applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
            sourceUrl: null,
            dedupeKey: 'dk1',
            lastSeenAt: hoursAgo(30),
            archivedAt: null,
            closedAt: null,
            closeReason: null,
            ...over,
          },
        ],
      },
    });
  const asDb = (db: ReturnType<typeof seed>) => db as unknown as LivenessDb;

  it('the row select names the columns the check reads and no posting text', () => {
    expect(Object.keys(LIVENESS_JOB_SELECT).sort()).toEqual(
      ['applyUrl', 'archivedAt', 'atsPostingKey', 'closedAt', 'externalId', 'fromRecruiterBank', 'id', 'lastSeenAt', 'market', 'sourceBoard', 'sourceUrl', 'visibility'].sort(),
    );
  });

  it('checkJobLive: a 404 answers closed and archives the row; a second call makes no request', async () => {
    const db = seed();
    const ats = fakeAts(() => GH_GONE);
    const deps = { db: asDb(db), fetch: ats.fetch, env: {}, now: () => NOW, repairDedupe: null };
    expect(await checkJobLive('j1', deps)).toBe('closed');
    expect(await db.rAJob.findUnique({ where: { id: 'j1' } })).toMatchObject({ archivedAt: NOW, closeReason: 'ats_removed' });
    resetLivenessForTests();
    expect(await checkJobLive('j1', deps)).toBe('closed');
    expect(ats.calls).toHaveLength(1);
  });

  it('checkJobLive: 200 answers open and refreshes lastSeenAt; a failing ATS answers unknown and writes nothing', async () => {
    const db = seed();
    expect(await checkJobLive('j1', { db: asDb(db), fetch: fakeAts(() => listed(1)).fetch, env: {}, now: () => NOW, repairDedupe: null })).toBe('open');
    expect((await db.rAJob.findUnique({ where: { id: 'j1' } }))?.lastSeenAt).toEqual(NOW);
    // Another process (the first answer is not remembered here).
    resetLivenessForTests();
    const other = seed();
    const before = await other.rAJob.findUnique({ where: { id: 'j1' } });
    expect(await checkJobLive('j1', { db: asDb(other), fetch: fakeAts(() => ({ status: 500, text: '' })).fetch, env: {}, now: () => NOW, repairDedupe: null })).toBe('unknown');
    expect(await other.rAJob.findUnique({ where: { id: 'j1' } })).toEqual(before);
  });

  it('checkJobLive: a job that does not exist, and a database that fails, are unknown', async () => {
    const ats = fakeAts(() => listed(1));
    expect(await checkJobLive('missing', { db: asDb(seed()), fetch: ats.fetch, env: {}, now: () => NOW })).toBe('unknown');
    const broken = { rAJob: { findUnique: async () => Promise.reject(new Error('db down')) } } as unknown as LivenessDb;
    expect(await checkJobLive('j1', { db: broken, fetch: ats.fetch, env: {}, now: () => NOW })).toBe('unknown');
    expect(ats.calls).toEqual([]);
  });

  it('confirmListing: the answer stands when the write fails, and the failure is logged', async () => {
    const failing = { rAJob: { findMany: async () => Promise.reject(new Error('db down')), updateMany: async () => Promise.reject(new Error('db down')) } } as unknown as LivenessDb;
    const log = vi.fn();
    const res = await confirmListing(job(), { db: failing, fetch: fakeAts(() => GH_GONE).fetch, env: {}, now: () => NOW, repairDedupe: null, log });
    expect(res.state).toBe('closed');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('confirmListing: a row answered from our own records never opens the database', async () => {
    const touched = vi.fn();
    const db = { rAJob: { findMany: touched, updateMany: touched, findUnique: touched } } as unknown as LivenessDb;
    const res = await confirmListing(boardRow({ lastSeenAt: hoursAgo(1) }), { db, fetch: fakeAts(() => listed(1)).fetch, env: {}, now: () => NOW });
    expect(res).toMatchObject({ state: 'open', via: 'sync' });
    expect(touched).not.toHaveBeenCalled();
  });

  it('confirmListing: the ingest area is loaded for the dedupe repair only after a "gone" answer, never for "listed" or "cannot tell"', async () => {
    const applyDedupe = vi.fn(async () => 1);
    const loadIngest = vi.fn(async () => ({ applyDedupe }));
    const open = seed();
    expect((await confirmListing(job(), { db: asDb(open), fetch: fakeAts(() => listed(1)).fetch, env: {}, now: () => NOW, loadIngest })).state).toBe('open');
    resetLivenessForTests();
    expect((await confirmListing(job(), { db: asDb(seed()), fetch: fakeAts(() => ({ status: 500, text: '' })).fetch, env: {}, now: () => NOW, loadIngest })).state).toBe('unknown');
    expect(loadIngest).not.toHaveBeenCalled();
    resetLivenessForTests();
    const gone = seed();
    expect((await confirmListing(job(), { db: asDb(gone), fetch: fakeAts(() => GH_GONE).fetch, env: {}, now: () => NOW, loadIngest })).state).toBe('closed');
    expect(loadIngest).toHaveBeenCalledTimes(1);
    expect(applyDedupe).toHaveBeenCalledWith(asDb(gone), 'intl', ['dk1']);
  });

  it('the dedupe repair is the ingest area\'s applyDedupe once its index exports it; until then there is none', async () => {
    const db = asDb(seed());
    expect(await ingestDedupeRepair(db, async () => ({}))).toBeUndefined();
    expect(await ingestDedupeRepair(db, async () => null)).toBeUndefined();
    expect(await ingestDedupeRepair(db, async () => Promise.reject(new Error('cannot load')))).toBeUndefined();
    const applyDedupe = vi.fn(async () => 2);
    const repair = await ingestDedupeRepair(db, async () => ({ applyDedupe }));
    await repair?.('cn', ['k1']);
    expect(applyDedupe).toHaveBeenCalledWith(db, 'cn', ['k1']);
  });
});
