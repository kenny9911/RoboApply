// @vitest-environment node
//
// WP-63a: the VoiceSessionProvider wraps Wave 0's LiveKit code unchanged and
// runs every call inside its brand; the brand media policy is applied inside
// the provider. Reserved providers (volcano, trtc) are never usable.
// Run: npx vitest run server/src/interview-engine/providers/__tests__/providers.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lk = vi.hoisted(() => ({
  brands: [] as Array<{ fn: string; brand: string | undefined; args: unknown[] }>,
}));

vi.mock('../../livekit/liveKitClient.js', async () => {
  const { getCurrentBrandId } = await import('../../../lib/requestContext.js');
  const rec = (fn: string, ret: unknown) => async (...args: unknown[]) => {
    lk.brands.push({ fn, brand: getCurrentBrandId(), args });
    return ret;
  };
  return {
    createInterviewRoom: rec('createRoom', { sid: 'RM_1' }),
    dispatchAgent: rec('dispatch', 'AD_1'),
    mintJoinToken: rec('mint', { token: 'jwt', url: 'wss://x', roomName: 'r', identity: 'i', expiresAt: new Date() }),
    sendInterviewEndSignal: rec('end', true),
    deleteInterviewRoom: rec('deleteRoom', undefined),
  };
});
vi.mock('../../livekit/egress.js', async () => {
  const { getCurrentBrandId } = await import('../../../lib/requestContext.js');
  return {
    startRoomRecording: async (...args: unknown[]) => {
      lk.brands.push({ fn: 'record', brand: getCurrentBrandId(), args });
      return { egressId: 'EG_1', filepath: 'f' };
    },
    stopRecording: async (...args: unknown[]) => {
      lk.brands.push({ fn: 'stopRecord', brand: getCurrentBrandId(), args });
    },
  };
});

import {
  createVoiceProvider,
  getVoiceProvider,
  readVoiceSeam,
  voiceAvailable,
  voiceProviderFor,
  voiceSeamForBrand,
  voiceSeamMetrics,
  VoiceProviderNotImplementedError,
  DEFAULT_VOICE_SEAM,
  IMPLEMENTED_VOICE_PROVIDERS,
} from '../index.js';
import { InterviewEngineConfigError } from '../../config.js';
import { runWithBrand } from '../../../lib/requestContext.js';

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('LIVEKIT_') || k.startsWith('CN_') || k === 'VOICE_PROVIDER' || k.startsWith('INTERVIEW_ENGINE_')) delete process.env[k];
  }
  lk.brands.length = 0;
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe('LiveKit provider per brand', () => {
  it('runs every GoApply call inside the GoApply brand and dispatches GoApply-Interview', async () => {
    const p = getVoiceProvider('goapply');
    expect(p.id).toBe('livekit_cloud');
    await p.createRoom({ roomName: 'r', metadata: '{}' });
    await p.dispatchAgent({ roomName: 'r', metadata: '{}' });
    await p.sendEndSignal('r');
    await p.deleteRoom('r');
    expect(lk.brands.map((c) => c.brand)).toEqual(['goapply', 'goapply', 'goapply', 'goapply']);
    expect(lk.brands[1]!.args[0]).toEqual({ roomName: 'r', agentName: 'GoApply-Interview', metadata: '{}' });
  });

  it('keeps the RoboApply call shapes of Wave 0', async () => {
    const p = getVoiceProvider('roboapply');
    await p.createRoom({ roomName: 'r', metadata: 'm' });
    await p.dispatchAgent({ roomName: 'r', metadata: 'm' });
    await p.sendEndSignal('r');
    expect(lk.brands[0]!.args).toEqual([{ roomName: 'r', metadata: 'm' }]);
    expect(lk.brands[1]!.args).toEqual([{ roomName: 'r', agentName: 'RoboApply-Interview', metadata: 'm' }]);
    expect(lk.brands[2]!.args).toEqual(['r']);
    expect(lk.brands.every((c) => c.brand === 'roboapply')).toBe(true);
  });

  it('does not re-enter a context that already is the brand', async () => {
    await runWithBrand('goapply', () => getVoiceProvider('goapply').sendEndSignal('r'));
    expect(lk.brands[0]!.brand).toBe('goapply');
  });

  it('GoApply: the join token never allows a camera, recordings are audio-only', async () => {
    const cn = getVoiceProvider('goapply');
    expect(cn.media).toEqual({ cameraPublish: false, recordVideo: false });
    await cn.mintClientToken({ roomName: 'r', identity: 'c', allowVideo: true });
    await cn.startRecording({ roomName: 'r', filepath: 'f', audioOnly: false });
    expect(lk.brands[0]!.args[0]).toMatchObject({ allowVideo: false });
    expect(lk.brands[1]!.args[0]).toMatchObject({ audioOnly: true });
  });

  it('RoboApply: video mode keeps the camera and video recording', async () => {
    const intl = getVoiceProvider('roboapply');
    await intl.mintClientToken({ roomName: 'r', identity: 'c', allowVideo: true });
    await intl.startRecording({ roomName: 'r', filepath: 'f', audioOnly: false });
    expect(lk.brands[0]!.args[0]).toMatchObject({ allowVideo: true });
    expect(lk.brands[1]!.args[0]).toMatchObject({ audioOnly: false });
  });

  it('is configured only with the brand’s own credentials', () => {
    Object.assign(process.env, { LIVEKIT_URL: 'wss://i', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' });
    expect(getVoiceProvider('roboapply').isConfigured()).toBe(true);
    expect(getVoiceProvider('goapply').isConfigured()).toBe(false);
    expect(voiceAvailable('goapply')).toBe(false);
    Object.assign(process.env, { CN_LIVEKIT_URL: 'wss://c', CN_LIVEKIT_API_KEY: 'k', CN_LIVEKIT_API_SECRET: 's' });
    expect(voiceAvailable('goapply')).toBe(true);
  });

  it('livekit_selfhosted uses the same protocol against the brand URL', async () => {
    process.env.CN_VOICE_PROVIDER = 'livekit_selfhosted';
    const p = getVoiceProvider('goapply');
    expect(p.id).toBe('livekit_selfhosted');
    await p.createRoom({ roomName: 'r', metadata: '{}' });
    expect(lk.brands[0]).toMatchObject({ fn: 'createRoom', brand: 'goapply' });
  });
});

describe('reserved providers', () => {
  it.each(['volcano', 'trtc'] as const)('%s is not implemented, never available, and maps to a 503 config error', (id) => {
    expect(IMPLEMENTED_VOICE_PROVIDERS).not.toContain(id);
    expect(() => createVoiceProvider(id, 'goapply')).toThrow(VoiceProviderNotImplementedError);
    expect(() => createVoiceProvider(id, 'goapply')).toThrow(InterviewEngineConfigError);
    process.env.CN_LIVEKIT_URL = 'wss://c';
    process.env.CN_LIVEKIT_API_KEY = 'k';
    process.env.CN_LIVEKIT_API_SECRET = 's';
    process.env.CN_VOICE_PROVIDER = id;
    expect(voiceAvailable('goapply')).toBe(false);
  });
});

describe('session seam', () => {
  it('reads every Wave 0 row as RoboApply on LiveKit Cloud', () => {
    expect(readVoiceSeam(null)).toEqual(DEFAULT_VOICE_SEAM);
    expect(readVoiceSeam({ control: { creditExempt: true } })).toEqual(DEFAULT_VOICE_SEAM);
    expect(readVoiceSeam({ voiceSeam: { brand: 'nope', provider: 'x' } })).toEqual(DEFAULT_VOICE_SEAM);
  });

  it('writes nothing for the default seam and round-trips any other', () => {
    expect(voiceSeamMetrics(voiceSeamForBrand('roboapply'))).toEqual({});
    const cn = voiceSeamForBrand('goapply');
    const stored = voiceSeamMetrics(cn);
    expect(stored).toEqual({ voiceSeam: { v: 1, brand: 'goapply', provider: 'livekit_cloud' } });
    expect(readVoiceSeam(stored)).toEqual(cn);
    expect(voiceProviderFor(readVoiceSeam(stored)).brand).toBe('goapply');
  });
});

describe('ai.interviewVoice follows the brand media plane (absent creds → text practice)', () => {
  it('GoApply voice is off without CN_LIVEKIT_*, even when RoboApply is configured', async () => {
    const { isEnabledForBrand } = await import('../../../platform/flags.js');
    const { getBrand } = await import('../../../platform/brand/registry.js');
    const env = { LIVEKIT_URL: 'wss://i', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's', FLAG_GOAPPLY_INTERVIEW_VOICE: 'true' };
    expect(isEnabledForBrand('ai.interviewVoice', getBrand('roboapply'), env)).toBe(true);
    expect(isEnabledForBrand('ai.interviewVoice', getBrand('goapply'), env)).toBe(false);
    expect(voiceAvailable('goapply')).toBe(false);
    // RoboApply without its own creds is off too (no cross-brand fallback).
    expect(isEnabledForBrand('ai.interviewVoice', getBrand('roboapply'), { CN_LIVEKIT_URL: 'wss://c', CN_LIVEKIT_API_KEY: 'k', CN_LIVEKIT_API_SECRET: 's' })).toBe(false);
  });
});
