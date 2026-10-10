// server/src/features/compliance/disclosures.ts
//
// What we disclose about AI models, processors and filings, and the legal
// footer — every value read from configuration (D3). Nothing is shown that
// ops has not set: an unset filing number is absent (never "pending"), a model
// is named as soon as it is configured (CN plan §5.3), and "备案中" appears only
// as the verbatim CN_GENAI_STATUS_NOTE when ops sets it.
//
// The lists describe the stack a brand REALLY resolves (D5; GOAPPLY_PARITY_PLAN.md
// §3.6). China-specific providers are optional overrides for GoApply, and the
// shared stack is its fallback: a GoApply deployment with only the shared
// credentials lists the shared models, Resend, LiveKit Cloud and the shared
// file store, exactly the processors its data goes to. Nothing that is not
// configured is listed, and no "mainland only" statement is made unless the
// domestic-only wall enforces it.

import { DEFAULT_BRAND, type ProductBrand } from '../../platform/brand/registry.js';
import { brandEnv, brandOwnEnv, brandStack, cnLlmDomesticOnly, type EnvSource } from '../../platform/brand/brandEnv.js';
import { transportNameFor } from '../../platform/email/index.js';
import { requirementsMet } from '../../platform/flags.js';
import { getLlmStack } from '../../lib/llm/llmStackConfigResolver.js';
import { MODEL_ENV, isDbConfigDisabled, type LlmStackBrand, type LlmStackConfigBlob, type ModelKey, type PurposeKey } from '../../lib/llm/llmStackConfigSchema.js';
import { normalizeProviderType, resolveProviderPrefix } from '../../services/llm/providerPrefixes.js';
import { GOAPPLY_DIRECT_PROVIDERS, MAINLAND_LLM_HOST_SUFFIXES, extraDomesticHosts, hostOf, isMainlandLlmHost } from '../../platform/llm/brandPolicy.js';
import { contentSafetyReadiness } from '../../platform/llm/contentSafety/config.js';
import { PROVIDER_DEFAULT_BASE_URLS, openRouterIgnoredUpstreams } from '../../platform/llm/egressPolicy.js';
import { isCnMainland } from '../../platform/residency/deployRegion.js';
import { isMainlandStorageHost, isPrivateHost } from '../../platform/residency/egressPolicy.js';
import { residencySummary } from '../../platform/residency/summary.js';
import { STAFFING_AGENCY_SOURCE, jobDataAttributions } from '../jobs/data/index.js';
import { CITY_TABLE_SOURCE } from '../jobs/geo/index.js';
import {
  ICP_LOOKUP_URL,
  LEGAL_FOOTER_DOCS,
  PSB_LOOKUP_URL_PREFIX,
  type AiModelDisclosure,
  type DataAttributionPurpose,
  type DataAttributionView,
  type DisclosuresResponse,
  type LegalFooterModel,
  type LlmEndpointFacts,
  type ProcessingFacts,
  type ProcessorPurpose,
} from './contract.js';
import { crossBorderApplies } from './deployment.js';

function val(env: EnvSource, name: string): string | null {
  const v = env[name];
  if (v === undefined) return null;
  const t = v.trim();
  return t ? t : null;
}

/**
 * The model settings we disclose, by task. Each is one key of the central
 * model table (`MODEL_ENV`), so the variable a brand reads is never typed
 * here: GoApply reads the `CN_` override of the name when it is set and the
 * shared value otherwise (D5; platform/brand `brandEnv`).
 */
export const LLM_TASK_KEYS: ReadonlyArray<[task: string, key: ModelKey]> = [
  ['default', 'defaultModel'],
  ['matching', 'matching'],
  ['extract', 'extract'],
  ['onboarding', 'onboarding'],
  ['rewrite', 'rewrite'],
  ['writing', 'writing'],
  ['assistant', 'copilot'],
  ['enrich', 'enrich'],
  ['practice', 'interview'],
  ['fallback', 'fallbackModel'],
  ['vision', 'vision'],
];

/** The same list by unprefixed env name (kept for callers that read the names). */
export const LLM_TASK_ENV: ReadonlyArray<[task: string, name: string]> = LLM_TASK_KEYS.map(([task, key]) => [task, MODEL_ENV[key]]);

// ── The AI stack a brand resolves ───────────────────────────────────────────
//
// One model setting is resolved per key, in the order of the LLM resolver
// (GOAPPLY_PARITY_PLAN.md §3.3):
//
//   RoboApply   its admin override (`llm_stack.{env}`)  →  <NAME>
//   GoApply     its admin override (`llm_stack.goapply.{env}`)  →  CN_<NAME>
//               →  the shared stack: RoboApply's override  →  <NAME>
//
// A disclosure needs more than the selector string: it needs to know WHICH
// stack the selector comes from, because a selector is read in the context of
// its own stack. A bare id (`gpt-5`) is sent to the provider of the stack that
// set it, never to the other one: with GoApply on its own provider and the
// vision model left to the shared stack, the vision request goes to the shared
// provider (the router qualifies it to that route), so the row must name that
// vendor and its country, not GoApply's.

/** Which stack a setting comes from: the brand's own, or the shared one (RoboApply's; GoApply's fallback). */
type SettingStack = 'own' | 'shared';

interface ResolvedSetting {
  value: string;
  stack: SettingStack;
  source: AiModelDisclosure['source'];
}

/** The admin overrides of both brands, as last loaded for an env object (`loadAiStackSnapshot`). */
type AiStackOverrides = Partial<Record<LlmStackBrand, LlmStackConfigBlob>>;
const SNAPSHOTS = new WeakMap<EnvSource, AiStackOverrides>();

/**
 * Load the admin model overrides the disclosures and the consent text read
 * (the `llm_stack.*` rows of both brands), and keep them as the snapshot of
 * `env`. Await it before building a disclosure, a consent text or a consent
 * requirement for the live process: every answer after it is built from the
 * same rows on every instance, cold or warm, so a consent hash served by one
 * instance is the hash another instance computes.
 *
 * Without a loaded snapshot the synchronous functions below read the
 * environment only. For any `env` object other than `process.env` (a test, a
 * what-if) nothing is read unless `read` is passed: the database belongs to
 * the live process. A failed read keeps the snapshot already held.
 */
export async function loadAiStackSnapshot(
  env: EnvSource = process.env,
  read?: (brandId: LlmStackBrand) => Promise<LlmStackConfigBlob>,
): Promise<void> {
  try {
    const reader = read ?? (env === process.env ? getLlmStack : null);
    if (!reader) return;
    if (!read && isDbConfigDisabled()) {
      // LLM_SETTINGS_DB_DISABLED: the resolver ignores every override, so the disclosure does too.
      SNAPSHOTS.delete(env);
      return;
    }
    const [goapply, roboapply] = await Promise.all([reader('goapply'), reader('roboapply')]);
    SNAPSHOTS.set(env, { goapply, roboapply });
  } catch {
    // Keep what we have: a disclosure must not fail because the settings row could not be read.
  }
}

type SettingKey = ModelKey | 'provider';

function overrideOf(env: EnvSource, brandId: LlmStackBrand, key: SettingKey): string | undefined {
  const blob = SNAPSHOTS.get(env)?.[brandId];
  if (!blob) return undefined;
  const raw = key === 'provider' ? blob.provider : key === 'defaultModel' ? blob.defaultModel : key === 'fallbackModel' ? blob.fallbackModel : blob.purposes[key as PurposeKey];
  const t = typeof raw === 'string' ? raw.trim() : '';
  return t ? t : undefined;
}

/** One setting of the shared stack: RoboApply's admin override, else the unprefixed variable. */
function sharedSetting(key: SettingKey, env: EnvSource): ResolvedSetting | null {
  const override = overrideOf(env, DEFAULT_BRAND, key);
  if (override) return { value: override, stack: 'shared', source: 'override' };
  const fromEnv = val(env, key === 'provider' ? 'LLM_PROVIDER' : MODEL_ENV[key]);
  return fromEnv ? { value: fromEnv, stack: 'shared', source: 'shared' } : null;
}

/** One setting as the brand resolves it, with the stack it comes from. */
function resolveSetting(brand: ProductBrand, key: SettingKey, env: EnvSource): ResolvedSetting | null {
  if (brand.id === DEFAULT_BRAND) return sharedSetting(key, env);
  const override = overrideOf(env, brand.id, key);
  if (override) return { value: override, stack: 'own', source: 'override' };
  const own = brandOwnEnv(brand, key === 'provider' ? 'LLM_PROVIDER' : MODEL_ENV[key], env);
  if (own) return { value: own, stack: 'own', source: 'own' };
  const shared = sharedSetting(key, env);
  // For this brand the value is the shared stack's, whoever set it there.
  return shared ? { ...shared, source: 'shared' } : null;
}

/** The dialect a selector is written in: a prefix such as `qwen/` names the mainland vendor only in the domestic one. */
type SelectorDialect = 'global' | 'domestic_cn';

/**
 * Country of each vendor's processing endpoint as we contract it. Only
 * vendors we know are listed; anything else renders "Not listed".
 */
export const VENDOR_COUNTRY: Readonly<Record<string, string>> = {
  openrouter: 'US',
  openai: 'US',
  anthropic: 'US',
  google: 'US',
  'x-ai': 'US',
  deepseek: 'CN',
  qwen: 'CN',
  dashscope: 'CN',
  kimi: 'CN',
  moonshot: 'CN',
  moonshotai: 'CN',
  glm: 'CN',
  zhipu: 'CN',
  doubao: 'CN',
  ark: 'CN',
  minimax: 'CN',
};

/** The provider a first segment pins in a dialect (`openrouter/…`, `deepseek/…`; `qwen/…` only in the domestic one), or null. */
function pinnedProvider(id: string, dialect: SelectorDialect): string | null {
  const slash = id.indexOf('/');
  return slash > 0 ? resolveProviderPrefix(id.slice(0, slash), dialect) : null;
}

/**
 * The provider a `vendor/model` selector is sent to, by the routing rule of
 * the stack it comes from (services/llm): a routing prefix pins its provider;
 * otherwise the stack's provider mode gets the whole id (OpenRouter for mode
 * `direct`, and when no mode is set in the global dialect; no route, '', when
 * none is set in the domestic one). A bare id on a mainland provider is that
 * provider.
 */
function routeProvider(id: string, provider: string | null, dialect: SelectorDialect): string {
  const pinned = pinnedProvider(id, dialect);
  if (pinned) return pinned;
  const mode = normalizeProviderType(provider ?? '');
  if (mode === 'direct') return 'openrouter';
  if (!mode) return dialect === 'global' ? 'openrouter' : '';
  return mode;
}

/**
 * Split a configured model id into vendor + model. `openrouter/google/x` is
 * served by OpenRouter, model `google/x`; any other `vendor/model` names its
 * first segment. A bare id takes `provider`, the provider setting of the
 * stack the id comes from.
 *
 * One rule on top, because the consent text and the cross-border requirement
 * are built from these rows: a row is placed with a mainland vendor only when
 * the request really goes to that vendor. A first segment can be a mainland
 * vendor's name without being a route to it: `qwen/…` is Alibaba's endpoint
 * only in the domestic dialect (a selector GoApply set for itself) and a model
 * namespace on the gateway in the global one (RoboApply, every selector of
 * the shared stack); `moonshotai/…` is a gateway namespace in both. Such a row
 * names the provider the request is sent to (`routeProvider`) and keeps the
 * whole id as the model.
 */
export function parseModelId(id: string, provider: string | null, dialect: SelectorDialect = 'global'): { vendor: string; model: string } {
  const parts = id.split('/');
  const named = parts.length > 1 ? { vendor: parts[0]!.toLowerCase(), model: parts.slice(1).join('/') } : { vendor: (provider ?? 'unknown').toLowerCase(), model: id };
  if (VENDOR_COUNTRY[named.vendor] !== 'CN') return named;
  const route = routeProvider(id, provider, dialect);
  if (VENDOR_COUNTRY[route] === 'CN') return named;
  return { vendor: route || 'unknown', model: id };
}

interface GenaiFiling {
  model: string;
  vendor: string;
  filingNo: string | null;
}

/** CN_GENAI_DISCLOSURES: JSON `[{ model, vendor, filingNo }]`; malformed → none. */
export function parseGenaiDisclosures(raw: string | null): GenaiFiling[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .filter((x) => typeof x.model === 'string' && typeof x.vendor === 'string')
      .map((x) => ({
        model: String(x.model),
        vendor: String(x.vendor),
        filingNo: typeof x.filingNo === 'string' && x.filingNo.trim() ? x.filingNo.trim() : null,
      }));
  } catch {
    return [];
  }
}

/**
 * Models the brand's AI tasks really resolve to, deduplicated, with filing
 * numbers when set. GoApply with no model of its own lists the shared models
 * (source `shared`): those are the ones its requests go to. Each row names the
 * vendor of the stack its selector comes from (see the note above).
 *
 * Behind the domestic-only wall a value of the shared stack that names no
 * mainland vendor is not used for GoApply (the resolver sets it aside and the
 * router would refuse it), so it is not listed either.
 */
export function configuredModels(brand: ProductBrand, env: EnvSource = process.env): AiModelDisclosure[] {
  const walled = brand.market === 'cn' && cnLlmDomesticOnly(env);
  const sharedProvider = sharedSetting('provider', env)?.value ?? null;
  const usableSharedProvider = walled && VENDOR_COUNTRY[normalizeProviderType(sharedProvider ?? '')] !== 'CN' ? null : sharedProvider;
  const brandProvider = resolveSetting(brand, 'provider', env);
  const ownProvider = brandProvider?.stack === 'own' ? brandProvider.value : usableSharedProvider;
  const filings = brand.market === 'cn' ? parseGenaiDisclosures(val(env, 'CN_GENAI_DISCLOSURES')) : [];
  const out: AiModelDisclosure[] = [];
  const seen = new Set<string>();
  for (const [task, modelKey] of LLM_TASK_KEYS) {
    const setting = resolveSetting(brand, modelKey, env);
    if (!setting) continue;
    const id = setting.value;
    const { vendor, model } =
      setting.stack === 'shared'
        ? parseModelId(id, sharedProvider, 'global')
        : parseModelId(id, ownProvider, brand.llmProfile === 'domestic_cn' ? 'domestic_cn' : 'global');
    const region = VENDOR_COUNTRY[vendor] ?? null;
    if (walled && setting.stack === 'shared' && region !== 'CN') continue;
    const key = `${vendor}/${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const filing = filings.find((f) => f.model === model || f.model === id);
    out.push({ task, vendor, model, region, filingNo: filing?.filingNo ?? null, source: setting.source });
  }
  // Models ops disclosed with a filing that are not in the task settings (e.g. used by the voice worker).
  for (const f of filings) {
    const key = `${f.vendor.toLowerCase()}/${f.model}`;
    if (seen.has(key) || out.some((m) => m.model === f.model)) continue;
    seen.add(key);
    out.push({ task: 'other', vendor: f.vendor.toLowerCase(), model: f.model, region: VENDOR_COUNTRY[f.vendor.toLowerCase()] ?? null, filingNo: f.filingNo, source: 'own' });
  }
  return out;
}

/**
 * GoApply only: a configured AI model is served outside mainland China (or by
 * a vendor whose country we cannot name), and nothing refuses that route. It
 * is the part of "personal information leaves the mainland" the environment
 * predicate cannot see: GoApply's own provider may itself be offshore
 * (CN_LLM_PROVIDER=openrouter), and an admin override in the database can
 * send a task abroad with no env variable involved (read from the snapshot
 * `loadAiStackSnapshot` loaded). Under the domestic-only wall every
 * non-mainland route is refused, so the answer is no.
 */
export function aiLeavesMainland(brand: ProductBrand, env: EnvSource = process.env): boolean {
  if (brand.market !== 'cn' || cnLlmDomesticOnly(env)) return false;
  return configuredModels(brand, env).some((m) => m.task !== 'other' && m.region !== 'CN');
}

export function neonRegion(databaseUrl: string | null): string | null {
  if (!databaseUrl) return null;
  const m = /\.([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech/i.exec(databaseUrl);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Country of an AWS region Neon runs in. Only regions we can name with
 * certainty are listed; anything else (or no parsable region) is null and
 * renders "Not listed" — never a guessed country.
 */
const AWS_REGION_COUNTRY: Readonly<Record<string, string>> = {
  'us-east-1': 'US',
  'us-east-2': 'US',
  'us-west-1': 'US',
  'us-west-2': 'US',
  'ca-central-1': 'CA',
  'sa-east-1': 'BR',
  'eu-central-1': 'DE',
  'eu-west-1': 'IE',
  'eu-west-2': 'GB',
  'eu-west-3': 'FR',
  'eu-north-1': 'SE',
  'ap-southeast-1': 'SG',
  'ap-southeast-2': 'AU',
  'ap-northeast-1': 'JP',
  'ap-northeast-2': 'KR',
  'ap-south-1': 'IN',
};

export function awsRegionCountry(region: string | null): string | null {
  return region ? (AWS_REGION_COUNTRY[region] ?? null) : null;
}

/**
 * Country of the bucket GoApply writes to, when its endpoint establishes it.
 * GoApply only, and only 'CN': the endpoint is mainland object storage
 * (`isMainlandStorageHost`: a named mainland region of Aliyun OSS, Tencent COS
 * or Huawei OBS, or an operator-listed mainland host; Hong Kong regions are
 * not mainland there). One case stays "Not listed" although that rule lets it
 * through: an in-cluster address unless the deployment itself is the mainland
 * stack. The shared bucket, which GoApply uses when it has none of its own,
 * has no country we can read from configuration, like RoboApply's.
 */
export function storageCountry(brand: ProductBrand, env: EnvSource = process.env): string | null {
  if (brand.market !== 'cn') return null;
  const host = hostOf(brandEnv(brand, 'S3_ENDPOINT', env) ?? null);
  if (!host || !isMainlandStorageHost(host, env)) return null;
  if (isPrivateHost(host)) return isCnMainland(env) ? 'CN' : null;
  return 'CN';
}

/** The name the push row carries: a browser decides which vendor delivers its notifications. */
export const WEB_PUSH_PROCESSOR_NAME = 'Browser push service (Google, Apple, Mozilla)';

/**
 * Processors derived from what this deployment is configured to use FOR THIS
 * BRAND: the email transport it really sends through, the voice plane, speech
 * set, file store and push keys it resolves, its payment rails and its models.
 * GoApply on the shared stack therefore lists the same processors as
 * RoboApply; its own providers appear only when they are configured.
 */
export function configuredProcessors(brand: ProductBrand, env: EnvSource = process.env): DisclosuresResponse['processors'] {
  const out: DisclosuresResponse['processors'] = [];
  const add = (name: string, purpose: ProcessorPurpose, country: string | null, region: string | null = null) => {
    if (!out.some((p) => p.name === name && p.purpose === purpose)) out.push({ name, purpose, country, region });
  };
  const db = val(env, 'DATABASE_URL');
  if (db && /neon\.tech/i.test(db)) {
    const region = neonRegion(db);
    add('Neon', 'database', awsRegionCountry(region), region);
  }
  if (val(env, 'VERCEL') || val(env, 'VERCEL_ENV')) add('Vercel', 'hosting', 'US');
  const cn = brand.market === 'cn';

  // Email: the transport the brand really sends through (platform/email).
  const transport = transportNameFor(brand, env);
  if (transport === 'resend' && val(env, 'RESEND_API_KEY')) add('Resend', 'email', 'US');
  if (cn && transport === 'aliyun_dm' && val(env, 'ALIYUN_DM_ACCESS_KEY_ID')) add('Aliyun DirectMail', 'email', 'CN');

  // Voice: the media plane of the brand's `voice` group. A plane of GoApply's
  // own that is not on LiveKit Cloud is named without the "Cloud".
  const livekit = brandEnv(brand, 'LIVEKIT_URL', env);
  if (livekit) {
    const ownPlane = brandStack(brand, 'voice', env) === 'own';
    const onCloud = /(?:^|\.)livekit\.cloud$/.test(hostOf(livekit) ?? '');
    add(ownPlane && !onCloud ? 'LiveKit' : 'LiveKit Cloud', 'voice', null);
  }
  // Speech: the shared speech vendors, unless GoApply has its own speech pair
  // (domestic models, disclosed through CN_GENAI_DISCLOSURES).
  if (brandStack(brand, 'speech', env) === 'shared') {
    if (val(env, 'DEEPGRAM_API_KEY')) add('Deepgram', 'speech', 'US');
    if (val(env, 'CARTESIA_API_KEY')) add('Cartesia', 'speech', 'US');
  }

  // Payments: the rails the brand can really charge through.
  if (!cn && val(env, 'STRIPE_SECRET_KEY')) add('Stripe', 'payments', 'US');
  if (cn && requirementsMet('pay.alipay', brand, env)) add('Alipay', 'payments', 'CN');
  if (cn && requirementsMet('pay.wechatpay', brand, env)) add('WeChat Pay', 'payments', 'CN');

  // File storage: the bucket of the brand's `storage` group. "(CN)" only when
  // the endpoint is mainland object storage; GoApply on the shared bucket gets
  // RoboApply's row.
  if (brandEnv(brand, 'S3_BUCKET', env)) {
    const country = storageCountry(brand, env);
    add(country === 'CN' ? 'Object storage (CN)' : 'Object storage', 'storage', country);
  }

  // Web push: the keys of the brand's `push` group. The browser's own push
  // service delivers the notification; which one depends on the browser.
  if (brandEnv(brand, 'VAPID_PUBLIC_KEY', env) && brandEnv(brand, 'VAPID_PRIVATE_KEY', env) && brandEnv(brand, 'VAPID_SUBJECT', env)) {
    add(WEB_PUSH_PROCESSOR_NAME, 'push', null);
  }

  // GoApply: generative-AI input and output are checked by Aliyun Content
  // Moderation (mainland) — listed only when that provider is really the one
  // configured and usable (WP-24); the built-in keyword filter sends nothing out.
  if (cn) {
    const safety = contentSafetyReadiness(env);
    if (safety.usable && safety.provider === 'aliyun_green') add('Aliyun Content Moderation', 'content_safety', 'CN', val(env, 'ALIYUN_GREEN_REGION'));
  }
  for (const m of configuredModels(brand, env)) add(m.vendor, 'ai_models', m.region);
  return out;
}

function filings(brand: ProductBrand, env: EnvSource): DisclosuresResponse['filings'] {
  if (brand.market !== 'cn') return {};
  const out: DisclosuresResponse['filings'] = {};
  const icp = val(env, 'CN_ICP_NUMBER');
  const psb = val(env, 'CN_PSB_NUMBER');
  const edi = val(env, 'CN_EDI_LICENCE_NUMBER');
  const hr = val(env, 'CN_HR_LICENCE_NUMBER');
  const genai = val(env, 'CN_GENAI_APP_REGISTRATION_NO');
  const algo = val(env, 'CN_ALGORITHM_FILING_NO');
  if (icp) out.icp = icp;
  if (psb) out.psb = psb;
  if (edi) out.edi = edi;
  if (hr) out.hrLicence = hr;
  if (genai) out.genaiRegistration = genai;
  if (algo) out.algorithmFiling = algo;
  return out;
}

/** The outside resume parser, named once here for the notices (the bundles and components carry no vendor name). */
export const MAINLAND_RESUME_PARSER_NAME = 'GoHire';

/**
 * Where and how the brand's data is processed on this deployment —
 * `residencySummary(brand)`, nothing added. The bucket endpoint host is left
 * out on purpose: this goes to an unauthenticated endpoint, and for some
 * object stores the host carries the account id or names the bucket endpoint.
 */
export function processingFacts(brand: ProductBrand, env: EnvSource = process.env): ProcessingFacts {
  const r = residencySummary(brand, env);
  return {
    region: r.region,
    stage: r.stage,
    originalFiles: r.originalFiles,
    storage: r.storage,
    resumeParsing: r.resumeParsing,
    resumeParser: r.resumeParsing === 'gohire_mainland' ? MAINLAND_RESUME_PARSER_NAME : null,
    redactedBeforeStorage: [...r.redactedBeforeStorage],
    imagesDiscarded: r.imagesDiscarded,
  };
}

/**
 * The rule the brand's AI routing follows on this deployment.
 *   RoboApply  'no_mainland', always.
 *   GoApply    'open' by default: its requests go to the models configured for
 *              it, on the shared stack when it has none of its own (D5).
 *              'mainland_only' when the domestic-only wall is on
 *              (CN_LLM_DOMESTIC_ONLY, or CN_RESIDENCY_STRICT, which implies
 *              it): the router then refuses every non-mainland endpoint, with
 *              or without a domestic model configured.
 */
export function llmEndpointRule(brand: ProductBrand, env: EnvSource = process.env): LlmEndpointFacts['rule'] {
  if (brand.market !== 'cn') return 'no_mainland';
  return cnLlmDomesticOnly(env) ? 'mainland_only' : 'open';
}

/**
 * The AI endpoint lists of the routing policy, straight from its own tables
 * (PROVIDER_DEFAULT_BASE_URLS, MAINLAND_LLM_HOST_SUFFIXES,
 * OPENROUTER_MAINLAND_UPSTREAMS) so the notice and the enforcement can never
 * name different hosts:
 *   no_mainland    (RoboApply) providers = every provider whose default host
 *                  is outside mainland China (a local model server is not a
 *                  processor); mainlandHosts = the hosts user data is never
 *                  sent to; excludedUpstreams = the OpenRouter upstreams that
 *                  are skipped.
 *   mainland_only  (GoApply behind the wall) providers = the domestic
 *                  providers, each on its default host; mainlandHosts = the
 *                  allowlist (plus CN_LLM_DOMESTIC_HOSTS).
 *   open           (GoApply by default) providers = every provider it can
 *                  reach: the ones RoboApply can use plus the domestic ones.
 *                  No host is allowed or refused by rule, so mainlandHosts is
 *                  empty; the models really in use are the models list.
 */
export function llmEndpointFacts(brand: ProductBrand, env: EnvSource = process.env): LlmEndpointFacts {
  const rule = llmEndpointRule(brand, env);
  const mainlandHosts = [...new Set<string>([...MAINLAND_LLM_HOST_SUFFIXES, ...extraDomesticHosts(env)])];
  const providers: LlmEndpointFacts['providers'] = [];
  const seenHosts = new Set<string>();
  for (const [provider, baseUrl] of Object.entries(PROVIDER_DEFAULT_BASE_URLS)) {
    const host = hostOf(baseUrl);
    if (!host || host === 'localhost' || seenHosts.has(host)) continue;
    const mainland = isMainlandLlmHost(host, env);
    const domesticDirect = mainland && (GOAPPLY_DIRECT_PROVIDERS as readonly string[]).includes(provider);
    const listed = rule === 'mainland_only' ? domesticDirect : rule === 'no_mainland' ? !mainland : !mainland || domesticDirect;
    if (!listed) continue;
    seenHosts.add(host);
    providers.push({ provider, host });
  }
  return {
    rule,
    providers,
    mainlandHosts: rule === 'open' ? [] : mainlandHosts,
    excludedUpstreams: rule === 'no_mainland' ? openRouterIgnoredUpstreams(env) : [],
  };
}

/**
 * GoApply: personal information leaves mainland China on this deployment, so
 * the cross-border consent is asked and its text applies. The environment
 * predicate shared with sign-up (`crossBorderApplies`: offshore deployment, or
 * part of the stack is the shared one), OR a configured AI model that is
 * served outside the mainland (`aiLeavesMainland`, which also sees database
 * overrides). Always false for RoboApply.
 *
 * Synchronous: for the live process, await `loadAiStackSnapshot()` first so
 * the admin overrides are part of the answer on a cold instance too.
 */
export function crossBorderConsentApplies(brand: ProductBrand, env: EnvSource = process.env): boolean {
  if (brand.market !== 'cn') return false;
  return crossBorderApplies(brand, env) || aiLeavesMainland(brand, env);
}

function attributionPurpose(sourceId: string): DataAttributionPurpose {
  if (sourceId === CITY_TABLE_SOURCE.id) return 'job_locations';
  if (sourceId === STAFFING_AGENCY_SOURCE.id) return 'agency_marking';
  return 'role_categories';
}

/** Datasets whose licence requires public attribution (e.g. CC BY); the team's own compilations are not listed. */
export function dataAttributions(): DataAttributionView[] {
  return jobDataAttributions()
    .filter((a) => a.attributionRequired)
    .map((a) => ({
      id: a.source.id,
      purpose: attributionPurpose(a.source.id),
      name: a.source.name,
      publisher: a.source.publisher,
      url: a.source.url,
      license: a.source.license,
      asOf: a.asOf,
    }));
}

export function buildDisclosures(brand: ProductBrand, env: EnvSource = process.env): DisclosuresResponse {
  return {
    brand: brand.id,
    models: configuredModels(brand, env),
    filings: filings(brand, env),
    processors: configuredProcessors(brand, env),
    offshore: crossBorderConsentApplies(brand, env),
    statusNote: brand.market === 'cn' ? val(env, 'CN_GENAI_STATUS_NOTE') : null,
    processing: processingFacts(brand, env),
    llmEndpoints: llmEndpointFacts(brand, env),
    dataAttributions: dataAttributions(),
  };
}

/** The legal footer for a brand; every line only when its value is set. */
export function buildLegalFooter(brand: ProductBrand, env: EnvSource = process.env): LegalFooterModel {
  const cn = brand.market === 'cn';
  const entity = brandEnv(brand, 'LEGAL_ENTITY_NAME', env) ?? (brand.legalEntity || null);
  const icp = cn ? val(env, 'CN_ICP_NUMBER') : null;
  const psb = cn ? val(env, 'CN_PSB_NUMBER') : null;
  const psbCode = cn ? val(env, 'CN_PSB_RECORD_CODE') : null;
  const hr = cn ? val(env, 'CN_HR_LICENCE_NUMBER') : null;
  const hrHolder = cn ? val(env, 'CN_HR_LICENCE_HOLDER') : null;
  const complaintEmail = cn ? val(env, 'CN_COMPLAINT_EMAIL') : null;
  const complaintPhone = cn ? val(env, 'CN_COMPLAINT_PHONE') : null;
  const showModels = Boolean(brand.legal.aiModelDisclosure);
  return {
    brand: brand.id,
    market: brand.market,
    entity,
    links: LEGAL_FOOTER_DOCS[brand.market].map((doc) => ({ doc, href: `/legal/${doc}` })),
    icp: icp ? { number: icp, url: ICP_LOOKUP_URL } : null,
    psb: psb ? { number: psb, url: psbCode ? `${PSB_LOOKUP_URL_PREFIX}${encodeURIComponent(psbCode)}` : null } : null,
    edi: cn ? val(env, 'CN_EDI_LICENCE_NUMBER') : null,
    hrLicence: hr && hrHolder ? { number: hr, holder: hrHolder } : null,
    aiModels: showModels ? configuredModels(brand, env).map(({ vendor, model, filingNo }) => ({ vendor, model, filingNo })) : [],
    genaiRegistration: cn ? val(env, 'CN_GENAI_APP_REGISTRATION_NO') : null,
    algorithmFiling: cn ? val(env, 'CN_ALGORITHM_FILING_NO') : null,
    statusNote: cn ? val(env, 'CN_GENAI_STATUS_NOTE') : null,
    complaints: complaintEmail || complaintPhone ? { email: complaintEmail, phone: complaintPhone } : null,
  };
}
