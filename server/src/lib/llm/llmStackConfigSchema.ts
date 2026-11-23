/**
 * LLM stack — DB-backed config schema (the non-secret half: provider/model
 * routing + per-purpose model overrides + behavioural tuning).
 *
 * Stored as a single `AppConfig` row keyed `llm_stack.{env}` (mirrors
 * `agent_alex.{env}`). The blob holds ONLY admin OVERRIDES — every field is
 * nullable and `null` means "inherit from env". The runtime accessor in
 * `llmModels.ts` does `override ?? env`, so an empty/absent blob behaves
 * byte-for-byte like today (the §2 safety invariant in the design spec).
 *
 * API KEYS DO NOT LIVE HERE — they are encrypted in the `SystemLLMKey` table
 * (see systemCredentials.ts). AppConfig.value is plaintext JSON.
 *
 * This is the ONLY file that reads the `LLM_*` model env vars (for the
 * env-default display + as the resolution fallback), mirroring the discipline
 * of agentAlex/configSchema.ts buildDefaultConfigFromEnv().
 */

export type ConfigEnvironment = 'production' | 'development';

export function getActiveEnvironment(): ConfigEnvironment {
  return process.env.NODE_ENV === 'production' ? 'production' : 'development';
}

/**
 * AppConfig key of one brand's override blob. RoboApply keeps the historical
 * key (`llm_stack.{env}`); GoApply has its own (`llm_stack.goapply.{env}`).
 * RoboApply never reads GoApply's blob. GoApply reads its own first and, for a
 * setting neither that blob nor `CN_<NAME>` provides, RoboApply's (the shared
 * stack; resolution order in llmModels.ts).
 */
export function appConfigKeyFor(env: ConfigEnvironment, brandId: LlmStackBrand = 'roboapply'): string {
  return brandId === 'roboapply' ? `llm_stack.${env}` : `llm_stack.${brandId}.${env}`;
}

/** Brands with an LLM stack blob (kept as a string union so this file stays import-free). */
export type LlmStackBrand = 'roboapply' | 'goapply';

/** Master kill-switch: force pure-env resolution, ignoring all DB overrides. */
export function isDbConfigDisabled(): boolean {
  return process.env.LLM_SETTINGS_DB_DISABLED === 'true';
}

/* ── Per-purpose model keys ───────────────────────────────────────────────
 * Each maps 1:1 to a real, verified-live env var + call site. See
 * docs/llm-settings-db/03-build-plan.md §A. */
export const PURPOSE_KEYS = [
  'fast',
  'pro',
  'quickJob',
  // Interview evaluation uses ONE model (the whole V3 pipeline + cheating + any
  // legacy V2/grader stage run on it). The 6 per-stage overrides were removed in
  // the 2026-06 simplification — see UnifiedEvaluationAgent resolve*Model.
  'evaluation',
  'matchResume',
  'matchScreen',
  'matching',
  'prematchFilter',
  'jobTag',
  'resumeTag',
  'extract',
  'onboarding',
  'rewrite',
  'interview',
  // Clone tasks (WP-14, ARCHITECTURE.md §1.8): the Assistant (tool-capable,
  // streamed), job enrichment (cheap) and long-form writing (cover letters,
  // outreach).
  'copilot',
  'enrich',
  'writing',
  'vision',
  'intentParser',
  // Weekly career insights and the cross-bank search summary (RAInsightService).
  'insights',
  // SCRM / CS Copilot (the /crm-ai workspace). crmHealth runs the merged
  // health+profile narrative; crmEmail drafts customer-facing reminders;
  // crmDigest writes the Command-Deck summary; crmCoaching writes the
  // per-account coaching artifact (strategy/scripts/objections/follow-ups).
  // crmProfile is reserved for a future standalone profile refresh. See
  // backend/src/agents/crm/*. crmCoaching falls back to crmEmail/fast when
  // unset, preserving the empty-DB == env invariant.
  'crmHealth',
  'crmProfile',
  'crmEmail',
  'crmDigest',
  'crmCoaching',
  // Agent Alex text-chat model (prefixed provider/model id). When set, it overrides the legacy
  // agent_alex.{env} blob's provider/model choice — see
  // services/agentAlex/config.ts resolveAgentAlexChatOverride().
  'agentAlex',
] as const;

export type PurposeKey = (typeof PURPOSE_KEYS)[number];

/** Top-level (non-purpose) model keys + the purpose keys = every model setting. */
export type ModelKey = 'defaultModel' | 'fallbackModel' | PurposeKey;

/**
 * purpose/core key → the env var that supplies its value when the DB override
 * is null. These are the UNPREFIXED names: RoboApply's own, and the shared
 * stack GoApply falls back to. GoApply reads `CN_<NAME>` first, as an optional
 * override, and the unprefixed name when that is unset (per key; the full
 * order, admin blobs included, is in llmModels.ts).
 *
 * This file imports nothing: platform/brand/brandEnv.ts reads this table (a
 * model selector decides where a prompt goes), so an import from platform/brand
 * here would be a cycle.
 */
export const MODEL_ENV: Record<ModelKey, string> = {
  defaultModel: 'LLM_MODEL',
  fallbackModel: 'LLM_FALLBACK_MODEL',
  fast: 'LLM_FAST',
  pro: 'LLM_PRO',
  quickJob: 'LLM_QUICK_JOB',
  evaluation: 'LLM_EVALUATION',
  matchResume: 'LLM_MATCH_RESUME',
  matchScreen: 'LLM_MATCH_SCREEN',
  matching: 'LLM_MATCHING_MODEL',
  prematchFilter: 'LLM_PREMATCH_FILTER',
  jobTag: 'LLM_JOB_TAG',
  resumeTag: 'LLM_RESUME_TAG',
  extract: 'LLM_EXTRACT_MODEL',
  onboarding: 'LLM_ONBOARDING_MODEL',
  rewrite: 'LLM_REWRITE_MODEL',
  interview: 'LLM_INTERVIEW_MODEL',
  copilot: 'LLM_COPILOT_MODEL',
  enrich: 'LLM_ENRICH_MODEL',
  writing: 'LLM_WRITING_MODEL',
  vision: 'LLM_VISION_MODEL',
  intentParser: 'LLM_INTENT_PARSER',
  // The name the insight agent has always read; now also a stack key.
  insights: 'RA_V2_CAREER_INSIGHT_MODEL',
  crmHealth: 'LLM_CRM_HEALTH',
  crmProfile: 'LLM_CRM_PROFILE',
  crmEmail: 'LLM_CRM_EMAIL',
  crmDigest: 'LLM_CRM_DIGEST',
  crmCoaching: 'LLM_CRM_COACHING',
  agentAlex: 'LLM_AGENT_ALEX',
};

/**
 * The auto-fallback list: comma-separated selectors a call may move to after a
 * CREDENTIAL failure (dead key, no credit, no key), after its area's fallbacks
 * and the fallback model (services/llm/fallbackRouting.ts). Read like every
 * other setting, the database first: the blob's `autoFallbackModels`, then
 * this variable (`CN_` override for GoApply). No model is named in code.
 */
export const AUTO_FALLBACK_ENV = 'LLM_AUTO_FALLBACK_MODELS';

/**
 * Every model-selector env var a deployment can set, for both brands: the
 * unprefixed names (RoboApply's, and GoApply's fallback) and the `CN_`
 * overrides GoApply reads first. Cost-coverage checks (check:llm-costs,
 * verify-llm-brand) scan this list, so no model either brand can resolve
 * bills at the default tier unnoticed. (The auto-fallback list holds several
 * selectors; verify-llm-brand checks each of them separately.)
 */
export const ALL_BRAND_MODEL_ENV_VARS: readonly string[] = [
  ...Object.values(MODEL_ENV),
  ...Object.values(MODEL_ENV).map((name) => `CN_${name}`),
];

export type LlmStackPurposes = Record<PurposeKey, string | null>;

/* ── Functionality areas (the LLM gateway) ───────────────────────────────────
 * An area is what an admin assigns a provider entry and a model to: Default,
 * and one area per kind of work. Each area owns the model keys its call sites
 * read, so assigning an area sets all of them at once. A key belongs to at
 * most one area; a key in no area (interview, fallbackModel, the CRM keys) is
 * not assignable here and keeps its per-key override and env value.
 *
 *   - `interview` is left out on purpose: the voice interview accepts only the
 *     models LiveKit lists (interview-engine/config.ts), which a free choice
 *     of provider would break.
 *   - `assistant` owns `copilot`, which streams tool calls. An entry whose
 *     provider type cannot (Google, Anthropic) is refused for that area when
 *     it is saved (AREAS_NEEDING_TOOLS).
 *
 * Resolution, the LLM gateway first and the env after it (llmModels.ts):
 *   1. the area's own assignment;
 *   2. an unassigned area uses the Default area's assignment (its model, its
 *      fallbacks and its effort), except for a key that needs what the
 *      Default entry cannot do (`copilot` streams tool calls);
 *   3. without either, the key's saved per-key override, then its env
 *      variable, then the default model (the defaultModel override, then
 *      LLM_MODEL). No model is chosen in code. */
export const LLM_AREAS = [
  'default',
  'matchResume',
  'parseResume',
  'visual',
  'evaluation',
  'insights',
  'writing',
  'assistant',
  'jobs',
] as const;

export type LlmArea = (typeof LLM_AREAS)[number];

export const AREA_MODEL_KEYS: Record<LlmArea, readonly ModelKey[]> = {
  default: ['defaultModel'],
  // Resume-to-job fit: the scorer (matching), the deep match report and its screens.
  matchResume: ['matching', 'matchResume', 'matchScreen', 'prematchFilter'],
  // Reading a resume's text into structured data.
  parseResume: ['extract', 'resumeTag'],
  // Reading images and scanned pages (OCR). Unassigned and unset, it uses the default model.
  visual: ['vision'],
  // Interview scoring: scorecard, per-question review, recommendations, coaching notes.
  evaluation: ['evaluation'],
  insights: ['insights'],
  writing: ['writing', 'rewrite'],
  assistant: ['copilot', 'onboarding', 'intentParser'],
  jobs: ['enrich', 'jobTag', 'quickJob'],
};

/** Areas whose calls stream tool calls; their entry's provider type must support it. */
export const AREAS_NEEDING_TOOLS: readonly LlmArea[] = ['assistant'];

/**
 * Keys whose calls stream tool calls. Such a key does not inherit the Default
 * area when the Default entry's type cannot stream them; it keeps its own
 * per-key override and env value instead (the boot check refuses a copilot
 * model without tool streaming).
 */
export const MODEL_KEYS_NEEDING_TOOLS: readonly ModelKey[] = ['copilot'];

/** Areas whose calls send images; shown as a hint, not enforced (a model list does not say). */
export const AREAS_NEEDING_IMAGES: readonly LlmArea[] = ['visual'];

/** The route tag an area's selectors carry (`newapi@aigw:matchresume/…`; providerPrefixes.ts). */
export function areaRouteTag(area: LlmArea): string {
  return area.toLowerCase();
}

/** The area a route tag names, or null. */
export function areaOfRouteTag(tag: string | null | undefined): LlmArea | null {
  if (!tag) return null;
  const lower = tag.toLowerCase();
  return LLM_AREAS.find((area) => area.toLowerCase() === lower) ?? null;
}

/* ── Reasoning effort and fallbacks of an assignment ─────────────────────────
 * `provider` sends no effort of the gateway's own: the call keeps what its
 * caller and the env send (LLM_<TASK>_REASONING_EFFORT, LLM_REASONING_EFFORT),
 * else the provider's default. Any other level is sent to every call on the
 * route, mapped to the nearest level the provider takes (reasoningEffort.ts
 * gatewayEffortFor). An assignment saved without one uses `medium`. */
export const GATEWAY_EFFORTS = ['provider', 'minimal', 'low', 'medium', 'high', 'max'] as const;
export type GatewayEffort = (typeof GATEWAY_EFFORTS)[number];
export const DEFAULT_GATEWAY_EFFORT: GatewayEffort = 'medium';

export function isGatewayEffort(value: unknown): value is GatewayEffort {
  return typeof value === 'string' && (GATEWAY_EFFORTS as readonly string[]).includes(value);
}

/** Ordered fallback models per assignment, tried after the area's own model. */
export const MAX_AREA_FALLBACKS = 3;

const AREA_OF_KEY: Partial<Record<ModelKey, LlmArea>> = LLM_AREAS.reduce(
  (acc, area) => {
    for (const key of AREA_MODEL_KEYS[area]) acc[key] = area;
    return acc;
  },
  {} as Partial<Record<ModelKey, LlmArea>>,
);

/** The area that owns a model key, or null. */
export function areaOfModelKey(key: ModelKey): LlmArea | null {
  return AREA_OF_KEY[key] ?? null;
}

export function isLlmArea(value: unknown): value is LlmArea {
  return typeof value === 'string' && (LLM_AREAS as readonly string[]).includes(value);
}

/** One model on a provider entry (gatewayProviders.ts), with the effort sent to it. */
export interface LlmRouteTarget {
  providerId: string;
  model: string;
  effort: GatewayEffort;
}

/**
 * An area's assignment: its model and, in order, up to MAX_AREA_FALLBACKS
 * models tried when that one fails (a dead or rate-limited key, an outage, a
 * model the endpoint does not serve). No two targets name the same entry and model.
 */
export interface LlmAreaRoute extends LlmRouteTarget {
  fallbacks: LlmRouteTarget[];
}

export type LlmStackRoutes = Record<LlmArea, LlmAreaRoute | null>;

export function emptyRoutes(): LlmStackRoutes {
  return LLM_AREAS.reduce((acc, area) => {
    acc[area] = null;
    return acc;
  }, {} as LlmStackRoutes);
}

export interface LlmStackTuning {
  retryAttempts: number | null; // LLM_RETRY_ATTEMPTS
  retryBaseMs: number | null; // LLM_RETRY_BASE_MS
  retryMaxMs: number | null; // LLM_RETRY_MAX_MS
  timeoutMs: number | null; // LLM_TIMEOUT_MS
}

export interface LlmStackConfigBlob {
  /** LLM_PROVIDER override (e.g. 'direct'); null → env. */
  provider: string | null;
  /** LLM_MODEL override (prefixed id); null → env. */
  defaultModel: string | null;
  /** LLM_FALLBACK_MODEL override; null → env. */
  fallbackModel: string | null;
  /** LLM_AUTO_FALLBACK_MODELS override (comma-separated selectors); null → env. */
  autoFallbackModels: string | null;
  purposes: LlmStackPurposes;
  /** Area assignments; null → the area's keys resolve as if it did not exist. */
  routes: LlmStackRoutes;
  tuning: LlmStackTuning;
}

/* ── Empty (all-inherit) blob — the resolver fallback ─────────────────────── */

export function emptyPurposes(): LlmStackPurposes {
  return PURPOSE_KEYS.reduce((acc, k) => {
    acc[k] = null;
    return acc;
  }, {} as LlmStackPurposes);
}

export function emptyTuning(): LlmStackTuning {
  return { retryAttempts: null, retryBaseMs: null, retryMaxMs: null, timeoutMs: null };
}

/** All-null overrides — every setting inherits env. The cold-cache / no-row fallback. */
export function emptyLlmStackBlob(): LlmStackConfigBlob {
  return {
    provider: null,
    defaultModel: null,
    fallbackModel: null,
    autoFallbackModels: null,
    purposes: emptyPurposes(),
    routes: emptyRoutes(),
    tuning: emptyTuning(),
  };
}

/* ── Env-default snapshot — for the admin UI "inherits: X" display only ──────
 * Returns the RAW env value per key (or null). NOT used at runtime resolution
 * (the accessor reads env directly); purely the "what env provides" view. For
 * GoApply that is `CN_<NAME>`, else the shared `<NAME>` it falls back to. */
export function buildEnvDefaultsSnapshot(brandId: LlmStackBrand = 'roboapply'): LlmStackConfigBlob {
  const read = (name: string): string | null => {
    const v = process.env[name];
    return v && v.trim() ? v.trim() : null;
  };
  const envStr = (name: string): string | null => (brandId === 'goapply' ? read(`CN_${name}`) ?? read(name) : read(name));
  const envInt = (name: string): number | null => {
    const raw = parseInt((process.env[name] ?? '').trim(), 10);
    return Number.isFinite(raw) ? raw : null;
  };
  const purposes = PURPOSE_KEYS.reduce((acc, k) => {
    acc[k] = envStr(MODEL_ENV[k]);
    return acc;
  }, {} as LlmStackPurposes);
  return {
    provider: envStr('LLM_PROVIDER'),
    defaultModel: envStr('LLM_MODEL'),
    fallbackModel: envStr('LLM_FALLBACK_MODEL'),
    autoFallbackModels: envStr(AUTO_FALLBACK_ENV),
    purposes,
    routes: emptyRoutes(),
    tuning: {
      retryAttempts: envInt('LLM_RETRY_ATTEMPTS'),
      retryBaseMs: envInt('LLM_RETRY_BASE_MS'),
      retryMaxMs: envInt('LLM_RETRY_MAX_MS'),
      timeoutMs: envInt('LLM_TIMEOUT_MS'),
    },
  };
}

/* ── Validation + parse ───────────────────────────────────────────────────── */

export interface ValidationError {
  field: string;
  message: string;
}

const isNullableString = (v: unknown): boolean => v === null || typeof v === 'string';
const isNullableNumber = (v: unknown): boolean =>
  v === null || (typeof v === 'number' && Number.isFinite(v));

/**
 * Validate a candidate blob (post-normalize). Lenient by design: the blob is
 * pure overrides, so the only hard requirement is that present fields are the
 * right primitive type. Returns [] when acceptable.
 */
export function validateLlmStackBlob(blob: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!blob || typeof blob !== 'object') {
    return [{ field: '', message: 'Config must be an object' }];
  }
  const c = blob as Partial<LlmStackConfigBlob>;
  if (!isNullableString(c.provider)) errors.push({ field: 'provider', message: 'provider must be a string or null' });
  if (!isNullableString(c.defaultModel)) errors.push({ field: 'defaultModel', message: 'defaultModel must be a string or null' });
  if (!isNullableString(c.fallbackModel)) errors.push({ field: 'fallbackModel', message: 'fallbackModel must be a string or null' });
  // Optional: a blob saved before the field existed has none.
  if (c.autoFallbackModels !== undefined && !isNullableString(c.autoFallbackModels)) {
    errors.push({ field: 'autoFallbackModels', message: 'autoFallbackModels must be a string or null' });
  }

  if (c.purposes == null || typeof c.purposes !== 'object') {
    errors.push({ field: 'purposes', message: 'purposes section is required' });
  } else {
    for (const k of PURPOSE_KEYS) {
      const v = (c.purposes as unknown as Record<string, unknown>)[k];
      if (v !== undefined && !isNullableString(v)) {
        errors.push({ field: `purposes.${k}`, message: `${k} must be a string or null` });
      }
    }
  }

  // `routes` is optional: a blob saved before the gateway existed has none.
  if (c.routes != null) {
    if (typeof c.routes !== 'object') {
      errors.push({ field: 'routes', message: 'routes must be an object' });
    } else {
      for (const area of LLM_AREAS) {
        const v = (c.routes as unknown as Record<string, unknown>)[area];
        if (v == null) continue;
        const r = v as Partial<LlmAreaRoute>;
        if (typeof v !== 'object' || typeof r.providerId !== 'string' || typeof r.model !== 'string') {
          errors.push({ field: `routes.${area}`, message: `${area} must be null or { providerId, model, effort, fallbacks }` });
          continue;
        }
        if (r.effort !== undefined && !isGatewayEffort(r.effort)) {
          errors.push({ field: `routes.${area}.effort`, message: `effort must be one of ${GATEWAY_EFFORTS.join(', ')}` });
        }
        if (r.fallbacks !== undefined && !Array.isArray(r.fallbacks)) {
          errors.push({ field: `routes.${area}.fallbacks`, message: 'fallbacks must be a list' });
        }
      }
    }
  }

  if (c.tuning == null || typeof c.tuning !== 'object') {
    errors.push({ field: 'tuning', message: 'tuning section is required' });
  } else {
    for (const k of ['retryAttempts', 'retryBaseMs', 'retryMaxMs', 'timeoutMs'] as const) {
      const v = (c.tuning as unknown as Record<string, unknown>)[k];
      if (v !== undefined && !isNullableNumber(v)) {
        errors.push({ field: `tuning.${k}`, message: `${k} must be a number or null` });
      }
    }
  }
  return errors;
}

function normalizeTarget(raw: unknown): LlmRouteTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const providerId = typeof r.providerId === 'string' ? r.providerId.trim().toLowerCase() : '';
  const model = typeof r.model === 'string' ? r.model.trim() : '';
  if (!providerId || !model) return null;
  return { providerId, model, effort: isGatewayEffort(r.effort) ? r.effort : DEFAULT_GATEWAY_EFFORT };
}

/**
 * One area's assignment, read leniently: a missing effort is `medium`, and a
 * fallback that is malformed, repeats an earlier target or comes after
 * MAX_AREA_FALLBACKS is dropped. Saving goes through gatewayAdmin.ts, which
 * refuses those instead.
 */
export function normalizeAreaRoute(raw: unknown): LlmAreaRoute | null {
  const primary = normalizeTarget(raw);
  if (!primary) return null;
  const seen = new Set([`${primary.providerId}::${primary.model}`]);
  const fallbacks: LlmRouteTarget[] = [];
  const list = (raw as { fallbacks?: unknown }).fallbacks;
  for (const item of Array.isArray(list) ? list : []) {
    const target = normalizeTarget(item);
    if (!target || fallbacks.length >= MAX_AREA_FALLBACKS) continue;
    const key = `${target.providerId}::${target.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fallbacks.push(target);
  }
  return { ...primary, fallbacks };
}

/** Coerce arbitrary input into a fully-shaped blob (missing → null). Trims strings. */
export function normalizeLlmStackBlob(input: unknown): LlmStackConfigBlob {
  const base = emptyLlmStackBlob();
  if (!input || typeof input !== 'object') return base;
  const c = input as Record<string, any>;
  const str = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
  };
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  base.provider = str(c.provider);
  base.defaultModel = str(c.defaultModel);
  base.fallbackModel = str(c.fallbackModel);
  base.autoFallbackModels = str(c.autoFallbackModels);
  if (c.purposes && typeof c.purposes === 'object') {
    for (const k of PURPOSE_KEYS) base.purposes[k] = str(c.purposes[k]);
  }
  if (c.routes && typeof c.routes === 'object') {
    for (const area of LLM_AREAS) base.routes[area] = normalizeAreaRoute(c.routes[area]);
  }
  if (c.tuning && typeof c.tuning === 'object') {
    base.tuning.retryAttempts = num(c.tuning.retryAttempts);
    base.tuning.retryBaseMs = num(c.tuning.retryBaseMs);
    base.tuning.retryMaxMs = num(c.tuning.retryMaxMs);
    base.tuning.timeoutMs = num(c.tuning.timeoutMs);
  }
  return base;
}

/** Parse a JSON-string AppConfig.value into a normalized blob, or null on failure. */
export function parseLlmStackBlob(raw: string | null | undefined): LlmStackConfigBlob | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (validateLlmStackBlob(normalizeLlmStackBlob(parsed)).length > 0) return null;
    return normalizeLlmStackBlob(parsed);
  } catch {
    return null;
  }
}
