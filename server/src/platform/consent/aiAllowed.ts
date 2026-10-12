// server/src/platform/consent/aiAllowed.ts
//
// GoApply AI consent gate (TASK_PLAN.md §2.2, H4). Every LLM call made for a
// user goes through `aiAllowed(user)`:
//   - RoboApply (market intl): always true.
//   - GoApply  (market cn):   true only with a LIVE `ai_resume_parsing` grant —
//     the newest SeekerConsentRecord of that type (or its legacy alias
//     `ai_resume_parse`) has granted=true. A later revocation (granted=false)
//     turns it off. No profile or no record → false.
// The brand comes from the subject (`{ id, brand }`) when it carries one;
// otherwise from the user's stored `User.brand` — never from the ambient
// context, which silently defaults to RoboApply when unset (a legacy cron, a
// webhook, an unbranded queue item). A failed brand lookup fails closed.
// When false, MATCH falls back to the deterministic "Quick estimate" and COP,
// RES, CL, AGENT and EXT hide their AI actions (zero LLMService calls).

import { getBrand, parseBrandId, type ProductBrand } from '../brand/registry.js';
import { brandOfUser } from '../brand/userBrand.js';
import {
  consentTypeSpellings,
  type SeekerConsentType,
} from '../../roboapply/engine/lib/seekerConsentTypes.js';

export const AI_CONSENT_TYPE: SeekerConsentType = 'ai_resume_parsing';

export interface ConsentRecordLike {
  consentType: string;
  granted: boolean;
  createdAt: Date;
}

/** A user, a `{ id, brand }` pair, or a bare user id (brand then = the stored User.brand). */
export type AiConsentSubject = string | { id: string; brand?: string | null };

/** Returns the newest record for the user among `types`, or null. */
export type LatestConsentLookup = (userId: string, types: SeekerConsentType[]) => Promise<ConsentRecordLike | null>;

const prismaLookup: LatestConsentLookup = async (userId, types) => {
  const { default: prisma } = await import('../../lib/prisma.js');
  return prisma.seekerConsentRecord.findFirst({
    where: { seekerProfile: { userId }, consentType: { in: types } },
    orderBy: { createdAt: 'desc' },
    select: { consentType: true, granted: true, createdAt: true },
  });
};

let latestConsentLookup: LatestConsentLookup = prismaLookup;

/** Test seam: replace the record lookup (null restores the Prisma one). */
export function setConsentLookup(lookup: LatestConsentLookup | null): void {
  latestConsentLookup = lookup ?? prismaLookup;
}

/** Pure: is the newest record across `types` a grant? */
export function isConsentLive(records: ConsentRecordLike[], type: SeekerConsentType): boolean {
  const spellings = consentTypeSpellings(type) as string[];
  let newest: ConsentRecordLike | null = null;
  for (const r of records) {
    if (!spellings.includes(r.consentType)) continue;
    if (!newest || r.createdAt.getTime() >= newest.createdAt.getTime()) newest = r;
  }
  return newest?.granted === true;
}

/** True when the user's newest record of `type` (any spelling) is a grant. */
export async function hasLiveConsent(userId: string, type: SeekerConsentType): Promise<boolean> {
  const latest = await latestConsentLookup(userId, consentTypeSpellings(type));
  return latest?.granted === true;
}

/** The subject's brand: its own field, else the stored User.brand; null when unknown. */
async function brandOf(subject: AiConsentSubject, userId: string | undefined): Promise<ProductBrand | null> {
  if (typeof subject === 'object' && subject) {
    const id = parseBrandId(subject.brand);
    if (id) return getBrand(id);
  }
  if (!userId) return null;
  try {
    const stored = await brandOfUser(userId);
    return stored ? getBrand(stored) : null;
  } catch {
    return null;
  }
}

/**
 * May the product call an LLM with this user's data?
 * Fails closed: an unknown brand (no such user, lookup error) or a consent
 * lookup error on GoApply counts as "no".
 */
export async function aiAllowed(subject: AiConsentSubject): Promise<boolean> {
  const userId = typeof subject === 'string' ? subject : subject?.id;
  const brand = await brandOf(subject, userId);
  if (!brand) return false;
  if (brand.market !== 'cn') return true;
  if (!userId) return false;
  try {
    return await hasLiveConsent(userId, AI_CONSENT_TYPE);
  } catch {
    return false;
  }
}
