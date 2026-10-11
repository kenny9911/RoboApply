// @vitest-environment node
//
// Refund and withdrawal mails (ST-4, ST-9): both render with every string
// present on both brands, in English for a locale that has no translation
// yet, and say only what is true of the refund they are about.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/prisma.js', () => ({ default: {} }));

import { ALL_LOCALES, getBrand, type BrandId } from '../../../brand/registry.js';
import { createEmailTranslator } from '../../i18n.js';
import { getEmailTemplate } from '../registry.js';
import { BILLING_REFUND_EMAIL_TEMPLATES, refundIssuedEmail, withdrawalConfirmedEmail, type RefundIssuedParams, type WithdrawalConfirmedParams } from './refunds.js';

const here = dirname(fileURLToPath(import.meta.url));
const STAGED = JSON.parse(readFileSync(resolve(here, '../../../../i18n/email/staging/billingRefunds.en.json'), 'utf8')) as {
  billingRefunds: Record<string, Record<string, string>>;
};

const REFUND: RefundIssuedParams = { planKey: 'pro_monthly', amountMinor: 2499, currency: 'USD', full: true, completesEarlierRefunds: false, accessEnded: true };
const WITHDRAWAL: WithdrawalConfirmedParams = { planKey: 'pro_monthly', amountMinor: 2082, currency: 'USD', withdrawnAt: '2026-10-10T08:00:00.000Z' };
const SAMPLES: Record<string, Record<string, unknown>> = {
  'billing.refund_issued': { ...REFUND },
  'billing.withdrawal_confirmed': { ...WITHDRAWAL },
};

function render<P>(key: string, params: P, brandId: BrandId = 'roboapply', locale: string = 'en') {
  const brand = getBrand(brandId);
  const t = createEmailTranslator(brand, locale);
  return getEmailTemplate(key)!.render({ brand, t, params: params as Record<string, unknown>, origin: brand.canonicalOrigin });
}

const refund = (over: Partial<RefundIssuedParams> = {}, locale = 'en') => render('billing.refund_issued', { ...REFUND, ...over }, 'roboapply', locale);
const withdrawal = (over: Partial<WithdrawalConfirmedParams> = {}, locale = 'en') => render('billing.withdrawal_confirmed', { ...WITHDRAWAL, ...over }, 'roboapply', locale);

describe('refund and withdrawal email templates', () => {
  it('registers exactly the two templates, both transactional (no unsubscribe link)', () => {
    expect([...BILLING_REFUND_EMAIL_TEMPLATES]).toEqual(['billing.refund_issued', 'billing.withdrawal_confirmed']);
    expect(getEmailTemplate('billing.refund_issued')).toBe(refundIssuedEmail);
    expect(getEmailTemplate('billing.withdrawal_confirmed')).toBe(withdrawalConfirmedEmail);
    for (const key of BILLING_REFUND_EMAIL_TEMPLATES) {
      const template = getEmailTemplate(key)!;
      expect(template.category).toBe('transactional');
      expect(template.list).toBeUndefined();
    }
  });

  it.each(BILLING_REFUND_EMAIL_TEMPLATES)('%s renders on both brands with every string present and the brand name filled in', (key) => {
    for (const brandId of ['roboapply', 'goapply'] as const) {
      const brand = getBrand(brandId);
      const body = render(key, SAMPLES[key], brandId, brand.defaultLocale);
      expect(body.subject.length).toBeGreaterThan(0);
      expect(`${body.subject} ${body.bodyText} ${body.bodyHtml}`).not.toMatch(/%BRAND%|billing(?:Refunds)?\.|undefined|NaN|\{[a-z]+\}/i);
      expect(`${body.subject} ${body.bodyText}`).not.toMatch(brandId === 'roboapply' ? /GoApply/ : /RoboApply/);
      expect(body.bodyText).toContain(`${brand.canonicalOrigin}/settings/billing`);
      expect(body.reasonText).toBeTruthy();
    }
  });

  it.each(ALL_LOCALES)('renders in locale %s, in English until the strings are translated there', (locale) => {
    // The staged strings exist in English only until the merge and translate pass; a locale that
    // has its own strings by then renders those, and this test then only checks that it renders.
    const bundle = JSON.parse(readFileSync(resolve(here, `../../../../i18n/email/${locale}.json`), 'utf8')) as { billingRefunds?: Record<string, unknown> };
    const translated = locale !== 'en' && Boolean(bundle.billingRefunds?.refundIssued) && Boolean(bundle.billingRefunds?.withdrawalConfirmed);
    const r = refund({}, locale);
    const w = withdrawal({}, locale);
    for (const body of [r, w]) {
      expect(body.subject.length).toBeGreaterThan(0);
      expect(`${body.subject} ${body.bodyText}`).not.toMatch(/%BRAND%|billing(?:Refunds)?\.|undefined|NaN/);
    }
    if (!translated) {
      expect(r.bodyText).toContain('That is the full amount you paid.');
      expect(r.bodyText).toContain('The money goes back to the payment method you paid with.');
      expect(w.bodyText).toContain('Your withdrawal is confirmed');
      expect(w.bodyText).toContain('The subscription has ended.');
    }
  });

  it('a full refund states the amount, the payment method and that the paid time ended', () => {
    const body = refund();
    expect(body.subject).toBe('Your RoboApply refund of $24.99');
    expect(body.bodyText).toContain('We refunded $24.99 for Pro Monthly. That is the full amount you paid.');
    expect(body.bodyText).toContain('The money goes back to the payment method you paid with.');
    expect(body.bodyText).toContain('The paid time from this purchase is no longer on your account.');
    expect(body.bodyText).not.toContain('stay as they are');
    expect(body.bodyHtml).toContain('$24.99');
  });

  it('a partial refund does not claim that access ended', () => {
    const body = refund({ amountMinor: 1000, full: false, accessEnded: false });
    expect(body.bodyText).toContain('We refunded $10.00 of your payment for Pro Monthly.');
    expect(body.bodyText).toContain('Your plan and your credits stay as they are.');
    expect(body.bodyText).not.toMatch(/no longer on your account|full amount|now on Free/);
    // Even if a caller passes accessEnded with a partial refund, the mail does not say so.
    expect(refund({ amountMinor: 1000, full: false, accessEnded: true }).bodyText).not.toMatch(/no longer on your account/);
  });

  it('the refund that completes a series of partial refunds never calls its own amount the full amount paid', () => {
    // 10.00 and 8.00 went back earlier on a 24.99 charge; this mail is about the last 6.99.
    const last = refund({ amountMinor: 699, full: true, completesEarlierRefunds: true, accessEnded: true });
    expect(last.subject).toBe('Your RoboApply refund of $6.99');
    expect(last.bodyText).toContain('We refunded $6.99 for Pro Monthly. With the earlier refunds, your payment is now refunded in full.');
    expect(last.bodyText).not.toContain('That is the full amount you paid');
    expect(last.bodyHtml).not.toContain('That is the full amount you paid');
    expect(last.preheader).not.toContain('full amount you paid');
    // Access is still driven by the whole charge being refunded: the paid time is gone.
    expect(last.bodyText).toContain('The paid time from this purchase is no longer on your account.');
    expect(last.bodyText).not.toContain('stay as they are');
    // With nothing left to take, it still says nothing about access.
    expect(refund({ amountMinor: 699, full: true, completesEarlierRefunds: true, accessEnded: false }).bodyText).not.toMatch(/no longer on your account|stay as they are/);
    // The flag means nothing on a partial refund: the partial sentence stays.
    const partial = refund({ amountMinor: 699, full: false, completesEarlierRefunds: true, accessEnded: false });
    expect(partial.bodyText).toContain('We refunded $6.99 of your payment for Pro Monthly.');
    expect(partial.bodyText).not.toMatch(/refunded in full|full amount/);
  });

  it('a full refund of a pack speaks of the unused credits; with nothing left to take it says nothing about access', () => {
    const pack = refund({ planKey: 'practice_pack_5', amountMinor: 999 });
    expect(pack.bodyText).toContain('We refunded $9.99 for Practice pack (5).');
    expect(pack.bodyText).toContain('The unused practice credits from this pack are no longer on your account.');
    expect(pack.bodyText).not.toContain('paid time');
    const nothingLeft = refund({ planKey: 'pro_week_pass', amountMinor: 999, accessEnded: false });
    expect(nothingLeft.bodyText).toContain('That is the full amount you paid.');
    expect(nothingLeft.bodyText).not.toMatch(/no longer on your account|stay as they are/);
  });

  it('the withdrawal confirmation states what was withdrawn, when we received it, the refund and that the subscription ended', () => {
    const body = withdrawal();
    expect(body.subject).toBe('Your RoboApply withdrawal is confirmed');
    expect(body.bodyText).toContain('You withdrew from your contract for Pro Monthly.');
    expect(body.bodyText).toContain('We received your withdrawal on October 10, 2026');
    expect(body.bodyText).toContain('UTC');
    expect(body.bodyText).toContain('We are refunding $20.82 to the payment method you paid with.');
    expect(body.bodyText).toContain('The subscription has ended. It will not renew and you will not be charged again for it.');
  });

  it('the withdrawal confirmation fits a pass, a pack and a period that was used up', () => {
    expect(withdrawal({ planKey: 'pro_week_pass', amountMinor: 999 }).bodyText).toContain('The pass has ended.');
    expect(withdrawal({ planKey: 'pro_week_pass', amountMinor: 999 }).bodyText).not.toContain('subscription');
    expect(withdrawal({ planKey: 'practice_pack_15', amountMinor: 2499 }).bodyText).toContain('The unused practice credits from this pack are no longer on your account.');
    const nothing = withdrawal({ planKey: 'pro_weekly', amountMinor: 0 });
    expect(nothing.bodyText).toContain('No refund is due');
    expect(nothing.bodyText).not.toContain('$0.00');
    expect(nothing.bodyText).toContain('The subscription has ended.');
  });

  it('amounts are formatted from minor units in the charge currency', () => {
    expect(refund({ amountMinor: 79900, currency: 'TWD' }).bodyText).toMatch(/NT\$\s?799\.00/);
    expect(withdrawal({ amountMinor: 5, currency: 'USD' }).bodyText).toContain('$0.05');
  });

  it('the staged copy names no competitor, promises no processing time and uses no em dash', () => {
    const strings = Object.values(STAGED.billingRefunds).flatMap((group) => Object.values(group));
    // A staging file holds exactly the namespace it is named after (scripts/i18n-merge-staging.mjs).
    expect(Object.keys(STAGED)).toEqual(['billingRefunds']);
    expect(Object.keys(STAGED.billingRefunds).sort()).toEqual(['refundIssued', 'withdrawalConfirmed']);
    expect(strings.length).toBeGreaterThan(10);
    for (const s of strings) {
      expect(s, s).not.toMatch(/—|–/);
      expect(s, s).not.toMatch(/jobright|simplify|teal|linkedin|indeed|boss|RoboApply|GoApply/i);
      expect(s, s).not.toMatch(/\b\d+\s*(?:to|-)?\s*\d*\s*(?:business |working )?(?:day|days|hour|hours|week|weeks)\b/i);
      expect(s, s).not.toMatch(/within|immediately|instantly|right away/i);
    }
  });
});
