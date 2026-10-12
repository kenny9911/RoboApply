// lib/fixtures/index.ts
//
// Re-exports for the V2 stub seed data. The fixture modules are TypeScript
// (not JSON) so we get full type-checking against `lib/api/v2/types.ts`.
// Reading fixtures in the stub:
//
//   import { FIXTURE_JOBS, FIXTURE_GOAL, ... } from '../fixtures';
//
// `lib/stub/raV2.stub.ts` deep-clones these on first read (via
// `structuredClone`) so mutations within the stub never bleed into other
// stubs or back into the source module — important when a single Vitest
// run swaps modules between tests.
//
// INT-13 (wave5 WP-93 #49) deleted the fixtures of the removed V2 slices
// (queue, activity, integrations, saved searches, insights, keywords): the
// stub stopped reading them in WP-75 and nothing else imported them.

export { FIXTURE_JOBS } from './jobs';
export { FIXTURE_GOAL } from './goal';
export { FIXTURE_TRACKER } from './tracker';
export { FIXTURE_RESUMES } from './resumes';

// ── V3 fixtures ───────────────────────────────────────────────────────
export {
  FIXTURE_MOCK_CATALOG,
  FIXTURE_MOCK_QUESTIONS,
  type FixtureMockQuestion,
} from './mockCatalog';
export { FIXTURE_MOCK_SESSIONS, FIXTURE_MOCK_SCORE } from './mockSessions';
export { FIXTURE_PREFERENCES, FIXTURE_PREFERENCE_OPTIONS } from './preferences';
export {
  FIXTURE_AI_REWRITES,
  FIXTURE_SUMMARY_REWRITES,
  FIXTURE_SKILL_SUGGESTIONS,
  FIXTURE_TAILOR_DIFF,
  FIXTURE_RESUME_COACH_TIPS,
  type RewriteByAction,
} from './resumeAI';
