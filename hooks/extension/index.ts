// hooks/extension — the extension's web-side hooks (WP-55a).

export {
  useExtStatus,
  useExtensionPresence,
  usePairBrowser,
  usePairCode,
  useRevokeDevice,
  useUninstallSurvey,
  type ExtensionPresence,
} from './useExtension';
export { useSensitiveFillConsent } from './useSensitiveFillConsent';
export {
  EXTENSION_ATS_BY_BRAND,
  EXTENSION_PER_PAGE_ATS,
  __setExtensionBridge,
  browserSupport,
  extensionFillsAts,
  extensionIdFor,
  extensionStoreUrl,
  isBelowMinVersion,
  pingExtension,
  sendPairToken,
  type ExtensionBridge,
} from './bridge';
