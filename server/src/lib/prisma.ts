// Load .env BEFORE pg.Pool reads process.env. Prisma v6's PrismaClient
// deferred connection-string resolution to first query, so env loading in
// index.ts beat the first DB call. v7's driver-adapter setup constructs
// pg.Pool eagerly at module load, which runs before any top-level code in
// index.ts (ESM hoists imports). We load the same .env files index.ts does,
// in the same order, with `override: false` so we don't fight with index.ts
// when both end up running. Idempotent — safe to call again.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __envDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__envDir, '../../.env'), override: false });
dotenv.config({ path: path.resolve(__envDir, '../../../.env'), override: false });

import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { resolvePooledDatabaseUrl, resolveDirectDatabaseUrl } from './databaseUrl.js';

/**
 * Enforce the schema invariant `User.roles[0] === User.role` on every
 * top-level User write. Both fields must be set together; if only one is
 * provided, or roles[0] disagrees with role, the write is rejected with a
 * clear error before it reaches the database. See
 * backend/prisma/schema.prisma:73-74 for the invariant declaration.
 *
 * Why this guard exists: the multi-role migration left scalar `role` and
 * the array `roles[]` as two independent storage sites for the same fact.
 * Drift between them is invisible at runtime — the API gates read scalar
 * `role` while the admin Edit-Roles UI reads `roles[]` — but it can mask
 * who actually has admin privileges. We discovered four phantom admins in
 * production this way. The original drift came from a one-time migration
 * default and a seed bug; both are fixed, but enforcing the invariant at
 * the write boundary is what makes the fix durable.
 */
type RoleData = {
  role?: string | { set?: string };
  roles?: string[] | { set?: string[] };
};

const extractRole = (v: RoleData['role']): string | undefined => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof v.set === 'string') return v.set;
  return undefined;
};
const extractRoles = (v: RoleData['roles']): string[] | undefined => {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object' && Array.isArray(v.set)) return v.set;
  return undefined;
};

const validateRoleInvariant = (data: RoleData | undefined, context: string): void => {
  if (!data) return;
  const hasRole = 'role' in data;
  const hasRoles = 'roles' in data;
  if (!hasRole && !hasRoles) return;

  if (hasRole && !hasRoles) {
    throw new Error(
      `[role-invariant] ${context}: data.role is set without data.roles. ` +
      `Both must be set together to keep roles[0] === role. ` +
      `Set data.roles = [<role>, ...extras] alongside data.role.`,
    );
  }
  if (hasRoles && !hasRole) {
    throw new Error(
      `[role-invariant] ${context}: data.roles is set without data.role. ` +
      `Both must be set together. Set data.role = roles[0] alongside data.roles.`,
    );
  }
  const role = extractRole(data.role);
  const roles = extractRoles(data.roles);
  if (typeof role !== 'string' || !Array.isArray(roles) || roles.length === 0) {
    throw new Error(
      `[role-invariant] ${context}: invalid shape — role must be a string and roles must be a non-empty array. ` +
      `Got role=${JSON.stringify(role)}, roles=${JSON.stringify(roles)}.`,
    );
  }
  if (roles[0] !== role) {
    throw new Error(
      `[role-invariant] ${context}: roles[0] ('${roles[0]}') must equal role ('${role}'). ` +
      `Got roles=${JSON.stringify(roles)}, role='${role}'.`,
    );
  }
};

// ──────────────────────────────────────────────────────────────────────────
// JobMatch preserve-manual contract — Phase 3 v3 redesign.
//
// `matchSingleResume` (Phase 1B) and `kickoffFullJobMatch`'s persistence
// loop already preserve manual recruiter fields by exclusion — the upsert
// `update:` clause only lists score/grade/tier/matchData. That's correct
// today but is an IMPLICIT contract: any future engineer who adds a field
// to the update list (e.g. `viewedAt: now()` to "freshen" the row) silently
// regresses David's "我手工标注的状态会不会被覆盖?" guarantee.
//
// This module exports an assertion function that the rescore writers call
// inline before the DB write. We initially tried AsyncLocalStorage to
// auto-instrument every JobMatch.upsert, but Prisma v7's extended-client
// machinery doesn't preserve ALS context across $extends layers — the
// rescore flag was always observed as `false` inside the extension hook.
// An explicit assertion at each call site is uglier but guaranteed to fire.
//
// The forbidden-on-rescore field set covers every recruiter-action column
// in the schema (status, starred, rejection*, action*, invited*, hold*,
// rejected*, viewed*, reviewed*, applied*) PLUS `aiRecommended` (Phase 2
// invariant — bucket membership snapshot at-screening-time) PLUS `source`
// (never flip on rescore).
// ──────────────────────────────────────────────────────────────────────────

const FORBIDDEN_ON_RESCORE = new Set<string>([
  // Recruiter action triplet (邀约 / 不推进 / 待定) and the v2 status enum.
  'status',
  // Manual flags + decision capture.
  'starred',
  'rejectionReason',
  'rejectionCode',
  'actionTakenAt',
  'actionTakenBy',
  'invitedAt',
  'holdAt',
  'rejectedAt',
  // Manual review + view trail.
  'reviewedAt',
  'reviewedBy',
  'viewedAt',
  'viewedBy',
  // Self-application timestamps (ATS/Applied bucket attribution).
  'appliedAt',
  'appliedBy',
  // Bucket membership snapshot (Phase 2 v3 critique-fix invariant).
  'aiRecommended',
  // Source attribution — never flip on rescore (Phase 1B Applied stays Applied).
  'source',
]);

/**
 * Synchronous safeguard for JobMatch UPDATE/upsert.update payloads on the
 * rescore path. Throws if `data` includes any manual recruiter field.
 *
 * Call this at the top of any rescore-context writer that does an UPDATE
 * on JobMatch — `matchSingleResume`, `kickoffFullJobMatch`'s persist loop,
 * and any future Phase 3 surgical-rescore code path. New engineers who
 * mistakenly add `viewedAt: now()` to "freshen" the row get a clear error
 * pointing at the field they added, before any DB write happens.
 *
 * Safe to call with `undefined` / non-object data (no-op).
 */
export function assertJobMatchUpdateRescoreSafe(data: unknown, caller: string): void {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const violations: string[] = [];
  for (const key of Object.keys(data as Record<string, unknown>)) {
    if (FORBIDDEN_ON_RESCORE.has(key)) violations.push(key);
  }
  if (violations.length > 0) {
    throw new Error(
      `[preserve-manual] ${caller}: rescore-path UPDATE tried to mutate ` +
      `manual field(s): ${violations.join(', ')}. Manual recruiter labor must be preserved ` +
      `through any rescore — only score/grade/tier/matchData/updatedAt may mutate. ` +
      `If this is intentional (a non-rescore writer that needs the same DB shape), ` +
      `restructure the writer to NOT call assertJobMatchUpdateRescoreSafe. ` +
      `See backend/src/lib/prisma.ts FORBIDDEN_ON_RESCORE for the full set.`,
    );
  }
}

// Strip Prisma-specific URL params before handing the connection string to
// pg. The runtime URL has `pgbouncer=true`, `connection_limit`,
// `pool_timeout`, `socket_timeout` — these are Prisma v6 engine knobs that
// pg doesn't understand, and `pgbouncer=true` in particular causes pg to
// reject the connection.
function cleanConnectionString(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    const dropParams = ['pgbouncer', 'connection_limit', 'pool_timeout', 'socket_timeout', 'schema'];
    for (const p of dropParams) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return raw;
  }
}

// Pick the runtime connection URL. Prefer the pooler (DATABASE_URL) over the
// direct endpoint: on Neon, fresh TCP/TLS to the direct compute can take
// 13-19s even when warm, which blows past pg.Pool's connectionTimeoutMillis
// when many slots need to refill at once (e.g. after every-5min idle
// suspend). The pooler completes the same handshake in ~2s.
//
// The historical reason we'd avoided the pooler (P1017 / "Server has closed
// the connection" from pgbouncer's transaction-mode pooling dropping
// connections under us) is covered by the `transient-error-retry` $extends
// layer below — P1017 is now retried transparently on the next pool client.
// `cleanConnectionString` strips Prisma-only knobs (pgbouncer=true, etc.)
// that node-postgres doesn't understand, and PrismaPg's node-postgres
// adapter does not use named/prepared statements by default, so transaction-
// mode pooling is safe for our query workload.
//
// DIRECT_DATABASE_URL is still set in `.env` and consumed by Prisma's CLI
// (db push / migrate) via `directUrl` in schema.prisma — those are the
// operations that genuinely cannot go through pgbouncer.
//
// The pooled/direct URLs are resolved PER BRAND (APP_NAME) by lib/databaseUrl:
// GoHire (APP_NAME=gohire) → LightArk, RoboHire → Neon. With no *_LIGHTARK vars
// set this is identical to reading DATABASE_URL / DIRECT_DATABASE_URL directly.
function pickRuntimeUrl(): string | undefined {
  const pooled = resolvePooledDatabaseUrl();
  if (pooled && pooled.length > 0) return cleanConnectionString(pooled);
  return cleanConnectionString(resolveDirectDatabaseUrl());
}

// Heuristic for transient DB errors that are safe to retry. Covers Prisma's
// own P1017 / "Server has closed the connection", and the underlying pg /
// driver-adapter signatures we've seen in practice.
function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string; cause?: unknown };
  if (e.code === 'P1017') return true;
  const msg = (e.message ?? '').toLowerCase();
  if (
    msg.includes('server has closed the connection') ||
    msg.includes('connection terminated') ||
    msg.includes('connection closed') ||
    msg.includes('econnreset')
  ) return true;
  // Walk one level into the wrapped cause (DriverAdapterError / pg errors).
  if (e.cause) return isTransientDbError(e.cause);
  return false;
}

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 75;

function createPrismaClient() {
  // Fail fast on a missing connection string. Without this guard, `new Pool`
  // receives `connectionString: undefined` and pg silently falls back to
  // libpq defaults (localhost:5432), so the FIRST query — not startup —
  // surfaces a cryptic `Invalid \`prisma.user.findUnique()\` invocation`
  // (really an ECONNREFUSED, 40 frames deep). A clear boot-time error saves
  // that whole debugging detour. See .env.example for the expected keys.
  const runtimeUrl = pickRuntimeUrl();
  if (!runtimeUrl) {
    throw new Error(
      'DATABASE_URL is not set — RoboApply cannot connect to a database. ' +
        'Set DATABASE_URL (and DIRECT_DATABASE_URL) in your .env; see .env.example. ' +
        '(For the GoHire brand, DATABASE_URL_LIGHTARK is also accepted.)',
    );
  }

  // v7 uses driver adapters. We pass a long-lived pg.Pool to PrismaPg so
  // connection management lives at the app layer. Pool sizing tuned for
  // Neon: keep idle connections warm for 10 minutes (the previous v6 URL
  // had pool_timeout=15s but that was Prisma's own queue timeout, not pg's
  // idle timeout — pg's default 10s killed warm connections). `keepAlive`
  // ensures the TCP socket survives Neon's idle disconnect.
  const pool = new Pool({
    connectionString: runtimeUrl,
    // On Vercel serverless, every function instance is short-lived and there
    // may be many concurrent instances — a big per-instance pool exhausts
    // Neon's connection budget fast. Cap at 1 (rely on Neon's pgbouncer pooler
    // for cross-instance sharing). Non-serverless hosts keep the warm pool.
    max: process.env.VERCEL ? 1 : 10,
    // Neon's scale-to-zero suspends the compute after idle. If we hold
    // sockets longer than the suspend window, the kernel keeps them in
    // ESTABLISHED state while the backend is gone — the next query then
    // either inherits a dead socket (P1017) or, worse, the whole pool
    // wedges with 10 stale sockets while new requests queue on
    // connectionTimeoutMillis. 90s aligns with the keepalive interval so
    // any client that misses a keepalive gets recycled before the next
    // suspend window opens.
    idleTimeoutMillis: 90_000,
    connectionTimeoutMillis: 30_000,
    keepAlive: true,
  });

  // pg.Pool emits 'error' on idle clients that die. Silence the default
  // crash behavior — pg has already removed the dead client from the pool,
  // and our $allOperations retry below will recover the in-flight query.
  pool.on('error', () => {});

  const adapter = new PrismaPg(pool);

  const baseClient = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

  // Keep an idle connection alive against Neon. Defaults to ON in
  // production but can be forced via PRISMA_KEEPALIVE_ENABLED=true in dev.
  if (shouldEnableKeepalive()) {
    const keepaliveMs = parseKeepaliveMs();
    setInterval(async () => {
      try {
        await baseClient.$queryRaw`SELECT 1`;
      } catch {
        // Connection lost — Prisma will auto-reconnect on next real query.
      }
    }, keepaliveMs).unref();
  }

  return baseClient.$extends({
    name: 'transient-error-retry',
    query: {
      // Wrap every operation with a small retry loop. Prisma v7 doesn't
      // retry on P1017 / ConnectionClosed itself (see prisma#24490) — pg's
      // pool removes the dead client immediately, so a retry transparently
      // gets a fresh connection. Bounded at 3 attempts with quick backoff
      // so genuinely-broken DBs still surface fast.
      $allOperations: async ({ args, query }) => {
        let attempt = 0;
        while (true) {
          try {
            return await query(args);
          } catch (err) {
            attempt++;
            if (attempt >= RETRY_MAX_ATTEMPTS || !isTransientDbError(err)) {
              throw err;
            }
            await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * attempt));
          }
        }
      },
    },
  }).$extends({
    name: 'role-invariant-guard',
    query: {
      user: {
        create({ args, query }) {
          validateRoleInvariant(args.data as unknown as RoleData, 'User.create');
          return query(args);
        },
        update({ args, query }) {
          validateRoleInvariant(args.data as unknown as RoleData, 'User.update');
          return query(args);
        },
        upsert({ args, query }) {
          validateRoleInvariant(args.create as unknown as RoleData, 'User.upsert.create');
          validateRoleInvariant(args.update as unknown as RoleData, 'User.upsert.update');
          return query(args);
        },
        createMany({ args, query }) {
          const raw = args.data;
          const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
          items.forEach((d, i) =>
            validateRoleInvariant(d as unknown as RoleData, `User.createMany[${i}]`),
          );
          return query(args);
        },
        updateMany({ args, query }) {
          validateRoleInvariant(args.data as unknown as RoleData, 'User.updateMany');
          return query(args);
        },
      },
    },
  }).$extends({
    // ────────────────────────────────────────────────────────────────────
    // Seeker append-only guard (CTO decision D3 in docs/job-seeker/06-cto-decisions.md).
    //
    // `SeekerConsentRecord` and `SeekerActivityLog` are the seeker audit
    // ledger: consent toggles for biometric voice / video recording and a
    // chronological activity trail. Both must be append-only in V1 — a
    // recruiter (or a buggy code path) MUST NOT be able to retroactively
    // edit or erase what a seeker consented to, nor rewrite the history
    // of what we told them happened on their account. V2 will replace
    // this with Postgres RLS; V1 lives at the Prisma extension layer.
    //
    // The guard ONLY rejects mutating actions (`update`, `updateMany`,
    // `delete`, `deleteMany`). It MUST NEVER reject `create` /
    // `createMany` — that would silently break the audit logger itself.
    // Read actions are untouched.
    //
    // Surfaces a clear error so the engineer who tries to do this in a
    // refactor sees exactly why their write was rejected, with a pointer
    // back to the design doc.
    // ────────────────────────────────────────────────────────────────────
    name: 'seeker-append-only-guard',
    query: {
      seekerConsentRecord: {
        update() {
          throw new Error('SeekerConsentRecord is append-only — UPDATE/DELETE rejected');
        },
        updateMany() {
          throw new Error('SeekerConsentRecord is append-only — UPDATE/DELETE rejected');
        },
        delete() {
          throw new Error('SeekerConsentRecord is append-only — UPDATE/DELETE rejected');
        },
        deleteMany() {
          throw new Error('SeekerConsentRecord is append-only — UPDATE/DELETE rejected');
        },
        upsert() {
          // `upsert` reduces to UPDATE on conflict — also forbidden, since
          // the whole point of append-only is that every change is a new
          // row. Engineers who hit this should switch to `create`.
          throw new Error('SeekerConsentRecord is append-only — UPDATE/DELETE rejected');
        },
      },
      seekerActivityLog: {
        update() {
          throw new Error('SeekerActivityLog is append-only — UPDATE/DELETE rejected');
        },
        updateMany() {
          throw new Error('SeekerActivityLog is append-only — UPDATE/DELETE rejected');
        },
        delete() {
          throw new Error('SeekerActivityLog is append-only — UPDATE/DELETE rejected');
        },
        deleteMany() {
          throw new Error('SeekerActivityLog is append-only — UPDATE/DELETE rejected');
        },
        upsert() {
          throw new Error('SeekerActivityLog is append-only — UPDATE/DELETE rejected');
        },
      },
      // SCRM / CS Copilot immutable audit ledger. Every AI/automation action
      // (email drafted/sent, alert raised, autonomy toggled, profile refreshed)
      // writes one immutable AIAuditLog row. Append-only so "did the AI really
      // do/send this?" can never be retroactively rewritten. Reversals must
      // insert a sibling row, never mutate. Prisma delegate is `aIAuditLog`
      // (only the first character is lowercased). See schema model AIAuditLog.
      aIAuditLog: {
        update() {
          throw new Error('AIAuditLog is append-only — UPDATE/DELETE rejected');
        },
        updateMany() {
          throw new Error('AIAuditLog is append-only — UPDATE/DELETE rejected');
        },
        delete() {
          throw new Error('AIAuditLog is append-only — UPDATE/DELETE rejected');
        },
        deleteMany() {
          throw new Error('AIAuditLog is append-only — UPDATE/DELETE rejected');
        },
        upsert() {
          throw new Error('AIAuditLog is append-only — UPDATE/DELETE rejected');
        },
      },
    },
  });
}

type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

// Transaction-callback parameter type for the extended client. Use this in
// helper signatures that previously accepted `Prisma.TransactionClient` —
// `$extends` produces a different (omit-some-methods) shape, and the legacy
// type is no longer assignable.
export type ExtendedTransactionClient = Omit<
  ExtendedPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

declare global {
  // eslint-disable-next-line no-var
  var prisma: ExtendedPrismaClient | undefined;
}

function shouldEnableKeepalive(): boolean {
  const override = process.env.PRISMA_KEEPALIVE_ENABLED?.trim().toLowerCase();
  if (override === 'true') return true;
  if (override === 'false') return false;
  // On Vercel there is no long-lived process to keep a connection warm — a
  // setInterval would dangle across the frozen instance. Serverless relies on
  // Neon's pooler instead. Opt back in with PRISMA_KEEPALIVE_ENABLED=true.
  if (process.env.VERCEL) return false;
  // v7 keepalive is always on by default — the driver-adapter setup means
  // the pool is responsible for connection liveness, and Neon's idle
  // disconnect kills warm connections silently otherwise. Set
  // PRISMA_KEEPALIVE_ENABLED=false to opt out (e.g. on local SQL where
  // Neon's quirks don't apply).
  return true;
}

function parseKeepaliveMs(): number {
  // 90s — well under Neon's ~5 minute idle disconnect window. Lower than
  // v6's 4 min default because the pool now has 10 potential connections
  // and we want to touch each within Neon's window.
  const fallbackMs = 90_000;
  const parsed = Number.parseInt(process.env.PRISMA_KEEPALIVE_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

export const prisma = global.prisma || createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

export default prisma;
