#!/usr/bin/env tsx
/**
 * Show how each LLM task resolves per brand (owner ruling D5;
 * GOAPPLY_PARITY_PLAN.md §3.3).
 *
 *   npx tsx scripts/verify-llm-brand.ts                     # both brands, resolution only
 *   npx tsx scripts/verify-llm-brand.ts --brand goapply     # one brand
 *   npx tsx scripts/verify-llm-brand.ts --brand goapply --probe   # also send a 1-token probe
 *   npx tsx scripts/verify-llm-brand.ts --json              # machine-readable
 *   npx tsx scripts/verify-llm-brand.ts --db                # include admin DB overrides
 *   npx tsx scripts/verify-llm-brand.ts --require-priced    # also fail on unpriced models
 *
 * Per brand it prints the effective LLM profile (GoApply is `global` on the
 * shared stack and `domestic_cn` only with a provider or default model of its
 * own), the provider mode with its source, and whether the domestic-only wall
 * (CN_LLM_DOMESTIC_ONLY) is on. For every task (default, fallback, matching,
 * extract, onboarding, rewrite, interview, copilot, enrich, writing) it prints
 * where the value is really set and its source: `own` (the brand's own
 * variable, CN_* on GoApply, or its own admin override) or `shared` (the
 * unprefixed variable, or RoboApply's admin override, that GoApply falls back
 * to per key). A value that comes from an admin override (--db) is shown as
 * `admin override (<AppConfig key>)`, never as an environment variable. Then
 * the resolved selector (a shared selector read by GoApply's own stack is
 * shown qualified, as it runs), provider, endpoint host, whether a key is
 * present, whether the brand policy allows the route, whether the model is
 * priced in the cost table, and for the copilot task whether the provider can
 * stream tool calls. Behind the domestic-only wall a shared value that names
 * no mainland vendor is not used: the row says so and shows what runs instead.
 *
 * It never calls a model unless --probe is given, and even then only routes
 * that have a key and that the policy allows (the probe carries no user
 * data). Without --db, admin DB overrides are skipped (LLM_SETTINGS_DB_DISABLED)
 * so the script needs no database. With --db it reads both brands' override
 * rows (AppConfig) once before resolving anything.
 *
 * Exit code 1 when a configured route is refused by the brand policy, the
 * copilot model cannot stream tools, or the domestic-only wall is on and
 * GoApply has no mainland default model (every AI call would answer 503);
 * 0 otherwise. Other missing keys or models are reported, not failed.
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
const { ALL_BRAND_MODEL_ENV_VARS, MODEL_ENV, appConfigKeyFor, getActiveEnvironment } = await import('../server/src/lib/llm/llmStackConfigSchema.js');
const { getLlmRoutingDefaults, resolveModelKey, resolveProviderSetting } = await import('../server/src/lib/llm/llmModels.js');
const { getLlmStack, getLlmStackCacheState } = await import('../server/src/lib/llm/llmStackConfigResolver.js');
const { brandEnvName } = await import('../server/src/platform/brand/brandEnv.js');
const { llmDomesticOnlyApplies } = await import('../server/src/platform/llm/brandPolicy.js');
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

/** `own`: the brand's own variable or admin override. `shared`: the shared stack GoApply falls back to. */
type Source = 'own' | 'shared' | 'unset';
const sourceOf = (s: string | undefined): Source => (s === 'shared' ? 'shared' : s === 'override' || s === 'env' ? 'own' : 'unset');
/** The resolver's own answer: the brand's admin override, its variable, the shared stack, or nothing. */
type SettingSource = 'override' | 'env' | 'shared' | 'none';

/** The brand whose settings are the shared stack (the unprefixed names, the historical override row). */
const SHARED_BRAND: BrandId = 'roboapply';
const overrideLabel = (brandId: BrandId) => `admin override (${appConfigKeyFor(getActiveEnvironment(), brandId)})`;

// The override rows are cached in memory and read synchronously by the
// resolver: load them first, or a cold cache would show env values only.
const overrideRows: Partial<Record<BrandId, 'db' | 'empty'>> = {};
if (flag('--db')) {
  for (const brandId of BRAND_IDS) {
    await getLlmStack(brandId);
    overrideRows[brandId] = getLlmStackCacheState(brandId).source === 'db' ? 'db' : 'empty';
  }
}

interface Row {
  brand: BrandId;
  task: string;
  /**
   * Where the value is set: a variable (the brand's own name, or the shared
   * one for a `shared` value), or `admin override (<AppConfig key>)`.
   */
  envName: string;
  /** The brand's own (override) variable for the task. */
  ownEnvName: string;
  source: Source;
  /** The resolver's source for the value that runs: override, env, shared or none. */
  settingSource: SettingSource;
  /** A shared value of this task the domestic-only wall set aside (not used), with where it is set. */
  sharedNotUsed?: { envName: string; selector: string };
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

interface BrandSummary {
  brand: BrandId;
  /** The profile the brand runs on (effectiveLlmProfile). */
  profile: string;
  /** The profile its registry entry names for a stack of its own. */
  registryProfile: string;
  providerMode: string;
  providerSource: Source;
  /** Where the provider mode is set: a variable, an admin override, or the built-in default. */
  providerOrigin: string;
  /** CN_LLM_DOMESTIC_ONLY (or CN_RESIDENCY_STRICT) holds for this brand. */
  domesticOnly: boolean;
}

const rows: Row[] = [];
const summaries: BrandSummary[] = [];
/** Brands behind the domestic-only wall with no mainland default model: their AI answers 503. */
const wallWithoutModel: BrandId[] = [];
let violations = 0;

for (const brandId of brands) {
  const brand = getBrand(brandId);
  const defaults = getLlmRoutingDefaults(brandId);
  const providerSetting = resolveProviderSetting(brandId).source;
  /** Where a value with this source is set, for the variable `name` (never an env name for an override). */
  const originOf = (source: SettingSource, name: string, sharedIsOverride: boolean): string => {
    if (source === 'override') return overrideLabel(brandId);
    if (source === 'shared') return sharedIsOverride ? overrideLabel(SHARED_BRAND) : name;
    return brandEnvName(brand, name);
  };
  summaries.push({
    brand: brandId,
    profile: defaults.profile,
    registryProfile: brand.llmProfile,
    providerMode: defaults.providerMode || '(none)',
    providerSource: sourceOf(providerSetting),
    providerOrigin:
      providerSetting === 'none' ? 'default' : originOf(providerSetting, 'LLM_PROVIDER', resolveProviderSetting(SHARED_BRAND).source === 'override'),
    domesticOnly: llmDomesticOnlyApplies(brand),
  });
  const tasks = ['default', 'fallback', ...LLM_TASKS] as const;
  for (const task of tasks) {
    const route = runWithBrand(brandId, () => llmService.explainRoute(task, brandId));
    const settingSource: SettingSource = route.selector ? route.source ?? 'none' : 'none';
    const source = sourceOf(settingSource);
    // An inherited value is the default model's: name the setting it really comes from.
    const valueKey = route.inheritsDefault || task === 'default' ? 'defaultModel' : task === 'fallback' ? 'fallbackModel' : task;
    const taskKey = task === 'default' ? 'defaultModel' : task === 'fallback' ? 'fallbackModel' : task;
    const sharedName = route.inheritsDefault ? TASK_ENV.default : TASK_ENV[task];
    const ownEnvName = brandEnvName(brand, TASK_ENV[task]);
    const sharedIsOverride = (key: typeof valueKey) => resolveModelKey(key, SHARED_BRAND).source === 'override';
    const row: Row = {
      brand: brandId,
      task,
      envName: originOf(settingSource, sharedName, sharedIsOverride(valueKey)),
      ownEnvName,
      source,
      settingSource,
      ...(route.sharedWalledOff
        ? { sharedNotUsed: { envName: sharedIsOverride(taskKey) ? overrideLabel(SHARED_BRAND) : TASK_ENV[task], selector: route.sharedWalledOff } }
        : {}),
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
  if (llmDomesticOnlyApplies(brand) && !rows.some((r) => r.brand === brandId && r.task === 'default' && r.selector)) {
    wallWithoutModel.push(brandId);
    violations += 1;
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
  console.log(JSON.stringify({ brands, summaries, rows, unpriced, wallWithoutModel, violations, ...(flag('--db') ? { overrideRows } : {}) }, null, 2));
} else {
  for (const brandId of brands) {
    const brand = getBrand(brandId);
    const summary = summaries.find((x) => x.brand === brandId)!;
    console.log(
      `\n${brand.name} (${brandId}): effective profile ${summary.profile}` +
        (summary.profile === summary.registryProfile ? '' : ` (shared stack; ${summary.registryProfile} once it has a provider of its own)`) +
        `, provider mode ${summary.providerMode} [${summary.providerSource === 'unset' ? 'default' : `${summary.providerSource}: ${summary.providerOrigin}`}]` +
        (brand.llmProfile === 'domestic_cn' ? `, domestic-only wall ${summary.domesticOnly ? 'ON' : 'off'}` : '') +
        (flag('--db') ? `, admin override row ${overrideRows[brandId] === 'db' ? 'read' : 'none (or the database could not be read)'}` : ''),
    );
    for (const r of rows.filter((x) => x.brand === brandId)) {
      const parts = [
        r.task.padEnd(10),
        r.source === 'unset'
          ? `${r.ownEnvName}=(unset)`
          : r.inheritsDefault
            ? `${r.ownEnvName}=(unset, uses ${r.envName} ${r.selector})`
            : `${r.envName}=${r.selector}`,
        r.source === 'unset' ? '' : `[${r.source}]`,
        r.sharedNotUsed ? `(shared ${r.sharedNotUsed.envName}=${r.sharedNotUsed.selector} is not used behind the wall)` : '',
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
  for (const brandId of wallWithoutModel) {
    console.log(
      `\n${getBrand(brandId).name}: the domestic-only wall is on and no mainland default model is configured. ` +
        'Its AI features answer 503 (ai_unavailable) until CN_LLM_MODEL (with CN_LLM_PROVIDER, or a vendor prefix) names one.',
    );
  }
  if (unpriced.length > 0) {
    console.log('\nConfigured models with no cost-table row (bill at the default tier):');
    for (const u of unpriced) console.log(`  ${u.envName}=${u.selector}`);
  }
  console.log(
    violations
      ? `\n${violations} violation(s): brand policy, tool requirement, no mainland model behind the wall${flag('--require-priced') ? ' or missing price' : ''}.`
      : '\nNo policy violations.',
  );
}

process.exit(violations > 0 ? 1 : 0);
