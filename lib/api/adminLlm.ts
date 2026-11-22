// lib/api/adminLlm.ts
//
// Typed client for the LLM gateway admin API (server:
// server/src/roboapply/v2/routes/adminLlm.ts, mounted at
// /api/v1/roboapply/v2/admin/llm). Admin only. The shapes mirror
// server/src/lib/llm/gatewayAdmin.ts and gatewayProviders.ts.
//
// No response carries an API key: a provider entry has `keyPreview`
// (`sk-…ab12`) and `hasKey` only.

import { roboApi } from './client';

const BASE = '/api/v1/roboapply/v2/admin/llm';

export type LlmGatewayBrand = 'roboapply' | 'goapply';

export const LLM_PROVIDER_TYPES = ['openai', 'anthropic', 'google', 'deepseek', 'moonshot', 'minimax', 'openrouter', 'ollama', 'newapi'] as const;
export type LlmProviderType = (typeof LLM_PROVIDER_TYPES)[number];

export const LLM_AREAS = ['default', 'matchResume', 'parseResume', 'visual', 'evaluation', 'insights', 'writing', 'assistant', 'jobs'] as const;
export type LlmArea = (typeof LLM_AREAS)[number];

export interface LlmProviderTypeInfo {
  type: LlmProviderType;
  baseUrl: 'required' | 'optional' | 'forbidden';
  defaultBaseUrl: string | null;
  tools: boolean;
}

export interface LlmProviderEntry {
  id: string;
  name: string;
  type: LlmProviderType;
  baseUrl: string | null;
  effectiveBaseUrl: string | null;
  enabled: boolean;
  notes: string | null;
  hasKey: boolean;
  keyPreview: string;
  keyUnreadable: boolean;
  usable: boolean;
  models: string[];
  modelsFetchedAt: string | null;
  updatedAt: string;
}

export interface LlmAreaRoute {
  providerId: string;
  model: string;
}

export type LlmAreaRouteStatus = 'ok' | 'provider_missing' | 'provider_disabled' | 'provider_key_missing' | 'provider_key_unreadable';
export type LlmSettingSource = 'override' | 'env' | 'shared' | 'none';

export interface LlmKeyResolution {
  key: string;
  envName: string;
  effective: string | null;
  source: LlmSettingSource;
  providerId: string | null;
  providerType: string | null;
  model: string | null;
}

export interface LlmAreaView {
  area: LlmArea;
  route: LlmAreaRoute | null;
  routeStatus: LlmAreaRouteStatus | null;
  modelListed: boolean | null;
  needsTools: boolean;
  needsImages: boolean;
  keys: LlmKeyResolution[];
}

export interface LlmGatewayOverview {
  environment: 'production' | 'development';
  brand: LlmGatewayBrand;
  dbDisabled: boolean;
  encryptionReady: boolean;
  maxProviders: number;
  providerTypes: LlmProviderTypeInfo[];
  providers: LlmProviderEntry[];
  areas: LlmAreaView[];
  defaultModel: string | null;
  updatedAt: string | null;
}

export type LlmModelListFailure =
  | 'invalid_base_url'
  | 'key_required'
  | 'auth_rejected'
  | 'not_supported'
  | 'rate_limited'
  | 'timeout'
  | 'unreachable'
  | 'invalid_response'
  | 'response_too_large'
  | 'provider_error';

export type LlmModelListResult =
  | { ok: true; models: string[]; truncated: boolean; elapsedMs: number }
  | { ok: false; code: LlmModelListFailure; status?: number; elapsedMs: number };

export interface LlmProviderInput {
  name: string;
  type: LlmProviderType;
  baseUrl: string;
  /** Empty on an update keeps the saved key. */
  apiKey: string;
  enabled: boolean;
  notes: string;
}

export interface LlmProviderSaveResponse {
  provider: LlmProviderEntry;
  /** The model-list fetch made right after a save; null when the saved list was kept. */
  models: LlmModelListResult | null;
  overview: LlmGatewayOverview;
}

const brandQuery = (brand: LlmGatewayBrand) => `?brand=${brand}`;
const entry = (id: string) => `${BASE}/providers/${encodeURIComponent(id)}`;

export const adminLlmApi = {
  overview: (brand: LlmGatewayBrand) => roboApi.get<LlmGatewayOverview>(`${BASE}${brandQuery(brand)}`),

  saveRoutes: (brand: LlmGatewayBrand, routes: Partial<Record<LlmArea, LlmAreaRoute | null>>) =>
    roboApi.put<LlmGatewayOverview>(`${BASE}/routes${brandQuery(brand)}`, { routes }),

  createProvider: (brand: LlmGatewayBrand, input: LlmProviderInput) =>
    roboApi.post<LlmProviderSaveResponse>(`${BASE}/providers${brandQuery(brand)}`, input),

  updateProvider: (brand: LlmGatewayBrand, id: string, input: LlmProviderInput) =>
    roboApi.put<LlmProviderSaveResponse>(`${entry(id)}${brandQuery(brand)}`, input),

  deleteProvider: (brand: LlmGatewayBrand, id: string) => roboApi.delete<LlmGatewayOverview>(`${entry(id)}${brandQuery(brand)}`),

  fetchModels: (brand: LlmGatewayBrand, id: string) =>
    roboApi.post<LlmProviderSaveResponse>(`${entry(id)}/models${brandQuery(brand)}`),

  /** Ask a provider for its model list with values that are not saved. Saves nothing. */
  testProvider: (input: Pick<LlmProviderInput, 'type' | 'baseUrl' | 'apiKey'>) =>
    roboApi.post<{ models: LlmModelListResult }>(`${BASE}/providers/test`, input),
};
