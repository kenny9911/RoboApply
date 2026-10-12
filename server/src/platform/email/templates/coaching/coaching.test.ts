// @vitest-environment node
// WP-72 — coaching.booking_request renders for both brands in all 9 locales,
// is transactional (no unsubscribe list), escapes what the user typed, says
// the user pays the coach directly, and never names a brand literally.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../../lib/prisma.js', () => ({ default: {} }));

import { getBrand, type BrandId } from '../../../brand/registry.js';
import { EMAIL_LOCALES, createEmailTranslator } from '../../index.js';
import { getEmailTemplate } from '../registry.js';
import { COACHING_BOOKING_REQUEST_TEMPLATE, COACHING_TEMPLATE_KEYS, type CoachingRequestEmailParams } from './index.js';

const params: CoachingRequestEmailParams = {
  coachName: 'Dana Lee',
  requesterName: 'Sam <script>',
  replyEmail: 'sam@example.test',
  topic: 'Mock interview for a PM role',
  message: 'Two interviews next week.\n<b>hi</b>',
  durationMin: 30,
  preferredTimes: 'Weekday evenings',
  audience: 'coach',
};

describe('coaching email templates', () => {
  it('registers every key as transactional with no list', () => {
    for (const key of COACHING_TEMPLATE_KEYS) {
      const t = getEmailTemplate(key);
      expect(t, key).toBeDefined();
      expect(t!.category).toBe('transactional');
      expect(t!.list).toBeUndefined();
    }
  });

  it.each(['coach', 'admin'] as const)('renders the %s copy for both brands in every locale', (audience) => {
    const template = getEmailTemplate(COACHING_BOOKING_REQUEST_TEMPLATE)!;
    for (const brandId of ['roboapply', 'goapply'] as BrandId[]) {
      const brand = getBrand(brandId);
      for (const locale of EMAIL_LOCALES) {
        const t = createEmailTranslator(brand, locale);
        const body = template.render({
          brand,
          t,
          params: { ...params, audience, coachId: 'c1', requesterUserId: 'u1' },
          origin: brand.canonicalOrigin,
        });
        expect(body.subject.length).toBeGreaterThan(0);
        expect(body.bodyText).toContain(params.topic);
        expect(body.bodyHtml).not.toContain('<script>');
        expect(body.bodyHtml).not.toContain('<b>hi</b>');
        expect(body.bodyHtml).toContain('&lt;b&gt;hi&lt;/b&gt;');
        expect(`${body.subject}${body.bodyText}${body.reasonText}`).not.toContain('%BRAND%');
        expect(body.bodyText).toContain(brand.name);
        if (audience === 'admin') expect(body.bodyText).toContain('u1');
        else expect(body.bodyText).not.toContain('u1');
      }
    }
  });

  it('says the user pays the coach directly and how to answer', () => {
    const brand = getBrand('roboapply');
    const t = createEmailTranslator(brand, 'en');
    const body = getEmailTemplate(COACHING_BOOKING_REQUEST_TEMPLATE)!.render({ brand, t, params, origin: brand.canonicalOrigin });
    expect(body.bodyText).toMatch(/pays the coach directly/);
    expect(body.bodyText).toContain('sam@example.test');
    expect(body.subject).toBe('Coaching request from Sam <script>: Mock interview for a PM role');
  });

  it('marks a reply address that is not the account\'s verified email', () => {
    const brand = getBrand('roboapply');
    const t = createEmailTranslator(brand, 'en');
    const render = (replyEmailVerified?: boolean) =>
      getEmailTemplate(COACHING_BOOKING_REQUEST_TEMPLATE)!.render({ brand, t, params: { ...params, replyEmailVerified }, origin: brand.canonicalOrigin });
    for (const unverified of [render(), render(false)]) {
      expect(unverified.bodyText).toMatch(/Reply address: Typed by the user .* has not checked that it is theirs\./);
    }
    expect(render(true).bodyText).not.toContain('Reply address:');
  });

  it('missing optional fields read "Not given", never invented', () => {
    const brand = getBrand('roboapply');
    const t = createEmailTranslator(brand, 'en');
    const body = getEmailTemplate(COACHING_BOOKING_REQUEST_TEMPLATE)!.render({
      brand,
      t,
      params: { ...params, requesterName: null, durationMin: null, preferredTimes: null, message: null },
      origin: brand.canonicalOrigin,
    });
    expect(body.bodyText).toContain('Session length: Not given');
    expect(body.bodyText).toContain('Times that suit them: Not given');
    expect(body.subject).toContain('sam@example.test');
  });
});
