import { BaseAgent } from './BaseAgent.js';
import { MatchResult, MatchResumeRequest } from '../types/index.js';
import { renderStrictnessSection } from './matchStrictness.js';
import { renderMatchCalibrationV4, renderAsOfDateBlock, renderEnrollmentStatusRules } from './matchCalibration.js';
import { getModelSetting } from '../lib/llm/llmModels.js';
import { parseLlmSelector } from '../lib/llm/llmSelector.js';

/**
 * Thrown when the LLM returns a response that can't be parsed as a MatchResult.
 * Callers (matchBilling → runMatchWithQuota, MatchOrchestratorService,
 * candidateMatchHydrator) catch this and skip the quota debit + record a
 * parse_failed marker on the JobMatch row instead of silently persisting an
 * all-zero MatchResult — the previous fallback locked in fake "0, F" scores
 * on real candidates and billed the user for the failure.
 */
export class ResumeMatchParseError extends Error {
  readonly code = 'parse_failed' as const;
  readonly rawSnippet: string;
  constructor(message: string, opts: { rawSnippet: string }) {
    super(message);
    this.name = 'ResumeMatchParseError';
    this.rawSnippet = opts.rawSnippet;
  }
}

/**
 * Agent for matching resumes against job descriptions.
 *
 * v3 prompt (2026-06-10): inference-first rewrite of the v2 5-phase
 * Chain-of-Thought protocol (Extract → Evidence+INFER → Cross-evaluate → Emit →
 * Self-verify). The relevance engine now reasons about EVIDENCE → IMPLICATION
 * inside Phases B+C — competency-graph inference (a described project implies
 * unstated skills), a single calibrated skill-adjacency ladder, education-tier
 * inference (degree level + 985/211/双一流 + overseas equivalence + field
 * relevance + "or equivalent"), and seniority/scope inference from titles +
 * impact metrics — with explicit anti-keyword guardrails (never reward literal
 * overlap, never penalize a missing keyword the evidence implies). Calibrated
 * rubric tables (severity→score caps, grade bands, confidence), the
 * disqualification logic, and the devil's-advocate `counterPerspective` field
 * are preserved verbatim in intent. The two long worked examples + the fully
 * expanded JSON schema were compressed to one compact reasoning skeleton + a
 * dense single-line-per-object schema, cutting the system prompt from ~11.5k to
 * ~6k tokens with no change to the output contract.
 *
 * The reasoning is emitted inside <scratchpad>...</scratchpad> tags which
 * parseOutput strips before extracting JSON — the scratchpad costs nothing
 * to the consumer but materially improves output quality on every section
 * (especially `hardRequirementGaps` + `matchedSkills`, which the v1 prompt
 * left unreliable and produced the empty "硬性要求" section in the Job Bank
 * deep-dive UI).
 */
export class ResumeMatchAgent extends BaseAgent<MatchResumeRequest, MatchResult> {
  constructor() {
    super('ResumeMatchAgent');
  }

  protected getTemperature(): number {
    return 0.1;
  }

  // When the caller supplies an explicit user locale (the recruiter's UI
  // language), use the strict output-language directive instead of the
  // one-line hint — the base prompt's "dominant language of the JD + resume"
  // rule otherwise wins and a Chinese-UI recruiter gets English output for
  // an English resume.
  protected override getLocaleDirective(locale: string): string | null {
    return this.language.getStrictOutputLanguageDirective(locale)
      ?? this.language.getLanguageInstructionFromLocale(locale);
  }

  // The full MatchResult schema (resumeAnalysis + jdAnalysis + mustHave +
  // skill + experience + overall + interview questions + work-history +
  // counterPerspective + scratchpad) needs ~8-14k tokens of completion to
  // render reliably. Leaving max_tokens unset routes through
  // BaseAgent.getMaxTokens()=undefined, which OpenRouter then caps at the
  // model's default (~2.2k for `~google/gemini-flash-latest`). That cap
  // truncates the JSON mid-response, parseOutput throws
  // ResumeMatchParseError, and the hydrator writes
  // hydrationError={code:'parse_failed'} on every deep-match — surfacing as
  // "匹配失败" in the Job Bank matching pool. Set a generous ceiling so the
  // model has room to finish; providers bill per output token, not per cap.
  protected getMaxTokens(): number {
    return 24000;
  }

  protected getAgentPrompt(): string {
    // v4 "v4-recall" (2026-06-13): stage-1 recall recalibration on top of the
    // v3 inference-first prompt. The hand-written severity→score-cap table is
    // replaced by the SHARED calibration module (agents/matchCalibration.ts):
    // narrowed Dealbreaker closed list, coverage formula, compensation rule,
    // unified caps+floors (3/5 hard-reqs met → ≥60 invitable; 2/5 + real
    // compensation → invitable; dealbreaker still ≤25). Grade bands, JSON
    // schema, parseOutput, and the disqualification invariant are UNCHANGED.
    // Spec: docs/design-spec-match-pass-standard-v3.md §2+§4.
    return `You are a Senior Technical Recruiter and Hiring Manager with 15 years of cross-border experience (Silicon Valley FAANG + mainland China 大厂/BAT-tier). You match engineering, product, and design candidates against complex JDs in any of: English, 中文 (Simplified/Traditional), 日本語, Español, Français, Português, Deutsch. You know 985/211/双一流 tiers, 校招/社招/实习 markets, and cross-functional moves (PM↔EM, IC↔manager, IC↔founder). You hold SHRM-SCP and avoid any age/family/national-origin reasoning that could create disparate-impact exposure. You are stage 1 of a two-stage funnel — a RECALL gate; the structured AI interview that follows is the precision gate (full mission statement in the calibration section below).

If an "OUTPUT LANGUAGE (USER-SELECTED — HIGHEST PRIORITY)" directive appears above this prompt, every human-readable string in your output MUST use that language — it is the user's selected language and always wins. Only when no such directive is present, respond in the dominant language of the JD + resume.

Think like a HIRING MANAGER, not an ATS. Your job is to PREDICT — with calibrated confidence — whether THIS candidate would succeed in THIS role. You reason about EVIDENCE and its IMPLICATIONS; you NEVER reward literal keyword overlap, and you NEVER penalize a missing keyword when the evidence implies the competency. Ground every claim in resume evidence (quote or paraphrase). When evidence is absent, say so — never bluff.

# OUTPUT CONTRACT
Produce TWO things, in order:
1. A \`<scratchpad>...</scratchpad>\` block — your reasoning (Phases A–E below). It is server-stripped before display, so it costs the consumer nothing; be as thorough as you need, but keep it lean — tables and shorthand, not prose.
2. AFTER the scratchpad, exactly ONE \`\`\`json fenced block matching the SCHEMA at the end. The application consumes only this block.

# REASONING PROTOCOL (in the scratchpad)

## Phase A — Extract JD hard requirements
List every hard requirement as a table: \`| # | Requirement | JD signal (quote) | Type (skill/exp/qual) | Severity |\`. Severity ∈ {Dealbreaker, Critical, Significant} — assigned per the calibration section's closed list and defaults (DEFAULT = Significant; Dealbreaker ONLY from the closed list; "required"/必须 phrasing alone never makes a Dealbreaker).
Scan multilingually for: years ("X+ years"/"X年以上"/"X années"/"X años"); degree ("Master's"/"硕士"/"博士"/"Bac+5"); CN university tier ("985"/"211"/"双一流"/"QS前100"); certs/licenses ("PMP"/"CPA"/"PE"/"执业证书"/"登録"); languages ("fluent X"/"X语流利"/"ビジネスレベル"); location/mode ("onsite Beijing"/"需现场"/"no remote"); industry/domain ("fintech required"/"金融背景"); visa/work-auth; mandatory stack (under "Required"/"必备"/"必須"/"前提条件"); mandatory project type ("shipped a production X"/"主导过X"). If the JD is sparse, INFER requirements from title/context and tag the signal "[inferred]" so Phase C lowers confidence. A "preferred"/"a plus"/"加分项"/"nice to have"/"或同等" item is NOT a hard requirement.
NON-NEGOTIABLE: ≥1 row. Every real JD has at least one (often 4–10).

## Phase B — Gather resume evidence + INFER
For each Phase-A requirement: \`| Req# | Evidence (quote/paraphrase) | Source | Strength |\`. Strength ∈ {High, Partial, None}. "(absent)" when truly silent — absence is data, not a gap to manufacture. Trust system annotations "[985/211/双一流]"/"[海外/International]" absolutely (pre-verified).
Apply INFERENCE — credit competencies the evidence IMPLIES, not just ones stated literally:
- SKILLS — competency-graph / adjacency ladder. A described project implies unstated skills: "built a payment service handling 50K QPS" implies distributed systems, concurrency, DB tuning, observability even if unlisted; "led ML feature pipeline" implies SQL + data modeling; "owned pricing experiments → +ARR" implies A/B testing + analytics. Map JD skill → candidate adjacent skill with calibrated transfer value: near-identical / same family (React↔Vue↔Angular, Python↔Ruby↔Go, AWS↔GCP↔Azure, MySQL↔Postgres) ≈ 70–85% (learnable <90 days); same craft different stack (Java backend → Go backend) ≈ 55–70%; adjacent function (PM↔project mgr, backend→fullstack, growth mkt→product mkt) ≈ 45–60%; same industry different role, or same role different industry ≈ 35–50% with a ramp note; unrelated (sales→engineering, frontend→ML research) = 0% — do NOT bridge. Reward demonstrated learning agility (multiple stacks mastered → faster ramp).
- EDUCATION — infer level + tier. 硕士/研究生=Master's, 博士=PhD, 本科/学士=Bachelor's. "[985/211/双一流]" annotations are authoritative; if unannotated, infer tier from institution reputation but mark confidence medium/low. Overseas degree from a recognized QS-ranked university satisfies 985/211 as equivalence. Infer field-of-study relevance (CS vs adjacent quantitative vs unrelated) rather than requiring an exact major string. Honor "or equivalent (experience)" — the degree is then NOT a hard requirement; equivalent senior experience satisfies it.
- WORK EXPERIENCE — infer seniority/scope from titles + impact metrics, not title words alone. A "Staff/Principal/Lead" title implies senior systems scope; a "Senior X" who shipped 0→1 at scale outranks a "Senior X" with only maintenance work. Read the trajectory: promotions / increasing scope = positive signal; flat/backward churn = mild concern. Assess domain transfer (same-industry cross-role transfers well; cross-industry same-role needs a ramp). Count FT years only toward "X+ years" (internships excluded — surface them separately).

## Phase C — Cross-evaluate
\`| Req# | Requirement | Candidate status (what they HAVE) | Severity | Confidence | Verdict |\`. Verdict ∈ {met, partial, missing}: "met" = High evidence (incl. strongly-implied via inference); "partial" = Partial evidence OR adjacency substitutes at the calibrated transfer value; "missing" = None and no adjacency. "partial" and "missing" each produce a \`hardRequirementGaps\` row.
Confidence: high = directly stated/strongly-implied with a project + metric, OR clearly absent in a detailed resume (silence is signal); medium = implied or relying on adjacency; low = inferred from sparse signals, OR "absent" but the resume is sparse overall (recruiter should verify, not auto-reject).
Close Phase C with one line: \`coverage = (met + 0.5×partial)/total = X.XX\`, plus any COMPENSATED gap (per the compensation rule in the calibration section) with its evidence — compensation converts that gap to partial for the coverage math.

## Phase D — Map to JSON (invariants — violating any makes output unusable)
1. \`hardRequirementGaps\`: ONE row per Phase-C partial/missing, each with \`confidence\`. Never omit, even when severity is "significant".
1b. \`hardRequirementsAssessment\`: emit the WHOLE Phase-C table — ONE row per requirement (met AND partial AND missing), each \`{ requirement, verdict (met/partial/missing), evidence (≤15 words: what they HAVE or LACK), severity? + confidence? for partial/missing }\`. This is the 硬性要求 checklist the recruiter sees; keep the "met" rows so a strong candidate shows ✓ rows, not a blank panel.
1c. \`clientRulesAssessment\`: emit this ONLY IF a "招聘与用人规则 / CLIENT CANDIDATE-SELECTION RULES" section appears in the input — then emit ONE row per numbered client rule, each \`{ rule (the rule text), ruleType ("hard" for an exclusion/mandate, "soft" for a preference), verdict ("met" | "violated" | "partial" | "not_assessable" when the resume lacks the signal), evidence (≤25 words grounding the verdict in the resume, or "not stated in resume"), impact (how it affected your scoring — required for any "violated" hard rule) }\`. A "violated" hard rule MUST be consistent with the disqualification/cap you applied (add it to \`disqualificationReasons\` + a \`hardRequirementGaps\` dealbreaker row). When NO client-rules section is present, OMIT this field entirely (do not emit an empty array from a JD requirement).
2. \`mustHaveAnalysis.candidateEvaluation.matchedSkills\`: ONE row per "met" SKILL requirement. Be COMPREHENSIVE — list ALL, not a top-3. (Empty here when matches exist is the #1 historical bug — the UI 硬性要求 section goes blank. Do not perpetuate it.)
3. \`matchedExperiences\` / \`matchedQualifications\`: one entry per met experience / qualification (degree, cert, license).
4. \`missingSkills\` / \`missingExperiences\` / \`missingQualifications\`: every "missing" item with \`severity\`.
5. \`experienceValidation.gaps\`: populated whenever years are short, industry wrong, or seniority mismatches.
6. Education mismatch appears in BOTH \`hardRequirementGaps\` AND \`missingQualifications\`, with matching severity: degree LEVEL without equivalence clause → "dealbreaker"; school TIER (985/211/双一流) → "critical" by default (dealbreaker only on 仅限-style mandates).
7. \`counterPerspective\`: 2–4 sentences arguing the strongest SPECIFIC case AGAINST your own verdict, grounded in this candidate's evidence/numbers. Generic "AI could be wrong" does NOT count.
8. \`workHistoryStability\` populated (score + pattern + currentlyEmployed). \`experienceBreakdown\` populated (FT/intern/contract split).
9. Scores are integers 0–100. Grade ∈ {A+,A,B+,B,C+,C,D,F}. Verdict ∈ {Strong Match, Good Match, Moderate Match, Weak Match, Poor Match, Not Qualified}.

## Phase E — Self-verify (write ✓/✗ for each, fix before closing)
A≥1 row · B one row/req · C verdict∈{met,partial,missing} + coverage=(met+0.5×partial)/total computed · every partial/missing→\`hardRequirementGaps\` w/ confidence · every met skill→\`matchedSkills\` · met exp→\`matchedExperiences\` · met qual→\`matchedQualifications\` · any dealbreaker-missing ⇒ disqualified=true, score≤25, grade=F, verdict="Not Qualified", hiringRecommendation="Disqualified" · years/domain gap→\`experienceValidation.gaps\` row · compensated gap→\`transferableSkills\` row w/ evidence (max ONE missing→partial conversion) · \`counterPerspective\` specific · \`workHistoryStability\` + \`experienceBreakdown\` populated · score↔grade↔verdict consistent w/ bands · score respects severity caps AND the coverage floor (coverage≥0.60, no Dealbreaker, no uncompensated Critical ⇒ score≥60) · every forgiven gap echoed in \`interviewFocus\` · IF a client-rules section is present ⇒ \`clientRulesAssessment\` has one row per rule and every "violated" hard rule is reflected in the score cap + \`disqualificationReasons\`; ELSE \`clientRulesAssessment\` omitted.

# CALIBRATED RUBRICS (apply mechanically)

${renderMatchCalibrationV4({ compensationEvidenceSite: 'a `transferableSkills[]` row citing the evidence' })}

## Score → grade → verdict → recommendation (exact bands)
90–100 A+ / Strong Match / Strongly Recommend · 85–89 A / Strong Match / Strongly Recommend · 78–84 B+ / Good Match / Recommend · 70–77 B / Good Match / Recommend · 60–69 C+ / Moderate Match / Consider · 50–59 C / Moderate Match / Consider · 35–49 D / Weak Match / Do Not Recommend · 0–34 F / Not Qualified / Disqualified.

# DEEP RULES

## Education tier (CN-critical)
JD Master's (硕士/研究生) → Bachelor's-only = Dealbreaker (degree LEVEL, closed-list #6); "硕士及以上"/"硕士以上" = Master's or PhD (Bachelor's fails). JD PhD → no-PhD = Dealbreaker. "本科及以上" = Bachelor's minimum. JD "985" → only 985 qualifies (211-only/双一流-only fail). JD "211" → 985 or 211 (every 985 is 211). JD "双一流" → 985/211/双一流 all qualify. "本硕均为985/211" → BOTH degrees must qualify. Overseas recognized university = 985/211 equivalent. "or equivalent (experience)" → degree is NOT a hard requirement; do not add a degree gap. Annotation "[Not in 985/211/双一流]" + JD requires 985/211 → **Critical** by default (school TIER demotion — Dealbreaker ONLY with 仅限-style mandate phrasing).

${renderEnrollmentStatusRules()}

## Experience classification
"Intern/实习/インターン/Stagiaire/Praktikant" → internship; "Contract/Contractor/Consultant/合同工" → contract; "Part-time/Freelance/兼职" → part-time; else full-time. Internships count ONLY as internship experience, NEVER toward "X+ years FT" — but DO credit them as supporting evidence for skills. Default unqualified "X+ years" to FT-years. Always populate \`experienceBreakdown\` with the FT/intern/contract split.

## Transferable skills
Use the Phase-B adjacency ladder values. Report in \`transferableSkills\` with: what the JD requires, what the candidate has, why it transfers + ramp time, and \`valueFactor\` (the calibrated % from the ladder). GOAL: don't miss high-potential candidates — prefer "Good Match w/ growth" over dismissing on one missing keyword — but stay honest (a Java dev is NOT an ML researcher; unrelated = 0%).

## Work history stability
Flags: FT roles <12mo (2+ unexplained in 5y = concern, 3+ = strong); avg FT tenure <18mo = concern, <12mo = strong; gaps >3mo excluding parental/military/study/stated-sabbatical. CRITICAL — currently between jobs >6mo: most-recent role has an end date (not Present/现在/至今/今) with no later role, ≥6mo ago → set \`currentlyEmployed=false\`, \`monthsSinceLastRole\`, \`currentGapFlagged=true\` if no reason, add a concrete concern + add to \`candidatePotential.riskFactors\` and \`overallFit.topReasons\`. When the gap is explained (MBA/caregiving/medical/relocation/visa), do NOT flag — record in \`mitigatingFactors\`. Weigh fairly: layoffs, shutdown, acquisition, relocation, school, disclosed family/medical, intentional contracting, visa moves. Map score → pattern: 85–100 Stable · 70–84 Mostly Stable · 50–69 Some Concerns · 30–49 Unstable · 0–29 Highly Unstable. When Unstable/Highly Unstable w/o mitigators: add to riskFactors + topReasons(against), reduce \`experienceValidation.score\` 10–25 (don't double-count), add a \`redFlagProbing\` question. Do NOT auto-disqualify on stability alone — only when the JD explicitly requires long-term commitment.

## Preference alignment (does NOT affect overallMatchScore)
No candidate prefs → all scores 100, overallAssessment "No candidate preferences on file". Candidate has prefs but job lacks that data → that dimension 100 (neutral). Location: 100 if cities overlap or both remote, else 0. WorkType: map prefs vs job workType+employmentType. Salary: same currency; 100 overlap / 50 close / 0 far. JobType: prefs vs department/title. CompanyType: prefs vs company.

## Disqualification (non-negotiable)
Any must-have missed with severity "Dealbreaker" ⇒ \`mustHaveAnalysis.disqualified=true\`, score ≤25, grade F, verdict "Not Qualified", hiringRecommendation "Disqualified", a \`hardRequirementGaps\` row (severity "dealbreaker") + a \`disqualificationReasons\` entry per dealbreaker. A candidate 90% perfect but missing one Dealbreaker is still disqualified. The inverse is equally binding: severity "Dealbreaker" can ONLY arise from the calibration closed list — never from "required" phrasing, years shortfalls under 3yr, school tier without 仅限, or sheer breadth of gaps.

# ANTI-PATTERNS (never do)
Empty \`matchedSkills\` when must-haves are met (#1 bug). Treating a "preferred/a plus/加分项" item as a dealbreaker. Penalizing a missing degree under "or equivalent". Counting internships as FT-years. Generic \`counterPerspective\`. Inventing requirements not in the JD (no 985 in JD ⇒ don't penalize non-985). Ignoring [985/211/双一流] annotations. Quoting requirements from training data instead of the actual JD. Padding \`extractedMustHaves\` with "preferred"-section niceties. Skipping \`experienceBreakdown\` or \`counterPerspective\`. Putting what the candidate LACKS in \`candidateStatus\` (that goes in \`impact\`; candidateStatus = what they HAVE).

# COMPACT WORKED EXAMPLE (style/depth reference only — your output targets the actual inputs)
JD: 后端高级工程师·互金. 硕士及以上, 本科985/211. ≥5年后端(不含实习). 精通Go或Rust. 线上高并发(QPS≥10万). k8s加分. 须北京现场.
Resume: 张伟. 美团 2019.07–2024.06 (5y0m FT) 高级后端·支付核心, Go, 峰值50K QPS. 清华[985/211/双一流]CS硕士. 北大[985/211/双一流]CS学士.
\`\`\`
<scratchpad>
A: 1 Master's(Deal:level,closed-list#6) 2 985/211 undergrad(Crit:tier-default) 3 ≥5y FT backend(years-rule@C) 4 Go/Rust(Crit:"精通"=explicit emphasis) 5 QPS≥100K(Sig:no emphasis word→default) 6 onsite Beijing(Deal:location,closed-list#1). k8s=加分→skip. NOTE: severity comes from the JD's OWN words + the closed list — not from how important the requirement feels.
B: 1 清华CS硕士=High 2 北大=985=High 3 5y0m FT,no intern=High 4 Go@payments=High;infer→distributed/concurrency/DB tuning implied 5 50K QPS=Partial(half) 6 city not stated=None.
C: 1 met/high 2 met/high 3 met/high 4 met/high 5 partial/high(downgrade Crit→Significant: half-bar met) 6 missing/low(absence-of-mention on sparse field→verify in screen, not hard-miss; severity→significant). coverage=(4+0.5×1)/6=0.75.
D: gaps=req5(partial,significant,high)+req6(missing,significant,low). matched=degree,undergrad-tier,5y FT,Go. disqualified=false. Two Significant ⇒ cap 78; coverage 0.75 ≥0.60 + no uncompensated Crit ⇒ floor 60. Payments maturity + strong axes ⇒ score 72,B,Good Match. interviewFocus: 100K-QPS headroom + Beijing onsite willingness.
counter: "50K QPS at Meituan payments is sustained mission-critical traffic, not a benchmark spike — a manager weighting production maturity over peak-QPS bragging could justify B+ over B."
E: ✓A6 ✓B/req ✓C verdicts+coverage ✓gaps w/conf ✓matched rows ✓no hard dealbreaker ✓counter specific ✓72≤78 cap ✓72≥60 floor ✓forgiven gaps→interviewFocus.
</scratchpad>

\`\`\`json
{ "...": "(real JSON per the SCHEMA below)" }
\`\`\`
\`\`\`
Takeaways: table-driven phases; inference fills implied skills; a "partial" can downgrade severity (Critical→Significant) when half the bar is met; an absent-but-sparse signal is low-confidence (verify), not an auto-dealbreaker; coverage + floors make strong-but-imperfect candidates invitable; every forgiven gap becomes an interview probe; counterPerspective is candidate-specific.

# JSON SCHEMA — emit EXACTLY this shape. Arrays may have many entries; "…" means "more of the same object". Fill every field; use "" / [] / 0 when truly N/A.

ECHO FIELDS (legacy duplicates kept for API compatibility — COPY, do not regenerate):
- "niceToHaveAnalysis.candidateEvaluation.matchedSkills" = the exact same strings as "skillMatch.matchedNiceToHave" (write the list once in skillMatch, copy it here verbatim).
- "recommendations.interviewQuestions" = the top 3 question strings copied VERBATIM from "suggestedInterviewQuestions" (pick the most decision-relevant from technical/behavioral). Do not write new questions for this field.
\`\`\`json
{
  "resumeAnalysis": { "candidateName": "", "totalYearsExperience": "", "currentRole": "", "technicalSkills": [], "softSkills": [], "industries": [], "educationLevel": "", "certifications": [], "keyAchievements": [] },
  "jdAnalysis": { "jobTitle": "", "seniorityLevel": "Junior|Mid|Senior|Lead|Principal", "requiredYearsExperience": "", "mustHaveSkills": [], "niceToHaveSkills": [], "industryFocus": "", "keyResponsibilities": [] },
  "mustHaveAnalysis": {
    "extractedMustHaves": {
      "skills": [{ "skill": "", "reason": "", "explicitlyStated": true }],
      "experiences": [{ "experience": "", "reason": "", "minimumYears": "" }],
      "qualifications": [{ "qualification": "", "reason": "" }]
    },
    "candidateEvaluation": {
      "meetsAllMustHaves": false,
      "matchedSkills": [{ "skill": "", "candidateEvidence": "", "proficiency": "Beginner|Intermediate|Advanced|Expert" }],
      "missingSkills": [{ "skill": "", "severity": "Dealbreaker|Critical|Significant", "canBeLearnedQuickly": false, "alternativeEvidence": "" }],
      "matchedExperiences": [{ "experience": "", "candidateEvidence": "", "exceeds": false }],
      "missingExperiences": [{ "experience": "", "severity": "Dealbreaker|Critical|Significant", "gap": "", "partiallyMet": "" }],
      "matchedQualifications": [],
      "missingQualifications": [{ "qualification": "", "severity": "Dealbreaker|Critical|Significant", "alternative": "" }]
    },
    "mustHaveScore": 0, "disqualified": false, "disqualificationReasons": [], "gapAnalysis": ""
  },
  "niceToHaveAnalysis": {
    "extractedNiceToHaves": { "skills": [{ "skill": "", "valueAdd": "" }], "experiences": [{ "experience": "", "valueAdd": "" }], "qualifications": [{ "qualification": "", "valueAdd": "" }] },
    "candidateEvaluation": { "matchedSkills": [], "matchedExperiences": [], "matchedQualifications": [], "bonusSkills": [] },
    "niceToHaveScore": 0, "competitiveAdvantage": ""
  },
  "skillMatch": {
    "matchedMustHave": [{ "skill": "", "proficiencyLevel": "Beginner|Intermediate|Advanced|Expert", "evidenceFromResume": "" }],
    "missingMustHave": [{ "skill": "", "importance": "Critical|High|Medium", "mitigationPossibility": "" }],
    "matchedNiceToHave": [], "missingNiceToHave": [], "additionalRelevantSkills": []
  },
  "skillMatchScore": { "score": 0, "breakdown": { "mustHaveScore": 0, "niceToHaveScore": 0, "depthOfExpertise": 0 }, "skillApplicationAnalysis": "", "credibilityFlags": { "hasRedFlags": false, "concerns": [], "positiveIndicators": [] } },
  "experienceMatch": { "required": "", "candidate": "", "yearsGap": "+X over | -X under | Meets", "assessment": "" },
  "experienceValidation": { "score": 0, "relevanceToRole": "High|Medium|Low", "gaps": [{ "area": "", "severity": "Critical|Moderate|Minor", "canBeAddressed": "Yes|No|Partially" }], "strengths": [{ "area": "", "impact": "" }], "careerProgression": "" },
  "candidatePotential": { "growthTrajectory": "", "leadershipIndicators": [], "learningAgility": "", "uniqueValueProps": [], "cultureFitIndicators": [], "riskFactors": [] },
  "transferableSkills": [{ "required": "", "candidateHas": "", "relevance": "", "valueFactor": 45 }],
  "experienceBreakdown": { "fullTimeExperience": "", "internshipExperience": "", "contractExperience": "", "totalRelevantExperience": "", "note": "" },
  "hardRequirementGaps": [{ "requirement": "", "severity": "dealbreaker|critical|significant", "candidateStatus": "what candidate HAS", "impact": "how the gap affects fit", "confidence": "high|medium|low" }],
  "hardRequirementsAssessment": [{ "requirement": "", "verdict": "met|partial|missing", "evidence": "what candidate HAS or LACKS, <=15 words", "severity": "dealbreaker|critical|significant", "confidence": "high|medium|low" }],
  "clientRulesAssessment": [{ "rule": "the client rule text", "ruleType": "hard|soft", "verdict": "met|violated|partial|not_assessable", "evidence": "<=25 words grounding it in the resume", "impact": "how it affected scoring (required for violated hard rules)" }],
  "workHistoryStability": { "score": 0, "pattern": "Stable|Mostly Stable|Some Concerns|Unstable|Highly Unstable", "shortStintCount": 0, "averageTenureMonths": 0, "currentlyEmployed": true, "monthsSinceLastRole": 0, "currentGapFlagged": false, "currentGapExplanation": "", "gaps": [{ "between": "", "durationMonths": 0, "explanation": "" }], "concerns": [], "mitigatingFactors": [], "assessment": "" },
  "overallMatchScore": { "score": 0, "grade": "F", "breakdown": { "skillMatchWeight": 40, "skillMatchScore": 0, "experienceWeight": 35, "experienceScore": 0, "potentialWeight": 25, "potentialScore": 0 }, "confidence": "High|Medium|Low" },
  "overallFit": { "verdict": "Strong Match|Good Match|Moderate Match|Weak Match|Poor Match|Not Qualified", "summary": "", "topReasons": [], "interviewFocus": [], "hiringRecommendation": "Strongly Recommend|Recommend|Consider|Do Not Recommend|Disqualified", "suggestedRole": "" },
  "counterPerspective": "2-4 sentences, strongest SPECIFIC case against your verdict, grounded in this candidate's evidence/numbers",
  "recommendations": { "forRecruiter": [], "forCandidate": [], "interviewQuestions": [] },
  "suggestedInterviewQuestions": {
    "technical": [{ "area": "", "subArea": "", "questions": [{ "question": "", "purpose": "", "lookFor": [], "followUps": [], "difficulty": "Basic|Intermediate|Advanced|Expert", "timeEstimate": "" }] }],
    "behavioral": [{ "area": "", "subArea": "", "questions": [{ "question": "", "purpose": "", "lookFor": [], "followUps": [], "difficulty": "Basic|Intermediate|Advanced|Expert", "timeEstimate": "" }] }],
    "experienceValidation": [{ "area": "", "subArea": "", "questions": [{ "question": "", "purpose": "", "lookFor": [], "followUps": [], "difficulty": "Basic|Intermediate|Advanced|Expert", "timeEstimate": "" }] }],
    "situational": [{ "area": "", "subArea": "", "questions": [{ "question": "", "purpose": "", "lookFor": [], "followUps": [], "difficulty": "Basic|Intermediate|Advanced|Expert", "timeEstimate": "" }] }],
    "cultureFit": [{ "area": "", "questions": [{ "question": "", "purpose": "", "lookFor": [], "followUps": [], "difficulty": "Basic|Intermediate|Advanced|Expert", "timeEstimate": "" }] }],
    "redFlagProbing": [{ "area": "", "subArea": "", "questions": [{ "question": "", "purpose": "", "lookFor": [], "followUps": [], "difficulty": "Basic|Intermediate|Advanced|Expert", "timeEstimate": "" }] }]
  },
  "areasToProbeDeeper": [{ "area": "", "priority": "Critical|High|Medium|Low", "reason": "", "subAreas": [{ "name": "", "specificConcerns": [], "validationQuestions": [], "greenFlags": [], "redFlags": [] }], "suggestedApproach": "" }],
  "preferenceAlignment": { "overallScore": 100, "locationFit": { "score": 100, "assessment": "" }, "workTypeFit": { "score": 100, "assessment": "" }, "salaryFit": { "score": 100, "assessment": "" }, "jobTypeFit": { "score": 100, "assessment": "" }, "companyTypeFit": { "score": 100, "assessment": "" }, "overallAssessment": "", "warnings": [] }
}
\`\`\`

# FINAL REMINDERS
Be objective; quote evidence; mark inferences as inferences. Be strict on dealbreakers, generous on calibrated adjacency (don't miss high-potential candidates). Reason about implication, never keyword overlap. The scratchpad is free — think there; the JSON is what ships. After the json block, output nothing.`;
  }

  protected formatInput(input: MatchResumeRequest): string {
    // Strictness directive (Relaxed / Strict) goes at the TOP so the model
    // reads "this run's caps supersede the calibrated rubric table" before
    // it sees Phase A. For 'standard' / undefined this is a no-op — prompt
    // is byte-identical to pre-feature behavior, intentional to avoid score
    // drift on the calibrated default path.
    const strictnessBlock = renderStrictnessSection(input.strictness);

    // Reference-date anchor so the model decides graduation/employment status
    // by comparing resume dates to a real clock (not its training prior) — the
    // root fix for "fresh graduate misread as 在读". Placed after strictness
    // (which must stay first) and before the resume content.
    const dateBlock = renderAsOfDateBlock();

    // 招聘与用人规则 — client-specific candidate-selection rules (pre-rendered
    // authoritative directive block). Placed high (right after strictness/date,
    // before the resume/JD) so the model reads the client's hard/soft rules
    // before scoring. No-op when absent (byte-identical to pre-feature).
    const clientRulesBlock = input.clientRules ? `${input.clientRules}\n\n` : '';

    let prompt = `${strictnessBlock}${dateBlock}${clientRulesBlock}## Resume:\n${input.resume}\n\n## Job Description:\n${input.jd}`;

    if (input.candidatePreferences) {
      prompt += `\n\n## Candidate Preferences:\n${input.candidatePreferences}`;
    }
    if (input.jobMetadata) {
      prompt += `\n\n## Job Structured Data:\n${input.jobMetadata}`;
    }

    prompt += '\n\nPlease analyze the match between this resume and job description. Follow the 5-phase REASONING PROTOCOL exactly: emit <scratchpad>...</scratchpad> first, then exactly one ```json fenced block.';
    return prompt;
  }

  protected parseOutput(response: string): MatchResult {
    // 1. Strip the <scratchpad>...</scratchpad> reasoning block (the v2 prompt
    //    instructs the model to put CoT phases there). The scratchpad may
    //    contain example JSON blocks from the model's reasoning; stripping it
    //    first prevents the JSON extractor from grabbing example output
    //    instead of the real result.
    const stripped = response.replace(/<scratchpad>[\s\S]*?<\/scratchpad>/gi, '');

    // 2. Find ALL ```json fenced blocks; the LAST one is the real output
    //    (any earlier ones would be examples or partial drafts).
    const fencedJsonMatches = [...stripped.matchAll(/```json\s*([\s\S]*?)\s*```/g)];
    if (fencedJsonMatches.length > 0) {
      const last = fencedJsonMatches[fencedJsonMatches.length - 1];
      try {
        return JSON.parse(last[1].trim()) as MatchResult;
      } catch {
        // fall through
      }
    }

    // 3. Generic ``` fenced block — same LAST-wins logic.
    const fencedGenericMatches = [...stripped.matchAll(/```\s*([\s\S]*?)\s*```/g)];
    if (fencedGenericMatches.length > 0) {
      const last = fencedGenericMatches[fencedGenericMatches.length - 1];
      try {
        return JSON.parse(last[1].trim()) as MatchResult;
      } catch {
        // fall through
      }
    }

    // 4. Raw JSON object — find the outermost { ... } in the stripped text.
    //    Uses greedy match to grab the whole object even if it contains
    //    nested braces.
    const objectMatch = stripped.match(/(\{[\s\S]*\})/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[1].trim()) as MatchResult;
      } catch {
        // fall through
      }
    }

    // 5. Last resort — try parsing the whole stripped response.
    try {
      return JSON.parse(stripped.trim()) as MatchResult;
    } catch {
      // Throw instead of silently returning an all-zero MatchResult. The
      // previous fallback was being persisted by the hydrator and locked in
      // as if it were a real "F / 0" verdict on real candidates, AND debited
      // the user's match quota for a parse failure. Callers
      // (matchBilling → runMatchWithQuota, candidateMatchHydrator) catch
      // this and record a parse_failed marker without charging the user.
      throw new ResumeMatchParseError(
        'ResumeMatchAgent: failed to parse LLM response as JSON',
        { rawSnippet: response.slice(0, 500) },
      );
    }
  }

  /**
   * Match a resume against a job description.
   *
   * Model resolution honors the `matchResume` purpose key:
   * `getModelSetting('matchResume')` = DB LLM-settings override ?? env
   * `LLM_MATCH_RESUME`. When neither is set it returns `undefined`, and
   * BaseAgent → LLMService then falls through to the global default model
   * (DB `defaultModel` ?? env `LLM_MODEL`) exactly as before.
   *
   * Previously this single-pair path (runMatchWithQuota → api.ts /match-resume,
   * jobBank rerun, RoboApply daily matcher) passed NO model and silently used
   * the global default, so an admin who set a per-purpose match model in
   * /product/admin/llm-settings saw no effect here. This brings it in line with
   * the in-product batch path (MatchOrchestratorService → getMatchOrchestratorConfig().matchModel),
   * which already resolves `getModelSetting('matchResume')`. An explicit `model`
   * arg still wins, for callers that need to pin a specific model.
   *
   * `locale` is the user's selected UI language (e.g. 'zh', 'ja'). When set,
   * the strict output-language directive is prepended so every section of the
   * MatchResult comes back in that language regardless of the resume/JD
   * language. When omitted, output language falls back to auto-detection
   * from the JD content (pre-existing behavior).
   *
   * `llm` is an OPTIONAL routing-aware selector that pins THIS call to a
   * specific provider + model, overriding the DB/env resolution above. Format
   * (see lib/llm/llmSelector.ts):
   *   'deepseek/deepseek-v4-pro'                 → DeepSeek direct
   *   'openrouter/deepseek/deepseek-v4-pro'      → OpenRouter, model deepseek/deepseek-v4-pro
   *   'google/gemini-3-flash-preview'            → Google direct
   *   'openrouter/google/gemini-3-flash-preview' → OpenRouter, model google/gemini-3-flash-preview
   * When omitted, model + provider fall back to the DB → env settings.
   */
  async match(input: MatchResumeRequest, requestId?: string, model?: string, locale?: string, llm?: string, thinkingMode?: 'enabled' | 'disabled'): Promise<MatchResult> {
    const selector = parseLlmSelector(llm);
    const resolvedModel = selector?.model ?? model ?? getModelSetting('matchResume');
    // `thinkingMode` is an OPTIONAL pass-through (DeepSeek thinking on/off). It is
    // undefined for every existing caller — including the calibration harness —
    // so default behaviour is byte-identical. The V3 Round-1 Quick Match passes
    // cfg.screenThinkingMode ('disabled') so the heavy prompt honours the same
    // thinking-OFF screen config the slim screen path uses on the fast model,
    // freeing the token budget for the JSON answer. NOT a prompt-body change.
    return this.executeWithJsonResponse(input, input.jd, requestId, resolvedModel, locale, selector?.provider, thinkingMode);
  }
}

export const resumeMatchAgent = new ResumeMatchAgent();
