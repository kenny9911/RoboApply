import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSessionVoice, resolveVoice } from './voiceCatalog.js';
import type { ResolvedVoice } from '../types.js';

const locales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de'];
const retiredMale: ResolvedVoice = {
  provider: 'elevenlabs', model: 'elevenlabs/eleven_turbo_v2_5',
  voiceId: 'JBFqnCBsd6RMkjVDRZzb', languageCode: 'zh', label: 'Male',
};
const retiredTaiwan: ResolvedVoice = {
  ...retiredMale, voiceId: 'fQj4gJSexpu8RDE2Ii5m', label: 'Taiwan female',
};

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (/^INTERVIEW_ENGINE_(TTS_|VOICE_|MODEL_)/.test(key)) vi.stubEnv(key, undefined);
  }
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('voice catalog after gateway provider retirement', () => {
  it.each(locales)('keeps distinct male and female voices with the right language for %s', (locale) => {
    const female = resolveVoice(locale, 'female');
    const male = resolveVoice(locale, 'male');
    expect(male.voiceId).not.toBe(female.voiceId);
    for (const voice of [female, male]) {
      expect(voice.model).toBe('cartesia/sonic-3');
      expect(voice.provider).toBe('cartesia');
      expect(voice.languageCode).toBe(locale === 'zh-TW' ? 'zh' : locale);
    }
  });

  it('migrates prepared sessions without losing the male persona or Mandarin language', () => {
    expect(resolveSessionVoice(retiredMale, 'zh', 'male')).toEqual(resolveVoice('zh', 'male'));
    expect(resolveSessionVoice(retiredTaiwan, 'zh-TW', 'female')).toEqual(resolveVoice('zh-TW', 'female'));
    expect(resolveSessionVoice(null, 'zh', 'male')).toEqual(resolveVoice('zh', 'male'));
  });

  it('retains the old male voice gender when the saved persona is unavailable', () => {
    expect(resolveSessionVoice(retiredMale, 'zh')).toEqual(resolveVoice('zh', 'male'));
  });

  it('keeps supported stored voices stable even when defaults or environment change', () => {
    const stored = resolveVoice('en');
    vi.stubEnv('INTERVIEW_ENGINE_VOICE_EN', 'new-voice');
    expect(resolveSessionVoice(stored, 'en')).toBe(stored);
  });

  it('migrates former default voice-only overrides rather than mixing provider ids', () => {
    const taiwan = resolveVoice('zh-TW');
    const male = resolveVoice('zh', 'male');
    vi.stubEnv('INTERVIEW_ENGINE_VOICE_ZH_TW', retiredTaiwan.voiceId);
    vi.stubEnv('INTERVIEW_ENGINE_VOICE_ZH_MALE', retiredMale.voiceId);
    expect(resolveVoice('zh-TW')).toEqual(taiwan);
    expect(resolveVoice('zh', 'male')).toEqual(male);
    expect(resolveSessionVoice(retiredTaiwan, 'zh-TW')).toEqual(taiwan);
  });

  it('honors explicit per-locale model and voice overrides when refreshing a retired voice', () => {
    vi.stubEnv('INTERVIEW_ENGINE_TTS_MODEL', 'cartesia/sonic-3');
    vi.stubEnv('INTERVIEW_ENGINE_MODEL_ZH_MALE', 'inworld/inworld-tts-2');
    vi.stubEnv('INTERVIEW_ENGINE_VOICE_ZH_MALE', 'Edward');
    vi.stubEnv('INTERVIEW_ENGINE_TTS_PROVIDER', 'inworld');
    expect(resolveSessionVoice(retiredMale, 'zh', 'male')).toMatchObject({
      provider: 'inworld', model: 'inworld/inworld-tts-2', voiceId: 'Edward', languageCode: 'zh',
    });
  });

  it('preserves custom voice-only overrides and explicit retired model choices', () => {
    vi.stubEnv('INTERVIEW_ENGINE_VOICE_ZH_TW', 'custom-voice');
    expect(resolveVoice('zh-TW').voiceId).toBe('custom-voice');
    vi.stubEnv('INTERVIEW_ENGINE_VOICE_ZH_TW', retiredTaiwan.voiceId);
    vi.stubEnv('INTERVIEW_ENGINE_MODEL_ZH_TW', retiredTaiwan.model);
    expect(resolveVoice('zh-TW')).toMatchObject({ model: retiredTaiwan.model, voiceId: retiredTaiwan.voiceId });
  });
});
