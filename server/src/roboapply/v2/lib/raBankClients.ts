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
import { logger } from '../../../services/LoggerService.js';
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
  const url = urlForBank(b);
  if (!url) return false;
  if (!bankTlsSatisfied(b, url)) {
    warnTlsRejectedOnce(b);
    return false;
  }
  if (envFlag('RA_CROSSBANK_DISABLED')) return false;
  if (envFlag(`RA_CROSSBANK_${b.toUpperCase()}_DISABLED`)) return false;
  if (b !== activeBank() && !envFlag('RA_CROSSBANK_CROSS_TENANT_CONFIRMED')) return false;
  return true;
}

/** Local development hosts: a bank DB there needs no TLS. */
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** libpq modes that guarantee an encrypted connection ('prefer'/'allow' may fall back to plaintext). */
const TLS_SSLMODES = new Set(['require', 'verify-ca', 'verify-full']);

/**
 * CN-E-05 / CN plan C-15: the GoHire bank is reached only over TLS
 * (`sslmode=require` or stricter in DATABASE_URL_GOHIRE). A GoHire URL
 * without it is treated as not configured — the bank is skipped, never read
 * in plaintext. Local development hosts are exempt. RoboHire keeps today's
 * behaviour (its hosted URLs already carry sslmode).
 */
export function bankTlsSatisfied(b: BankId, url: string | undefined = urlForBank(b)): boolean {
  if (b !== 'gohire') return true;
  if (!url) return false;
  try {
    const u = new URL(url);
    if (LOCAL_DB_HOSTS.has(u.hostname.toLowerCase())) return true;
    const mode = u.searchParams.get('sslmode')?.trim().toLowerCase();
    return !!mode && TLS_SSLMODES.has(mode);
  } catch {
    return false;
  }
}

const tlsWarned = new Set<BankId>();

/**
 * Logs ONCE per process that a configured bank URL was rejected for missing
 * TLS, so a switched-off bank never looks like an empty one (OPS-A6: the
 * GoHire endpoint must accept TLS and DATABASE_URL_GOHIRE must carry
 * sslmode=require). The URL itself is never logged.
 */
function warnTlsRejectedOnce(b: BankId): void {
  if (tlsWarned.has(b)) return;
  tlsWarned.add(b);
  logger.warn('RA_BANK_CLIENTS', 'bank disabled: database URL is set but does not require TLS', {
    bank: b,
    env: b === 'gohire' ? 'DATABASE_URL_GOHIRE (or the fallback it resolves from)' : 'DATABASE_URL_ROBOHIRE',
    fix: 'serve the bank over TLS and add sslmode=require (or verify-ca / verify-full) to the URL',
  });
}

/** The product market a bank's jobs belong to (RoboHire → intl, GoHire → cn). */
export function bankMarket(b: BankId): 'intl' | 'cn' {
  return b === 'gohire' ? 'cn' : 'intl';
}

/** The bank whose jobs feed a market's inventory (WP-16b bank sync; WP-54 contact sync). */
export function bankForMarket(market: 'intl' | 'cn'): BankId {
  return market === 'cn' ? 'gohire' : 'robohire';
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
  if (!bankTlsSatisfied(b, url)) {
    warnTlsRejectedOnce(b); // CN-E-05: never open a plaintext GoHire pool
    return null;
  }
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
  bankTlsSatisfied,
  envFlag,
  resetCache: () => {
    cacheByUrl.clear();
    tlsWarned.clear();
  },
};
