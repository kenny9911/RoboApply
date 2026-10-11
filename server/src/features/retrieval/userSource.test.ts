// @vitest-environment node
//
// Where the user texts get their inputs (MKT-2H item 4). Fake database and a fake match seam.

import { describe, expect, it, vi } from 'vitest';
import { loadUserTextSource, type UserSourceDb, type UserSourceDeps } from './userSource.js';

function deps(over: { user?: boolean; profile?: { firstName: string | null; lastName: string | null; careerGoal: string | null } | null; answers?: unknown; filters?: unknown; resume?: { parsedData: unknown } | null } = {}) {
  const selects: Record<string, unknown> = {};
  const db: UserSourceDb = {
    user: {
      findUnique: async (args) => {
        selects.user = args.select;
        return over.user === false ? null : { id: args.where.id };
      },
    },
    rAProfile: {
      findUnique: async (args) => {
        selects.rAProfile = args.select;
        return over.profile === undefined ? { firstName: 'Ada', lastName: 'Lovelace', careerGoal: 'Lead a platform team' } : over.profile;
      },
    },
    seekerProfile: {
      findUnique: async (args) => {
        selects.seekerProfile = args.select;
        return { onboardingAnswers: over.answers ?? null };
      },
    },
    rASearchProfile: {
      findFirst: async (args) => {
        selects.rASearchProfile = args;
        return { filters: over.filters ?? { industries: ['Fintech', 7, ''], titles: ['ignored here'] } };
      },
    },
  };
  const userContext = vi.fn(async () => ({
    user: { targetTitles: ['Backend Engineer'], targetTaxonomyIds: ['backend_engineer'], targetSeniority: ['senior'], skills: ['Go'] },
    resume: over.resume === undefined ? { parsedData: { summary: 'x' } } : over.resume,
  }));
  const d: UserSourceDeps = { db: async () => db, userContext };
  return { d, selects, userContext };
}

describe('loadUserTextSource', () => {
  it('takes the search targets, the skills and the primary resume from the match seam, and the industries, goal and names from its own reads', async () => {
    const k = deps({ answers: { goal: { goal: 'more_senior' } } });
    expect(await loadUserTextSource('u1', 'intl', k.d)).toEqual({
      intent: { targetTitles: ['Backend Engineer'], targetTaxonomyIds: ['backend_engineer'], targetSeniority: ['senior'], skills: ['Go'], industries: ['Fintech'], goal: 'more_senior' },
      resumeParsed: { summary: 'x' },
      names: ['Ada', 'Lovelace', 'Ada Lovelace', 'Lovelace Ada'],
    });
    expect(k.userContext).toHaveBeenCalledWith('u1');
    // The search the feed uses: active, else default, else the oldest.
    expect((k.selects.rASearchProfile as { orderBy: unknown }).orderBy).toEqual([{ isActive: 'desc' }, { isDefault: 'desc' }, { createdAt: 'asc' }]);
  });

  it('reads nothing a vector may not carry: no school, photo, gender, birth date, 籍贯 or 政治面貌', async () => {
    const k = deps();
    await loadUserTextSource('u1', 'cn', k.d);
    expect(k.selects.rAProfile).toEqual({ firstName: true, lastName: true, careerGoal: true });
    expect(k.selects.seekerProfile).toEqual({ onboardingAnswers: true });
    expect(k.selects.user).toEqual({ id: true });
  });

  it("falls back to the profile's own goal, and to no goal, no industries and no resume", async () => {
    expect((await loadUserTextSource('u1', 'intl', deps().d))!.intent.goal).toBe('Lead a platform team');
    const bare = await loadUserTextSource('u1', 'intl', deps({ profile: null, filters: {}, resume: null }).d);
    expect(bare).toMatchObject({ intent: { goal: null, industries: [] }, resumeParsed: null, names: [null, null, null, null] });
  });

  it('is null for an account that is gone, without reading anything else', async () => {
    const k = deps({ user: false });
    expect(await loadUserTextSource('gone', 'intl', k.d)).toBeNull();
    expect(k.userContext).not.toHaveBeenCalled();
  });
});
