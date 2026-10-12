// server/src/platform/residency/startupAssertions.ts
//
// Boot-time residency checks (owner ruling D5; GOAPPLY_PARITY_PLAN.md §3.6;
// TASK_PLAN.md WP-15). A mainland deployment boots on the shared stack: a
// missing China-specific provider is reported, never fatal, unless the
// operator chose the strict mainland posture (`CN_RESIDENCY_STRICT=true`).
//
// With `DEPLOY_REGION=cn-mainland` the API always refuses to start when the
// TOPOLOGY is wrong:
//   - the database host is not on the CN allowlist              (db_host_not_allowed / db_url_missing)
//       defaults below; `CN_ALLOWED_DB_HOST_SUFFIXES` replaces them;
//       private RFC 1918 and loopback addresses are always allowed.
//       LIMIT: Aliyun RDS / Tencent CDB public hostnames carry no region
//       (`pgm-xxx.pg.rds.aliyuncs.com` is the same shape in Singapore and
//       Shanghai), so a default-suffix match cannot prove the instance is on
//       the mainland. The report carries a warning for it; ops verify the
//       instance RegionId (cn-*) or connect over the VPC private address,
//       which is the normal ACK setup and needs no suffix at all.
//   - the deployment serves RoboApply (`ALLOWED_BRANDS` / `BRAND_LOCK`) (intl_brand_on_mainland)
//
// These are ADVISORIES by default (logged as warnings at boot) and failures
// only under `CN_RESIDENCY_STRICT=true`:
//   - `CN_ICP_NUMBER` is unset                                  (icp_missing)
//   - a configured CN model route resolves outside the domestic allowlist (cn_llm_off_allowlist)
//       every `CN_LLM_*MODEL` / `CN_RA_MODEL_*` selector is resolved the way
//       LLMService resolves it (known prefix → that provider; otherwise the
//       `CN_LLM_PROVIDER`; in direct mode or with none → OpenRouter), and
//       anything that is not a domestic direct provider is reported
//   - GoApply has no complete bucket of its own (`CN_S3_*`): its files go to
//     the shared store                                           (cn_storage_missing)
//   - the CN bucket endpoint is not mainland object storage       (cn_storage_offshore)
//   - content safety is not Aliyun Green                         (content_safety_not_aliyun_green)
//   - Aliyun Green is chosen but not usable (keys, region, endpoint, timeout;
//     `contentSafetyReadiness().cn1Ready`, WP-76 request)        (content_safety_not_ready)
//   - GoApply email goes through Resend (offshore): `CN_EMAIL_TRANSPORT=resend`,
//     or the default transport with `RESEND_API_KEY` set          (cn_email_offshore)
// In every region an unknown `DEPLOY_REGION` value is refused
// (deploy_region_unknown), so a typo never switches these checks off.
//
// Offshore (DEPLOY_REGION unset) nothing is asserted: that is the shared
// stack, which serves GoApply too.
//
// Wiring: `assertResidencyAtStartup()` is called once at boot through
// platform/startup.ts (from server/src/app.ts), before the app listens or is
// exported; its `advisories` and `warnings` are logged. It throws
// `ResidencyStartupError` listing every failure.

import { allowedBrands } from '../brand/runtime.js';
import { getBrand } from '../brand/registry.js';
import { brandStack, cnResidencyStrict, type EnvSource } from '../brand/brandEnv.js';
import { checkLlmRoute, hostOf } from '../llm/brandPolicy.js';
import { contentSafetyReadiness } from '../llm/contentSafety/config.js';
import { DIRECT_PROVIDER_PREFIXES, PROVIDER_PREFIX_ALIASES } from '../../services/llm/providerPrefixes.js';
import { isPrivateHost } from './egressPolicy.js';
import { CN_MAINLAND, deployRegion, unknownDeployRegion, type DeployRegion } from './deployRegion.js';
import { cnOwnStorageProblem } from './uploadPolicy.js';

/** Mainland managed-Postgres host suffixes (Aliyun RDS / PolarDB, Tencent CDB). */
export const DEFAULT_CN_DB_HOST_SUFFIXES = [
  'rds.aliyuncs.com',
  'pg.rds.aliyuncs.com',
  'polardb.rds.aliyuncs.com',
  'tencentcdb.com',
] as const;

export type ResidencyFailureCode =
  | 'deploy_region_unknown'
  | 'icp_missing'
  | 'db_url_missing'
  | 'db_host_not_allowed'
  | 'intl_brand_on_mainland'
  | 'cn_llm_off_allowlist'
  | 'cn_storage_missing'
  | 'cn_storage_offshore'
  | 'content_safety_not_aliyun_green'
  | 'content_safety_not_ready'
  | 'cn_email_offshore';

export interface ResidencyFailure {
  code: ResidencyFailureCode;
  message: string;
}

/** The checks that never depend on the strict switch: a wrong topology always refuses the boot. */
export const TOPOLOGY_FAILURE_CODES: readonly ResidencyFailureCode[] = [
  'deploy_region_unknown',
  'db_url_missing',
  'db_host_not_allowed',
  'intl_brand_on_mainland',
];

export interface ResidencyReport {
  region: DeployRegion;
  /** `CN_RESIDENCY_STRICT=true`: every check below is a failure. */
  strict: boolean;
  /** Refuse the boot. Topology checks always; the provider checks only under the strict switch. */
  failures: ResidencyFailure[];
  /**
   * Provider checks that did not pass while the strict switch is off: GoApply
   * runs on the shared stack for that part. Logged at boot; never block it.
   * Empty under the strict switch (the same entries are `failures` there).
   */
  advisories: ResidencyFailure[];
  /** Facts the code cannot verify and ops must (logged at boot; never block it). */
  warnings: string[];
}

export class ResidencyStartupError extends Error {
  readonly failures: ResidencyFailure[];
  constructor(failures: ResidencyFailure[]) {
    super(
      'Refusing to start: data-residency checks failed:\n' +
        failures.map((f) => `  - [${f.code}] ${f.message}`).join('\n'),
    );
    this.name = 'ResidencyStartupError';
    this.failures = failures;
  }
}

function set(env: EnvSource, name: string): string | undefined {
  const v = env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function allowedDbHostSuffixes(env: EnvSource = process.env): string[] {
  const override = (env.CN_ALLOWED_DB_HOST_SUFFIXES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
  return override.length ? override : [...DEFAULT_CN_DB_HOST_SUFFIXES];
}

/** Host of a postgres connection string (`postgresql://u:p@host:5432/db?…`). */
export function dbHostOf(url: string): string | null {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h || null;
  } catch {
    return null;
  }
}

export function isAllowedCnDbHost(host: string, env: EnvSource = process.env): boolean {
  if (isPrivateHost(host)) return true;
  return allowedDbHostSuffixes(env).some((s) => host === s || host.endsWith(`.${s}`));
}

/** Base-URL env each provider reads (`systemCredentials.ts`, CN plan §5.2). */
const PROVIDER_BASE_URL_ENV: Record<string, string[]> = {
  ollama: ['OLLAMA_BASE_URL'],
  deepseek: ['DEEPSEEK_API_BASE_URL'],
  kimi: ['KIMI_API_BASE_URL'],
  moonshot: ['KIMI_API_BASE_URL'],
  minimax: ['MINIMAX_BASE_URL'],
  newapi: ['NEWAPI_BASE_URL'],
  qwen: ['DASHSCOPE_BASE_URL'],
  dashscope: ['DASHSCOPE_BASE_URL'],
  glm: ['GLM_API_BASE_URL'],
  zhipu: ['GLM_API_BASE_URL'],
  doubao: ['ARK_BASE_URL'],
  ark: ['ARK_BASE_URL'],
  openai: ['OPENAI_BASE_URL'],
  openrouter: ['OPENROUTER_API_BASE_URL'],
  anthropic: ['ANTHROPIC_BASE_URL'],
  google: ['GEMINI_BASE_URL'],
  gemini: ['GEMINI_BASE_URL'],
};

/** Routing modes `CN_LLM_PROVIDER` may hold instead of a provider id. */
const ROUTING_MODES = new Set(['direct', 'auto']);

/** Every CN model setting (`CN_LLM_<ANY_TASK>_MODEL`, `CN_LLM_MODEL`, `CN_RA_MODEL_*`). */
function cnModelSettings(env: EnvSource): Array<[string, string]> {
  return Object.keys(env)
    .filter((k) => /^CN_LLM_[A-Z0-9_]*MODEL$/.test(k) || /^CN_RA_MODEL_[A-Z0-9_]+$/.test(k))
    .sort()
    .map((k) => [k, set(env, k)] as [string, string | undefined])
    .filter((pair): pair is [string, string] => Boolean(pair[1]));
}

/**
 * Provider pinned by a `provider/model` selector prefix — only the prefixes
 * LLMService itself recognises (`providerPrefixes.ts`), so this check tracks
 * the router: a prefix it does not know (`mistralai/…`, today also `qwen/…`)
 * is not a pin, and the selector goes wherever the routing mode sends it.
 */
function prefixProvider(value: string): string | null {
  if (!value.includes('/')) return null;
  const head = value.split('/')[0]?.trim().toLowerCase() ?? '';
  const id = PROVIDER_PREFIX_ALIASES[head] ?? head;
  return DIRECT_PROVIDER_PREFIXES.has(id) ? id : null;
}

/**
 * The provider LLMService would call for a CN selector
 * (`LLMService.resolvePlatformRoute`): a known prefix wins; otherwise a
 * `CN_LLM_PROVIDER` that names a provider; otherwise (direct/auto mode, or
 * none) an unprefixed selector takes the default model's provider and
 * anything else goes to OpenRouter.
 */
export function resolveCnSelectorProvider(value: string, env: EnvSource = process.env): string {
  const pinned = prefixProvider(value);
  if (pinned) return pinned;
  const mode = (set(env, 'CN_LLM_PROVIDER') ?? '').toLowerCase();
  if (mode && !ROUTING_MODES.has(mode)) return mode;
  if (!value.includes('/')) {
    const defaultModel = set(env, 'CN_LLM_MODEL');
    const fromDefault = defaultModel ? prefixProvider(defaultModel) : null;
    if (fromDefault) return fromDefault;
  }
  return 'openrouter';
}

/**
 * Check every CN model route in env against GoApply's domestic allowlist:
 * one entry per `CN_` model setting that resolves to a provider or host
 * outside it. GoApply may use such a route by default (D5); the entries are
 * what an operator who wants mainland-only AI has to fix.
 */
export function cnLlmRouteFailures(env: EnvSource = process.env): ResidencyFailure[] {
  const goapply = getBrand('goapply');
  const routes: Array<{ setting: string; provider: string }> = [];
  const explicit = set(env, 'CN_LLM_PROVIDER');
  if (explicit && !ROUTING_MODES.has(explicit.toLowerCase())) {
    routes.push({ setting: 'CN_LLM_PROVIDER', provider: explicit.toLowerCase() });
  }
  for (const [setting, value] of cnModelSettings(env)) {
    routes.push({ setting, provider: resolveCnSelectorProvider(value, env) });
  }
  const failures: ResidencyFailure[] = [];
  for (const { setting, provider } of routes) {
    const baseUrl = (PROVIDER_BASE_URL_ENV[provider] ?? []).map((n) => set(env, n)).find(Boolean) ?? null;
    // The question here is always "is this route on the domestic allowlist?",
    // whatever the deployment's own setting: the policy is asked with the
    // domestic-only wall on. Whether a "no" refuses the boot is the caller's
    // rule (an advisory by default, a failure under CN_RESIDENCY_STRICT).
    const decision = checkLlmRoute({ brand: goapply, provider, baseUrl, carriesUserData: true, env: { ...env, CN_LLM_DOMESTIC_ONLY: 'true' } });
    if (!decision.allowed) {
      failures.push({
        code: 'cn_llm_off_allowlist',
        message: `${setting} resolves to ${provider}${decision.host ? ` (${decision.host})` : ''}: ${decision.reason}`,
      });
    }
  }
  return failures;
}

/** Collect every residency failure and advisory for this environment (no side effects). */
export function checkResidency(env: EnvSource = process.env): ResidencyReport {
  const region = deployRegion(env);
  const strict = cnResidencyStrict(env);
  const failures: ResidencyFailure[] = [];
  const advisories: ResidencyFailure[] = [];
  const warnings: string[] = [];
  /** A provider check: fatal only under the strict switch (P4), otherwise reported. */
  const provider = (failure: ResidencyFailure) => (strict ? failures : advisories).push(failure);

  const unknown = unknownDeployRegion(env);
  if (unknown) {
    failures.push({
      code: 'deploy_region_unknown',
      message: `DEPLOY_REGION="${unknown}" is not a known value. Use "${CN_MAINLAND}" on the mainland stack, or leave it unset.`,
    });
  }
  if (region !== CN_MAINLAND) return { region, strict, failures, advisories, warnings };

  if (!set(env, 'CN_ICP_NUMBER')) {
    provider({ code: 'icp_missing', message: 'CN_ICP_NUMBER is not set. The footer shows no ICP filing line.' });
  }

  const dbUrls = ['DATABASE_URL', 'DIRECT_DATABASE_URL'].map((n) => [n, set(env, n)] as const);
  if (!dbUrls[0]![1]) {
    failures.push({ code: 'db_url_missing', message: 'DATABASE_URL is not set.' });
  }
  for (const [name, url] of dbUrls) {
    if (!url) continue;
    const host = dbHostOf(url);
    if (!host || !isAllowedCnDbHost(host, env)) {
      failures.push({
        code: 'db_host_not_allowed',
        message: `${name} host ${host ?? '(unreadable)'} is not on the CN database allowlist (${allowedDbHostSuffixes(env).join(', ')}; private addresses allowed). Set CN_ALLOWED_DB_HOST_SUFFIXES to change it.`,
      });
    } else if (!isPrivateHost(host) && !set(env, 'CN_ALLOWED_DB_HOST_SUFFIXES')) {
      warnings.push(
        `${name} host ${host} matches a default managed-database suffix, which does not encode the region. ` +
          'Verify the instance RegionId is cn-*, or connect over the VPC private address.',
      );
    }
  }

  const brands = allowedBrands(env);
  if (brands.includes('roboapply')) {
    failures.push({
      code: 'intl_brand_on_mainland',
      message: `This deployment would serve roboapply (allowed brands: ${brands.join(', ')}). Set ALLOWED_BRANDS=goapply.`,
    });
  }

  for (const failure of cnLlmRouteFailures(env)) provider(failure);
  if (!strict && brandStack('goapply', 'llm', env) === 'shared') {
    warnings.push('GoApply has no model provider of its own (CN_LLM_PROVIDER / CN_LLM_MODEL): its AI requests use the shared model stack.');
  }

  const storage = cnOwnStorageProblem(env);
  if (storage === 'missing') {
    provider({
      code: 'cn_storage_missing',
      message: strict
        ? 'CN_S3_ENDPOINT, CN_S3_BUCKET, CN_S3_ACCESS_KEY_ID and CN_S3_SECRET_ACCESS_KEY must all be set under CN_RESIDENCY_STRICT.'
        : 'GoApply has no complete bucket of its own (CN_S3_ENDPOINT, CN_S3_BUCKET, CN_S3_ACCESS_KEY_ID, CN_S3_SECRET_ACCESS_KEY): its files are kept on the shared store.',
    });
  } else if (storage === 'offshore') {
    const cnStorageHost = hostOf(set(env, 'CN_S3_ENDPOINT') ?? '');
    const intlStorageHost = hostOf(set(env, 'S3_ENDPOINT') ?? '');
    provider({
      code: 'cn_storage_offshore',
      message:
        cnStorageHost && intlStorageHost && cnStorageHost === intlStorageHost
          ? 'CN_S3_ENDPOINT points at the shared bucket host (S3_ENDPOINT).'
          : `CN_S3_ENDPOINT host ${cnStorageHost ?? '(unreadable)'} is not mainland object storage ` +
            '(oss-cn-*.aliyuncs.com, cos.ap-<mainland>.myqcloud.com, obs.cn-*.myhuaweicloud.com, a private address, ' +
            'or CN_ALLOWED_STORAGE_HOST_SUFFIXES).',
    });
  }

  if ((set(env, 'CN_CONTENT_SAFETY_PROVIDER') ?? '').toLowerCase() !== 'aliyun_green') {
    provider({
      code: 'content_safety_not_aliyun_green',
      message: strict
        ? 'CN_CONTENT_SAFETY_PROVIDER must be aliyun_green under CN_RESIDENCY_STRICT.'
        : 'CN_CONTENT_SAFETY_PROVIDER is not aliyun_green: GoApply AI text is checked by the built-in keyword filter only.',
    });
  } else {
    const safety = contentSafetyReadiness(env);
    if (!safety.cn1Ready) {
      provider({
        code: 'content_safety_not_ready',
        message: `Aliyun Green content safety is not usable: ${safety.problems.join('; ') || 'unknown configuration problem'}.`,
      });
    }
  }

  // The same reading as the email service (platform/email `transportNameFor`):
  // every value other than `aliyun_dm` and `none` sends through Resend, the
  // shared transport. So unset, and a value that names no transport (`aliyun`,
  // `smtp`: a typo must not hide the offshore route), are flagged when a key
  // makes Resend real. An explicit `resend` is always flagged, as before.
  const transport = (set(env, 'CN_EMAIL_TRANSPORT') ?? '').toLowerCase();
  const sendsThroughResend = transport !== 'aliyun_dm' && transport !== 'none';
  if (transport === 'resend' || (sendsThroughResend && set(env, 'RESEND_API_KEY'))) {
    const unknown = transport && transport !== 'resend' ? ' CN_EMAIL_TRANSPORT names no transport (aliyun_dm, resend or none), so it is read as resend.' : '';
    provider({
      code: 'cn_email_offshore',
      message:
        (strict
          ? 'GoApply email would go through Resend, an offshore provider. Set CN_EMAIL_TRANSPORT=aliyun_dm (or none for no email).'
          : 'GoApply email goes through Resend, an offshore provider. Set CN_EMAIL_TRANSPORT=aliyun_dm to send from the mainland.') + unknown,
    });
  }

  return { region, strict, failures, advisories, warnings };
}

/** Throw `ResidencyStartupError` when any check fails; return the report otherwise. */
export function assertResidencyAtStartup(env: EnvSource = process.env): ResidencyReport {
  const report = checkResidency(env);
  if (report.failures.length) throw new ResidencyStartupError(report.failures);
  return report;
}
