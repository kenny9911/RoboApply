// @vitest-environment node
// R-14 / R41-1b (WP-93): with CN_RECRUITMENT_INFO_MODE=off no seeker alert,
// digest row or inbox row on GoApply carries a third-party posting.
//
// One public GoHire posting is seeded and read through the alerts' own seams:
//   - the candidate selection seam (`modeGatedCandidates` over the Prisma
//     source): off → nothing; partner_deeplink → listed;
//   - the Prisma source by itself (the gate is a second layer, not the only one),
//     the card reader behind digest rows, and the re-engagement "N new jobs"
//     count (lifecycle `countNewJobsWith` over the same gated seam);
//   - the whole `job-alerts` task on GoApply, with the `jobs.alerts` flag forced
//     ON so only the mode stands between the posting and an alert;
//   - the inbox readers (list, unread count, mark read) over an alert row
//     written while the mode allowed postings, and over the rows that name one
//     posting (the tailoring tip, the ready-list kit reminder).
// RoboApply is never affected. In-memory Prisma: no database, no network.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../lib/prisma.js', () => ({ default: {}, prisma: {} }));

import { getBrand, type BrandId } from '../../platform/brand/registry.js';
import { createBudget, type CronContext } from '../../platform/queue/index.js';
import type { SendEmailInput, SendEmailResult } from '../../platform/email/index.js';
import { NOTIFY_TEMPLATES } from '../../platform/email/templates/notify/index.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { cnJobCapabilities } from '../cn/jobs/index.js';
import { NotificationCenterService, type NotificationsDb } from '../notifications/index.js';
import { defaultPostingsAllowed, modeGatedCandidates, type AlertCandidateQuery } from './candidates.js';
import { deliverMessage, type DeliverDeps, type InAppRow } from './deliver.js';
import type { PreferenceFacts } from './preferences.js';
import { createPrismaAlertsRepo, type AlertProfileRow, type AlertsRepo, type PrismaAlertsRepoOptions, type Recipient } from './repo.js';
import { createJobAlertsTask, type JobAlertsDeps } from './service.js';
import { countNewJobsWith } from '../lifecycle/service.js';

const NOW = new Date('2026-10-12T04:00:00Z'); // 12:00 in Shanghai
const HOUR = 3_600_000;
const OFF = { CN_RECRUITMENT_INFO_MODE: 'off' };
const PARTNER = { CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' };
const GO = getBrand('goapply');
const ROBO = getBrand('roboapply');

/** A public posting from the GoHire bank, as the ingest stores it. */
function gohirePosting(over: Record<string, unknown> = {}) {
  return {
    id: 'job_gh',
    market: 'cn',
    visibility: 'public',
    ownerUserId: null,
    provider: 'gohire',
    sourceBoard: 'gohire',
    isCanonical: true,
    archivedAt: null,
    closedAt: null,
    firstSeenAt: new Date(NOW.getTime() - HOUR),
    postedAt: new Date(NOW.getTime() - HOUR),
    fraudFlags: null,
    title: '产品经理',
    companyName: '示例科技有限公司',
    location: '上海',
    locationCity: '上海',
    workModel: 'onsite',
    salaryMin: 15000,
    salaryMax: 25000,
    salaryCurrency: 'CNY',
    salaryPeriod: 'month',
    salaryText: '15-25K',
    salaryDisclosed: true,
    ...over,
  };
}

function world(jobs: Array<Record<string, unknown>> = [gohirePosting()]) {
  const db = createFakePrisma({ seed: { rAJob: jobs } });
  const getDb = (async () => db) as unknown as NonNullable<PrismaAlertsRepoOptions['getDb']>;
  const repoFor = (env: Record<string, string>) => createPrismaAlertsRepo({ getDb, env });
  return { db, repoFor };
}

const query = (over: Partial<AlertCandidateQuery> = {}): AlertCandidateQuery => ({
  searchProfileId: 'sp1',
  userId: 'u1',
  market: 'cn',
  filters: {},
  since: new Date(NOW.getTime() - 24 * HOUR),
  postedSince: null,
  limit: 100,
  ...over,
});

describe('alert candidates: the selection seam', () => {
  it('mode off: the seeded GoHire posting is not a candidate; partner_deeplink: it is listed', async () => {
    const w = world();
    const select = (env: Record<string, string>) => modeGatedCandidates((q) => w.repoFor(env).candidateJobIds(q), defaultPostingsAllowed(env));
    expect(await select(OFF)(query())).toEqual({ ids: [], truncated: false });
    expect(await select(PARTNER)(query())).toEqual({ ids: ['job_gh'], truncated: false });
    expect(await select({ CN_RECRUITMENT_INFO_MODE: 'licensed' })(query())).toEqual({ ids: ['job_gh'], truncated: false });
    // The default (variable unset) is off.
    expect(await select({})(query())).toEqual({ ids: [], truncated: false });
  });

  it('mode off: the source is not even asked, whatever it is (join J4 swaps the source, not the gate)', async () => {
    const source = vi.fn(async () => ({ ids: ['job_gh'], truncated: false }));
    expect(await modeGatedCandidates(source, defaultPostingsAllowed(OFF))(query())).toEqual({ ids: [], truncated: false });
    expect(source).not.toHaveBeenCalled();
    expect(await modeGatedCandidates(source, defaultPostingsAllowed(PARTNER))(query())).toEqual({ ids: ['job_gh'], truncated: false });
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('the Prisma source filters by the mode in its own query too (second layer)', async () => {
    const w = world();
    expect(await w.repoFor(OFF).candidateJobIds(query())).toEqual({ ids: [], truncated: false });
    expect(await w.repoFor(PARTNER).candidateJobIds(query())).toEqual({ ids: ['job_gh'], truncated: false });
  });

  it('a user’s own import never alerts, in either mode', async () => {
    const w = world([gohirePosting({ id: 'job_own', visibility: 'private', ownerUserId: 'u1', provider: 'user_import', sourceBoard: null })]);
    for (const env of [OFF, PARTNER]) expect((await w.repoFor(env).candidateJobIds(query())).ids).toEqual([]);
  });

  it('RoboApply is not touched by the GoApply mode', async () => {
    const w = world([gohirePosting({ id: 'job_intl', market: 'intl', provider: 'jsearch', sourceBoard: 'greenhouse' })]);
    const select = modeGatedCandidates((q) => w.repoFor(OFF).candidateJobIds(q), defaultPostingsAllowed(OFF));
    expect(await select(query({ market: 'intl' }))).toEqual({ ids: ['job_intl'], truncated: false });
    expect((await w.repoFor(OFF).jobCards(['job_intl'])).map((j) => j.id)).toEqual(['job_intl']);
  });
});

describe('digest rows and the "N new jobs" count', () => {
  it('mode off: the card reader returns no third-party posting, so no digest row can carry one', async () => {
    const w = world();
    expect(await w.repoFor(OFF).jobCards(['job_gh'])).toEqual([]);
    const cards = await w.repoFor(PARTNER).jobCards(['job_gh']);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: 'job_gh', title: '产品经理', companyName: '示例科技有限公司', salaryText: '15-25K' });
    // The fields read for the mode check are not part of the card.
    expect(Object.keys(cards[0]!)).not.toEqual(expect.arrayContaining(['market', 'visibility', 'ownerUserId', 'provider', 'sourceBoard']));
  });

  it('mode off: the re-engagement count never asks its source and is 0, so no "N new jobs" message goes out', async () => {
    // The lifecycle count reads the same gated candidate seam as the alerts (join J4).
    const asked: AlertCandidateQuery[] = [];
    const source = async (q: AlertCandidateQuery) => (asked.push(q), { ids: ['job_gh', 'job_2', 'job_3'], truncated: false });
    const input = { searchProfileId: 'sp_cn', userId: 'u_cn', since: new Date(NOW.getTime() - 24 * HOUR) };
    const off = countNewJobsWith(modeGatedCandidates(source, defaultPostingsAllowed(OFF)));
    expect(await off({ ...input, market: 'cn' })).toBe(0);
    expect(asked).toHaveLength(0);
    const partner = countNewJobsWith(modeGatedCandidates(source, defaultPostingsAllowed(PARTNER)));
    expect(await partner({ ...input, market: 'cn' })).toBe(3);
    // RoboApply is not affected by the GoApply mode.
    expect(await off({ ...input, market: 'intl' })).toBe(3);
    expect(asked.map((q) => q.market)).toEqual(['cn', 'intl']);
  });
});

// ── The whole task on GoApply ────────────────────────────────────────────

function taskHarness(env: Record<string, string>, brandId: BrandId = 'goapply') {
  const w = world();
  const prismaRepo = w.repoFor(env);
  const profile: AlertProfileRow = { id: 'sp1', userId: 'u1', name: '产品岗', filters: {}, alertInstantMax: 5, alertDigest: 'daily', alertLastInstantAt: null, alertLastDigestAt: null };
  const recipient: Recipient = { userId: 'u1', brand: brandId, email: 'u1@example.cn', locale: 'zh', timeZone: 'Asia/Shanghai', seekerProfileId: 'sp-u1' };
  const deliveries: Array<{ id: string; kind: string; jobIds: string[] }> = [];
  // Saved searches, people and the delivery ledger are fixed; the job reads are the real Prisma ones.
  const repo: AlertsRepo = {
    ...prismaRepo,
    dueProfiles: async ({ afterId }) => (afterId ? [] : [profile]),
    recipients: async () => new Map([['u1', recipient]]),
    excludedJobIds: async () => new Set(),
    instantCountsSince: async () => ({ total: 0, byProfile: new Map() }),
    claimInstant: async () => true,
    claimDigest: async () => true,
    releaseInstant: async () => undefined,
    releaseDigest: async () => undefined,
    createDelivery: async (input) => (deliveries.push({ id: `d${deliveries.length + 1}`, kind: input.kind, jobIds: input.jobIds }), { id: `d${deliveries.length}` }),
    setDeliveryEmailLog: async () => undefined,
    noReplyCount: async () => 0,
  };
  const inApp: InAppRow[] = [];
  const emails: SendEmailInput[] = [];
  const deliverDeps: DeliverDeps = {
    createInApp: async (row) => (inApp.push(row), { id: `n${inApp.length}` }),
    markEmailed: async () => undefined,
    sendEmail: async (input): Promise<SendEmailResult> => (emails.push(input), { status: 'sent', provider: 'resend', logId: 'log1' }),
    channels: () => [],
    emailEnabled: () => true,
    now: () => NOW,
  };
  const prefs: PreferenceFacts = { userId: 'u1', brand: brandId, tipsGranted: null, marketingGranted: null, country: 'CN', prefs: {}, timeZone: 'Asia/Shanghai', quietHours: { start: '21:00', end: '08:00' } };
  const deps: JobAlertsDeps = {
    repo,
    candidates: modeGatedCandidates((q) => repo.candidateJobIds(q), defaultPostingsAllowed(env)),
    prefs: { load: async () => prefs },
    preScore: async (_userId, ids) => ids.map((jobId) => ({ jobId, score: 88, tier: 'great' as const, topGap: null })),
    planInstantMax: async () => 100,
    deliver: (msg) => deliverMessage(msg, deliverDeps),
    // Forced on: in production `jobs.alerts` follows the mode; here only the mode guards the posting.
    alertsEnabled: () => true,
  };
  const ctx: CronContext = { name: 'job-alerts', brand: getBrand(brandId), budget: createBudget(240_000), now: NOW };
  return { run: () => createJobAlertsTask(() => deps)(ctx), deliveries, inApp, emails };
}

describe('job-alerts on GoApply', () => {
  it('the flag follows the mode (the first guard)', () => {
    expect(cnJobCapabilities(OFF)).toMatchObject({ postings: false, alerts: false });
    expect(cnJobCapabilities(PARTNER)).toMatchObject({ postings: true, alerts: true });
  });

  it('mode off, even with the alerts flag on: no delivery, no inbox row, no email carries the posting', async () => {
    const h = taskHarness(OFF);
    expect(await h.run()).toMatchObject({ instantSent: 0, digestSent: 0 });
    expect(h.deliveries).toEqual([]);
    expect(h.inApp).toEqual([]);
    expect(h.emails).toEqual([]);
  });

  it('partner_deeplink: the posting is alerted, in the inbox row and the email', async () => {
    const h = taskHarness(PARTNER);
    expect(await h.run()).toMatchObject({ instantSent: 1 });
    expect(h.deliveries[0]).toMatchObject({ kind: 'instant', jobIds: ['job_gh'] });
    expect(h.inApp[0]).toMatchObject({ brand: 'goapply', category: 'alert', templateKey: NOTIFY_TEMPLATES.jobAlertInstant });
    const jobs = (h.inApp[0]!.params as { jobs: Array<{ id: string; company: string }> }).jobs;
    expect(jobs.map((j) => [j.id, j.company])).toEqual([['job_gh', '示例科技有限公司']]);
    expect((h.emails[0]!.params as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id)).toEqual(['job_gh']);
  });
});

// ── Inbox readers ────────────────────────────────────────────────────────

function inbox(env: Record<string, string>, brand: 'goapply' | 'roboapply' = 'goapply') {
  const db = createFakePrisma();
  db.$rows('user').push({ id: 'u1', email: 'u1@example.cn', emailIsPlaceholder: false, brand });
  db.$rows('seekerProfile').push({ id: 'sp1', userId: 'u1', market: null, notificationPreferences: null, weeklyNudgeOptOut: false });
  const base = { seekerProfileId: 'sp1', userId: 'u1', brand, body: null, deepLink: null, readAt: null, relatedEntityType: null, relatedEntityId: null };
  const card = { id: 'job_gh', title: '产品经理', company: '示例科技有限公司', place: '上海', remote: false, pay: null, tier: 'great', gap: null, href: '/jobs/job_gh?from=alert&imp=d1' };
  const rows = db.$rows('seekerNotification');
  // Written while the mode allowed postings (partner_deeplink), then the mode went back to off.
  rows.push({ ...base, id: 'n_alert', type: NOTIFY_TEMPLATES.jobAlertInstant, category: 'alert', templateKey: NOTIFY_TEMPLATES.jobAlertInstant, params: { search: '产品岗', jobs: [card] }, title: '“产品岗”有 1 个新职位', deepLink: '/jobs?from=alert', relatedEntityType: 'alert_delivery', relatedEntityId: 'd1', createdAt: new Date(NOW.getTime() - 4 * HOUR) });
  rows.push({ ...base, id: 'n_digest', type: NOTIFY_TEMPLATES.jobAlertDigest, category: 'alert', templateKey: NOTIFY_TEMPLATES.jobAlertDigest, params: { search: '产品岗', cadence: 'daily', jobs: [card], moreCount: 0 }, title: '1 个新职位', relatedEntityType: 'alert_delivery', relatedEntityId: 'd2', createdAt: new Date(NOW.getTime() - 3 * HOUR) });
  // A tip that names a posting (no alert template, no delivery): caught by the row check.
  rows.push({ ...base, id: 'n_tip', type: NOTIFY_TEMPLATES.tipsFirstTailor, category: 'tips', templateKey: NOTIFY_TEMPLATES.tipsFirstTailor, params: { job: { id: 'job_gh', title: '产品经理', company: '示例科技有限公司' } }, title: '为“产品经理”定制简历', createdAt: new Date(NOW.getTime() - 2 * HOUR) });
  // The ready-list kit reminder (WP-52): flat params name the posting by id. One for the GoHire posting, one for the person's own imported job.
  db.$rows('rAJob').push({ id: 'job_gh', market: 'cn', visibility: 'public', ownerUserId: null, sourceBoard: 'gohire' });
  db.$rows('rAJob').push({ id: 'job_own', market: 'cn', visibility: 'private', ownerUserId: 'u1', sourceBoard: null });
  const kit = { type: NOTIFY_TEMPLATES.kitNotOpened, category: 'reminder', templateKey: NOTIFY_TEMPLATES.kitNotOpened, relatedEntityType: 'agent_queue_item' };
  rows.push({ ...base, ...kit, id: 'n_kit', params: { jobId: 'job_gh', title: '产品经理', company: '示例科技有限公司' }, title: '“产品经理”的材料已备好', deepLink: '/ready/job_gh', relatedEntityId: 'q1', createdAt: new Date(NOW.getTime() - 100 * 60_000) });
  rows.push({ ...base, ...kit, id: 'n_kit_own', params: { jobId: 'job_own', title: '运营专员', company: '我导入的公司' }, title: '“运营专员”的材料已备好', deepLink: '/ready/job_own', relatedEntityId: 'q2', createdAt: new Date(NOW.getTime() - 90 * 60_000) });
  // Rows that carry no posting: the person's own campus reminder and a plain system row with no template.
  rows.push({ ...base, id: 'n_campus', type: 'reminder', category: 'reminder', templateKey: 'campus.deadline', params: { eventId: 'ev1', company: '示例科技', program: '2027届校园招聘', closesAt: '2026-10-31T15:59:00.000Z', days: 1 }, title: '示例科技：网申明天截止', relatedEntityType: 'campus_event', relatedEntityId: 'ev1', createdAt: new Date(NOW.getTime() - HOUR) });
  rows.push({ ...base, id: 'n_system', type: 'system', category: 'system', templateKey: null, params: null, title: '账号已验证', createdAt: NOW });
  const service = new NotificationCenterService({ db: db as unknown as NotificationsDb, env, now: () => NOW, capabilities: async () => ({ email: true, push: false, wechat: false, invitations: false, alerts: false }) });
  return { db, service, profile: { id: 'sp1', userId: 'u1' } };
}

describe('inbox rows on GoApply', () => {
  it('mode off: no row that carries a third-party posting is listed, counted or opened', async () => {
    const { db, service, profile } = inbox(OFF);
    const list = await service.list(profile, GO);
    // The kit for the person's own imported job stays; the kit for the GoHire posting does not.
    expect(list.items.map((n) => n.id)).toEqual(['n_system', 'n_campus', 'n_kit_own']);
    expect(JSON.stringify(list)).not.toContain('job_gh');
    expect(JSON.stringify(list)).not.toContain('示例科技有限公司');
    // The badge agrees with the list: hidden rows are not counted as unread.
    expect(await service.unreadCount('u1', GO)).toBe(3);
    expect(await service.unreadCountForProfile('sp1', GO)).toBe(3);
    await expect(service.markRead(profile, GO, 'n_alert')).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.markRead(profile, GO, 'n_tip')).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.markRead(profile, GO, 'n_kit')).rejects.toMatchObject({ code: 'not_found' });
    // "Mark all read" covers what the person could see; every hidden row is left as it was.
    expect(await service.markAllRead(profile, GO)).toEqual({ updated: 3 });
    const read = Object.fromEntries(db.$rows('seekerNotification').map((r) => [r.id as string, r.readAt !== null]));
    expect(read).toEqual({ n_alert: false, n_digest: false, n_tip: false, n_kit: false, n_kit_own: true, n_campus: true, n_system: true });
  });

  it('mode off: a kit reminder is the owner’s only; a kit whose job is gone is left out', async () => {
    const { db, service, profile } = inbox(OFF);
    // Another person's import is never "own".
    db.$rows('rAJob').find((j) => j.id === 'job_own')!.ownerUserId = 'someone_else';
    expect((await service.list(profile, GO)).items.map((n) => n.id)).toEqual(['n_system', 'n_campus']);
    // The job row is gone: nothing shows the kit was for the person's own job.
    db.$rows('rAJob').length = 0;
    expect((await service.list(profile, GO)).items.map((n) => n.id)).toEqual(['n_system', 'n_campus']);
    expect(await service.unreadCount('u1', GO)).toBe(2);
  });

  it('tracker reminders are about the person’s own applications and stay, whatever job they name', async () => {
    const { db, service, profile } = inbox(OFF);
    db.$rows('seekerNotification').push({
      seekerProfileId: 'sp1', userId: 'u1', brand: 'goapply', body: null, readAt: null, relatedEntityType: 'tracker_entry', relatedEntityId: 't1',
      id: 'n_interview', type: NOTIFY_TEMPLATES.interviewReminder, category: 'reminder', templateKey: NOTIFY_TEMPLATES.interviewReminder,
      params: { entryId: 't1', jobId: 'job_gh', title: '产品经理', company: '我投递的公司', interviewAt: '2026-10-13T02:00:00.000Z' }, title: '面试提醒', deepLink: '/applications', createdAt: new Date(NOW.getTime() + 60_000),
    });
    expect((await service.list(profile, GO)).items.map((n) => n.id)).toEqual(['n_interview', 'n_system', 'n_campus', 'n_kit_own']);
  });

  it('partner_deeplink: the same rows are listed again (nothing was deleted)', async () => {
    const { service, profile } = inbox(PARTNER);
    const list = await service.list(profile, GO);
    expect(list.items.map((n) => n.id)).toEqual(['n_system', 'n_campus', 'n_kit_own', 'n_kit', 'n_tip', 'n_digest', 'n_alert']);
    expect(await service.unreadCount('u1', GO)).toBe(7);
    await expect(service.markRead(profile, GO, 'n_alert')).resolves.toBeUndefined();
  });

  it('paging still reaches every visible row when hidden rows sit between them', async () => {
    const { service, profile } = inbox(OFF);
    const first = await service.list(profile, GO, { limit: 1 });
    const second = await service.list(profile, GO, { limit: 1, cursor: first.cursor ?? undefined });
    const third = await service.list(profile, GO, { limit: 1, cursor: second.cursor ?? undefined });
    expect([...first.items, ...second.items, ...third.items].map((n) => n.id)).toEqual(['n_system', 'n_campus', 'n_kit_own']);
  });

  it('RoboApply inboxes are never filtered by the GoApply mode', async () => {
    const { service, profile } = inbox(OFF, 'roboapply');
    expect((await service.list(profile, ROBO)).items).toHaveLength(7);
    expect(await service.unreadCount('u1', ROBO)).toBe(7);
  });
});
