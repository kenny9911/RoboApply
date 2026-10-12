// server/src/features/network/contactsSync.ts — `contacts-sync` (04:45 UTC daily; WP-54, OPS-A10, H15).
//
// Hiring contacts are recruiters from our recruiter banks (RoboHire for
// RoboApply, GoHire for GoApply) who OPTED IN to being contactable by
// candidates. The sync:
//
//   1. reads the opt-in records through the bank's API (OPS-A10), configured per
//      brand by `CONTACT_OPTIN_API_URL` + `CONTACT_OPTIN_API_KEY`
//      (`CN_` prefixed for GoApply; brandEnv, no fallback across brands);
//   2. reads the opted-in recruiters' display fields (name, job title, company)
//      from the bank DB through WP-16b's `bankClients` seam (read-only, kill
//      switches, cross-tenant guard and the GoHire TLS rule apply);
//   3. upserts one RAContact (source 'bank_recruiter') per recruiter with
//      `consentBasis` = the record's basis, `sourceRef` =
//      `<bank>:<recruiterId>|optin:<recordId>@<optedInAt ISO>` and
//      `companyName` = the company as the recruiter's bank profile writes it;
//   4. deletes the contacts whose opt-in is withdrawn or no longer listed
//      (only after the whole record list was read).
//
// H15: THIS FILE IS THE ONLY WRITER OF `RAContact.consentBasis`
// (consentBasis.test.ts enforces it). No migration, backfill or other path may
// set it, and nothing is assumed: no API configured → nothing is written.

import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import { brandEnv, type EnvSource } from '../../platform/brand/brandEnv.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import type { CronResult } from '../../platform/queue/index.js';

export type BankId = 'robohire' | 'gohire';

/** One opt-in record as the bank API returns it. */
export const OptInRecordSchema = z.object({
  id: z.string().min(1).max(128),
  recruiterUserId: z.string().min(1).max(128),
  /** false or a withdrawnAt means the recruiter is no longer contactable. */
  optedIn: z.boolean(),
  optedInAt: z.string().datetime({ offset: true }),
  withdrawnAt: z.string().datetime({ offset: true }).nullable().optional(),
  /** Version of the consent text the recruiter agreed to. */
  consentTextVersion: z.string().max(64).nullable().optional(),
});
export type OptInRecord = z.infer<typeof OptInRecordSchema>;

export const OptInPageSchema = z.object({
  records: z.array(OptInRecordSchema).max(1_000),
  next: z.string().max(512).nullable().optional(),
});

export interface BankRecruiter {
  id: string;
  name: string | null;
  jobTitle: string | null;
  company: string | null;
}

export interface SyncedContact {
  id: string;
  sourceRef: string | null;
}

export interface ContactsSyncPorts {
  /** Every opt-in record (all pages), or null when the API is not configured. Throws on a failed read. */
  fetchOptInRecords: () => Promise<OptInRecord[] | null>;
  /** null when the bank is switched off or not configured. */
  bankReader: () => { readRecruiters(ids: string[]): Promise<BankRecruiter[]> } | null;
  /** Existing bank_recruiter contacts of this bank in this market. */
  listSynced: (market: string, bank: BankId) => Promise<SyncedContact[]>;
  upsert: (input: {
    existingId: string | null;
    market: string;
    sourceRef: string;
    consentBasis: string;
    companyNameNormalized: string;
    /** The company as the bank profile writes it (SR-54-2). */
    companyName: string;
    fullName: string;
    firstName: string | null;
    title: string | null;
  }) => Promise<void>;
  remove: (ids: string[]) => Promise<number>;
  normalizeCompany: (name: string) => string;
  bank: BankId;
}

/** `<bank>:<recruiterId>|optin:<recordId>@<ISO>` */
export function syncSourceRef(bank: BankId, record: Pick<OptInRecord, 'id' | 'recruiterUserId' | 'optedInAt'>): string {
  return `${bank}:${record.recruiterUserId}|optin:${record.id}@${new Date(record.optedInAt).toISOString()}`;
}

/** The recruiter id a synced contact belongs to (null for any other shape). */
export function recruiterIdOf(bank: BankId, sourceRef: string | null): string | null {
  const m = new RegExp(`^${bank}:([^|]+)\\|optin:`).exec(sourceRef ?? '');
  return m ? m[1]! : null;
}

export function isActive(record: OptInRecord, now: Date): boolean {
  if (!record.optedIn) return false;
  if (record.withdrawnAt) return false;
  const at = new Date(record.optedInAt);
  return !Number.isNaN(at.getTime()) && at.getTime() <= now.getTime() + 5 * 60_000;
}

/** Run one sync for a brand. Pure over its ports (tests pass fakes). */
export async function syncContacts(ports: ContactsSyncPorts, market: string, now: Date): Promise<CronResult> {
  const records = await ports.fetchOptInRecords();
  if (records === null) return { skipped: 'optin_api_not_configured', processed: 0 };
  const reader = ports.bankReader();
  if (!reader) return { skipped: 'bank_not_configured', processed: 0 };

  // The newest record per recruiter decides.
  const latest = new Map<string, OptInRecord>();
  for (const r of records) {
    const prev = latest.get(r.recruiterUserId);
    if (!prev || new Date(r.optedInAt).getTime() >= new Date(prev.optedInAt).getTime()) latest.set(r.recruiterUserId, r);
  }
  const active = [...latest.values()].filter((r) => isActive(r, now));
  const recruiters = active.length ? await reader.readRecruiters(active.map((r) => r.recruiterUserId)) : [];
  const byId = new Map(recruiters.map((r) => [r.id, r]));

  const existing = await ports.listSynced(market, ports.bank);
  const existingByRecruiter = new Map<string, string>();
  for (const c of existing) {
    const rid = recruiterIdOf(ports.bank, c.sourceRef);
    if (rid) existingByRecruiter.set(rid, c.id);
  }

  let upserted = 0;
  let skippedNoProfile = 0;
  const keep = new Set<string>();
  for (const record of active) {
    const recruiter = byId.get(record.recruiterUserId);
    const fullName = recruiter?.name?.trim() ?? '';
    const companyNameNormalized = ports.normalizeCompany(recruiter?.company ?? '');
    if (!recruiter || !fullName || !companyNameNormalized) {
      // No name or company to show: not listed (we never fill a person in).
      skippedNoProfile += 1;
      continue;
    }
    const existingId = existingByRecruiter.get(record.recruiterUserId) ?? null;
    await ports.upsert({
      existingId,
      market,
      sourceRef: syncSourceRef(ports.bank, record),
      consentBasis: `recruiter_opt_in:${record.id}${record.consentTextVersion ? `:v${record.consentTextVersion}` : ''}`,
      companyNameNormalized,
      companyName: (recruiter.company ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
      fullName,
      firstName: fullName.split(/\s+/)[0] ?? null,
      title: recruiter.jobTitle?.trim() || null,
    });
    if (existingId) keep.add(existingId);
    upserted += 1;
  }
  // Withdrawn, expired or unlisted opt-ins (and recruiters we can no longer show) lose their contact row.
  const stale = existing.filter((c) => !keep.has(c.id)).map((c) => c.id);
  const removed = stale.length ? await ports.remove(stale) : 0;
  return { processed: upserted + removed, upserted, removed, skippedNoProfile, records: records.length };
}

// ── Production ports ─────────────────────────────────────────────────────

const PAGE_LIMIT = 50;
const FETCH_TIMEOUT_MS = 10_000;

/** The opt-in API reader for a brand, or a reader that returns null when it is not configured. */
export function optInApiReader(brand: ProductBrand, env: EnvSource = process.env, fetchImpl: typeof fetch = fetch): () => Promise<OptInRecord[] | null> {
  return async () => {
    const url = brandEnv(brand, 'CONTACT_OPTIN_API_URL', env);
    const key = brandEnv(brand, 'CONTACT_OPTIN_API_KEY', env);
    if (!url || !key) return null;
    if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url)) return null;
    const out: OptInRecord[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < PAGE_LIMIT; page++) {
      const u = new URL(url);
      if (cursor) u.searchParams.set('cursor', cursor);
      const res = await fetchImpl(u.toString(), {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`contact opt-in API answered ${res.status}`);
      const parsed = OptInPageSchema.parse(await res.json());
      out.push(...parsed.records);
      cursor = parsed.next ?? null;
      if (!cursor) return out;
    }
    throw new Error('contact opt-in API: too many pages');
  };
}

type BankClientsSeam = {
  getBankClient(b: BankId): unknown;
  isBankEnabled(b: BankId): boolean;
};

/** Read-only recruiter reads through WP-16b's bankClients seam. */
export function bankRecruiterReader(seam: BankClientsSeam, bank: BankId): ContactsSyncPorts['bankReader'] {
  return () => {
    if (!seam.isBankEnabled(bank)) return null;
    const client = seam.getBankClient(bank) as { user: { findMany(args: unknown): Promise<BankRecruiter[]> } } | null;
    if (!client) return null;
    return {
      async readRecruiters(ids) {
        const out: BankRecruiter[] = [];
        for (let i = 0; i < ids.length; i += 500) {
          out.push(
            ...(await client.user.findMany({
              where: { id: { in: ids.slice(i, i + 500) }, isActive: true },
              select: { id: true, name: true, jobTitle: true, company: true },
            })),
          );
        }
        return out;
      },
    };
  };
}

/**
 * The recruiter who posted a bank job (bank `Job.userId` for `Job.id`), read-only
 * through bankClients. Used at request time to pick the job's hiring contact
 * (service.ts hiringContact). null when the bank is off, unreachable or the job is gone.
 */
export function bankJobPosterReader(seam: BankClientsSeam): (bank: BankId, externalId: string) => Promise<string | null> {
  return async (bank, externalId) => {
    if (!seam.isBankEnabled(bank)) return null;
    const client = seam.getBankClient(bank) as { job: { findUnique(args: unknown): Promise<{ userId: string | null } | null> } } | null;
    if (!client) return null;
    const row = await client.job.findUnique({ where: { id: externalId }, select: { userId: true } });
    return row?.userId || null;
  };
}

/** Prisma writes for the synced rows (the sole consentBasis writer). */
export function prismaSyncedContacts(db: typeof prisma = prisma): Pick<ContactsSyncPorts, 'listSynced' | 'upsert' | 'remove'> {
  return {
    async listSynced(market, bank) {
      return db.rAContact.findMany({
        where: { market, source: 'bank_recruiter', ownerUserId: null, sourceRef: { startsWith: `${bank}:` } },
        select: { id: true, sourceRef: true },
      });
    },
    async upsert(input) {
      const data = {
        sourceRef: input.sourceRef,
        consentBasis: input.consentBasis,
        companyNameNormalized: input.companyNameNormalized,
        companyName: input.companyName,
        fullName: input.fullName,
        firstName: input.firstName,
        title: input.title,
      };
      if (input.existingId) {
        await db.rAContact.update({ where: { id: input.existingId }, data });
        return;
      }
      await db.rAContact.create({ data: { ...data, market: input.market, source: 'bank_recruiter', ownerUserId: null } });
    },
    async remove(ids) {
      const res = await db.rAContact.deleteMany({ where: { id: { in: ids }, source: 'bank_recruiter', ownerUserId: null } });
      return res.count;
    },
  };
}
