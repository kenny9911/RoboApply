/**
 * LLM gateway — named provider entries.
 *
 * An admin saves any number of provider entries (up to MAX_PROVIDERS). Each
 * has a name, the provider type whose client speaks to it, an API base URL, an
 * API key, and the model list the provider returned for that key. A
 * functionality area (llmStackConfigSchema.ts LLM_AREAS) is then assigned to
 * one entry and one of its models.
 *
 * Storage: one `AppConfig` row per environment, `llm_providers.{env}`, like the
 * stack blob beside it (`llm_stack.{env}`). No schema change. The API key is
 * stored AES-256-GCM encrypted (lib/crypto.ts, FIELD_ENCRYPTION_KEY), exactly
 * as `SystemLLMKey.encryptedKey` is; everything else in the row is not secret.
 * Both brands read the same entries: which brand may use which endpoint is
 * still decided per call, on the endpoint host, by the brand policy.
 *
 * SAFETY (the same rules as systemCredentials.ts):
 *  - A decrypted key lives only in the in-memory cache and is handed straight
 *    to a provider client. It is never logged, serialized or returned.
 *  - An entry that cannot be used (removed, disabled, no key, or a key that
 *    does not decrypt with this deployment's FIELD_ENCRYPTION_KEY) is reported
 *    as unusable, and an area assigned to it falls back to what it would have
 *    resolved to without the assignment (llmModels.ts). It never blacks out
 *    the area.
 *  - Base URLs pass the BYOK SSRF check; model-list requests follow no
 *    redirect, time out after 8 seconds and read at most 8 MiB.
 */

import { prisma } from '../prisma.js';
import { decryptField, encryptField } from '../crypto.js';
import { logger } from '../../services/LoggerService.js';
import { PROVIDER_DEFAULT_BASE_URLS } from '../../platform/llm/egressPolicy.js';
import { PROVIDER_ENTRY_ID_RE } from '../../services/llm/providerPrefixes.js';
import { BYOK_PROVIDERS, baseUrlRequirement, isByokProvider, previewFor, validateBaseUrl, type ByokProvider } from '../byokService.js';
import { getActiveEnvironment, isDbConfigDisabled, type ConfigEnvironment } from './llmStackConfigSchema.js';

/* ── Shape ────────────────────────────────────────────────────────────────── */

/** Provider types an entry can have. `newapi` is the generic OpenAI-compatible endpoint. */
export const GATEWAY_PROVIDER_TYPES = BYOK_PROVIDERS;
export type GatewayProviderType = ByokProvider;

export const MAX_PROVIDERS = 16;
export const MAX_MODELS_PER_PROVIDER = 1000;
const MAX_NAME = 60;
const MAX_NOTES = 2000;
const MAX_MODEL_ID = 200;

/** One entry as stored. `encryptedKey` is ciphertext ('' = keyless, ollama only). */
export interface StoredGatewayProvider {
  id: string;
  name: string;
  type: GatewayProviderType;
  /** Normalized base URL, or null for the provider type's own host. */
  baseUrl: string | null;
  encryptedKey: string;
  enabled: boolean;
  notes: string | null;
  /** Model ids from the provider's model list, sorted. */
  models: string[];
  modelsFetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

interface StoredGatewayProviders {
  version: 1;
  providers: StoredGatewayProvider[];
}

/** What the admin API returns for an entry. Never the key. */
export interface GatewayProviderSummary {
  id: string;
  name: string;
  type: GatewayProviderType;
  baseUrl: string | null;
  /** The base URL calls go to: the entry's, else the provider type's own. */
  effectiveBaseUrl: string | null;
  enabled: boolean;
  notes: string | null;
  hasKey: boolean;
  /** `sk-…ab12`, never the plaintext. */
  keyPreview: string;
  /** The stored key does not decrypt with this deployment's FIELD_ENCRYPTION_KEY. */
  keyUnreadable: boolean;
  /** Calls can be sent to it: enabled and a readable key (ollama needs none). */
  usable: boolean;
  models: string[];
  modelsFetchedAt: string | null;
  updatedAt: string;
}

/** A usable entry with its decrypted key, for the credential resolver. */
export interface ResolvedGatewayProvider {
  id: string;
  name: string;
  type: GatewayProviderType;
  baseUrl: string | null;
  apiKey: string;
}

export class GatewayProviderError extends Error {
  constructor(
    readonly code:
      | 'invalid_name'
      | 'duplicate_name'
      | 'invalid_type'
      | 'invalid_base_url'
      | 'key_required'
      | 'key_required_for_new_url'
      | 'too_many_providers'
      | 'not_found'
      | 'invalid_notes'
      | 'encryption_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'GatewayProviderError';
  }
}

export function appConfigKeyForProviders(env: ConfigEnvironment): string {
  return `llm_providers.${env}`;
}

/* ── Parse ────────────────────────────────────────────────────────────────── */

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function parseStored(raw: string | null | undefined): StoredGatewayProvider[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (parsed as { providers?: unknown } | null)?.providers;
  if (!Array.isArray(list)) return [];
  const out: StoredGatewayProvider[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = str(o.id);
    const name = str(o.name);
    if (!id || !PROVIDER_ENTRY_ID_RE.test(id) || seen.has(id) || !name || !isByokProvider(o.type)) continue;
    seen.add(id);
    const now = new Date(0).toISOString();
    out.push({
      id,
      name,
      type: o.type,
      baseUrl: str(o.baseUrl),
      encryptedKey: typeof o.encryptedKey === 'string' ? o.encryptedKey : '',
      enabled: o.enabled !== false,
      notes: str(o.notes),
      models: Array.isArray(o.models) ? o.models.filter((m): m is string => typeof m === 'string' && !!m.trim()).slice(0, MAX_MODELS_PER_PROVIDER) : [],
      modelsFetchedAt: str(o.modelsFetchedAt),
      createdAt: str(o.createdAt) ?? now,
      updatedAt: str(o.updatedAt) ?? now,
      updatedBy: str(o.updatedBy),
    });
    if (out.length >= MAX_PROVIDERS) break;
  }
  return out;
}

/** The decrypted key of a stored entry; `unreadable` when it does not decrypt. */
function readKey(entry: StoredGatewayProvider): { apiKey: string; unreadable: boolean } {
  if (!entry.encryptedKey) return { apiKey: '', unreadable: false };
  try {
    return { apiKey: decryptField(entry.encryptedKey), unreadable: false };
  } catch {
    return { apiKey: '', unreadable: true };
  }
}

function isUsable(entry: StoredGatewayProvider, key: { apiKey: string; unreadable: boolean }): boolean {
  if (!entry.enabled || key.unreadable) return false;
  return entry.type === 'ollama' || !!key.apiKey;
}

/** The base URL an entry's calls go to: its own, else the provider type's own host. */
export function effectiveProviderBaseUrl(type: GatewayProviderType, baseUrl: string | null): string | null {
  return baseUrl ?? PROVIDER_DEFAULT_BASE_URLS[type] ?? null;
}

function summarize(entry: StoredGatewayProvider): GatewayProviderSummary {
  const key = readKey(entry);
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    baseUrl: entry.baseUrl,
    effectiveBaseUrl: effectiveProviderBaseUrl(entry.type, entry.baseUrl),
    enabled: entry.enabled,
    notes: entry.notes,
    hasKey: !!entry.encryptedKey,
    keyPreview: key.unreadable ? '••••' : key.apiKey ? previewFor(key.apiKey) : '',
    keyUnreadable: key.unreadable,
    usable: isUsable(entry, key),
    models: entry.models,
    modelsFetchedAt: entry.modelsFetchedAt,
    updatedAt: entry.updatedAt,
  };
}

/* ── Cache (30s TTL, like the stack blob and the system keys) ─────────────── */

interface ProviderCache {
  /** Usable entries only, by id. */
  usable: Map<string, ResolvedGatewayProvider>;
  fetchedAt: number;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
const STALE_TTL_MS = 10_000;
let cache: ProviderCache | null = null;
const warnedUnreadable = new Set<string>();

async function readStored(env: ConfigEnvironment): Promise<StoredGatewayProvider[]> {
  const row = await prisma.appConfig.findUnique({ where: { key: appConfigKeyForProviders(env) } });
  return parseStored(row?.value);
}

async function refreshCache(): Promise<void> {
  const now = Date.now();
  try {
    const stored = await readStored(getActiveEnvironment());
    const usable = new Map<string, ResolvedGatewayProvider>();
    for (const entry of stored) {
      const key = readKey(entry);
      if (key.unreadable && !warnedUnreadable.has(entry.id)) {
        warnedUnreadable.add(entry.id);
        logger.warn('LLM_GATEWAY', 'provider key does not decrypt; areas assigned to it use their inherited model', {
          provider: entry.id,
          hint: 'FIELD_ENCRYPTION_KEY must match the key that encrypted it; re-save the key in the LLM gateway',
        });
      }
      if (!isUsable(entry, key)) continue;
      usable.set(entry.id, { id: entry.id, name: entry.name, type: entry.type, baseUrl: entry.baseUrl, apiKey: key.apiKey });
    }
    cache = { usable, fetchedAt: now, expiresAt: now + CACHE_TTL_MS };
  } catch (err) {
    logger.warn('LLM_GATEWAY', 'provider cache refresh failed', { error: err instanceof Error ? err.message : String(err) });
    // Keep the last known entries a little longer; a cold cache stays cold.
    if (cache) cache.expiresAt = now + STALE_TTL_MS;
  }
}

/**
 * A usable entry by id, synchronously, for the hot path. A cold cache answers
 * null and warms in the background, so the first calls after a start resolve
 * as if no area were assigned (the environment), like the stack blob.
 */
export function getGatewayProviderSync(id: string | null | undefined): ResolvedGatewayProvider | null {
  if (!id || isDbConfigDisabled()) return null;
  if (!cache) {
    void refreshCache();
    return null;
  }
  if (cache.expiresAt <= Date.now()) void refreshCache();
  return cache.usable.get(id.toLowerCase()) ?? null;
}

export function invalidateGatewayProviders(): void {
  cache = null;
  warnedUnreadable.clear();
}

export async function warmupGatewayProviders(): Promise<void> {
  if (isDbConfigDisabled()) return;
  await refreshCache();
}

/* ── Admin read ───────────────────────────────────────────────────────────── */

export async function listGatewayProviders(env: ConfigEnvironment = getActiveEnvironment()): Promise<GatewayProviderSummary[]> {
  return (await readStored(env)).map(summarize);
}

/* ── Admin write ──────────────────────────────────────────────────────────── */

async function writeStored(env: ConfigEnvironment, providers: StoredGatewayProvider[], adminId: string): Promise<void> {
  const value = JSON.stringify({ version: 1, providers } satisfies StoredGatewayProviders);
  const key = appConfigKeyForProviders(env);
  await prisma.appConfig.upsert({ where: { key }, update: { value, updatedBy: adminId }, create: { key, value, updatedBy: adminId } });
  if (env === getActiveEnvironment()) invalidateGatewayProviders();
}

/** Audit row: what changed, never a key (not even its ciphertext). */
async function audit(env: ConfigEnvironment, adminId: string, action: string, entry: StoredGatewayProvider, detail: string): Promise<void> {
  await prisma.adminAdjustment
    .create({
      data: {
        userId: adminId,
        adminId,
        type: `llm_provider:${env}`,
        oldValue: null,
        newValue: JSON.stringify({ id: entry.id, name: entry.name, type: entry.type, baseUrl: entry.baseUrl, enabled: entry.enabled }),
        reason: `${action} ${entry.id}${detail ? ` — ${detail}` : ''}`,
      },
    })
    .catch((err) => {
      logger.error('ADMIN', 'AdminAdjustment write failed for an LLM provider change', {
        env,
        adminId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || 'provider';
}

function uniqueId(name: string, taken: Set<string>): string {
  const base = slugify(name);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base.slice(0, 36)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 28)}-${Date.now().toString(36)}`;
}

function hostOfUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export interface SaveGatewayProviderInput {
  /** Omitted to add an entry. */
  id?: string | null;
  name: string;
  type: string;
  baseUrl?: string | null;
  /** Empty on an update keeps the stored key. */
  apiKey?: string | null;
  enabled?: boolean;
  notes?: string | null;
}

/**
 * Add or change an entry. The key is optional on an update, with one
 * exception: when the endpoint host changes, a key must be sent with it, so a
 * stored key is never forwarded to a host it was not entered for.
 */
export async function saveGatewayProvider(
  input: SaveGatewayProviderInput,
  adminId: string,
  env: ConfigEnvironment = getActiveEnvironment(),
): Promise<GatewayProviderSummary> {
  const name = (input.name ?? '').trim();
  if (!name || name.length > MAX_NAME) throw new GatewayProviderError('invalid_name', `A provider needs a name of at most ${MAX_NAME} characters.`);
  if (!isByokProvider(input.type)) throw new GatewayProviderError('invalid_type', 'Unknown provider type.');
  const type = input.type;
  const base = validateBaseUrl(type, input.baseUrl ?? null);
  if (!base.ok) throw new GatewayProviderError('invalid_base_url', base.error ?? 'Invalid base URL.');
  const baseUrl = base.normalized ?? null;
  if (baseUrl && /\/(chat\/completions|responses|models|messages)$/i.test(baseUrl)) {
    throw new GatewayProviderError('invalid_base_url', 'Enter the API base URL, without an endpoint such as /chat/completions or /models.');
  }
  const notes = (input.notes ?? '').trim();
  if (notes.length > MAX_NOTES) throw new GatewayProviderError('invalid_notes', `Notes can be at most ${MAX_NOTES} characters.`);
  const apiKey = (input.apiKey ?? '').trim();

  const stored = await readStored(env);
  const id = (input.id ?? '').trim().toLowerCase();
  const existing = id ? stored.find((p) => p.id === id) : undefined;
  if (id && !existing) throw new GatewayProviderError('not_found', 'This provider no longer exists.');
  if (stored.some((p) => p.id !== existing?.id && p.name.toLowerCase() === name.toLowerCase())) {
    throw new GatewayProviderError('duplicate_name', 'Another provider already has this name.');
  }
  if (!existing && stored.length >= MAX_PROVIDERS) {
    throw new GatewayProviderError('too_many_providers', `At most ${MAX_PROVIDERS} providers can be saved.`);
  }

  const endpointChanged =
    !!existing &&
    (existing.type !== type || hostOfUrl(effectiveProviderBaseUrl(existing.type, existing.baseUrl)) !== hostOfUrl(effectiveProviderBaseUrl(type, baseUrl)));
  if (!apiKey && type !== 'ollama') {
    if (!existing?.encryptedKey) throw new GatewayProviderError('key_required', 'Enter an API key.');
    if (endpointChanged) {
      throw new GatewayProviderError('key_required_for_new_url', 'The endpoint changed. Enter the API key again so the saved key is not sent to a different host.');
    }
  }

  let encryptedKey = existing?.encryptedKey ?? '';
  if (apiKey) {
    try {
      encryptedKey = encryptField(apiKey);
    } catch {
      throw new GatewayProviderError('encryption_unavailable', 'FIELD_ENCRYPTION_KEY is not set on this server, so the key cannot be stored.');
    }
  }

  const now = new Date().toISOString();
  const next: StoredGatewayProvider = {
    id: existing?.id ?? uniqueId(name, new Set(stored.map((p) => p.id))),
    name,
    type,
    baseUrl,
    encryptedKey,
    enabled: input.enabled ?? existing?.enabled ?? true,
    notes: notes || null,
    // A model list belongs to the endpoint and key it was fetched with.
    models: existing && !endpointChanged && !apiKey ? existing.models : [],
    modelsFetchedAt: existing && !endpointChanged && !apiKey ? existing.modelsFetchedAt : null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    updatedBy: adminId,
  };
  const providers = existing ? stored.map((p) => (p.id === existing.id ? next : p)) : [...stored, next];
  await writeStored(env, providers, adminId);
  await audit(env, adminId, existing ? 'update' : 'create', next, apiKey ? 'key replaced' : '');
  return summarize(next);
}

export async function deleteGatewayProvider(id: string, adminId: string, env: ConfigEnvironment = getActiveEnvironment()): Promise<void> {
  const stored = await readStored(env);
  const existing = stored.find((p) => p.id === id.trim().toLowerCase());
  if (!existing) throw new GatewayProviderError('not_found', 'This provider no longer exists.');
  await writeStored(env, stored.filter((p) => p.id !== existing.id), adminId);
  await audit(env, adminId, 'delete', existing, '');
}

/* ── Model list ───────────────────────────────────────────────────────────── */

export type ModelListFailure =
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

export type ModelListResult =
  | { ok: true; models: string[]; truncated: boolean; elapsedMs: number }
  | { ok: false; code: ModelListFailure; status?: number; elapsedMs: number };

const MODEL_LIST_TIMEOUT_MS = 8_000;
const MODEL_LIST_MAX_BYTES = 8 * 1024 * 1024;

class ModelListError extends Error {
  constructor(readonly code: ModelListFailure, readonly status?: number) {
    super(code);
  }
}

async function readBounded(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MODEL_LIST_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ModelListError('response_too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function getJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  // No redirect is followed: a 3xx to an internal host would get past the
  // base-URL check made on the original URL.
  const res = await fetch(url, { method: 'GET', headers, signal, redirect: 'manual' });
  if (res.status === 401 || res.status === 403) throw new ModelListError('auth_rejected', res.status);
  if (res.status === 404 || res.status === 405 || res.status === 501) throw new ModelListError('not_supported', res.status);
  if (res.status === 429) throw new ModelListError('rate_limited', res.status);
  if (!res.ok) throw new ModelListError('provider_error', res.status);
  const text = await readBounded(res);
  try {
    return JSON.parse(text);
  } catch {
    throw new ModelListError('invalid_response', res.status);
  }
}

function idsFrom(list: unknown, pick: (item: Record<string, unknown>) => unknown): string[] {
  if (!Array.isArray(list)) throw new ModelListError('invalid_response');
  const ids: string[] = [];
  for (const item of list) {
    const raw = typeof item === 'string' ? item : item && typeof item === 'object' ? pick(item as Record<string, unknown>) : null;
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (id && id.length <= MAX_MODEL_ID) ids.push(id);
  }
  return ids;
}

async function listOpenAiCompatible(root: string, apiKey: string, signal: AbortSignal): Promise<string[]> {
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const read = (body: unknown): string[] => {
    const o = body as { data?: unknown; models?: unknown } | unknown[] | null;
    const list = Array.isArray(o) ? o : o?.data ?? o?.models;
    return idsFrom(list, (m) => m.id ?? m.name);
  };
  try {
    return read(await getJson(`${root}/models`, headers, signal));
  } catch (err) {
    // A base URL entered without its version path (`https://host`): the list is at /v1/models.
    if (err instanceof ModelListError && err.code === 'not_supported' && !/\/v\d+[a-z0-9]*$/i.test(root)) {
      return read(await getJson(`${root}/v1/models`, headers, signal));
    }
    throw err;
  }
}

async function listAnthropic(root: string, apiKey: string, signal: AbortSignal): Promise<string[]> {
  const base = root.replace(/\/v1$/i, '');
  const body = (await getJson(`${base}/v1/models?limit=1000`, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, signal)) as { data?: unknown };
  return idsFrom(body?.data, (m) => m.id);
}

async function listGoogle(root: string, apiKey: string, signal: AbortSignal): Promise<string[]> {
  const base = root.replace(/\/v1(beta)?$/i, '');
  // The key travels in a header, not in the URL, so it stays out of any request log.
  const body = (await getJson(`${base}/v1beta/models?pageSize=1000`, { 'x-goog-api-key': apiKey }, signal)) as { models?: unknown };
  if (!Array.isArray(body?.models)) throw new ModelListError('invalid_response');
  const generative = body.models.filter((m) => {
    const methods = (m as { supportedGenerationMethods?: unknown } | null)?.supportedGenerationMethods;
    return !Array.isArray(methods) || methods.includes('generateContent');
  });
  return idsFrom(generative, (m) => (typeof m.name === 'string' ? m.name.replace(/^models\//, '') : null));
}

/**
 * Ask a provider which models a key can use. Read-only: it generates nothing
 * and saves nothing. The list shows what the provider lists; it does not prove
 * that the key may generate with each model.
 */
export async function fetchProviderModels(input: { type: string; baseUrl?: string | null; apiKey: string }): Promise<ModelListResult> {
  const started = Date.now();
  const fail = (code: ModelListFailure, status?: number): ModelListResult => ({ ok: false, code, ...(status ? { status } : {}), elapsedMs: Date.now() - started });
  if (!isByokProvider(input.type)) return fail('invalid_base_url');
  const type = input.type;
  const base = validateBaseUrl(type, input.baseUrl ?? null);
  if (!base.ok) return fail('invalid_base_url');
  const root = (effectiveProviderBaseUrl(type, base.normalized ?? null) ?? '').replace(/\/+$/, '');
  if (!root) return fail('invalid_base_url');
  const apiKey = (input.apiKey ?? '').trim();
  if (!apiKey && type !== 'ollama') return fail('key_required');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MODEL_LIST_TIMEOUT_MS);
  try {
    const ids =
      type === 'anthropic'
        ? await listAnthropic(root, apiKey, ctrl.signal)
        : type === 'google'
          ? await listGoogle(root, apiKey, ctrl.signal)
          : await listOpenAiCompatible(root, apiKey, ctrl.signal);
    const unique = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    return { ok: true, models: unique.slice(0, MAX_MODELS_PER_PROVIDER), truncated: unique.length > MAX_MODELS_PER_PROVIDER, elapsedMs: Date.now() - started };
  } catch (err) {
    if (err instanceof ModelListError) return fail(err.code, err.status);
    if (ctrl.signal.aborted) return fail('timeout');
    return fail('unreachable');
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch a saved entry's model list with its stored key, and save the list with the entry. */
export async function refreshGatewayProviderModels(
  id: string,
  adminId: string,
  env: ConfigEnvironment = getActiveEnvironment(),
): Promise<{ result: ModelListResult; provider: GatewayProviderSummary }> {
  const stored = await readStored(env);
  const existing = stored.find((p) => p.id === id.trim().toLowerCase());
  if (!existing) throw new GatewayProviderError('not_found', 'This provider no longer exists.');
  const key = readKey(existing);
  if (key.unreadable) {
    return { result: { ok: false, code: 'key_required', elapsedMs: 0 }, provider: summarize(existing) };
  }
  const result = await fetchProviderModels({ type: existing.type, baseUrl: existing.baseUrl, apiKey: key.apiKey });
  if (!result.ok) return { result, provider: summarize(existing) };
  // Re-read before writing: the fetch took time, and another admin may have saved meanwhile.
  const latest = await readStored(env);
  const current = latest.find((p) => p.id === existing.id);
  if (!current || current.encryptedKey !== existing.encryptedKey || current.baseUrl !== existing.baseUrl || current.type !== existing.type) {
    return { result, provider: summarize(current ?? existing) };
  }
  const next: StoredGatewayProvider = { ...current, models: result.models, modelsFetchedAt: new Date().toISOString() };
  await writeStored(env, latest.map((p) => (p.id === next.id ? next : p)), adminId);
  return { result, provider: summarize(next) };
}

export { baseUrlRequirement };
