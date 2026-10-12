// Speech (STT / TTS) backend switch (WP-63b, CN-E-06).
//
//   gateway              LiveKit Inference STT + TTS, with the optional OpenAI
//                        tts-1 floor. RoboApply's worker: unchanged.
//   dashscope_paraformer DashScope Paraformer realtime STT (plugins/dashscope).
//   dashscope_cosyvoice  DashScope CosyVoice streaming TTS (plugins/dashscope).
//
// Selection per session, from the model ids the control plane writes into the
// room metadata: a `dashscope/…` model (GoApply: CN_INTERVIEW_ENGINE_STT_MODEL /
// _TTS_MODEL) selects the DashScope plugin, anything else the gateway.
// STT_BACKEND / TTS_BACKEND pin the choice for a deployment: the GoApply
// worker sets them to the DashScope values so a session can never reach the
// international gateway, whatever its metadata says.
//
// Fail closed: a DashScope session without DASHSCOPE_API_KEY is a
// WorkerConfigError, never a silent gateway fallback, and the DashScope voice
// gets no OpenAI floor (the candidate-facing text would leave the mainland).
// The plugin module is imported only when a DashScope backend is selected, so
// a worker without the key never loads it.

import { inference, type stt as sttNs, type tts as ttsNs } from '@livekit/agents';
import type * as openai from '@livekit/agents-plugin-openai';
import { InterviewTtsFallback } from '../tts-fallback.js';
import { SafeOpenAiTts } from '../safe-openai-tts.js';
import { WorkerConfigError, envValue, hostOf, isDomesticHost, isGoApplyWorker, type Env } from './config.js';
import {
  DEFAULT_COSYVOICE_MODEL,
  DEFAULT_PARAFORMER_MODEL,
  dashscopeModelId,
  isDashScopeModel,
  resolveCosyVoice,
  voiceGenderFromLabel,
} from '../plugins/dashscope/models.js';
import type { DashScopeConnection } from '../plugins/dashscope/protocol.js';

type DashScopeModule = typeof import('../plugins/dashscope/index.js');

/** Room-metadata speech blocks (subset of InterviewRoomMetadata). */
export interface SttMeta {
  provider?: string;
  model?: string;
  language?: string;
  fallbackModels?: string[];
}

export interface VoiceMeta {
  provider?: string;
  model?: string;
  voiceId?: string;
  languageCode?: string;
  /** e.g. "普通话 · 男声"; the only gender hint when voiceId is empty. */
  label?: string;
}

export const STT_BACKENDS = ['gateway', 'dashscope_paraformer'] as const;
export const TTS_BACKENDS = ['gateway', 'dashscope_cosyvoice'] as const;
export type SttBackend = (typeof STT_BACKENDS)[number];
export type TtsBackend = (typeof TTS_BACKENDS)[number];

/** Valid OpenAI TTS voice names — used to validate a metadata voice override. */
const OPENAI_VOICES = new Set([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer',
]);

function pinned<T extends string>(env: Env, name: string, allowed: readonly T[]): T | null {
  const raw = envValue(env, name).toLowerCase();
  if (!raw) return null;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new WorkerConfigError(`${name}="${raw}" is not supported. Use ${allowed.join(' or ')}.`);
}

/** The GoApply (mainland) worker never resolves a speech backend to the gateway. */
function refuseGatewayOnGoApply(kind: 'STT' | 'TTS', model: string | undefined, env: Env): void {
  if (!isGoApplyWorker(env)) return;
  throw new WorkerConfigError(
    `the GoApply worker (GoApply-Interview) only runs DashScope speech, but the session ${kind} model ` +
    `${model?.trim() || '(none)'} would use the LiveKit gateway; set ${kind}_BACKEND=` +
    `${kind === 'STT' ? 'dashscope_paraformer' : 'dashscope_cosyvoice'} and send dashscope/… models`,
  );
}

export function resolveSttBackend(model: string | undefined, env: Env = process.env): SttBackend {
  const explicit = pinned(env, 'STT_BACKEND', STT_BACKENDS);
  if (explicit === 'gateway' && isDashScopeModel(model)) {
    throw new WorkerConfigError(`session STT model ${model} needs DashScope, but this worker pins STT_BACKEND=gateway`);
  }
  const backend: SttBackend = explicit ?? (isDashScopeModel(model) ? 'dashscope_paraformer' : 'gateway');
  if (backend === 'gateway') refuseGatewayOnGoApply('STT', model, env);
  return backend;
}

export function resolveTtsBackend(model: string | undefined, env: Env = process.env): TtsBackend {
  const explicit = pinned(env, 'TTS_BACKEND', TTS_BACKENDS);
  if (explicit === 'gateway' && isDashScopeModel(model)) {
    throw new WorkerConfigError(`session voice model ${model} needs DashScope, but this worker pins TTS_BACKEND=gateway`);
  }
  const backend: TtsBackend = explicit ?? (isDashScopeModel(model) ? 'dashscope_cosyvoice' : 'gateway');
  if (backend === 'gateway') refuseGatewayOnGoApply('TTS', model, env);
  return backend;
}

/** DashScope credentials + endpoint. The endpoint must be mainland (not dashscope-intl). */
export function dashscopeConnection(env: Env = process.env): DashScopeConnection {
  const apiKey = envValue(env, 'DASHSCOPE_API_KEY');
  if (!apiKey) {
    throw new WorkerConfigError('DASHSCOPE_API_KEY is not set; this session needs DashScope speech (Paraformer / CosyVoice)');
  }
  const url = envValue(env, 'DASHSCOPE_WS_URL');
  if (url && !isDomesticHost(hostOf(url), env)) {
    throw new WorkerConfigError(`DASHSCOPE_WS_URL host ${hostOf(url) ?? url} is not a mainland endpoint`);
  }
  const workspace = envValue(env, 'DASHSCOPE_WORKSPACE');
  return { apiKey, ...(url ? { url } : {}), ...(workspace ? { workspace } : {}) };
}

/** Map an interview locale to a valid inference STT language code. The
 *  interview language is KNOWN, so we PIN it — otherwise STT defaults to English
 *  and mis-transcribes e.g. Mandarin speech as English gibberish. zh-TW/zh-CN
 *  both map to 'zh' (Scribe/Deepgram use one Mandarin code). */
export function sttLanguage(raw: string | undefined): string {
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

/**
 * Barge-in gate for the interviewer (AgentSession turnHandling.interruption).
 * The SDK counts transcript words with a whitespace split (`/\S+/`), so an
 * unspaced Chinese / Japanese / Korean transcript — Paraformer always, and any
 * CJK interview — is ONE word however long it is. With minWords 2 such a
 * candidate could never interrupt, and a whole turn that ends while the
 * interviewer is still talking is dropped ("word count below minimum
 * interruption threshold"). Those sessions use minWords 1; minDuration 600 ms
 * of speech still filters a cough, a short "嗯" or an echo tail.
 */
export function interruptionFor(
  sttBackend: SttBackend,
  language: string | undefined,
): { enabled: true; minDuration: number; minWords: number } {
  const lang = sttLanguage(language);
  const unspaced = sttBackend === 'dashscope_paraformer' || lang === 'zh' || lang === 'ja' || lang === 'ko';
  return { enabled: true, minDuration: 600, minWords: unspaced ? 1 : 2 };
}

/** Constructors, injectable so tests never open a gateway or vendor connection. */
export interface SpeechFactories {
  gatewayStt: (opts: { model: string; language: string; fallback?: string[] }) => sttNs.STT;
  gatewayTts: (opts: { model: string; voice?: string; language?: string }) => ttsNs.TTS;
  openaiFloor: (opts: { model: string; voice: openai.TTSVoices; apiKey: string }) => ttsNs.TTS;
  loadDashScope: () => Promise<DashScopeModule>;
}

export const DEFAULT_SPEECH_FACTORIES: SpeechFactories = {
  gatewayStt: (opts) => new inference.STT(opts as ConstructorParameters<typeof inference.STT>[0]),
  gatewayTts: (opts) => new inference.TTS(opts as ConstructorParameters<typeof inference.TTS>[0]),
  openaiFloor: (opts) => new SafeOpenAiTts(opts),
  loadDashScope: () => import('../plugins/dashscope/index.js'),
};

export interface BuiltStt {
  stt: sttNs.STT;
  backend: SttBackend;
  model: string;
}

export async function buildStt(
  meta: SttMeta | undefined,
  language: string,
  env: Env = process.env,
  factories: SpeechFactories = DEFAULT_SPEECH_FACTORIES,
  warn: (msg: string) => void = () => {},
): Promise<BuiltStt> {
  const backend = resolveSttBackend(meta?.model, env);
  if (backend === 'dashscope_paraformer') {
    const conn = dashscopeConnection(env);
    const model = dashscopeModelId(meta?.model) ?? DEFAULT_PARAFORMER_MODEL;
    const ignored = (meta?.fallbackModels ?? []).filter(Boolean);
    if (ignored.length) {
      warn(`DashScope STT has no provider failover; ignoring fallback models ${ignored.join(', ')} (the SDK retries the task)`);
    }
    const { ParaformerSTT } = await factories.loadDashScope();
    return { stt: new ParaformerSTT({ ...conn, model, language: meta?.language ?? language }), backend, model };
  }

  // Gateway: unchanged from the pre-switch worker.
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
  const fallback = (meta?.fallbackModels ?? []).filter(Boolean);
  const model = meta?.model ?? 'deepgram/nova-3';
  return {
    stt: factories.gatewayStt({
      model,
      language: sttLanguage(meta?.language ?? language),
      ...(fallback.length ? { fallback } : {}),
    }),
    backend,
    model,
  };
}

export interface BuiltTts {
  tts: InterviewTtsFallback;
  backend: TtsBackend;
  model: string;
  voice?: string;
}

export async function buildTts(
  voiceMeta: VoiceMeta | undefined,
  sessionId: string | undefined,
  env: Env = process.env,
  factories: SpeechFactories = DEFAULT_SPEECH_FACTORIES,
): Promise<BuiltTts> {
  const backend = resolveTtsBackend(voiceMeta?.model, env);
  if (backend === 'dashscope_cosyvoice') {
    const conn = dashscopeConnection(env);
    const model = dashscopeModelId(voiceMeta?.model) ?? DEFAULT_COSYVOICE_MODEL;
    const voice = resolveCosyVoice(model, voiceMeta?.voiceId, voiceGenderFromLabel(voiceMeta?.label), env);
    if (!voice) {
      throw new WorkerConfigError(
        `no CosyVoice voice for ${model}: set CN_INTERVIEW_ENGINE_TTS_VOICE on the control plane or ` +
        'COSYVOICE_VOICE_ZH_FEMALE / COSYVOICE_VOICE_ZH_MALE on the worker',
      );
    }
    const { CosyVoiceTTS } = await factories.loadDashScope();
    // Single domestic provider; the fallback wrapper still owns zero-frame
    // and teardown handling exactly as for the gateway voice.
    return { tts: new InterviewTtsFallback([new CosyVoiceTTS({ ...conn, model, voice })]), backend, model, voice };
  }
  return { ...buildGatewayTts(voiceMeta, sessionId, env, factories), backend };
}

/** Gateway voice + optional OpenAI floor: unchanged from the pre-switch worker. */
function buildGatewayTts(
  voiceMeta: VoiceMeta | undefined,
  sessionId: string | undefined,
  env: Env,
  factories: SpeechFactories,
): { tts: InterviewTtsFallback; model: string; voice?: string } {
  const model = voiceMeta?.model?.trim();
  const voiceId = voiceMeta?.voiceId?.trim();
  const language = voiceMeta?.languageCode?.trim() || undefined;

  // Read the optional direct-provider key after dotenv has loaded. A configured
  // key can still be out of quota; the fallback handles that as a provider
  // failure, never as a guarantee that speech is available.
  const openaiKey = env.OPENAI_API_KEY?.trim();
  const floorVoice = voiceId && OPENAI_VOICES.has(voiceId) ? voiceId : 'nova';
  const floor = openaiKey ? factories.openaiFloor({
    model: 'tts-1',
    voice: floorVoice as openai.TTSVoices,
    apiKey: openaiKey,
  }) : null;

  if (model && model.includes('/')) {
    try {
      const primary = factories.gatewayTts({
        model,
        ...(voiceId ? { voice: voiceId } : {}),
        ...(language ? { language } : {}),
      });
      // The catalog selects supported gateway voices. ElevenLabs was retired
      // from LiveKit Inference on 2026-08-31, so it cannot be a gateway fallback.
      // Handle mid-stream/zero-frame failures locally without the SDK 1.6.2
      // recovery loop, which calls unsupported inference.TTS.synthesize().
      return { tts: new InterviewTtsFallback(floor ? [primary, floor] : [primary]), model, ...(voiceId ? { voice: voiceId } : {}) };
    } catch (err) {
      console.warn(
        `[interview-agent] session_id=${sessionId ?? 'unknown'} inference.TTS init failed; using OpenAI floor:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Legacy bare model ids use the direct-provider path.
  if (floor) return { tts: new InterviewTtsFallback([floor]), model: 'tts-1', voice: floorVoice };
  throw new Error('no TTS available: gateway voice unusable and OPENAI_API_KEY unset');
}

/** One greppable line describing the deployment's backend switches (never secrets). */
export function describeBackends(env: Env = process.env): string {
  const parts = [
    `llm_backend=${envValue(env, 'LLM_BACKEND') || (isGoApplyWorker(env) ? 'openai_compatible' : 'gateway')}`,
    `stt_backend=${envValue(env, 'STT_BACKEND') || 'auto'}`,
    `tts_backend=${envValue(env, 'TTS_BACKEND') || 'auto'}`,
    `dashscope_key=${envValue(env, 'DASHSCOPE_API_KEY') ? 'set' : 'unset'}`,
    `brand=${isGoApplyWorker(env) ? 'goapply' : 'roboapply'}`,
  ];
  return parts.join(' ');
}
