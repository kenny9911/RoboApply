// server/src/interview-engine/providers/livekitCloud.ts
//
// The LiveKit provider. It wraps Wave 0's LiveKit code (../livekit/) without
// changing it: each call runs inside the provider's brand AND on its plane
// (`stack`), which is how getLiveKitCreds() picks the shared LIVEKIT_* set or
// GoApply's own CN_LIVEKIT_* set, never a mix (D5; GOAPPLY_PARITY_PLAN §3.5).
// A provider built from a stored session seam keeps that session's plane for
// every call; one built for a new session takes the plane the environment
// selects. The media policy is applied here.

import {
  createInterviewRoom,
  deleteInterviewRoom,
  dispatchAgent,
  mintJoinToken,
  sendInterviewEndSignal,
} from '../livekit/liveKitClient.js';
import { startRoomRecording, stopRecording } from '../livekit/egress.js';
import { receiveBrandWebhook } from '../livekit/webhookReceiver.js';
import {
  getInterviewAgentName,
  getInterviewMediaPolicy,
  getLiveKitCreds,
  isLiveKitConfigured,
  type VoiceProviderId,
  type VoiceStack,
} from '../config.js';
import type { BrandId } from '../../platform/brand/registry.js';
import { inSeam } from './brandScope.js';
import type { VoiceSessionProvider } from './types.js';

export function createLiveKitProvider(
  brand: BrandId,
  id: Extract<VoiceProviderId, 'livekit_cloud' | 'livekit_selfhosted'> = 'livekit_cloud',
  stack?: VoiceStack,
): VoiceSessionProvider {
  const media = getInterviewMediaPolicy(brand);
  const run = <T>(fn: () => T): T => inSeam({ brand, stack }, fn);
  return {
    id,
    brand,
    ...(stack ? { stack } : {}),
    media,
    isConfigured: () => run(() => isLiveKitConfigured(brand)),
    agentName: () => run(() => getInterviewAgentName(brand)),
    createRoom: (params) => run(() => createInterviewRoom(params)),
    dispatchAgent: (params) =>
      run(() => dispatchAgent({ roomName: params.roomName, agentName: getInterviewAgentName(brand), metadata: params.metadata })),
    mintClientToken: (params) =>
      run(() => mintJoinToken({ ...params, allowVideo: params.allowVideo && media.cameraPublish })),
    sendEndSignal: (roomName) => run(() => sendInterviewEndSignal(roomName)),
    deleteRoom: (roomName) => run(() => deleteInterviewRoom(roomName)),
    startRecording: (params) =>
      run(() => startRoomRecording({ ...params, audioOnly: params.audioOnly || !media.recordVideo })),
    stopRecording: (egressId) => run(() => stopRecording(egressId)),
    verifyWebhook: async (rawBody, authHeader) => {
      const received = await receiveBrandWebhook(rawBody, authHeader);
      // The key of THIS plane: two brands on one project share it, so the
      // signer is checked by key, not by brand.
      const expected = run(() => getLiveKitCreds(brand).apiKey);
      if (received.apiKey !== expected) {
        throw new Error(`webhook was signed by another LiveKit project than the one ${brand} runs this session on`);
      }
      return received.event;
    },
  };
}

/** livekit_cloud: LiveKit Cloud (the shared project for both brands, or a GoApply project of its own). */
export function livekitCloudProvider(brand: BrandId, stack?: VoiceStack): VoiceSessionProvider {
  return createLiveKitProvider(brand, 'livekit_cloud', stack);
}
