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
  // Cross-bank search (existing SKUs that had no mapping and fell into "Other").
  ra_crossbank_score: { key: 'crossbank', label: 'Cross-bank Search', modality: 'llm' },
  ra_crossbank_insight: { key: 'crossbank', label: 'Cross-bank Search', modality: 'llm' },
  // Jobright-clone SKUs, pre-registered by FND-3 (ARCHITECTURE.md §7.5). Writers
  // add each one to the DeductionSku union in lib/matchBilling.ts when they
  // first log it. `PLATFORM_SKUS` below marks the shared (non-user) costs.
  ra_job_enrich: { key: 'job_enrich', label: 'Job Enrichment', modality: 'llm' },
  ra_match_score_v3: { key: 'match_score', label: 'Job-Match Scoring', modality: 'llm' },
  ra_fit_analysis: { key: 'fit_analysis', label: 'Fit Analysis', modality: 'llm' },
  ra_competitiveness: { key: 'competitiveness', label: 'Competitiveness Report', modality: 'llm' },
  ra_copilot_turn: { key: 'assistant', label: 'Assistant', modality: 'llm' },
  ra_copilot_summary: { key: 'assistant', label: 'Assistant', modality: 'llm' },
  ra_resume_grade: { key: 'resume_check', label: 'Resume Check', modality: 'llm' },
  ra_resume_fix: { key: 'resume_rewrite', label: 'Resume Rewrite', modality: 'llm' },
  ra_tailor_v2: { key: 'resume_tailor', label: 'Resume Tailor', modality: 'llm' },
  ra_outreach_draft: { key: 'outreach', label: 'Outreach Draft', modality: 'llm' },
  ra_ext_answer: { key: 'ai_answer', label: 'Application Answers', modality: 'llm' },
  ra_job_import: { key: 'job_import', label: 'Job Import', modality: 'llm' },
  ra_interview_guide: { key: 'interview_guide', label: 'Interview Question Guide', modality: 'llm' },
  ra_seo_intro: { key: 'seo_intro', label: 'Public Page Intro', modality: 'llm' },
};

/** The SKUs ARCHITECTURE.md §7.5 adds for the jobright clone (all mapped above). */
export const CLONE_SKUS = [
  'ra_job_enrich',
  'ra_match_score_v3',
  'ra_fit_analysis',
  'ra_competitiveness',
  'ra_copilot_turn',
  'ra_copilot_summary',
  'ra_resume_grade',
  'ra_resume_fix',
  'ra_tailor_v2',
  'ra_cover_letter',
  'ra_outreach_draft',
  'ra_ext_answer',
  'ra_job_import',
  'ra_interview_guide',
  'ra_seo_intro',
  'ra_crossbank_score',
  'ra_crossbank_insight',
] as const;

/** SKUs whose cost belongs to the platform, not to one user (logged under SHARED_COST_USER_ID). */
export const PLATFORM_SKUS: ReadonlySet<string> = new Set(['ra_job_enrich', 'ra_seo_intro']);

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
