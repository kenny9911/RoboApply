// @vitest-environment node
//
// Alice's contract: every model value is cleaned before it is stored or shown
// (D3: a company is the person's only when they named it; no profile without
// a title), the diff between versions is computed, and the brief merges an
// answer without losing what was known.

import { describe, expect, it } from 'vitest';
import { AliceTurnBodySchema, EMPTY_BRIEF, cleanBrief, cleanPlaces, cleanProfile, diffProfiles, mergeBrief, cleanPay } from '../contract.js';

const raw = {
  label: 'Steady climb',
  headline: 'Senior product designer at a payments company',
  summary: 'Keep growing in payments design.',
  titles: ['Senior Product Designer', 'Senior Product Designer', '  Lead Designer  '],
  searchTitles: ['Senior Product Designer'],
  levels: ['senior', 'wizard'],
  workModels: ['remote', 'hybrid', 'spaceship'],
  places: [{ label: 'Berlin', city: 'Berlin', country: 'de' }, { label: 'anywhere in Europe', city: null, country: 'Europe' }],
  pay: { amount: '85,000', currency: 'eur', period: 'year' },
  industries: ['Fintech'],
  companyKinds: ['scaleup'],
  companySizes: ['201-1000', '7'],
  companies: [{ name: 'Stripe', source: 'you' }, { name: 'Adyen', source: 'you' }, 'Wise'],
  skills: ['Figma'],
  mustHaves: ['Design system ownership'],
  niceToHaves: [],
  dealbreakers: ['Weekly travel'],
  whyItFits: ['Six years in checkout design'],
  tradeoff: 'Less scope than a lead role.',
  jobTypes: ['full_time', 'gig'],
};

describe('cleanProfile', () => {
  it('keeps only known ids, folds duplicates and labels companies by who named them (D3)', () => {
    const p = cleanProfile(raw, 'a', ['Stripe'])!;
    expect(p.titles).toEqual(['Senior Product Designer', 'Lead Designer']);
    expect(p.levels).toEqual(['senior']);
    expect(p.workModels).toEqual(['remote', 'hybrid']);
    expect(p.companySizes).toEqual(['201-1000']);
    expect(p.jobTypes).toEqual(['full_time']);
    expect(p.pay).toEqual({ amount: 85000, currency: 'EUR', period: 'year' });
    expect(p.places).toEqual([
      { label: 'Berlin', city: 'Berlin', country: 'DE' },
      { label: 'anywhere in Europe', city: null, country: null },
    ]);
    // Stripe was named; Adyen claims "you" but the person never named it; Wise is a bare string.
    expect(p.companies).toEqual([
      { name: 'Stripe', source: 'you' },
      { name: 'Adyen', source: 'alice' },
      { name: 'Wise', source: 'alice' },
    ]);
  });

  it('refuses a profile with no title (nothing to search)', () => {
    expect(cleanProfile({ ...raw, titles: [] }, 'a')).toBeNull();
    expect(cleanProfile(null, 'a')).toBeNull();
  });
});

describe('diffProfiles', () => {
  it('lists exactly the fields that differ, in display order', () => {
    const a = cleanProfile(raw, 'a', ['Stripe'])!;
    const b = { ...a, workModels: ['remote' as const], dealbreakers: ['Weekly travel', 'On-call'] };
    expect(diffProfiles(a, b)).toEqual(['workModels', 'dealbreakers']);
    expect(diffProfiles(a, { ...a })).toEqual([]);
    expect(diffProfiles(null, a)).toEqual([]);
  });
});

describe('mergeBrief', () => {
  it('replaces a list only when the answer names it, and clears what the person took back', () => {
    const base = { ...EMPTY_BRIEF, roles: ['Product designer'], workModels: ['remote' as const], values: ['growth'] };
    const next = mergeBrief(base, { workModels: ['hybrid', 'remote'] as never, values: [] }, ['values']);
    expect(next.roles).toEqual(['Product designer']);
    expect(next.workModels).toEqual(['remote', 'hybrid']);
    expect(next.values).toEqual([]);
  });

  it('ignores invalid values from a model', () => {
    const next = mergeBrief(EMPTY_BRIEF, { levels: ['emperor'] as never, pay: { amount: -4, currency: 'X', period: 'year' } as never, timing: 'yesterday' as never });
    expect(next.levels).toEqual([]);
    expect(next.pay).toBeNull();
    expect(next.timing).toBeNull();
  });
});

describe('small cleaners', () => {
  it('cleanBrief fills every field', () => {
    expect(cleanBrief(undefined)).toEqual(EMPTY_BRIEF);
  });
  it('cleanPlaces keeps the label, drops a non-ISO country', () => {
    expect(cleanPlaces(['Taipei', { label: 'Taipei' }], 4)).toEqual([{ label: 'Taipei', city: null, country: null }]);
  });
  it('cleanPay refuses nonsense', () => {
    expect(cleanPay({ amount: 0, currency: 'USD', period: 'year' })).toBeNull();
    expect(cleanPay({ amount: 5000, currency: 'TWD', period: 'week' })).toBeNull();
    expect(cleanPay({ amount: 60000, currency: 'twd', period: 'month' })).toEqual({ amount: 60000, currency: 'TWD', period: 'month' });
  });
});

describe('turn actions', () => {
  it('parses each kind and refuses unknown fields', () => {
    expect(AliceTurnBodySchema.parse({ kind: 'save' })).toEqual({ kind: 'save', search: 'auto' });
    expect(AliceTurnBodySchema.safeParse({ kind: 'choose', draftId: 'c' }).success).toBe(false);
    expect(AliceTurnBodySchema.safeParse({ kind: 'message', text: 'hi', extra: 1 }).success).toBe(false);
    expect(AliceTurnBodySchema.safeParse({ kind: 'refine', comment: '' }).success).toBe(false);
  });
});
