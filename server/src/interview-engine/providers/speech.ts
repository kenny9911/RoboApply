// server/src/interview-engine/providers/speech.ts
//
// The interviewer's voice (TTS) and the candidate's speech recognition (STT)
// per brand (D5; GOAPPLY_PARITY_PLAN.md §3.5, G53).
//
//   RoboApply  Wave 0's voice catalog (voice/voiceCatalog.ts), unchanged:
//              LiveKit Inference voices and STT.
//   GoApply    the same catalog and STT by default (a zh session gets the
//              catalog's Mandarin voice). DashScope speech is an optional
//              override: when BOTH CN_INTERVIEW_ENGINE_STT_MODEL and
//              CN_INTERVIEW_ENGINE_TTS_MODEL are set (`tryGetCnSpeechConfig`),
//              the session uses that set, and every model in it must be
//              domestic.
//
// A session keeps the speech set it was created with: its voice is stored on
// the row, and STT is resolved from the same set (`resolveBrandSessionStt`), so
// the worker never gets a DashScope voice with a gateway STT or the reverse
// because the pair was added or removed while the session waited.

import type { BrandId } from '../../platform/brand/registry.js';
import { getBrand } from '../../platform/brand/registry.js';
import { InterviewEngineConfigError, getCnSpeechConfig, isGoApplySpeechModel, tryGetCnSpeechConfig, type CnSpeechConfig } from '../config.js';
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

function cnVoice(cfg: CnSpeechConfig, locale?: string | null, voiceGender?: VoiceGender): ResolvedVoice {
  const norm = normalizeLocale(locale);
  const gender: 'female' | 'male' = voiceGender === 'male' ? 'male' : 'female';
  const voiceId = (gender === 'male' ? cfg.voiceMale ?? cfg.voiceFemale : cfg.voiceFemale ?? cfg.voiceMale) ?? '';
  return {
    provider: cfg.ttsModel.split('/')[0]!.toLowerCase(),
    model: cfg.ttsModel,
    // Empty = the worker's own default voice for the language.
    voiceId,
    languageCode: speechLanguage(norm),
    label: CN_LABELS[norm]?.[gender] ?? `${norm} · ${gender}`,
  };
}

function cnStt(cfg: CnSpeechConfig, locale?: string | null): ResolvedStt {
  return {
    provider: cfg.sttModel.split('/')[0]!.toLowerCase(),
    model: cfg.sttModel,
    language: speechLanguage(normalizeLocale(locale)),
    fallbackModels: cfg.sttFallbackModels,
  };
}

/** The interviewer voice a NEW session of this brand gets. */
export function resolveBrandVoice(brand: BrandId, locale?: string | null, voiceGender?: VoiceGender): ResolvedVoice {
  const cfg = isCn(brand) ? tryGetCnSpeechConfig(brand) : null;
  return cfg ? cnVoice(cfg, locale, voiceGender) : resolveVoice(locale, voiceGender);
}

/**
 * The voice an existing session connects with: the stored one, as long as the
 * speech set it belongs to is still there. A stored DashScope voice with the
 * CN pair gone, or a stored catalog voice with the CN pair now set, is
 * resolved again on the set in use (the session was prepared before the
 * configuration changed and has not connected yet).
 */
export function resolveBrandSessionVoice(
  brand: BrandId,
  stored: ResolvedVoice | null | undefined,
  locale?: string | null,
  voiceGender?: VoiceGender,
): ResolvedVoice {
  if (!isCn(brand)) return resolveSessionVoice(stored, locale, voiceGender);
  const cfg = tryGetCnSpeechConfig(brand);
  const storedDomestic = !!stored && isGoApplySpeechModel(stored.model);
  if (cfg) return storedDomestic ? stored! : cnVoice(cfg, locale, voiceGender);
  return resolveSessionVoice(storedDomestic ? null : stored, locale, voiceGender);
}

/** Speech recognition for a NEW session of this brand. */
export function resolveBrandStt(brand: BrandId, locale?: string | null): ResolvedStt {
  const cfg = isCn(brand) ? tryGetCnSpeechConfig(brand) : null;
  return cfg ? cnStt(cfg, locale) : resolveStt(locale);
}

/**
 * Speech recognition from the SAME set as the session's voice: DashScope STT
 * for a DashScope voice (GoApply's own speech set; a config error when that
 * set is gone), the shared STT for a catalog voice.
 */
export function resolveBrandSessionStt(brand: BrandId, voice: ResolvedVoice, locale?: string | null): ResolvedStt {
  if (isCn(brand) && isGoApplySpeechModel(voice.model)) return cnStt(getCnSpeechConfig(brand), locale);
  return resolveStt(locale);
}

/**
 * Last check before worker metadata leaves the control plane. It applies to
 * GoApply's own speech set only: when the voice or the STT is a DashScope
 * model, every speech model named must be domestic (one set, never a mix).
 * A session on the shared catalog is not checked: that is the same speech set
 * RoboApply uses.
 */
export function assertBrandSpeech(brand: BrandId, voice: ResolvedVoice, stt: ResolvedStt): void {
  if (!isCn(brand)) return;
  const models = [voice.model, stt.model, ...(stt.fallbackModels ?? [])];
  if (!models.some((m) => isGoApplySpeechModel(m))) return;
  const foreign = models.filter((m) => !isGoApplySpeechModel(m));
  if (foreign.length > 0) {
    throw new InterviewEngineConfigError(
      `GoApply session would mix its DashScope speech set with another one (${foreign.join(', ')}); refusing to connect.`,
    );
  }
}
