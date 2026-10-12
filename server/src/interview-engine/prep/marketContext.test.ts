// @vitest-environment node
//
// Which job market a practice is for (prep/marketContext.ts): GoApply is
// always mainland China; on RoboApply the job's own country wins, then the
// candidate's search/profile country (faked here), the interface language,
// and the brand's default country. A posting's location text is read the way
// the job normalizers read it, so "Denver, CO" is Colorado, not Colombia.
// Run: npx vitest run server/src/interview-engine/prep/marketContext.test.ts

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { getBrand } from '../../platform/brand/registry.js';
import { countryFromLocation, resolvePrepMarket } from './marketContext.js';

const robo = getBrand('roboapply');
const go = getBrand('goapply');

describe('countryFromLocation', () => {
  it.each([
    ['Berlin, Germany', 'DE'],
    ['Tokyo, Japan', 'JP'],
    ['Remote - Germany', 'DE'],
    ['Remote (Germany)', 'DE'],
    ['Hybrid (Taipei City, Taiwan)', 'TW'],
    ['Austin, TX, US', 'US'],
    ['Toronto, ON, Canada', 'CA'],
    ['深圳, 中国', 'CN'],
    ['上海', 'CN'],
    ['台北市', 'TW'],
  ])('%s → %s', (location, country) => {
    expect(countryFromLocation(location)).toBe(country);
  });

  it.each([
    // US state codes that are also country codes: the posting is in the United States.
    ['Denver, CO', 'US'], // not Colombia
    ['Wilmington, DE', 'US'], // not Germany
    ['Indianapolis, IN', 'US'], // not India
    ['San Francisco, CA', 'US'], // not Canada
    ['Austin, TX', 'US'],
  ])('a US "<city>, <state>" location: %s → %s', (location, country) => {
    expect(countryFromLocation(location)).toBe(country);
  });

  it('is null when the text names no place it can place', () => {
    for (const location of ['Remote', 'Anywhere', '', '   ', null, undefined]) expect(countryFromLocation(location)).toBeNull();
  });
});

describe('resolvePrepMarket', () => {
  it('GoApply is always mainland China, with its AI-interview formats, and reads no user data', async () => {
    const userCountry = vi.fn(async () => 'JP');
    const ctx = await resolvePrepMarket({ userId: 'u1', brand: go, locale: 'en', countryHint: 'JP' }, { userCountry });
    expect(ctx).toEqual({ brand: go, formatMarket: 'cn', country: 'CN', marketKey: 'cn', marketLabel: 'Mainland China' });
    expect(userCountry).not.toHaveBeenCalled();
  });

  it('the job’s country wins over the candidate’s and is resolved from a name or a code', async () => {
    const userCountry = vi.fn(async () => 'US');
    expect(await resolvePrepMarket({ userId: 'u1', brand: robo, locale: 'en', countryHint: 'Japan' }, { userCountry })).toMatchObject({
      formatMarket: 'intl',
      country: 'JP',
      marketKey: 'jp',
      marketLabel: 'Japan',
    });
    expect(userCountry).not.toHaveBeenCalled();
    expect((await resolvePrepMarket({ userId: 'u1', brand: robo, locale: 'en', countryHint: 'gb' }, { userCountry })).marketKey).toBe('uk');
  });

  it('then the candidate’s search or profile country', async () => {
    const userCountry = vi.fn(async () => 'DE');
    const ctx = await resolvePrepMarket({ userId: 'u1', brand: robo, locale: 'ja' }, { userCountry });
    expect(userCountry).toHaveBeenCalledWith('u1');
    expect(ctx).toMatchObject({ country: 'DE', marketKey: 'de' });
  });

  it('then the interface language, then the brand’s default country', async () => {
    const none = vi.fn(async () => null);
    expect(await resolvePrepMarket({ userId: 'u1', brand: robo, locale: 'ko' }, { userCountry: none })).toMatchObject({ country: 'KR', marketKey: 'kr' });
    expect(await resolvePrepMarket({ userId: 'u1', brand: robo, locale: 'zh-TW' }, { userCountry: none })).toMatchObject({ country: 'TW', marketKey: 'tw' });
    expect(await resolvePrepMarket({ userId: 'u1', brand: robo, locale: 'en' }, { userCountry: none })).toMatchObject({ country: 'US', marketKey: 'us' });
    // A failed lookup is treated as unknown, never as an error.
    const failing = vi.fn(async () => {
      throw new Error('db down');
    });
    expect(await resolvePrepMarket({ userId: 'u1', brand: robo, locale: 'fr' }, { userCountry: failing })).toMatchObject({ country: 'FR', marketKey: 'fr' });
  });

  it('a country without its own playbook says which norms stand in for it', async () => {
    const ctx = await resolvePrepMarket({ userId: 'u1', brand: robo, locale: 'en', countryHint: 'NG' }, { userCountry: vi.fn() });
    expect(ctx).toMatchObject({ country: 'NG', marketKey: 'us', marketLabel: 'NG (United States and Canada norms)' });
  });
});
