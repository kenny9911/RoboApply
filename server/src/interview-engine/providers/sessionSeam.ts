// server/src/interview-engine/providers/sessionSeam.ts
//
// Which brand, provider and media plane a live session runs on, fixed at
// create so a later env change (or a webhook arriving on the other brand's
// host) never moves a running session to another media plane.
//
// `stack` (D5, plan §3.5) is the LiveKit plane: 'shared' = the project
// RoboApply uses, 'own' = GoApply's own (CN_LIVEKIT_*). It is stored in
// `liveMetrics.voiceSeam` for GoApply sessions (RoboApply is always on the
// shared plane, so its rows store nothing new). A row without it (created
// before the stack was stored) runs on the plane the environment selects now.
//
// Stored on the row since SCHEMA-4 (WP-63a-S1): `InterviewSession.brand` and
// `InterviewSession.voiceProvider`, written by every create. Readers resolve
// the seam in this order (`resolveSessionSeam`):
//   1. the columns, when `brand` is non-null;
//   2. else `liveMetrics.voiceSeam` (rows created between WP-63a and the
//      column writer; GoApply rows always carry it);
//   3. else the owner's `User.brand` (rows older than WP-63a carry neither).
// A null column is never read as 'roboapply': the brand picks the LLM settings,
// the bucket, the LiveKit plane, the worker secret and the content-safety rule.
// `liveMetrics.voiceSeam` is still written for non-default seams during the
// transition (no backfill DML; an older deploy reading a new row still finds
// the brand there).

import { isBrandId, type BrandId } from '../../platform/brand/registry.js';
import { brandOfUser } from '../../platform/brand/userBrand.js';
import { VOICE_PROVIDER_IDS, isVoiceStack, type VoiceProviderId, type VoiceStack } from '../config.js';

export interface VoiceSeam {
  brand: BrandId;
  provider: VoiceProviderId;
  /**
   * The LiveKit plane the session was created on. Absent for RoboApply (always
   * the shared plane) and for rows older than the stored stack: those run on
   * the plane the environment selects at the time of the call.
   */
  stack?: VoiceStack;
}

export const DEFAULT_VOICE_SEAM: Readonly<VoiceSeam> = Object.freeze({ brand: 'roboapply', provider: 'livekit_cloud' });

export const VOICE_SEAM_KEY = 'voiceSeam';

export function isDefaultSeam(seam: VoiceSeam): boolean {
  return seam.brand === DEFAULT_VOICE_SEAM.brand && seam.provider === DEFAULT_VOICE_SEAM.provider;
}

function asProvider(value: unknown): VoiceProviderId | null {
  return (VOICE_PROVIDER_IDS as readonly unknown[]).includes(value) ? (value as VoiceProviderId) : null;
}

/** The seam `liveMetrics.voiceSeam` records, or null when it records none (absent or malformed). */
export function readStoredVoiceSeam(liveMetrics: unknown): VoiceSeam | null {
  if (!liveMetrics || typeof liveMetrics !== 'object' || Array.isArray(liveMetrics)) return null;
  const raw = (liveMetrics as Record<string, unknown>)[VOICE_SEAM_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isBrandId(r.brand)) return null;
  return {
    brand: r.brand,
    provider: asProvider(r.provider) ?? DEFAULT_VOICE_SEAM.provider,
    ...(isVoiceStack(r.stack) ? { stack: r.stack } : {}),
  };
}

/**
 * Read the seam from liveMetrics alone (default when absent or malformed).
 * @deprecated A row without `voiceSeam` is NOT necessarily RoboApply: use
 * `resolveSessionSeam(row)`, which reads the columns first and falls back to
 * the owner's brand. Kept for callers that only hold liveMetrics.
 */
export function readVoiceSeam(liveMetrics: unknown): VoiceSeam {
  return readStoredVoiceSeam(liveMetrics) ?? { ...DEFAULT_VOICE_SEAM };
}

/** The columns and fields the seam is read from. */
export interface SessionSeamRow {
  brand?: string | null;
  voiceProvider?: string | null;
  liveMetrics?: unknown;
}

/**
 * The seam the row itself records: the SCHEMA-4 columns when `brand` is set,
 * else `liveMetrics.voiceSeam`. null = the row says nothing (a row older than
 * WP-63a): the caller must ask for the owner's brand, never assume one.
 */
export function readRowSeam(row: SessionSeamRow): VoiceSeam | null {
  const stored = readStoredVoiceSeam(row.liveMetrics);
  if (isBrandId(row.brand)) {
    const sameBrand = stored && stored.brand === row.brand ? stored : null;
    const provider =
      asProvider(row.voiceProvider) ??
      // A column brand without a provider: the JSON seam of the same brand, else LiveKit Cloud (schema: null = legacy).
      (sameBrand ? sameBrand.provider : DEFAULT_VOICE_SEAM.provider);
    // The plane has no column (no schema change in the parity wave): it is
    // read from the JSON seam of the same brand.
    return { brand: row.brand, provider, ...(sameBrand?.stack ? { stack: sameBrand.stack } : {}) };
  }
  return stored;
}

/** Resolves a user's brand; null when the user is unknown. */
export type OwnerBrandLookup = (userId: string) => Promise<BrandId | null>;

/**
 * The seam of a stored session: column → liveMetrics → the owner's
 * `User.brand`. A legacy row (no column, no JSON seam) of a GoApply user
 * resolves 'goapply', so its storage, LLM routing, LiveKit project and webhook
 * signer are GoApply's. Lookup errors propagate (never guess a brand). Only a
 * row whose owner no longer exists falls back to the default seam.
 */
export async function resolveSessionSeam(
  row: SessionSeamRow & { userId: string },
  lookup: OwnerBrandLookup = brandOfUser,
): Promise<VoiceSeam> {
  const own = readRowSeam(row);
  if (own) return own;
  const ownerBrand = await lookup(row.userId);
  // Rows this old predate provider selection: they ran on LiveKit Cloud.
  return ownerBrand ? { brand: ownerBrand, provider: DEFAULT_VOICE_SEAM.provider } : { ...DEFAULT_VOICE_SEAM };
}

/** The column values every create writes (SCHEMA-4, WP-63a-S1). */
export function voiceSeamColumns(seam: VoiceSeam): { brand: BrandId; voiceProvider: VoiceProviderId } {
  return { brand: seam.brand, voiceProvider: seam.provider };
}

/** The liveMetrics fragment to persist at create: empty for the default seam
 *  (RoboApply on LiveKit Cloud, always the shared plane). */
export function voiceSeamMetrics(seam: VoiceSeam): Record<string, unknown> {
  if (isDefaultSeam(seam)) return {};
  return { [VOICE_SEAM_KEY]: { v: 1, brand: seam.brand, provider: seam.provider, ...(seam.stack ? { stack: seam.stack } : {}) } };
}
