// server/src/features/coaching/service.ts
//
// Coaching roster + booking requests (TASK_PLAN.md WP-72; PRODUCT_PLAN.md
// §5.14 F-COACH-01/02/05).
//
//   listActive(brand, query)   the brand's listed coaches (active only)
//   get(brand, id)             one listed coach (404 coach_not_found otherwise)
//   hasActiveCoaches(brand)    drives the nav entry and every upsell
//   request(brand, user, id)   emails the request to the coach (Reply-To: the
//                              user) and a copy to the brand's coaching admin
//                              inbox; nothing is stored, nothing is charged
//   admin*                     roster management (staff add real coaches who
//                              agreed to be listed)
//
// Honesty (D3): every field shown comes from the roster row staff entered.
// `rating` is null: V2 records no coaching sessions, so there are no real
// post-session ratings to show. Prices are the coach's own; the user pays the
// coach directly and the platform takes no coaching payment on any rail (no
// `coaching` purpose exists on the CN rails, ARCH §2.2 / OPS C-13).

import type { Prisma } from '../../generated/prisma/client.js';
import { addressOf, sendEmail, type SendEmailInput, type SendEmailResult } from '../../platform/email/index.js';
import { brandEnv, type EnvSource } from '../../platform/brand/brandEnv.js';
import { getBrand, type BrandId, type ProductBrand } from '../../platform/brand/registry.js';
import { HttpError } from '../../platform/http.js';
import { logger } from '../../services/LoggerService.js';
import {
  COACHING_ERROR_CODES,
  type AdminCoachView,
  type CoachRequestResponse,
  type CoachSessionOption,
  type CoachView,
} from './contract.js';
import type { z } from 'zod';
import type { AdminCoachesQuerySchema, CoachBodySchema, CoachRequestBodySchema, ListCoachesQuerySchema, PatchCoachBodySchema } from './contract.js';
// Importing the template module registers `coaching.booking_request`.
import { COACHING_BOOKING_REQUEST_TEMPLATE, type CoachingRequestEmailParams } from '../../platform/email/templates/coaching/index.js';

export type ListCoachesQuery = z.output<typeof ListCoachesQuerySchema>;
export type CoachRequestBody = z.output<typeof CoachRequestBodySchema>;
export type CoachBody = z.output<typeof CoachBodySchema>;
export type PatchCoachBody = z.output<typeof PatchCoachBodySchema>;
export type AdminCoachesQuery = z.output<typeof AdminCoachesQuerySchema>;

/**
 * The Prisma delegates this area uses (typed; tests pass a fake): the roster,
 * and a read of `User` (linked-account checks; the requester's own address).
 */
export type CoachingDb = Pick<Prisma.TransactionClient, 'rACoach' | 'user'>;

/** The columns this area reads (a narrow select keeps reads stable across schema additions). */
export const COACH_SELECT = {
  id: true,
  userId: true,
  brand: true,
  displayName: true,
  headline: true,
  bio: true,
  photoUrl: true,
  languages: true,
  specialties: true,
  sessionLengths: true,
  rates: true,
  bookingUrl: true,
  requestEmail: true,
  introVideoUrl: true,
  active: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface CoachRow {
  id: string;
  userId: string | null;
  brand: string;
  displayName: string;
  headline: string;
  bio: string;
  photoUrl: string | null;
  languages: string[];
  specialties: string[];
  sessionLengths: number[];
  rates: unknown;
  bookingUrl: string | null;
  requestEmail: string | null;
  introVideoUrl: string | null;
  active: boolean;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CoachRequester {
  userId: string;
  /** The user's display name, when known (shown to the coach). */
  name?: string | null;
  locale?: string | null;
}

export interface CoachingService {
  hasActiveCoaches(brand: BrandId): Promise<boolean>;
  listActive(brand: BrandId, query?: ListCoachesQuery): Promise<{ items: CoachView[] }>;
  get(brand: BrandId, id: string): Promise<CoachView>;
  request(brand: BrandId, requester: CoachRequester, id: string, body: CoachRequestBody): Promise<CoachRequestResponse>;
  adminList(query?: AdminCoachesQuery): Promise<{ items: AdminCoachView[] }>;
  adminCreate(adminId: string, body: CoachBody): Promise<AdminCoachView>;
  adminUpdate(adminId: string, id: string, body: PatchCoachBody): Promise<AdminCoachView>;
  adminDelete(adminId: string, id: string): Promise<void>;
}

export interface CoachingServiceDeps {
  db?: CoachingDb | (() => Promise<CoachingDb>);
  send?: (input: SendEmailInput<Record<string, unknown>>) => Promise<SendEmailResult>;
  env?: EnvSource;
}

// ── Pure helpers ─────────────────────────────────────────────────────────

/** `rates` JSON → a clean `{ currency, '30': n, … }` or null when nothing is listed. */
export function normalizeRates(raw: unknown): Record<string, number | string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const currency = typeof src.currency === 'string' && /^[A-Z]{3}$/.test(src.currency) ? src.currency : null;
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'currency') continue;
    if (/^\d{2,3}$/.test(k) && typeof v === 'number' && Number.isInteger(v) && v >= 0) out[k] = v;
  }
  if (!currency || Object.keys(out).length === 0) return null;
  return { currency, ...out };
}

/** Session lengths with the coach's own price for each; an unlisted price stays null (never 0). */
export function sessionOptions(lengths: readonly number[], rates: Record<string, number | string> | null): CoachSessionOption[] {
  const currency = rates && typeof rates.currency === 'string' ? rates.currency : null;
  return [...new Set(lengths)]
    .filter((m) => Number.isInteger(m) && m > 0)
    .sort((a, b) => a - b)
    .map((minutes) => {
      const v = rates?.[String(minutes)];
      const amountMinor = typeof v === 'number' ? v : null;
      return { minutes, amountMinor, currency: amountMinor === null ? null : currency };
    });
}

export function toCoachView(row: CoachRow): CoachView {
  const rates = normalizeRates(row.rates);
  return {
    id: row.id,
    displayName: row.displayName,
    headline: row.headline,
    bio: row.bio,
    photoUrl: row.photoUrl,
    languages: [...row.languages],
    specialties: [...row.specialties],
    sessionLengths: [...row.sessionLengths],
    rates,
    sessions: sessionOptions(row.sessionLengths, rates),
    bookingUrl: row.bookingUrl,
    booking: row.bookingUrl ? 'link' : 'request',
    introVideoUrl: row.introVideoUrl,
    // No coaching sessions are recorded in V2, so no real rating exists (D3).
    rating: null,
  };
}

export function toAdminCoachView(row: CoachRow): AdminCoachView {
  return {
    ...toCoachView(row),
    brand: row.brand === 'goapply' ? 'goapply' : 'roboapply',
    userId: row.userId,
    requestEmail: row.requestEmail,
    active: row.active,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A listed coach must be reachable: their own booking page or a request address. */
export function hasBookingPath(row: Pick<CoachRow, 'bookingUrl' | 'requestEmail'>): boolean {
  return Boolean(row.bookingUrl || row.requestEmail);
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}

/** Filter by specialty (case-insensitive exact) and language (code or its primary subtag). */
export function matchesQuery(view: Pick<CoachView, 'specialties' | 'languages'>, query: ListCoachesQuery = {}): boolean {
  if (query.specialty && !view.specialties.some((s) => sameText(s, query.specialty!))) return false;
  if (query.language) {
    const want = query.language.trim().toLowerCase();
    const primary = want.split('-')[0]!;
    if (!view.languages.some((l) => l.toLowerCase() === want || l.toLowerCase().split('-')[0] === primary)) return false;
  }
  return true;
}

/**
 * Where the staff copy of a booking request goes: COACHING_ADMIN_EMAIL /
 * CN_COACHING_ADMIN_EMAIL (brandEnv, no fallback across brands), else the
 * brand's support inbox (SUPPORT_EMAIL / CN_SUPPORT_EMAIL, else the registry
 * reply-to address).
 */
export function coachingAdminAddress(brand: ProductBrand, env: EnvSource = process.env): string {
  const configured = brandEnv(brand, 'COACHING_ADMIN_EMAIL', env) ?? brandEnv(brand, 'SUPPORT_EMAIL', env);
  return (configured && addressOf(configured)) || brand.email.replyTo;
}

function notFound(): HttpError {
  return new HttpError('not_found', 'This coach is not listed.', { reason: COACHING_ERROR_CODES.coachNotFound });
}

function invalid(reason: string, message: string): HttpError {
  return new HttpError('invalid_request', message, { reason });
}

function linkedAccountMissing(): HttpError {
  return invalid(COACHING_ERROR_CODES.coachUserNotFound, 'No account with that ID.');
}

/**
 * `RACoach.userId` is unique and a foreign key to `User`: a second roster row
 * for the same account is a conflict (P2002), and an unknown account ID is a
 * validation error (P2003), never a 500.
 */
function rethrowUnique(err: unknown): never {
  const code = (err as { code?: unknown })?.code;
  if (code === 'P2002') {
    throw new HttpError('conflict', 'That account is already linked to another coach.', { reason: COACHING_ERROR_CODES.coachUserTaken });
  }
  if (code === 'P2003') throw linkedAccountMissing();
  throw err;
}

/** Sites whose market needs a separate consent before user data goes to the coach (GoApply: PIPL Art. 23). */
export function requiresShareConsent(brand: Pick<ProductBrand, 'market'>): boolean {
  return brand.market === 'cn';
}

/** Placeholder addresses (e.g. GoApply phone-only accounts) end in `.invalid`. */
function isPlaceholderEmail(email: string): boolean {
  return /\.invalid$/i.test(email.trim());
}

/**
 * True only when the reply address is the requester's own verified account
 * email. Anything else was typed by the user and is marked as unverified in
 * the coach's email.
 */
export function isVerifiedReplyAddress(
  account: { email: string | null; emailVerified: boolean | null } | null,
  replyEmail: string,
): boolean {
  if (!account?.email || account.emailVerified !== true || isPlaceholderEmail(account.email)) return false;
  return account.email.trim().toLowerCase() === replyEmail.trim().toLowerCase();
}

// ── Service ──────────────────────────────────────────────────────────────

async function defaultDb(): Promise<CoachingDb> {
  const { default: prisma } = await import('../../lib/prisma.js');
  return prisma as unknown as CoachingDb;
}

function createData(body: CoachBody, adminId: string): Prisma.RACoachUncheckedCreateInput {
  return {
    brand: body.brand,
    userId: body.userId ?? null,
    displayName: body.displayName,
    headline: body.headline,
    bio: body.bio,
    photoUrl: body.photoUrl ?? null,
    languages: body.languages,
    specialties: body.specialties,
    sessionLengths: [...new Set(body.sessionLengths)].sort((a, b) => a - b),
    rates: (body.rates ?? {}) as Prisma.InputJsonValue,
    bookingUrl: body.bookingUrl ?? null,
    requestEmail: body.requestEmail ?? null,
    introVideoUrl: body.introVideoUrl ?? null,
    active: body.active,
    // Staff add coaches who already agreed to be listed (V2 has no coach applications).
    status: 'approved',
    approvedAt: new Date(),
    approvedBy: adminId,
  };
}

function patchData(body: PatchCoachBody): Prisma.RACoachUncheckedUpdateInput {
  const data: Prisma.RACoachUncheckedUpdateInput = {};
  if (body.brand !== undefined) data.brand = body.brand;
  if (body.userId !== undefined) data.userId = body.userId;
  if (body.displayName !== undefined) data.displayName = body.displayName;
  if (body.headline !== undefined) data.headline = body.headline;
  if (body.bio !== undefined) data.bio = body.bio;
  if (body.photoUrl !== undefined) data.photoUrl = body.photoUrl;
  if (body.languages !== undefined) data.languages = body.languages;
  if (body.specialties !== undefined) data.specialties = body.specialties;
  if (body.sessionLengths !== undefined) data.sessionLengths = [...new Set(body.sessionLengths)].sort((a, b) => a - b);
  if (body.rates !== undefined) data.rates = (body.rates ?? {}) as Prisma.InputJsonValue;
  if (body.bookingUrl !== undefined) data.bookingUrl = body.bookingUrl;
  if (body.requestEmail !== undefined) data.requestEmail = body.requestEmail;
  if (body.introVideoUrl !== undefined) data.introVideoUrl = body.introVideoUrl;
  if (body.active !== undefined) data.active = body.active;
  return data;
}

export function createCoachingService(deps: CoachingServiceDeps = {}): CoachingService {
  const env = deps.env ?? process.env;
  const send = deps.send ?? ((input) => sendEmail(input));
  const db = async (): Promise<CoachingDb> => {
    if (!deps.db) return defaultDb();
    return typeof deps.db === 'function' ? deps.db() : deps.db;
  };

  async function findListed(brand: BrandId, id: string): Promise<CoachRow> {
    const row = (await (await db()).rACoach.findFirst({ where: { id, brand, active: true }, select: COACH_SELECT })) as CoachRow | null;
    if (!row) throw notFound();
    return row;
  }

  async function findAny(id: string): Promise<CoachRow> {
    const row = (await (await db()).rACoach.findUnique({ where: { id }, select: COACH_SELECT })) as CoachRow | null;
    if (!row) throw notFound();
    return row;
  }

  /** A linked account must exist and belong to the coach's site. */
  async function checkLinkedAccount(userId: string, brand: string): Promise<void> {
    const user = (await (await db()).user.findUnique({ where: { id: userId }, select: { id: true, brand: true } })) as {
      id: string;
      brand: string | null;
    } | null;
    if (!user) throw linkedAccountMissing();
    if ((user.brand ?? 'roboapply') !== brand) {
      throw invalid(COACHING_ERROR_CODES.coachUserWrongBrand, 'That account belongs to the other site.');
    }
  }

  return {
    async hasActiveCoaches(brand) {
      const n = await (await db()).rACoach.count({
        where: { brand, active: true, OR: [{ bookingUrl: { not: null } }, { requestEmail: { not: null } }] },
      });
      return n > 0;
    },

    async listActive(brand, query = {}) {
      const rows = (await (await db()).rACoach.findMany({
        where: { brand, active: true },
        select: COACH_SELECT,
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        take: 200,
      })) as CoachRow[];
      // A listed coach with no way to reach them is not shown (it could not be booked).
      return { items: rows.filter(hasBookingPath).map(toCoachView).filter((v) => matchesQuery(v, query)) };
    },

    async get(brand, id) {
      const row = await findListed(brand, id);
      if (!hasBookingPath(row)) throw notFound();
      return toCoachView(row);
    },

    async request(brandId, requester, id, body) {
      const brand = getBrand(brandId);
      const row = await findListed(brandId, id);
      if (row.bookingUrl) {
        throw new HttpError('conflict', 'This coach takes bookings on their own page.', {
          reason: COACHING_ERROR_CODES.useBookingLink,
          bookingUrl: row.bookingUrl,
        });
      }
      const coachAddress = row.requestEmail ? addressOf(row.requestEmail) : null;
      if (!coachAddress) throw notFound();
      if (body.durationMin !== undefined && row.sessionLengths.length > 0 && !row.sessionLengths.includes(body.durationMin)) {
        throw invalid(COACHING_ERROR_CODES.durationNotOffered, 'This coach does not offer that session length.');
      }
      if (requiresShareConsent(brand) && body.shareConsent !== true) {
        throw invalid(COACHING_ERROR_CODES.shareConsentRequired, 'Agree to send your request to the coach first.');
      }

      // The reply address is typed by the user: the coach is told when it is
      // not the requester's own verified account email.
      const account = (await (await db()).user.findUnique({
        where: { id: requester.userId },
        select: { email: true, emailVerified: true },
      })) as { email: string | null; emailVerified: boolean | null } | null;
      const replyEmailVerified = isVerifiedReplyAddress(account, body.contactEmail);

      const params: CoachingRequestEmailParams = {
        coachName: row.displayName,
        requesterName: body.name?.trim() || requester.name?.trim() || null,
        replyEmail: body.contactEmail,
        replyEmailVerified,
        topic: body.topic,
        message: body.message ?? null,
        durationMin: body.durationMin ?? null,
        preferredTimes: body.preferredTimes ?? null,
        audience: 'coach',
      };
      const toCoach = await send({
        template: COACHING_BOOKING_REQUEST_TEMPLATE,
        to: coachAddress,
        userId: null,
        brand,
        replyTo: body.contactEmail,
        params: params as unknown as Record<string, unknown>,
      });
      if (toCoach.status !== 'sent') {
        logger.warn('COACHING', 'booking request not delivered to coach', { brand: brand.id, coachId: row.id, status: toCoach.status, reason: toCoach.reason });
        if (toCoach.status === 'suppressed' && toCoach.reason === 'transport_not_configured') {
          throw new HttpError('provider_not_configured', 'Email is not configured on this deployment.');
        }
        throw new HttpError('internal_error', 'The request could not be sent.');
      }

      // Staff copy (the coach's address is not included; the requester's is, so staff can follow up).
      const adminTo = coachingAdminAddress(brand, env);
      const toAdmin = await send({
        template: COACHING_BOOKING_REQUEST_TEMPLATE,
        to: adminTo,
        userId: null,
        brand,
        replyTo: body.contactEmail,
        params: { ...params, audience: 'admin', coachId: row.id, requesterUserId: requester.userId } as unknown as Record<string, unknown>,
      });
      if (toAdmin.status !== 'sent') {
        // The coach has the request; a missing staff copy is logged, not surfaced to the user.
        logger.warn('COACHING', 'booking request staff copy not delivered', { brand: brand.id, coachId: row.id, status: toAdmin.status, reason: toAdmin.reason });
      }
      logger.info('COACHING', 'booking request sent', {
        brand: brand.id,
        coachId: row.id,
        requesterUserId: requester.userId,
        replyEmailVerified,
        // GoApply: the user ticked "send my name, email and message to the coach" (PIPL Art. 23).
        shareConsent: requiresShareConsent(brand) ? true : undefined,
      });
      return { received: true };
    },

    async adminList(query = {}) {
      const where: Prisma.RACoachWhereInput = {};
      if (query.brand) where.brand = query.brand;
      if (query.active) where.active = query.active === 'true';
      const rows = (await (await db()).rACoach.findMany({
        where,
        select: COACH_SELECT,
        orderBy: [{ brand: 'asc' }, { displayName: 'asc' }, { id: 'asc' }],
        take: 500,
      })) as CoachRow[];
      return { items: rows.map(toAdminCoachView) };
    },

    async adminCreate(adminId, body) {
      if (body.active && !hasBookingPath({ bookingUrl: body.bookingUrl ?? null, requestEmail: body.requestEmail ?? null })) {
        throw invalid(COACHING_ERROR_CODES.noBookingPath, 'Add a booking link or a request email before listing this coach.');
      }
      if (body.userId) await checkLinkedAccount(body.userId, body.brand);
      const row = (await (await db())
        .rACoach.create({ data: createData(body, adminId), select: COACH_SELECT })
        .catch(rethrowUnique)) as CoachRow;
      // The staff attestation is logged with who approved the listing and when (no audit table in V2).
      logger.info('COACHING', 'coach added to roster', {
        adminId,
        coachId: row.id,
        brand: row.brand,
        active: row.active,
        listingConsent: body.listingConsent,
        approvedBy: adminId,
        approvedAt: new Date().toISOString(),
      });
      return toAdminCoachView(row);
    },

    async adminUpdate(adminId, id, body) {
      const current = await findAny(id);
      const next = {
        bookingUrl: body.bookingUrl !== undefined ? body.bookingUrl : current.bookingUrl,
        requestEmail: body.requestEmail !== undefined ? body.requestEmail : current.requestEmail,
      };
      const active = body.active ?? current.active;
      if (active && !hasBookingPath(next)) {
        throw invalid(COACHING_ERROR_CODES.noBookingPath, 'Add a booking link or a request email before listing this coach.');
      }
      const nextUserId = body.userId !== undefined ? body.userId : current.userId;
      if (nextUserId && (body.userId !== undefined || body.brand !== undefined)) {
        await checkLinkedAccount(nextUserId, body.brand ?? current.brand);
      }
      const row = (await (await db())
        .rACoach.update({ where: { id }, data: patchData(body), select: COACH_SELECT })
        .catch(rethrowUnique)) as CoachRow;
      logger.info('COACHING', 'coach roster entry updated', { adminId, coachId: id, fields: Object.keys(body) });
      return toAdminCoachView(row);
    },

    async adminDelete(adminId, id) {
      await findAny(id);
      await (await db()).rACoach.delete({ where: { id } });
      logger.info('COACHING', 'coach removed from roster', { adminId, coachId: id });
    },
  };
}

let defaultService: CoachingService | null = null;

/** The process-wide service (lazy, so importing the router never opens a database connection). */
export function getCoachingService(): CoachingService {
  defaultService ??= createCoachingService();
  return defaultService;
}

/** Tests only. */
export function setCoachingServiceForTests(service: CoachingService | null): void {
  defaultService = service;
}
