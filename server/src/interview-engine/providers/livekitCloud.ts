// server/src/interview-engine/providers/livekitCloud.ts
//
// The LiveKit provider. It wraps Wave 0's LiveKit code (../livekit/) without
// changing it: each call runs inside the provider's brand, which is how
// getLiveKitCreds()/getR2Creds() pick LIVEKIT_* + S3_* (RoboApply) or
// CN_LIVEKIT_* + CN_S3_* (GoApply). The brand media policy is applied here.

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
  isLiveKitConfigured,
  type VoiceProviderId,
} from '../config.js';
import type { BrandId } from '../../platform/brand/registry.js';
import { inBrand } from './brandScope.js';
import type { VoiceSessionProvider } from './types.js';

export function createLiveKitProvider(
  brand: BrandId,
  id: Extract<VoiceProviderId, 'livekit_cloud' | 'livekit_selfhosted'> = 'livekit_cloud',
): VoiceSessionProvider {
  const media = getInterviewMediaPolicy(brand);
  const run = <T>(fn: () => T): T => inBrand(brand, fn);
  return {
    id,
    brand,
    media,
    isConfigured: () => isLiveKitConfigured(brand),
    agentName: () => getInterviewAgentName(brand),
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
      if (received.brand !== brand) throw new Error(`webhook was signed for brand ${received.brand}, not ${brand}`);
      return received.event;
    },
  };
}

/** livekit_cloud: LiveKit Cloud (RoboApply; GoApply CN-0 on its own Asia-region project). */
export function livekitCloudProvider(brand: BrandId): VoiceSessionProvider {
  return createLiveKitProvider(brand, 'livekit_cloud');
}
