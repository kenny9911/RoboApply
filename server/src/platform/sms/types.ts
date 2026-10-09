// server/src/platform/sms/types.ts — the SMS provider seam (TASK_PLAN.md WP-11;
// CN_TW_LAUNCH_PLAN.md §5.2, CN-L-07).
//
// One message kind only: a one-time sign-in code. The text the person
// receives is the provider's registered signature (the brand name) plus the
// registered OTP template, which carries the code and nothing else — no
// links, no marketing (carrier rules, CN-L-07). Providers never receive any
// other personal data than the phone number and the code.

import type { EnvSource } from '../brand/brandEnv.js';

export type SmsProviderId = 'aliyun' | 'tencent' | 'dev_console';

export interface OtpSms {
  /** E.164, e.g. `+8613812345678`. */
  phoneE164: string;
  /** The 6-digit code. */
  code: string;
  /** Brand name (the dev console prints it as the signature; real providers use their registered signature). */
  brandName: string;
}

export interface SmsSendResult {
  ok: boolean;
  provider: SmsProviderId;
  /** Provider message/request id when the provider returned one. */
  providerMessageId?: string;
  /** Provider error code when `ok` is false (never shown to users). */
  errorCode?: string;
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface SmsProviderDeps {
  env: EnvSource;
  fetch: FetchLike;
  now: () => Date;
  /** Log sink (dev console prints the code here). */
  log: (line: string) => void;
}

export interface SmsProvider {
  id: SmsProviderId;
  sendOtp(message: OtpSms): Promise<SmsSendResult>;
}

/** Thrown when no provider is usable (should not happen behind the `auth.phoneOtp` gate). */
export class SmsNotConfiguredError extends Error {
  constructor() {
    super('No SMS provider is configured.');
    this.name = 'SmsNotConfiguredError';
  }
}

/** Mask a phone for logs: `+86138****5678`. */
export function maskPhone(phoneE164: string): string {
  if (phoneE164.length < 8) return '****';
  return `${phoneE164.slice(0, phoneE164.length - 8)}****${phoneE164.slice(-4)}`;
}

/** The national number without `+86` (mainland providers want it bare). */
export function nationalNumber(phoneE164: string): string {
  return phoneE164.startsWith('+86') ? phoneE164.slice(3) : phoneE164.replace(/^\+/, '');
}
