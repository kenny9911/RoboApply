// WP-40 pure rules: CTA parameter preservation, browse links, the hero floor,
// the feature map per brand and parity with the server constants the pages print.

import { describe, expect, it } from 'vitest';

import { DEFAULT_MATCH_TIERS as SERVER_TIERS, DEFAULT_MATCH_WEIGHTS } from '../../../../server/src/features/match/contract';
import { HERO_COUNT_MIN as SERVER_HERO_MIN, PUBLIC_CAP_BUCKETS } from '../../../../server/src/features/support/contract';
import { supportAddress } from '../../../../server/src/features/support/service';
import { getBrand } from '../../../../lib/brand/registry.generated';
import { legalEntityFor, supportEmailFor } from '../brandEnv';
import {
  FEED_LIMITS,
  GOAL_ADJUSTMENTS as SERVER_GOALS,
  ORDERING_RULES as SERVER_RULES,
  RANKING_FACTORS as SERVER_FACTORS,
} from '../../../../server/src/features/feed/contract';
import { COMPANY_SPREAD, FEATURES, FIT_PARTS, FIT_TIER_FLOORS, GOAL_ADJUSTMENTS, ORDERING_RULES, RANKING_FACTORS, featuresFor, findFeature } from '../catalog';
import { HERO_COUNT_MIN, browseHref, buildSignupHref, fromSlug, heroCount, popularListHref, slugify } from '../links';

describe('buildSignupHref (PRODUCT §3.2 CTA rule)', () => {
  it('carries from, job, ref and utm_* and nothing else', () => {
    const href = buildSignupHref('pricing', '?job=cm123abc&ref=ABCD2345&utm_source=news&utm_campaign=fall_26&q=designer&token=secret');
    const url = new URL(href, 'https://x.test');
    expect(url.pathname).toBe('/signup');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: 'pricing',
      job: 'cm123abc',
      ref: 'ABCD2345',
      utm_source: 'news',
      utm_campaign: 'fall_26',
    });
  });

  it('accepts URLSearchParams and Next searchParams objects', () => {
    expect(buildSignupHref('home', new URLSearchParams('utm_medium=email'))).toBe('/signup?from=home&utm_medium=email');
    expect(buildSignupHref('home', { job: ['cm1', 'cm2'], utm_term: 'x' })).toBe('/signup?from=home&job=cm1&utm_term=x');
    expect(buildSignupHref('home', null)).toBe('/signup?from=home');
  });

  it('never puts an email address or free text in the URL', () => {
    const href = buildSignupHref('home', '?utm_source=a@b.test&ref=has%20space&job=<script>');
    expect(href).toBe('/signup?from=home');
  });

  it('normalises the page slug', () => {
    expect(fromSlug('Feature:Job Matches')).toBe('feature:job-matches');
    expect(fromSlug('')).toBe('site');
  });
});

describe('browse links', () => {
  it('builds the PRODUCT §3.2 browse paths', () => {
    expect(browseHref({ role: 'Product Designer' })).toBe('/browse/product-designer');
    expect(browseHref({ role: 'Product designer', city: 'São Paulo' })).toBe('/browse/product-designer/são-paulo');
    expect(browseHref({ role: 'Data analyst', city: 'Berlin', remote: true, country: 'de' })).toBe('/browse/remote/data-analyst?country=DE');
    expect(browseHref({ role: '   ' })).toBeNull();
    expect(slugify('前端 工程师')).toBe('前端-工程师');
    expect(popularListHref('backend_engineer')).toBe('/browse/backend-engineer');
  });
});

describe('hero count floor (H20)', () => {
  it('drops the clause under 1,000 and when unknown', () => {
    expect(heroCount({ value: 950 })).toBeNull();
    expect(heroCount(null)).toBeNull();
    expect(heroCount({ value: 1000 })).toBe(1000);
    expect(heroCount({ value: 12_000 })).toBe(12_000);
  });

  it('matches the server floor', () => {
    expect(HERO_COUNT_MIN).toBe(SERVER_HERO_MIN);
  });
});

describe('site map per brand (PRODUCT §3.2)', () => {
  it('RoboApply and GoApply have their own feature pages', () => {
    expect(featuresFor('roboapply').map((f) => f.slug)).toEqual([
      'job-matches',
      'resume-tailoring',
      'cover-letters',
      'ready-to-apply',
      'interview-practice',
      'assistant',
      'visa-sponsorship',
      'referrals',
      'chrome-extension',
    ]);
    expect(featuresFor('goapply').map((f) => f.slug)).toEqual(['campus-calendar', 'resume', 'interview-practice', 'assistant', 'form-filler']);
  });

  it('a slug of the other brand is not found', () => {
    expect(findFeature('goapply', 'chrome-extension')).toBeNull();
    expect(findFeature('roboapply', 'form-filler')).toBeNull();
    expect(findFeature('goapply', 'form-filler')?.gate).toBe('extensionPublished');
  });

  it('there is no H-1B-only or competitor page', () => {
    expect(FEATURES.some((f) => /h1b|compare|jobright/i.test(f.slug))).toBe(false);
  });
});

describe('published ranking factors', () => {
  it('weights add up to 100 (WP-32 formula)', () => {
    expect(RANKING_FACTORS.reduce((s, f) => s + f.pct, 0)).toBe(100);
    expect(Object.fromEntries(RANKING_FACTORS.map((f) => [f.key, f.pct]))).toEqual({ fit: 55, freshness: 20, affinity: 15, source: 10 });
  });

  // INT-06 (wave3 WP-93 #17): /help/ranking prints catalog.ts; the ranking code
  // reads server/src/features/feed/contract.ts. These fail when they differ.
  it('the four factors are the feed contract ones, key for key and weight for weight', () => {
    expect(RANKING_FACTORS.map((f) => [f.server, f.pct])).toEqual(SERVER_FACTORS.map((f) => [f.key, Math.round(f.weight * 100)]));
    expect(SERVER_FACTORS.reduce((sum, f) => sum + f.weight, 0)).toBeCloseTo(1, 10);
  });

  it('the ordering rules are the feed contract ones (same rules, same points)', () => {
    expect(ORDERING_RULES.map((r) => [r.server, r.points])).toEqual(SERVER_RULES.map((r) => [r.key, r.points]));
    // Sponsorship is asked on RoboApply only; every rule is shown on at least one brand.
    expect(ORDERING_RULES.find((r) => r.server === 'sponsorship_first')?.markets).toEqual(['intl']);
    for (const r of ORDERING_RULES) expect(r.markets.length).toBeGreaterThan(0);
  });

  it('every goal that adds points on the server is listed with those points, and no other', () => {
    const serverNonZero = Object.entries(SERVER_GOALS)
      .filter(([, g]) => g.points !== 0)
      .map(([key, g]) => [key, g.points]);
    expect(GOAL_ADJUSTMENTS.map((g) => [g.server, g.points])).toEqual(serverNonZero);
    for (const g of GOAL_ADJUSTMENTS) expect(g.points).toBeGreaterThan(0);
  });

  it('the company spread is the feed limit', () => {
    expect(COMPANY_SPREAD).toEqual({ max: FEED_LIMITS.companyMaxPerWindow, window: FEED_LIMITS.companyWindow });
  });

  it('fit parts and tiers match the scoring defaults', () => {
    expect(Object.fromEntries(FIT_PARTS.map((p) => [p.server, p.pct]))).toEqual(DEFAULT_MATCH_WEIGHTS);
    expect(FIT_TIER_FLOORS).toEqual(SERVER_TIERS);
  });
});

describe('per-brand config readers (R-03)', () => {
  it('support inbox matches the server and never falls back across brands', () => {
    const env = { SUPPORT_EMAIL: 'Help <help@roboapply.example>' };
    for (const id of ['roboapply', 'goapply'] as const) {
      expect(supportEmailFor(getBrand(id), env)).toBe(supportAddress(getBrand(id) as never, env));
    }
    expect(supportEmailFor(getBrand('goapply'), env)).toBe(getBrand('goapply').email.replyTo);
  });

  it('the legal entity shows only when configured', () => {
    expect(legalEntityFor(getBrand('roboapply'), {})).toBeNull();
    expect(legalEntityFor(getBrand('roboapply'), { LEGAL_ENTITY_NAME: 'Example Ltd' })).toBe('Example Ltd');
    expect(legalEntityFor(getBrand('goapply'), { LEGAL_ENTITY_NAME: 'Example Ltd' })).toBeNull();
  });

  it('the caps table lists the public buckets only', () => {
    expect(PUBLIC_CAP_BUCKETS).not.toContain('contact_lookup');
  });
});
