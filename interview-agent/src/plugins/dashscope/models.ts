// DashScope model / voice selection (pure; unit-tested).
//
// The control plane names speech models as `dashscope/<model>`
// (CN_INTERVIEW_ENGINE_STT_MODEL / CN_INTERVIEW_ENGINE_TTS_MODEL) and may pass
// a CosyVoice voice id (CN_INTERVIEW_ENGINE_TTS_VOICE[_MALE]); an empty voice
// id means "the worker's default for that gender".

import type { Env } from '../../backends/config.js';

export const DASHSCOPE_PREFIX = 'dashscope/';
export const DEFAULT_PARAFORMER_MODEL = 'paraformer-realtime-v2';
export const DEFAULT_COSYVOICE_MODEL = 'cosyvoice-v2';

/** `dashscope/paraformer-realtime-v2` → `paraformer-realtime-v2`; null when not a DashScope id. */
export function dashscopeModelId(model: string | null | undefined): string | null {
  const m = (model ?? '').trim();
  if (!m.toLowerCase().startsWith(DASHSCOPE_PREFIX)) return null;
  const id = m.slice(DASHSCOPE_PREFIX.length).trim();
  return id || null;
}

export function isDashScopeModel(model: string | null | undefined): boolean {
  return dashscopeModelId(model) !== null;
}

// ── Paraformer (STT) ────────────────────────────────────────────────────────

/** 8k telephone models take 8 kHz audio; everything else 16 kHz. */
export function paraformerSampleRate(model: string): number {
  return /-8k-/.test(model) ? 8000 : 16000;
}

/**
 * Languages paraformer-realtime-v2 accepts as `language_hints`. Mainland
 * interviews mix English technical terms into Mandarin, so zh adds en.
 */
const PARAFORMER_V2_LANGS = new Set(['zh', 'en', 'ja', 'ko', 'yue', 'de', 'fr', 'ru']);

export function paraformerLanguageHints(model: string, language: string | undefined): string[] | undefined {
  if (!/paraformer-realtime(-8k)?-v2/.test(model)) return undefined; // only v2 takes hints
  const raw = (language ?? '').toLowerCase();
  const base = raw.startsWith('zh') || raw.startsWith('cmn') ? 'zh' : raw.split(/[-_]/)[0] ?? '';
  if (!PARAFORMER_V2_LANGS.has(base)) return undefined; // let the model auto-detect
  return base === 'zh' ? ['zh', 'en'] : [base];
}

export function paraformerParameters(model: string, language: string | undefined): Record<string, unknown> {
  const hints = paraformerLanguageHints(model, language);
  const isV2 = /paraformer-realtime(-8k)?-v2/.test(model);
  return {
    format: 'pcm',
    sample_rate: paraformerSampleRate(model),
    // Keep the candidate's own words (filler words feed the cn report's
    // filler-word count, WP-66).
    disfluency_removal_enabled: false,
    // Keep the task alive through long thinking pauses instead of the
    // server's idle timeout.
    heartbeat: true,
    // v2 closes a sentence after this much silence (default 800 ms). Shorter
    // than the agent's own end-of-turn window (800 ms for zh, see agent.ts
    // endpointingFor) so the final transcript is in before the turn commits.
    ...(isV2 ? { max_sentence_silence: 500 } : {}),
    ...(hints ? { language_hints: hints } : {}),
  };
}

// ── CosyVoice (TTS) ─────────────────────────────────────────────────────────

export const COSYVOICE_SAMPLE_RATE = 24000;

export type VoiceGender = 'female' | 'male';

/** Built-in default voices for the CosyVoice generations whose catalog we know. */
const DEFAULT_VOICES: Array<{ match: RegExp; female: string; male: string }> = [
  { match: /^cosyvoice-v2\b/, female: 'longxiaochun_v2', male: 'longcheng_v2' },
  { match: /^cosyvoice-v1$/, female: 'longxiaochun', male: 'longcheng' },
];

/**
 * Gender of the session voice. The control plane resolves the gender into the
 * voice id; when it leaves the id empty it still labels the voice
 * (e.g. "普通话 · 男声"), which is the only hint the worker gets.
 */
export function voiceGenderFromLabel(label: string | null | undefined): VoiceGender {
  const l = (label ?? '').toLowerCase();
  if (/男/.test(l)) return 'male';
  if (/\bfemale\b|女/.test(l)) return 'female';
  if (/\bmale\b/.test(l)) return 'male';
  return 'female';
}

/**
 * Voice precedence: metadata voice id (control plane CN_INTERVIEW_ENGINE_TTS_VOICE[_MALE])
 * → worker env COSYVOICE_VOICE_ZH_{FEMALE,MALE} → built-in default for the
 * model generation. Returns null when nothing applies (unknown generation and
 * no configured voice): the caller fails the session with a config error
 * rather than guess a voice id the model may reject.
 */
export function resolveCosyVoice(
  model: string,
  voiceId: string | null | undefined,
  gender: VoiceGender,
  env: Env,
): string | null {
  const explicit = (voiceId ?? '').trim();
  if (explicit) return explicit;
  const envName = gender === 'male' ? 'COSYVOICE_VOICE_ZH_MALE' : 'COSYVOICE_VOICE_ZH_FEMALE';
  const fromEnv = (env[envName] ?? '').trim();
  if (fromEnv) return fromEnv;
  const defaults = DEFAULT_VOICES.find((d) => d.match.test(model));
  return defaults ? defaults[gender] : null;
}

export function cosyVoiceParameters(voice: string, sampleRate = COSYVOICE_SAMPLE_RATE): Record<string, unknown> {
  return {
    text_type: 'PlainText',
    voice,
    format: 'pcm',
    sample_rate: sampleRate,
    volume: 50,
    rate: 1,
    pitch: 1,
  };
}
