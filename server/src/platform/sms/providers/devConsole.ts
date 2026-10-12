// server/src/platform/sms/providers/devConsole.ts — local development only.
//
// Prints the code to the server log instead of sending an SMS. Refuses to run
// when NODE_ENV === 'production' (CN_TW_LAUNCH_PLAN.md §4.2 WP-AUTH-CN "Dev"),
// so a stray `SMS_DEV_CONSOLE=true` in production never prints codes.

import { maskPhone, type OtpSms, type SmsProvider, type SmsProviderDeps, type SmsSendResult } from '../types.js';

export class DevConsoleInProductionError extends Error {
  constructor() {
    super('The dev console SMS provider is disabled in production.');
    this.name = 'DevConsoleInProductionError';
  }
}

export function createDevConsoleProvider(deps: Pick<SmsProviderDeps, 'env' | 'log'>): SmsProvider {
  return {
    id: 'dev_console',
    async sendOtp(message: OtpSms): Promise<SmsSendResult> {
      if (deps.env.NODE_ENV === 'production') throw new DevConsoleInProductionError();
      // The same shape a real message has: signature + code, no link.
      deps.log(`[sms:dev] ${maskPhone(message.phoneE164)} ← 【${message.brandName}】验证码：${message.code}`);
      return { ok: true, provider: 'dev_console' };
    },
  };
}
