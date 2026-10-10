// server/src/platform/startup.ts — boot-time checks run once by server/src/app.ts
// (Wave 2 gate wiring of WP-15 REQ-WP15-01 and the WP-14 startup check;
// WP-93 made the Assistant check blocking).
//
//   1. Residency (WP-15, CN §3): `assertResidencyAtStartup()`. A failure
//      refuses to boot: off Vercel the process exits 1; on Vercel the throw
//      fails the function's module init, so no request is served. Warnings
//      (e.g. a default Aliyun RDS suffix that does not prove the region) are
//      logged.
//   2. Assistant tools (WP-14 / WP-50): `assertCopilotModelSupportsTools()`
//      runs for the brands this deployment serves whose `copilot` capability
//      is on (platform/flags.ts: product switch AND a text model). A brand
//      with the capability off is not checked — its Assistant has no entry
//      and its router answers 404/503 — so turning the switch off
//      (FLAG_<BRAND>_COPILOT=false) always lets the deployment boot.
//        production      a model that cannot stream tool calls (or that the
//                        brand policy refuses) refuses to boot, like (1)
//        anything else   a warning per brand; `npm run dev` and tests that
//                        import app.ts boot without a copilot model
//   3. Capability probes: registers `voiceAvailable` (interview-engine/providers)
//      behind the `ai.interviewVoice` flag and `wechatPayReadiness`
//      (platform/billing/rails/wechatpay) behind `pay.wechatpay`.

import { voiceAvailable } from '../interview-engine/providers/index.js';
import { wechatPayReadiness } from './billing/rails/wechatpay.js';
import { getBrand, type BrandId } from './brand/registry.js';
import { allowedBrands } from './brand/runtime.js';
import { isEnabledForBrand, setVoiceAvailabilityProbe, setWechatPayReadinessProbe } from './flags.js';
import { assertCopilotModelSupportsTools } from './llm/index.js';
import { ResidencyStartupError, assertResidencyAtStartup } from './residency/index.js';

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
        'Set LLM_COPILOT_MODEL / CN_LLM_COPILOT_MODEL to an allowed model that can stream tool calls, ' +
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

export function runStartupAssertions(deps: StartupDeps): void {
  const env = deps.env ?? process.env;
  const residency = deps.residency ?? assertResidencyAtStartup;

  // `ai.interviewVoice` asks the interview engine whether the brand's media
  // plane can run; `pay.wechatpay` asks the rail whether it may take money.
  setVoiceAvailabilityProbe(voiceAvailable);
  setWechatPayReadinessProbe((brand, probeEnv) => wechatPayReadiness(brand, probeEnv).ready);

  try {
    const report = residency(env);
    for (const warning of report.warnings) deps.log.warn('STARTUP', `Residency: ${warning}`, { region: report.region });
  } catch (err) {
    if (err instanceof ResidencyStartupError) {
      deps.log.error('STARTUP', err.message, { failures: err.failures.map((f) => f.code) });
      if (!env.VERCEL) (deps.exit ?? ((code: number) => process.exit(code)))(1);
    }
    throw err;
  }

  assertAssistantModel(deps, env);
}
