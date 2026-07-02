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
//     INTERVIEW_ENGINE_LLM_MODEL, INTERVIEW_ENGINE_STT_MODEL
//   Callback wiring:
//     INTERVIEW_ENGINE_CALLBACK_BASE_URL — base URL the worker uses to reach this
//        backend (e.g. https://api.robohire.io). Falls back to BACKEND_PUBLIC_URL /
//        PUBLIC_BACKEND_URL, else http://localhost:<PORT>.
//   Tuning:
//     INTERVIEW_ENGINE_JOIN_TOKEN_TTL_SEC (default 3600)
//     INTERVIEW_ENGINE_SESSION_EXPIRY_MIN (default 120)
//     INTERVIEW_ENGINE_RECORDING_ENABLED  (default true)

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
 * The Node worker (interview-agent/) must register this SAME name.
 */
export function getInterviewAgentName(): string {
  return process.env.INTERVIEW_ENGINE_AGENT_NAME?.trim() || 'RoboHire-Interview';
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

// ─── Worker model defaults (passed via room metadata) ─────────────────────
//
// These are LiveKit Inference model identifiers consumed by the Python worker.
// Keep them overridable; the per-locale STT/voice can still be refined by the
// voice catalog. Defaults are conservative, broadly-multilingual choices.

export function getWorkerLlmModel(): string {
  return process.env.INTERVIEW_ENGINE_LLM_MODEL?.trim() || 'openai/gpt-5.4';
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

/** Base URL the agent worker uses to POST transcript / lifecycle callbacks. */
export function getCallbackBaseUrl(): string {
  const explicit =
    process.env.INTERVIEW_ENGINE_CALLBACK_BASE_URL?.trim() ||
    process.env.BACKEND_PUBLIC_URL?.trim() ||
    process.env.PUBLIC_BACKEND_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const port = process.env.PORT?.trim() || '4607';
  return `http://localhost:${port}`;
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

export function isRecordingEnabled(): boolean {
  const raw = (process.env.INTERVIEW_ENGINE_RECORDING_ENABLED || 'true').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(raw);
}
