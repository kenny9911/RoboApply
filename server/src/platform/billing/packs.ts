// server/src/platform/billing/packs.ts
//
// Practice packs (PRODUCT_PLAN.md §6.3: 5 or 15 practice credits, valid 12
// months, any plan). A pack ADDS credits to the practice balance once per
// order (idempotent through the practice ledger key) and records an
// RACreditGrant row (bucket 'practice', reason 'pack') so plan renewals keep
// unspent pack credits and the pack expires on time (lib/mockCreditService.ts).
//
// Crash safety: the RACreditGrant row has a deterministic id derived from the
// purchase's idempotency key and is upserted whenever the credit grant is
// done ('granted' OR 'already_granted'). A replay after a crash between the
// two writes therefore still creates the row, so the next plan grant (which
// SETS the balance and carries only pack rows) keeps the pack credits.

import { createHash } from 'node:crypto';
import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import { grantPracticeCredit as defaultGrant, type PracticeGrantResult } from '../credits/practice.js';
import { PACK_VALID_MONTHS } from './refunds.js';

export type PackDb = Pick<ExtendedPrismaClient, 'rACreditGrant'>;

export interface GrantPackInput {
  userId: string;
  credits: number;
  /** One per purchase: 'stripe:<checkoutSessionId>' | 'order:<AlipayOrder.id>'. */
  idempotencyKey: string;
  purchasedAt: Date;
}

export interface PackDeps {
  getDb?: () => Promise<PackDb>;
  grant?: typeof defaultGrant;
}

const defaultGetDb = async (): Promise<PackDb> => (await import('../../lib/prisma.js')).default;

export function packExpiry(purchasedAt: Date): Date {
  const d = new Date(purchasedAt.getTime());
  d.setUTCMonth(d.getUTCMonth() + PACK_VALID_MONTHS);
  return d;
}

/** Deterministic RACreditGrant id for one pack purchase (same key → same row). */
export function packGrantId(userId: string, idempotencyKey: string): string {
  return `pack_${createHash('sha256').update(`${userId}|${idempotencyKey}`, 'utf8').digest('hex').slice(0, 40)}`;
}

export async function grantPracticePack(input: GrantPackInput, deps: PackDeps = {}): Promise<PracticeGrantResult> {
  const grant = deps.grant ?? defaultGrant;
  const res = await grant(input.userId, 'pack_purchase', input.idempotencyKey, { credits: input.credits });
  if (res.status === 'granted' || res.status === 'already_granted') {
    const db = await (deps.getDb ?? defaultGetDb)();
    // update: {} — an existing row keeps its spent `remaining` and expiry.
    await db.rACreditGrant.upsert({
      where: { id: packGrantId(input.userId, input.idempotencyKey) },
      update: {},
      create: {
        id: packGrantId(input.userId, input.idempotencyKey),
        userId: input.userId,
        bucket: 'practice',
        amount: input.credits,
        remaining: input.credits,
        reason: 'pack',
        expiresAt: packExpiry(input.purchasedAt),
      },
    });
  }
  return res;
}
