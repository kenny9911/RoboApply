// backend/src/roboapply/v2/lib/raOnboardingDraft.ts
//
// Deterministic preference-draft machinery for the onboarding chat:
//
//   - enum normalization tables (PRD §7 taxonomy) the PrefExtract agent's
//     parseOutput runs every extracted value through (unknown values DROP);
//   - deep-merge of extractor updates into the per-session draft
//     (arrays union-with-cap; an explicit empty array clears; declined
//     topics never write);
//   - locale → market country/currency defaults (JSearch market + inferred
//     salary currency);
//   - the cross-source job dedup fingerprint;
//   - draft → RACareerGoal / RAPreferences-blob persistence mappers.
//
// The mappers are SPARSE by contract: only keys the conversation actually
// captured appear in the output, because RAPreferencesService PATCH semantics
// replace arrays/scalars wholesale — sending an unset key would wipe a stored
// preference. Two shape conversions matter (the live blob is the source of
// truth, see RAPreferencesService.ts):
//   - draft.workModes[] / draft.companyStages[] → the blob's boolean-record
//     shapes ({remote,hybrid,onsite} / Record<stageId, boolean>). Both keys
//     deep-merge in the service, so partial records keep their siblings.
//   - draft.targetRoles → the EXISTING `roleTitles` blob key (what the
//     /preferences page reads). `targetRoles` is only the internal draft name.

import { createHash } from 'crypto';
import type {
  OnboardingDraftPreferences,
  OnboardingEmploymentType,
  OnboardingSeniority,
  OnboardingTopic,
  OnboardingWorkMode,
} from '../types/onboarding.js';
import type { RaLocale } from './raLocale.js';
import { getMessages } from './raOnboardingMessages.js';
import {
  RA_PREFERENCE_OPTIONS,
  type RAPreferencesUpdateInput,
} from '../services/RAPreferencesService.js';

// ─── Enum normalization tables (PRD §7 taxonomy) ───────────────────────
//
// Lookup is lowercase + trimmed; CJK synonyms cover the zh / zh-TW / ja
// registers the extractor sees. Unknown values return null and are dropped.

function lookupKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return key || null;
}

const WORK_MODE_TABLE: Record<string, OnboardingWorkMode> = {
  remote: 'remote',
  'fully remote': 'remote',
  'remote only': 'remote',
  'remote-first': 'remote',
  wfh: 'remote',
  'work from home': 'remote',
  远程: 'remote',
  遠端: 'remote',
  遠距: 'remote',
  リモート: 'remote',
  在宅: 'remote',
  hybrid: 'hybrid',
  混合: 'hybrid',
  混合办公: 'hybrid',
  混合辦公: 'hybrid',
  ハイブリッド: 'hybrid',
  onsite: 'onsite',
  'on-site': 'onsite',
  'on site': 'onsite',
  'in office': 'onsite',
  'in-office': 'onsite',
  office: 'onsite',
  到岗: 'onsite',
  到班: 'onsite',
  駐點: 'onsite',
  出社: 'onsite',
};

export function normalizeWorkMode(value: unknown): OnboardingWorkMode | null {
  const key = lookupKey(value);
  if (!key) return null;
  if (WORK_MODE_TABLE[key]) return WORK_MODE_TABLE[key];
  // Heuristic containment for phrases like "fully remote please".
  if (key.includes('remote') || key.includes('遠端') || key.includes('远程')) return 'remote';
  if (key.includes('hybrid') || key.includes('混合')) return 'hybrid';
  if (key.includes('onsite') || key.includes('on-site') || key.includes('office')) return 'onsite';
  return null;
}

const EMPLOYMENT_TYPE_TABLE: Record<string, OnboardingEmploymentType> = {
  full_time: 'full_time',
  'full-time': 'full_time',
  fulltime: 'full_time',
  'full time': 'full_time',
  fte: 'full_time',
  permanent: 'full_time',
  全职: 'full_time',
  全職: 'full_time',
  正职: 'full_time',
  正職: 'full_time',
  正社員: 'full_time',
  contract: 'contract',
  contractor: 'contract',
  contracting: 'contract',
  freelance: 'contract',
  合同: 'contract',
  合同制: 'contract',
  合約: 'contract',
  約聘: 'contract',
  约聘: 'contract',
  契約: 'contract',
  業務委託: 'contract',
  part_time: 'part_time',
  'part-time': 'part_time',
  parttime: 'part_time',
  'part time': 'part_time',
  兼职: 'part_time',
  兼職: 'part_time',
  パート: 'part_time',
  パートタイム: 'part_time',
  アルバイト: 'part_time',
  internship: 'internship',
  intern: 'internship',
  实习: 'internship',
  實習: 'internship',
  インターン: 'internship',
};

export function normalizeEmploymentType(
  value: unknown,
): OnboardingEmploymentType | null {
  const key = lookupKey(value);
  if (!key) return null;
  return EMPLOYMENT_TYPE_TABLE[key] ?? null;
}

const SENIORITY_TABLE: Record<string, OnboardingSeniority> = {
  ic: 'ic',
  junior: 'ic',
  mid: 'ic',
  'mid-level': 'ic',
  entry: 'ic',
  'entry-level': 'ic',
  'individual contributor': 'ic',
  初级: 'ic',
  初級: 'ic',
  中级: 'ic',
  中級: 'ic',
  ジュニア: 'ic',
  senior: 'senior',
  sr: 'senior',
  'sr.': 'senior',
  资深: 'senior',
  資深: 'senior',
  高级: 'senior',
  高級: 'senior',
  シニア: 'senior',
  staff: 'staff',
  principal: 'principal',
  manager: 'manager',
  'engineering manager': 'manager',
  em: 'manager',
  lead: 'manager',
  'team lead': 'manager',
  经理: 'manager',
  經理: 'manager',
  マネージャー: 'manager',
  director: 'director',
  总监: 'director',
  總監: 'director',
  ディレクター: 'director',
  vp: 'vp',
  'vice president': 'vp',
  副总裁: 'vp',
  副總裁: 'vp',
  cxo: 'cxo',
  cto: 'cxo',
  ceo: 'cxo',
  coo: 'cxo',
  cfo: 'cxo',
  cpo: 'cxo',
  executive: 'cxo',
  高管: 'cxo',
};

export function normalizeSeniority(value: unknown): OnboardingSeniority | null {
  const key = lookupKey(value);
  if (!key) return null;
  return SENIORITY_TABLE[key] ?? null;
}

/** Fuzzy synonym → canonical RA_PREFERENCE_OPTIONS industry (19-item list). */
const INDUSTRY_SYNONYMS: Record<string, string> = {
  fintech: 'Fintech',
  finance: 'Fintech',
  financial: 'Fintech',
  payments: 'Fintech',
  banking: 'Fintech',
  金融: 'Fintech',
  金融科技: 'Fintech',
  healthtech: 'Healthtech',
  health: 'Healthtech',
  healthcare: 'Healthtech',
  medical: 'Healthtech',
  医疗: 'Healthtech',
  醫療: 'Healthtech',
  ヘルスケア: 'Healthtech',
  climate: 'Climate',
  cleantech: 'Climate',
  气候: 'Climate',
  氣候: 'Climate',
  edtech: 'Edtech',
  education: 'Edtech',
  教育: 'Edtech',
  devtools: 'Developer tools',
  'dev tools': 'Developer tools',
  'developer tools': 'Developer tools',
  'developer tooling': 'Developer tools',
  ai: 'AI / ML',
  ml: 'AI / ML',
  'ai/ml': 'AI / ML',
  'ai / ml': 'AI / ML',
  'machine learning': 'AI / ML',
  'artificial intelligence': 'AI / ML',
  genai: 'AI / ML',
  llm: 'AI / ML',
  人工智能: 'AI / ML',
  人工智慧: 'AI / ML',
  機器學習: 'AI / ML',
  机器学习: 'AI / ML',
  saas: 'B2B SaaS',
  b2b: 'B2B SaaS',
  'b2b saas': 'B2B SaaS',
  'enterprise software': 'B2B SaaS',
  consumer: 'Consumer',
  b2c: 'Consumer',
  ecommerce: 'E-commerce',
  'e-commerce': 'E-commerce',
  电商: 'E-commerce',
  電商: 'E-commerce',
  marketplace: 'Marketplaces',
  marketplaces: 'Marketplaces',
  logistics: 'Logistics',
  'supply chain': 'Logistics',
  物流: 'Logistics',
  manufacturing: 'Manufacturing',
  制造: 'Manufacturing',
  製造: 'Manufacturing',
  cybersecurity: 'Cybersecurity',
  security: 'Cybersecurity',
  infosec: 'Cybersecurity',
  资安: 'Cybersecurity',
  資安: 'Cybersecurity',
  网络安全: 'Cybersecurity',
  media: 'Media',
  entertainment: 'Media',
  媒体: 'Media',
  媒體: 'Media',
  gaming: 'Gaming',
  games: 'Gaming',
  游戏: 'Gaming',
  遊戲: 'Gaming',
  ゲーム: 'Gaming',
  hardware: 'Hardware',
  硬件: 'Hardware',
  硬體: 'Hardware',
  bio: 'Bio / Pharma',
  pharma: 'Bio / Pharma',
  biotech: 'Bio / Pharma',
  biopharma: 'Bio / Pharma',
  'bio / pharma': 'Bio / Pharma',
  生技: 'Bio / Pharma',
  制药: 'Bio / Pharma',
  製藥: 'Bio / Pharma',
  'real estate': 'Real estate',
  proptech: 'Real estate',
  房地产: 'Real estate',
  房地產: 'Real estate',
  不動產: 'Real estate',
  legaltech: 'Legal-tech',
  'legal-tech': 'Legal-tech',
  'legal tech': 'Legal-tech',
  legal: 'Legal-tech',
};

const CANONICAL_INDUSTRIES = new Map<string, string>(
  RA_PREFERENCE_OPTIONS.industries.map((i) => [i.toLowerCase(), i]),
);

export function normalizeIndustry(value: unknown): string | null {
  const key = lookupKey(value);
  if (!key) return null;
  return CANONICAL_INDUSTRIES.get(key) ?? INDUSTRY_SYNONYMS[key] ?? null;
}

/** Canonical company-stage ids (RA_PREFERENCE_OPTIONS.companyStages[].id). */
const COMPANY_STAGE_TABLE: Record<string, string> = {
  seed: 'seed',
  'pre-seed': 'seed',
  preseed: 'seed',
  early: 'seed',
  'early-stage': 'seed',
  'early stage': 'seed',
  种子轮: 'seed',
  種子輪: 'seed',
  seriesa: 'seriesA',
  'series a': 'seriesA',
  'series-a': 'seriesA',
  a轮: 'seriesA',
  a輪: 'seriesA',
  seriesb: 'seriesB',
  'series b': 'seriesB',
  'series-b': 'seriesB',
  b轮: 'seriesB',
  b輪: 'seriesB',
  seriesc: 'seriesC',
  'series c': 'seriesC',
  'series-c': 'seriesC',
  c轮: 'seriesC',
  c輪: 'seriesC',
  late: 'late',
  'late-stage': 'late',
  'late stage': 'late',
  'pre-ipo': 'late',
  growth: 'late',
  unicorn: 'late',
  public: 'public',
  listed: 'public',
  'post-ipo': 'public',
  上市: 'public',
};

export function normalizeCompanyStage(value: unknown): string | null {
  const key = lookupKey(value);
  if (!key) return null;
  return COMPANY_STAGE_TABLE[key] ?? null;
}

/** Canonical size buckets (RA_PREFERENCE_OPTIONS.companySizes). Tolerates
 *  plain-hyphen variants; anything else drops. */
const COMPANY_SIZE_BUCKETS = new Map<string, string>(
  RA_PREFERENCE_OPTIONS.companySizes.flatMap((bucket) => [
    [bucket.toLowerCase(), bucket],
    [bucket.replace(/–/g, '-').toLowerCase(), bucket],
  ] as Array<[string, string]>),
);

export function normalizeCompanySize(value: unknown): string | null {
  const key = lookupKey(value);
  if (!key) return null;
  return COMPANY_SIZE_BUCKETS.get(key) ?? null;
}

function normalizeSalaryPeriod(value: unknown): 'year' | 'month' | 'hour' | null {
  const key = lookupKey(value);
  if (!key) return null;
  if (['year', 'yearly', 'annual', 'annually', '年', '年薪', '年収'].includes(key)) return 'year';
  if (['month', 'monthly', '月', '月薪', '月給'].includes(key)) return 'month';
  if (['hour', 'hourly', '时薪', '時薪', '時給'].includes(key)) return 'hour';
  return null;
}

// ─── Update normalization + draft merge ────────────────────────────────

const MAX_TARGET_ROLES = 5;
const MAX_LIST_ITEMS = 10;
const MAX_FREE_TEXT_LEN = 80;

function cleanFreeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim().slice(0, MAX_FREE_TEXT_LEN);
  return s || null;
}

function normalizeStringList(
  value: unknown,
  normalizer: (v: unknown) => string | null,
  cap: number,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const v of value) {
    const norm = normalizer(v);
    if (norm && !out.includes(norm)) out.push(norm);
    if (out.length >= cap) break;
  }
  return out; // [] is meaningful — an explicit clear
}

function normalizeCountry(value: unknown): string | null {
  const s = cleanFreeText(value);
  if (!s) return null;
  return s.length === 2 ? s.toUpperCase() : s;
}

/**
 * Coerce a raw extractor `updates` object into a clean
 * OnboardingDraftPreferences: every enum runs through its taxonomy table
 * (unknown → dropped), free text is trimmed/clipped, lists deduped + capped.
 * Used by RAOnboardingPrefExtractAgent.parseOutput and defensively re-applied
 * by mergeDraft. Never throws.
 */
export function normalizeDraftUpdates(raw: unknown): OnboardingDraftPreferences {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const u = raw as Record<string, unknown>;
  const out: OnboardingDraftPreferences = {};

  const targetRoles = normalizeStringList(u.targetRoles, cleanFreeText, MAX_TARGET_ROLES);
  if (targetRoles !== undefined) out.targetRoles = targetRoles;

  if (u.seniority !== undefined) {
    const seniority = normalizeSeniority(u.seniority);
    if (seniority) out.seniority = seniority;
  }

  const workModes = normalizeStringList(u.workModes, normalizeWorkMode, 3);
  if (workModes !== undefined) out.workModes = workModes as OnboardingWorkMode[];

  const employmentTypes = normalizeStringList(u.employmentTypes, normalizeEmploymentType, 4);
  if (employmentTypes !== undefined) {
    out.employmentTypes = employmentTypes as OnboardingEmploymentType[];
  }

  const industriesTarget = normalizeStringList(u.industriesTarget, normalizeIndustry, MAX_LIST_ITEMS);
  if (industriesTarget !== undefined) out.industriesTarget = industriesTarget;
  const industriesAvoid = normalizeStringList(u.industriesAvoid, normalizeIndustry, MAX_LIST_ITEMS);
  if (industriesAvoid !== undefined) out.industriesAvoid = industriesAvoid;

  const companyStages = normalizeStringList(u.companyStages, normalizeCompanyStage, 6);
  if (companyStages !== undefined) out.companyStages = companyStages;
  const companySizes = normalizeStringList(u.companySizes, normalizeCompanySize, 6);
  if (companySizes !== undefined) out.companySizes = companySizes;

  const mustHaves = normalizeStringList(u.mustHaves, cleanFreeText, MAX_LIST_ITEMS);
  if (mustHaves !== undefined) out.mustHaves = mustHaves;
  const dealbreakers = normalizeStringList(u.dealbreakers, cleanFreeText, MAX_LIST_ITEMS);
  if (dealbreakers !== undefined) out.dealbreakers = dealbreakers;

  if (typeof u.salary === 'object' && u.salary !== null && !Array.isArray(u.salary)) {
    const s = u.salary as Record<string, unknown>;
    const salary: OnboardingDraftPreferences['salary'] = {};
    if (typeof s.min === 'number' && Number.isFinite(s.min) && s.min >= 0) {
      salary.min = Math.round(s.min);
    }
    if (typeof s.max === 'number' && Number.isFinite(s.max) && s.max >= 0) {
      salary.max = Math.round(s.max);
    }
    if (typeof s.currency === 'string' && /^[A-Za-z]{3}$/.test(s.currency.trim())) {
      salary.currency = s.currency.trim().toUpperCase();
    }
    const period = normalizeSalaryPeriod(s.period);
    if (period) salary.period = period;
    if (Object.keys(salary).length > 0) out.salary = salary;
  }

  if (typeof u.locations === 'object' && u.locations !== null && !Array.isArray(u.locations)) {
    const l = u.locations as Record<string, unknown>;
    const locations: OnboardingDraftPreferences['locations'] = {};
    const countries = normalizeStringList(l.countries, normalizeCountry, 5);
    if (countries !== undefined) locations.countries = countries;
    const cities = normalizeStringList(l.cities, cleanFreeText, 5);
    if (cities !== undefined) locations.cities = cities;
    if (typeof l.remoteOk === 'boolean') locations.remoteOk = l.remoteOk;
    if (Object.keys(locations).length > 0) out.locations = locations;
  }

  return out;
}

/** Field → elicitation topic, for declined-topic suppression. Fields without
 *  a topic mapping (targetRoles, mustHaves, …) are never suppressed. */
const FIELD_TOPIC: Partial<Record<keyof OnboardingDraftPreferences, OnboardingTopic>> = {
  salary: 'salary',
  workModes: 'workMode',
  industriesTarget: 'industry',
  industriesAvoid: 'industry',
  employmentTypes: 'employmentType',
  locations: 'location',
  seniority: 'seniority',
};

function unionWithCap(current: string[] | undefined, incoming: string[], cap: number): string[] {
  const out = [...(current ?? [])];
  for (const v of incoming) {
    if (!out.includes(v)) out.push(v);
  }
  return out.slice(0, cap);
}

/**
 * Merge one turn's (already-normalized) extractor updates into the session
 * draft. Semantics:
 *   - array fields UNION with the existing draft, capped — "也接受 X" /
 *     "contract is fine too" ADDS to what's already acceptable instead of
 *     replacing it (this is where the additive employmentTypes rule lives);
 *   - an explicit EMPTY array is a "clear X" intent and replaces with [];
 *   - `salary` / `locations` shallow-merge their defined sub-fields;
 *   - scalars replace;
 *   - fields whose topic is in `declinedTopics` are never written.
 * Returns a new object; never mutates inputs; never throws.
 */
export function mergeDraft(
  current: OnboardingDraftPreferences,
  updates: OnboardingDraftPreferences,
  declinedTopics: OnboardingTopic[] = [],
): OnboardingDraftPreferences {
  const clean = normalizeDraftUpdates(updates);
  const declined = new Set(declinedTopics);
  const next: OnboardingDraftPreferences = {
    ...current,
    salary: current.salary ? { ...current.salary } : undefined,
    locations: current.locations ? { ...current.locations } : undefined,
  };
  if (next.salary === undefined) delete next.salary;
  if (next.locations === undefined) delete next.locations;

  const skip = (field: keyof OnboardingDraftPreferences): boolean => {
    const topic = FIELD_TOPIC[field];
    return topic !== undefined && declined.has(topic);
  };

  const mergeList = (
    field: 'targetRoles' | 'workModes' | 'employmentTypes' | 'industriesTarget'
      | 'industriesAvoid' | 'companyStages' | 'companySizes' | 'mustHaves' | 'dealbreakers',
    cap: number,
  ): void => {
    const incoming = clean[field] as string[] | undefined;
    if (incoming === undefined || skip(field)) return;
    (next as Record<string, unknown>)[field] =
      incoming.length === 0
        ? [] // explicit clear
        : unionWithCap(current[field] as string[] | undefined, incoming, cap);
  };

  mergeList('targetRoles', MAX_TARGET_ROLES);
  mergeList('workModes', 3);
  mergeList('employmentTypes', 4);
  mergeList('industriesTarget', MAX_LIST_ITEMS);
  mergeList('industriesAvoid', MAX_LIST_ITEMS);
  mergeList('companyStages', 6);
  mergeList('companySizes', 6);
  mergeList('mustHaves', MAX_LIST_ITEMS);
  mergeList('dealbreakers', MAX_LIST_ITEMS);

  if (clean.seniority !== undefined && !skip('seniority')) {
    next.seniority = clean.seniority;
  }

  if (clean.salary !== undefined && !skip('salary')) {
    next.salary = { ...current.salary, ...clean.salary };
  }

  if (clean.locations !== undefined && !skip('locations')) {
    const cur = current.locations ?? {};
    const inc = clean.locations;
    next.locations = {
      ...cur,
      ...(inc.countries !== undefined
        ? { countries: inc.countries.length === 0 ? [] : unionWithCap(cur.countries, inc.countries, 5) }
        : {}),
      ...(inc.cities !== undefined
        ? { cities: inc.cities.length === 0 ? [] : unionWithCap(cur.cities, inc.cities, 5) }
        : {}),
      ...(inc.remoteOk !== undefined ? { remoteOk: inc.remoteOk } : {}),
    };
  }

  return next;
}

// ─── Locale → market defaults ──────────────────────────────────────────

export interface OnboardingMarketDefaults {
  /** ISO-3166 alpha-2, lowercase — the JSearch (Google for Jobs) market. */
  country: string;
  /** ISO-4217 — the inferred salary currency (always confirmable in chat). */
  currency: string;
}

const MARKET_DEFAULTS: Partial<Record<RaLocale, OnboardingMarketDefaults>> = {
  en: { country: 'us', currency: 'USD' },
  zh: { country: 'cn', currency: 'CNY' },
  'zh-TW': { country: 'tw', currency: 'TWD' },
  ja: { country: 'jp', currency: 'JPY' },
  // es / fr / pt / de intentionally absent → en market, mirroring the
  // catalog's English fallback for those locales.
};

export function marketDefaultsForLocale(locale: RaLocale): OnboardingMarketDefaults {
  return MARKET_DEFAULTS[locale] ?? MARKET_DEFAULTS.en!;
}

// ─── Dedup fingerprint ─────────────────────────────────────────────────

export interface FingerprintInput {
  title: string;
  companyName: string;
  locationCity?: string | null;
  /** Free-form location string, e.g. "台北市, 台灣" — first comma token is
   *  used when locationCity is null (JSearch TW rows: city null 10/10). */
  location?: string | null;
  isRemote?: boolean;
}

/**
 * Cross-source dedup fingerprint:
 *   sha256(lower(title) | lower(company) | citySlot)
 * citySlot = locationCity ?? firstTokenOf(location) ?? (isRemote ? 'remote'
 * : 'unknown') — so a TW external row with a null city but "台北市, 台灣"
 * location still collides with its internal twin stored as locationCity.
 */
export function jobFingerprint(input: FingerprintInput): string {
  const city =
    input.locationCity?.trim() ||
    input.location?.split(',')[0]?.trim() ||
    (input.isRemote ? 'remote' : 'unknown');
  const raw = [
    input.title.trim().toLowerCase(),
    input.companyName.trim().toLowerCase(),
    city.toLowerCase(),
  ].join('|');
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

// ─── Draft → persistence mappers ───────────────────────────────────────

export interface DraftGoalInput {
  targetTitle: string;
  targetSalaryMin?: number;
  targetSalaryMax?: number;
  targetSalaryCurrency?: string;
  seniority?: OnboardingSeniority;
  preferredLocations?: {
    countries: string[];
    cities: string[];
    remoteOk: boolean;
    hybridOk: boolean;
  };
  preferredWorkType?: OnboardingWorkMode;
}

/**
 * Draft → RACareerGoal upsert fields. Sparse: keys are present only when the
 * conversation captured them (RACareerGoalService.upsert keeps previous
 * values for unset fields — returning-user deep-merge for free). The title
 * falls back to the localized catalog `defaultTargetTitle` — never a
 * hardcoded literal, never a client-side string split.
 */
export function draftToGoalInput(
  draft: OnboardingDraftPreferences,
  locale: RaLocale,
): DraftGoalInput {
  const out: DraftGoalInput = {
    targetTitle: draft.targetRoles?.[0] ?? getMessages(locale).defaultTargetTitle,
  };

  if (draft.salary?.min != null || draft.salary?.max != null) {
    if (draft.salary.min != null) out.targetSalaryMin = draft.salary.min;
    if (draft.salary.max != null) out.targetSalaryMax = draft.salary.max;
    // Stated currency wins; otherwise the locale market default (which the
    // chat confirmed before relying on it).
    out.targetSalaryCurrency =
      draft.salary.currency ?? marketDefaultsForLocale(locale).currency;
  }

  if (draft.seniority) out.seniority = draft.seniority;

  if (draft.locations !== undefined || draft.workModes !== undefined) {
    const modes = draft.workModes ?? [];
    out.preferredLocations = {
      countries: draft.locations?.countries ?? [],
      cities: draft.locations?.cities ?? [],
      remoteOk: draft.locations?.remoteOk ?? modes.includes('remote'),
      hybridOk: modes.includes('hybrid'),
    };
  }

  if (draft.workModes && draft.workModes.length > 0) {
    out.preferredWorkType = draft.workModes[0];
  }

  return out;
}

/**
 * Draft → sparse RAPreferences-blob PATCH. Only conversation-captured keys
 * (defined on the draft) appear — the service's replace-wholesale array
 * semantics make sending unset keys destructive. Shape conversions:
 *   - workModes[] → FULL boolean record (a stated set of acceptable modes is
 *     a closed choice over exactly three keys);
 *   - companyStages[] → partial true-only record (deep-merged in the service,
 *     so unstated stages keep their stored values);
 *   - targetRoles → the existing `roleTitles` key;
 *   - salary.min/max (absolute) → salaryMinK/MaxK (blob's K units).
 * Session-level keys (intentMarkdown, defaultResumeId, aggressiveness,
 * dailyCap, huntActive, onboarding) are the orchestrator's to add on top.
 */
export function draftToPreferencesPatch(
  draft: OnboardingDraftPreferences,
): RAPreferencesUpdateInput {
  const patch: RAPreferencesUpdateInput = {};

  if (draft.targetRoles !== undefined) patch.roleTitles = draft.targetRoles;

  if (draft.workModes !== undefined) {
    patch.workModes = {
      remote: draft.workModes.includes('remote'),
      hybrid: draft.workModes.includes('hybrid'),
      onsite: draft.workModes.includes('onsite'),
    };
  }

  if (draft.companyStages !== undefined) {
    const stages: Record<string, boolean> = {};
    for (const id of draft.companyStages) stages[id] = true;
    patch.companyStages = stages;
  }

  if (draft.employmentTypes !== undefined) {
    patch.employmentTypes = draft.employmentTypes;
  }

  if (draft.locations?.cities !== undefined) {
    patch.cities = draft.locations.cities;
  }

  if (draft.salary?.min != null) patch.salaryMinK = Math.round(draft.salary.min / 1000);
  if (draft.salary?.max != null) patch.salaryMaxK = Math.round(draft.salary.max / 1000);
  if (draft.salary?.period != null) patch.salaryPeriod = draft.salary.period;

  if (draft.industriesTarget !== undefined) patch.industriesTarget = draft.industriesTarget;
  if (draft.industriesAvoid !== undefined) patch.industriesAvoid = draft.industriesAvoid;
  if (draft.companySizes !== undefined) patch.companySizes = draft.companySizes;
  if (draft.mustHaves !== undefined) patch.mustHaves = draft.mustHaves;
  if (draft.dealbreakers !== undefined) patch.dealbreakers = draft.dealbreakers;

  return patch;
}
