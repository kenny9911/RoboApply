// server/src/features/jobs/ingest/adapters/bank.ts — recruiter-bank cursor sync (WP-16b, ARCH §4.2).
//
// One RAIngestQuery per bank (origin 'bank_sync') keeps `params.cursor` =
// "<updatedAt ISO>|<Job.id>". Each step reads the bank's recruiter `Job`
// rows changed after the cursor, oldest first, WITHOUT the LLM explorer:
//   - status 'open' AND publishedAt IS NOT NULL → synced (drafts, paused,
//     closed and unpublished jobs never enter RAJob);
//   - anything else that we may hold → closed (closeReason 'bank_closed').
// Bank clients are read-only; the cross-tenant guard
// (RA_CROSSBANK_CROSS_TENANT_CONFIRMED) and the GoHire TLS rule (CN-E-05:
// sslmode=require) are enforced by raBankClients.isBankEnabled/getBankClient.
//
// Honesty (D3, H12/H13, OPS-A4):
//   - fromRecruiterBank = true (the normalizer sets it from the provider);
//   - employerVerified ONLY from the bank's verified-employer record;
//   - publicDisplay = true ONLY when the bank records the employer's consent
//     to syndicate. Today's bank schema has neither field, so both read false
//     through `readBankEmployerSignals` until RoboHire/GoHire add them
//     (handoff: Schema requests SR-16b-3/SR-16b-4).
//   - "Direct from employer" is never derived here.

import { bankMarket, getBankClient, isBankEnabled } from '../../../../roboapply/v2/lib/raBankClients.js';
import { bankDisplayName, synthesizeApplyUrl } from '../../../../roboapply/v2/lib/raCrossBankMatch.js';
import type { ExtendedPrismaClient } from '../../../../lib/prisma.js';
import type { Prisma } from '../../../../generated/prisma/client.js';
import { inputFromBankJob, type ProviderJobInput } from '../../normalize/index.js';
import { bankPageSize } from '../config.js';
import type { JobSourceAdapter, SourceFetchResult } from '../../sources/index.js';

export type BankId = 'robohire' | 'gohire';

/** Columns read from the recruiter bank. Never internal notes, AI caches or tenant data. */
export const BANK_SYNC_SELECT = {
  id: true,
  status: true,
  publishedAt: true,
  updatedAt: true,
  title: true,
  description: true,
  qualifications: true,
  hardRequirements: true,
  niceToHave: true,
  benefits: true,
  location: true,
  locations: true,
  workType: true,
  employmentType: true,
  experienceLevel: true,
  salaryMin: true,
  salaryMax: true,
  salaryCurrency: true,
  salaryPeriod: true,
  salaryText: true,
  companyName: true,
  requiredKeywordSet: true,
  company: { select: { id: true, name: true, logoUrl: true, website: true, industry: true, size: true, headcount: true, founded: true } },
} as const;

/** A bank Job row as selected (structural, so tests need no client). */
export interface BankSyncRow {
  id: string;
  status: string | null;
  publishedAt: Date | null;
  updatedAt: Date;
  title: string | null;
  description?: string | null;
  qualifications?: string | null;
  hardRequirements?: string | null;
  niceToHave?: string | null;
  benefits?: string | null;
  location?: string | null;
  locations?: unknown;
  workType?: string | null;
  employmentType?: string | null;
  experienceLevel?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  salaryPeriod?: string | null;
  salaryText?: string | null;
  companyName?: string | null;
  requiredKeywordSet?: string[] | null;
  company?: {
    id?: string | null;
    name?: string | null;
    logoUrl?: string | null;
    website?: string | null;
    industry?: string | null;
    size?: string | null;
    headcount?: number | null;
    founded?: number | null;
  } | null;
}

export interface BankEmployerSignals {
  employerVerified: boolean;
  syndicationConsent: boolean;
}

/**
 * The bank's verified-employer and consent-to-syndicate records for a job.
 * Narrow typed adapter: reads `employerVerified` / `syndicationConsentAt`
 * when the bank row carries them (a future bank schema), else false. Never
 * inferred from anything else (OPS-A4, D3).
 */
export function readBankEmployerSignals(row: object): BankEmployerSignals {
  const r = row as Record<string, unknown>;
  const company = (r.company && typeof r.company === 'object' ? r.company : {}) as Record<string, unknown>;
  return {
    employerVerified: r.employerVerified === true || company.employerVerified === true,
    syndicationConsent: r.syndicationConsentAt instanceof Date || (typeof r.syndicationConsentAt === 'string' && r.syndicationConsentAt !== ''),
  };
}

/** True when a bank job may sync: open AND published (drafts never sync). */
export function isSyncableBankJob(row: Pick<BankSyncRow, 'status' | 'publishedAt'>): boolean {
  return row.status === 'open' && row.publishedAt != null;
}

/** "<ISO>|<id>" → parts; null for no/invalid cursor (full sync). */
export function parseBankCursor(cursor: string | null | undefined): { updatedAt: Date; id: string } | null {
  if (!cursor) return null;
  const at = cursor.indexOf('|');
  if (at <= 0) return null;
  const updatedAt = new Date(cursor.slice(0, at));
  const id = cursor.slice(at + 1);
  if (Number.isNaN(updatedAt.getTime()) || !id) return null;
  return { updatedAt, id };
}

export function formatBankCursor(row: Pick<BankSyncRow, 'updatedAt' | 'id'>): string {
  return `${row.updatedAt.toISOString()}|${row.id}`;
}

/** Prisma `where` for rows after the cursor (ordered by updatedAt, id). */
export function bankCursorWhere(cursor: { updatedAt: Date; id: string } | null): Prisma.JobWhereInput {
  if (!cursor) return {};
  return { OR: [{ updatedAt: { gt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, id: { gt: cursor.id } }] };
}

/** One bank row → normalizer input (null when the row cannot be shown). */
export function inputFromBankSyncRow(bank: BankId, row: BankSyncRow, now: Date): ProviderJobInput | null {
  const signals = readBankEmployerSignals(row);
  const input = inputFromBankJob(
    {
      id: row.id,
      title: row.title,
      description: row.description ?? null,
      qualifications: row.qualifications ?? null,
      hardRequirements: row.hardRequirements ?? null,
      niceToHave: row.niceToHave ?? null,
      benefits: row.benefits ?? null,
      location: row.location ?? null,
      locations: row.locations,
      workType: row.workType ?? null,
      employmentType: row.employmentType ?? null,
      experienceLevel: row.experienceLevel ?? null,
      salaryMin: row.salaryMin ?? null,
      salaryMax: row.salaryMax ?? null,
      salaryCurrency: row.salaryCurrency ?? null,
      salaryPeriod: row.salaryPeriod ?? null,
      salaryText: row.salaryText ?? null,
      publishedAt: row.publishedAt,
      companyName: row.companyName ?? null,
      company: row.company ? { id: row.company.id ?? null, name: row.company.name ?? null, logoUrl: row.company.logoUrl ?? null } : null,
      requiredKeywordSet: row.requiredKeywordSet ?? null,
    },
    bank,
    { applyUrl: synthesizeApplyUrl(bank, row.id), employerVerified: signals.employerVerified, syndicationConsent: signals.syndicationConsent },
  );
  if (!input) return null;
  const c = row.company;
  if (c && (c.website || c.industry || c.size || c.headcount || c.founded)) {
    input.companyFacts = {
      source: `bank:${bank}`,
      fetchedAt: now,
      website: c.website ?? null,
      industries: c.industry ? [c.industry] : null,
      size: c.size ?? null,
      employeeCount: c.headcount ?? null,
      foundedYear: c.founded ?? null,
    };
  }
  input.sourcePublisher = null; // the bank itself is the source (sourceName = RoboHire / GoHire)
  return input;
}

/** Reads one page of bank rows after the cursor. */
export type BankPageReader = (bank: BankId, cursor: { updatedAt: Date; id: string } | null, take: number) => Promise<BankSyncRow[] | null>;

/** Default reader: the bank's typed Prisma client (read-only). Null when the bank is unreachable. */
export const readBankPage: BankPageReader = async (bank, cursor, take) => {
  const client: ExtendedPrismaClient | null = getBankClient(bank);
  if (!client) return null;
  const rows = await client.job.findMany({
    where: bankCursorWhere(cursor),
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take,
    select: BANK_SYNC_SELECT,
  });
  return rows as unknown as BankSyncRow[];
};

export interface BankAdapterDeps {
  read?: BankPageReader;
  isEnabled?: () => boolean;
  pageSize?: () => number;
}

export function createBankAdapter(bank: BankId, deps: BankAdapterDeps = {}): JobSourceAdapter {
  const read = deps.read ?? readBankPage;
  const provider = bank === 'gohire' ? 'bank_gohire' : 'bank_robohire';
  return {
    provider,
    kind: 'cursor',
    markets: [bankMarket(bank)],
    sourceBoards: [bank],
    isEnabled: () => {
      try {
        return deps.isEnabled ? deps.isEnabled() : isBankEnabled(bank);
      } catch {
        return false;
      }
    },
    supportsCountry: () => true,
    dailyCallLimit: () => null,
    async fetch(query, ctx): Promise<SourceFetchResult> {
      const take = deps.pageSize?.() ?? bankPageSize();
      const cursor = parseBankCursor(query.params.cursor);
      let rows: BankSyncRow[] | null;
      try {
        rows = await read(bank, cursor, take);
      } catch (err) {
        return { jobs: [], calls: 1, error: `${bankDisplayName(bank)} bank read failed: ${err instanceof Error ? err.message.slice(0, 160) : 'error'}` };
      }
      if (rows === null) return { jobs: [], calls: 0, error: 'bank_unavailable' };
      const jobs: ProviderJobInput[] = [];
      const closedExternalIds: string[] = [];
      for (const row of rows) {
        if (!isSyncableBankJob(row)) {
          closedExternalIds.push(row.id);
          continue;
        }
        const input = inputFromBankSyncRow(bank, row, ctx.now);
        if (input) jobs.push(input);
      }
      const last = rows[rows.length - 1];
      return {
        jobs,
        calls: 1,
        closedExternalIds,
        cursor: last ? formatBankCursor(last) : (query.params.cursor ?? null),
        exhausted: rows.length < take,
      };
    },
  };
}
