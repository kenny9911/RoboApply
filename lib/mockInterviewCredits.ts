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
