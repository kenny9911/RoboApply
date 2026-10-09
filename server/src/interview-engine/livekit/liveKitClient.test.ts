// @vitest-environment node
// C7: the candidate token must allow updating its own attributes so the
// browser can set 'ie.client_ready'.
// Run: npx vitest run server/src/interview-engine/livekit/liveKitClient.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintJoinToken, __resetLiveKitClientsForTest } from './liveKitClient.js';

const KEYS = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const;

function decode(jwt: string): Record<string, any> {
  return JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'));
}

describe('mintJoinToken', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env.LIVEKIT_URL = 'wss://example.livekit.test';
    process.env.LIVEKIT_API_KEY = 'APIkey';
    process.env.LIVEKIT_API_SECRET = 'secret-secret-secret-secret-secret-secret';
    __resetLiveKitClientsForTest();
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('grants canUpdateOwnMetadata alongside data publish', async () => {
    const tok = await mintJoinToken({ roomName: 'ie-1', identity: 'candidate-s1', allowVideo: true, ttlSeconds: 900 });
    const claims = decode(tok.token);
    expect(claims.video).toMatchObject({
      room: 'ie-1',
      roomJoin: true,
      canPublishData: true,
      canUpdateOwnMetadata: true,
    });
  });
});
