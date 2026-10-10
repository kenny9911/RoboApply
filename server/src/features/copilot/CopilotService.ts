// server/src/features/copilot/CopilotService.ts — the Assistant (ARCH §5; TASK_PLAN WP-50).
//
// handleTurn(userId, threadId, input):
//   0. checks before anything streams (each answers a plain HTTP error):
//      thread ownership → aiAllowed(user) (false → 503, ZERO model calls) →
//      GoApply phone binding → Idempotency-Key → the brand's daily budget →
//      one `assistant` credit reserved.
//   1. context: profileSnapshotForLlm, the active filters, the job in
//      context, confirmed memory (GoApply only with `copilot_memory`), the
//      rolling summary, the last 12 messages; user text PII-redacted.
//   2. up to 4 model rounds (`streamChatWithTools`, task `copilot`, brand
//      pinned: GoApply routes only to its domestic models). Text is released
//      sentence by sentence through the guard; tool calls run through the
//      registry (arguments parsed, job ids checked, results wrapped as
//      <data>); cards are emitted as they come.
//   3. persist the user message and the reply (with cards and tool digests),
//      commit the credit only for a stored, complete reply (released when
//      nothing was produced, the save failed, or a retryable fault on our
//      side cut the reply short; the partial reply is still kept), add the cost
//      to the budget and the cost log (SKU ra_copilot_turn), log guard hits
//      (`copilot_guard_hit`), enqueue the rolling summary every 10 messages.
// Events: meta → delta* / tool* / card* → (error) → done. A reply that could
// not be saved ends with error `save_failed` and no done.
//
// handleVisitorTurn: the same loop with the public tools only, no user, no
// persistence, no credits (WP-78 rate-limits per IP); counts against the
// brand budget.

import crypto from 'node:crypto';
import { HttpError } from '../../platform/http.js';
import type { HiringContactsMode, ProductBrand } from '../../platform/brand/registry.js';
import type { FlagKey } from '../../platform/flags.js';
import type { CreditService } from '../../platform/credits/index.js';
import { CreditReplayError } from '../../platform/credits/index.js';
import type { LLMUsageInfo } from '../../types/index.js';
import type { StreamChatWithToolsOptions, StreamChatWithToolsResult, ToolChatMessage } from '../../platform/llm/index.js';
import { logger } from '../../services/LoggerService.js';
import type { CopilotBudget } from './budget.js';
import { EventChannel } from './channel.js';
import {
  COPILOT_ERROR_CODES,
  CopilotCardSchema,
  PROPOSAL_TTL_MS,
  type CopilotCard,
  type CopilotFeedbackRow,
  type CopilotSseEvent,
  type MemoryFactView,
  type MessageView,
  type NudgeView,
  type ThreadView,
  type VisitorTurnInput,
} from './contract.js';
import { collectSourceNumbers, numbersIn, StreamGuard, type GuardContext } from './guard.js';
import { nextNudge, type NudgeSignals } from './nudges.js';
import {
  HISTORY_MESSAGES,
  MAX_OUTPUT_TOKENS,
  MAX_ROUNDS,
  chipHint,
  contextMessage,
  fitHistory,
  jobContext,
  redactUserText,
  systemPrompt,
  type ContextBlocks,
  type HistoryMessage,
} from './prompt.js';
import { createProposalService, effectiveStatus, type ProposalService } from './proposals.js';
import type { CopilotStore, MessageRow, ThreadRow } from './store.js';
import { crossedSummaryMark } from './summary.js';
import { guardLine } from './text.js';
import { availableTools, runToolCall, toLlmTools, wrapData, type ToolRunRecord } from './tools/registry.js';
import type { CopilotAreas, ToolContext } from './types.js';

export interface TurnInput {
  text: string;
  chip?: string;
  contextJobId?: string;
  resumeId?: string;
}

export interface TurnOptions {
  signal?: AbortSignal;
  idempotencyKey?: string | null;
  locale?: string;
}

export interface CopilotEventStream extends AsyncIterable<CopilotSseEvent> {
  /** Resolves when the turn has finished (persisted, credit settled). */
  readonly finished: Promise<void>;
}

export interface CopilotLlm {
  streamChatWithTools(messages: readonly ToolChatMessage[], opts: StreamChatWithToolsOptions): Promise<StreamChatWithToolsResult>;
}

export interface CopilotServiceDeps {
  store: CopilotStore;
  areas: CopilotAreas;
  llm: CopilotLlm;
  aiAllowed: (userId: string) => Promise<boolean>;
  assertPhoneBound: (userId: string) => Promise<void>;
  credits: Pick<CreditService, 'reserve' | 'commit' | 'release' | 'usage'>;
  budget: CopilotBudget;
  hasConsent: (userId: string, type: 'copilot_memory') => Promise<boolean>;
  isEnabled: (key: FlagKey, userId: string | null) => Promise<boolean>;
  hiringContactsMode: () => HiringContactsMode;
  costOf: (model: string, usage: LLMUsageInfo) => number;
  enqueueSummary: (input: { threadId: string; userId: string; brand: string; mark: number }) => Promise<void>;
  /** GoApply: log the AI-content label for a reply (best effort). */
  logAiLabel?: (input: { userId: string; contentId: string }) => Promise<void>;
  nudgeSignals: NudgeSignals;
  brand: () => ProductBrand;
  now: () => Date;
  requestId: () => string | null;
  newMessageId: () => string;
  newCardId?: () => string;
}

const ASSISTANT_BUCKET = 'assistant' as const;
const THREAD_LIST_LIMIT = 50;
const MESSAGE_PAGE = 30;

function iso(d: Date): string {
  return d.toISOString();
}

function toThreadView(t: ThreadRow): ThreadView {
  return { id: t.id, title: t.title, contextJobId: t.contextJobId, updatedAt: iso(t.lastMessageAt), createdAt: iso(t.createdAt) };
}

function parseCards(raw: unknown): CopilotCard[] {
  if (!Array.isArray(raw)) return [];
  const out: CopilotCard[] = [];
  for (const c of raw) {
    const parsed = CopilotCardSchema.safeParse(c);
    if (parsed.success) out.push(parsed.data as CopilotCard);
  }
  return out;
}

/** Job ids a card refers to (`data.jobId`, `data.items[].jobId`). */
export function cardJobIds(cardItem: CopilotCard): string[] {
  const out: string[] = [];
  const d = cardItem.data as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return out;
  if (typeof d.jobId === 'string' && d.jobId) out.push(d.jobId);
  if (Array.isArray(d.items)) for (const it of d.items) if (it && typeof (it as { jobId?: unknown }).jobId === 'string') out.push((it as { jobId: string }).jobId);
  return out;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'APIUserAbortError';
}

interface TurnSpec {
  scope: 'seeker' | 'public';
  userId: string | null;
  thread: ThreadRow | null;
  text: string;
  chip?: string;
  contextJobId: string | null;
  resumeId: string | null;
  locale: string;
  signal?: AbortSignal;
  page?: VisitorTurnInput['pageContext'];
  reservationId: string | null;
}

export class CopilotService {
  readonly proposals: ProposalService;
  private readonly newCardId: () => string;

  constructor(private readonly deps: CopilotServiceDeps) {
    this.newCardId = deps.newCardId ?? (() => `card_${crypto.randomUUID().slice(0, 12)}`);
    this.proposals = createProposalService({
      store: deps.store,
      areas: deps.areas,
      brand: deps.brand,
      now: deps.now,
      hasConsent: deps.hasConsent,
      newCardId: this.newCardId,
    });
  }

  // ── Threads, messages ──────────────────────────────────────────────────

  private async ownThread(userId: string, threadId: string): Promise<ThreadRow> {
    const t = await this.deps.store.getThread(threadId);
    if (!t || t.userId !== userId || t.brand !== this.deps.brand().id || t.archivedAt) {
      throw new HttpError('not_found', 'This conversation was not found.', { reason: COPILOT_ERROR_CODES.threadNotFound });
    }
    return t;
  }

  async listThreads(userId: string): Promise<{ items: ThreadView[] }> {
    const rows = await this.deps.store.listThreads(userId, this.deps.brand().id, THREAD_LIST_LIMIT);
    return { items: rows.map(toThreadView) };
  }

  async createThread(userId: string, input: { contextJobId?: string }): Promise<ThreadView> {
    const row = await this.deps.store.createThread({ userId, brand: this.deps.brand().id, contextJobId: input.contextJobId ?? null });
    return toThreadView(row);
  }

  async archiveThread(userId: string, threadId: string): Promise<void> {
    await this.ownThread(userId, threadId);
    await this.deps.store.archiveThread(threadId, this.deps.now());
  }

  async listMessages(userId: string, threadId: string, query: { before?: string; limit?: number }): Promise<{ items: MessageView[]; cursor: string | null }> {
    await this.ownThread(userId, threadId);
    const limit = query.limit ?? MESSAGE_PAGE;
    const rows = await this.deps.store.listMessages(threadId, { before: query.before, limit: limit + 1 });
    const page = rows.slice(0, limit);
    const cursor = rows.length > limit ? page[page.length - 1]!.id : null;
    const chronological = [...page].reverse();
    // Proposal cards show the proposal's current status (applied, dismissed, expired…).
    const proposalIds = new Set<string>();
    for (const m of chronological) for (const c of parseCards(m.cards)) {
      const pid = (c.data as { proposalId?: unknown } | null)?.proposalId;
      if (typeof pid === 'string') proposalIds.add(pid);
    }
    const now = this.deps.now();
    const statuses = new Map((await this.deps.store.getProposals([...proposalIds])).map((p) => [p.id, effectiveStatus(p, now)]));
    const items = chronological.map((m) => this.toMessageView(m, statuses));
    return { items, cursor };
  }

  private toMessageView(m: MessageRow, statuses: Map<string, string>): MessageView {
    const cards = parseCards(m.cards).map((c) => {
      const pid = (c.data as { proposalId?: unknown } | null)?.proposalId;
      if (typeof pid === 'string' && statuses.has(pid)) return { ...c, data: { ...(c.data as object), status: statuses.get(pid) } };
      return c;
    });
    return {
      id: m.id,
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
      cards,
      createdAt: iso(m.createdAt),
      feedback: m.feedback === 'up' || m.feedback === 'down' ? m.feedback : null,
      ...(m.role === 'assistant' ? { aiGenerated: true } : {}),
    };
  }

  async feedback(userId: string, messageId: string, input: { value: 'up' | 'down'; note?: string }): Promise<void> {
    const msg = await this.deps.store.getMessage(messageId);
    if (!msg || msg.role !== 'assistant') throw new HttpError('not_found', 'Message not found.', { reason: COPILOT_ERROR_CODES.messageNotFound });
    await this.ownThread(userId, msg.threadId).catch(() => {
      throw new HttpError('not_found', 'Message not found.', { reason: COPILOT_ERROR_CODES.messageNotFound });
    });
    const name = await this.deps.store.userName(userId).catch(() => null);
    const note = input.note?.trim() ? redactUserText(input.note.trim(), [name]).slice(0, 1000) : null;
    await this.deps.store.setFeedback(messageId, input.value, note);
  }

  async listMemory(userId: string): Promise<{ items: MemoryFactView[] }> {
    const rows = await this.deps.store.listMemory(userId);
    return { items: rows.map((r) => ({ id: r.id, fact: r.fact, createdAt: iso(r.createdAt) })) };
  }

  async deleteMemory(userId: string, id: string): Promise<void> {
    if (!(await this.deps.store.deleteMemory(userId, id, this.deps.now()))) throw new HttpError('not_found', 'Not found.');
  }

  listFeedback(options: { cursor?: string; limit?: number } = {}): Promise<{ items: CopilotFeedbackRow[]; cursor: string | null }> {
    return this.deps.store.listFeedback({ cursor: options.cursor, limit: Math.min(Math.max(options.limit ?? 50, 1), 200) });
  }

  async nudge(userId: string): Promise<{ nudge: NudgeView | null }> {
    const nudge = await nextNudge(userId, {
      areas: this.deps.areas,
      signals: this.deps.nudgeSignals,
      market: () => this.deps.brand().market,
      isEnabled: (key) => this.deps.isEnabled(key, userId),
      now: this.deps.now,
    });
    return { nudge };
  }

  // ── Turns ──────────────────────────────────────────────────────────────

  async handleTurn(userId: string, threadId: string, input: TurnInput, options: TurnOptions = {}): Promise<CopilotEventStream> {
    const thread = await this.ownThread(userId, threadId);
    if (!(await this.deps.aiAllowed(userId))) {
      throw new HttpError('ai_unavailable', 'The Assistant needs your consent to use AI. Turn it on in Settings.', { reason: COPILOT_ERROR_CODES.aiOff });
    }
    await this.deps.assertPhoneBound(userId);
    const key = options.idempotencyKey?.trim();
    if (!key || key.length > 120) {
      throw new HttpError('invalid_request', 'An Idempotency-Key header is required.', { reason: COPILOT_ERROR_CODES.idempotencyKeyRequired });
    }
    const brand = this.deps.brand();
    if (await this.deps.budget.exhausted(brand.id)) {
      throw new HttpError('ai_unavailable', 'The Assistant is busy right now. Try again later; nothing was charged.', { reason: COPILOT_ERROR_CODES.dailyBudget });
    }
    const reservation = await this.deps.credits.reserve({ userId, bucket: ASSISTANT_BUCKET, idempotencyKey: key, refType: 'ra_copilot_thread', refId: threadId, brand: brand.id });
    if (reservation.replayed) {
      const replay = new CreditReplayError(reservation.id, reservation.status === 'committed' ? 'committed' : 'reserved');
      throw new HttpError('conflict', replay.message, { reason: replay.code });
    }
    return this.startTurn({
      scope: 'seeker',
      userId,
      thread,
      text: input.text,
      chip: input.chip,
      contextJobId: input.contextJobId ?? thread.contextJobId ?? null,
      resumeId: input.resumeId ?? null,
      locale: options.locale ?? (brand.market === 'cn' ? 'zh' : 'en'),
      signal: options.signal,
      reservationId: reservation.id,
    });
  }

  async handleVisitorTurn(input: VisitorTurnInput, options: { tools: 'public'; signal?: AbortSignal; locale?: string }): Promise<CopilotEventStream> {
    const brand = this.deps.brand();
    if (await this.deps.budget.exhausted(brand.id)) {
      throw new HttpError('ai_unavailable', 'The Assistant is busy right now. Try again later.', { reason: COPILOT_ERROR_CODES.dailyBudget });
    }
    return this.startTurn({
      scope: 'public',
      userId: null,
      thread: null,
      text: input.text,
      contextJobId: null,
      resumeId: null,
      locale: options.locale ?? (brand.market === 'cn' ? 'zh' : 'en'),
      signal: options.signal,
      page: input.pageContext,
      reservationId: null,
    });
  }

  private startTurn(spec: TurnSpec): CopilotEventStream {
    const channel = new EventChannel<CopilotSseEvent>();
    const finished = this.runTurn(spec, channel)
      .catch((err) => {
        logger.error('COPILOT', 'turn crashed', { error: errMessage(err) });
        channel.push({ event: 'error', data: { code: 'internal_error', message: 'Something went wrong. Try again.', retryable: true } });
      })
      .finally(() => channel.end());
    return Object.assign(channel, { finished }) as unknown as CopilotEventStream;
  }

  private async runTurn(spec: TurnSpec, channel: EventChannel<CopilotSseEvent>): Promise<void> {
    const { deps } = this;
    const brand = deps.brand();
    const now = deps.now();
    const messageId = deps.newMessageId();
    const userId = spec.userId;
    const emit = (e: CopilotSseEvent) => channel.push(e);
    emit({ event: 'meta', data: { threadId: spec.thread?.id ?? 'visitor', messageId } });

    // ── Context ──
    const allowedNumbers = new Set<string>();
    const allowedJobIds = new Set<string>();
    numbersIn(spec.text, allowedNumbers);
    const today = iso(now).slice(0, 10);
    numbersIn(today.replace(/-/g, ' '), allowedNumbers);
    const blocks: ContextBlocks = { profile: null, filters: null, job: null, memory: [], summary: null, resumeId: spec.resumeId, page: spec.page ?? null };
    let history: HistoryMessage[] = [];
    let knownName: string | null = null;
    if (userId && spec.thread) {
      const [profile, filters, job, memory, recent, name] = await Promise.all([
        deps.areas.profileSnapshot(userId).catch(() => null),
        deps.areas.activeSearchProfile(userId).then((p) => ({ searchProfileId: p.id, version: p.version, filters: p.filters })).catch(() => null),
        spec.contextJobId ? deps.areas.getJob(userId, spec.contextJobId).then(jobContext).catch(() => null) : Promise.resolve(null),
        this.memoryFor(userId),
        deps.store.recentMessages(spec.thread.id, HISTORY_MESSAGES).catch(() => [] as MessageRow[]),
        deps.store.userName(userId).catch(() => null),
      ]);
      knownName = name;
      Object.assign(blocks, { profile, filters, job, memory, summary: spec.thread.summary });
      if (job && spec.contextJobId) allowedJobIds.add(spec.contextJobId);
      for (const m of recent) for (const c of parseCards(m.cards)) for (const id of cardJobIds(c)) allowedJobIds.add(id);
      history = recent.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.role === 'user' ? redactUserText(m.content, [name]) : m.content }));
      for (const text of [profile, memory.join('\n'), spec.thread.summary, ...recent.map((m) => m.content)]) if (text) numbersIn(text, allowedNumbers);
      if (filters) collectSourceNumbers(filters, allowedNumbers);
      if (job) collectSourceNumbers(job, allowedNumbers);
    }
    if (spec.page) collectSourceNumbers(spec.page, allowedNumbers);

    const toolCtx: ToolContext = {
      userId,
      brand,
      market: brand.market,
      locale: spec.locale,
      now,
      messageId,
      contextJobId: spec.contextJobId,
      resumeId: spec.resumeId,
      scope: spec.scope,
      areas: deps.areas,
      page: spec.page,
      isEnabled: (key) => deps.isEnabled(key, userId),
      hiringContactsMode: deps.hiringContactsMode,
      propose: async (draft) => {
        if (spec.scope !== 'seeker' || !userId || !spec.thread) throw new Error('Proposals need a signed-in thread.');
        const expiresAt = new Date(deps.now().getTime() + PROPOSAL_TTL_MS);
        const row = await deps.store.createProposal({ threadId: spec.thread.id, userId, kind: draft.kind, payload: draft.payload, expiresAt });
        return { id: row.id, expiresAt };
      },
      creditsLeft: async (bucket) => {
        if (!userId) return null;
        const usage = await deps.credits.usage(userId, { brand: brand.id });
        const b = usage.find((u) => u.bucket === bucket);
        return b ? { remaining: b.remaining + b.grantRemaining, resetsAt: iso(b.resetsAt) } : null;
      },
      hasConsent: async (type) => (userId ? deps.hasConsent(userId, type) : false),
      newCardId: this.newCardId,
    };

    const tools = await availableTools(spec.scope, toolCtx);
    const llmTools = toLlmTools(tools);
    const sys = systemPrompt({ brand, locale: spec.locale, today, scope: spec.scope });
    const ctxMsg = contextMessage(blocks);
    const hint = chipHint(spec.chip as never);
    const userText = redactUserText(spec.text, [knownName]);
    const fixedChars = sys.length + (ctxMsg?.length ?? 0) + userText.length + (hint?.length ?? 0);
    const messages: ToolChatMessage[] = [
      { role: 'system', content: sys },
      ...(ctxMsg ? [{ role: 'system' as const, content: ctxMsg }] : []),
      ...fitHistory(history, fixedChars),
      ...(hint ? [{ role: 'system' as const, content: hint }] : []),
      { role: 'user', content: userText },
    ];

    // ── Rounds ──
    const guardCtx = (): GuardContext => ({ allowedNumbers, allowedJobIds, locale: spec.locale });
    const guard = new StreamGuard(guardCtx);
    const cards: CopilotCard[] = [];
    const records: ToolRunRecord[] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    let costUsd = 0;
    let model: string | null = null;
    let rounds = 0;
    let pendingBreak = false;
    let failure: { code: string; message: string; retryable: boolean } | null = null;
    let blockedTail = false;
    let aborted = false;

    const emitText = (raw: string) => {
      if (!raw) return;
      let text = raw;
      if (pendingBreak && guard.text && !/\s$/.test(guard.text) && text.trim()) {
        text = `\n\n${text}`;
        pendingBreak = false;
      }
      const out = guard.push(text);
      if (out) emit({ event: 'delta', data: { text: out } });
    };

    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const last = round === MAX_ROUNDS - 1;
        rounds += 1;
        const res = await deps.llm.streamChatWithTools(messages, {
          tools: llmTools,
          task: 'copilot',
          signal: spec.signal,
          maxTokens: MAX_OUTPUT_TOKENS,
          brand: brand.id,
          // Visitor text is user text too: never routed to an endpoint user data may not reach (R-13).
          carriesUserData: true,
          ...(llmTools.length ? { toolChoice: last ? ('none' as const) : ('auto' as const) } : {}),
          requestId: deps.requestId() ?? undefined,
          onDelta: emitText,
        });
        model = res.model;
        usage.inputTokens += res.usage.promptTokens;
        usage.outputTokens += res.usage.completionTokens;
        try {
          costUsd += deps.costOf(res.model, res.usage);
        } catch {
          // cost table miss: logged as 0
        }
        const tail = guard.flush();
        if (tail) emit({ event: 'delta', data: { text: tail } });
        if (!res.toolCalls.length || last) break;

        messages.push({ role: 'assistant', content: res.content || null, toolCalls: res.toolCalls, ...(res.reasoningContent ? { reasoningContent: res.reasoningContent } : {}) });
        for (const call of res.toolCalls) {
          if (spec.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          emit({ event: 'tool', data: { id: call.id, name: call.name, phase: 'start' } });
          const r = await runToolCall(call, tools, toolCtx, allowedJobIds);
          records.push(r.record);
          for (const id of r.output.jobIds ?? []) allowedJobIds.add(id);
          collectSourceNumbers(r.output.data, allowedNumbers);
          for (const c of r.output.cards ?? []) {
            const unknown = cardJobIds(c).filter((id) => !allowedJobIds.has(id));
            if (unknown.length) {
              logger.warn('COPILOT', 'copilot_guard_hit', { kind: 'card_job_id', card: c.type, jobIds: unknown, brand: brand.id });
              continue;
            }
            cards.push(c);
            emit({ event: 'card', data: c });
          }
          emit({ event: 'tool', data: { id: call.id, name: call.name, phase: 'end', ok: r.record.ok } });
          messages.push({ role: 'tool', toolCallId: call.id, content: wrapData(`tool:${call.name}`, r.content) });
        }
        pendingBreak = true;
      }
    } catch (err) {
      const tail = guard.flush();
      if (tail) emit({ event: 'delta', data: { text: tail } });
      const code = (err as { code?: unknown } | null)?.code;
      if (isAbort(err, spec.signal)) {
        aborted = true;
      } else if (code === 'content_blocked') {
        const stage = (err as { details?: { stage?: string } }).details?.stage;
        if (stage === 'output' || guard.text) {
          blockedTail = true;
          const line = guardLine('restBlocked', spec.locale);
          emit({ event: 'delta', data: { text: `${guard.text && !/\s$/.test(guard.text) ? '\n\n' : ''}${line}` } });
        }
        failure = { code: 'content_blocked', message: guardLine('restBlocked', spec.locale), retryable: false };
      } else if (code === 'stream_interrupted') {
        failure = { code: 'stream_interrupted', message: 'The reply stopped early. Try again.', retryable: true };
      } else if (code === 'ai_unavailable') {
        failure = { code: 'ai_unavailable', message: 'The Assistant is not available right now.', retryable: false };
      } else {
        logger.error('COPILOT', 'turn failed', { error: errMessage(err), code: typeof code === 'string' ? code : undefined, brand: brand.id });
        failure = { code: 'internal_error', message: 'Something went wrong. Try again.', retryable: true };
      }
    }

    // ── Finish ──
    let content = guard.text.trim();
    if (blockedTail) content = `${content}${content ? '\n\n' : ''}${guardLine('restBlocked', spec.locale)}`;
    const produced = content.length > 0 || cards.length > 0;
    const hits = guard.hits;
    if (hits.length) {
      for (const h of hits) logger.warn('COPILOT', 'copilot_guard_hit', { kind: h.kind, token: h.token, excerpt: h.excerpt, brand: brand.id, scope: spec.scope });
    }
    if (failure) emit({ event: 'error', data: failure });

    if (costUsd > 0) await deps.budget.spend(brand.id, costUsd).catch((e) => logger.warn('COPILOT', 'budget update failed', { error: errMessage(e) }));

    let creditsRemaining: number | null = null;
    /** False only when a seeker turn produced a reply that could not be stored. */
    let saved = true;
    if (spec.scope === 'seeker' && userId && spec.thread) {
      if (produced) {
        saved = false;
        try {
          const row = await deps.store.saveTurn({
            threadId: spec.thread.id,
            user: { content: spec.text, createdAt: now },
            assistant: { id: messageId, content, cards, toolCalls: records, model, tokensIn: usage.inputTokens, tokensOut: usage.outputTokens, createdAt: new Date(now.getTime() + 1) },
            costUsd,
            title: spec.thread.title ? null : spec.text.replace(/\s+/g, ' ').trim().slice(0, 60),
            contextJobId: spec.contextJobId,
          });
          saved = true;
          if (crossedSummaryMark(row.messageCount)) {
            await deps.enqueueSummary({ threadId: spec.thread.id, userId, brand: brand.id, mark: Math.floor(row.messageCount / 10) }).catch((e) =>
              logger.warn('COPILOT', 'summary enqueue failed', { error: errMessage(e) }),
            );
          }
        } catch (err) {
          logger.error('COPILOT', 'could not save the turn', { error: errMessage(err), threadId: spec.thread.id });
        }
      }
      // The `assistant` credit is charged only for a reply that is stored and
      // complete. A fault on our side (stream cut, internal error) or a failed
      // save releases it, so the user's retry is the only charge.
      const releaseReason = !produced
        ? aborted
          ? 'client_aborted'
          : 'no_output'
        : !saved
          ? 'save_failed'
          : failure?.retryable && !aborted
            ? failure.code
            : null;
      if (spec.reservationId) {
        if (releaseReason) {
          await deps.credits.release(spec.reservationId, releaseReason).catch((e) => logger.warn('COPILOT', 'credit release failed', { error: errMessage(e) }));
        } else {
          await deps.credits.commit(spec.reservationId, { refId: messageId }).catch((e) => logger.warn('COPILOT', 'credit commit failed', { error: errMessage(e) }));
        }
      }
      if (produced && saved && brand.market === 'cn' && deps.logAiLabel) await deps.logAiLabel({ userId, contentId: `copilot_message:${messageId}` }).catch(() => undefined);
      if (costUsd > 0 || rounds > 0) {
        await deps.store
          .logCost({ userId, costUsd, requestId: deps.requestId(), messageId, metadata: { threadId: spec.thread.id, model, rounds, tokensIn: usage.inputTokens, tokensOut: usage.outputTokens, guardHits: hits.length, ...(saved ? {} : { saveFailed: true }) } })
          .catch((e) => logger.warn('COPILOT', 'cost log failed', { error: errMessage(e) }));
      }
      try {
        const u = await deps.credits.usage(userId, { brand: brand.id });
        const b = u.find((x) => x.bucket === ASSISTANT_BUCKET);
        creditsRemaining = b ? b.remaining + b.grantRemaining : null;
      } catch {
        creditsRemaining = null;
      }
    }

    if (!saved && !aborted) {
      // The reply reached the screen but is not in the thread: say so, uncharged.
      if (!failure) emit({ event: 'error', data: { code: 'save_failed', message: 'The reply could not be saved. Try again.', retryable: true } });
    } else if (!aborted && (produced || !failure)) {
      emit({ event: 'done', data: { messageId, usage, creditsRemaining, content, guarded: hits.length > 0 } });
    }
  }

  private async memoryFor(userId: string): Promise<string[]> {
    try {
      if (this.deps.brand().market === 'cn' && !(await this.deps.hasConsent(userId, 'copilot_memory'))) return [];
      const rows = await this.deps.store.listMemory(userId);
      return rows.map((r) => r.fact).filter(Boolean).slice(0, 50);
    } catch {
      return [];
    }
  }
}
