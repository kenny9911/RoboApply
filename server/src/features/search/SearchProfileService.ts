// server/src/features/search/SearchProfileService.ts
//
// CRUD over RASearchProfile, the one preference store (ARCHITECTURE.md §2.8,
// §3.3). No routes here: WP-20 mounts `/search-profiles` on this service.
//
// Invariants:
//   - every user who has read their profiles has exactly one default profile
//     and exactly one active profile (both enforced in transactions; the first
//     read migrates the legacy preferences under a per-user advisory lock);
//   - writes carry the version the client read; a mismatch raises
//     VersionConflictError (409) instead of overwriting a newer edit from the
//     drawer, the Assistant or onboarding;
//   - the number of profiles is capped by the `saved_searches` entitlement
//     (Free 1, Pro 10); profiles imported from legacy saved searches are kept
//     even above the cap;
//   - `alertInstantMax` may not exceed the `instant_alerts` entitlement.

import type { ExtendedPrismaClient, ExtendedTransactionClient } from '../../lib/prisma.js';
import { BRANDS, type Market } from '../../platform/brand/registry.js';
import {
  DEFAULT_CREDIT_CATALOG,
  entitlementService as defaultEntitlements,
  getCreditCatalog,
  type CreditCatalog,
  type EntitlementService,
} from '../../platform/credits/index.js';
import type { BrandId } from '../../platform/brand/registry.js';
import { logger } from '../../services/LoggerService.js';
import { HttpError } from '../../platform/http.js';
import {
  ALERT_INSTANT_OPTIONS,
  FILTER_SET_SCHEMA_VERSION,
  type FilterSet,
  type FilterSetPatch,
  type SearchProfileListWire,
  type SearchProfileWire,
} from './contract.js';
import { coerceFilterSet, mergeFilterSet, parseFilterSet, parseFilterSetPatch, type FilterIssue } from './filterSet.js';
import { buildLegacyProfiles } from './legacyMigration.js';

// ── Errors ─────────────────────────────────────────────────────────────────

export class SearchProfileNotFoundError extends Error {
  readonly code = 'search_profile_not_found' as const;
  readonly status = 404;
  constructor(readonly profileId: string) {
    super(`Search profile ${profileId} not found`);
    this.name = 'SearchProfileNotFoundError';
  }
}

export class VersionConflictError extends Error {
  readonly code = 'version_conflict' as const;
  readonly status = 409;
  constructor(
    readonly profileId: string,
    readonly expectedVersion: number,
    readonly currentVersion: number,
    readonly current: SearchProfileWire,
  ) {
    super(`Search profile ${profileId} is at version ${currentVersion}, not ${expectedVersion}`);
    this.name = 'VersionConflictError';
  }
}

export class SavedSearchLimitError extends Error {
  readonly code = 'saved_search_limit' as const;
  readonly status = 403;
  constructor(
    readonly max: number,
    readonly upgradable: boolean,
  ) {
    super(`Up to ${max} saved searches on this plan`);
    this.name = 'SavedSearchLimitError';
  }
}

export class AlertFrequencyNotAllowedError extends Error {
  readonly code = 'alert_frequency_not_allowed' as const;
  readonly status = 403;
  constructor(readonly max: number) {
    super(`Instant alerts are limited to ${max} a day on this plan`);
    this.name = 'AlertFrequencyNotAllowedError';
  }
}

export class InvalidFiltersError extends Error {
  readonly code = 'invalid_filters' as const;
  readonly status = 422;
  constructor(readonly issues: FilterIssue[]) {
    super('Invalid filters');
    this.name = 'InvalidFiltersError';
  }
}

export class DefaultProfileError extends Error {
  readonly code = 'cannot_delete_default_profile' as const;
  readonly status = 409;
  constructor() {
    super('The default search profile cannot be deleted; make another one the default first');
    this.name = 'DefaultProfileError';
  }
}

export class LastProfileError extends Error {
  readonly code = 'cannot_delete_last_profile' as const;
  readonly status = 409;
  constructor() {
    super('The last search profile cannot be deleted');
    this.name = 'LastProfileError';
  }
}

export type SearchProfileError =
  | SearchProfileNotFoundError
  | VersionConflictError
  | SavedSearchLimitError
  | AlertFrequencyNotAllowedError
  | InvalidFiltersError
  | LastProfileError
  | DefaultProfileError;

/** `{ status, body }` for a search-profile error, or null. */
export function searchErrorToHttp(err: unknown): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof VersionConflictError) return { status: 409, body: { error: err.code, currentVersion: err.currentVersion, profile: err.current } };
  if (err instanceof SavedSearchLimitError) return { status: 403, body: { error: err.code, max: err.max, upgradable: err.upgradable } };
  if (err instanceof AlertFrequencyNotAllowedError) return { status: 403, body: { error: err.code, max: err.max } };
  if (err instanceof InvalidFiltersError) return { status: 422, body: { error: err.code, issues: err.issues } };
  if (err instanceof SearchProfileNotFoundError || err instanceof LastProfileError || err instanceof DefaultProfileError) {
    return { status: err.status, body: { error: err.code } };
  }
  return null;
}

/**
 * The same errors as platform `HttpError`s, for routes built with `route()`:
 * a platform code plus `details.reason` naming the search case (contract
 * SEARCH_ERROR_CODES). Returns null for anything else.
 */
export function searchErrorToHttpError(err: unknown): HttpError | null {
  if (err instanceof VersionConflictError) {
    return new HttpError('version_conflict', undefined, { currentVersion: err.currentVersion, profile: err.current });
  }
  if (err instanceof SavedSearchLimitError) {
    return new HttpError('forbidden', err.message, { reason: err.code, max: err.max, upgradable: err.upgradable });
  }
  if (err instanceof AlertFrequencyNotAllowedError) return new HttpError('forbidden', err.message, { reason: err.code, max: err.max });
  if (err instanceof InvalidFiltersError) return new HttpError('invalid_request', err.message, { reason: err.code, issues: err.issues });
  if (err instanceof SearchProfileNotFoundError) return new HttpError('not_found', err.message, { reason: err.code });
  if (err instanceof LastProfileError || err instanceof DefaultProfileError) return new HttpError('conflict', err.message, { reason: err.code });
  return null;
}

// ── Types ──────────────────────────────────────────────────────────────────

type Db = Pick<ExtendedPrismaClient, '$transaction' | 'rASearchProfile' | 'rACareerGoal' | 'rASavedSearch'>;
type Tx = Pick<ExtendedTransactionClient, '$executeRaw' | 'rASearchProfile' | 'rACareerGoal' | 'rASavedSearch'>;

interface ProfileRow {
  id: string;
  userId: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  version: number;
  schemaVersion: number;
  filters: unknown;
  alertInstantMax: number;
  alertDigest: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const PROFILE_SELECT = {
  id: true,
  userId: true,
  name: true,
  isDefault: true,
  isActive: true,
  version: true,
  schemaVersion: true,
  filters: true,
  alertInstantMax: true,
  alertDigest: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface CreateProfileInput {
  name: string;
  filters: unknown;
  isDefault?: boolean;
  activate?: boolean;
  alertInstantMax?: number;
  alertDigest?: 'daily' | 'weekly' | null;
}

export interface UpdateProfileInput {
  version: number;
  name?: string;
  /** Replaces the whole set. */
  filters?: unknown;
  /** FilterSetPatch: a value replaces a field, null clears it (exclusive with `filters`). */
  filtersPatch?: unknown;
  /** Make this the default profile. */
  makeDefault?: boolean;
  alertInstantMax?: number;
  alertDigest?: 'daily' | 'weekly' | null;
}

export interface SearchProfileServiceDeps {
  getDb?: () => Promise<Db>;
  entitlements?: EntitlementService;
  /** The brand's credit catalog (for the Pro column of `saved_searches`). */
  loadCatalog?: (brand: BrandId) => Promise<CreditCatalog>;
}

function toWire(row: ProfileRow, market: Market): SearchProfileWire {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    isActive: row.isActive,
    version: row.version,
    schemaVersion: row.schemaVersion,
    filters: coerceFilterSet(row.filters, { market }).value,
    alertInstantMax: row.alertInstantMax,
    alertDigest: row.alertDigest === 'daily' || row.alertDigest === 'weekly' ? row.alertDigest : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sortProfiles(rows: ProfileRow[]): ProfileRow[] {
  return [...rows].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.getTime() - b.createdAt.getTime());
}

const defaultGetDb = async (): Promise<Db> => (await import('../../lib/prisma.js')).default;

export function createSearchProfileService(deps: SearchProfileServiceDeps = {}) {
  const getDb = deps.getDb ?? defaultGetDb;
  const entitlements = deps.entitlements ?? defaultEntitlements;
  const loadCatalog = deps.loadCatalog ?? getCreditCatalog;

  async function proSavedSearches(brand: BrandId): Promise<number> {
    try {
      return (await loadCatalog(brand)).entitlements.pro.saved_searches;
    } catch {
      return DEFAULT_CREDIT_CATALOG[brand].entitlements.pro.saved_searches;
    }
  }

  async function context(userId: string) {
    const ent = await entitlements.resolve(userId);
    return { ent, market: ent.market, currency: BRANDS[ent.brand].currency };
  }

  function validateFilters(raw: unknown, market: Market): FilterSet {
    const parsed = parseFilterSet(raw, { market });
    if (!parsed.ok) throw new InvalidFiltersError(parsed.issues);
    return parsed.value;
  }

  function checkAlertFrequency(value: number | undefined, max: number): void {
    if (value === undefined) return;
    if (!(ALERT_INSTANT_OPTIONS as readonly number[]).includes(value)) throw new InvalidFiltersError([{ path: 'alertInstantMax', message: 'not an allowed option' }]);
    if (value > max) throw new AlertFrequencyNotAllowedError(max);
  }

  async function rowsFor(db: Db | Tx, userId: string): Promise<ProfileRow[]> {
    return (await db.rASearchProfile.findMany({ where: { userId }, select: PROFILE_SELECT })) as ProfileRow[];
  }

  /** First read: migrate legacy preferences once (advisory lock per user). Returns the rows. */
  async function ensureProfiles(userId: string, market: Market, currency: string): Promise<ProfileRow[]> {
    const db = await getDb();
    const existing = await rowsFor(db, userId);
    if (existing.length) return existing;
    return db.$transaction(async (txRaw) => {
      const tx = txRaw as unknown as Tx;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ra_search_profile:${userId}`}))`;
      const again = await rowsFor(tx, userId);
      if (again.length) return again;
      const [goal, saved] = await Promise.all([
        tx.rACareerGoal.findUnique({
          where: { userId },
          select: {
            targetTitle: true,
            targetSalaryMin: true,
            targetSalaryCurrency: true,
            preferredLocations: true,
            preferredWorkType: true,
            seniority: true,
            preferencesBlob: true,
          },
        }),
        tx.rASavedSearch.findMany({ where: { userId }, select: { id: true, name: true, query: true, createdAt: true } }),
      ]);
      const profiles = buildLegacyProfiles({ goal, savedSearches: saved, market, currency });
      for (const p of profiles) {
        await tx.rASearchProfile.create({
          data: {
            userId,
            name: p.name,
            isDefault: p.isDefault,
            isActive: p.isActive,
            version: 1,
            schemaVersion: FILTER_SET_SCHEMA_VERSION,
            filters: p.filters as object,
            alertInstantMax: 0,
            alertDigest: null,
          },
        });
      }
      logger.info('SEARCH_PROFILES', 'legacy preferences migrated', { userId, profiles: profiles.map((p) => p.source) });
      return rowsFor(tx, userId);
    });
  }

  async function getRow(userId: string, id: string, db?: Db | Tx): Promise<ProfileRow> {
    const row = (await (db ?? (await getDb())).rASearchProfile.findFirst({ where: { id, userId }, select: PROFILE_SELECT })) as ProfileRow | null;
    if (!row) throw new SearchProfileNotFoundError(id);
    return row;
  }

  async function list(userId: string): Promise<SearchProfileListWire> {
    const { ent, market, currency } = await context(userId);
    const rows = sortProfiles(await ensureProfiles(userId, market, currency));
    const upgradable = ent.planProfile === 'free' && ent.proSellable;
    const proMax = upgradable ? await proSavedSearches(ent.brand) : null;
    return {
      profiles: rows.map((r) => toWire(r, market)),
      maxProfiles: ent.entitlements.saved_searches,
      maxInstantAlerts: ent.entitlements.instant_alerts,
      // Only worth a note when Pro actually allows more.
      proMaxProfiles: proMax !== null && proMax > ent.entitlements.saved_searches ? proMax : null,
      upgradable,
    };
  }

  async function get(userId: string, id: string): Promise<SearchProfileWire> {
    const { market } = await context(userId);
    return toWire(await getRow(userId, id), market);
  }

  /**
   * A profile by id alone, for background readers that hold no session (the
   * feed's alert-candidate seam): the owner, the version and the stored
   * filters as written (the caller coerces them for its market). Null when
   * the profile is gone. Never used to answer a request for another user.
   */
  async function findById(id: string): Promise<{ id: string; userId: string; version: number; filters: unknown } | null> {
    const row = await (await getDb()).rASearchProfile.findFirst({ where: { id }, select: { id: true, userId: true, version: true, filters: true } });
    return row ? { id: row.id, userId: row.userId, version: row.version, filters: row.filters } : null;
  }

  /** The profile the feed uses now (active, else default). Migrates on first use. */
  async function getActive(userId: string): Promise<SearchProfileWire> {
    const { market, currency } = await context(userId);
    const rows = await ensureProfiles(userId, market, currency);
    const row = rows.find((r) => r.isActive) ?? rows.find((r) => r.isDefault) ?? sortProfiles(rows)[0];
    return toWire(row, market);
  }

  async function create(userId: string, input: CreateProfileInput): Promise<SearchProfileWire> {
    const { ent, market, currency } = await context(userId);
    const filters = validateFilters(input.filters, market);
    checkAlertFrequency(input.alertInstantMax, ent.entitlements.instant_alerts);
    const cap = ent.entitlements.saved_searches;
    const limitError = () => new SavedSearchLimitError(cap, ent.planProfile === 'free' && ent.proSellable);
    // Fast refusal (also runs the legacy migration on a first write).
    const existing = await ensureProfiles(userId, market, currency);
    if (existing.length >= cap) throw limitError();
    const db = await getDb();
    const row = await db.$transaction(async (txRaw) => {
      const tx = txRaw as unknown as Tx;
      // The authoritative check: the same per-user lock as the migration, then
      // a re-count, so two concurrent creates (two tabs, a double click)
      // cannot both pass the cap.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ra_search_profile:${userId}`}))`;
      if ((await tx.rASearchProfile.count({ where: { userId } })) >= cap) throw limitError();
      if (input.isDefault) await tx.rASearchProfile.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
      if (input.activate) await tx.rASearchProfile.updateMany({ where: { userId, isActive: true }, data: { isActive: false } });
      return tx.rASearchProfile.create({
        data: {
          userId,
          name: input.name.trim().slice(0, 60),
          isDefault: !!input.isDefault,
          isActive: !!input.activate,
          version: 1,
          schemaVersion: FILTER_SET_SCHEMA_VERSION,
          filters: filters as object,
          alertInstantMax: input.alertInstantMax ?? 0,
          alertDigest: input.alertDigest ?? null,
        },
        select: PROFILE_SELECT,
      });
    });
    return toWire(row as ProfileRow, market);
  }

  async function update(userId: string, id: string, input: UpdateProfileInput): Promise<SearchProfileWire> {
    const { ent, market } = await context(userId);
    const db = await getDb();
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name.trim().slice(0, 60);
    if (input.filters !== undefined && input.filtersPatch !== undefined) {
      throw new InvalidFiltersError([{ path: 'filtersPatch', message: 'send filters or filtersPatch, not both' }]);
    }
    if (input.filters !== undefined) data.filters = validateFilters(input.filters, market) as object;
    if (input.filtersPatch !== undefined) {
      const parsed = parseFilterSetPatch(input.filtersPatch);
      if (!parsed.ok) throw new InvalidFiltersError(parsed.issues);
      const row = await getRow(userId, id, db);
      if (row.version !== input.version) throw new VersionConflictError(id, input.version, row.version, toWire(row, market));
      const merged = mergeFilterSet(coerceFilterSet(row.filters, { market }).value, parsed.value as FilterSetPatch);
      // Re-validate the merged set strictly (strips the other market's fields).
      data.filters = validateFilters(merged, market) as object;
    }
    if (input.alertInstantMax !== undefined) {
      checkAlertFrequency(input.alertInstantMax, ent.entitlements.instant_alerts);
      data.alertInstantMax = input.alertInstantMax;
    }
    if (input.alertDigest !== undefined) data.alertDigest = input.alertDigest;
    const res = await db.rASearchProfile.updateMany({
      where: { id, userId, version: input.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (res.count !== 1) {
      const current = await getRow(userId, id, db);
      throw new VersionConflictError(id, input.version, current.version, toWire(current, market));
    }
    if (input.makeDefault) return setDefault(userId, id);
    return toWire(await getRow(userId, id, db), market);
  }

  /** Apply a FilterSetPatch (value replaces, null clears) at an expected version. */
  async function patchFilters(userId: string, id: string, version: number, patch: unknown): Promise<SearchProfileWire> {
    return update(userId, id, { version, filtersPatch: patch });
  }

  async function setDefault(userId: string, id: string): Promise<SearchProfileWire> {
    const { market } = await context(userId);
    const db = await getDb();
    const row = await db.$transaction(async (txRaw) => {
      const tx = txRaw as unknown as Tx;
      await getRow(userId, id, tx);
      await tx.rASearchProfile.updateMany({ where: { userId, isDefault: true, NOT: { id } }, data: { isDefault: false } });
      await tx.rASearchProfile.updateMany({ where: { id, userId }, data: { isDefault: true } });
      return getRow(userId, id, tx);
    });
    return toWire(row, market);
  }

  /** Make a profile the one the feed uses. */
  async function activate(userId: string, id: string): Promise<SearchProfileWire> {
    const { market } = await context(userId);
    const db = await getDb();
    const row = await db.$transaction(async (txRaw) => {
      const tx = txRaw as unknown as Tx;
      await getRow(userId, id, tx);
      await tx.rASearchProfile.updateMany({ where: { userId, isActive: true, NOT: { id } }, data: { isActive: false } });
      await tx.rASearchProfile.updateMany({ where: { id, userId }, data: { isActive: true } });
      return getRow(userId, id, tx);
    });
    return toWire(row, market);
  }

  /**
   * Delete a profile. The last profile and the default profile cannot be
   * deleted (ARCH §3.3); when the active one goes, the default becomes active.
   */
  async function remove(userId: string, id: string): Promise<void> {
    const db = await getDb();
    await db.$transaction(async (txRaw) => {
      const tx = txRaw as unknown as Tx;
      const row = await getRow(userId, id, tx);
      const rows = await rowsFor(tx, userId);
      if (rows.length <= 1) throw new LastProfileError();
      if (row.isDefault) throw new DefaultProfileError();
      await tx.rASearchProfile.deleteMany({ where: { id, userId } });
      const rest = sortProfiles(rows.filter((r) => r.id !== id));
      let defaultId = rest.find((r) => r.isDefault)?.id;
      if (row.isDefault || !defaultId) {
        defaultId = [...rest].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0].id;
        await tx.rASearchProfile.updateMany({ where: { id: defaultId, userId }, data: { isDefault: true } });
      }
      if (row.isActive || !rest.some((r) => r.isActive)) {
        await tx.rASearchProfile.updateMany({ where: { id: defaultId, userId }, data: { isActive: true } });
      }
    });
  }

  return { list, get, getActive, findById, create, update, patchFilters, setDefault, activate, remove };
}

export type SearchProfileService = ReturnType<typeof createSearchProfileService>;

/** The process-wide service. */
export const searchProfileService: SearchProfileService = createSearchProfileService();
