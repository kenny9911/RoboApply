// @vitest-environment node
//
// Every auth email renders in both brands with the staged English strings,
// substitutes the brand names, links to the brand origin and is
// transactional (no unsubscribe footer).

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../../../brand/registry.js';
import { createEmailTranslator } from '../../i18n.js';
import { getEmailTemplate } from '../registry.js';
import { AUTH_EMAIL_KEYS } from './index.js';

const PARAMS: Record<string, Record<string, unknown>> = {
  [AUTH_EMAIL_KEYS.passwordReset]: { path: '/reset-password/tok' },
  [AUTH_EMAIL_KEYS.emailVerify]: { path: '/verify-email/tok' },
  [AUTH_EMAIL_KEYS.oauthEmail]: { path: '/verify-email/tok' },
  [AUTH_EMAIL_KEYS.newDevice]: { browser: 'Chrome', os: 'macOS', at: '2026-10-10 12:00' },
  [AUTH_EMAIL_KEYS.otherBrand]: { otherOrigin: 'https://www.goapply.top' },
  [AUTH_EMAIL_KEYS.accountDeleted]: { days: 30 },
};

describe('auth email templates', () => {
  it.each(Object.values(AUTH_EMAIL_KEYS))('%s renders for both brands', (key) => {
    const template = getEmailTemplate(key)!;
    expect(template.category).toBe('transactional');
    for (const id of ['roboapply', 'goapply'] as const) {
      const brand = getBrand(id);
      const t = createEmailTranslator(brand, 'en');
      const out = template.render({ brand, t, params: PARAMS[key]!, origin: brand.canonicalOrigin });
      expect(out.subject.length).toBeGreaterThan(5);
      expect(out.bodyHtml + out.bodyText + out.subject).not.toContain('%BRAND%');
      expect(out.bodyText + out.subject).not.toMatch(/\{\w+\}/);
      if (typeof PARAMS[key]!.path === 'string') expect(out.bodyText).toContain(`${brand.canonicalOrigin}${PARAMS[key]!.path}`);
    }
  });

  it('the account-deleted mail says the plan will not renew only when closing the account turned the renewal off', () => {
    // It stands in for the "plan cancelled" mail, which would promise paid features to a closed account.
    const r = getBrand('roboapply');
    const render = (params: Record<string, unknown>) =>
      getEmailTemplate(AUTH_EMAIL_KEYS.accountDeleted)!.render({ brand: r, t: createEmailTranslator(r, 'en'), params, origin: r.canonicalOrigin });
    const sentence = 'Your paid plan will not renew, and you will not be charged for it again.';
    const stopped = render({ days: 30, renewalStopped: true });
    expect(stopped.bodyText).toContain(sentence);
    expect(stopped.bodyHtml).toContain(sentence);
    expect(stopped.bodyText).toContain('can no longer sign in');
    for (const params of [{ days: 30 }, { days: 30, renewalStopped: false }]) {
      const plain = render(params);
      expect(plain.bodyText).not.toContain('will not renew');
      expect(plain.bodyHtml).not.toContain('will not renew');
    }
    // Nothing in it promises access: that was the contradiction with "you can no longer sign in".
    expect(stopped.bodyText).not.toMatch(/stay on until|See your plan/);
  });

  it('the cross-brand notice names the brand that holds the account and links there', () => {
    const go = getBrand('goapply');
    const out = getEmailTemplate(AUTH_EMAIL_KEYS.otherBrand)!.render({
      brand: go,
      t: createEmailTranslator(go, 'en'),
      params: { otherOrigin: 'https://www.roboapply.io' },
      origin: go.canonicalOrigin,
    });
    expect(out.bodyText).toContain('RoboApply account');
    expect(out.bodyText).toContain('https://www.roboapply.io/login');
  });

  it('the new-device email says what signed in and how to lock the account', () => {
    const r = getBrand('roboapply');
    const out = getEmailTemplate(AUTH_EMAIL_KEYS.newDevice)!.render({
      brand: r,
      t: createEmailTranslator(r, 'en'),
      params: PARAMS[AUTH_EMAIL_KEYS.newDevice]!,
      origin: r.canonicalOrigin,
    });
    expect(out.bodyText).toContain('Chrome on macOS at 2026-10-10 12:00 (UTC)');
    expect(out.bodyText).toContain('https://www.roboapply.io/forgot-password');
  });
});
