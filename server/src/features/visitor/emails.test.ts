// @vitest-environment node
//
// WP-78 alert emails: the confirm email is transactional (no unsubscribe
// link needed, nothing else in it); the digest carries the one-click
// unsubscribe headers for an address with no account, real counts, pay as
// listed or "Pay not listed", and no fit wording.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../../platform/brand/registry.js';
import { createEmailTranslator } from '../../platform/email/i18n.js';
import { registerEmailTransport, resetEmailTransportsForTests, sendEmail, setEmailPreferenceGate } from '../../platform/email/EmailService.js';
import { verifyUnsubscribeToken } from '../../platform/email/unsubscribe.js';
import type { EmailMessage } from '../../platform/email/transports/resend.js';
import { alertConfirmTemplate, alertDigestTemplate, formatDigestPay, VISITOR_EMAIL_EN, visitorText, type AlertDigestParams } from './emails.js';

const ROBO = getBrand('roboapply');
const GO = getBrand('goapply');
const ENV = { RESEND_API_KEY: 'k', EMAIL_UNSUBSCRIBE_SECRET: 's' };

const digest: AlertDigestParams = {
  search: 'Data analyst · Taipei',
  cadence: 'weekly',
  total: 12,
  signupUrl: 'https://www.roboapply.io/signup?from=alert',
  jobs: [
    { id: 'j1', title: 'Data Analyst', company: 'Acme', place: 'Taipei', remote: false, pay: null, href: 'https://www.roboapply.io/job/j1-data-analyst' },
    { id: 'j2', title: 'BI <Analyst>', company: 'Beta', place: null, remote: true, pay: { min: 100000, max: 120000, currency: 'USD', period: 'year', text: null }, href: 'https://www.roboapply.io/job/j2' },
  ],
};

afterEach(() => resetEmailTransportsForTests());

describe('visitor email templates', () => {
  it('confirm: subject, link and the "not you?" line; brand substituted, no literal brand in the source strings', () => {
    const t = createEmailTranslator(ROBO, 'en');
    const out = alertConfirmTemplate.render({ brand: ROBO, t, params: { url: 'https://www.roboapply.io/alerts/confirm/tok', search: '', cadence: 'daily', hours: 72 }, origin: 'https://www.roboapply.io' });
    expect(out.subject).toBe('Confirm your job alerts from RoboApply');
    expect(out.bodyHtml).toContain('href="https://www.roboapply.io/alerts/confirm/tok"');
    expect(out.bodyText).toContain('"any job"');
    expect(out.bodyText).toContain('once a day');
    expect(out.bodyText).toContain('72 hours');
    expect(JSON.stringify(VISITOR_EMAIL_EN)).not.toMatch(/RoboApply|GoApply/);
  });

  it('digest: real total, 10-at-most list, pay as listed, escaped titles, signup line, no fit wording', () => {
    const t = createEmailTranslator(ROBO, 'en');
    const out = alertDigestTemplate.render({ brand: ROBO, t, params: digest, origin: 'https://www.roboapply.io' });
    expect(out.subject).toBe('12 new jobs for "Data analyst · Taipei"');
    expect(out.bodyText).toContain('10 more jobs also match.');
    expect(out.bodyText).toContain('Pay not listed');
    expect(out.bodyText).toContain('$100,000–$120,000 a year');
    expect(out.bodyText).toContain('Remote');
    expect(out.bodyHtml).toContain('BI &lt;Analyst&gt;');
    expect(out.bodyText).not.toMatch(/Great fit|Good fit|Possible|Unlikely|\/ 100|%/);
    expect(out.reasonText).toContain('You do not have an account.');
  });

  it('formats pay from the posting only', () => {
    const t = createEmailTranslator(ROBO, 'en');
    expect(formatDigestPay(null, t)).toBeNull();
    expect(formatDigestPay({ min: null, max: null, currency: 'USD', period: 'year', text: null }, t)).toBeNull();
    expect(formatDigestPay({ min: 50, max: null, currency: 'USD', period: 'hour', text: null }, t)).toBe('$50 an hour');
    expect(formatDigestPay({ min: 1, max: 2, currency: 'CNY', period: 'month', text: '15-25K·13薪' }, t)).toBe('15-25K·13薪');
  });

  it('falls back to the English source until INT stages the strings; uses the bundle once present', () => {
    const t = createEmailTranslator(GO, 'zh');
    expect(visitorText(t, 'visitor.email.searchAny')).toBe('any job');
    const fake = Object.assign((key: string) => `bundle:${key}`, { locale: 'en', brand: ROBO, has: () => true }) as unknown as typeof t;
    expect(visitorText(fake, 'visitor.email.searchAny')).toBe('bundle:visitor.email.searchAny');
    expect(() => visitorText(createEmailTranslator(ROBO, 'en'), 'visitor.email.nope')).toThrow();
  });
});

describe('through EmailService', () => {
  function capture() {
    const sent: EmailMessage[] = [];
    registerEmailTransport('resend', { name: 'resend', isConfigured: () => true, send: async (m: EmailMessage) => (sent.push(m), { ok: true, providerId: 'p' }) } as never);
    return sent;
  }
  const db = { rAEmailLog: { create: vi.fn(async () => ({})) } } as never;

  it('the digest carries the one-click unsubscribe for an address with no account', async () => {
    const sent = capture();
    const gate = vi.fn(async () => true);
    setEmailPreferenceGate(gate);
    const res = await sendEmail({ template: alertDigestTemplate, to: 'a@example.com', locale: 'en', params: digest, brand: ROBO }, { env: ENV, db });
    expect(res.status).toBe('sent');
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ userId: null, list: 'alerts', category: 'alert' }));
    const headers = sent[0]!.headers as Record<string, string>;
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const token = decodeURIComponent(/token=([^>]+)>/.exec(headers['List-Unsubscribe']!)![1]!);
    const v = verifyUnsubscribeToken(token, { expectedBrand: 'roboapply', env: ENV });
    expect(v.ok && v.payload.emailHash && !v.payload.userId && v.payload.list).toBe('alerts');
  });

  it('the digest is held back when the gate says no (unconfirmed address)', async () => {
    capture();
    setEmailPreferenceGate(async () => false);
    const res = await sendEmail({ template: alertDigestTemplate, to: 'a@example.com', locale: 'en', params: digest, brand: ROBO }, { env: ENV, db });
    expect(res).toMatchObject({ status: 'suppressed', reason: 'preference_off' });
  });

  it('the confirm email is transactional: no gate, no unsubscribe header', async () => {
    const sent = capture();
    const gate = vi.fn(async () => false);
    setEmailPreferenceGate(gate);
    const res = await sendEmail(
      { template: alertConfirmTemplate, to: 'a@example.com', locale: 'en', params: { url: 'https://x/alerts/confirm/t', search: 'Nurse', cadence: 'weekly', hours: 72 }, brand: ROBO },
      { env: ENV, db },
    );
    expect(res.status).toBe('sent');
    expect(gate).not.toHaveBeenCalled();
    expect((sent[0]!.headers ?? {})['List-Unsubscribe']).toBeUndefined();
  });
});

describe('email strings in the staging bundle (Wave 5 gate)', () => {
  it('server/src/i18n/email/staging/visitor.en.json equals VISITOR_EMAIL_EN', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const staged = JSON.parse(readFileSync(join(process.cwd(), 'server/src/i18n/email/staging/visitor.en.json'), 'utf8'));
    expect(staged).toEqual(VISITOR_EMAIL_EN);
  });
});
