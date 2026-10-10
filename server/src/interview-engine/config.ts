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
//   Per brand (WP-63a, ARCHITECTURE.md §1.9, TASK_PLAN R-03): every LiveKit,
//   S3, callback, recording and retention setting is read through
//   `brandEnv(brand, NAME)` — unprefixed for RoboApply (exactly the Wave 0
//   names above), `CN_` + NAME for GoApply, with NO fallback from CN_X to X:
//     CN_LIVEKIT_URL / CN_LIVEKIT_API_KEY / CN_LIVEKIT_API_SECRET,
//     CN_LIVEKIT_AGENT_CALLBACK_SECRET, CN_INTERVIEW_ENGINE_AGENT_NAME
//        (default 'GoApply-Interview'), CN_S3_* (audio recordings + transcripts),
//     CN_INTERVIEW_ENGINE_CALLBACK_BASE_URL, CN_INTERVIEW_ENGINE_RECORDING_ENABLED,
//     CN_LLM_INTERVIEW_LIVE_MODEL (+ _REASONING_EFFORT), CN_LLM_INTERVIEW_BLUEPRINT_MODEL,
//     CN_INTERVIEW_ENGINE_STT_MODEL / _STT_FALLBACK_MODELS / _TTS_MODEL /
//        _TTS_VOICE(_MALE) (domestic speech only: dashscope/…).
//   VOICE_PROVIDER / CN_VOICE_PROVIDER — livekit_cloud (default) |
//     livekit_selfhosted | volcano | trtc (the last two reserved, unimplemented).
//   INTERVIEW_RETENTION_DAYS / CN_INTERVIEW_RETENTION_DAYS — default 90, never
//     longer than the 90 days both privacy notices publish.

import { getTaskModel, getTaskReasoningEffort } from '../lib/llm/llmTaskSettings.js';
import { brandEnv } from '../platform/brand/brandEnv.js';
import { getBrand, DEFAULT_BRAND, type BrandId, type ProductBrand } from '../platform/brand/registry.js';
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

// ─── LiveKit ────────────────────────────────────────────────────────────

export interface LiveKitCreds {
  url: string;
  apiKey: string;
  apiSecret: string;
  /** Agent worker name for explicit dispatch. Null disables auto-dispatch. */
  agentName: string | null;
}

export function isLiveKitConfigured(brand?: InterviewBrandRef): boolean {
  const b = interviewBrand(brand);
  return !!(brandEnv(b, 'LIVEKIT_URL') && brandEnv(b, 'LIVEKIT_API_KEY') && brandEnv(b, 'LIVEKIT_API_SECRET'));
}

/** Throws InterviewEngineConfigError if LiveKit is not configured for the brand. */
export function getLiveKitCreds(brand?: InterviewBrandRef): LiveKitCreds {
  const b = interviewBrand(brand);
  const url = brandEnv(b, 'LIVEKIT_URL');
  const apiKey = brandEnv(b, 'LIVEKIT_API_KEY');
  const apiSecret = brandEnv(b, 'LIVEKIT_API_SECRET');
  if (!url || !apiKey || !apiSecret) {
    const p = b.market === 'cn' ? 'CN_' : '';
    throw new InterviewEngineConfigError(
      `LiveKit is not configured. Set ${p}LIVEKIT_URL, ${p}LIVEKIT_API_KEY, ${p}LIVEKIT_API_SECRET.`,
    );
  }
  return { url, apiKey, apiSecret, agentName: brandEnv(b, 'LIVEKIT_AGENT_NAME') || null };
}

/** The wss:// URL minus protocol coercion — used to derive the HTTPS host for
 *  the server-side service clients (RoomServiceClient/EgressClient want https). */
export function getLiveKitHttpUrl(brand?: InterviewBrandRef): string {
  const { url } = getLiveKitCreds(brand);
  return url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
}

/** The worker's shared callback secret for one brand (each brand runs its own worker). */
export function getAgentCallbackSecret(brand?: InterviewBrandRef): string | null {
  return brandEnv(interviewBrand(brand), 'LIVEKIT_AGENT_CALLBACK_SECRET') || null;
}

/** Every configured callback secret, one per brand that has one. Only a
 *  cheap pre-filter: a callback is then checked against the secret of its
 *  session's brand alone (InterviewSessionService.assertCallbackSecret). */
export function getAgentCallbackSecrets(): string[] {
  const out: string[] = [];
  for (const id of ['roboapply', 'goapply'] as BrandId[]) {
    const s = getAgentCallbackSecret(id);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * The agent worker name the interview engine dispatches. DELIBERATELY separate
 * from the shared `LIVEKIT_AGENT_NAME` (which is "Agent Alex" in this repo) so
 * the interview worker never collides with Agent Alex's LiveKit registration.
 * The Node worker (interview-agent/) must register this SAME name. The default
 * MUST stay 'RoboApply-Interview' — the deployed contract; a stale
 * 'RoboHire-Interview' fallback once dispatched interviews to nobody on the
 * shared LiveKit project (silent-room outage, 2026-07-03).
 */
export function getInterviewAgentName(brand?: InterviewBrandRef): string {
  const b = interviewBrand(brand);
  // The registry carries the per-brand contract names ('RoboApply-Interview',
  // 'GoApply-Interview'), so the two workers never take each other's rooms.
  return brandEnv(b, 'INTERVIEW_ENGINE_AGENT_NAME') || b.interview.agentName;
}

// ─── Voice provider (VoiceSessionProvider seam, CN-E-06) ─────────────────

export const VOICE_PROVIDER_IDS = ['livekit_cloud', 'livekit_selfhosted', 'volcano', 'trtc'] as const;
export type VoiceProviderId = (typeof VOICE_PROVIDER_IDS)[number];

/** VOICE_PROVIDER / CN_VOICE_PROVIDER; unset or unknown → livekit_cloud. */
export function getVoiceProviderId(brand?: InterviewBrandRef): VoiceProviderId {
  const raw = (brandEnv(interviewBrand(brand), 'VOICE_PROVIDER') || '').toLowerCase();
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
 * S3/R2 creds for interview artifacts. Per brand (no cross-brand fallback):
 * RoboApply reads S3_* (and the AWS_* aliases), GoApply CN_S3_* (and
 * CN_AWS_*), so a missing CN bucket disables GoApply storage instead of
 * sending mainland recordings to the international bucket.
 */
export function getR2Creds(brand?: InterviewBrandRef): R2Creds | null {
  const b = interviewBrand(brand);
  const bucket = brandEnv(b, 'S3_BUCKET') || '';
  const accessKeyId = brandEnv(b, 'S3_ACCESS_KEY_ID') || brandEnv(b, 'AWS_ACCESS_KEY_ID') || '';
  const secretAccessKey = brandEnv(b, 'S3_SECRET_ACCESS_KEY') || brandEnv(b, 'AWS_SECRET_ACCESS_KEY') || '';
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  if (b.market === 'cn' && sharesIntlBucketName(bucket)) return null;
  return {
    bucket,
    region: brandEnv(b, 'S3_REGION') || brandEnv(b, 'AWS_REGION') || 'auto',
    endpoint: brandEnv(b, 'S3_ENDPOINT') || undefined,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: ['true', '1', 'yes'].includes((brandEnv(b, 'S3_FORCE_PATH_STYLE') || '').toLowerCase()),
  };
}

let warnedSharedBucket = false;

/**
 * GoApply storage counts as NOT configured when CN_S3_BUCKET has the same name
 * as RoboApply's S3_BUCKET. The interview storage client
 * (storage/r2Storage.ts) caches its S3 client by bucket name only, so two
 * brands with one bucket name — say an "interviews" bucket on R2 and another
 * on a mainland OSS — would share one client: GoApply objects could land in the
 * international store and retention could delete from the wrong one. Same
 * name and same store would put mainland data in the international bucket,
 * which CN L-11 forbids too. Either way GoApply recording and transcript
 * upload stay off (and retention leaves the pointers for a later run) until
 * the buckets have different names. Remove once the storage cache is keyed by
 * endpoint + bucket + access key (request to the storage owner).
 */
function sharesIntlBucketName(cnBucket: string): boolean {
  const intlBucket = (process.env.S3_BUCKET || '').trim();
  if (!intlBucket || intlBucket !== cnBucket) return false;
  if (!warnedSharedBucket) {
    warnedSharedBucket = true;
    console.warn('[interview-engine] CN_S3_BUCKET has the same name as S3_BUCKET; GoApply interview storage stays off until it has its own bucket name.');
  }
  return true;
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

function requireInterviewBackendModel(): string {
  const model = getTaskModel('interview');
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

/** The selector the LIVE worker turns run on, before LiveKit mapping:
 *  LLM_INTERVIEW_LIVE_MODEL when set, else the interview task model (backward
 *  compatible). The ALIGNED_INTERVIEW_MODELS allowlist applies to THIS value. */
function liveModelSelector(): { selector: string; envName: string } {
  const live = process.env.LLM_INTERVIEW_LIVE_MODEL?.trim();
  if (live) return { selector: live, envName: 'LLM_INTERVIEW_LIVE_MODEL' };
  const model = getTaskModel('interview');
  if (!model) {
    throw new InterviewEngineConfigError(
      'Interview LLM is not configured. Set LLM_INTERVIEW_MODEL (or LLM_INTERVIEW_LIVE_MODEL for the live worker).',
    );
  }
  return { selector: model, envName: 'LLM_INTERVIEW_MODEL' };
}

/** LiveKit Inference model id for live interview turns. */
export function getWorkerLlmModel(): string {
  const { selector, envName } = liveModelSelector();
  return mapInterviewModelToWorker(selector, envName);
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
export function getWorkerLlmReasoningEffort(workerModel?: string): InterviewReasoningEffort | undefined {
  const effort = parseReasoningEffort(process.env.LLM_INTERVIEW_LIVE_REASONING_EFFORT);
  if (effort === 'max') {
    throw new InterviewEngineConfigError(
      'LLM_INTERVIEW_LIVE_REASONING_EFFORT=max is not supported by LiveKit Inference; use minimal, low, medium, or high.',
    );
  }
  if (effort) return effort;
  let model = workerModel;
  if (model === undefined) {
    try {
      model = getWorkerLlmModel();
    } catch {
      model = undefined;
    }
  }
  return liveModelAcceptsReasoningEffort(model) ? 'low' : undefined;
}

/**
 * GoApply (R-13): the live worker runs an OpenAI-compatible domestic model
 * (WP-63b `LLM_BACKEND=openai_compatible`), never LiveKit Inference's
 * international catalog. CN_LLM_INTERVIEW_LIVE_MODEL (else the GoApply
 * interview task model) is passed to the worker as-is, and must name a
 * GoApply direct provider (deepseek, qwen, kimi, glm, doubao, minimax).
 */
function cnInterviewLlmRouting(brand: ProductBrand): InterviewLlmRouting {
  const backendModel = getTaskModel('interview', brand);
  if (!backendModel) {
    throw new InterviewEngineConfigError('GoApply interview LLM is not configured. Set CN_LLM_INTERVIEW_MODEL.');
  }
  const workerModel = brandEnv(brand, 'LLM_INTERVIEW_LIVE_MODEL') || backendModel;
  const provider = workerModel.split('/')[0]!.trim().toLowerCase();
  if (!isGoApplyDirectProvider(provider)) {
    throw new InterviewEngineConfigError(
      `CN_LLM_INTERVIEW_LIVE_MODEL="${workerModel}" is not a domestic model. Use deepseek/, qwen/, kimi/, glm/, doubao/ or minimax/.`,
    );
  }
  const effort = parseReasoningEffort(brandEnv(brand, 'LLM_INTERVIEW_LIVE_REASONING_EFFORT'));
  return { backendModel, workerModel, ...(effort && effort !== 'max' ? { reasoningEffort: effort } : {}) };
}

/** Resolve the backend + worker pair once so a live-session claim is atomic
 *  with respect to hot configuration changes. The backend model (blueprint +
 *  evaluation) stays required: a session without it can never be prepared.
 *  RoboApply (and no brand context) keeps the Wave 0 resolution unchanged. */
export function getInterviewLlmRouting(brand?: InterviewBrandRef): InterviewLlmRouting {
  const b = interviewBrand(brand);
  if (b.market === 'cn') return cnInterviewLlmRouting(b);
  const backendModel = requireInterviewBackendModel();
  const workerModel = getWorkerLlmModel();
  return {
    backendModel,
    workerModel,
    reasoningEffort: getWorkerLlmReasoningEffort(workerModel),
  };
}

// ─── Session-preparation (blueprint) model ─────────────────────────────────

/** Model for the blueprint/prompt pipeline: LLM_INTERVIEW_BLUEPRINT_MODEL when
 *  set (e.g. a faster direct-provider model), else the interview task model. */
export function getBlueprintModel(brand?: InterviewBrandRef): string | undefined {
  const b = interviewBrand(brand);
  // GoApply never inherits the international blueprint override (R-13).
  if (b.market === 'cn') return brandEnv(b, 'LLM_INTERVIEW_BLUEPRINT_MODEL') || getTaskModel('interview', b);
  return process.env.LLM_INTERVIEW_BLUEPRINT_MODEL?.trim() || getTaskModel('interview');
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

// ─── GoApply speech (STT / TTS) — domestic only (R-13, CN L-11) ────────────

/**
 * Speech providers a GoApply worker may stream the candidate's voice to.
 * DashScope (Paraformer STT, CosyVoice TTS) is what the GoApply worker
 * implements (WP-63b). LiveKit Inference's catalog (deepgram/, cartesia/,
 * elevenlabs/, …) is international and never allowed.
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
 * GoApply speech models (no fallback to the international names):
 *   CN_INTERVIEW_ENGINE_STT_MODEL            e.g. dashscope/paraformer-realtime-v2
 *   CN_INTERVIEW_ENGINE_STT_FALLBACK_MODELS  optional, comma-separated, domestic too
 *   CN_INTERVIEW_ENGINE_TTS_MODEL            e.g. dashscope/cosyvoice-v2
 *   CN_INTERVIEW_ENGINE_TTS_VOICE(_MALE)     optional CosyVoice voice ids
 * Missing or non-domestic → InterviewEngineConfigError (503) before anything
 * is persisted or connected, so the worker metadata never names an
 * international STT/TTS for a GoApply session.
 */
export function getCnSpeechConfig(brand?: InterviewBrandRef): CnSpeechConfig {
  const b = interviewBrand(brand);
  const sttModel = brandEnv(b, 'INTERVIEW_ENGINE_STT_MODEL');
  const ttsModel = brandEnv(b, 'INTERVIEW_ENGINE_TTS_MODEL');
  if (!sttModel || !ttsModel) {
    throw new InterviewEngineConfigError(
      'GoApply interview speech is not configured. Set CN_INTERVIEW_ENGINE_STT_MODEL and CN_INTERVIEW_ENGINE_TTS_MODEL (dashscope/…).',
    );
  }
  const sttFallbackModels = (brandEnv(b, 'INTERVIEW_ENGINE_STT_FALLBACK_MODELS') || '')
    .split(',').map((m) => m.trim()).filter(Boolean);
  for (const model of [sttModel, ttsModel, ...sttFallbackModels]) {
    if (!isGoApplySpeechModel(model)) {
      throw new InterviewEngineConfigError(
        `GoApply speech model "${model}" is not a domestic provider. Use ${GOAPPLY_SPEECH_PROVIDERS.map((p) => `${p}/`).join(', ')}.`,
      );
    }
  }
  return {
    sttModel,
    sttFallbackModels,
    ttsModel,
    voiceFemale: brandEnv(b, 'INTERVIEW_ENGINE_TTS_VOICE') || null,
    voiceMale: brandEnv(b, 'INTERVIEW_ENGINE_TTS_VOICE_MALE') || null,
  };
}

// ─── Callback wiring ──────────────────────────────────────────────────────

function explicitCallbackBaseUrl(brand?: InterviewBrandRef): string | null {
  const b = interviewBrand(brand);
  // GoApply's worker calls back to the GoApply deployment only
  // (CN_INTERVIEW_ENGINE_CALLBACK_BASE_URL); the shared public-URL aliases
  // name the international backend, so they apply to RoboApply alone.
  const explicit = b.market === 'cn'
    ? brandEnv(b, 'INTERVIEW_ENGINE_CALLBACK_BASE_URL')
    : process.env.INTERVIEW_ENGINE_CALLBACK_BASE_URL?.trim() ||
      process.env.BACKEND_PUBLIC_URL?.trim() ||
      process.env.PUBLIC_BACKEND_URL?.trim();
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
export function getCallbackBaseUrl(persisted?: string | null, brand?: InterviewBrandRef): string {
  const explicit = explicitCallbackBaseUrl(brand);
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
 *  (INTERVIEW_ENGINE_RECORDING_ENABLED, CN_ on GoApply; default false). A
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

/** INTERVIEW_RETENTION_DAYS (CN_ on GoApply): a whole number of days, default
 *  and maximum 90 — a shorter window is allowed, a longer one would break the
 *  published retention schedule, so it is capped. */
export function getInterviewRetentionDays(brand?: InterviewBrandRef): number {
  const raw = Number(brandEnv(interviewBrand(brand), 'INTERVIEW_RETENTION_DAYS'));
  if (!Number.isFinite(raw) || raw < 1) return INTERVIEW_RETENTION_MAX_DAYS;
  return Math.min(INTERVIEW_RETENTION_MAX_DAYS, Math.floor(raw));
}

// ─── Media policy per brand (CN L-11) ──────────────────────────────────────

export interface InterviewMediaPolicy {
  /** The candidate may publish a camera track (GoApply: local preview only). */
  cameraPublish: boolean;
  /** Video frames may be recorded (GoApply: audio only, always). */
  recordVideo: boolean;
}

export function getInterviewMediaPolicy(brand?: InterviewBrandRef): InterviewMediaPolicy {
  const cn = interviewBrand(brand).market === 'cn';
  return { cameraPublish: !cn, recordVideo: !cn };
}
