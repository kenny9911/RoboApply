// @vitest-environment node
//
// Registry invariants (ARCHITECTURE.md §1.2) and the `%BRAND%` bundle rules
// (§1.7): bundles never carry a literal product name, the token count per key
// matches across locales, and loadMessages(locale, brandId) substitutes it.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BRANDS, BRAND_IDS, getBrand, type BrandId } from '../../lib/brand/registry.generated';
import { BRAND_TOKEN, OTHER_BRAND_TOKEN, substituteBrandString, substituteBrandTokens } from '../../lib/brand/tokens';
import { clientBrandFor, publicBrand } from '../../lib/brand/client';
import { loadMessages } from '../../lib/i18n';
import {
  LOCALES,
  READY_LOCALES,
  clampLocale,
  isLocaleIn,
  localePath,
  matchLocale,
  switcherLocales,
} from '../../lib/localeConfig';
import { pickLocale } from '../../lib/serverLocale';

const ROOT = process.cwd();
const MESSAGES_DIR = join(ROOT, 'i18n/messages');
const BUNDLES = readdirSync(MESSAGES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => join(MESSAGES_DIR, f));
const EXTRA_BUNDLES = [join(ROOT, 'components/job-search/messages.en.json')];
const LITERAL_BRAND = /RoboApply|GoApply/;

function flatten(obj: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (typeof obj === 'string') out[prefix] = obj;
  else if (Array.isArray(obj)) obj.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}
const countToken = (s: string, token: string) => s.split(token).length - 1;

describe('registry invariants', () => {
  it.each(BRAND_IDS)('%s: locales include defaultLocale and seoLocales ⊆ locales', (id) => {
    const b = BRANDS[id];
    expect(b.locales).toContain(b.defaultLocale);
    for (const l of b.seoLocales) expect(b.locales).toContain(l);
    expect(b.id).toBe(id);
    expect(BRANDS[b.otherBrand].otherBrand).toBe(id);
  });

  it('hosts are lowercase, port-free and unique across brands', () => {
    const all = BRAND_IDS.flatMap((id) => [...BRANDS[id].hosts, ...BRANDS[id].devHosts]);
    for (const h of all) {
      expect(h).toBe(h.toLowerCase());
      expect(h).not.toContain(':');
    }
    expect(new Set(all).size).toBe(all.length);
  });

  it('market facts: GoApply has no EEO answers and no Stripe; RoboApply is USD', () => {
    expect(BRANDS.goapply.flags.eeoAnswers).toBe(false);
    expect(BRANDS.goapply.paymentRails).not.toContain('stripe');
    expect(BRANDS.roboapply.currency).toBe('USD');
    expect(BRANDS.goapply.currency).toBe('CNY');
    expect(BRANDS.goapply.defaultLocale).toBe('zh');
    expect([...BRANDS.goapply.locales].sort()).toEqual(['en', 'zh']);
    expect(BRANDS.roboapply.locales).toHaveLength(9);
  });

  it('publicBrand() strips server-only and capability fields', () => {
    const c = publicBrand(getBrand('goapply')) as unknown as Record<string, unknown>;
    for (const k of ['flags', 'authMethods', 'paymentRails', 'email', 'llmProfile', 'llmEnvPrefix', 'interview', 'jobProviders', 'cookieDomain']) {
      expect(c).not.toHaveProperty(k);
    }
    expect(c).toMatchObject({ id: 'goapply', name: 'GoApply', otherBrand: { id: 'roboapply', name: 'RoboApply' } });
    expect(clientBrandFor().id).toBe('roboapply');
  });
});

describe('message bundles carry %BRAND%, never a literal product name', () => {
  it.each([...BUNDLES, ...EXTRA_BUNDLES].map((p) => [p.slice(ROOT.length + 1), p]))('%s has no literal RoboApply/GoApply', (_name, path) => {
    const flat = flatten(JSON.parse(readFileSync(path, 'utf8')));
    const offenders = Object.entries(flat).filter(([, v]) => LITERAL_BRAND.test(v)).map(([k]) => k);
    expect(offenders).toEqual([]);
  });

  it('the %BRAND% count per key is equal across locales', () => {
    const en = flatten(JSON.parse(readFileSync(join(MESSAGES_DIR, 'en.json'), 'utf8')));
    const enKeysWithToken = Object.keys(en).filter((k) => en[k]!.includes(BRAND_TOKEN));
    expect(enKeysWithToken.length).toBeGreaterThanOrEqual(18);
    for (const path of BUNDLES) {
      const flat = flatten(JSON.parse(readFileSync(path, 'utf8')));
      for (const key of Object.keys(flat)) {
        if (!(key in en)) continue;
        for (const token of [BRAND_TOKEN, OTHER_BRAND_TOKEN]) {
          expect({ path, key, n: countToken(flat[key]!, token) }).toEqual({ path, key, n: countToken(en[key]!, token) });
        }
      }
    }
  });

  it('the job-search bundle matches its en.json namespace (tokens included)', () => {
    const en = JSON.parse(readFileSync(join(MESSAGES_DIR, 'en.json'), 'utf8'));
    const js = JSON.parse(readFileSync(EXTRA_BUNDLES[0]!, 'utf8'));
    expect(js.jobSearchApi.eyebrow).toBe(en.jobSearchApi.eyebrow);
    expect(js.jobSearchApi.eyebrow).toContain(BRAND_TOKEN);
  });
});

describe('loadMessages(locale, brandId)', () => {
  const appName = (locale: (typeof LOCALES)[number], brand?: BrandId) =>
    (loadMessages(locale, brand) as { common: { app_name: string } }).common.app_name;

  it('substitutes the brand name in every locale', () => {
    for (const locale of LOCALES) {
      expect(appName(locale, 'roboapply')).toBe('RoboApply');
      expect(appName(locale, 'goapply')).toBe('GoApply');
    }
  });

  it('defaults to RoboApply for callers that predate brands', () => {
    expect(appName('en')).toBe('RoboApply');
    const meta = (loadMessages('en') as { landing: { meta: { title: string } } }).landing.meta.title;
    expect(meta).toContain('RoboApply');
    expect(meta).not.toContain('%BRAND%');
  });

  it('leaves no token behind and is memoized per brand × locale', () => {
    for (const brand of BRAND_IDS) {
      const bundle = loadMessages('zh', brand);
      expect(JSON.stringify(bundle)).not.toContain('%BRAND%');
      expect(loadMessages('zh', brand)).toBe(bundle);
    }
    expect(loadMessages('zh', 'roboapply')).not.toBe(loadMessages('zh', 'goapply'));
  });

  it('substituteBrandTokens handles %OTHER_BRAND%, arrays and nesting without mutating', () => {
    const input = { a: 'Try %OTHER_BRAND%', b: ['%BRAND% x', 3], c: { d: '%BRAND% and %BRAND%' } };
    const out = substituteBrandTokens(input, 'goapply');
    expect(out).toEqual({ a: 'Try RoboApply', b: ['GoApply x', 3], c: { d: 'GoApply and GoApply' } });
    expect(input.a).toBe('Try %OTHER_BRAND%');
    expect(substituteBrandString('100% sure', 'roboapply')).toBe('100% sure');
  });
});

describe('locale helpers clamp to the brand', () => {
  const go = BRANDS.goapply;
  const robo = BRANDS.roboapply;

  it('one switcher list, following the brand', () => {
    expect(switcherLocales(go.locales).map((l) => l.code)).toEqual(['en', 'zh']);
    expect(switcherLocales().map((l) => l.code)).toEqual([...LOCALES]);
    expect(READY_LOCALES).toEqual(switcherLocales(robo.locales));
  });

  it('clampLocale / isLocaleIn / localePath', () => {
    expect(clampLocale('zh-TW', go.locales, go.defaultLocale)).toBe('zh');
    expect(clampLocale('en', go.locales, go.defaultLocale)).toBe('en');
    expect(clampLocale(undefined, robo.locales, robo.defaultLocale)).toBe('en');
    expect(isLocaleIn('ja', go.locales)).toBe(false);
    expect(localePath('en')).toBe('/');
    expect(localePath('zh', 'zh')).toBe('/');
    expect(localePath('en', 'zh')).toBe('/en');
  });

  it('matchLocale skips tags the brand does not serve', () => {
    expect(matchLocale(['ja', 'en-US'], go.locales)).toBe('en');
    expect(matchLocale(['zh-Hant-TW', 'zh-CN'], go.locales)).toBe('zh');
    expect(matchLocale(['zh-Hant-TW'])).toBe('zh-TW');
    expect(matchLocale(['ja'], go.locales)).toBeNull();
  });

  it('pickLocale: path → cookie → Accept-Language → brand default, all clamped', () => {
    const none = { pathname: null, cookieLocale: null, acceptLanguage: null };
    expect(pickLocale(none, robo)).toBe('en');
    expect(pickLocale(none, go)).toBe('zh');
    expect(pickLocale({ ...none, pathname: '/ja/x' }, robo)).toBe('ja');
    expect(pickLocale({ ...none, pathname: '/ja/x', cookieLocale: 'en' }, go)).toBe('en');
    expect(pickLocale({ ...none, cookieLocale: 'zh-TW', acceptLanguage: 'ko,en;q=0.5' }, go)).toBe('en');
    expect(pickLocale({ ...none, cookieLocale: 'zh-TW' }, robo)).toBe('zh-TW');
    expect(pickLocale({ ...none, acceptLanguage: 'fr-CA,fr;q=0.9' }, robo)).toBe('fr');
    expect(pickLocale({ ...none, acceptLanguage: 'fr-CA,fr;q=0.9' }, go)).toBe('zh');
  });
});
