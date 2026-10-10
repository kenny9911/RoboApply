// Client-side mirror of the mock-interview credit calculation used by
// server/src/lib/mockInterviewPlans.ts. The server authors `creditMinutes`;
// the fallback keeps the UI compatible with an older API during rolling
// deployments.

export const DEFAULT_MOCK_CREDIT_MINUTES = 20;

export function normalizeMockCreditMinutes(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_MOCK_CREDIT_MINUTES;
}

export function mockCreditsForMinutes(minutes: number, creditMinutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  const minutesPerCredit = normalizeMockCreditMinutes(creditMinutes);
  return Math.ceil((minutes / minutesPerCredit) * 100) / 100;
}

/** Float slack for a balance that is the sum of pro-rated debits. */
const BALANCE_EPSILON = 1e-9;

/** True when `balance` covers a practice of `minutes`. */
export function canAffordMinutes(minutes: number, balance: number, creditMinutes: number): boolean {
  return balance + BALANCE_EPSILON >= mockCreditsForMinutes(minutes, creditMinutes);
}

/** The longest of the offered lengths the balance covers, or null when it covers none. */
export function longestAffordableMinutes(
  options: readonly number[],
  balance: number,
  creditMinutes: number,
): number | null {
  let best: number | null = null;
  for (const minutes of options) {
    if (canAffordMinutes(minutes, balance, creditMinutes) && (best === null || minutes > best)) best = minutes;
  }
  return best;
}

/**
 * The length a practice starts on before the user picks one.
 *
 * `preferred` (the interview type's own length) when the balance covers it or
 * is not known yet. Otherwise the longest offered length the balance does
 * cover, so the first plan on screen is one the user can start. When the
 * balance covers no offered length, `preferred` stays and the setup says what
 * is missing.
 */
export function defaultPracticeMinutes(input: {
  preferred: number;
  options: readonly number[];
  balance: number | null | undefined;
  creditMinutes: number;
}): number {
  const { preferred, options, balance, creditMinutes } = input;
  if (typeof balance !== 'number' || !Number.isFinite(balance)) return preferred;
  if (canAffordMinutes(preferred, balance, creditMinutes)) return preferred;
  return longestAffordableMinutes(options, balance, creditMinutes) ?? preferred;
}
