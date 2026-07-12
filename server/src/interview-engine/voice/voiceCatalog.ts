// backend/src/interview-engine/voice/voiceCatalog.ts
//
// Requirement #5: pick the best NATIVE-TONE voice for the interview locale.
// Never let an English-accented voice speak another language.
//
// Strategy: emit NATIVE per-locale voices reachable through the LiveKit
// Inference gateway — the SAME gateway the worker already uses for STT/LLM, so
// no provider plugin and no provider API key are needed (LiveKit bills + rate-
// limits it). `model` is a gateway 'provider/model' id and `voiceId` is that
// provider's voice id; the worker passes both straight into `inference.TTS`.
//   • Default: Cartesia `sonic-3` — genuinely native en/zh(Mandarin)/ja/ko and
//     the lowest latency on the gateway (~90ms TTFB).
//   • Exception zh-TW: Cartesia has only ONE Mainland Mandarin, which sounds
//     Mainland to a Taiwanese listener — so Traditional/Taiwan uses ElevenLabs
//     'Yu' (fQj4gJSexpu8RDE2Ii5m), a native youthful Taiwan-accent FEMALE voice
//     (also gateway-billed, no key). CAUTION: the gateway serves only ElevenLabs
//     DEFAULT/curated voices — of the ~20 ElevenLabs "Taiwan Mandarin" library
//     voices, ONLY 'Yu' is gateway-accepted; every other (incl. the former
//     'Anna Su' r6qgCCGI7RWKXCagm158) is REJECTED mid-turn → silent OpenAI-floor
//     fallback speaking generic Mandarin. Never swap in another Taiwan library id
//     without first probing it (interview-agent/verify-voices.mjs zh-TW). The
//     Taiwan accent comes from the VOICE + the Traditional-character prompt text;
//     languageCode is the single gateway Mandarin code 'zh'.
//   • es/fr/pt/de FEMALE currently ride the multilingual English Cartesia voice
//     with the locale's language code (no verified native per-locale Cartesia id
//     yet). Labels say so honestly; drop in a native id via the per-locale env
//     overrides below when one is sourced — no redeploy needed.
//   • MALE voices: each persona carries a voiceGender hint (interviewCatalog.ts)
//     so a male persona never introduces himself in a female voice. All male
//     defaults use the verified ElevenLabs PREMADE 'George' (warm, professional)
//     on the multilingual `eleven_turbo_v2_5` — the same trusted gateway combo
//     as zh-TW — with the per-locale language code. Premade ids only: a
//     fabricated/wrong id silently degrades to the English fallback voice.
//   • The worker keeps OpenAI tts-1 ('nova') as a LOCAL last-resort floor so a
//     session is never mute.
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

/** The verified ElevenLabs PREMADE 'George' — warm, professional male,
 *  multilingual on eleven_turbo_v2_5. One id serves every locale (the locale's
 *  languageCode carries the language); per-locale _MALE env overrides swap in
 *  a native male id without a redeploy. */
const MALE_PREMADE_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
const MALE_PREMADE_MODEL = 'elevenlabs/eleven_turbo_v2_5';

function maleDefault(languageCode: string, label: string): ResolvedVoice {
  return { provider: 'elevenlabs', model: MALE_PREMADE_MODEL, voiceId: MALE_PREMADE_VOICE_ID, languageCode, label };
}

/**
 * Native-tone voice defaults per locale × gender, reached via the LiveKit
 * Inference gateway. `model` = 'provider/model', `voiceId` = that provider's
 * voice id, `languageCode` = short gateway language code. The worker passes all
 * three to `inference.TTS({ model, voice, language })`.
 *   • female (the default): en/zh/ja/ko on native Cartesia sonic-3; zh-TW on an
 *     ElevenLabs Taiwan voice; es/fr/pt/de ride the multilingual English
 *     Cartesia voice with a swapped language code (labels say so) pending
 *     native per-locale ids — override via INTERVIEW_ENGINE_VOICE_<LOCALE>.
 *   • male: the ElevenLabs premade 'George' (multilingual) everywhere —
 *     override via INTERVIEW_ENGINE_VOICE_<LOCALE>_MALE.
 * All gateway-billed — no provider API key. The worker has an OpenAI tts-1
 * local floor, so an unresolved id degrades gracefully.
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
    female: { provider: 'elevenlabs', model: 'elevenlabs/eleven_turbo_v2_5', voiceId: 'fQj4gJSexpu8RDE2Ii5m',                 languageCode: 'zh', label: '國語 · 台灣 · 女聲' },
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
  return {
    provider: providerOverride || base.provider,
    model: localeModelOverride || modelOverride || base.model,
    voiceId: voiceOverride || base.voiceId,
    languageCode: base.languageCode,
    label: base.label,
  };
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
