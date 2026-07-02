/**
 * Match calibration v4 ("v4-recall") — the SHARED stage-1 scoring rubric
 * interpolated into BOTH per-pair match agents (`ResumeMatchAgent` heavy +
 * `MatchAgent` slim). Spec: docs/design-spec-match-pass-standard-v3.md §2+§4.
 *
 * Why shared: before v4 the two agents carried hand-copied severity→cap
 * tables that drifted (heavy 25/45/65 vs slim 35/55/70), so the same
 * candidate could pass a kickoff batch and fail a single-pair re-run inside
 * one bucket. All calibration numbers now live HERE and only here.
 *
 * Design rules:
 *   1. Stage-1 matching is a RECALL gate (score ≥60 = "worth an interview
 *      slot"), stage-2 interview evaluation is the PRECISION gate. The cap
 *      table is deliberately lenient: 3/5 hard requirements met must be able
 *      to land ≥60, and 2/5 + real compensating strengths must too.
 *   2. The score→grade→verdict band table is NOT defined here and must not
 *      change (UI chips/kanban tiers depend on it — matchStrictness.ts rule).
 *   3. `matchStrictness.ts` directives OVERRIDE these caps per run (strict ≈
 *      the pre-v4 Standard calibration). Keep the two files in sync when
 *      editing either.
 *   4. Stamp `matchData.rubricVersion = MATCH_RUBRIC_VERSION` wherever a
 *      MatchResult is persisted — never compare scores across versions.
 */

export const MATCH_RUBRIC_VERSION = 'v4-recall';

export interface MatchCalibrationOpts {
  /**
   * Where the agent's output schema records compensation evidence:
   * heavy agent → 'a `transferableSkills[]` row citing the evidence',
   * slim agent  → '`missingSkills[].alternativeEvidence` plus a `gapAnalysis` note'.
   */
  compensationEvidenceSite: string;
}

/**
 * The v4 calibration block. Inject INSIDE the agent prompt where the old
 * severity→score-cap table lived. ~600 tokens.
 */
export function renderMatchCalibrationV4(opts: MatchCalibrationOpts): string {
  return `# STAGE-1 FUNNEL MISSION (frames every rule below)
You are stage 1 of a two-stage funnel. Stage 2 is a structured AI interview that verifies everything you are unsure about. Your job is RECALL: never screen out a candidate who could plausibly succeed in this role; only block candidates who are clearly unqualified. Precision is the interview's job, not yours. A score of 60 means "worth an interview slot", NOT "recommend hire" — 60-69 candidates are invitable with open questions. Every gap you forgive (partial, compensated, or low-confidence) MUST surface in \`overallFit.interviewFocus\` so the interview verifies it.

## Severity assignment (re-anchored — severity inflation is anti-pattern #1, alongside empty matchedSkills)
A Dealbreaker is ONLY one of this closed list:
1. Work authorization / visa / hard onsite location with no relocation or remote signal.
2. Legally required license/certification (医师执照, 律师执照, CPA signing authority, security clearance).
3. Required working language demonstrably absent (e.g. native-level Japanese for a JP client-facing role).
4. Zero domain overlap — the adjacency ladder returns "unrelated" for the core craft (sales → ML research).
5. Explicit JD client-mandate phrasing: 仅限 / 必须持有 / "must hold" / "only candidates with X" — including school-tier mandates like 仅限985/211院校 (the ONE case where a tier gap IS a Dealbreaker).
6. Degree LEVEL floor with no equivalence clause (e.g. 硕士及以上 and no "or equivalent").
Demotions from the old calibration: school TIER (985/211/双一流) gaps are **Critical** by default — Dealbreaker only with 仅限-style phrasing (the tier-equivalence rules themselves are unchanged); an uncompensated school-TIER gap therefore takes the ≤58 Critical cap, never the milder Significant table. Years shortfall: ≤1yr short = Significant; 1-3yr = Critical; a shortfall UNDER 3 years is NEVER a Dealbreaker — even when the JD phrases the years floor as required / 必须 / "internships do not count"; but when the shortfall is ≥3 years AND the JD marks the floor non-negotiable (必须满足 / 不接受任何例外 / explicit no-exceptions language), it IS a Dealbreaker — e.g. an 8-year hard floor vs a 4.5-year candidate disqualifies. The DEFAULT severity for any hard requirement is **Significant**; use Critical only when the JD adds explicit emphasis (核心 / 必须精通 / 重点考察) or the missing capability is the role's PRIMARY daily craft. Judge "primary daily craft" mechanically from the JD's role title + responsibilities section (岗位职责/职责描述), NOT from the hard-requirements list: if the missing requirement is not the dominant theme there, it is one secondary duty among several — Significant, not Critical. STRUCTURAL CHECK: when you assign Critical, the gap's impact note MUST quote the JD's own emphasis wording (or name the title/responsibilities theme that makes it the primary craft); if you cannot produce such a quote, the severity IS Significant — no exceptions.
Two hard rules that override your instincts: (1) a requirement being phrased as "required" / "must" / 必须 does NOT make its gap a Dealbreaker — Dealbreaker classification comes ONLY from the closed list above; (2) MANY gaps are not a Dealbreaker either — \`disqualified=true\` is set ONLY when a closed-list item is missed. A candidate missing most requirements is blocked by the coverage caps (e.g. coverage <0.40 → ≤50) with \`disqualified=false\`, never by inventing a dealbreaker.

## Coverage (compute in your reasoning; defines mustHaveScore)
coverage = (met + 0.5 × partial) / total hard requirements. Set \`mustHaveAnalysis.mustHaveScore\` = round(100 × coverage). "partial" = adjacency at ≥55% calibrated transfer value OR half-the-bar evidence (e.g. 50K QPS against a 100K requirement).

## Compensation rule (the formal leniency valve)
A MISSING requirement counts as COMPENSATED when the candidate shows EITHER (a) adjacency ≥55% transfer ("same craft, different stack" or closer) with ≥1 year of production evidence, OR (b) ≥2 distinct gap-relevant bonus signals (exceeding another hard requirement ~2× in scale/seniority; a domain-matched marquee employer or achievement; higher relevant education than required). Effect: that gap counts as **partial** for the coverage formula AND its severity downgrades Critical→Significant. BOUND: compensation may convert at most ONE missing→partial per candidate (adjacency-based severity downgrades are unbounded — the ladder is already calibrated). Every compensated gap MUST cite its evidence in ${opts.compensationEvidenceSite} — no evidence, no credit.

## Severity/coverage → score caps & floors (apply the MOST restrictive cap; a Dealbreaker overrides everything)
- Any missing Dealbreaker → score ≤25, grade F, verdict "Not Qualified", hiringRecommendation "Disqualified", \`disqualified=true\`.
- Uncompensated Critical gap → score ≤58 (deliberately below the 60 invite bar; add a "verify in screen" note).
- Compensated Critical gap → reclassified Significant (apply the Significant table).
- Significant gaps: 1-2 → ≤78 · 3-4 → ≤68 · 5+ → ≤58.
- coverage ≥0.60 with no Dealbreaker and no uncompensated Critical → the final score MUST be ≥60 (floor — the "3 of 5 hard requirements met" candidate is invitable by design).
- 0.40 ≤ coverage <0.60 WITH compensation → cap 68; land 58-68 and lean ≥60 when the compensating strengths map to core role outcomes (the "2 of 5 + real compensating strengths" candidate is invitable by design).
- 0.40 ≤ coverage <0.60 WITHOUT compensation → ≤59 (borderline: recruiter review, never auto-invite).
- coverage <0.40 → ≤50 (clearly unqualified — blocked, with \`disqualified=false\` unless a closed-list Dealbreaker is also present).
AFTER choosing your score, mechanically CHECK it against this table: if it exceeds the most restrictive applicable cap, lower it to the cap; if it sits below an applicable floor, raise it to the floor. The caps bind at the top end too — strong evidence elsewhere never licenses exceeding a cap.
(A run-level "Strictness Mode" block prepended to the input OVERRIDES these caps/floors for that run; honor it.)

## Over-specification guard (JDs that list too many "must-haves")
Real JDs routinely over-specify — a kitchen-sink hard-requirements list mixes the role's 2-4 TRUE core requirements with a long tail of nice-to-haves mislabeled "required". Do NOT let sheer requirement COUNT tank a strong candidate:
- First name the role's CORE craft from the title + 岗位职责/responsibilities section; weight coverage toward the core. When the JD lists MORE THAN 6 "hard" requirements, treat the ones NOT reflected in the core responsibilities as effectively preferred — a miss there is at most Significant and must not, on its own, pull coverage below the invite floor.
- "5+ Significant gaps → ≤58" still applies, but count only gaps in CORE requirements toward that tally; long-tail wish-list misses on an over-specified JD do not stack into a Critical/blocking cap.

## Talent-fit recall lift (judge alongside hard-req coverage, never below the floors above)
Beyond checklist coverage, read TALENT RELEVANCE holistically and let a strong read lift the score to the TOP of the applicable cap band (and to ≥60 wherever a floor permits) — recall is the goal; stage 2 verifies:
- Talent relevance: is this person in the right pool/level for the role's CORE craft? A senior, directly-relevant practitioner for that craft is a strong fit despite checklist gaps.
- Transferable skills & experience: high-adjacency strengths (same craft / family / domain) carry forward as REAL coverage, not "missing" — apply the adjacency ladder generously.
- Skills-coverage breadth: a candidate who covers the MAJORITY of the role's working skills (named, or evidenced through projects) is a fit even when a few exact keywords are absent.
A clearly-capable, relevant talent missing one or two hard requirements is INVITABLE — record the gaps in \`overallFit.interviewFocus\`, do not block. (None of this overrides a closed-list Dealbreaker.)

## Calibration examples (style reference — score the actual inputs)
1. JD: React+TS+5yr+电商+本科 (5 hard reqs). Candidate: Vue 4yr lead, TS, 物流SaaS, 本科 → met 2, partial 2 (React-via-Vue ≈75%, years 4/5), missing 1 (电商, Significant) → coverage (2+1)/5 = 0.60 → floor 60 → lands ~64, C+ — INVITE, with probes on React depth + 电商 ramp.
2. Same JD; candidate meets only TS+本科, but is a 6yr Angular team-lead at a marquee company with checkout-scale evidence → compensation converts the React miss → partial → coverage 0.50 + compensated → lands ~61, C+ — INVITE with verify-in-interview notes.
3. Candidate overseas; JD 仅限-onsite 深圳 with no relocation signal → Dealbreaker → ≤25 / F / Disqualified, regardless of other strength.

## False-negative kill list (never block for these)
Adjacent-stack engineers (Vue→React = partial at the ladder value, never "missing") · 1-2yr years shortfall with strong evidence · same-craft career changers (Java→Go backend) · "or equivalent experience" candidates without the degree · sparse/under-written resumes (low confidence + "verify in interview", never a block) · cross-industry same-role at 35-50% transfer (a ramp note, not a rejection) · strong senior ICs missing a 带教/mentorship/小组管理 line item — for IC-craft roles (engineer, analyst, designer, etc.) a missing mentorship/team-lead requirement is Significant, NEVER Critical, no matter how senior the title; verify leadership appetite in the interview. (Only management-titled roles — 经理/主管/Team Lead — whose responsibilities are management-dominated may treat it as Critical.)`;
}

/**
 * Reference-date anchor — prepended to the match agents' USER message (not the
 * cached system prompt) so the model can decide "current vs. past" by comparing
 * resume dates to a real clock instead of its training-data prior. Without this
 * the model treats a recent-past education end date (e.g. 2025.07 read in
 * 2026-06) as if the candidate were still enrolled — the "fresh graduate
 * misread as 在读" bug. Lives here (not inline in each agent) so the heavy and
 * slim agents stay byte-identical. Pass `now` for deterministic tests.
 */
export function renderAsOfDateBlock(now: Date = new Date()): string {
  const iso = now.toISOString().slice(0, 10);
  const year = now.getUTCFullYear();
  return `## REFERENCE DATE — anchor ALL "current vs. past" reasoning here
Today is ${iso} (current year ${year}). Determine enrollment/graduation AND employment status by comparing the dates in the resume against THIS date — never against assumptions from your training data. Any education or job end-date on or before ${iso} is in the PAST.

`;
}

/**
 * Enrollment-vs-graduation reasoning rules — interpolated into the Education
 * section of BOTH match-agent system prompts (kept here so they can't drift).
 * Pairs with `renderAsOfDateBlock`: the date block supplies the clock, these
 * rules tell the model how to read graduation/enrollment markers against it.
 * Directly fixes the "25届毕业生 / ended 2025.07 → 目前在...就读" misread and the
 * follow-on phantom relocation/onsite gap inferred from the school's city.
 */
export function renderEnrollmentStatusRules(): string {
  return `## Enrollment vs. graduation status (do NOT misread a graduate as a current student)
Decide STILL-ENROLLED vs. GRADUATED by comparing the education end date to the REFERENCE DATE in the input — never assume "now" from training data:
- End date on/before the reference date, OR the resume says 毕业/已毕业/graduated → the candidate has GRADUATED and is on the job market (available for full-time work). Do NOT describe them as 在读/在校/在学/"currently studying".
- End date in the FUTURE, OR the education entry itself says 在读/在校/在学/预计YYYY(年)毕业/expected graduation/in progress/present/至今 → currently enrolled.
- CN campus-recruitment markers: "20XX届" / "XX届毕业生" = the graduating CLASS of year 20XX (e.g. "25届" / "2025届" = class of 2025). If that graduating year ≤ the reference year, the candidate has ALREADY graduated. "应届毕业生" = a fresh graduate on the job market (just graduated, or graduating this cycle and seeking full-time work) — treat as AVAILABLE, NEVER as an enrolled student who cannot work.
- NEVER infer enrollment status or current location from WHERE the school is located — a university in 呼和浩特 does NOT mean the candidate currently studies or lives there. Use the candidate's stated current city / 现居地 if present; otherwise treat location as unknown and verify in the interview. Do NOT manufacture a relocation / onsite / availability gap from the school's city or from a misread "still studying" status.`;
}
