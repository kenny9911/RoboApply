// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../../../test/fakePrisma.js';
import { getBrand, type BrandId } from '../../../brand/registry.js';
import {
  EMAIL_LOCALES,
  createEmailTranslator,
  registerEmailTransport,
  resetEmailTransportsForTests,
  sendEmail,
  setEmailPreferenceGate,
  type EmailDb,
  type EmailMessage,
} from '../../index.js';
import { getEmailTemplate } from '../registry.js';
import {
  NOTIFY_TEMPLATE_KEYS,
  NOTIFY_TEMPLATES,
  formatPay,
  type AlertJobCard,
  type NotifyTemplateKey,
} from './index.js';

const job = (i: number, extra: Partial<AlertJobCard> = {}): AlertJobCard => ({
  id: `job${i}`,
  title: `Backend Engineer ${i}`,
  company: `Acme ${i}`,
  place: 'Berlin',
  remote: false,
  pay: { min: 70000, max: 90000, currency: 'EUR', period: 'year', text: null },
  tier: 'good',
  gap: 'Kubernetes',
  href: `/jobs/job${i}?from=alert&imp=d1`,
  ...extra,
});

export const NOTIFY_SAMPLES: Record<NotifyTemplateKey, Record<string, unknown>> = {
  [NOTIFY_TEMPLATES.jobAlertInstant]: { search: 'Backend in Berlin', jobs: [job(1), job(2, { pay: null, remote: true })] },
  [NOTIFY_TEMPLATES.jobAlertDigest]: { search: 'Backend in Berlin', cadence: 'weekly', jobs: [job(1), job(2)], moreCount: 4, noReplyCount: 2 },
  [NOTIFY_TEMPLATES.welcome]: { firstRoute: '/jobs' },
  [NOTIFY_TEMPLATES.finishSetup]: { resumeRoute: '/onboarding/basics' },
  [NOTIFY_TEMPLATES.resumeCheckReady]: { resumeId: 'r1', issueCount: 3 },
  [NOTIFY_TEMPLATES.tipsFirstTailor]: { job: { id: 'job1', title: 'Backend Engineer', company: 'Acme' } },
  [NOTIFY_TEMPLATES.tipsPractice]: {},
  [NOTIFY_TEMPLATES.tipsReEngagement]: { search: 'Backend', count: 12, since: '2026-09-20T10:00:00.000Z', timeZone: 'Europe/Berlin' },
  [NOTIFY_TEMPLATES.followUpReminder]: { entryId: 'e1', title: 'Backend Engineer', company: 'Acme', appliedAt: '2026-09-30T10:00:00.000Z', days: 10 },
  [NOTIFY_TEMPLATES.interviewReminder]: { entryId: 'e1', jobId: 'job1', title: 'Backend Engineer', company: 'Acme', interviewAt: '2026-10-11T14:00:00.000Z', timeZone: 'Asia/Taipei' },
  [NOTIFY_TEMPLATES.readyListReady]: { count: 8 },
  [NOTIFY_TEMPLATES.kitNotOpened]: { jobId: 'job1', title: 'Backend Engineer', company: 'Acme' },
  [NOTIFY_TEMPLATES.campusDeadline]: { eventId: 'ev1', company: '某科技公司', program: '2027 校园招聘', closesAt: '2026-10-20T15:59:00.000Z', officialUrl: 'https://careers.example.cn/campus' },
  [NOTIFY_TEMPLATES.campusFollowed]: { eventId: 'ev1', company: '某科技公司', companySlug: '某科技公司', program: '2027 校园招聘', graduationClass: '2027届' },
};

/**
 * GoApply with a verified sender of its own. Optional (D5): with neither value
 * GoApply mail goes out through the shared Resend account (covered below and
 * in EmailService.test.ts).
 */
const CN_EMAIL_ENV = { CN_EMAIL_TRANSPORT: 'resend', CN_EMAIL_FROM: 'GoApply <noreply@goapply.top>' };

// Emoji and pictographs (PRODUCT §7.1: no emoji subjects).
const EMOJI = /\p{Extended_Pictographic}/u;

describe('notify email templates', () => {
  it('registers every notify template as non-transactional with an unsubscribe list', () => {
    for (const key of NOTIFY_TEMPLATE_KEYS) {
      const t = getEmailTemplate(key);
      expect(t, key).toBeDefined();
      expect(t!.category, key).not.toBe('transactional');
      // tips use the category default list ('tips'); the rest name theirs.
      expect(t!.category === 'tips' || !!t!.list, key).toBe(true);
    }
  });

  it.each(NOTIFY_TEMPLATE_KEYS)('%s renders for both brands in all 9 locales with every string present', (key) => {
    const template = getEmailTemplate(key)!;
    for (const brandId of ['roboapply', 'goapply'] as BrandId[]) {
      const brand = getBrand(brandId);
      for (const locale of EMAIL_LOCALES) {
        const t = createEmailTranslator(brand, locale);
        const body = template.render({ brand, t, params: NOTIFY_SAMPLES[key], origin: brand.canonicalOrigin });
        expect(body.subject.length, `${key} ${brandId} ${locale}`).toBeGreaterThan(0);
        const all = `${body.subject}\n${body.bodyText}\n${body.preheader ?? ''}\n${body.reasonText ?? ''}`;
        expect(all).not.toMatch(/%BRAND%|notify\.|undefined|NaN|\{[a-z]+\}/);
        expect(body.subject).not.toMatch(EMOJI);
        expect(body.bodyText).not.toMatch(brandId === 'roboapply' ? /GoApply/ : /RoboApply/);
        expect(body.bodyHtml).not.toContain('<script');
      }
    }
  });

  it('never renders an alert or digest with zero jobs, a re-engagement under 3 or an empty weekly list', () => {
    const brand = getBrand('roboapply');
    const t = createEmailTranslator(brand, 'en');
    const ctx = (params: Record<string, unknown>) => ({ brand, t, params, origin: brand.canonicalOrigin });
    expect(() => getEmailTemplate(NOTIFY_TEMPLATES.jobAlertInstant)!.render(ctx({ search: 's', jobs: [] }))).toThrow(/zero jobs/);
    expect(() => getEmailTemplate(NOTIFY_TEMPLATES.jobAlertDigest)!.render(ctx({ search: 's', cadence: 'daily', jobs: [], moreCount: 0 }))).toThrow(/zero jobs/);
    expect(() =>
      getEmailTemplate(NOTIFY_TEMPLATES.tipsReEngagement)!.render(ctx({ search: 's', count: 2, since: '2026-09-01T00:00:00Z' })),
    ).toThrow(/fewer than 3/);
    expect(() => getEmailTemplate(NOTIFY_TEMPLATES.readyListReady)!.render(ctx({ count: 0 }))).toThrow(/empty list/);
  });

  it('prints only real counts: the digest total is shown jobs + real others; with an unknown total no total is claimed', () => {
    const brand = getBrand('roboapply');
    const t = createEmailTranslator(brand, 'en');
    const tpl = getEmailTemplate(NOTIFY_TEMPLATES.jobAlertDigest)!;
    const known = tpl.render({ brand, t, origin: brand.canonicalOrigin, params: { search: 'Data', cadence: 'daily', jobs: [job(1), job(2)], moreCount: 3 } });
    expect(known.subject).toBe('5 new jobs fit your search since yesterday');
    expect(known.bodyText).toContain('3 more new jobs also fit. See them in RoboApply.');
    const unknown = tpl.render({ brand, t, origin: brand.canonicalOrigin, params: { search: 'Data', cadence: 'daily', jobs: [job(1), job(2)], moreCount: null } });
    // The candidate scan was cut off: the subject claims no number, the intro counts only the listed jobs.
    expect(unknown.subject).toBe('New jobs fit your search since yesterday');
    expect(unknown.subject).not.toMatch(/\d/);
    expect(unknown.preheader).toBe('Here are 2 new jobs that fit your saved search "Data" since yesterday. You can see every new job in RoboApply.');
    expect(unknown.bodyText).not.toContain('more new jobs');
    expect(unknown.bodyText).not.toMatch(/\b\d+ new jobs fit\b/);
    const unknownWeekly = tpl.render({ brand, t, origin: brand.canonicalOrigin, params: { search: 'Data', cadence: 'weekly', jobs: [job(1)], moreCount: null } });
    expect(unknownWeekly.subject).toBe('New jobs fit your search this week');
    expect(unknownWeekly.preheader).toContain('Here is 1 new job that fits your saved search "Data" this week.');
    const weekly = tpl.render({ brand, t, origin: brand.canonicalOrigin, params: { search: 'Data', cadence: 'weekly', jobs: [job(1)], moreCount: 0, noReplyCount: 2 } });
    expect(weekly.bodyText).toContain('2 applications have had no reply for 10 days.');
    const weeklyNone = tpl.render({ brand, t, origin: brand.canonicalOrigin, params: { search: 'Data', cadence: 'weekly', jobs: [job(1)], moreCount: 0, noReplyCount: 0 } });
    expect(weeklyNone.bodyText).not.toContain('no reply');
  });

  it('links each job with from=alert, shows the tier, the gap line and the fit note', () => {
    const brand = getBrand('roboapply');
    const t = createEmailTranslator(brand, 'en');
    const body = getEmailTemplate(NOTIFY_TEMPLATES.jobAlertInstant)!.render({ brand, t, origin: 'https://www.roboapply.io', params: NOTIFY_SAMPLES[NOTIFY_TEMPLATES.jobAlertInstant] });
    expect(body.subject).toBe('2 new jobs for "Backend in Berlin"');
    expect(body.bodyText).toContain('https://www.roboapply.io/jobs/job1?from=alert&imp=d1');
    expect(body.bodyText).toContain('Good fit');
    expect(body.bodyText).toContain('Not on your resume yet: Kubernetes');
    expect(body.bodyText).toContain('This is not your chance of getting hired.');
    expect(body.bodyText).toContain('Remote');
    expect(body.bodyText).toContain('Pay not listed');
  });

  it('formats pay from the posting only, never an estimate', () => {
    const t = createEmailTranslator(getBrand('roboapply'), 'en');
    expect(formatPay(null, t)).toBe('Pay not listed');
    expect(formatPay({ min: null, max: null, currency: 'USD', period: 'year', text: null }, t)).toBe('Pay not listed');
    expect(formatPay({ min: 120000, max: 150000, currency: 'USD', period: 'year', text: null }, t)).toBe('$120,000–$150,000 a year');
    expect(formatPay({ min: 40, max: null, currency: 'USD', period: 'hour', text: null }, t)).toBe('$40 an hour');
    expect(formatPay({ min: null, max: null, currency: null, period: null, text: '15-25K·13薪' }, t)).toBe('15-25K·13薪');
  });

  it('the welcome always lists exactly the three steps it promises, whatever the first-value route', () => {
    for (const [brandId, locale] of [['roboapply', 'en'], ['goapply', 'zh']] as const) {
      const brand = getBrand(brandId);
      const t = createEmailTranslator(brand, locale);
      for (const firstRoute of ['/jobs', '/campus', '/resume', '']) {
        const body = getEmailTemplate(NOTIFY_TEMPLATES.welcome)!.render({ brand, t, origin: brand.canonicalOrigin, params: { firstRoute } });
        const steps = body.bodyText.split('\n').filter((l) => /^\d\. /.test(l));
        expect(steps.map((l) => l.slice(0, 2))).toEqual(['1.', '2.', '3.']);
        expect(new Set(steps).size).toBe(3);
      }
    }
    // GoApply's default (recruitment-info mode off): resume first, then practice and the tracker.
    const brand = getBrand('goapply');
    const body = getEmailTemplate(NOTIFY_TEMPLATES.welcome)!.render({ brand, t: createEmailTranslator(brand, 'zh'), origin: brand.canonicalOrigin, params: { firstRoute: '/resume' } });
    expect(body.bodyText).toContain('1. ');
    expect(body.bodyText).toContain('https://www.goapply.top/resume');
    expect(body.bodyText).toContain('https://www.goapply.top/practice');
    expect(body.bodyText).toContain('https://www.goapply.top/applications');
  });

  it('the practice tip says "free" only when the credit is the free one', () => {
    const brand = getBrand('roboapply');
    const t = createEmailTranslator(brand, 'en');
    const tpl = getEmailTemplate(NOTIFY_TEMPLATES.tipsPractice)!;
    const free = tpl.render({ brand, t, origin: brand.canonicalOrigin, params: { free: true } });
    expect(free.subject).toBe('Your free practice interview is ready to use');
    for (const params of [{ free: false }, {}]) {
      const paid = tpl.render({ brand, t, origin: brand.canonicalOrigin, params });
      expect(paid.subject).not.toMatch(/free/i);
      expect(paid.bodyText).not.toMatch(/\bfree\b/i);
    }
  });

  it('the tailoring tip with no job opens /jobs, or the same-site fallback it is given (never an outside link)', () => {
    const brand = getBrand('goapply');
    const t = createEmailTranslator(brand, 'en');
    const tpl = getEmailTemplate(NOTIFY_TEMPLATES.tipsFirstTailor)!;
    const link = (params: Record<string, unknown>) => tpl.render({ brand, t, origin: brand.canonicalOrigin, params }).bodyText.split('\n').pop();
    expect(link({ job: null })).toBe('Tailor my resume: https://www.goapply.top/jobs');
    expect(link({ job: null, fallbackHref: '/resume' })).toBe('Tailor my resume: https://www.goapply.top/resume');
    for (const bad of ['https://evil.example/x', '//evil.example', 'resume', '', 42, '/a b']) {
      expect(link({ job: null, fallbackHref: bad })).toBe('Tailor my resume: https://www.goapply.top/jobs');
    }
    // A named job always links to that job.
    expect(link({ job: { id: 'job1', title: 'Analyst', company: 'Acme' }, fallbackHref: '/resume' })).toBe('Tailor my resume: https://www.goapply.top/jobs/job1?from=tips');
  });

  it('GoApply welcome starts at the campus calendar when that is the first-value route', () => {
    const brand = getBrand('goapply');
    const t = createEmailTranslator(brand, 'zh');
    const body = getEmailTemplate(NOTIFY_TEMPLATES.welcome)!.render({ brand, t, origin: brand.canonicalOrigin, params: { firstRoute: '/campus' } });
    expect(body.bodyText).toContain('https://www.goapply.top/campus');
    expect(body.bodyText).toContain('https://www.goapply.top/resume');
    expect(body.bodyText).toContain('https://www.goapply.top/practice');
  });
});

describe('every notify send carries RFC 8058 List-Unsubscribe headers', () => {
  const ENV = { RESEND_API_KEY: 're_test', JWT_SECRET: 'jwt-test-secret', NODE_ENV: 'test' };
  let sent: EmailMessage[];
  beforeEach(() => {
    sent = [];
    resetEmailTransportsForTests();
    registerEmailTransport('resend', { name: 'resend', isConfigured: () => true, send: async (m) => (sent.push(m), { ok: true, providerId: 'm1' }) });
    setEmailPreferenceGate(async () => true);
  });
  afterEach(() => resetEmailTransportsForTests());

  it.each(NOTIFY_TEMPLATE_KEYS)('%s', async (key) => {
    const db = createFakePrisma();
    // A market-only template is sent on a brand of its market (GoApply for the campus follow notice).
    const cnOnly = getEmailTemplate(key)!.markets?.includes('cn') === true && !getEmailTemplate(key)!.markets?.includes('intl');
    const r = await sendEmail(
      { template: key, to: 'person@example.com', userId: 'u1', locale: 'en', params: NOTIFY_SAMPLES[key], brand: cnOnly ? 'goapply' : 'roboapply' },
      { db: db as unknown as EmailDb, env: cnOnly ? { ...ENV, ...CN_EMAIL_ENV } : ENV },
    );
    expect(r.status).toBe('sent');
    const msg = sent[0]!;
    expect(msg.headers?.['List-Unsubscribe']).toMatch(
      cnOnly ? /^<https:\/\/www\.goapply\.top\/api\/v1\/public\/email\/unsubscribe\?token=/ : /^<https:\/\/www\.roboapply\.io\/api\/v1\/public\/email\/unsubscribe\?token=/,
    );
    expect(msg.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(msg.text).toContain('/unsubscribe/');
    expect(msg.subject).not.toMatch(EMOJI);
  });
});

describe('notify.campus_followed (GoApply follow-a-company notice)', () => {
  const ENV = { RESEND_API_KEY: 're_test', JWT_SECRET: 'jwt-test-secret', NODE_ENV: 'test', ...CN_EMAIL_ENV };
  const PARAMS = NOTIFY_SAMPLES[NOTIFY_TEMPLATES.campusFollowed];
  let sent: EmailMessage[];
  let db: ReturnType<typeof createFakePrisma>;
  const send = (over: { brand?: BrandId; env?: Record<string, string>; params?: Record<string, unknown>; locale?: string } = {}) =>
    sendEmail(
      { template: NOTIFY_TEMPLATES.campusFollowed, to: 'student@example.cn', userId: 'u1', locale: over.locale ?? 'en', params: over.params ?? PARAMS, brand: over.brand ?? 'goapply' },
      { db: db as unknown as EmailDb, env: over.env ?? ENV },
    );
  beforeEach(() => {
    sent = [];
    db = createFakePrisma();
    resetEmailTransportsForTests();
    registerEmailTransport('resend', { name: 'resend', isConfigured: () => true, send: async (m) => (sent.push(m), { ok: true, providerId: 'm1' }) });
  });
  afterEach(() => resetEmailTransportsForTests());

  it('is on the `reminders` list (like the 网申截止 email and its own inbox row), for GoApply only', () => {
    const tpl = getEmailTemplate(NOTIFY_TEMPLATES.campusFollowed)!;
    expect(tpl).toMatchObject({ category: 'alert', list: 'reminders', markets: ['cn'] });
    expect(getEmailTemplate(NOTIFY_TEMPLATES.campusDeadline)!.list).toBe('reminders');
  });

  it('gate closed: nothing is sent (preference gate off, or no gate installed)', async () => {
    const gate = vi.fn(async () => false);
    setEmailPreferenceGate(gate);
    expect(await send()).toEqual({ status: 'suppressed', reason: 'preference_off', logId: null });
    // The gate is asked about the reminders list for this person.
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', list: 'reminders', category: 'alert', template: NOTIFY_TEMPLATES.campusFollowed }));
    setEmailPreferenceGate(null);
    expect(await send()).toEqual({ status: 'suppressed', reason: 'no_preference_gate', logId: null });
    expect(sent).toHaveLength(0);
  });

  it('gate open: sent from GoApply with the company, the programme, the campus link and one-click unsubscribe', async () => {
    setEmailPreferenceGate(async () => true);
    const r = await send();
    expect(r).toMatchObject({ status: 'sent', provider: 'resend' });
    const msg = sent[0]!;
    expect(msg.from).toBe('GoApply <noreply@goapply.top>');
    expect(msg.subject).toBe('某科技公司 posted its class of 2027 campus programme');
    expect(msg.text).toContain('2027 校园招聘 at 某科技公司 is now on the campus calendar');
    expect(msg.text).toContain(`https://www.goapply.top/campus/${encodeURIComponent('某科技公司')}`);
    expect(msg.text).toContain('you follow 某科技公司 on the GoApply campus calendar');
    expect(msg.headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/www\.goapply\.top\/api\/v1\/public\/email\/unsubscribe\?token=/);
    expect(msg.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(msg.subject).not.toMatch(EMOJI);
  });

  it('gate open and only the shared Resend key (no CN_EMAIL_TRANSPORT): the notice goes out through the shared transport as GoApply', async () => {
    setEmailPreferenceGate(async () => true);
    const shared = { RESEND_API_KEY: 're_test', JWT_SECRET: 'jwt-test-secret', ROBOAPPLY_EMAIL_FROM: 'RoboApply <hello@mail.roboapply.io>' };
    expect(await send({ env: shared })).toMatchObject({ status: 'sent', provider: 'resend' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.from).toBe('GoApply <hello@mail.roboapply.io>');
    expect(sent[0]!.html).not.toMatch(/RoboApply|roboapply\.io/);
    expect(sent[0]!.headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/www\.goapply\.top\//);
  });

  it('gate open but the brand cannot send email (the other gate): nothing is sent', async () => {
    setEmailPreferenceGate(async () => true);
    // CN_EMAIL_TRANSPORT=none is the operator's off switch; so is a deployment with no email key at all.
    expect(await send({ env: { RESEND_API_KEY: 're_test', JWT_SECRET: 'jwt-test-secret', CN_EMAIL_TRANSPORT: 'none' } })).toEqual({ status: 'suppressed', reason: 'transport_not_configured', logId: null });
    expect(await send({ env: { JWT_SECRET: 'jwt-test-secret' } })).toEqual({ status: 'suppressed', reason: 'transport_not_configured', logId: null });
    expect(sent).toHaveLength(0);
  });

  it('never goes out on RoboApply, even with every gate open', async () => {
    const gate = vi.fn(async () => true);
    setEmailPreferenceGate(gate);
    expect(await send({ brand: 'roboapply' })).toEqual({ status: 'suppressed', reason: 'not_for_market', logId: null });
    expect(gate).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('names no year when the followed class carries none', async () => {
    setEmailPreferenceGate(async () => true);
    await send({ params: { ...PARAMS, graduationClass: '应届' } });
    expect(sent[0]!.subject).toBe('某科技公司 posted a new campus programme');
  });
});
