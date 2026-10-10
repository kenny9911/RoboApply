// FND-6a — route plumbing: protected prefixes ↔ robots, next.config
// redirects, the GoApply brand stylesheet hook-up, and the sign-in method
// registry.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import robots from '../../app/robots';
import type { NextConfig } from 'next';
// @ts-expect-error — plain .mjs config without a declaration file.
import nextConfigModule from '../../next.config.mjs';

const nextConfig = nextConfigModule as NextConfig;
type Redirect = { source: string; destination: string; permanent?: boolean };
const redirectsOf = async (): Promise<Redirect[]> => (await nextConfig.redirects!()) as Redirect[];
import { PROTECTED_PREFIXES } from '../../lib/proxyPaths';
import { AUTH_METHOD_REGISTRY, authMethodsFor } from '../../components/auth/methods/registry';
import { flagsWith } from './helpers';

const ROOT = process.cwd();

/** The brand-token allowlist, read from the design gate (importing it would run the gate). */
const BRAND_TOKENS: string[] = (() => {
  const src = readFileSync(join(ROOT, 'scripts/check-design.mjs'), 'utf8');
  const block = src.match(/export const BRAND_TOKENS = \[([\s\S]*?)\];/);
  return block ? [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
})();

describe('robots ↔ PROTECTED_PREFIXES', () => {
  // WP-56 (REQ-56-1, Wave 4 gate): robots is per host (async) and AI crawlers
  // are also disallowed on /job/*, so every group contains — not equals — the list.
  it('disallows /api/ plus every protected prefix for every crawler group (AI crawlers also /job/*, WP-56)', async () => {
    const rules = (await robots()).rules;
    const list = Array.isArray(rules) ? rules : [rules];
    for (const rule of list) expect(rule.disallow).toEqual(expect.arrayContaining(['/api/', ...PROTECTED_PREFIXES]));
    for (const p of ['/onboarding', '/profile', '/assistant', '/ready', '/inbox', '/invite', '/coaching', '/referrals']) {
      expect(PROTECTED_PREFIXES).toContain(p);
    }
  });
});

describe('next.config redirects', () => {
  it('no longer sends /onboarding to /jobs', async () => {
    const redirects = await redirectsOf();
    expect(redirects.find((r) => r.source === '/onboarding' || r.source.startsWith('/onboarding/'))).toBeUndefined();
  });

  it('moves the bare /job-search to /jobs/explore and leaves /job-search/developers alone', async () => {
    const redirects = await redirectsOf();
    const rule = redirects.find((r) => r.source === '/job-search');
    expect(rule).toMatchObject({ destination: '/jobs/explore' });
    expect(redirects.some((r) => r.source.startsWith('/job-search/') || r.source.includes('/job-search/:'))).toBe(false);
  });

  it('keeps the legacy redirects', async () => {
    const sources = (await redirectsOf()).map((r) => r.source);
    for (const s of ['/home', '/tracker', '/preferences', '/plans', '/account', '/choose-plan']) expect(sources).toContain(s);
  });
});

describe('GoApply brand stylesheet', () => {
  const globals = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');
  const brandCss = readFileSync(join(ROOT, 'styles/brands/goapply.css'), 'utf8');

  it("globals.css imports it once, after the shared token sheets", () => {
    const imports = [...globals.matchAll(/@import '([^']+)'/g)].map((m) => m[1]);
    expect(imports.filter((i) => i === '../styles/brands/goapply.css')).toHaveLength(1);
    expect(imports.indexOf('../styles/brands/goapply.css')).toBeGreaterThan(imports.indexOf('../styles/tokens.css'));
    expect(imports.indexOf('../styles/brands/goapply.css')).toBeGreaterThan(imports.indexOf('../styles/v3.css'));
  });

  it("targets only html[data-brand='goapply'] (light and dark) and declares only brand tokens", () => {
    const code = brandCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...code.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim());
    expect(selectors.length).toBeGreaterThan(0);
    for (const sel of selectors) expect(sel.startsWith("html[data-brand='goapply']")).toBe(true);
    expect(selectors).toContain("html[data-brand='goapply'][data-theme='dark']");
    const props = [...code.matchAll(/(--[\w-]+|[a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(BRAND_TOKENS).toContain('--action');
    for (const p of props) expect(BRAND_TOKENS).toContain(p);
  });

  it('the attribute it keys on is the one app/layout.tsx sets', () => {
    expect(readFileSync(join(ROOT, 'app/layout.tsx'), 'utf8')).toMatch(/data-brand=\{/);
  });
});

describe('sign-in methods registry', () => {
  it('covers every method the brands name', () => {
    expect(Object.keys(AUTH_METHOD_REGISTRY).sort()).toEqual(['email_password', 'google', 'line', 'phone_otp', 'wechat']);
  });

  it('follows the brand order and shows a method only when its capability is on', () => {
    expect(authMethodsFor('roboapply', flagsWith()).map((m) => m.id)).toEqual(['email_password']);
    expect(authMethodsFor('roboapply', flagsWith({ 'auth.google': true, 'auth.line': true })).map((m) => m.id)).toEqual([
      'email_password',
      'google',
      'line',
    ]);
    expect(authMethodsFor('goapply', flagsWith({ 'auth.phoneOtp': true, 'auth.wechatInApp': true })).map((m) => m.id)).toEqual([
      'phone_otp',
      'wechat',
      'email_password',
    ]);
    // Fail closed before the flags arrive: only the flagless method.
    expect(authMethodsFor('goapply', null).map((m) => m.id)).toEqual(['email_password']);
  });
});
