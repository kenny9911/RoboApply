/**
 * Semantic labels for a parsed resume.
 *
 * Closed-set fields use canonical English enum keys (stable across resume language).
 * Open-set fields preserve the source language verbatim.
 *
 * Persisted on Resume.semanticLabels. Drives:
 *  - Pre-filter at match time (deterministic, $0 cost)
 *  - Faceted search/filter (TalentHub)
 *  - Recommendation features (find similar candidates)
 */

export const SEMANTIC_TAG_SCHEMA_VERSION = 'v1' as const;
export type SemanticTagSchemaVersion = typeof SEMANTIC_TAG_SCHEMA_VERSION;

// ── Closed-set enums ────────────────────────────────────────────────

export const INDUSTRY_TAGS = [
  'ai-ml', 'fintech', 'ecommerce', 'saas', 'enterprise-saas',
  'gaming', 'healthcare', 'edtech', 'automotive', 'social',
  'security', 'blockchain-crypto', 'iot-hardware',
  'consulting', 'logistics', 'media', 'telecom',
  'government', 'other',
] as const;
export type IndustryTag = typeof INDUSTRY_TAGS[number];

export const JOB_CATEGORIES = [
  'engineering', 'ai-ml', 'product', 'design', 'data',
  'marketing', 'operations', 'sales', 'management', 'qa',
  'hr', 'finance', 'other',
] as const;
export type JobCategory = typeof JOB_CATEGORIES[number];

export const SENIORITY_LEVELS = [
  'intern', 'entry', 'junior', 'mid', 'senior',
  'staff-principal', 'lead-manager', 'director-vp', 'executive',
] as const;
export type Seniority = typeof SENIORITY_LEVELS[number];

export const TECH_STACK_PROFILES = [
  'frontend', 'backend', 'fullstack', 'mobile',
  'ml-engineer', 'data-engineer', 'data-scientist',
  'devops-sre', 'embedded', 'security', 'qa-automation',
  'non-technical',
] as const;
export type TechStackProfile = typeof TECH_STACK_PROFILES[number];

export const COMPANY_TIERS = [
  'faang', 'big-tech-us', 'big-tech-cn',
  'unicorn', 'scaleup', 'startup', 'sme',
  'government', 'state-owned-cn', 'academic',
  'big4', 'other',
] as const;
export type CompanyTier = typeof COMPANY_TIERS[number];

export const EDUCATION_TIERS = [
  'top-global', 'top-cn-c9', 'top-cn-985',
  'top-cn-211', 'shuangyiliu', 'top-regional',
  'standard', 'vocational', 'unknown',
] as const;
export type EducationTier = typeof EDUCATION_TIERS[number];

export const DEGREES = [
  'phd', 'masters', 'bachelors', 'associate',
  'vocational', 'high-school', 'unknown',
] as const;
export type Degree = typeof DEGREES[number];

export const PROFICIENCY_LEVELS = ['expert', 'proficient', 'familiar'] as const;
export type ProficiencyLevel = typeof PROFICIENCY_LEVELS[number];

export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native'] as const;
export type CefrLevel = typeof CEFR_LEVELS[number];

export const MOBILITY_SIGNALS = [
  'open-relocation', 'remote-friendly', 'location-fixed', 'unknown',
] as const;
export type MobilitySignal = typeof MOBILITY_SIGNALS[number];

export const CAREER_PATTERNS = [
  'ascending', 'lateral', 'declining', 'stable',
  'gap-recovery', 'early-career', 'unclear',
] as const;
export type CareerPattern = typeof CAREER_PATTERNS[number];

export const RISK_FLAG_KINDS = [
  'frequent-job-changes', 'gaps-unexplained', 'title-inflation',
  'sparse-resume', 'over-qualified-for-target', 'under-evidenced-claims',
] as const;
export type RiskFlagKind = typeof RISK_FLAG_KINDS[number];

export const RISK_SEVERITIES = ['low', 'medium', 'high'] as const;
export type RiskSeverity = typeof RISK_SEVERITIES[number];

/** Allowlist for evidenced soft skills. Any value outside this list is rejected by validator. */
export const SOFT_SKILL_ALLOWLIST = [
  'leadership', 'mentorship', 'cross-functional-collaboration',
  'communication', 'ownership', 'strategic-thinking',
  'problem-solving', 'stakeholder-management', 'conflict-resolution',
  'public-speaking', 'project-management', 'execution',
] as const;
export type SoftSkill = typeof SOFT_SKILL_ALLOWLIST[number];

// ── Composite signal types ───────────────────────────────────────────

export interface IndustrySignal {
  /** Closed-enum industry key. */
  tag: IndustryTag;
  /** 0..1 — agent's confidence the candidate has meaningful experience in the industry. */
  confidence: number;
}

export interface ProgrammingLanguageSkill {
  /** Canonical title-case (e.g. "Python", "C++", "Rust", "Go"). Free-form but normalized. */
  language: string;
  proficiency: ProficiencyLevel;
  /** Years inferred from earliest mention to most recent role using it. */
  yearsUsing?: number;
}

export interface CompanyTierSignal {
  tier: CompanyTier;
  /** 0..1 — confidence in tier classification. */
  confidence: number;
  /** Original company name as written in the resume (source language). */
  company: string;
  /** Whether the candidate is currently at this company. */
  current: boolean;
}

export interface EducationTierSignal {
  tier: EducationTier;
  /** Original institution name. */
  school: string;
  /** Closed degree enum. */
  degree: Degree;
  /** Original degree string preserved. */
  degreeRaw: string;
  /** True for the highest-degree entry (exactly one). */
  isHighest: boolean;
}

export interface SpokenLanguageSkill {
  /** Canonical English language name (e.g. "Chinese-Mandarin", "English", "Japanese"). */
  language: string;
  cefr: CefrLevel;
  /** Verbatim evidence string from the resume (e.g. "IELTS 7.5", "CET-6", "母语"). */
  evidence: string;
}

export interface GeographicMarkers {
  /** Distinct work locations across all experience, in source language. */
  workLocations: string[];
  /** Current/preferred location if discernible. */
  currentLocation?: string;
  mobilitySignal: MobilitySignal;
}

export interface CareerTrajectory {
  pattern: CareerPattern;
  /** Average tenure across full-time roles, in months. */
  tenureAvgMonths: number;
  /** Number of distinct full-time roles. */
  jobCount: number;
  /** Total unexplained gap, in months. 0 if no gaps. */
  gapMonths: number;
}

export interface AchievementSignals {
  publications: number;
  patents: number;
  /** OSS project names as written. */
  openSourceProjects: string[];
  /** Award names as written, source language. */
  awards: string[];
  /** Largest team size led/managed if mentioned. */
  teamSize?: number;
  /** Budget/scope description if mentioned, source language. */
  budgetScope?: string;
  speakingEngagements: number;
}

export interface RiskFlag {
  kind: RiskFlagKind;
  severity: RiskSeverity;
  /** One-line explanation, source language. */
  reason: string;
}

export interface YearsOfExperience {
  /** Full-time years + 0.3 × internship months / 12, rounded to 1 decimal. */
  total: number;
  /** Years inside the dominant jobCategory. */
  relevantToCategory: number;
}

// ── Top-level resume semantic labels ────────────────────────────────

/**
 * Rich semantic profile of a candidate, derived from ParsedResume + raw resume text.
 * Emitted by ResumeSemanticTagAgent. Persisted on Resume.semanticLabels.
 */
export interface ResumeSemanticLabels {
  /** Schema version. Bump when fields are added/removed. Drives lazy re-tagging. */
  schemaVersion: SemanticTagSchemaVersion;

  /** Industries the candidate has substantive experience in (max 5, confidence ≥ 0.6 to count). */
  industries: IndustrySignal[];

  /** Single dominant function. */
  jobCategory: JobCategory;

  /** Free-text sub-track within jobCategory, source language, ≤30 chars. */
  specialization: string;

  /** Closed-enum seniority — mirrors JD experienceLevel for prematch alignment. */
  seniority: Seniority;

  yearsOfExperience: YearsOfExperience;

  techStackProfile: TechStackProfile;

  programmingLanguages: ProgrammingLanguageSkill[];

  /** Top ~25 normalized frameworks/tools, title-case canonical. */
  frameworksAndTools: string[];

  /** Soft skills, only if evidenced by achievements. From SOFT_SKILL_ALLOWLIST. */
  softSkills: SoftSkill[];

  /** Per-company tier signals. */
  companyTiers: CompanyTierSignal[];

  /** Display names from curated NOTABLE_COMPANIES list. */
  notableCompanies: string[];

  /** Per-degree tier signals; isHighest=true on one entry. */
  educationTiers: EducationTierSignal[];

  highestDegree: Degree;

  spokenLanguages: SpokenLanguageSkill[];

  geographicMarkers: GeographicMarkers;

  /** Phase 4. Optional. */
  careerTrajectory?: CareerTrajectory;

  /** Phase 4. Optional. */
  achievementSignals?: AchievementSignals;

  /** Phase 4. Optional. Never used as hard filter — surfaced in commentary only. */
  riskFlags?: RiskFlag[];

  /** Top 15 free-text domain terms for keyword search; source language. */
  domainKeywords: string[];

  /** One-line pitch, ≤140 chars, source language. */
  positioningStatement: string;

  /** ISO timestamp of generation. */
  generatedAt: string;
}

// ── Allowed tag-set keys (non-exhaustive, for grep-ability) ──────────

// ── Phase 5 — Job-side semantic labels ───────────────────────────────

export interface SkillRequirement {
  /** Canonical title-case (e.g. "Python", "C++"). */
  language: string;
  /** Minimum acceptable proficiency. Defaults to 'familiar' when absent. */
  minProficiency?: ProficiencyLevel;
  /** True when this skill is a hard requirement (drives requiredTagSet).
   *  False when it's nice-to-have (drives preferredTagSet). */
  required: boolean;
}

export interface SpokenLanguageRequirement {
  /** Canonical English language name (matches resume side: "English", "Chinese-Mandarin"). */
  language: string;
  /** Minimum CEFR floor (or null when language is mentioned without a level). */
  minCefr: CefrLevel | null;
  required: boolean;
}

/**
 * Job-side semantic profile. Smaller than ResumeSemanticLabels — we only
 * need what's necessary to express "what does this job require?" cleanly.
 *
 * Closed-set fields use the same canonical English enums as the resume side
 * so set algebra (`candidateTagSet ⊇ job.requiredTagSet`) works directly.
 *
 * The `must` vs `prefer` separation is the key Phase 5 design call:
 *   - must  → contributes to `requiredTagSet` (hard exclusion)
 *   - prefer → contributes to `preferredTagSet` (soft ranking)
 *
 * Persisted on Job.semanticLabels.
 */
export interface JobSemanticLabels {
  schemaVersion: SemanticTagSchemaVersion;

  /** Dominant function for the role. */
  jobCategory: JobCategory;

  /** Required seniority (from JD experienceLevel). May be null if JD is vague. */
  requiredSeniority: Seniority | null;

  /** Inferred minimum years of experience for the role. Null when unclear. */
  minYearsExperience: number | null;

  /** Tech stack profile the role is for. Often correlates with jobCategory. */
  techStackProfile: TechStackProfile | null;

  /** Hard-required + nice-to-have programming languages. */
  hardSkills: SkillRequirement[];

  /** Frameworks/tools mentioned in the JD. Hard ones go to requiredTagSet. */
  hardTools: SkillRequirement[];

  /** Industries the role serves. Soft signal — never a hard requirement. */
  targetIndustries: IndustryTag[];

  /** Required minimum education tier (when JD specifies). */
  minEducationTier: EducationTier | null;
  /** Required minimum degree (e.g. bachelors+). Null when unspecified. */
  minDegree: Degree | null;

  /** Preferred company tiers — e.g. "Ex-FAANG candidates preferred".
   *  Always soft; never excludes. */
  preferredCompanyTiers: CompanyTier[];

  /** Spoken-language requirements. Hard or soft per the `required` field. */
  spokenLanguages: SpokenLanguageRequirement[];

  /** Locations the JD specifies. Empty array = remote-friendly / location-agnostic. */
  locations: string[];

  /** Mobility signals the JD accepts (e.g. ['open-relocation', 'remote-friendly']
   *  means the role is flexible). When empty, defaults to location-strict. */
  acceptableMobilitySignals: MobilitySignal[];

  /** ISO timestamp of generation. */
  generatedAt: string;
}

/**
 * Privacy-violating top-level keys that the validator strips even if the LLM
 * regresses. Any field name matching one of these (case-insensitive) is
 * silently dropped. Defense in depth — the type itself has no slot for them.
 */
export const PROHIBITED_KEYS = [
  'age', 'gender', 'sex', 'race', 'ethnicity', 'religion',
  'maritalstatus', 'marital_status', 'marital',
  'familystatus', 'family_status',
  'sexualorientation', 'sexual_orientation',
  'disability', 'health',
  'politicalaffiliation', 'political_affiliation',
  'nationality', 'birthplace', 'hometown',
  // CJK variants (lowercased after stripping non-letter chars by validator)
  '性别', '年龄', '婚否', '婚姻', '种族', '宗教', '国籍', '户籍',
] as const;
