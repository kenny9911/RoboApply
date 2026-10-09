// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  aliyunDmEndpoint,
  aliyunPercentEncode,
  aliyunTimestamp,
  buildSingleSendMailRequest,
  canonicalizeParams,
  createAliyunDmTransport,
  displayNameOf,
  signAliyunRpc,
  stringToSign,
} from '../email/transports/aliyunDirectMail.js';
import type { EmailMessage } from '../email/transports/resend.js';

// Alibaba Cloud's published RPC-signature example (ECS DescribeRegions):
// AccessKeySecret "testsecret" → Signature "OLeaidS1JvxuMvnyHOwuJ+uX5qY=".
const DOC_PARAMS = {
  AccessKeyId: 'testid',
  Action: 'DescribeRegions',
  Format: 'XML',
  SignatureMethod: 'HMAC-SHA1',
  SignatureNonce: '3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf',
  SignatureVersion: '1.0',
  Timestamp: '2016-02-23T12:46:24Z',
  Version: '2014-05-26',
};

describe('Aliyun RPC signature', () => {
  it('matches the documented fixture', () => {
    expect(stringToSign('GET', DOC_PARAMS)).toBe(
      'GET&%2F&AccessKeyId%3Dtestid%26Action%3DDescribeRegions%26Format%3DXML%26SignatureMethod%3DHMAC-SHA1' +
        '%26SignatureNonce%3D3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf%26SignatureVersion%3D1.0' +
        '%26Timestamp%3D2016-02-23T12%253A46%253A24Z%26Version%3D2014-05-26',
    );
    expect(signAliyunRpc('GET', DOC_PARAMS, 'testsecret')).toBe('OLeaidS1JvxuMvnyHOwuJ+uX5qY=');
  });

  it('percent-encodes per the POP rules', () => {
    expect(aliyunPercentEncode("a b*c~d!e'(f)")).toBe('a%20b%2Ac~d%21e%27%28f%29');
    expect(aliyunPercentEncode('你好')).toBe('%E4%BD%A0%E5%A5%BD');
    expect(canonicalizeParams({ b: '2', a: '1 1' })).toBe('a=1%201&b=2');
  });

  it('formats timestamps and endpoints', () => {
    expect(aliyunTimestamp(new Date('2026-10-10T08:00:00.123Z'))).toBe('2026-10-10T08:00:00Z');
    expect(aliyunDmEndpoint(undefined)).toBe('https://dm.aliyuncs.com/');
    expect(aliyunDmEndpoint('cn-hangzhou')).toBe('https://dm.aliyuncs.com/');
    expect(aliyunDmEndpoint('ap-southeast-1')).toBe('https://dm.ap-southeast-1.aliyuncs.com/');
  });

  it('reads display names', () => {
    expect(displayNameOf('GoApply <noreply@mail.goapply.top>')).toBe('GoApply');
    expect(displayNameOf('"GoApply 求职" <a@b.c>')).toBe('GoApply 求职');
    expect(displayNameOf('a@b.c')).toBe('');
  });
});

const MESSAGE: EmailMessage = {
  from: 'GoApply <noreply@mail.goapply.top>',
  to: ['user@example.com'],
  subject: '验证你的邮箱',
  html: '<p>你好</p>',
  text: '你好',
  headers: { 'List-Unsubscribe': '<https://x>' },
};

describe('SingleSendMail request', () => {
  const fixed = {
    accessKeyId: 'testid',
    accessKeySecret: 'testsecret',
    accountName: 'noreply@mail.goapply.top',
    timestamp: new Date('2026-10-10T08:00:00Z'),
    nonce: 'nonce-1',
  };

  it('carries the SingleSendMail parameters and a signature over all of them', () => {
    const req = buildSingleSendMailRequest({ ...fixed, message: MESSAGE });
    expect(req.url).toBe('https://dm.aliyuncs.com/');
    const { Signature, ...unsigned } = req.params;
    expect(unsigned).toEqual({
      Action: 'SingleSendMail',
      Format: 'JSON',
      Version: '2015-11-23',
      AccessKeyId: 'testid',
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      SignatureNonce: 'nonce-1',
      Timestamp: '2026-10-10T08:00:00Z',
      RegionId: 'cn-hangzhou',
      AccountName: 'noreply@mail.goapply.top',
      AddressType: '1',
      ReplyToAddress: 'false',
      ToAddress: 'user@example.com',
      Subject: '验证你的邮箱',
      HtmlBody: '<p>你好</p>',
      TextBody: '你好',
      FromAlias: 'GoApply',
    });
    expect(Signature).toBe(signAliyunRpc('POST', unsigned, 'testsecret'));
    // Deterministic for a fixed clock and nonce.
    expect(buildSingleSendMailRequest({ ...fixed, message: MESSAGE }).params.Signature).toBe(Signature);
    // Any parameter change changes the signature.
    expect(buildSingleSendMailRequest({ ...fixed, nonce: 'nonce-2', message: MESSAGE }).params.Signature).not.toBe(Signature);
    expect(req.body).toContain(`Signature=${aliyunPercentEncode(Signature!)}`);
    expect(req.body).toContain('ToAddress=user%40example.com');
  });

  it('uses the console reply address when the message has a Reply-To, and a regional endpoint', () => {
    const req = buildSingleSendMailRequest({ ...fixed, region: 'cn-shanghai', message: { ...MESSAGE, replyTo: 'support@goapply.top' } });
    expect(req.params.ReplyToAddress).toBe('true');
    expect(req.params.RegionId).toBe('cn-shanghai');
    expect(req.url).toBe('https://dm.cn-shanghai.aliyuncs.com/');
  });
});

describe('createAliyunDmTransport', () => {
  const env = {
    ALIYUN_DM_ACCESS_KEY_ID: 'testid',
    ALIYUN_DM_ACCESS_KEY_SECRET: 'testsecret',
    ALIYUN_DM_ACCOUNT_NAME: 'noreply@mail.goapply.top',
  };

  it('is not configured without all three credentials, and then never calls out', async () => {
    const fetchImpl = vi.fn();
    const t = createAliyunDmTransport({ env: { ALIYUN_DM_ACCESS_KEY_ID: 'x' }, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(t.name).toBe('aliyun_dm');
    expect(t.isConfigured()).toBe(false);
    expect(await t.send(MESSAGE)).toEqual({ ok: false, error: 'not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs a signed form and returns the EnvId on success', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ EnvId: '600000123', RequestId: 'req-1' }), { status: 200 }));
    const t = createAliyunDmTransport({
      env,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date('2026-10-10T08:00:00Z'),
      nonce: () => 'nonce-1',
    });
    expect(t.isConfigured()).toBe(true);
    expect(await t.send(MESSAGE)).toEqual({ ok: true, providerId: '600000123' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://dm.aliyuncs.com/');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toMatch(/x-www-form-urlencoded/);
    const sent = Object.fromEntries(new URLSearchParams(String(init.body)));
    const { Signature, ...unsigned } = sent;
    expect(Signature).toBe(signAliyunRpc('POST', unsigned, 'testsecret'));
    expect(sent.Action).toBe('SingleSendMail');
    expect(sent.Subject).toBe('验证你的邮箱');
  });

  it('reports Aliyun error codes without throwing', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ Code: 'InvalidMailAddress.NotFound', Message: 'sender not verified' }), { status: 400 }),
    );
    const t = createAliyunDmTransport({ env, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await t.send(MESSAGE)).toEqual({
      ok: false,
      status: 400,
      error: 'aliyun_dm_InvalidMailAddress.NotFound: sender not verified',
    });
  });

  it('turns network errors into a failed result', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const t = createAliyunDmTransport({ env, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await t.send(MESSAGE)).toEqual({ ok: false, error: 'ECONNRESET' });
    expect(await t.send({ ...MESSAGE, to: [] })).toEqual({ ok: false, error: 'no_recipients' });
  });
});
