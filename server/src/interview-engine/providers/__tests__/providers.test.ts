// @vitest-environment node
//
// WP-63a + D5: the VoiceSessionProvider wraps Wave 0's LiveKit code unchanged
// and runs every call inside its brand and on its plane (the shared LiveKit
// project, or GoApply's own); the media policy, the same on both brands, is
// applied inside the provider. Reserved providers (volcano, trtc) are never
// usable.
// Run: npx vitest run server/src/interview-engine/providers/__tests__/providers.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lk = vi.hoisted(() => ({
  brands: [] as Array<{ fn: string; brand: string | undefined; args: unknown[]; stack?: string }>,
}));

vi.mock('../../livekit/liveKitClient.js', async () => {
  const { getCurrentBrandId } = await import('../../../lib/requestContext.js');
  const { voiceStack } = await import('../../config.js');
  const rec = (fn: string, ret: unknown) => async (...args: unknown[]) => {
    const brand = getCurrentBrandId();
    // The plane the real client would read its credentials from.
    lk.brands.push({ fn, brand, args, stack: voiceStack(brand) } as (typeof lk.brands)[number]);
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
  readRowSeam,
  readStoredVoiceSeam,
  readVoiceSeam,
  resolveSessionSeam,
  voiceAvailable,
  voiceProviderFor,
  voiceSeamColumns,
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
    if (k.startsWith('LIVEKIT_') || k.startsWith('CN_') || k === 'VOICE_PROVIDER' || k.startsWith('INTERVIEW_ENGINE_') || k.startsWith('FLAG_')) delete process.env[k];
  }
  lk.brands.length = 0;
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const SHARED_LK = { LIVEKIT_URL: 'wss://i', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' };
const CN_LK = { CN_LIVEKIT_URL: 'wss://c', CN_LIVEKIT_API_KEY: 'ck', CN_LIVEKIT_API_SECRET: 'cs' };

describe('LiveKit provider per brand', () => {
  it('GoApply on the shared plane: every call runs inside the GoApply brand and dispatches the shared worker (G51)', async () => {
    Object.assign(process.env, SHARED_LK);
    const p = getVoiceProvider('goapply');
    expect(p.id).toBe('livekit_cloud');
    expect(p.stack).toBe('shared');
    expect(p.agentName()).toBe('RoboApply-Interview');
    await p.createRoom({ roomName: 'r', metadata: '{}' });
    await p.dispatchAgent({ roomName: 'r', metadata: '{}' });
    await p.sendEndSignal('r');
    await p.deleteRoom('r');
    expect(lk.brands.map((c) => c.brand)).toEqual(['goapply', 'goapply', 'goapply', 'goapply']);
    expect(lk.brands.map((c) => c.stack)).toEqual(['shared', 'shared', 'shared', 'shared']);
    // Never 'GoApply-Interview' on the shared project.
    expect(lk.brands[1]!.args[0]).toEqual({ roomName: 'r', agentName: 'RoboApply-Interview', metadata: '{}' });
  });

  it("GoApply on its own plane dispatches 'GoApply-Interview'", async () => {
    Object.assign(process.env, SHARED_LK, CN_LK);
    const p = getVoiceProvider('goapply');
    expect(p.stack).toBe('own');
    expect(p.agentName()).toBe('GoApply-Interview');
    await p.dispatchAgent({ roomName: 'r', metadata: '{}' });
    expect(lk.brands[0]).toMatchObject({ brand: 'goapply', stack: 'own' });
    expect(lk.brands[0]!.args[0]).toEqual({ roomName: 'r', agentName: 'GoApply-Interview', metadata: '{}' });
  });

  it('a provider built from a stored seam keeps that plane when the environment changes', async () => {
    Object.assign(process.env, SHARED_LK);
    const pinned = voiceProviderFor(voiceSeamForBrand('goapply'));
    expect(pinned.stack).toBe('shared');
    // GoApply gets its own plane while the session is live.
    Object.assign(process.env, CN_LK);
    await pinned.dispatchAgent({ roomName: 'r', metadata: '{}' });
    await pinned.deleteRoom('r');
    expect(lk.brands.map((c) => c.stack)).toEqual(['shared', 'shared']);
    expect(lk.brands[0]!.args[0]).toMatchObject({ agentName: 'RoboApply-Interview' });
    expect(pinned.isConfigured()).toBe(true);
    // A new session's provider is on the new plane.
    expect(getVoiceProvider('goapply').stack).toBe('own');
    // A seam with no stored plane (an older row) follows the environment.
    const legacy = voiceProviderFor({ brand: 'goapply', provider: 'livekit_cloud' });
    expect(legacy.stack).toBeUndefined();
    expect(legacy.agentName()).toBe('GoApply-Interview');
  });

  it('keeps the RoboApply call shapes of Wave 0', async () => {
    const p = getVoiceProvider('roboapply');
    expect(p.stack).toBeUndefined();
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

  it('video mode keeps the camera and video recording on BOTH brands (G8)', async () => {
    for (const brand of ['roboapply', 'goapply'] as const) {
      lk.brands.length = 0;
      const p = getVoiceProvider(brand);
      expect(p.media).toEqual({ cameraPublish: true, recordVideo: true });
      await p.mintClientToken({ roomName: 'r', identity: 'c', allowVideo: true });
      await p.startRecording({ roomName: 'r', filepath: 'f', audioOnly: false });
      expect(lk.brands[0]!.args[0], brand).toMatchObject({ allowVideo: true });
      expect(lk.brands[1]!.args[0], brand).toMatchObject({ audioOnly: false });
      // A voice practice, or a session without the video consent, still records audio only.
      await p.mintClientToken({ roomName: 'r', identity: 'c', allowVideo: false });
      await p.startRecording({ roomName: 'r', filepath: 'f', audioOnly: true });
      expect(lk.brands[2]!.args[0], brand).toMatchObject({ allowVideo: false });
      expect(lk.brands[3]!.args[0], brand).toMatchObject({ audioOnly: true });
    }
  });

  it('GoApply with CN_INTERVIEW_CAMERA_PUBLISH=false: the join token never allows a camera, recordings are audio-only', async () => {
    process.env.CN_INTERVIEW_CAMERA_PUBLISH = 'false';
    const cn = getVoiceProvider('goapply');
    expect(cn.media).toEqual({ cameraPublish: false, recordVideo: false });
    await cn.mintClientToken({ roomName: 'r', identity: 'c', allowVideo: true });
    await cn.startRecording({ roomName: 'r', filepath: 'f', audioOnly: false });
    expect(lk.brands[0]!.args[0]).toMatchObject({ allowVideo: false });
    expect(lk.brands[1]!.args[0]).toMatchObject({ audioOnly: true });
    expect(getVoiceProvider('roboapply').media).toEqual({ cameraPublish: true, recordVideo: true });
  });

  it('GoApply is configured by the shared credentials; a half-set own plane is not configured (never mixed)', () => {
    Object.assign(process.env, SHARED_LK);
    expect(getVoiceProvider('roboapply').isConfigured()).toBe(true);
    expect(getVoiceProvider('goapply').isConfigured()).toBe(true);
    expect(voiceAvailable('goapply')).toBe(true);
    process.env.CN_LIVEKIT_URL = 'wss://c';
    expect(getVoiceProvider('goapply').isConfigured()).toBe(false);
    expect(voiceAvailable('goapply')).toBe(false);
    expect(voiceAvailable('roboapply')).toBe(true);
    Object.assign(process.env, CN_LK);
    expect(voiceAvailable('goapply')).toBe(true);
    // Its own plane alone is enough for GoApply and gives RoboApply nothing.
    for (const k of Object.keys(SHARED_LK)) delete process.env[k];
    expect(voiceAvailable('goapply')).toBe(true);
    expect(voiceAvailable('roboapply')).toBe(false);
  });

  it('livekit_selfhosted uses the same protocol against the URL of the plane in use', async () => {
    // GoApply's own plane: CN_VOICE_PROVIDER is read together with CN_LIVEKIT_URL.
    Object.assign(process.env, CN_LK, { CN_VOICE_PROVIDER: 'livekit_selfhosted' });
    const own = getVoiceProvider('goapply');
    expect(own.id).toBe('livekit_selfhosted');
    await own.createRoom({ roomName: 'r', metadata: '{}' });
    expect(lk.brands[0]).toMatchObject({ fn: 'createRoom', brand: 'goapply', stack: 'own' });
    // The shared plane: VOICE_PROVIDER selects it for both brands; a stray CN value is not read.
    for (const k of Object.keys(CN_LK)) delete process.env[k];
    expect(getVoiceProvider('goapply').id).toBe('livekit_cloud');
    process.env.VOICE_PROVIDER = 'livekit_selfhosted';
    delete process.env.CN_VOICE_PROVIDER;
    expect(getVoiceProvider('goapply').id).toBe('livekit_selfhosted');
    expect(getVoiceProvider('roboapply').id).toBe('livekit_selfhosted');
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
  it('liveMetrics alone: no seam reads as the default (legacy reader), and as "says nothing" for the row reader', () => {
    expect(readVoiceSeam(null)).toEqual(DEFAULT_VOICE_SEAM);
    expect(readVoiceSeam({ control: { creditExempt: true } })).toEqual(DEFAULT_VOICE_SEAM);
    expect(readVoiceSeam({ voiceSeam: { brand: 'nope', provider: 'x' } })).toEqual(DEFAULT_VOICE_SEAM);
    expect(readStoredVoiceSeam(null)).toBeNull();
    expect(readStoredVoiceSeam({ control: {} })).toBeNull();
    expect(readStoredVoiceSeam({ voiceSeam: { brand: 'nope', provider: 'x' } })).toBeNull();
    expect(readStoredVoiceSeam({ voiceSeam: { brand: 'goapply', provider: 'x' } })).toEqual({ brand: 'goapply', provider: 'livekit_cloud' });
    // The plane is read when it is one of the two values, dropped otherwise.
    expect(readStoredVoiceSeam({ voiceSeam: { brand: 'goapply', provider: 'livekit_cloud', stack: 'shared' } })).toEqual({ brand: 'goapply', provider: 'livekit_cloud', stack: 'shared' });
    expect(readStoredVoiceSeam({ voiceSeam: { brand: 'goapply', provider: 'livekit_cloud', stack: 'mine' } })).toEqual({ brand: 'goapply', provider: 'livekit_cloud' });
  });

  it('the row reader takes the columns first, then liveMetrics, and never invents a brand (INT-09)', () => {
    const json = { voiceSeam: { v: 1, brand: 'goapply', provider: 'livekit_selfhosted' } };
    expect(readRowSeam({ brand: 'goapply', voiceProvider: 'livekit_selfhosted', liveMetrics: null })).toEqual({ brand: 'goapply', provider: 'livekit_selfhosted' });
    // The column wins over a JSON seam that disagrees.
    expect(readRowSeam({ brand: 'roboapply', voiceProvider: 'livekit_cloud', liveMetrics: json })).toEqual({ brand: 'roboapply', provider: 'livekit_cloud' });
    // A column brand with no provider: the JSON seam of the same brand supplies it, else LiveKit Cloud.
    expect(readRowSeam({ brand: 'goapply', voiceProvider: null, liveMetrics: json })).toEqual({ brand: 'goapply', provider: 'livekit_selfhosted' });
    expect(readRowSeam({ brand: 'goapply', voiceProvider: 'bogus', liveMetrics: null })).toEqual({ brand: 'goapply', provider: 'livekit_cloud' });
    // No column: the JSON seam.
    expect(readRowSeam({ brand: null, voiceProvider: null, liveMetrics: json })).toEqual({ brand: 'goapply', provider: 'livekit_selfhosted' });
    // The plane has no column: it comes from the JSON seam of the SAME brand only.
    const planed = { voiceSeam: { v: 1, brand: 'goapply', provider: 'livekit_cloud', stack: 'shared' } };
    expect(readRowSeam({ brand: 'goapply', voiceProvider: 'livekit_cloud', liveMetrics: planed })).toEqual({ brand: 'goapply', provider: 'livekit_cloud', stack: 'shared' });
    expect(readRowSeam({ brand: null, liveMetrics: planed })).toEqual({ brand: 'goapply', provider: 'livekit_cloud', stack: 'shared' });
    expect(readRowSeam({ brand: 'roboapply', voiceProvider: 'livekit_cloud', liveMetrics: planed })).toEqual({ brand: 'roboapply', provider: 'livekit_cloud' });
    // Neither (and an unknown column value): the row says nothing — null, not 'roboapply'.
    expect(readRowSeam({ brand: null, voiceProvider: null, liveMetrics: { control: {} } })).toBeNull();
    expect(readRowSeam({ brand: 'someone-else', liveMetrics: null })).toBeNull();
    expect(readRowSeam({})).toBeNull();
  });

  it('resolveSessionSeam: column → liveMetrics → the owner’s brand; null is never read as RoboApply', async () => {
    const lookup = vi.fn(async (userId: string) => (userId === 'cn-user' ? ('goapply' as const) : userId === 'ghost' ? null : ('roboapply' as const)));
    // The row answers by itself: no lookup.
    expect(await resolveSessionSeam({ userId: 'cn-user', brand: 'goapply', voiceProvider: 'livekit_cloud' }, lookup)).toEqual({ brand: 'goapply', provider: 'livekit_cloud' });
    expect(await resolveSessionSeam({ userId: 'u', brand: null, liveMetrics: { voiceSeam: { brand: 'goapply', provider: 'livekit_cloud' } } }, lookup)).toEqual({ brand: 'goapply', provider: 'livekit_cloud' });
    expect(lookup).not.toHaveBeenCalled();
    // A legacy row: the owner decides.
    expect(await resolveSessionSeam({ userId: 'cn-user', brand: null, voiceProvider: null, liveMetrics: null }, lookup)).toEqual({ brand: 'goapply', provider: 'livekit_cloud' });
    expect(await resolveSessionSeam({ userId: 'intl-user', brand: null, liveMetrics: {} }, lookup)).toEqual({ brand: 'roboapply', provider: 'livekit_cloud' });
    expect(lookup).toHaveBeenCalledTimes(2);
    // The owner is gone (rows cascade with the user, so this is a leftover): the default seam.
    expect(await resolveSessionSeam({ userId: 'ghost' }, lookup)).toEqual(DEFAULT_VOICE_SEAM);
    // A failed lookup is never a guess.
    await expect(resolveSessionSeam({ userId: 'x' }, async () => { throw new Error('db down'); })).rejects.toThrow('db down');
  });

  it('every create writes both columns, for the default seam too', () => {
    expect(voiceSeamColumns(voiceSeamForBrand('roboapply'))).toEqual({ brand: 'roboapply', voiceProvider: 'livekit_cloud' });
    expect(voiceSeamColumns({ brand: 'goapply', provider: 'livekit_selfhosted' })).toEqual({ brand: 'goapply', voiceProvider: 'livekit_selfhosted' });
  });

  it('writes nothing for the default seam and round-trips any other, plane included', () => {
    expect(voiceSeamForBrand('roboapply')).toEqual({ brand: 'roboapply', provider: 'livekit_cloud' });
    expect(voiceSeamMetrics(voiceSeamForBrand('roboapply'))).toEqual({});
    const cn = voiceSeamForBrand('goapply');
    expect(cn).toEqual({ brand: 'goapply', provider: 'livekit_cloud', stack: 'shared' });
    const stored = voiceSeamMetrics(cn);
    expect(stored).toEqual({ voiceSeam: { v: 1, brand: 'goapply', provider: 'livekit_cloud', stack: 'shared' } });
    expect(readVoiceSeam(stored)).toEqual(cn);
    expect(voiceProviderFor(readVoiceSeam(stored)).brand).toBe('goapply');
    Object.assign(process.env, CN_LK);
    expect(voiceSeamForBrand('goapply')).toEqual({ brand: 'goapply', provider: 'livekit_cloud', stack: 'own' });
    expect(voiceSeamMetrics(voiceSeamForBrand('goapply'))).toEqual({ voiceSeam: { v: 1, brand: 'goapply', provider: 'livekit_cloud', stack: 'own' } });
    // A seam of an older row (no plane) is written back as it was.
    expect(voiceSeamMetrics({ brand: 'goapply', provider: 'livekit_selfhosted' })).toEqual({ voiceSeam: { v: 1, brand: 'goapply', provider: 'livekit_selfhosted' } });
  });
});

describe('ai.interviewVoice follows the media plane in use (absent creds → text practice)', () => {
  it('GoApply voice is on through the shared plane; off with no LiveKit at all or with the product switch', async () => {
    const { isEnabledForBrand } = await import('../../../platform/flags.js');
    const { getBrand } = await import('../../../platform/brand/registry.js');
    const env = { ...SHARED_LK };
    expect(isEnabledForBrand('ai.interviewVoice', getBrand('roboapply'), env)).toBe(true);
    expect(isEnabledForBrand('ai.interviewVoice', getBrand('goapply'), env)).toBe(true);
    Object.assign(process.env, env);
    expect(voiceAvailable('goapply')).toBe(true);
    // The documented off switch.
    expect(isEnabledForBrand('ai.interviewVoice', getBrand('goapply'), { ...env, FLAG_GOAPPLY_INTERVIEW_VOICE: 'false' })).toBe(false);
    expect(isEnabledForBrand('ai.interviewVoice', getBrand('roboapply'), { ...env, FLAG_GOAPPLY_INTERVIEW_VOICE: 'false' })).toBe(true);
    // No LiveKit at all: off on both brands.
    expect(isEnabledForBrand('ai.interviewVoice', getBrand('goapply'), {})).toBe(false);
    expect(isEnabledForBrand('ai.interviewVoice', getBrand('roboapply'), {})).toBe(false);
    for (const k of Object.keys(SHARED_LK)) delete process.env[k];
    expect(voiceAvailable('goapply')).toBe(false);
    // GoApply's own plane gives RoboApply nothing (RoboApply never reads a CN_ value).
    expect(isEnabledForBrand('ai.interviewVoice', getBrand('roboapply'), { CN_LIVEKIT_URL: 'wss://c', CN_LIVEKIT_API_KEY: 'k', CN_LIVEKIT_API_SECRET: 's' })).toBe(false);
  });
});
