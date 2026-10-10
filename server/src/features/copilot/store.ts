// server/src/features/copilot/store.ts — the Assistant's own tables (WP-50).
//
// RACopilotThread / RACopilotMessage / RACopilotProposal / RACopilotMemory,
// plus two narrow reads it needs elsewhere (the user's display name, so it
// can be redacted from prompts, and the primary resume id). Typed Prisma
// only; the service talks to this interface, tests run it over fakePrisma.

import crypto from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import type { CopilotCard, CopilotFeedbackRow, ProposalKind, ProposalStatus } from './contract.js';

type PrismaClientLike = typeof import('../../lib/prisma.js').default;

export interface ThreadRow {
  id: string;
  userId: string;
  brand: string;
  title: string | null;
  contextJobId: string | null;
  summary: string | null;
  summarizedThroughId: string | null;
  messageCount: number;
  lastMessageAt: Date;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface MessageRow {
  id: string;
  threadId: string;
  role: string;
  content: string;
  cards: unknown;
  toolCalls: unknown;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  feedback: string | null;
  feedbackNote: string | null;
  createdAt: Date;
}

export interface ProposalRow {
  id: string;
  threadId: string;
  userId: string;
  kind: string;
  payload: unknown;
  status: string;
  expiresAt: Date;
  appliedAt: Date | null;
  createdAt: Date;
}

export interface MemoryRow {
  id: string;
  userId: string;
  fact: string;
  source: string;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface SaveTurnInput {
  threadId: string;
  user: { content: string; createdAt: Date };
  assistant: {
    id: string;
    content: string;
    cards: CopilotCard[];
    toolCalls: unknown[];
    model: string | null;
    tokensIn: number;
    tokensOut: number;
    createdAt: Date;
  };
  costUsd: number;
  /** Set the thread title when it has none. */
  title: string | null;
  contextJobId: string | null;
}

export interface CopilotStore {
  listThreads(userId: string, brand: string, limit: number): Promise<ThreadRow[]>;
  createThread(input: { userId: string; brand: string; contextJobId: string | null }): Promise<ThreadRow>;
  getThread(id: string): Promise<ThreadRow | null>;
  archiveThread(id: string, at: Date): Promise<void>;
  /** Newest first; `before` = a message id of this thread. */
  listMessages(threadId: string, options: { before?: string; limit: number }): Promise<MessageRow[]>;
  /** The last `n` messages, oldest first. */
  recentMessages(threadId: string, n: number): Promise<MessageRow[]>;
  /** Messages after `afterId` (all when null), oldest first. */
  messagesAfter(threadId: string, afterId: string | null, limit: number): Promise<MessageRow[]>;
  getMessage(id: string): Promise<MessageRow | null>;
  /** Persist the user message and the reply together; returns the thread's new message count. */
  saveTurn(input: SaveTurnInput): Promise<{ messageCount: number }>;
  setFeedback(messageId: string, value: 'up' | 'down', note: string | null): Promise<void>;
  appendCard(messageId: string, card: CopilotCard): Promise<void>;
  /**
   * Read-modify-write of a message's cards under a row lock (`FOR UPDATE` in
   * one transaction), so two proposals on one message applied at once never
   * overwrite each other's status or result card.
   */
  updateCards(messageId: string, update: (cards: CopilotCard[]) => CopilotCard[]): Promise<void>;
  updateSummary(threadId: string, summary: string, throughId: string): Promise<void>;
  createProposal(input: { id?: string; threadId: string; userId: string; kind: ProposalKind; payload: Record<string, unknown>; expiresAt: Date }): Promise<ProposalRow>;
  getProposal(id: string): Promise<ProposalRow | null>;
  getProposals(ids: string[]): Promise<ProposalRow[]>;
  /** Moves a proposal from `from` to `to` (compare-and-set); false when it was not in `from`. */
  transitionProposal(id: string, from: ProposalStatus, to: ProposalStatus, at: Date): Promise<boolean>;
  listMemory(userId: string): Promise<MemoryRow[]>;
  countMemory(userId: string): Promise<number>;
  createMemory(input: { userId: string; fact: string; source: 'user_said' | 'user_confirmed' }): Promise<MemoryRow>;
  /**
   * Count and create under one per-user advisory lock: returns null (nothing
   * stored) when the user already has `max` live facts, so two concurrent
   * applies at `max - 1` store one fact, not two.
   */
  createMemoryCapped(input: { userId: string; fact: string; source: 'user_said' | 'user_confirmed' }, max: number): Promise<MemoryRow | null>;
  deleteMemory(userId: string, id: string, at: Date): Promise<boolean>;
  listFeedback(options: { cursor?: string; limit: number }): Promise<{ items: CopilotFeedbackRow[]; cursor: string | null }>;
  userName(userId: string): Promise<string | null>;
  /**
   * @deprecated Reads the resume area's `RAResumeVariant` directly. Replace
   * with `resume.primaryVariantId(userId)` from `resume/index.ts` (REQ-50-03).
   */
  primaryResumeId(userId: string): Promise<string | null>;
  /** Cost row (units 0) under SKU `ra_copilot_turn`; the `assistant` credit commit writes the charged row. */
  logCost(input: { userId: string; costUsd: number; requestId: string | null; messageId: string; metadata: Record<string, unknown> }): Promise<void>;
}

const THREAD_SELECT = {
  id: true,
  userId: true,
  brand: true,
  title: true,
  contextJobId: true,
  summary: true,
  summarizedThroughId: true,
  messageCount: true,
  lastMessageAt: true,
  archivedAt: true,
  createdAt: true,
} as const;

const MESSAGE_SELECT = {
  id: true,
  threadId: true,
  role: true,
  content: true,
  cards: true,
  toolCalls: true,
  model: true,
  tokensIn: true,
  tokensOut: true,
  feedback: true,
  feedbackNote: true,
  createdAt: true,
} as const;

const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

/** Newest-first keyset after a message (createdAt desc, id desc). */
function beforeWhere(row: { createdAt: Date; id: string }): Prisma.RACopilotMessageWhereInput {
  return { OR: [{ createdAt: { lt: row.createdAt } }, { createdAt: row.createdAt, id: { lt: row.id } }] };
}

export function createPrismaCopilotStore(getDb: () => Promise<PrismaClientLike> = async () => (await import('../../lib/prisma.js')).default): CopilotStore {
  const store: CopilotStore = {
    async listThreads(userId, brand, limit) {
      const p = await getDb();
      return p.rACopilotThread.findMany({ where: { userId, brand, archivedAt: null }, orderBy: { lastMessageAt: 'desc' }, take: limit, select: THREAD_SELECT });
    },
    async createThread(input) {
      const p = await getDb();
      return p.rACopilotThread.create({ data: { userId: input.userId, brand: input.brand, contextJobId: input.contextJobId }, select: THREAD_SELECT });
    },
    async getThread(id) {
      const p = await getDb();
      return p.rACopilotThread.findUnique({ where: { id }, select: THREAD_SELECT });
    },
    async archiveThread(id, at) {
      const p = await getDb();
      await p.rACopilotThread.updateMany({ where: { id, archivedAt: null }, data: { archivedAt: at } });
    },
    async listMessages(threadId, options) {
      const p = await getDb();
      let where: Prisma.RACopilotMessageWhereInput = { threadId, role: { in: ['user', 'assistant'] } };
      if (options.before) {
        const anchor = await p.rACopilotMessage.findFirst({ where: { id: options.before, threadId }, select: { id: true, createdAt: true } });
        if (anchor) where = { AND: [where, beforeWhere(anchor)] };
      }
      return p.rACopilotMessage.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: options.limit, select: MESSAGE_SELECT });
    },
    async recentMessages(threadId, n) {
      const p = await getDb();
      const rows = await p.rACopilotMessage.findMany({
        where: { threadId, role: { in: ['user', 'assistant'] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: n,
        select: MESSAGE_SELECT,
      });
      return rows.reverse();
    },
    async messagesAfter(threadId, afterId, limit) {
      const p = await getDb();
      let where: Prisma.RACopilotMessageWhereInput = { threadId, role: { in: ['user', 'assistant'] } };
      if (afterId) {
        const anchor = await p.rACopilotMessage.findFirst({ where: { id: afterId, threadId }, select: { id: true, createdAt: true } });
        if (anchor) where = { AND: [where, { OR: [{ createdAt: { gt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { gt: anchor.id } }] }] };
      }
      return p.rACopilotMessage.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limit, select: MESSAGE_SELECT });
    },
    async getMessage(id) {
      const p = await getDb();
      return p.rACopilotMessage.findUnique({ where: { id }, select: MESSAGE_SELECT });
    },
    async saveTurn(input) {
      const p = await getDb();
      return p.$transaction(async (tx) => {
        await tx.rACopilotMessage.create({
          data: { threadId: input.threadId, role: 'user', content: input.user.content, cards: json([]), createdAt: input.user.createdAt },
        });
        await tx.rACopilotMessage.create({
          data: {
            id: input.assistant.id,
            threadId: input.threadId,
            role: 'assistant',
            content: input.assistant.content,
            cards: json(input.assistant.cards),
            toolCalls: json(input.assistant.toolCalls),
            model: input.assistant.model,
            tokensIn: input.assistant.tokensIn,
            tokensOut: input.assistant.tokensOut,
            createdAt: input.assistant.createdAt,
          },
        });
        const current = await tx.rACopilotThread.findUnique({ where: { id: input.threadId }, select: { title: true } });
        const updated = await tx.rACopilotThread.update({
          where: { id: input.threadId },
          data: {
            messageCount: { increment: 2 },
            tokensIn: { increment: input.assistant.tokensIn },
            tokensOut: { increment: input.assistant.tokensOut },
            costUsd: { increment: input.costUsd },
            lastMessageAt: input.assistant.createdAt,
            ...(current && !current.title && input.title ? { title: input.title } : {}),
            ...(input.contextJobId ? { contextJobId: input.contextJobId } : {}),
          },
          select: { messageCount: true },
        });
        return { messageCount: updated.messageCount };
      });
    },
    async setFeedback(messageId, value, note) {
      const p = await getDb();
      await p.rACopilotMessage.update({ where: { id: messageId }, data: { feedback: value, feedbackNote: note } });
    },
    async appendCard(messageId, card) {
      await store.updateCards(messageId, (cards) => [...cards, card]);
    },
    async updateCards(messageId, update) {
      const p = await getDb();
      await p.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "RACopilotMessage" WHERE id = ${messageId} FOR UPDATE`;
        const row = await tx.rACopilotMessage.findUnique({ where: { id: messageId }, select: { cards: true } });
        if (!row) return;
        const cards = Array.isArray(row.cards) ? (row.cards as unknown as CopilotCard[]) : [];
        await tx.rACopilotMessage.update({ where: { id: messageId }, data: { cards: json(update(cards)) } });
      });
    },
    async updateSummary(threadId, summary, throughId) {
      const p = await getDb();
      await p.rACopilotThread.update({ where: { id: threadId }, data: { summary, summarizedThroughId: throughId } });
    },
    async createProposal(input) {
      const p = await getDb();
      return p.rACopilotProposal.create({
        data: {
          ...(input.id ? { id: input.id } : {}),
          threadId: input.threadId,
          userId: input.userId,
          kind: input.kind,
          payload: json(input.payload),
          status: 'pending',
          expiresAt: input.expiresAt,
        },
      });
    },
    async getProposal(id) {
      const p = await getDb();
      return p.rACopilotProposal.findUnique({ where: { id } });
    },
    async getProposals(ids) {
      if (!ids.length) return [];
      const p = await getDb();
      return p.rACopilotProposal.findMany({ where: { id: { in: ids } } });
    },
    async transitionProposal(id, from, to, at) {
      const p = await getDb();
      const res = await p.rACopilotProposal.updateMany({ where: { id, status: from }, data: { status: to, ...(to === 'applied' ? { appliedAt: at } : {}) } });
      return res.count > 0;
    },
    async listMemory(userId) {
      const p = await getDb();
      return p.rACopilotMemory.findMany({ where: { userId, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 100 });
    },
    async countMemory(userId) {
      const p = await getDb();
      return p.rACopilotMemory.count({ where: { userId, deletedAt: null } });
    },
    async createMemory(input) {
      const p = await getDb();
      return p.rACopilotMemory.create({ data: { userId: input.userId, fact: input.fact, source: input.source } });
    },
    async createMemoryCapped(input, max) {
      const p = await getDb();
      return p.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ra_copilot_memory:${input.userId}`}))`;
        const live = await tx.rACopilotMemory.count({ where: { userId: input.userId, deletedAt: null } });
        if (live >= max) return null;
        return tx.rACopilotMemory.create({ data: { userId: input.userId, fact: input.fact, source: input.source } });
      });
    },
    async deleteMemory(userId, id, at) {
      const p = await getDb();
      // The fact text is cleared at once; the row is only a tombstone.
      const res = await p.rACopilotMemory.updateMany({ where: { id, userId, deletedAt: null }, data: { deletedAt: at, fact: '' } });
      return res.count > 0;
    },
    async listFeedback(options) {
      const p = await getDb();
      let where: Prisma.RACopilotMessageWhereInput = { feedback: { not: null } };
      if (options.cursor) {
        const anchor = await p.rACopilotMessage.findFirst({ where: { id: options.cursor }, select: { id: true, createdAt: true } });
        if (anchor) where = { AND: [where, beforeWhere(anchor)] };
      }
      const rows = await p.rACopilotMessage.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: options.limit + 1,
        select: { id: true, threadId: true, feedback: true, feedbackNote: true, createdAt: true },
      });
      const page = rows.slice(0, options.limit);
      const threadIds = [...new Set(page.map((r) => r.threadId))];
      const threads = threadIds.length
        ? await p.rACopilotThread.findMany({ where: { id: { in: threadIds } }, select: { id: true, userId: true } })
        : [];
      const owner = new Map(threads.map((t) => [t.id, t.userId]));
      return {
        items: page
          .filter((r) => r.feedback === 'up' || r.feedback === 'down')
          .map((r) => ({
            messageId: r.id,
            threadId: r.threadId,
            userId: owner.get(r.threadId) ?? '',
            value: r.feedback as 'up' | 'down',
            note: r.feedbackNote ?? null,
            createdAt: r.createdAt.toISOString(),
          })),
        cursor: rows.length > options.limit ? page[page.length - 1]!.id : null,
      };
    },
    async userName(userId) {
      const p = await getDb();
      const row = await p.user.findUnique({ where: { id: userId }, select: { name: true } });
      return row?.name ?? null;
    },
    async primaryResumeId(userId) {
      const p = await getDb();
      const primary = await p.rAResumeVariant.findFirst({ where: { userId, deletedAt: null, isPrimary: true }, select: { id: true } });
      if (primary) return primary.id;
      const latest = await p.rAResumeVariant.findFirst({ where: { userId, deletedAt: null }, orderBy: { lastEditedAt: 'desc' }, select: { id: true } });
      return latest?.id ?? null;
    },
    async logCost(input) {
      const p = await getDb();
      await p.usageDeductionLog.create({
        data: {
          userId: input.userId,
          sku: 'ra_copilot_turn',
          units: 0,
          source: 'plan',
          platformCostUsd: input.costUsd,
          requestId: input.requestId,
          relatedEntityType: 'ra_copilot_message',
          relatedEntityId: input.messageId,
          metadata: json({ kind: 'cost', ...input.metadata }),
        },
      });
    },
  };
  return store;
}

/** Assistant message ids are generated up front (the `meta` event names them before the row exists). */
export function newMessageId(): string {
  return `cpm_${crypto.randomUUID().replace(/-/g, '')}`;
}
