// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/prisma.js', () => ({ default: {} }));

import { getBrand } from '../../../brand/registry.js';
import { createEmailTranslator } from '../../i18n.js';
import { getEmailTemplate } from '../registry.js';
import { BILLING_EMAIL_TEMPLATES, formatPrice, planName } from './index.js';

const SAMPLES: Record<string, Record<string, unknown>> = {
  'billing.renewal_reminder': { planKey: 'pro_monthly', date: '2026-10-14T00:00:00.000Z', amountMinor: 2499, currency: 'USD', interval: 'month', manual: false },
  'billing.annual_reminder': { planKey: 'pro_quarterly', startedAt: '2025-09-01T00:00:00.000Z', nextRenewal: null, amountMinor: 5999, currency: 'USD', interval: 'quarter' },
  'billing.cancel_link': { url: 'https://www.roboapply.io/cancel?token=abc', expiresMinutes: 30 },
  'billing.cancel_none': {},
  'billing.cancel_confirmed': { planKey: 'starter', cancelledAt: '2026-10-10T08:00:00.000Z', accessUntil: '2026-10-30T00:00:00.000Z' },
  'billing.payment_failed': { planKey: 'pro_weekly', amountMinor: 999, currency: 'USD' },
};


function renderEn(key: string, params: Record<string, unknown>) {
  const brand = getBrand('roboapply');
  const t = createEmailTranslator(brand, 'en');
  return getEmailTemplate(key)!.render({ brand, t, params, origin: brand.canonicalOrigin });
}

describe('billing email templates', () => {
  it.each(BILLING_EMAIL_TEMPLATES)('%s renders on both brands with every string present and the brand name filled in', (key) => {
    const template = getEmailTemplate(key)!;
    expect(template.category).toBe('transactional');
    for (const brandId of ['roboapply', 'goapply'] as const) {
      const brand = getBrand(brandId);
      const t = createEmailTranslator(brand, brand.defaultLocale);
      const body = template.render({ brand, t, params: SAMPLES[key], origin: brand.canonicalOrigin });
      expect(body.subject.length).toBeGreaterThan(0);
      expect(`${body.subject} ${body.bodyText}`).not.toMatch(/%BRAND%|billing\.|undefined|NaN/);
      expect(body.bodyText).not.toMatch(brandId === 'roboapply' ? /GoApply/ : /RoboApply/);
    }
  });

  it('names legacy plans honestly and GoApply passes as passes', () => {
    const intl = createEmailTranslator(getBrand('roboapply'), 'en');
    const cn = createEmailTranslator(getBrand('goapply'), 'en');
    expect(planName(intl, 'growth')).toBe('Practice plan (legacy)');
    expect(planName(intl, 'pro_monthly')).toBe('Pro Monthly');
    expect(planName(cn, 'pro_monthly')).toBe('Pro month pass');
    expect(planName(intl, 'mystery')).toBe('Pro');
  });

  it('renewal reminders read naturally for every interval ("every 3 months", never "a 3 months")', () => {
    const base = { planKey: 'pro_monthly', date: '2026-10-14T00:00:00.000Z', currency: 'USD', manual: false };
    expect(renderEn('billing.renewal_reminder', { ...base, amountMinor: 2499, interval: 'month' }).bodyText).toContain(
      'Pro Monthly renews automatically on October 14, 2026 for $24.99 every month.',
    );
    const quarterly = renderEn('billing.renewal_reminder', { ...base, planKey: 'pro_quarterly', amountMinor: 5999, interval: 'quarter' }).bodyText;
    expect(quarterly).toContain('Pro Quarterly renews automatically on October 14, 2026 for $59.99 every 3 months.');
    expect(quarterly).not.toContain('a 3 months');
    expect(renderEn('billing.renewal_reminder', { ...base, planKey: 'pro_weekly', amountMinor: 999, interval: 'week' }).bodyText).toContain('for $9.99 every week.');
  });

  it('a legacy pass reminder never promises Pro or "another pass"; a Pro pass reminder does', () => {
    const legacy = renderEn('billing.renewal_reminder', { planKey: 'starter', date: '2026-10-14T00:00:00.000Z', amountMinor: null, currency: 'CNY', interval: 'pass', manual: true }).bodyText;
    expect(legacy).toContain('Practice plan (legacy) ends on October 14, 2026. It does not renew and nothing will be charged.');
    expect(legacy).toContain('See the current plans');
    expect(legacy).not.toMatch(/Pro|another pass/);
    const pass = renderEn('billing.renewal_reminder', { planKey: 'pro_week_pass', date: '2026-10-14T00:00:00.000Z', amountMinor: 699, currency: 'USD', interval: 'pass', manual: true }).bodyText;
    expect(pass).toContain('Buy another pass if you want to keep Pro.');
  });

  it('prints unknown prices as "—", never 0', () => {
    const t = createEmailTranslator(getBrand('roboapply'), 'en');
    expect(formatPrice(null, 'USD', t)).toBe('—');
    expect(formatPrice(2499, 'USD', t)).toBe('$24.99');
  });

  it('the cancel confirmation states the plan, when access ends and when we received it (§312k BGB)', () => {
    const brand = getBrand('roboapply');
    const t = createEmailTranslator(brand, 'en');
    const body = getEmailTemplate('billing.cancel_confirmed')!.render({ brand, t, params: SAMPLES['billing.cancel_confirmed'], origin: brand.canonicalOrigin });
    expect(body.bodyText).toContain('We cancelled Practice plan (legacy).');
    expect(body.bodyText).toContain('Your paid features stay on until October 30, 2026.');
    expect(body.bodyText).not.toMatch(/Pro/);
    expect(body.bodyText).toContain('We received your cancellation on October 10, 2026');
  });
});
