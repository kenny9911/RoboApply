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
// WP-20 (ARCHITECTURE.md §2.8): the job-targeting keys (`roleTitles`,
// `workModes`, `cities`, `salaryMinK`, `salaryPeriod`, `employmentTypes`,
// `companyStages`, `companySizes`, `industriesTarget/Avoid`,
// `targetCompanies`) are no longer written to the blob. GET projects them
// from the user's ACTIVE search profile (RASearchProfile.filters, the one
// preference store) and PATCH turns a change to them into a FilterSetPatch on
// that profile (features/search/legacyBridge.ts). The wire shape is unchanged,
// so the legacy V2 client, onboarding confirm and Settings keep working.
// `blockedCompanies` stays here (privacy) and is mirrored into
// `excludedCompanies`. The dead agent knobs (`aggressiveness`,
// `matchThreshold`, `dailyCap`, `quietStart/End`, `autoDecline`,
// `autoSchedule`) are dropped from the type, stripped on write and ignored on
// read.
//
// The older prefs-vs-goal split (per the fixture header + 02-stub-contract.md §5):
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

import type { ExtendedPrismaClient } from '../../../lib/prisma.js';
import { logger } from '../../../services/LoggerService.js';
import { BRANDS } from '../../../platform/brand/registry.js';
import { getCurrentBrandOrDefault } from '../../../platform/brand/index.js';
import {
  SEARCH_BACKED_PREFERENCE_KEYS,
  VersionConflictError,
  preferencePatchToFilterPatch,
  projectFiltersToPreferences,
  searchProfileService as defaultSearchProfiles,
  type SearchProfileService,
} from '../../../features/search/index.js';

// ─────────────────────────────────────────────────────────────────────
// Wire types — kept structurally identical to roboapply/lib/api/v2/types.ts.
// (V2 backend cannot import the frontend types module; we mirror it here.)
// ─────────────────────────────────────────────────────────────────────

/** @deprecated Dead agent knob (ARCH §2.8): no longer stored or returned. */
export type RAAggressiveness = 'manual' | 'balanced' | 'aggressive';

/** Dead agent knobs: stripped on write, ignored on read (ARCH §2.8). */
export const DEAD_AGENT_KNOBS = ['aggressiveness', 'matchThreshold', 'dailyCap', 'quietStart', 'quietEnd', 'autoDecline', 'autoSchedule'] as const;

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
  /** e.g. 'v5-confirm'. */
  version?: string;
  completedSteps?: string[];
  /** The RAOnboardingSession that produced this stamp. */
  sessionId?: string;
  /**
   * How many times the setup panel has AUTO-opened. Hard cap 2, enforced
   * client-side off `GET /auth/me`; `POST /onboarding/seen` increments it.
   *
   * It is stamped on PANEL OPEN and not on bootstrap, and the difference is
   * the whole point: bootstrap needs a `resumeVariantId`, which is precisely
   * what the no-resume user does not have — so a bootstrap-time counter would
   * never fire for them and the panel would reopen forever for exactly the
   * people the cap protects.
   */
  autoOpens?: number;
  /** Which step the panel last auto-opened at ('resume' | 'confirm'). */
  lastSeenStep?: string;
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
  /** Companies the user WANTS. Boosts the feed with an extra company-scoped
   *  row; never a filter. Not to be confused with `blockedCompanies`. */
  targetCompanies: string[];
  mustHaves: string[];
  dealbreakers: string[];
  workAuth: string;

  // Agent behavior (the dead knobs are gone: DEAD_AGENT_KNOBS)
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
    targetCompanies: [],
    mustHaves: [],
    dealbreakers: [],
    workAuth: '',

    // Agent behavior
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
  const merged = mergePreferences(base, stripDeadKnobs(raw) as RAPreferencesUpdateInput);
  // Preserve the stored updatedAt if present (mergePreferences stamps a new
  // one); a GET should not look like a fresh write.
  if (typeof (raw as Record<string, unknown>).updatedAt === 'string') {
    merged.updatedAt = (raw as Record<string, unknown>).updatedAt as string;
  }
  return merged;
}

function stripDeadKnobs(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  for (const k of DEAD_AGENT_KNOBS) delete out[k];
  return out;
}

/** The blob as stored: everything except the search-backed keys. */
function storableBlob(prefs: RAPreferences): Record<string, unknown> {
  const out = stripDeadKnobs({ ...(prefs as unknown as Record<string, unknown>) });
  for (const k of SEARCH_BACKED_PREFERENCE_KEYS) delete out[k];
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────

type GoalDb = Pick<ExtendedPrismaClient, 'rACareerGoal'>;

export interface RAPreferencesServiceDeps {
  getDb?: () => Promise<GoalDb>;
  searchProfiles?: Pick<SearchProfileService, 'getActive' | 'update'>;
  /** Currency for a new pay floor (default: the request brand's). */
  currency?: () => string;
}

const defaultGetDb = async (): Promise<GoalDb> => (await import('../../../lib/prisma.js')).default;

export class RAPreferencesService {
  private readonly getDb: () => Promise<GoalDb>;
  private readonly searchProfiles: Pick<SearchProfileService, 'getActive' | 'update'>;
  private readonly currency: () => string;

  constructor(deps: RAPreferencesServiceDeps = {}) {
    this.getDb = deps.getDb ?? defaultGetDb;
    this.searchProfiles = deps.searchProfiles ?? defaultSearchProfiles;
    this.currency = deps.currency ?? (() => BRANDS[getCurrentBrandOrDefault().id].currency);
  }

  private async readBlob(userId: string): Promise<unknown> {
    const db = await this.getDb();
    const row = await db.rACareerGoal.findUnique({ where: { userId }, select: { preferencesBlob: true } });
    return row?.preferencesBlob ?? null;
  }

  /**
   * Overlay the active search profile's projection. When the store cannot be
   * read (logged), the blob's own legacy values are returned unchanged:
   * stale but real, never invented.
   */
  private async withProjection(userId: string, prefs: RAPreferences): Promise<RAPreferences> {
    try {
      const active = await this.searchProfiles.getActive(userId);
      return { ...prefs, ...projectFiltersToPreferences(active.filters) };
    } catch (err) {
      logger.warn('RA_V2_PREFERENCES', 'search profile projection failed; returning stored values', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return prefs;
    }
  }

  /**
   * GET /preferences — the user's blob (defaulted for first-timers) with the
   * job-targeting keys projected from the active search profile, plus the
   * static option lists. Never returns null.
   */
  async get(userId: string): Promise<{
    preferences: RAPreferences;
    options: RAPreferenceOptions;
  }> {
    const preferences = await this.withProjection(userId, hydrateBlob(await this.readBlob(userId)));
    return { preferences, options: RA_PREFERENCE_OPTIONS };
  }

  /**
   * PATCH /preferences — deep-merge the non-search keys into the stored blob,
   * then apply any change to a job-targeting key to the active search profile
   * (one FilterSetPatch, retried once on a version conflict). Returns the
   * merged result with the fresh projection (PreferencesUpdateResponse shape).
   *
   * The blob lives on RACareerGoal. If the user has no goal row yet we must
   * create one — but `targetTitle` is a required column. We seed it with an
   * empty string placeholder so the prefs surface works before a goal is set;
   * the goal route's own validation (non-empty targetTitle) still gates the
   * real goal save, and goal.get tolerates the placeholder.
   *
   * Order matters for users who predate search profiles. Their job-targeting
   * keys still sit in the blob, and the one-time legacy migration (run by
   * `searchProfiles.getActive`) reads them from there. So the migration is
   * forced BEFORE the blob is rewritten; only once it has succeeded may the
   * targeting keys be stripped. If it fails, the blob is written with those
   * keys kept (dead knobs still dropped), so a later migration still finds
   * them.
   *
   * The blob is written before the search-profile write, so a failed
   * search-profile write never loses the onboarding stamp or a notification
   * setting; that failure is then thrown (the route answers 500 and the
   * client keeps its draft).
   */
  async update(
    userId: string,
    patchIn: RAPreferencesUpdateInput,
  ): Promise<{ preferences: RAPreferences }> {
    const patch = stripDeadKnobs({ ...(patchIn as Record<string, unknown>) }) as RAPreferencesUpdateInput;
    const db = await this.getDb();

    // Migrate (or confirm) the search profiles while the blob is untouched.
    let migrationError: unknown = null;
    try {
      await this.searchProfiles.getActive(userId);
    } catch (err) {
      migrationError = err;
      logger.warn('RA_V2_PREFERENCES', 'search profile store unavailable; keeping job-targeting keys in the blob', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const rawBefore = await this.readBlob(userId);
    const current = hydrateBlob(rawBefore);
    const blockedBefore = current.blockedCompanies;
    const merged = mergePreferences(current, patch);
    const stored = (migrationError ? stripDeadKnobs({ ...(merged as unknown as Record<string, unknown>) }) : storableBlob(merged)) as object;

    await db.rACareerGoal.upsert({
      where: { userId },
      create: { userId, targetTitle: '', preferencesBlob: stored },
      update: { preferencesBlob: stored },
    });

    const searchKeys = Object.keys(patch).filter(
      (k) => (SEARCH_BACKED_PREFERENCE_KEYS as readonly string[]).includes(k) || k === 'blockedCompanies',
    );
    if (searchKeys.length) {
      // The change is in the blob (kept unstripped), but it did not reach the
      // search profile: report the failure rather than pretend it saved.
      if (migrationError) throw migrationError;
      await this.writeThrough(userId, patch as Record<string, unknown>, blockedBefore);
    }

    logger.info('RA_V2_PREFERENCES', 'preferences updated', {
      userId,
      keys: Object.keys(patch),
      searchKeys,
    });
    return { preferences: await this.withProjection(userId, merged) };
  }

  private async writeThrough(userId: string, patch: Record<string, unknown>, blockedBefore: string[]): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const active = await this.searchProfiles.getActive(userId);
      const filtersPatch = preferencePatchToFilterPatch(patch, { current: active.filters, currency: this.currency(), blockedBefore });
      if (!filtersPatch) return;
      try {
        await this.searchProfiles.update(userId, active.id, { version: active.version, filtersPatch });
        return;
      } catch (err) {
        if (err instanceof VersionConflictError && attempt === 0) continue;
        throw err;
      }
    }
  }
}

export const raPreferencesService = new RAPreferencesService();
