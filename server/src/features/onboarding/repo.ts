// server/src/features/onboarding/repo.ts — Prisma adapter of the onboarding area (WP-30).
//
// The only module here that touches the database. The service and the match
// pipeline depend on the `OnboardingRepo` interface, so tests run on an
// in-memory fake (no network, no database).

import { Prisma } from '../../generated/prisma/client.js';
import type { OnboardingAnswers, OnboardingEntry } from './contract.js';

/**
 * Not flagged as fraudulent (R-17): `RAJob.fraudFlags` is null or []. The same
 * rule as the cn index count (`NOT_FRAUD_FLAGGED`, onboarding-cn/marketSnapshot.ts);
 * repo.test.ts keeps the two equal. It is written out here instead of imported:
 * this file is loaded by every importer of the stage machine, and the
 * onboarding-cn index would bring that whole area (and compliance) with it.
 */
export const CANDIDATE_NOT_FRAUD_FLAGGED: Prisma.RAJobWhereInput = {
  OR: [{ fraudFlags: { equals: Prisma.DbNull } }, { fraudFlags: { equals: Prisma.JsonNull } }, { fraudFlags: { equals: [] } }],
};

export interface OnboardingRecord {
  step: string | null;
  path: string | null;
  answers: OnboardingAnswers;
  entry: OnboardingEntry | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface OnboardingPatch {
  step?: string;
  path?: string | null;
  answers?: OnboardingAnswers;
  startedAt?: Date | null;
  completedAt?: Date | null;
  acquisitionSource?: string | null;
  acquisitionNote?: string | null;
}

export interface ResumeVariantRow {
  id: string;
  parsedData: unknown;
  resumeMarkdown: string | null;
}

export interface CandidateQuery {
  market: 'intl' | 'cn';
  taxonomyIds: string[];
  titles: string[];
  /** ISO countries; empty = anywhere. */
  countries: string[];
  /** City names (GoApply 期望城市); empty or absent = every city. */
  cities?: string[];
  /** Include remote jobs wherever they are. */
  includeRemote: boolean;
  limit: number;
}

export interface OnboardingRepo {
  read(userId: string): Promise<OnboardingRecord | null>;
  /**
   * Read-modify-write under a row lock (two tabs saving at once never lose an
   * answer). `fn` returns the patch to write (or null for none) and a result.
   */
  mutate<T>(userId: string, fn: (rec: OnboardingRecord) => { patch: OnboardingPatch | null; result: T }): Promise<T>;
  /** RAProfile.seekerType / careerGoal (upsert; undefined leaves a field). */
  setProfileFields(userId: string, data: { seekerType?: string | null; careerGoal?: string | null }): Promise<void>;
  getResume(userId: string, variantId: string): Promise<ResumeVariantRow | null>;
  /**
   * Candidate job ids for O6: public, canonical rows of the market that are
   * still open (not archived, not closed — a job closed after reports keeps
   * `archivedAt` null). On GoApply a fraud-flagged posting is left out too
   * (R-17), the same rule as the cn index count, so the number the user is
   * told never exceeds what the list can show.
   */
  findCandidates(q: CandidateQuery): Promise<string[]>;
}

function toRecord(row: {
  onboardingStep: string | null;
  onboardingPath: string | null;
  onboardingAnswers: unknown;
  onboardingEntry: unknown;
  onboardingStartedAt: Date | null;
  onboardingCompletedAt: Date | null;
}): OnboardingRecord {
  const answers = row.onboardingAnswers && typeof row.onboardingAnswers === 'object' && !Array.isArray(row.onboardingAnswers) ? (row.onboardingAnswers as OnboardingAnswers) : {};
  const entry = row.onboardingEntry && typeof row.onboardingEntry === 'object' && !Array.isArray(row.onboardingEntry) ? (row.onboardingEntry as OnboardingEntry) : null;
  return {
    step: row.onboardingStep,
    path: row.onboardingPath,
    answers,
    entry,
    startedAt: row.onboardingStartedAt,
    completedAt: row.onboardingCompletedAt,
  };
}

const RECORD_SELECT = {
  onboardingStep: true,
  onboardingPath: true,
  onboardingAnswers: true,
  onboardingEntry: true,
  onboardingStartedAt: true,
  onboardingCompletedAt: true,
} as const;

function toData(patch: OnboardingPatch): Prisma.SeekerProfileUpdateInput {
  const data: Prisma.SeekerProfileUpdateInput = {};
  if (patch.step !== undefined) data.onboardingStep = patch.step;
  if (patch.path !== undefined) data.onboardingPath = patch.path;
  if (patch.answers !== undefined) data.onboardingAnswers = patch.answers as Prisma.InputJsonValue;
  if (patch.startedAt !== undefined) data.onboardingStartedAt = patch.startedAt;
  if (patch.completedAt !== undefined) data.onboardingCompletedAt = patch.completedAt;
  if (patch.acquisitionSource !== undefined) data.acquisitionSource = patch.acquisitionSource;
  if (patch.acquisitionNote !== undefined) data.acquisitionNote = patch.acquisitionNote;
  return data;
}

export class OnboardingProfileMissingError extends Error {
  constructor() {
    super('seeker profile not found');
    this.name = 'OnboardingProfileMissingError';
  }
}

type Db = typeof import('../../lib/prisma.js').default;

export function createPrismaOnboardingRepo(getDb: () => Promise<Db> = async () => (await import('../../lib/prisma.js')).default): OnboardingRepo {
  return {
    async read(userId) {
      const db = await getDb();
      const row = await db.seekerProfile.findUnique({ where: { userId }, select: RECORD_SELECT });
      return row ? toRecord(row) : null;
    },

    async mutate(userId, fn) {
      const db = await getDb();
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "SeekerProfile" WHERE "userId" = ${userId} FOR UPDATE`;
        const row = await tx.seekerProfile.findUnique({ where: { userId }, select: RECORD_SELECT });
        if (!row) throw new OnboardingProfileMissingError();
        const { patch, result } = fn(toRecord(row));
        if (patch && Object.keys(patch).length) await tx.seekerProfile.update({ where: { userId }, data: toData(patch) });
        return result;
      });
    },

    async setProfileFields(userId, data) {
      const db = await getDb();
      const fields: { seekerType?: string | null; careerGoal?: string | null } = {};
      if (data.seekerType !== undefined) fields.seekerType = data.seekerType;
      if (data.careerGoal !== undefined) fields.careerGoal = data.careerGoal;
      if (!Object.keys(fields).length) return;
      await db.rAProfile.upsert({ where: { userId }, create: { userId, ...fields }, update: fields });
    },

    async getResume(userId, variantId) {
      const db = await getDb();
      const row = await db.rAResumeVariant.findFirst({
        where: { id: variantId, userId, deletedAt: null },
        select: { id: true, parsedData: true, resumeMarkdown: true },
      });
      return row ? { id: row.id, parsedData: row.parsedData, resumeMarkdown: row.resumeMarkdown ?? null } : null;
    },

    async findCandidates(q) {
      const db = await getDb();
      const titleOr: Prisma.RAJobWhereInput[] = [
        ...(q.taxonomyIds.length ? [{ taxonomyIds: { hasSome: q.taxonomyIds } }] : []),
        ...q.titles.filter(Boolean).map((t) => ({ titleNormalized: { contains: t.trim().toLowerCase() } })),
      ];
      if (!titleOr.length) return [];
      const placeOr: Prisma.RAJobWhereInput[] = [
        ...(q.countries.length ? [{ locationCountry: { in: q.countries } }] : []),
        ...(q.includeRemote ? [{ workModel: 'remote' }] : []),
      ];
      const cities = (q.cities ?? []).filter(Boolean);
      const cityOr: Prisma.RAJobWhereInput[] = cities.length ? [{ locationCity: { in: cities } }, ...cities.map((c) => ({ location: { contains: c } }))] : [];
      const rows = await db.rAJob.findMany({
        where: {
          market: q.market,
          visibility: 'public',
          isCanonical: true,
          archivedAt: null,
          closedAt: null,
          AND: [
            { OR: titleOr },
            ...(placeOr.length && q.countries.length ? [{ OR: placeOr }] : []),
            ...(cityOr.length ? [{ OR: cityOr }] : []),
            ...(q.market === 'cn' ? [CANDIDATE_NOT_FRAUD_FLAGGED] : []),
          ],
        },
        select: { id: true },
        orderBy: { postedAt: 'desc' },
        take: q.limit,
      });
      return rows.map((r) => r.id);
    },
  };
}
