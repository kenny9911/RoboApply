/**
 * Match strictness directives — shared between `MatchAgent` (the slim v2,
 * primary path for batch matching via MatchOrchestratorService) and
 * `ResumeMatchAgent` (the older v2, primary path for single-pair matches
 * via runMatchWithQuota + Seeker services + InstantSearch + sourcing).
 *
 * Strictness is recruiter-chosen per matching run (Relaxed / Standard /
 * Strict). It is stored on `MatchingSession.strictness`, optionally seeded
 * from `User.matchingPreferences.defaultStrictness`, and threaded into the
 * agent input as `MatchResumeRequest.strictness`.
 *
 * v4 NOTE (2026-06-13): the BASE Standard calibration was recalibrated to
 * the recall-first v4 rubric (shared module `agents/matchCalibration.ts`,
 * spec docs/design-spec-match-pass-standard-v3.md §4). The directives below
 * were rewritten against that new base:
 *   - STRICT ≈ the OLD pre-v4 Standard (25/45/65-55, no floors, adjacency
 *     withheld) — recruiters who want the old behavior pick Strict.
 *   - RELAXED is re-spread softer than the new Standard (35/64/84-74-64,
 *     floors +3, generous adjacency).
 *
 * Design rules (PROJECT-WIDE):
 *   1. **Standard MUST be a no-op directive.** When strictness is
 *      `'standard'` or omitted, this helper returns an empty string — the
 *      LLM input is byte-identical to the un-directed prompt. (The v4 base
 *      recalibration changed the prompt itself — the owner's explicit ask —
 *      but the standard DIRECTIVE stays empty so strictness A/B comparisons
 *      remain clean.)
 *   2. **Override the rubric, don't replace it.** The base prompt of both
 *      agents interpolates the v4 cap/floor table with literal numbers. The
 *      directive injected here explicitly OVERRIDES those caps AND floors
 *      for this run (the LLM honors "this run's caps supersede the table").
 *   3. **Don't touch the grade-band table.** Score → grade is a fixed
 *      mapping the rest of the UI depends on (chips, kanban tiers).
 *      Strictness affects the SCORE the LLM emits, not the table.
 *
 * If you add a new agent that does per-pair matching, call
 * `renderStrictnessSection(input.strictness)` and concatenate the result
 * into your `formatInput()` output (typically as the first block, before
 * the precomputed-signals section).
 */

export type MatchStrictness = 'relaxed' | 'standard' | 'strict';

const RELAXED_DIRECTIVE = `## Strictness Mode: RELAXED (this run only)

The recruiter has dialed strictness DOWN for this run. The v4 calibration in
the base prompt is the "Standard" — for THIS run, apply the adjustments
below. Apply this lens consistently across mustHaveAnalysis,
hardRequirementGaps, missingSkills/Experiences/Qualifications severities, and
overallMatchScore.

- **Adjacency credit (very generous)**: Give 65-85% transfer value for
  adjacent / transferable skills. React ↔ Vue / Angular, Python ↔ Ruby / Go,
  AWS ↔ GCP / Azure, ERP sales ↔ CRM sales, backend ↔ fullstack — treat as
  substantial mitigation for a missing must-have, not as a footnote.
- **Years shortfall**: A shortfall under 2 years is **Significant**, never
  Critical. Never Dealbreaker on years alone unless the gap is 4+ years.
- **Caps & floors — OVERRIDE the base v4 table for this run**:
  - Dealbreaker missing → overallMatchScore.score ≤ 35 (base: 25).
    Grade cap: D. Verdict cap: Weak Match.
  - Uncompensated Critical gap → score ≤ 64 (base: 58).
  - Significant gaps: 1-2 → ≤ 84 (base: 78) · 3-4 → ≤ 74 (base: 68) ·
    5+ → ≤ 64 (base: 58).
  - Floors rise +3: coverage ≥ 0.60 (no Dealbreaker, no uncompensated
    Critical) → score MUST be ≥ 63; 0.40-0.59 with compensation → lean ≥ 62.
- **Verdict bias**: When ≥80% of must-haves are present with adjacent
  evidence, lean toward Good Match or better. When borderline between two
  severities, always pick the LESS severe one.`;

const STRICT_DIRECTIVE = `## Strictness Mode: STRICT (this run only)

The recruiter has dialed strictness UP for this run. The v4 recall-first
calibration in the base prompt is the "Standard" — for THIS run, revert to a
precision-first lens (this mode matches the platform's pre-v4 default).
Apply it consistently across mustHaveAnalysis, hardRequirementGaps,
missingSkills/Experiences/Qualifications severities, and overallMatchScore.

- **Adjacency credit (withheld)**: Do NOT credit adjacent / transferable
  skills toward a missing must-have unless the resume EXPLICITLY states
  equivalent professional experience. React ≠ Vue for this run unless both
  appear on the resume with substantive use. Acknowledge adjacency only
  inline as a note, never as severity mitigation. The compensation rule
  (missing→partial conversion) is DISABLED for this run.
- **Severity (re-tightened)**: School TIER gaps (985/211/双一流) are
  Dealbreaker when the JD requires the tier. A 1-year shortfall on
  "X+ years required" is **Critical**; a 2+ year shortfall is a
  **Dealbreaker**.
- **Caps — OVERRIDE the base v4 table for this run; ALL FLOORS ARE OFF**
  (do not apply any coverage-based minimum score):
  - Dealbreaker missing → overallMatchScore.score ≤ 25. Grade cap: F.
    Verdict cap: Not Qualified.
  - Critical missing → score ≤ 45. Grade cap: D. Verdict cap: Weak Match.
  - Significant (1-2) → score ≤ 65. Grade cap: C+. Verdict cap:
    Moderate Match.
  - Significant (3+) → score ≤ 55. Grade cap: C. Verdict cap:
    Moderate Match.
- **Verdict bias**: Hold the line on must-haves. If ANY explicit must-have
  is missing without strong adjacent evidence on the resume, downgrade
  verdict to Weak Match or lower. Do NOT downgrade Dealbreaker → Critical
  in this mode — call out true dealbreakers as dealbreakers, even if other
  axes are strong.`;

/**
 * Returns the prompt block to inject for the given strictness, or an
 * empty string for 'standard' / undefined (no-op preserves Standard
 * behavior byte-for-byte).
 *
 * Callers should concatenate the returned block at the TOP of
 * `formatInput()` output (above precomputed signals) so the directive
 * frames the model's evaluation rather than appearing as an afterthought.
 */
export function renderStrictnessSection(strictness?: MatchStrictness | null): string {
  switch (strictness) {
    case 'relaxed': return RELAXED_DIRECTIVE + '\n\n';
    case 'strict':  return STRICT_DIRECTIVE + '\n\n';
    default:        return ''; // 'standard' and undefined: no injection
  }
}

/**
 * Coerce arbitrary input (string from DB, undefined, garbage) into a valid
 * MatchStrictness. Falls back to `'standard'`. Use at boundaries where
 * the value comes in as a generic string column (e.g. `MatchingSession.strictness`).
 */
export function normalizeStrictness(raw: unknown): MatchStrictness {
  if (raw === 'relaxed' || raw === 'strict' || raw === 'standard') return raw;
  return 'standard';
}
