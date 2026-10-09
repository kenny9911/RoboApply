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

import { getTaskModel, getTaskReasoningEffort } from '../lib/llm/llmTaskSettings.js';
import { parseReasoningEffort, type ReasoningEffort } from '../services/llm/reasoningEffort.js';
import type { InterviewReasoningEffort } from './types.js';

export class InterviewEngineConfigError extends Error {
  readonly code = 'interview_engine_not_configured';
  constructor(message: string) {
    super(message);
    this.name = 'InterviewEngineConfigError';
  }
}

// ─── LiveKit ────────────────────────────────────────────────────────────

export interface LiveKitCreds {
  url: string;
  apiKey: string;
  apiSecret: string;
  /** Agent worker name for explicit dispatch. Null disables auto-dispatch. */
  agentName: string | null;
}

export function isLiveKitConfigured(): boolean {
  return !!(
    process.env.LIVEKIT_URL &&
    process.env.LIVEKIT_API_KEY &&
    process.env.LIVEKIT_API_SECRET
  );
}

/** Throws InterviewEngineConfigError if LiveKit is not configured. */
export function getLiveKitCreds(): LiveKitCreds {
  const url = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret) {
    throw new InterviewEngineConfigError(
      'LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.',
    );
  }
  return { url, apiKey, apiSecret, agentName: process.env.LIVEKIT_AGENT_NAME?.trim() || null };
}

/** The wss:// URL minus protocol coercion — used to derive the HTTPS host for
 *  the server-side service clients (RoomServiceClient/EgressClient want https). */
export function getLiveKitHttpUrl(): string {
  const { url } = getLiveKitCreds();
  return url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
}

export function getAgentCallbackSecret(): string | null {
  return process.env.LIVEKIT_AGENT_CALLBACK_SECRET?.trim() || null;
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
export function getInterviewAgentName(): string {
  return process.env.INTERVIEW_ENGINE_AGENT_NAME?.trim() || 'RoboApply-Interview';
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

export function getR2Creds(): R2Creds | null {
  const bucket = (process.env.S3_BUCKET || '').trim();
  const accessKeyId = (process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '').trim();
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    region: (process.env.S3_REGION || process.env.AWS_REGION || 'auto').trim(),
    endpoint: (process.env.S3_ENDPOINT || '').trim() || undefined,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: ['true', '1', 'yes'].includes((process.env.S3_FORCE_PATH_STYLE || '').trim().toLowerCase()),
  };
}

export function isR2Configured(): boolean {
  return getR2Creds() !== null;
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

/** Resolve the backend + worker pair once so a live-session claim is atomic
 *  with respect to hot configuration changes. The backend model (blueprint +
 *  evaluation) stays required: a session without it can never be prepared. */
export function getInterviewLlmRouting(): InterviewLlmRouting {
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
export function getBlueprintModel(): string | undefined {
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

// ─── Callback wiring ──────────────────────────────────────────────────────

function explicitCallbackBaseUrl(): string | null {
  const explicit =
    process.env.INTERVIEW_ENGINE_CALLBACK_BASE_URL?.trim() ||
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
): string | null {
  if (explicitCallbackBaseUrl()) return null; // call-time env read stays authoritative
  if (!isProductionRuntime()) return null;
  const fromRequest = headers ? deriveRequestOrigin(headers) : null;
  if (fromRequest) return fromRequest;
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return prod ? `https://${prod}` : null;
}

/** Base URL the agent worker uses to POST transcript / lifecycle callbacks.
 *  `persisted` is the per-session origin captured at create time (C13). */
export function getCallbackBaseUrl(persisted?: string | null): string {
  const explicit = explicitCallbackBaseUrl();
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

/** Opt-in: recording practice audio/video to R2 needs an explicit true. A
 *  default-on recorder would store every practice session with no consent
 *  the moment storage credentials work. Per-session consent comes later. */
export function isRecordingEnabled(): boolean {
  const raw = (process.env.INTERVIEW_ENGINE_RECORDING_ENABLED || '').trim().toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(raw);
}
