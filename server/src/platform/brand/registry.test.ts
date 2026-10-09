// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  ALL_LOCALES,
  BRANDS,
  BRAND_IDS,
  brandIdFromHost,
  clampLocaleToBrand,
  getBrand,
  isDevOrPreviewHost,
  normalizeHost,
  parseBrandId,
} from './registry.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('brand registry', () => {
  it.each([
    ['roboapply.io', 'roboapply'],
    ['www.roboapply.io', 'roboapply'],
    ['api.roboapply.io', 'roboapply'],
    ['WWW.RoboApply.IO:443', 'roboapply'],
    ['staging.roboapply.io', 'roboapply'],
    ['goapply.top', 'goapply'],
    ['www.goapply.top', 'goapply'],
    ['m.goapply.top', 'goapply'],
    ['localhost:3611', 'roboapply'],
    ['localhost:3621', 'roboapply'],
    ['127.0.0.1:3621', 'roboapply'],
    ['goapply.localhost:3621', 'goapply'],
    ['goapply.localhost', 'goapply'],
    ['example.com', null],
    ['notroboapply.io', null],
    ['roboapply.io.evil.com', null],
    ['', null],
    [undefined, null],
  ])('brandIdFromHost(%s) → %s', (host, expected) => {
    expect(brandIdFromHost(host as string | undefined)).toBe(expected);
  });

  it('normalizes hosts (port, case, comma lists, IPv6, trailing dot)', () => {
    expect(normalizeHost('WWW.GoApply.Top:8443')).toBe('www.goapply.top');
    expect(normalizeHost('a.example.com, b.example.com')).toBe('a.example.com');
    expect(normalizeHost('[::1]:3611')).toBe('[::1]');
    expect(normalizeHost('roboapply.io.')).toBe('roboapply.io');
    expect(normalizeHost(null)).toBe('');
  });

  it.each([
    ['localhost:3611', true],
    ['goapply.localhost:3621', true],
    ['127.0.0.1', true],
    ['[::1]:3000', true],
    ['roboapply-git-feat-x.vercel.app', true],
    ['www.roboapply.io', false],
    ['goapply.top', false],
    ['vercel.app.evil.com', false],
  ])('isDevOrPreviewHost(%s) → %s', (host, expected) => {
    expect(isDevOrPreviewHost(host)).toBe(expected);
  });

  it('parses brand ids and market aliases', () => {
    expect(parseBrandId('goapply')).toBe('goapply');
    expect(parseBrandId(' CN ')).toBe('goapply');
    expect(parseBrandId('intl')).toBe('roboapply');
    expect(parseBrandId('robohire')).toBeNull();
    expect(parseBrandId(undefined)).toBeNull();
  });

  it('holds the plan invariants (ARCH §1.2, CN §2.1)', () => {
    const allHosts: string[] = [];
    for (const id of BRAND_IDS) {
      const b = BRANDS[id];
      expect(b.id).toBe(id);
      expect(b.locales).toContain(b.defaultLocale);
      for (const l of b.seoLocales) expect(b.locales).toContain(l);
      for (const l of b.locales) expect(ALL_LOCALES).toContain(l);
      for (const h of [...b.hosts, ...b.devHosts]) {
        expect(h).toBe(h.toLowerCase());
        expect(h).not.toContain(':');
        allHosts.push(h);
      }
      expect(getBrand(b.otherBrand).otherBrand).toBe(id);
      expect(b.canonicalOrigin.startsWith('https://')).toBe(true);
    }
    expect(new Set(allHosts).size).toBe(allHosts.length);

    const robo = BRANDS.roboapply;
    const go = BRANDS.goapply;
    expect(robo.market).toBe('intl');
    expect(robo.currency).toBe('USD');
    expect(robo.locales).toHaveLength(9);
    expect(robo.defaultLocale).toBe('en');
    expect(robo.paymentRails).toEqual(['stripe']);
    expect(robo.countries).toContain('TW');
    expect(robo.interview.agentName).toBe('RoboApply-Interview');

    expect(go.market).toBe('cn');
    expect(go.currency).toBe('CNY');
    expect(go.locales).toEqual(['zh', 'en']);
    expect(go.defaultLocale).toBe('zh');
    expect(go.paymentRails).not.toContain('stripe');
    expect(go.paymentRails).toEqual(['alipay', 'wechatpay']);
    expect(go.flags.eeoAnswers).toBe(false);
    expect(go.llmProfile).toBe('domestic_cn');
    expect(go.llmEnvPrefix).toBe('CN_');
    expect(go.interview.agentName).toBe('GoApply-Interview');
    expect(go.jobProviders).not.toContain('linkedin');
    expect(robo.flags.hiringContacts).toBe('deeplinks_only');
    expect(go.flags.hiringContacts).toBe('deeplinks_only');
  });

  it('carries no legal facts it does not know (D3)', () => {
    for (const id of BRAND_IDS) {
      expect(BRANDS[id].legalEntity).toBe('');
      expect(BRANDS[id].legal.icpNumber).toBeUndefined();
      expect(BRANDS[id].legal.psbNumber).toBeUndefined();
      expect(BRANDS[id].seo.sameAs).toEqual([]);
    }
  });

  it('clamps locales to the brand', () => {
    expect(clampLocaleToBrand(BRANDS.goapply, 'zh-TW')).toBe('zh');
    expect(clampLocaleToBrand(BRANDS.goapply, 'en')).toBe('en');
    expect(clampLocaleToBrand(BRANDS.roboapply, 'zh-TW')).toBe('zh-TW');
    expect(clampLocaleToBrand(BRANDS.roboapply, null)).toBe('en');
  });

  it('has zero imports and reads no env (it is mirrored to the web)', () => {
    const src = readFileSync(fileURLToPath(new URL('./registry.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/\brequire\(/);
  });
});
