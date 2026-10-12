'use client';

// hooks/shared/useCreditGate.ts — run a credit-spending action the same way
// everywhere (ARCHITECTURE.md §7.3; FND-7).
//
//   const gate = useCreditGate('tailor');
//   gate.left           // credits usable now, or null when unknown ("—")
//   const r = await gate.run((idempotencyKey) =>
//     createTailorSession(body, { idempotencyKey }));
//   if (r.ok) … r.value … else if (r.reason === 'credits_exhausted') …
//
// What it guarantees:
//   - One idempotency key per `run()`, passed to the action, so a network
//     retry inside the action never charges twice.
//   - When the summary already shows 0 left, the action is not sent; the
//     out-of-credits sheet opens instead.
//   - A `402 credits_exhausted` from the server opens the same sheet with the
//     server's bucket, reset time and upgrade flag (never guessed).
//   - The credit summary is refetched after every attempt that reached the
//     server, so "N left" stays true.
//
// The sheet itself (`components/features/credits/OutOfCreditsSheet.tsx`,
// FND-6b stub, WP-21b) is mounted once in the app layout and reads
// `useOutOfCredits()`.

import { useCallback, useSyncExternalStore } from 'react';

import { apiErrorCode, apiErrorDetails, newIdempotencyKey } from '../../lib/api/contracts/wire';
import { createStore } from './store';
import { bucketSummary, creditsLeft, useCredits, useInvalidateCredits, type BucketSummary } from './useCredits';

export interface CreditsExhaustedInfo {
  bucket: string;
  /** ISO time the bucket refills, when the server said so. */
  resetsAt: string | null;
  /** A sellable plan raises this cap (show "See Pro"). */
  upgradable: boolean;
}

const outOfCredits = createStore<CreditsExhaustedInfo | null>(null);

/** Open the out-of-credits sheet. */
export function reportCreditsExhausted(info: CreditsExhaustedInfo): void {
  outOfCredits.set(info);
}

export function clearCreditsExhausted(): void {
  outOfCredits.set(null);
}

/** For the out-of-credits sheet: the current request (or null) and a dismiss callback. */
export function useOutOfCredits(): { info: CreditsExhaustedInfo | null; dismiss: () => void } {
  const info = useSyncExternalStore(outOfCredits.subscribe, outOfCredits.get, () => null);
  return { info, dismiss: clearCreditsExhausted };
}

/** The exhausted-credit details carried by a failed call, or null for any other error. */
export function creditsExhaustedFrom(err: unknown, fallbackBucket?: string): CreditsExhaustedInfo | null {
  if (apiErrorCode(err) !== 'credits_exhausted') return null;
  const d = apiErrorDetails<{ bucket?: unknown; resetsAt?: unknown; upgradable?: unknown }>(err) ?? {};
  return {
    bucket: typeof d.bucket === 'string' ? d.bucket : (fallbackBucket ?? 'unknown'),
    resetsAt: typeof d.resetsAt === 'string' ? d.resetsAt : null,
    upgradable: d.upgradable === true,
  };
}

export type CreditGateResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'credits_exhausted'; info: CreditsExhaustedInfo };

export interface CreditGate {
  bucket: string;
  summary: BucketSummary | null;
  /** Credits usable now (window + bonus), or null when unknown. */
  left: number | null;
  /** Window cap, or null when unknown. */
  cap: number | null;
  resetsAt: string | null;
  /** False only when the summary is known and shows nothing left. */
  canSpend: boolean;
  run<T>(action: (idempotencyKey: string) => Promise<T>): Promise<CreditGateResult<T>>;
}

/**
 * `bucket` is a credit bucket name (`tailor`, `fit_analysis`, `cover_letter`,
 * `assistant`, …; TASK_PLAN.md §4.1.f). `practice` is handled by the
 * interview credits, not here.
 */
export function useCreditGate(bucket: string): CreditGate {
  const { data, isSuccess } = useCredits();
  const invalidate = useInvalidateCredits();
  const summary = bucketSummary(data?.summary, bucket);
  const left = creditsLeft(summary);
  const upgradable = data?.summary.upgradable === true;

  const run = useCallback(
    async <T,>(action: (idempotencyKey: string) => Promise<T>): Promise<CreditGateResult<T>> => {
      if (isSuccess && summary && left === 0) {
        const info: CreditsExhaustedInfo = { bucket, resetsAt: summary.resetsAt, upgradable };
        reportCreditsExhausted(info);
        return { ok: false, reason: 'credits_exhausted', info };
      }
      try {
        const value = await action(newIdempotencyKey());
        return { ok: true, value };
      } catch (err) {
        const info = creditsExhaustedFrom(err, bucket);
        if (info) {
          reportCreditsExhausted(info);
          return { ok: false, reason: 'credits_exhausted', info };
        }
        throw err;
      } finally {
        void invalidate();
      }
    },
    [bucket, invalidate, isSuccess, left, summary, upgradable],
  );

  return {
    bucket,
    summary,
    left,
    cap: summary?.cap ?? null,
    resetsAt: summary?.resetsAt ?? null,
    canSpend: !(summary && left === 0),
    run,
  };
}

/** Tests only. */
export const __outOfCreditsStore = outOfCredits;
