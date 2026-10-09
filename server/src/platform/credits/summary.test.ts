// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { summarizeEntitlementsForMe } from './summary.js';
import { createCreditTestKit } from './testkit.js';

describe('summarizeEntitlementsForMe (/auth/me)', () => {
  it('returns plan, caps, usage and reset times as JSON-safe values', async () => {
    const kit = createCreditTestKit({ accounts: { u1: { brand: 'goapply', timezone: null, subscription: null } } });
    await kit.credits.commit((await kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'a' })).id);
    const s = await summarizeEntitlementsForMe('u1', { credits: kit.credits, entitlements: kit.entitlements });
    expect(s).toMatchObject({ planKey: 'free', planProfile: 'free', legacyPlan: false, timezone: 'Asia/Shanghai', upgradable: true, periodEnd: null });
    expect(s.buckets.tailor).toEqual({ cap: 3, window: 'day', used: 1, remaining: 2, grantRemaining: 0, resetsAt: '2026-10-10T16:00:00.000Z' });
    expect(s.entitlements).toEqual({ saved_searches: 1, instant_alerts: 1, competitivenessFull: false });
    expect(Object.keys(s.buckets)).not.toContain('practice');
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});
