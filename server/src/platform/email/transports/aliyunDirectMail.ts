// server/src/platform/email/transports/aliyunDirectMail.ts
//
// Aliyun DirectMail transport for GoApply (`CN_EMAIL_TRANSPORT=aliyun_dm`;
// CN_TW_LAUNCH_PLAN.md §2.3; TASK_PLAN.md WP-15).
//
// STUB (FND repair, Wave 1). Owner: WP-15, who fills this file only.
// platform/email/EmailService.ts already registers it statically under
// 'aliyun_dm' next to 'resend', so no startup wiring is needed. Until it is
// filled, `isConfigured()` is false and GoApply sends with this transport are
// recorded as `suppressed: transport_not_configured` (never faked as sent).
// Credentials are vendor keys read unprefixed (R-03): ALIYUN_DM_ACCESS_KEY_ID,
// ALIYUN_DM_ACCESS_KEY_SECRET, ALIYUN_DM_ACCOUNT_NAME.

import type { EmailMessage, EmailTransport, TransportResult } from './resend.js';

export const ALIYUN_DM_TRANSPORT_NAME = 'aliyun_dm';

export interface AliyunDmTransportOptions {
  accessKeyId?: string;
  accessKeySecret?: string;
  accountName?: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

export function createAliyunDmTransport(_options: AliyunDmTransportOptions = {}): EmailTransport {
  return {
    name: ALIYUN_DM_TRANSPORT_NAME,
    isConfigured: () => false,
    async send(_message: EmailMessage): Promise<TransportResult> {
      return { ok: false, error: 'aliyun_dm transport is not implemented yet' };
    },
  };
}
