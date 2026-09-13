// backend/src/interview-engine/voice/voiceCatalog.ts
//
// Voices use LiveKit Inference, with per-locale language codes and persona
// gender. ElevenLabs was retired from the gateway on August 31, 2026:
// https://docs.livekit.io/agents/models/tts/elevenlabs/
// Cartesia sonic-3 remains supported. The Chinese, Japanese and Korean female
// voices retain their locale defaults; other locales and the male Blake voice
// use multilingual voices. Taiwan currently uses the Mandarin female voice;
// its label does not promise a Taiwan accent. Native alternatives can be set
// through the overrides below after verify-voices.mjs confirms gateway access.
// `languageCode` is now a SHORT gateway code ('en'|'zh'|'ja'|'ko'|...), NOT a
// Google/BCP-47 regional code. Everything is overridable via env (no redeploy):
//
//   INTERVIEW_ENGINE_TTS_PROVIDER          — global provider label override (cosmetic on the gateway path)
//   INTERVIEW_ENGINE_TTS_MODEL             — global model override for ALL locales (e.g. 'inworld/inworld-tts-2')
//   INTERVIEW_ENGINE_MODEL_<LOCALE>        — per-locale model override, female/default voice (e.g. INTERVIEW_ENGINE_MODEL_KO, INTERVIEW_ENGINE_MODEL_ZH_TW)
//   INTERVIEW_ENGINE_VOICE_<LOCALE>        — per-locale voiceId override, female/default voice (e.g. INTERVIEW_ENGINE_VOICE_ZH)
//   INTERVIEW_ENGINE_MODEL_<LOCALE>_MALE   — per-locale model override, male voice (e.g. INTERVIEW_ENGINE_MODEL_ZH_MALE)
//   INTERVIEW_ENGINE_VOICE_<LOCALE>_MALE   — per-locale voiceId override, male voice (e.g. INTERVIEW_ENGINE_VOICE_ZH_MALE)

import type { ResolvedVoice, ResolvedStt } from '../types.js';
import { getWorkerSttModel, getWorkerSttFallbackModels } from '../config.js';

export type SupportedLocale = 'en' | 'zh' | 'zh-TW' | 'ja' | 'ko' | 'es' | 'fr' | 'pt' | 'de';

const SUPPORTED: SupportedLocale[] = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de'];

/** Normalize any BCP-47-ish input to one of our supported locales. */
export function normalizeLocale(input?: string | null): SupportedLocale {
  const raw = (input || '').trim().toLowerCase().replace('_', '-');
  if (!raw) return 'en';
  if (raw === 'zh-tw' || raw === 'zh-hant' || raw === 'zh-hk' || raw.startsWith('zh-tw') || raw.includes('hant')) return 'zh-TW';
  if (raw.startsWith('zh')) return 'zh';
  if (raw.startsWith('ja')) return 'ja';
  if (raw.startsWith('ko')) return 'ko';
  if (raw.startsWith('es')) return 'es';
  if (raw.startsWith('fr')) return 'fr';
  if (raw.startsWith('pt')) return 'pt';
  if (raw.startsWith('de')) return 'de';
  if (raw.startsWith('en')) return 'en';
  return 'en';
}

export function isSupportedLocale(input?: string | null): boolean {
  return SUPPORTED.includes(normalizeLocale(input));
}

export type VoiceGender = 'female' | 'male' | 'neutral';

/** Cartesia Blake, a male voice listed by LiveKit and probed through the gateway.
 * https://docs.livekit.io/agents/models/tts/cartesia/#voices
 * Language is pinned separately; non-English labels describe it as multilingual. */
const MALE_PREMADE_VOICE_ID = 'a167e0f3-df7e-4d52-a9c3-f949145efdab';
const MALE_PREMADE_MODEL = 'cartesia/sonic-3';
const RETIRED_MALE_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
const RETIRED_TAIWAN_VOICE_ID = 'fQj4gJSexpu8RDE2Ii5m';
const warnedRetiredOverrides = new Set<string>();

function maleDefault(languageCode: string, label: string): ResolvedVoice {
  return { provider: 'cartesia', model: MALE_PREMADE_MODEL, voiceId: MALE_PREMADE_VOICE_ID, languageCode, label };
}

/**
 * Voice defaults per locale × gender, reached via the LiveKit
 * Inference gateway. `model` = 'provider/model', `voiceId` = that provider's
 * voice id, `languageCode` = short gateway language code. The worker passes all
 * three to `inference.TTS({ model, voice, language })`.
 *   • female (the default): en/zh/ja/ko on Cartesia sonic-3; zh-TW on the same
 *     Mandarin voice as zh; es/fr/pt/de ride the multilingual English
 *     Cartesia voice with a swapped language code (labels say so) pending
 *     native per-locale ids — override via INTERVIEW_ENGINE_VOICE_<LOCALE>.
 *   • male: Cartesia Blake (multilingual) everywhere —
 *     override via INTERVIEW_ENGINE_VOICE_<LOCALE>_MALE.
 * All gateway-billed — no provider API key.
 */
const VOICE_DEFAULTS: Record<SupportedLocale, { female: ResolvedVoice; male: ResolvedVoice }> = {
  en: {
    female: { provider: 'cartesia',   model: 'cartesia/sonic-3',             voiceId: '694f9389-aac1-45b6-b726-9d9369183238', languageCode: 'en', label: 'English · US · female · warm' },
    male:   maleDefault('en', 'English · male · warm professional'),
  },
  zh: {
    female: { provider: 'cartesia',   model: 'cartesia/sonic-3',             voiceId: 'e90c6678-f0d3-4767-9883-5d0ecf5894a8', languageCode: 'zh', label: '普通话 · 大陆 · 女声' },
    male:   maleDefault('zh', '普通话 · 男声 · 多语音色'),
  },
  'zh-TW': {
    female: { provider: 'cartesia',   model: 'cartesia/sonic-3',             voiceId: 'e90c6678-f0d3-4767-9883-5d0ecf5894a8', languageCode: 'zh', label: '國語 · 通用華語 · 女聲' },
    male:   maleDefault('zh', '國語 · 男聲 · 多語音色'),
  },
  ja: {
    female: { provider: 'cartesia',   model: 'cartesia/sonic-3',             voiceId: '2b568345-1d48-4047-b25f-7baccf842eb0', languageCode: 'ja', label: '日本語 · 女性' },
    male:   maleDefault('ja', '日本語 · 男性 · 多言語ボイス'),
  },
  ko: {
    female: { provider: 'cartesia',   model: 'cartesia/sonic-3',             voiceId: '29e5f8b4-b953-4160-848f-40fae182235b', languageCode: 'ko', label: '한국어 · 여성 · 차분' },
    male:   maleDefault('ko', '한국어 · 남성 · 다국어 보이스'),
  },
  es: {
    female: { provider: 'cartesia',   model: 'cartesia/sonic-3',             voiceId: '694f9389-aac1-45b6-b726-9d9369183238', languageCode: 'es', label: 'Español · multilingüe · femenino' },
    male:   maleDefault('es', 'Español · multilingüe · masculino'),
  },
  fr: {
    female: { provider: 'cartesia',   model: 'cartesia/sonic-3',             voiceId: '694f9389-aac1-45b6-b726-9d9369183238', languageCode: 'fr', label: 'Français · multilingue · féminin' },
    male:   maleDefault('fr', 'Français · multilingue · masculin'),
  },
  pt: {
    female: { provider: 'cartesia',   model: 'cartesia/sonic-3',             voiceId: '694f9389-aac1-45b6-b726-9d9369183238', languageCode: 'pt', label: 'Português · multilíngue · feminino' },
    male:   maleDefault('pt', 'Português · multilíngue · masculino'),
  },
  de: {
    female: { provider: 'cartesia',   model: 'cartesia/sonic-3',             voiceId: '694f9389-aac1-45b6-b726-9d9369183238', languageCode: 'de', label: 'Deutsch · mehrsprachig · weiblich' },
    male:   maleDefault('de', 'Deutsch · mehrsprachig · männlich'),
  },
};

/** STT language hint per locale (passed to the worker's STT model). The worker
 *  re-normalizes (zh-TW → 'zh') for Deepgram, which uses one Mandarin code. */
const STT_LANGUAGE: Record<SupportedLocale, string> = {
  en: 'en',
  zh: 'zh',
  'zh-TW': 'zh-TW',
  ja: 'ja',
  ko: 'ko',
  es: 'es',
  fr: 'fr',
  pt: 'pt',
  de: 'de',
};

// The female keys keep their historical names (no `_FEMALE` suffix) so existing
// deployments' env overrides keep working unchanged; male adds a `_MALE` suffix.
function localeEnvKey(locale: SupportedLocale, gender: 'female' | 'male' = 'female'): string {
  return `INTERVIEW_ENGINE_VOICE_${locale.toUpperCase().replace('-', '_')}${gender === 'male' ? '_MALE' : ''}`;
}

function localeModelEnvKey(locale: SupportedLocale, gender: 'female' | 'male' = 'female'): string {
  return `INTERVIEW_ENGINE_MODEL_${locale.toUpperCase().replace('-', '_')}${gender === 'male' ? '_MALE' : ''}`;
}

/** Resolve the native-tone voice for an interview locale (with env overrides).
 *  Precedence: per-locale env > global env > the gateway default.
 *  `voiceGender` follows the persona's hint: omitted / 'neutral' / 'female' →
 *  the female default (the historical behavior), 'male' → the male voice. */
export function resolveVoice(locale?: string | null, voiceGender?: VoiceGender): ResolvedVoice {
  const norm = normalizeLocale(locale);
  const gender: 'female' | 'male' = voiceGender === 'male' ? 'male' : 'female';
  const base = VOICE_DEFAULTS[norm][gender];
  const providerOverride = process.env.INTERVIEW_ENGINE_TTS_PROVIDER?.trim();
  const modelOverride = process.env.INTERVIEW_ENGINE_TTS_MODEL?.trim();           // global, all locales
  const localeModelOverride = process.env[localeModelEnvKey(norm, gender)]?.trim(); // per-locale (+ _MALE), e.g. KO / ZH_TW
  const voiceOverride = process.env[localeEnvKey(norm, gender)]?.trim();            // per-locale (+ _MALE) voiceId
  // Older setup instructions pinned these defaults as voice-only overrides.
  // Their ElevenLabs ids cannot be paired with the new Cartesia model. Preserve
  // custom overrides and explicit model/provider choices; migrate only the
  // former default for this locale/gender when no model/provider is specified.
  const retiredDefaultOverride = !localeModelOverride && !modelOverride && !providerOverride && (
    (gender === 'male' && voiceOverride === RETIRED_MALE_VOICE_ID)
    || (norm === 'zh-TW' && gender === 'female' && voiceOverride === RETIRED_TAIWAN_VOICE_ID)
  );
  if (retiredDefaultOverride) {
    const key = localeEnvKey(norm, gender);
    if (!warnedRetiredOverrides.has(key)) {
      warnedRetiredOverrides.add(key);
      console.warn(`[interview-engine] ${key} uses a retired ElevenLabs default; using the current ${base.model} default.`);
    }
  }
  return {
    provider: providerOverride || base.provider,
    model: localeModelOverride || modelOverride || base.model,
    voiceId: (!retiredDefaultOverride && voiceOverride) || base.voiceId,
    languageCode: base.languageCode,
    label: base.label,
  };
}

/** Prepared sessions persist their voice before connecting. Refresh retired
 * gateway voices at dispatch time so those sessions benefit from new defaults.
 * Supported stored voices remain stable; current explicit env overrides still
 * take precedence when resolving a replacement. */
export function resolveSessionVoice(
  storedVoice: ResolvedVoice | null | undefined,
  locale?: string | null,
  voiceGender?: VoiceGender,
): ResolvedVoice {
  if (storedVoice && !storedVoice.model?.trim().startsWith('elevenlabs/')) return storedVoice;
  const gender = voiceGender ?? (storedVoice?.voiceId === RETIRED_MALE_VOICE_ID ? 'male' : undefined);
  return resolveVoice(locale, gender);
}

/** Resolve the STT config for an interview locale. */
export function resolveStt(locale?: string | null): ResolvedStt {
  const norm = normalizeLocale(locale);
  return {
    provider: (getWorkerSttModel().split('/')[0] || 'deepgram'),
    model: getWorkerSttModel(),
    language: STT_LANGUAGE[norm],
    fallbackModels: getWorkerSttFallbackModels(),
  };
}

export const __test = { VOICE_DEFAULTS, STT_LANGUAGE, localeEnvKey, localeModelEnvKey, MALE_PREMADE_VOICE_ID, MALE_PREMADE_MODEL };
