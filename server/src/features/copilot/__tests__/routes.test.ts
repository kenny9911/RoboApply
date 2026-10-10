// @vitest-environment node
// WP-50 routes over the route harness: auth, capability, JSON errors before
// the stream, SSE turns end to end, client abort, proposals, feedback,
// memory and the nudge. Fake services; no network, no database.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from 'express';

vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setFlagOverrideLoader } from '../../../platform/flags.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';
import type { CopilotEventStream } from '../CopilotService.js';
import { createCopilotRouter } from '../routes.js';
import { USER, makeService, type Harness } from './testkit.js';

const BASE = '/api/v1/roboapply/copilot';
const RA = 'localhost:3621';
const passThrough: RequestHandler = (_req, _res, next) => next();
const holder = { h: null as Harness | null, userId: USER as string | null };

let on: RouteHarness;
let off: RouteHarness;

beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  const deps = (env: Record<string, string>) => ({ seekerAuth: [fakeAuth(() => (holder.userId ? { id: holder.userId } : null))], env });
  const options = { service: async () => holder.h!.service, phoneGate: passThrough };
  on = await startRouteHarness({ env: {}, mounts: [[BASE, createCopilotRouter(deps({}), options)]] });
  off = await startRouteHarness({ env: {}, mounts: [[BASE, createCopilotRouter(deps({ FLAG_ROBOAPPLY_COPILOT: 'false' }), options)]] });
});
afterAll(async () => {
  setFlagOverrideLoader(null);
  await Promise.all([on.close(), off.close()]);
});
beforeEach(() => {
  holder.userId = USER;
  holder.h = makeService({ rounds: [{ chunks: ['Hello there. ', 'How can I help?'] }] });
});

type Env<T> = { success: boolean; data: T; code?: string; details?: Record<string, unknown> };

function parseSse(text: string): Array<{ event: string; data: unknown }> {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((b) => b && !b.startsWith(':'))
    .map((b) => {
      const event = /^event: (.*)$/m.exec(b)?.[1] ?? 'message';
      const data = b
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      return { event, data: JSON.parse(data) };
    });
}

async function thread(): Promise<string> {
  const res = await on.request<Env<{ id: string }>>('POST', `${BASE}/threads`, { host: RA, body: {} });
  expect(res.status).toBe(201);
  return res.body.data.id;
}

describe('auth and capability', () => {
  it('401 without a session', async () => {
    holder.userId = null;
    expect((await on.request('GET', `${BASE}/threads`, { host: RA })).status).toBe(401);
  });

  it('404 feature_disabled when `copilot` is off', async () => {
    for (const [m, p] of [['GET', '/threads'], ['POST', '/threads/t/messages'], ['POST', '/proposals/p/apply'], ['GET', '/memory'], ['GET', '/nudge']] as const) {
      const res = await off.request<Env<null>>(m, `${BASE}${p}`, { host: RA, body: m === 'POST' ? { text: 'x' } : undefined });
      expect(res.status, `${m} ${p}`).toBe(404);
      expect(res.body.code).toBe('feature_disabled');
    }
  });
});

describe('threads and messages', () => {
  it('creates, lists and archives threads', async () => {
    const id = await thread();
    const list = await on.request<Env<{ items: Array<{ id: string }> }>>('GET', `${BASE}/threads`, { host: RA });
    expect(list.body.data.items.map((t) => t.id)).toEqual([id]);
    expect((await on.request('DELETE', `${BASE}/threads/${id}`, { host: RA })).status).toBe(204);
    expect((await on.request<Env<{ items: unknown[] }>>('GET', `${BASE}/threads`, { host: RA })).body.data.items).toEqual([]);
    expect((await on.request<Env<null>>('GET', `${BASE}/threads/${id}/messages`, { host: RA })).body.code).toBe('not_found');
  });

  it('streams a turn over SSE (headers, events) and then lists the stored messages', async () => {
    const id = await thread();
    const res = await on.request<string>('POST', `${BASE}/threads/${id}/messages`, { host: RA, body: { text: 'Hi' }, headers: { 'Idempotency-Key': 'k-1' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    const events = parseSse(res.text);
    expect(events.map((e) => e.event)).toEqual(['meta', 'delta', 'delta', 'done']);
    expect(events.at(-1)!.data).toMatchObject({ content: 'Hello there. How can I help?', creditsRemaining: 29 });
    const msgs = await on.request<Env<{ items: Array<{ role: string; content: string }>; cursor: string | null }>>('GET', `${BASE}/threads/${id}/messages`, { host: RA });
    expect(msgs.body.data.items.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Hi'],
      ['assistant', 'Hello there. How can I help?'],
    ]);
    expect(msgs.body.data.cursor).toBeNull();
  });

  it('answers JSON errors before the stream: 422 body, 422 missing key, 503 AI off, 402 credits', async () => {
    const id = await thread();
    expect((await on.request<Env<null>>('POST', `${BASE}/threads/${id}/messages`, { host: RA, body: { text: '   ' }, headers: { 'Idempotency-Key': 'k' } })).status).toBe(422);
    const noKey = await on.request<Env<null>>('POST', `${BASE}/threads/${id}/messages`, { host: RA, body: { text: 'hi' } });
    expect(noKey.status).toBe(422);
    expect(noKey.body.details).toMatchObject({ reason: 'idempotency_key_required' });
    holder.h!.aiAllowed.mockResolvedValue(false);
    const ai = await on.request<Env<null>>('POST', `${BASE}/threads/${id}/messages`, { host: RA, body: { text: 'hi' }, headers: { 'Idempotency-Key': 'k2' } });
    expect(ai.status).toBe(503);
    expect(ai.body.code).toBe('ai_unavailable');
    expect(holder.h!.llm.streamChatWithTools).not.toHaveBeenCalled();
    holder.h!.aiAllowed.mockResolvedValue(true);
    holder.h!.credits.state.used = 30;
    const out = await on.request<Env<null>>('POST', `${BASE}/threads/${id}/messages`, { host: RA, body: { text: 'hi' }, headers: { 'Idempotency-Key': 'k3' } });
    expect(out.status).toBe(402);
    expect(out.body).toMatchObject({ code: 'credits_exhausted', details: { bucket: 'assistant' } });
  });

  it('a client abort stops the model call and the partial reply is kept', async () => {
    holder.h = makeService({ rounds: [{ chunks: ['Working on it. '], hangUntilAbort: true }] });
    const streams: CopilotEventStream[] = [];
    const orig = holder.h.service.handleTurn.bind(holder.h.service);
    vi.spyOn(holder.h.service, 'handleTurn').mockImplementation(async (...args) => {
      const s = await orig(...args);
      streams.push(s);
      return s;
    });
    const id = await thread();
    const controller = new AbortController();
    const res = await fetch(`${on.baseUrl}${BASE}/threads/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-host': RA, 'Idempotency-Key': 'abort-1' },
      body: JSON.stringify({ text: 'hi' }),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    let seen = '';
    while (!seen.includes('event: delta')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await holder.h.llm.hanging;
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    await streams[0]!.finished;
    expect(holder.h.llm.calls[0]!.opts.signal?.aborted).toBe(true);
    const stored = await holder.h.db.rACopilotMessage.findMany({ where: { role: 'assistant' } });
    expect((stored[0] as { content: string }).content).toBe('Working on it.');
  });
});

describe('proposals, feedback, memory, nudge', () => {
  it('apply and dismiss through the routes', async () => {
    holder.h = makeService({ rounds: [{ toolCalls: [{ name: 'remember', args: { fact: 'Likes remote work' } }, { name: 'remember', args: { fact: 'Avoids agencies' } }] }, { chunks: ['Check the cards.'] }] });
    const id = await thread();
    const res = await on.request<string>('POST', `${BASE}/threads/${id}/messages`, { host: RA, body: { text: 'remember this' }, headers: { 'Idempotency-Key': 'k' } });
    const cards = parseSse(res.text).filter((e) => e.event === 'card').map((e) => (e.data as { data: { proposalId: string } }).data.proposalId);
    expect(cards).toHaveLength(2);
    const applied = await on.request<Env<{ applied: boolean; result: { memory: { fact: string } } }>>('POST', `${BASE}/proposals/${cards[0]}/apply`, { host: RA, body: {} });
    expect(applied.status).toBe(200);
    expect(applied.body.data).toMatchObject({ applied: true, result: { memory: { fact: 'Likes remote work' } } });
    expect((await on.request('POST', `${BASE}/proposals/${cards[1]}/dismiss`, { host: RA, body: {} })).status).toBe(204);
    const again = await on.request<Env<null>>('POST', `${BASE}/proposals/${cards[1]}/apply`, { host: RA, body: {} });
    expect(again.status).toBe(409);
    const mem = await on.request<Env<{ items: Array<{ id: string; fact: string }> }>>('GET', `${BASE}/memory`, { host: RA });
    expect(mem.body.data.items.map((m) => m.fact)).toEqual(['Likes remote work']);
    expect((await on.request('DELETE', `${BASE}/memory/${mem.body.data.items[0]!.id}`, { host: RA })).status).toBe(204);
    expect((await on.request<Env<{ items: unknown[] }>>('GET', `${BASE}/memory`, { host: RA })).body.data.items).toEqual([]);
  });

  it('feedback on an assistant message (note redacted), 404 for a user message or another user', async () => {
    const id = await thread();
    const res = await on.request<string>('POST', `${BASE}/threads/${id}/messages`, { host: RA, body: { text: 'Hi' }, headers: { 'Idempotency-Key': 'k' } });
    const messageId = (parseSse(res.text).at(-1)!.data as { messageId: string }).messageId;
    expect((await on.request('POST', `${BASE}/messages/${messageId}/feedback`, { host: RA, body: { value: 'down', note: 'Wrong. Call me at +1 415 555 0100' } })).status).toBe(204);
    const row = (await holder.h!.db.rACopilotMessage.findUnique({ where: { id: messageId } })) as { feedback: string; feedbackNote: string };
    expect(row.feedback).toBe('down');
    expect(row.feedbackNote).not.toContain('555 0100');
    const fb = await holder.h!.service.listFeedback();
    expect(fb.items).toEqual([expect.objectContaining({ messageId, threadId: id, userId: USER, value: 'down' })]);
    holder.userId = 'other';
    expect((await on.request('POST', `${BASE}/messages/${messageId}/feedback`, { host: RA, body: { value: 'up' } })).status).toBe(404);
  });

  it('nudge: one nudge from real signals (a low rating wins over the pay hint)', async () => {
    const pay = await on.request<Env<{ nudge: { kind: string } }>>('GET', `${BASE}/nudge`, { host: RA });
    expect(pay.body.data.nudge).toMatchObject({ kind: 'pay_filter', facts: { jobsListingPay: { value: 120, source: 'index', sampleSize: 120 } } });
    (holder.h!.deps.nudgeSignals.latestRating as ReturnType<typeof vi.fn>).mockResolvedValue({ score: 3, createdAt: new Date('2026-10-09T00:00:00.000Z') });
    const res = await on.request<Env<{ nudge: { kind: string } }>>('GET', `${BASE}/nudge`, { host: RA });
    expect(res.body.data.nudge).toMatchObject({ kind: 'low_rating', facts: { rating: 3 } });
  });
});
