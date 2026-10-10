// server/src/features/jobs/normalize/identity.ts
//
// Dedupe key, search text and lifecycle dates (ARCH §4.4).
//
//   dedupeKey  = sha1(companyNameNormalized | titleNormalized | place), where
//                place = the city (table id when known, else the posting's
//                city words), else the remote scope, else the country.
//   searchText = titleNormalized + companyNameNormalized + top skills.
//   expiresAt  = the provider's expiry; else postedAt + 45 days; bank jobs
//                and public ATS boards: none (their sync closes them when
//                the bank or the board stops listing the posting).

import { createHash } from 'node:crypto';
import type { NormalizeProvider } from './types.js';

export const DEFAULT_EXPIRY_DAYS = 45;
const DAY_MS = 86_400_000;

export interface DedupePlace {
  cityId?: string | null;
  city?: string | null;
  remoteScope?: string | null;
  country?: string | null;
}

/** The place part of the dedupe key (lower case; '' when nothing is known). */
export function dedupePlace(p: DedupePlace): string {
  const value = p.cityId ?? (p.city ? p.city.normalize('NFKC').toLowerCase().trim() : null) ?? (p.remoteScope ? `remote:${p.remoteScope.toLowerCase()}` : null) ?? p.country?.toLowerCase() ?? '';
  return value;
}

export function dedupeKey(companyNameNormalized: string, titleNormalized: string, place: DedupePlace): string {
  return createHash('sha1').update(`${companyNameNormalized}|${titleNormalized}|${dedupePlace(place)}`).digest('hex');
}

/** Normalized title + company + up to 10 skills, at most 500 characters. */
export function buildSearchText(titleNormalized: string, companyNameNormalized: string, skills: readonly string[]): string {
  const parts = [titleNormalized, companyNameNormalized, ...skills.slice(0, 10)].filter(Boolean);
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text.length <= 500 ? text : text.slice(0, 500).trimEnd();
}

/** A valid Date from a Date / ISO string / epoch ms, else null. Zone-less ISO strings are read as UTC. */
export function toDate(value: string | Date | number | null | undefined): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(s) ? `${s}Z` : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface PostedAtResult {
  postedAt: Date | null;
  estimated: boolean;
}

/**
 * The posting date. Missing, unparseable, before 2000 or more than a day in
 * the future → an estimate, marked as such: the existing row's firstSeenAt
 * when the job was seen before (so re-ingesting an undated job never makes it
 * look newly posted or pushes its expiry out), else the fetch time, else `now`.
 */
export function resolvePostedAt(
  posted: string | Date | null | undefined,
  opts: { estimated?: boolean | null; fetchedAt?: string | Date | null; firstSeenAt?: string | Date | null; now: Date },
): PostedAtResult {
  const d = toDate(posted ?? null);
  const seen = toDate(opts.firstSeenAt ?? null);
  const firstSeen = seen && seen.getTime() <= opts.now.getTime() ? seen : null;
  const fetched = toDate(opts.fetchedAt ?? null);
  const fallback = firstSeen && (!fetched || firstSeen < fetched) ? firstSeen : (fetched ?? opts.now);
  if (!d || d.getUTCFullYear() < 2000 || d.getTime() > opts.now.getTime() + DAY_MS) return { postedAt: fallback, estimated: true };
  return { postedAt: d, estimated: opts.estimated === true };
}

/** Providers whose postings never expire by date: their own sync (or the owner) closes them. */
export const NO_DATE_EXPIRY_PROVIDERS: readonly NormalizeProvider[] = ['bank_robohire', 'bank_gohire', 'user_import', 'ats_public'];

/**
 * Provider expiry, else postedAt + 45 days. Bank jobs, private imports and
 * public ATS boards (`ats_public`) never expire by date: an employer's board
 * lists a role for as long as it is open, often for months, and the board
 * sync archives the posting when the board stops listing it.
 */
export function resolveExpiresAt(provider: NormalizeProvider, providerExpiry: string | Date | null | undefined, postedAt: Date | null): Date | null {
  if (NO_DATE_EXPIRY_PROVIDERS.includes(provider)) return null;
  const explicit = toDate(providerExpiry ?? null);
  if (explicit && explicit.getUTCFullYear() >= 2000) return explicit;
  return postedAt ? new Date(postedAt.getTime() + DEFAULT_EXPIRY_DAYS * DAY_MS) : null;
}
