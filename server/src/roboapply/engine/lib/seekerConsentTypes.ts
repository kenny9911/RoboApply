// backend/src/seeker/lib/seekerConsentTypes.ts
//
// Closed enum of consent types accepted by the seeker app. Centralized here so
// every writer (signup, opt-in-from-invite, video record gate, auto-apply
// toggle, etc.) reads from the same vocabulary and the SeekerConsentRecord
// ledger stays clean.
//
// See docs/job-seeker-engineering-spec.md §16 (Compliance) for the surface
// each value corresponds to.

export const SEEKER_CONSENT_TYPES = [
  'seeker_app_optin',
  'biometric_video',
  'biometric_interview',
  'auto_apply',
  'external_board_share',
  'transactional_email',
  'marketing_email',
  'ai_assistance',
] as const;

export type SeekerConsentType = (typeof SEEKER_CONSENT_TYPES)[number];

export function isSeekerConsentType(value: unknown): value is SeekerConsentType {
  return (
    typeof value === 'string' &&
    (SEEKER_CONSENT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Versioned prose hashes for the legal disclosure shown to users when they
 * grant a particular consent. Hashes are stored alongside the grant row so
 * we can prove "this exact version of the disclosure was visible" without
 * retaining IP / user-agent forever.
 *
 * Bump the version (and the hash) whenever the in-product copy changes.
 */
export const SEEKER_CONSENT_PROSE_VERSION = '2026-05-14.v1';
