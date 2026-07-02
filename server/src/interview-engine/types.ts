// backend/src/interview-engine/types.ts
//
// Shared types for the Interview Engine, including the ROOM METADATA CONTRACT
// — the JSON the control plane writes onto the LiveKit room and the Python
// worker reads back to fully configure itself (models, voice, language,
// prompt, callback URL). This is the single integration seam between the two
// services; keep it in sync with interview-agent/src/agent.ts.

export type InterviewMode = 'voice' | 'video';

export type InterviewStatus =
  | 'created'
  | 'live'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'expired';

export type InterviewSource = 'roboapply' | 'recruiter' | 'external';

export type TranscriptRole = 'interviewer' | 'candidate' | 'system';

export interface TranscriptTurn {
  role: TranscriptRole;
  text: string;
  /** epoch ms */
  ts: number;
  /** true while the segment is still being spoken/recognized (interim) */
  interim?: boolean;
}

/** Resolved native-tone voice for a session. */
export interface ResolvedVoice {
  provider: string;     // cartesia | elevenlabs | openai | google | rime | inference
  model: string;        // provider TTS model id
  voiceId: string;      // provider voice id / name
  languageCode: string; // BCP-47 / provider language code
  label?: string;       // human label, e.g. "Mandarin · female · warm"
}

export interface ResolvedStt {
  provider: string;
  model: string;
  language: string; // language hint passed to STT (e.g. 'zh', 'multi')
  /** Server-side LiveKit Inference STT fallback models (provider failover). */
  fallbackModels?: string[];
}

/**
 * The JSON blob stringified into LiveKit room.metadata. The worker decodes
 * this on entry. Never put secrets here (room metadata can be visible to
 * participants) — the callback SECRET stays in the worker's own env.
 */
export interface InterviewRoomMetadata {
  kind: 'interview-engine';
  sessionId: string;
  mode: InterviewMode;
  /** BCP-47 interview language. */
  language: string;
  durationMinutes: number;
  /** TTS-friendly voice interviewer system prompt. */
  systemPrompt: string;
  /** First-turn instruction for the agent's opening line (LLM-generated greeting). */
  openingInstruction: string;
  /**
   * Deterministic, fully-localized opening line (greeting + intro + first
   * question) the worker speaks VERBATIM via TTS. Preferred over
   * openingInstruction because it never depends on the LLM producing the first
   * turn — guaranteeing the candidate always hears a greeting. Empty string ⇒
   * worker falls back to the LLM greeting via openingInstruction.
   */
  openingLine: string;
  voice: ResolvedVoice;
  stt: ResolvedStt;
  llm: { model: string };
  /** Base URL the worker POSTs transcript + lifecycle callbacks to. */
  callbackBaseUrl: string;
}

/** One worker telemetry event (POST /callbacks/sessions/:id/metrics). Beyond
 *  type+ts the shape is worker-defined (per-turn latency fields such as
 *  eouDelayMs / ttftMs / ttfbMs) — the control plane stores events verbatim
 *  and only aggregates them for logging. */
export interface WorkerMetricEvent {
  type: string;
  /** epoch ms */
  ts: number;
  [key: string]: unknown;
}

/** Body of the worker → control-plane metrics callback. */
export interface WorkerMetricsCallbackBody {
  events: WorkerMetricEvent[];
}

/** Body of the worker → control-plane lifecycle callback. 'started' may carry
 *  join telemetry; 'ended' triggers finalize. */
export interface WorkerLifecycleCallbackBody {
  event: 'started' | 'ended';
  /** ms from job accept to room join (event:'started' only). */
  joinMs?: number;
  /** How the opening line was delivered, e.g. 'verbatim' | 'llm' (event:'started' only). */
  greeting?: string;
}

export interface InterviewCharacteristics {
  /** 1 (gentle) .. 5 (adversarial). */
  difficulty: number;
  /** conversational tone, e.g. 'warm' | 'neutral' | 'formal' | 'skeptical'. */
  tone: string;
  /** 'relaxed' | 'standard' | 'brisk' — controls time pressure. */
  pacing: string;
  /** how many follow-ups to push on a weak answer (0..3). */
  followUpDepth: number;
  /** topics the interviewer must cover. */
  mustCoverTopics: string[];
  /** focus areas to weight. */
  focusAreas: string[];
  /** allow the candidate to ask questions at the end. */
  allowCandidateQuestions: boolean;
}
