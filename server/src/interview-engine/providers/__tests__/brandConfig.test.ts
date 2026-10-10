// @vitest-environment node
//
// D5 (GOAPPLY_PARITY_PLAN.md §3.1, §3.5): interview-engine config reads every
// per-brand setting as "an optional CN_ override, else the shared value".
// RoboApply reads the unprefixed Wave 0 names. GoApply reads its own LiveKit
// plane wholly from CN_LIVEKIT_* when CN_LIVEKIT_URL is set and wholly from the
// shared names otherwise (never a mix); the same for speech (both CN models)
// and storage (CN_S3_BUCKET). A session can be pinned to the plane it was
// created on.
// Run: npx vitest run server/src/interview-engine/providers/__tests__/brandConfig.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetInterviewStoreNoteForTest,
  __resetVoiceConfigWarningsForTest,
  configuredLiveKitPlanes,
  getAgentCallbackSecret,
  getAgentCallbackSecrets,
  getBlueprintModel,
  getCallbackBaseUrl,
  getCnSpeechConfig,
  getEarlierR2Creds,
  isGoApplySpeechModel,
  getInterviewAgentName,
  getInterviewLlmRouting,
  getInterviewMediaPolicy,
  getInterviewRetentionDays,
  getLiveKitCreds,
  getR2Creds,
  getR2WriteCreds,
  getVoiceProviderId,
  getWorkerLlmModel,
  interviewStorageWriteBlocked,
  isLiveKitConfigured,
  isR2Configured,
  isRecordingEnabled,
  InterviewEngineConfigError,
  runOnVoiceStack,
  tryGetCnSpeechConfig,
  voiceConfigProblems,
  voiceRoutingProblem,
  voiceStack,
  warnVoiceConfigProblemsOnce,
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
  __resetInterviewStoreNoteForTest();
  __resetVoiceConfigWarningsForTest();
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
    expect(voiceStack('roboapply')).toBe('shared');
  });

  it('GoApply reads CN_LIVEKIT_* when it has its own plane — explicitly or from the brand of the unit of work', () => {
    Object.assign(process.env, INTL_LK, CN_LK);
    expect(voiceStack('goapply')).toBe('own');
    expect(getLiveKitCreds('goapply')).toMatchObject({ url: 'wss://cn.livekit.test', apiKey: 'cn-key', apiSecret: 'cn-secret' });
    expect(runWithBrand('goapply', () => getLiveKitCreds().apiKey)).toBe('cn-key');
  });

  it('GoApply with only LIVEKIT_* set runs on the shared plane with the shared credentials (G7, G50)', () => {
    Object.assign(process.env, INTL_LK);
    expect(voiceStack('goapply')).toBe('shared');
    expect(isLiveKitConfigured('roboapply')).toBe(true);
    expect(isLiveKitConfigured('goapply')).toBe(true);
    expect(getLiveKitCreds('goapply')).toMatchObject({ url: 'wss://intl.livekit.test', apiKey: 'intl-key', apiSecret: 'intl-secret' });
    expect(runWithBrand('goapply', () => getLiveKitCreds().apiKey)).toBe('intl-key');
  });

  it('an own plane with a missing member is not configured: the shared key is never mixed in', () => {
    Object.assign(process.env, INTL_LK, { CN_LIVEKIT_URL: 'wss://cn.livekit.test' });
    expect(voiceStack('goapply')).toBe('own');
    expect(isLiveKitConfigured('goapply')).toBe(false);
    expect(() => getLiveKitCreds('goapply')).toThrow(InterviewEngineConfigError);
    // The error names the variables of the plane in use, and only the missing ones.
    expect(() => getLiveKitCreds('goapply')).toThrow(/CN_LIVEKIT_API_KEY, CN_LIVEKIT_API_SECRET/);
    expect(() => getLiveKitCreds('goapply')).toThrow(/never mixed in/);
    process.env.CN_LIVEKIT_API_KEY = 'cn-key';
    expect(isLiveKitConfigured('goapply')).toBe(false);
    expect(() => getLiveKitCreds('goapply')).toThrow(/Set CN_LIVEKIT_API_SECRET;/);
    // RoboApply is untouched by a half-set GoApply plane.
    expect(getLiveKitCreds('roboapply').apiKey).toBe('intl-key');
  });

  it('with no LiveKit at all the GoApply error names the shared variables first', () => {
    expect(isLiveKitConfigured('goapply')).toBe(false);
    expect(() => getLiveKitCreds('goapply')).toThrow(/set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET/);
    expect(() => getLiveKitCreds('roboapply')).toThrow('LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.');
  });

  it('a pinned plane holds while the environment changes (a live session never moves)', () => {
    Object.assign(process.env, INTL_LK);
    const onShared = <T>(fn: () => T) => runOnVoiceStack('goapply', 'shared', fn);
    const onOwn = <T>(fn: () => T) => runOnVoiceStack('goapply', 'own', fn);
    // CN_LIVEKIT_* arrives while a session created on the shared plane is live.
    Object.assign(process.env, CN_LK, { CN_LIVEKIT_AGENT_CALLBACK_SECRET: 'cn-cb', LIVEKIT_AGENT_CALLBACK_SECRET: 'intl-cb' });
    expect(getLiveKitCreds('goapply').apiKey).toBe('cn-key');
    expect(onShared(() => getLiveKitCreds('goapply').apiKey)).toBe('intl-key');
    expect(onShared(() => runWithBrand('goapply', () => getLiveKitCreds().apiKey))).toBe('intl-key');
    expect(onShared(() => getInterviewAgentName('goapply'))).toBe('RoboApply-Interview');
    expect(onShared(() => getAgentCallbackSecret('goapply'))).toBe('intl-cb');
    expect(onShared(() => voiceStack('goapply'))).toBe('shared');
    // The explicit argument wins over the pin; the pin is per brand.
    expect(onShared(() => getLiveKitCreds('goapply', 'own').apiKey)).toBe('cn-key');
    expect(onOwn(() => getLiveKitCreds('roboapply').apiKey)).toBe('intl-key');
    // CN_LIVEKIT_* is removed while a session created on the own plane is live:
    // it is not configured any more, and never falls to the shared keys.
    for (const k of Object.keys(CN_LK)) delete process.env[k];
    expect(getLiveKitCreds('goapply').apiKey).toBe('intl-key');
    expect(onOwn(() => isLiveKitConfigured('goapply'))).toBe(false);
    expect(() => onOwn(() => getLiveKitCreds('goapply'))).toThrow(/CN_LIVEKIT_URL/);
  });
});

describe('agent names', () => {
  it("on the shared plane both brands dispatch the name the shared worker registers ('RoboApply-Interview')", () => {
    Object.assign(process.env, INTL_LK);
    expect(getInterviewAgentName('roboapply')).toBe('RoboApply-Interview');
    expect(getInterviewAgentName()).toBe('RoboApply-Interview');
    // 'GoApply-Interview' is registered by nobody on the shared project (G51).
    expect(getInterviewAgentName('goapply')).toBe('RoboApply-Interview');
    // The clone dev stack registers another name: both brands follow it.
    process.env.INTERVIEW_ENGINE_AGENT_NAME = 'RoboApply-Interview-Clone';
    expect(getInterviewAgentName('roboapply')).toBe('RoboApply-Interview-Clone');
    expect(getInterviewAgentName('goapply')).toBe('RoboApply-Interview-Clone');
    // A stray CN name without CN_LIVEKIT_URL starts no plane and is not read.
    process.env.CN_INTERVIEW_ENGINE_AGENT_NAME = 'CN-Override';
    expect(getInterviewAgentName('goapply')).toBe('RoboApply-Interview-Clone');
  });

  it("'GoApply-Interview' is dispatched only on GoApply's own plane, which takes its own override", () => {
    Object.assign(process.env, INTL_LK, CN_LK, { INTERVIEW_ENGINE_AGENT_NAME: 'Intl-Override' });
    expect(getInterviewAgentName('roboapply')).toBe('Intl-Override');
    expect(getInterviewAgentName('goapply')).toBe('GoApply-Interview');
    process.env.CN_INTERVIEW_ENGINE_AGENT_NAME = 'CN-Override';
    expect(getInterviewAgentName('goapply')).toBe('CN-Override');
    expect(getInterviewAgentName('roboapply')).toBe('Intl-Override');
    // A session pinned to the shared plane keeps the shared worker's name.
    expect(getInterviewAgentName('goapply', 'shared')).toBe('Intl-Override');
  });
});

describe('S3 for recordings and transcripts', () => {
  it('GoApply with only S3_* set uses the shared bucket; with CN_S3_BUCKET and its keys, that bucket (G55)', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    Object.assign(process.env, { S3_BUCKET: 'intl', AWS_ACCESS_KEY_ID: 'ak', AWS_SECRET_ACCESS_KEY: 'sk' });
    expect(getR2Creds('roboapply')).toMatchObject({ bucket: 'intl', accessKeyId: 'ak', region: 'auto' });
    expect(getR2Creds('goapply')).toMatchObject({ bucket: 'intl', accessKeyId: 'ak', region: 'auto' });
    expect(isR2Configured('goapply')).toBe(true);
    expect(getEarlierR2Creds('goapply')).toEqual([]);
    Object.assign(process.env, { CN_S3_BUCKET: 'cn-bucket', CN_S3_ACCESS_KEY_ID: 'cak', CN_S3_SECRET_ACCESS_KEY: 'csk', CN_S3_REGION: 'cn-shanghai' });
    expect(getR2Creds('goapply')).toMatchObject({ bucket: 'cn-bucket', accessKeyId: 'cak', region: 'cn-shanghai' });
    expect(runWithBrand('goapply', () => getR2Creds()?.bucket)).toBe('cn-bucket');
    expect(getR2Creds('roboapply')).toMatchObject({ bucket: 'intl', accessKeyId: 'ak' });
    // Which store GoApply uses is said once per store, with variable names only.
    getR2Creds('goapply');
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/GoApply .* use the shared bucket \(S3_BUCKET\)/);
    expect(lines[1]).toMatch(/GoApply .* use its own bucket \(CN_S3_BUCKET\)/);
    expect(lines.join(' ')).not.toMatch(/cn-bucket|intl\b|cak|csk/);
    info.mockRestore();
  });

  it('an own bucket with a missing key is not configured: the shared keys (and the AWS_ aliases) are never mixed in', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    Object.assign(process.env, { S3_BUCKET: 'intl', S3_ACCESS_KEY_ID: 'ak', S3_SECRET_ACCESS_KEY: 'sk', AWS_ACCESS_KEY_ID: 'aws-ak', AWS_SECRET_ACCESS_KEY: 'aws-sk', CN_S3_BUCKET: 'cn-bucket' });
    expect(getR2Creds('goapply')).toBeNull();
    expect(isR2Configured('goapply')).toBe(false);
    expect(isR2Configured('roboapply')).toBe(true);
    vi.restoreAllMocks();
  });

  it('sharing one bucket is the fallback, not an error: the same bucket named in CN_S3_BUCKET is accepted too', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    Object.assign(process.env, {
      S3_BUCKET: 'interviews', S3_ENDPOINT: 'https://r2.example', AWS_ACCESS_KEY_ID: 'ak', AWS_SECRET_ACCESS_KEY: 'sk',
      CN_S3_BUCKET: 'interviews', CN_S3_ENDPOINT: 'https://R2.example/', CN_S3_ACCESS_KEY_ID: 'cak', CN_S3_SECRET_ACCESS_KEY: 'csk',
    });
    expect(getR2Creds('goapply')).toMatchObject({ bucket: 'interviews', endpoint: 'https://R2.example/', accessKeyId: 'cak' });
    expect(isR2Configured('goapply')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(getR2Creds('roboapply')).toMatchObject({ bucket: 'interviews', endpoint: 'https://r2.example' });
    vi.restoreAllMocks();
  });

  it('the same bucket name on a different endpoint is a different store (INT-09, R8)', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    Object.assign(process.env, {
      S3_BUCKET: 'interviews', S3_ENDPOINT: 'https://r2.example', AWS_ACCESS_KEY_ID: 'ak', AWS_SECRET_ACCESS_KEY: 'sk',
      CN_S3_BUCKET: 'interviews', CN_S3_ENDPOINT: 'https://oss-cn-shanghai.example', CN_S3_ACCESS_KEY_ID: 'cak', CN_S3_SECRET_ACCESS_KEY: 'csk',
    });
    expect(getR2Creds('goapply')).toMatchObject({ bucket: 'interviews', endpoint: 'https://oss-cn-shanghai.example', accessKeyId: 'cak' });
    expect(getR2Creds('roboapply')).toMatchObject({ bucket: 'interviews', endpoint: 'https://r2.example', accessKeyId: 'ak' });
    vi.restoreAllMocks();
  });

  it('once GoApply has its own bucket, the shared one is still named for cleaning up its earlier sessions', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    Object.assign(process.env, {
      S3_BUCKET: 'intl', S3_ACCESS_KEY_ID: 'ak', S3_SECRET_ACCESS_KEY: 'sk',
      CN_S3_BUCKET: 'cn-bucket', CN_S3_ACCESS_KEY_ID: 'cak', CN_S3_SECRET_ACCESS_KEY: 'csk',
    });
    expect(getEarlierR2Creds('goapply')).toEqual([expect.objectContaining({ bucket: 'intl', accessKeyId: 'ak' })]);
    expect(getEarlierR2Creds('roboapply')).toEqual([]);
    delete process.env.S3_BUCKET;
    expect(getEarlierR2Creds('goapply')).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe('CN_RESIDENCY_STRICT: mainland storage required (plan §4)', () => {
  const SHARED = { S3_BUCKET: 'intl', S3_ACCESS_KEY_ID: 'ak', S3_SECRET_ACCESS_KEY: 'sk' };
  const OWN = { CN_S3_BUCKET: 'cn-bucket', CN_S3_ACCESS_KEY_ID: 'cak', CN_S3_SECRET_ACCESS_KEY: 'csk' };

  it('off (the default): new artifacts go where they are read from, on both brands', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    Object.assign(process.env, SHARED);
    expect(interviewStorageWriteBlocked('goapply')).toBe(false);
    expect(getR2WriteCreds('goapply')).toEqual(getR2Creds('goapply'));
    expect(getR2WriteCreds('goapply')).toMatchObject({ bucket: 'intl' });
    expect(getR2WriteCreds('roboapply')).toMatchObject({ bucket: 'intl' });
    // The LLM wall alone is not the storage rule.
    process.env.CN_LLM_DOMESTIC_ONLY = 'true';
    expect(getR2WriteCreds('goapply')).toMatchObject({ bucket: 'intl' });
    vi.restoreAllMocks();
  });

  it('on, without a bucket of its own: GoApply writes nothing new; earlier objects stay readable and deletable; RoboApply is untouched', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    Object.assign(process.env, SHARED, { CN_RESIDENCY_STRICT: 'true' });
    expect(interviewStorageWriteBlocked('goapply')).toBe(true);
    expect(getR2WriteCreds('goapply')).toBeNull();
    expect(runWithBrand('goapply', () => getR2WriteCreds())).toBeNull();
    // Reads and deletes of what earlier sessions stored are not blocked.
    expect(getR2Creds('goapply')).toMatchObject({ bucket: 'intl' });
    expect(isR2Configured('goapply')).toBe(true);
    expect(interviewStorageWriteBlocked('roboapply')).toBe(false);
    expect(getR2WriteCreds('roboapply')).toMatchObject({ bucket: 'intl' });
    // It is said, with variable names only.
    expect(voiceConfigProblems('goapply')).toContainEqual({
      kind: 'storage',
      message: 'CN_RESIDENCY_STRICT is on and GoApply has no bucket of its own (CN_S3_BUCKET and its keys): practice recordings and transcript files are not stored.',
    });
    vi.restoreAllMocks();
  });

  it('on, with a bucket of its own: new artifacts go there', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    Object.assign(process.env, SHARED, OWN, { CN_RESIDENCY_STRICT: 'true' });
    expect(interviewStorageWriteBlocked('goapply')).toBe(false);
    expect(getR2WriteCreds('goapply')).toMatchObject({ bucket: 'cn-bucket', accessKeyId: 'cak' });
    expect(voiceConfigProblems('goapply').filter((p) => p.kind === 'storage')).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe('recording switch', () => {
  it('defaults off on both brands; GoApply follows the shared switch unless its own is set (per key)', () => {
    expect(isRecordingEnabled('roboapply')).toBe(false);
    expect(isRecordingEnabled('goapply')).toBe(false);
    process.env.INTERVIEW_ENGINE_RECORDING_ENABLED = 'true';
    expect(isRecordingEnabled('roboapply')).toBe(true);
    expect(isRecordingEnabled('goapply')).toBe(true);
    process.env.CN_INTERVIEW_ENGINE_RECORDING_ENABLED = 'false';
    expect(isRecordingEnabled('goapply')).toBe(false);
    expect(isRecordingEnabled('roboapply')).toBe(true);
    process.env.INTERVIEW_ENGINE_RECORDING_ENABLED = 'false';
    process.env.CN_INTERVIEW_ENGINE_RECORDING_ENABLED = 'on';
    expect(isRecordingEnabled('goapply')).toBe(true);
    expect(isRecordingEnabled('roboapply')).toBe(false);
  });
});

describe('media policy (D5: the same on both brands)', () => {
  it('both brands publish the camera and may record video by default', () => {
    expect(getInterviewMediaPolicy('roboapply')).toEqual({ cameraPublish: true, recordVideo: true });
    expect(getInterviewMediaPolicy('goapply')).toEqual({ cameraPublish: true, recordVideo: true });
    expect(runWithBrand('goapply', () => getInterviewMediaPolicy())).toEqual({ cameraPublish: true, recordVideo: true });
  });

  it('CN_INTERVIEW_CAMERA_PUBLISH set to a false value restores local preview and audio only, on GoApply alone', () => {
    for (const off of ['false', '0', 'no', 'off', 'FALSE']) {
      process.env.CN_INTERVIEW_CAMERA_PUBLISH = off;
      expect(getInterviewMediaPolicy('goapply'), off).toEqual({ cameraPublish: false, recordVideo: false });
      expect(getInterviewMediaPolicy('roboapply'), off).toEqual({ cameraPublish: true, recordVideo: true });
    }
    for (const on of ['true', '1', 'yes', 'on', '']) {
      process.env.CN_INTERVIEW_CAMERA_PUBLISH = on;
      expect(getInterviewMediaPolicy('goapply'), on).toEqual({ cameraPublish: true, recordVideo: true });
    }
    // The unprefixed twin is not a switch for either brand.
    delete process.env.CN_INTERVIEW_CAMERA_PUBLISH;
    process.env.INTERVIEW_CAMERA_PUBLISH = 'false';
    expect(getInterviewMediaPolicy('goapply')).toEqual({ cameraPublish: true, recordVideo: true });
    expect(getInterviewMediaPolicy('roboapply')).toEqual({ cameraPublish: true, recordVideo: true });
  });
});

describe('retention window', () => {
  it('defaults to 90 days on both brands', () => {
    expect(getInterviewRetentionDays('roboapply')).toBe(90);
    expect(getInterviewRetentionDays('goapply')).toBe(90);
  });
  it('accepts a shorter window, never a longer one than published; GoApply takes its own value first', () => {
    process.env.INTERVIEW_RETENTION_DAYS = '30';
    process.env.CN_INTERVIEW_RETENTION_DAYS = '365';
    expect(getInterviewRetentionDays('roboapply')).toBe(30);
    expect(getInterviewRetentionDays('goapply')).toBe(90);
    delete process.env.CN_INTERVIEW_RETENTION_DAYS;
    expect(getInterviewRetentionDays('goapply')).toBe(30);
    process.env.INTERVIEW_RETENTION_DAYS = 'soon';
    expect(getInterviewRetentionDays('roboapply')).toBe(90);
    process.env.INTERVIEW_RETENTION_DAYS = '0';
    expect(getInterviewRetentionDays('roboapply')).toBe(90);
  });
});

describe('voice provider id', () => {
  it('defaults to livekit_cloud; GoApply follows VOICE_PROVIDER on the shared plane', () => {
    expect(getVoiceProviderId('goapply')).toBe('livekit_cloud');
    expect(getVoiceProviderId('roboapply')).toBe('livekit_cloud');
    process.env.VOICE_PROVIDER = 'livekit_selfhosted';
    expect(getVoiceProviderId('roboapply')).toBe('livekit_selfhosted');
    expect(getVoiceProviderId('goapply')).toBe('livekit_selfhosted');
    process.env.VOICE_PROVIDER = 'trtc';
    expect(getVoiceProviderId('roboapply')).toBe('trtc');
    process.env.VOICE_PROVIDER = 'something-else';
    expect(getVoiceProviderId('roboapply')).toBe('livekit_cloud');
  });

  it('CN_VOICE_PROVIDER is read only together with CN_LIVEKIT_URL', () => {
    process.env.CN_VOICE_PROVIDER = 'livekit_selfhosted';
    // No own plane: the value is not read (and voiceConfigProblems names it).
    expect(getVoiceProviderId('goapply')).toBe('livekit_cloud');
    Object.assign(process.env, CN_LK);
    expect(getVoiceProviderId('goapply')).toBe('livekit_selfhosted');
    expect(getVoiceProviderId('roboapply')).toBe('livekit_cloud');
    // On its own plane RoboApply's setting does not leak in.
    delete process.env.CN_VOICE_PROVIDER;
    process.env.VOICE_PROVIDER = 'volcano';
    expect(getVoiceProviderId('goapply')).toBe('livekit_cloud');
  });
});

describe('worker callbacks', () => {
  it('one secret per plane: both brands use the shared worker’s secret on the shared plane (G58)', () => {
    process.env.LIVEKIT_AGENT_CALLBACK_SECRET = 'intl-cb';
    expect(getAgentCallbackSecret('roboapply')).toBe('intl-cb');
    expect(getAgentCallbackSecret('goapply')).toBe('intl-cb');
    // De-duplicated: two brands on one plane share one secret.
    expect(getAgentCallbackSecrets()).toEqual(['intl-cb']);
    // A CN secret without CN_LIVEKIT_URL starts no plane: it is not read and not accepted.
    process.env.CN_LIVEKIT_AGENT_CALLBACK_SECRET = 'cn-cb';
    expect(getAgentCallbackSecret('goapply')).toBe('intl-cb');
    expect(getAgentCallbackSecrets()).toEqual(['intl-cb']);
  });

  it('GoApply’s own plane has its own secret; the shared one stays listed for sessions pinned to the shared plane', () => {
    Object.assign(process.env, CN_LK, { LIVEKIT_AGENT_CALLBACK_SECRET: 'intl-cb' });
    // Its own plane without its own secret: none (never the shared secret).
    expect(getAgentCallbackSecret('goapply')).toBeNull();
    process.env.CN_LIVEKIT_AGENT_CALLBACK_SECRET = 'cn-cb';
    expect(getAgentCallbackSecret('goapply')).toBe('cn-cb');
    expect(getAgentCallbackSecret('goapply', 'shared')).toBe('intl-cb');
    expect(getAgentCallbackSecret('roboapply')).toBe('intl-cb');
    expect(getAgentCallbackSecrets()).toEqual(['intl-cb', 'cn-cb']);
    // The same value on both planes is listed once.
    process.env.CN_LIVEKIT_AGENT_CALLBACK_SECRET = 'intl-cb';
    expect(getAgentCallbackSecrets()).toEqual(['intl-cb']);
  });

  it('on the shared plane GoApply calls back where the shared worker calls back (explicit URL, else the aliases)', () => {
    process.env.PORT = '4621';
    expect(getCallbackBaseUrl(null, 'goapply')).toBe('http://localhost:4621');
    expect(getCallbackBaseUrl('https://goapply.top', 'goapply')).toBe('https://goapply.top');
    process.env.PUBLIC_BACKEND_URL = 'https://public.example/';
    expect(getCallbackBaseUrl('https://goapply.top', 'goapply')).toBe('https://public.example');
    process.env.BACKEND_PUBLIC_URL = 'https://backend.example';
    expect(getCallbackBaseUrl(null, 'goapply')).toBe('https://backend.example');
    process.env.INTERVIEW_ENGINE_CALLBACK_BASE_URL = 'https://api.roboapply.io/';
    expect(getCallbackBaseUrl(null, 'roboapply')).toBe('https://api.roboapply.io');
    expect(getCallbackBaseUrl('https://goapply.top', 'goapply')).toBe('https://api.roboapply.io');
    // A stray CN base URL without CN_LIVEKIT_URL is not read.
    process.env.CN_INTERVIEW_ENGINE_CALLBACK_BASE_URL = 'https://api.goapply.top';
    expect(getCallbackBaseUrl('https://goapply.top', 'goapply')).toBe('https://api.roboapply.io');
  });

  it('on its own plane GoApply calls back to its own base URL, never the shared aliases', () => {
    Object.assign(process.env, CN_LK, { INTERVIEW_ENGINE_CALLBACK_BASE_URL: 'https://api.roboapply.io/', BACKEND_PUBLIC_URL: 'https://backend.example', PORT: '4621' });
    expect(getCallbackBaseUrl('https://goapply.top', 'goapply')).toBe('https://goapply.top');
    expect(getCallbackBaseUrl(null, 'goapply')).toBe('http://localhost:4621');
    process.env.CN_INTERVIEW_ENGINE_CALLBACK_BASE_URL = 'https://api.goapply.top';
    expect(getCallbackBaseUrl('https://goapply.top', 'goapply')).toBe('https://api.goapply.top');
    expect(getCallbackBaseUrl(null, 'roboapply')).toBe('https://api.roboapply.io');
    // A session pinned to the shared plane keeps the shared base URL.
    expect(getCallbackBaseUrl('https://goapply.top', 'goapply', 'shared')).toBe('https://api.roboapply.io');
  });
});

describe('LiveKit projects a webhook may be signed by', () => {
  it('one shared project serves both brands; an own GoApply project is listed beside it', () => {
    expect(configuredLiveKitPlanes()).toEqual([]);
    Object.assign(process.env, INTL_LK);
    expect(configuredLiveKitPlanes()).toEqual([{ apiKey: 'intl-key', apiSecret: 'intl-secret', brands: ['roboapply', 'goapply'] }]);
    Object.assign(process.env, CN_LK);
    expect(configuredLiveKitPlanes()).toEqual([
      // Still listed: sessions pinned to the shared plane are signed by it.
      { apiKey: 'intl-key', apiSecret: 'intl-secret', brands: ['roboapply'] },
      { apiKey: 'cn-key', apiSecret: 'cn-secret', brands: ['goapply'] },
    ]);
    // A half-set own plane is not a project.
    delete process.env.CN_LIVEKIT_API_SECRET;
    expect(configuredLiveKitPlanes()).toEqual([{ apiKey: 'intl-key', apiSecret: 'intl-secret', brands: ['roboapply'] }]);
  });
});

describe('interview models per brand (D5: the shared routing unless GoApply runs its own worker)', () => {
  it('RoboApply keeps the Wave 0 LiveKit Inference mapping', () => {
    process.env.LLM_INTERVIEW_MODEL = 'openai/gpt-5.4';
    expect(getInterviewLlmRouting('roboapply')).toMatchObject({ backendModel: 'openai/gpt-5.4', workerModel: 'openai/gpt-5.4' });
  });

  it('GoApply with only the shared models gets RoboApply’s routing, allowlist included (G54)', () => {
    Object.assign(process.env, INTL_LK, { LLM_INTERVIEW_MODEL: 'openai/gpt-5.4', LLM_INTERVIEW_BLUEPRINT_MODEL: 'openai/gpt-5.4-mini' });
    expect(getInterviewLlmRouting('goapply')).toEqual(getInterviewLlmRouting('roboapply'));
    expect(getInterviewLlmRouting('goapply')).toEqual({ backendModel: 'openai/gpt-5.4', workerModel: 'openai/gpt-5.4', reasoningEffort: 'low' });
    expect(getBlueprintModel('goapply')).toBe('openai/gpt-5.4-mini');
    expect(getBlueprintModel('roboapply')).toBe('openai/gpt-5.4-mini');
    process.env.LLM_INTERVIEW_LIVE_MODEL = 'openai/gpt-4.1-mini';
    expect(getInterviewLlmRouting('goapply')).toEqual({ backendModel: 'openai/gpt-5.4', workerModel: 'openai/gpt-4.1-mini', reasoningEffort: undefined });
    // The same allowlist as RoboApply.
    process.env.LLM_INTERVIEW_LIVE_MODEL = 'anthropic/claude-x';
    expect(() => getInterviewLlmRouting('goapply')).toThrow(/LLM_INTERVIEW_LIVE_MODEL="anthropic\/claude-x" has no supported equivalent in LiveKit Inference/);
    delete process.env.LLM_INTERVIEW_LIVE_MODEL;
    delete process.env.LLM_INTERVIEW_MODEL;
    expect(() => getInterviewLlmRouting('goapply')).toThrow(/Set LLM_INTERVIEW_MODEL/);
  });

  it('per key: a CN interview setting overrides the shared one; on the shared plane it is still a LiveKit Inference model', () => {
    Object.assign(process.env, INTL_LK, { LLM_INTERVIEW_MODEL: 'openai/gpt-5.4', LLM_INTERVIEW_BLUEPRINT_MODEL: 'openai/gpt-5.4-mini' });
    process.env.CN_LLM_INTERVIEW_BLUEPRINT_MODEL = 'deepseek/deepseek-v4-pro';
    expect(getBlueprintModel('goapply')).toBe('deepseek/deepseek-v4-pro');
    expect(getBlueprintModel('roboapply')).toBe('openai/gpt-5.4-mini');
    // The shared (gateway) worker never gets a raw domestic id: a CN model with
    // a LiveKit Inference equivalent is mapped into its namespace.
    process.env.CN_LLM_INTERVIEW_MODEL = 'deepseek/deepseek-v4-pro';
    expect(getInterviewLlmRouting('goapply')).toEqual({ backendModel: 'deepseek/deepseek-v4-pro', workerModel: 'deepseek-ai/deepseek-v4-pro', reasoningEffort: undefined });
    expect(getInterviewLlmRouting('roboapply')).toMatchObject({ backendModel: 'openai/gpt-5.4', workerModel: 'openai/gpt-5.4' });
    process.env.CN_LLM_INTERVIEW_LIVE_MODEL = 'openai/gpt-5.4-mini';
    process.env.CN_LLM_INTERVIEW_LIVE_REASONING_EFFORT = 'medium';
    expect(getInterviewLlmRouting('goapply')).toEqual({ backendModel: 'deepseek/deepseek-v4-pro', workerModel: 'openai/gpt-5.4-mini', reasoningEffort: 'medium' });
  });

  it('a CN interview model with no LiveKit Inference equivalent never turns voice off on the shared plane: it plans and scores, the shared model runs the live turns', () => {
    Object.assign(process.env, INTL_LK, { LLM_INTERVIEW_MODEL: 'openai/gpt-5.5', CN_LLM_INTERVIEW_MODEL: 'qwen/qwen-max' });
    expect(voiceStack('goapply')).toBe('shared');
    // (The backend selector is GoApply's own model; the model resolver may spell
    // its route out, e.g. dashscope/qwen-max, so only the model is pinned here.)
    const routing = getInterviewLlmRouting('goapply');
    expect(routing.backendModel).toMatch(/^(qwen|dashscope)\/qwen-max$/);
    expect(routing).toMatchObject({ workerModel: 'openai/gpt-5.5', reasoningEffort: 'low' });
    expect(getWorkerLlmModel('goapply')).toBe('openai/gpt-5.5');
    expect(voiceRoutingProblem('goapply')).toBeNull();
    // Every domestic family without an equivalent behaves the same.
    for (const model of ['kimi/kimi-k3', 'glm/glm-5', 'doubao/doubao-pro', 'minimax/abab-7', 'deepseek/deepseek-v4-flash']) {
      process.env.CN_LLM_INTERVIEW_MODEL = model;
      expect(getInterviewLlmRouting('goapply'), model).toMatchObject({ backendModel: model, workerModel: 'openai/gpt-5.5' });
    }
    // The shared live model, when set, is what the shared worker runs.
    process.env.LLM_INTERVIEW_LIVE_MODEL = 'openai/gpt-4.1-mini';
    expect(getInterviewLlmRouting('goapply')).toMatchObject({ backendModel: 'deepseek/deepseek-v4-flash', workerModel: 'openai/gpt-4.1-mini' });
    delete process.env.LLM_INTERVIEW_LIVE_MODEL;
    // A CN LIVE model with no equivalent is passed over too, and its effort with it:
    // the shared model runs with the shared effort (never an effort written for another model).
    process.env.CN_LLM_INTERVIEW_MODEL = 'deepseek/deepseek-v4-pro';
    process.env.CN_LLM_INTERVIEW_LIVE_MODEL = 'qwen/qwen-max';
    process.env.CN_LLM_INTERVIEW_LIVE_REASONING_EFFORT = 'high';
    expect(getInterviewLlmRouting('goapply')).toEqual({ backendModel: 'deepseek/deepseek-v4-pro', workerModel: 'deepseek-ai/deepseek-v4-pro', reasoningEffort: undefined });
    process.env.CN_LLM_INTERVIEW_MODEL = 'glm/glm-5';
    expect(getInterviewLlmRouting('goapply')).toEqual({ backendModel: 'glm/glm-5', workerModel: 'openai/gpt-5.5', reasoningEffort: 'low' });
    process.env.LLM_INTERVIEW_LIVE_REASONING_EFFORT = 'minimal';
    expect(getInterviewLlmRouting('goapply').reasoningEffort).toBe('minimal');
    // RoboApply never reads any of it.
    expect(getInterviewLlmRouting('roboapply')).toEqual({ backendModel: 'openai/gpt-5.5', workerModel: 'openai/gpt-5.5', reasoningEffort: 'minimal' });
  });

  it('a SHARED selector with no equivalent is still an error for both brands, and so is a CN model with no shared model left to run on', () => {
    Object.assign(process.env, INTL_LK, { LLM_INTERVIEW_MODEL: 'anthropic/claude-x', CN_LLM_INTERVIEW_MODEL: 'qwen/qwen-max' });
    expect(() => getInterviewLlmRouting('goapply')).toThrow(/^LLM_INTERVIEW_MODEL="anthropic\/claude-x" has no supported equivalent in LiveKit Inference/);
    expect(() => getInterviewLlmRouting('roboapply')).toThrow(/^LLM_INTERVIEW_MODEL="anthropic\/claude-x" has no supported equivalent/);
    expect(voiceRoutingProblem('goapply')).toMatch(/LLM_INTERVIEW_MODEL="anthropic\/claude-x"/);
    delete process.env.LLM_INTERVIEW_MODEL;
    expect(() => getInterviewLlmRouting('goapply')).toThrow(/^CN_LLM_INTERVIEW_MODEL="qwen\/qwen-max" has no supported equivalent in LiveKit Inference/);
    delete process.env.CN_LLM_INTERVIEW_MODEL;
    expect(() => getWorkerLlmModel('goapply')).toThrow(/Set LLM_INTERVIEW_MODEL \(or LLM_INTERVIEW_LIVE_MODEL for the live worker\)/);
  });

  it('on its own plane with a CN interview model, GoApply’s worker gets the domestic model as-is', () => {
    Object.assign(process.env, INTL_LK, CN_LK, { LLM_INTERVIEW_MODEL: 'openai/gpt-5.4', LLM_INTERVIEW_LIVE_MODEL: 'openai/gpt-4.1-mini', LLM_INTERVIEW_LIVE_REASONING_EFFORT: 'high' });
    // No CN interview model: a gateway worker on GoApply's own project, RoboApply's routing.
    expect(getInterviewLlmRouting('goapply')).toEqual({ backendModel: 'openai/gpt-5.4', workerModel: 'openai/gpt-4.1-mini', reasoningEffort: 'high' });
    process.env.CN_LLM_INTERVIEW_MODEL = 'deepseek/deepseek-v4-pro';
    // The shared live model and effort are not inherited by the domestic worker.
    expect(getInterviewLlmRouting('goapply')).toEqual({ backendModel: 'deepseek/deepseek-v4-pro', workerModel: 'deepseek/deepseek-v4-pro' });
    process.env.CN_LLM_INTERVIEW_LIVE_MODEL = 'qwen/qwen-max';
    process.env.CN_LLM_INTERVIEW_LIVE_REASONING_EFFORT = 'low';
    expect(getInterviewLlmRouting('goapply')).toEqual({
      backendModel: 'deepseek/deepseek-v4-pro', workerModel: 'qwen/qwen-max', reasoningEffort: 'low',
    });
    process.env.CN_LLM_INTERVIEW_LIVE_MODEL = 'openai/gpt-5.4';
    expect(() => getInterviewLlmRouting('goapply')).toThrow(/CN_LLM_INTERVIEW_LIVE_MODEL="openai\/gpt-5.4" is not a domestic model/);
    // A session pinned to the shared plane keeps the gateway routing: the
    // shared live model, or the CN model mapped into LiveKit Inference.
    delete process.env.CN_LLM_INTERVIEW_LIVE_MODEL;
    const pinned = () => runOnVoiceStack('goapply', 'shared', () => getInterviewLlmRouting('goapply'));
    expect(pinned()).toMatchObject({ backendModel: 'deepseek/deepseek-v4-pro', workerModel: 'openai/gpt-4.1-mini' });
    delete process.env.LLM_INTERVIEW_LIVE_MODEL;
    expect(pinned()).toMatchObject({ workerModel: 'deepseek-ai/deepseek-v4-pro' });
    process.env.LLM_INTERVIEW_LIVE_MODEL = 'openai/gpt-4.1-mini';
    expect(getInterviewLlmRouting('roboapply')).toMatchObject({ backendModel: 'openai/gpt-5.4', workerModel: 'openai/gpt-4.1-mini' });
  });

  it.each(['CN_LLM_DOMESTIC_ONLY', 'CN_RESIDENCY_STRICT'])('%s (operator opt-in): the interviewer must be domestic, on GoApply’s own plane', (wall) => {
    Object.assign(process.env, INTL_LK, { LLM_INTERVIEW_MODEL: 'openai/gpt-5.4', [wall]: 'true' });
    // The shared project runs LiveKit Inference: refused, never routed offshore.
    expect(() => getInterviewLlmRouting('goapply')).toThrow(InterviewEngineConfigError);
    expect(() => getInterviewLlmRouting('goapply')).toThrow(/CN_LLM_DOMESTIC_ONLY is on/);
    // The practice gate reads this, so the setup offers the written practice
    // instead of a voice option whose every start is a 503; and it is logged.
    expect(voiceRoutingProblem('goapply')).toMatch(/CN_LLM_DOMESTIC_ONLY is on/);
    expect(voiceRoutingProblem('roboapply')).toBeNull();
    expect(voiceConfigProblems('goapply').filter((p) => p.kind === 'worker')).toEqual([
      { kind: 'worker', message: expect.stringMatching(/^GoApply voice practice cannot start, so the written practice is offered instead: CN_LLM_DOMESTIC_ONLY is on/) },
    ]);
    Object.assign(process.env, CN_LK);
    // Its own plane but only the shared model: still refused, naming what to set.
    expect(() => getInterviewLlmRouting('goapply')).toThrow(/LLM_INTERVIEW_MODEL="openai\/gpt-5.4" is not a domestic model/);
    expect(voiceRoutingProblem('goapply')).toMatch(/is not a domestic model/);
    process.env.CN_LLM_INTERVIEW_MODEL = 'deepseek/deepseek-v4-pro';
    expect(getInterviewLlmRouting('goapply')).toEqual({ backendModel: 'deepseek/deepseek-v4-pro', workerModel: 'deepseek/deepseek-v4-pro' });
    expect(voiceRoutingProblem('goapply')).toBeNull();
    // RoboApply is never touched by GoApply's wall.
    expect(getInterviewLlmRouting('roboapply')).toMatchObject({ backendModel: 'openai/gpt-5.4', workerModel: 'openai/gpt-5.4' });
    delete process.env[wall];
  });
});

describe('GoApply speech models (an optional DashScope set)', () => {
  it('has no speech set of its own unless BOTH CN models are set; the shared names are never read as its own', () => {
    process.env.INTERVIEW_ENGINE_STT_MODEL = 'deepgram/nova-3';
    process.env.INTERVIEW_ENGINE_TTS_MODEL = 'cartesia/sonic-3';
    expect(tryGetCnSpeechConfig('goapply')).toBeNull();
    expect(tryGetCnSpeechConfig('roboapply')).toBeNull();
    expect(() => getCnSpeechConfig('goapply')).toThrow(InterviewEngineConfigError);
    // One model of the pair is not a set (G53; PAR-1 known gap).
    process.env.CN_INTERVIEW_ENGINE_STT_MODEL = 'dashscope/paraformer-realtime-v2';
    expect(tryGetCnSpeechConfig('goapply')).toBeNull();
    process.env.CN_INTERVIEW_ENGINE_TTS_MODEL = 'dashscope/cosyvoice-v2';
    process.env.CN_INTERVIEW_ENGINE_TTS_VOICE = 'voice-f';
    const cfg = {
      sttModel: 'dashscope/paraformer-realtime-v2', sttFallbackModels: [], ttsModel: 'dashscope/cosyvoice-v2',
      voiceFemale: 'voice-f', voiceMale: null,
    };
    expect(tryGetCnSpeechConfig('goapply')).toEqual(cfg);
    expect(getCnSpeechConfig('goapply')).toEqual(cfg);
    expect(tryGetCnSpeechConfig('roboapply')).toBeNull();
  });

  it('its own set must be domestic throughout (the DashScope path is unchanged)', () => {
    process.env.CN_INTERVIEW_ENGINE_STT_MODEL = 'dashscope/paraformer-realtime-v2';
    for (const bad of ['cartesia/sonic-3', 'elevenlabs/eleven_flash', 'deepgram/nova-3', 'cosyvoice-v2', 'openai/tts-1']) {
      process.env.CN_INTERVIEW_ENGINE_TTS_MODEL = bad;
      expect(() => tryGetCnSpeechConfig('goapply')).toThrow(/not a domestic provider/);
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

describe('voice and speech settings that are set but not in effect are named (PAR-1 P4-2)', () => {
  const MODEL = { LLM_INTERVIEW_MODEL: 'openai/gpt-5.4' };
  const CN_SECRET = { CN_LIVEKIT_AGENT_CALLBACK_SECRET: 'cn-cb-secret-value' };

  it('a clean configuration, and RoboApply, report nothing', () => {
    // Nothing configured at all: nothing is "set but not in effect".
    expect(voiceConfigProblems('goapply')).toEqual([]);
    Object.assign(process.env, INTL_LK, MODEL);
    expect(voiceConfigProblems('goapply')).toEqual([]);
    expect(voiceConfigProblems('roboapply')).toEqual([]);
    Object.assign(process.env, CN_LK, CN_SECRET, {
      CN_LLM_INTERVIEW_MODEL: 'deepseek/deepseek-v4-pro',
      CN_INTERVIEW_ENGINE_STT_MODEL: 'dashscope/paraformer-realtime-v2',
      CN_INTERVIEW_ENGINE_TTS_MODEL: 'dashscope/cosyvoice-v2',
    });
    expect(voiceConfigProblems('goapply')).toEqual([]);
    expect(voiceConfigProblems('roboapply')).toEqual([]);
  });

  it('CN_LIVEKIT_API_KEY or CN_VOICE_PROVIDER without CN_LIVEKIT_URL: ignored, and said so', () => {
    Object.assign(process.env, INTL_LK, MODEL, { CN_LIVEKIT_API_KEY: 'cn-key-value', CN_VOICE_PROVIDER: 'livekit_selfhosted' });
    const problems = voiceConfigProblems('goapply');
    expect(problems).toHaveLength(1);
    expect(problems[0]!.kind).toBe('voice');
    expect(problems[0]!.message).toBe(
      'GoApply voice settings CN_LIVEKIT_API_KEY, CN_VOICE_PROVIDER are ignored because CN_LIVEKIT_URL is not set; GoApply uses the shared voice stack.',
    );
    // Names only, never a value.
    expect(problems[0]!.message).not.toContain('cn-key-value');
    expect(voiceConfigProblems('roboapply')).toEqual([]);
  });

  it('CN_LIVEKIT_URL without its key or secret: voice is off for GoApply, and the missing variables are named', () => {
    Object.assign(process.env, INTL_LK, MODEL, CN_SECRET, { CN_LIVEKIT_URL: 'wss://cn.livekit.test', CN_LLM_INTERVIEW_MODEL: 'deepseek/deepseek-v4-pro', CN_INTERVIEW_ENGINE_AGENT_NAME: 'GoApply-Gateway' });
    expect(isLiveKitConfigured('goapply')).toBe(false);
    const problems = voiceConfigProblems('goapply');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'voice' });
    expect(problems[0]!.message).toMatch(/Set CN_LIVEKIT_API_KEY, CN_LIVEKIT_API_SECRET; the shared LIVEKIT_\* values are never mixed in/);
    expect(problems[0]!.message).not.toContain('wss://');
  });

  it('its own plane without CN_LIVEKIT_AGENT_CALLBACK_SECRET: the worker’s callbacks would be refused, and it is said', () => {
    // The voice group flips as a whole: the shared secret is not read on the own plane.
    Object.assign(process.env, INTL_LK, CN_LK, MODEL, {
      LIVEKIT_AGENT_CALLBACK_SECRET: 'shared-cb-secret-value', CN_INTERVIEW_ENGINE_AGENT_NAME: 'GoApply-Gateway',
    });
    expect(getAgentCallbackSecret('goapply')).toBeNull();
    const problems = voiceConfigProblems('goapply');
    expect(problems).toEqual([
      {
        kind: 'voice',
        message:
          "GoApply's own plane has no CN_LIVEKIT_AGENT_CALLBACK_SECRET: its worker's callbacks are refused (the shared LIVEKIT_AGENT_CALLBACK_SECRET is not used on that plane).",
      },
    ]);
    expect(problems[0]!.message).not.toContain('shared-cb-secret-value');
    Object.assign(process.env, CN_SECRET);
    expect(voiceConfigProblems('goapply')).toEqual([]);
    // On the shared plane the shared secret serves both brands: nothing to say.
    for (const k of [...Object.keys(CN_LK), ...Object.keys(CN_SECRET)]) delete process.env[k];
    delete process.env.CN_INTERVIEW_ENGINE_AGENT_NAME;
    expect(voiceConfigProblems('goapply')).toEqual([]);
  });

  it('its own plane with only the shared callback base URL: outside production the worker would be sent to localhost', () => {
    Object.assign(process.env, INTL_LK, CN_LK, CN_SECRET, MODEL, {
      INTERVIEW_ENGINE_CALLBACK_BASE_URL: 'https://api.shared.test', CN_INTERVIEW_ENGINE_AGENT_NAME: 'GoApply-Gateway',
    });
    const savedNodeEnv = process.env.NODE_ENV;
    const savedVercel = process.env.VERCEL;
    delete process.env.VERCEL;
    process.env.NODE_ENV = 'development';
    try {
      const problems = voiceConfigProblems('goapply');
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({ kind: 'voice' });
      expect(problems[0]!.message).toMatch(/no CN_INTERVIEW_ENGINE_CALLBACK_BASE_URL: outside production its worker is sent to localhost/);
      expect(problems[0]!.message).not.toContain('api.shared.test');
      expect(getCallbackBaseUrl(null, 'goapply')).toMatch(/^http:\/\/localhost:/);
      // In production the request origin is used: nothing to say.
      process.env.NODE_ENV = 'production';
      expect(voiceConfigProblems('goapply')).toEqual([]);
      process.env.NODE_ENV = 'development';
      process.env.CN_INTERVIEW_ENGINE_CALLBACK_BASE_URL = 'https://api.cn.test';
      expect(voiceConfigProblems('goapply')).toEqual([]);
    } finally {
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
      if (savedVercel !== undefined) process.env.VERCEL = savedVercel;
    }
  });

  it('one speech model of the pair: GoApply stays on the shared speech set and the missing variable is named, once', () => {
    Object.assign(process.env, INTL_LK, MODEL, { CN_INTERVIEW_ENGINE_STT_MODEL: 'dashscope/paraformer-realtime-v2' });
    expect(voiceConfigProblems('goapply')).toEqual([
      {
        kind: 'speech',
        message:
          'GoApply speech settings CN_INTERVIEW_ENGINE_STT_MODEL are ignored because CN_INTERVIEW_ENGINE_TTS_MODEL is not set; GoApply uses the shared speech stack.',
      },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(warnVoiceConfigProblemsOnce('goapply')).toHaveLength(1);
    warnVoiceConfigProblemsOnce('goapply');
    warnVoiceConfigProblemsOnce('roboapply');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/CN_INTERVIEW_ENGINE_TTS_MODEL is not set/);
    warn.mockRestore();
  });

  it('the CN speech pair while voice runs on the shared worker: that worker needs the DashScope key', () => {
    Object.assign(process.env, INTL_LK, MODEL, {
      CN_INTERVIEW_ENGINE_STT_MODEL: 'dashscope/paraformer-realtime-v2', CN_INTERVIEW_ENGINE_TTS_MODEL: 'dashscope/cosyvoice-v2',
    });
    expect(voiceConfigProblems('goapply')).toEqual([
      {
        kind: 'worker',
        message:
          "GoApply's DashScope speech (CN_INTERVIEW_ENGINE_STT_MODEL, CN_INTERVIEW_ENGINE_TTS_MODEL) runs on the shared worker, which must have DASHSCOPE_API_KEY; without it each GoApply session fails when it connects.",
      },
    ]);
    // On its own plane the pair belongs to its own worker: nothing to say.
    Object.assign(process.env, CN_LK, CN_SECRET, { CN_LLM_INTERVIEW_MODEL: 'deepseek/deepseek-v4-pro' });
    expect(voiceConfigProblems('goapply')).toEqual([]);
  });

  it('a foreign model in the CN speech pair: no voice session can start, and it is said', () => {
    Object.assign(process.env, INTL_LK, MODEL, {
      CN_INTERVIEW_ENGINE_STT_MODEL: 'dashscope/paraformer-realtime-v2', CN_INTERVIEW_ENGINE_TTS_MODEL: 'cartesia/sonic-3',
    });
    expect(voiceRoutingProblem('goapply')).toMatch(/GoApply speech model "cartesia\/sonic-3" is not a domestic provider/);
    expect(voiceConfigProblems('goapply').map((p) => p.message).join('\n')).toMatch(/voice practice cannot start, so the written practice is offered instead: GoApply speech model/);
    expect(voiceRoutingProblem('roboapply')).toBeNull();
  });

  it('the domestic-only GoApply-Interview worker without a domestic model or DashScope speech', () => {
    Object.assign(process.env, INTL_LK, CN_LK, CN_SECRET, MODEL);
    expect(voiceConfigProblems('goapply').map((p) => p.kind)).toEqual(['worker', 'worker']);
    expect(voiceConfigProblems('goapply')[0]!.message).toMatch(/GoApply-Interview worker .* CN_LLM_INTERVIEW_MODEL is not set/);
    expect(voiceConfigProblems('goapply')[1]!.message).toMatch(/DashScope speech only/);
    // A gateway worker under another name on GoApply's own project is a valid setup.
    process.env.CN_INTERVIEW_ENGINE_AGENT_NAME = 'GoApply-Gateway';
    expect(voiceConfigProblems('goapply')).toEqual([]);
  });

  it('a CN interview model with no LiveKit Inference equivalent while voice runs on the shared (gateway) worker: said, and voice stays on', () => {
    Object.assign(process.env, INTL_LK, MODEL, { CN_LLM_INTERVIEW_LIVE_MODEL: 'qwen/qwen-max', CN_LLM_INTERVIEW_MODEL: 'qwen/qwen-plus' });
    expect(voiceRoutingProblem('goapply')).toBeNull();
    expect(voiceConfigProblems('goapply')).toEqual([
      {
        kind: 'worker',
        message:
          'GoApply voice practice runs on the shared LiveKit project, whose worker runs LiveKit Inference models. ' +
          'CN_LLM_INTERVIEW_LIVE_MODEL and CN_LLM_INTERVIEW_MODEL have no LiveKit Inference equivalent, ' +
          "so the live turns use the shared interview model (GoApply's own interview model still writes the plan and the report). " +
          'Set CN_LIVEKIT_URL with a worker of its own to run it live.',
      },
    ]);
    // A CN model the shared worker can run is in effect: nothing to say.
    delete process.env.CN_LLM_INTERVIEW_LIVE_MODEL;
    process.env.CN_LLM_INTERVIEW_MODEL = 'deepseek/deepseek-v4-pro';
    expect(voiceConfigProblems('goapply')).toEqual([]);
  });

  it('no interview model at all while the plane is configured: voice cannot start, and it is said (once the plane exists)', () => {
    Object.assign(process.env, INTL_LK);
    expect(voiceRoutingProblem('goapply')).toMatch(/Interview LLM is not configured/);
    expect(voiceConfigProblems('goapply')).toEqual([
      { kind: 'worker', message: 'GoApply voice practice cannot start, so the written practice is offered instead: Interview LLM is not configured. Set LLM_INTERVIEW_MODEL.' },
    ]);
  });
});

describe('the blueprint model goes through the shared model resolver when it is there (plan §3.3)', () => {
  it('without the resolver: CN value, else the shared one, else the interview task model (per key)', () => {
    Object.assign(process.env, { LLM_INTERVIEW_MODEL: 'openai/gpt-5.4' });
    expect(getBlueprintModel('goapply')).toBe('openai/gpt-5.4');
    process.env.LLM_INTERVIEW_BLUEPRINT_MODEL = 'openai/gpt-5.4-mini';
    expect(getBlueprintModel('goapply')).toBe('openai/gpt-5.4-mini');
    process.env.CN_LLM_INTERVIEW_BLUEPRINT_MODEL = 'deepseek/deepseek-v4-pro';
    expect(getBlueprintModel('goapply')).toBe('deepseek/deepseek-v4-pro');
    expect(getBlueprintModel('roboapply')).toBe('openai/gpt-5.4-mini');
  });
});
