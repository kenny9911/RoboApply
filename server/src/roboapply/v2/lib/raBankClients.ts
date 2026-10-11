// backend/src/roboapply/v2/lib/raBankClients.ts
//
// Lazy, per-URL-cached Prisma clients for the two recruiter job banks
// (RoboHire + GoHire). Both banks share the SAME generated Prisma client
// (identical schema); only the physical DB differs. Clients are READ-ONLY from
// RoboApply's perspective — the orchestrator only calls findMany on Job/Company
// through them; every WRITE goes to the active-brand singleton `prisma`.
//
// See docs/CROSSBANK_JOBSEARCH_SPEC.md §2.3.
//
// Transport (GOAPPLY_PARITY_PLAN.md §3.9, MARKET_STRATEGY §8 "GoHire bank
// transport", JC-2): a bank is read through its database ('db') or, for GoHire
// only, over HTTPS: the syndication endpoint ('syndication', whenever
// GOHIRE_SYNDICATION_URL is set: it wins over the two others and needs no
// database URL at all), or the interim list endpoint ('api'). The TLS rule of
// the database transport is unchanged: a GoHire database URL that does not
// require TLS is never opened; the bank is then read over HTTPS when a key is
// set. GOHIRE_BANK_TRANSPORT (db | api | off) chooses between the database and
// the list endpoint, and `off` switches the bank off on every transport. No
// Prisma client exists on the two HTTPS transports: the ingest adapter owns
// the HTTP reads, and the live cross-bank search reads the synced RAJob mirror
// instead (raBankProviders.searchBank), whatever database URL is configured.

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
import { DEFAULT_GOHIRE_API_BASE } from '../../../platform/residency/egressPolicy.js';
import { bankMarket } from './raCrossBankMatch.js';
import type { BankId } from '../types/crossBank.js';

const cacheByUrl = new Map<string, ExtendedPrismaClient>();

function urlForBank(b: BankId): string | undefined {
  return b === 'robohire' ? resolveRoboHireDatabaseUrl() : resolveGoHireDatabaseUrl();
}

function envFlag(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === 'true';
}

function envFlagIn(env: Record<string, string | undefined>, name: string): boolean {
  return env[name]?.trim().toLowerCase() === 'true';
}

/** The bank's database URL read from an explicit env (tests, the admin panel); the DB-brand fallback is process-wide. */
function urlForBankIn(b: BankId, env: Record<string, string | undefined>): string | undefined {
  if (b === 'robohire') return env.DATABASE_URL_ROBOHIRE || (activeBank() === 'robohire' ? env.DATABASE_URL : undefined);
  return env.DATABASE_URL_GOHIRE || env.DATABASE_URL_LIGHTARK || (activeBank() === 'gohire' ? env.DATABASE_URL : undefined);
}

export type BankTransport = 'db' | 'api' | 'syndication' | 'off';

type Env = Record<string, string | undefined>;

/** The GoHire list endpoint (the interim reader; the key is the one the resume parse uses). */
export interface BankApiConfig {
  /** `GOHIRE_API_BASE` without a trailing slash (default https://api.gohire.top). */
  base: string;
  key: string;
}

/** The GoHire syndication endpoint (the cursor + tombstone route of the GoHire backend, JC-3). */
export interface BankSyndicationConfig {
  /** `GOHIRE_SYNDICATION_URL` as set. Whether it may be called (https) is checked by the reader, before any request. */
  url: string;
  /** `GOHIRE_SYNDICATION_KEY` (the scoped service key), else `GOHIRE_API_KEY`. Never logged. */
  key: string;
}

function httpsOrLocal(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && LOCAL_DB_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * The list endpoint of a bank (the interim reader), or null when it has none:
 * only GoHire has an API, it needs GOHIRE_API_KEY, and the base must be https
 * (a local development host may use http). The key is never logged.
 */
export function bankApiConfig(b: BankId, env: Env = process.env): BankApiConfig | null {
  if (b !== 'gohire') return null;
  const key = (env.GOHIRE_API_KEY ?? '').trim();
  if (!key) return null;
  const base = ((env.GOHIRE_API_BASE ?? '').trim() || DEFAULT_GOHIRE_API_BASE).replace(/\/+$/, '');
  if (!httpsOrLocal(base)) return null;
  return { base, key };
}

/** `GOHIRE_SYNDICATION_URL`, trimmed ('' when unset). Only GoHire has a syndication endpoint. */
function syndicationUrlOf(b: BankId, env: Env): string {
  return b === 'gohire' ? (env.GOHIRE_SYNDICATION_URL ?? '').trim() : '';
}

/**
 * The syndication endpoint of a bank, or null when it is not configured: the
 * URL and a key (GOHIRE_SYNDICATION_KEY, the scoped service key; else
 * GOHIRE_API_KEY). No database URL is needed. A URL that is not https is still
 * returned: the reader refuses it before any request and reports
 * 'syndication_url_not_https', so a wrong setting is an error the operator
 * sees and never a silent switch to another transport.
 */
export function bankSyndicationConfig(b: BankId, env: Env = process.env): BankSyndicationConfig | null {
  const url = syndicationUrlOf(b, env);
  if (!url) return null;
  const key = (env.GOHIRE_SYNDICATION_KEY ?? '').trim() || (env.GOHIRE_API_KEY ?? '').trim();
  return key ? { url, key } : null;
}

/** `GOHIRE_BANK_TRANSPORT` when it is one of db | api | off, else null (unset or unknown: the default rule). */
function requestedTransport(b: BankId, env: Env): BankTransport | null {
  if (b !== 'gohire') return null;
  const raw = (env.GOHIRE_BANK_TRANSPORT ?? '').trim().toLowerCase();
  return raw === 'db' || raw === 'api' || raw === 'off' ? raw : null;
}

/**
 * How a bank is read. RoboHire: its database, or 'off' with no URL. GoHire:
 *   1. GOHIRE_BANK_TRANSPORT=off switches the bank off, whatever else is set;
 *   2. with GOHIRE_SYNDICATION_URL set the transport is 'syndication' (it wins
 *      over the list endpoint and over the database, and over a `db` or `api`
 *      request), or 'off' when no key is set for it;
 *   3. otherwise GOHIRE_BANK_TRANSPORT when set; else the database when its URL
 *      satisfies the TLS rule, else the list endpoint when GOHIRE_API_KEY is
 *      set, else 'off'.
 * A transport that was asked for and cannot be honoured (the syndication URL
 * without a key, 'db' without TLS, 'api' without a key) is 'off': the
 * operator's choice is never silently replaced by another transport.
 */
export function bankTransport(b: BankId, env: Env = process.env): BankTransport {
  const url = urlForBankIn(b, env);
  const dbOk = !!url && bankTlsSatisfied(b, url);
  const want = requestedTransport(b, env);
  if (want === 'off') return 'off';
  if (syndicationUrlOf(b, env)) return bankSyndicationConfig(b, env) ? 'syndication' : 'off';
  if (want === 'db') return dbOk ? 'db' : 'off';
  if (want === 'api') return bankApiConfig(b, env) ? 'api' : 'off';
  if (dbOk) return 'db';
  return bankApiConfig(b, env) ? 'api' : 'off';
}

/** Why a bank is off, as a short code for the admin sources panel (null when it is on). */
export function bankDisabledReason(b: BankId, env: Env = process.env): string | null {
  if (envFlagIn(env, 'RA_CROSSBANK_DISABLED') || envFlagIn(env, `RA_CROSSBANK_${b.toUpperCase()}_DISABLED`)) return 'kill_switch';
  if (bankTransport(b, env) === 'off') {
    const want = requestedTransport(b, env);
    if (want === 'off') return 'transport_off';
    // The syndication endpoint is configured without a key (GOHIRE_SYNDICATION_KEY or GOHIRE_API_KEY).
    if (syndicationUrlOf(b, env)) return 'no_api_key';
    const url = urlForBankIn(b, env);
    if (want === 'api') return 'no_api_key';
    if (url && !bankTlsSatisfied(b, url)) return b === 'gohire' && want !== 'db' ? 'tls_required_no_api_key' : 'tls_required';
    return 'not_configured';
  }
  if (b !== activeBank() && !envFlagIn(env, 'RA_CROSSBANK_CROSS_TENANT_CONFIRMED')) return 'cross_tenant_unconfirmed';
  return null;
}

/**
 * A bank is searchable when: it has a transport (its database over TLS, or
 * for GoHire one of the HTTPS transports: the syndication endpoint needs its
 * URL and a key and no database URL at all), no kill switch is set, and — for
 * the FOREIGN brand's bank — the cross-tenant white-label sign-off is
 * confirmed in env (reading another brand's recruiter jobs into a candidate
 * index crosses a contractual boundary; the active brand's OWN bank is always
 * allowed). `bankTransport(b)` names the transport. [FIX legal / spec §2.3]
 */
export function isBankEnabled(b: BankId): boolean {
  const url = urlForBank(b);
  const transport = bankTransport(b);
  if (transport === 'syndication') warnTransportOverriddenOnce(b);
  if (url && !bankTlsSatisfied(b, url)) warnTlsRejectedOnce(b, transport);
  if (transport === 'off') return false;
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
 * TLS, and what happens instead (read over HTTPS, or switched off), so a
 * switched-off bank never looks like an empty one (OPS-A6: the GoHire endpoint
 * must accept TLS and DATABASE_URL_GOHIRE must carry sslmode=require). The URL
 * itself is never logged.
 */
function warnTlsRejectedOnce(b: BankId, transport: BankTransport = 'off'): void {
  if (tlsWarned.has(b)) return;
  tlsWarned.add(b);
  const overHttps = transport === 'api' || transport === 'syndication';
  logger.warn('RA_BANK_CLIENTS', overHttps ? 'bank database URL does not require TLS: the database is not opened and the bank is read over HTTPS' : 'bank disabled: database URL is set but does not require TLS', {
    bank: b,
    transport,
    env: b === 'gohire' ? 'DATABASE_URL_GOHIRE (or the fallback it resolves from)' : 'DATABASE_URL_ROBOHIRE',
    fix: 'serve the bank over TLS and add sslmode=require (or verify-ca / verify-full) to the URL',
  });
}

const overrideWarned = new Set<BankId>();

/**
 * Logs ONCE per process that GOHIRE_BANK_TRANSPORT asks for the database or
 * the list endpoint while GOHIRE_SYNDICATION_URL is set: the syndication
 * endpoint is used (bankTransport rule 2), and the operator should know which
 * of the two settings decided. Neither value is logged beyond the request.
 */
function warnTransportOverriddenOnce(b: BankId): void {
  if (overrideWarned.has(b)) return;
  const want = requestedTransport(b, process.env);
  if (want !== 'db' && want !== 'api') return;
  overrideWarned.add(b);
  logger.warn('RA_BANK_CLIENTS', 'GOHIRE_BANK_TRANSPORT is ignored while GOHIRE_SYNDICATION_URL is set: the bank is read through the syndication endpoint', {
    bank: b,
    requested: want,
    fix: 'unset GOHIRE_SYNDICATION_URL to read the database or the list endpoint, or unset GOHIRE_BANK_TRANSPORT',
  });
}

/** The product market a bank's jobs belong to (RoboHire → intl, GoHire → cn): the one rule, in raCrossBankMatch. */
export { bankMarket };

/** The bank whose jobs feed a market's inventory (WP-16b bank sync; WP-54 contact sync). */
export function bankForMarket(market: 'intl' | 'cn'): BankId {
  return market === 'cn' ? 'gohire' : 'robohire';
}

/**
 * True when the live cross-bank search must read our synced RAJob mirror of
 * the bank instead of the bank itself: the bank's transport is one of the two
 * HTTPS ones ('api' or 'syndication'), where the ingest adapter owns every
 * read. The TRANSPORT decides, never the presence of a database URL: while the
 * sync runs over HTTPS no database client of the bank is opened for a search,
 * even when a database URL is configured (it may be the plaintext endpoint the
 * TLS rule refuses, or a database the operator chose not to read).
 */
export function bankReadsMirror(b: BankId, env: Env = process.env): boolean {
  const transport = bankTransport(b, env);
  return transport === 'api' || transport === 'syndication';
}

/** The client that holds the RAJob mirror: the active-brand singleton (never a bank pool). */
export function getMirrorClient(): ExtendedPrismaClient {
  return prisma;
}

export function listEnabledBanks(): BankId[] {
  return (['robohire', 'gohire'] as BankId[]).filter(isBankEnabled);
}

/**
 * Resolve (and cache) a client for a bank. Returns the active-brand singleton
 * when the bank's cleaned URL points at the SAME physical DB (no 2nd pool);
 * otherwise opens one keepalive-off, read-mostly client per distinct URL.
 * Returns null when the bank is not configured, or is not read through its
 * database (transport 'api' or 'off'). [FIX-6]
 */
export function getBankClient(b: BankId): ExtendedPrismaClient | null {
  const url = urlForBank(b);
  if (!url) return null;
  if (!bankTlsSatisfied(b, url)) {
    warnTlsRejectedOnce(b, bankTransport(b)); // CN-E-05: never open a plaintext GoHire pool
    return null;
  }
  // Any transport but the database (the syndication endpoint, the list endpoint, off): no database client.
  if (bankTransport(b) !== 'db') return null;
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
  bankTransport,
  envFlag,
  resetCache: () => {
    cacheByUrl.clear();
    tlsWarned.clear();
    overrideWarned.clear();
  },
};
