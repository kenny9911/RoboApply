// server/src/features/admin/feedback.ts — Assistant feedback list (ruling C25;
// TASK_PLAN.md WP-74): thumbs up/down with the person's reason, a short
// PII-redacted excerpt of the thread around the rated reply, and the guard
// hits recorded on that reply's cost row (SKU ra_copilot_turn,
// `metadata.guardHits`). Rows come from `copilot.listFeedback()` (WP-50).

import prisma from '../../lib/prisma.js';
import { redactPii } from '../../platform/pii/index.js';
import { listFeedback as copilotListFeedback, type CopilotFeedbackRow } from '../copilot/index.js';
import type { AdminFeedbackItem, AdminFeedbackResponse } from './contract.js';

export const FEEDBACK_PAGE_SIZE = 30;
const EXCERPT_CHARS = 400;
/** Copilot pages read at most when filtering by value (bounded read). */
const MAX_SCAN_PAGES = 5;

export interface FeedbackStore {
  list(options: { cursor?: string; limit: number }): Promise<{ items: CopilotFeedbackRow[]; cursor: string | null }>;
  /** The rated message and the messages before it in its thread (oldest first), `before` of them at most. */
  context(messageId: string, threadId: string, before: number): Promise<Array<{ id: string; role: string; content: string }>>;
  /** `metadata.guardHits` of each message's cost row. */
  guardHits(messageIds: readonly string[]): Promise<Map<string, number>>;
  userNames(userIds: readonly string[]): Promise<Map<string, string>>;
}

type Db = Pick<typeof prisma, 'rACopilotMessage' | 'usageDeductionLog' | 'user'>;

export function createPrismaFeedbackStore(db: Db = prisma): FeedbackStore {
  return {
    list: (options) => copilotListFeedback(options),
    async context(messageId, threadId, before) {
      const target = await db.rACopilotMessage.findUnique({ where: { id: messageId }, select: { id: true, role: true, content: true, createdAt: true } });
      if (!target) return [];
      const prior = await db.rACopilotMessage.findMany({
        where: { threadId, role: { in: ['user', 'assistant'] }, createdAt: { lt: target.createdAt } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: before,
        select: { id: true, role: true, content: true },
      });
      return [...prior.reverse(), { id: target.id, role: target.role, content: target.content }];
    },
    async guardHits(messageIds) {
      const out = new Map<string, number>();
      if (!messageIds.length) return out;
      const rows = await db.usageDeductionLog.findMany({
        where: { sku: 'ra_copilot_turn', relatedEntityType: 'ra_copilot_message', relatedEntityId: { in: [...messageIds] } },
        select: { relatedEntityId: true, metadata: true },
      });
      for (const r of rows) {
        const meta = r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata) ? (r.metadata as Record<string, unknown>) : {};
        if (r.relatedEntityId && typeof meta.guardHits === 'number') out.set(r.relatedEntityId, meta.guardHits);
      }
      return out;
    },
    async userNames(userIds) {
      const rows = userIds.length ? await db.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } }) : [];
      return new Map(rows.filter((r) => r.name).map((r) => [r.id, r.name!]));
    },
  };
}

function excerptText(text: string, knownValues: string[]): string {
  const clipped = text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1)}…` : text;
  return redactPii(clipped, { knownValues }).text;
}

export async function listAdminFeedback(store: FeedbackStore, query: { value?: 'up' | 'down'; cursor?: string }): Promise<AdminFeedbackResponse> {
  let cursor = query.cursor;
  const rows: CopilotFeedbackRow[] = [];
  let next: string | null = null;
  scan: for (let i = 0; i < MAX_SCAN_PAGES; i += 1) {
    const page = await store.list({ cursor, limit: FEEDBACK_PAGE_SIZE });
    next = page.cursor;
    for (const [index, r] of page.items.entries()) {
      if (query.value && r.value !== query.value) continue;
      rows.push(r);
      if (rows.length === FEEDBACK_PAGE_SIZE) {
        // The copilot cursor is a message id: continue after the last row shown.
        next = index < page.items.length - 1 || page.cursor ? r.messageId : null;
        break scan;
      }
    }
    if (!next) break;
    cursor = next;
  }

  const [hits, names] = await Promise.all([
    store.guardHits(rows.map((r) => r.messageId)),
    store.userNames([...new Set(rows.map((r) => r.userId).filter(Boolean))]),
  ]);
  const items: AdminFeedbackItem[] = await Promise.all(
    rows.map(async (r) => {
      const known = [names.get(r.userId)].filter((v): v is string => Boolean(v));
      const context = await store.context(r.messageId, r.threadId, 2);
      return {
        messageId: r.messageId,
        threadId: r.threadId,
        userId: r.userId,
        value: r.value,
        note: r.note ? redactPii(r.note.slice(0, EXCERPT_CHARS), { knownValues: known }).text : null,
        createdAt: r.createdAt,
        excerpt: context
          .filter((m): m is typeof m & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role, text: excerptText(m.content, known) })),
        guardHits: hits.has(r.messageId) ? hits.get(r.messageId)! : null,
      };
    }),
  );
  return { items, cursor: next };
}
