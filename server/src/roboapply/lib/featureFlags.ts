// backend/src/roboapply/lib/featureFlags.ts
//
// Deploy-time feature flags for the RoboApply candidate app. These are read
// from the backend's environment (root .env) and surfaced to the Next.js
// frontend through GET /api/v1/roboapply/auth/me so the client has a single
// source of truth (the frontend cannot read the backend's .env directly).
//
// JOB_APPLYING_ENABLED — master switch for the auto-apply / job-application
// product surface (Today feed, Review queue, Pipeline tracker, Activity log,
// the agent orb, the auto-apply onboarding, and the auto-apply preferences).
// When OFF, the frontend hides those surfaces and lands users on the
// Resume Builder + Mock Interview product instead. Default: ENABLED — the flag
// only disables when explicitly set to the string 'false' (mirrors the
// ROBOAPPLY_CRON_DISABLED convention in RoboApplyCronService).

/** True unless JOB_APPLYING_ENABLED is explicitly set to 'false'. */
export function isJobApplyingEnabled(): boolean {
  return (process.env.JOB_APPLYING_ENABLED ?? '').trim().toLowerCase() !== 'false';
}
