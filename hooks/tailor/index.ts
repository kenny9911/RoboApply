// hooks/tailor — tailor session hooks (WP-36a).

export {
  GENERATING_POLL_MS,
  sessionRefetchInterval,
  tailorErrorKind,
  tailorKeys,
  useCreateTailorSession,
  useFinalizeTailor,
  useTailorClaim,
  useTailorSession,
  type CreateTailorBody,
  type TailorErrorKind,
} from './useTailorSession';
export { useTailorAvailability, type TailorAvailability } from './useTailorAvailability';
export {
  DEFAULT_TAILOR_SECTIONS,
  TAILOR_SECTION_KEYS,
  readTailorPrefs,
  useTailorPrefs,
  writeTailorPrefs,
  type TailorPrefs,
  type TailorSectionKey,
} from './useTailorPrefs';
