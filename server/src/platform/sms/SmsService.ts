// server/src/platform/sms/SmsService.ts — picks the SMS provider from env
// (TASK_PLAN.md WP-11; CN_TW_LAUNCH_PLAN.md §5.2).
//
//   CN_SMS_PROVIDER=aliyun  + ALIYUN_SMS_*   → Aliyun
//   CN_SMS_PROVIDER=tencent + TENCENT_SMS_*  → Tencent Cloud
//   otherwise, NODE_ENV!=='production' and SMS_DEV_CONSOLE=true → dev console
//   otherwise → not configured (the `auth.phoneOtp` capability is off, so no
//   phone form renders and the routes answer 404 feature_disabled).
//
// The selection mirrors `smsConfigured()` in platform/flags.ts, so the
// capability and the service never disagree (test).

import { envSet, parseBoolEnv, type EnvSource } from '../brand/brandEnv.js';
import { logger } from '../../services/LoggerService.js';
import { createAliyunProvider } from './providers/aliyun.js';
import { createDevConsoleProvider } from './providers/devConsole.js';
import { createTencentProvider } from './providers/tencent.js';
import {
  maskPhone,
  SmsNotConfiguredError,
  type FetchLike,
  type OtpSms,
  type SmsProvider,
  type SmsProviderId,
  type SmsSendResult,
} from './types.js';

/** Which provider env selects (null = none usable). */
export function selectSmsProvider(env: EnvSource = process.env): SmsProviderId | null {
  const provider = (env.CN_SMS_PROVIDER || '').trim().toLowerCase();
  if (provider === 'aliyun') {
    return envSet(env, 'ALIYUN_SMS_ACCESS_KEY_ID', 'ALIYUN_SMS_ACCESS_KEY_SECRET', 'ALIYUN_SMS_SIGN_NAME', 'ALIYUN_SMS_TEMPLATE_OTP')
      ? 'aliyun'
      : null;
  }
  if (provider === 'tencent') {
    return envSet(env, 'TENCENT_SMS_SECRET_ID', 'TENCENT_SMS_SECRET_KEY', 'TENCENT_SMS_SDK_APP_ID', 'TENCENT_SMS_SIGN_NAME', 'TENCENT_SMS_TEMPLATE_OTP')
      ? 'tencent'
      : null;
  }
  return env.NODE_ENV !== 'production' && parseBoolEnv(env.SMS_DEV_CONSOLE) ? 'dev_console' : null;
}

export interface SmsServiceOptions {
  env?: EnvSource;
  fetch?: FetchLike;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface SmsService {
  readonly provider: SmsProviderId | null;
  readonly configured: boolean;
  /** Sends the one-time code. Throws SmsNotConfiguredError when no provider is usable. */
  sendOtp(message: OtpSms): Promise<SmsSendResult>;
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export function createSmsService(options: SmsServiceOptions = {}): SmsService {
  const env = options.env ?? process.env;
  const deps = {
    env,
    fetch: options.fetch ?? defaultFetch,
    now: options.now ?? (() => new Date()),
    // eslint-disable-next-line no-console
    log: options.log ?? ((line: string) => console.info(line)),
  };
  const id = selectSmsProvider(env);
  const provider: SmsProvider | null =
    id === 'aliyun'
      ? createAliyunProvider(deps)
      : id === 'tencent'
        ? createTencentProvider(deps)
        : id === 'dev_console'
          ? createDevConsoleProvider(deps)
          : null;
  return {
    provider: id,
    configured: provider !== null,
    async sendOtp(message: OtpSms): Promise<SmsSendResult> {
      if (!provider) throw new SmsNotConfiguredError();
      const result = await provider.sendOtp(message);
      if (!result.ok) {
        logger.warn('SMS', 'OTP send failed', { provider: result.provider, errorCode: result.errorCode, to: maskPhone(message.phoneE164) });
      }
      return result;
    },
  };
}
