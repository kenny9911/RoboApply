// server/src/features/jobs/ingest/config.ts — env knobs of the inventory pipeline (WP-16b).
//
// Every knob has a safe default; nothing here enables a paid provider (the
// RapidAPI clients still need RAPID_API_KEY and their own kill switches).
//
//   INGEST_<PROVIDER>_DAILY_CALLS   per-provider daily call budget in RAProviderUsage
//                                   (defaults: activejobs 300, linkedin 150, jsearch 200)
//   PUBLIC_DISPLAY_PROVIDERS        providers whose licence allows public redisplay
//                                   (comma list; DEFAULT EMPTY — owner decision OPS-A4)
//   CN_EXTERNAL_PROVIDERS           external providers GoApply may use (testing only;
//                                   only 'jsearch' is honoured, with country=cn)
//   INGEST_LEASE_BATCH              queries leased per step (default 4)
//   INGEST_SEED_ROLES               SEO seed roles (taxonomy L3, table order; default 300)
//   INGEST_SEED_CITIES_PER_COUNTRY  SEO seed cities per country (default 3)
//   INGEST_SEED_COUNTRIES           SEO seed countries (default: the brand's default country)
//   INGEST_BANK_PAGE                bank rows read per sync step (default 200)
//   INGEST_SEED_BUDGET_SHARE        share of a provider's daily calls SEO seeds may use
//                                   (default 0.5; demand always keeps the rest)

import type { EnvSource } from '../../../platform/brand/index.js';
import type { IngestProvider } from '../sources/index.js';

export const DEFAULT_DAILY_CALLS: Readonly<Partial<Record<IngestProvider, number>>> = {
  activejobs: 300,
  linkedin: 150,
  jsearch: 200,
};

/** Upsert batch size (ARCH §4.4: one statement per 100 rows). */
export const UPSERT_BATCH = 100;
/** A leased query is invisible to other ticks for this long (ARCH §4.4). */
export const LEASE_MINUTES = 15;
/** Days of inactivity after which a user's profile stops creating demand (ARCH §4.3). */
export const ACTIVE_USER_DAYS = 14;
/** Days a demand query may go unused before the planner disables it (ARCH §4.3). */
export const DISABLE_UNUSED_DAYS = 30;
/** Postings older than this are archived when the provider gives no expiry (ARCH §4.4). */
export const MAX_AGE_DAYS = 45;
/** Locations per user profile that become demand tuples. */
export const MAX_LOCATIONS_PER_PROFILE = 3;

function intEnv(env: EnvSource, name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function listEnv(env: EnvSource, name: string): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** `INGEST_<PROVIDER>_DAILY_CALLS`, else the default; null = not metered. */
export function dailyCallLimit(provider: IngestProvider, env: EnvSource = process.env): number | null {
  const fallback = DEFAULT_DAILY_CALLS[provider];
  const name = `INGEST_${provider.toUpperCase()}_DAILY_CALLS`;
  if (fallback === undefined && !env[name]?.trim()) return null;
  return intEnv(env, name, fallback ?? 0, 0);
}

/** Providers whose licence allows public redisplay. Default empty (OPS-A4). */
export function publicDisplayProviders(env: EnvSource = process.env): string[] {
  return listEnv(env, 'PUBLIC_DISPLAY_PROVIDERS');
}

/** External providers GoApply may query (testing only). Only 'jsearch' is supported. */
export function cnExternalProviders(env: EnvSource = process.env): IngestProvider[] {
  return listEnv(env, 'CN_EXTERNAL_PROVIDERS').filter((p): p is 'jsearch' => p === 'jsearch');
}

export function leaseBatch(env: EnvSource = process.env): number {
  return intEnv(env, 'INGEST_LEASE_BATCH', 4, 1, 25);
}

export function seedRoleLimit(env: EnvSource = process.env): number {
  return intEnv(env, 'INGEST_SEED_ROLES', 300, 0, 1000);
}

export function seedCitiesPerCountry(env: EnvSource = process.env): number {
  return intEnv(env, 'INGEST_SEED_CITIES_PER_COUNTRY', 3, 0, 20);
}

export function seedCountries(defaultCountry: string, env: EnvSource = process.env): string[] {
  const list = listEnv(env, 'INGEST_SEED_COUNTRIES').map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  return list.length ? [...new Set(list)] : [defaultCountry.toUpperCase()];
}

export function bankPageSize(env: EnvSource = process.env): number {
  return intEnv(env, 'INGEST_BANK_PAGE', 200, 10, 1000);
}

/** Share (0–1) of a provider's daily calls SEO seed queries may use. */
export function seedBudgetShare(env: EnvSource = process.env): number {
  const raw = Number(env.INGEST_SEED_BUDGET_SHARE?.trim() || '0.5');
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;
}
