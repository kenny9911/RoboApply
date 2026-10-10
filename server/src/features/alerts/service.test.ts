// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { getBrand, type BrandId } from '../../platform/brand/registry.js';
import { createBudget, type CronContext } from '../../platform/queue/index.js';
import type { SendEmailInput, SendEmailResult } from '../../platform/email/index.js';
import { NOTIFY_TEMPLATES } from '../../platform/email/templates/notify/index.js';
import { deliverMessage, type DeliverDeps, type InAppRow } from './deliver.js';
import { deliveryChannels, registerDeliveryChannel, resetDeliveryChannelsForTests, type DeliveryChannel, type DeliveryMessage } from './index.js';
import type { PreferenceFacts } from './preferences.js';
import type { AlertProfileRow, AlertsRepo, JobCardRow, Recipient } from './repo.js';
import type { ScoredJob } from './selection.js';
import { createJobAlertsTask, type JobAlertsDeps } from './service.js';

// ── In-memory world ──────────────────────────────────────────────────────

interface World {
  profiles: AlertProfileRow[];
  recipients: Map<string, Recipient>;
  jobs: Array<JobCardRow & { firstSeenAt: Date; postedAt: Date | null; market: string }>;
  hidden: Set<string>;
  tracked: Set<string>;
  deliveries: Array<{ id: string; userId: string; searchProfileId: string; kind: string; jobIds: string[]; sentAt: Date; emailLogId?: string | null }>;
  scores: Map<string, ScoredJob>;
  noReply: number;
  claimFails: boolean;
  clock: { now: Date };
}

function card(id: string, extra: Partial<JobCardRow> = {}): JobCardRow {
  return {
    id,
    title: `Engineer ${id}`,
    companyName: `Co ${id}`,
    location: 'Austin, TX',
    locationCity: 'Austin',
    workModel: 'onsite',
    salaryMin: 100000,
    salaryMax: 130000,
    salaryCurrency: 'USD',
    salaryPeriod: 'year',
    salaryText: null,
    salaryDisclosed: true,
    ...extra,
  };
}

function makeRepo(w: World): AlertsRepo {
  let seq = 0;
  return {
    async dueProfiles({ afterId, limit }) {
      return w.profiles.filter((p) => !afterId || p.id > afterId).slice(0, limit);
    },
    async recipients(ids) {
      return new Map(ids.flatMap((id) => (w.recipients.has(id) ? [[id, w.recipients.get(id)!] as const] : [])));
    },
    async candidateJobIds({ since, postedSince, limit, market }) {
      const rows = w.jobs
        .filter((j) => j.market === market && j.firstSeenAt > since && (!postedSince || !j.postedAt || j.postedAt >= postedSince))
        .sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime());
      return { ids: rows.slice(0, limit).map((r) => r.id), truncated: rows.length > limit };
    },
    async excludedJobIds({ searchProfileId, jobIds }) {
      const out = new Set<string>();
      for (const id of jobIds) {
        if (w.hidden.has(id) || w.tracked.has(id)) out.add(id);
        if (w.deliveries.some((d) => d.searchProfileId === searchProfileId && d.jobIds.includes(id))) out.add(id);
      }
      return out;
    },
    async instantCountsSince(userId, since) {
      const rows = w.deliveries.filter((d) => d.userId === userId && d.kind === 'instant' && d.sentAt >= since);
      const byProfile = new Map<string, number>();
      for (const r of rows) byProfile.set(r.searchProfileId, (byProfile.get(r.searchProfileId) ?? 0) + 1);
      return { total: rows.length, byProfile };
    },
    async claimInstant(profileId, previous, now) {
      if (w.claimFails) return false;
      const p = w.profiles.find((x) => x.id === profileId)!;
      if ((p.alertLastInstantAt?.getTime() ?? null) !== (previous?.getTime() ?? null)) return false;
      p.alertLastInstantAt = now;
      return true;
    },
    async claimDigest(profileId, previous, now) {
      if (w.claimFails) return false;
      const p = w.profiles.find((x) => x.id === profileId)!;
      if ((p.alertLastDigestAt?.getTime() ?? null) !== (previous?.getTime() ?? null)) return false;
      p.alertLastDigestAt = now;
      return true;
    },
    async releaseInstant(profileId, claimedAt, previous) {
      const p = w.profiles.find((x) => x.id === profileId)!;
      if (p.alertLastInstantAt?.getTime() === claimedAt.getTime()) p.alertLastInstantAt = previous;
    },
    async releaseDigest(profileId, claimedAt, previous) {
      const p = w.profiles.find((x) => x.id === profileId)!;
      if (p.alertLastDigestAt?.getTime() === claimedAt.getTime()) p.alertLastDigestAt = previous;
    },
    async createDelivery(input) {
      const row = { id: `d${++seq}`, ...input, sentAt: w.clock.now };
      w.deliveries.push(row);
      return { id: row.id };
    },
    async setDeliveryEmailLog(deliveryId, emailLogId) {
      const d = w.deliveries.find((x) => x.id === deliveryId);
      if (d) d.emailLogId = emailLogId;
    },
    async jobCards(ids) {
      return w.jobs.filter((j) => ids.includes(j.id));
    },
    async noReplyCount() {
      return w.noReply;
    },
  };
}

function makeWorld(): World {
  const now = new Date('2026-10-12T15:00:00Z'); // Monday 10:00 in Chicago (CDT)
  return {
    clock: { now },
    profiles: [
      {
        id: 'sp1',
        userId: 'u1',
        name: 'Backend in Austin',
        filters: {},
        alertInstantMax: 5,
        alertDigest: null,
        alertLastInstantAt: null,
        alertLastDigestAt: null,
      },
    ],
    recipients: new Map([
      ['u1', { userId: 'u1', brand: 'roboapply' as BrandId, email: 'u1@example.com', locale: 'en', timeZone: 'America/Chicago', seekerProfileId: 'sp-u1' }],
    ]),
    jobs: [
      { ...card('j1'), firstSeenAt: new Date(now.getTime() - 3_600_000), postedAt: new Date(now.getTime() - 3_600_000), market: 'intl' },
      { ...card('j2', { workModel: 'remote', salaryDisclosed: false, salaryMin: null, salaryMax: null }), firstSeenAt: new Date(now.getTime() - 2 * 3_600_000), postedAt: null, market: 'intl' },
      { ...card('j3'), firstSeenAt: new Date(now.getTime() - 4 * 3_600_000), postedAt: null, market: 'intl' },
      { ...card('j4'), firstSeenAt: new Date(now.getTime() - 5 * 3_600_000), postedAt: null, market: 'intl' },
      { ...card('jcn'), firstSeenAt: new Date(now.getTime() - 1_000), postedAt: null, market: 'cn' },
    ],
    hidden: new Set(),
    tracked: new Set(),
    deliveries: [],
    scores: new Map([
      ['j1', { jobId: 'j1', score: 85, tier: 'great', topGap: 'Go' }],
      ['j2', { jobId: 'j2', score: 66, tier: 'good', topGap: null }],
      ['j3', { jobId: 'j3', score: 50, tier: 'possible', topGap: null }],
      ['j4', { jobId: 'j4', score: 20, tier: 'unlikely', topGap: null }],
    ]),
    noReply: 0,
    claimFails: false,
  };
}

const prefsFor = (over: Partial<PreferenceFacts> = {}): PreferenceFacts => ({
  userId: 'u1',
  brand: 'roboapply',
  tipsGranted: null,
  marketingGranted: null,
  country: 'US',
  prefs: {},
  timeZone: 'America/Chicago',
  quietHours: { start: '21:00', end: '08:00' },
  ...over,
});

interface Harness {
  deps: JobAlertsDeps;
  inApp: InAppRow[];
  emails: SendEmailInput[];
  preScore: ReturnType<typeof vi.fn>;
}

function harness(
  w: World,
  opts: { planMax?: number; prefs?: Partial<PreferenceFacts>; alertsEnabled?: boolean; emailEnabled?: boolean; emailResult?: (n: number) => SendEmailResult } = {},
): Harness {
  const inApp: InAppRow[] = [];
  const emails: SendEmailInput[] = [];
  const deliverDeps: DeliverDeps = {
    createInApp: async (row) => (inApp.push(row), { id: `n${inApp.length}` }),
    markEmailed: async () => undefined,
    // Like the platform `sendEmail`: a sent email answers with its RAEmailLog id.
    sendEmail: async (input): Promise<SendEmailResult> => (emails.push(input), opts.emailResult?.(emails.length) ?? { status: 'sent', provider: 'resend', logId: `log${emails.length}` }),
    channels: (b) => deliveryChannels(b.id),
    emailEnabled: () => opts.emailEnabled ?? true,
    now: () => w.clock.now,
  };
  const preScore = vi.fn(async (_userId: string, ids: string[]) => ids.flatMap((id) => (w.scores.has(id) ? [w.scores.get(id)!] : [])));
  const deps: JobAlertsDeps = {
    repo: makeRepo(w),
    // The one candidate seam; reads `deps.repo` at call time so a test can swap the repo.
    candidates: (q) => deps.repo.candidateJobIds(q),
    prefs: { load: async () => prefsFor(opts.prefs) },
    preScore,
    planInstantMax: async () => opts.planMax ?? 100,
    deliver: (msg) => deliverMessage(msg, deliverDeps),
    alertsEnabled: () => opts.alertsEnabled ?? true,
  };
  return { inApp, emails, preScore, deps };
}

function ctx(w: World, brandId: BrandId = 'roboapply'): CronContext {
  return { name: 'job-alerts', brand: getBrand(brandId), budget: createBudget(240_000), now: w.clock.now };
}

beforeEach(() => resetDeliveryChannelsForTests());
afterEach(() => resetDeliveryChannelsForTests());

describe('job-alerts: instant', () => {
  it('sends only new canonical jobs at Possible or better, records the delivery and mirrors it in-app', async () => {
    const w = makeWorld();
    w.hidden.add('j3'); // Not interested
    const h = harness(w);
    const r = await createJobAlertsTask(() => h.deps)(ctx(w));
    expect(r).toMatchObject({ processed: 1, instantSent: 1 });
    expect(w.deliveries).toHaveLength(1);
    expect(w.deliveries[0]).toMatchObject({ kind: 'instant', searchProfileId: 'sp1', jobIds: ['j1', 'j2'] });
    // In-app first (source of truth), then email.
    expect(h.inApp).toHaveLength(1);
    expect(h.inApp[0]).toMatchObject({ category: 'alert', templateKey: NOTIFY_TEMPLATES.jobAlertInstant, seekerProfileId: 'sp-u1', deepLink: '/jobs?from=alert' });
    expect(h.inApp[0]!.title).toBe('2 new jobs for "Backend in Austin"');
    expect(h.emails).toHaveLength(1);
    const params = h.emails[0]!.params as { jobs: Array<{ id: string; href: string; pay: unknown; remote: boolean; tier: string }> };
    expect(params.jobs.map((j) => j.id)).toEqual(['j1', 'j2']);
    expect(params.jobs[0]!.href).toBe(`/jobs/j1?from=alert&imp=${w.deliveries[0]!.id}`);
    expect(params.jobs[1]).toMatchObject({ remote: true, pay: null, tier: 'good' });
    // the pre-score never sees excluded jobs
    expect(h.preScore.mock.calls[0]![1]).not.toContain('j3');
    expect(w.profiles[0]!.alertLastInstantAt).toEqual(w.clock.now);
  });

  it('stores the email log id on the delivery when an email carried the alert (RAAlertDelivery.emailLogId)', async () => {
    const w = makeWorld();
    const h = harness(w);
    await createJobAlertsTask(() => h.deps)(ctx(w));
    expect(h.emails).toHaveLength(1);
    expect(w.deliveries[0]).toMatchObject({ kind: 'instant', emailLogId: 'log1' });
  });

  it('leaves emailLogId empty when no email went out (email off, or the send was gated)', async () => {
    const off = makeWorld();
    await createJobAlertsTask(() => harness(off, { emailEnabled: false }).deps)(ctx(off));
    expect(off.deliveries).toHaveLength(1);
    expect(off.deliveries[0]!.emailLogId ?? null).toBeNull();
    // Gated by the preference gate: sendEmail answers suppressed with no log id.
    const gated = makeWorld();
    const h = harness(gated, { emailResult: () => ({ status: 'suppressed', reason: 'preference_off', logId: null }) });
    await createJobAlertsTask(() => h.deps)(ctx(gated));
    expect(h.emails).toHaveLength(1);
    expect(gated.deliveries[0]!.emailLogId ?? null).toBeNull();
    // The in-app row is still written: the alert itself was delivered.
    expect(h.inApp).toHaveLength(1);
  });

  it('a failed link write never fails the alert', async () => {
    const w = makeWorld();
    const h = harness(w);
    h.deps.repo = { ...h.deps.repo, setDeliveryEmailLog: async () => { throw new Error('db down'); } };
    expect(await createJobAlertsTask(() => h.deps)(ctx(w))).toMatchObject({ instantSent: 1, errors: 0 });
  });

  it('takes its candidates from the one injectable seam (join J4 points it at the feed)', async () => {
    const w = makeWorld();
    const h = harness(w);
    const asked: Array<{ searchProfileId: string; userId: string; market: string; limit: number }> = [];
    h.deps.candidates = async (q) => (asked.push({ searchProfileId: q.searchProfileId, userId: q.userId, market: q.market, limit: q.limit }), { ids: ['j3'], truncated: false });
    await createJobAlertsTask(() => h.deps)(ctx(w));
    expect(asked).toEqual([{ searchProfileId: 'sp1', userId: 'u1', market: 'intl', limit: 100 }]);
    expect(w.deliveries[0]!.jobIds).toEqual(['j3']);
  });

  it('never sends a zero-job alert (nothing new, or nothing at Possible or better)', async () => {
    const w = makeWorld();
    w.scores = new Map([['j1', { jobId: 'j1', score: 30, tier: 'unlikely', topGap: null }]]);
    const h = harness(w);
    const r = await createJobAlertsTask(() => h.deps)(ctx(w));
    expect(r).toMatchObject({ instantSent: 0, noJobs: 1 });
    expect(w.deliveries).toHaveLength(0);
    expect(h.inApp).toHaveLength(0);
    expect(h.emails).toHaveLength(0);
    expect(w.profiles[0]!.alertLastInstantAt).toBeNull();
  });

  it('skips tracked jobs and jobs already sent for this search', async () => {
    const w = makeWorld();
    w.tracked.add('j1');
    w.deliveries.push({ id: 'old', userId: 'u1', searchProfileId: 'sp1', kind: 'instant', jobIds: ['j2'], sentAt: new Date('2026-10-01T00:00:00Z') });
    const h = harness(w);
    await createJobAlertsTask(() => h.deps)(ctx(w));
    expect(w.deliveries.at(-1)!.jobIds).toEqual(['j3']);
  });

  it('Free plan: one instant alert a day even when the search asks for more', async () => {
    const w = makeWorld();
    const h = harness(w, { planMax: 1 });
    const task = createJobAlertsTask(() => h.deps);
    await task(ctx(w));
    expect(w.deliveries).toHaveLength(1);
    // 4 hours later, same local day, a new job arrives.
    w.clock.now = new Date(w.clock.now.getTime() + 4 * 3_600_000);
    w.jobs.push({ ...card('j9'), firstSeenAt: new Date(w.clock.now.getTime() - 60_000), postedAt: null, market: 'intl' });
    w.scores.set('j9', { jobId: 'j9', score: 90, tier: 'great', topGap: null });
    const r = await task(ctx(w));
    expect(r).toMatchObject({ instantSent: 0, capped: 1 });
    expect(w.deliveries).toHaveLength(1);
  });

  it('Pro: another alert after 3 hours, never sooner', async () => {
    const w = makeWorld();
    const h = harness(w, { planMax: 100 });
    const task = createJobAlertsTask(() => h.deps);
    await task(ctx(w));
    const add = (id: string) => {
      w.jobs.push({ ...card(id), firstSeenAt: new Date(w.clock.now.getTime() - 60_000), postedAt: null, market: 'intl' });
      w.scores.set(id, { jobId: id, score: 90, tier: 'great', topGap: null });
    };
    w.clock.now = new Date(w.clock.now.getTime() + 2 * 3_600_000);
    add('j10');
    await task(ctx(w));
    expect(w.deliveries).toHaveLength(1);
    w.clock.now = new Date(w.clock.now.getTime() + 3_600_000);
    await task(ctx(w));
    expect(w.deliveries).toHaveLength(2);
    expect(w.deliveries[1]!.jobIds).toEqual(['j10']);
  });

  it('sends nothing in quiet hours', async () => {
    const w = makeWorld();
    w.clock.now = new Date('2026-10-12T04:00:00Z'); // 23:00 in Chicago
    const h = harness(w);
    const r = await createJobAlertsTask(() => h.deps)(ctx(w));
    expect(r).toMatchObject({ quiet: 1, instantSent: 0 });
    expect(h.emails).toHaveLength(0);
  });

  it('a lost claim (another run sent it) sends nothing', async () => {
    const w = makeWorld();
    w.claimFails = true;
    const h = harness(w);
    await createJobAlertsTask(() => h.deps)(ctx(w));
    expect(w.deliveries).toHaveLength(0);
    expect(h.emails).toHaveLength(0);
  });

  it('is off on a brand where jobs.alerts is off (GoApply, recruitment-info mode off)', async () => {
    const w = makeWorld();
    const h = harness(w, { alertsEnabled: false });
    expect(await createJobAlertsTask(() => h.deps)(ctx(w, 'goapply'))).toEqual({ skipped: 'disabled' });
    expect(h.preScore).not.toHaveBeenCalled();
  });

  it('answers no_work at once when no saved search has alerts on', async () => {
    const w = makeWorld();
    w.profiles = [];
    const h = harness(w);
    expect(await createJobAlertsTask(() => h.deps)(ctx(w))).toEqual({ skipped: 'no_work', processed: 0 });
  });

  it('GoApply person without a real email: in-app only', async () => {
    const w = makeWorld();
    w.recipients.set('u1', { ...w.recipients.get('u1')!, brand: 'goapply', email: null, timeZone: 'Asia/Shanghai' });
    w.jobs = w.jobs.map((j) => ({ ...j, market: 'cn' }));
    w.clock.now = new Date('2026-10-12T03:00:00Z'); // 11:00 Shanghai
    w.jobs.forEach((j) => (j.firstSeenAt = new Date(w.clock.now.getTime() - 60_000)));
    const h = harness(w, { prefs: { brand: 'goapply', timeZone: 'Asia/Shanghai' } });
    await createJobAlertsTask(() => h.deps)(ctx(w, 'goapply'));
    expect(h.inApp).toHaveLength(1);
    expect(h.emails).toHaveLength(0);
  });
});

describe('job-alerts: claims', () => {
  it('a send that records nothing gives the claim back (jobs vanished, or a failure before the delivery row)', async () => {
    const w = makeWorld();
    const h = harness(w);
    h.deps.repo = { ...h.deps.repo, jobCards: async () => [] };
    expect(await createJobAlertsTask(() => h.deps)(ctx(w))).toMatchObject({ instantSent: 0 });
    expect(w.profiles[0]!.alertLastInstantAt).toBeNull();

    const w2 = makeWorld();
    const h2 = harness(w2);
    h2.deps.repo = { ...h2.deps.repo, jobCards: async () => { throw new Error('db down'); } };
    expect(await createJobAlertsTask(() => h2.deps)(ctx(w2))).toMatchObject({ instantSent: 0, errors: 1 });
    expect(w2.profiles[0]!.alertLastInstantAt).toBeNull();
    // next run: the same jobs alert
    const h3 = harness(w2);
    expect(await createJobAlertsTask(() => h3.deps)(ctx(w2))).toMatchObject({ instantSent: 1 });
    expect(w2.deliveries[0]!.jobIds).toEqual(['j1', 'j2', 'j3']);
  });

  it('a failure after the delivery row keeps the claim (those jobs are recorded and excluded later)', async () => {
    const w = makeWorld();
    const h = harness(w);
    h.deps.deliver = async () => {
      throw new Error('transport down');
    };
    expect(await createJobAlertsTask(() => h.deps)(ctx(w))).toMatchObject({ errors: 1 });
    expect(w.deliveries).toHaveLength(1);
    expect(w.profiles[0]!.alertLastInstantAt).toEqual(w.clock.now);
  });

  it('a digest that records nothing gives its claim back too', async () => {
    const w = makeWorld();
    w.profiles[0] = { ...w.profiles[0]!, alertInstantMax: 0, alertDigest: 'daily' };
    const h = harness(w);
    h.deps.repo = { ...h.deps.repo, jobCards: async () => [] };
    await createJobAlertsTask(() => h.deps)(ctx(w));
    expect(w.profiles[0]!.alertLastDigestAt).toBeNull();
  });
});

describe('job-alerts: digests', () => {
  it('daily digest from 08:00 local: top fits plus the real number of others', async () => {
    const w = makeWorld();
    w.profiles[0] = { ...w.profiles[0]!, alertInstantMax: 0, alertDigest: 'daily' };
    const h = harness(w);
    const r = await createJobAlertsTask(() => h.deps)(ctx(w));
    expect(r).toMatchObject({ digestSent: 1 });
    expect(w.deliveries[0]).toMatchObject({ kind: 'digest_daily', jobIds: ['j1', 'j2', 'j3'] });
    expect(h.emails[0]!.params).toMatchObject({ cadence: 'daily', moreCount: 0, noReplyCount: null });
    // second tick the same day: nothing
    w.clock.now = new Date(w.clock.now.getTime() + 15 * 60_000);
    await createJobAlertsTask(() => h.deps)(ctx(w));
    expect(w.deliveries).toHaveLength(1);
  });

  it('weekly digest on Monday adds the tracker "no reply for 10 days" count', async () => {
    const w = makeWorld();
    w.noReply = 2;
    w.profiles[0] = { ...w.profiles[0]!, alertInstantMax: 0, alertDigest: 'weekly' };
    const h = harness(w);
    await createJobAlertsTask(() => h.deps)(ctx(w));
    expect(w.deliveries[0]!.kind).toBe('digest_weekly');
    expect(h.emails[0]!.params).toMatchObject({ cadence: 'weekly', noReplyCount: 2 });
  });

  it('a cut-off candidate scan never claims a total: the subject and in-app title carry no number', async () => {
    const w = makeWorld();
    w.profiles[0] = { ...w.profiles[0]!, alertInstantMax: 0, alertDigest: 'daily' };
    const h = harness(w);
    const repo = h.deps.repo;
    h.deps.repo = { ...repo, candidateJobIds: async (input) => ({ ...(await repo.candidateJobIds(input)), truncated: true }) };
    await createJobAlertsTask(() => h.deps)(ctx(w));
    expect(h.emails[0]!.params).toMatchObject({ cadence: 'daily', moreCount: null });
    expect(h.inApp[0]!.title).toBe('New jobs fit your search since yesterday');
  });

  it('not before 08:00 local', async () => {
    const w = makeWorld();
    w.clock.now = new Date('2026-10-12T12:30:00Z'); // 07:30 Chicago
    w.profiles[0] = { ...w.profiles[0]!, alertInstantMax: 0, alertDigest: 'daily' };
    const h = harness(w);
    await createJobAlertsTask(() => h.deps)(ctx(w));
    expect(w.deliveries).toHaveLength(0);
  });
});

describe('registerDeliveryChannel (WP-61 web push, WP-73 WeChat)', () => {
  it('mirrors each alert to every configured channel of the brand, after the in-app row', async () => {
    const got: DeliveryMessage[] = [];
    const push: DeliveryChannel = { id: 'web_push', brands: ['roboapply'], isConfigured: () => true, deliver: async (m) => (got.push(m), { delivered: true }) };
    const wechat: DeliveryChannel = { id: 'wechat_mp', brands: ['goapply'], isConfigured: () => true, deliver: vi.fn(async () => ({ delivered: true })) };
    const broken: DeliveryChannel = { id: 'fake_broken', brands: ['roboapply'], isConfigured: () => true, deliver: async () => { throw new Error('boom'); } };
    const unconfigured: DeliveryChannel = { id: 'fake_off', brands: ['roboapply'], isConfigured: () => false, deliver: vi.fn(async () => ({ delivered: true })) };
    registerDeliveryChannel('web_push', push);
    registerDeliveryChannel('wechat_mp', wechat);
    registerDeliveryChannel('fake_broken', broken);
    registerDeliveryChannel('fake_off', unconfigured);
    const w = makeWorld();
    const h = harness(w);
    await createJobAlertsTask(() => h.deps)(ctx(w));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ userId: 'u1', brand: 'roboapply', kind: 'instant', category: 'alert', templateKey: NOTIFY_TEMPLATES.jobAlertInstant, notificationId: 'n1' });
    expect(wechat.deliver).not.toHaveBeenCalled();
    expect(unconfigured.deliver).not.toHaveBeenCalled();
    // a failing channel does not stop the email
    expect(h.emails).toHaveLength(1);
  });

  it('a channel the person turned off is skipped', async () => {
    const push: DeliveryChannel = { id: 'web_push', brands: ['roboapply'], isConfigured: () => true, deliver: vi.fn(async () => ({ delivered: true })) };
    registerDeliveryChannel('web_push', push);
    const w = makeWorld();
    const h = harness(w, { prefs: { prefs: { channels: { alert: ['in_app', 'email'] } } } });
    await createJobAlertsTask(() => h.deps)(ctx(w));
    expect(push.deliver).not.toHaveBeenCalled();
    expect(h.emails).toHaveLength(1);
  });
});
