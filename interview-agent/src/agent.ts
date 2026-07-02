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
// STT (Deepgram Nova-3) → LLM → TTS (OpenAI tts-1).
//
// This file ONLY defines the agent (default export). The worker is launched
// from main.ts via cli.runApp, which points `ServerOptions.agent` at this file
// so job subprocesses import the default export.

import { config as loadEnv } from 'dotenv';
import { inference, voice, defineAgent, type JobContext, type JobProcess } from '@livekit/agents';
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
  // and a short language code. A server-side gateway `fallback` covers a runtime
  // provider error; the local OpenAI tts-1 floor below covers a construction
  // error — together a session is never mute.
  const model = voiceMeta?.model?.trim();
  const voiceId = voiceMeta?.voiceId?.trim();
  const language = voiceMeta?.languageCode?.trim() || undefined;

  // Any 'provider/model' id → gateway TTS. (Legacy bare ids without a slash —
  // e.g. the old 'tts' — fall through to the OpenAI floor.)
  if (model && model.includes('/')) {
    try {
      return new inference.TTS({
        model,
        ...(voiceId ? { voice: voiceId } : {}),
        ...(language ? { language } : {}),
        // Server-side gateway failover (gateway-valid providers only — OpenAI is
        // NOT an Inference TTS provider, it's the LOCAL floor below). ElevenLabs
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
    } catch (err) {
      console.warn(`[interview-agent] session_id=${sessionId ?? 'unknown'} inference.TTS init failed; using OpenAI floor:`, err);
    }
  }

  // Local last-resort floor: OpenAI tts-1 (multilingual, needs only
  // OPENAI_API_KEY which the worker already has). Never let a session go mute.
  const chosen = voiceId && OPENAI_VOICES.has(voiceId) ? voiceId : 'nova';
  return new openai.TTS({ model: 'tts-1', voice: chosen as openai.TTSVoices });
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
    //  - preemptiveGeneration: start drafting the reply before the candidate
    //    fully stops → lower perceived latency.
    //  - MultilingualModel turn detector: wait for a *meaning*-complete turn so
    //    we don't cut the candidate off mid-thought.
    //  - minInterruptionDuration: the candidate must speak ~0.5s to barge in, so
    //    a stray "mhm"/cough doesn't stop the interviewer.
    //  - min/maxEndpointingDelay: snappy but patient end-of-turn detection,
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
        // Require ~0.6s of real speech to interrupt the agent, so brief noise or
        // residual echo doesn't cut it off mid-sentence. (ms)
        interruption: { enabled: true, minDuration: 600 },
        // Draft the reply (and start TTS) before the candidate fully stops →
        // lower perceived latency.
        preemptiveGeneration: { enabled: true, preemptiveTts: true },
      },
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

    // 3c) Observable time management. The system prompt tells the model to
    //     "manage your time" but an LLM has no clock — these timers inject
    //     non-spoken system notes at fixed fractions of the planned duration so
    //     pacing decisions are grounded in actual elapsed time. Cleared on
    //     shutdown.
    const timeManagementTimers: NodeJS.Timeout[] = [];

    ctx.addShutdownCallback(async () => {
      for (const t of timeManagementTimers) clearTimeout(t);
      timeManagementTimers.length = 0;
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
    const agent = new voice.Agent({ instructions: systemPrompt });
    await session.start({ agent, room: ctx.room });

    // The greeting must NOT be interruptible — otherwise the candidate's mic
    // picking up the agent's own voice (or any noise) cuts it off immediately.
    // Prefer a DETERMINISTIC spoken greeting (`say`) over an LLM-generated one
    // (`generateReply`): say() synthesizes a known, fully-localized line and
    // never depends on the LLM producing a first turn, so the candidate ALWAYS
    // hears an opening. addToChatCtx records it as the interviewer's turn so the
    // model continues the conversation naturally instead of greeting again.
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

    // 'started' lifecycle: the agent's join time is otherwise unknowable
    // server-side (the control plane only sees dispatch, not the greeting).
    void post(`/api/v1/interview-engine/callbacks/sessions/${sessionId}/lifecycle`, {
      event: 'started',
      joinMs: Date.now() - entryAt,
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
        }
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
