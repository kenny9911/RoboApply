// @vitest-environment node
//
// FND-5 acceptance:
//   - a handler under /api/v1/webhooks/* receives the raw request Buffer
//     when the app parses /api/v1/webhooks with express.raw BEFORE express.json
//     (as server/src/app.ts does), and sees a parsed body otherwise;
//   - server/src/app.ts keeps that order, calls mountFeatures exactly once
//     AFTER every legacy router, and imports the queue worker registry.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createBrandContext } from '../platform/brand/brandContext.js';
import { setFlagOverrideLoader } from '../platform/flags.js';
import { mountFeatures } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const ENV = {
  NODE_ENV: 'development',
  CN_PAYMENTS_ENABLED: 'true',
  WECHATPAY_MCH_ID: 'm',
  WECHATPAY_APP_ID: 'a',
  WECHATPAY_API_V3_KEY: '0123456789abcdef0123456789abcdef',
  WECHATPAY_MCH_CERT_SERIAL: 's',
  WECHATPAY_MCH_PRIVATE_KEY: 'p',
  WECHATPAY_PUBLIC_KEY: 'pub',
  WECHATPAY_PUBLIC_KEY_ID: 'PUB_KEY_ID_1',
  WECHATPAY_MERCHANT_ENTITY: 'Example Collecting Co.',
  CN_PAYMENT_COLLECTING_ENTITY: 'Example Collecting Co.',
  WECHAT_MP_APP_ID: 'wx',
  WECHAT_MP_APP_SECRET: 's',
  WECHAT_MP_TOKEN: 't',
};
const GOAPPLY = 'goapply.localhost:3621';

async function start(rawFirst: boolean): Promise<{ server: Server; base: string }> {
  const app = express();
  if (rawFirst) app.use('/api/v1/webhooks', express.raw({ type: '*/*', limit: '1mb' }));
  app.use(express.json());
  app.use(createBrandContext({ env: ENV }));
  mountFeatures(app, { env: ENV });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('webhook routes receive the raw Buffer', () => {
  let raw: { server: Server; base: string };
  let parsed: { server: Server; base: string };

  beforeAll(async () => {
    setFlagOverrideLoader(async () => []);
    raw = await start(true);
    parsed = await start(false);
  });
  afterAll(async () => {
    setFlagOverrideLoader(null);
    await Promise.all([raw, parsed].map((r) => new Promise<void>((res, rej) => r.server.close((e) => (e ? rej(e) : res())))));
  });

  const post = (base: string, p: string, body: string, type: string) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': type, 'x-forwarded-host': GOAPPLY }, body });

  // The routes are reached either way; what differs is the body the handler
  // sees. With raw-first parsing it is never refused for not being a Buffer
  // (the stub answers 501; a filled handler answers per its own contract —
  // WP-62 / WP-73 test signatures and replies themselves).
  const refusedAsParsed = (status: number, body: { code?: string; details?: { expected?: string } }) =>
    status === 422 && body.code === 'invalid_request' && body.details?.expected === 'Buffer';

  it('WeChat Pay notify gets a Buffer, not a parsed object', async () => {
    const ok = await post(raw.base, '/api/v1/webhooks/wechatpay', '{"id":"evt_1","resource":{}}', 'application/json');
    const okBody = (await ok.json()) as { code?: string; details?: { expected?: string } };
    expect(ok.status).not.toBe(404);
    expect(refusedAsParsed(ok.status, okBody)).toBe(false);

    // While the handler is the FND stub it also proves the negative: a parsed
    // body is refused (the stub checks Buffer.isBuffer before its 501).
    if (okBody.code === 'not_implemented') {
      const bad = await post(parsed.base, '/api/v1/webhooks/wechatpay', '{"id":"evt_1","resource":{}}', 'application/json');
      expect(refusedAsParsed(bad.status, await bad.json())).toBe(true);
    }
  });

  it('WeChat MP server messages get the raw XML Buffer', async () => {
    const q = '?signature=abc&timestamp=1700000000&nonce=n1';
    const res = await post(raw.base, `/api/v1/webhooks/wechat-mp${q}`, '<xml><ToUserName>gh</ToUserName></xml>', 'text/xml');
    expect(res.status).not.toBe(404);
    expect(refusedAsParsed(res.status, await res.json().catch(() => ({})))).toBe(false);
  });

  it('webhooks stay hidden when their capability is off (RoboApply host)', async () => {
    const res = await fetch(`${raw.base}/api/v1/webhooks/wechatpay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-host': 'localhost:3621' }, body: '{}' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'feature_disabled' });
  });
});

describe('server/src/app.ts wiring', () => {
  const source = readFileSync(path.resolve(here, '../app.ts'), 'utf8');
  const code = source
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

  it('parses /api/v1/webhooks raw before express.json', () => {
    const rawAt = code.indexOf("app.use('/api/v1/webhooks', express.raw(");
    const jsonAt = code.indexOf('app.use(express.json(');
    expect(rawAt).toBeGreaterThan(-1);
    expect(jsonAt).toBeGreaterThan(rawAt);
  });

  it('calls mountFeatures exactly once, after every legacy router', () => {
    const calls = code.match(/mountFeatures\(app/g) ?? [];
    expect(calls).toHaveLength(1);
    const mountAt = code.indexOf('mountFeatures(app');
    const legacy = [
      "app.use('/api/v1/roboapply/auth'",
      "app.use('/api/v1/roboapply/billing'",
      "app.use('/api/v1/roboapply/account'",
      "app.use('/api/v1/roboapply/v2'",
      "app.use('/api/v1/roboapply/v2/job-search'",
      "app.use('/api/v1/interview-engine'",
      "app.use('/api/v1/public/brand'",
    ];
    for (const marker of legacy) {
      const at = code.indexOf(marker);
      expect(at, marker).toBeGreaterThan(-1);
      expect(at, marker).toBeLessThan(mountAt);
    }
    // The global error handler stays last.
    expect(code.indexOf('Unhandled error')).toBeGreaterThan(mountAt);
  });

  it('imports the queue worker registry for its side effect', () => {
    expect(code).toContain("import './platform/queue/registry.js';");
  });
});
