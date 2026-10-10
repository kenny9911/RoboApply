// server/src/features/seo/scope.ts
//
// Which jobs a public page may read (TASK_PLAN.md §2.2, ARCH §9.4). One spec,
// two evaluators that must agree:
//   - `publicJobWhere(scope, ctx)`  the Prisma `where` the repository runs;
//   - `matchesScope(row, scope, ctx)` the same rule over a plain row (the
//     in-memory repository and the tests use it).
//
// The base predicate, applied to every list, count and aggregate:
//   market = brand.market AND visibility = 'public' AND isCanonical AND
//   archivedAt IS NULL AND closedAt IS NULL AND (expiresAt IS NULL OR
//   expiresAt > now) AND sourceBoard <> 'seed' AND no fraud flags AND
//   publicDisplay AND (fromRecruiterBank OR sourceBoard is a board of a
//   provider still listed in PUBLIC_DISPLAY_PROVIDERS).
// `publicDisplay` is decided at ingest (bank syndication consent, or the
// provider list at the time); the read-time provider check makes removing a
// provider from the list take effect at once, without waiting for a re-ingest.

import { Prisma } from '../../generated/prisma/client.js';
import type { EnvSource } from '../../platform/brand/index.js';
import type { Market } from '../../platform/brand/registry.js';
import { PUBLIC_ATS } from '../jobs/sources/atsPublic/contract.js';

/** Provider → the `sourceBoard` values its rows carry. Banks are governed by consent, not this list. */
const PROVIDER_BOARDS: Readonly<Record<string, readonly string[]>> = {
  activejobs: ['activejobs'],
  linkedin: ['linkedin'],
  jsearch: ['jsearch'],
  ats_public: PUBLIC_ATS,
};

/** `PUBLIC_DISPLAY_PROVIDERS` (comma list, default empty — OPS-A4). */
export function publicDisplayProviders(env: EnvSource = process.env): string[] {
  return (env.PUBLIC_DISPLAY_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** The source boards whose rows may appear publicly (non-bank). */
export function allowedPublicBoards(env: EnvSource = process.env): string[] {
  const out = new Set<string>();
  for (const p of publicDisplayProviders(env)) for (const b of PROVIDER_BOARDS[p] ?? []) out.add(b);
  return [...out];
}

export type Seniority = 'intern_newgrad' | 'entry' | 'mid' | 'senior' | 'lead_staff' | 'director_exec';

/** The page-specific narrowing on top of the base predicate. */
export interface JobScope {
  /** Taxonomy id the job carries at any level (`taxonomyIds` contains it). */
  taxonomyId?: string;
  /** Lowercased city names (any language) + the country they lie in. */
  city?: { names: string[]; country: string };
  /** Located in this ISO country (non-remote pages) — `?country=`. */
  country?: string;
  /** Remote jobs only; with `country`, remote for that country or global. */
  remote?: boolean;
  /** Sponsorship offered, quote-backed, in this country (or remote for it). */
  sponsorshipCountry?: string;
  /** Sponsorship offered and quote-backed, any country (the cron groups these by country). */
  sponsorshipOffered?: boolean;
  /** Seniority levels allowed. */
  seniority?: readonly Seniority[];
  /** employmentType = 'internship' (true) or not an internship (false). */
  internship?: boolean;
}

export interface ScopeContext {
  market: Market;
  now: Date;
  /** Boards from PUBLIC_DISPLAY_PROVIDERS (see allowedPublicBoards). */
  publicBoards: readonly string[];
}

/** The base predicate as a Prisma `where` (every clause of the header). */
export function basePublicWhere(ctx: ScopeContext): Prisma.RAJobWhereInput {
  return {
    market: ctx.market,
    visibility: 'public',
    isCanonical: true,
    archivedAt: null,
    closedAt: null,
    publicDisplay: true,
    sourceBoard: { not: 'seed' },
    AND: [
      { OR: [{ expiresAt: null }, { expiresAt: { gt: ctx.now } }] },
      { OR: [{ fraudFlags: { equals: Prisma.AnyNull } }, { fraudFlags: { equals: [] } }] },
      { OR: [{ fromRecruiterBank: true }, { sourceBoard: { in: [...ctx.publicBoards] } }] },
    ],
  };
}

/** Base predicate AND the page narrowing. */
export function publicJobWhere(scope: JobScope, ctx: ScopeContext): Prisma.RAJobWhereInput {
  const base = basePublicWhere(ctx);
  const and = [...(base.AND as Prisma.RAJobWhereInput[])];
  if (scope.taxonomyId) and.push({ taxonomyIds: { has: scope.taxonomyId } });
  if (scope.city) {
    and.push({ locationCountry: scope.city.country });
    and.push({ OR: scope.city.names.map((n) => ({ locationCity: { equals: n, mode: 'insensitive' as const } })) });
  }
  if (scope.remote) {
    and.push({ workModel: 'remote' });
    if (scope.country) and.push({ OR: [{ remoteScope: scope.country }, { remoteScope: 'global' }, { remoteScope: null }] });
  } else if (scope.country && !scope.city) {
    and.push({ locationCountry: scope.country });
  }
  if (scope.sponsorshipCountry) {
    and.push({ sponsorship: 'offered' });
    and.push({ sponsorshipEvidence: { not: null } });
    and.push({ NOT: { sponsorshipEvidence: '' } });
    and.push({
      OR: [{ locationCountry: scope.sponsorshipCountry }, { workModel: 'remote', remoteScope: scope.sponsorshipCountry }],
    });
  }
  if (scope.sponsorshipOffered && !scope.sponsorshipCountry) {
    and.push({ sponsorship: 'offered' });
    and.push({ sponsorshipEvidence: { not: null } });
    and.push({ NOT: { sponsorshipEvidence: '' } });
  }
  if (scope.seniority) and.push({ seniority: { in: [...scope.seniority] } });
  if (scope.internship === true) and.push({ employmentType: 'internship' });
  if (scope.internship === false) and.push({ OR: [{ employmentType: null }, { employmentType: { not: 'internship' } }] });
  return { ...base, AND: and };
}

/** The row fields `matchesScope` reads. */
export interface ScopeRow {
  market: string;
  visibility: string;
  isCanonical: boolean;
  archivedAt: Date | null;
  closedAt: Date | null;
  expiresAt: Date | null;
  publicDisplay: boolean;
  fromRecruiterBank: boolean;
  sourceBoard: string;
  fraudFlags: unknown;
  taxonomyIds: string[];
  locationCity: string | null;
  locationCountry: string | null;
  workModel: string | null;
  remoteScope: string | null;
  sponsorship: string | null;
  sponsorshipEvidence: string | null;
  seniority: string | null;
  employmentType: string | null;
}

function noFraudFlags(v: unknown): boolean {
  return v === null || v === undefined || (Array.isArray(v) && v.length === 0);
}

/** The base predicate over a plain row. */
export function isPubliclyListable(row: ScopeRow, ctx: ScopeContext): boolean {
  return (
    row.market === ctx.market &&
    row.visibility === 'public' &&
    row.isCanonical === true &&
    row.archivedAt === null &&
    row.closedAt === null &&
    (row.expiresAt === null || row.expiresAt.getTime() > ctx.now.getTime()) &&
    row.sourceBoard !== 'seed' &&
    noFraudFlags(row.fraudFlags) &&
    row.publicDisplay === true &&
    (row.fromRecruiterBank === true || ctx.publicBoards.includes(row.sourceBoard))
  );
}

/** `publicJobWhere` over a plain row. */
export function matchesScope(row: ScopeRow, scope: JobScope, ctx: ScopeContext): boolean {
  if (!isPubliclyListable(row, ctx)) return false;
  if (scope.taxonomyId && !row.taxonomyIds.includes(scope.taxonomyId)) return false;
  if (scope.city) {
    if (row.locationCountry !== scope.city.country) return false;
    if (!row.locationCity || !scope.city.names.includes(row.locationCity.toLowerCase())) return false;
  }
  if (scope.remote) {
    if (row.workModel !== 'remote') return false;
    if (scope.country && !(row.remoteScope === scope.country || row.remoteScope === 'global' || row.remoteScope === null)) return false;
  } else if (scope.country && !scope.city && row.locationCountry !== scope.country) return false;
  if (scope.sponsorshipCountry) {
    if (row.sponsorship !== 'offered' || !row.sponsorshipEvidence) return false;
    const inCountry = row.locationCountry === scope.sponsorshipCountry;
    const remoteFor = row.workModel === 'remote' && row.remoteScope === scope.sponsorshipCountry;
    if (!inCountry && !remoteFor) return false;
  }
  if (scope.sponsorshipOffered && (row.sponsorship !== 'offered' || !row.sponsorshipEvidence)) return false;
  if (scope.seniority && !(row.seniority && scope.seniority.includes(row.seniority as Seniority))) return false;
  if (scope.internship === true && row.employmentType !== 'internship') return false;
  if (scope.internship === false && row.employmentType === 'internship') return false;
  return true;
}
