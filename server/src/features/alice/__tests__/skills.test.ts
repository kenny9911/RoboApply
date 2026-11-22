// @vitest-environment node
//
// Alice's skills: the readiness rule and the asking order, the profile → search
// mapping (only fields postings state; no invented geography; the market's own
// rules), the relevance text the feed accepts, and the follow-up order.

import { describe, expect, it } from 'vitest';
import { EMPTY_BRIEF, cleanProfile, type AliceBrief } from '../contract.js';
import { ALICE_SKILLS, PROFILE_AXES, filtersFromProfile, marketNorms, needsYou, nextTopic, readiness, relevanceText, renderTopicIndex, topicsFor, voiceDirective } from '../skills/index.js';
import { FEED_RELEVANCE_MAX_CHARS } from '../../feed/contract.js';

const brief = (over: Partial<AliceBrief>): AliceBrief => ({ ...EMPTY_BRIEF, ...over });

describe('intake topics', () => {
  it('needs roles, level, where and one aspiration; a declined aspiration counts, a declined role never does', () => {
    expect(readiness(brief({}), [], 'intl')).toEqual({ ready: false, missing: ['roles', 'level', 'where', 'aspiration'] });
    const almost = brief({ roles: ['Designer'], levels: ['senior'], workModels: ['remote'] });
    expect(readiness(almost, [], 'intl').missing).toEqual(['aspiration']);
    expect(readiness(almost, ['companies'], 'intl').ready).toBe(true);
    expect(readiness(brief({ levels: ['senior'], workModels: ['remote'], values: ['growth'] }), ['roles'], 'intl').missing).toEqual(['roles']);
  });

  it('asks the open needed group first, then the rest in order', () => {
    expect(nextTopic(brief({}), [], 'intl')).toBe('roles');
    expect(nextTopic(brief({ roles: ['Designer'], levels: ['senior'] }), [], 'intl')).toBe('workSetting');
    const ready = brief({ roles: ['Designer'], levels: ['senior'], workModels: ['remote'], companies: ['Figma'] });
    expect(nextTopic(ready, [], 'intl')).toBe('pay');
  });

  it('never asks GoApply about visas', () => {
    expect(topicsFor('cn').map((t) => t.id)).not.toContain('sponsorship');
    expect(topicsFor('intl').map((t) => t.id)).toContain('sponsorship');
    expect(renderTopicIndex('cn')).not.toContain('sponsorship');
  });
});

describe('profile → search', () => {
  const profile = cleanProfile(
    {
      titles: ['資深產品設計師'],
      searchTitles: ['Senior Product Designer'],
      levels: ['senior'],
      workModels: ['remote', 'hybrid', 'onsite'],
      places: [
        { label: 'Taipei', city: 'Taipei', country: 'TW' },
        { label: 'anywhere in Asia', city: null, country: null },
      ],
      pay: { amount: 90000, currency: 'TWD', period: 'month' },
      industries: ['Fintech'],
      companySizes: ['5000+'],
      skills: ['Figma'],
      companies: [{ name: 'LINE', source: 'you' }, { name: 'Appier', source: 'alice' }],
    },
    'p',
    ['LINE'],
  )!;

  it('maps only what postings state; places with no country never become filters', () => {
    const f = filtersFromProfile(profile, brief({ avoidCompanies: ['Acme Bank'], needsSponsorship: true }), 'intl');
    expect(f.titles).toEqual(['Senior Product Designer']);
    expect(f.seniority).toEqual(['senior']);
    expect(f.workModels).toBeUndefined(); // all three settings = no restriction
    expect(f.country).toBe('TW');
    expect(f.locations).toEqual([{ label: 'Taipei', city: 'Taipei', country: 'TW', radiusKm: 40 }]);
    expect(f.salaryMin).toEqual({ amount: 90000, currency: 'TWD', period: 'month' });
    // Only the company the person named; Alice's example (Appier) stays in the profile, not in their list (D3).
    expect(f.preferredCompanies).toEqual(['LINE']);
    expect(f.excludedCompanies).toEqual(['Acme Bank']);
    expect(f.needsSponsorship).toBe(true);
    // Strict feed filters that would drop jobs lacking the field are not written.
    expect(f.industries).toBeUndefined();
    expect(f.companySizes).toBeUndefined();
    expect(f.skills).toBeUndefined();
  });

  it('writes whole-country rows for several countries, and no sponsorship on GoApply', () => {
    const multi = { ...profile, places: [{ label: 'Berlin', city: 'Berlin', country: 'DE' }, { label: 'the Netherlands', city: null, country: 'NL' }] };
    const f = filtersFromProfile(multi, brief({ needsSponsorship: true }), 'cn');
    expect(f.country).toBeUndefined();
    expect(f.locations).toEqual([
      { label: 'Berlin', city: 'Berlin', country: 'DE', radiusKm: 40 },
      { label: 'NL', country: 'NL', radiusKm: 0 },
    ]);
    expect(f.needsSponsorship).toBeUndefined();
  });

  it('keeps the text to rank by within what the feed accepts', () => {
    const long = { ...profile, skills: Array.from({ length: 10 }, (_, i) => `a fairly long skill name ${i}`), headline: 'x'.repeat(130) };
    expect(relevanceText(long).length).toBeLessThanOrEqual(FEED_RELEVANCE_MAX_CHARS);
    expect(relevanceText(profile)).toContain('Senior Product Designer');
  });
});

describe('follow-ups', () => {
  it('orders by what costs most to miss and shows one item per application', () => {
    const items = needsYou(
      [
        { entryId: 'e1', reason: 'no_reply_10d', at: '2026-11-01', days: 22, companyName: 'Figma', title: 'Designer' },
        { entryId: 'e2', reason: 'interview_tomorrow', at: '2026-11-24T10:00:00Z', days: null, companyName: 'Stripe', title: 'Designer' },
        { entryId: 'e2', reason: 'follow_up_due', at: '2026-11-20', days: null, companyName: 'Stripe', title: 'Designer' },
      ],
      [{ queueItemId: 'q1', entryId: null, company: 'Linear', title: 'Designer', at: '2026-11-22' }],
    );
    expect(items.map((i) => [i.kind, i.entryId ?? i.queueItemId])).toEqual([
      ['interview_tomorrow', 'e2'],
      ['ready_to_check', 'q1'],
      ['no_reply_10d', 'e1'],
    ]);
  });
});

describe('the registry', () => {
  it('lists every skill, seven axes, and a voice that keeps D1', () => {
    expect(ALICE_SKILLS.map((s) => s.id)).toEqual(['intakeTopics', 'profileAxes', 'marketNorms', 'voice', 'profileFilters', 'followUps']);
    expect(PROFILE_AXES).toHaveLength(7);
    expect(voiceDirective('RoboApply')).toMatch(/never apply, submit or send anything to an employer/);
    expect(marketNorms('cn', null)).toMatchObject({ currency: 'CNY', payPeriod: 'month', askSponsorship: false });
    expect(marketNorms('intl', 'TW')).toMatchObject({ currency: 'TWD', payPeriod: 'month' });
    expect(marketNorms('intl', null)).toMatchObject({ currency: 'USD', payPeriod: 'year' });
  });
});
