// server/src/platform/email/transports/aliyunDirectMail.ts
//
// Aliyun DirectMail transport for GoApply (`CN_EMAIL_TRANSPORT=aliyun_dm`;
// CN_TW_LAUNCH_PLAN.md §2.1, §5.2; ARCHITECTURE.md §8.1; TASK_PLAN.md WP-15).
// platform/email/EmailService.ts registers it statically under 'aliyun_dm'.
//
// API: `SingleSendMail` (RPC style, version 2015-11-23), POSTed as a form to
// `https://dm.aliyuncs.com/` (region cn-hangzhou) or `dm.<region>.aliyuncs.com`.
// Requests are signed with the Aliyun RPC signature v1 (HMAC-SHA1 over the
// canonicalized, percent-encoded, sorted parameters; key = secret + "&").
//
// Credentials are vendor keys read unprefixed (R-03): ALIYUN_DM_ACCESS_KEY_ID,
// ALIYUN_DM_ACCESS_KEY_SECRET, ALIYUN_DM_ACCOUNT_NAME (the verified sender
// address, e.g. noreply@mail.goapply.top), optional ALIYUN_DM_REGION
// (default cn-hangzhou). The From display name comes from the message
// (`GoApply <…>` → FromAlias); the address is always the configured account,
// because DirectMail only sends from verified sender addresses.
//
// Limits of this API that callers should know: custom headers (e.g. RFC 8058
// `List-Unsubscribe`) are not sent — the unsubscribe link in the email body
// still works; Reply-To uses the reply address configured for the sender in
// the Aliyun console (`ReplyToAddress=true`) when the message has one.

import { createHmac, randomUUID } from 'node:crypto';
import type { EmailMessage, EmailTransport, TransportResult } from './resend.js';

export const ALIYUN_DM_TRANSPORT_NAME = 'aliyun_dm';
export const ALIYUN_DM_API_VERSION = '2015-11-23';
export const ALIYUN_DM_DEFAULT_REGION = 'cn-hangzhou';

export interface AliyunDmTransportOptions {
  accessKeyId?: string;
  accessKeySecret?: string;
  accountName?: string;
  region?: string;
  fetchImpl?: typeof fetch;
  /** Full endpoint URL override (tests). */
  endpoint?: string;
  /** Fixed clock and nonce (tests). */
  now?: () => Date;
  nonce?: () => string;
  /** Read env at send time (default process.env). */
  env?: Record<string, string | undefined>;
}

/**
 * Aliyun POP percent-encoding: RFC 3986 unreserved characters
 * (A–Z a–z 0–9 - _ . ~) stay; everything else is %XX (uppercase), spaces
 * become %20 (never "+").
 */
export function aliyunPercentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Sorted, encoded `k=v&k=v` string (the canonicalized query string). */
export function canonicalizeParams(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${aliyunPercentEncode(k)}=${aliyunPercentEncode(params[k]!)}`)
    .join('&');
}

/** `METHOD&%2F&encode(canonicalized)` */
export function stringToSign(method: 'GET' | 'POST', params: Record<string, string>): string {
  return `${method}&${aliyunPercentEncode('/')}&${aliyunPercentEncode(canonicalizeParams(params))}`;
}

/** Base64 HMAC-SHA1 of the string to sign, keyed with `secret + "&"`. */
export function signAliyunRpc(method: 'GET' | 'POST', params: Record<string, string>, accessKeySecret: string): string {
  return createHmac('sha1', `${accessKeySecret}&`).update(stringToSign(method, params)).digest('base64');
}

/** ISO 8601 UTC without milliseconds: 2026-10-10T08:00:00Z. */
export function aliyunTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function aliyunDmEndpoint(region: string | undefined): string {
  const r = (region ?? '').trim().toLowerCase() || ALIYUN_DM_DEFAULT_REGION;
  return r === ALIYUN_DM_DEFAULT_REGION ? 'https://dm.aliyuncs.com/' : `https://dm.${r}.aliyuncs.com/`;
}

/** Display name from `Name <a@b.c>` (quotes removed), or '' for a bare address. */
export function displayNameOf(from: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<[^<>]+>\s*$/.exec(from ?? '');
  return m ? m[1]!.trim() : '';
}

export interface BuiltDmRequest {
  url: string;
  params: Record<string, string>;
  body: string;
}

/** Build the signed SingleSendMail request (pure; exported for the fixture test). */
export function buildSingleSendMailRequest(input: {
  message: EmailMessage;
  accessKeyId: string;
  accessKeySecret: string;
  accountName: string;
  region?: string;
  endpoint?: string;
  timestamp: Date;
  nonce: string;
}): BuiltDmRequest {
  const region = (input.region ?? '').trim() || ALIYUN_DM_DEFAULT_REGION;
  const { message } = input;
  const params: Record<string, string> = {
    Action: 'SingleSendMail',
    Format: 'JSON',
    Version: ALIYUN_DM_API_VERSION,
    AccessKeyId: input.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: input.nonce,
    Timestamp: aliyunTimestamp(input.timestamp),
    RegionId: region,
    AccountName: input.accountName,
    AddressType: '1',
    ReplyToAddress: message.replyTo ? 'true' : 'false',
    ToAddress: message.to.join(','),
    Subject: message.subject,
    HtmlBody: message.html,
  };
  const alias = displayNameOf(message.from);
  if (alias) params.FromAlias = alias;
  if (message.text) params.TextBody = message.text;
  const signature = signAliyunRpc('POST', params, input.accessKeySecret);
  const signed = { ...params, Signature: signature };
  return {
    url: input.endpoint ?? aliyunDmEndpoint(region),
    params: signed,
    body: canonicalizeParams(signed),
  };
}

export function createAliyunDmTransport(options: AliyunDmTransportOptions = {}): EmailTransport {
  const env = () => options.env ?? process.env;
  const read = (explicit: string | undefined, name: string) => (explicit ?? env()[name] ?? '').trim();
  const accessKeyId = () => read(options.accessKeyId, 'ALIYUN_DM_ACCESS_KEY_ID');
  const accessKeySecret = () => read(options.accessKeySecret, 'ALIYUN_DM_ACCESS_KEY_SECRET');
  const accountName = () => read(options.accountName, 'ALIYUN_DM_ACCOUNT_NAME');
  const region = () => read(options.region, 'ALIYUN_DM_REGION') || ALIYUN_DM_DEFAULT_REGION;
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  return {
    name: ALIYUN_DM_TRANSPORT_NAME,
    isConfigured: () => Boolean(accessKeyId() && accessKeySecret() && accountName()),
    async send(message: EmailMessage): Promise<TransportResult> {
      if (!accessKeyId() || !accessKeySecret() || !accountName()) return { ok: false, error: 'not_configured' };
      if (!message.to.length) return { ok: false, error: 'no_recipients' };
      const req = buildSingleSendMailRequest({
        message,
        accessKeyId: accessKeyId(),
        accessKeySecret: accessKeySecret(),
        accountName: accountName(),
        region: region(),
        endpoint: options.endpoint,
        timestamp: options.now?.() ?? new Date(),
        nonce: options.nonce?.() ?? randomUUID(),
      });
      try {
        const res = await doFetch(req.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', Accept: 'application/json' },
          body: req.body,
        });
        const json = (await res.json().catch(() => null)) as
          | { EnvId?: unknown; RequestId?: unknown; Code?: unknown; Message?: unknown }
          | null;
        if (!res.ok || (json && typeof json.Code === 'string' && json.Code && !json.EnvId)) {
          const code = typeof json?.Code === 'string' ? json.Code : `http_${res.status}`;
          const msg = typeof json?.Message === 'string' ? `: ${json.Message.slice(0, 300)}` : '';
          return { ok: false, status: res.status, error: `aliyun_dm_${code}${msg}` };
        }
        const providerId =
          typeof json?.EnvId === 'string' || typeof json?.EnvId === 'number'
            ? String(json.EnvId)
            : typeof json?.RequestId === 'string'
              ? json.RequestId
              : undefined;
        return { ok: true, providerId };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
