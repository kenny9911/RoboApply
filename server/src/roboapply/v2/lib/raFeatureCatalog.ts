// backend/src/roboapply/v2/lib/raFeatureCatalog.ts
//
// Single source of truth for the "by feature" dimension of RoboApply usage +
// cost analytics. Maps each UsageDeductionLog SKU to a stable feature key, a
// human label (en — the UI translates via the `admin.features.*` i18n keys),
// and a primary cost modality. Used by BOTH the admin console (cost by feature)
// and the user account page (usage by feature).
//
// Keep in sync with the DeductionSku union in backend/src/lib/matchBilling.ts.

export type CostModality = 'llm' | 'stt' | 'tts' | 'recording' | 'image';

export interface FeatureDef {
  /** Stable key for i18n + grouping (several SKUs may share one feature). */
  key: string;
  /** English label (fallback / dev display). */
  label: string;
  /** Primary modality for the "by modality" rollup. Interviews are multi-modal
   *  and handled specially (their breakdown is read from costBreakdown). */
  modality: CostModality;
  /** True for the real-time mock interview (multi-modal: llm+stt+tts+recording). */
  interview?: boolean;
}

/** SKU → feature. Unknown SKUs fall back to FEATURE_OTHER. */
export const FEATURE_BY_SKU: Record<string, FeatureDef> = {
  mock_interview: { key: 'mock_interview', label: 'Mock Interview', modality: 'llm', interview: true },
  ra_resume_tailor: { key: 'resume_tailor', label: 'Resume Tailor', modality: 'llm' },
  ra_cover_letter: { key: 'cover_letter', label: 'Cover Letter', modality: 'llm' },
  roboapply_cover_letter: { key: 'cover_letter', label: 'Cover Letter', modality: 'llm' },
  ra_match_score: { key: 'match_score', label: 'Job-Match Scoring', modality: 'llm' },
  ra_insight: { key: 'career_insight', label: 'Career Insight', modality: 'llm' },
  ra_jd_parse: { key: 'jd_parse', label: 'JD Parse', modality: 'llm' },
  ra_keyword_extract: { key: 'keyword_extract', label: 'Keyword Extract', modality: 'llm' },
  ra_onboarding_turn: { key: 'onboarding', label: 'Onboarding Chat', modality: 'llm' },
  roboapply_intent: { key: 'intent', label: 'Intent Parse', modality: 'llm' },
  roboapply_digest: { key: 'digest', label: 'Morning Digest', modality: 'llm' },
  // RoboApply engine (seeker_*) SKUs — the shared apply/tailor engine.
  seeker_apply: { key: 'application', label: 'Application', modality: 'llm' },
  seeker_tailor: { key: 'resume_tailor', label: 'Resume Tailor', modality: 'llm' },
  seeker_resume_refinement: { key: 'resume_tailor', label: 'Resume Tailor', modality: 'llm' },
  seeker_mock_interview: { key: 'mock_interview', label: 'Mock Interview', modality: 'llm', interview: true },
  seeker_mock: { key: 'mock_interview', label: 'Mock Interview', modality: 'llm', interview: true },
  seeker_coach_text: { key: 'coach', label: 'Interview Coach', modality: 'llm' },
  seeker_negotiation: { key: 'negotiation', label: 'Offer Negotiation', modality: 'llm' },
  seeker_interview_planner: { key: 'interview_planner', label: 'Interview Planner', modality: 'llm' },
  seeker_match: { key: 'match_score', label: 'Job-Match Scoring', modality: 'llm' },
};

export const FEATURE_OTHER: FeatureDef = { key: 'other', label: 'Other', modality: 'llm' };

export function featureForSku(sku: string): FeatureDef {
  return FEATURE_BY_SKU[sku] ?? FEATURE_OTHER;
}

/** All distinct feature keys → label (for building the i18n key list + legends). */
export function allFeatureKeys(): { key: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const def of Object.values(FEATURE_BY_SKU)) {
    if (!seen.has(def.key)) seen.set(def.key, def.label);
  }
  return Array.from(seen.entries()).map(([key, label]) => ({ key, label }));
}

/** SKUs whose cost is SHARED/platform (not one user's) — attributed to the
 *  cron sentinel userId. Surfaced as a "Shared / platform" bucket; excluded
 *  from per-user margin. */
export const SHARED_COST_USER_ID = 'system_cron_ra_v2';
