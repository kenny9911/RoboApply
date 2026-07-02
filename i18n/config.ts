// Re-export of lib/i18n.ts for the conventional `/i18n/config` path used by
// frontend architecture docs.
export {
  LOCALES,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isLocale,
  loadMessages,
} from '../lib/i18n';
export type { RoboLocale } from '../lib/i18n';
