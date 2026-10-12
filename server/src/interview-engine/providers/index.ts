// server/src/interview-engine/providers/index.ts — public surface of the
// per-brand voice seam (WP-63a; ARCHITECTURE.md §1.9; CN-E-06).
//
//   const provider = voiceProviderFor(seam);      // the session's media plane
//   await provider.createRoom({ roomName, metadata });
//
// The provider id comes from VOICE_PROVIDER on the shared plane (both brands)
// and from CN_VOICE_PROVIDER on GoApply's own plane (CN_LIVEKIT_URL set);
// default livekit_cloud. `volcano` and `trtc` are reserved: they throw
// VoiceProviderNotImplementedError (503) and voiceAvailable() is false.
//
// D5 (GOAPPLY_PARITY_PLAN §3.5): with no CN_LIVEKIT_URL GoApply runs on the
// shared LiveKit project, with the shared worker and its agent name. A session
// stores the plane it was created on (`seam.stack`) and keeps it.

import { getBrand, type BrandId } from '../../platform/brand/registry.js';
import { brandStack } from '../../platform/brand/brandEnv.js';
import { getVoiceProviderId, type VoiceProviderId, type VoiceStack } from '../config.js';
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
  readRowSeam,
  readStoredVoiceSeam,
  readVoiceSeam,
  resolveSessionSeam,
  voiceSeamColumns,
  voiceSeamMetrics,
  type OwnerBrandLookup,
  type SessionSeamRow,
  type VoiceSeam,
} from './sessionSeam.js';
export { inBrand, inSeam } from './brandScope.js';
export { assertBrandSpeech, resolveBrandSessionStt, resolveBrandSessionVoice, resolveBrandStt, resolveBrandVoice } from './speech.js';

/** Provider ids with an implementation. The reserved ones are never capabilities. */
export const IMPLEMENTED_VOICE_PROVIDERS: readonly VoiceProviderId[] = ['livekit_cloud', 'livekit_selfhosted'];

export function isImplementedVoiceProvider(id: VoiceProviderId): boolean {
  return IMPLEMENTED_VOICE_PROVIDERS.includes(id);
}

/** A provider by id for a brand (and, for a stored session, its plane). Throws VoiceProviderNotImplementedError for volcano / trtc. */
export function createVoiceProvider(id: VoiceProviderId, brand: BrandId, stack?: VoiceStack): VoiceSessionProvider {
  switch (id) {
    case 'livekit_cloud':
      return livekitCloudProvider(brand, stack);
    case 'livekit_selfhosted':
      return livekitSelfHostedProvider(brand, stack);
    default:
      throw new VoiceProviderNotImplementedError(id, brand);
  }
}

/** The provider a NEW session of this brand runs on (from env, at call time). */
export function getVoiceProvider(brand: BrandId): VoiceSessionProvider {
  return voiceProviderFor(voiceSeamForBrand(brand));
}

/** The provider an existing session runs on (from its stored seam, plane included). */
export function voiceProviderFor(seam: VoiceSeam): VoiceSessionProvider {
  return createVoiceProvider(seam.provider, seam.brand, seam.stack);
}

/**
 * The seam a new session of this brand gets. GoApply's records its plane
 * (`stack`), so the session stays on it; RoboApply is always on the shared
 * plane and stores nothing (its rows are unchanged).
 */
export function voiceSeamForBrand(brand: BrandId): VoiceSeam {
  // The plane the environment selects NOW (never a plane pinned for other work).
  const stack = brandStack(brand, 'voice');
  const provider = getVoiceProviderId(brand, stack);
  return getBrand(brand).market === 'cn' ? { brand, provider, stack } : { brand, provider };
}

/**
 * The media plane can run a live session for this brand: an implemented
 * provider is selected and the credentials of the plane in use are present
 * (the shared LiveKit project, or GoApply's own when CN_LIVEKIT_URL is set;
 * a half-set own plane is not configured, never mixed with the shared keys).
 * The capability (`ai.interviewVoice`, platform/flags.ts: registry switch +
 * the same credentials) still decides whether the product offers voice; this
 * adds the provider check it cannot see (volcano / trtc → false).
 */
export function voiceAvailable(brand: BrandId): boolean {
  const id = getVoiceProviderId(brand);
  if (!isImplementedVoiceProvider(id)) return false;
  return createVoiceProvider(id, brand).isConfigured();
}
