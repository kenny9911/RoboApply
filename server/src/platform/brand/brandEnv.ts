// server/src/platform/brand/brandEnv.ts
//
// The one per-brand env rule (owner ruling D5; GOAPPLY_PARITY_PLAN.md §3.1).
// It supersedes TASK_PLAN R-03 ("no fallback from CN_X to X"): a China-specific
// value is an OPTIONAL OVERRIDE. Set, it is used. Unset, GoApply runs on the
// shared stack RoboApply uses. No module invents its own fallback: it calls
// `brandEnv` and gets this rule.
//
//   brandEnv(roboapply, NAME) → NAME, always. RoboApply never reads a CN_ value.
//
//   brandEnv(goapply, NAME), by the class of NAME:
//
//   1. Brand-own (`BRAND_OWN_ENV`): CN_NAME only, never the shared value.
//      Identity does not cross brands (origin, cookie domain, legal entity,
//      sender and support mailboxes, collecting entity) and neither do a few
//      settings that only make sense per deployment.
//        brandEnv(goapply, 'COOKIE_DOMAIN') → CN_COOKIE_DOMAIN
//
//   2. Grouped (`BRAND_ENV_GROUPS`): settings that belong together are read as
//      ONE set. When the group's CN_ anchor is set, every member is read as
//      CN_NAME with no fallback. Otherwise every member is read unprefixed. A
//      URL from one account is never paired with a key from another.
//        CN_S3_BUCKET unset → brandEnv(goapply, 'S3_ACCESS_KEY_ID') = S3_ACCESS_KEY_ID
//        CN_S3_BUCKET set   → brandEnv(goapply, 'S3_ACCESS_KEY_ID') = CN_S3_ACCESS_KEY_ID
//                             (undefined when unset; never the shared key)
//
//   3. Everything else: CN_NAME ?? NAME, per key (LLM_*, TOTP_ENCRYPTION_KEY,
//      COPILOT_DAILY_BUDGET_USD, SCORE_DAILY_BUDGET, RA_SYSTEM_USER_ID,
//      INTERVIEW_RETENTION_DAYS, INTERVIEW_ENGINE_RECORDING_ENABLED, …).
//
// The strict mainland posture is an explicit operator choice, never implied by
// a missing value: `cnResidencyStrict` (CN_RESIDENCY_STRICT=true) and
// `cnLlmDomesticOnly` (CN_LLM_DOMESTIC_ONLY=true, or the strict switch).
//
// A group follows its anchor, so a half-set GoApply group (CN_S3_ENDPOINT and
// keys without CN_S3_BUCKET) runs wholly on the shared names. That is the rule,
// but it must not be silent: `brandEnvGroupProblems` names such groups so
// startup can report them.
//
// Vendor-only keys stay unprefixed and are read directly
// (DEEPSEEK_API_KEY, DASHSCOPE_API_KEY, WECHAT_*, WECHATPAY_*, ALIYUN_*).

import { MODEL_ENV } from '../../lib/llm/llmStackConfigSchema.js';
import { getBrand, type BrandId, type ProductBrand } from './registry.js';

export type EnvSource = Record<string, string | undefined>;

/**
 * Names a brand reads from its own variable only. GoApply reads `CN_<NAME>`
 * and gets `undefined` when it is unset: RoboApply's value never stands in.
 */
export const BRAND_OWN_ENV: ReadonlySet<string> = new Set([
  'CANONICAL_ORIGIN',
  'COOKIE_DOMAIN',
  'BACKEND_URL',
  'EMAIL_FROM',
  'SUPPORT_EMAIL',
  'COACHING_ADMIN_EMAIL',
  'TAKEDOWN_CONTACT',
  'LEGAL_ENTITY_NAME',
  'LEGAL_POSTAL_ADDRESS',
  'LEGAL_DOCS_VERSION',
  'PAYMENT_COLLECTING_ENTITY',
  'MIN_EXT_VERSION',
  'BAIDU_PUSH_TOKEN',
  'CONTACT_OPTIN_API_URL',
  'CONTACT_OPTIN_API_KEY',
  'CONTENT_SAFETY_PROVIDER',
  'CONTENT_SAFETY_TIMEOUT_MS',
  'SAFETY_KEYWORDS_URL',
  // The contact in the job-source User-Agent (features/jobs/sources/userAgent.ts, MKT-1C): identity, so
  // GoApply never sends RoboApply's contact to a mainland board.
  'JOB_SOURCES_CONTACT',
]);

export type BrandEnvGroupId = 'voice' | 'speech' | 'storage' | 'push';

export interface BrandEnvGroup {
  /** GoApply owns the group when EVERY anchor has a `CN_` value. */
  anchors: readonly string[];
  /** Every name read as one set (anchors included). */
  members: readonly string[];
}

/**
 * Settings read as one set: wholly from `CN_*` when the anchor is set, wholly
 * from the shared names otherwise.
 */
export const BRAND_ENV_GROUPS: Readonly<Record<BrandEnvGroupId, BrandEnvGroup>> = {
  voice: {
    anchors: ['LIVEKIT_URL'],
    members: [
      'LIVEKIT_URL',
      'LIVEKIT_API_KEY',
      'LIVEKIT_API_SECRET',
      'LIVEKIT_AGENT_NAME',
      'LIVEKIT_AGENT_CALLBACK_SECRET',
      'VOICE_PROVIDER',
      'INTERVIEW_ENGINE_AGENT_NAME',
      'INTERVIEW_ENGINE_CALLBACK_BASE_URL',
    ],
  },
  speech: {
    anchors: ['INTERVIEW_ENGINE_STT_MODEL', 'INTERVIEW_ENGINE_TTS_MODEL'],
    members: [
      'INTERVIEW_ENGINE_STT_MODEL',
      'INTERVIEW_ENGINE_TTS_MODEL',
      'INTERVIEW_ENGINE_TTS_VOICE',
      'INTERVIEW_ENGINE_TTS_VOICE_MALE',
      'INTERVIEW_ENGINE_STT_FALLBACK_MODELS',
    ],
  },
  storage: {
    anchors: ['S3_BUCKET'],
    members: [
      'S3_BUCKET',
      'S3_ENDPOINT',
      'S3_REGION',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'S3_FORCE_PATH_STYLE',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_REGION',
    ],
  },
  push: {
    anchors: ['VAPID_PUBLIC_KEY'],
    members: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
  },
};

export const BRAND_ENV_GROUP_IDS = Object.keys(BRAND_ENV_GROUPS) as BrandEnvGroupId[];

/** The stacks `brandStack` answers for: the four groups plus the text model. */
export type BrandStackId = 'llm' | BrandEnvGroupId;
export const BRAND_STACK_IDS: readonly BrandStackId[] = ['llm', ...BRAND_ENV_GROUP_IDS];

/**
 * Where a value comes from.
 *  - `own`: a variable only this brand reads (a `CN_` value for GoApply; a
 *    brand-own name such as COOKIE_DOMAIN for RoboApply).
 *  - `shared`: the unprefixed infrastructure value, the stack RoboApply runs on.
 *  - `none`: nothing is set for this brand.
 */
export type BrandEnvSource = 'own' | 'shared' | 'none';

const GROUP_OF = new Map<string, BrandEnvGroupId>();
for (const id of BRAND_ENV_GROUP_IDS) {
  for (const name of BRAND_ENV_GROUPS[id].members) GROUP_OF.set(name, id);
}

function toBrand(brand: BrandId | ProductBrand): ProductBrand {
  return typeof brand === 'string' ? getBrand(brand) : brand;
}

function assertName(name: string): void {
  if (!name || name !== name.toUpperCase() || name.startsWith('CN_')) {
    throw new Error(`brandEnv: pass the unprefixed UPPER_SNAKE name, got "${name}"`);
  }
}

/** Trimmed value, or undefined when unset or blank. */
function read(env: EnvSource, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/** GoApply has its own set for a group: every anchor has a `CN_` value. */
function cnOwnsGroup(group: BrandEnvGroupId, env: EnvSource): boolean {
  return BRAND_ENV_GROUPS[group].anchors.every((anchor) => read(env, `CN_${anchor}`) !== undefined);
}

function resolve(brand: BrandId | ProductBrand, name: string, env: EnvSource): { value: string | undefined; source: BrandEnvSource } {
  assertName(name);
  const from = (value: string | undefined, source: 'own' | 'shared') => ({ value, source: value === undefined ? ('none' as const) : source });
  if (toBrand(brand).market !== 'cn') return from(read(env, name), BRAND_OWN_ENV.has(name) ? 'own' : 'shared');

  const own = read(env, `CN_${name}`);
  if (BRAND_OWN_ENV.has(name)) return from(own, 'own');
  const group = GROUP_OF.get(name);
  if (group) return cnOwnsGroup(group, env) ? from(own, 'own') : from(read(env, name), 'shared');
  return own !== undefined ? from(own, 'own') : from(read(env, name), 'shared');
}

/**
 * The brand's own variable name for `name` (`CN_` prefix for GoApply). This is
 * the override name; whether GoApply reads it or the shared name is decided by
 * `brandEnv`.
 */
export function brandEnvName(brand: BrandId | ProductBrand, name: string): string {
  assertName(name);
  return toBrand(brand).market === 'cn' ? `CN_${name}` : name;
}

/**
 * The value a brand uses for `name`: trimmed, or undefined when unset or
 * blank. For GoApply an optional `CN_` override, else the shared value, by the
 * class of the name (see the header).
 */
export function brandEnv(
  brand: BrandId | ProductBrand,
  name: string,
  env: EnvSource = process.env,
): string | undefined {
  return resolve(brand, name, env).value;
}

/**
 * The strict read: `CN_NAME` for GoApply, `NAME` for RoboApply, never a value
 * from the other name. Use it to ask "did the operator set GoApply's own
 * value?", not to read a setting.
 */
export function brandOwnEnv(
  brand: BrandId | ProductBrand,
  name: string,
  env: EnvSource = process.env,
): string | undefined {
  return read(env, brandEnvName(brand, name));
}

/** Where `brandEnv(brand, name)` gets its value (disclosures, admin). */
export function brandEnvSource(
  brand: BrandId | ProductBrand,
  name: string,
  env: EnvSource = process.env,
): BrandEnvSource {
  return resolve(brand, name, env).source;
}

/**
 * Which stack a brand runs a group of settings on. `own` only for GoApply with
 * its own set: the group's `CN_` anchor(s), or for `llm` a `CN_LLM_PROVIDER` or
 * `CN_LLM_MODEL`. RoboApply always runs on the shared stack.
 */
export function brandStack(
  brand: BrandId | ProductBrand,
  group: BrandStackId,
  env: EnvSource = process.env,
): 'own' | 'shared' {
  if (toBrand(brand).market !== 'cn') return 'shared';
  if (group === 'llm') {
    return read(env, 'CN_LLM_PROVIDER') !== undefined || read(env, 'CN_LLM_MODEL') !== undefined ? 'own' : 'shared';
  }
  return cnOwnsGroup(group, env) ? 'own' : 'shared';
}

/** A GoApply group whose `CN_` values are set but not read. */
export interface BrandEnvGroupProblem {
  group: BrandEnvGroupId;
  /** The `CN_` variables of the group that are set (names only, never values). */
  set: string[];
  /** The `CN_` anchor(s) still unset. Until they are set the whole group reads the shared names. */
  missingAnchors: string[];
}

/**
 * Half-set groups: at least one `CN_<member>` is set, yet the group is not
 * GoApply's own because an anchor is missing (a missed or mistyped
 * CN_S3_BUCKET, a CN_LIVEKIT_API_KEY without CN_LIVEKIT_URL, one speech model
 * of the pair, a CN_VAPID_PRIVATE_KEY without the public key). `brandEnv` then
 * reads the WHOLE group from the shared names and ignores the `CN_` values:
 * GoApply would use RoboApply's bucket, LiveKit project, speech set or VAPID
 * pair while the operator believes it has its own. Startup reports each entry
 * (a failure under `CN_RESIDENCY_STRICT`). Empty for RoboApply, which never
 * reads a `CN_` value, and for a group that is wholly unset or wholly anchored.
 */
export function brandEnvGroupProblems(brand: BrandId | ProductBrand, env: EnvSource = process.env): BrandEnvGroupProblem[] {
  if (toBrand(brand).market !== 'cn') return [];
  const problems: BrandEnvGroupProblem[] = [];
  for (const group of BRAND_ENV_GROUP_IDS) {
    if (cnOwnsGroup(group, env)) continue;
    const { anchors, members } = BRAND_ENV_GROUPS[group];
    const set = members.map((name) => `CN_${name}`).filter((name) => read(env, name) !== undefined);
    if (set.length === 0) continue;
    const missingAnchors = anchors.map((name) => `CN_${name}`).filter((name) => read(env, name) === undefined);
    problems.push({ group, set, missingAnchors });
  }
  return problems;
}

const LLM_MODEL_SELECTORS: ReadonlySet<string> = new Set(Object.values(MODEL_ENV));

/**
 * An unprefixed LLM setting that decides WHERE a prompt goes: the provider
 * mode, a model selector of the stack table (`MODEL_ENV`), or a task model
 * read beside it (LLM_INTERVIEW_LIVE_MODEL, LLM_CAMPUS_MODEL, …). Tuning
 * (timeouts, retries, reasoning effort) decides nothing about the route.
 */
function isLlmRouteSetting(name: string): boolean {
  return name === 'LLM_PROVIDER' || LLM_MODEL_SELECTORS.has(name) || /^LLM_[A-Z0-9_]*MODEL$/.test(name);
}

/**
 * GoApply has its own text-model stack, yet one routing setting still comes
 * from the shared one: `LLM_X` is set and `CN_LLM_X` is not. Model settings
 * are per key, so that task (resume images with only LLM_VISION_MODEL, say)
 * runs on the shared route.
 */
function llmReadsSharedRoute(env: EnvSource): boolean {
  return Object.keys(env).some(
    (name) => isLlmRouteSetting(name) && read(env, name) !== undefined && read(env, `CN_${name}`) === undefined,
  );
}

/**
 * True when any stack (text model, voice, speech, storage, push) or the email
 * transport of the brand resolves to the shared stack. For GoApply this is
 * what makes cross-border processing a fact the product must disclose. Email is
 * shared unless `CN_EMAIL_TRANSPORT` is `aliyun_dm` (own) or `none` (no email).
 *
 * The text model is per key: with GoApply's own provider or default model set
 * (`brandStack(…, 'llm') === 'own'`), a task whose model comes from an
 * unprefixed `LLM_*` setting still runs on the shared route, so that counts as
 * shared too. Not under `cnLlmDomesticOnly`, where every route must be a
 * mainland one whatever the settings say.
 *
 * This reads the environment only. An admin override stored in the database
 * (`llm_stack.*`) can also send a GoApply task to the shared stack; a caller
 * that decides a consent from this value must OR it with the routes the LLM
 * resolver really returns (server/src/lib/llm).
 */
export function brandUsesSharedStack(brand: BrandId | ProductBrand, env: EnvSource = process.env): boolean {
  if (toBrand(brand).market !== 'cn') return true;
  if (BRAND_STACK_IDS.some((group) => brandStack(brand, group, env) === 'shared')) return true;
  if (!cnLlmDomesticOnly(env) && llmReadsSharedRoute(env)) return true;
  const transport = (read(env, 'CN_EMAIL_TRANSPORT') ?? '').toLowerCase();
  return transport !== 'aliyun_dm' && transport !== 'none';
}

/**
 * `CN_RESIDENCY_STRICT=true`: the operator chose the strict mainland posture
 * (PI egress allowlist, mainland storage required, boot assertions fail).
 * Off by default; never implied by a missing value.
 */
export function cnResidencyStrict(env: EnvSource = process.env): boolean {
  return parseBoolEnv(env.CN_RESIDENCY_STRICT);
}

/**
 * GoApply may use mainland model endpoints only: `CN_LLM_DOMESTIC_ONLY=true`,
 * or the strict residency switch, which implies it. Off by default.
 */
export function cnLlmDomesticOnly(env: EnvSource = process.env): boolean {
  return parseBoolEnv(env.CN_LLM_DOMESTIC_ONLY) || cnResidencyStrict(env);
}

/** 'true' | '1' | 'yes' | 'on' (case-insensitive) → true. Unset → `fallback`. */
export function brandEnvFlag(
  brand: BrandId | ProductBrand,
  name: string,
  fallback = false,
  env: EnvSource = process.env,
): boolean {
  const v = brandEnv(brand, name, env);
  if (v === undefined) return fallback;
  return parseBoolEnv(v);
}

export function parseBoolEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/** Non-empty after trimming. */
export function envSet(env: EnvSource, ...names: string[]): boolean {
  return names.every((n) => {
    const v = env[n];
    return typeof v === 'string' && v.trim().length > 0;
  });
}
