/**
 * LLM gateway — what the admin page reads and saves.
 *
 * Two things are managed, for the ACTIVE environment only:
 *  - provider entries (gatewayProviders.ts): name, type, base URL, key, models;
 *  - area assignments (`routes` in the stack blob, llmStackConfigSchema.ts):
 *    per functionality area and brand, one provider entry and model with its
 *    reasoning effort, and up to three ordered fallback models.
 *
 * The overview also shows, for every model key of an area, what a call
 * resolves to right now and where that value comes from (the area, the
 * Default area it inherits, a saved per-key setting, the env), so an
 * unassigned area is never a blank.
 */

import type { BrandId } from '../../platform/brand/registry.js';
import { PROVIDER_DEFAULT_BASE_URLS } from '../../platform/llm/egressPolicy.js';
import { providerBaseType, providerEntryId, providerRouteTag, splitSelectorPrefix } from '../../services/llm/providerPrefixes.js';
import { supportsToolStreaming } from '../../services/llm/toolStreaming.js';
import {
  GATEWAY_PROVIDER_TYPES,
  GatewayProviderError,
  MAX_PROVIDERS,
  baseUrlRequirement,
  deleteGatewayProvider,
  listGatewayProviders,
  warmupGatewayProviders,
  type GatewayProviderSummary,
  type GatewayProviderType,
} from './gatewayProviders.js';
import { getDefaultModel, resolveModelKey, type LlmSettingSource } from './llmModels.js';
import { getLlmStack, getLlmStackForEnvironment, saveLlmStack } from './llmStackConfigResolver.js';
import {
  AREAS_NEEDING_IMAGES,
  AREAS_NEEDING_TOOLS,
  AREA_MODEL_KEYS,
  DEFAULT_GATEWAY_EFFORT,
  GATEWAY_EFFORTS,
  LLM_AREAS,
  MAX_AREA_FALLBACKS,
  areaOfRouteTag,
  getActiveEnvironment,
  isDbConfigDisabled,
  isGatewayEffort,
  isLlmArea,
  type ConfigEnvironment,
  type GatewayEffort,
  type LlmArea,
  type LlmAreaRoute,
  type LlmRouteTarget,
  type LlmStackBrand,
  type ModelKey,
} from './llmStackConfigSchema.js';

const MAX_MODEL_ID = 200;

export interface GatewayProviderTypeInfo {
  type: GatewayProviderType;
  baseUrl: 'required' | 'optional' | 'forbidden';
  defaultBaseUrl: string | null;
  /** Its client can stream tool calls (needed by the Assistant area). */
  tools: boolean;
}

/** Why an assignment is not in effect; `ok` when it is. */
export type AreaRouteStatus = 'ok' | 'provider_missing' | 'provider_disabled' | 'provider_key_missing' | 'provider_key_unreadable';

/**
 * Where a key's value comes from, in the order a call reads them:
 * `area` (its area's assignment), `default` (the Default area's, for an
 * unassigned area), `override` (a saved per-key setting), `env`, `shared`
 * (RoboApply's settings, read by GoApply for a key it does not set), `none`
 * (the call uses the default model).
 */
export type GatewayKeyVia = 'area' | 'default' | 'override' | 'env' | 'shared' | 'none';

export interface GatewayKeyResolution {
  key: ModelKey;
  /** The env variable that supplies the key when nothing is assigned. */
  envName: string;
  /** The selector a call uses now; null when the key has no value of its own. */
  effective: string | null;
  source: LlmSettingSource;
  via: GatewayKeyVia;
  /** The value is an assignment of RoboApply's (GoApply reading the shared stack). */
  shared: boolean;
  /** The provider entry the selector names, when it names one. */
  providerId: string | null;
  /** Provider type of the selector's routing prefix, when it has one. */
  providerType: string | null;
  /** The model id sent upstream (routing prefix removed). */
  model: string | null;
}

export interface GatewayAreaView {
  area: LlmArea;
  route: LlmAreaRoute | null;
  /** Null when the area is not assigned. */
  routeStatus: AreaRouteStatus | null;
  /** The assigned model is in the entry's fetched model list (null: no list, or not assigned). */
  modelListed: boolean | null;
  /** Per fallback of `route`, in order: whether it can be used now. */
  fallbackStatus: AreaRouteStatus[];
  /** Per fallback of `route`: its model is in the entry's list (null: no list). */
  fallbackListed: (boolean | null)[];
  needsTools: boolean;
  needsImages: boolean;
  /** Unassigned, and at least one of its keys runs on the Default area's assignment. */
  inheritsDefault: boolean;
  keys: GatewayKeyResolution[];
}

export interface GatewayOverview {
  environment: ConfigEnvironment;
  brand: LlmStackBrand;
  /** LLM_SETTINGS_DB_DISABLED: saved settings are ignored at runtime. */
  dbDisabled: boolean;
  /** FIELD_ENCRYPTION_KEY is set, so keys can be stored. */
  encryptionReady: boolean;
  maxProviders: number;
  /** Fallback models per assignment. */
  maxFallbacks: number;
  /** The reasoning-effort choices, and the one a new assignment starts with. */
  efforts: readonly GatewayEffort[];
  defaultEffort: GatewayEffort;
  providerTypes: GatewayProviderTypeInfo[];
  providers: GatewayProviderSummary[];
  areas: GatewayAreaView[];
  /** The default model selector every unset key ends on (null: none configured). */
  defaultModel: string | null;
  updatedAt: string | null;
}

export class GatewayRouteError extends Error {
  constructor(
    readonly code:
      | 'invalid_area'
      | 'invalid_route'
      | 'unknown_provider'
      | 'tools_unsupported'
      | 'provider_in_use'
      | 'invalid_effort'
      | 'invalid_fallback'
      | 'duplicate_fallback'
      | 'too_many_fallbacks',
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'GatewayRouteError';
  }
}

function providerTypes(): GatewayProviderTypeInfo[] {
  return GATEWAY_PROVIDER_TYPES.map((type) => ({
    type,
    baseUrl: baseUrlRequirement(type),
    defaultBaseUrl: PROVIDER_DEFAULT_BASE_URLS[type] ?? null,
    tools: supportsToolStreaming(type),
  }));
}

function statusOf(route: Pick<LlmRouteTarget, 'providerId'>, providers: Map<string, GatewayProviderSummary>): AreaRouteStatus {
  const p = providers.get(route.providerId);
  if (!p) return 'provider_missing';
  if (!p.enabled) return 'provider_disabled';
  if (p.keyUnreadable) return 'provider_key_unreadable';
  if (!p.usable) return 'provider_key_missing';
  return 'ok';
}

function listed(target: LlmRouteTarget, providers: Map<string, GatewayProviderSummary>): boolean | null {
  const entry = providers.get(target.providerId);
  return entry && entry.models.length > 0 ? entry.models.includes(target.model) : null;
}

function resolveKey(key: ModelKey, brand: LlmStackBrand): GatewayKeyResolution {
  const r = resolveModelKey(key, brand as BrandId);
  const split = r.effective ? splitSelectorPrefix(r.effective, 'global') : null;
  // A gateway assignment's selector names its area (`newapi@aigw:visual/…`).
  const routeArea = split ? areaOfRouteTag(providerRouteTag(split.providerType)) : null;
  const via: GatewayKeyVia = routeArea ? (routeArea === 'default' && key !== 'defaultModel' ? 'default' : 'area') : r.source;
  return {
    key,
    envName: r.envName,
    effective: r.effective,
    source: r.source,
    via,
    shared: r.source === 'shared',
    providerId: split ? providerEntryId(split.providerType) : null,
    providerType: split ? providerBaseType(split.providerType) : null,
    model: r.effective ? (split ? split.model : r.effective) : null,
  };
}

/** Everything the admin page shows, read fresh (the runtime caches are warmed first). */
export async function getGatewayOverview(brand: LlmStackBrand): Promise<GatewayOverview> {
  const env = getActiveEnvironment();
  // Warm both blobs and the entries so the per-key resolutions below are the
  // ones a call would get, not the cold-cache (env-only) view.
  await Promise.all([getLlmStack('roboapply'), getLlmStack('goapply'), warmupGatewayProviders()]);
  const [providers, stored] = await Promise.all([listGatewayProviders(env), getLlmStackForEnvironment(env, brand)]);
  const byId = new Map(providers.map((p) => [p.id, p]));
  const areas: GatewayAreaView[] = LLM_AREAS.map((area) => {
    const route = stored.blob.routes[area];
    const keys = AREA_MODEL_KEYS[area].map((key) => resolveKey(key, brand));
    return {
      area,
      route,
      routeStatus: route ? statusOf(route, byId) : null,
      modelListed: route ? listed(route, byId) : null,
      fallbackStatus: (route?.fallbacks ?? []).map((f) => statusOf(f, byId)),
      fallbackListed: (route?.fallbacks ?? []).map((f) => listed(f, byId)),
      needsTools: AREAS_NEEDING_TOOLS.includes(area),
      needsImages: AREAS_NEEDING_IMAGES.includes(area),
      inheritsDefault: !route && keys.some((k) => k.via === 'default'),
      keys,
    };
  });
  return {
    environment: env,
    brand,
    dbDisabled: isDbConfigDisabled(),
    encryptionReady: !!process.env.FIELD_ENCRYPTION_KEY,
    maxProviders: MAX_PROVIDERS,
    maxFallbacks: MAX_AREA_FALLBACKS,
    efforts: GATEWAY_EFFORTS,
    defaultEffort: DEFAULT_GATEWAY_EFFORT,
    providerTypes: providerTypes(),
    providers,
    areas,
    defaultModel: getDefaultModel(brand as BrandId) ?? null,
    updatedAt: stored.updatedAt ? stored.updatedAt.toISOString() : null,
  };
}

/**
 * One target of an assignment (its model or a fallback), checked: a saved
 * provider entry, a model id, an effort (missing → `medium`), and a provider
 * type that streams tool calls when the area needs it.
 */
function parseTarget(
  raw: unknown,
  area: LlmArea,
  providers: Map<string, GatewayProviderSummary>,
  fallbackIndex: number | null,
): LlmRouteTarget {
  const at = fallbackIndex === null ? { area } : { area, fallback: fallbackIndex };
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<LlmRouteTarget>;
  const providerId = typeof r.providerId === 'string' ? r.providerId.trim().toLowerCase() : '';
  const model = typeof r.model === 'string' ? r.model.trim() : '';
  if (!providerId || !model || model.length > MAX_MODEL_ID || /\s/.test(model)) {
    throw new GatewayRouteError(fallbackIndex === null ? 'invalid_route' : 'invalid_fallback', 'Choose a provider and a model.', at);
  }
  if (r.effort !== undefined && r.effort !== null && !isGatewayEffort(r.effort)) {
    throw new GatewayRouteError('invalid_effort', `Reasoning effort must be one of ${GATEWAY_EFFORTS.join(', ')}.`, at);
  }
  const entry = providers.get(providerId);
  if (!entry) throw new GatewayRouteError('unknown_provider', 'This provider no longer exists.', at);
  if (AREAS_NEEDING_TOOLS.includes(area) && !supportsToolStreaming(entry.type)) {
    throw new GatewayRouteError('tools_unsupported', `The ${area} area streams tool calls, which ${entry.type} providers cannot do here.`, { ...at, type: entry.type });
  }
  return { providerId, model, effort: isGatewayEffort(r.effort) ? r.effort : DEFAULT_GATEWAY_EFFORT };
}

/**
 * Save area assignments for a brand. `routes` holds only the areas to change:
 * `{ providerId, model, effort?, fallbacks? }` assigns, `null` clears. Every
 * target must name a saved provider entry; an area that streams tool calls
 * refuses an entry (its model or a fallback) whose type cannot; at most
 * MAX_AREA_FALLBACKS fallbacks, and no entry and model twice in one area.
 */
export async function saveGatewayRoutes(
  brand: LlmStackBrand,
  routes: Record<string, unknown>,
  adminId: string,
): Promise<void> {
  const env = getActiveEnvironment();
  const providers = new Map((await listGatewayProviders(env)).map((p) => [p.id, p]));
  const { blob } = await getLlmStackForEnvironment(env, brand);
  const next = { ...blob, routes: { ...blob.routes } };
  for (const [area, raw] of Object.entries(routes ?? {})) {
    if (!isLlmArea(area)) throw new GatewayRouteError('invalid_area', `Unknown area "${area}".`);
    if (raw === null) {
      next.routes[area] = null;
      continue;
    }
    const primary = parseTarget(raw, area, providers, null);
    const list = (raw as { fallbacks?: unknown }).fallbacks;
    if (list !== undefined && list !== null && !Array.isArray(list)) {
      throw new GatewayRouteError('invalid_fallback', 'Fallback models must be a list.', { area });
    }
    const items = Array.isArray(list) ? list : [];
    if (items.length > MAX_AREA_FALLBACKS) {
      throw new GatewayRouteError('too_many_fallbacks', `An area takes at most ${MAX_AREA_FALLBACKS} fallback models.`, { area, max: MAX_AREA_FALLBACKS });
    }
    const seen = new Set([`${primary.providerId}::${primary.model}`]);
    const fallbacks = items.map((item, index) => {
      const target = parseTarget(item, area, providers, index);
      const key = `${target.providerId}::${target.model}`;
      if (seen.has(key)) throw new GatewayRouteError('duplicate_fallback', 'Each model can appear once in an area.', { area, fallback: index });
      seen.add(key);
      return target;
    });
    next.routes[area] = { ...primary, fallbacks };
  }
  await saveLlmStack(env, next, adminId, 'LLM gateway: area assignments', brand);
}

/** Areas (of either brand) that use a provider entry, for their model or a fallback. */
export async function areasUsingProvider(id: string): Promise<{ brand: LlmStackBrand; area: LlmArea }[]> {
  const env = getActiveEnvironment();
  const out: { brand: LlmStackBrand; area: LlmArea }[] = [];
  for (const brand of ['roboapply', 'goapply'] as const) {
    const { blob } = await getLlmStackForEnvironment(env, brand);
    for (const area of LLM_AREAS) {
      const route = blob.routes[area];
      if (route && (route.providerId === id || route.fallbacks.some((f) => f.providerId === id))) out.push({ brand, area });
    }
  }
  return out;
}

/** Remove a provider entry, unless an area is still assigned to it. */
export async function removeGatewayProvider(id: string, adminId: string): Promise<void> {
  const inUse = await areasUsingProvider(id.trim().toLowerCase());
  if (inUse.length > 0) {
    throw new GatewayRouteError('provider_in_use', 'An area is still assigned to this provider. Reassign or clear it first.', { areas: inUse });
  }
  await deleteGatewayProvider(id, adminId);
}

export { GatewayProviderError };
