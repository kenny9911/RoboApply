// server/src/platform/startup.ts — boot-time checks run once by server/src/app.ts
// (Wave 2 gate wiring of WP-15 REQ-WP15-01 and the WP-14 startup check).
//
//   1. Residency (WP-15, CN §3): `assertResidencyAtStartup()`. A failure
//      refuses to boot: off Vercel the process exits 1; on Vercel the throw
//      fails the function's module init, so no request is served. Warnings
//      (e.g. a default Aliyun RDS suffix that does not prove the region) are
//      logged.
//   2. Assistant tools (WP-14): `assertCopilotModelSupportsTools()` is run in
//      report-only mode and logs each brand whose copilot model cannot stream
//      tool calls. It does not block boot yet, because nothing calls the
//      Assistant until WP-50 (Wave 4); WP-50 / WP-93 switch it to blocking.

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
  /** Called on a residency failure off Vercel. Defaults to process.exit. */
  exit?: (code: number) => never;
  residency?: typeof assertResidencyAtStartup;
  copilotTools?: typeof assertCopilotModelSupportsTools;
}

export function runStartupAssertions(deps: StartupDeps): void {
  const env = deps.env ?? process.env;
  const residency = deps.residency ?? assertResidencyAtStartup;
  const copilotTools = deps.copilotTools ?? assertCopilotModelSupportsTools;

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

  try {
    for (const check of copilotTools({ throwOnError: false })) {
      if (!check.ok) {
        deps.log.warn('STARTUP', `Assistant model for ${check.brand} cannot be used: ${check.problem ?? 'unknown problem'}`, {
          brand: check.brand,
          selector: check.route.selector ?? null,
        });
      }
    }
  } catch (err) {
    deps.log.warn('STARTUP', 'Assistant model check could not run', { error: err instanceof Error ? err.message : String(err) });
  }
}
