// server/src/interview-engine/providers/brandScope.ts
//
// Run work inside a brand's unit of work. Every brand-aware reader below the
// provider (LiveKit creds, S3 creds, LLM routing, content safety) reads the
// brand of the current unit of work, so session work that can arrive from
// anywhere — a webhook on the other brand's host, a cron, a callback — must
// run in the SESSION's brand.
//
// When the current unit of work already is that brand, `fn` runs as is, so a
// RoboApply request keeps its request id, user and BYOK flags exactly as in
// Wave 0.

import { getCurrentBrandId, runWithBrand } from '../../lib/requestContext.js';
import type { BrandId } from '../../platform/brand/registry.js';
import { runOnVoiceStack, type VoiceStack } from '../config.js';

function currentBrandId(): BrandId | undefined {
  try {
    return getCurrentBrandId();
  } catch {
    return undefined;
  }
}

export function inBrand<T>(brand: BrandId, fn: () => T): T {
  return currentBrandId() === brand ? fn() : runWithBrand(brand, fn);
}

/**
 * Run session work inside the session's brand AND on the media plane it was
 * created on (`seam.stack`): LiveKit credentials, the agent name, the callback
 * secret and base URL are then read from that plane for the whole call, so a
 * CN_LIVEKIT_* value added or removed while the session is live does not move
 * it. A seam with no stored stack runs on the plane the environment selects.
 */
export function inSeam<T>(seam: { brand: BrandId; stack?: VoiceStack }, fn: () => T): T {
  return inBrand(seam.brand, () => runOnVoiceStack(seam.brand, seam.stack, fn));
}
