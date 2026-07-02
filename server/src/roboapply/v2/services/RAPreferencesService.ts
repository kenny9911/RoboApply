// backend/src/roboapply/v2/services/RAPreferencesService.ts
//
// RoboApply V3 extended-preferences store. Holds the rich RAPreferences blob
// (industries / stages / dealbreakers / notifications / privacy / agent rules)
// that `goal` / the auth profile do NOT own. Persisted as a `jsonb`
// `preferencesBlob` column on `RACareerGoal` (1:1 per user — the row already
// exists for the goal surface; we reuse it rather than spinning up a second
// table).
//
// Contract: must round-trip against `RAPreferences` / `RAPreferenceOptions`
// from `roboapply/lib/api/v2/types.ts`. The get/update/merge semantics mirror
// the executable spec in `roboapply/lib/stub/raV2.stub.ts`:
//   - get  -> { preferences, options }  (options are static)
//   - update -> deep-merges nested record objects (links / channels / notif /
//     companyStages / workModes); arrays + scalars replace; bumps updatedAt.
//   - first-time users get the defaults below (no row / null blob).
//
// The prefs-vs-goal split (per the fixture header + 02-stub-contract.md §5):
//   - goal owns: targetTitle, salary band, work type, seniority, preferred
//     locations. The frontend already mirrors those to `goal.upsert`.
//   - this blob owns: everything else in RAPreferences (identity extras, hunt
//     intent/role-titles/work-modes/cities/salaryK band/stages/sizes/
//     industries/must-haves/dealbreakers/workAuth, agent behavior,
//     notifications, privacy, dataRetention, plan, defaultResumeId).
// The `salaryMinK/MaxK`, `workModes`, and `cities` fields DO live in this blob
// (they are the proto's richer hunt knobs, distinct from goal's canonical
// targetSalaryMin/Max + preferredWorkType + preferredLocations); the stub keeps
// them here too, so we preserve that to keep the wire shape identical.

import prisma from '../../../lib/prisma.js';
import { logger } from '../../../services/LoggerService.js';

// ─────────────────────────────────────────────────────────────────────
// Wire types — kept structurally identical to roboapply/lib/api/v2/types.ts.
// (V2 backend cannot import the frontend types module; we mirror it here.)
// ─────────────────────────────────────────────────────────────────────

export type RAAggressiveness = 'manual' | 'balanced' | 'aggressive';

/**
 * Onboarding-chat provenance stamp. Written WHOLESALE (the key is not in
 * DEEP_MERGE_PREF_KEYS, so a PATCH replaces the whole object — completion /
 * skip write it atomically). Absent (undefined) until the user finishes or
 * skips the chat onboarding; `GET /auth/me` keys its onboardingState
 * derivation off `completedAt`.
 */
export interface RAPreferencesOnboarding {
  completedAt?: string;
  skippedAt?: string;
  /** e.g. 'v4-chat'. */
  version?: string;
  completedSteps?: string[];
  /** The RAOnboardingSession that produced this stamp. */
  sessionId?: string;
}

export interface RAPreferences {
  // Identity extras (name/email live on the auth profile)
  phone: string | null;
  location: string | null;
  pronouns: string | null;
  yearsExp: number;
  defaultResumeId: string | null;
  links: { linkedin: string; github: string; portfolio: string; x: string };

  // Hunt (the parts goal doesn't own)
  huntActive: boolean;
  intentMarkdown: string;
  roleTitles: string[];
  workModes: { remote: boolean; hybrid: boolean; onsite: boolean };
  cities: string[];
  salaryMinK: number;
  salaryMaxK: number;
  /** 'year' | 'month' | 'hour' — the unit salaryMinK/MaxK are quoted in
   *  (zh-TW 月薪 norm). Defaults to 'year'. */
  salaryPeriod: 'year' | 'month' | 'hour';
  /** 'full_time' | 'contract' | 'part_time' | 'internship' — maps 1:1 to
   *  JSearch FULLTIME/CONTRACTOR/PARTTIME/INTERN. Replace-wholesale array
   *  like its siblings. */
  employmentTypes: string[];
  companyStages: Record<string, boolean>;
  companySizes: string[];
  industriesTarget: string[];
  industriesAvoid: string[];
  mustHaves: string[];
  dealbreakers: string[];
  workAuth: string;

  // Agent behavior
  aggressiveness: RAAggressiveness;
  matchThreshold: number;
  dailyCap: number;
  quietStart: number;
  quietEnd: number;
  autoDecline: boolean;
  autoSchedule: boolean;
  pauseDuringInterviews: boolean;
  reScoreWeekly: boolean;
  coachLoudness: string;

  // Notifications
  channels: { email: boolean; push: boolean; sms: boolean };
  digest: string;
  notif: Record<string, { email: boolean; push: boolean; sms: boolean }>;

  // Privacy
  profileVisibility: string;
  blockedCompanies: string[];
  blockedRecruiters: number;
  dataRetention: string;

  // Plan (read-mostly)
  plan: string;

  // Onboarding-chat provenance (optional — see RAPreferencesOnboarding)
  onboarding?: RAPreferencesOnboarding;

  updatedAt: string;
}

export interface RAPreferenceOptions {
  industries: string[];
  companyStages: Array<{ id: string; label: string; sub: string }>;
  companySizes: string[];
  seniorityLabels: string[];
}

/** Partial preferences update; only changed fields are sent. */
export type RAPreferencesUpdateInput = Partial<Omit<RAPreferences, 'updatedAt'>>;

// ─────────────────────────────────────────────────────────────────────
// Static option lists — transcribed from FIXTURE_PREFERENCE_OPTIONS
// (roboapply/lib/fixtures/preferences.ts) / RoboApply_V3 data.jsx.
// ─────────────────────────────────────────────────────────────────────

export const RA_PREFERENCE_OPTIONS: RAPreferenceOptions = {
  industries: [
    'Healthtech',
    'Climate',
    'Fintech',
    'Edtech',
    'Developer tools',
    'AI / ML',
    'B2B SaaS',
    'Consumer',
    'E-commerce',
    'Marketplaces',
    'Logistics',
    'Manufacturing',
    'Cybersecurity',
    'Media',
    'Gaming',
    'Hardware',
    'Bio / Pharma',
    'Real estate',
    'Legal-tech',
  ],
  companyStages: [
    { id: 'seed', label: 'Seed', sub: '1–10 ppl · pre-product' },
    { id: 'seriesA', label: 'Series A', sub: '10–50 · product-market' },
    { id: 'seriesB', label: 'Series B', sub: '50–200 · scaling' },
    { id: 'seriesC', label: 'Series C', sub: '200–500 · expansion' },
    { id: 'late', label: 'Late-stage', sub: '500–5000 · pre-IPO' },
    { id: 'public', label: 'Public', sub: '5000+ · post-IPO' },
  ],
  companySizes: ['1–10', '11–50', '51–200', '201–1000', '1001–5000', '5000+'],
  seniorityLabels: ['Intern', 'Junior', 'Mid', 'Senior', 'Staff', 'Principal'],
};

// ─────────────────────────────────────────────────────────────────────
// Defaults for first-time users — a conservative, empty-ish profile. We do
// NOT copy the demo persona from FIXTURE_PREFERENCES (that's seed data for the
// stub); a fresh user starts blank with sensible agent defaults so the form
// renders without crashing and the agent has safe limits.
// ─────────────────────────────────────────────────────────────────────

function defaultPreferences(): RAPreferences {
  return {
    // Identity extras
    phone: null,
    location: null,
    pronouns: null,
    yearsExp: 0,
    defaultResumeId: null,
    links: { linkedin: '', github: '', portfolio: '', x: '' },

    // Hunt
    huntActive: false,
    intentMarkdown: '',
    roleTitles: [],
    workModes: { remote: true, hybrid: true, onsite: false },
    cities: [],
    salaryMinK: 0,
    salaryMaxK: 0,
    salaryPeriod: 'year',
    employmentTypes: [],
    companyStages: {
      seed: false,
      seriesA: false,
      seriesB: false,
      seriesC: false,
      late: false,
      public: false,
    },
    companySizes: [],
    industriesTarget: [],
    industriesAvoid: [],
    mustHaves: [],
    dealbreakers: [],
    workAuth: '',

    // Agent behavior
    aggressiveness: 'balanced',
    matchThreshold: 80,
    dailyCap: 10,
    quietStart: 22,
    quietEnd: 8,
    autoDecline: false,
    autoSchedule: false,
    pauseDuringInterviews: true,
    reScoreWeekly: true,
    coachLoudness: 'nudges',

    // Notifications
    channels: { email: true, push: true, sms: false },
    digest: 'daily',
    notif: {
      newMatch90: { email: true, push: true, sms: false },
      queueReview: { email: true, push: true, sms: false },
      appSent: { email: false, push: true, sms: false },
      response: { email: true, push: true, sms: true },
      interview: { email: true, push: true, sms: true },
    },

    // Privacy
    profileVisibility: 'private',
    blockedCompanies: [],
    blockedRecruiters: 0,
    dataRetention: '365',

    // Plan
    plan: 'free',

    updatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Deep-merge semantics — identical to the stub's `mergePreferences`.
// These nested record objects deep-merge (a patch touching one key keeps its
// siblings); everything else (arrays + scalars) replaces wholesale.
// ─────────────────────────────────────────────────────────────────────

const DEEP_MERGE_PREF_KEYS = [
  'links',
  'channels',
  'notif',
  'companyStages',
  'workModes',
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mergePreferences(
  current: RAPreferences,
  patch: RAPreferencesUpdateInput,
): RAPreferences {
  const next: RAPreferences = { ...current };
  const currentRec = current as unknown as Record<string, unknown>;
  const nextRec = next as unknown as Record<string, unknown>;
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    if (
      (DEEP_MERGE_PREF_KEYS as readonly string[]).includes(key) &&
      isPlainObject(val) &&
      isPlainObject(currentRec[key])
    ) {
      nextRec[key] = {
        ...(currentRec[key] as Record<string, unknown>),
        ...(val as Record<string, unknown>),
      };
    } else {
      nextRec[key] = val;
    }
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

/**
 * Coerce a persisted blob (which may be partial / from an older shape / null)
 * into a complete RAPreferences by layering it over the defaults. This keeps
 * GET resilient — a row written before a field was added still returns a full
 * object. Nested record objects are shallow-merged over their default so new
 * sub-keys (e.g. a future notif event) appear with safe defaults.
 */
function hydrateBlob(raw: unknown): RAPreferences {
  const base = defaultPreferences();
  if (!isPlainObject(raw)) return base;
  const merged = mergePreferences(base, raw as RAPreferencesUpdateInput);
  // Preserve the stored updatedAt if present (mergePreferences stamps a new
  // one); a GET should not look like a fresh write.
  if (typeof (raw as Record<string, unknown>).updatedAt === 'string') {
    merged.updatedAt = (raw as Record<string, unknown>).updatedAt as string;
  }
  return merged;
}

// ─────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────

export class RAPreferencesService {
  /**
   * GET /preferences — returns the user's blob (defaulted for first-timers)
   * plus the static option lists. Never returns null; a user with no row gets
   * the defaults.
   */
  async get(userId: string): Promise<{
    preferences: RAPreferences;
    options: RAPreferenceOptions;
  }> {
    const p = prisma as any;
    const row = await p.rACareerGoal.findUnique({
      where: { userId },
      select: { preferencesBlob: true },
    });
    const preferences = hydrateBlob(row?.preferencesBlob ?? null);
    return { preferences, options: RA_PREFERENCE_OPTIONS };
  }

  /**
   * PATCH /preferences — deep-merge the patch into the stored blob and persist.
   * Returns the merged result (PreferencesUpdateResponse shape: { preferences }).
   *
   * The blob lives on RACareerGoal. If the user has no goal row yet we must
   * create one — but `targetTitle` is a required column. We seed it with an
   * empty string placeholder so the prefs surface works before a goal is set;
   * the goal route's own validation (non-empty targetTitle) still gates the
   * real goal save, and goal.get tolerates the placeholder.
   */
  async update(
    userId: string,
    patch: RAPreferencesUpdateInput,
  ): Promise<{ preferences: RAPreferences }> {
    const p = prisma as any;
    const existing = await p.rACareerGoal.findUnique({
      where: { userId },
      select: { preferencesBlob: true },
    });

    const current = hydrateBlob(existing?.preferencesBlob ?? null);
    const merged = mergePreferences(current, patch);

    await p.rACareerGoal.upsert({
      where: { userId },
      create: {
        userId,
        targetTitle: '',
        preferencesBlob: merged as unknown as object,
      },
      update: {
        preferencesBlob: merged as unknown as object,
      },
    });

    logger.info('RA_V2_PREFERENCES', 'preferences updated', {
      userId,
      keys: Object.keys(patch),
    });
    return { preferences: merged };
  }
}

export const raPreferencesService = new RAPreferencesService();
