// @vitest-environment node
// Parley webhook route: raw-body HMAC verification and the status codes that
// drive Parley's retry (401/400 stop it, 500/503 retry, 200 done).
// Run: npx vitest run server/src/interview-engine/routes/parleyWebhookRoutes.test.ts

import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ handle: vi.fn() }));

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../sessions/InterviewSessionService.js', () => ({ interviewSessionService: { name: 'service' } }));
vi.mock('../parley/parleySessions.js', () => ({ handleParleyWebhook: m.handle }));

const { default: router } = await import('./parleyWebhookRoutes.js');

const SECRET = 'whsec_test';
let base = '';
let server: ReturnType<express.Express['listen']>;

beforeAll(async () => {
  Object.assign(process.env, {
    PARLEY_URL: 'http://parley.test', PARLEY_API_KEY: 'pk', PARLEY_WEBHOOK_SECRET: SECRET, PARLEY_AGENT_ID: 'agt',
  });
  const app = express();
  // Mirrors app.ts: the raw parser for this exact path, before express.json().
  app.use('/webhooks/parley', express.raw({ type: '*/*' }));
  app.use(express.json());
  app.use('/webhooks', router);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => m.handle.mockReset());

function post(body: string, signature?: string) {
  return fetch(`${base}/webhooks/parley`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(signature ? { 'x-parley-signature': signature } : {}) },
    body,
  });
}
const sign = (body: string, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`;

describe('POST /webhooks/parley', () => {
  const body = JSON.stringify({ event: 'session.ended', data: { sessionId: 'ses_1', externalRef: 'iv_1', transcript: [] } });

  it('verifies the signature over the raw bytes and hands the event to the service', async () => {
    m.handle.mockResolvedValueOnce('handled');
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.handle).toHaveBeenCalledWith({ name: 'service' }, JSON.parse(body));
  });

  it('rejects a missing or wrong signature without processing', async () => {
    expect((await post(body)).status).toBe(401);
    expect((await post(body, sign(body + ' '))).status).toBe(401);
    expect(m.handle).not.toHaveBeenCalled();
  });

  it('acks ignored events and asks for a retry when processing fails', async () => {
    m.handle.mockResolvedValueOnce('ignored');
    expect(await (await post(body, sign(body))).json()).toEqual({ ok: true, ignored: true });
    m.handle.mockRejectedValueOnce(new Error('db down'));
    expect((await post(body, sign(body))).status).toBe(500);
  });

  it('rejects a signed body that is not JSON', async () => {
    const junk = 'not json';
    expect((await post(junk, sign(junk))).status).toBe(400);
  });
});
