// server/src/interview-engine/providers/sessionSeam.ts
//
// Which brand and provider a live session runs on, fixed at create so a later
// env change (or a webhook arriving on the other brand's host) never moves a
// running session to another media plane.
//
// Narrow typed adapter: stored at `InterviewSession.liveMetrics.voiceSeam`
// until the schema carries a first-class column (Schema request WP-63a-S1:
// `InterviewSession.brand String @default("roboapply")` + `voiceProvider String?`).
// Rows without it — every Wave 0 row and every default RoboApply session —
// read as RoboApply on LiveKit Cloud, so nothing is written for them and
// RoboApply rows stay byte-for-byte what Wave 0 wrote.

import { isBrandId, type BrandId } from '../../platform/brand/registry.js';
import { VOICE_PROVIDER_IDS, type VoiceProviderId } from '../config.js';

export interface VoiceSeam {
  brand: BrandId;
  provider: VoiceProviderId;
}

export const DEFAULT_VOICE_SEAM: Readonly<VoiceSeam> = Object.freeze({ brand: 'roboapply', provider: 'livekit_cloud' });

export const VOICE_SEAM_KEY = 'voiceSeam';

export function isDefaultSeam(seam: VoiceSeam): boolean {
  return seam.brand === DEFAULT_VOICE_SEAM.brand && seam.provider === DEFAULT_VOICE_SEAM.provider;
}

/** Read the seam from a session's liveMetrics (default when absent or malformed). */
export function readVoiceSeam(liveMetrics: unknown): VoiceSeam {
  if (!liveMetrics || typeof liveMetrics !== 'object' || Array.isArray(liveMetrics)) return { ...DEFAULT_VOICE_SEAM };
  const raw = (liveMetrics as Record<string, unknown>)[VOICE_SEAM_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_VOICE_SEAM };
  const r = raw as Record<string, unknown>;
  const brand = isBrandId(r.brand) ? r.brand : DEFAULT_VOICE_SEAM.brand;
  const provider = (VOICE_PROVIDER_IDS as readonly unknown[]).includes(r.provider)
    ? (r.provider as VoiceProviderId)
    : DEFAULT_VOICE_SEAM.provider;
  return { brand, provider };
}

/** The liveMetrics fragment to persist at create: empty for the default seam. */
export function voiceSeamMetrics(seam: VoiceSeam): Record<string, unknown> {
  return isDefaultSeam(seam) ? {} : { [VOICE_SEAM_KEY]: { v: 1, brand: seam.brand, provider: seam.provider } };
}
