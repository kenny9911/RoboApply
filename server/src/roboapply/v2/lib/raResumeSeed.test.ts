// backend/src/roboapply/v2/lib/raResumeSeed.test.ts
//
// The two things that must never regress in first-run setup:
//
//   1. the deterministic seed actually reads the resume (otherwise step 2 is
//      an interrogation wearing a confirm screen's clothes), and it marks the
//      city as INFERRED and PROPOSED rather than applied;
//   2. `replaceDraft` genuinely removes a chip the user removed. Under the
//      chat's union semantics it silently did not, which is the worst bug
//      available on a confirm screen: the user corrects something, the UI
//      agrees, and the correction is discarded.
//
// Run: npx vitest run server/src/roboapply/v2/lib/raResumeSeed.test.ts

import { describe, it, expect } from 'vitest';
import { seedDraftFromParsedResume, cityFromAddress, seniorityFromTitle } from './raResumeSeed.js';
import { replaceDraft, mergeDraft } from './raOnboardingDraft.js';

const FULL_RESUME = {
  name: 'Ada Okonkwo',
  address: '221B Baker St, Austin, TX 78701',
  experience: [
    {
      role: 'Senior Product Manager',
      company: 'Lattice',
      employmentType: 'full-time',
      duration: '2020 – present',
      location: 'Austin, TX',
    },
    {
      role: 'Product Manager',
      company: 'Figma',
      employmentType: 'contract',
      duration: '2016 – 2020',
    },
    // Duplicate title at a third employer — one chip, not two.
    { role: 'product manager', company: 'Notion', duration: '2015 – 2016' },
  ],
};

describe('seedDraftFromParsedResume', () => {
  it('reads roles, employment types, seniority and years off the parse', () => {
    const seed = seedDraftFromParsedResume(FULL_RESUME, null);

    expect(seed.draft.targetRoles).toEqual(['Senior Product Manager', 'Product Manager']);
    expect(seed.fieldMeta.targetRoles).toEqual({ source: 'resume', confidence: 0.8 });

    expect(seed.draft.employmentTypes).toEqual(
      expect.arrayContaining(['full_time', 'contract']),
    );

    // "Senior" is an explicit level token in a real title.
    expect(seed.draft.seniority).toBe('senior');

    // 2020–present (≥4) plus 2016–2020 (4) plus 2015–2016 (1).
    expect(seed.evidence.years).toBeGreaterThanOrEqual(9);
    expect(seed.evidence.employers).toEqual(['Lattice', 'Figma', 'Notion']);
    expect(seed.thin).toBe(false);
  });

  it('proposes the city as INFERRED and never as an applied value', () => {
    const seed = seedDraftFromParsedResume(FULL_RESUME, null);

    // The street number and the "TX 78701" postal chunk are dropped.
    expect(seed.draft.locations?.cities).toEqual(['Austin']);
    expect(seed.evidence.city).toBe('Austin');

    // This is the guard that keeps a remote seeker's feed from emptying:
    // the city must arrive marked as a guess AND listed as a proposal, so the
    // client renders it unselected.
    expect(seed.fieldMeta.locations).toEqual({ source: 'inferred', confidence: 0.5 });
    expect(seed.proposedFields).toContain('locations');
    expect(seed.proposedFields).not.toContain('targetRoles');
  });

  it('never seeds salary or work modes, whatever the resume says', () => {
    const seed = seedDraftFromParsedResume(
      { ...FULL_RESUME, desiredSalary: 190000, workMode: 'remote' },
      null,
    );
    expect(seed.draft.salary).toBeUndefined();
    expect(seed.draft.workModes).toBeUndefined();
  });

  it('reports thin when no role can be derived', () => {
    const seed = seedDraftFromParsedResume({ name: 'Ada Okonkwo' }, null);
    expect(seed.draft.targetRoles).toBeUndefined();
    expect(seed.thin).toBe(true);
    // A thin resume must still not invent anything.
    expect(seed.proposedFields).toEqual([]);
  });

  it('survives a null / garbage parse without throwing', () => {
    expect(() => seedDraftFromParsedResume(null, null)).not.toThrow();
    expect(seedDraftFromParsedResume(null, null).thin).toBe(true);
    expect(seedDraftFromParsedResume('not an object', null).draft).toEqual({});
  });

  it('falls back to a City, Country line at the top of the markdown', () => {
    const md = '# Ada Okonkwo\nBerlin, Germany · ada@example.com\n\n## Experience\n';
    const seed = seedDraftFromParsedResume({}, md);
    expect(seed.draft.locations?.cities).toEqual(['Berlin']);
  });
});

describe('cityFromAddress', () => {
  it('drops digit-bearing parts and keeps the first real place', () => {
    expect(cityFromAddress('123 Main St, Austin, TX 78701')).toBe('Austin');
    expect(cityFromAddress('台北市, 台灣')).toBe('台北市');
    expect(cityFromAddress('Berlin')).toBe('Berlin');
  });

  it('refuses "Remote" — that is a work mode, not a place', () => {
    expect(cityFromAddress('Remote')).toBeNull();
    expect(cityFromAddress(null)).toBeNull();
  });
});

describe('seniorityFromTitle', () => {
  it('matches the most specific level token', () => {
    expect(seniorityFromTitle('Head of Engineering')).toBe('manager');
    expect(seniorityFromTitle('VP of Product')).toBe('vp');
    expect(seniorityFromTitle('Staff Software Engineer')).toBe('staff');
    expect(seniorityFromTitle('Senior Backend Engineer')).toBe('senior');
  });

  it('returns null when the title carries no level, rather than guessing', () => {
    expect(seniorityFromTitle('Product Manager')).toBeNull();
    expect(seniorityFromTitle(null)).toBeNull();
  });
});

describe('replaceDraft (the confirm path)', () => {
  const seeded = {
    targetRoles: ['Senior Product Manager', 'QA Lead'],
    locations: { cities: ['Austin'] },
  };

  it('REMOVES a chip the user removed — the bug that motivates this function', () => {
    const confirmed = replaceDraft(seeded, { targetRoles: ['Senior Product Manager'] });
    expect(confirmed.targetRoles).toEqual(['Senior Product Manager']);

    // Proof that the chat path could not have done this.
    const merged = mergeDraft(seeded, { targetRoles: ['Senior Product Manager'] });
    expect(merged.targetRoles).toContain('QA Lead');
  });

  it('treats an empty array as "I removed them all"', () => {
    expect(replaceDraft(seeded, { targetRoles: [] }).targetRoles).toEqual([]);
  });

  it('leaves fields the client did not submit alone', () => {
    const confirmed = replaceDraft(seeded, { workModes: ['remote'] });
    expect(confirmed.targetRoles).toEqual(['Senior Product Manager', 'QA Lead']);
    expect(confirmed.workModes).toEqual(['remote']);
  });

  it('replaces the locations block wholesale, so clearing the city clears it', () => {
    const confirmed = replaceDraft(seeded, { locations: { cities: [], remoteOk: true } });
    expect(confirmed.locations).toEqual({ cities: [], remoteOk: true });
  });

  it('still runs the taxonomy tables', () => {
    const confirmed = replaceDraft({}, {
      workModes: ['remote', 'nonsense'] as never,
      targetCompanies: ['Stripe', 'Linear'],
    });
    expect(confirmed.workModes).toEqual(['remote']);
    expect(confirmed.targetCompanies).toEqual(['Stripe', 'Linear']);
  });
});
