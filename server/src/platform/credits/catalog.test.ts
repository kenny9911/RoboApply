// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import {
  CREDIT_BUCKETS,
  DEFAULT_CREDIT_CATALOG,
  ENTITLEMENT_KEYS,
  WINDOW_BUCKETS,
  catalogFor,
  getCreditCatalog,
  parseCreditCatalogOverride,
  setCreditCatalogConfigLoader,
} from './catalog.js';
import { PLAN_DEFINITIONS, entitlementProfileFor } from '../billing/planCatalog.js';
import { resolveEntitlementsFrom } from './EntitlementService.js';

afterEach(() => setCreditCatalogConfigLoader(null));

describe('default credit catalog (PRODUCT §6.2, R-07)', () => {
  it('has exactly the §4.1.f buckets', () => {
    expect([...CREDIT_BUCKETS].sort()).toEqual(
      [
        'fit_analysis',
        'tailor',
        'cover_letter',
        'resume_check',
        'rewrite',
        'outreach',
        'assistant',
        'autofill',
        'ai_answer',
        'job_import',
        'ready_kits',
        'competitiveness',
        'contact_lookup',
        'practice',
      ].sort(),
    );
    expect(WINDOW_BUCKETS).not.toContain('practice');
  });

  it('matches the PRODUCT §6.2 table for RoboApply', () => {
    const c = DEFAULT_CREDIT_CATALOG.roboapply.buckets;
    const table: Record<string, [number, number, string]> = {
      fit_analysis: [10, 200, 'day'],
      tailor: [2, 50, 'day'],
      cover_letter: [2, 50, 'day'],
      resume_check: [1, 20, 'day'],
      rewrite: [20, 300, 'day'],
      outreach: [3, 50, 'day'],
      assistant: [30, 300, 'day'],
      autofill: [5, 100, 'day'],
      job_import: [10, 50, 'day'],
      ready_kits: [3, 30, 'week'],
    };
    for (const [bucket, [free, pro, window]] of Object.entries(table)) {
      const def = c[bucket as keyof typeof c];
      expect(def.caps.free, bucket).toEqual({ cap: free, window });
      expect(def.caps.pro, bucket).toEqual({ cap: pro, window });
    }
    expect(DEFAULT_CREDIT_CATALOG.roboapply.entitlements).toEqual({
      free: { saved_searches: 1, instant_alerts: 1, competitivenessFull: false },
      pro: { saved_searches: 10, instant_alerts: 100, competitivenessFull: true },
    });
  });

  it('gives GoApply 免费版 three tailors a day and otherwise the same caps', () => {
    const intl = DEFAULT_CREDIT_CATALOG.roboapply.buckets;
    const cn = DEFAULT_CREDIT_CATALOG.goapply.buckets;
    expect(cn.tailor.caps.free.cap).toBe(3);
    for (const b of WINDOW_BUCKETS) if (b !== 'tailor') expect(cn[b].caps, b).toEqual(intl[b].caps);
  });

  it('caps every bucket with a finite number on every plan (no unlimited, R-07)', () => {
    for (const brand of ['roboapply', 'goapply'] as const) {
      for (const b of WINDOW_BUCKETS) {
        const { free, pro } = DEFAULT_CREDIT_CATALOG[brand].buckets[b].caps;
        expect(Number.isInteger(free.cap) && Number.isInteger(pro.cap), `${brand}.${b}`).toBe(true);
        expect(pro.cap).toBeGreaterThanOrEqual(0);
        expect(pro.cap).toBeLessThan(1000);
      }
    }
  });

  it('keeps contact lookup at 0 and not grantable', () => {
    const def = DEFAULT_CREDIT_CATALOG.roboapply.buckets.contact_lookup;
    expect(def.caps.free.cap).toBe(0);
    expect(def.caps.pro.cap).toBe(0);
    expect(def.grantable).toBe(false);
  });

  it('has no entitlement or bucket gating the recruiter-jobs filter on any plan (C16)', () => {
    const names = [...ENTITLEMENT_KEYS, ...CREDIT_BUCKETS].join(' ').toLowerCase();
    expect(names).not.toMatch(/recruiter|exclusive|fromrecruiterbank/);
    for (const brand of ['roboapply', 'goapply'] as const) {
      for (const profile of ['free', 'pro'] as const) {
        expect(Object.keys(DEFAULT_CREDIT_CATALOG[brand].entitlements[profile]).sort()).toEqual([...ENTITLEMENT_KEYS].sort());
      }
    }
  });
});

describe('credits.catalog.v1 override', () => {
  it('merges a valid override over the brand defaults', () => {
    const { override, error } = parseCreditCatalogOverride(
      JSON.stringify({ version: 1, brands: { goapply: { buckets: { tailor: { free: { cap: 4 } } }, entitlements: { pro: { saved_searches: 12 } } } } }),
    );
    expect(error).toBeNull();
    const cn = catalogFor('goapply', override);
    expect(cn.buckets.tailor.caps.free).toEqual({ cap: 4, window: 'day' });
    expect(cn.entitlements.pro.saved_searches).toBe(12);
    expect(catalogFor('roboapply', override).buckets.tailor.caps.free.cap).toBe(2);
  });

  it('rejects invalid JSON, unknown keys and out-of-range caps', () => {
    expect(parseCreditCatalogOverride('{nope').error).toBe('invalid_json');
    expect(parseCreditCatalogOverride(JSON.stringify({ brands: { roboapply: { buckets: { tailor: { free: { cap: -1 } } } } } })).override).toBeNull();
    expect(parseCreditCatalogOverride(JSON.stringify({ brands: { roboapply: { buckets: { nope: {} } } } })).override).toBeNull();
    expect(parseCreditCatalogOverride(JSON.stringify({ brands: { roboapply: { buckets: { tailor: { free: { cap: 1e9 } } } } } })).override).toBeNull();
    expect(parseCreditCatalogOverride(JSON.stringify({ extra: true })).override).toBeNull();
    expect(parseCreditCatalogOverride(null)).toEqual({ override: null, error: null });
  });

  it('never makes contact lookup grantable', () => {
    const { override } = parseCreditCatalogOverride(JSON.stringify({ brands: { roboapply: { buckets: { contact_lookup: { grantable: true } } } } }));
    expect(catalogFor('roboapply', override).buckets.contact_lookup.grantable).toBe(false);
  });

  it('loads through the AppConfig loader, caches, and falls back on errors', async () => {
    let calls = 0;
    setCreditCatalogConfigLoader(async () => {
      calls += 1;
      return JSON.stringify({ brands: { roboapply: { buckets: { rewrite: { free: { cap: 25 } } } } } });
    });
    expect((await getCreditCatalog('roboapply')).buckets.rewrite.caps.free.cap).toBe(25);
    await getCreditCatalog('goapply');
    expect(calls).toBe(1);

    setCreditCatalogConfigLoader(async () => {
      throw new Error('db down');
    });
    expect((await getCreditCatalog('roboapply')).buckets.rewrite.caps.free.cap).toBe(20);
  });
});

// Plans map to a catalog COLUMN, never to a row of their own: every pass a
// brand sells unlocks the same Pro column (MARKET_STRATEGY §3; D5). The
// GoApply student passes are passes like the others.
describe('plan → catalog column', () => {
  it('every pass and subscription of either brand unlocks the Pro column; packs and Free keep the Free column', () => {
    for (const brand of ['roboapply', 'goapply'] as const) {
      for (const def of PLAN_DEFINITIONS[brand]) {
        const expected = def.kind === 'pass' || def.kind === 'subscription' ? 'pro' : 'free';
        expect(entitlementProfileFor({ planKey: def.key }), `${brand}.${def.key}`).toBe(expected);
        // The plan row and the resolver agree.
        expect(def.entitlementProfile ?? 'free', `${brand}.${def.key}`).toBe(expected);
      }
    }
  });

  it.each(['pro_week_pass', 'pro_monthly', 'pro_quarterly', 'student_monthly', 'student_quarterly'])('a live GoApply %s gets exactly the GoApply Pro caps', (planKey) => {
    const now = new Date('2026-10-10T12:00:00Z');
    const r = resolveEntitlementsFrom({
      userId: 'u1',
      account: { brand: 'goapply', timezone: null, subscription: { tier: 'pro', planKey, status: 'active', interval: 'pass', currentPeriodEnd: new Date('2026-11-01T00:00:00Z') } },
      overrides: [],
      catalogFor: (brand) => DEFAULT_CREDIT_CATALOG[brand],
      now,
      fallbackBrand: 'goapply',
      proSellable: () => true,
    });
    expect(r.planProfile).toBe('pro');
    expect(r.planKey).toBe(planKey);
    const pro = DEFAULT_CREDIT_CATALOG.goapply;
    for (const bucket of WINDOW_BUCKETS) expect(r.buckets[bucket], bucket).toMatchObject(pro.buckets[bucket].caps.pro);
    expect(r.entitlements).toEqual(pro.entitlements.pro);
    // The same column a RoboApply subscriber gets, bucket for bucket.
    for (const bucket of WINDOW_BUCKETS) expect(pro.buckets[bucket].caps.pro, bucket).toEqual(DEFAULT_CREDIT_CATALOG.roboapply.buckets[bucket].caps.pro);
  });

  it('an ended student pass drops back to the Free column', () => {
    const r = resolveEntitlementsFrom({
      userId: 'u1',
      account: { brand: 'goapply', timezone: null, subscription: { tier: 'pro', planKey: 'student_monthly', status: 'active', interval: 'pass', currentPeriodEnd: new Date('2026-10-01T00:00:00Z') } },
      overrides: [],
      catalogFor: (brand) => DEFAULT_CREDIT_CATALOG[brand],
      now: new Date('2026-10-10T12:00:00Z'),
      fallbackBrand: 'goapply',
      proSellable: () => true,
    });
    expect(r.planProfile).toBe('free');
  });
});
