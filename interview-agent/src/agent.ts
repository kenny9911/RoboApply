// RoboHire Interview Engine — LiveKit voice worker (Node/TS).
//
// The metadata-driven AI interviewer, ported from the Python worker to
// @livekit/agents (Node) so the whole stack is one language. Nothing is
// hardcoded: the system prompt, opening line, language, voice, and STT/LLM/TTS
// models all come from the LiveKit room/job metadata the control plane writes
// (the InterviewRoomMetadata contract in
// backend/src/interview-engine/types.ts).
//
// Pipeline (smoothest full-duplex): Silero VAD-based turn detection +
// preemptive generation + tuned endpointing/interruption thresholds.
// STT (Deepgram Nova-3) → LLM (per metadata; control-plane default) → TTS via
// the LiveKit Inference gateway (OpenAI tts-1 as the local floor).
//
// This file ONLY defines the agent (default export). The worker is launched
// from main.ts via cli.runApp, which points `ServerOptions.agent` at this file
// so job subprocesses import the default export.

import { config as loadEnv } from 'dotenv';
import { inference, tts, voice, defineAgent, type JobContext, type JobProcess } from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import * as openai from '@livekit/agents-plugin-openai';

// Job subprocesses import this file; ensure they have the env too (inherited
// from the parent in most cases, but load defensively).
loadEnv({ path: '.env.local' });

const CALLBACK_SECRET = process.env.LIVEKIT_AGENT_CALLBACK_SECRET ?? '';

/** Valid OpenAI TTS voice names — used to validate a metadata voice override. */
const OPENAI_VOICES = new Set([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer',
]);

// Per-turn latency metrics batching. 30s flush keeps the control plane current
// without per-turn HTTP chatter; 200/batch keeps a single POST body small
// enough to never trip body-size limits; the 1000 cap bounds memory if the
// control plane is unreachable for a long session (drop oldest — latency
// forensics favor recency).
const METRICS_FLUSH_INTERVAL_MS = 30_000;
const METRICS_MAX_BATCH = 200;
const METRICS_BUFFER_CAP = 1000;

// Control-plane callback resilience. The transcript callbacks are the ONLY path
// the recorded interview reaches the backend, so a momentary backend blip during
// a live interview must not silently drop turns — that yields an empty, all-zero
// report (the backend finalizes the session via the browser/LiveKit-webhook path
// with whatever transcript it has, which is nothing). Callbacks retry transient
// NETWORK failures (ECONNREFUSED / timeout / DNS) with backoff; transcript turns
// are buffered and re-sent until delivered, with a longer drain at session end
// (the last chance before the job subprocess exits).
const CALLBACK_MAX_ATTEMPTS = 4; // 1 try + 3 retries per POST
const CALLBACK_RETRY_BASE_MS = 600; // backoff: 600 / 1200 / 1800 ms
const TRANSCRIPT_FLUSH_INTERVAL_MS = 4_000;
const TRANSCRIPT_BUFFER_CAP = 2_000; // bound memory if the backend stays unreachable
const SHUTDOWN_DRAIN_ATTEMPTS = 8; // ~12s extra drain window at session end
const SHUTDOWN_DRAIN_GAP_MS = 1_500;

// Silent-candidate re-engagement limits. The SDK flips the user state to
// 'away' after ~15s of mutual silence; one nudge per episode (the transition
// fires once per episode), ≥60s between nudges so we never badger, and a hard
// per-session cap of 3 so a genuinely absent candidate gets silence — the room
// timeouts handle abandonment, not the interviewer's voice.
const NUDGE_MIN_GAP_MS = 60_000;
const NUDGE_MAX_PER_SESSION = 3;

// Abandoned-room teardown. A candidate who drops (or closes the tab) and never
// returns must not hold the worker slot + room until the overtime hard-stop
// (up to planned duration + 4 min): give them a rejoin grace window, then shut
// the job down (the shutdown callbacks drain the transcript and fire the
// 'ended' lifecycle → the control plane finalizes and deletes the room). 90s
// comfortably covers a page refresh or a network-interface switch.
const ABANDON_GRACE_MS = 90_000;

// Audio-ready handshake. The candidate's browser auto-connects with NO user
// gesture, so on a fresh document load (refresh / deep-link / new tab / Safari)
// the browser autoplay policy blocks remote audio until the user interacts —
// and WebRTC audio is real-time, not buffered, so a greeting spoken into that
// blocked window is LOST while every later turn is fine (the classic "no voice
// when the interview started"). The client publishes a one-shot `client_ready`
// data message on this topic once playback is CONFIRMED unlocked (see the
// mock-interview page); the worker holds the greeting until it arrives. Fail
// OPEN after the timeout so an old/instrumented client (or a blocked data
// channel) still gets greeted rather than sitting in silence. Tunable for ops
// (and for local `console` runs, which have no browser client).
const CLIENT_DATA_TOPIC = 'ie';
const CLIENT_READY_TIMEOUT_MS =
  Number.parseInt(process.env.WORKER_CLIENT_READY_TIMEOUT_MS ?? '', 10) || 12_000;

/** Subset of InterviewRoomMetadata the worker reads (kept in sync with
 *  backend/src/interview-engine/types.ts). */
interface RoomMeta {
  sessionId?: string;
  language?: string;
  systemPrompt?: string;
  openingInstruction?: string;
  /** Deterministic localized greeting spoken verbatim (preferred over the LLM
   *  greeting — guarantees the candidate always hears an opening). */
  openingLine?: string;
  callbackBaseUrl?: string;
  /** Planned interview length — drives the elapsed-time system notes so the
   *  model has an actual clock to "manage its time" against. */
  durationMinutes?: number;
  voice?: { provider?: string; model?: string; voiceId?: string; languageCode?: string };
  stt?: { provider?: string; model?: string; language?: string; fallbackModels?: string[] };
  llm?: { model?: string };
}

/** Map an interview locale to a valid inference STT language code. The
 *  interview language is KNOWN, so we PIN it — otherwise STT defaults to English
 *  and mis-transcribes e.g. Mandarin speech as English gibberish. zh-TW/zh-CN
 *  both map to 'zh' (Scribe/Deepgram use one Mandarin code). */
function sttLanguage(raw: string | undefined): string {
  const s = (raw || 'en').toLowerCase();
  if (s.startsWith('zh') || s.startsWith('cmn')) return 'zh';
  if (s.startsWith('ja')) return 'ja';
  if (s.startsWith('ko')) return 'ko';
  if (s.startsWith('es')) return 'es';
  if (s.startsWith('fr')) return 'fr';
  if (s.startsWith('pt')) return 'pt';
  if (s.startsWith('de')) return 'de';
  if (s.startsWith('en')) return 'en';
  return 'multi'; // unknown → multilingual auto-detect
}

/** End-of-turn endpointing per language. CJK speakers pause longer at turn
 *  boundaries (particle-final clauses + tone-group phrasing read as "done" to a
 *  Western-tuned threshold while the speaker is still mid-thought), and getting
 *  cut off during a thinking pause feels abrupt in an interview — so zh/ja/ko
 *  get a more patient 800/3000 window. Everyone else keeps the snappy 600/2500. */
function endpointingFor(language: string): { minDelay: number; maxDelay: number } {
  const lang = sttLanguage(language);
  if (lang === 'zh' || lang === 'ja' || lang === 'ko') {
    return { minDelay: 800, maxDelay: 3000 };
  }
  return { minDelay: 600, maxDelay: 2500 };
}

function buildStt(stt: RoomMeta['stt'], language: string) {
  // Deepgram Nova-3 via LiveKit Inference. Two reasons over Scribe v2 Realtime:
  //  1. Idle-TOLERANT — it keeps the Inference stream alive through the initial
  //     silent window (greeting + before the candidate speaks). Scribe idle-closes
  //     that window ("session closed due to agent inactivity", code 2007) and the
  //     Agents SDK closes the WHOLE AgentSession on a single unrecoverable STT
  //     error (no tolerance counter, unlike LLM/TTS) — so that idle-close was
  //     aborting the greeting. (See livekit/agents#4255: Scribe v2 unreliable via
  //     Inference.)
  //  2. As of the 2026 expansions Nova-3 covers Mandarin (Simplified + Traditional),
  //     Japanese, Spanish, French, German, Portuguese, etc., so PINNING the known
  //     interview language transcribes correctly (no English-default mis-hearing).
  // `fallback` configures server-side LiveKit Inference failover: a provider error
  // on the primary fails over WITHOUT the agent seeing the unrecoverable error.
  const fallback = (stt?.fallbackModels ?? []).filter(Boolean);
  return new inference.STT({
    model: stt?.model ?? 'deepgram/nova-3',
    language: sttLanguage(stt?.language ?? language),
    ...(fallback.length ? { fallback } : {}),
  });
}

function buildLlm(llm: RoomMeta['llm']) {
  return new inference.LLM({ model: llm?.model ?? 'openai/gpt-4o' });
}

function buildTts(voiceMeta: RoomMeta['voice'], sessionId?: string) {
  // Honor the control-plane-resolved NATIVE voice by routing it through the
  // LiveKit Inference gateway — the SAME gateway used for STT/LLM, so it needs
  // only LIVEKIT_* creds (no provider API key, no extra plugin). The catalog
  // sends a 'provider/model' id (e.g. 'cartesia/sonic-3'), a provider voice id,
  // and a short language code.
  const model = voiceMeta?.model?.trim();
  const voiceId = voiceMeta?.voiceId?.trim();
  const language = voiceMeta?.languageCode?.trim() || undefined;

  // LOCAL last-resort floor: OpenAI tts-1 (multilingual). It backs the gateway
  // primary via the FallbackAdapter below and shares NO failure mode with the
  // LiveKit Inference gateway, so it stays up when the gateway (or a specific
  // provider voice) is down. Built DEFENSIVELY, and with the key read from the
  // LIVE env at call time: the plugin otherwise captures process.env.OPENAI_API_KEY
  // at IMPORT time (before this module's loadEnv in dev), and an unset key throws
  // at construction — passing it explicitly reads what loadEnv has since
  // populated. A genuinely-absent key yields NO floor (gateway alone) rather than
  // crashing every session (main.ts warns about this at boot).
  const openaiKey = process.env.OPENAI_API_KEY?.trim() || undefined;
  const floorVoice = voiceId && OPENAI_VOICES.has(voiceId) ? voiceId : 'nova';
  let floor: openai.TTS | null = null;
  try {
    floor = new openai.TTS({
      model: 'tts-1',
      voice: floorVoice as openai.TTSVoices,
      ...(openaiKey ? { apiKey: openaiKey } : {}),
    });
  } catch (err) {
    console.warn(`[interview-agent] session_id=${sessionId ?? 'unknown'} OpenAI TTS floor unavailable (OPENAI_API_KEY?):`, err instanceof Error ? err.message : err);
  }

  // Any 'provider/model' id → gateway TTS as the PRIMARY. (Legacy bare ids
  // without a slash — e.g. the old 'tts' — use the floor alone.)
  if (model && model.includes('/')) {
    try {
      const primary = new inference.TTS({
        model,
        ...(voiceId ? { voice: voiceId } : {}),
        ...(language ? { language } : {}),
        // SERVER-SIDE gateway failover (gateway-valid providers only — OpenAI is
        // NOT an Inference TTS provider, it's the LOCAL floor above). ElevenLabs
        // 'Rachel' is a guaranteed premade multilingual voice. The fallback entry
        // has no top-level `language` field, but `extraKwargs` is forwarded to
        // the provider verbatim (gateway `extra` payload) and ElevenLabs honors
        // `language_code` (ISO 639-1) on eleven_turbo_v2_5 — without it a
        // mid-interview failover would flip the voice back to English.
        fallback: [{
          model: 'elevenlabs/eleven_turbo_v2_5',
          voice: '21m00Tcm4TlvDq8ikWAM',
          ...(language ? { extraKwargs: { language_code: language } } : {}),
        }],
      });
      // CLIENT-SIDE failover via the SDK's FallbackAdapter. `inference.TTS`
      // opens the gateway WS LAZILY at stream() time, so a rejected model /
      // unknown voiceId / provider error throws MID-TURN — never at construction
      // — so the try/catch here can't catch it and (pre-fix) the base stream
      // silently closed with ZERO frames: the interviewer's text committed to the
      // transcript but the turn was MUTE, and after a few such turns the SDK's
      // unrecoverable-TTS-error counter hard-closed the whole session. The
      // FallbackAdapter watches for that zero-frame/error completion (which the
      // server-side `fallback` above does NOT cover — that only handles a
      // provider error the gateway itself sees) and fails over to the local
      // OpenAI floor, so a turn is never mute. maxRetryPerTTS:0 → fail over on
      // the FIRST gateway error (no multi-second retry dead-air before the
      // greeting). Because audio then always plays, the session's TTS error
      // counter resets each turn and never trips the session-close path.
      // If the floor couldn't be built (no OPENAI_API_KEY), use the gateway
      // alone — same reach as before this hardening, minus the never-mute
      // guarantee (already surfaced by the warn above + the boot check).
      return floor ? new tts.FallbackAdapter({ ttsInstances: [primary, floor], maxRetryPerTTS: 0 }) : primary;
    } catch (err) {
      console.warn(`[interview-agent] session_id=${sessionId ?? 'unknown'} inference.TTS init failed; using OpenAI floor:`, err);
    }
  }

  // Legacy/bare id, or gateway construction failed → the floor if we have one.
  if (floor) return floor;
  // No usable gateway path AND no floor: a session with no TTS is unavoidable —
  // surface WHY loudly instead of returning a broken pipeline.
  throw new Error('no TTS available: gateway voice unusable and OPENAI_API_KEY unset');
}

export default defineAgent({
  // Load Silero VAD once per worker process; reused across jobs.
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    // Anchor for the 'started' lifecycle joinMs and all elapsed-time notes —
    // captured before anything else so it measures the full join path.
    const entryAt = Date.now();

    // 1) Read metadata — prefer dispatch/job metadata, fall back to room.
    const raw = ctx.job?.metadata || ctx.room?.metadata || '';
    let meta: RoomMeta = {};
    try {
      meta = raw ? (JSON.parse(raw) as RoomMeta) : {};
    } catch {
      meta = {};
    }

    const sessionId = meta.sessionId || ctx.room?.name || 'unknown';
    const callbackBase = (meta.callbackBaseUrl ?? '').replace(/\/+$/, '');
    const systemPrompt = meta.systemPrompt || 'You are a professional interviewer. Conduct a thoughtful, adaptive interview.';
    const opening = meta.openingInstruction || 'Greet the candidate warmly and ask your first question.';
    const openingLine = (meta.openingLine ?? '').trim();
    // 30min default matches the control plane's session default — a missing or
    // garbage value must never schedule a wrap-up at t=0.
    const durationMinutes =
      typeof meta.durationMinutes === 'number' && Number.isFinite(meta.durationMinutes) && meta.durationMinutes > 0
        ? meta.durationMinutes
        : 30;

    // Every log line carries session_id — parallel jobs interleave on the
    // worker's stdout, so an unattributed error is undebuggable.
    const slog = (msg: string, ...rest: unknown[]) =>
      console.log(`[interview-agent] session_id=${sessionId} ${msg}`, ...rest);
    const swarn = (msg: string, ...rest: unknown[]) =>
      console.warn(`[interview-agent] session_id=${sessionId} ${msg}`, ...rest);
    const serror = (msg: string, ...rest: unknown[]) =>
      console.error(`[interview-agent] session_id=${sessionId} ${msg}`, ...rest);

    // 2) Build the session. Tuned for natural full duplex:
    //  - preemptiveGeneration: draft the reply (LLM only) before the candidate
    //    fully stops → lower perceived latency (preemptiveTts stays off).
    //  - VAD end-of-turn detection (see turnDetection below for why not the
    //    semantic turn detector).
    //  - interruption: barge-in needs ~0.6s of speech AND ≥2 transcribed words,
    //    so a stray "mhm"/cough/echo doesn't stop the interviewer.
    //  - endpointing min/maxDelay: snappy but patient end-of-turn detection,
    //    widened for CJK (see endpointingFor).
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: buildStt(meta.stt, meta.language ?? 'en'),
      llm: buildLlm(meta.llm),
      tts: buildTts(meta.voice, sessionId),
      turnHandling: {
        // VAD-based end-of-turn. The multilingual semantic model's inference is
        // unreliable in this Node build (lk_end_of_utterance_multilingual fails
        // every turn → broken, "stuck waiting" turn-taking). VAD is reliable and
        // snappy.
        turnDetection: 'vad',
        // Respond shortly after the candidate stops talking; cap so a thinking
        // pause doesn't strand the conversation. Thresholds are per-language
        // (CJK pauses run longer — see endpointingFor). (ms)
        endpointing: endpointingFor(meta.stt?.language ?? meta.language ?? 'en'),
        // Barge-in gate. minDuration=600ms of speech energy AND minWords=2
        // TRANSCRIBED words are both required to interrupt the interviewer, so a
        // one-word backchannel ("yeah"/"right"/"mhm") or a near-silent AEC echo
        // tail can't truncate a turn mid-sentence and leave it looking mute.
        // (The adaptive backchannel classifier is off in prod without the
        // inference EOT endpoint, so minWords is the real content guard here;
        // Inference STT streams word-aligned transcripts, so minWords is honored.)
        interruption: { enabled: true, minDuration: 600, minWords: 2 },
        // Draft the reply preemptively (LLM only) before the candidate fully
        // stops → lower perceived latency. preemptiveTts stays FALSE: with
        // preemptive TTS on, a speculative turn is synthesized then discarded
        // when the turn re-confirms (or when a mid-session system note mutates
        // the chat context — see injectSystemNote), multiplying gateway TTS
        // sessions and the transient-error surface for no audible benefit.
        preemptiveGeneration: { enabled: true, preemptiveTts: false },
      },
    });

    // Did the interviewer's audio actually START playing? `await session.say()`
    // resolves even when TTS produced ZERO frames (the SpeechHandle settles on
    // both success and error), so this is the only reliable signal that the
    // greeting/turn was truly audible — it drives the greeting watchdog below.
    let heardAgentAudio = false;
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (ev.newState === 'speaking') heardAgentAudio = true;
    });

    // 3) Transcript + lifecycle forwarding to the control plane (secret-gated).
    //    Node has global fetch + AbortSignal.timeout.
    const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

    // Returns 'delivered' once the backend RECEIVES the request — even on a
    // non-2xx status, because a resend would double-append the transcript (the
    // ingest is an unconditional jsonb append). Returns 'lost' only if EVERY
    // attempt failed at the network layer (ECONNREFUSED / timeout / DNS), where
    // the request never reached the backend so a resend is safe. Buffered
    // callers (transcript, metrics) re-queue on 'lost' and retry later;
    // 'delivered' is terminal.
    type PostResult = 'delivered' | 'lost' | 'skipped';
    const post = async (
      path: string,
      body: unknown,
      attempts: number = CALLBACK_MAX_ATTEMPTS,
    ): Promise<PostResult> => {
      if (!callbackBase) return 'skipped';
      const payload = JSON.stringify(body);
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const res = await fetch(`${callbackBase}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-interview-callback-secret': CALLBACK_SECRET },
            body: payload,
            signal: AbortSignal.timeout(8000),
          });
          // Received by the backend. A non-2xx is a server-side concern, not a
          // delivery failure; retrying would duplicate appended turns.
          if (!res.ok) swarn(`control-plane POST ${path} -> HTTP ${res.status}`);
          return 'delivered';
        } catch (err) {
          // Network-layer failure: the request never reached the backend, so a
          // retry is safe (no double-append risk).
          if (attempt < attempts) {
            await sleep(CALLBACK_RETRY_BASE_MS * attempt);
            continue;
          }
          swarn(`control-plane POST ${path} failed after ${attempts} attempt(s):`, err);
          return 'lost';
        }
      }
      return 'lost';
    };

    // 3a) Per-turn latency metrics. Buffered + batch-POSTed so "why was session
    //     X laggy" is answerable server-side after the fact; each metric also
    //     gets one structured stdout line for live grepping.
    const metricsBuffer: Array<Record<string, unknown>> = [];
    const bufferMetric = (event: Record<string, unknown>): void => {
      if (!callbackBase) return; // nowhere to send — stdout line already emitted
      if (metricsBuffer.length >= METRICS_BUFFER_CAP) metricsBuffer.shift();
      metricsBuffer.push(event);
    };
    const flushMetrics = async (drain = false): Promise<void> => {
      while (metricsBuffer.length > 0) {
        const events = metricsBuffer.splice(0, METRICS_MAX_BATCH);
        const result = await post(`/api/v1/interview-engine/callbacks/sessions/${sessionId}/metrics`, { events });
        // Network loss → keep the batch for the next flush; stop this pass.
        if (result === 'lost') { metricsBuffer.unshift(...events); break; }
        if (!drain) break;
      }
    };
    let metricsFlushTimer: NodeJS.Timeout | null = setInterval(() => {
      if (metricsBuffer.length > 0) void flushMetrics();
    }, METRICS_FLUSH_INTERVAL_MS);

    // 3a′) Transcript turns are buffered and flushed on an interval; a delivery
    //      failure keeps them buffered for the next flush (and the shutdown
    //      drain). Pre-resilience this was a per-turn fire-and-forget POST, so a
    //      momentary backend outage during the interview permanently lost the
    //      turn → an empty, all-zero report.
    const transcriptBuffer: Array<{ role: string; text: string; ts: number }> = [];
    let transcriptFlushing = false;
    const flushTranscript = async (): Promise<void> => {
      if (!callbackBase) { transcriptBuffer.length = 0; return; }
      if (transcriptFlushing || transcriptBuffer.length === 0) return;
      transcriptFlushing = true;
      try {
        // Snapshot the buffered turns, then send. On 'lost' (network) put them
        // back at the FRONT so chronological order holds and they retry next
        // flush (turns that arrived during the await stay behind them).
        const turns = transcriptBuffer.splice(0, transcriptBuffer.length);
        const result = await post(`/api/v1/interview-engine/callbacks/sessions/${sessionId}/transcript`, { turns });
        if (result === 'lost') transcriptBuffer.unshift(...turns);
      } finally {
        transcriptFlushing = false;
      }
    };
    let transcriptFlushTimer: NodeJS.Timeout | null = setInterval(() => {
      void flushTranscript();
    }, TRANSCRIPT_FLUSH_INTERVAL_MS);

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      const m = ev.metrics;
      const ts = Date.now();
      switch (m.type) {
        case 'llm_metrics':
          slog(`metrics type=llm ttft_ms=${m.ttftMs} prompt_tokens=${m.promptTokens} completion_tokens=${m.completionTokens}`);
          bufferMetric({ type: 'llm', ts, ttftMs: m.ttftMs, promptTokens: m.promptTokens, completionTokens: m.completionTokens });
          break;
        case 'tts_metrics':
          slog(`metrics type=tts ttfb_ms=${m.ttfbMs} audio_duration_ms=${m.audioDurationMs} characters=${m.charactersCount}`);
          bufferMetric({ type: 'tts', ts, ttfbMs: m.ttfbMs, audioDurationMs: m.audioDurationMs, charactersCount: m.charactersCount });
          break;
        case 'stt_metrics':
          slog(`metrics type=stt duration_ms=${m.durationMs} audio_duration_ms=${m.audioDurationMs}`);
          bufferMetric({ type: 'stt', ts, durationMs: m.durationMs, audioDurationMs: m.audioDurationMs });
          break;
        case 'eou_metrics':
          slog(`metrics type=eou end_of_utterance_delay_ms=${m.endOfUtteranceDelayMs} transcription_delay_ms=${m.transcriptionDelayMs}`);
          bufferMetric({ type: 'eou', ts, endOfUtteranceDelayMs: m.endOfUtteranceDelayMs, transcriptionDelayMs: m.transcriptionDelayMs });
          break;
        case 'interruption_metrics':
          slog(`metrics type=interruption detection_delay_ms=${m.detectionDelay} interruptions=${m.numInterruptions} backchannels=${m.numBackchannels}`);
          bufferMetric({ type: 'interruption', ts, detectionDelay: m.detectionDelay, numInterruptions: m.numInterruptions, numBackchannels: m.numBackchannels });
          break;
        default:
          // vad_metrics fires ~continuously (too chatty to log or ship);
          // realtime/avatar metrics never occur in this STT→LLM→TTS pipeline.
          break;
      }
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = (ev as { item?: { role?: string; textContent?: string } }).item;
      const text = item?.textContent?.trim();
      if (!text) return;
      if (!callbackBase) return;
      const role = item?.role === 'user' ? 'candidate' : item?.role === 'assistant' ? 'interviewer' : 'system';
      // Bound memory if the backend is unreachable for a long stretch (drop the
      // oldest — but the cap is generous enough that a normal interview never
      // hits it).
      if (transcriptBuffer.length >= TRANSCRIPT_BUFFER_CAP) transcriptBuffer.shift();
      transcriptBuffer.push({ role, text, ts: Date.now() });
      // Nudge a near-real-time flush (keeps the live screen / server current);
      // the interval + shutdown drain are the durability guarantee.
      void flushTranscript();
    });

    // 3b) Silent-candidate re-engagement. The SDK flips user state to 'away'
    //     after ~15s of mutual silence; without this a frozen/hesitant candidate
    //     just gets indefinite silence. The transition event fires once per away
    //     episode, so acting only on the transition = at most one nudge/episode.
    let nudgeCount = 0;
    let lastNudgeAt = 0;
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState !== 'away') return;
      if (nudgeCount >= NUDGE_MAX_PER_SESSION) return;
      if (Date.now() - lastNudgeAt < NUDGE_MIN_GAP_MS) return;
      // 'away' implies mutual silence, but a preemptive generation can still be
      // in flight — never talk over the agent's own speech.
      const agentState = session.agentState;
      if (agentState === 'speaking' || agentState === 'thinking') return;
      nudgeCount += 1;
      lastNudgeAt = Date.now();
      slog(`re-engagement nudge ${nudgeCount}/${NUDGE_MAX_PER_SESSION} (user away)`);
      try {
        session.generateReply({
          instructions:
            'In the session language: the candidate has been quiet for a while. ' +
            'Gently check in — reassure them they can take their time, and offer to rephrase the question.',
        });
      } catch (err) {
        swarn('re-engagement nudge failed:', err);
      }
    });

    // 3c) Session close/error visibility. The SDK closes the WHOLE AgentSession
    //     on a single unrecoverable pipeline error (see buildStt), and a closed
    //     session otherwise looks like an interviewer who just went mute: the
    //     'ended' lifecycle only fires when the JOB shuts down, so nothing
    //     reaches the control plane until room timeouts. Log every pipeline
    //     error, and on an unexpected close POST an 'error' lifecycle event —
    //     the backend's lifecycle handler ignores unknown events gracefully
    //     (never 500s), so this is pure telemetry, never load-bearing.
    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      const err = ev.error as { message?: string; recoverable?: boolean } | undefined;
      serror(`pipeline error (recoverable=${err?.recoverable ?? 'unknown'}):`, ev.error);
    });
    const EXPECTED_CLOSE_REASONS = new Set<string>([
      voice.CloseReason.USER_INITIATED, // our own session.close() paths (overtime, abandonment)
      voice.CloseReason.JOB_SHUTDOWN, // normal job teardown
      voice.CloseReason.PARTICIPANT_DISCONNECTED, // candidate left — the abandon timer owns teardown
    ]);
    session.on(voice.AgentSessionEventTypes.Close, (ev) => {
      const reason = String(ev.reason ?? 'unknown');
      if (EXPECTED_CLOSE_REASONS.has(reason)) {
        slog(`session closed (${reason})`);
        return;
      }
      const message = ev.error instanceof Error ? ev.error.message : ev.error ? String(ev.error) : undefined;
      serror(`session closed UNEXPECTEDLY: reason=${reason}${message ? ` error=${message}` : ''}`);
      void post(`/api/v1/interview-engine/callbacks/sessions/${sessionId}/lifecycle`, {
        event: 'error',
        reason,
        ...(message ? { message } : {}),
      });
    });

    // 3d) Abandoned-room teardown. closeOnDisconnect is disabled at start() so
    //     a deliberate-looking disconnect (page refresh/tab close both send
    //     CLIENT_INITIATED) doesn't instantly kill the pipeline — the client's
    //     rejoin flow needs a LIVE agent to return to. In exchange the worker
    //     owns abandonment: candidate gone past the grace window → close the
    //     session and shut the job down instead of holding the room until the
    //     overtime hard-stop.
    let abandonTimer: NodeJS.Timeout | null = null;
    // Candidate identities are minted as `candidate-${sessionId}` by the
    // control plane; anything else (hidden egress, ops) never arms the timer.
    const isCandidate = (identity: string): boolean => identity.startsWith('candidate-');
    ctx.room.on('participantDisconnected', (p) => {
      if (!isCandidate(p.identity)) return;
      slog(`candidate disconnected — closing in ${ABANDON_GRACE_MS / 1000}s unless they rejoin`);
      if (abandonTimer) clearTimeout(abandonTimer);
      abandonTimer = setTimeout(() => {
        abandonTimer = null;
        void (async () => {
          slog('candidate never returned — closing abandoned session');
          try {
            await session.close();
          } catch (err) {
            swarn('abandoned-session close failed:', err);
          }
          ctx.shutdown('candidate_abandoned');
        })();
      }, ABANDON_GRACE_MS);
    });
    ctx.room.on('participantConnected', (p) => {
      if (!isCandidate(p.identity) || !abandonTimer) return;
      clearTimeout(abandonTimer);
      abandonTimer = null;
      slog('candidate rejoined — abandonment timer cancelled');
    });

    // 3e) Observable time management. The system prompt tells the model to
    //     "manage your time" but an LLM has no clock — these timers inject
    //     non-spoken system notes at fixed fractions of the planned duration so
    //     pacing decisions are grounded in actual elapsed time. Cleared on
    //     shutdown.
    const timeManagementTimers: NodeJS.Timeout[] = [];

    ctx.addShutdownCallback(async () => {
      for (const t of timeManagementTimers) clearTimeout(t);
      timeManagementTimers.length = 0;
      if (abandonTimer) {
        clearTimeout(abandonTimer);
        abandonTimer = null;
      }
      if (metricsFlushTimer) {
        clearInterval(metricsFlushTimer);
        metricsFlushTimer = null;
      }
      if (transcriptFlushTimer) {
        clearInterval(transcriptFlushTimer);
        transcriptFlushTimer = null;
      }
      // Drain the transcript FIRST and BEFORE the 'ended' lifecycle: 'ended'
      // finalizes + scores the session, and the backend's transcript ingest is
      // status-guarded (turns arriving after finalize are dropped). This is the
      // last chance to deliver buffered turns before the job exits, so retry
      // over a longer window than the live flush.
      for (let i = 0; i < SHUTDOWN_DRAIN_ATTEMPTS && transcriptBuffer.length > 0; i += 1) {
        await flushTranscript();
        if (transcriptBuffer.length > 0) await sleep(SHUTDOWN_DRAIN_GAP_MS);
      }
      if (transcriptBuffer.length > 0) {
        serror(
          `shutdown: ${transcriptBuffer.length} transcript turn(s) UNDELIVERED — control plane ` +
          `unreachable for the entire drain window; this session's report will be empty`,
        );
      }
      // Drain remaining metrics BEFORE the usage report so the control plane
      // has the complete latency picture when finalize() runs.
      await flushMetrics(true);
      // Report the session's aggregated model usage (LLM tokens + STT/TTS audio)
      // BEFORE the 'ended' lifecycle, so the control plane has it on hand when
      // finalize() computes the session cost. session.usage.modelUsage is the
      // LiveKit-aggregated per-model tally. Fire-and-forget; never block 'ended'.
      try {
        const usage = session.usage;
        await post(`/api/v1/interview-engine/callbacks/sessions/${sessionId}/usage`, {
          modelUsage: usage?.modelUsage ?? [],
        });
      } catch (err) {
        swarn('usage report failed:', err);
      }
      await post(`/api/v1/interview-engine/callbacks/sessions/${sessionId}/lifecycle`, { event: 'ended' });
    });

    // 4) Connect, start, and greet.
    await ctx.connect();

    // Audio-ready handshake (see CLIENT_READY_TIMEOUT_MS). Attach the listener
    // BEFORE session.start()/greet so a `client_ready` published during the
    // candidate's join is never missed. The promise resolves once — a
    // `client_ready` message on our topic flips it; the greeting races it
    // against a fail-open timeout below.
    let clientReadyResolve: (v: 'ready') => void = () => {};
    const clientReadyPromise = new Promise<'ready'>((res) => { clientReadyResolve = res; });
    const onClientData = (payload: Uint8Array, _p?: unknown, _k?: unknown, topic?: string): void => {
      if (topic && topic !== CLIENT_DATA_TOPIC) return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload)) as { type?: string };
        if (msg?.type === 'client_ready') clientReadyResolve('ready');
      } catch {
        // Non-JSON / unrelated app data — ignore.
      }
    };
    ctx.room.on('dataReceived', onClientData);

    const agent = new voice.Agent({ instructions: systemPrompt });
    // closeOnDisconnect defaults to TRUE and closes the session the instant the
    // candidate disconnects with CLIENT_INITIATED — which a mid-interview page
    // refresh sends — leaving a rejoining candidate with a mute agent. Disabled:
    // the abandonment grace timer (3d) owns candidate-gone teardown instead.
    await session.start({ agent, room: ctx.room, inputOptions: { closeOnDisconnect: false } });

    // Hold the greeting until the candidate's browser confirms audio playback is
    // unlocked — otherwise the opening streams into a muted <audio> element and
    // is lost (see CLIENT_DATA_TOPIC). Bounded + fail-open: an old client that
    // never signals still gets greeted after the timeout rather than dead air.
    const readyState = await Promise.race([
      clientReadyPromise,
      sleep(CLIENT_READY_TIMEOUT_MS).then(() => 'timeout' as const),
    ]);
    ctx.room.off('dataReceived', onClientData);
    slog(`client audio-ready: ${readyState}`);

    // The greeting must NOT be interruptible — otherwise the candidate's mic
    // picking up the agent's own voice (or any noise) cuts it off immediately.
    // Prefer a DETERMINISTIC spoken greeting (`say`) over an LLM-generated one
    // (`generateReply`): say() synthesizes a known, fully-localized line and
    // never depends on the LLM producing a first turn, so the candidate ALWAYS
    // hears an opening. addToChatCtx records it as the interviewer's turn so the
    // model continues the conversation naturally instead of greeting again.
    const greetingStartAt = Date.now();
    try {
      if (openingLine) {
        await session.say(openingLine, { allowInterruptions: false, addToChatCtx: true });
      } else {
        await session.generateReply({ instructions: opening, allowInterruptions: false });
      }
    } catch (err) {
      swarn('primary greeting failed; falling back to LLM greeting:', err);
      // Last-ditch: if a deterministic say() somehow failed, try the LLM path so
      // the interview still opens rather than sitting in silence.
      if (openingLine) {
        try {
          await session.generateReply({ instructions: opening, allowInterruptions: false });
        } catch (err2) {
          serror('greeting fully failed:', err2);
        }
      }
    }

    // Greeting watchdog. say() resolving is NOT proof of audio (it settles even
    // on a zero-frame TTS miss), so if the agent never reached the 'speaking'
    // state the opening was silent — re-issue it ONCE. The client-side
    // FallbackAdapter should make this rare; addToChatCtx:false so a re-issue
    // after a missed state signal never double-records the greeting turn.
    if (!heardAgentAudio) {
      swarn('greeting produced no audible frames (never reached speaking) — re-issuing once');
      try {
        if (openingLine) {
          await session.say(openingLine, { allowInterruptions: false, addToChatCtx: false });
        } else {
          await session.generateReply({ instructions: opening, allowInterruptions: false });
        }
      } catch (err) {
        serror('greeting re-issue failed:', err);
      }
    }

    // 'started' lifecycle: the agent's join time is otherwise unknowable
    // server-side (the control plane only sees dispatch, not the greeting).
    // joinMs is measured to the START of the greeting (the true join path) —
    // NOT after playout, which the greeting's audio duration would otherwise
    // inflate — with the greeting's own duration reported separately.
    void post(`/api/v1/interview-engine/callbacks/sessions/${sessionId}/lifecycle`, {
      event: 'started',
      joinMs: greetingStartAt - entryAt,
      greetingMs: Date.now() - greetingStartAt,
      clientReady: readyState,
      greeting: openingLine ? 'deterministic' : 'llm',
    });

    // Inject a non-spoken system note into the agent's chat context: copy the
    // (readonly) live context, append, and apply via the SDK's supported
    // updateChatCtx. The model sees it on its next turn — nothing is spoken.
    const injectSystemNote = async (note: string): Promise<void> => {
      try {
        const updated = agent.chatCtx.copy();
        updated.addMessage({ role: 'system', content: note });
        await agent.updateChatCtx(updated);
        slog(`time note injected: ${note.slice(0, 80)}`);
      } catch (err) {
        swarn('system-note injection failed:', err);
      }
    };
    // Timers are anchored to entryAt (not "now") so the planned duration counts
    // from join, not from after the greeting finished synthesizing.
    const scheduleAtElapsed = (targetElapsedMs: number, fn: () => void): void => {
      const delay = targetElapsedMs - (Date.now() - entryAt);
      if (delay <= 0) return; // already past (tiny durations) — skip, never fire at t=0
      timeManagementTimers.push(setTimeout(fn, delay));
    };
    const durationMs = durationMinutes * 60_000;
    scheduleAtElapsed(durationMs * 0.5, () => {
      void injectSystemNote(
        `SYSTEM NOTE: about ${Math.round(durationMinutes / 2)} of ${durationMinutes} minutes have elapsed — roughly half the planned time. ` +
        'Pace the remaining planned questions accordingly. Do not mention this note.',
      );
    });
    scheduleAtElapsed(durationMs * 0.75, () => {
      void injectSystemNote(
        `SYSTEM NOTE: about ${Math.round(durationMinutes * 0.75)} of ${durationMinutes} minutes have elapsed — three quarters of the planned time. ` +
        'Prioritize only the most important remaining questions. Do not mention this note.',
      );
    });
    // T−2min: enough runway for one final answer plus a courteous close.
    scheduleAtElapsed(durationMs - 120_000, () => {
      void injectSystemNote(
        `SYSTEM NOTE: about 2 minutes remain of the planned ${durationMinutes}-minute interview. ` +
        'Begin closing after the candidate finishes their current answer — thank them and wrap up. Do not mention this note.',
      );
    });
    // T+90s overtime: a long final answer routinely overshoots by a minute; 90s
    // is where "finishing a thought" becomes "running long".
    scheduleAtElapsed(durationMs + 90_000, () => {
      void injectSystemNote(
        `SYSTEM NOTE: the interview has run about 90 seconds past its planned ${durationMinutes} minutes. ` +
        'Conclude now: deliver a brief, warm closing. Do not mention this note.',
      );
    });
    // T+4min hard stop: by now two nudges have been ignored — speak a brief
    // localized goodbye, then close the session gracefully. If anything fails,
    // the existing room timeouts still tear the session down.
    scheduleAtElapsed(durationMs + 240_000, () => {
      void (async () => {
        try {
          const handle = session.generateReply({
            instructions: 'In the session language, deliver a brief warm closing and end the interview now.',
            allowInterruptions: false,
          });
          await handle.waitForPlayout();
          await session.close();
          slog('overtime hard-stop: closing spoken, session closed');
        } catch (err) {
          swarn('overtime wrap-up failed; leaving teardown to room timeouts:', err);
          return;
        }
        // Release the job too: shutdown drains transcripts and fires 'ended',
        // so the control plane finalizes + deletes the room — the candidate's
        // client sees ROOM_DELETED and routes to the report instead of sitting
        // in a silent room with a closed pipeline.
        ctx.shutdown('overtime_hard_stop');
      })();
    });

    // Log every live model this session uses to the worker console.
    slog(
      `session started: language=${meta.language ?? 'en'} durationMinutes=${durationMinutes} ` +
      `greeting=${openingLine ? 'deterministic' : 'llm'} ` +
      `models={llm:${meta.llm?.model ?? 'openai/gpt-4o'}, stt:${meta.stt?.model ?? 'deepgram/nova-3'}` +
      `${meta.stt?.fallbackModels?.length ? `(+fallback ${meta.stt.fallbackModels.join(',')})` : ''}, ` +
      `tts:${meta.voice?.model ?? 'tts-1 (local floor)'}, voiceId:${meta.voice?.voiceId ?? '-'}, ` +
      `voiceProvider:${meta.voice?.provider ?? 'openai'}}`,
    );
  },
});
