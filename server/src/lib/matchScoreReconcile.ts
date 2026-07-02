/**
 * matchScoreReconcile — deterministic post-parse backstop for per-pair
 * match results (the stage-1 analogue of `agents/unifiedEval/scoreReconcile`).
 * Spec: docs/design-spec-match-pass-standard-v3.md §5.
 *
 * The v4 recall rubric relies on prompt-level caps and floors. Historically
 * this module only clamped DOWN (caps) and treated floors as telemetry. That
 * made the calibration MODEL-DEPENDENT: the prompt's leniency was effectively
 * co-calibrated to gemini-3-flash-preview, and a more conservative reasoning
 * model (deepseek-v4-pro — thinking always on, temperature ignored) reasons
 * gaps into Critical/Dealbreaker and lands below the advisory floors that
 * nothing restored, so far fewer candidates cleared the 60 invite bar (the
 * 2026-06 "matching too strict" incident; see project memory). This module now
 * also enforces the floors UPWARD and validates spurious disqualifications, so
 * the calibration is model-agnostic: ANY model that emits the structured
 * coverage/severity fields is corrected in one place.
 *
 * Recruiter policy this encodes (the two-sided constraint):
 *   - DON'T MISS GOOD CANDIDATES (recall): release spurious disqualifications
 *     and raise clearly-qualified candidates to the recall floor.
 *   - NEVER SEND OBVIOUSLY-DISQUALIFIED CANDIDATES (precision): genuine
 *     closed-list Dealbreakers still clamp to ≤25; the DEFAULT for any
 *     uncertain Dealbreaker is to KEEP it (downgrade only on positive
 *     evidence it is severity inflation).
 *
 * What this module guarantees, in order:
 *   1. Spurious-disqualification validation: a Dealbreaker that is
 *      low-confidence, an enrollment/fresh-grad misread, or an `disqualified`
 *      flag unsupported by any genuine Dealbreaker gap while the model's own
 *      coverage says ≥60% — is DOWNGRADED (recall). Genuine closed-list
 *      Dealbreakers are kept.
 *   2. Disqualification invariant: a genuine Dealbreaker ⇒ score clamped ≤25,
 *      grade F, verdict "Not Qualified", recommendation "Disqualified",
 *      disqualified forced true (precision).
 *   3. Floor enforcement (recall): when NOT disqualified, NOT a STRICT run,
 *      coverage (mustHaveScore) ≥60, and no critical gap — raise the score to
 *      the recall floor (60, or 63 under RELAXED). Skipped entirely under
 *      STRICT (matchStrictness.ts: STRICT turns all floors off).
 *   4. Grade/verdict/recommendation consistency: recomputed from the FROZEN
 *      score→grade band table (90/85/78/70/60/50/35) and overwritten on drift.
 *   5. Coverage telemetry: log (never silently clamp) when emitted
 *      `mustHaveScore` deviates >15 points from recomputed coverage.
 *   6. Stamps `rubricVersion` (MATCH_RUBRIC_VERSION) on the result.
 *
 * Wire-in points (run BEFORE the quota commit so billing semantics are
 * unchanged): `runMatchWithQuota` (lib/matchBilling.ts),
 * `MatchOrchestratorService` post-LLM tiering, and the hydrator's
 * `validateMatchResult` success path. Each MUST pass the run's `strictness`
 * so floor enforcement honors a recruiter's explicit STRICT choice.
 */

import type { MatchResult } from '../types/index.js';
import { MATCH_RUBRIC_VERSION } from '../agents/matchCalibration.js';
import type { MatchStrictness } from '../agents/matchStrictness.js';
import { logger } from '../services/LoggerService.js';

/** FROZEN score→grade→verdict→recommendation bands (UI contract — do not edit). */
const BANDS: Array<{ min: number; grade: string; verdict: string; recommendation: string }> = [
  { min: 90, grade: 'A+', verdict: 'Strong Match',   recommendation: 'Strongly Recommend' },
  { min: 85, grade: 'A',  verdict: 'Strong Match',   recommendation: 'Strongly Recommend' },
  { min: 78, grade: 'B+', verdict: 'Good Match',     recommendation: 'Recommend' },
  { min: 70, grade: 'B',  verdict: 'Good Match',     recommendation: 'Recommend' },
  { min: 60, grade: 'C+', verdict: 'Moderate Match', recommendation: 'Consider' },
  { min: 50, grade: 'C',  verdict: 'Moderate Match', recommendation: 'Consider' },
  { min: 35, grade: 'D',  verdict: 'Weak Match',     recommendation: 'Do Not Recommend' },
  { min: 0,  grade: 'F',  verdict: 'Not Qualified',  recommendation: 'Disqualified' },
];

function bandFor(score: number) {
  return BANDS.find((b) => score >= b.min) ?? BANDS[BANDS.length - 1];
}

const DEALBREAKER_CLAMP = 25;
const COVERAGE_DEVIATION_LOG_THRESHOLD = 15;

/** coverage ≥0.60 ⇒ mustHaveScore ≥60 (mustHaveScore is round(100 × coverage)). */
const COVERAGE_FLOOR_THRESHOLD = 60;
/** Recall floor a clearly-qualified candidate is raised to. RELAXED adds +3
 *  (matchStrictness.ts RELAXED_DIRECTIVE); STRICT turns floors OFF entirely. */
const STANDARD_FLOOR = 60;
const RELAXED_FLOOR = 63;

/**
 * Enrollment / fresh-graduate misread detector. The v4 rubric is emphatic that
 * "应届毕业生 = AVAILABLE, NEVER an enrolled student who cannot work" and that a
 * graduate must not be read as 在读/在校. A reasoning model (deepseek-v4-pro)
 * nonetheless sometimes manufactures a DISQUALIFICATION from a misread
 * enrollment status (empirically the fresh-grad golden case dropped 82 → 20).
 * Enrollment status is NOT on the closed Dealbreaker list, so a Dealbreaker
 * justified by it is ALWAYS severity inflation and safe to release. Deliberately
 * narrow: it must hit an availability/enrollment phrase, NOT merely the word
 * 毕业 — a required degree LEVEL (硕士及以上) is a different, genuine gap about
 * NOT HAVING the degree, never about being currently enrolled, and must not
 * match here.
 */
const ENROLLMENT_MISREAD_RE = /(应届|在读|在校|在学|未毕业|尚未毕业|fresh\s*grad|recent\s*graduate|new\s*grad|still\s*(a\s*)?(student|enrolled|studying|in\s*school)|currently\s*(a\s*)?student|currently\s*(enrolled|studying)|cannot\s*work\s*full[\s-]*time|not\s*available\s*for\s*full[\s-]*time|不能全职|无法全职|无法到岗)/i;

function gapText(g: unknown): string {
  const r = g as { requirement?: unknown; candidateStatus?: unknown; impact?: unknown } | null;
  if (!r || typeof r !== 'object') return '';
  return [r.requirement, r.candidateStatus, r.impact]
    .filter((s): s is string => typeof s === 'string')
    .join(' ');
}

/**
 * Should this Dealbreaker gap be DOWNGRADED (severity inflation) rather than
 * honored? We downgrade ONLY on positive evidence of a known false-positive —
 * the default for anything else is to KEEP the Dealbreaker, so an obviously-
 * disqualified candidate is never released (the recruiter's hard precision
 * constraint). Two safe signals:
 *   - confidence === 'low': the rubric says low-confidence gaps are
 *     "verify-in-screen", never auto-reject.
 *   - enrollment/fresh-grad misread: never a closed-list Dealbreaker.
 */
function isSpuriousDealbreaker(g: unknown): boolean {
  const row = g as { confidence?: string } | null;
  if (row?.confidence === 'low') return true;
  if (ENROLLMENT_MISREAD_RE.test(gapText(g))) return true;
  return false;
}

/**
 * CRITICAL gaps the v4 rubric's false-negative kill list says are "a ramp note,
 * not a rejection" — cross-industry SAME-ROLE transfer and adjacent-stack /
 * same-craft moves — must be Significant, never Critical. A reasoning model
 * over-assigns Critical here (deepseek scored a cross-industry same-role
 * candidate 78 one run, 58 + a self-assigned Critical the next), capping below
 * the invite bar. Downgrading these unblocks the recall floor.
 */
const SPURIOUS_CRITICAL_RE = /(cross[\s-]*industry|different\s*industry|industry\s*(mismatch|gap|background)|跨行业|行业(背景)?(不匹配|不同|差异|缺乏|跨)|领域(背景)?(不匹配|不同|跨)|adjacent\s*(stack|tech|technology|framework|skill)|transferab|可迁移|同类(技术|框架|栈)|same\s*craft|career\s*chang|转行|不同行业)/i;

/**
 * Categories the rubric KEEPS Critical (or higher) — NEVER downgrade these, so a
 * genuinely-Critical gap can't be floored into the invite band. This is the hard
 * guard that protects precision: school TIER (985/211/双一流 — Critical by
 * default), a 1-3yr years shortfall (Critical per the rubric), degree level,
 * license/cert, language, and work-authorization gaps.
 */
const CRITICAL_DOWNGRADE_EXCLUSION_RE = /(985|211|双一流|院校|学校\s*(层次|档次|背景|tier)|school\s*tier|硕士|博士|master|phd|doctora|degree|学历|学位|licen[sc]e|执照|资格证|注册|certif|clearance|visa|work\s*authoriz|right\s*to\s*work|签证|工作许可|母语|native|language|语言|year|年限|年经验|经验年)/i;

/**
 * Should this CRITICAL gap be downgraded to Significant (kill-list ramp-note)?
 * Exclusion-first: a gap touching any genuinely-Critical category is KEPT, even
 * if low-confidence — precision before recall. Otherwise downgrade when it is a
 * cross-industry/adjacency pattern or low-confidence.
 */
function isSpuriousCritical(g: unknown): boolean {
  const text = gapText(g);
  if (CRITICAL_DOWNGRADE_EXCLUSION_RE.test(text)) return false;
  const row = g as { confidence?: string } | null;
  if (row?.confidence === 'low') return true;
  return SPURIOUS_CRITICAL_RE.test(text);
}

export interface ReconcileTelemetry {
  clampedForDisqualification: boolean;
  /** A spurious Dealbreaker / unsupported `disqualified` flag was released (recall). */
  disqualificationDowngraded: boolean;
  /** Score was raised UP to the recall floor (recall). */
  floorRaised: boolean;
  /** A kill-list Critical (cross-industry/adjacency/low-confidence) was downgraded (recall). */
  criticalDowngraded: boolean;
  gradeRewritten: boolean;
  coverageDeviation: number | null;
}

/**
 * Deterministic backstop guaranteeing the hard-requirements analysis
 * (`mustHaveAnalysis`, 硬性要求分析) is ALWAYS present and populated, so the
 * recruiter UI card never goes blank when the LLM under-emits it — the
 * acknowledged "#1 bug" both match prompts warn against, which prompt text
 * alone has not closed. Mirrors the module philosophy: ANY model that emits the
 * structured fields is corrected in ONE place rather than re-tuning prompts.
 *
 * STRICTLY SCORE-NEUTRAL: it only fills the *display structure* — it never
 * touches score / mustHaveScore / disqualified / grade / verdict /
 * recommendation, so calibration pass-fail + disqualification agreement are
 * unaffected. `reconcileMatchResult` (which DOES own the score) runs after it.
 *
 * Recovery, all from the SAME parsed result (no external lookups):
 *   - Structure: every nested object/array is defaulted so the UI's
 *     `mustHaveAnalysis && …` gate passes and `.map()` never throws.
 *   - extractedMustHaves.skills ← jdAnalysis.mustHaveSkills, ONLY when not a
 *     single requirement was extracted (so the card lists the JD's hard
 *     requirements even when the dedicated extraction was skipped).
 *   - candidateEvaluation.matchedSkills / missingSkills ← the redundant
 *     skillMatch.matchedMustHave / missingMustHave representation, when the
 *     dedicated arrays are empty but skillMatch carries the data.
 */
export function ensureMustHaveAnalysis(result: MatchResult): MatchResult {
  const r = result as any;
  if (!r || typeof r !== 'object') return result;

  const mha = (r.mustHaveAnalysis && typeof r.mustHaveAnalysis === 'object')
    ? r.mustHaveAnalysis
    : (r.mustHaveAnalysis = {});

  const em = (mha.extractedMustHaves && typeof mha.extractedMustHaves === 'object')
    ? mha.extractedMustHaves
    : (mha.extractedMustHaves = {});
  em.skills = Array.isArray(em.skills) ? em.skills : [];
  em.experiences = Array.isArray(em.experiences) ? em.experiences : [];
  em.qualifications = Array.isArray(em.qualifications) ? em.qualifications : [];

  const ce = (mha.candidateEvaluation && typeof mha.candidateEvaluation === 'object')
    ? mha.candidateEvaluation
    : (mha.candidateEvaluation = {});
  ce.matchedSkills = Array.isArray(ce.matchedSkills) ? ce.matchedSkills : [];
  ce.missingSkills = Array.isArray(ce.missingSkills) ? ce.missingSkills : [];
  ce.matchedExperiences = Array.isArray(ce.matchedExperiences) ? ce.matchedExperiences : [];
  ce.missingExperiences = Array.isArray(ce.missingExperiences) ? ce.missingExperiences : [];
  ce.matchedQualifications = Array.isArray(ce.matchedQualifications) ? ce.matchedQualifications : [];
  ce.missingQualifications = Array.isArray(ce.missingQualifications) ? ce.missingQualifications : [];
  if (!Array.isArray(mha.disqualificationReasons)) mha.disqualificationReasons = [];
  if (typeof mha.gapAnalysis !== 'string') mha.gapAnalysis = '';
  // NOTE: mustHaveScore / disqualified are intentionally NOT defaulted here —
  // reconcileMatchResult reads + owns them. Defaulting would alter its input.

  // Backfill the requirement LIST from the JD analysis when nothing was
  // extracted, so the card still shows the JD's hard requirements.
  const jd = (r.jdAnalysis && typeof r.jdAnalysis === 'object') ? r.jdAnalysis : {};
  const jdMustSkills: string[] = Array.isArray(jd.mustHaveSkills)
    ? jd.mustHaveSkills.filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];
  const nothingExtracted = em.skills.length === 0 && em.experiences.length === 0 && em.qualifications.length === 0;
  if (nothingExtracted && jdMustSkills.length > 0) {
    em.skills = jdMustSkills.map((skill) => ({ skill, reason: '', explicitlyStated: true }));
  }

  // Cross-fill the candidate evaluation from the redundant skillMatch shape.
  const sm = (r.skillMatch && typeof r.skillMatch === 'object') ? r.skillMatch : {};
  if (ce.matchedSkills.length === 0 && Array.isArray(sm.matchedMustHave) && sm.matchedMustHave.length > 0) {
    ce.matchedSkills = sm.matchedMustHave
      .filter((m: any) => m && typeof m.skill === 'string')
      .map((m: any) => ({ skill: m.skill, candidateEvidence: m.evidenceFromResume || '', proficiency: m.proficiencyLevel || '' }));
  }
  if (ce.missingSkills.length === 0 && Array.isArray(sm.missingMustHave) && sm.missingMustHave.length > 0) {
    ce.missingSkills = sm.missingMustHave
      .filter((m: any) => m && typeof m.skill === 'string')
      .map((m: any) => ({ skill: m.skill, severity: m.importance || 'significant', canBeLearnedQuickly: false, alternativeEvidence: m.mitigationPossibility || '' }));
  }

  // Derive meetsAllMustHaves only when the model didn't state it.
  if (typeof ce.meetsAllMustHaves !== 'boolean') {
    ce.meetsAllMustHaves = ce.missingSkills.length === 0
      && ce.missingExperiences.length === 0
      && ce.missingQualifications.length === 0;
  }

  return result;
}

/**
 * Reconcile a freshly parsed MatchResult IN PLACE (also returned for
 * chaining). Safe on partial / slim-schema results: every field access is
 * defensive. Pass `strictness` so floor enforcement honors a STRICT run
 * (floors off) — omitted ⇒ Standard (floors on at 60).
 */
export function reconcileMatchResult(
  result: MatchResult,
  opts: { requestId?: string | null; source?: string; strictness?: MatchStrictness | null } = {},
): MatchResult {
  const r = result as any;
  if (!r || typeof r !== 'object') return result;

  // Guarantee the hard-requirements structure is present + populated BEFORE the
  // score logic runs (score-neutral; see ensureMustHaveAnalysis). This is what
  // keeps the recruiter's 硬性要求 card from going blank on every match path,
  // since reconcile is the single chokepoint they all funnel through.
  ensureMustHaveAnalysis(result);

  const overall = r.overallMatchScore ?? (r.overallMatchScore = {});
  const fit = r.overallFit ?? (r.overallFit = {});
  const mha = r.mustHaveAnalysis ?? {};
  const strictness = opts.strictness ?? 'standard';

  let score = typeof overall.score === 'number' && Number.isFinite(overall.score)
    ? Math.max(0, Math.min(100, Math.round(overall.score)))
    : 0;

  const telemetry: ReconcileTelemetry = {
    clampedForDisqualification: false,
    disqualificationDowngraded: false,
    floorRaised: false,
    criticalDowngraded: false,
    gradeRewritten: false,
    coverageDeviation: null,
  };

  const gaps: any[] = Array.isArray(r.hardRequirementGaps) ? r.hardRequirementGaps : [];
  const mustHaveScore = typeof mha?.mustHaveScore === 'number' && Number.isFinite(mha.mustHaveScore)
    ? mha.mustHaveScore
    : null;

  // ── 1. Spurious-disqualification validation (RECALL, precision-safe) ──────
  // Downgrade Dealbreaker gaps that are severity inflation (low-confidence or an
  // enrollment misread) so they no longer hard-block. Genuine closed-list
  // Dealbreakers are left untouched. Downgrade target is 'significant' (not
  // 'critical') because these are non-blockers — an enrollment "gap" is a
  // non-issue and a low-confidence gap is a verify-in-screen note — so they must
  // not suppress the recall floor either.
  let downgradedAny = false;
  for (const g of gaps) {
    if (!g || typeof g !== 'object' || typeof g.severity !== 'string') continue;
    const sev = g.severity.toLowerCase();
    if (sev === 'dealbreaker' && isSpuriousDealbreaker(g)) {
      g.severity = 'significant';
      g.reconcileNote = 'severity downgraded by backstop (low-confidence or enrollment misread; not a closed-list dealbreaker)';
      downgradedAny = true;
    } else if (sev === 'critical' && isSpuriousCritical(g)) {
      // Kill-list ramp-note (cross-industry same-role / adjacency / low-confidence)
      // — Significant, not a rejection. Unblocks the recall floor. Genuinely-
      // Critical categories (school tier, years, degree, license) are excluded.
      g.severity = 'significant';
      g.reconcileNote = 'critical downgraded by backstop (kill-list ramp-note category or low confidence; rubric says Significant, not a rejection)';
      telemetry.criticalDowngraded = true;
    }
  }

  const genuineDealbreakerGaps = gaps.filter(
    (g) => typeof g?.severity === 'string' && g.severity.toLowerCase() === 'dealbreaker',
  );
  const hasGenuineDealbreaker = genuineDealbreakerGaps.length > 0;
  const modelSaidDisqualified = mha?.disqualified === true;

  // Effective disqualification:
  //  - any GENUINE Dealbreaker gap ⇒ disqualified (precision).
  //  - model set disqualified but NO genuine Dealbreaker backs it: this is only
  //    honored when the model's OWN coverage corroborates a block (mustHaveScore
  //    < 60). When coverage says ≥60% (or is absent), an unsupported disqualified
  //    flag is severity inflation ⇒ RELEASE (recall). This is the internal-
  //    consistency fix for deepseek's spurious fresh-grad disqualification.
  let disqualified: boolean;
  if (hasGenuineDealbreaker) {
    disqualified = true;
  } else if (modelSaidDisqualified) {
    const coverageBlocks = mustHaveScore !== null && mustHaveScore < COVERAGE_FLOOR_THRESHOLD;
    if (coverageBlocks) {
      disqualified = true; // low coverage corroborates the block — keep it
    } else {
      disqualified = false;
      telemetry.disqualificationDowngraded = true;
    }
  } else {
    disqualified = false;
  }
  if (downgradedAny && !disqualified) telemetry.disqualificationDowngraded = true;

  // Correct the record so structured fields are internally consistent.
  if (r.mustHaveAnalysis) r.mustHaveAnalysis.disqualified = disqualified;
  if (telemetry.disqualificationDowngraded) {
    // The released disqualification's reasons no longer apply — clearing avoids a
    // self-contradictory "60 / C+ / Consider but disqualificationReasons=[...]" row.
    if (r.mustHaveAnalysis && Array.isArray(r.mustHaveAnalysis.disqualificationReasons)) {
      r.mustHaveAnalysis.disqualificationReasons = [];
    }
  }

  // ── 2. Disqualification clamp (PRECISION — threshold-independent) ─────────
  if (disqualified) {
    if (score > DEALBREAKER_CLAMP) {
      score = DEALBREAKER_CLAMP;
      telemetry.clampedForDisqualification = true;
    }
  }

  // ── 3. Floor enforcement (RECALL) ────────────────────────────────────────
  // Raise a clearly-qualified candidate the model under-scored to the recall
  // floor. Gated so it can NEVER float an obviously-disqualified candidate:
  // requires NOT disqualified, NO critical gap, and the model's OWN coverage
  // ≥60%. Skipped entirely under STRICT (recruiter explicitly turned floors off).
  if (!disqualified && strictness !== 'strict') {
    const hasCriticalGap = gaps.some(
      (g) => typeof g?.severity === 'string' && g.severity.toLowerCase() === 'critical',
    );
    const floor = strictness === 'relaxed' ? RELAXED_FLOOR : STANDARD_FLOOR;
    if (mustHaveScore !== null && mustHaveScore >= COVERAGE_FLOOR_THRESHOLD && !hasCriticalGap && score < floor) {
      score = floor;
      telemetry.floorRaised = true;
    }
  }

  // ── 4. Grade/verdict/recommendation from the frozen bands ────────────────
  const band = bandFor(score);
  if (overall.score !== score || overall.grade !== band.grade) telemetry.gradeRewritten = true;
  overall.score = score;
  overall.grade = band.grade;
  if (typeof fit === 'object' && fit !== null) {
    if (fit.verdict !== band.verdict) telemetry.gradeRewritten = true;
    fit.verdict = band.verdict;
    fit.hiringRecommendation = disqualified ? 'Disqualified' : band.recommendation;
  }

  // ── 5. Coverage telemetry (approximate; log-only, never clamp) ───────────
  const approx = approximateCoverage(mha, gaps);
  if (mustHaveScore !== null && approx !== null) {
    const deviation = Math.abs(mustHaveScore - approx);
    telemetry.coverageDeviation = deviation;
    if (deviation > COVERAGE_DEVIATION_LOG_THRESHOLD) {
      logger.warn('MATCH_RECONCILE', 'mustHaveScore deviates from recomputed coverage', {
        requestId: opts.requestId ?? undefined,
        source: opts.source,
        emittedMustHaveScore: mustHaveScore,
        approximateCoverageScore: approx,
        deviation,
        score,
      });
    }
  }

  // ── 6. Version stamp — segments dashboards / metrics by calibration. ─────
  r.rubricVersion = MATCH_RUBRIC_VERSION;

  if (telemetry.clampedForDisqualification) {
    logger.info('MATCH_RECONCILE', 'score clamped for disqualification invariant', {
      requestId: opts.requestId ?? undefined,
      source: opts.source,
      clampedTo: DEALBREAKER_CLAMP,
    });
  }
  if (telemetry.disqualificationDowngraded) {
    logger.info('MATCH_RECONCILE', 'spurious disqualification released (recall)', {
      requestId: opts.requestId ?? undefined,
      source: opts.source,
      mustHaveScore,
      downgradedGaps: downgradedAny,
      score,
    });
  }
  if (telemetry.floorRaised) {
    logger.info('MATCH_RECONCILE', 'score raised to recall floor', {
      requestId: opts.requestId ?? undefined,
      source: opts.source,
      strictness,
      mustHaveScore,
      raisedTo: score,
    });
  }
  if (telemetry.criticalDowngraded) {
    logger.info('MATCH_RECONCILE', 'kill-list critical downgraded to significant (recall)', {
      requestId: opts.requestId ?? undefined,
      source: opts.source,
      mustHaveScore,
      score,
    });
  }

  return result;
}

/**
 * Best-effort coverage recompute: met requirements / total requirements,
 * counting each hardRequirementGaps row as unmet (a "partial" row gets no
 * credit here — that asymmetry is why this is telemetry-only).
 * Returns a 0-100 number or null when the shape doesn't expose enough.
 */
function approximateCoverage(mha: any, gaps: any[]): number | null {
  const ce = mha?.candidateEvaluation;
  if (!ce || typeof ce !== 'object') return null;
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const met = len(ce.matchedSkills) + len(ce.matchedExperiences) + len(ce.matchedQualifications);
  const missing = len(ce.missingSkills) + len(ce.missingExperiences) + len(ce.missingQualifications);
  // Slim schema has no matched* arrays — fall back to gaps vs extracted totals.
  const ex = mha?.extractedMustHaves;
  const total = ex && typeof ex === 'object'
    ? len(ex.skills) + len(ex.experiences) + len(ex.qualifications)
    : met + missing;
  if (total <= 0) return null;
  if (met === 0 && missing === 0 && gaps.length === 0) return null; // nothing emitted to compare
  const effectiveMet = met > 0 ? met : Math.max(0, total - Math.max(missing, gaps.length));
  return Math.round((Math.min(effectiveMet, total) / total) * 100);
}
