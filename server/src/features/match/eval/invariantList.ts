// server/src/features/match/eval/invariantList.ts
//
// The ten invariants of MARKET_STRATEGY.md 2.6 (SEARCH_RETRIEVE_MATCH.md 6.3)
// as data: id, the phase after which each must hold, and its sentence. Pure
// (no imports), so run.ts can print the list without loading the code under
// test. The executable specs are in invariantSpecs.ts.
//
// Stage names are the phase names of the market wave. `due` is the phase
// whose merge must make the invariant true:
//   M1  1, 2, 4, 5, 6, 8, 9, 10
//   M2  3 (every consumer reads getFit)
//   M4  7 (the three-state keyword check)

export const STAGES = ['M1', 'M2', 'M4'] as const;
export type Stage = (typeof STAGES)[number];
/** `--enforce`: invariants due at or before this phase must pass; `all` enforces every one. */
export type Enforce = Stage | 'all';

export const ENFORCE_VALUES: readonly Enforce[] = [...STAGES, 'all'];

export function isEnforce(v: unknown): v is Enforce {
  return typeof v === 'string' && (ENFORCE_VALUES as readonly string[]).includes(v);
}

/** Read an `--enforce` / EVAL_ENFORCE value; anything else is `all` (the strict default). */
export function parseEnforce(v: unknown): Enforce {
  return isEnforce(v) ? v : 'all';
}

/** Must an invariant due after `due` hold when `enforce` is the phase that has merged? */
export function isEnforced(due: Stage, enforce: Enforce): boolean {
  if (enforce === 'all') return true;
  return STAGES.indexOf(due) <= STAGES.indexOf(enforce);
}

export interface InvariantInfo {
  id: string;
  due: Stage;
  /** One sentence, as the strategy states it. */
  title: string;
  /** The fit-contract rule of strategy 2.2 it proves, when it is one. */
  rule?: string;
}

export const INVARIANT_LIST: readonly InvariantInfo[] = [
  { id: 'INV-1', due: 'M1', title: 'A job with no listed skills and no stated level is never great and its confidence is low', rule: 'I4' },
  { id: 'INV-2', due: 'M1', title: 'Changing a filter chip changes no fit; a location, pay or sponsorship answer changes the logistics dimension only', rule: 'I3' },
  { id: 'INV-3', due: 'M2', title: 'Every surface returns the same score, tier and kind for one user and one job', rule: 'I1, I2' },
  { id: 'INV-4', due: 'M1', title: 'A senior resume against an internship is at most possible' },
  { id: 'INV-5', due: 'M1', title: '"Java Backend Architect", "Lead AI Architect" and "Principal Architect - Machine Learning" are not in Design; "Landscape Architect" is' },
  { id: 'INV-6', due: 'M1', title: 'A location entry with a country and no city filters by country' },
  { id: 'INV-7', due: 'M4', title: 'The keyword check reports PostgreSQL as related evidence for "relational databases" and lists no skill twice' },
  { id: 'INV-8', due: 'M1', title: 'An AI-scored job never ranks below an unscored job of equal quality solely because it was scored' },
  { id: 'INV-9', due: 'M1', title: 'A pay value that cannot be pay for its period is not sorted as pay' },
  { id: 'INV-10', due: 'M1', title: 'On GoApply without the AI consent, getFit, a feed query and the precompute cron make zero model calls', rule: 'I8' },
];

export function invariantInfo(id: string): InvariantInfo | null {
  return INVARIANT_LIST.find((i) => i.id === id) ?? null;
}
