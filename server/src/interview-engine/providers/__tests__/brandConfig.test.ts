// @vitest-environment node
//
// WP-63a: interview-engine config reads every per-brand setting through
// brandEnv — unprefixed for RoboApply (the Wave 0 names), CN_ for GoApply,
// never falling back from CN_X to X.
// Run: npx vitest run server/src/interview-engine/providers/__tests__/brandConfig.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getAgentCallbackSecret,
  getAgentCallbackSecrets,
  getBlueprintModel,
  getCallbackBaseUrl,
  getCnSpeechConfig,
  isGoApplySpeechModel,
  getInterviewAgentName,
  getInterviewLlmRouting,
  getInterviewMediaPolicy,
  getInterviewRetentionDays,
  getLiveKitCreds,
  getR2Creds,
  getVoiceProviderId,
  isLiveKitConfigured,
  isR2Configured,
  isRecordingEnabled,
  InterviewEngineConfigError,
} from '../../config.js';
import { runWithBrand } from '../../../lib/requestContext.js';

const PREFIXES = ['LIVEKIT_', 'CN_', 'S3_', 'AWS_', 'INTERVIEW_', 'LLM_', 'VOICE_PROVIDER', 'BACKEND_PUBLIC_URL', 'PUBLIC_BACKEND_URL'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (PREFIXES.some((p) => k.startsWith(p))) delete process.env[k];
  }
  process.env.LLM_SETTINGS_DB_DISABLED = 'true';
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const INTL_LK = { LIVEKIT_URL: 'wss://intl.livekit.test', LIVEKIT_API_KEY: 'intl-key', LIVEKIT_API_SECRET: 'intl-secret' };
const CN_LK = { CN_LIVEKIT_URL: 'wss://cn.livekit.test', CN_LIVEKIT_API_KEY: 'cn-key', CN_LIVEKIT_API_SECRET: 'cn-secret' };

describe('LiveKit credentials per brand', () => {
  it('RoboApply reads the unprefixed Wave 0 variables (also with no brand context)', () => {
    Object.assign(process.env, INTL_LK, CN_LK);
    expect(getLiveKitCreds()).toMatchObject({ url: 'wss://intl.livekit.test', apiKey: 'intl-key' });
    expect(getLiveKitCreds('roboapply').apiSecret).toBe('intl-secret');
  });

  it('GoApply reads CN_LIVEKIT_* — explicitly or from the brand of the unit of work', () => {
    Object.assign(process.env, INTL_LK, CN_LK);
    expect(getLiveKitCreds('goapply')).toMatchObject({ url: 'wss://cn.livekit.test', apiKey: 'cn-key', apiSecret: 'cn-secret' });
    expect(runWithBrand('goapply', () => getLiveKitCreds().apiKey)).toBe('cn-key');
  });

  it('never falls back from CN_LIVEKIT_* to LIVEKIT_*', () => {
    Object.assign(process.env, INTL_LK);
    expect(isLiveKitConfigured('roboapply')).toBe(true);
    expect(isLiveKitConfigured('goapply')).toBe(false);
    expect(() => getLiveKitCreds('goapply')).toThrow(/CN_LIVEKIT_URL/);
    expect(() => getLiveKitCreds('goapply')).toThrow(InterviewEngineConfigError);
  });
});

describe('agent names', () => {
  it("dispatch 'RoboApply-Interview' and 'GoApply-Interview' by default", () => {
    expect(getInterviewAgentName('roboapply')).toBe('RoboApply-Interview');
    expect(getInterviewAgentName()).toBe('RoboApply-Interview');
    expect(getInterviewAgentName('goapply')).toBe('GoApply-Interview');
  });

  it('take a per-brand override without crossing brands', () => {
    process.env.INTERVIEW_ENGINE_AGENT_NAME = 'Intl-Override';
    expect(getInterviewAgentName('roboapply')).toBe('Intl-Override');
    expect(getInterviewAgentName('goapply')).toBe('GoApply-Interview');
    process.env.CN_INTERVIEW_ENGINE_AGENT_NAME = 'CN-Override';
    expect(getInterviewAgentName('goapply')).toBe('CN-Override');
  });
});

describe('S3 for recordings and transcripts', () => {
  it('GoApply uses CN_S3_* only; RoboApply keeps S3_* and the AWS_* aliases', () => {
    Object.assign(process.env, { S3_BUCKET: 'intl', AWS_ACCESS_KEY_ID: 'ak', AWS_SECRET_ACCESS_KEY: 'sk' });
    expect(getR2Creds('roboapply')).toMatchObject({ bucket: 'intl', accessKeyId: 'ak', region: 'auto' });
    expect(getR2Creds('goapply')).toBeNull();
    Object.assign(process.env, { CN_S3_BUCKET: 'cn-bucket', CN_S3_ACCESS_KEY_ID: 'cak', CN_S3_SECRET_ACCESS_KEY: 'csk', CN_S3_REGION: 'cn-shanghai' });
    expect(getR2Creds('goapply')).toMatchObject({ bucket: 'cn-bucket', accessKeyId: 'cak', region: 'cn-shanghai' });
    expect(runWithBrand('goapply', () => getR2Creds()?.bucket)).toBe('cn-bucket');
  });

  it('GoApply storage stays off when CN_S3_BUCKET has the same name as S3_BUCKET (shared client cache)', () => {
    Object.assign(process.env, {
      S3_BUCKET: 'interviews', S3_ENDPOINT: 'https://r2.example', AWS_ACCESS_KEY_ID: 'ak', AWS_SECRET_ACCESS_KEY: 'sk',
      CN_S3_BUCKET: 'interviews', CN_S3_ENDPOINT: 'https://oss-cn-shanghai.example', CN_S3_ACCESS_KEY_ID: 'cak', CN_S3_SECRET_ACCESS_KEY: 'csk',
    });
    expect(getR2Creds('goapply')).toBeNull();
    expect(isR2Configured('goapply')).toBe(false);
    // RoboApply is unaffected.
    expect(getR2Creds('roboapply')).toMatchObject({ bucket: 'interviews', endpoint: 'https://r2.example' });
    process.env.CN_S3_BUCKET = 'interviews-cn';
    expect(getR2Creds('goapply')).toMatchObject({ bucket: 'interviews-cn', endpoint: 'https://oss-cn-shanghai.example' });
  });
});

describe('recording switch', () => {
  it('defaults off on both brands and is per brand', () => {
    expect(isRecordingEnabled('roboapply')).toBe(false);
    expect(isRecordingEnabled('goapply')).toBe(false);
    process.env.INTERVIEW_ENGINE_RECORDING_ENABLED = 'true';
    expect(isRecordingEnabled('roboapply')).toBe(true);
    expect(isRecordingEnabled('goapply')).toBe(false);
    process.env.CN_INTERVIEW_ENGINE_RECORDING_ENABLED = 'on';
    expect(isRecordingEnabled('goapply')).toBe(true);
  });
});

describe('media policy (CN L-11)', () => {
  it('GoApply: camera is a local preview only and recordings are audio-only', () => {
    expect(getInterviewMediaPolicy('goapply')).toEqual({ cameraPublish: false, recordVideo: false });
    expect(getInterviewMediaPolicy('roboapply')).toEqual({ cameraPublish: true, recordVideo: true });
  });
});

describe('retention window', () => {
  it('defaults to 90 days on both brands', () => {
    expect(getInterviewRetentionDays('roboapply')).toBe(90);
    expect(getInterviewRetentionDays('goapply')).toBe(90);
  });
  it('accepts a shorter window per brand, never a longer one than published', () => {
    process.env.INTERVIEW_RETENTION_DAYS = '30';
    process.env.CN_INTERVIEW_RETENTION_DAYS = '365';
    expect(getInterviewRetentionDays('roboapply')).toBe(30);
    expect(getInterviewRetentionDays('goapply')).toBe(90);
    process.env.INTERVIEW_RETENTION_DAYS = 'soon';
    expect(getInterviewRetentionDays('roboapply')).toBe(90);
    process.env.INTERVIEW_RETENTION_DAYS = '0';
    expect(getInterviewRetentionDays('roboapply')).toBe(90);
  });
});

describe('voice provider id', () => {
  it('defaults to livekit_cloud and reads VOICE_PROVIDER / CN_VOICE_PROVIDER', () => {
    expect(getVoiceProviderId('goapply')).toBe('livekit_cloud');
    process.env.CN_VOICE_PROVIDER = 'livekit_selfhosted';
    expect(getVoiceProviderId('goapply')).toBe('livekit_selfhosted');
    expect(getVoiceProviderId('roboapply')).toBe('livekit_cloud');
    process.env.VOICE_PROVIDER = 'trtc';
    expect(getVoiceProviderId('roboapply')).toBe('trtc');
    process.env.VOICE_PROVIDER = 'something-else';
    expect(getVoiceProviderId('roboapply')).toBe('livekit_cloud');
  });
});

describe('worker callbacks', () => {
  it('keeps one secret per brand and lists every configured one', () => {
    process.env.LIVEKIT_AGENT_CALLBACK_SECRET = 'intl-cb';
    expect(getAgentCallbackSecret('goapply')).toBeNull();
    process.env.CN_LIVEKIT_AGENT_CALLBACK_SECRET = 'cn-cb';
    expect(getAgentCallbackSecret('goapply')).toBe('cn-cb');
    expect(getAgentCallbackSecrets()).toEqual(['intl-cb', 'cn-cb']);
  });

  it('GoApply calls back to its own base URL, never the international aliases', () => {
    process.env.INTERVIEW_ENGINE_CALLBACK_BASE_URL = 'https://api.roboapply.io/';
    process.env.PORT = '4621';
    expect(getCallbackBaseUrl(null, 'roboapply')).toBe('https://api.roboapply.io');
    expect(getCallbackBaseUrl('https://goapply.top', 'goapply')).toBe('https://goapply.top');
    process.env.CN_INTERVIEW_ENGINE_CALLBACK_BASE_URL = 'https://api.goapply.top';
    expect(getCallbackBaseUrl('https://goapply.top', 'goapply')).toBe('https://api.goapply.top');
  });
});

describe('interview models per brand (R-13)', () => {
  it('RoboApply keeps the Wave 0 LiveKit Inference mapping', () => {
    process.env.LLM_INTERVIEW_MODEL = 'openai/gpt-5.4';
    expect(getInterviewLlmRouting('roboapply')).toMatchObject({ backendModel: 'openai/gpt-5.4', workerModel: 'openai/gpt-5.4' });
  });

  it('GoApply needs a domestic model of its own and never inherits the international one', () => {
    process.env.LLM_INTERVIEW_MODEL = 'openai/gpt-5.4';
    process.env.LLM_INTERVIEW_BLUEPRINT_MODEL = 'openai/gpt-5.4-mini';
    expect(() => getInterviewLlmRouting('goapply')).toThrow(/CN_LLM_INTERVIEW_MODEL/);
    process.env.CN_LLM_INTERVIEW_MODEL = 'deepseek/deepseek-v4-pro';
    expect(getInterviewLlmRouting('goapply')).toEqual({ backendModel: 'deepseek/deepseek-v4-pro', workerModel: 'deepseek/deepseek-v4-pro' });
    expect(getBlueprintModel('goapply')).toBe('deepseek/deepseek-v4-pro');
    expect(getBlueprintModel('roboapply')).toBe('openai/gpt-5.4-mini');
    process.env.CN_LLM_INTERVIEW_LIVE_MODEL = 'qwen/qwen-max';
    process.env.CN_LLM_INTERVIEW_LIVE_REASONING_EFFORT = 'low';
    expect(getInterviewLlmRouting('goapply')).toEqual({
      backendModel: 'deepseek/deepseek-v4-pro', workerModel: 'qwen/qwen-max', reasoningEffort: 'low',
    });
    process.env.CN_LLM_INTERVIEW_LIVE_MODEL = 'openai/gpt-5.4';
    expect(() => getInterviewLlmRouting('goapply')).toThrow(/not a domestic model/);
  });
});

describe('GoApply speech models (R-13, CN L-11)', () => {
  it('requires domestic STT and TTS of its own and never reads the international names', () => {
    process.env.INTERVIEW_ENGINE_STT_MODEL = 'deepgram/nova-3';
    process.env.INTERVIEW_ENGINE_TTS_MODEL = 'cartesia/sonic-3';
    expect(() => getCnSpeechConfig('goapply')).toThrow(InterviewEngineConfigError);
    process.env.CN_INTERVIEW_ENGINE_STT_MODEL = 'dashscope/paraformer-realtime-v2';
    process.env.CN_INTERVIEW_ENGINE_TTS_MODEL = 'dashscope/cosyvoice-v2';
    process.env.CN_INTERVIEW_ENGINE_TTS_VOICE = 'voice-f';
    expect(getCnSpeechConfig('goapply')).toEqual({
      sttModel: 'dashscope/paraformer-realtime-v2', sttFallbackModels: [], ttsModel: 'dashscope/cosyvoice-v2',
      voiceFemale: 'voice-f', voiceMale: null,
    });
    for (const bad of ['cartesia/sonic-3', 'elevenlabs/eleven_flash', 'deepgram/nova-3', 'cosyvoice-v2', 'openai/tts-1']) {
      process.env.CN_INTERVIEW_ENGINE_TTS_MODEL = bad;
      expect(() => getCnSpeechConfig('goapply')).toThrow(/not a domestic provider/);
    }
    process.env.CN_INTERVIEW_ENGINE_TTS_MODEL = 'dashscope/cosyvoice-v2';
    process.env.CN_INTERVIEW_ENGINE_STT_FALLBACK_MODELS = 'dashscope/paraformer-v1, deepgram/nova-2';
    expect(() => getCnSpeechConfig('goapply')).toThrow(/deepgram\/nova-2/);
  });

  it('recognises only dashscope/ ids as domestic speech', () => {
    expect(isGoApplySpeechModel('dashscope/cosyvoice-v2')).toBe(true);
    expect(isGoApplySpeechModel('DashScope/paraformer-realtime-v2')).toBe(true);
    expect(isGoApplySpeechModel('dashscope/')).toBe(false);
    expect(isGoApplySpeechModel('cartesia/sonic-3')).toBe(false);
    expect(isGoApplySpeechModel(null)).toBe(false);
  });
});
