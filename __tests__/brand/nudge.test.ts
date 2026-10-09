// @vitest-environment node
//
// WP-12 / TW-01: when the wrong-market nudge offers the other brand
// (ARCHITECTURE.md §1.3, CN_TW_LAUNCH_PLAN.md §2.4). Acceptance: it shows for
// country CN on RoboApply and for zh-TW / TW / HK on GoApply.

import { describe, expect, it } from 'vitest';

import {
  CLAMPED_FROM_COOKIE,
  CLAMPED_FROM_QUERY,
  decideWrongBrandNudge,
  hasTraditionalSignal,
  normalizeCountry,
  nudgeDismissKey,
  nudgeStorageKey,
} from '../../components/features/brand/nudge';
import { clientBrandFor } from '../../lib/brand/client';
import { UI_KEY_RE } from '../../server/src/features/uistate/contract';

const robo = clientBrandFor('roboapply');
const go = clientBrandFor('goapply');

describe('decideWrongBrandNudge — RoboApply', () => {
  it('offers GoApply (in Chinese, at its root) to a visitor in mainland China', () => {
    expect(decideWrongBrandNudge({ brand: robo, country: 'CN', locale: 'en' })).toEqual({
      reason: 'country_cn',
      target: { id: 'goapply', name: 'GoApply' },
      targetLocale: 'zh',
      href: 'https://www.goapply.top/',
    });
  });

  it('accepts a lowercase country header', () => {
    expect(decideWrongBrandNudge({ brand: robo, country: 'cn', locale: 'zh' })?.reason).toBe('country_cn');
  });

  it('stays quiet for a 繁體中文 reader in mainland China (GoApply has no zh-TW; L-9)', () => {
    expect(decideWrongBrandNudge({ brand: robo, country: 'CN', locale: 'zh-TW' })).toBeNull();
    expect(decideWrongBrandNudge({ brand: robo, country: 'CN', locale: 'en', preferredLocales: [null, 'zh-TW'] })).toBeNull();
    expect(decideWrongBrandNudge({ brand: robo, country: 'CN', locale: 'zh', preferredLocales: ['zh-TW'] })).toBeNull();
    // A Simplified or English reader in the mainland is still offered GoApply.
    expect(decideWrongBrandNudge({ brand: robo, country: 'CN', locale: 'zh', preferredLocales: ['zh', 'en'] })?.reason).toBe('country_cn');
  });

  it.each(['TW', 'HK', 'MO', 'US', 'SG', null, 'XX', ''])('stays quiet for country %s', (country) => {
    expect(decideWrongBrandNudge({ brand: robo, country, locale: 'zh' })).toBeNull();
  });

  it('a zh / zh-TW locale alone never sends a RoboApply visitor away (Taiwan is served here)', () => {
    expect(decideWrongBrandNudge({ brand: robo, country: 'TW', locale: 'zh-TW', preferredLocales: ['zh-TW'] })).toBeNull();
    expect(decideWrongBrandNudge({ brand: robo, country: null, locale: 'zh', preferredLocales: ['zh'] })).toBeNull();
  });
});

describe('decideWrongBrandNudge — GoApply', () => {
  it.each(['TW', 'HK', 'MO'])('offers RoboApply in Traditional Chinese to a visitor in %s', (country) => {
    expect(decideWrongBrandNudge({ brand: go, country, locale: 'zh' })).toEqual({
      reason: 'region_traditional',
      target: { id: 'roboapply', name: 'RoboApply' },
      targetLocale: 'zh-TW',
      href: 'https://www.roboapply.io/zh-TW',
    });
  });

  it('offers RoboApply in Traditional Chinese on a zh-TW locale signal, even from mainland China', () => {
    const fromCookie = decideWrongBrandNudge({ brand: go, country: 'CN', locale: 'zh', preferredLocales: ['zh-TW', null] });
    expect(fromCookie?.reason).toBe('locale_zh_tw');
    expect(fromCookie?.href).toBe('https://www.roboapply.io/zh-TW');
    const fromPage = decideWrongBrandNudge({ brand: go, country: null, locale: 'zh-TW' });
    expect(fromPage?.reason).toBe('locale_zh_tw');
  });

  it('offers RoboApply to a visitor elsewhere, in the language they read here', () => {
    expect(decideWrongBrandNudge({ brand: go, country: 'US', locale: 'en' })).toEqual({
      reason: 'country_outside_cn',
      target: { id: 'roboapply', name: 'RoboApply' },
      targetLocale: 'en',
      href: 'https://www.roboapply.io/',
    });
    expect(decideWrongBrandNudge({ brand: go, country: 'SG', locale: 'zh' })?.href).toBe('https://www.roboapply.io/zh');
  });

  it('stays quiet for a mainland visitor and for an unknown country without a zh-TW signal', () => {
    expect(decideWrongBrandNudge({ brand: go, country: 'CN', locale: 'zh', preferredLocales: ['zh', 'en'] })).toBeNull();
    expect(decideWrongBrandNudge({ brand: go, country: null, locale: 'en' })).toBeNull();
    expect(decideWrongBrandNudge({ brand: go, country: 'XX', locale: 'zh' })).toBeNull();
  });
});

describe('nudge helpers', () => {
  it('normalizes countries and drops unknown codes', () => {
    expect(normalizeCountry(' tw ')).toBe('TW');
    expect(normalizeCountry('XX')).toBeNull();
    expect(normalizeCountry('T1')).toBeNull();
    expect(normalizeCountry('USA')).toBeNull();
    expect(normalizeCountry(undefined)).toBeNull();
  });

  it('dismissal keys are per brand and valid ui-state keys', () => {
    for (const id of ['roboapply', 'goapply'] as const) {
      expect(nudgeDismissKey(id)).toMatch(UI_KEY_RE);
      expect(nudgeDismissKey(id)).toContain(id);
      expect(nudgeStorageKey(id)).toContain(id);
    }
    expect(nudgeDismissKey('roboapply')).not.toBe(nudgeDismissKey('goapply'));
  });

  it('every link targets the other brand’s canonical origin (never a same-site redirect)', () => {
    const cases = [
      decideWrongBrandNudge({ brand: robo, country: 'CN', locale: 'en' }),
      decideWrongBrandNudge({ brand: go, country: 'HK', locale: 'zh' }),
      decideWrongBrandNudge({ brand: go, country: 'DE', locale: 'en' }),
    ];
    expect(cases[0]!.href.startsWith(go.canonicalOrigin)).toBe(true);
    expect(cases[1]!.href.startsWith(robo.canonicalOrigin)).toBe(true);
    expect(cases[2]!.href.startsWith(robo.canonicalOrigin)).toBe(true);
  });
});

describe('the /zh-TW → /zh clamp marker (ARCHITECTURE.md §1.5 step 3)', () => {
  it('names the cookie and query the proxy sets', () => {
    expect(CLAMPED_FROM_COOKIE).toBe('ra_clamped_from');
    expect(CLAMPED_FROM_QUERY).toBe('from_locale');
  });

  it('counts as a zh-TW signal on GoApply', () => {
    expect(hasTraditionalSignal([null, ' ZH-TW ', undefined])).toBe(true);
    expect(hasTraditionalSignal(['zh', 'en', null])).toBe(false);
    const clamped = decideWrongBrandNudge({ brand: go, country: 'CN', locale: 'zh', preferredLocales: [null, 'zh-TW', 'zh'] });
    expect(clamped?.reason).toBe('locale_zh_tw');
    expect(clamped?.href).toBe('https://www.roboapply.io/zh-TW');
  });
});
