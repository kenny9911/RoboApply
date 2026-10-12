// server/src/features/account-v2/store.ts — persistence for two-factor sign-in
// and student verification (WP-79).
//
// SCHEMA REQUESTS (not in the schema yet; SCHEMA-5):
//
// SR-79-1 — ra-platform.prisma (+ back-relation `raTwoFactor RATwoFactor?` on User):
//   /// Seeker two-factor sign-in (TOTP). One row per user; `enabledAt` null =
//   /// enrolment started but not confirmed (the secret is not trusted yet).
//   model RATwoFactor {
//     userId                   String    @id
//     user                     User      @relation(fields: [userId], references: [id], onDelete: Cascade)
//     brand                    String
//     /// AES-256-GCM sealed base32 secret (features/account-v2/sealing.ts); never clear text.
//     secretSealed             String
//     enabledAt                DateTime?
//     /// Last accepted 30-second step: a code is never accepted twice.
//     lastUsedStep             Int?
//     /// sha256 of each unused recovery code.
//     recoveryCodeHashes       String[]  @default([])
//     recoveryCodesGeneratedAt DateTime?
//     createdAt                DateTime  @default(now())
//     updatedAt                DateTime  @updatedAt
//   }
//
// SR-79-2 — ra-platform.prisma (+ back-relation `raStudentVerification RAStudentVerification?` on User):
//   /// School-email verification for student prices (F-ACCT-02). The address
//   /// itself is never stored: only its hash (one school email per account)
//   /// and its domain.
//   model RAStudentVerification {
//     userId          String    @id
//     user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)
//     brand           String
//     /// sha256(lowercase school email) of the verified (or first) address.
//     schoolEmailHash String
//     schoolDomain    String
//     /// The address a code was last sent to; moves into schoolEmailHash /
//     /// schoolDomain only when that code is confirmed, so trying a new
//     /// address never ends a live verification early.
//     pendingEmailHash String?
//     pendingDomain    String?
//     /// sha256 of the pending 6-digit code; null once used.
//     codeHash        String?
//     codeExpiresAt   DateTime?
//     codeAttempts    Int       @default(0)
//     verifiedAt      DateTime?
//     /// Verification lapses (12 months); the student verifies again.
//     expiresAt       DateTime?
//     createdAt       DateTime  @default(now())
//     updatedAt       DateTime  @updatedAt
//     @@index([schoolEmailHash])
//   }
//
// Until SCHEMA-5 adds them, the Prisma adapters reach the delegates through a
// narrow typed view and report `available() === false`, so routes answer 503
// storage_unavailable, and the login challenge hook sees "nobody has two-factor
// on" (true: nobody can have enrolled without the table). After the push they
// work without a code change. The memory stores back the tests.

import prisma from '../../lib/prisma.js';

export interface TwoFactorRow {
  userId: string;
  brand: string;
  secretSealed: string;
  enabledAt: Date | null;
  lastUsedStep: number | null;
  recoveryCodeHashes: string[];
  recoveryCodesGeneratedAt: Date | null;
  createdAt: Date;
}

export interface StudentRow {
  userId: string;
  brand: string;
  schoolEmailHash: string;
  schoolDomain: string;
  pendingEmailHash: string | null;
  pendingDomain: string | null;
  codeHash: string | null;
  codeExpiresAt: Date | null;
  codeAttempts: number;
  verifiedAt: Date | null;
  expiresAt: Date | null;
}

export interface TwoFactorStore {
  /** False until SR-79-1 is in the database client. */
  available(): boolean;
  find(userId: string): Promise<TwoFactorRow | null>;
  /** Starts (or restarts) enrolment: a new unconfirmed secret, no recovery codes. */
  upsertPending(input: { userId: string; brand: string; secretSealed: string }): Promise<TwoFactorRow>;
  /** Confirms enrolment. */
  enable(userId: string, input: { enabledAt: Date; lastUsedStep: number; recoveryCodeHashes: string[] }): Promise<void>;
  /**
   * Accepts a code: sets `lastUsedStep` only when it is still below `step`
   * (compare-and-set), so two requests racing with the same code cannot both
   * win. False when another request already used this step or a later one.
   */
  advanceStep(userId: string, step: number): Promise<boolean>;
  /**
   * Spends one recovery code: removes `hash` only when it is still present
   * (compare-and-set on the list). False when it was already spent.
   */
  spendRecoveryCode(userId: string, hash: string): Promise<boolean>;
  replaceRecoveryCodes(userId: string, hashes: string[], at: Date): Promise<void>;
  remove(userId: string): Promise<void>;
}

export interface StudentStore {
  /** False until SR-79-2 is in the database client. */
  available(): boolean;
  find(userId: string): Promise<StudentRow | null>;
  /** Another user holding a live verification with the same school email. */
  verifiedByOther(schoolEmailHash: string, userId: string, now: Date): Promise<boolean>;
  /**
   * A new code for a school email, held as pending; resets attempts. Any
   * live verification is left as it is until `markVerified` (a mistyped or
   * undeliverable new address must not end it). A first row also takes the
   * pending address as its school address, unverified.
   */
  saveCode(input: {
    userId: string;
    brand: string;
    pendingEmailHash: string;
    pendingDomain: string;
    codeHash: string;
    codeExpiresAt: Date;
  }): Promise<void>;
  /** Increments the attempt counter; returns the new count. */
  countAttempt(userId: string): Promise<number>;
  /** The confirmed address becomes the school address; pending and code are cleared. */
  markVerified(userId: string, input: { schoolEmailHash: string; schoolDomain: string; verifiedAt: Date; expiresAt: Date }): Promise<void>;
}

// ── Prisma adapters (narrow typed views over the SR-79 delegates) ───────

interface Delegate<Row> {
  findUnique(args: object): Promise<Row | null>;
  findFirst(args: object): Promise<Row | null>;
  upsert(args: object): Promise<Row>;
  update(args: object): Promise<Row>;
  updateMany(args: object): Promise<{ count: number }>;
  deleteMany(args: object): Promise<{ count: number }>;
}

interface AccountV2Delegates {
  rATwoFactor: Delegate<TwoFactorRow>;
  rAStudentVerification: Delegate<StudentRow>;
}

export class StoreUnavailableError extends Error {
  constructor(readonly requestId: 'SR-79-1' | 'SR-79-2') {
    super(`${requestId}: the account-v2 tables are not in the database client yet`);
    this.name = 'StoreUnavailableError';
  }
}

export function createPrismaTwoFactorStore(db: object = prisma): TwoFactorStore {
  const view = db as Partial<AccountV2Delegates>;
  const rows = (): Delegate<TwoFactorRow> => {
    if (!view.rATwoFactor) throw new StoreUnavailableError('SR-79-1');
    return view.rATwoFactor;
  };
  return {
    available: () => Boolean(view.rATwoFactor),
    find: (userId) => rows().findUnique({ where: { userId } }),
    upsertPending: ({ userId, brand, secretSealed }) =>
      rows().upsert({
        where: { userId },
        create: { userId, brand, secretSealed, enabledAt: null, lastUsedStep: null, recoveryCodeHashes: [] },
        update: { brand, secretSealed, enabledAt: null, lastUsedStep: null, recoveryCodeHashes: [], recoveryCodesGeneratedAt: null },
      }),
    async enable(userId, { enabledAt, lastUsedStep, recoveryCodeHashes }) {
      await rows().update({ where: { userId }, data: { enabledAt, lastUsedStep, recoveryCodeHashes, recoveryCodesGeneratedAt: enabledAt } });
    },
    async advanceStep(userId, step) {
      const { count } = await rows().updateMany({
        where: { userId, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] },
        data: { lastUsedStep: step },
      });
      return count === 1;
    },
    async spendRecoveryCode(userId, hash) {
      const row = await rows().findUnique({ where: { userId } });
      if (!row || !row.recoveryCodeHashes.includes(hash)) return false;
      const { count } = await rows().updateMany({
        where: { userId, recoveryCodeHashes: { has: hash } },
        data: { recoveryCodeHashes: row.recoveryCodeHashes.filter((h) => h !== hash) },
      });
      return count === 1;
    },
    async replaceRecoveryCodes(userId, hashes, at) {
      await rows().update({ where: { userId }, data: { recoveryCodeHashes: hashes, recoveryCodesGeneratedAt: at } });
    },
    async remove(userId) {
      await rows().deleteMany({ where: { userId } });
    },
  };
}

export function createPrismaStudentStore(db: object = prisma): StudentStore {
  const view = db as Partial<AccountV2Delegates>;
  const rows = (): Delegate<StudentRow> => {
    if (!view.rAStudentVerification) throw new StoreUnavailableError('SR-79-2');
    return view.rAStudentVerification;
  };
  return {
    available: () => Boolean(view.rAStudentVerification),
    find: (userId) => rows().findUnique({ where: { userId } }),
    async verifiedByOther(schoolEmailHash, userId, now) {
      const other = await rows().findFirst({
        where: { schoolEmailHash, userId: { not: userId }, verifiedAt: { not: null }, expiresAt: { gt: now } },
      });
      return Boolean(other);
    },
    async saveCode({ userId, brand, pendingEmailHash, pendingDomain, codeHash, codeExpiresAt }) {
      await rows().upsert({
        where: { userId },
        create: {
          userId,
          brand,
          schoolEmailHash: pendingEmailHash,
          schoolDomain: pendingDomain,
          pendingEmailHash,
          pendingDomain,
          codeHash,
          codeExpiresAt,
          codeAttempts: 0,
        },
        update: { brand, pendingEmailHash, pendingDomain, codeHash, codeExpiresAt, codeAttempts: 0 },
      });
    },
    async countAttempt(userId) {
      const row = await rows().update({ where: { userId }, data: { codeAttempts: { increment: 1 } } });
      return row.codeAttempts;
    },
    async markVerified(userId, { schoolEmailHash, schoolDomain, verifiedAt, expiresAt }) {
      await rows().update({
        where: { userId },
        data: { schoolEmailHash, schoolDomain, verifiedAt, expiresAt, pendingEmailHash: null, pendingDomain: null, codeHash: null, codeExpiresAt: null, codeAttempts: 0 },
      });
    },
  };
}

// ── Memory stores (tests) ───────────────────────────────────────────────

export function createMemoryTwoFactorStore(): TwoFactorStore & { rows: Map<string, TwoFactorRow> } {
  const rows = new Map<string, TwoFactorRow>();
  return {
    rows,
    available: () => true,
    find: async (userId) => (rows.has(userId) ? { ...rows.get(userId)!, recoveryCodeHashes: [...rows.get(userId)!.recoveryCodeHashes] } : null),
    async upsertPending({ userId, brand, secretSealed }) {
      const row: TwoFactorRow = {
        userId,
        brand,
        secretSealed,
        enabledAt: null,
        lastUsedStep: null,
        recoveryCodeHashes: [],
        recoveryCodesGeneratedAt: null,
        createdAt: rows.get(userId)?.createdAt ?? new Date(),
      };
      rows.set(userId, row);
      return { ...row };
    },
    async enable(userId, { enabledAt, lastUsedStep, recoveryCodeHashes }) {
      const row = rows.get(userId);
      if (!row) throw new Error('not found');
      Object.assign(row, { enabledAt, lastUsedStep, recoveryCodeHashes: [...recoveryCodeHashes], recoveryCodesGeneratedAt: enabledAt });
    },
    async advanceStep(userId, step) {
      const row = rows.get(userId);
      if (!row || (row.lastUsedStep !== null && row.lastUsedStep >= step)) return false;
      row.lastUsedStep = step;
      return true;
    },
    async spendRecoveryCode(userId, hash) {
      const row = rows.get(userId);
      if (!row || !row.recoveryCodeHashes.includes(hash)) return false;
      row.recoveryCodeHashes = row.recoveryCodeHashes.filter((h) => h !== hash);
      return true;
    },
    async replaceRecoveryCodes(userId, hashes, at) {
      const row = rows.get(userId);
      if (!row) throw new Error('not found');
      row.recoveryCodeHashes = [...hashes];
      row.recoveryCodesGeneratedAt = at;
    },
    async remove(userId) {
      rows.delete(userId);
    },
  };
}

export function createMemoryStudentStore(): StudentStore & { rows: Map<string, StudentRow> } {
  const rows = new Map<string, StudentRow>();
  return {
    rows,
    available: () => true,
    find: async (userId) => (rows.has(userId) ? { ...rows.get(userId)! } : null),
    async verifiedByOther(schoolEmailHash, userId, now) {
      return [...rows.values()].some(
        (r) => r.userId !== userId && r.schoolEmailHash === schoolEmailHash && r.verifiedAt !== null && r.expiresAt !== null && r.expiresAt > now,
      );
    },
    async saveCode({ userId, brand, pendingEmailHash, pendingDomain, codeHash, codeExpiresAt }) {
      const prev = rows.get(userId);
      rows.set(userId, {
        userId,
        brand,
        schoolEmailHash: prev?.schoolEmailHash ?? pendingEmailHash,
        schoolDomain: prev?.schoolDomain ?? pendingDomain,
        pendingEmailHash,
        pendingDomain,
        codeHash,
        codeExpiresAt,
        codeAttempts: 0,
        verifiedAt: prev?.verifiedAt ?? null,
        expiresAt: prev?.expiresAt ?? null,
      });
    },
    async countAttempt(userId) {
      const row = rows.get(userId);
      if (!row) throw new Error('not found');
      row.codeAttempts += 1;
      return row.codeAttempts;
    },
    async markVerified(userId, { schoolEmailHash, schoolDomain, verifiedAt, expiresAt }) {
      const row = rows.get(userId);
      if (!row) throw new Error('not found');
      Object.assign(row, {
        schoolEmailHash,
        schoolDomain,
        verifiedAt,
        expiresAt,
        pendingEmailHash: null,
        pendingDomain: null,
        codeHash: null,
        codeExpiresAt: null,
        codeAttempts: 0,
      });
    },
  };
}
