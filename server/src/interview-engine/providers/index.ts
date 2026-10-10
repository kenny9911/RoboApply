// server/src/interview-engine/providers/index.ts — public surface of the
// per-brand voice seam (WP-63a; ARCHITECTURE.md §1.9; CN-E-06).
//
//   const provider = voiceProviderFor(seam);      // the session's media plane
//   await provider.createRoom({ roomName, metadata });
//
// The provider id comes from VOICE_PROVIDER (RoboApply) / CN_VOICE_PROVIDER
// (GoApply), default livekit_cloud. `volcano` and `trtc` are reserved: they
// throw VoiceProviderNotImplementedError (503) and voiceAvailable() is false.

import type { BrandId } from '../../platform/brand/registry.js';
import { getVoiceProviderId, type VoiceProviderId } from '../config.js';
import { livekitCloudProvider } from './livekitCloud.js';
import { livekitSelfHostedProvider } from './livekitSelfHosted.js';
import { VoiceProviderNotImplementedError, type VoiceSessionProvider } from './types.js';
import type { VoiceSeam } from './sessionSeam.js';

export type { VoiceSessionProvider, ProviderJoinToken, ProviderRecording } from './types.js';
export { VoiceProviderNotImplementedError } from './types.js';
export { createLiveKitProvider, livekitCloudProvider } from './livekitCloud.js';
export { livekitSelfHostedProvider } from './livekitSelfHosted.js';
export {
  DEFAULT_VOICE_SEAM,
  VOICE_SEAM_KEY,
  isDefaultSeam,
  readVoiceSeam,
  voiceSeamMetrics,
  type VoiceSeam,
} from './sessionSeam.js';
export { inBrand } from './brandScope.js';
export { assertBrandSpeech, resolveBrandSessionVoice, resolveBrandStt, resolveBrandVoice } from './speech.js';

/** Provider ids with an implementation. The reserved ones are never capabilities. */
export const IMPLEMENTED_VOICE_PROVIDERS: readonly VoiceProviderId[] = ['livekit_cloud', 'livekit_selfhosted'];

export function isImplementedVoiceProvider(id: VoiceProviderId): boolean {
  return IMPLEMENTED_VOICE_PROVIDERS.includes(id);
}

/** A provider by id for a brand. Throws VoiceProviderNotImplementedError for volcano / trtc. */
export function createVoiceProvider(id: VoiceProviderId, brand: BrandId): VoiceSessionProvider {
  switch (id) {
    case 'livekit_cloud':
      return livekitCloudProvider(brand);
    case 'livekit_selfhosted':
      return livekitSelfHostedProvider(brand);
    default:
      throw new VoiceProviderNotImplementedError(id, brand);
  }
}

/** The provider a NEW session of this brand runs on (from env, at call time). */
export function getVoiceProvider(brand: BrandId): VoiceSessionProvider {
  return createVoiceProvider(getVoiceProviderId(brand), brand);
}

/** The provider an existing session runs on (from its stored seam). */
export function voiceProviderFor(seam: VoiceSeam): VoiceSessionProvider {
  return createVoiceProvider(seam.provider, seam.brand);
}

/** The seam a new session of this brand gets. */
export function voiceSeamForBrand(brand: BrandId): VoiceSeam {
  return { brand, provider: getVoiceProviderId(brand) };
}

/**
 * The media plane can run a live session for this brand: an implemented
 * provider is selected and its credentials are present. The capability
 * (`ai.interviewVoice`, platform/flags.ts: registry switch + the same
 * credentials) still decides whether the product offers voice; this adds the
 * provider check it cannot see (volcano / trtc → false).
 */
export function voiceAvailable(brand: BrandId): boolean {
  const id = getVoiceProviderId(brand);
  if (!isImplementedVoiceProvider(id)) return false;
  return createVoiceProvider(id, brand).isConfigured();
}
