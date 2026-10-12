// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_CREDIT_CATALOG } from './catalog.js';
import { proAllowsMore, summarizeEntitlementsForMe } from './summary.js';
import { createCreditTestKit } from './testkit.js';

describe('summarizeEntitlementsForMe (/auth/me)', () => {
  it('returns plan, caps, usage and reset times as JSON-safe values', async () => {
    const kit = createCreditTestKit({ accounts: { u1: { brand: 'goapply', timezone: null, subscription: null } } });
    await kit.credits.commit((await kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'a' })).id);
    const s = await summarizeEntitlementsForMe('u1', { credits: kit.credits, entitlements: kit.entitlements });
    expect(s).toMatchObject({ planKey: 'free', planProfile: 'free', legacyPlan: false, timezone: 'Asia/Shanghai', upgradable: true, periodEnd: null });
    expect(s.buckets.tailor).toEqual({ cap: 3, window: 'day', used: 1, remaining: 2, grantRemaining: 0, resetsAt: '2026-10-10T16:00:00.000Z', proCap: 50, proWindow: 'day' });
    expect(s.cancelAtPeriodEnd).toBe(false);
    expect(s.entitlements).toEqual({ saved_searches: 1, instant_alerts: 1, competitivenessFull: false });
    expect(Object.keys(s.buckets)).not.toContain('practice');
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  describe('proCap (what Pro would give, from the catalog)', () => {
    const LATER = new Date('2026-11-01T00:00:00Z');
    const pro = { tier: 'pro', planKey: 'pro_monthly', status: 'active', interval: 'month', currentPeriodEnd: LATER };

    it('a free user\'s ready_kits bucket carries the Pro weekly cap', async () => {
      const kit = createCreditTestKit({ accounts: { u1: { brand: 'roboapply', timezone: 'UTC', subscription: null } } });
      const s = await summarizeEntitlementsForMe('u1', { credits: kit.credits, entitlements: kit.entitlements });
      const expected = DEFAULT_CREDIT_CATALOG.roboapply.buckets.ready_kits.caps.pro;
      expect(s.buckets.ready_kits).toMatchObject({ cap: 3, window: 'week', proCap: expected.cap, proWindow: expected.window });
      expect(s.buckets.ready_kits.proCap).toBe(30);
    });

    it('follows an admin change to the Pro cap', async () => {
      const catalog = structuredClone(DEFAULT_CREDIT_CATALOG.roboapply);
      catalog.buckets.ready_kits.caps.pro.cap = 40;
      const kit = createCreditTestKit({ accounts: { u1: { brand: 'roboapply', timezone: 'UTC', subscription: null } }, catalog: { roboapply: catalog } });
      const s = await summarizeEntitlementsForMe('u1', { credits: kit.credits, entitlements: kit.entitlements });
      expect(s.buckets.ready_kits.proCap).toBe(40);
    });

    it('is absent where Pro gives no more: a Pro user, the gated contact lookup, an override above the Pro cap', async () => {
      const kit = createCreditTestKit({
        accounts: { free: { brand: 'roboapply', timezone: 'UTC', subscription: null }, paid: { brand: 'roboapply', timezone: 'UTC', subscription: pro } },
        overrides: { free: [{ key: 'bucket:ready_kits', value: 30, expiresAt: null, createdAt: new Date('2026-10-01T00:00:00Z') }] },
      });
      const paid = await summarizeEntitlementsForMe('paid', { credits: kit.credits, entitlements: kit.entitlements });
      for (const b of Object.values(paid.buckets)) {
        expect('proCap' in b).toBe(false);
        expect('proWindow' in b).toBe(false);
      }
      const free = await summarizeEntitlementsForMe('free', { credits: kit.credits, entitlements: kit.entitlements });
      expect('proCap' in free.buckets.contact_lookup).toBe(false);
      // The override already gives the Pro cap, so "Pro: up to 30" would promise nothing.
      expect(free.buckets.ready_kits.cap).toBe(30);
      expect('proCap' in free.buckets.ready_kits).toBe(false);
    });

    it('names the Pro window when it differs (1 a week on Free, 3 a day on Pro)', async () => {
      const kit = createCreditTestKit({ accounts: { u1: { brand: 'roboapply', timezone: 'UTC', subscription: null } } });
      const s = await summarizeEntitlementsForMe('u1', { credits: kit.credits, entitlements: kit.entitlements });
      expect(s.buckets.competitiveness).toMatchObject({ cap: 1, window: 'week', proCap: 3, proWindow: 'day' });
    });

    it('compares per day, so a smaller number on a shorter window still counts as more', () => {
      expect(proAllowsMore({ cap: 1, window: 'week' }, { cap: 3, window: 'day' })).toBe(true);
      expect(proAllowsMore({ cap: 30, window: 'week' }, { cap: 3, window: 'day' })).toBe(false);
      expect(proAllowsMore({ cap: 3, window: 'week' }, { cap: 3, window: 'week' })).toBe(false);
      expect(proAllowsMore({ cap: 0, window: 'day' }, { cap: 0, window: 'day' })).toBe(false);
    });
  });

  describe('cancelAtPeriodEnd', () => {
    const LATER = new Date('2026-11-01T00:00:00Z');
    const sub = (over: Record<string, unknown> = {}) => ({ tier: 'pro', planKey: 'pro_monthly', status: 'active', interval: 'month', currentPeriodEnd: LATER, ...over });

    it('is true for a cancelled new-catalog subscription that is still running, with the date access ends', async () => {
      const kit = createCreditTestKit({ accounts: { u1: { brand: 'roboapply', timezone: 'UTC', subscription: sub({ cancelAtPeriodEnd: true }) } } });
      const s = await summarizeEntitlementsForMe('u1', { credits: kit.credits, entitlements: kit.entitlements });
      expect(s).toMatchObject({ planKey: 'pro_monthly', planProfile: 'pro', cancelAtPeriodEnd: true, periodEnd: LATER.toISOString() });
    });

    it('is false while the plan still renews, and flips when the user cancels', async () => {
      const kit = createCreditTestKit({ accounts: { u1: { brand: 'roboapply', timezone: 'UTC', subscription: sub({ cancelAtPeriodEnd: false }) } } });
      expect((await summarizeEntitlementsForMe('u1', { credits: kit.credits, entitlements: kit.entitlements })).cancelAtPeriodEnd).toBe(false);
      kit.setAccount('u1', { brand: 'roboapply', timezone: 'UTC', subscription: sub({ cancelAtPeriodEnd: true }) });
      expect((await summarizeEntitlementsForMe('u1', { credits: kit.credits, entitlements: kit.entitlements })).cancelAtPeriodEnd).toBe(true);
    });

    it('is false once the paid period is over (the stale flag on an ended row is not a running cancellation)', async () => {
      const ended = sub({ cancelAtPeriodEnd: true, currentPeriodEnd: new Date('2026-10-01T00:00:00Z') });
      const kit = createCreditTestKit({ accounts: { u1: { brand: 'roboapply', timezone: 'UTC', subscription: ended } } });
      const s = await summarizeEntitlementsForMe('u1', { credits: kit.credits, entitlements: kit.entitlements });
      expect(s).toMatchObject({ planProfile: 'free', cancelAtPeriodEnd: false, periodEnd: null });
    });

    it('is false when the source does not say (older snapshots)', async () => {
      const kit = createCreditTestKit({ accounts: { u1: { brand: 'roboapply', timezone: 'UTC', subscription: sub() } } });
      expect((await summarizeEntitlementsForMe('u1', { credits: kit.credits, entitlements: kit.entitlements })).cancelAtPeriodEnd).toBe(false);
    });
  });
});
