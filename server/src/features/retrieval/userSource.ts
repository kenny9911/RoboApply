// server/src/features/retrieval/userSource.ts
//
// Where the two user texts get their inputs (the default of
// `UserEmbedDeps.loadUser`). The resume, the skills and the search targets
// come from the match area's own seam (`matchService.userContext`): the same
// primary resume and the same saved search a fit is computed against. The
// chosen industries, the career goal and the person's names are read here.
// Runs inside the brand of the work item (`runWithBrand`), like every read of
// the match area.
//
// Never read: school name or tier, photo, 籍贯, 政治面貌, gender, birth date.

import type { UserTextSource } from './workers.js';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The slice of the Prisma client read here. */
export interface UserSourceDb {
  user: { findUnique(args: { where: { id: string }; select: { id: true } }): Promise<{ id: string } | null> };
  rAProfile: { findUnique(args: { where: { userId: string }; select: { firstName: true; lastName: true; careerGoal: true } }): Promise<{ firstName: string | null; lastName: string | null; careerGoal: string | null } | null> };
  seekerProfile: { findUnique(args: { where: { userId: string }; select: { onboardingAnswers: true } }): Promise<{ onboardingAnswers: unknown } | null> };
  rASearchProfile: {
    findFirst(args: { where: { userId: string }; select: { filters: true }; orderBy: Array<Record<string, 'asc' | 'desc'>> }): Promise<{ filters: unknown } | null>;
  };
}

export interface UserSourceDeps {
  db: () => Promise<UserSourceDb>;
  /** `matchService.userContext`: the saved search's targets, the skills and the primary resume. */
  userContext: (userId: string) => Promise<{
    user: { targetTitles: string[]; targetTaxonomyIds: string[]; targetSeniority: string[]; skills: string[] };
    resume: { parsedData: unknown } | null;
  }>;
}

async function defaultDeps(): Promise<UserSourceDeps> {
  const { matchService } = await import('../match/index.js');
  return {
    db: async () => (await import('../../lib/prisma.js')).default as unknown as UserSourceDb,
    userContext: (userId) => matchService.userContext(userId),
  };
}

/** `filters.industries` of a stored FilterSet document (strings only; anything else is ignored). */
function industriesOf(filters: unknown): string[] {
  const list = isRecord(filters) ? (filters.industries ?? filters.industriesInclude) : null;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, 30) : [];
}

export async function loadUserTextSource(userId: string, _market: string, deps?: UserSourceDeps): Promise<UserTextSource | null> {
  const d = deps ?? (await defaultDeps());
  const db = await d.db();
  if (!(await db.user.findUnique({ where: { id: userId }, select: { id: true } }))) return null;
  const [context, profile, seeker, search] = await Promise.all([
    d.userContext(userId),
    db.rAProfile.findUnique({ where: { userId }, select: { firstName: true, lastName: true, careerGoal: true } }),
    db.seekerProfile.findUnique({ where: { userId }, select: { onboardingAnswers: true } }),
    // The search the feed uses: active, else default, else the oldest (the order the match area reads it in).
    db.rASearchProfile.findFirst({ where: { userId }, select: { filters: true }, orderBy: [{ isActive: 'desc' }, { isDefault: 'desc' }, { createdAt: 'asc' }] }),
  ]);
  const answers = seeker?.onboardingAnswers;
  const onboardingGoal = isRecord(answers) && isRecord(answers.goal) ? text(answers.goal.goal) : null;
  const first = text(profile?.firstName);
  const last = text(profile?.lastName);
  return {
    intent: {
      targetTitles: context.user.targetTitles ?? [],
      targetTaxonomyIds: context.user.targetTaxonomyIds ?? [],
      targetSeniority: context.user.targetSeniority ?? [],
      skills: context.user.skills ?? [],
      industries: industriesOf(search?.filters),
      goal: onboardingGoal ?? text(profile?.careerGoal),
    },
    resumeParsed: context.resume?.parsedData ?? null,
    names: [first, last, first && last ? `${first} ${last}` : null, first && last ? `${last} ${first}` : null],
  };
}
