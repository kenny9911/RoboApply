// server/src/platform/sms/providers/aliyun.ts — Aliyun SMS (Dysmsapi 2017-05-25).
//
// RPC-style `SendSms` signed with HMAC-SHA1 (signature version 1.0), sent with
// fetch: no SDK dependency. Env (CN_TW_LAUNCH_PLAN.md §5.2):
//   ALIYUN_SMS_ACCESS_KEY_ID, ALIYUN_SMS_ACCESS_KEY_SECRET,
//   ALIYUN_SMS_SIGN_NAME (the brand name / registered trademark),
//   ALIYUN_SMS_TEMPLATE_OTP (template whose only variable is ${code}, no link).

import crypto from 'node:crypto';
import { nationalNumber, type OtpSms, type SmsProvider, type SmsProviderDeps, type SmsSendResult } from '../types.js';

export const ALIYUN_SMS_ENDPOINT = 'https://dysmsapi.aliyuncs.com/';

/** RFC 3986 percent-encoding as Aliyun's POP signature requires. */
export function aliyunPercentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

/** `YYYY-MM-DDThh:mm:ssZ` (UTC, no milliseconds). */
function aliyunTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Signs the parameter set (pure; exported for the test). */
export function signAliyunParams(params: Record<string, string>, secret: string, method = 'GET'): string {
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${aliyunPercentEncode(k)}=${aliyunPercentEncode(params[k]!)}`)
    .join('&');
  const stringToSign = `${method}&${aliyunPercentEncode('/')}&${aliyunPercentEncode(canonical)}`;
  return crypto.createHmac('sha1', `${secret}&`).update(stringToSign).digest('base64');
}

export function buildAliyunSendUrl(message: OtpSms, deps: Pick<SmsProviderDeps, 'env' | 'now'>, nonce: string): string {
  const env = deps.env;
  const params: Record<string, string> = {
    AccessKeyId: env.ALIYUN_SMS_ACCESS_KEY_ID ?? '',
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: nationalNumber(message.phoneE164),
    RegionId: 'cn-hangzhou',
    SignName: env.ALIYUN_SMS_SIGN_NAME ?? '',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: nonce,
    SignatureVersion: '1.0',
    TemplateCode: env.ALIYUN_SMS_TEMPLATE_OTP ?? '',
    TemplateParam: JSON.stringify({ code: message.code }),
    Timestamp: aliyunTimestamp(deps.now()),
    Version: '2017-05-25',
  };
  const signature = signAliyunParams(params, env.ALIYUN_SMS_ACCESS_KEY_SECRET ?? '');
  const query = Object.entries({ Signature: signature, ...params })
    .map(([k, v]) => `${aliyunPercentEncode(k)}=${aliyunPercentEncode(v)}`)
    .join('&');
  return `${ALIYUN_SMS_ENDPOINT}?${query}`;
}

export function createAliyunProvider(deps: SmsProviderDeps): SmsProvider {
  return {
    id: 'aliyun',
    async sendOtp(message: OtpSms): Promise<SmsSendResult> {
      const url = buildAliyunSendUrl(message, deps, crypto.randomUUID());
      try {
        const res = await deps.fetch(url, { method: 'GET' });
        const body = JSON.parse((await res.text()) || '{}') as { Code?: string; BizId?: string; RequestId?: string };
        if (res.ok && body.Code === 'OK') {
          return { ok: true, provider: 'aliyun', providerMessageId: body.BizId ?? body.RequestId };
        }
        return { ok: false, provider: 'aliyun', errorCode: body.Code ?? `http_${res.status}` };
      } catch {
        return { ok: false, provider: 'aliyun', errorCode: 'network_error' };
      }
    },
  };
}
