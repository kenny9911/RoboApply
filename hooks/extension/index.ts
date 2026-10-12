// hooks/extension — the extension's web-side hooks (WP-55a).

export {
  EXT_STATUS_QUERY_KEY,
  deviceNameFromAgent,
  useExtStatus,
  useExtensionPresence,
  usePairBrowser,
  usePairCode,
  useRevokeDevice,
  useUninstallSurvey,
  type ExtensionPresence,
  type ExtensionPresenceState,
} from './useExtension';
export { SENSITIVE_FILL_CONSENT, useSensitiveFillConsent } from './useSensitiveFillConsent';
export {
  EXTENSION_ATS_BY_BRAND,
  EXTENSION_PER_PAGE_ATS,
  __setExtensionBridge,
  browserSupport,
  compareVersions,
  extensionFillsAts,
  extensionIdFor,
  extensionStoreUrl,
  isBelowMinVersion,
  pingExtension,
  sendPairToken,
  type BrowserSupport,
  type ExtensionBridge,
} from './bridge';
