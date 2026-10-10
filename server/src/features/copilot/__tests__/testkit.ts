// Fakes for the Assistant tests (WP-50): a scripted LLM, fake area seams,
// in-memory credits and budget, and a CopilotService over fakePrisma.
// No network, no database.

import { vi } from 'vitest';
import { getBrand } from '../../../platform/brand/registry.js';
import type { BrandId } from '../../../platform/brand/registry.js';
import type { LlmToolCall, StreamChatWithToolsOptions, StreamChatWithToolsResult, ToolChatMessage } from '../../../platform/llm/index.js';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import type { FeedItem } from '../../feed/contract.js';
import type { SearchProfileWire } from '../../search/contract.js';
import type { JobDetailResponse } from '../../jobs/detail/contract.js';
import type { MatchFitView } from '../../match/contract.js';
import { CopilotService, type CopilotServiceDeps } from '../CopilotService.js';
import { createPrismaCopilotStore, type CopilotStore } from '../store.js';
import type { CopilotAreas } from '../types.js';
import type { CopilotBudget } from '../budget.js';

export const NOW = new Date('2026-10-10T08:00:00.000Z');
export const USER = 'user_1';

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

// ── Area fixtures ─────────────────────────────────────────────────────────

export function feedItem(over: Partial<FeedItem> = {}): FeedItem {
  return {
    jobId: 'job_1',
    title: 'Data Analyst',
    company: { id: 'co_1', name: 'Acme', logoUrl: null },
    location: 'Austin, TX',
    workModel: 'hybrid',
    employmentType: 'full_time',
    seniority: 'mid',
    pay: { min: 90000, max: 120000, currency: 'USD', period: 'year', text: null },
    postedAt: '2026-10-01T00:00:00.000Z',
    lastSeenAt: '2026-10-09T00:00:00.000Z',
    source: { name: 'Acme careers', kind: 'ats_public' },
    fromRecruiterBank: false,
    employerVerified: false,
    isAgency: false,
    badges: [],
    fit: { tier: 'good', score: 72, kind: 'pre', topGap: 'GraphQL', topOverlap: 'SQL' },
    tracker: null,
    ...over,
  };
}

export function profile(over: Partial<SearchProfileWire> = {}): SearchProfileWire {
  return {
    id: 'sp_1',
    name: '',
    isDefault: true,
    isActive: true,
    version: 3,
    schemaVersion: 1,
    filters: { titles: ['Data Analyst'], workModels: ['remote'] },
    alertInstantMax: 1,
    alertDigest: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

export function jobDetail(id = 'job_1', description = 'We need SQL and Python.'): JobDetailResponse {
  return {
    job: {
      id,
      title: 'Data Analyst',
      companyName: 'Acme',
      location: 'Austin, TX',
      workModel: 'hybrid',
      employmentType: 'full_time',
      seniority: 'mid',
      pay: { min: 90000, max: 120000, currency: 'USD', period: 'year', text: null },
      payText: null,
      summary: null,
      sections: [{ kind: 'responsibilities', body: description }],
      skills: [{ skill: 'SQL', kind: 'hard', required: true }],
      sponsorship: { status: 'not_stated', quote: null },
      requirements: [],
      applyUrl: 'https://acme.example/jobs/1',
      postedAt: '2026-10-01T00:00:00.000Z',
      postedAtEstimated: false,
      lastSeenAt: '2026-10-09T00:00:00.000Z',
      closedAt: null,
      status: 'open',
      source: { name: 'Acme careers', kind: 'ats_public', originalName: null },
      fromRecruiterBank: false,
      employerVerified: false,
      isAgency: false,
      visibility: 'public',
      badges: [],
    },
    company: { id: 'co_1', name: 'Acme', slug: 'acme', logoUrl: null, domain: 'acme.example', facts: {}, openJobs: null },
    fit: null,
    explanation: null,
    tracker: null,
    checklist: {} as JobDetailResponse['checklist'],
    similarIds: [],
    autofill: { supported: false, atsType: null },
    people: {} as JobDetailResponse['people'],
    marketMeta: {},
  } as unknown as JobDetailResponse;
}

export function fitView(jobId = 'job_1'): MatchFitView {
  return {
    jobId,
    score: 72,
    tier: 'good',
    kind: 'pre',
    dimensions: [],
    summary: null,
    strengths: [],
    gaps: [],
    keywordsMatched: [],
    keywordsMissing: [],
    skills: { aligned: ['SQL'], missing: ['GraphQL'], listed: 2 },
    topOverlap: 'SQL',
    topGap: 'GraphQL',
    scoredAt: NOW.toISOString(),
  } as unknown as MatchFitView;
}

export type FakeAreas = { [K in keyof CopilotAreas]: ReturnType<typeof vi.fn> & CopilotAreas[K] };

export function fakeAreas(over: Partial<CopilotAreas> = {}): FakeAreas {
  const base: CopilotAreas = {
    feedPreview: async () => [feedItem(), feedItem({ jobId: 'job_2', title: 'BI Analyst' })],
    feedPublicList: async () => [feedItem({ jobId: 'job_pub' })],
    countForFilters: async (_u, f) => ({ count: f.workModels?.includes('onsite') ? 40 : 120, capped: false }),
    activeSearchProfile: async () => profile(),
    searchProfile: async () => profile(),
    patchFilters: async (_u, id, version, patch) => profile({ id, version: version + 1, filters: { ...profile().filters, ...(patch as object) } }),
    getJob: async (_u, jobId) => {
      if (jobId.startsWith('missing')) throw Object.assign(new Error('nf'), { code: 'not_found', status: 404 });
      return jobDetail(jobId);
    },
    scoreJob: async (_u, jobId) => fitView(jobId),
    companyProfile: async () => ({
      id: 'co_1',
      name: 'Acme',
      slug: 'acme',
      logoUrl: null,
      domain: 'acme.example',
      facts: { industry: { value: 'Software', source: 'provider:linkedin', asOf: NOW.toISOString() } },
      openJobs: { value: 12, source: 'index', asOf: NOW.toISOString(), method: 'computed' },
    }),
    connectionsForJob: async () => {
      throw Object.assign(new Error('network.connectionsForJob is not implemented yet.'), { code: 'not_implemented', status: 501 });
    },
    planForJob: async () => {
      throw Object.assign(new Error('prep.planForJob is not implemented yet.'), { code: 'not_implemented', status: 501 });
    },
    trackerSummary: async () => ({ byStatus: { saved: 2, applied: 1 }, followUps: [] }),
    profileCompleteness: async () => ({ completeness: 60, missing: [{ key: 'skills', label: 'Skills' }] }),
    profileSnapshot: async () => 'Target role: Data Analyst. 4 years of experience. Skills: SQL, Python.',
    primaryResumeId: async () => 'res_1',
    resumeLatestGrade: async () => ({
      grade: {
        id: 'g1',
        resumeVariantId: 'res_1',
        status: 'done',
        label: null,
        score: 70,
        counts: null,
        issues: [{ id: 'iss_1', type: 'weak_verb', severity: 'medium', section: 'experience', anchor: null, why: 'Weak verb', how: 'Lead with a stronger verb', target: 'Helped with reports', fixable: true }],
        profile: {},
        method: 'rules',
        aiSkipped: null,
        rulesChecked: 20,
      },
      previous: null,
      stale: false,
      aiAvailable: true,
    }) as never,
    campusUpcoming: async () => {
      throw Object.assign(new Error('campus.upcomingForUser is not implemented yet.'), { code: 'not_implemented', status: 501 });
    },
    salaryStats: async (input) => ({
      totalCount: 80,
      listedCount: 32,
      currency: 'USD',
      period: 'year',
      median: { value: 105000, source: 'index', sampleSize: 32, asOf: (input.now ?? NOW).toISOString(), method: 'computed' },
      p25: { value: 95000, source: 'index', sampleSize: 32, asOf: (input.now ?? NOW).toISOString(), method: 'computed' },
      p75: { value: 118000, source: 'index', sampleSize: 32, asOf: (input.now ?? NOW).toISOString(), method: 'computed' },
      scope: { taxonomyId: null, title: input.title ?? null, country: input.country ?? null, city: input.city ?? null },
      minSample: 20,
    }),
    postingsAllowed: (market) => market !== 'cn',
    createTailorSession: async (_u, input) => ({ id: 'ts_1', status: 'ready', baseVariantId: input.baseVariantId, jobId: input.jobId, resultVariantId: 'res_t1' }) as never,
    createCoverLetter: async (_u, input) => ({ id: 'cl_1', title: 'Letter', jobId: input.jobId, resumeVariantId: input.resumeVariantId }) as never,
    importJob: async () => ({
      importId: 'draft_1',
      status: 'needs_fields',
      jobId: null,
      missingFields: [],
      warnings: [],
      reason: null,
      draft: { title: 'Analyst', company: 'Beta', description: 'x'.repeat(200), location: null, applyUrl: 'https://beta.example/j', sources: {} },
      matched: null,
    }),
    saveImportedJob: async () => ({ importId: 'job_new', status: 'done', jobId: 'job_new', missingFields: [], warnings: [], reason: null, draft: null, matched: null }),
    fixResumeIssue: async () => ({ suggestions: [{ text: 'Built weekly reports', aiWritten: true }], blocked: 0 }),
  };
  const out = {} as FakeAreas;
  for (const [k, v] of Object.entries({ ...base, ...over })) (out as Record<string, unknown>)[k] = vi.fn(v as (...a: unknown[]) => unknown);
  return out;
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
