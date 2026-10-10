// server/src/features/cn/jobs/fraud/flags.ts — `RAJob.fraudFlags` for GoApply.
//
// The column is shared: WP-17 writes `intl_*` rules, this module the
// CN_FRAUD_RULES. A non-empty array keeps the job out of ranking and
// recommendations (WP-32 / match repo), so an admin "clear" must remove the
// CN flags, and a re-run must not bring back a flag an admin cleared.

import { CN_FRAUD_RULES, type CnFraudFlag, type CnFraudMethod, type CnFraudRule } from '../contract.js';
import { normalizeText } from '../text.js';
import type { CnFraudSignal } from './keywords.js';

/** A stored flag of any module (`{ rule, evidence, at }`, optional `method`). */
export interface StoredFraudFlag {
  rule: string;
  evidence: string;
  at: string;
  method?: string;
}

const CN_RULES = new Set<string>(CN_FRAUD_RULES);

export function isCnFraudRule(rule: string): rule is CnFraudRule {
  return CN_RULES.has(rule);
}

function isStoredFlag(v: unknown): v is StoredFraudFlag {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return typeof f.rule === 'string' && typeof f.evidence === 'string' && typeof f.at === 'string';
}

/** Valid entries of a stored `fraudFlags` value (anything else is ignored). */
export function readFraudFlags(v: unknown): StoredFraudFlag[] {
  return Array.isArray(v) ? v.filter(isStoredFlag) : [];
}

/** The CN flags of a stored value. */
export function cnFlagsOf(v: unknown): StoredFraudFlag[] {
  return readFraudFlags(v).filter((f) => isCnFraudRule(f.rule));
}

/** Key of a flag for "an admin cleared exactly this" memory. */
export function flagKey(f: { rule: string; evidence: string }): string {
  return `${f.rule}|${normalizeText(f.evidence).replace(/\s+/g, '')}`;
}

export function signalsToFlags(signals: readonly CnFraudSignal[], method: CnFraudMethod, at: Date): CnFraudFlag[] {
  return signals.map((s) => ({ rule: s.rule, evidence: s.quote, at: at.toISOString(), method }));
}

/**
 * Replace the CN flags raised by `methods` with `next`, keeping every other
 * flag (intl rules, LLM / admin flags when not in `methods`). A flag with the
 * same rule and evidence keeps its original `at`. Flags whose key is in
 * `cleared` are dropped. Returns null when nothing is left (column NULL).
 */
export function mergeCnFraudFlags(
  existing: unknown,
  next: readonly CnFraudFlag[],
  methods: readonly CnFraudMethod[],
  cleared: ReadonlySet<string> = new Set(),
): StoredFraudFlag[] | null {
  const prior = readFraudFlags(existing);
  const replaced = new Set<string>(methods);
  // A CN flag without a method predates methods: treat it as a keyword flag.
  const ours = (f: StoredFraudFlag) => isCnFraudRule(f.rule) && replaced.has(f.method ?? 'keywords');
  const kept = prior.filter((f) => !ours(f));
  const out: StoredFraudFlag[] = [...kept];
  for (const f of next) {
    if (cleared.has(flagKey(f))) continue;
    if (out.some((o) => o.rule === f.rule && flagKey(o) === flagKey(f))) continue;
    const old = prior.find((p) => ours(p) && flagKey(p) === flagKey(f));
    out.push(old ? { ...f, at: old.at } : f);
  }
  return out.length ? out : null;
}

/** Remove every CN flag (admin clear). Keeps other modules' flags. */
export function withoutCnFlags(existing: unknown): StoredFraudFlag[] | null {
  const kept = readFraudFlags(existing).filter((f) => !isCnFraudRule(f.rule));
  return kept.length ? kept : null;
}

/** Same flags, order-insensitive. */
export function sameFlags(a: unknown, b: unknown): boolean {
  const ka = readFraudFlags(a).map((f) => `${flagKey(f)}|${f.method ?? ''}`).sort();
  const kb = readFraudFlags(b).map((f) => `${flagKey(f)}|${f.method ?? ''}`).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}
