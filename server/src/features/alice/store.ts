// server/src/features/alice/store.ts — where Alice keeps her threads, messages and saved profiles.
//
// Two implementations of one interface: Prisma (RAAliceThread, RAAliceMessage,
// RAJobProfile; SCHEMA-10) and an in-memory store for tests. A database
// without the tables answers 503 `ai_unavailable` with reason
// `alice_not_ready` from every call (`notReady`), so the page can say Alice is
// not switched on yet instead of failing; nothing else reads these tables.
//
// Every read is scoped by the user id: a thread or a profile of another user
// is "not found", never another person's data.

import crypto from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import { HttpError } from '../../platform/http.js';
import { ALICE_ERROR_REASONS, type AliceStage } from './contract.js';

export interface ThreadRow {
  id: string;
  userId: string;
  brand: string;
  locale: string;
  stage: AliceStage;
  resumeVariantId: string | null;
  resumeSkipped: boolean;
  brief: unknown;
  topics: unknown;
  pending: unknown;
  analysis: unknown;
  drafts: unknown;
  revisions: unknown;
  currentVersion: number;
  savedProfileId: string | null;
  turnCount: number;
  draftCount: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ThreadPatch = Partial<
  Pick<
    ThreadRow,
    | 'locale'
    | 'stage'
    | 'resumeVariantId'
    | 'resumeSkipped'
    | 'brief'
    | 'topics'
    | 'pending'
    | 'analysis'
    | 'drafts'
    | 'revisions'
    | 'currentVersion'
    | 'savedProfileId'
    | 'turnCount'
    | 'draftCount'
  >
>;

export interface MessageRow {
  id: string;
  threadId: string;
  role: 'user' | 'alice';
  content: string;
  blocks: unknown;
  agent: string | null;
  createdAt: Date;
}

export interface NewMessage {
  role: 'user' | 'alice';
  content: string;
  blocks: unknown[];
  agent: string | null;
}

export interface JobProfileRow {
  id: string;
  userId: string;
  name: string;
  profile: unknown;
  searchProfileId: string | null;
  previousFilters: unknown;
  status: 'active' | 'archived';
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type JobProfilePatch = Partial<Pick<JobProfileRow, 'name' | 'profile' | 'searchProfileId' | 'previousFilters' | 'status' | 'version'>>;

export interface AliceStore {
  activeThread(userId: string): Promise<ThreadRow | null>;
  createThread(input: { userId: string; brand: string; locale: string }): Promise<ThreadRow>;
  updateThread(userId: string, id: string, patch: ThreadPatch): Promise<ThreadRow>;
  archiveThread(userId: string, id: string): Promise<void>;
  /** Appends in order (each one a millisecond after the one before, so the order is stable). */
  addMessages(threadId: string, messages: readonly NewMessage[]): Promise<MessageRow[]>;
  /** The most recent `limit` messages, oldest first. */
  recentMessages(threadId: string, limit: number): Promise<MessageRow[]>;
  listProfiles(userId: string): Promise<JobProfileRow[]>;
  getProfile(userId: string, id: string): Promise<JobProfileRow | null>;
  createProfile(input: Omit<JobProfileRow, 'id' | 'createdAt' | 'updatedAt'>): Promise<JobProfileRow>;
  updateProfile(userId: string, id: string, patch: JobProfilePatch): Promise<JobProfileRow>;
  deleteProfile(userId: string, id: string): Promise<void>;
}

/** Prisma: the table (P2021) or a column (P2022) is not in the database yet; raw queries say 42P01. */
export function isMissingAliceTable(err: unknown): boolean {
  const e = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown } | null;
  if (e?.code === 'P2021' || e?.code === 'P2022') return true;
  if (e?.code === 'P2010' && (e.meta?.code === '42P01' || e.meta?.code === '42703')) return true;
  return typeof e?.message === 'string' && /relation "RA(AliceThread|AliceMessage|JobProfile)" does not exist/i.test(e.message);
}

export function notReadyError(): HttpError {
  return new HttpError('ai_unavailable', 'Alice is not switched on here yet.', { reason: ALICE_ERROR_REASONS.notReady });
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isMissingAliceTable(err)) throw notReadyError();
    throw err;
  }
}

// ── Prisma ─────────────────────────────────────────────────────────────────

type Db = typeof import('../../lib/prisma.js').default;

const THREAD_SELECT = {
  id: true,
  userId: true,
  brand: true,
  locale: true,
  stage: true,
  resumeVariantId: true,
  resumeSkipped: true,
  brief: true,
  topics: true,
  pending: true,
  analysis: true,
  drafts: true,
  revisions: true,
  currentVersion: true,
  savedProfileId: true,
  turnCount: true,
  draftCount: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Nullable Json columns take SQL NULL only as `Prisma.DbNull`; a plain null is refused. */
const NULLABLE_JSON = new Set(['pending', 'analysis', 'previousFilters']);

function jsonValue(key: string, value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (value === null && NULLABLE_JSON.has(key)) return Prisma.DbNull;
  return value as Prisma.InputJsonValue | undefined;
}

export function createPrismaAliceStore(getDb: () => Promise<Db> = async () => (await import('../../lib/prisma.js')).default): AliceStore {
  return {
    activeThread: (userId) =>
      guard(async () => {
        const db = await getDb();
        return (await db.rAAliceThread.findFirst({ where: { userId, archivedAt: null }, orderBy: { createdAt: 'desc' }, select: THREAD_SELECT })) as ThreadRow | null;
      }),
    createThread: (input) =>
      guard(async () => {
        const db = await getDb();
        return (await db.rAAliceThread.create({ data: { userId: input.userId, brand: input.brand, locale: input.locale }, select: THREAD_SELECT })) as ThreadRow;
      }),
    updateThread: (userId, id, patch) =>
      guard(async () => {
        const db = await getDb();
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(patch)) if (v !== undefined) data[k] = jsonValue(k, v);
        const res = await db.rAAliceThread.updateMany({ where: { id, userId }, data });
        if (res.count === 0) throw new HttpError('not_found', 'This conversation is gone.');
        return (await db.rAAliceThread.findFirst({ where: { id, userId }, select: THREAD_SELECT })) as ThreadRow;
      }),
    archiveThread: (userId, id) =>
      guard(async () => {
        const db = await getDb();
        await db.rAAliceThread.updateMany({ where: { id, userId, archivedAt: null }, data: { archivedAt: new Date() } });
      }),
    addMessages: (threadId, messages) =>
      guard(async () => {
        const db = await getDb();
        const base = Date.now();
        const rows: MessageRow[] = [];
        for (let i = 0; i < messages.length; i++) {
          const m = messages[i];
          rows.push(
            (await db.rAAliceMessage.create({
              data: { threadId, role: m.role, content: m.content, blocks: m.blocks as object, agent: m.agent, createdAt: new Date(base + i) },
            })) as MessageRow,
          );
        }
        return rows;
      }),
    recentMessages: (threadId, limit) =>
      guard(async () => {
        const db = await getDb();
        const rows = (await db.rAAliceMessage.findMany({ where: { threadId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit })) as MessageRow[];
        return rows.reverse();
      }),
    listProfiles: (userId) =>
      guard(async () => {
        const db = await getDb();
        return (await db.rAJobProfile.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' } })) as JobProfileRow[];
      }),
    getProfile: (userId, id) =>
      guard(async () => {
        const db = await getDb();
        return (await db.rAJobProfile.findFirst({ where: { id, userId } })) as JobProfileRow | null;
      }),
    createProfile: (input) =>
      guard(async () => {
        const db = await getDb();
        return (await db.rAJobProfile.create({ data: { ...input, profile: input.profile as object, previousFilters: jsonValue('previousFilters', input.previousFilters ?? null) } })) as JobProfileRow;
      }),
    updateProfile: (userId, id, patch) =>
      guard(async () => {
        const db = await getDb();
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(patch)) if (v !== undefined) data[k] = jsonValue(k, v);
        const res = await db.rAJobProfile.updateMany({ where: { id, userId }, data });
        if (res.count === 0) throw new HttpError('not_found', 'This job profile is gone.', { reason: ALICE_ERROR_REASONS.profileNotFound });
        return (await db.rAJobProfile.findFirst({ where: { id, userId } })) as JobProfileRow;
      }),
    deleteProfile: (userId, id) =>
      guard(async () => {
        const db = await getDb();
        const res = await db.rAJobProfile.deleteMany({ where: { id, userId } });
        if (res.count === 0) throw new HttpError('not_found', 'This job profile is gone.', { reason: ALICE_ERROR_REASONS.profileNotFound });
      }),
  };
}

// ── In memory (tests) ──────────────────────────────────────────────────────

export function createMemoryAliceStore(): AliceStore & { threads: ThreadRow[]; messages: MessageRow[]; profiles: JobProfileRow[] } {
  const threads: ThreadRow[] = [];
  const messages: MessageRow[] = [];
  const profiles: JobProfileRow[] = [];
  let clock = Date.UTC(2026, 10, 23, 9, 0, 0);
  const tick = () => new Date((clock += 1000));
  const id = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
  const copy = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
  return {
    threads,
    messages,
    profiles,
    async activeThread(userId) {
      const row = [...threads].reverse().find((t) => t.userId === userId && !t.archivedAt);
      return row ? { ...row } : null;
    },
    async createThread(input) {
      const now = tick();
      const row: ThreadRow = {
        id: id('th'),
        userId: input.userId,
        brand: input.brand,
        locale: input.locale,
        stage: 'intake',
        resumeVariantId: null,
        resumeSkipped: false,
        brief: {},
        topics: {},
        pending: null,
        analysis: null,
        drafts: [],
        revisions: [],
        currentVersion: 0,
        savedProfileId: null,
        turnCount: 0,
        draftCount: 0,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      threads.push(row);
      return { ...row };
    },
    async updateThread(userId, tid, patch) {
      const row = threads.find((t) => t.id === tid && t.userId === userId);
      if (!row) throw new HttpError('not_found', 'This conversation is gone.');
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) (row as unknown as Record<string, unknown>)[k] = copy(v);
      row.updatedAt = tick();
      return { ...row };
    },
    async archiveThread(userId, tid) {
      const row = threads.find((t) => t.id === tid && t.userId === userId);
      if (row) row.archivedAt = tick();
    },
    async addMessages(threadId, list) {
      return list.map((m) => {
        const row: MessageRow = { id: id('msg'), threadId, role: m.role, content: m.content, blocks: copy(m.blocks), agent: m.agent, createdAt: tick() };
        messages.push(row);
        return { ...row };
      });
    },
    async recentMessages(threadId, limit) {
      return messages.filter((m) => m.threadId === threadId).slice(-limit).map((m) => ({ ...m }));
    },
    async listProfiles(userId) {
      return profiles.filter((p) => p.userId === userId).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).map((p) => ({ ...p }));
    },
    async getProfile(userId, pid) {
      const row = profiles.find((p) => p.id === pid && p.userId === userId);
      return row ? { ...row } : null;
    },
    async createProfile(input) {
      const now = tick();
      const row: JobProfileRow = { ...input, profile: copy(input.profile), previousFilters: copy(input.previousFilters), id: id('jp'), createdAt: now, updatedAt: now };
      profiles.push(row);
      return { ...row };
    },
    async updateProfile(userId, pid, patch) {
      const row = profiles.find((p) => p.id === pid && p.userId === userId);
      if (!row) throw new HttpError('not_found', 'This job profile is gone.', { reason: ALICE_ERROR_REASONS.profileNotFound });
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) (row as unknown as Record<string, unknown>)[k] = copy(v);
      row.updatedAt = tick();
      return { ...row };
    },
    async deleteProfile(userId, pid) {
      const i = profiles.findIndex((p) => p.id === pid && p.userId === userId);
      if (i < 0) throw new HttpError('not_found', 'This job profile is gone.', { reason: ALICE_ERROR_REASONS.profileNotFound });
      profiles.splice(i, 1);
    },
  };
}
