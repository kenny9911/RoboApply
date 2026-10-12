// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { grantPracticePack, packExpiry, packGrantId, type PackDb } from './packs.js';

describe('grantPracticePack', () => {
  it('adds credits once per purchase and records a 12-month pack row', async () => {
    const db = createFakePrisma();
    const seen = new Set<string>();
    const grant = vi.fn(async (_u: string, _r: string, key: string, opts?: { credits?: number }) => {
      if (seen.has(key)) return { status: 'already_granted' as const, ledgerId: 'l', balanceAfter: null };
      seen.add(key);
      return { status: 'granted' as const, ledgerId: 'l', balanceAfter: opts?.credits ?? 0 };
    });
    const at = new Date('2026-10-10T00:00:00.000Z');
    const input = { userId: 'u_1', credits: 5, idempotencyKey: 'stripe:cs_1', purchasedAt: at };
    expect((await grantPracticePack(input, { grant, getDb: async () => db as unknown as PackDb })).status).toBe('granted');
    expect((await grantPracticePack(input, { grant, getDb: async () => db as unknown as PackDb })).status).toBe('already_granted');
    expect(grant).toHaveBeenCalledWith('u_1', 'pack_purchase', 'stripe:cs_1', { credits: 5 });
    const rows = await db.rACreditGrant.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bucket: 'practice', reason: 'pack', amount: 5, remaining: 5 });
    expect((rows[0]!.expiresAt as Date).toISOString()).toBe(packExpiry(at).toISOString());
    expect(packExpiry(at).toISOString()).toBe('2027-10-10T00:00:00.000Z');
  });

  it('a replay after a crash between the credit grant and the pack row still writes the row once', async () => {
    const db = createFakePrisma();
    // The credit grant already happened (first run crashed before the row).
    const grant = vi.fn(async () => ({ status: 'already_granted' as const, ledgerId: 'l', balanceAfter: null }));
    const at = new Date('2026-10-10T00:00:00.000Z');
    const input = { userId: 'u_1', credits: 15, idempotencyKey: 'order:o_1', purchasedAt: at };
    await grantPracticePack(input, { grant, getDb: async () => db as unknown as PackDb });
    await grantPracticePack(input, { grant, getDb: async () => db as unknown as PackDb });
    const rows = await db.rACreditGrant.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: packGrantId('u_1', 'order:o_1'), bucket: 'practice', reason: 'pack', amount: 15, remaining: 15 });
  });

  it('never writes a row while the grant is unfinished or failed', async () => {
    const db = createFakePrisma();
    for (const status of ['in_progress', 'failed', 'no_profile'] as const) {
      const grant = vi.fn(async () => ({ status, ledgerId: null, balanceAfter: null }));
      await grantPracticePack({ userId: 'u_1', credits: 5, idempotencyKey: `k_${status}`, purchasedAt: new Date() }, { grant, getDb: async () => db as unknown as PackDb });
    }
    expect(await db.rACreditGrant.findMany({})).toEqual([]);
  });
});
