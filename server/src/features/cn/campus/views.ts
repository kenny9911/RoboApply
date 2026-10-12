// server/src/features/cn/campus/views.ts — pure mapping and query helpers of
// the campus calendar (WP-58). No I/O.

import type { Prisma } from '../../../generated/prisma/client.js';
import {
  CAMPUS_EVENT_KINDS,
  CAMPUS_EVENT_STATUSES,
  CAMPUS_REVERIFY_DAYS,
  CampusStagesSchema,
  campusCompanySlug,
  type AdminCampusEventView,
  type CampusEventView,
  type CampusSubscriptionView,
} from './contract.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The RACampusEvent columns the area reads (a typed narrow slice of the row). */
export interface CampusEventRow {
  id: string;
  market: string;
  companyName: string;
  companyId: string | null;
  title: string;
  graduationClass: string;
  kind: string;
  applyOpensAt: Date | null;
  applyClosesAt: Date | null;
  stages: unknown;
  cities: string[];
  roles: string[];
  officialUrl: string;
  sourceUrl: string | null;
  sourceName: string | null;
  sourceNote: string | null;
  status: string;
  verifiedAt: Date | null;
  verifiedByUserId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export const CAMPUS_EVENT_SELECT = {
  id: true,
  market: true,
  companyName: true,
  companyId: true,
  title: true,
  graduationClass: true,
  kind: true,
  applyOpensAt: true,
  applyClosesAt: true,
  stages: true,
  cities: true,
  roles: true,
  officialUrl: true,
  sourceUrl: true,
  sourceName: true,
  sourceNote: true,
  status: true,
  verifiedAt: true,
  verifiedByUserId: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.RACampusEventSelect;

/** "待核实": the last verification is older than CAMPUS_REVERIFY_DAYS (or missing). */
export function needsReverify(verifiedAt: Date | null, now: Date): boolean {
  if (!verifiedAt) return true;
  return now.getTime() - verifiedAt.getTime() > CAMPUS_REVERIFY_DAYS * DAY_MS;
}

/** Stored stages, validated; malformed rows render as no stages rather than invented ones. */
export function parseStages(raw: unknown): CampusEventView['stages'] {
  const parsed = CampusStagesSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

function kindOf(raw: string): CampusEventView['kind'] {
  return (CAMPUS_EVENT_KINDS as readonly string[]).includes(raw) ? (raw as CampusEventView['kind']) : 'application';
}

function statusOf(raw: string): AdminCampusEventView['status'] {
  return (CAMPUS_EVENT_STATUSES as readonly string[]).includes(raw) ? (raw as AdminCampusEventView['status']) : 'draft';
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * Public view of a published, verified row. Returns null for anything that may
 * not be shown publicly (not published or never verified): D3, nothing goes
 * out without a human check.
 */
export function toEventView(row: CampusEventRow, now: Date, subscribed = false): CampusEventView | null {
  if (row.status !== 'published' || !row.verifiedAt || !row.officialUrl) return null;
  return {
    id: row.id,
    companyName: row.companyName,
    companySlug: campusCompanySlug(row.companyName),
    title: row.title,
    graduationClass: row.graduationClass,
    kind: kindOf(row.kind),
    applyOpensAt: iso(row.applyOpensAt),
    applyClosesAt: iso(row.applyClosesAt),
    stages: parseStages(row.stages),
    cities: row.cities,
    roles: row.roles,
    officialUrl: row.officialUrl,
    sourceUrl: row.sourceUrl,
    sourceName: row.sourceName,
    verifiedAt: row.verifiedAt.toISOString(),
    needsReverify: needsReverify(row.verifiedAt, now),
    subscribed,
  };
}

export function toAdminView(row: CampusEventRow, now: Date, verifiedByName: string | null = null): AdminCampusEventView {
  return {
    id: row.id,
    companyName: row.companyName,
    companySlug: campusCompanySlug(row.companyName),
    title: row.title,
    graduationClass: row.graduationClass,
    kind: kindOf(row.kind),
    applyOpensAt: iso(row.applyOpensAt),
    applyClosesAt: iso(row.applyClosesAt),
    stages: parseStages(row.stages),
    cities: row.cities,
    roles: row.roles,
    officialUrl: row.officialUrl,
    sourceUrl: row.sourceUrl,
    sourceName: row.sourceName,
    needsReverify: needsReverify(row.verifiedAt, now),
    status: statusOf(row.status),
    companyId: row.companyId,
    sourceNote: row.sourceNote,
    verifiedAt: iso(row.verifiedAt),
    verifiedByUserId: row.verifiedByUserId,
    verifiedByName,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CampusSubscriptionRow {
  id: string;
  kind: string;
  eventId: string | null;
  companyNameNormalized: string | null;
  graduationClass: string | null;
  channel: string;
  createdAt: Date;
}

export function toSubscriptionView(row: CampusSubscriptionRow, event: CampusEventView | null): CampusSubscriptionView {
  const channel = row.channel === 'email' || row.channel === 'wechat' ? row.channel : 'in_app';
  return {
    id: row.id,
    kind: row.kind === 'company' ? 'company' : 'event',
    eventId: row.eventId,
    companyName: row.companyNameNormalized,
    graduationClass: row.graduationClass,
    channel,
    createdAt: row.createdAt.toISOString(),
    event,
  };
}

// ── List filters ──

export interface CampusListFilter {
  /** 届别 year, e.g. 2027 → '2027届'. */
  class?: number;
  company?: string;
  role?: string;
  city?: string;
  openNow?: boolean;
}

/**
 * Where-clause of the public list: published and verified rows of the market,
 * still ahead (no stated close, or closing now or later). A programme that
 * names no city (or no role) is open to every city (role).
 */
export function campusListWhere(market: string, f: CampusListFilter, now: Date): Prisma.RACampusEventWhereInput {
  const and: Prisma.RACampusEventWhereInput[] = [];
  if (f.openNow) {
    and.push({ applyClosesAt: { gte: now } }, { OR: [{ applyOpensAt: null }, { applyOpensAt: { lte: now } }] });
  } else {
    and.push({ OR: [{ applyClosesAt: null }, { applyClosesAt: { gte: now } }] });
  }
  if (f.company?.trim()) and.push({ companyName: { contains: f.company.trim(), mode: 'insensitive' } });
  if (f.city?.trim()) and.push({ OR: [{ cities: { isEmpty: true } }, { cities: { has: f.city.trim() } }] });
  if (f.role?.trim()) {
    const role = f.role.trim();
    and.push({ OR: [{ roles: { isEmpty: true } }, { roles: { has: role } }, { title: { contains: role, mode: 'insensitive' } }] });
  }
  return {
    market,
    status: 'published',
    verifiedAt: { not: null },
    ...(f.class ? { graduationClass: `${f.class}届` } : {}),
    AND: and,
  };
}

/** Closing soonest first; programmes with no stated close date last. */
export const CAMPUS_LIST_ORDER: Prisma.RACampusEventOrderByWithRelationInput[] = [
  { applyClosesAt: { sort: 'asc', nulls: 'last' } },
  { id: 'asc' },
];

/** Offset cursor (the list is small, curated and ordered by close date). */
export function encodeCursor(offset: number): string {
  return `o${offset.toString(36)}`;
}

export function decodeCursor(cursor: string | undefined | null): number {
  if (!cursor || !/^o[0-9a-z]{1,8}$/.test(cursor)) return 0;
  const n = parseInt(cursor.slice(1), 36);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** In-memory twin of `campusListWhere` (tests and the follow/upcoming paths keep one rule). */
export function eventMatches(row: CampusEventRow, market: string, f: CampusListFilter, now: Date): boolean {
  if (row.market !== market || row.status !== 'published' || !row.verifiedAt) return false;
  if (f.class && row.graduationClass !== `${f.class}届`) return false;
  const t = now.getTime();
  if (f.openNow) {
    if (!row.applyClosesAt || row.applyClosesAt.getTime() < t) return false;
    if (row.applyOpensAt && row.applyOpensAt.getTime() > t) return false;
  } else if (row.applyClosesAt && row.applyClosesAt.getTime() < t) return false;
  const company = f.company?.trim().toLowerCase();
  if (company && !row.companyName.toLowerCase().includes(company)) return false;
  const city = f.city?.trim();
  if (city && row.cities.length && !row.cities.includes(city)) return false;
  const role = f.role?.trim();
  if (role && row.roles.length && !row.roles.includes(role) && !row.title.toLowerCase().includes(role.toLowerCase())) return false;
  return true;
}

/** Sort twin of CAMPUS_LIST_ORDER. */
export function compareByClose(a: CampusEventRow, b: CampusEventRow): number {
  const ac = a.applyClosesAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bc = b.applyClosesAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (ac !== bc) return ac < bc ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
