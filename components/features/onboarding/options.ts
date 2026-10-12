// components/features/onboarding/options.ts — option lists of the onboarding screens (WP-30).
//
// Web copies of the server contract's enumerations
// (server/src/features/onboarding/contract.ts); the web bundle never imports
// server runtime code. options.test.ts keeps each list equal to its source.

export const TIMINGS = ['asap', 'next_few_months', 'just_looking'] as const;
export const SEEKER_TYPES = ['student', 'recent_graduate', 'experienced', 'career_change'] as const;
export const JOB_TYPES = ['full_time', 'part_time', 'contract', 'internship'] as const;
export const SPONSORSHIP_ANSWERS = ['yes', 'no', 'not_sure'] as const;
export const MVP_COUNTRIES = ['US', 'CA', 'GB', 'IE', 'AU', 'NZ', 'SG', 'HK', 'TW', 'JP', 'KR', 'DE', 'FR', 'ES', 'PT', 'NL', 'REMOTE'] as const;
export const GOAL_GROUPS = [
  { id: 'move_up', options: ['more_senior', 'management', 'higher_pay'] },
  { id: 'change', options: ['new_industry', 'different_role', 'learn_skills'] },
  { id: 'day_to_day', options: ['work_life_balance', 'job_security', 'flexibility'] },
] as const;
export const CAREER_GOALS = GOAL_GROUPS.flatMap((g) => g.options);
export const INDUSTRIES = [
  { id: 'Healthtech', slug: 'healthtech' },
  { id: 'Climate', slug: 'climate' },
  { id: 'Fintech', slug: 'fintech' },
  { id: 'Edtech', slug: 'edtech' },
  { id: 'Developer tools', slug: 'developer_tools' },
  { id: 'AI / ML', slug: 'ai_ml' },
  { id: 'B2B SaaS', slug: 'b2b_saas' },
  { id: 'Consumer', slug: 'consumer' },
  { id: 'E-commerce', slug: 'ecommerce' },
  { id: 'Marketplaces', slug: 'marketplaces' },
  { id: 'Logistics', slug: 'logistics' },
  { id: 'Manufacturing', slug: 'manufacturing' },
  { id: 'Cybersecurity', slug: 'cybersecurity' },
  { id: 'Media', slug: 'media' },
  { id: 'Gaming', slug: 'gaming' },
  { id: 'Hardware', slug: 'hardware' },
  { id: 'Bio / Pharma', slug: 'bio_pharma' },
  { id: 'Real estate', slug: 'real_estate' },
  { id: 'Legal-tech', slug: 'legal_tech' },
] as const;
export const COMPANY_SIZES = ['1-50', '51-200', '201-1000', '1001-10000', '10000+', 'any'] as const;
export const WORK_MODELS = ['remote', 'hybrid', 'onsite'] as const;
export const PAY_PERIODS = ['year', 'month', 'hour'] as const;
export const EXPERIENCE_LEVELS = ['internship', 'entry', 'mid', 'senior', 'lead_staff', 'director_plus'] as const;
export const ALERT_FREQUENCIES = ['daily', 'weekly', 'off'] as const;
export const HEARD_FROM = ['search_engine', 'linkedin', 'instagram', 'tiktok', 'youtube', 'reddit', 'friend', 'ai_assistant', 'school', 'other'] as const;
export const MATCH_PHASES = ['reading', 'saving', 'searching', 'comparing', 'ranking'] as const;

/** Currency that follows a country (O4 "follows the first selected country"). */
export const COUNTRY_CURRENCY: Readonly<Record<string, string>> = {
  US: 'USD',
  CA: 'CAD',
  GB: 'GBP',
  IE: 'EUR',
  AU: 'AUD',
  NZ: 'NZD',
  SG: 'SGD',
  HK: 'HKD',
  TW: 'TWD',
  JP: 'JPY',
  KR: 'KRW',
  DE: 'EUR',
  FR: 'EUR',
  ES: 'EUR',
  PT: 'EUR',
  NL: 'EUR',
};
export const CURRENCIES = ['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'NZD', 'SGD', 'HKD', 'TWD', 'JPY', 'KRW'] as const;

/** Limits (PRODUCT §4.3). */
export const LIMITS = {
  titles: 3,
  cities: 5,
  industries: 5,
  skills: 15,
  extraTitles: 3,
  pasteMinChars: 200,
  resumeMaxBytes: 15 * 1024 * 1024,
} as const;

export const RESUME_EXTENSIONS = ['.pdf', '.doc', '.docx', '.txt'] as const;
export const RESUME_ACCEPT = '.pdf,.doc,.docx,.txt,application/pdf';

/** The LinkedIn profile URL rule (same as the contract's ConfirmStepSchema). */
export const LINKEDIN_URL_RE = /^https:\/\/(www\.)?linkedin\.com\/in\/[^\s/]+\/?$/;

/** UI-state keys (contract ONBOARDING_UI_KEYS). */
export const UI_KEYS = {
  tour: 'jobs.firstVisit',
  finishBanner: 'onboarding.finishBanner',
  scoreTip: 'onboarding.scoreTip',
  resumeCheckBanner: 'onboarding.resumeCheckBanner',
  skillsCheck: 'onboarding.skillsCheck',
} as const;
export const FINISH_BANNER_MAX_DISMISSALS = 2;
