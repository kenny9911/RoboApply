// @vitest-environment node
//
// WP-11: SMS platform — provider selection agrees with the `auth.phoneOtp`
// capability, the dev console never prints in production, both providers
// sign their requests correctly, and the message carries only the brand
// signature and the code (no link). No network: fetch is a stub.

import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { getBrand } from '../brand/registry.js';
import { requirementsMet } from '../flags.js';
import { createSmsService, selectSmsProvider, maskPhone, nationalNumber, SmsNotConfiguredError, DevConsoleInProductionError } from './index.js';
import { buildAliyunSendUrl, signAliyunParams, aliyunPercentEncode, createAliyunProvider } from './providers/aliyun.js';
import { buildTencentSendRequest, createTencentProvider } from './providers/tencent.js';
import { createDevConsoleProvider } from './providers/devConsole.js';

const ALIYUN = {
  CN_SMS_PROVIDER: 'aliyun',
  ALIYUN_SMS_ACCESS_KEY_ID: 'AKID',
  ALIYUN_SMS_ACCESS_KEY_SECRET: 'SECRET',
  ALIYUN_SMS_SIGN_NAME: 'GoApply',
  ALIYUN_SMS_TEMPLATE_OTP: 'SMS_123',
};
const TENCENT = {
  CN_SMS_PROVIDER: 'tencent',
  TENCENT_SMS_SECRET_ID: 'SID',
  TENCENT_SMS_SECRET_KEY: 'SKEY',
  TENCENT_SMS_SDK_APP_ID: '1400000000',
  TENCENT_SMS_SIGN_NAME: 'GoApply',
  TENCENT_SMS_TEMPLATE_OTP: '100001',
};
const msg = { phoneE164: '+8613812345678', code: '042917', brandName: 'GoApply' };
const now = () => new Date('2026-10-10T08:00:00.000Z');

describe('selectSmsProvider', () => {
  const table: Array<[string, Record<string, string>, string | null]> = [
    ['aliyun with every key', { ...ALIYUN }, 'aliyun'],
    ['aliyun missing the template', { ...ALIYUN, ALIYUN_SMS_TEMPLATE_OTP: '' }, null],
    ['tencent with every key', { ...TENCENT }, 'tencent'],
    ['tencent missing the secret', { ...TENCENT, TENCENT_SMS_SECRET_KEY: '' }, null],
    ['dev console in development', { NODE_ENV: 'development', SMS_DEV_CONSOLE: 'true' }, 'dev_console'],
    ['dev console in production is ignored', { NODE_ENV: 'production', SMS_DEV_CONSOLE: 'true' }, null],
    ['nothing set', {}, null],
  ];

  it.each(table)('%s', (_name, env, expected) => {
    expect(selectSmsProvider(env)).toBe(expected);
  });

  it.each(table)('agrees with the auth.phoneOtp capability on GoApply: %s', (_name, env, expected) => {
    expect(requirementsMet('auth.phoneOtp', getBrand('goapply'), env)).toBe(expected !== null);
  });
});

describe('dev console provider', () => {
  it('prints signature + code only, with the number masked', async () => {
    const lines: string[] = [];
    const p = createDevConsoleProvider({ env: { NODE_ENV: 'development' }, log: (l) => lines.push(l) });
    await expect(p.sendOtp(msg)).resolves.toEqual({ ok: true, provider: 'dev_console' });
    expect(lines).toEqual(['[sms:dev] +86138****5678 ← 【GoApply】验证码：042917']);
    expect(lines[0]).not.toMatch(/https?:|www\./);
    expect(lines[0]).not.toContain('13812345678');
  });

  it('refuses to print codes in production', async () => {
    const log = vi.fn();
    const p = createDevConsoleProvider({ env: { NODE_ENV: 'production' }, log });
    await expect(p.sendOtp(msg)).rejects.toBeInstanceOf(DevConsoleInProductionError);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('Aliyun provider', () => {
  it('builds a signed SendSms request with the bare number and only the code as template param', () => {
    const url = new URL(buildAliyunSendUrl(msg, { env: ALIYUN, now }, 'nonce-1'));
    const p = Object.fromEntries(url.searchParams.entries());
    expect(url.origin).toBe('https://dysmsapi.aliyuncs.com');
    expect(p.Action).toBe('SendSms');
    expect(p.PhoneNumbers).toBe('13812345678');
    expect(p.SignName).toBe('GoApply');
    expect(p.TemplateCode).toBe('SMS_123');
    expect(JSON.parse(p.TemplateParam!)).toEqual({ code: '042917' });
    expect(p.Timestamp).toBe('2026-10-10T08:00:00Z');
    const { Signature, ...rest } = p;
    expect(Signature).toBe(signAliyunParams(rest, 'SECRET'));
  });

  it('percent-encodes per RFC 3986', () => {
    expect(aliyunPercentEncode("a b*~!'()")).toBe('a%20b%2A~%21%27%28%29');
  });

  it('signs with HMAC-SHA1 of the canonical string', () => {
    const params = { B: '2', A: '1' };
    const expected = crypto.createHmac('sha1', 'k&').update('GET&%2F&A%3D1%26B%3D2').digest('base64');
    expect(signAliyunParams(params, 'k')).toBe(expected);
  });

  it('maps OK and failures', async () => {
    const okFetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ Code: 'OK', BizId: 'biz1' }) }));
    const p = createAliyunProvider({ env: ALIYUN, now, fetch: okFetch, log: () => {} });
    await expect(p.sendOtp(msg)).resolves.toEqual({ ok: true, provider: 'aliyun', providerMessageId: 'biz1' });
    const badFetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ Code: 'isv.BUSINESS_LIMIT_CONTROL' }) }));
    const p2 = createAliyunProvider({ env: ALIYUN, now, fetch: badFetch, log: () => {} });
    await expect(p2.sendOtp(msg)).resolves.toEqual({ ok: false, provider: 'aliyun', errorCode: 'isv.BUSINESS_LIMIT_CONTROL' });
    const throwing = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const p3 = createAliyunProvider({ env: ALIYUN, now, fetch: throwing, log: () => {} });
    await expect(p3.sendOtp(msg)).resolves.toMatchObject({ ok: false, errorCode: 'network_error' });
  });
});

describe('Tencent provider', () => {
  it('builds a TC3-signed SendSms request with only the code as template param', () => {
    const req = buildTencentSendRequest(msg, { env: TENCENT, now });
    const body = JSON.parse(req.body);
    expect(body).toEqual({
      PhoneNumberSet: ['+8613812345678'],
      SmsSdkAppId: '1400000000',
      SignName: 'GoApply',
      TemplateId: '100001',
      TemplateParamSet: ['042917'],
    });
    expect(req.headers['X-TC-Action']).toBe('SendSms');
    expect(req.headers['X-TC-Timestamp']).toBe(String(Math.floor(now().getTime() / 1000)));
    expect(req.headers.Authorization).toMatch(
      /^TC3-HMAC-SHA256 Credential=SID\/2026-10-10\/sms\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/,
    );
    // Deterministic for the same input; different for a different secret.
    expect(buildTencentSendRequest(msg, { env: TENCENT, now }).headers.Authorization).toBe(req.headers.Authorization);
    expect(buildTencentSendRequest(msg, { env: { ...TENCENT, TENCENT_SMS_SECRET_KEY: 'other' }, now }).headers.Authorization).not.toBe(
      req.headers.Authorization,
    );
  });

  it('maps Ok and errors', async () => {
    const ok = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ Response: { SendStatusSet: [{ Code: 'Ok', SerialNo: 's1' }], RequestId: 'r1' } }),
    }));
    await expect(createTencentProvider({ env: TENCENT, now, fetch: ok, log: () => {} }).sendOtp(msg)).resolves.toEqual({
      ok: true,
      provider: 'tencent',
      providerMessageId: 's1',
    });
    const err = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ Response: { Error: { Code: 'AuthFailure.SignatureFailure' } } }),
    }));
    await expect(createTencentProvider({ env: TENCENT, now, fetch: err, log: () => {} }).sendOtp(msg)).resolves.toMatchObject({
      ok: false,
      errorCode: 'AuthFailure.SignatureFailure',
    });
  });
});

describe('createSmsService', () => {
  it('throws when nothing is configured', async () => {
    const s = createSmsService({ env: {} });
    expect(s.configured).toBe(false);
    await expect(s.sendOtp(msg)).rejects.toBeInstanceOf(SmsNotConfiguredError);
  });

  it('routes to the selected provider', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ Code: 'OK' }) }));
    const s = createSmsService({ env: ALIYUN, fetch: fetchFn, now });
    expect(s.provider).toBe('aliyun');
    await s.sendOtp(msg);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toContain('dysmsapi.aliyuncs.com');
  });

  it('helpers', () => {
    expect(maskPhone('+8613812345678')).toBe('+86138****5678');
    expect(nationalNumber('+8613812345678')).toBe('13812345678');
  });
});
