// Semantic resume labels (re-exported from semanticLabels.ts)
export * from './semanticLabels.js';

// LLM Types
export interface TextContentPart {
  type: 'text';
  text: string;
}

export interface ImageContentPart {
  type: 'image_url';
  image_url: { url: string }; // data:image/png;base64,...
}

export type MessageContent = string | (TextContentPart | ImageContentPart)[];

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: MessageContent;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  // Cap on REASONING tokens for thinking models (OpenRouter unified
  // `reasoning.max_tokens`). Without it, dynamic thinking can burn the whole
  // maxTokens budget and return empty content (finish_reason=length). Set it
  // well below maxTokens so the answer always has headroom. Ignored by
  // providers/models without reasoning support.
  reasoningMaxTokens?: number;
  // Force the provider to emit a single JSON object (the API-level "JSON mode" /
  // structured-output flag). Translated per provider:
  //   OpenAI / OpenRouter / Kimi / DeepSeek / OpenAI-compatible →
  //     response_format: { type: 'json_object' }
  //   Google (Gemini) → generationConfig.responseMimeType: 'application/json'
  //   Anthropic → ignored (Claude has no json_object mode; prompt/tool-based)
  // Only set this for agents whose prompt asks for a PURE JSON object with NO
  // surrounding prose — JSON mode suppresses any pre-JSON text (e.g. a
  // <scratchpad> reasoning block), so chain-of-thought agents must NOT use it.
  // See BaseAgent.getResponseFormat(). The OpenAI-family providers only attach
  // it when the prompt also mentions "json" (an OpenAI hard precondition);
  // OpenRouter silently drops it for models that don't support it.
  responseFormat?: 'json_object';
  model?: string;
  provider?: string; // Override provider for this call (e.g. 'openai', 'google')
  // Per-CALL DeepSeek thinking-mode override. Wins over the DB/env tuning
  // (DEEPSEEK_THINKING_MODE) for THIS call only, so e.g. the cheap match
  // screen can force thinking OFF without changing the global mode that other
  // DeepSeek agents rely on. Ignored by non-DeepSeek providers and by
  // reasoning-only models (v4-pro, always-on).
  thinkingMode?: 'enabled' | 'disabled';
  requestId?: string;
  visionModel?: string; // Override model for vision tasks
  signal?: AbortSignal;
}

export interface LLMUsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  // True when the provider omitted a usage block and these counts were
  // approximated from text (~4 chars/token). Lets cost analytics flag
  // unmetered calls. See services/llm/tokenEstimate.ts.
  estimated?: boolean;
}

export interface LLMResponse {
  content: string;
  usage: LLMUsageInfo;
  model: string;
}

export interface LLMProvider {
  chat(messages: Message[], options?: LLMOptions): Promise<LLMResponse>;
  getProviderName(): string;
}

/**
 * Per-construction provider overrides resolved from the DB-backed credential
 * tier (system key) or env. Threaded into provider constructors by LLMService so
 * base URLs / proxy keys / tuning can be admin-configured without redeploy. Every
 * field is optional; a provider falls back to its env read / hardcoded default
 * when a field is undefined, preserving byte-for-byte env behaviour when unset.
 */
export interface ProviderExtra {
  baseUrl?: string;
  proxyKey?: string;
  timeoutMs?: number;
  thinkingMode?: 'enabled' | 'disabled'; // deepseek
  reasoningEffort?: 'high' | 'max'; // deepseek
}

// Resume Types - Expanded to preserve all content
export interface ParsedResume {
  name: string;
  email: string;
  phone: string;
  address?: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  skills: string[] | SkillsDetailed;
  experience: WorkExperience[];
  projects?: Project[];
  education: Education[];
  certifications?: Certification[];
  awards?: Award[];
  languages?: LanguageSkill[];
  volunteerWork?: VolunteerWork[];
  publications?: string[];
  patents?: string[];
  summary?: string;
  otherSections?: Record<string, string>;
  rawText?: string;
}

export interface SkillsDetailed {
  technical?: string[];
  soft?: string[];
  languages?: string[];
  tools?: string[];
  frameworks?: string[];
  other?: string[];
}

export interface WorkExperience {
  company: string;
  role: string;
  location?: string;
  startDate?: string;
  endDate?: string;
  duration: string;
  description?: string;
  achievements?: string[];
  technologies?: string[];
  employmentType?: 'full-time' | 'part-time' | 'internship' | 'contract' | 'freelance';
}

export interface Project {
  name: string;
  role?: string;
  date?: string;
  description?: string;
  technologies?: string[];
  link?: string;
}

export interface Education {
  institution: string;
  degree: string;
  field?: string;
  startDate?: string;
  endDate?: string;
  year: string;
  gpa?: string;
  achievements?: string[];
  coursework?: string[];
}

export interface Certification {
  name: string;
  issuer?: string;
  date?: string;
  expiryDate?: string;
  credentialId?: string;
}

export interface Award {
  name: string;
  issuer?: string;
  date?: string;
  description?: string;
}

export interface LanguageSkill {
  language: string;
  proficiency?: string;
}

export interface VolunteerWork {
  organization: string;
  role?: string;
  duration?: string;
  description?: string;
}

// JD Types - Expanded to preserve all content
export interface ParsedJD {
  title: string;
  company: string;
  companyDescription?: string;
  team?: string;
  department?: string;
  location: string;
  workType?: string;
  employmentType?: string;
  experienceLevel?: string;
  education?: string;
  headcount?: number;
  jobOverview?: string;
  description?: string;
  requirements: string[] | RequirementsDetailed;
  responsibilities: string | string[];
  qualifications: string | string[] | QualificationsDetailed;
  hardRequirements?: string;
  niceToHave?: string;
  benefits: string | string[];
  compensation?: CompensationInfo;
  salary?: string;
  applicationProcess?: string;
  deadline?: string;
  contactInfo?: string;
  additionalInfo?: Record<string, string>;
  rawText?: string;
}

export interface RequirementsDetailed {
  mustHave?: string[];
  niceToHave?: string[];
}

export interface QualificationsDetailed {
  education?: string[];
  certifications?: string[];
  experience?: string[];
  skills?: {
    technical?: string[];
    soft?: string[];
    tools?: string[];
    languages?: string[];
  };
}

export interface CompensationInfo {
  salary?: string;
  bonus?: string;
  equity?: string;
  other?: string;
}

// Match Result Types - Enhanced Analysis
export interface MatchResult {
  resumeAnalysis: {
    candidateName: string;
    totalYearsExperience: string;
    currentRole: string;
    technicalSkills: string[];
    softSkills: string[];
    industries: string[];
    educationLevel: string;
    certifications: string[];
    keyAchievements: string[];
  };
  jdAnalysis: {
    jobTitle: string;
    seniorityLevel: string;
    requiredYearsExperience: string;
    mustHaveSkills: string[];
    niceToHaveSkills: string[];
    industryFocus: string;
    keyResponsibilities: string[];
  };
  mustHaveAnalysis: {
    extractedMustHaves: {
      skills: Array<{
        skill: string;
        reason: string;
        explicitlyStated: boolean;
      }>;
      experiences: Array<{
        experience: string;
        reason: string;
        minimumYears: string;
      }>;
      qualifications: Array<{
        qualification: string;
        reason: string;
      }>;
    };
    candidateEvaluation: {
      meetsAllMustHaves: boolean;
      matchedSkills: Array<{
        skill: string;
        candidateEvidence: string;
        proficiency: string;
      }>;
      missingSkills: Array<{
        skill: string;
        severity: string;
        canBeLearnedQuickly: boolean;
        alternativeEvidence: string;
      }>;
      matchedExperiences: Array<{
        experience: string;
        candidateEvidence: string;
        exceeds: boolean;
      }>;
      missingExperiences: Array<{
        experience: string;
        severity: string;
        gap: string;
        partiallyMet: string;
      }>;
      matchedQualifications: string[];
      missingQualifications: Array<{
        qualification: string;
        severity: string;
        alternative: string;
      }>;
    };
    mustHaveScore: number;
    disqualified: boolean;
    disqualificationReasons: string[];
    gapAnalysis: string;
  };
  niceToHaveAnalysis: {
    extractedNiceToHaves: {
      skills: Array<{
        skill: string;
        valueAdd: string;
      }>;
      experiences: Array<{
        experience: string;
        valueAdd: string;
      }>;
      qualifications: Array<{
        qualification: string;
        valueAdd: string;
      }>;
    };
    candidateEvaluation: {
      matchedSkills: string[];
      matchedExperiences: string[];
      matchedQualifications: string[];
      bonusSkills: string[];
    };
    niceToHaveScore: number;
    competitiveAdvantage: string;
  };
  skillMatch: {
    matchedMustHave: Array<{
      skill: string;
      proficiencyLevel: string;
      evidenceFromResume: string;
    }>;
    missingMustHave: Array<{
      skill: string;
      importance: string;
      mitigationPossibility: string;
    }>;
    matchedNiceToHave: string[];
    missingNiceToHave: string[];
    additionalRelevantSkills: string[];
  };
  skillMatchScore: {
    score: number;
    breakdown: {
      mustHaveScore: number;
      niceToHaveScore: number;
      depthOfExpertise: number;
    };
    skillApplicationAnalysis: string;
    credibilityFlags: {
      hasRedFlags: boolean;
      concerns: string[];
      positiveIndicators: string[];
    };
  };
  experienceMatch: {
    required: string;
    candidate: string;
    yearsGap: string;
    assessment: string;
  };
  experienceValidation: {
    score: number;
    relevanceToRole: string;
    gaps: Array<{
      area: string;
      severity: string;
      canBeAddressed: string;
    }>;
    strengths: Array<{
      area: string;
      impact: string;
    }>;
    careerProgression: string;
  };
  candidatePotential: {
    growthTrajectory: string;
    leadershipIndicators: string[];
    learningAgility: string;
    uniqueValueProps: string[];
    cultureFitIndicators: string[];
    riskFactors: string[];
  };
  transferableSkills?: Array<{
    required: string;
    candidateHas: string;
    relevance: string;
    valueFactor: number;
  }>;
  experienceBreakdown?: {
    fullTimeExperience: string;
    internshipExperience: string;
    contractExperience?: string;
    totalRelevantExperience: string;
    note: string;
  };
  hardRequirementGaps?: Array<{
    requirement: string;
    severity: 'dealbreaker' | 'critical' | 'significant';
    candidateStatus: string;
    impact: string;
    /** v2 prompt addition (2026-05-21) — how confident the agent is in this
     *  gap call. 'low' rows should prompt the recruiter to verify in screen
     *  rather than auto-rejecting (handles the "absent because resume is
     *  sparse" case correctly). Older persisted MatchResult rows may omit. */
    confidence?: 'high' | 'medium' | 'low';
  }>;
  /** 2026-06 — COMPLETE per-hard-requirement checklist (every JD hard
   *  requirement, met or not), so the 硬性要求 panel can show ✓-met rows and not
   *  just gaps. `hardRequirementGaps` above stays the misses-only subset for
   *  back-compat. Empty array when the JD declares no hard requirements. */
  hardRequirementsAssessment?: Array<{
    requirement: string;             // verbatim from the JD's hard requirements
    verdict: 'met' | 'partial' | 'missing';
    evidence: string;                // ≤15 words: what the candidate HAS (met) or LACKS (missing)
    severity?: 'dealbreaker' | 'critical' | 'significant';  // for partial/missing
    confidence?: 'high' | 'medium' | 'low';
  }>;
  /** 招聘与用人规则 — per-rule compliance against the client's Candidate Selection
   *  Rules (from the `/match-resume` API `clientRules` param and/or the Client
   *  profile's saved rules). Present ONLY when client rules were supplied to the
   *  match; empty/omitted otherwise. Powers the "Client Selection Rules" section
   *  in the match UI. See lib/clientSelectionRules.ts. */
  clientRulesAssessment?: Array<{
    rule: string;                    // the client rule text (verbatim)
    ruleType: 'hard' | 'soft';       // hard = exclusion/mandate; soft = preference
    verdict: 'met' | 'violated' | 'partial' | 'not_assessable';
    evidence: string;                // what in the resume supports this verdict (≤25 words)
    impact?: string;                 // how it affected the overall assessment (esp. for violated hard rules)
  }>;
  workHistoryStability?: {
    score: number;
    pattern: 'Stable' | 'Mostly Stable' | 'Some Concerns' | 'Unstable' | 'Highly Unstable';
    shortStintCount: number;
    averageTenureMonths: number;
    currentlyEmployed: boolean;
    monthsSinceLastRole: number;
    currentGapFlagged: boolean;
    currentGapExplanation: string;
    gaps: Array<{
      between: string;
      durationMonths: number;
      explanation: string;
    }>;
    concerns: string[];
    mitigatingFactors: string[];
    assessment: string;
  };
  overallMatchScore: {
    score: number;
    grade: string;
    breakdown: {
      skillMatchWeight: number;
      skillMatchScore: number;
      experienceWeight: number;
      experienceScore: number;
      potentialWeight: number;
      potentialScore: number;
    };
    confidence: string;
  };
  overallFit: {
    verdict: string;
    summary: string;
    topReasons: string[];
    interviewFocus: string[];
    hiringRecommendation: string;
    suggestedRole: string;
  };
  recommendations: {
    forRecruiter: string[];
    forCandidate: string[];
    interviewQuestions: string[]; // Legacy simple format
  };
  suggestedInterviewQuestions: {
    technical: InterviewQuestionCategory[];
    behavioral: InterviewQuestionCategory[];
    experienceValidation: InterviewQuestionCategory[];
    situational: InterviewQuestionCategory[];
    cultureFit: InterviewQuestionCategory[];
    redFlagProbing: InterviewQuestionCategory[];
  };
  areasToProbeDeeper: ProbingArea[];
  preferenceAlignment?: PreferenceAlignment;
  candidateSummary?: CandidateSummary;
  /** v2 prompt addition (2026-05-21) — devil's-advocate paragraph. The agent
   *  argues the strongest specific case AGAINST its own verdict, grounded in
   *  candidate-specific evidence. Surfaced in the Deep Dive UI as a "counter
   *  perspective" callout so recruiters get a built-in second opinion before
   *  accepting the verdict. Optional because older persisted MatchResult rows
   *  predate this field. */
  counterPerspective?: string;
}

export interface CandidateSummaryWarning {
  code: string;
  label: string;
  severity: 'amber' | 'rose';
}

export interface CandidateSummary {
  oneLiner: string;
  warnings: CandidateSummaryWarning[];
}

export interface PreferenceAlignment {
  overallScore: number;
  locationFit: { score: number; assessment: string };
  workTypeFit: { score: number; assessment: string };
  salaryFit: { score: number; assessment: string };
  jobTypeFit: { score: number; assessment: string };
  companyTypeFit: { score: number; assessment: string };
  overallAssessment: string;
  warnings: string[];
}

export interface InterviewQuestionCategory {
  area: string;
  subArea?: string;
  questions: InterviewQuestion[];
}

export interface InterviewQuestion {
  question: string;
  purpose: string;
  lookFor: string[];
  followUps: string[];
  difficulty: 'Basic' | 'Intermediate' | 'Advanced' | 'Expert';
  timeEstimate: string;
}

export interface ProbingArea {
  area: string;
  priority: 'Critical' | 'High' | 'Medium' | 'Low';
  reason: string;
  subAreas: ProbingSubArea[];
  suggestedApproach: string;
}

export interface ProbingSubArea {
  name: string;
  specificConcerns: string[];
  validationQuestions: string[];
  greenFlags: string[];
  redFlags: string[];
}

// Invitation Types
export interface InvitationEmail {
  subject: string;
  body: string;
}

// 一键邀约 API Response
export interface RoboHireInvitationResponse {
  email: string;
  bcc: string[];
  name: string;
  login_url: string;
  home_url: string;
  display_name: string;
  /**
   * GoHire user id for the candidate. GoHire returns this as a `number` on
   * fresh-invite responses; the dedup-reuse path in `/api/v1/invite-candidate`
   * returns whatever was stored on `Interview.gohireUserId` (a `String`
   * column), so callers should accept both shapes.
   */
  user_id: number | string;
  request_introduction_id: string;
  expiration: number;
  expiration_time: number;
  company_name: string;
  job_title: string;
  job_interview_duration: number;
  job_summary: string;
  interview_req: string | null;
  qrcode_url: string;
  password: string | null;
  message: string;
  /** GoHire's internal job id (string-encoded). Returned on fresh-invite responses. */
  gohire_job_id?: string;
}

// Interview Evaluation Types - Comprehensive
export interface InterviewEvaluation {
  // Core scores and decision
  score: number; // 0-100 overall match score
  summary: string; // Persuasive candidate highlight intro
  strengths: string[]; // 3-5 key strengths with evidence
  weaknesses: string[]; // 2-4 potential concerns or gaps
  recommendation: string; // Detailed hiring recommendation with reasoning
  hiringDecision: 'Strong Hire' | 'Hire' | 'Weak Hire' | 'No Hire' | 'Disqualified';

  // Skills assessment (legacy compatibility)
  skillsAssessment: SkillAssessment[];

  // 1. Must-Have Requirements Analysis (Critical - determines disqualification)
  mustHaveAnalysis: MustHaveInterviewAnalysis;

  // 2. Technical Capability Assessment
  technicalAnalysis: TechnicalAnalysis;

  // 3. JD Match & Extra Skills
  jdMatch: JDMatchAnalysis;

  // 4. Behavioral Analysis
  behavioralAnalysis: BehavioralAnalysis;

  // 5. Interviewer's Kit
  interviewersKit: InterviewersKit;

  // 6. Level & Fit Assessment
  levelAssessment: 'Expert' | 'Senior' | 'Intermediate' | 'Junior';
  expertAdvice: string; // Professional advice on level, potential growth, specific fit
  suitableWorkTypes: string[]; // Specific roles they're best suited for

  // 7. Question-Answer Assessment
  questionAnswerAssessment: QuestionAnswerAssessment[];

  // 8. Cheating Analysis (optional)
  cheatingAnalysis?: CheatingAnalysis;

  // 9. Key Competency Deep Assessment (optional)
  keyCompetencyAssessment?: {
    professionalCompetency: { score: number; assessment: string };
    resumeInterviewConsistency: { score: number; assessment: string };
    achievementsContribution: { score: number; assessment: string };
    logicCommunication: { score: number; assessment: string };
    businessTeamwork: { score: number; assessment: string };
    overallCompetency: string;
  };

  // 10. Skill Radar (optional)
  skillRadar?: {
    professionalAbility: number;
    teamCollaboration: number;
    communication: number;
    achievementContribution: number;
    experienceFit: number;
  };

  // 11. Personality Assessment (optional)
  personalityAssessment?: PersonalityAssessment;
}

// Must-Have Interview Analysis - Determines disqualification
export interface MustHaveInterviewAnalysis {
  // Extracted must-have requirements from JD
  extractedMustHaves: {
    skills: Array<{
      skill: string;
      reason: string; // Why it's a must-have
      criticality: 'Dealbreaker' | 'Critical' | 'Important';
    }>;
    experiences: Array<{
      experience: string;
      reason: string;
      minimumYears?: string;
      criticality: 'Dealbreaker' | 'Critical' | 'Important';
    }>;
    qualifications: Array<{
      qualification: string;
      reason: string;
      criticality: 'Dealbreaker' | 'Critical' | 'Important';
    }>;
  };
  
  // Verification through interview answers
  interviewVerification: {
    verified: Array<{
      requirement: string;
      verifiedBy: string; // Which Q&A verified this
      evidence: string; // Quote or summary proving competency
      confidenceLevel: 'High' | 'Medium' | 'Low';
    }>;
    failed: Array<{
      requirement: string;
      failedAt: string; // Which Q&A revealed the failure
      reason: string; // Why they failed (wrong answer, no knowledge, etc.)
      severity: 'Dealbreaker' | 'Critical' | 'Significant';
    }>;
    notTested: Array<{
      requirement: string;
      recommendation: string; // What to ask in next round
    }>;
  };
  
  // Scoring
  mustHaveScore: number; // 0-100
  passRate: string; // e.g., "3/5 must-haves verified"
  
  // Disqualification
  disqualified: boolean;
  disqualificationReasons: string[];
  
  // Overall assessment
  assessment: string;
}

export interface SkillAssessment {
  skill: string;
  rating: 'Excellent' | 'Good' | 'Adequate' | 'Insufficient' | 'Not Demonstrated';
  evidence: string;
}

export interface TechnicalAnalysis {
  summary: string; // Deep dive into technical depth/breadth
  depthRating: 'Expert' | 'Advanced' | 'Intermediate' | 'Novice';
  details: string[]; // Specific technical points/findings
  provenSkills: string[]; // Skills with demonstrated real depth
  claimedButUnverified: string[]; // Skills claimed but not proven
  responseQuality: 'High' | 'Medium' | 'Low';
}

export interface JDMatchAnalysis {
  requirements: JDRequirementMatch[];
  hardRequirementsAnalysis: HardRequirementAnalysis[];
  extraSkillsFound: string[]; // Skills NOT in JD but demonstrated
  summary: string;
}

export interface JDRequirementMatch {
  requirement: string; // Copy verbatim from JD
  matchLevel: 'High' | 'Medium' | 'Low' | 'None';
  score: number; // 0-10
  explanation: string; // Evidence-based justification
}

export interface HardRequirementAnalysis {
  requirement: string; // The mandatory requirement
  met: boolean;
  analysis: string; // Explanation of why met or not
}

export interface BehavioralAnalysis {
  summary: string; // Assessment of soft skills/culture
  compatibility: 'High' | 'Medium' | 'Low';
  details: string[]; // e.g., "Communication: Clear", "Adaptability: Strong"
}

export interface InterviewersKit {
  suggestedQuestions: string[]; // Questions to probe gaps/verify skills
  focusAreas: string[]; // Areas needing more investigation
}

export interface QuestionAnswerAssessment {
  question: string; // The question asked
  answer: string; // Summary of candidate's response
  score: number; // 0-100 score for this specific answer
  correctness: 'Correct' | 'Partially Correct' | 'Incorrect';
  thoughtProcess: string; // Evaluation of their reasoning
  logicalThinking: string; // Evaluation of their logic
  clarity: 'High' | 'Medium' | 'Low';
  completeness: 'Complete' | 'Partial' | 'Incomplete';
  // Must-have requirement linkage
  relatedMustHave?: string; // If this Q&A tests a must-have requirement
  mustHaveVerified?: boolean; // If a must-have requirement, did they pass?
  weight: 'Must-Have' | 'Important' | 'Nice-to-Have'; // Question importance weight
}

// Cheating Detection Types
export interface CheatingAnalysis {
  suspicionScore: number; // 0-100 (0=definitely genuine, 100=definitely AI-assisted)
  riskLevel: 'Low' | 'Medium' | 'High' | 'Critical' | 'Unknown';
  summary: string; // 2-3 sentence assessment
  indicators: CheatingIndicator[];
  authenticitySignals: string[]; // List of genuine behavior signs found
  recommendation: string; // Action recommendation (legacy single-string form)
  // wasAnalyzed=false means the call short-circuited (empty/too-short transcript)
  // or failed to parse. Consumers MUST treat this as "no signal", not "clean".
  wasAnalyzed?: boolean;
  analysisReason?: string;
  questionLevelSuspicion?: QuestionLevelSuspicion[];

  /** v3 (2026) additions — see backend/src/types/unifiedEvaluation.ts for the
   *  canonical contract. Adapter `adaptLegacyCheating()` in
   *  UnifiedEvaluationAgent carries these through to the unified shape. */
  detectionConfidence?: 'High' | 'Medium' | 'Low';
  recommendedActions?: Array<{
    priority: 'urgent' | 'normal' | 'low';
    action: string;
    category?: string;
    rationale?: string;
  }>;
  passes?: {
    droppedIndicators?: Array<{ type: string; reason: string }>;
    appliedSeverityDowngrades?: number;
    hardSignalsFired?: string[];
    scoreFloor?: number;
  };
}

export interface CheatingIndicator {
  type: string; // Category name
  description?: string; // What was detected (optional; v2 adapter folds into evidence)
  severity: 'Low' | 'Medium' | 'High';
  evidence: string; // Direct quote or example
  /** v3 (2026) additions — see unifiedEvaluation.ts for canonical docs. */
  subPattern?: string;
  evidenceOffsets?: { start: number; end: number };
  hardSignal?: boolean;
  fairnessConcern?: string;
}

export interface QuestionLevelSuspicion {
  questionId: string;
  questionText?: string;
  score: number; // 0-100
  riskLevel: 'Low' | 'Medium' | 'High';
  reason: string;
}

// Personality Assessment — inferred from interview behavioral cues
export interface PersonalityAssessment {
  mbtiEstimate: string; // e.g. "INTJ" or "ENFP" — best-fit estimate
  mbtiConfidence: 'High' | 'Medium' | 'Low';
  mbtiExplanation: string; // Why this type was chosen based on transcript evidence
  bigFiveTraits: Array<{
    trait: string; // Openness | Conscientiousness | Extraversion | Agreeableness | Neuroticism
    level: 'High' | 'Medium-High' | 'Medium' | 'Medium-Low' | 'Low';
    evidence: string; // Supporting behavioral evidence from transcript
  }>;
  communicationStyle: string; // e.g. "Direct and structured", "Collaborative and empathetic"
  workStylePreferences: string[]; // e.g. ["Independent deep work", "Structured environment"]
  motivators: string[]; // e.g. ["Technical challenge", "Impact-driven"]
  potentialChallenges: string[]; // e.g. ["May struggle with ambiguity", "Could be overly detail-oriented"]
  teamDynamicsAdvice: string; // How this person might fit in a team
  summary: string; // Overall personality summary paragraph
}

// API Request Types
export interface MatchResumeRequest {
  resume: string;
  jd: string;
  candidatePreferences?: string;
  jobMetadata?: string;
  /** Phase 4b — pre-formatted candidate semantic profile to anchor the agent's
   *  conclusions. Generated from Resume.semanticLabels via
   *  formatSemanticTagContext(). Adds ~50–80 tokens to the prompt and
   *  ~5% improvement in seniority/category accuracy on our eval set. */
  semanticTagContext?: string;
  /** Match Weights v2 — per-job axis weights (0-100, sum=100) injected into
   *  the prompt as priority guidance. The agent uses them to bias its gestalt
   *  overall-match-score judgment toward the recruiter's stated priorities.
   *  When omitted, the agent falls back to its default weighting. */
  matchWeights?: Record<string, number> | null;
  /** Match v2 — pre-formatted keyword overlap summary (one-line) computed
   *  by MatchSignals.formatKeywordOverlap. When present, the agent uses it
   *  to ground its scoring on actual lexical evidence. */
  keywordOverlapSummary?: string;
  /** Match v2 — pre-formatted semantic-tag overlap summary (multi-line)
   *  from MatchSignals.formatSemanticTagOverlap. */
  semanticTagOverlapSummary?: string;
  /**
   * Recruiter-chosen rigor for this match. Threaded into the agent prompt
   * by both MatchAgent and ResumeMatchAgent via the shared
   * `agents/matchStrictness.ts` helper. The base (no-directive) calibration
   * is the v4 recall rubric in `agents/matchCalibration.ts`.
   *  - `'standard'` (or omitted) → no prompt injection; the v4 recall-first
   *    base calibration applies (Dealbreaker ≤ 25, uncompensated Critical
   *    ≤ 58, Significant 1-2 ≤ 78 / 3-4 ≤ 68 / 5+ ≤ 58, coverage ≥ 0.60 →
   *    floor 60).
   *  - `'relaxed'` → softer than the v4 base (Dealbreaker ≤ 35, Critical
   *    ≤ 64, Significant ≤ 84/74/64, floors +3, adjacency 65-85%).
   *  - `'strict'` → ≈ the pre-v4 Standard (Dealbreaker ≤ 25, Critical ≤ 45,
   *    Significant ≤ 65/55, NO floors, adjacency withheld unless explicit,
   *    1-yr shortfall Critical / 2+yr Dealbreaker).
   * Source of truth on writes: `MatchingSession.strictness` (per run);
   * `User.matchingPreferences.defaultStrictness` is only a pre-fill hint.
   */
  strictness?: 'relaxed' | 'standard' | 'strict';
  /**
   * 招聘与用人规则 — a pre-rendered "Candidate Selection Rules" prompt block
   * resolved from the Client (Company) profile that owns this job's companyName.
   * When present, both match agents append it near the top of the user message
   * so the LLM treats each client rule as an authoritative directive (hard
   * exclusion → disqualify/cap; soft preference → nudge). Built by
   * `renderClientSelectionRulesBlock(..., 'match')` in
   * `lib/clientSelectionRules.ts`. Omitted (byte-identical to pre-feature) when
   * the job has no matching client or no enabled rules.
   */
  clientRules?: string;
}

/**
 * Public request body for `POST /api/v1/match-resume`. Distinct from the
 * internal agent-input `MatchResumeRequest` because the API accepts an
 * either-or contract — callers may supply `resume` raw text OR a stored
 * `resumeId` (the server hydrates `resumeText` from the DB in that case).
 * After resolution the handler passes a definite-`resume` `MatchResumeRequest`
 * into `runMatchWithQuota` → `ResumeMatchAgent`.
 */
export interface MatchResumeApiBody {
  /** Raw resume text. Required unless `resumeId` is supplied. */
  resume?: string;
  jd: string;
  /**
   * Optional RoboHire `Resume` row id. When provided, the server loads
   * `Resume.resumeText` from the DB (via team-visibility scope) and ignores
   * any `resume` field in the body. Returns 404 if the id is unknown or not
   * visible to the caller. Useful for matching the same candidate against
   * multiple JDs without re-uploading the text.
   */
  resumeId?: string;
  candidatePreferences?: string;
  jobMetadata?: string;
  strictness?: 'relaxed' | 'standard' | 'strict';
  /**
   * 招聘与用人规则 — free-form Candidate Selection Rules from the hiring client.
   * Treated as authoritative directives (like a user prompt): the match agent
   * applies each rule (hard exclusion → disqualify/cap; soft preference →
   * nudge) and returns a per-rule `clientRulesAssessment` in the result. Pass
   * one rule per line for the cleanest per-rule breakdown, or a free prose
   * blob. Also accepted under the hyphenated key `client-rules`. Merged with
   * any rules resolved from `companyName` below.
   */
  clientRules?: string;
  /**
   * Optional client (Company) name. When provided, the server loads that
   * client's saved Candidate Selection Rules (scoped to the API-key owner,
   * case-insensitive) and MERGES them with the free-form `clientRules` above
   * before injecting into the match. No match if the caller owns no Company by
   * that name — the free-form `clientRules` still apply.
   */
  companyName?: string;
  /**
   * Optional output language for all narrative fields (e.g. 'zh', 'zh-TW',
   * 'ja', 'en'). When set, every human-readable section of the MatchResult
   * is written in this language regardless of the resume/JD language;
   * scores, grades and schema enum values are unaffected. When omitted,
   * the handler falls back to the Accept-Language header, then to
   * auto-detection from the JD content.
   */
  locale?: string;
}

/**
 * Response payload returned in `data` by `POST /api/v1/match-resume`.
 * Wraps the agent's full `MatchResult` (all original top-level fields are
 * preserved for back-compat) and adds top-level identifiers + a curated
 * summary block flattened from the nested agent output so SDK consumers
 * don't have to walk `data.overallMatchScore.score` etc.
 */
export interface MatchResumeResponseData extends MatchResult {
  /** RoboHire `Resume` row id — either reused (when `resumeId` was supplied) or auto-created by content hash. */
  resumeId: string;
  /** True iff a new `Resume` row was inserted during this call. False on reuse. */
  resumeCreated: boolean;
  /** ISO 8601 timestamp the match was persisted at. */
  matchedAt: string;
  /** Convenience alias for `overallMatchScore.score`. Defaults to 0 if missing. */
  score: number;
  /** Convenience alias for `overallMatchScore.grade`. Defaults to '' if missing. */
  grade: string;
  /** Convenience alias for `overallFit.verdict`. Defaults to '' if missing. */
  verdict: string;
  /** Convenience alias for `mustHaveAnalysis.disqualified`. Defaults to false if missing. */
  disqualified: boolean;
  /** Convenience alias for `resumeAnalysis.candidateName`. Defaults to '' if missing. */
  candidateName: string;
  /** Convenience alias for `jdAnalysis.jobTitle`. Defaults to '' if missing. */
  jobTitle: string;
}

export interface CreateJDRequest {
  /** Job title (e.g. "Senior Frontend Developer"). At least one of title/requirements/jobDescription must be provided. */
  title?: string;
  /** Free-text requirements, hiring context, or notes the LLM should turn into a JD. */
  requirements?: string;
  /** Existing JD text to refine and improve (instead of generating from scratch). */
  jobDescription?: string;
  /** Locale hint for output language (e.g. 'en', 'zh', 'ja'). Auto-detected from inputs when omitted. */
  language?: string;
  /**
   * Origin of the request. When `'quick-job'`, the route uses
   * `process.env.LLM_QUICK_JOB` (if set) so QuickJob can run on a faster
   * model than the global default. Other values are ignored.
   */
  source?: 'quick-job' | string;
}

export interface InviteCandidateRequest {
  /**
   * Raw resume text. Required unless `resume_id` is provided — in which case
   * the handler loads `Resume.resumeText` from the DB.
   */
  resume: string;
  /**
   * Raw JD text. Required unless `job_id` resolves to a `Job` row whose
   * description/qualifications/hardRequirements/niceToHave fields can be
   * assembled by `buildJobJdContentForInvitation`.
   */
  jd: string;
  candidate_email?: string;
  recruiter_email?: string;
  interviewer_requirement?: string;
  /** When inviting from an existing resume record, pass its ID to avoid re-deriving from text */
  resume_id?: string;
  /** When inviting for a known hiring request, pass its ID to avoid re-deriving from JD text */
  hiring_request_id?: string;
  /** Explicit Job ID — used to load company name, interview language, and correct title */
  job_id?: string;
  /** Explicit job title — ensures the invitation email uses the correct position name */
  job_title?: string;
  /** Company name — included in the invitation email so candidates can identify the sender */
  company_name?: string;

  // ── Action-First Matching v2 — per-invite overrides ───────────────────────
  // language + duration are forwarded to GoHire; mode / passing_score /
  // linked_assessment_id are RoboHire-side and stored on
  // Interview.metadata.inviteConfig for downstream workflows.
  /** Interview format (e.g. "ai_video"). Stored on Interview.metadata.inviteConfig. */
  interview_mode?: string;
  /** Passing-score threshold (0–100). Stored on Interview.metadata.inviteConfig. */
  passing_score?: number;
  /** Language code for the AI interview session (e.g. "en", "zh"). Forwarded to GoHire as `interview_language`. */
  interview_language?: string;
  /** Interview duration in minutes (must be > 0). Forwarded to GoHire as `interview_duration`. */
  interview_duration?: number;
  /** Optional linked assessment template. `null` clears any inherited job default. */
  linked_assessment_id?: string | null;

  // ── Admin-only escape hatch ───────────────────────────────────────────────
  /**
   * Verbatim GoHire body override. When present, the handler sends this
   * payload to GoHire INSTEAD of the body computed by
   * `buildGoHireInvitationRequestBody`. Used by the admin debug-terminal's
   * "GoHire 预览" tab so engineers can manually edit the downstream payload
   * (e.g. test a JD variant) without redeploying. Recruiter/candidate emails
   * on the override still apply for dedup; the rest of RoboHire-side
   * persistence (Interview row, ResumeJobFit, etc.) uses the resolved fields
   * above.
   */
  gohire_body_override?: Record<string, unknown>;
}

export interface EvaluateInterviewRequest {
  resume: string;
  jd: string;
  interviewScript: string;
  /** Exact candidate name — must appear verbatim in evaluation output (prevents LLM homophone substitution) */
  candidateName?: string;
  /** Job title — anchors the evaluation prompt's role context. Optional; when
   *  omitted the prompt renders "(not provided)" and relies on the JD body. */
  jobTitle?: string;
  includeCheatingDetection?: boolean;
  userInstructions?: string;
}

// Resume Insight Types
export interface ResumeInsightInput {
  parsedResume: ParsedResume;
  resumeText: string;
}

export interface ResumeInsight {
  executiveSummary: string;
  careerTrajectory: {
    direction: 'Upward' | 'Lateral' | 'Declining' | 'Early Career' | 'Career Change';
    analysis: string;
    keyTransitions: string[];
    progressionRate: string;
  };
  salaryEstimate: {
    rangeLow: string;
    rangeHigh: string;
    currency: string;
    confidence: 'High' | 'Medium' | 'Low';
    factors: string[];
    marketContext: string;
  };
  marketCompetitiveness: {
    score: number;
    level: 'Highly Sought-After' | 'Competitive' | 'Average' | 'Below Average';
    inDemandSkills: string[];
    rareSkills: string[];
    commoditySkills: string[];
    marketTrends: string;
  };
  strengthsAndDevelopment: {
    coreStrengths: Array<{
      strength: string;
      evidence: string;
      impact: string;
    }>;
    developmentAreas: Array<{
      area: string;
      currentLevel: string;
      recommendation: string;
    }>;
  };
  cultureFitIndicators: {
    workStyle: string[];
    values: string[];
    environmentPreferences: string[];
    managementStyle: string;
  };
  redFlags: Array<{
    flag: string;
    severity: 'High' | 'Medium' | 'Low';
    details: string;
    mitigatingFactors: string;
  }>;
  recommendedRoles: Array<{
    roleType: string;
    industry: string;
    seniorityLevel: string;
    fitReason: string;
  }>;
}

// Job Fit Types
export interface JobFitInput {
  parsedResume: ParsedResume;
  resumeText: string;
  hiringRequests: Array<{
    id: string;
    title: string;
    requirements: string;
    jobDescription?: string;
  }>;
}

export interface JobFitResult {
  fits: Array<{
    hiringRequestId: string;
    hiringRequestTitle: string;
    fitScore: number;
    fitGrade: string;
    verdict: 'Strong Fit' | 'Good Fit' | 'Moderate Fit' | 'Weak Fit' | 'Not a Fit';
    matchedSkills: string[];
    missingCriticalSkills: string[];
    experienceAlignment: string;
    topReasons: string[];
    recommendation: string;
    hardRequirementGaps?: Array<{
      requirement: string;
      severity: 'dealbreaker' | 'significant' | 'minor';
      candidateStatus: string;
    }>;
    transferableSkills?: Array<{
      required: string;
      candidateHas: string;
      relevance: string;
    }>;
    fullTimeExperience?: string;
    internshipExperience?: string;
  }>;
  bestFit: {
    hiringRequestId: string;
    hiringRequestTitle: string;
    reason: string;
  } | null;
  candidateSummary: string;
}

// Screening Types (one-job-many-resumes)
export interface ScreeningInput {
  hiringRequest: {
    id: string;
    title: string;
    requirements: string;
    jobDescription?: string;
  };
  resumes: Array<{
    resumeId: string;
    name: string;
    resumeText: string;
    parsedSummary: string;
  }>;
}

export interface ScreeningResult {
  screenings: Array<{
    resumeId: string;
    fitScore: number;
    fitGrade: string;
    verdict: 'Strong Fit' | 'Good Fit' | 'Moderate Fit' | 'Weak Fit' | 'Not a Fit';
    matchedSkills: string[];
    missingCriticalSkills: string[];
    experienceAlignment: string;
    topReasons: string[];
    recommendation: string;
    hardRequirementGaps?: Array<{
      requirement: string;
      severity: string;
      candidateStatus: string;
    }>;
    transferableSkills?: Array<{
      required: string;
      candidateHas: string;
      relevance: string;
    }>;
  }>;
}

// Recruitment Intelligence Types (Multi-Agent)
export interface RecruitmentIntelligenceInput {
  title: string;
  requirements: string;
  jobDescription?: string;
}

export interface SourcingStrategyInput extends RecruitmentIntelligenceInput {
  candidateProfile: CandidateProfileResult;
}

export interface MarketIntelligenceInput extends RecruitmentIntelligenceInput {
  candidateProfile: CandidateProfileResult;
}

export interface CandidateProfileResult {
  candidatePersonaSummary: string;
  idealBackground: {
    typicalDegrees: string[];
    typicalCareerPath: string[];
    yearsOfExperience: string;
    industryBackground: string[];
  };
  skillMapping: {
    mustHave: Array<{ skill: string; seniorityExpectation: string; reason: string }>;
    niceToHave: Array<{ skill: string; valueAdd: string }>;
  };
  personalityTraits: {
    traits: Array<{ trait: string; importance: 'Critical' | 'High' | 'Medium'; reason: string }>;
    cultureFitIndicators: string[];
  };
  dayInTheLife: string;
}

export interface SourcingStrategyResult {
  sourcingSummary: string;
  platforms: Array<{
    platform: string;
    effectiveness: 'High' | 'Medium' | 'Low';
    strategy: string;
    searchKeywords?: string[];
  }>;
  booleanSearchStrings: string[];
  targetCompanies: Array<{ company: string; reason: string }>;
  targetIndustries: string[];
  passiveVsActive: {
    recommendation: 'Passive' | 'Active' | 'Both';
    passiveStrategy: string;
    activeStrategy: string;
  };
  networkingStrategies: Array<{
    strategy: string;
    expectedYield: 'High' | 'Medium' | 'Low';
    details: string;
  }>;
}

export interface MarketIntelligenceResult {
  marketSummary: string;
  salaryRanges: Array<{
    region: string;
    level: string;
    rangeLow: string;
    rangeHigh: string;
    currency: string;
    notes: string;
  }>;
  supplyDemand: {
    assessment: 'Oversupplied' | 'Balanced' | 'Undersupplied' | 'Severely Undersupplied';
    details: string;
    talentPoolSize: string;
  };
  recruitmentDifficulty: {
    score: number;
    level: string;
    factors: string[];
  };
  timeToHire: {
    estimateDays: string;
    factors: string[];
  };
  competition: Array<{
    competitor: string;
    hiringActivity: string;
    relevance: string;
  }>;
  marketTrends: Array<{
    trend: string;
    impact: 'Positive' | 'Negative' | 'Neutral';
    details: string;
  }>;
}

export interface RecruitmentIntelligenceReport {
  candidateProfile: CandidateProfileResult;
  sourcingStrategy: SourcingStrategyResult;
  marketIntelligence: MarketIntelligenceResult;
  generatedAt: string;
}

// API Response Types
export interface APIResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}
