// Type-only — services/llm/reasoningEffort.ts is a dependency-free leaf that
// owns the effort ladder, so importing it here adds no runtime edge.
import type { ReasoningEffort } from '../services/llm/reasoningEffort.js';
export type { ReasoningEffort };

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
  // Completion budget. Thinking-enabled DeepSeek and OpenAI reasoning models
  // via OpenRouter add reasoning headroom to this answer allowance.
  maxTokens?: number;
  // Reasoning budget. OpenRouter sends reasoning.max_tokens: models with hard
  // caps count it within maxTokens; OpenAI models map it to effort and also add
  // it as completion headroom. DeepSeek adds it as headroom when thinking is on.
  // On OpenRouter an explicit reasoningEffort supersedes this numeric budget.
  reasoningMaxTokens?: number;
  // Per-call qualitative reasoning effort. Task-specific callers use this to
  // override provider/admin/global tuning without mutating shared state.
  reasoningEffort?: ReasoningEffort;
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
  // Reasoning-effort dial for models that expose one (OpenAI/OpenRouter:
  // minimal|low|medium|high; DeepSeek: high|max; Anthropic: low through max).
  // Providers filter it to what
  // their own API accepts and drop it otherwise — see
  // services/llm/reasoningEffort.ts, which also owns the LLM_REASONING_EFFORT
  // global fallback each provider applies when this is unset.
  reasoningEffort?: ReasoningEffort;
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

