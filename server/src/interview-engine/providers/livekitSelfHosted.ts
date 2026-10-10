// server/src/interview-engine/providers/livekitSelfHosted.ts
//
// livekit_selfhosted: a LiveKit server we run ourselves (GoApply CN-1, an ICP
// domain in Shanghai with TURN/TLS on 443). The server API is the same
// protocol as LiveKit Cloud, so the provider is the LiveKit provider pointed
// at the brand's own URL (CN_LIVEKIT_URL); egress writes to the brand's
// bucket (CN_S3_*). The worker side (DashScope STT/TTS, domestic LLM) is
// WP-63b's interview-agent backend.

import type { BrandId } from '../../platform/brand/registry.js';
import { createLiveKitProvider } from './livekitCloud.js';
import type { VoiceSessionProvider } from './types.js';

export function livekitSelfHostedProvider(brand: BrandId): VoiceSessionProvider {
  return createLiveKitProvider(brand, 'livekit_selfhosted');
}
