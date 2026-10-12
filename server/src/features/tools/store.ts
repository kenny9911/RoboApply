// server/src/features/tools/store.ts
//
// The narrow, typed Prisma adapter for the free tools (WP-57). The service
// talks to these interfaces only, so tests run against the in-memory twin in
// ./memoryStore.ts and never touch the database.
//
// Where a result lives: one `RAAuthToken` row of kind `tool_result` — the
// table that already holds single-use, expiring hand-off tokens (magic links,
// extension pairing). `tokenHash` is the sha256 of the result id the visitor
// holds (the raw id is never stored); `payload` is the 24 h cache entry
// (`ToolResultPayload`, which also holds sha256 of the browser's visitor
// cookie); `userId`/`consumedAt` are set when a signed-in user claims it. No
// original file is stored anywhere.
//
// A repeat run answered from the cache gets its own result id: that id is a
// separate row of kind `tool_result_alias` (same brand and expiry) whose
// payload points at the result row, so every lookup goes through the unique
// `tokenHash` index — never a scan of payload JSON.
//
// Rows of both kinds are deleted by `purgeExpired` (./cron.ts in
// `jobs-maintain`, plus every tool run), by WP-10's used/expired token purge
// and by WP-13's `auth_tokens` retention.
//
// Today's allowance is the platform limiter's `RARateCounter` row for
// `publicToolsPerIp` (read-only here; the service consumes it).

import crypto from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ToolKind } from './contract.js';

export const TOOL_RESULT_TOKEN_KIND = 'tool_result';
/** A further result id for a cached `tool_result` row (payload `{ v: 1, of: <row id> }`). */
export const TOOL_RESULT_ALIAS_KIND = 'tool_result_alias';
const TOOL_KINDS_STORED = [TOOL_RESULT_TOKEN_KIND, TOOL_RESULT_ALIAS_KIND];

/** The stored part of a report (no result id, expiry or view flags). */
export interface StoredCheckReport {
  kind: 'resume_check';
  label: string;
  counts: { urgent: number; critical: number; optional: number };
  issues: unknown[];
  rulesChecked: number | null;
  profile: string;
}

export interface StoredMatchReport {
  kind: 'resume_job_match';
  postingTitle: string;
  rows: unknown[];
  keywords: { matched: string[]; missing: string[] };
  hardSkills: { matched: string[]; missing: string[] };
}

export type StoredReport = StoredCheckReport | StoredMatchReport;

/** `RAAuthToken.payload` of a `tool_result` row. */
export interface ToolResultPayload {
  v: 1;
  tool: ToolKind;
  /** sha256 over brand, tool, file hash, posting hash, the visitor's hashed IP and the visitor-cookie hash. */
  cacheKey: string;
  report: StoredReport;
  /** The text read from the file (markdown), redacted per the brand rule; null once claimed. */
  resume: { markdown: string; name: string } | null;
  /** sha256 of the visitor cookie of the browser that ran the check (reads and the claim must present it). */
  visitorHash: string;
  /** GoApply: the processing notice the visitor ticked, and when (evidence if the result is kept). */
  consent?: { version: string; at: string };
  /** Set on claim. */
  claimedResumeId?: string;
}

export interface ToolResultRow {
  id: string;
  brand: string;
  tokenHash: string;
  payload: ToolResultPayload;
  userId: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface NewToolResult {
  brand: string;
  tokenHash: string;
  payload: ToolResultPayload;
  expiresAt: Date;
}

export interface ToolsStore {
  /** A live (unexpired, unclaimed) result with this cache key. */
  findByCacheKey(brand: string, cacheKey: string, now: Date): Promise<ToolResultRow | null>;
  /** This brand's result row whose own token hash is `tokenHash`, or that an alias row with this hash points at. */
  findByTokenHash(brand: string, tokenHash: string): Promise<ToolResultRow | null>;
  create(input: NewToolResult): Promise<ToolResultRow>;
  /** Add a further result id for a cached row (an alias row; earlier ids stay valid). */
  addTokenAlias(row: Pick<ToolResultRow, 'id' | 'brand' | 'expiresAt'>, tokenHash: string): Promise<void>;
  /** Atomically mark the row claimed by `userId`; false when someone got there first. */
  markClaimed(id: string, userId: string, now: Date): Promise<boolean>;
  /** Undo `markClaimed` (the resume could not be created). */
  unclaim(id: string): Promise<void>;
  /** Replace the payload after a claim (drops the resume text). */
  savePayload(id: string, payload: ToolResultPayload): Promise<void>;
  /** Delete this brand's tool results (and alias rows) that expired, claimed or not. */
  purgeExpired(brand: string, now: Date): Promise<number>;
}

/** sha256 hex of the raw result id (what `tokenHash` holds). */
export function hashResultId(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** A fresh result id: 32 random bytes, base64url (43 characters). */
export function newResultId(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function isPayload(value: unknown): value is ToolResultPayload {
  const v = value as Partial<ToolResultPayload> | null;
  return (
    !!v &&
    typeof v === 'object' &&
    v.v === 1 &&
    typeof v.cacheKey === 'string' &&
    typeof v.visitorHash === 'string' &&
    !!v.report &&
    typeof v.report === 'object'
  );
}

/** The result row id an alias row points at, or null. */
function aliasTarget(value: unknown): string | null {
  const v = value as { v?: unknown; of?: unknown } | null;
  return !!v && typeof v === 'object' && v.v === 1 && typeof v.of === 'string' && v.of ? v.of : null;
}

interface TokenRecord {
  id: string;
  brand: string;
  kind: string;
  tokenHash: string;
  payload: Prisma.JsonValue | null;
  userId: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

function toRow(r: TokenRecord | null): ToolResultRow | null {
  if (!r || r.kind !== TOOL_RESULT_TOKEN_KIND || !isPayload(r.payload)) return null;
  return {
    id: r.id,
    brand: r.brand,
    tokenHash: r.tokenHash,
    payload: r.payload,
    userId: r.userId,
    expiresAt: r.expiresAt,
    consumedAt: r.consumedAt,
    createdAt: r.createdAt,
  };
}

const json = (v: ToolResultPayload) => v as unknown as Prisma.InputJsonValue;

const SELECT = {
  id: true,
  brand: true,
  kind: true,
  tokenHash: true,
  payload: true,
  userId: true,
  expiresAt: true,
  consumedAt: true,
  createdAt: true,
} as const;

export function createPrismaToolsStore(): ToolsStore {
  const db = async () => (await import('../../lib/prisma.js')).default;
  return {
    async findByCacheKey(brand, cacheKey, now) {
      const p = await db();
      const r = await p.rAAuthToken.findFirst({
        where: {
          kind: TOOL_RESULT_TOKEN_KIND,
          brand,
          consumedAt: null,
          expiresAt: { gt: now },
          payload: { path: ['cacheKey'], equals: cacheKey },
        },
        orderBy: { createdAt: 'desc' },
        select: SELECT,
      });
      return toRow(r);
    },
    async findByTokenHash(brand, tokenHash) {
      const p = await db();
      const hit = await p.rAAuthToken.findUnique({ where: { tokenHash }, select: SELECT });
      if (!hit || hit.brand !== brand) return null;
      if (hit.kind === TOOL_RESULT_TOKEN_KIND) return toRow(hit);
      if (hit.kind !== TOOL_RESULT_ALIAS_KIND) return null;
      const target = aliasTarget(hit.payload);
      if (!target) return null;
      const row = toRow(await p.rAAuthToken.findUnique({ where: { id: target }, select: SELECT }));
      return row && row.brand === brand ? row : null;
    },
    async create(input) {
      const p = await db();
      const r = await p.rAAuthToken.create({
        data: { kind: TOOL_RESULT_TOKEN_KIND, brand: input.brand, tokenHash: input.tokenHash, payload: json(input.payload), expiresAt: input.expiresAt },
        select: SELECT,
      });
      const row = toRow(r);
      if (!row) throw new Error('tool result row could not be read back');
      return row;
    },
    async addTokenAlias(row, tokenHash) {
      const p = await db();
      await p.rAAuthToken.create({
        data: { kind: TOOL_RESULT_ALIAS_KIND, brand: row.brand, tokenHash, payload: { v: 1, of: row.id }, expiresAt: row.expiresAt },
        select: { id: true },
      });
    },
    async markClaimed(id, userId, now) {
      const p = await db();
      const res = await p.rAAuthToken.updateMany({ where: { id, kind: TOOL_RESULT_TOKEN_KIND, consumedAt: null }, data: { consumedAt: now, userId } });
      return res.count === 1;
    },
    async unclaim(id) {
      const p = await db();
      await p.rAAuthToken.updateMany({ where: { id, kind: TOOL_RESULT_TOKEN_KIND }, data: { consumedAt: null, userId: null } });
    },
    async savePayload(id, payload) {
      const p = await db();
      await p.rAAuthToken.update({ where: { id }, data: { payload: json(payload) } });
    },
    async purgeExpired(brand, now) {
      const p = await db();
      const res = await p.rAAuthToken.deleteMany({ where: { kind: { in: TOOL_KINDS_STORED }, brand, expiresAt: { lte: now } } });
      return res.count;
    },
  };
}

// ── Today's allowance (read-only view of the platform limiter) ───────────

export interface RateWindowRead {
  /** Full counter key including the `:<windowSec>` suffix the limiter appends. */
  key: string;
  windowStart: Date;
}

export interface RateCounterReader {
  /** Current count of each window (0 when no row). */
  counts(windows: RateWindowRead[]): Promise<number[]>;
}

export function createPrismaRateCounterReader(): RateCounterReader {
  return {
    async counts(windows) {
      const { default: p } = await import('../../lib/prisma.js');
      return Promise.all(
        windows.map(async (w) => {
          const row = await p.rARateCounter.findUnique({ where: { key_windowStart: { key: w.key, windowStart: w.windowStart } }, select: { count: true } });
          return row?.count ?? 0;
        }),
      );
    },
  };
}
