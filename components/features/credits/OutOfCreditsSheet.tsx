'use client';

// OutOfCreditsSheet — opens when an action has no credits left: three equal
// options (wait for the reset at {time}, a practice pack where it applies,
// Pro), never a dead end (PRODUCT_PLAN.md §6.4; TASK_PLAN.md WP-21b).
//
// STUB (FND-6b). Owner: WP-21b. Renders nothing. Mounted ONCE in the app
// layout; it takes no props and reads `useOutOfCredits()` from
// hooks/shared/useCreditGate.ts, which every credit-spending action feeds
// (`reportCreditsExhausted` on a 402 `credits_exhausted`). Bucket, reset time
// and `upgradable` come from the server; nothing is guessed on the client.

export type OutOfCreditsSheetProps = Record<string, never>;

export function OutOfCreditsSheet(_props: OutOfCreditsSheetProps = {}): null {
  return null;
}

export default OutOfCreditsSheet;
