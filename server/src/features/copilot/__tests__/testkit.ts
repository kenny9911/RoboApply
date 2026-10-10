// Fakes for the Assistant tests (WP-50): a scripted LLM, fake area seams,
// in-memory credits and budget, and a CopilotService over fakePrisma.
// No network, no database.

import { vi } from 'vitest';
import { getBrand } from '../../../platform/brand/registry.js';
import type { BrandId } from '../../../platform/brand/registry.js';
import type { LlmToolCall, StreamChatWithToolsOptions, StreamChatWithToolsResult, ToolChatMessage } from '../../../platform/llm/index.js';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { CopilotService, type CopilotServiceDeps } from '../CopilotService.js';
import { createPrismaCopilotStore, type CopilotStore } from '../store.js';
import type { CopilotBudget } from '../budget.js';

import { NOW, USER, fakeAreas, type FakeAreas } from './areaFakes.js';
import type { CopilotAreas } from '../types.js';

export { NOW, USER, feedItem, profile, jobDetail, fitView, fakeAreas, type FakeAreas } from './areaFakes.js';

// ── LLM ──────────────────────────────────────────────────────────────────

export interface ScriptedRound {
  /** Text streamed through onDelta, chunk by chunk. */
  chunks?: string[];
  toolCalls?: Array<{ name: string; args: unknown; id?: string }>;
  /** Throw this after streaming the chunks. */
  error?: unknown;
  /** Wait for the signal to abort after streaming the chunks (then throw AbortError). */
  hangUntilAbort?: boolean;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface ScriptedLlm {
  streamChatWithTools: ReturnType<typeof vi.fn>;
  calls: Array<{ messages: ToolChatMessage[]; opts: StreamChatWithToolsOptions }>;
  /** Fires when a hanging round is waiting. */
  hanging: Promise<void>;
}

export function scriptedLlm(rounds: ScriptedRound[], model = 'test-model'): ScriptedLlm {
  const calls: ScriptedLlm['calls'] = [];
  let i = 0;
  let resolveHanging: () => void = () => undefined;
  const hanging = new Promise<void>((r) => (resolveHanging = r));
  const fn = vi.fn(async (messages: readonly ToolChatMessage[], opts: StreamChatWithToolsOptions): Promise<StreamChatWithToolsResult> => {
    calls.push({ messages: [...messages], opts });
    const round = rounds[Math.min(i, rounds.length - 1)] ?? {};
    i += 1;
    let content = '';
    for (const c of round.chunks ?? []) {
      if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      content += c;
      opts.onDelta?.(c);
      await Promise.resolve();
    }
    if (round.hangUntilAbort) {
      resolveHanging();
      await new Promise<void>((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (opts.signal?.aborted) fail();
        else opts.signal?.addEventListener('abort', fail, { once: true });
      });
    }
    if (round.error) throw round.error;
    const toolCalls: LlmToolCall[] = (opts.toolChoice === 'none' ? [] : (round.toolCalls ?? [])).map((t, n) => ({
      id: t.id ?? `call_${i}_${n}`,
      name: t.name,
      arguments: JSON.stringify(t.args ?? {}),
      parsedArguments: t.args ?? {},
    }));
    for (const t of toolCalls) opts.onToolCall?.(t);
    return {
      content,
      toolCalls,
      finishReason: toolCalls.length ? 'tool_calls' : 'stop',
      usage: { promptTokens: round.usage?.promptTokens ?? 100, completionTokens: round.usage?.completionTokens ?? 20, totalTokens: 120 },
      model,
      provider: 'openrouter',
    };
  });
  return { streamChatWithTools: fn, calls, hanging };
}

// ── Credits, budget ───────────────────────────────────────────────────────

export function fakeCredits(options: { cap?: number } = {}) {
  const cap = options.cap ?? 30;
  const state = { used: 0, reserved: new Map<string, { key: string; status: string }>(), keys: new Map<string, string>() };
  let n = 0;
  return {
    state,
    reserve: vi.fn(async (opts: { userId: string; bucket: string; idempotencyKey: string }) => {
      const existing = state.keys.get(opts.idempotencyKey);
      if (existing) {
        const row = state.reserved.get(existing)!;
        return { id: existing, userId: opts.userId, bucket: opts.bucket, units: 1, status: row.status, fromSource: 'window', windowKey: 'd', idempotencyKey: opts.idempotencyKey, replayed: true };
      }
      if (state.used >= cap) {
        throw Object.assign(new Error('You have used all credits for this action in the current period.'), {
          code: 'credits_exhausted',
          status: 402,
          bucket: opts.bucket,
          resetsAt: new Date('2026-10-11T00:00:00.000Z'),
          upgradable: true,
        });
      }
      n += 1;
      const id = `res_${n}`;
      state.used += 1;
      state.reserved.set(id, { key: opts.idempotencyKey, status: 'reserved' });
      state.keys.set(opts.idempotencyKey, id);
      return { id, userId: opts.userId, bucket: opts.bucket, units: 1, status: 'reserved', fromSource: 'window', windowKey: 'd', idempotencyKey: opts.idempotencyKey, replayed: false };
    }),
    commit: vi.fn(async (id: string) => {
      state.reserved.get(id)!.status = 'committed';
      return { id } as never;
    }),
    release: vi.fn(async (id: string) => {
      const row = state.reserved.get(id)!;
      if (row.status === 'reserved') state.used -= 1;
      row.status = 'released';
      return { id } as never;
    }),
    usage: vi.fn(async () => [
      { bucket: 'assistant', cap, window: 'day', used: state.used, reserved: 0, remaining: cap - state.used, grantRemaining: 0, resetsAt: new Date('2026-10-11T00:00:00.000Z') },
      { bucket: 'tailor', cap: 2, window: 'day', used: 0, reserved: 0, remaining: 2, grantRemaining: 0, resetsAt: new Date('2026-10-11T00:00:00.000Z') },
    ]),
  };
}

export function fakeBudget(exhausted = false): CopilotBudget & { spent: number[] } {
  const spent: number[] = [];
  return { spent, exhausted: vi.fn(async () => exhausted), spend: vi.fn(async (_b, usd: number) => void spent.push(usd)) };
}

// ── Service ───────────────────────────────────────────────────────────────

export function makeFake() {
  return createFakePrisma({
    timestampFields: ['createdAt', 'lastMessageAt'],
    defaults: {
      rACopilotThread: { title: null, contextJobId: null, summary: null, summarizedThroughId: null, messageCount: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, archivedAt: null },
      rACopilotMessage: { cards: [], toolCalls: null, model: null, tokensIn: null, tokensOut: null, feedback: null, feedbackNote: null },
      rACopilotProposal: { status: 'pending', appliedAt: null },
      rACopilotMemory: { deletedAt: null },
    },
    seed: {
      user: [{ id: USER, name: 'Jamie Rivera', brand: 'roboapply' }],
      rAResumeVariant: [{ id: 'res_1', userId: USER, deletedAt: null, isPrimary: true, lastEditedAt: NOW }],
    },
  });
}

export type FakeDb = ReturnType<typeof makeFake>;

export interface Harness {
  service: CopilotService;
  db: FakeDb;
  store: CopilotStore;
  areas: FakeAreas;
  llm: ScriptedLlm;
  credits: ReturnType<typeof fakeCredits>;
  budget: ReturnType<typeof fakeBudget>;
  deps: CopilotServiceDeps;
  consents: Set<string>;
  aiAllowed: ReturnType<typeof vi.fn>;
}

export function makeService(
  options: {
    rounds?: ScriptedRound[];
    brand?: BrandId;
    areas?: Partial<CopilotAreas>;
    aiAllowed?: boolean;
    budgetExhausted?: boolean;
    creditsCap?: number;
    consents?: string[];
    flags?: Record<string, boolean>;
    hiringContacts?: 'off' | 'deeplinks_only' | 'on';
    db?: FakeDb;
    now?: () => Date;
  } = {},
): Harness {
  const db = options.db ?? makeFake();
  const store = createPrismaCopilotStore(async () => db as never);
  const areas = fakeAreas(options.areas);
  const llm = scriptedLlm(options.rounds ?? [{ chunks: ['Hello. '] }]);
  const credits = fakeCredits({ cap: options.creditsCap });
  const budget = fakeBudget(options.budgetExhausted);
  const consents = new Set(options.consents ?? []);
  const aiAllowed = vi.fn(async () => options.aiAllowed ?? true);
  let msg = 0;
  let cardN = 0;
  const deps: CopilotServiceDeps = {
    store,
    areas,
    llm,
    aiAllowed,
    assertPhoneBound: vi.fn(async () => undefined),
    credits: credits as never,
    budget,
    hasConsent: vi.fn(async (_u, type) => consents.has(type)),
    isEnabled: vi.fn(async (key: string) => options.flags?.[key] ?? false),
    hiringContactsMode: () => options.hiringContacts ?? 'deeplinks_only',
    costOf: () => 0.0015,
    enqueueSummary: vi.fn(async () => undefined),
    logAiLabel: vi.fn(async () => undefined),
    nudgeSignals: { latestRating: vi.fn(async () => null), reportedSince: vi.fn(async () => false) },
    brand: () => getBrand(options.brand ?? 'roboapply'),
    now: options.now ?? (() => NOW),
    requestId: () => 'req_1',
    newMessageId: () => `msg_${++msg}`,
    newCardId: () => `card_${++cardN}`,
  };
  return { service: new CopilotService(deps), db, store, areas, llm, credits, budget, deps, consents, aiAllowed };
}

export async function newThread(h: Harness, contextJobId?: string): Promise<string> {
  const t = await h.service.createThread(USER, { contextJobId });
  return t.id;
}

export async function runTurn(h: Harness, threadId: string, text: string, extra: { chip?: string; contextJobId?: string; resumeId?: string; key?: string; signal?: AbortSignal } = {}) {
  const stream = await h.service.handleTurn(USER, threadId, { text, chip: extra.chip, contextJobId: extra.contextJobId, resumeId: extra.resumeId }, { idempotencyKey: extra.key ?? `key_${Math.random()}`, signal: extra.signal, locale: 'en' });
  const events = [] as Array<{ event: string; data: unknown }>;
  for await (const e of stream) events.push(e);
  await stream.finished;
  return events;
}

export const deltaText = (events: Array<{ event: string; data: unknown }>) =>
  events.filter((e) => e.event === 'delta').map((e) => (e.data as { text: string }).text).join('');
