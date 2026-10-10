// server/src/platform/startup.ts — boot-time checks run once by server/src/app.ts
// (Wave 2 gate wiring of WP-15 REQ-WP15-01 and the WP-14 startup check;
// WP-93 made the Assistant check blocking; D5 parity, GOAPPLY_PARITY_PLAN.md §3.6).
//
//   1. Residency (WP-15, CN §3): `assertResidencyAtStartup()`. A failure
//      refuses to boot: off Vercel the process exits 1; on Vercel the throw
//      fails the function's module init, so no request is served. A wrong
//      topology always fails. A missing China-specific provider on the
//      mainland stack is an advisory: it is logged as a warning and the
//      deployment boots on the shared stack (a failure only under
//      CN_RESIDENCY_STRICT). Ops warnings (e.g. a default Aliyun RDS suffix
//      that does not prove the region) are logged too.
//   2. Configuration problems that would otherwise be silent, logged once:
//        - ALLOWED_BRANDS / BRAND_LOCK names no brand (the deployment then
//          serves RoboApply only)                                    error
//        - a half-set GoApply settings group (CN_S3_ENDPOINT without
//          CN_S3_BUCKET, CN_LIVEKIT_API_KEY without CN_LIVEKIT_URL, …): the
//          CN_ values are ignored and the shared set is used         warning
//          Under CN_RESIDENCY_STRICT a half-set STORAGE group refuses the
//          boot: the operator asked for a mainland bucket and would get the
//          shared one.
//        - an unknown CN_RECRUITMENT_INFO_MODE value (the feed is ON)  error
//        - an unknown CN_STORAGE_MODE value (read as discard)          error
//        - an unknown CN_SIGNUP_MODE value (sign-up stays OPEN)        error
//        - a GoApply content-safety setting that is not valid, so the
//          built-in keyword filter runs instead                       warning
//      The GoApply lines are skipped on a deployment that does not serve it.
//   3. Assistant tools (WP-14 / WP-50): `assertCopilotModelSupportsTools()`
//      runs for the brands this deployment serves whose `copilot` capability
//      is on (platform/flags.ts). Every deployment serves both brands unless
//      ALLOWED_BRANDS / BRAND_LOCK narrows it, so by default both are
//      checked; GoApply is checked on the model it really resolves (the
//      shared one when it has none of its own). A brand with the capability
//      off is not checked: its Assistant has no entry and its router answers
//      404/503, so turning the switch off (FLAG_<BRAND>_COPILOT=false)
//      always lets the deployment boot.
//        production      a model that cannot stream tool calls (or that the
//                        brand policy refuses) refuses to boot, like (1)
//        anything else   a warning per brand; `npm run dev` and tests that
//                        import app.ts boot without a copilot model
//   4. Capability probes: registers `voiceAvailable` (interview-engine/providers)
//      behind the `ai.interviewVoice` flag and `wechatPayReadiness`
//      (platform/billing/rails/wechatpay) behind `pay.wechatpay`.

import { voiceAvailable } from '../interview-engine/providers/index.js';
import { wechatPayReadiness } from './billing/rails/wechatpay.js';
import { brandEnvGroupProblems, cnResidencyStrict, type BrandEnvGroupProblem } from './brand/brandEnv.js';
import { getBrand, type BrandId } from './brand/registry.js';
import { allowedBrands, allowedBrandsProblem } from './brand/runtime.js';
import { cnRecruitmentInfoModeProblem, isEnabledForBrand, setVoiceAvailabilityProbe, setWechatPayReadinessProbe } from './flags.js';
import { contentSafetyReadiness } from './llm/contentSafety/config.js';
import { assertCopilotModelSupportsTools } from './llm/index.js';
import { ResidencyStartupError, assertResidencyAtStartup, cnStorageModeProblem } from './residency/index.js';

export interface StartupLog {
  info(scope: string, message: string, meta?: Record<string, unknown>): void;
  warn(scope: string, message: string, meta?: Record<string, unknown>): void;
  error(scope: string, message: string, meta?: Record<string, unknown>): void;
}

export interface StartupDeps {
  env?: NodeJS.ProcessEnv;
  log: StartupLog;
  /** Called on a blocking failure off Vercel. Defaults to process.exit. */
  exit?: (code: number) => never;
  residency?: typeof assertResidencyAtStartup;
  copilotTools?: typeof assertCopilotModelSupportsTools;
  /** Whether the `copilot` capability is on for a brand. Defaults to the flag resolver. */
  copilotEnabled?: (brand: BrandId) => boolean;
  /**
   * The raw `CN_SIGNUP_MODE` value when it is set and is not a known mode, else
   * null. Defaults to the sign-up policy's own detector (features/auth-cn
   * `cnSignupModeProblem`), loaded lazily and only when the variable is set.
   */
  signupModeProblem?: (env: NodeJS.ProcessEnv) => string | null | Promise<string | null>;
}

/** One brand whose Assistant model cannot be used. */
export interface AssistantModelFailure {
  brand: BrandId;
  problem: string;
  selector: string | null;
}

/** Production boot refused: the Assistant is on for a brand whose model cannot run it. */
export class AssistantModelStartupError extends Error {
  readonly code = 'assistant_model_unusable' as const;
  readonly failures: AssistantModelFailure[];
  constructor(failures: AssistantModelFailure[]) {
    const lines = failures.map((f) => `${f.brand}: ${f.problem} (selector ${f.selector ?? '(none)'})`);
    super(
      `The Assistant (copilot) model cannot be used: ${lines.join('; ')}. ` +
        'Set LLM_COPILOT_MODEL (GoApply: CN_LLM_COPILOT_MODEL, else the shared one) to an allowed model that can stream tool calls, ' +
        'or turn the Assistant off for that brand (FLAG_<BRAND>_COPILOT=false).',
    );
    this.name = 'AssistantModelStartupError';
    this.failures = failures;
  }
}

/** Brands served by this deployment whose `copilot` capability is on. */
export function copilotBrands(env: NodeJS.ProcessEnv = process.env, enabled?: (brand: BrandId) => boolean): BrandId[] {
  const on = enabled ?? ((id: BrandId) => isEnabledForBrand('copilot', getBrand(id), env));
  return allowedBrands(env).filter((id) => on(id));
}

function assertAssistantModel(deps: StartupDeps, env: NodeJS.ProcessEnv): void {
  const copilotTools = deps.copilotTools ?? assertCopilotModelSupportsTools;
  const production = env.NODE_ENV === 'production';

  let brands: BrandId[];
  let failures: AssistantModelFailure[];
  try {
    brands = copilotBrands(env, deps.copilotEnabled);
    if (brands.length === 0) return; // capability off everywhere: nothing can call the Assistant
    failures = copilotTools({ brands, throwOnError: false })
      .filter((check) => !check.ok)
      .map((check) => ({ brand: check.brand, problem: check.problem ?? 'unknown problem', selector: check.route.selector ?? null }));
  } catch (err) {
    // A fault in the check itself is not evidence about the model: report it, keep serving.
    const meta = { error: err instanceof Error ? err.message : String(err) };
    if (production) deps.log.error('STARTUP', 'Assistant model check could not run', meta);
    else deps.log.warn('STARTUP', 'Assistant model check could not run', meta);
    return;
  }
  if (failures.length === 0) return;

  if (!production) {
    for (const f of failures) {
      deps.log.warn('STARTUP', `Assistant model for ${f.brand} cannot be used: ${f.problem}`, { brand: f.brand, selector: f.selector });
    }
    return;
  }
  const error = new AssistantModelStartupError(failures);
  deps.log.error('STARTUP', error.message, { brands: failures.map((f) => f.brand) });
  if (!env.VERCEL) (deps.exit ?? ((code: number) => process.exit(code)))(1);
  throw error;
}

/**
 * The sign-up policy owns the rule for `CN_SIGNUP_MODE`; startup only reports
 * what it says. Loaded lazily (the area is a feature module, and the question
 * exists only when the variable is set). An area without the detector answers
 * null: nothing is reported rather than a second copy of the rule kept here.
 */
async function defaultSignupModeProblem(env: NodeJS.ProcessEnv): Promise<string | null> {
  const AUTH_CN = '../features/auth-cn/index.js';
  const area = (await import(/* @vite-ignore */ AUTH_CN)) as { cnSignupModeProblem?: (env: NodeJS.ProcessEnv) => string | null };
  return typeof area.cnSignupModeProblem === 'function' ? area.cnSignupModeProblem(env) : null;
}

/** Logged after boot (the check is asynchronous); a fault in it is never fatal. */
function reportSignupModeProblem(deps: StartupDeps, env: NodeJS.ProcessEnv): void {
  if (!(env.CN_SIGNUP_MODE ?? '').trim()) return;
  void Promise.resolve()
    .then(() => (deps.signupModeProblem ?? defaultSignupModeProblem)(env))
    .then((value) => {
      if (value === null || value === undefined) return;
      deps.log.error('STARTUP', `unknown CN_SIGNUP_MODE value ${JSON.stringify(value)}; GoApply sign-up is OPEN. Use invite or closed.`, { value });
    })
    .catch(() => undefined);
}

/** Production boot refused under CN_RESIDENCY_STRICT: GoApply's bucket settings are half set, so it would use the shared bucket. */
export class StrictStorageGroupStartupError extends Error {
  readonly code = 'cn_storage_group_incomplete' as const;
  readonly problem: BrandEnvGroupProblem;
  constructor(problem: BrandEnvGroupProblem) {
    super(
      `Refusing to start: CN_RESIDENCY_STRICT is on and GoApply storage settings ${problem.set.join(', ')} are set without ${problem.missingAnchors.join(', ')}. ` +
        'The whole group would be ignored and GoApply would use the shared bucket.',
    );
    this.name = 'StrictStorageGroupStartupError';
    this.problem = problem;
  }
}

/**
 * Report configuration that would otherwise fail silently (see the header,
 * step 2). Variable names and operator-typed tokens only, never a secret.
 * Returns the storage group problem that must refuse the boot under the
 * strict switch, if any.
 */
function reportConfigurationProblems(deps: StartupDeps, env: NodeJS.ProcessEnv): BrandEnvGroupProblem | null {
  const scope = allowedBrandsProblem(env);
  if (scope) {
    const tokens = scope.invalid.map((i) => `${i.variable}=${JSON.stringify(i.token)}`).join(', ');
    const serves = scope.serves.join(', ');
    deps.log.error(
      'STARTUP',
      scope.failedClosed
        ? `ALLOWED_BRANDS / BRAND_LOCK names no brand: ${tokens}. This deployment serves ${serves} only.`
        : `ALLOWED_BRANDS / BRAND_LOCK has a value that is not a brand: ${tokens}. It is ignored; this deployment serves ${serves}.`,
      { invalid: scope.invalid, serves: scope.serves, failedClosed: scope.failedClosed },
    );
  }

  if (!allowedBrands(env).includes('goapply')) return null;

  let strictStorage: BrandEnvGroupProblem | null = null;
  for (const problem of brandEnvGroupProblems('goapply', env)) {
    deps.log.warn(
      'STARTUP',
      `GoApply ${problem.group} settings ${problem.set.join(', ')} are ignored because ${problem.missingAnchors.join(', ')} is not set; ` +
        `GoApply uses the shared ${problem.group} stack.`,
      { group: problem.group, set: problem.set, missingAnchors: problem.missingAnchors },
    );
    if (problem.group === 'storage' && cnResidencyStrict(env)) strictStorage = problem;
  }

  const mode = cnRecruitmentInfoModeProblem(env);
  if (mode !== null) {
    deps.log.error('STARTUP', `unknown CN_RECRUITMENT_INFO_MODE value ${JSON.stringify(mode)}; the job feed is ON. Use off to close it.`, { value: mode });
  }

  const storageMode = cnStorageModeProblem(env);
  if (storageMode !== null) {
    deps.log.error(
      'STARTUP',
      `unknown CN_STORAGE_MODE value ${JSON.stringify(storageMode)}; it is read as discard (no original file is kept and resume text is redacted). Use store, redact or discard.`,
      { value: storageMode },
    );
  }

  reportSignupModeProblem(deps, env);

  // An invalid CN_CONTENT_SAFETY_* setting no longer turns GoApply AI off: the
  // built-in keyword filter runs instead (`degraded`, platform/llm/contentSafety).
  // Say so once at boot. A readiness report without that field reports nothing here.
  const safety = contentSafetyReadiness(env) as ReturnType<typeof contentSafetyReadiness> & { degraded?: boolean };
  if (safety.degraded === true) {
    deps.log.warn(
      'STARTUP',
      `GoApply content safety settings are not valid (${safety.problems.join('; ') || 'unknown problem'}); the built-in keyword filter is used.`,
      { provider: safety.provider, problems: safety.problems },
    );
  }
  return strictStorage;
}

export function runStartupAssertions(deps: StartupDeps): void {
  const env = deps.env ?? process.env;
  const residency = deps.residency ?? assertResidencyAtStartup;
  const refuse = () => {
    if (!env.VERCEL) (deps.exit ?? ((code: number) => process.exit(code)))(1);
  };

  // `ai.interviewVoice` asks the interview engine whether the brand's media
  // plane can run; `pay.wechatpay` asks the rail whether it may take money.
  setVoiceAvailabilityProbe(voiceAvailable);
  setWechatPayReadinessProbe((brand, probeEnv) => wechatPayReadiness(brand, probeEnv).ready);

  try {
    const report = residency(env);
    // Provider checks that did not pass on the mainland stack: GoApply runs on
    // the shared stack for that part (they are failures under CN_RESIDENCY_STRICT).
    for (const advisory of report.advisories ?? []) {
      deps.log.warn('STARTUP', `Residency: [${advisory.code}] ${advisory.message}`, { region: report.region, code: advisory.code });
    }
    for (const warning of report.warnings) deps.log.warn('STARTUP', `Residency: ${warning}`, { region: report.region });
  } catch (err) {
    if (err instanceof ResidencyStartupError) {
      deps.log.error('STARTUP', err.message, { failures: err.failures.map((f) => f.code) });
      refuse();
    }
    throw err;
  }

  const strictStorage = reportConfigurationProblems(deps, env);
  if (strictStorage) {
    const error = new StrictStorageGroupStartupError(strictStorage);
    deps.log.error('STARTUP', error.message, { group: strictStorage.group, set: strictStorage.set, missingAnchors: strictStorage.missingAnchors });
    refuse();
    throw error;
  }

  assertAssistantModel(deps, env);
}
