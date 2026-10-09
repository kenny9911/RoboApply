// server/src/features/profile/service.ts
//
// The profile service (ARCHITECTURE.md §2.7/§3.3; TASK_PLAN.md WP-19).
//
//   get / patch                     RAProfile (+ derived completeness, missing fields, availability)
//   education / experience CRUD     RAProfileEducation / RAProfileExperience (owner-scoped)
//   putSkills                       RAProfile.skills
//   getSensitive / putSensitive     RASensitiveAnswers (AES-GCM, owner only)
//   syncPreview / syncApply         resume → profile, reviewed field by field
//   snapshotForLlm                  the only profile text a prompt may contain
//   sensitiveForAutofill            decrypted answers for the extension, consent `autofill_sensitive` only
//
// Every write recomputes `completeness` (which also bumps `updatedAt`, the
// snapshot cache key). Brand comes from the caller (the request's brand);
// market rules: cnFields + 籍贯/政治面貌/家庭成员/photo on GoApply only;
// workAuth, Taiwan fields and EEO answers on RoboApply only; EEO also needs
// the `eeoAnswers` flag; the photo is refused in CN-0 (DEPLOY_REGION is not
// cn-mainland), where GoApply stores no photo at all (WP-15 rule).

import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { HttpError } from '../../platform/http.js';
import { brandOfUser, getBrand, getCurrentBrandOrDefault, type ProductBrand } from '../../platform/brand/index.js';
import { hasLiveConsent } from '../../platform/consent/index.js';
import { isEnabled } from '../../platform/flags.js';
import { CnProfileFieldsSchema } from '../onboarding-cn/index.js';
import { hasTwAnswers } from '../tw/index.js';
import {
  CN_FIELDS_REFUSED_KEYS,
  PROFILE_ERROR_CODES,
  type EducationBodySchema,
  type EducationPatchSchema,
  type ExperienceBodySchema,
  type ExperiencePatchSchema,
  type ProfileAvailability,
  type ProfilePatchSchema,
  type ProfileSnapshotForLlm,
  type ProfileView,
  type PutSkillsBodySchema,
  type SensitiveAnswers,
  type SensitiveAnswersView,
  type SyncFromResumeResponse,
} from './contract.js';
import { computeCompleteness } from './completeness.js';
import { isPlainObject, toCore, toEducationView, toExperienceView, type Market, type ProfileCore } from './model.js';
import { StaleDiffError, diffProfile, planAccepted, proposeFromResume } from './resumeSync.js';
import { openSensitive, sealSensitive, sensitiveCryptoConfigured, type CryptoEnv } from './sensitiveCrypto.js';
import { buildSnapshotText, snapshotCacheKey } from './snapshot.js';
import { createTwFieldsStore, type TwFieldsStore } from './twFieldsStore.js';
import { z } from 'zod';

export type ProfileDb = Pick<
  ExtendedPrismaClient,
  'rAProfile' | 'rAProfileEducation' | 'rAProfileExperience' | 'rASensitiveAnswers' | 'rAResumeVariant' | '$transaction'
>;

export interface ProfileContext {
  brand: ProductBrand;
}

export interface ProfileServiceDeps {
  getDb?: () => Promise<ProfileDb>;
  env?: CryptoEnv;
  twFields?: TwFieldsStore;
  /** `eeoAnswers` flag for this user and brand (default: platform/flags isEnabled). */
  eeoEnabled?: (userId: string, brand: ProductBrand) => Promise<boolean>;
  /** Live consent check (default: platform/consent hasLiveConsent). */
  hasConsent?: (userId: string, type: 'autofill_sensitive') => Promise<boolean>;
  /** Operational warning sink (default: LoggerService, loaded lazily). Never receives answers. */
  warn?: (message: string, meta: Record<string, unknown>) => void;
}

type In<S extends z.ZodType> = z.output<S>;

const defaultGetDb = async (): Promise<ProfileDb> => (await import('../../lib/prisma.js')).default;

const rowNotFound = () => new HttpError('not_found', 'This entry was not found.', { reason: PROFILE_ERROR_CODES.rowNotFound });
const notAvailable = (field: string) =>
  new HttpError('invalid_request', `${field} is not available here.`, { reason: PROFILE_ERROR_CODES.fieldNotAvailable, field });

/** '' → null; undefined stays undefined (field not sent). */
const blankToNull = (v: string | undefined): string | null | undefined => (v === undefined ? undefined : v.trim() === '' ? null : v.trim());
const ym = (v: string | undefined | null): string | null | undefined => (v === undefined ? undefined : v === null || v === '' ? null : v.slice(0, 7));

export function isCnMainlandDeployment(env: CryptoEnv): boolean {
  return env.DEPLOY_REGION === 'cn-mainland';
}

/**
 * What the plaintext `RAProfile.cnFields` column may hold: onboarding-cn's
 * documented keys only (its schema is `.passthrough()`; this copy strips), with
 * strings bounded.
 */
const CnFieldsStoreSchema = z
  .object({
    ...CnProfileFieldsSchema.shape,
    schoolName: z.string().max(120).optional(),
    schoolTags: z.array(z.string().max(40)).max(20).optional(),
    major: z.string().max(120).optional(),
    availableFrom: z.string().max(40).optional(),
  })
  .strip();
const CN_FIELD_KEYS = new Set(Object.keys(CnFieldsStoreSchema.shape));
type CnProfileFields = z.output<typeof CnFieldsStoreSchema>;

function dropNulls(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));
}

function isEmptyAnswers(a: SensitiveAnswers): boolean {
  const has = (o: Record<string, unknown> | undefined) =>
    !!o && Object.values(o).some((v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v !== undefined && v !== null));
  return !has(a.eeo) && !has(a.cn);
}

export function createProfileService(deps: ProfileServiceDeps = {}) {
  const getDb = deps.getDb ?? defaultGetDb;
  const env = deps.env ?? process.env;
  const tw = deps.twFields ?? createTwFieldsStore();
  const eeoEnabled = deps.eeoEnabled ?? ((userId: string, brand: ProductBrand) => isEnabled('eeoAnswers', { userId, brand }));
  const hasConsent = deps.hasConsent ?? ((userId: string, type: 'autofill_sensitive') => hasLiveConsent(userId, type));
  const warn =
    deps.warn ??
    ((message: string, meta: Record<string, unknown>) => {
      void import('../../services/LoggerService.js').then(({ logger }) => logger.warn('PROFILE', message, meta)).catch(() => undefined);
    });

  async function availability(userId: string, brand: ProductBrand): Promise<ProfileAvailability> {
    const market: Market = brand.market;
    return {
      market,
      twFields: market === 'intl' && tw.available,
      eeo: market === 'intl' && (await eeoEnabled(userId, brand)),
      cnSensitive: market === 'cn',
      cnPhoto: market === 'cn' && isCnMainlandDeployment(env),
    };
  }

  async function loadCore(db: ProfileDb, userId: string): Promise<{ core: ProfileCore; exists: boolean }> {
    const [row, education, experience] = await Promise.all([
      db.rAProfile.findUnique({ where: { userId } }),
      db.rAProfileEducation.findMany({ where: { userId } }),
      db.rAProfileExperience.findMany({ where: { userId } }),
    ]);
    return { core: toCore(userId, row, education, experience, tw.read(row)), exists: row !== null };
  }

  async function view(db: ProfileDb, userId: string, ctx: ProfileContext): Promise<ProfileView> {
    const { core } = await loadCore(db, userId);
    const { completeness, missing } = computeCompleteness(core, ctx.brand.market);
    return { ...core, completeness, missing, availability: await availability(userId, ctx.brand) };
  }

  /** Write `data` (may be empty) and the recomputed completeness in one upsert. */
  async function save(db: ProfileDb, userId: string, ctx: ProfileContext, data: Prisma.RAProfileUncheckedUpdateInput): Promise<ProfileView> {
    // Completeness is computed on the profile as it will be after this write.
    const { core } = await loadCore(db, userId);
    const next = applyLocal(core, data);
    const { completeness } = computeCompleteness(next, ctx.brand.market);
    const update = { ...data, completeness };
    await db.rAProfile.upsert({
      where: { userId },
      create: { ...(update as Prisma.RAProfileUncheckedCreateInput), userId },
      update,
    });
    return view(db, userId, ctx);
  }

  /** Recompute completeness after a row change (touches updatedAt). */
  const refresh = (db: ProfileDb, userId: string, ctx: ProfileContext) => save(db, userId, ctx, {});

  async function ownedEducation(db: ProfileDb, userId: string, id: string) {
    const row = await db.rAProfileEducation.findFirst({ where: { id, userId } });
    if (!row) throw rowNotFound();
    return row;
  }
  async function ownedExperience(db: ProfileDb, userId: string, id: string) {
    const row = await db.rAProfileExperience.findFirst({ where: { id, userId } });
    if (!row) throw rowNotFound();
    return row;
  }

  /**
   * Merge a cnFields PATCH with what is stored and keep only the documented
   * keys. Sensitive keys (籍贯, 政治面貌, family, photo, gender, birth date)
   * are refused: they belong in the encrypted sensitive answers, never in this
   * plaintext column. Unknown keys are refused too; unknown keys already stored
   * are dropped on the next write.
   */
  async function mergeCnFields(db: ProfileDb, userId: string, patch: Record<string, unknown>): Promise<CnProfileFields> {
    const refused = Object.keys(patch).filter((k) => (CN_FIELDS_REFUSED_KEYS as readonly string[]).includes(k));
    if (refused.length) throw notAvailable(`cnFields.${refused[0]}`);
    const unknown = Object.keys(patch).filter((k) => !CN_FIELD_KEYS.has(k));
    if (unknown.length) {
      throw new HttpError('invalid_request', 'Some background answers are not valid.', {
        issues: unknown.map((k) => ({ path: `cnFields.${k}`, message: 'Unknown field.' })),
      });
    }
    const existing = (await db.rAProfile.findUnique({ where: { userId }, select: { cnFields: true } }))?.cnFields;
    const merged = dropNulls({ ...(isPlainObject(existing) ? existing : {}), ...patch });
    const parsed = CnFieldsStoreSchema.safeParse(merged);
    if (!parsed.success) {
      throw new HttpError('invalid_request', 'Some background answers are not valid.', {
        issues: parsed.error.issues.map((i) => ({ path: ['cnFields', ...i.path.map(String)].join('.'), message: i.message })),
      });
    }
    return parsed.data;
  }

  /**
   * The stored answers. A row that cannot be decrypted (e.g. sealed with a key
   * older than the previous one) is reported as `unreadable` with no answers,
   * so the owner can still re-enter or delete them; a save overwrites the row.
   */
  async function readSensitive(db: ProfileDb, userId: string): Promise<{ answers: SensitiveAnswers; updatedAt: string | null; unreadable: boolean }> {
    const row = await db.rASensitiveAnswers.findUnique({ where: { userId } });
    if (!row) return { answers: {}, updatedAt: null, unreadable: false };
    const updatedAt = row.updatedAt.toISOString();
    if (!sensitiveCryptoConfigured(env)) return { answers: {}, updatedAt, unreadable: true };
    try {
      const answers = openSensitive<SensitiveAnswers>(userId, { ciphertext: row.ciphertext, keyVersion: row.keyVersion }, env);
      return { answers: isPlainObject(answers) ? answers : {}, updatedAt, unreadable: false };
    } catch (err) {
      warn('sensitive answers could not be decrypted', { userId, keyVersion: row.keyVersion, error: err instanceof Error ? err.message : 'unknown' });
      return { answers: {}, updatedAt, unreadable: true };
    }
  }

  return {
    availability,

    async get(userId: string, ctx: ProfileContext): Promise<ProfileView> {
      return view(await getDb(), userId, ctx);
    },

    async patch(userId: string, body: In<typeof ProfilePatchSchema>, ctx: ProfileContext): Promise<ProfileView> {
      const db = await getDb();
      const market = ctx.brand.market;
      const data: Prisma.RAProfileUncheckedUpdateInput = {};
      for (const key of ['firstName', 'middleName', 'lastName', 'headline', 'addressLine1', 'city', 'region', 'postalCode', 'summary'] as const) {
        const v = blankToNull(body[key]);
        if (v !== undefined) data[key] = v;
      }
      if (body.contactEmail !== undefined) data.contactEmail = body.contactEmail === null ? null : body.contactEmail.trim().toLowerCase();
      if (body.phoneE164 !== undefined) data.phoneE164 = body.phoneE164;
      if (body.phoneType !== undefined) data.phoneType = body.phoneType;
      if (body.country !== undefined) data.country = body.country;
      if (body.links !== undefined) {
        if (market === 'cn' && body.links.linkedin) throw notAvailable('links.linkedin');
        data.links = dropNulls(body.links) as Prisma.InputJsonValue;
      }
      if (body.languages !== undefined) data.languages = body.languages as Prisma.InputJsonValue;
      if (body.workAuth !== undefined) {
        if (market !== 'intl') throw notAvailable('workAuth');
        // The 工作許可 answer belongs to the Taiwan row only.
        data.workAuth = body.workAuth.map((w) => (w.country === 'TW' ? w : { country: w.country, authorized: w.authorized, sponsorship: w.sponsorship })) as Prisma.InputJsonValue;
      }
      if (body.cnFields !== undefined) {
        if (market !== 'cn') throw notAvailable('cnFields');
        data.cnFields = (await mergeCnFields(db, userId, body.cnFields)) as Prisma.InputJsonValue;
      }
      if (body.twFields !== undefined) {
        if (market !== 'intl') throw notAvailable('twFields');
        Object.assign(data, tw.data(body.twFields && hasTwAnswers(body.twFields) ? body.twFields : null));
      }
      return save(db, userId, ctx, data);
    },

    async addEducation(userId: string, body: In<typeof EducationBodySchema>, ctx: ProfileContext) {
      const db = await getDb();
      const sortOrder = await db.rAProfileEducation.count({ where: { userId } });
      const row = await db.rAProfileEducation.create({
        data: {
          userId,
          school: body.school.trim(),
          degree: blankToNull(body.degree) ?? null,
          major: blankToNull(body.major) ?? null,
          gpa: blankToNull(body.gpa) ?? null,
          startYm: ym(body.startDate) ?? null,
          endYm: body.current ? null : (ym(body.endDate) ?? null),
          current: body.current ?? false,
          location: blankToNull(body.location) ?? null,
          sortOrder,
        },
      });
      await refresh(db, userId, ctx);
      return toEducationView(row);
    },

    async updateEducation(userId: string, id: string, body: In<typeof EducationPatchSchema>, ctx: ProfileContext) {
      const db = await getDb();
      await ownedEducation(db, userId, id);
      const data: Prisma.RAProfileEducationUncheckedUpdateInput = {};
      if (body.school !== undefined) data.school = body.school.trim();
      for (const key of ['degree', 'major', 'gpa', 'location'] as const) {
        const v = blankToNull(body[key]);
        if (v !== undefined) data[key] = v;
      }
      if (body.startDate !== undefined) data.startYm = ym(body.startDate);
      if (body.endDate !== undefined) data.endYm = ym(body.endDate);
      if (body.current !== undefined) {
        data.current = body.current;
        if (body.current) data.endYm = null;
      }
      const row = await db.rAProfileEducation.update({ where: { id }, data });
      await refresh(db, userId, ctx);
      return toEducationView(row);
    },

    async deleteEducation(userId: string, id: string, ctx: ProfileContext): Promise<void> {
      const db = await getDb();
      await ownedEducation(db, userId, id);
      await db.rAProfileEducation.delete({ where: { id } });
      await refresh(db, userId, ctx);
    },

    async addExperience(userId: string, body: In<typeof ExperienceBodySchema>, ctx: ProfileContext) {
      const db = await getDb();
      const sortOrder = await db.rAProfileExperience.count({ where: { userId } });
      const row = await db.rAProfileExperience.create({
        data: {
          userId,
          company: body.company.trim(),
          title: body.title.trim(),
          location: blankToNull(body.location) ?? null,
          startYm: ym(body.startDate) ?? null,
          endYm: body.current ? null : (ym(body.endDate) ?? null),
          current: body.current ?? false,
          summary: blankToNull(body.description) ?? null,
          bullets: body.bullets ?? [],
          kind: body.kind ?? 'work',
          employmentType: blankToNull(body.employmentType) ?? null,
          sortOrder,
        },
      });
      await refresh(db, userId, ctx);
      return toExperienceView(row);
    },

    async updateExperience(userId: string, id: string, body: In<typeof ExperiencePatchSchema>, ctx: ProfileContext) {
      const db = await getDb();
      await ownedExperience(db, userId, id);
      const data: Prisma.RAProfileExperienceUncheckedUpdateInput = {};
      if (body.company !== undefined) data.company = body.company.trim();
      if (body.title !== undefined) data.title = body.title.trim();
      const loc = blankToNull(body.location);
      if (loc !== undefined) data.location = loc;
      const desc = blankToNull(body.description);
      if (desc !== undefined) data.summary = desc;
      const et = blankToNull(body.employmentType);
      if (et !== undefined) data.employmentType = et;
      if (body.bullets !== undefined) data.bullets = body.bullets;
      if (body.kind !== undefined) data.kind = body.kind;
      if (body.startDate !== undefined) data.startYm = ym(body.startDate);
      if (body.endDate !== undefined) data.endYm = ym(body.endDate);
      if (body.current !== undefined) {
        data.current = body.current;
        if (body.current) data.endYm = null;
      }
      const row = await db.rAProfileExperience.update({ where: { id }, data });
      await refresh(db, userId, ctx);
      return toExperienceView(row);
    },

    async deleteExperience(userId: string, id: string, ctx: ProfileContext): Promise<void> {
      const db = await getDb();
      await ownedExperience(db, userId, id);
      await db.rAProfileExperience.delete({ where: { id } });
      await refresh(db, userId, ctx);
    },

    async putSkills(userId: string, body: In<typeof PutSkillsBodySchema>, ctx: ProfileContext): Promise<ProfileView> {
      const seen = new Set<string>();
      const skills = body.skills.filter((s) => {
        const k = s.name.trim().toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      return save(await getDb(), userId, ctx, { skills: skills as Prisma.InputJsonValue });
    },

    async getSensitive(userId: string, ctx: ProfileContext): Promise<SensitiveAnswersView> {
      const db = await getDb();
      const { answers, updatedAt, unreadable } = await readSensitive(db, userId);
      const a = await availability(userId, ctx.brand);
      return {
        answers,
        configured: sensitiveCryptoConfigured(env),
        availability: { market: a.market, eeo: a.eeo, cnSensitive: a.cnSensitive, cnPhoto: a.cnPhoto },
        updatedAt,
        unreadable,
      };
    },

    async putSensitive(userId: string, body: SensitiveAnswers, ctx: ProfileContext): Promise<SensitiveAnswersView> {
      const db = await getDb();
      const a = await availability(userId, ctx.brand);
      if (body.eeo && !a.eeo) throw new HttpError('feature_disabled');
      if (body.cn && !a.cnSensitive) throw notAvailable('cn');
      if (body.cn?.photoAssetId && !a.cnPhoto) throw notAvailable('cn.photoAssetId');
      const availabilityView = { market: a.market, eeo: a.eeo, cnSensitive: a.cnSensitive, cnPhoto: a.cnPhoto };

      if (isEmptyAnswers(body)) {
        await db.rASensitiveAnswers.deleteMany({ where: { userId } });
        return { answers: {}, configured: sensitiveCryptoConfigured(env), availability: availabilityView, updatedAt: null, unreadable: false };
      }
      if (!sensitiveCryptoConfigured(env)) {
        throw new HttpError('provider_not_configured', 'Sensitive answers cannot be saved on this deployment.', {
          reason: PROFILE_ERROR_CODES.sensitiveNotConfigured,
        });
      }
      const sealed = sealSensitive(userId, body, env);
      const row = await db.rASensitiveAnswers.upsert({
        where: { userId },
        create: { userId, ciphertext: sealed.ciphertext, keyVersion: sealed.keyVersion },
        update: { ciphertext: sealed.ciphertext, keyVersion: sealed.keyVersion },
      });
      return { answers: body, configured: true, availability: availabilityView, updatedAt: row.updatedAt.toISOString(), unreadable: false };
    },

    async syncPreview(userId: string, variantId: string, ctx: ProfileContext): Promise<SyncFromResumeResponse> {
      const db = await getDb();
      const variant = await db.rAResumeVariant.findFirst({ where: { id: variantId, userId, deletedAt: null }, select: { id: true, parsedData: true } });
      if (!variant) throw new HttpError('not_found', 'This resume was not found.', { reason: PROFILE_ERROR_CODES.resumeNotFound });
      const { core } = await loadCore(db, userId);
      const proposal = proposeFromResume(variant.parsedData, { market: ctx.brand.market, country: core.country });
      if (!proposal) return { variantId, parsed: false, diff: [] };
      return { variantId, parsed: true, diff: diffProfile(core, proposal, ctx.brand.market) };
    },

    async syncApply(userId: string, variantId: string, accept: readonly string[], ctx: ProfileContext): Promise<ProfileView> {
      const db = await getDb();
      const variant = await db.rAResumeVariant.findFirst({ where: { id: variantId, userId, deletedAt: null }, select: { id: true, parsedData: true } });
      if (!variant) throw new HttpError('not_found', 'This resume was not found.', { reason: PROFILE_ERROR_CODES.resumeNotFound });
      const { core } = await loadCore(db, userId);
      const proposal = proposeFromResume(variant.parsedData, { market: ctx.brand.market, country: core.country });
      const diff = proposal ? diffProfile(core, proposal, ctx.brand.market) : [];
      let plan;
      try {
        plan = planAccepted(core, diff, accept);
      } catch (err) {
        if (err instanceof StaleDiffError) {
          throw new HttpError('conflict', 'The resume or profile changed. Review the changes again.', { reason: PROFILE_ERROR_CODES.staleDiff, paths: err.paths });
        }
        throw err;
      }

      const data: Prisma.RAProfileUncheckedUpdateInput = { ...plan.fields, syncedFromVariantId: variantId };
      if (plan.links) data.links = dropNulls({ ...core.links, ...plan.links }) as Prisma.InputJsonValue;
      if (plan.skills) data.skills = plan.skills as Prisma.InputJsonValue;
      if (plan.languages) data.languages = plan.languages as Prisma.InputJsonValue;

      await db.$transaction(async (tx) => {
        let eduOrder = await tx.rAProfileEducation.count({ where: { userId } });
        for (const e of plan.education) {
          await tx.rAProfileEducation.create({
            data: { userId, school: e.school, degree: e.degree, major: e.major, gpa: e.gpa, startYm: e.startDate, endYm: e.endDate, current: e.current, sortOrder: eduOrder++ },
          });
        }
        let expOrder = await tx.rAProfileExperience.count({ where: { userId } });
        for (const x of plan.experience) {
          await tx.rAProfileExperience.create({
            data: {
              userId,
              company: x.company,
              title: x.title,
              location: x.location,
              startYm: x.startDate,
              endYm: x.endDate,
              current: x.current,
              summary: x.description,
              bullets: x.bullets,
              kind: x.kind,
              employmentType: x.employmentType,
              sortOrder: expOrder++,
            },
          });
        }
      });
      return save(db, userId, ctx, data);
    },

    async completeness(userId: string, ctx: ProfileContext) {
      const { core } = await loadCore(await getDb(), userId);
      return computeCompleteness(core, ctx.brand.market);
    },

    /** Never reads RASensitiveAnswers. See snapshot.ts for what the text may contain. */
    async snapshotForLlm(userId: string, ctx: ProfileContext): Promise<ProfileSnapshotForLlm> {
      const db = await getDb();
      const [{ core }, primary] = await Promise.all([
        loadCore(db, userId),
        db.rAResumeVariant.findFirst({ where: { userId, isPrimary: true, deletedAt: null }, select: { resumeContentHash: true } }),
      ]);
      return { text: buildSnapshotText(core, ctx.brand.market), cacheKey: snapshotCacheKey(core.updatedAt, primary?.resumeContentHash ?? null) };
    },

    /** Decrypted answers for the extension's autofill payload; null without a live `autofill_sensitive` consent. */
    async sensitiveForAutofill(userId: string): Promise<SensitiveAnswers | null> {
      if (!(await hasConsent(userId, 'autofill_sensitive'))) return null;
      const { answers, updatedAt, unreadable } = await readSensitive(await getDb(), userId);
      return updatedAt && !unreadable ? answers : null;
    },
  };
}

export type ProfileServiceImpl = ReturnType<typeof createProfileService>;

/** The brand for a bare user id: the stored User.brand, else the request's brand context. */
export async function brandForUser(userId: string): Promise<ProductBrand> {
  const stored = await brandOfUser(userId).catch(() => null);
  return stored ? getBrand(stored) : getCurrentBrandOrDefault();
}

/** Apply an update to the in-memory profile, for computing completeness before the write lands. */
function applyLocal(core: ProfileCore, data: Prisma.RAProfileUncheckedUpdateInput): ProfileCore {
  const next: ProfileCore = { ...core };
  const rec = data as Record<string, unknown>;
  for (const key of ['firstName', 'middleName', 'lastName', 'headline', 'contactEmail', 'phoneE164', 'city', 'country', 'summary'] as const) {
    if (key in rec) next[key] = (rec[key] as string | null) ?? null;
  }
  if (Array.isArray(rec.skills)) next.skills = rec.skills as ProfileCore['skills'];
  if (Array.isArray(rec.languages)) next.languages = rec.languages as ProfileCore['languages'];
  if (Array.isArray(rec.workAuth)) next.workAuth = rec.workAuth as ProfileCore['workAuth'];
  if (isPlainObject(rec.links)) next.links = rec.links as ProfileCore['links'];
  if (isPlainObject(rec.cnFields)) next.cnFields = rec.cnFields;
  return next;
}
