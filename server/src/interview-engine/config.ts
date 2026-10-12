// backend/src/interview-engine/config.ts
//
// SINGLE SOURCE OF TRUTH for every environment-variable read in the Interview
// Engine. No other file in backend/src/interview-engine/* should touch
// `process.env` directly — import a helper from here instead.
//
// All reads happen at CALL TIME (not module load) so dotenv ordering in
// backend/src/index.ts never bites us (the same reason RAMockInterviewerAgent
// resolves its model lazily).
//
// Env vars consumed (all optional except where a feature requires them):
//   LiveKit (required for live sessions):
//     LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
//     LIVEKIT_AGENT_NAME            — agent worker name to dispatch (explicit dispatch)
//     LIVEKIT_AGENT_CALLBACK_SECRET — shared secret the worker echoes on callbacks
//   R2 / S3 (required for recording + transcript persistence):
//     S3_BUCKET, S3_REGION (default 'auto'), S3_ENDPOINT,
//     S3_ACCESS_KEY_ID|AWS_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY|AWS_SECRET_ACCESS_KEY,
//     S3_FORCE_PATH_STYLE
//   Worker model selection (passed to the worker via room metadata; overridable):
//     LLM_INTERVIEW_LIVE_MODEL, LLM_INTERVIEW_LIVE_REASONING_EFFORT — the live
//        turn model (falls back to LLM_INTERVIEW_MODEL; effort defaults 'low' for
//        reasoning models (gpt-5/6, o-series, gpt-oss), none otherwise),
//     LLM_INTERVIEW_MODEL, LLM_INTERVIEW_REASONING_EFFORT (blueprint + evaluation),
//     LLM_INTERVIEW_BLUEPRINT_MODEL, LLM_INTERVIEW_BLUEPRINT_REASONING_EFFORT
//        (optional faster model for session preparation),
//     INTERVIEW_ENGINE_STT_MODEL
//   Callback wiring:
//     INTERVIEW_ENGINE_CALLBACK_BASE_URL — base URL the worker uses to reach this
//        backend (e.g. https://api.robohire.io). Falls back to BACKEND_PUBLIC_URL /
//        PUBLIC_BACKEND_URL; in production (VERCEL=1 / NODE_ENV=production) to the
//        public origin of the create request (allowlisted hosts only, see
//        INTERVIEW_ENGINE_CALLBACK_ALLOWED_HOSTS), else http://localhost:<PORT>.
//   Tuning:
//     INTERVIEW_ENGINE_JOIN_TOKEN_TTL_SEC (default 3600)
//     INTERVIEW_ENGINE_SESSION_EXPIRY_MIN (default 120)
//     INTERVIEW_ENGINE_RECORDING_ENABLED  (default false — opt-in)
//   Per brand (owner ruling D5; GOAPPLY_PARITY_PLAN.md §3.1, §3.5). RoboApply
//   reads the unprefixed names above. For GoApply a `CN_` value is an OPTIONAL
//   OVERRIDE; without it GoApply runs on the shared stack RoboApply uses:
//     voice plane   CN_LIVEKIT_URL starts GoApply's own plane. Then every
//        member is read as CN_ (CN_LIVEKIT_API_KEY / _API_SECRET,
//        CN_LIVEKIT_AGENT_CALLBACK_SECRET, CN_VOICE_PROVIDER,
//        CN_INTERVIEW_ENGINE_AGENT_NAME (default 'GoApply-Interview'),
//        CN_INTERVIEW_ENGINE_CALLBACK_BASE_URL) and the shared keys are never
//        mixed in. Without it: the shared LiveKit project, its worker and its
//        agent name (INTERVIEW_ENGINE_AGENT_NAME, else 'RoboApply-Interview').
//        A session stores which of the two it was created on (`VoiceStack`)
//        and keeps that plane for its life (`runOnVoiceStack`).
//     speech        CN_INTERVIEW_ENGINE_STT_MODEL + _TTS_MODEL (both; then
//        _STT_FALLBACK_MODELS / _TTS_VOICE(_MALE)) select DashScope speech.
//        Without the pair: the shared voice catalog and STT.
//     storage       CN_S3_BUCKET starts GoApply's own bucket (CN_S3_*);
//        without it recordings and transcripts use the shared bucket.
//     models        CN_LLM_INTERVIEW_MODEL / _LIVE_MODEL (+ _REASONING_EFFORT)
//        / _BLUEPRINT_MODEL, each falling back to the shared name. On the
//        shared plane the live worker runs LiveKit Inference: a CN model with
//        no equivalent there still plans and scores the practice, and the
//        live turns use the shared interview model.
//     per key       CN_INTERVIEW_ENGINE_RECORDING_ENABLED,
//        CN_INTERVIEW_RETENTION_DAYS (each falls back to the shared name).
//   CN_INTERVIEW_CAMERA_PUBLISH=false — GoApply keeps the camera a local
//     preview and records audio only (default: the same policy as RoboApply).
//   CN_LLM_DOMESTIC_ONLY / CN_RESIDENCY_STRICT (operator opt-in): GoApply's
//     live interviewer may only run a domestic model on GoApply's own plane.
//     Until that plane exists voice is reported unavailable (`voiceRoutingProblem`)
//     and the setup offers the written practice.
//   CN_RESIDENCY_STRICT also requires a bucket of GoApply's own for NEW
//     recordings and transcript files (`getR2WriteCreds`): without CN_S3_BUCKET
//     nothing new is written to the shared bucket; what earlier sessions stored
//     there stays readable and is still deleted on time.
//   VOICE_PROVIDER / CN_VOICE_PROVIDER — livekit_cloud (default) |
//     livekit_selfhosted | volcano | trtc (the last two reserved, unimplemented).
//   INTERVIEW_RETENTION_DAYS / CN_INTERVIEW_RETENTION_DAYS — default 90, never
//     longer than the 90 days both privacy notices publish.

import { AsyncLocalStorage } from 'node:async_hooks';
import { getEnvModelSetting } from '../lib/llm/llmModels.js';
import { getTaskModel, getTaskReasoningEffort } from '../lib/llm/llmTaskSettings.js';
import {
  brandEnv,
  brandEnvGroupProblems,
  brandOwnEnv,
  brandStack,
  cnLlmDomesticOnly,
  cnResidencyStrict,
  parseBoolEnv,
} from '../platform/brand/brandEnv.js';
import { BRAND_IDS, getBrand, DEFAULT_BRAND, type BrandId, type ProductBrand } from '../platform/brand/registry.js';
import { cnOwnStorageProblem } from '../platform/residency/uploadPolicy.js';
import { getCurrentBrandId } from '../lib/requestContext.js';
import { isGoApplyDirectProvider } from '../platform/llm/brandPolicy.js';
import { parseReasoningEffort, type ReasoningEffort } from '../services/llm/reasoningEffort.js';
import type { InterviewReasoningEffort } from './types.js';

export class InterviewEngineConfigError extends Error {
  readonly code = 'interview_engine_not_configured';
  constructor(message: string) {
    super(message);
    this.name = 'InterviewEngineConfigError';
  }
}

// ─── Brand resolution ───────────────────────────────────────────────────

/** A brand id or registry entry; omitted = the brand of the current unit of
 *  work (request, cron or `runWithBrand`), else the default brand (RoboApply). */
export type InterviewBrandRef = BrandId | ProductBrand | undefined;

function safeCurrentBrandId(): BrandId | undefined {
  try {
    return getCurrentBrandId();
  } catch {
    return undefined;
  }
}

/** Resolve a brand reference. No context → the default brand, whose names are
 *  the unprefixed Wave 0 variables, so legacy callers read what they always did. */
export function interviewBrand(brand?: InterviewBrandRef): ProductBrand {
  if (brand && typeof brand === 'object') return brand;
  return getBrand(brand ?? safeCurrentBrandId() ?? DEFAULT_BRAND);
}

// ─── The media plane a brand runs on (D5; plan §3.5) ──────────────────────

/**
 * Which LiveKit plane a brand's session runs on: `own` = GoApply's own project
 * (CN_LIVEKIT_URL is set, every member read as CN_), `shared` = the project
 * RoboApply uses. RoboApply is always `shared`.
 */
export type VoiceStack = 'own' | 'shared';

export function isVoiceStack(value: unknown): value is VoiceStack {
  return value === 'own' || value === 'shared';
}

interface VoiceStackPin {
  brand: BrandId;
  stack: VoiceStack;
}

const pinnedVoiceStack = new AsyncLocalStorage<VoiceStackPin>();

/**
 * Run `fn` with the brand's media plane fixed to `stack`. A session records its
 * plane at create; every later piece of session work runs through here, so
 * adding or removing CN_LIVEKIT_* while a session is live never moves it to
 * another LiveKit project, worker or callback secret. No stack (a row older
 * than the stored stack, or RoboApply) = the plane the environment selects now.
 */
export function runOnVoiceStack<T>(brand: BrandId, stack: VoiceStack | null | undefined, fn: () => T): T {
  if (!stack) return fn();
  const current = pinnedVoiceStack.getStore();
  if (current && current.brand === brand && current.stack === stack) return fn();
  return pinnedVoiceStack.run({ brand, stack }, fn);
}

/**
 * The plane of a brand: the explicit `stack`, else the one pinned for the
 * current unit of work (`runOnVoiceStack`), else `brandStack(brand, 'voice')`
 * (the `voice` group rule of platform/brand/brandEnv.ts).
 */
export function voiceStack(brand?: InterviewBrandRef, stack?: VoiceStack | null): VoiceStack {
  const b = interviewBrand(brand);
  if (b.market !== 'cn') return 'shared';
  if (stack) return stack;
  const pin = pinnedVoiceStack.getStore();
  if (pin && pin.brand === b.id) return pin.stack;
  return brandStack(b, 'voice');
}

function sharedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * One member of the `voice` group, read wholly from the plane in use: CN_NAME
 * on GoApply's own plane (undefined when unset, never the shared value), NAME
 * on the shared one. With no pin this is exactly `brandEnv(brand, name)`.
 */
function voiceEnv(b: ProductBrand, name: string, stack?: VoiceStack | null): string | undefined {
  return voiceStack(b, stack) === 'own' ? brandOwnEnv(b, name) : sharedEnv(name);
}

// ─── LiveKit ────────────────────────────────────────────────────────────

export interface LiveKitCreds {
  url: string;
  apiKey: string;
  apiSecret: string;
  /** Agent worker name for explicit dispatch. Null disables auto-dispatch. */
  agentName: string | null;
}

export function isLiveKitConfigured(brand?: InterviewBrandRef, stack?: VoiceStack | null): boolean {
  const b = interviewBrand(brand);
  return !!(voiceEnv(b, 'LIVEKIT_URL', stack) && voiceEnv(b, 'LIVEKIT_API_KEY', stack) && voiceEnv(b, 'LIVEKIT_API_SECRET', stack));
}

const LIVEKIT_NAMES = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const;

/** What to set, named for the plane in use (never a mix of the two sets). */
function liveKitNotConfiguredMessage(b: ProductBrand, stack: VoiceStack): string {
  if (b.market !== 'cn') return `LiveKit is not configured. Set ${LIVEKIT_NAMES.join(', ')}.`;
  if (stack === 'own') {
    const missing = LIVEKIT_NAMES.map((n) => `CN_${n}`).filter((n) => !process.env[n]?.trim());
    return (
      `LiveKit is not configured for ${b.name}'s own plane (CN_LIVEKIT_URL selects it). ` +
      `Set ${missing.join(', ') || LIVEKIT_NAMES.map((n) => `CN_${n}`).join(', ')}; the shared LIVEKIT_* values are never mixed in.`
    );
  }
  return (
    `LiveKit is not configured. ${b.name} uses the shared project: set ${LIVEKIT_NAMES.join(', ')} ` +
    `(or all of ${LIVEKIT_NAMES.map((n) => `CN_${n}`).join(', ')} for a plane of its own).`
  );
}

/** Throws InterviewEngineConfigError if LiveKit is not configured for the brand's plane. */
export function getLiveKitCreds(brand?: InterviewBrandRef, stack?: VoiceStack | null): LiveKitCreds {
  const b = interviewBrand(brand);
  const plane = voiceStack(b, stack);
  const url = voiceEnv(b, 'LIVEKIT_URL', plane);
  const apiKey = voiceEnv(b, 'LIVEKIT_API_KEY', plane);
  const apiSecret = voiceEnv(b, 'LIVEKIT_API_SECRET', plane);
  if (!url || !apiKey || !apiSecret) throw new InterviewEngineConfigError(liveKitNotConfiguredMessage(b, plane));
  return { url, apiKey, apiSecret, agentName: voiceEnv(b, 'LIVEKIT_AGENT_NAME', plane) || null };
}

/** The wss:// URL minus protocol coercion — used to derive the HTTPS host for
 *  the server-side service clients (RoomServiceClient/EgressClient want https). */
export function getLiveKitHttpUrl(brand?: InterviewBrandRef, stack?: VoiceStack | null): string {
  const { url } = getLiveKitCreds(brand, stack);
  return url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
}

/** The callback secret of the worker on the brand's plane (the shared worker's
 *  on the shared plane; CN_LIVEKIT_AGENT_CALLBACK_SECRET on GoApply's own). */
export function getAgentCallbackSecret(brand?: InterviewBrandRef, stack?: VoiceStack | null): string | null {
  return voiceEnv(interviewBrand(brand), 'LIVEKIT_AGENT_CALLBACK_SECRET', stack) || null;
}

/** The planes a brand's sessions may be on: the shared one, and its own when it has one. */
function voiceStacksOf(brand: BrandId): VoiceStack[] {
  return brandStack(brand, 'voice') === 'own' ? ['shared', 'own'] : ['shared'];
}

/** Every configured callback secret, each once (two brands on one plane share
 *  one). Only a cheap pre-filter: a callback is then checked against the
 *  secret of its session's plane alone (InterviewSessionService.assertCallbackSecret). */
export function getAgentCallbackSecrets(): string[] {
  const out: string[] = [];
  for (const id of BRAND_IDS) {
    for (const stack of voiceStacksOf(id)) {
      const s = getAgentCallbackSecret(id, stack);
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

/** One LiveKit project a webhook may be signed by, and the brands running on it now. */
export interface LiveKitPlane {
  apiKey: string;
  apiSecret: string;
  brands: BrandId[];
}

/**
 * Every configured LiveKit project, keyed by its API key: the shared one and,
 * when CN_LIVEKIT_* is set, GoApply's own. `brands` lists the brands whose
 * NEW sessions use that key (both brands on the shared project by default).
 * A half-set plane is not configured and is not listed.
 */
export function configuredLiveKitPlanes(): LiveKitPlane[] {
  const planes: LiveKitPlane[] = [];
  const add = (brand: BrandId, stack: VoiceStack, current: boolean) => {
    if (!isLiveKitConfigured(brand, stack)) return;
    const { apiKey, apiSecret } = getLiveKitCreds(brand, stack);
    let plane = planes.find((p) => p.apiKey === apiKey && p.apiSecret === apiSecret);
    if (!plane) {
      plane = { apiKey, apiSecret, brands: [] };
      planes.push(plane);
    }
    if (current && !plane.brands.includes(brand)) plane.brands.push(brand);
  };
  for (const id of BRAND_IDS) {
    const now = brandStack(id, 'voice');
    // The shared project still signs webhooks for sessions pinned to it before
    // a brand got a plane of its own, so it stays listed.
    for (const stack of voiceStacksOf(id)) add(id, stack, stack === now);
  }
  return planes;
}

/**
 * The agent worker name the interview engine dispatches. DELIBERATELY separate
 * from the shared `LIVEKIT_AGENT_NAME` (which is "Agent Alex" in this repo) so
 * the interview worker never collides with Agent Alex's LiveKit registration.
 * The Node worker (interview-agent/) must register this SAME name. The default
 * MUST stay 'RoboApply-Interview' — the deployed contract; a stale
 * 'RoboHire-Interview' fallback once dispatched interviews to nobody on the
 * shared LiveKit project (silent-room outage, 2026-07-03).
 *
 * The name is the one the worker ON THE PLANE registers: on the shared project
 * INTERVIEW_ENGINE_AGENT_NAME, else RoboApply's registry name, for both brands
 * ('GoApply-Interview' is registered by nobody there and would leave a silent
 * room); on GoApply's own plane CN_INTERVIEW_ENGINE_AGENT_NAME, else GoApply's
 * registry name.
 */
export function getInterviewAgentName(brand?: InterviewBrandRef, stack?: VoiceStack | null): string {
  const b = interviewBrand(brand);
  const plane = voiceStack(b, stack);
  const registryName = plane === 'own' ? b.interview.agentName : getBrand(DEFAULT_BRAND).interview.agentName;
  return voiceEnv(b, 'INTERVIEW_ENGINE_AGENT_NAME', plane) || registryName;
}

// ─── Voice provider (VoiceSessionProvider seam, CN-E-06) ─────────────────

export const VOICE_PROVIDER_IDS = ['livekit_cloud', 'livekit_selfhosted', 'volcano', 'trtc'] as const;
export type VoiceProviderId = (typeof VOICE_PROVIDER_IDS)[number];

/** VOICE_PROVIDER (CN_VOICE_PROVIDER on GoApply's own plane only); unset or unknown → livekit_cloud. */
export function getVoiceProviderId(brand?: InterviewBrandRef, stack?: VoiceStack | null): VoiceProviderId {
  const raw = (voiceEnv(interviewBrand(brand), 'VOICE_PROVIDER', stack) || '').toLowerCase();
  return (VOICE_PROVIDER_IDS as readonly string[]).includes(raw) ? (raw as VoiceProviderId) : 'livekit_cloud';
}

// ─── R2 / S3 ────────────────────────────────────────────────────────────

export interface R2Creds {
  bucket: string;
  region: string;
  endpoint: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/**
 * S3/R2 creds for interview artifacts, read as one set (the `storage` group of
 * brandEnv): RoboApply reads S3_* (and the AWS_* aliases). GoApply reads
 * CN_S3_* (and CN_AWS_*) when CN_S3_BUCKET is set, with no shared key mixed
 * in; without it GoApply's recordings and transcripts go to the shared bucket.
 * Objects are keyed by session id (`interviews/<sessionId>/…`), so the two
 * brands never collide there.
 */
export function getR2Creds(brand?: InterviewBrandRef): R2Creds | null {
  const b = interviewBrand(brand);
  const creds = r2CredsFrom((name) => brandEnv(b, name));
  if (creds && b.market === 'cn') noteInterviewStore(b);
  return creds;
}

/** One complete store from one set of names, or null (never a mix of two sets). */
function r2CredsFrom(read: (name: string) => string | undefined): R2Creds | null {
  const bucket = read('S3_BUCKET') || '';
  const accessKeyId = read('S3_ACCESS_KEY_ID') || read('AWS_ACCESS_KEY_ID') || '';
  const secretAccessKey = read('S3_SECRET_ACCESS_KEY') || read('AWS_SECRET_ACCESS_KEY') || '';
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    region: read('S3_REGION') || read('AWS_REGION') || 'auto',
    endpoint: read('S3_ENDPOINT') || undefined,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: ['true', '1', 'yes'].includes((read('S3_FORCE_PATH_STYLE') || '').toLowerCase()),
  };
}

/**
 * GoApply may not write NEW interview artifacts: the operator chose the strict
 * mainland posture (CN_RESIDENCY_STRICT: mainland storage required, plan §4)
 * and GoApply has no MAINLAND bucket of its own. The same predicate as resume
 * originals (`cnOwnStorageProblem`, platform/residency/uploadPolicy): the
 * four CN_S3_* values set and CN_S3_ENDPOINT on mainland object storage. A
 * bucket of its own on a foreign endpoint is not one: practice audio, video
 * and transcripts are held to the rule that holds the resume file. Never true
 * for RoboApply.
 */
export function interviewStorageWriteBlocked(brand?: InterviewBrandRef): boolean {
  const b = interviewBrand(brand);
  return b.market === 'cn' && cnResidencyStrict() && cnOwnStorageProblem(process.env) !== null;
}

/**
 * The store NEW recordings and transcript files of the brand are written to:
 * `getR2Creds`, except under CN_RESIDENCY_STRICT, where GoApply without a
 * mainland bucket of its own writes nothing (null: recording is not offered and the
 * transcript stays in the database only). Reads and deletes keep using
 * `getR2Creds`, so what earlier sessions stored in the shared bucket is still
 * played back and still deleted on time.
 */
export function getR2WriteCreds(brand?: InterviewBrandRef): R2Creds | null {
  const b = interviewBrand(brand);
  return interviewStorageWriteBlocked(b) ? null : getR2Creds(b);
}

/**
 * Stores that may still hold artifacts of this brand's EARLIER sessions. When
 * GoApply has its own bucket (CN_S3_BUCKET), sessions created before it was
 * set wrote to the shared bucket: deletes (retention, account purge, a user's
 * own delete) must reach those objects too, or the published 90-day retention
 * would silently miss them. Keys carry the session id, so a delete there can
 * only ever hit that session's own objects. Empty for RoboApply and for
 * GoApply on the shared bucket.
 */
export function getEarlierR2Creds(brand?: InterviewBrandRef): R2Creds[] {
  const b = interviewBrand(brand);
  if (b.market !== 'cn' || brandStack(b, 'storage') !== 'own') return [];
  const shared = r2CredsFrom(sharedEnv);
  return shared ? [shared] : [];
}

const notedInterviewStores = new Set<string>();

/** Say once per process (and again if it changes) which store a GoApply
 *  session's recordings and transcripts use. Variable names only. */
function noteInterviewStore(b: ProductBrand): void {
  const stack = brandStack(b, 'storage');
  const key = `${b.id}:${stack}`;
  if (notedInterviewStores.has(key)) return;
  notedInterviewStores.add(key);
  console.info(
    stack === 'own'
      ? `[interview-engine] ${b.name} interview recordings and transcripts use its own bucket (CN_S3_BUCKET).`
      : `[interview-engine] ${b.name} interview recordings and transcripts use the shared bucket (S3_BUCKET); set CN_S3_BUCKET and its keys to give ${b.name} its own.`,
  );
}

/** Test seam: forget which stores were announced. */
export function __resetInterviewStoreNoteForTest(): void {
  notedInterviewStores.clear();
}

export function isR2Configured(brand?: InterviewBrandRef): boolean {
  return getR2Creds(brand) !== null;
}

/** All interview artifacts live under this R2 prefix. */
export const INTERVIEW_R2_PREFIX = 'interviews';

// ─── Worker models (passed via room metadata) ──────────────────────────────
//
// These are LiveKit Inference model identifiers consumed by the Node worker.
// The per-locale STT/voice can still be refined by the voice catalog.

/**
 * Model IDs that have the same namespace in our backend selector and LiveKit
 * Inference. This is a compatibility catalog, never a fallback: the selected
 * entry still comes exclusively from LLM_INTERVIEW_MODEL. Keep it aligned with
 * what the LiveKit Inference gateway actually serves: its docs
 * (https://docs.livekit.io/agents/models/inference/) and the worker SDK's
 * model union both lag the gateway, so probe a new ID before adding it:
 *
 *   cd interview-agent && npm run verify:llm -- [model ...] [--effort high]
 *
 * It streams a reply through the worker's own LLM construction using only the
 * LIVEKIT_* creds in interview-agent/.env.local; with no model it probes every
 * ID below. interview-agent/verify-llm.mjs mirrors this list — update both.
 */
const ALIGNED_INTERVIEW_MODELS = [
  // Gateway-verified 2026-09-28, before docs.livekit.io listed any GPT-6 model.
  // gpt-6-terra, gpt-6-astra and the -pro variants 404 there, so they stay out.
  'openai/gpt-6-luna',
  'openai/gpt-6-sol',
  'openai/gpt-5.5',
  'openai/gpt-5.6-luna',
  'openai/gpt-5.6-sol',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.4',
  'openai/gpt-5.4-mini',
  'openai/gpt-5.4-nano',
  'openai/gpt-5.3-chat-latest',
  'openai/gpt-5.2',
  'openai/gpt-5.2-chat-latest',
  'openai/gpt-5.1',
  'openai/gpt-5.1-chat-latest',
  'openai/gpt-5',
  'openai/gpt-5-mini',
  'openai/gpt-5-nano',
  'openai/gpt-4.1',
  'openai/gpt-4.1-mini',
  'openai/gpt-4.1-nano',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'openai/chat-latest',
  'openai/gpt-oss-120b',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3-flash-preview',
  'google/gemini-3.1-flash-lite',
  'google/gemini-3.5-flash',
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.6-flash',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  'google/gemini-2.5-flash-lite',
] as const;

/** Backend selector → semantically equivalent LiveKit Inference model ID. */
const LIVEKIT_MODEL_BY_BACKEND_SELECTOR = new Map<string, string>();

for (const model of ALIGNED_INTERVIEW_MODELS) {
  // Native backend routing and explicit OpenRouter routing both resolve to the
  // same model family in LiveKit's own namespace.
  LIVEKIT_MODEL_BY_BACKEND_SELECTOR.set(model, model);
  LIVEKIT_MODEL_BY_BACKEND_SELECTOR.set(`openrouter/${model}`, model);

  // LLMService accepts gemini/... as a direct-provider alias for google/....
  // LiveKit uses only the google namespace, so normalize that alias here too.
  if (model.startsWith('google/')) {
    LIVEKIT_MODEL_BY_BACKEND_SELECTOR.set(`gemini/${model.slice('google/'.length)}`, model);
  }
}

for (const version of ['kimi-k2.5', 'kimi-k2.6']) {
  const workerModel = `moonshotai/${version}`;
  LIVEKIT_MODEL_BY_BACKEND_SELECTOR.set(`kimi/${version}`, workerModel);
  LIVEKIT_MODEL_BY_BACKEND_SELECTOR.set(`moonshot/${version}`, workerModel);
  LIVEKIT_MODEL_BY_BACKEND_SELECTOR.set(`openrouter/${workerModel}`, workerModel);
}

// The backend's direct DeepSeek namespace and LiveKit's hosted namespace are
// intentionally different. V4 Flash has no LiveKit Inference equivalent, so
// it is not silently substituted with V4 Pro.
LIVEKIT_MODEL_BY_BACKEND_SELECTOR.set(
  'deepseek/deepseek-v4-pro',
  'deepseek-ai/deepseek-v4-pro',
);
LIVEKIT_MODEL_BY_BACKEND_SELECTOR.set(
  'openrouter/deepseek/deepseek-v4-pro',
  'deepseek-ai/deepseek-v4-pro',
);

export interface InterviewLlmRouting {
  /** Exact task selector consumed by backend interview agents. */
  backendModel: string;
  /** Equivalent model ID consumed by LiveKit Inference. */
  workerModel: string;
  reasoningEffort?: InterviewReasoningEffort;
}

/**
 * The interview task model of a brand. RoboApply (and no brand context) keeps
 * the Wave 0 read; GoApply reads CN_LLM_INTERVIEW_MODEL, else the shared
 * LLM_INTERVIEW_MODEL (the per-key fallback of the model resolver).
 */
function interviewTaskModel(b: ProductBrand): string | undefined {
  return b.market === 'cn' ? getTaskModel('interview', b) : getTaskModel('interview');
}

/** A per-key interview setting: CN_NAME, else NAME on GoApply; NAME on RoboApply. */
function interviewEnv(b: ProductBrand, name: string): string | undefined {
  return b.market === 'cn' ? brandEnv(b, name) : sharedEnv(name);
}

function requireInterviewBackendModel(b: ProductBrand): string {
  const model = interviewTaskModel(b);
  if (!model) {
    throw new InterviewEngineConfigError(
      'Interview LLM is not configured. Set LLM_INTERVIEW_MODEL.',
    );
  }
  return model;
}

function mapInterviewModelToWorker(backendModel: string, envName = 'LLM_INTERVIEW_MODEL'): string {
  const workerModel = LIVEKIT_MODEL_BY_BACKEND_SELECTOR.get(backendModel);
  if (!workerModel) {
    throw new InterviewEngineConfigError(
      `${envName}="${backendModel}" has no supported equivalent in LiveKit Inference. ` +
      'Configure one model selector supported by both the backend LLM stack and LiveKit Inference.',
    );
  }
  return workerModel;
}

interface LiveSelector {
  selector: string;
  envName: string;
  /** A value GoApply set for itself (a CN_ override), not the shared one. */
  own: boolean;
}

/**
 * The selectors the LIVE worker turns may run on, in order, before LiveKit
 * mapping: LLM_INTERVIEW_LIVE_MODEL when set, else the interview task model
 * (backward compatible). GoApply reads each per key, its own value first:
 * CN live, shared live, its own task model, the shared task model. The shared
 * ones are read exactly as RoboApply reads them.
 */
function liveModelCandidates(b: ProductBrand): LiveSelector[] {
  const out: LiveSelector[] = [];
  const add = (selector: string | undefined, envName: string, own: boolean) => {
    if (selector) out.push({ selector, envName, own });
  };
  if (b.market !== 'cn') {
    add(sharedEnv('LLM_INTERVIEW_LIVE_MODEL'), 'LLM_INTERVIEW_LIVE_MODEL', false);
    add(interviewTaskModel(b), 'LLM_INTERVIEW_MODEL', false);
    return out;
  }
  add(brandOwnEnv(b, 'LLM_INTERVIEW_LIVE_MODEL'), 'CN_LLM_INTERVIEW_LIVE_MODEL', true);
  add(sharedEnv('LLM_INTERVIEW_LIVE_MODEL'), 'LLM_INTERVIEW_LIVE_MODEL', false);
  const sharedTask = getTaskModel('interview', DEFAULT_BRAND);
  const ownTask = interviewTaskModel(b);
  if (ownTask && ownTask !== sharedTask) {
    // Its own value: CN_LLM_INTERVIEW_MODEL, or one set for it in the admin model settings.
    add(ownTask, brandOwnEnv(b, 'LLM_INTERVIEW_MODEL') ? 'CN_LLM_INTERVIEW_MODEL' : `${b.name} interview model`, true);
  }
  add(sharedTask, 'LLM_INTERVIEW_MODEL', false);
  return out;
}

interface LiveWorkerModel {
  /** LiveKit Inference model id. */
  workerModel: string;
  /** GoApply's own selectors that have no LiveKit Inference equivalent and were passed over. */
  passedOver: LiveSelector[];
}

/**
 * The LiveKit Inference model of the live turns (the worker of the shared
 * plane, and any gateway worker): the first candidate, mapped through the
 * allowlist. A shared selector that does not map is a configuration error,
 * for both brands alike. One of GoApply's OWN selectors that does not map
 * (qwen, kimi, glm, doubao, minimax: an ordinary choice for its plans and
 * reports) is passed over instead, so a China override never turns voice off
 * (D5): the live turns then run on the shared interview model, and
 * `voiceConfigProblems` says so. Only when no shared model is left to run on
 * is that selector the error.
 */
function resolveLiveWorkerModel(b: ProductBrand): LiveWorkerModel {
  const passedOver: LiveSelector[] = [];
  for (const candidate of liveModelCandidates(b)) {
    if (candidate.own && !LIVEKIT_MODEL_BY_BACKEND_SELECTOR.has(candidate.selector)) {
      passedOver.push(candidate);
      continue;
    }
    return { workerModel: mapInterviewModelToWorker(candidate.selector, candidate.envName), passedOver };
  }
  const first = passedOver[0];
  if (first) mapInterviewModelToWorker(first.selector, first.envName); // throws, naming the variable
  throw new InterviewEngineConfigError(
    'Interview LLM is not configured. Set LLM_INTERVIEW_MODEL (or LLM_INTERVIEW_LIVE_MODEL for the live worker).',
  );
}

/** LiveKit Inference model id for live interview turns (the worker of the
 *  shared plane, and any gateway worker). */
export function getWorkerLlmModel(brand?: InterviewBrandRef): string {
  return resolveLiveWorkerModel(interviewBrand(brand)).workerModel;
}

/** True for LiveKit worker model ids that accept OpenAI's `reasoning_effort`
 *  (gpt-5*, gpt-6*, o-series, gpt-oss) — excluding the non-reasoning
 *  `chat-latest` aliases. gpt-4.1*, gpt-4o*, Gemini, Kimi and DeepSeek keep the
 *  pre-split behaviour (no effort unless explicitly configured), because
 *  OpenAI rejects `reasoning_effort` on non-reasoning models with a 400 and
 *  every live turn would then fail. */
export function liveModelAcceptsReasoningEffort(workerModel: string | undefined): boolean {
  if (!workerModel) return false;
  const id = workerModel.trim().toLowerCase();
  if (!id.startsWith('openai/')) return false;
  const name = id.slice('openai/'.length);
  if (name === 'chat-latest' || name.endsWith('-chat-latest')) return false;
  return /^(gpt-5|gpt-6|gpt-oss|o\d)/.test(name);
}

/** Reasoning effort for live turns: LLM_INTERVIEW_LIVE_REASONING_EFFORT when
 *  set; otherwise 'low' for reasoning-capable live models and undefined (no
 *  effort sent) for everything else. Voice turns are latency-bound (a 'high'
 *  effort costs ~5 s of dead air per turn), so the live worker never inherits
 *  the blueprint/evaluation dial. `workerModel` defaults to the resolved live
 *  model; an unresolvable model yields no default effort. */
export function getWorkerLlmReasoningEffort(workerModel?: string, brand?: InterviewBrandRef): InterviewReasoningEffort | undefined {
  const b = interviewBrand(brand);
  return liveReasoningEffort(b, workerModel, interviewEnv(b, 'LLM_INTERVIEW_LIVE_REASONING_EFFORT'));
}

function liveReasoningEffort(b: ProductBrand, workerModel: string | undefined, raw: string | undefined): InterviewReasoningEffort | undefined {
  const effort = parseReasoningEffort(raw);
  if (effort === 'max') {
    throw new InterviewEngineConfigError(
      'LLM_INTERVIEW_LIVE_REASONING_EFFORT=max is not supported by LiveKit Inference; use minimal, low, medium, or high.',
    );
  }
  if (effort) return effort;
  let model = workerModel;
  if (model === undefined) {
    try {
      model = getWorkerLlmModel(b);
    } catch {
      model = undefined;
    }
  }
  return liveModelAcceptsReasoningEffort(model) ? 'low' : undefined;
}

/** GoApply set an interview model of its own (CN_LLM_INTERVIEW_MODEL or CN_LLM_INTERVIEW_LIVE_MODEL). */
function cnInterviewModelSet(b: ProductBrand): boolean {
  return !!(brandOwnEnv(b, 'LLM_INTERVIEW_MODEL') || brandOwnEnv(b, 'LLM_INTERVIEW_LIVE_MODEL'));
}

/**
 * GoApply on its OWN plane with an interview model of its own (an optional
 * override, D5): the GoApply worker runs an OpenAI-compatible domestic model
 * (interview-agent `LLM_BACKEND=openai_compatible`), never LiveKit Inference.
 * CN_LLM_INTERVIEW_LIVE_MODEL (else GoApply's interview task model) is passed
 * to the worker as-is, and must name a GoApply direct provider (deepseek,
 * qwen, kimi, glm, doubao, minimax).
 */
function cnInterviewLlmRouting(brand: ProductBrand): InterviewLlmRouting {
  const backendModel = getTaskModel('interview', brand);
  if (!backendModel) {
    throw new InterviewEngineConfigError('GoApply interview LLM is not configured. Set CN_LLM_INTERVIEW_MODEL.');
  }
  const workerModel = brandOwnEnv(brand, 'LLM_INTERVIEW_LIVE_MODEL') || backendModel;
  const provider = workerModel.split('/')[0]!.trim().toLowerCase();
  if (!isGoApplyDirectProvider(provider)) {
    const name = brandOwnEnv(brand, 'LLM_INTERVIEW_LIVE_MODEL')
      ? 'CN_LLM_INTERVIEW_LIVE_MODEL'
      : brandOwnEnv(brand, 'LLM_INTERVIEW_MODEL') ? 'CN_LLM_INTERVIEW_MODEL' : 'LLM_INTERVIEW_MODEL';
    throw new InterviewEngineConfigError(
      `${name}="${workerModel}" is not a domestic model. Set CN_LLM_INTERVIEW_LIVE_MODEL (or CN_LLM_INTERVIEW_MODEL) to deepseek/, qwen/, kimi/, glm/, doubao/ or minimax/.`,
    );
  }
  const effort = parseReasoningEffort(brandOwnEnv(brand, 'LLM_INTERVIEW_LIVE_REASONING_EFFORT'));
  return { backendModel, workerModel, ...(effort && effort !== 'max' ? { reasoningEffort: effort } : {}) };
}

/**
 * Which routing a GoApply session gets (D5; plan §3.5, G3, G54). The live
 * worker model is written in the namespace of the worker that will run it, and
 * the worker is decided by the plane:
 *   shared plane   the shared (gateway) worker → RoboApply's resolution: the
 *                  live selector (CN_ override, else the shared one) mapped
 *                  through the same LiveKit Inference allowlist. A raw
 *                  domestic id is never sent there: a CN model with no
 *                  equivalent stays the backend model (plan and report) and
 *                  the live turns run on the shared interview model
 *                  (`resolveLiveWorkerModel`), so a China override never
 *                  turns voice off.
 *   own plane      with CN_LLM_INTERVIEW_MODEL / _LIVE_MODEL set: the domestic
 *                  model, as-is, for GoApply's own worker. Without one:
 *                  RoboApply's resolution (a gateway worker on GoApply's own
 *                  LiveKit project).
 * Under the opt-in domestic-only wall (CN_LLM_DOMESTIC_ONLY, or
 * CN_RESIDENCY_STRICT) the interviewer must be a domestic model on GoApply's
 * own plane: anything else is refused, never routed offshore. The practice
 * gate reads that refusal (`voiceRoutingProblem`), so voice is then reported
 * unavailable and the written practice is offered; a direct create is a 503.
 */
function usesCnInterviewRouting(b: ProductBrand): boolean {
  const own = voiceStack(b) === 'own';
  if (cnLlmDomesticOnly()) {
    if (!own) {
      throw new InterviewEngineConfigError(
        'CN_LLM_DOMESTIC_ONLY is on: GoApply voice practice needs its own media plane and worker (CN_LIVEKIT_URL, CN_LIVEKIT_API_KEY, CN_LIVEKIT_API_SECRET) with a domestic CN_LLM_INTERVIEW_MODEL. The shared LiveKit project runs LiveKit Inference models.',
      );
    }
    return true;
  }
  return own && cnInterviewModelSet(b);
}

/** Resolve the backend + worker pair once so a live-session claim is atomic
 *  with respect to hot configuration changes. The backend model (blueprint +
 *  evaluation) stays required: a session without it can never be prepared.
 *  RoboApply (and no brand context) keeps the Wave 0 resolution unchanged;
 *  GoApply follows it too unless it runs its own worker (see above). */
export function getInterviewLlmRouting(brand?: InterviewBrandRef): InterviewLlmRouting {
  const b = interviewBrand(brand);
  if (b.market === 'cn' && usesCnInterviewRouting(b)) return cnInterviewLlmRouting(b);
  const backendModel = requireInterviewBackendModel(b);
  const { workerModel, passedOver } = resolveLiveWorkerModel(b);
  // An effort GoApply set for a live model of its own belongs to that model:
  // when the model was passed over, the shared model runs with the shared effort.
  const ownLivePassedOver = passedOver.some((c) => c.envName === 'CN_LLM_INTERVIEW_LIVE_MODEL');
  const effort = ownLivePassedOver ? sharedEnv('LLM_INTERVIEW_LIVE_REASONING_EFFORT') : interviewEnv(b, 'LLM_INTERVIEW_LIVE_REASONING_EFFORT');
  return {
    backendModel,
    workerModel,
    reasoningEffort: liveReasoningEffort(b, workerModel, effort),
  };
}

/**
 * Why a NEW voice session of this brand cannot start, or null: the checks
 * `createSession` makes before it persists anything (the interview model
 * routing, the domestic-only wall, GoApply's own speech set), as one sentence.
 * The practice gate reads it, so the setup offers the written practice instead
 * of a voice option whose every start would answer 503.
 */
export function voiceRoutingProblem(brand?: InterviewBrandRef): string | null {
  const b = interviewBrand(brand);
  try {
    getInterviewLlmRouting(b);
    tryGetCnSpeechConfig(b);
    return null;
  } catch (err) {
    if (err instanceof InterviewEngineConfigError) return err.message;
    throw err;
  }
}

// ─── Session-preparation (blueprint) model ─────────────────────────────────

/** Model for the blueprint/prompt pipeline: LLM_INTERVIEW_BLUEPRINT_MODEL when
 *  set (e.g. a faster direct-provider model), else the interview task model.
 *  GoApply: CN_LLM_INTERVIEW_BLUEPRINT_MODEL, else the shared override, else
 *  its interview task model. */
export function getBlueprintModel(brand?: InterviewBrandRef): string | undefined {
  const b = interviewBrand(brand);
  if (b.market !== 'cn') return sharedEnv('LLM_INTERVIEW_BLUEPRINT_MODEL') || interviewTaskModel(b);
  return blueprintSelector(b) || interviewTaskModel(b);
}

/**
 * The blueprint selector of GoApply through the shared model resolver
 * (lib/llm/llmModels.ts `getEnvModelSetting`, plan §3.3 and the §5 contract):
 * CN_LLM_INTERVIEW_BLUEPRINT_MODEL, else the shared value, which is qualified
 * to a full route when GoApply has a provider of its own and is not inherited
 * behind the domestic-only wall unless it names a mainland vendor. A plain
 * import since the parity gate (both bundles are merged), so a renamed export
 * is a compile error and never a silent fallback to the unqualified read.
 */
function blueprintSelector(b: ProductBrand): string | undefined {
  return getEnvModelSetting('LLM_INTERVIEW_BLUEPRINT_MODEL', b);
}

/** Effort for the blueprint call: LLM_INTERVIEW_BLUEPRINT_REASONING_EFFORT when
 *  valid, else the interview task effort. */
export function getBlueprintReasoningEffort(): ReasoningEffort | undefined {
  return parseReasoningEffort(process.env.LLM_INTERVIEW_BLUEPRINT_REASONING_EFFORT)
    ?? getTaskReasoningEffort('interview');
}

/** Upper bound on the market-research (Tavily) stage of preparation. */
export function getWebEvidenceTimeoutMs(): number {
  const raw = Number(process.env.INTERVIEW_ENGINE_WEB_EVIDENCE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : 15_000;
}

/** Upper bound on one whole preparation run (web evidence + blueprint LLM).
 *  Kept under the Vercel function maxDuration (300 s). */
export function getPrepareTimeoutMs(): number {
  const raw = Number(process.env.INTERVIEW_ENGINE_PREPARE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 10_000 ? Math.floor(raw) : 240_000;
}

export function getWorkerSttModel(): string {
  // Deepgram Nova-3 via LiveKit Inference. As of the 2026 language expansions it
  // covers Mandarin (Simplified + Traditional), Japanese, Spanish, French,
  // German, Portuguese, etc. — so pinning `zh` works. Crucially it is
  // idle-TOLERANT: it keeps the Inference stream alive through the initial silent
  // window (greeting + before the candidate speaks). ElevenLabs Scribe v2 Realtime
  // idle-CLOSES that window ("session closed due to agent inactivity", code 2007);
  // because the Agents SDK closes the whole AgentSession on a single unrecoverable
  // STT error (no tolerance counter, unlike LLM/TTS), that idle-close was killing
  // the greeting. See livekit/agents#4255 (Scribe v2 unreliable via Inference).
  // Override with INTERVIEW_ENGINE_STT_MODEL if needed.
  return process.env.INTERVIEW_ENGINE_STT_MODEL?.trim() || 'deepgram/nova-3';
}

/**
 * Server-side LiveKit Inference STT fallback model(s). If the primary STT model
 * has a provider error, Inference fails over to these WITHOUT the agent ever
 * seeing the unrecoverable error that would otherwise close the session. Empty
 * string disables. Defaults to nova-2 (also multilingual incl. Mandarin,
 * idle-tolerant).
 */
export function getWorkerSttFallbackModels(): string[] {
  const raw = process.env.INTERVIEW_ENGINE_STT_FALLBACK_MODELS;
  if (raw === undefined) return ['deepgram/nova-2'];
  return raw.split(',').map((m) => m.trim()).filter(Boolean);
}

// ─── GoApply speech (STT / TTS): DashScope as an optional override ─────────

/**
 * Speech providers of GoApply's OWN speech set (CN_INTERVIEW_ENGINE_STT_MODEL +
 * _TTS_MODEL): DashScope (Paraformer STT, CosyVoice TTS), which the worker
 * implements (interview-agent plugins/dashscope). Without that pair GoApply
 * uses the shared voice catalog and STT, like RoboApply.
 */
export const GOAPPLY_SPEECH_PROVIDERS = ['dashscope'] as const;

/** `model` is 'provider/model' with a domestic speech provider. */
export function isGoApplySpeechModel(model: string | null | undefined): boolean {
  const m = (model ?? '').trim();
  const slash = m.indexOf('/');
  if (slash <= 0 || slash === m.length - 1) return false;
  return (GOAPPLY_SPEECH_PROVIDERS as readonly string[]).includes(m.slice(0, slash).toLowerCase());
}

export interface CnSpeechConfig {
  sttModel: string;
  sttFallbackModels: string[];
  ttsModel: string;
  /** CosyVoice voice ids; null = the worker's own default for that gender. */
  voiceFemale: string | null;
  voiceMale: string | null;
}

/**
 * GoApply's own speech set, or null when it has none (then the shared catalog
 * applies). Own = BOTH models are set (the `speech` group of brandEnv):
 *   CN_INTERVIEW_ENGINE_STT_MODEL            e.g. dashscope/paraformer-realtime-v2
 *   CN_INTERVIEW_ENGINE_TTS_MODEL            e.g. dashscope/cosyvoice-v2
 *   CN_INTERVIEW_ENGINE_STT_FALLBACK_MODELS  optional, comma-separated, domestic too
 *   CN_INTERVIEW_ENGINE_TTS_VOICE(_MALE)     optional CosyVoice voice ids
 * One model of the pair without the other is NOT an own set: GoApply stays on
 * the shared speech set and `voiceConfigProblems` names the missing variable.
 * With the pair set, every model must be domestic: a foreign id is an
 * InterviewEngineConfigError (503) before anything is persisted or connected,
 * so the worker never gets a half-domestic speech set.
 */
export function tryGetCnSpeechConfig(brand?: InterviewBrandRef): CnSpeechConfig | null {
  const b = interviewBrand(brand);
  if (b.market !== 'cn' || brandStack(b, 'speech') !== 'own') return null;
  const sttModel = brandOwnEnv(b, 'INTERVIEW_ENGINE_STT_MODEL')!;
  const ttsModel = brandOwnEnv(b, 'INTERVIEW_ENGINE_TTS_MODEL')!;
  const sttFallbackModels = (brandOwnEnv(b, 'INTERVIEW_ENGINE_STT_FALLBACK_MODELS') || '')
    .split(',').map((m) => m.trim()).filter(Boolean);
  for (const model of [sttModel, ttsModel, ...sttFallbackModels]) {
    if (!isGoApplySpeechModel(model)) {
      throw new InterviewEngineConfigError(
        `GoApply speech model "${model}" is not a domestic provider. Use ${GOAPPLY_SPEECH_PROVIDERS.map((p) => `${p}/`).join(', ')}, or unset CN_INTERVIEW_ENGINE_STT_MODEL and CN_INTERVIEW_ENGINE_TTS_MODEL to use the shared speech set.`,
      );
    }
  }
  return {
    sttModel,
    sttFallbackModels,
    ttsModel,
    voiceFemale: brandOwnEnv(b, 'INTERVIEW_ENGINE_TTS_VOICE') || null,
    voiceMale: brandOwnEnv(b, 'INTERVIEW_ENGINE_TTS_VOICE_MALE') || null,
  };
}

/**
 * GoApply's own speech set; throws InterviewEngineConfigError when it has none.
 * For callers that need DashScope specifically. A session resolves its speech
 * through `tryGetCnSpeechConfig` (providers/speech.ts), which falls back to the
 * shared catalog instead.
 */
export function getCnSpeechConfig(brand?: InterviewBrandRef): CnSpeechConfig {
  const cfg = tryGetCnSpeechConfig(brand);
  if (!cfg) {
    throw new InterviewEngineConfigError(
      'GoApply has no speech set of its own. Set CN_INTERVIEW_ENGINE_STT_MODEL and CN_INTERVIEW_ENGINE_TTS_MODEL (dashscope/…).',
    );
  }
  return cfg;
}

// ─── What the voice and speech configuration really resolves to ───────────

export interface VoiceConfigProblem {
  /**
   * 'voice' | 'speech': a group that is half set, or set but not in effect;
   * 'worker': a combination the worker or the session create will refuse;
   * 'storage': recordings and transcript files are not stored.
   */
  kind: 'voice' | 'speech' | 'worker' | 'storage';
  /** One plain sentence. Variable names and model ids only, never a secret or a URL. */
  message: string;
}

/**
 * Configuration that is set but not in effect, or that the worker will refuse
 * (PAR-1 request P4-2). `brandEnv` reads a half-set GoApply group wholly from
 * the shared names; this says so instead of leaving it silent:
 *   - CN_LIVEKIT_API_KEY / CN_VOICE_PROVIDER / … without CN_LIVEKIT_URL;
 *   - CN_LIVEKIT_URL without its key or secret (voice is then off for GoApply:
 *     the shared keys are never mixed into its own plane);
 *   - its own plane without CN_LIVEKIT_AGENT_CALLBACK_SECRET (the worker's
 *     callbacks are refused), or, outside production, without
 *     CN_INTERVIEW_ENGINE_CALLBACK_BASE_URL while the shared base URL is set
 *     (the worker is sent to localhost);
 *   - one speech model of the CN pair without the other;
 *   - the CN speech pair while voice runs on the shared worker, which then
 *     needs the DashScope key;
 *   - GoApply's own plane dispatching the domestic-only 'GoApply-Interview'
 *     worker with no domestic interview model or no DashScope speech;
 *   - a CN interview model with no LiveKit Inference equivalent while voice
 *     runs on the shared (gateway) worker: live turns use the shared model;
 *   - a configuration no voice session can start on (`voiceRoutingProblem`:
 *     the domestic-only wall without a plane of its own, no usable interview
 *     model, a foreign model in the CN speech pair);
 *   - CN_RESIDENCY_STRICT without a bucket of its own: nothing new is stored.
 * Empty for RoboApply and for a clean configuration.
 */
export function voiceConfigProblems(brand?: InterviewBrandRef): VoiceConfigProblem[] {
  const b = interviewBrand(brand);
  if (b.market !== 'cn') return [];
  const out: VoiceConfigProblem[] = [];
  for (const p of brandEnvGroupProblems(b)) {
    if (p.group !== 'voice' && p.group !== 'speech') continue;
    out.push({
      kind: p.group,
      message:
        `${b.name} ${p.group} settings ${p.set.join(', ')} are ignored because ${p.missingAnchors.join(' and ')} ` +
        `${p.missingAnchors.length > 1 ? 'are' : 'is'} not set; ${b.name} uses the shared ${p.group} stack.`,
    });
  }
  const own = brandStack(b, 'voice') === 'own';
  // CN_LIVEKIT_URL selects the own plane; a missing key or secret there turns
  // voice off (the shared keys are never mixed in), which must be said.
  if (own && !isLiveKitConfigured(b, 'own')) {
    out.push({ kind: 'voice', message: liveKitNotConfiguredMessage(b, 'own') });
  }
  // The voice group flips as a whole: the shared worker secret is not read on
  // GoApply's own plane, so every transcript, usage and lifecycle callback of
  // its worker would be a 401 and its sessions would end with no transcript.
  if (own && !getAgentCallbackSecret(b, 'own')) {
    out.push({
      kind: 'voice',
      message: `${b.name}'s own plane has no CN_LIVEKIT_AGENT_CALLBACK_SECRET: its worker's callbacks are refused (the shared LIVEKIT_AGENT_CALLBACK_SECRET is not used on that plane).`,
    });
  }
  // Outside production there is no request origin to fall back to, and the
  // shared base URL names the other plane's backend.
  if (own && !isProductionRuntime() && !explicitCallbackBaseUrl(b, 'own') && explicitCallbackBaseUrl(b, 'shared')) {
    out.push({
      kind: 'voice',
      message: `${b.name}'s own plane has no CN_INTERVIEW_ENGINE_CALLBACK_BASE_URL: outside production its worker is sent to localhost (INTERVIEW_ENGINE_CALLBACK_BASE_URL, BACKEND_PUBLIC_URL and PUBLIC_BACKEND_URL are not used on that plane).`,
    });
  }
  const ownSpeech = brandStack(b, 'speech') === 'own';
  if (ownSpeech && !own) {
    out.push({
      kind: 'worker',
      message: `${b.name}'s DashScope speech (CN_INTERVIEW_ENGINE_STT_MODEL, CN_INTERVIEW_ENGINE_TTS_MODEL) runs on the shared worker, which must have DASHSCOPE_API_KEY; without it each ${b.name} session fails when it connects.`,
    });
  }
  const domesticWorker = own && getInterviewAgentName(b, 'own') === b.interview.agentName;
  if (domesticWorker && !cnInterviewModelSet(b)) {
    out.push({
      kind: 'worker',
      message: `${b.name} dispatches the ${b.interview.agentName} worker on its own plane, which runs domestic models only, but CN_LLM_INTERVIEW_MODEL is not set.`,
    });
  }
  if (domesticWorker && !ownSpeech) {
    out.push({
      kind: 'worker',
      message: `${b.name} dispatches the ${b.interview.agentName} worker on its own plane, which runs DashScope speech only, but CN_INTERVIEW_ENGINE_STT_MODEL and CN_INTERVIEW_ENGINE_TTS_MODEL are not both set.`,
    });
  }
  // Only where voice would otherwise be offered (the plane is configured).
  if (isLiveKitConfigured(b)) {
    const routingProblem = voiceRoutingProblem(b);
    if (routingProblem) {
      out.push({ kind: 'worker', message: `${b.name} voice practice cannot start, so the written practice is offered instead: ${routingProblem}` });
    } else if (!usesCnInterviewRouting(b)) {
      // A gateway worker: say which of GoApply's own models it does not run.
      const names = [...new Set(resolveLiveWorkerModel(b).passedOver.map((c) => c.envName))];
      if (names.length) {
        out.push({
          kind: 'worker',
          message:
            `${b.name} voice practice runs on ${own ? 'a LiveKit Inference worker' : 'the shared LiveKit project, whose worker runs LiveKit Inference models'}. ` +
            `${names.join(' and ')} ${names.length > 1 ? 'have' : 'has'} no LiveKit Inference equivalent, ` +
            `so the live turns use the shared interview model (${b.name}'s own interview model still writes the plan and the report).` +
            (own ? '' : ' Set CN_LIVEKIT_URL with a worker of its own to run it live.'),
        });
      }
    }
  }
  if (interviewStorageWriteBlocked(b)) {
    out.push({
      kind: 'storage',
      message:
        cnOwnStorageProblem(process.env) === 'offshore'
          ? `CN_RESIDENCY_STRICT is on and ${b.name}'s own bucket is not mainland object storage (CN_S3_ENDPOINT): practice recordings and transcript files are not stored.`
          : `CN_RESIDENCY_STRICT is on and ${b.name} has no bucket of its own (CN_S3_ENDPOINT, CN_S3_BUCKET and its keys): practice recordings and transcript files are not stored.`,
    });
  }
  return out;
}

const warnedVoiceProblems = new Set<string>();

/** Log each voice or speech configuration problem once per process (warn). */
export function warnVoiceConfigProblemsOnce(brand?: InterviewBrandRef): VoiceConfigProblem[] {
  let problems: VoiceConfigProblem[];
  try {
    problems = voiceConfigProblems(brand);
  } catch {
    // A log line must never break the request that asked for it.
    return [];
  }
  for (const p of problems) {
    if (warnedVoiceProblems.has(p.message)) continue;
    warnedVoiceProblems.add(p.message);
    console.warn(`[interview-engine] ${p.message}`);
  }
  return problems;
}

/** Test seam: forget which problems were logged. */
export function __resetVoiceConfigWarningsForTest(): void {
  warnedVoiceProblems.clear();
}

// ─── Callback wiring ──────────────────────────────────────────────────────

/**
 * The explicit base URL of the plane in use (the `voice` group). On the shared
 * plane: INTERVIEW_ENGINE_CALLBACK_BASE_URL, else BACKEND_PUBLIC_URL /
 * PUBLIC_BACKEND_URL, for both brands (one worker, one backend to call). On
 * GoApply's own plane: CN_INTERVIEW_ENGINE_CALLBACK_BASE_URL only; the shared
 * aliases name the other deployment.
 */
function explicitCallbackBaseUrl(brand?: InterviewBrandRef, stack?: VoiceStack | null): string | null {
  const b = interviewBrand(brand);
  const plane = voiceStack(b, stack);
  const explicit = plane === 'own'
    ? voiceEnv(b, 'INTERVIEW_ENGINE_CALLBACK_BASE_URL', plane)
    : sharedEnv('INTERVIEW_ENGINE_CALLBACK_BASE_URL') ||
      sharedEnv('BACKEND_PUBLIC_URL') ||
      sharedEnv('PUBLIC_BACKEND_URL');
  return explicit ? explicit.replace(/\/+$/, '') : null;
}

function localCallbackBaseUrl(): string {
  const port = process.env.PORT?.trim() || '4607';
  return `http://localhost:${port}`;
}

export function isProductionRuntime(): boolean {
  return process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
}

/** Brand apex domains whose hosts (and subdomains) may receive worker
 *  callbacks when the origin is derived from a request. The callback carries
 *  the shared worker secret, so a client-supplied Host must never be trusted
 *  blindly. Extend with INTERVIEW_ENGINE_CALLBACK_ALLOWED_HOSTS (comma list). */
const DEFAULT_CALLBACK_HOSTS = ['roboapply.io', 'robohire.io', 'goapply.top'];

function callbackHostAllowlist(): string[] {
  const extra = (process.env.INTERVIEW_ENGINE_CALLBACK_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const vercel = [
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_URL,
  ]
    .map((h) => (h || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean);
  return [...DEFAULT_CALLBACK_HOSTS, ...extra, ...vercel];
}

function isAllowedCallbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return callbackHostAllowlist().some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}

function firstHeader(value: string | string[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  return (v ?? '').split(',')[0]!.trim();
}

/**
 * Public origin of an incoming request (x-forwarded-proto + x-forwarded-host,
 * else host). Returns null when the host is missing, malformed or not on the
 * callback allowlist. Production callbacks always use https.
 */
export function deriveRequestOrigin(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const host = (firstHeader(headers['x-forwarded-host']) || firstHeader(headers.host)).toLowerCase();
  if (!host || !/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) return null;
  const hostname = host.replace(/:\d+$/, '');
  if (!isAllowedCallbackHost(hostname)) return null;
  const proto = firstHeader(headers['x-forwarded-proto']).toLowerCase();
  const scheme = proto === 'http' && !isProductionRuntime() ? 'http' : 'https';
  return `${scheme}://${host}`;
}

/**
 * Base URL to persist on a NEW session for worker callbacks. Explicit env
 * wins; in production an allowlisted request origin is used (so a missing
 * INTERVIEW_ENGINE_CALLBACK_BASE_URL no longer sends the worker to its own
 * localhost), then the Vercel production domain; dev keeps the localhost
 * default. Returns null when nothing better than the call-time default exists.
 */
export function resolveSessionCallbackBaseUrl(
  headers?: Record<string, string | string[] | undefined>,
  brand?: InterviewBrandRef,
): string | null {
  if (explicitCallbackBaseUrl(brand)) return null; // call-time env read stays authoritative
  if (!isProductionRuntime()) return null;
  const fromRequest = headers ? deriveRequestOrigin(headers) : null;
  if (fromRequest) return fromRequest;
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return prod ? `https://${prod}` : null;
}

/** Base URL the agent worker uses to POST transcript / lifecycle callbacks.
 *  `persisted` is the per-session origin captured at create time (C13). */
export function getCallbackBaseUrl(persisted?: string | null, brand?: InterviewBrandRef, stack?: VoiceStack | null): string {
  const explicit = explicitCallbackBaseUrl(brand, stack);
  if (explicit) return explicit;
  if (persisted && /^https?:\/\//.test(persisted)) return persisted.replace(/\/+$/, '');
  return localCallbackBaseUrl();
}

// ─── Tuning ────────────────────────────────────────────────────────────────

export function getJoinTokenTtlSeconds(): number {
  const raw = Number(process.env.INTERVIEW_ENGINE_JOIN_TOKEN_TTL_SEC);
  return Number.isFinite(raw) && raw >= 60 ? Math.floor(raw) : 3600;
}

export function getSessionExpiryMinutes(): number {
  const raw = Number(process.env.INTERVIEW_ENGINE_SESSION_EXPIRY_MIN);
  return Number.isFinite(raw) && raw >= 5 ? Math.floor(raw) : 120;
}

/** Opt-in: recording practice audio/video to R2 needs an explicit true
 *  (INTERVIEW_ENGINE_RECORDING_ENABLED; GoApply reads its CN_ override first,
 *  else the shared value; default false). A
 *  default-on recorder would store every practice session with no consent
 *  the moment storage credentials work. The env switch is necessary, never
 *  sufficient: each session also needs the user's recording consent (H8). */
export function isRecordingEnabled(brand?: InterviewBrandRef): boolean {
  const raw = (brandEnv(interviewBrand(brand), 'INTERVIEW_ENGINE_RECORDING_ENABLED') || '').toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(raw);
}

// ─── Retention (both brands) ───────────────────────────────────────────────

/** The retention both privacy notices publish for practice recordings and transcripts. */
export const INTERVIEW_RETENTION_MAX_DAYS = 90;

/** INTERVIEW_RETENTION_DAYS (CN_ override first on GoApply): a whole number of days, default
 *  and maximum 90 — a shorter window is allowed, a longer one would break the
 *  published retention schedule, so it is capped. */
export function getInterviewRetentionDays(brand?: InterviewBrandRef): number {
  const raw = Number(brandEnv(interviewBrand(brand), 'INTERVIEW_RETENTION_DAYS'));
  if (!Number.isFinite(raw) || raw < 1) return INTERVIEW_RETENTION_MAX_DAYS;
  return Math.min(INTERVIEW_RETENTION_MAX_DAYS, Math.floor(raw));
}

// ─── Media policy (the same on both brands; D5, plan §3.5) ─────────────────

export interface InterviewMediaPolicy {
  /** The candidate may publish a camera track. */
  cameraPublish: boolean;
  /** Video frames may be recorded (still only with the session's two consents). */
  recordVideo: boolean;
}

/**
 * Camera and video recording follow one policy on both brands: the camera is
 * published in a video practice, and video frames are recorded only for a
 * session with a live `interview_recording` AND `interview_video` consent
 * (resolvePracticeRecording). CN_INTERVIEW_CAMERA_PUBLISH set to a false value
 * is GoApply's operator opt-out: the camera stays a local preview and
 * recordings are audio only (the former CN L-11 rule).
 */
export function getInterviewMediaPolicy(brand?: InterviewBrandRef): InterviewMediaPolicy {
  const b = interviewBrand(brand);
  // GoApply's own switch only (never an unprefixed twin). Set and not a true
  // value = off, like the sibling off switches (CN_CAMPUS_CALENDAR_ENABLED):
  // an unreadable value falls to the side that publishes nothing.
  const optOut = b.market === 'cn' ? brandOwnEnv(b, 'INTERVIEW_CAMERA_PUBLISH') : undefined;
  const on = optOut === undefined || parseBoolEnv(optOut);
  return { cameraPublish: on, recordVideo: on };
}
