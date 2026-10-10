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
  // ── Original seeker-app set ─────────────────────────────────────────────
  'seeker_app_optin',
  'biometric_video',
  'biometric_interview',
  'auto_apply',
  'external_board_share',
  'transactional_email',
  'marketing_email',
  'ai_assistance',
  // ── Jobright clone (ARCHITECTURE.md §2.13 ∪ CN_TW_LAUNCH_PLAN.md §4.1(4) ∪
  //    TASK_PLAN.md FND-2a). Additive only: no existing value is removed.
  /** @deprecated ARCH spelling; write `ai_resume_parsing`. Still honoured by aiAllowed(). */
  'ai_resume_parse',
  /** GoApply separate consent for AI processing of the resume/profile; gates every LLM call for a GoApply user (aiAllowed). */
  'ai_resume_parsing',
  'sensitive_fields',
  'personalized_recommendation',
  'share_with_employers',
  'share_with_gohire',
  'interview_recording',
  'interview_video',
  'autofill_sensitive',
  'age_16_plus',
  'tw_pdpa_notice',
  'pipl_basic_processing',
  'pipl_cross_border',
  'pipl_sensitive_pi',
  'intl_cross_border_cn_parse',
  'copilot_memory',
  'tips_reminders',
  'auto_renew_ack',
  'withdrawal_waiver',
  'analytics',
  /** GoApply: the 用户协议 version accepted before a WeChat Pay order (WP-62 billing-cn writes it; Wave 4 gate). */
  'cn_pay_terms_ack',
] as const;

export type SeekerConsentType = (typeof SEEKER_CONSENT_TYPES)[number];

/**
 * Spellings that mean the same consent. Readers that check a consent must
 * look at every alias (the newest record across them wins); writers use the
 * canonical value.
 */
export const SEEKER_CONSENT_ALIASES: Partial<Record<SeekerConsentType, SeekerConsentType>> = {
  ai_resume_parse: 'ai_resume_parsing',
};

/** Canonical spelling of a consent type. */
export function canonicalConsentType(type: SeekerConsentType): SeekerConsentType {
  return SEEKER_CONSENT_ALIASES[type] ?? type;
}

/** The canonical type plus every alias that maps to it. */
export function consentTypeSpellings(type: SeekerConsentType): SeekerConsentType[] {
  const canonical = canonicalConsentType(type);
  return SEEKER_CONSENT_TYPES.filter((t) => canonicalConsentType(t) === canonical);
}

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
