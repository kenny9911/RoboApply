// @vitest-environment node
//
// WP-54 Prisma-adapter checks that need no database: a 30,000-row connections
// import (LINKEDIN_IMPORT_MAX_ROWS) runs in ONE interactive transaction with
// explicit bounds (Prisma's 5 s default aborts it with P2028 on a slow
// database), in 1,000-row chunks; the hiring-contact read is tied to one
// recruiter id and always requires a consent basis.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { LINKEDIN_IMPORT_MAX_ROWS } from './contract.js';
import { CREATE_CHUNK, SAVE_IMPORT_TX, createPrismaNetworkStore } from './store.js';

function fakeDb() {
  const createMany = vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length }));
  const create = vi.fn(async () => ({ id: 'imp_1' }));
  const findFirst = vi.fn(async () => null);
  const tx = { rAContactImport: { create }, rAContact: { createMany } };
  const $transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>, _opts?: unknown) => fn(tx));
  const db = { $transaction, rAContact: { findFirst } };
  return { db, $transaction, createMany, create, findFirst };
}

describe('createPrismaNetworkStore', () => {
  it('saveImport: the 30,000-row cap runs in one transaction with explicit timeout/maxWait, in 1,000-row chunks', async () => {
    const f = fakeDb();
    const store = createPrismaNetworkStore(f.db as never);
    const contacts = Array.from({ length: LINKEDIN_IMPORT_MAX_ROWS }, (_, i) => ({
      market: 'intl',
      ownerUserId: 'u_1',
      companyNameNormalized: 'acme',
      fullName: `Person ${i}`,
      firstName: 'Person',
      title: null,
      linkedinUrl: null,
      connectedOn: null,
    }));
    const id = await store.saveImport({ userId: 'u_1', fileName: 'Connections.csv', rowCount: contacts.length, contacts });
    expect(id).toBe('imp_1');
    expect(f.$transaction).toHaveBeenCalledTimes(1);
    expect(f.$transaction.mock.calls[0]![1]).toEqual(SAVE_IMPORT_TX);
    expect(SAVE_IMPORT_TX.timeout).toBeGreaterThanOrEqual(60_000);
    expect(SAVE_IMPORT_TX.maxWait).toBeGreaterThan(2_000);
    expect(f.createMany).toHaveBeenCalledTimes(Math.ceil(LINKEDIN_IMPORT_MAX_ROWS / CREATE_CHUNK));
    for (const [args] of f.createMany.mock.calls) {
      expect((args as { data: Array<{ linkedinUrl: unknown; sourceRef: unknown }> }).data.every((r) => r.linkedinUrl === null && r.sourceRef === 'imp_1')).toBe(true);
    }
  });

  it('consentedRecruiter reads one recruiter of one bank, and only with a consent basis', async () => {
    const f = fakeDb();
    const store = createPrismaNetworkStore(f.db as never);
    expect(await store.consentedRecruiter('intl', 'robohire', 'u_9')).toBeNull();
    expect(f.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          market: 'intl',
          source: 'bank_recruiter',
          ownerUserId: null,
          consentBasis: { not: null },
          sourceRef: { startsWith: 'robohire:u_9|optin:' },
        },
      }),
    );
  });
});
