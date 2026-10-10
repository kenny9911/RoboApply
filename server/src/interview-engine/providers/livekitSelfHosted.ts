// server/src/interview-engine/providers/livekitSelfHosted.ts
//
// livekit_selfhosted: a LiveKit server we run ourselves (an optional GoApply
// plane in the mainland, with TURN/TLS on 443). The server API is the same
// protocol as LiveKit Cloud, so the provider is the LiveKit provider pointed
// at the URL of the plane in use: VOICE_PROVIDER=livekit_selfhosted selects it
// for the shared plane, CN_VOICE_PROVIDER (read only together with
// CN_LIVEKIT_URL) for GoApply's own. Egress writes to the brand's bucket (the
// `storage` group). The worker side (DashScope STT/TTS, a domestic LLM) is the
// interview-agent backend switch.

import type { BrandId } from '../../platform/brand/registry.js';
import type { VoiceStack } from '../config.js';
import { createLiveKitProvider } from './livekitCloud.js';
import type { VoiceSessionProvider } from './types.js';

export function livekitSelfHostedProvider(brand: BrandId, stack?: VoiceStack): VoiceSessionProvider {
  return createLiveKitProvider(brand, 'livekit_selfhosted', stack);
}
