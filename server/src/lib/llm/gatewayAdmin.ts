/**
 * LLM gateway — what the admin page reads and saves.
 *
 * Two things are managed, for the ACTIVE environment only:
 *  - provider entries (gatewayProviders.ts): name, type, base URL, key, models;
 *  - area assignments (`routes` in the stack blob, llmStackConfigSchema.ts):
 *    one provider entry and one model per functionality area, per brand.
 *
 * The overview also shows, for every model key of an area, what a call
 * resolves to right now and where that value comes from, so an unassigned
 * area is never a blank: it names the env value or default it inherits.
 */

import type { BrandId } from '../../platform/brand/registry.js';
import { PROVIDER_DEFAULT_BASE_URLS } from '../../platform/llm/egressPolicy.js';
import { providerBaseType, providerEntryId, splitSelectorPrefix } from '../../services/llm/providerPrefixes.js';
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
  LLM_AREAS,
  getActiveEnvironment,
  isDbConfigDisabled,
  isLlmArea,
  type ConfigEnvironment,
  type LlmArea,
  type LlmAreaRoute,
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

export interface GatewayKeyResolution {
  key: ModelKey;
  /** The env variable that supplies the key when nothing is assigned. */
  envName: string;
  /** The selector a call uses now; null when the key has no value of its own. */
  effective: string | null;
  source: LlmSettingSource;
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
  needsTools: boolean;
  needsImages: boolean;
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
  providerTypes: GatewayProviderTypeInfo[];
  providers: GatewayProviderSummary[];
  areas: GatewayAreaView[];
  /** The default model selector every unset key ends on (null: none configured). */
  defaultModel: string | null;
  updatedAt: string | null;
}

export class GatewayRouteError extends Error {
  constructor(
    readonly code: 'invalid_area' | 'invalid_route' | 'unknown_provider' | 'tools_unsupported' | 'provider_in_use',
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

function statusOf(route: LlmAreaRoute, providers: Map<string, GatewayProviderSummary>): AreaRouteStatus {
  const p = providers.get(route.providerId);
  if (!p) return 'provider_missing';
  if (!p.enabled) return 'provider_disabled';
  if (p.keyUnreadable) return 'provider_key_unreadable';
  if (!p.usable) return 'provider_key_missing';
  return 'ok';
}

function resolveKey(key: ModelKey, brand: LlmStackBrand): GatewayKeyResolution {
  const r = resolveModelKey(key, brand as BrandId);
  const split = r.effective ? splitSelectorPrefix(r.effective, 'global') : null;
  return {
    key,
    envName: r.envName,
    effective: r.effective,
    source: r.source,
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
    const entry = route ? byId.get(route.providerId) : undefined;
    return {
      area,
      route,
      routeStatus: route ? statusOf(route, byId) : null,
      modelListed: route && entry && entry.models.length > 0 ? entry.models.includes(route.model) : null,
      needsTools: AREAS_NEEDING_TOOLS.includes(area),
      needsImages: AREAS_NEEDING_IMAGES.includes(area),
      keys: AREA_MODEL_KEYS[area].map((key) => resolveKey(key, brand)),
    };
  });
  return {
    environment: env,
    brand,
    dbDisabled: isDbConfigDisabled(),
    encryptionReady: !!process.env.FIELD_ENCRYPTION_KEY,
    maxProviders: MAX_PROVIDERS,
    providerTypes: providerTypes(),
    providers,
    areas,
    defaultModel: getDefaultModel(brand as BrandId) ?? null,
    updatedAt: stored.updatedAt ? stored.updatedAt.toISOString() : null,
  };
}

/**
 * Save area assignments for a brand. `routes` holds only the areas to change:
 * `{ providerId, model }` assigns, `null` clears. An assignment must name a
 * saved provider entry; an area that streams tool calls refuses an entry whose
 * provider type cannot.
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
    const r = raw as Partial<LlmAreaRoute> | undefined;
    const providerId = typeof r?.providerId === 'string' ? r.providerId.trim().toLowerCase() : '';
    const model = typeof r?.model === 'string' ? r.model.trim() : '';
    if (!providerId || !model || model.length > MAX_MODEL_ID || /\s/.test(model)) {
      throw new GatewayRouteError('invalid_route', 'Choose a provider and a model.', { area });
    }
    const entry = providers.get(providerId);
    if (!entry) throw new GatewayRouteError('unknown_provider', 'This provider no longer exists.', { area });
    if (AREAS_NEEDING_TOOLS.includes(area) && !supportsToolStreaming(entry.type)) {
      throw new GatewayRouteError('tools_unsupported', `The ${area} area streams tool calls, which ${entry.type} providers cannot do here.`, { area, type: entry.type });
    }
    next.routes[area] = { providerId, model };
  }
  await saveLlmStack(env, next, adminId, 'LLM gateway: area assignments', brand);
}

/** Areas (of either brand) assigned to a provider entry. */
export async function areasUsingProvider(id: string): Promise<{ brand: LlmStackBrand; area: LlmArea }[]> {
  const env = getActiveEnvironment();
  const out: { brand: LlmStackBrand; area: LlmArea }[] = [];
  for (const brand of ['roboapply', 'goapply'] as const) {
    const { blob } = await getLlmStackForEnvironment(env, brand);
    for (const area of LLM_AREAS) if (blob.routes[area]?.providerId === id) out.push({ brand, area });
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
