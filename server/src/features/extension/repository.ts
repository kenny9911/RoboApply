// server/src/features/extension/repository.ts — database reads and writes of
// the extension area (WP-55a). Typed Prisma only.
//
//   RAExtensionDevice   paired installs (token stored hashed, revocable)
//   RAAuthToken         pair codes (kind 'ext_pair', single use, 10 min)
//   RAAutofillRun       one "Fill this form" run (credit reservation id)
//   RASiteRequest       "Support this site" requests (origin + path only)
//   RASurveyResponse    uninstall survey (kind 'ext_uninstall')
// Jobs, tracker entries and resumes are only READ here; writes to them go
// through their areas' services (import, tracker, resume export).

import prisma from '../../lib/prisma.js';

export interface DeviceRow {
  id: string;
  userId: string;
  brand: string;
  tokenPrefix: string;
  name: string;
  browser: string | null;
  extVersion: string | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface DeviceWithUser extends DeviceRow {
  user: { id: string; email: string; brand: string; role: string; isActive: boolean };
}

export interface RunRow {
  id: string;
  userId: string;
  deviceId: string;
  jobId: string | null;
  trackerEntryId: string | null;
  host: string;
  /**
   * The page the run belongs to (SCHEMA-6): the URL without its query string,
   * plus `#job=<hash>` when the query named the job (service `runPageKey`).
   * Null on runs from before the column.
   */
  pageUrl: string | null;
  atsType: string;
  fieldsTotal: number;
  fieldsFilled: number;
  aiAnswers: number;
  outcome: string;
  userMarkedSubmitted: boolean;
  creditLedgerId: string | null;
  createdAt: Date;
}

/** The job fields the extension reads (visibility and market checks, prompts). */
export interface ExtJobRow {
  id: string;
  market: string;
  visibility: string;
  ownerUserId: string | null;
  sourceBoard: string;
  title: string;
  companyName: string;
  archivedAt: Date | null;
}

export interface ResumeChoice {
  id: string;
  name: string;
}

export interface ExtensionRepo {
  createDevice(input: { userId: string; brand: string; tokenHash: string; tokenPrefix: string; name: string; browser: string | null; extVersion: string | null }): Promise<DeviceRow>;
  listDevices(userId: string, brand: string): Promise<DeviceRow[]>;
  /** Sets revokedAt on the user's own live device; false when there is none. */
  revokeDevice(userId: string, brand: string, id: string, now: Date): Promise<boolean>;
  findDeviceByTokenHash(tokenHash: string): Promise<DeviceWithUser | null>;
  touchDevice(id: string, now: Date, extVersion?: string | null): Promise<void>;

  createPairCode(input: { userId: string; brand: string; tokenHash: string; expiresAt: Date }): Promise<void>;
  /** Single use: marks the code consumed and returns its user, or null (unknown, used, expired, other brand). */
  consumePairCode(tokenHash: string, brand: string, now: Date): Promise<{ userId: string } | null>;
  userBrand(userId: string): Promise<{ id: string; email: string; brand: string; isActive: boolean } | null>;

  /** A live job in this market the user may see whose apply or posting URL is one of `urls`. */
  findJobByUrls(input: { market: string; userId: string; urls: string[]; cnWhere?: { OR: Array<Record<string, unknown>> } | null }): Promise<ExtJobRow | null>;
  loadJob(jobId: string): Promise<ExtJobRow | null>;

  createRun(input: Omit<RunRow, 'id' | 'fieldsFilled' | 'aiAnswers' | 'outcome' | 'userMarkedSubmitted' | 'createdAt'>): Promise<RunRow>;
  getRun(userId: string, id: string): Promise<RunRow | null>;
  /**
   * The newest run of the same application (R4): same user, device and host,
   * started at or after `since`, not marked as submitted, and for the same
   * job — or, when `jobId` is null, for the same `pageUrl` with no job linked.
   * Null when neither key is given.
   */
  findReusableRun(input: { userId: string; deviceId: string; host: string; jobId: string | null; pageUrl: string | null; since: Date }): Promise<RunRow | null>;
  /** The run an idempotent retry already created for this credit reservation. */
  findRunByLedger(userId: string, creditLedgerId: string): Promise<RunRow | null>;
  updateRun(id: string, data: Partial<Pick<RunRow, 'fieldsFilled' | 'fieldsTotal' | 'outcome' | 'userMarkedSubmitted' | 'trackerEntryId' | 'jobId' | 'creditLedgerId'>>): Promise<RunRow>;
  incrementAiAnswers(id: string): Promise<void>;

  trackerEntryFor(userId: string, jobId: string): Promise<string | null>;
  /** The newest tailored copy for the job (none when `jobId` is null) and the user's main resume (live rows only). */
  resumesFor(userId: string, jobId: string | null): Promise<{ tailored: ResumeChoice | null; primary: ResumeChoice | null }>;
  linkArtifactToRun(artifactId: string, runId: string): Promise<void>;

  createSiteRequest(input: { userId: string; host: string; url: string; note: string | null }): Promise<void>;
  createUninstallSurvey(input: { brand: string; userId: string | null; answers: { reasons: string[]; note?: string } }): Promise<void>;
}

const DEVICE_SELECT = {
  id: true,
  userId: true,
  brand: true,
  tokenPrefix: true,
  name: true,
  browser: true,
  extVersion: true,
  lastSeenAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

const RUN_SELECT = {
  id: true,
  userId: true,
  deviceId: true,
  jobId: true,
  trackerEntryId: true,
  host: true,
  pageUrl: true,
  atsType: true,
  fieldsTotal: true,
  fieldsFilled: true,
  aiAnswers: true,
  outcome: true,
  userMarkedSubmitted: true,
  creditLedgerId: true,
  createdAt: true,
} as const;

const JOB_SELECT = {
  id: true,
  market: true,
  visibility: true,
  ownerUserId: true,
  sourceBoard: true,
  title: true,
  companyName: true,
  archivedAt: true,
} as const;

export function createPrismaExtensionRepo(db: typeof prisma = prisma): ExtensionRepo {
  return {
    async createDevice(input) {
      return db.rAExtensionDevice.create({ data: input, select: DEVICE_SELECT });
    },
    async listDevices(userId, brand) {
      return db.rAExtensionDevice.findMany({ where: { userId, brand, revokedAt: null }, orderBy: { createdAt: 'desc' }, take: 50, select: DEVICE_SELECT });
    },
    async revokeDevice(userId, brand, id, now) {
      const out = await db.rAExtensionDevice.updateMany({ where: { id, userId, brand, revokedAt: null }, data: { revokedAt: now } });
      return out.count > 0;
    },
    async findDeviceByTokenHash(tokenHash) {
      return db.rAExtensionDevice.findUnique({
        where: { tokenHash },
        select: { ...DEVICE_SELECT, user: { select: { id: true, email: true, brand: true, role: true, isActive: true } } },
      });
    },
    async touchDevice(id, now, extVersion) {
      await db.rAExtensionDevice.update({ where: { id }, data: { lastSeenAt: now, ...(extVersion ? { extVersion } : {}) } });
    },

    async createPairCode(input) {
      await db.rAAuthToken.create({ data: { userId: input.userId, brand: input.brand, kind: 'ext_pair', tokenHash: input.tokenHash, expiresAt: input.expiresAt } });
    },
    async consumePairCode(tokenHash, brand, now) {
      const row = await db.rAAuthToken.findUnique({ where: { tokenHash }, select: { id: true, userId: true, kind: true, brand: true } });
      if (!row || row.kind !== 'ext_pair' || row.brand !== brand || !row.userId) return null;
      const claimed = await db.rAAuthToken.updateMany({ where: { id: row.id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } });
      return claimed.count === 1 ? { userId: row.userId } : null;
    },
    async userBrand(userId) {
      return db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, brand: true, isActive: true } });
    },

    async findJobByUrls({ market, userId, urls, cnWhere }) {
      const clean = [...new Set(urls.filter(Boolean))];
      if (!clean.length) return null;
      return db.rAJob.findFirst({
        where: {
          AND: [
            { market, archivedAt: null },
            { OR: [{ applyUrl: { in: clean } }, { sourceUrl: { in: clean } }] },
            cnWhere ?? { OR: [{ visibility: 'public', isCanonical: true }, { visibility: 'private', ownerUserId: userId }] },
          ],
        },
        // The user's own copy first, then the newest public posting.
        orderBy: [{ ownerUserId: { sort: 'asc', nulls: 'last' } }, { firstSeenAt: 'desc' }],
        select: JOB_SELECT,
      });
    },
    async loadJob(jobId) {
      return db.rAJob.findUnique({ where: { id: jobId }, select: JOB_SELECT });
    },

    async createRun(input) {
      return db.rAAutofillRun.create({ data: input, select: RUN_SELECT });
    },
    async getRun(userId, id) {
      return db.rAAutofillRun.findFirst({ where: { id, userId }, select: RUN_SELECT });
    },
    async findReusableRun({ userId, deviceId, host, jobId, pageUrl, since }) {
      if (!jobId && !pageUrl) return null;
      return db.rAAutofillRun.findFirst({
        where: { userId, deviceId, host, userMarkedSubmitted: false, createdAt: { gte: since }, ...(jobId ? { jobId } : { jobId: null, pageUrl }) },
        orderBy: { createdAt: 'desc' },
        select: RUN_SELECT,
      });
    },
    async findRunByLedger(userId, creditLedgerId) {
      return db.rAAutofillRun.findFirst({ where: { userId, creditLedgerId }, select: RUN_SELECT });
    },
    async updateRun(id, data) {
      return db.rAAutofillRun.update({ where: { id }, data, select: RUN_SELECT });
    },
    async incrementAiAnswers(id) {
      await db.rAAutofillRun.update({ where: { id }, data: { aiAnswers: { increment: 1 } } });
    },

    async trackerEntryFor(userId, jobId) {
      const row = await db.rATrackerEntry.findFirst({ where: { userId, jobId, deletedAt: null }, select: { id: true } });
      return row?.id ?? null;
    },
    async resumesFor(userId, jobId) {
      const [tailored, primary] = await Promise.all([
        jobId
          ? db.rAResumeVariant.findFirst({ where: { userId, targetJobId: jobId, deletedAt: null }, orderBy: { lastEditedAt: 'desc' }, select: { id: true, name: true } })
          : Promise.resolve(null),
        db.rAResumeVariant.findFirst({
          where: { userId, deletedAt: null, targetJobId: null },
          orderBy: [{ isPrimary: 'desc' }, { lastEditedAt: 'desc' }],
          select: { id: true, name: true },
        }),
      ]);
      return { tailored, primary };
    },
    async linkArtifactToRun(artifactId, runId) {
      await db.rAApplicationArtifact.update({ where: { id: artifactId }, data: { autofillRunId: runId } });
    },

    async createSiteRequest(input) {
      await db.rASiteRequest.create({ data: input });
    },
    async createUninstallSurvey(input) {
      await db.rASurveyResponse.create({ data: { brand: input.brand, kind: 'ext_uninstall', userId: input.userId, answers: input.answers } });
    },
  };
}
