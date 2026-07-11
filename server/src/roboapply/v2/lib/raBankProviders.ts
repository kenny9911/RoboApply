// backend/src/roboapply/v2/lib/raBankProviders.ts
//
// The bank retrieval seam: one provider per recruiter job bank. High-recall
// retrieval of OPEN recruiter `Job` rows (+ Company), NEVER throws → returns
// null on failure so the orchestrator degrades to the other bank.
//
// `search` takes an INJECTED client so it is unit-testable against a fake bank
// client with no live DB (spec §3.4). `buildBankJobWhere` is a separately
// unit-tested pure function.

import { logger } from '../../../services/LoggerService.js';
import type { ExtendedPrismaClient } from '../../../lib/prisma.js';
import { getBankClient, isBankEnabled } from './raBankClients.js';
import { dedupeStrings, PER_BANK_QUERY_TAKE, PER_BANK_CANDIDATE_CAP } from './raCrossBankMatch.js';
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

/** Convenience: resolve client + run the provider; null on missing client. */
export async function searchBank(
  bank: BankId,
  intent: BankSearchIntent,
  ctx?: { requestId?: string; signal?: AbortSignal },
): Promise<BankJobRow[] | null> {
  const client = getBankClient(bank);
  if (!client) return null;
  return BANK_PROVIDERS[bank].search(client, intent, ctx);
}

export const __test = { buildBankJobWhere, normalizeBankJobRow, JOB_SELECT };
