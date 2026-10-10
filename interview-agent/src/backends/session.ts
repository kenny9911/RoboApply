// Build one session's STT, LLM and TTS through the backend switch, and report
// a worker misconfiguration to the control plane (WP-63b).
//
// A WorkerConfigError (missing DashScope or vendor key, non-mainland endpoint,
// a gateway backend on the GoApply worker, unknown CosyVoice voice, …) is
// posted as lifecycle `{ event: 'error', reason: 'worker_config' }` so the
// session fails visibly instead of leaving the candidate in a silent room.
// Any other error is rethrown without that report (the SDK's own job failure
// path handles it). Whatever was already built is closed before rethrowing.
//
// The poster and every factory are injected so this is unit-testable.

import { errorMessage } from '../session-lifecycle.js';
import type { LiveLlmMeta } from '../live-model.js';
import { WorkerConfigError, type Env } from './config.js';
import { buildLlm, type BuiltLlm, type LlmFactories } from './llm.js';
import {
  buildStt,
  buildTts,
  DEFAULT_SPEECH_FACTORIES,
  type BuiltStt,
  type BuiltTts,
  type SpeechFactories,
  type SttMeta,
  type VoiceMeta,
} from './speech.js';

export interface SessionModelMeta extends LiveLlmMeta {
  voice?: VoiceMeta;
  stt?: SttMeta;
  language?: string;
}

export interface SessionModels {
  stt: BuiltStt;
  llm: BuiltLlm;
  tts: BuiltTts;
}

export interface BuildSessionModelsDeps {
  sessionId: string;
  /** Posts a lifecycle body to the control plane (callbacks.ts createPoster). */
  post: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  env?: Env;
  speechFactories?: SpeechFactories;
  llmFactories?: LlmFactories;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export function lifecyclePath(sessionId: string): string {
  return `/api/v1/interview-engine/callbacks/sessions/${sessionId}/lifecycle`;
}

export async function buildSessionModels(meta: SessionModelMeta, deps: BuildSessionModelsDeps): Promise<SessionModels> {
  const env = deps.env ?? process.env;
  const speech = deps.speechFactories ?? DEFAULT_SPEECH_FACTORIES;
  const warn = deps.warn ?? (() => {});
  let tts: BuiltTts | undefined;
  let stt: BuiltStt | undefined;
  try {
    tts = await buildTts(meta.voice, deps.sessionId, env, speech);
    stt = await buildStt(meta.stt, meta.language ?? 'en', env, speech, warn);
    const llm = buildLlm(meta, env, deps.llmFactories);
    return { stt, llm, tts };
  } catch (err) {
    await tts?.tts.close().catch(() => {});
    await stt?.stt.close().catch(() => {});
    if (err instanceof WorkerConfigError) {
      const message = errorMessage(err);
      deps.error?.(`worker configuration error: ${message}`);
      try {
        await deps.post(lifecyclePath(deps.sessionId), { event: 'error', reason: 'worker_config', message });
      } catch (postErr) {
        warn(`worker_config report failed: ${errorMessage(postErr)}`);
      }
    }
    throw err;
  }
}
