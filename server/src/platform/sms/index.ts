// server/src/platform/sms/index.ts — public surface of the SMS platform (WP-11).

export { createSmsService, selectSmsProvider } from './SmsService.js';
export type { SmsService, SmsServiceOptions } from './SmsService.js';
export { maskPhone, nationalNumber, SmsNotConfiguredError } from './types.js';
export type { FetchLike, OtpSms, SmsProvider, SmsProviderId, SmsSendResult } from './types.js';
export { DevConsoleInProductionError } from './providers/devConsole.js';
