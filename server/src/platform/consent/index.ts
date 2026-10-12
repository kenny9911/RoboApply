// server/src/platform/consent/index.ts — public surface of the consent helpers.

export {
  AI_CONSENT_TYPE,
  aiAllowed,
  hasLiveConsent,
  isConsentLive,
  setConsentLookup,
} from './aiAllowed.js';
export type { AiConsentSubject, ConsentRecordLike, LatestConsentLookup } from './aiAllowed.js';
export { setUserBrandLookup } from '../brand/userBrand.js';
export {
  SEEKER_CONSENT_ALIASES,
  SEEKER_CONSENT_PROSE_VERSION,
  SEEKER_CONSENT_TYPES,
  canonicalConsentType,
  consentTypeSpellings,
  isSeekerConsentType,
} from '../../roboapply/engine/lib/seekerConsentTypes.js';
export type { SeekerConsentType } from '../../roboapply/engine/lib/seekerConsentTypes.js';
