// server/src/features/auth-cn/inviteService.ts — GoApply invite codes, used only when the
// operator sets `CN_SIGNUP_MODE=invite` (sign-up is open by default, D5;
// CN_TW_LAUNCH_PLAN.md §3; TASK_PLAN.md WP-11).
//
// Codes are generated here, shown ONCE to the admin who creates them, and
// stored only as a sha256 of the normalized code (`RABrandInvite.codeHash`).
// Redemption is a compare-and-set on `uses`, so two signups can never spend
// the last use of a code twice.

import crypto from 'node:crypto';
import type { BrandId } from '../../platform/brand/registry.js';
import {
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  normalizeInviteCode,
  type InviteStatus,
  type InviteView,
} from './contract.js';
import type { AuthCnDb, AuthCnTx } from './db.js';
import { AuthCnError } from './errors.js';

export const INVITE_PAGE_SIZE = 100;

export function hashInviteCode(raw: string): string {
  return crypto.createHash('sha256').update(normalizeInviteCode(raw)).digest('hex');
}

/** `ABCDE-FGHJK` (unambiguous alphabet, crypto randomness). */
export function generateInviteCode(): string {
  let out = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) out += INVITE_CODE_ALPHABET[crypto.randomInt(0, INVITE_CODE_ALPHABET.length)];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

interface InviteRow {
  id: string;
  brand: string;
  maxUses: number;
  uses: number;
  expiresAt: Date | null;
  note: string | null;
  createdAt: Date;
}

export function inviteStatus(row: Pick<InviteRow, 'uses' | 'maxUses' | 'expiresAt'>, now: Date): InviteStatus {
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (row.uses >= row.maxUses) return 'used';
  return 'active';
}

function toView(row: InviteRow, now: Date, code: string | null): InviteView {
  return {
    id: row.id,
    code,
    maxUses: row.maxUses,
    usedCount: row.uses,
    status: inviteStatus(row, now),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

const SELECT = { id: true, brand: true, maxUses: true, uses: true, expiresAt: true, note: true, createdAt: true } as const;

export interface InviteDeps {
  db: AuthCnDb;
  now: () => Date;
}

/** The one delegate invite redemption touches (a Prisma transaction client satisfies it). */
export type InviteTx = Pick<AuthCnTx, 'rABrandInvite'>;

/** Read-only check (no use spent). Throws invite_invalid. */
export async function assertInviteRedeemable(db: InviteTx, brand: BrandId, rawCode: string, now: Date): Promise<void> {
  const row = await db.rABrandInvite.findUnique({ where: { codeHash: hashInviteCode(rawCode) }, select: SELECT });
  if (!row || row.brand !== brand || inviteStatus(row, now) !== 'active') throw new AuthCnError('invite_invalid');
}

/**
 * Spends one use of a code inside the caller's transaction — the SAME
 * transaction that creates the account, so a failed redemption rolls the
 * account back and the last use of a code can never be spent twice.
 * Throws invite_invalid.
 */
export async function redeemInviteIn(tx: InviteTx, brand: BrandId, rawCode: string, now: Date): Promise<string> {
  const codeHash = hashInviteCode(rawCode);
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await tx.rABrandInvite.findUnique({ where: { codeHash }, select: SELECT });
    if (!row || row.brand !== brand || inviteStatus(row, now) !== 'active') throw new AuthCnError('invite_invalid');
    const res = await tx.rABrandInvite.updateMany({ where: { id: row.id, uses: row.uses }, data: { uses: row.uses + 1 } });
    if (res.count === 1) return row.id;
  }
  throw new AuthCnError('invite_invalid');
}

export function createInviteService(deps: InviteDeps) {
  const { db } = deps;
  return {
    /** Creates `count` codes; the raw codes are in the result and nowhere else. */
    async create(
      brand: BrandId,
      adminUserId: string | null,
      input: { count: number; maxUses: number; expiresAt?: string; note?: string },
    ): Promise<{ items: InviteView[] }> {
      const now = deps.now();
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
      const items: InviteView[] = [];
      await db.$transaction(async (tx) => {
        for (let i = 0; i < input.count; i++) {
          const code = generateInviteCode();
          const row = await tx.rABrandInvite.create({
            data: { brand, codeHash: hashInviteCode(code), maxUses: input.maxUses, expiresAt, note: input.note ?? null, createdBy: adminUserId },
            select: SELECT,
          });
          items.push(toView(row, now, code));
        }
      });
      return { items };
    },

    /** Newest first, 100 per page; `cursor` is the `createdAt` of the last row of the previous page. */
    async list(brand: BrandId, query: { status?: InviteStatus; cursor?: string }): Promise<{ items: InviteView[]; cursor: string | null }> {
      const now = deps.now();
      const before = query.cursor ? new Date(query.cursor) : null;
      const rows = await db.rABrandInvite.findMany({
        where: { brand, ...(before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}) },
        orderBy: { createdAt: 'desc' },
        take: INVITE_PAGE_SIZE,
        select: SELECT,
      });
      const items = rows.map((r) => toView(r, now, null)).filter((v) => !query.status || v.status === query.status);
      const last = rows[rows.length - 1];
      return { items, cursor: rows.length === INVITE_PAGE_SIZE && last ? last.createdAt.toISOString() : null };
    },

    /** Read-only check (no use spent): does this code work on this brand now? */
    async isRedeemable(brand: BrandId, rawCode: string): Promise<boolean> {
      const row = await db.rABrandInvite.findUnique({ where: { codeHash: hashInviteCode(rawCode) }, select: SELECT });
      return Boolean(row && row.brand === brand && inviteStatus(row, deps.now()) === 'active');
    },

    /** Spends one use (own transaction). Throws invite_invalid. */
    async redeem(brand: BrandId, rawCode: string): Promise<void> {
      await db.$transaction((tx) => redeemInviteIn(tx, brand, rawCode, deps.now()));
    },
  };
}

export type InviteService = ReturnType<typeof createInviteService>;
