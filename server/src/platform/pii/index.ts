// server/src/platform/pii/index.ts — public surface of the PII redaction helpers (WP-15).
export {
  ALL_PII_KINDS,
  CN0_STORAGE_PII_KINDS,
  GOVERNMENT_ID_KINDS,
  LLM_PII_KINDS,
  detectPii,
  isValidPrcId,
  isValidTwNationalId,
  knownValuePattern,
  markerLocaleFor,
  redactDeep,
  redactPii,
  redactText,
  redactionMarker,
} from './redact.js';
export type {
  PiiCounts,
  PiiKind,
  RedactDeepResult,
  RedactOptions,
  RedactResult,
  RedactionMarkerLocale,
} from './redact.js';
