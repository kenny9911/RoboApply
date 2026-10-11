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
  'billing.payment_action_required': { planKey: 'pro_monthly', amountMinor: 2499, currency: 'USD', hostedInvoiceUrl: 'https://invoice.stripe.test/i/acct_1/in_1' },
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
    // GoApply student plans are passes too (PAR-6): never the subscription name.
    expect(planName(cn, 'student_monthly')).toBe('Student 30-day pass');
    expect(planName(cn, 'student_quarterly')).toBe('Student 90-day pass');
    expect(planName(intl, 'student_monthly')).toBe('Student Monthly');
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

  // AL-6 mail half (MARKET_STRATEGY §5.3 G12, M-18): the old RoboApply ¥-passes
  // can no longer be bought in RMB on RoboApply, so their reminder also names
  // the other brand's pricing page. A link, never a redirect.
  describe('the legacy ¥-pass reminder links to GoApply for RMB and Alipay', () => {
    const legacyCny = { planKey: 'starter', date: '2026-10-14T00:00:00.000Z', amountMinor: 3900, currency: 'CNY', interval: 'pass', manual: true };
    const GOAPPLY_PRICING = 'https://www.goapply.top/pricing';

    it('a legacy CNY pass reminder on RoboApply contains the GoApply line and a link to its pricing page', () => {
      for (const planKey of ['starter', 'growth']) {
        const mail = renderEn('billing.renewal_reminder', { ...legacyCny, planKey });
        expect(mail.bodyText).toContain('In mainland China? You can pay in RMB with Alipay on GoApply.');
        expect(mail.bodyText).toContain(`See GoApply prices: ${GOAPPLY_PRICING}`);
        expect(mail.bodyHtml).toContain(`href="${GOAPPLY_PRICING}"`);
        expect(mail.bodyHtml).toContain('In mainland China? You can pay in RMB with Alipay on GoApply.');
        // The first button still goes to the reader's own plan page; nothing replaces it.
        expect(mail.bodyText).toContain('See plans: https://www.roboapply.io/settings/billing');
        expect(mail.bodyHtml.indexOf('https://www.roboapply.io/settings/billing')).toBeLessThan(mail.bodyHtml.indexOf(GOAPPLY_PRICING));
        // A link in a mail: no redirect of any kind.
        expect(mail.bodyHtml).not.toMatch(/http-equiv|<script|window\.location/i);
        // Still never a promise of Pro or "another pass" for a legacy plan.
        expect(mail.bodyText).not.toMatch(/Pro|another pass/);
        expect(`${mail.subject} ${mail.bodyText}`).not.toMatch(/%BRAND%|%OTHER_BRAND%|billing\.|undefined|NaN/);
      }
    });

    it('the address comes from the brand registry, and the currency is read without regard to case', () => {
      expect(getBrand(getBrand('roboapply').otherBrand).canonicalOrigin).toBe('https://www.goapply.top');
      expect(renderEn('billing.renewal_reminder', { ...legacyCny, currency: 'cny' }).bodyText).toContain(GOAPPLY_PRICING);
    });

    it('a GoApply pass reminder does not carry it (GoApply is where RMB and Alipay already are)', () => {
      const brand = getBrand('goapply');
      for (const locale of ['zh', 'en'] as const) {
        const t = createEmailTranslator(brand, locale);
        for (const params of [
          { planKey: 'pro_monthly', date: '2026-10-14T00:00:00.000Z', amountMinor: 3900, currency: 'CNY', interval: 'pass', manual: true },
          { ...legacyCny },
        ]) {
          const mail = getEmailTemplate('billing.renewal_reminder')!.render({ brand, t, params, origin: brand.canonicalOrigin });
          expect(`${mail.bodyText} ${mail.bodyHtml}`).not.toMatch(/goapply\.top\/pricing|roboapply\.io\/pricing|mainland China|RMB/);
          expect((mail.bodyHtml.match(/<a /g) ?? []).length).toBe(1);
        }
      }
    });

    it('a Stripe renewal reminder does not carry it; nor does a pass that was not paid in CNY', () => {
      const others = [
        // An auto-renewing Stripe plan.
        { planKey: 'pro_monthly', date: '2026-10-14T00:00:00.000Z', amountMinor: 2499, currency: 'USD', interval: 'month', manual: false },
        // A legacy Stripe subscription (starter, USD, renews).
        { planKey: 'starter', date: '2026-10-14T00:00:00.000Z', amountMinor: 1900, currency: 'USD', interval: 'month', manual: false },
        // The 7-day pass bought through Stripe.
        { planKey: 'pro_week_pass', date: '2026-10-14T00:00:00.000Z', amountMinor: 999, currency: 'USD', interval: 'pass', manual: true },
        // A legacy pass with no recorded currency, or in another one: nothing says it was an RMB purchase.
        { ...legacyCny, currency: null },
        { ...legacyCny, currency: 'USD' },
        // A CNY amount on a plan that is not a legacy ¥-pass.
        { planKey: 'pro_week_pass', date: '2026-10-14T00:00:00.000Z', amountMinor: 1200, currency: 'CNY', interval: 'pass', manual: true },
        // A legacy CNY plan that renews by itself is not the manual pass this line is for.
        { ...legacyCny, manual: false },
      ];
      for (const params of others) {
        const mail = renderEn('billing.renewal_reminder', params);
        expect(`${mail.bodyText} ${mail.bodyHtml}`, JSON.stringify(params)).not.toMatch(/GoApply|goapply\.top|mainland China|Alipay/);
      }
    });
  });

  // ST-3 / ST-7 (MARKET_STRATEGY §5.1 "Dunning and SCA"): the bank wants the
  // buyer to confirm a payment; the mail carries Stripe's hosted invoice page.
  describe('billing.payment_action_required', () => {
    const params = { planKey: 'pro_monthly', amountMinor: 2499, currency: 'USD', hostedInvoiceUrl: 'https://invoice.stripe.test/i/acct_1/in_1?s=ap' };

    it('renders subject, body and the hosted invoice link in English', () => {
      const mail = renderEn('billing.payment_action_required', params);
      expect(mail.subject).toBe('Confirm your RoboApply payment');
      expect(mail.bodyText).toContain('Your bank needs you to confirm this payment');
      expect(mail.bodyText).toContain('The payment of $24.99 for Pro Monthly is waiting for your confirmation.');
      expect(mail.bodyText).toContain('Nothing is charged until you confirm.');
      expect(mail.bodyText).toContain(`Confirm payment: ${params.hostedInvoiceUrl}`);
      expect(mail.bodyHtml).toContain('href="https://invoice.stripe.test/i/acct_1/in_1?s=ap"');
      // One button, and it goes to the hosted invoice page, not to our settings.
      expect((mail.bodyHtml.match(/<a /g) ?? []).length).toBe(1);
      expect(mail.bodyHtml).not.toContain('/settings/billing');
      expect(mail.reasonText).toBe('You get this email because it is about your RoboApply plan and payments.');
    });

    it('is transactional and registered with the other billing mails', () => {
      expect(getEmailTemplate('billing.payment_action_required')!.category).toBe('transactional');
      expect(BILLING_EMAIL_TEMPLATES).toContain('billing.payment_action_required');
    });

    it('falls back to English for a locale that has no translation yet, with the price in that locale\'s format', () => {
      const brand = getBrand('roboapply');
      for (const locale of ['de', 'ja', 'zh-TW', 'fr'] as const) {
        const t = createEmailTranslator(brand, locale);
        const mail = getEmailTemplate('billing.payment_action_required')!.render({ brand, t, params, origin: brand.canonicalOrigin });
        expect(mail.subject, locale).toBe('Confirm your RoboApply payment');
        expect(mail.bodyText, locale).toContain('Your bank needs you to confirm this payment');
        expect(mail.bodyText, locale).toContain(params.hostedInvoiceUrl);
        expect(`${mail.subject} ${mail.bodyText}`, locale).not.toMatch(/%BRAND%|billing\.|undefined|NaN/);
      }
    });

    it('names a legacy plan honestly and prints an unknown amount as a dash, never 0', () => {
      const mail = renderEn('billing.payment_action_required', { ...params, planKey: 'growth', amountMinor: null });
      expect(mail.bodyText).toContain('The payment of — for Practice plan (legacy) is waiting');
    });

    it('names no plan when the plan is not known, and never the free plan', () => {
      for (const planKey of [null, 'free']) {
        const mail = renderEn('billing.payment_action_required', { ...params, planKey });
        expect(mail.bodyText, String(planKey)).toContain('A payment of $24.99 is waiting for your confirmation. Open the payment page to finish it. Nothing is charged until you confirm.');
        expect(`${mail.subject} ${mail.bodyText} ${mail.bodyHtml}`, String(planKey)).not.toMatch(/Free|for Pro|\{plan\}|billing\.|undefined/);
        expect(mail.bodyText).toContain(`Confirm payment: ${params.hostedInvoiceUrl}`);
      }
    });

    it('a link that is not http(s) is never put in the button', () => {
      const mail = renderEn('billing.payment_action_required', { ...params, hostedInvoiceUrl: 'javascript:alert(1)' });
      expect(mail.bodyHtml).not.toContain('javascript:');
    });
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
