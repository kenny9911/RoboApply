// server/src/interview-engine/providers/speech.ts
//
// The interviewer's voice (TTS) and the candidate's speech recognition (STT)
// per brand — the speech half of the per-brand voice catalog (ARCHITECTURE.md
// §1.9, CN L-11, R-13).
//
//   RoboApply  Wave 0's voice catalog (voice/voiceCatalog.ts), unchanged:
//              LiveKit Inference voices and STT.
//   GoApply    domestic speech only (CN_INTERVIEW_ENGINE_STT_MODEL /
//              _TTS_MODEL, dashscope/…). The international catalog is never
//              consulted, and a session refuses to be created or connected
//              (InterviewEngineConfigError → 503) rather than name an
//              international STT/TTS in the worker's room metadata.

import type { BrandId } from '../../platform/brand/registry.js';
import { getBrand } from '../../platform/brand/registry.js';
import { InterviewEngineConfigError, getCnSpeechConfig, isGoApplySpeechModel } from '../config.js';
import type { ResolvedStt, ResolvedVoice } from '../types.js';
import {
  normalizeLocale,
  resolveSessionVoice,
  resolveStt,
  resolveVoice,
  type SupportedLocale,
  type VoiceGender,
} from '../voice/voiceCatalog.js';

function isCn(brand: BrandId): boolean {
  return getBrand(brand).market === 'cn';
}

/** Short language code the speech models take (Mandarin for both zh scripts). */
function speechLanguage(locale: SupportedLocale): string {
  return locale === 'zh-TW' ? 'zh' : locale;
}

const CN_LABELS: Partial<Record<SupportedLocale, { female: string; male: string }>> = {
  zh: { female: '普通话 · 女声', male: '普通话 · 男声' },
  'zh-TW': { female: '國語 · 女聲', male: '國語 · 男聲' },
};

/** The interviewer voice a NEW session of this brand gets. */
export function resolveBrandVoice(brand: BrandId, locale?: string | null, voiceGender?: VoiceGender): ResolvedVoice {
  if (!isCn(brand)) return resolveVoice(locale, voiceGender);
  const cfg = getCnSpeechConfig(brand);
  const norm = normalizeLocale(locale);
  const gender: 'female' | 'male' = voiceGender === 'male' ? 'male' : 'female';
  const voiceId = (gender === 'male' ? cfg.voiceMale ?? cfg.voiceFemale : cfg.voiceFemale ?? cfg.voiceMale) ?? '';
  return {
    provider: cfg.ttsModel.split('/')[0]!.toLowerCase(),
    model: cfg.ttsModel,
    // Empty = the worker's own default voice for the language (WP-63b).
    voiceId,
    languageCode: speechLanguage(norm),
    label: CN_LABELS[norm]?.[gender] ?? `${norm} · ${gender}`,
  };
}

/** The voice an existing session connects with. GoApply keeps a stored voice
 *  only when it is domestic; anything else is re-resolved from CN_ config. */
export function resolveBrandSessionVoice(
  brand: BrandId,
  stored: ResolvedVoice | null | undefined,
  locale?: string | null,
  voiceGender?: VoiceGender,
): ResolvedVoice {
  if (!isCn(brand)) return resolveSessionVoice(stored, locale, voiceGender);
  if (stored && isGoApplySpeechModel(stored.model)) return stored;
  return resolveBrandVoice(brand, locale, voiceGender);
}

/** Speech recognition for a session of this brand. */
export function resolveBrandStt(brand: BrandId, locale?: string | null): ResolvedStt {
  if (!isCn(brand)) return resolveStt(locale);
  const cfg = getCnSpeechConfig(brand);
  return {
    provider: cfg.sttModel.split('/')[0]!.toLowerCase(),
    model: cfg.sttModel,
    language: speechLanguage(normalizeLocale(locale)),
    fallbackModels: cfg.sttFallbackModels,
  };
}

/**
 * Last check before worker metadata leaves the control plane: for GoApply,
 * every speech model it names must be domestic. Throws (503) otherwise.
 */
export function assertBrandSpeech(brand: BrandId, voice: ResolvedVoice, stt: ResolvedStt): void {
  if (!isCn(brand)) return;
  const models = [voice.model, stt.model, ...(stt.fallbackModels ?? [])];
  const foreign = models.filter((m) => !isGoApplySpeechModel(m));
  if (foreign.length > 0) {
    throw new InterviewEngineConfigError(
      `GoApply session would use a non-domestic speech model (${foreign.join(', ')}); refusing to connect.`,
    );
  }
}
