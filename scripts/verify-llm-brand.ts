#!/usr/bin/env tsx
/**
 * Show how each LLM task resolves per brand (WP-14, TASK_PLAN R-13).
 *
 *   npx tsx scripts/verify-llm-brand.ts                     # both brands, resolution only
 *   npx tsx scripts/verify-llm-brand.ts --brand goapply     # one brand
 *   npx tsx scripts/verify-llm-brand.ts --brand goapply --probe   # also send a 1-token probe
 *   npx tsx scripts/verify-llm-brand.ts --json              # machine-readable
 *   npx tsx scripts/verify-llm-brand.ts --db                # include admin DB overrides
 *   npx tsx scripts/verify-llm-brand.ts --require-priced    # also fail on unpriced models
 *
 * For every task (default, fallback, matching, extract, onboarding, rewrite,
 * interview, copilot, enrich, writing) it prints the env variable the brand
 * reads (CN_* on GoApply, never the unprefixed one), the selector, provider,
 * endpoint host, whether a key is present, whether the brand policy allows
 * the route, whether the model is priced in the cost table, and for the
 * copilot task whether the provider can stream tool calls.
 *
 * It never calls a model unless --probe is given, and even then only routes
 * that have a key and that the policy allows (the probe carries no user
 * data). Without --db, admin DB overrides are skipped (LLM_SETTINGS_DB_DISABLED)
 * so the script needs no database.
 *
 * Exit code 1 when a configured route is refused by the brand policy or the
 * copilot model cannot stream tools; 0 otherwise. Missing keys or models are
 * reported, not failed (GoApply AI is simply hidden until configured).
 * With --require-priced, every configured model-selector env var of both
 * brands (ALL_BRAND_MODEL_ENV_VARS, CN_* included) must also have a
 * cost-table row, or the exit code is 1.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const REPO_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
dotenv.config({ path: resolve(REPO_ROOT, '.env'), override: false, quiet: true });
dotenv.config({ path: resolve(REPO_ROOT, '.env.local'), override: false, quiet: true });

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const valueOf = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
};

if (!flag('--db')) process.env.LLM_SETTINGS_DB_DISABLED = 'true';
// Keep the logger quiet: this is a report, not a server.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'ERROR';

const { BRAND_IDS, getBrand, isBrandId } = await import('../server/src/platform/brand/registry.js');
const { runWithBrand } = await import('../server/src/lib/requestContext.js');
const { LLM_TASKS } = await import('../server/src/lib/llm/llmTaskSettings.js');
const { ALL_BRAND_MODEL_ENV_VARS, MODEL_ENV } = await import('../server/src/lib/llm/llmStackConfigSchema.js');
const { lookupModelRate } = await import('../server/src/lib/modelPricing.js');
const { llmService } = await import('../server/src/services/llm/LLMService.js');

type BrandId = (typeof BRAND_IDS)[number];

const requested = valueOf('--brand');
const brandAliases: Record<string, BrandId> = { cn: 'goapply', intl: 'roboapply' };
const brands: BrandId[] = !requested || requested === 'all'
  ? [...BRAND_IDS]
  : (() => {
      const id = brandAliases[requested] ?? requested;
      if (!isBrandId(id)) {
        console.error(`Unknown brand "${requested}". Use roboapply, goapply (or intl, cn) or all.`);
        process.exit(2);
      }
      return [id];
    })();

const TASK_ENV: Record<string, string> = {
  default: MODEL_ENV.defaultModel,
  fallback: MODEL_ENV.fallbackModel,
  ...Object.fromEntries(LLM_TASKS.map((t) => [t, MODEL_ENV[t]])),
};

function priced(model: string | null): boolean | null {
  if (!model) return null;
  const candidates = [model, model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model];
  return candidates.some((id) => lookupModelRate(id) !== null);
}

interface Row {
  brand: BrandId;
  task: string;
  envName: string;
  selector: string | null;
  inheritsDefault: boolean;
  provider: string | null;
  model: string | null;
  host: string | null;
  hasKey: boolean;
  allowed: boolean;
  policy: string;
  priced: boolean | null;
  tools: boolean | null;
  probe?: string;
}

const rows: Row[] = [];
let violations = 0;

for (const brandId of brands) {
  const brand = getBrand(brandId);
  const tasks = ['default', 'fallback', ...LLM_TASKS] as const;
  for (const task of tasks) {
    const route = runWithBrand(brandId, () => llmService.explainRoute(task, brandId));
    const row: Row = {
      brand: brandId,
      task,
      envName: `${brand.llmEnvPrefix}${TASK_ENV[task]}`,
      selector: route.selector,
      inheritsDefault: route.inheritsDefault,
      provider: route.providerType,
      model: route.model,
      host: route.host,
      hasKey: route.hasKey,
      allowed: route.allowed,
      policy: route.selector ? (route.allowed ? 'allowed' : `REFUSED ${route.policyCode ?? ''}`.trim()) : 'not configured',
      priced: priced(route.model),
      tools: task === 'copilot' && route.selector ? route.toolsSupported : null,
    };
    if (route.selector && !route.allowed) violations += 1;
    if (task === 'copilot' && route.selector && route.allowed && !route.toolsSupported) violations += 1;
    if (flag('--probe') && route.selector && route.allowed && route.hasKey) {
      const result = await runWithBrand(brandId, () => llmService.probeModel(route.selector as string, brandId));
      row.probe = result.ok ? `ok ${result.latencyMs}ms` : `failed: ${(result.error ?? '').slice(0, 120)}`;
    } else if (flag('--probe')) {
      row.probe = 'skipped';
    }
    rows.push(row);
  }
}

/** Configured selectors (both brands, every purpose) with no cost-table row. */
const unpriced: Array<{ envName: string; selector: string }> = [];
for (const envName of ALL_BRAND_MODEL_ENV_VARS) {
  const selector = (process.env[envName] ?? '').trim();
  if (!selector) continue;
  // Peel routing prefixes the way LLMService does before billing.
  const segments = selector.split('/');
  const candidates = segments.map((_, i) => segments.slice(i).join('/'));
  if (!candidates.some((id) => lookupModelRate(id) !== null)) unpriced.push({ envName, selector });
}
if (flag('--require-priced')) violations += unpriced.length;

if (flag('--json')) {
  console.log(JSON.stringify({ brands, rows, unpriced, violations }, null, 2));
} else {
  for (const brandId of brands) {
    const brand = getBrand(brandId);
    console.log(`\n${brand.name} (${brandId}, llmProfile=${brand.llmProfile}, env prefix "${brand.llmEnvPrefix}")`);
    for (const r of rows.filter((x) => x.brand === brandId)) {
      const parts = [
        r.task.padEnd(10),
        r.inheritsDefault ? `${r.envName}=(unset, uses ${brand.llmEnvPrefix}LLM_MODEL ${r.selector})` : `${r.envName}=${r.selector ?? '(unset)'}`,
        r.provider ? `→ ${r.provider}/${r.model} @ ${r.host ?? '?'}` : '',
        r.selector ? `key ${r.hasKey ? 'yes' : 'MISSING'}` : '',
        r.policy,
        r.priced === false ? 'UNPRICED (add a modelCostTable row)' : '',
        r.tools === null ? '' : r.tools ? 'tools ok' : 'TOOLS UNSUPPORTED',
        r.probe ? `probe ${r.probe}` : '',
      ].filter(Boolean);
      console.log(`  ${parts.join('  ')}`);
    }
  }
  if (unpriced.length > 0) {
    console.log('\nConfigured models with no cost-table row (bill at the default tier):');
    for (const u of unpriced) console.log(`  ${u.envName}=${u.selector}`);
  }
  console.log(
    violations
      ? `\n${violations} violation(s): brand policy, tool requirement${flag('--require-priced') ? ' or missing price' : ''}.`
      : '\nNo policy violations.',
  );
}

process.exit(violations > 0 ? 1 : 0);
