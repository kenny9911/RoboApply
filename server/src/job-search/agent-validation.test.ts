// @vitest-environment node
// MKT-4H (SM-9): the planner's plan may name topics to rank by. They are the
// one lenient field of the plan: a bad value is dropped, the plan stays usable.
// A requirement named as a topic is moved to the preferences nobody checked,
// for every reader of a plan (the search API and the feed's NL query).
import { describe, expect, it } from 'vitest';
import {
  RELEVANCE_MAX_CHARS,
  RELEVANCE_MAX_TERMS,
  RELEVANCE_MOVED_MAX,
  RELEVANCE_TERM_MAX_CHARS,
  RELEVANCE_TERM_MIN_CHARS,
  parseAgentPlan,
  parseRelevanceTerms,
  splitRelevanceTerms,
} from './agent-validation.js';
import { JobSearchValidationError } from './validation.js';
import { FEED_RELEVANCE_MAX_CHARS } from '../features/feed/contract.js';
import { RANKED_BY_MAX_CHARS, RANKED_BY_MAX_TERMS, planToFilters, type PlannerPlan } from '../features/feed/filterDiff.js';

const BASE = { queries: ['backend engineer'], unverifiedPreferences: [] };

describe('relevanceTerms: an allowed, optional field of the plan', () => {
  it('the plan of the acceptance request: queries, remote, the topics to rank by, and the pay phrase left unverified', () => {
    // "remote backend roles at climate startups, ideally using Rust, paying over 150k"
    const plan = parseAgentPlan(JSON.stringify({ queries: ['backend engineer'], remote: true, relevanceTerms: ['climate startups', 'Rust'], unverifiedPreferences: ['paying over 150k'] }));
    expect(plan).toEqual({ queries: ['backend engineer'], remote: true, relevanceTerms: ['climate startups', 'Rust'], unverifiedPreferences: ['paying over 150k'] });
  });

  it('a plan without the field, or with nothing usable in it, carries no relevanceTerms key', () => {
    expect(parseAgentPlan(BASE)).toEqual(BASE);
    for (const relevanceTerms of [[], [''], ['   '], ['x'], [7, null, {}], 'Rust', 42, null, { 0: 'Rust' }]) {
      expect(parseAgentPlan({ ...BASE, relevanceTerms }), JSON.stringify(relevanceTerms)).toEqual(BASE);
    }
  });

  it('every other field stays strict: an unknown field or a malformed filter is still fatal', () => {
    expect(() => parseAgentPlan({ ...BASE, relevanceTerms: ['Rust'], providers: ['jsearch'] })).toThrow('Unexpected planning fields.');
    expect(() => parseAgentPlan({ ...BASE, relevanceTerms: ['Rust'], rankedBy: ['Rust'] })).toThrow('Unexpected planning fields.');
    expect(() => parseAgentPlan({ ...BASE, relevanceTerms: ['Rust'], remote: 'true' })).toThrow('remote must be boolean.');
    expect(() => parseAgentPlan({ queries: ['https://example.com/jobs'], unverifiedPreferences: [], relevanceTerms: ['Rust'] })).toThrow('Role query is invalid.');
  });

  it('a request that names a topic but no role is still asked for a role (the sentinel beside relevanceTerms)', () => {
    for (const relevanceTerms of [[], ['Rust'], 'nonsense']) {
      expect(() => parseAgentPlan({ queries: [], unverifiedPreferences: [], relevanceTerms })).toThrow(JobSearchValidationError);
    }
  });
});

describe('parseRelevanceTerms: caps and dropped values (never fatal)', () => {
  it('keeps at most five, in the planner\'s order: a plan with nine is accepted with the rest dropped', () => {
    const nine = ['climate startups', 'Rust', 'developer tools', 'open source', 'fintech', 'robotics', 'health care', 'education', 'gaming'];
    expect(parseRelevanceTerms(nine)).toEqual(nine.slice(0, 5));
    expect(parseAgentPlan({ ...BASE, relevanceTerms: nine }).relevanceTerms).toEqual(nine.slice(0, 5));
    expect(RELEVANCE_MAX_TERMS).toBe(5);
  });

  it('drops a URL, a control character, a value that is too short or too long, and a value that is not a string; the plan is kept', () => {
    const plan = parseAgentPlan({
      ...BASE,
      relevanceTerms: [
        'https://evil.example/jobs?q=rust',
        'see www.example.com',
        '//example.com/x',
        'climate\u0000startups',
        'line one\nline two',
        'R',
        'x'.repeat(RELEVANCE_TERM_MAX_CHARS + 1),
        17,
        null,
        ['Rust'],
        'climate startups',
        '  Rust  ',
      ],
    });
    expect(plan.relevanceTerms).toEqual(['climate startups', 'Rust']);
    expect(plan.queries).toEqual(['backend engineer']);
  });

  it('keeps the shortest and the longest allowed value, names with dots, and other scripts', () => {
    const longest = 'y'.repeat(RELEVANCE_TERM_MAX_CHARS);
    expect(parseRelevanceTerms(['Go', longest, 'Next.js', 'ASP.NET', 'TCP/IP', '新能源', 'C++'])).toEqual(['Go', longest, 'Next.js', 'ASP.NET', 'TCP/IP']);
    expect(parseRelevanceTerms(['新能源', '跨境电商', 'C++'])).toEqual(['新能源', '跨境电商', 'C++']);
    expect([RELEVANCE_TERM_MIN_CHARS, RELEVANCE_TERM_MAX_CHARS]).toEqual([2, 60]);
  });

  it('names a topic once, whatever the letter case, and keeps the first spelling', () => {
    expect(parseRelevanceTerms(['Rust', 'rust', 'RUST ', 'climate startups', 'Climate Startups'])).toEqual(['Rust', 'climate startups']);
  });

  it('the kept terms always fit the feed\'s relevance text together: a term that no longer fits is dropped, a later shorter one still counts', () => {
    const long = (c: string) => c.repeat(RELEVANCE_TERM_MAX_CHARS);
    // Four terms of 60 and three spaces are 243 characters: the fourth does not fit, the short one after it does.
    const kept = parseRelevanceTerms([long('a'), long('b'), long('c'), long('d'), 'Rust']);
    expect(kept).toEqual([long('a'), long('b'), long('c'), 'Rust']);
    expect(kept.join(' ').length).toBeLessThanOrEqual(RELEVANCE_MAX_CHARS);
  });

  it('the limits are the feed\'s own (the rule lives there; these are its twins)', () => {
    expect(RELEVANCE_MAX_CHARS).toBe(FEED_RELEVANCE_MAX_CHARS);
    expect(RELEVANCE_MAX_TERMS).toBe(RANKED_BY_MAX_TERMS);
    expect(RELEVANCE_TERM_MAX_CHARS).toBe(RANKED_BY_MAX_CHARS);
  });
});

describe('a requirement is never a relevance term: the parser moves it to unverifiedPreferences', () => {
  it('a pay, visa or benefit phrase the model named as a topic is moved; the real topics stay', () => {
    const plan = parseAgentPlan({ ...BASE, relevanceTerms: ['paying over 150k', 'visa sponsorship', '五险一金', 'Rust'] });
    expect(plan.relevanceTerms).toEqual(['Rust']);
    expect(plan.unverifiedPreferences).toEqual(['paying over 150k', 'visa sponsorship', '五险一金']);
  });

  it('the moved phrases follow the planner\'s own preferences, once each', () => {
    const plan = parseAgentPlan({ queries: ['backend engineer'], unverifiedPreferences: ['visa sponsorship', 'small team'], relevanceTerms: ['Visa Sponsorship', 'equity', 'visa sponsorship', 'fintech'] });
    // 'Visa Sponsorship' is the planner's own phrase in another letter case: it is not listed twice.
    expect(plan.unverifiedPreferences).toEqual(['visa sponsorship', 'small team', 'equity']);
    expect(plan.relevanceTerms).toEqual(['fintech']);
  });

  it('only requirements among the terms: the plan carries no relevanceTerms key', () => {
    const plan = parseAgentPlan({ ...BASE, relevanceTerms: ['salary above 150k', 'flexible hours'] });
    expect(plan).toEqual({ queries: ['backend engineer'], unverifiedPreferences: ['salary above 150k', 'flexible hours'] });
  });

  it('a requirement is found among all the usable terms, before the cap of five topics, so one named ninth is not lost', () => {
    const nine = ['climate startups', 'Rust', 'developer tools', 'open source', 'fintech', 'robotics', 'gaming', 'education', 'visa sponsorship'];
    const plan = parseAgentPlan({ ...BASE, relevanceTerms: nine });
    expect(plan.relevanceTerms).toEqual(nine.slice(0, 5));
    expect(plan.unverifiedPreferences).toEqual(['visa sponsorship']);
    // A requirement does not use up one of the five places either.
    expect(parseAgentPlan({ ...BASE, relevanceTerms: ['paying over 150k', ...nine.slice(0, 6)] }).relevanceTerms).toEqual(nine.slice(0, 5));
  });

  it('a bad value is still dropped, never moved: a URL in a pay phrase is not disclosed', () => {
    const plan = parseAgentPlan({ ...BASE, relevanceTerms: ['salary at https://evil.example/pay', 'pay\u0000', 'p'.repeat(61) + ' salary'] });
    expect(plan).toEqual(BASE);
  });

  it('at most twelve phrases are moved (the size of the preference list itself)', () => {
    const many = Array.from({ length: 20 }, (_, i) => `salary band ${i + 1}`);
    const { topics, conditions } = splitRelevanceTerms(many);
    expect(topics).toEqual([]);
    expect(conditions).toEqual(many.slice(0, RELEVANCE_MOVED_MAX));
    expect(RELEVANCE_MOVED_MAX).toBe(12);
    // The planner's own twelve are still its strict limit; the moved ones come after them.
    const own = Array.from({ length: 12 }, (_, i) => `preference ${i + 1}`);
    expect(parseAgentPlan({ queries: ['backend engineer'], unverifiedPreferences: own, relevanceTerms: ['visa sponsorship'] }).unverifiedPreferences).toEqual([...own, 'visa sponsorship']);
    expect(() => parseAgentPlan({ queries: ['backend engineer'], unverifiedPreferences: [...own, 'one more'] })).toThrow('Unverified preferences are invalid.');
  });

  it('the rule is the feed\'s by default and can be replaced', () => {
    const raw = { ...BASE, relevanceTerms: ['climate startups', 'Rust'] };
    expect(parseAgentPlan(raw).relevanceTerms).toEqual(['climate startups', 'Rust']);
    const plan = parseAgentPlan(raw, (phrase) => phrase === 'Rust');
    expect(plan.relevanceTerms).toEqual(['climate startups']);
    expect(plan.unverifiedPreferences).toEqual(['Rust']);
    // Words that are also topics stay topics (the feed's rule names requirement wording, not single words).
    expect(parseAgentPlan({ ...BASE, relevanceTerms: ['equity research', 'paid social', '4k video'] }).relevanceTerms).toEqual(['equity research', 'paid social', '4k video']);
  });
});

describe('the feed reads the terms through its planner dependency (POST /feed/nl-query → rankedBy)', () => {
  // feed/defaultService.ts `defaultPlanner` is `parseAgentPlan(raw) as PlannerPlan`; `nlQuery` answers `planToFilters(plan, …).rankedBy`.
  const nlQueryRankedBy = (raw: unknown, text: string) => planToFilters(parseAgentPlan(raw) as PlannerPlan, text, 'intl');

  it('the terms the planner names are what the in-app search is ranked by; the pay phrase stays unchecked', () => {
    const text = 'remote backend roles at climate startups, ideally using Rust, paying over 150k';
    const out = nlQueryRankedBy({ queries: ['backend engineer'], remote: true, relevanceTerms: ['climate startups', 'Rust'], unverifiedPreferences: ['paying over 150k'] }, text);
    expect(out.rankedBy).toEqual(['climate startups', 'Rust']);
    expect(out.unmatched).toEqual(['paying over 150k']);
    expect(out.patch).toMatchObject({ titles: ['backend engineer'], workModels: ['remote'] });
    expect(out.patch.salaryMin).toBeUndefined();
  });

  it('a plan with nine terms or a URL in one still reaches the feed, with the bad values gone', () => {
    const out = nlQueryRankedBy({ ...BASE, relevanceTerms: ['https://x.example', 'climate startups', 'Rust', 'a', 'b2b', 'fintech', 'robotics', 'gaming', 'biotech'] }, 'backend engineer');
    expect(out.rankedBy).toEqual(['climate startups', 'Rust', 'b2b', 'fintech', 'robotics']);
  });

  it('a requirement the planner filed under relevanceTerms is not lost in the app: it becomes the filter it names, or is shown as not checked', () => {
    // The same phrases under unverifiedPreferences give the same answer: no wish vanishes because of the field it came in.
    const filed = nlQueryRankedBy({ queries: ['backend engineer'], relevanceTerms: ['visa sponsorship', 'equity'], unverifiedPreferences: [] }, 'backend engineer');
    const stated = nlQueryRankedBy({ queries: ['backend engineer'], unverifiedPreferences: ['visa sponsorship', 'equity'] }, 'backend engineer');
    expect(filed.patch.needsSponsorship).toBe(true);
    expect(filed.unmatched).toEqual(['equity']);
    expect(filed.rankedBy).toEqual([]);
    expect(filed).toEqual(stated);
    // Beside real topics: the topics order the list, the requirement is still handled.
    const mixed = nlQueryRankedBy({ queries: ['backend engineer'], relevanceTerms: ['Rust', 'unlimited vacation'], unverifiedPreferences: [] }, 'backend engineer');
    expect(mixed.rankedBy).toEqual(['Rust']);
    expect(mixed.unmatched).toEqual(['unlimited vacation']);
    // GoApply has no sponsorship filter: the phrase is shown as not checked there.
    const cn = planToFilters(parseAgentPlan({ queries: ['后端工程师'], relevanceTerms: ['五险一金', '新能源'], unverifiedPreferences: [] }) as PlannerPlan, '后端工程师', 'cn');
    expect(cn.unmatched).toEqual(['五险一金']);
    expect(cn.rankedBy).toEqual(['新能源']);
  });
});
