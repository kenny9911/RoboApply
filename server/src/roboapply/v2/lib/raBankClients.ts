// backend/src/roboapply/v2/lib/raBankClients.ts
//
// Lazy, per-URL-cached Prisma clients for the two recruiter job banks
// (RoboHire + GoHire). Both banks share the SAME generated Prisma client
// (identical schema); only the physical DB differs. Clients are READ-ONLY from
// RoboApply's perspective — the orchestrator only calls findMany on Job/Company
// through them; every WRITE goes to the active-brand singleton `prisma`.
//
// See docs/CROSSBANK_JOBSEARCH_SPEC.md §2.3.

import {
  prisma,
  createPrismaClientForUrl,
  activeRuntimeUrl,
  cleanConnectionString,
  type ExtendedPrismaClient,
} from '../../../lib/prisma.js';
import {
  activeBank,
  resolveRoboHireDatabaseUrl,
  resolveGoHireDatabaseUrl,
} from '../../../lib/databaseUrl.js';
import type { BankId } from '../types/crossBank.js';

const cacheByUrl = new Map<string, ExtendedPrismaClient>();

function urlForBank(b: BankId): string | undefined {
  return b === 'robohire' ? resolveRoboHireDatabaseUrl() : resolveGoHireDatabaseUrl();
}

function envFlag(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === 'true';
}

/**
 * A bank is searchable when: it has a configured URL, no kill switch is set,
 * and — for the FOREIGN brand's bank — the cross-tenant white-label sign-off is
 * confirmed in env (reading another brand's recruiter jobs into a candidate
 * index crosses a contractual boundary; the active brand's OWN bank is always
 * allowed). [FIX legal / spec §2.3]
 */
export function isBankEnabled(b: BankId): boolean {
  if (!urlForBank(b)) return false;
  if (envFlag('RA_CROSSBANK_DISABLED')) return false;
  if (envFlag(`RA_CROSSBANK_${b.toUpperCase()}_DISABLED`)) return false;
  if (b !== activeBank() && !envFlag('RA_CROSSBANK_CROSS_TENANT_CONFIRMED')) return false;
  return true;
}

export function listEnabledBanks(): BankId[] {
  return (['robohire', 'gohire'] as BankId[]).filter(isBankEnabled);
}

/**
 * Resolve (and cache) a client for a bank. Returns the active-brand singleton
 * when the bank's cleaned URL points at the SAME physical DB (no 2nd pool);
 * otherwise opens one keepalive-off, read-mostly client per distinct URL.
 * Returns null when the bank is not configured. [FIX-6]
 */
export function getBankClient(b: BankId): ExtendedPrismaClient | null {
  const url = urlForBank(b);
  if (!url) return null;
  const key = cleanConnectionString(url);
  if (!key) return null;

  const activeKey = cleanConnectionString(activeRuntimeUrl());
  if (activeKey && key === activeKey) return prisma; // reuse singleton — no extra pool

  let client = cacheByUrl.get(key);
  if (!client) {
    client = createPrismaClientForUrl(url, { keepalive: false });
    cacheByUrl.set(key, client);
  }
  return client;
}

/** Test seam. */
export const __test = {
  urlForBank,
  envFlag,
  resetCache: () => cacheByUrl.clear(),
};
