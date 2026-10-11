// server/src/features/jobs/ingest/quotaContract.ts — the provider quota
// snapshot (MKT-1C; MARKET_STRATEGY §1.2 "Until the licensed feed is bought",
// JI-1, JC-6; MARKET_TASK_PLAN "Quota snapshot").
//
// A metered provider tells us its plan's quota in its response headers (and,
// on a 429, in the body). Ingest records the last reading per provider in ONE
// AppConfig row (key PROVIDER_QUOTA_CONFIG_KEY, value = the JSON text below),
// so planning stops for an exhausted provider until its reset and the admin
// System panel can show plan, remaining quota and days to reset the day a
// source dies. `RAProviderUsage` (the daily call counter) has no column for
// this and is not changed.
//
//   { "version": 1, "providers": { "<provider>": ProviderQuotaSnapshot, … } }
//
// This file is the contract only: types, constants and pure functions. No
// database and no network code. Writer: the ingest pipeline (MKT-3A). Readers:
// the planner (MKT-3B), the admin System panel (MKT-3F), the licensed feed's
// quota gate (MKT-5A).
//
// Honesty (D3): every value is one the provider itself stated. A field the
// provider did not state is null, never an assumption: `plan` is only a name
// read from the provider (e.g. "BASIC" from a 429 body), and a reading we
// cannot interpret is state 'unknown'.

import type { Market } from '../../../platform/brand/index.js';

/** `AppConfig.key` of the snapshot row. */
export const PROVIDER_QUOTA_CONFIG_KEY = 'jobs.providerQuota.v1';
export const PROVIDER_QUOTA_VERSION = 1;

/**
 *   ok              the last call was served and quota remains (or none is stated);
 *   exhausted       the provider says the period's quota is used up (429, remaining 0);
 *   not_subscribed  the key has no plan for this API (403 "not subscribed");
 *   unauthorized    the key was refused (401 / 403 for another reason);
 *   unknown         nothing readable yet.
 */
export const PROVIDER_QUOTA_STATES = ['ok', 'exhausted', 'not_subscribed', 'unauthorized', 'unknown'] as const;
export type ProviderQuotaState = (typeof PROVIDER_QUOTA_STATES)[number];

export interface ProviderQuotaSnapshot {
  /** The provider the reading is for (the key of `providers`). */
  provider: string;
  /** The plan's name as the provider itself stated it; null when it did not. Never guessed. */
  plan: string | null;
  /** Requests the plan allows in the period, and how many are left. */
  requestsLimit: number | null;
  requestsRemaining: number | null;
  /** Postings the plan allows in the period, and how many are left (per-job plans). */
  jobsLimit: number | null;
  jobsRemaining: number | null;
  /** When the period's quota resets (ISO 8601); null when the provider did not say. */
  resetAt: string | null;
  /** When this reading was taken (ISO 8601). */
  observedAt: string;
  /** HTTP status of the call the reading comes from. */
  lastStatus: number | null;
  /** Requests the last call consumed, from the header delta. */
  lastCallCost: number | null;
  state: ProviderQuotaState;
}

/** The AppConfig value, parsed. */
export interface ProviderQuotaDocument {
  version: typeof PROVIDER_QUOTA_VERSION;
  providers: Record<string, ProviderQuotaSnapshot>;
}

const MAX_PLAN_LENGTH = 60;
const DAY_MS = 86_400_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A stated count: a finite number that is not negative. Anything else was not stated. */
function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * One snapshot in the contract's shape and field order, or null when it is not
 * usable (no provider, or no time of observation). The same rule on the way in
 * (parse) and on the way out (serialize): unknown fields are dropped, a field
 * of the wrong type was "not stated".
 */
function cleanSnapshot(provider: string, v: unknown): ProviderQuotaSnapshot | null {
  const key = provider.trim();
  if (!key || !isRecord(v)) return null;
  const observedAt = isoOrNull(v.observedAt);
  if (!observedAt) return null;
  const plan = typeof v.plan === 'string' ? v.plan.trim().slice(0, MAX_PLAN_LENGTH) : '';
  const status = v.lastStatus;
  return {
    provider: key,
    plan: plan || null,
    requestsLimit: count(v.requestsLimit),
    requestsRemaining: count(v.requestsRemaining),
    jobsLimit: count(v.jobsLimit),
    jobsRemaining: count(v.jobsRemaining),
    resetAt: isoOrNull(v.resetAt),
    observedAt,
    lastStatus: typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    lastCallCost: count(v.lastCallCost),
    state: (PROVIDER_QUOTA_STATES as readonly unknown[]).includes(v.state) ? (v.state as ProviderQuotaState) : 'unknown',
  };
}

/**
 * The snapshots of an AppConfig value, by provider. Tolerant: no row, bad
 * JSON, another version or another shape gives an empty map (the caller then
 * knows nothing about any provider, which is the truth); an unusable entry is
 * dropped and the others are kept. Never throws.
 */
export function parseProviderQuota(raw: string | null | undefined | object): Map<string, ProviderQuotaSnapshot> {
  const out = new Map<string, ProviderQuotaSnapshot>();
  let doc: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return out;
    try {
      doc = JSON.parse(raw);
    } catch {
      return out;
    }
  }
  if (!isRecord(doc) || doc.version !== PROVIDER_QUOTA_VERSION || !isRecord(doc.providers)) return out;
  for (const [provider, value] of Object.entries(doc.providers)) {
    const snapshot = cleanSnapshot(provider, value);
    if (snapshot) out.set(snapshot.provider, snapshot);
  }
  return out;
}

/**
 * The AppConfig value for these snapshots (a map from `parseProviderQuota`, or
 * a list). For a map the KEY is the provider, as it is when the document is
 * read back (two entries under two keys stay two entries, whatever their
 * `provider` field says); for a list it is each snapshot's `provider`, and the
 * last one given wins. Providers in alphabetical order, contract fields only:
 * the same snapshots always give the same text. An unusable snapshot (see
 * cleanSnapshot) is left out.
 */
export function serializeProviderQuota(snapshots: ReadonlyMap<string, ProviderQuotaSnapshot> | Iterable<ProviderQuotaSnapshot>): string {
  const entries: Array<[key: unknown, snapshot: unknown]> =
    snapshots instanceof Map ? [...snapshots.entries()] : [...(snapshots as Iterable<ProviderQuotaSnapshot>)].map((s) => [isRecord(s) ? s.provider : null, s]);
  const byProvider = new Map<string, ProviderQuotaSnapshot>();
  for (const [key, s] of entries) {
    const clean = typeof key === 'string' ? cleanSnapshot(key, s) : null;
    if (clean) byProvider.set(clean.provider, clean);
  }
  const providers: Record<string, ProviderQuotaSnapshot> = {};
  for (const provider of [...byProvider.keys()].sort()) providers[provider] = byProvider.get(provider)!;
  const doc: ProviderQuotaDocument = { version: PROVIDER_QUOTA_VERSION, providers };
  return JSON.stringify(doc);
}

/**
 * Whole days until the provider's quota resets, rounded up (a reset 16.9 days
 * ahead is 17 days away); 0 when the reset time has passed. Null when the
 * provider stated no reset time: never a guess.
 */
export function daysToReset(snapshot: Pick<ProviderQuotaSnapshot, 'resetAt'> | null | undefined, now: Date): number | null {
  const reset = snapshot?.resetAt ? Date.parse(snapshot.resetAt) : Number.NaN;
  const at = now.getTime();
  if (!Number.isFinite(reset) || !Number.isFinite(at)) return null;
  return reset <= at ? 0 : Math.ceil((reset - at) / DAY_MS);
}

/**
 * The `RAProviderUsage.provider` key a call is counted under: the provider for
 * the international market, `<provider>:cn` for mainland calls, so one
 * market's daily usage never eats the other's budget (JI-1, JC-6).
 */
export function usageKey(provider: string, market: Market): string {
  return market === 'cn' ? `${provider}:cn` : provider;
}
