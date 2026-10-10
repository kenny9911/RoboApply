// server/src/platform/email/index.ts — public surface of the email platform.

export {
  addressOf,
  classifyAddress,
  emailOrigin,
  fromFor,
  platformEmailService,
  registerEmailTransport,
  replyToFor,
  resetEmailTransportsForTests,
  sendEmail,
  setEmailPreferenceGate,
  transportFor,
  transportNameFor,
} from './EmailService.js';
export type {
  EmailDb,
  EmailPreferenceGate,
  EmailTransportName,
  EmailServiceDeps,
  SendEmailInput,
  SendEmailResult,
  SendStatus,
  SuppressReason,
} from './EmailService.js';
export {
  EMAIL_LOCALES,
  EmailI18nError,
  createEmailTranslator,
  emailI18nDir,
  formatMessage,
  isValidMessage,
  loadEmailMessages,
  loadEnglishWithStaging,
  mergeMessages,
  normalizeEmailLocale,
  resetEmailI18nCache,
  setEmailI18nDirForTests,
  substituteBrand,
} from './i18n.js';
export type { EmailTranslator, MessageParams, Messages } from './i18n.js';
export {
  UNSUBSCRIBE_LISTS,
  UnsubscribeConfigError,
  createUnsubscribeToken,
  hashEmail,
  listUnsubscribeHeaders,
  unsubscribeUrls,
  verifyUnsubscribeToken,
} from './unsubscribe.js';
export type { UnsubscribeList, UnsubscribePayload, VerifyResult } from './unsubscribe.js';
export { button, escapeHtml, heading, legalFooter, paragraph, renderShell, safeUrl } from './templates/_shell.js';
export type { EmailCategory, ShellInput, ShellOutput } from './templates/_shell.js';
export {
  defaultListFor,
  defineEmailTemplate,
  getEmailTemplate,
  registerEmailTemplate,
  registeredEmailTemplates,
} from './templates/registry.js';
export type { EmailTemplate, TemplateBody, TemplateContext } from './templates/registry.js';
export { createResendTransport, resendTransport } from './transports/resend.js';
export type { EmailMessage, EmailTransport, TransportResult } from './transports/resend.js';

/** Payload of the `email.send` work item (enqueued by producers, delivered by WP-39a's worker). */
export interface EmailSendPayload {
  template: string;
  /** Either an explicit address or a user id the worker resolves (the worker skips placeholder addresses). */
  to?: string;
  userId?: string | null;
  locale?: string | null;
  params: Record<string, unknown>;
}

export const EMAIL_SEND_KIND = 'email.send';
