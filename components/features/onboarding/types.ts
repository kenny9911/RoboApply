// Shared props of the onboarding step screens (WP-30).

import type { OnboardingState } from '../../../hooks/onboarding/useOnboarding';

export interface StepScreenProps {
  state: OnboardingState;
  /** Save the step's answers (`skip` marks the step skipped); the page navigates on success. */
  save: (body: Record<string, unknown>, options?: { skip?: boolean }) => void;
  onBack?: () => void;
  onLeave: () => void;
  busy: boolean;
  /** A save error, already in plain language. */
  error: string | null;
  position: { current: number; total: number } | null;
}

/** The stored answers of one step (untyped JSON on the wire). */
export function answersOf<T>(state: OnboardingState, step: string): Partial<T> {
  const v = (state.answers as Record<string, unknown>)[step];
  return v && typeof v === 'object' ? (v as Partial<T>) : {};
}
