// @vitest-environment node
//
// LiveKit webhooks are verified with the key that signed them and matched to a
// LiveKit project: the shared one (both brands by default, D5) or GoApply's
// own (CN_LIVEKIT_*). A token no configured project signed is rejected.
// Run: npx vitest run server/src/interview-engine/livekit/webhookReceiver.test.ts

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccessToken } from 'livekit-server-sdk';

import { __resetWebhookReceiverForTest, receiveBrandWebhook, receiveWebhook, webhookIssuer } from './webhookReceiver.js';
import { voiceProviderFor } from '../providers/index.js';

const ENV = {
  LIVEKIT_URL: 'wss://intl.livekit.test',
  LIVEKIT_API_KEY: 'APIintl',
  LIVEKIT_API_SECRET: 'intl-secret-intl-secret-intl-secret-1234',
  CN_LIVEKIT_URL: 'wss://cn.livekit.test',
  CN_LIVEKIT_API_KEY: 'APIcn',
  CN_LIVEKIT_API_SECRET: 'cn-secret-cn-secret-cn-secret-cn-secret-1',
};

const BODY = JSON.stringify({ event: 'room_finished', room: { name: 'ie-1' } });

async function sign(apiKey: string, apiSecret: string, body = BODY): Promise<string> {
  const at = new AccessToken(apiKey, apiSecret, { ttl: 300 });
  at.sha256 = createHash('sha256').update(body).digest('base64');
  return at.toJwt();
}

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  __resetWebhookReceiverForTest();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('receiveBrandWebhook', () => {
  it('verifies a webhook of the shared project with LIVEKIT_* and names the key and its brands', async () => {
    const token = await sign(ENV.LIVEKIT_API_KEY, ENV.LIVEKIT_API_SECRET);
    const got = await receiveBrandWebhook(BODY, token);
    expect(got.apiKey).toBe('APIintl');
    // GoApply has its own project in this env, so only RoboApply's new sessions use the shared one.
    expect(got.brands).toEqual(['roboapply']);
    expect(got.event.event).toBe('room_finished');
    expect((await receiveWebhook(BODY, token)).room?.name).toBe('ie-1');
  });

  it('verifies a webhook of GoApply’s own project with CN_LIVEKIT_*', async () => {
    const token = await sign(ENV.CN_LIVEKIT_API_KEY, ENV.CN_LIVEKIT_API_SECRET);
    expect(webhookIssuer(token)).toBe('APIcn');
    expect(await receiveBrandWebhook(BODY, token)).toMatchObject({ apiKey: 'APIcn', brands: ['goapply'] });
  });

  it('the shared-key case: with no CN_LIVEKIT_* both brands run on one project and its webhooks name both (G52)', async () => {
    for (const k of ['CN_LIVEKIT_URL', 'CN_LIVEKIT_API_KEY', 'CN_LIVEKIT_API_SECRET']) delete process.env[k];
    const token = await sign(ENV.LIVEKIT_API_KEY, ENV.LIVEKIT_API_SECRET);
    const got = await receiveBrandWebhook(BODY, token);
    expect(got.apiKey).toBe('APIintl');
    expect(got.brands).toEqual(['roboapply', 'goapply']);
    expect(got.event.room?.name).toBe('ie-1');
    // A key that is not the shared project's is still rejected.
    await expect(receiveBrandWebhook(BODY, await sign(ENV.CN_LIVEKIT_API_KEY, ENV.CN_LIVEKIT_API_SECRET))).rejects.toThrow(/not signed/);
  });

  it('one project named twice (CN_LIVEKIT_* equal to LIVEKIT_*) is one project serving both brands', async () => {
    Object.assign(process.env, { CN_LIVEKIT_URL: ENV.LIVEKIT_URL, CN_LIVEKIT_API_KEY: ENV.LIVEKIT_API_KEY, CN_LIVEKIT_API_SECRET: ENV.LIVEKIT_API_SECRET });
    const got = await receiveBrandWebhook(BODY, await sign(ENV.LIVEKIT_API_KEY, ENV.LIVEKIT_API_SECRET));
    expect(got).toMatchObject({ apiKey: 'APIintl', brands: ['roboapply', 'goapply'] });
  });

  it('rejects an unknown key, a wrong secret, and a tampered body', async () => {
    await expect(receiveBrandWebhook(BODY, await sign('APIother', 'x'.repeat(40)))).rejects.toThrow(/not signed/);
    await expect(receiveBrandWebhook(BODY, await sign(ENV.CN_LIVEKIT_API_KEY, 'y'.repeat(40)))).rejects.toThrow();
    const token = await sign(ENV.LIVEKIT_API_KEY, ENV.LIVEKIT_API_SECRET);
    await expect(receiveBrandWebhook(BODY.replace('ie-1', 'ie-2'), token)).rejects.toThrow(/sha256/);
  });

  it('a webhook of GoApply’s own project is refused once that project is unconfigured (its key is never checked against the shared secret)', async () => {
    const token = await sign(ENV.CN_LIVEKIT_API_KEY, ENV.CN_LIVEKIT_API_SECRET);
    delete process.env.CN_LIVEKIT_URL;
    await expect(receiveBrandWebhook(BODY, token)).rejects.toThrow(/not signed/);
    // A half-set own plane is not a project either.
    process.env.CN_LIVEKIT_URL = ENV.CN_LIVEKIT_URL;
    delete process.env.CN_LIVEKIT_API_SECRET;
    await expect(receiveBrandWebhook(BODY, token)).rejects.toThrow(/not signed/);
  });

  it('with no LiveKit configured at all it raises the configuration error', async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    await expect(receiveBrandWebhook(BODY, 'x.y.z')).rejects.toThrow(/LiveKit is not configured/);
  });
});

describe('receiver cache', () => {
  it('a rotated secret of the same length is used at once (no stale cached receiver)', async () => {
    const before = await sign(ENV.LIVEKIT_API_KEY, ENV.LIVEKIT_API_SECRET);
    await expect(receiveBrandWebhook(BODY, before)).resolves.toMatchObject({ apiKey: 'APIintl' });
    const rotated = ENV.LIVEKIT_API_SECRET.replace(/1234$/, '5678');
    expect(rotated).toHaveLength(ENV.LIVEKIT_API_SECRET.length);
    process.env.LIVEKIT_API_SECRET = rotated;
    await expect(receiveBrandWebhook(BODY, await sign(ENV.LIVEKIT_API_KEY, rotated))).resolves.toMatchObject({ apiKey: 'APIintl' });
    await expect(receiveBrandWebhook(BODY, before)).rejects.toThrow();
  });
});

describe('provider.verifyWebhook (the key of the session plane, not the brand)', () => {
  it('a GoApply session on the shared project accepts the shared key and refuses GoApply’s other project', async () => {
    const shared = await sign(ENV.LIVEKIT_API_KEY, ENV.LIVEKIT_API_SECRET);
    const own = await sign(ENV.CN_LIVEKIT_API_KEY, ENV.CN_LIVEKIT_API_SECRET);
    const onShared = voiceProviderFor({ brand: 'goapply', provider: 'livekit_cloud', stack: 'shared' });
    await expect(onShared.verifyWebhook(BODY, shared)).resolves.toMatchObject({ event: 'room_finished' });
    await expect(onShared.verifyWebhook(BODY, own)).rejects.toThrow(/another LiveKit project/);
    const onOwn = voiceProviderFor({ brand: 'goapply', provider: 'livekit_cloud', stack: 'own' });
    await expect(onOwn.verifyWebhook(BODY, own)).resolves.toMatchObject({ event: 'room_finished' });
    await expect(onOwn.verifyWebhook(BODY, shared)).rejects.toThrow(/another LiveKit project/);
    // RoboApply and GoApply on one project both accept its key.
    const intl = voiceProviderFor({ brand: 'roboapply', provider: 'livekit_cloud' });
    await expect(intl.verifyWebhook(BODY, shared)).resolves.toMatchObject({ event: 'room_finished' });
    await expect(intl.verifyWebhook(BODY, own)).rejects.toThrow(/another LiveKit project/);
  });
});
