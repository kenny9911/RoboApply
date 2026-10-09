// server/src/platform/sms/providers/tencent.ts — Tencent Cloud SMS (API 3.0, 2021-01-11).
//
// `SendSms` signed with TC3-HMAC-SHA256, sent with fetch: no SDK dependency.
// Env (CN_TW_LAUNCH_PLAN.md §5.2): TENCENT_SMS_SECRET_ID, TENCENT_SMS_SECRET_KEY,
// TENCENT_SMS_SDK_APP_ID, TENCENT_SMS_SIGN_NAME (brand name / trademark),
// TENCENT_SMS_TEMPLATE_OTP (template whose only parameter is the code, no link).

import crypto from 'node:crypto';
import type { OtpSms, SmsProvider, SmsProviderDeps, SmsSendResult } from '../types.js';

export const TENCENT_SMS_HOST = 'sms.tencentcloudapi.com';
const SERVICE = 'sms';
const VERSION = '2021-01-11';
const REGION = 'ap-guangzhou';
const CONTENT_TYPE = 'application/json; charset=utf-8';

const sha256hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key: crypto.BinaryLike, s: string) => crypto.createHmac('sha256', key).update(s).digest();

export interface TencentSignedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Builds the signed request (pure; exported for the test). */
export function buildTencentSendRequest(message: OtpSms, deps: Pick<SmsProviderDeps, 'env' | 'now'>): TencentSignedRequest {
  const env = deps.env;
  const body = JSON.stringify({
    PhoneNumberSet: [message.phoneE164],
    SmsSdkAppId: env.TENCENT_SMS_SDK_APP_ID ?? '',
    SignName: env.TENCENT_SMS_SIGN_NAME ?? '',
    TemplateId: env.TENCENT_SMS_TEMPLATE_OTP ?? '',
    TemplateParamSet: [message.code],
  });
  const timestamp = Math.floor(deps.now().getTime() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalRequest = ['POST', '/', '', `content-type:${CONTENT_TYPE}\nhost:${TENCENT_SMS_HOST}\n`, 'content-type;host', sha256hex(body)].join(
    '\n',
  );
  const scope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), scope, sha256hex(canonicalRequest)].join('\n');
  const secretDate = hmac(`TC3${env.TENCENT_SMS_SECRET_KEY ?? ''}`, date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex');
  return {
    url: `https://${TENCENT_SMS_HOST}`,
    body,
    headers: {
      Authorization: `TC3-HMAC-SHA256 Credential=${env.TENCENT_SMS_SECRET_ID ?? ''}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
      'Content-Type': CONTENT_TYPE,
      Host: TENCENT_SMS_HOST,
      'X-TC-Action': 'SendSms',
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': VERSION,
      'X-TC-Region': REGION,
    },
  };
}

interface TencentResponse {
  Response?: {
    SendStatusSet?: Array<{ Code?: string; SerialNo?: string }>;
    Error?: { Code?: string };
    RequestId?: string;
  };
}

export function createTencentProvider(deps: SmsProviderDeps): SmsProvider {
  return {
    id: 'tencent',
    async sendOtp(message: OtpSms): Promise<SmsSendResult> {
      const req = buildTencentSendRequest(message, deps);
      try {
        const res = await deps.fetch(req.url, { method: 'POST', headers: req.headers, body: req.body });
        const parsed = JSON.parse((await res.text()) || '{}') as TencentResponse;
        const status = parsed.Response?.SendStatusSet?.[0];
        if (res.ok && status?.Code === 'Ok') {
          return { ok: true, provider: 'tencent', providerMessageId: status.SerialNo ?? parsed.Response?.RequestId };
        }
        return { ok: false, provider: 'tencent', errorCode: parsed.Response?.Error?.Code ?? status?.Code ?? `http_${res.status}` };
      } catch {
        return { ok: false, provider: 'tencent', errorCode: 'network_error' };
      }
    },
  };
}
