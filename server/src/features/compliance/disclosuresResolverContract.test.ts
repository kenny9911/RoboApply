// @vitest-environment node
//
// Contract check between the disclosures and the model resolver
// (GOAPPLY_PARITY_PLAN.md §3.3 and §5: "getModelSetting / getProviderSetting
// fall back to the shared stack", provider PAR-2, consumer PAR-5).
//
// The disclosures resolve each model setting per key from the same sources as
// the resolver, and keep the stack every value comes from, so they can name
// the vendor a request really goes to. This file compares the two answers:
// for every disclosed task, "this row is a mainland vendor" must equal "the
// resolver routes this task to a mainland provider".
//
// The resolver's per-key fallback (and its routing helpers) arrive with the
// LLM bundle. Until that bundle is merged the comparison cannot be made and
// the test is skipped; after the merge it runs by itself.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import * as llmModels from '../../lib/llm/llmModels.js';
import * as providerPrefixes from '../../services/llm/providerPrefixes.js';
import { GOAPPLY_DIRECT_PROVIDERS } from '../../platform/llm/brandPolicy.js';
import { getBrand } from '../../platform/brand/registry.js';
import { LLM_TASK_KEYS, VENDOR_COUNTRY, aiLeavesMainland, configuredModels } from './disclosures.js';

type Env = Record<string, string | undefined>;
interface RoutingDefaults {
  profile: 'global' | 'domestic_cn';
  providerMode: string;
  model: string | undefined;
}
interface ResolverSeam {
  getModelSetting: (key: string, brand: string, env: Env) => string | undefined;
  getLlmRoutingDefaults: (brand: string, env: Env) => RoutingDefaults;
}
interface RouteSeam {
  resolveSelectorRoute: (selector: string, providerMode: string, defaultModel: string | null | undefined, profile: 'global' | 'domestic_cn') => { providerType: string; model: string };
}

const resolver = llmModels as unknown as Partial<ResolverSeam>;
const routes = providerPrefixes as unknown as Partial<RouteSeam>;
const merged = typeof resolver.getLlmRoutingDefaults === 'function' && typeof routes.resolveSelectorRoute === 'function';

const goapply = getBrand('goapply');

const ENVS: Array<[name: string, env: Env]> = [
  ['shared stack only', { LLM_PROVIDER: 'openrouter', LLM_MODEL: 'openrouter/google/gemini-x', LLM_COPILOT_MODEL: 'openai/gpt-5' }],
  ['shared stack, a bare id', { LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-5' }],
  ['shared stack, a gateway id with a mainland vendor name', { LLM_PROVIDER: 'openrouter', LLM_MODEL: 'qwen/qwen3.8-flash' }],
  ['its own stack', { CN_LLM_PROVIDER: 'deepseek', CN_LLM_MODEL: 'deepseek-chat', CN_LLM_FALLBACK_MODEL: 'qwen/qwen-plus' }],
  [
    'mixed: its own provider, the vision model from the shared stack as a bare id',
    { LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-5', LLM_VISION_MODEL: 'gpt-5-vision', CN_LLM_PROVIDER: 'deepseek', CN_LLM_MODEL: 'deepseek-chat' },
  ],
  [
    'mixed: its own provider, a shared gateway id',
    { LLM_PROVIDER: 'openrouter', LLM_MODEL: 'openrouter/x/y', LLM_ENRICH_MODEL: 'qwen/qwen3.8-flash', CN_LLM_PROVIDER: 'deepseek', CN_LLM_MODEL: 'deepseek-chat' },
  ],
  ['its own provider abroad', { CN_LLM_PROVIDER: 'openrouter', CN_LLM_MODEL: 'openai/gpt-5' }],
  // CN_LLM_MODEL alone starts the own profile; a bare id has no route there (boot reports it, platform/startup.ts
  // `cnDefaultModelHasNoRoute`). Nothing is sent, and the disclosures never call it a mainland vendor.
  ['its own model as a bare id and no provider of its own (no route)', { LLM_PROVIDER: 'openrouter', LLM_MODEL: 'openai/gpt-5', CN_LLM_MODEL: 'deepseek-chat' }],
  ['its own model with a vendor prefix and no provider of its own', { LLM_PROVIDER: 'openrouter', LLM_MODEL: 'openai/gpt-5', CN_LLM_MODEL: 'deepseek/deepseek-chat' }],
];

describe('disclosures agree with the model resolver on where each task goes', () => {
  beforeEach(() => vi.stubEnv('LLM_SETTINGS_DB_DISABLED', 'true'));
  afterEach(() => vi.unstubAllEnvs());

  it.runIf(merged)('a task is disclosed with a mainland vendor exactly when the resolver routes it to a mainland provider', () => {
    const mainland = (provider: string) => (GOAPPLY_DIRECT_PROVIDERS as readonly string[]).includes(provider);
    for (const [name, env] of ENVS) {
      const defaults = resolver.getLlmRoutingDefaults!('goapply', env);
      let anyAbroad = false;
      for (const [task, key] of LLM_TASK_KEYS) {
        const selector = resolver.getModelSetting!(key, 'goapply', env);
        if (!selector) continue;
        const route = routes.resolveSelectorRoute!(selector, defaults.providerMode, defaults.model, defaults.profile);
        if (!mainland(route.providerType)) anyAbroad = true;
        // The row that covers this task (rows are deduplicated by vendor and model).
        const rows = configuredModels(goapply, env);
        const covered = rows.some((r) => (VENDOR_COUNTRY[r.vendor] === 'CN') === mainland(route.providerType));
        expect(covered, `${name}: ${task} (${selector} → ${route.providerType})`).toBe(true);
      }
      expect(aiLeavesMainland(goapply, env), name).toBe(anyAbroad);
    }
  });

  it('until the resolver seam is merged the disclosures still answer by the plan order (pinned here so the gated test above is not the only check)', () => {
    const mixed = ENVS[4]![1];
    expect(configuredModels(goapply, mixed).map((m) => `${m.task}:${m.vendor}:${m.region}:${m.source}`)).toEqual(['default:deepseek:CN:own', 'vision:openai:US:shared']);
    expect(aiLeavesMainland(goapply, ENVS[3]![1])).toBe(false);
    expect(aiLeavesMainland(goapply, ENVS[5]![1])).toBe(true);
    expect(aiLeavesMainland(goapply, ENVS[6]![1])).toBe(true);
  });
});
