// server/src/features/match/eval/testdata/fitUnbound.ts
//
// For seams.test.ts: a fit module whose functions exist but cannot be bound to
// in-memory dependencies (no factory, and the match service has no such
// methods). The harness must report that as a missing seam, never call them.

export async function getFits(): Promise<never> {
  throw new Error('fitUnbound: must never be called');
}
export async function getFit(): Promise<never> {
  throw new Error('fitUnbound: must never be called');
}
