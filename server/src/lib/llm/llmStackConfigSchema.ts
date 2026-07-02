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

export function appConfigKeyFor(env: ConfigEnvironment): string {
  return `llm_stack.${env}`;
}

/** Master kill-switch: force pure-env resolution, ignoring all DB overrides. */
export function isDbConfigDisabled(): boolean {
  return process.env.LLM_SETTINGS_DB_DISABLED === 'true';
}

/* ── Per-purpose model keys ───────────────────────────────────────────────
 * Each maps 1:1 to a real, verified-live env var + call site. See
 * docs/llm-settings-db/03-build-plan.md §A. interviewPrompt / livekit are
 * intentionally absent (not read by the backend). */
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
  'prematchFilter',
  'jobTag',
  'resumeTag',
  'extract',
  'vision',
  'intentParser',
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
  // Agent Alex text-chat model (prefixed id, e.g. 'anthropic/claude-opus-4-8'
  // or 'google/gemini-3.1-pro-preview'). When set, it overrides the legacy
  // agent_alex.{env} blob's provider/model choice — see
  // services/agentAlex/config.ts resolveAgentAlexChatOverride().
  'agentAlex',
] as const;

export type PurposeKey = (typeof PURPOSE_KEYS)[number];

/** Top-level (non-purpose) model keys + the purpose keys = every model setting. */
export type ModelKey = 'defaultModel' | 'fallbackModel' | PurposeKey;

/** purpose/core key → the env var that supplies its value when the DB override is null. */
export const MODEL_ENV: Record<ModelKey, string> = {
  defaultModel: 'LLM_MODEL',
  fallbackModel: 'LLM_FALLBACK_MODEL',
  fast: 'LLM_FAST',
  pro: 'LLM_PRO',
  quickJob: 'LLM_QUICK_JOB',
  evaluation: 'LLM_EVALUATION',
  matchResume: 'LLM_MATCH_RESUME',
  matchScreen: 'LLM_MATCH_SCREEN',
  prematchFilter: 'LLM_PREMATCH_FILTER',
  jobTag: 'LLM_JOB_TAG',
  resumeTag: 'LLM_RESUME_TAG',
  extract: 'LLM_EXTRACT',
  vision: 'LLM_VISION_MODEL',
  intentParser: 'LLM_INTENT_PARSER',
  crmHealth: 'LLM_CRM_HEALTH',
  crmProfile: 'LLM_CRM_PROFILE',
  crmEmail: 'LLM_CRM_EMAIL',
  crmDigest: 'LLM_CRM_DIGEST',
  crmCoaching: 'LLM_CRM_COACHING',
  agentAlex: 'LLM_AGENT_ALEX',
};

export type LlmStackPurposes = Record<PurposeKey, string | null>;

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
  purposes: LlmStackPurposes;
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
    purposes: emptyPurposes(),
    tuning: emptyTuning(),
  };
}

/* ── Env-default snapshot — for the admin UI "inherits: X" display only ──────
 * Returns the RAW env value per key (or null). NOT used at runtime resolution
 * (the accessor reads env directly); purely the "what env provides" view. */
export function buildEnvDefaultsSnapshot(): LlmStackConfigBlob {
  const envStr = (name: string): string | null => {
    const v = process.env[name];
    return v && v.trim() ? v.trim() : null;
  };
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
    purposes,
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
  if (c.purposes && typeof c.purposes === 'object') {
    for (const k of PURPOSE_KEYS) base.purposes[k] = str(c.purposes[k]);
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
