// backend/src/roboapply/v2/lib/raBankProviders.ts
//
// The bank retrieval seam: one provider per recruiter job bank. High-recall
// retrieval of OPEN recruiter `Job` rows (+ Company), NEVER throws → returns
// null on failure so the orchestrator degrades to the other bank.
//
// `search` takes an INJECTED client so it is unit-testable against a fake bank
// client with no live DB (spec §3.4). `buildBankJobWhere` is a separately
// unit-tested pure function.
//
// A bank that is read over HTTPS (raBankClients.bankTransport 'syndication' or
// 'api': GoHire through the syndication endpoint, or through the interim list
// endpoint) is searched in OUR synced mirror of the bank instead: the open,
// public, canonical RAJob rows the ingest adapter wrote for it
// (`searchBankMirror`). The TRANSPORT decides (`bankReadsMirror`), before any
// database client is asked for: while the sync runs over HTTPS a search never
// opens the bank's database, whatever database URL is configured (MARKET_STRATEGY
// §1.4, JC-2). The mirror holds only rows that are listable (published, named
// employer, a real posting page, inside their stated validity), and the read
// applies the feed's own lifecycle and fraud scope on top (open, not closed,
// no fraud flag: feed/sql.ts `scopePredicates`; the mainland fraud rules flag
// bank rows too), so it does not surface a job the feed hides. How fresh the mirror is goes into the
// search telemetry (`bankMirrorSyncAge`), so a mirror that has stopped moving
// is visible instead of looking like a quiet bank.

import { logger } from '../../../services/LoggerService.js';
import type { ExtendedPrismaClient } from '../../../lib/prisma.js';
import { bankReadsMirror, getBankClient, getMirrorClient, isBankEnabled } from './raBankClients.js';
import { bankMarket, dedupeStrings, PER_BANK_QUERY_TAKE, PER_BANK_CANDIDATE_CAP } from './raCrossBankMatch.js';
import { canonicalizeTag } from './raCrossBankMatch.js';
import type { BankId, BankJobRow, BankSearchIntent } from '../types/crossBank.js';

const TAG = 'RA_V2_CROSSBANK';

export interface BankJobProvider {
  readonly bank: BankId;
  isEnabled(): boolean;
  search(
    client: ExtendedPrismaClient,
    intent: BankSearchIntent,
    ctx?: { requestId?: string; signal?: AbortSignal },
  ): Promise<BankJobRow[] | null>;
}

/**
 * Pure WHERE builder. Only HARD filters are true dealbreakers (open + fresh);
 * everything else is an OR-signal so retrieval never starves the funnel
 * (salary/level/work-mode are ranking weights, NEVER SQL cuts). [FIX-5]
 */
export function buildBankJobWhere(
  intent: BankSearchIntent,
): Record<string, unknown> {
  const titles = dedupeStrings(intent.titles).slice(0, 14);
  const keywords = dedupeStrings(intent.mustKeywords).slice(0, 15);
  // Canonical bare+namespaced forms so `hasSome` matches whichever grammar the
  // bank actually stored.
  const tagForms = dedupeStrings(intent.tags.flatMap((t) => canonicalizeTag(t))).slice(0, 40);

  const or: Record<string, unknown>[] = [];
  for (const t of titles) or.push({ title: { contains: t, mode: 'insensitive' } });
  for (const k of keywords) {
    or.push({ description: { contains: k, mode: 'insensitive' } });
    or.push({ qualifications: { contains: k, mode: 'insensitive' } });
  }
  if (tagForms.length > 0) {
    or.push({ requiredTagSet: { hasSome: tagForms } });
    or.push({ preferredTagSet: { hasSome: tagForms } });
    or.push({ requiredKeywordSet: { hasSome: keywords } });
  }

  return {
    status: 'open',
    publishedAt: { not: null, gte: intent.freshnessCutoff },
    ...(or.length > 0 ? { OR: or } : {}),
  };
}

const JOB_SELECT = {
  id: true,
  title: true,
  description: true,
  qualifications: true,
  hardRequirements: true,
  niceToHave: true,
  benefits: true,
  location: true,
  // NB: the recruiter `Job` model has NO locationCity/locationCountry columns
  // (those live only on RAJob). We derive city from `location` below. [review FIX-4]
  workType: true,
  employmentType: true,
  experienceLevel: true,
  salaryMin: true,
  salaryMax: true,
  salaryCurrency: true,
  salaryPeriod: true,
  requiredTagSet: true,
  preferredTagSet: true,
  requiredKeywordSet: true,
  preferredKeywordSet: true,
  matchInviteScore: true,
  publishedAt: true,
  companyName: true,
  company: { select: { name: true, logoUrl: true } },
} as const;

function normalizeBankJobRow(bank: BankId, raw: Record<string, unknown>): BankJobRow {
  const company = (raw.company ?? null) as { name?: string | null; logoUrl?: string | null } | null;
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const publishedAt =
    raw.publishedAt instanceof Date
      ? raw.publishedAt
      : typeof raw.publishedAt === 'string'
        ? new Date(raw.publishedAt)
        : null;
  return {
    bank,
    retrievedVia: 'title',
    job: {
      id: String(raw.id),
      title: str(raw.title) ?? '',
      description: str(raw.description),
      qualifications: str(raw.qualifications),
      hardRequirements: str(raw.hardRequirements),
      niceToHave: str(raw.niceToHave),
      benefits: str(raw.benefits),
      location: str(raw.location),
      // Job has no city/country columns — derive city from the first comma
      // token of `location` (feeds the dedup fingerprint + RAJob mirror).
      locationCity: str(raw.location)?.split(',')[0]?.trim() || null,
      locationCountry: null,
      workType: str(raw.workType),
      employmentType: str(raw.employmentType),
      experienceLevel: str(raw.experienceLevel),
      salaryMin: num(raw.salaryMin),
      salaryMax: num(raw.salaryMax),
      salaryCurrency: str(raw.salaryCurrency),
      salaryPeriod: str(raw.salaryPeriod),
      requiredTagSet: arr(raw.requiredTagSet),
      preferredTagSet: arr(raw.preferredTagSet),
      requiredKeywordSet: arr(raw.requiredKeywordSet),
      preferredKeywordSet: arr(raw.preferredKeywordSet),
      matchInviteScore: num(raw.matchInviteScore),
      publishedAt,
    },
    company: {
      companyName: str(raw.companyName) ?? company?.name ?? '',
      companyLogoUrl: company?.logoUrl ?? null,
    },
  };
}

function makeProvider(bank: BankId): BankJobProvider {
  return {
    bank,
    isEnabled: () => isBankEnabled(bank),
    async search(client, intent, ctx) {
      try {
        const where = buildBankJobWhere(intent);
        const rows: Record<string, unknown>[] = await (client as any).job.findMany({
          where,
          select: JOB_SELECT,
          orderBy: { publishedAt: 'desc' },
          take: Math.min(intent.take || PER_BANK_QUERY_TAKE, PER_BANK_QUERY_TAKE),
        });
        // Within-bank dedup on Job.id, cap PER_BANK_CANDIDATE_CAP.
        const seen = new Set<string>();
        const out: BankJobRow[] = [];
        for (const raw of rows) {
          const id = String(raw.id);
          if (seen.has(id)) continue;
          seen.add(id);
          out.push(normalizeBankJobRow(bank, raw));
          if (out.length >= PER_BANK_CANDIDATE_CAP) break;
        }
        return out;
      } catch (err) {
        logger.error(TAG, `bank ${bank} retrieval failed`, {
          error: err instanceof Error ? err.message : String(err),
        }, ctx?.requestId);
        return null; // degrade — never throw
      }
    },
  };
}

export const robohireBankProvider = makeProvider('robohire');
export const gohireBankProvider = makeProvider('gohire');

export const BANK_PROVIDERS: Record<BankId, BankJobProvider> = {
  robohire: robohireBankProvider,
  gohire: gohireBankProvider,
};

// ─── The synced mirror (a bank with no database client) ────────────────────

/**
 * WHERE over our RAJob mirror of a bank: the bank's rows in its own market
 * that are open (neither archived nor closed), public and canonical, inside
 * their stated validity, as fresh as the live bank search asks (the same bound
 * on the posting date), and an OR of the same title / description / skills
 * signals. The fraud scope is applied to the rows read (`mirrorRowListable`):
 * `fraudFlags` is a Json column, and "null, not a list or an empty list" is
 * not one Prisma filter.
 */
export function buildMirrorJobWhere(bank: BankId, intent: BankSearchIntent, now: Date = new Date()): Record<string, unknown> {
  const titles = dedupeStrings(intent.titles).slice(0, 14);
  const keywords = dedupeStrings(intent.mustKeywords).slice(0, 15);
  const or: Record<string, unknown>[] = [];
  for (const t of titles) or.push({ title: { contains: t, mode: 'insensitive' } });
  for (const k of keywords) or.push({ descriptionPlain: { contains: k, mode: 'insensitive' } });
  // The bank's requiredKeywordSet is stored lower-cased as RAJob.skills.
  if (keywords.length > 0) or.push({ skills: { hasSome: keywords.map((k) => k.toLowerCase()) } });
  return {
    sourceBoard: bank,
    market: bankMarket(bank),
    visibility: 'public',
    archivedAt: null,
    closedAt: null,
    isCanonical: true,
    postedAt: { not: null, gte: intent.freshnessCutoff },
    // A validity the bank stated and that has passed: the feed hides such a row at once, maintenance archives it later.
    AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    ...(or.length > 0 ? { OR: or } : {}),
  };
}

const MIRROR_SELECT = {
  externalId: true,
  title: true,
  description: true,
  location: true,
  locationCity: true,
  locationCountry: true,
  workModel: true,
  employmentType: true,
  salaryMin: true,
  salaryMax: true,
  salaryCurrency: true,
  salaryPeriod: true,
  skills: true,
  postedAt: true,
  companyName: true,
  companyLogoUrl: true,
  // Read to decide (`mirrorRowListable`); never handed on.
  fraudFlags: true,
} as const;

/** The feed's fraud scope for one mirrored row: listed unless `fraudFlags` is a non-empty list (feed/sql.ts `scopePredicates`). */
export function mirrorRowListable(raw: { fraudFlags?: unknown }): boolean {
  return !(Array.isArray(raw.fraudFlags) && raw.fraudFlags.length > 0);
}

/** One mirrored RAJob row → the BankJobRow the pre-matcher reads. Fields the mirror does not hold stay empty (never guessed). */
function mirrorRowToBankJobRow(bank: BankId, raw: Record<string, unknown>): BankJobRow {
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    bank,
    retrievedVia: 'title',
    job: {
      id: String(raw.externalId),
      title: str(raw.title) ?? '',
      description: str(raw.description),
      qualifications: null,
      hardRequirements: null,
      niceToHave: null,
      benefits: null,
      location: str(raw.location),
      locationCity: str(raw.locationCity),
      locationCountry: str(raw.locationCountry),
      workType: str(raw.workModel),
      employmentType: str(raw.employmentType),
      experienceLevel: null,
      salaryMin: num(raw.salaryMin),
      salaryMax: num(raw.salaryMax),
      salaryCurrency: str(raw.salaryCurrency),
      salaryPeriod: str(raw.salaryPeriod),
      requiredTagSet: [],
      preferredTagSet: [],
      requiredKeywordSet: arr(raw.skills),
      preferredKeywordSet: [],
      matchInviteScore: null,
      publishedAt: raw.postedAt instanceof Date ? raw.postedAt : null,
    },
    company: { companyName: str(raw.companyName) ?? '', companyLogoUrl: str(raw.companyLogoUrl) },
  };
}

/**
 * Retrieval over our synced mirror of a bank (never throws → null on failure,
 * like every provider). `client` is injected for tests; the default is the
 * active-brand client that holds RAJob.
 */
export async function searchBankMirror(
  bank: BankId,
  intent: BankSearchIntent,
  ctx?: { requestId?: string; signal?: AbortSignal },
  client: ExtendedPrismaClient = getMirrorClient(),
): Promise<BankJobRow[] | null> {
  try {
    const rows: Record<string, unknown>[] = await (client as any).rAJob.findMany({
      where: buildMirrorJobWhere(bank, intent),
      select: MIRROR_SELECT,
      orderBy: { postedAt: 'desc' },
      take: Math.min(intent.take || PER_BANK_QUERY_TAKE, PER_BANK_QUERY_TAKE),
    });
    return rows.filter(mirrorRowListable).slice(0, PER_BANK_CANDIDATE_CAP).map((raw) => mirrorRowToBankJobRow(bank, raw));
  } catch (err) {
    logger.error(TAG, `bank ${bank} mirror retrieval failed`, { error: err instanceof Error ? err.message : String(err) }, ctx?.requestId);
    return null; // degrade — never throw
  }
}

/** How fresh our mirror of a bank is (search telemetry; counts and times only). */
export interface BankMirrorSyncAge {
  /** The newest `lastSeenAt` among the bank's mirrored rows: the last time the sync wrote one. Null: the mirror is empty. */
  newestSeenAt: string | null;
  /** Milliseconds since `newestSeenAt`; null for an empty mirror. */
  ageMs: number | null;
  /**
   * The last time the bank's standing sync query ran, whether or not it had
   * anything to write. A cursor sync writes a row only when the bank changed
   * it or when it reads the bank again from the beginning (every 7 days by
   * default), so on a quiet bank `newestSeenAt` can be days old while the sync
   * is healthy: read the two together. Null: no sync query has run.
   */
  lastSyncAt: string | null;
  /** True when that last run ended in an error. */
  lastSyncFailed: boolean;
}

/**
 * The sync age of our mirror of a bank. Two small reads on the client that
 * holds RAJob; never throws (null when either read fails: telemetry must not
 * cost a search its results).
 */
export async function bankMirrorSyncAge(bank: BankId, now: Date = new Date(), client: ExtendedPrismaClient = getMirrorClient()): Promise<BankMirrorSyncAge | null> {
  try {
    const market = bankMarket(bank);
    const [newest, sync] = await Promise.all([
      client.rAJob.findFirst({ where: { sourceBoard: bank, market }, orderBy: { lastSeenAt: 'desc' }, select: { lastSeenAt: true } }),
      client.rAIngestQuery.findFirst({
        where: { provider: bank === 'gohire' ? 'bank_gohire' : 'bank_robohire', market, origin: 'bank_sync' },
        orderBy: { lastRunAt: { sort: 'desc', nulls: 'last' } },
        select: { lastRunAt: true, lastError: true },
      }),
    ]);
    const seen: Date | null = newest?.lastSeenAt instanceof Date ? newest.lastSeenAt : null;
    const ran: Date | null = sync?.lastRunAt instanceof Date ? sync.lastRunAt : null;
    return {
      newestSeenAt: seen ? seen.toISOString() : null,
      ageMs: seen ? Math.max(0, now.getTime() - seen.getTime()) : null,
      lastSyncAt: ran ? ran.toISOString() : null,
      lastSyncFailed: typeof sync?.lastError === 'string' && sync.lastError !== '',
    };
  } catch {
    return null;
  }
}

/**
 * Convenience: pick the read by the bank's transport and run it. A bank whose
 * transport is HTTPS ('syndication' or 'api') is searched in our synced
 * mirror and no database client is asked for; a bank on the database
 * transport is searched in its database, as before; null when the bank has
 * neither.
 */
export async function searchBank(
  bank: BankId,
  intent: BankSearchIntent,
  ctx?: { requestId?: string; signal?: AbortSignal },
): Promise<BankJobRow[] | null> {
  if (bankReadsMirror(bank)) return searchBankMirror(bank, intent, ctx);
  const client = getBankClient(bank);
  if (client) return BANK_PROVIDERS[bank].search(client, intent, ctx);
  return null;
}

export const __test = { buildBankJobWhere, buildMirrorJobWhere, mirrorRowToBankJobRow, normalizeBankJobRow, JOB_SELECT, MIRROR_SELECT };
