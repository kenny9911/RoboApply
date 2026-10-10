// @vitest-environment node
//
// WP-93 #8 (R41-1b; CN-L-04), restated for D5: postings show by default on
// GoApply, and the kill switch is set explicitly here. With
// CN_RECRUITMENT_INFO_MODE=off the
// tracker never returns a third-party posting on GoApply. One GoHire posting
// and one own import are seeded through the service seam (the fake database
// behind `createTrackerCore`); every reader is called.
//   mode off            only the import (and a job the user typed in)
//   partner_deeplink    both
//   nothing set         both (the default)
// The central route scan (cn/jobs/__tests__/modeOff.routes.test.ts) lists the
// tracker under NOT_EXERCISED until this file exists (join J8).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { trackerCsv } from './csv.js';
import { createTrackerRouter } from './routes.js';
import { createTrackerCore, TrackerNotFoundError, type TrackerCore, type TrackerDb } from './service.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const DAY = 86_400_000;
const U = 'u1';
const GA = 'goapply.localhost:3621';
const BASE = '/api/v1/roboapply/v2/tracker';

const MODE_OFF: Record<string, string> = { CN_RECRUITMENT_INFO_MODE: 'off' };
const MODE_ON: Record<string, string> = { CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' };
/** Nothing set: postings are shown (D5 default). */
const MODE_DEFAULT: Record<string, string> = {};

const job = (over: Record<string, unknown>) => ({
  companyLogoUrl: null,
  location: '上海',
  workType: 'onsite',
  closedAt: null,
  archivedAt: null,
  expiresAt: null,
  salaryMax: null,
  salaryCurrency: null,
  market: 'cn',
  ...over,
});

/** A GoHire bank posting (third party) and the viewer's own import. */
const GOHIRE = job({ id: 'job_gh', title: '产品经理', companyName: '示例科技有限公司', applyUrl: 'https://gohire.top/jobs/1', visibility: 'public', ownerUserId: null, sourceBoard: 'gohire' });
const OWN_IMPORT = job({ id: 'job_own', title: '数据分析师', companyName: '我的导入公司', applyUrl: 'https://careers.example.cn/1', visibility: 'private', ownerUserId: U, sourceBoard: 'user_import' });
const OTHERS_IMPORT = job({ id: 'job_theirs', title: '运营', companyName: '别人的导入', applyUrl: '', visibility: 'private', ownerUserId: 'u2', sourceBoard: 'user_import' });

const entry = (id: string, jobId: string | null, over: Record<string, unknown> = {}) => ({
  id,
  userId: U,
  jobId,
  status: 'applied',
  outcome: null,
  stageDetail: null,
  excitementStars: 0,
  maxSalary: null,
  maxSalaryCurrency: null,
  notesMarkdown: null,
  dateSaved: new Date(NOW.getTime() - 20 * DAY),
  // Applied 12 days ago: each of these is a "no reply" follow-up fact.
  dateApplied: new Date(NOW.getTime() - 12 * DAY),
  deadline: null,
  followUpAt: null,
  interviewAt: null,
  appliedVia: 'manual',
  linkedRunId: null,
  externalSnapshot: null,
  source: 'feed',
  offer: null,
  tailoredVariantId: null,
  coverLetterId: null,
  deletedAt: null,
  createdAt: new Date(NOW.getTime() - 20 * DAY),
  updatedAt: new Date(NOW.getTime() - 12 * DAY),
  ...over,
});

function seed() {
  return createFakePrisma({
    timestampFields: ['createdAt', 'updatedAt', 'dateSaved'],
    defaults: { rATrackerEvent: { fromValue: null, toValue: null, payload: null } },
    seed: {
      rAJob: [GOHIRE, OWN_IMPORT, OTHERS_IMPORT],
      rATrackerEntry: [
        entry('e_gh', 'job_gh'),
        entry('e_own', 'job_own'),
        entry('e_typed', null, { externalSnapshot: { title: '实习生', companyName: '手动添加的公司', applyUrl: null }, source: 'manual' }),
      ],
      rATrackerEvent: [],
      rAApplicationArtifact: [{ id: 'a1', userId: U, trackerEntryId: 'e_gh', kind: 'resume', fileName: 'resume.pdf', format: 'pdf', fileSha256: 'x', channel: 'download', variantId: null, coverLetterId: null, createdAt: NOW }],
    },
  });
}

let db = seed();
const coreFor = (env: Record<string, string>): TrackerCore => createTrackerCore({ getDb: async () => db as unknown as TrackerDb, now: () => NOW, market: () => 'cn', env });

/** Any object that is a posting not imported by the viewer (the central scan's rule, for tracker job cards). */
function thirdPartyPostings(body: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    const looksLikeJob = typeof o.title === 'string' && (typeof o.companyName === 'string' || typeof o.applyUrl === 'string');
    if (looksLikeJob && o.visibility === 'public') out.push(o);
    Object.values(o).forEach(walk);
  };
  walk(body);
  return out;
}
const NAMES = /示例科技|产品经理|gohire\.top/;

// The writers take the (user, job) advisory lock whose key lives in the job
// detail area; that module is loaded on first use. Load it once up front so no
// single test pays for the import.
beforeAll(async () => {
  await Promise.all([import('../jobs/detail/index.js'), import('../cn/jobs/index.js')]);
}, 60_000);

beforeEach(() => {
  db = seed();
});

describe('GoApply, CN_RECRUITMENT_INFO_MODE=off: the tracker returns only the user\'s own jobs', () => {
  const off = () => coreFor(MODE_OFF);

  it('list (every view), counts and total leave the GoHire posting out', async () => {
    for (const query of [{}, { view: 'date' as const }, { q: '经理' }, { q: '公司' }, { status: 'applied' as const }, { sortBy: 'dateApplied' as const }]) {
      const res = await off().list(U, query);
      expect(res.entries.map((e) => e.id).sort(), JSON.stringify(query)).toEqual(query.q === '经理' ? [] : ['e_own', 'e_typed']);
      expect(res.total, JSON.stringify(query)).toBe(query.q === '经理' ? 0 : 2);
      expect(res.statusCounts.applied).toBe(2);
      expect(thirdPartyPostings(res)).toEqual([]);
      expect(JSON.stringify(res)).not.toMatch(NAMES);
    }
    // The own import carries its job card, marked as the user's own.
    const own = (await off().list(U, {})).entries.find((e) => e.id === 'e_own')!;
    expect(own.job).toMatchObject({ title: '数据分析师', companyName: '我的导入公司', visibility: 'private' });
  });

  it('by-id reads, the timeline, files and writes answer "not found" for the hidden entry', async () => {
    await expect(off().getById(U, 'e_gh')).rejects.toBeInstanceOf(TrackerNotFoundError);
    await expect(off().events(U, 'e_gh')).rejects.toBeInstanceOf(TrackerNotFoundError);
    await expect(off().artifacts(U, 'e_gh')).rejects.toBeInstanceOf(TrackerNotFoundError);
    await expect(off().addNote(U, 'e_gh', 'note')).rejects.toBeInstanceOf(TrackerNotFoundError);
    await expect(off().patch(U, 'e_gh', { status: 'interviewing' })).rejects.toBeInstanceOf(TrackerNotFoundError);
    expect((await off().getById(U, 'e_own')).job?.companyName).toBe('我的导入公司');
    expect((await off().getById(U, 'e_typed')).externalSnapshot?.companyName).toBe('手动添加的公司');
    // Nothing was written to the hidden entry.
    expect(db.$rows('rATrackerEntry').find((r) => r.id === 'e_gh')!.status).toBe('applied');
  });

  it('a bulk change naming the hidden entry changes nothing, and answers like an id that is not the user\'s', async () => {
    const record = vi.fn(async () => undefined);
    const core = createTrackerCore({ getDb: async () => db as unknown as TrackerDb, now: () => NOW, market: () => 'cn', env: MODE_OFF, recordInteraction: record });
    const before = JSON.stringify(db.$rows('rATrackerEntry'));
    for (const ids of [['e_gh'], ['e_own', 'e_gh']]) {
      await expect(core.bulk(U, { ids, patch: { status: 'interviewing' } })).rejects.toMatchObject({ code: 'invalid_request', reason: 'not_owner', message: 'Some ids not owned by user' });
    }
    // The same answer as a foreign id: the request does not reveal that the entry exists.
    await expect(core.bulk(U, { ids: ['e_nobody'], patch: { status: 'interviewing' } })).rejects.toMatchObject({ code: 'invalid_request', reason: 'not_owner', message: 'Some ids not owned by user' });
    expect(JSON.stringify(db.$rows('rATrackerEntry'))).toBe(before);
    expect(db.$rows('rATrackerEvent')).toHaveLength(0);
    expect(record).not.toHaveBeenCalled();
    // The user's own entries still move in bulk.
    const moved = await core.bulk(U, { ids: ['e_own', 'e_typed'], patch: { status: 'interviewing' } });
    expect(moved).toMatchObject({ updated: 2 });
    expect(moved.entries.map((e) => e.status)).toEqual(['interviewing', 'interviewing']);
    expect(JSON.stringify(moved)).not.toMatch(NAMES);
  });

  it('follow-up facts, the Assistant summary and the CSV export name only the user\'s own jobs', async () => {
    const followUps = await off().followUps(U);
    expect(followUps.map((f) => f.entryId).sort()).toEqual(['e_own', 'e_typed']);
    expect(JSON.stringify(followUps)).not.toMatch(NAMES);
    const summary = await off().summary(U);
    expect(summary.byStatus).toEqual({ applied: 2 });
    expect(JSON.stringify(summary)).not.toMatch(NAMES);
    const exported = await off().exportEntries(U);
    expect(exported.map((e) => e.id).sort()).toEqual(['e_own', 'e_typed']);
    const csv = trackerCsv(exported, 'zh', 'cn');
    expect(csv).toContain('我的导入公司');
    expect(csv).not.toMatch(NAMES);
    const weekly = await off().weeklyFacts(U, '2026-10-04');
    expect(weekly.noReply10d).toBe(2);
  });

  it('a third-party posting cannot be saved, applied to or added while the mode is off; the own import can', async () => {
    await expect(off().upsertForJob(U, 'job_gh', { status: 'bookmarked' })).rejects.toBeInstanceOf(TrackerNotFoundError);
    await expect(off().markApplied(U, 'job_gh', 'manual')).rejects.toBeInstanceOf(TrackerNotFoundError);
    db.$rows('rATrackerEntry').splice(0);
    await expect(off().create(U, { jobId: 'job_gh' })).rejects.toBeInstanceOf(TrackerNotFoundError);
    await expect(off().create(U, { jobId: 'job_theirs' })).rejects.toBeInstanceOf(TrackerNotFoundError);
    expect((await off().create(U, { jobId: 'job_own' })).job?.visibility).toBe('private');
    expect(db.$rows('rATrackerEntry').map((r) => r.jobId)).toEqual(['job_own']);
  });

  it('nothing is deleted: the entry is back when the mode allows postings again', async () => {
    expect((await off().list(U, {})).total).toBe(2);
    const on = await coreFor(MODE_ON).list(U, {});
    expect(on.entries.map((e) => e.id).sort()).toEqual(['e_gh', 'e_own', 'e_typed']);
  });
});

describe('GoApply, CN_RECRUITMENT_INFO_MODE=partner_deeplink: both the posting and the import are returned', () => {
  const on = () => coreFor(MODE_ON);

  it('list, counts, by-id reads, follow-ups, summary and export include the GoHire posting', async () => {
    const res = await on().list(U, {});
    expect(res.entries.map((e) => e.id).sort()).toEqual(['e_gh', 'e_own', 'e_typed']);
    expect(res.total).toBe(3);
    expect(res.statusCounts.applied).toBe(3);
    // The scanner does see the posting here: the mode-off checks above are not vacuous.
    expect(thirdPartyPostings(res)).toHaveLength(1);
    expect((await on().getById(U, 'e_gh')).job).toMatchObject({ companyName: '示例科技有限公司', visibility: 'public' });
    expect((await on().artifacts(U, 'e_gh')).map((a) => a.fileName)).toEqual(['resume.pdf']);
    expect((await on().followUps(U)).map((f) => f.entryId).sort()).toEqual(['e_gh', 'e_own', 'e_typed']);
    expect((await on().summary(U)).byStatus).toEqual({ applied: 3 });
    expect(trackerCsv(await on().exportEntries(U), 'zh', 'cn')).toMatch(/示例科技有限公司/);
    await expect(on().patch(U, 'e_gh', { status: 'interviewing' })).resolves.toMatchObject({ status: 'interviewing' });
    await expect(on().bulk(U, { ids: ['e_gh', 'e_own'], patch: { status: 'offer' } })).resolves.toMatchObject({ updated: 2 });
  });

  it('default (nothing set): the GoHire posting is returned too', async () => {
    const byDefault = coreFor(MODE_DEFAULT);
    const res = await byDefault.list(U, {});
    expect(res.entries.map((e) => e.id).sort()).toEqual(['e_gh', 'e_own', 'e_typed']);
    expect(thirdPartyPostings(res)).toHaveLength(1);
    expect((await byDefault.getById(U, 'e_gh')).job).toMatchObject({ companyName: '示例科技有限公司', visibility: 'public' });
  });

  it('another user\'s private import is never visible, whatever the mode', async () => {
    db.$rows('rATrackerEntry').push(entry('e_theirs', 'job_theirs'));
    expect((await on().list(U, {})).entries.map((e) => e.id)).not.toContain('e_theirs');
    await expect(on().getById(U, 'e_theirs')).rejects.toBeInstanceOf(TrackerNotFoundError);
  });
});

describe('RoboApply is not affected by the GoApply mode', () => {
  it('an intl posting stays in the tracker with the mode off', async () => {
    db = createFakePrisma({
      timestampFields: ['createdAt', 'updatedAt', 'dateSaved'],
      seed: { rAJob: [job({ id: 'job_us', title: 'Data Analyst', companyName: 'Acme', applyUrl: 'https://acme.example/1', market: 'intl', visibility: 'public', ownerUserId: null })], rATrackerEntry: [entry('e_us', 'job_us')], rATrackerEvent: [] },
    });
    const intl = createTrackerCore({ getDb: async () => db as unknown as TrackerDb, now: () => NOW, market: () => 'intl', env: MODE_OFF });
    expect((await intl.list(U, {})).entries.map((e) => e.id)).toEqual(['e_us']);
    expect((await intl.getById(U, 'e_us')).job?.companyName).toBe('Acme');
  });
});

describe('the tracker router on GoApply (follow-ups, export.csv, events, artifacts)', () => {
  let off: RouteHarness;
  let on: RouteHarness;
  const passLimiter = () => (_req: unknown, _res: unknown, next: () => void) => next();
  const mount = (env: Record<string, string>) =>
    startRouteHarness({
      env,
      mounts: [[BASE, createTrackerRouter({ seekerAuth: [fakeAuth({ id: U, role: 'seeker' })], env }, { core: coreFor(env), limiter: passLimiter as never })]],
    });

  beforeAll(async () => {
    off = await mount(MODE_OFF);
    on = await mount(MODE_ON);
  });
  afterAll(async () => {
    await Promise.all([off?.close(), on?.close()]);
  });

  it('mode off: every 2xx body is free of the GoHire posting; the hidden entry\'s sub-routes are 404', async () => {
    const followUps = await off.request<{ data: { items: Array<{ entryId: string }> } }>('GET', `${BASE}/follow-ups`, { host: GA });
    expect(followUps.status).toBe(200);
    expect(followUps.body.data.items.map((i) => i.entryId).sort()).toEqual(['e_own', 'e_typed']);
    expect(followUps.text).not.toMatch(NAMES);

    const csv = await off.request('GET', `${BASE}/export.csv`, { host: GA, headers: { 'x-robo-locale': 'zh' } });
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('我的导入公司');
    expect(csv.text).toContain('公司,职位,阶段');
    expect(csv.text).not.toMatch(NAMES);

    for (const path of ['events', 'artifacts']) {
      const hidden = await off.request<{ code?: string }>('GET', `${BASE}/e_gh/${path}`, { host: GA });
      expect([hidden.status, hidden.body.code], path).toEqual([404, 'not_found']);
      const own = await off.request('GET', `${BASE}/e_own/${path}`, { host: GA });
      expect(own.status, path).toBe(200);
    }
    const note = await off.request<{ code?: string }>('POST', `${BASE}/e_gh/events`, { host: GA, body: { note: 'x' } });
    expect(note.status).toBe(404);
  });

  it('partner_deeplink: the same routes return the posting', async () => {
    const followUps = await on.request<{ data: { items: Array<{ entryId: string }> } }>('GET', `${BASE}/follow-ups`, { host: GA });
    expect(followUps.body.data.items.map((i) => i.entryId).sort()).toEqual(['e_gh', 'e_own', 'e_typed']);
    const csv = await on.request('GET', `${BASE}/export.csv`, { host: GA });
    expect(csv.text).toMatch(/示例科技有限公司/);
    expect((await on.request('GET', `${BASE}/e_gh/artifacts`, { host: GA })).status).toBe(200);
  });
});
