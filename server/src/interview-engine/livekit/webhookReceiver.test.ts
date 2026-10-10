// @vitest-environment node
//
// WP-63a: LiveKit webhooks from either brand's project are verified with the
// key that signed them; a token no configured project signed is rejected.
// Run: npx vitest run server/src/interview-engine/livekit/webhookReceiver.test.ts

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccessToken } from 'livekit-server-sdk';

import { __resetWebhookReceiverForTest, receiveBrandWebhook, receiveWebhook, webhookIssuer } from './webhookReceiver.js';

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
  it('verifies a RoboApply webhook with LIVEKIT_* and names the brand', async () => {
    const token = await sign(ENV.LIVEKIT_API_KEY, ENV.LIVEKIT_API_SECRET);
    const got = await receiveBrandWebhook(BODY, token);
    expect(got.brand).toBe('roboapply');
    expect(got.event.event).toBe('room_finished');
    expect((await receiveWebhook(BODY, token)).room?.name).toBe('ie-1');
  });

  it('verifies a GoApply webhook with CN_LIVEKIT_*', async () => {
    const token = await sign(ENV.CN_LIVEKIT_API_KEY, ENV.CN_LIVEKIT_API_SECRET);
    expect(webhookIssuer(token)).toBe('APIcn');
    expect((await receiveBrandWebhook(BODY, token)).brand).toBe('goapply');
  });

  it('rejects an unknown key, a wrong secret, and a tampered body', async () => {
    await expect(receiveBrandWebhook(BODY, await sign('APIother', 'x'.repeat(40)))).rejects.toThrow(/not signed/);
    await expect(receiveBrandWebhook(BODY, await sign(ENV.CN_LIVEKIT_API_KEY, 'y'.repeat(40)))).rejects.toThrow();
    const token = await sign(ENV.LIVEKIT_API_KEY, ENV.LIVEKIT_API_SECRET);
    await expect(receiveBrandWebhook(BODY.replace('ie-1', 'ie-2'), token)).rejects.toThrow(/sha256/);
  });

  it('a GoApply webhook is refused once its project is unconfigured (no fallback to the intl key)', async () => {
    const token = await sign(ENV.CN_LIVEKIT_API_KEY, ENV.CN_LIVEKIT_API_SECRET);
    delete process.env.CN_LIVEKIT_URL;
    await expect(receiveBrandWebhook(BODY, token)).rejects.toThrow(/not signed/);
  });
});

describe('receiver cache', () => {
  it('a rotated secret of the same length is used at once (no stale cached receiver)', async () => {
    const before = await sign(ENV.LIVEKIT_API_KEY, ENV.LIVEKIT_API_SECRET);
    await expect(receiveBrandWebhook(BODY, before)).resolves.toMatchObject({ brand: 'roboapply' });
    const rotated = ENV.LIVEKIT_API_SECRET.replace(/1234$/, '5678');
    expect(rotated).toHaveLength(ENV.LIVEKIT_API_SECRET.length);
    process.env.LIVEKIT_API_SECRET = rotated;
    await expect(receiveBrandWebhook(BODY, await sign(ENV.LIVEKIT_API_KEY, rotated))).resolves.toMatchObject({ brand: 'roboapply' });
    await expect(receiveBrandWebhook(BODY, before)).rejects.toThrow();
  });
});
