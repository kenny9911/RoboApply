// @vitest-environment node
//
// Alice's router behind the route harness: auth, the `alice` capability (404
// feature_disabled when off), the turn stream (progress → message → thread →
// done, as SSE), errors raised before the stream answering as plain JSON, and
// a database without the Alice tables answering 503 alice_not_ready.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../lib/prisma.js', () => ({
  default: new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        throw new Error(`no real DB in unit tests (prisma.${String(prop)})`);
      },
    },
  ),
}));

import { setFlagOverrideLoader } from '../../../platform/flags.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';
import { createAliceRouter } from '../routes.js';
import { createAliceService } from '../service.js';
import { notReadyError } from '../store.js';
import { intakeOut, makeAlice } from './testkit.js';

const BASE = '/api/v1/roboapply/alice';
const RA = 'localhost:3621';

const state = vi.hoisted(() => ({ userId: 'u_alice' as string | null }));
let alice = makeAlice();
let h: RouteHarness;
let off: RouteHarness;
let missing: RouteHarness;

function parseSse(text: string): Array<{ event: string; data: unknown }> {
  return text
    .split(/\n\n+/)
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return event && data ? { event, data: JSON.parse(data) } : null;
    })
    .filter((e): e is { event: string; data: unknown } => e !== null);
}

beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  const auth = [fakeAuth(() => (state.userId ? { id: state.userId } : null))];
  const lazy = new Proxy({}, { get: (_t, prop) => (alice.service as unknown as Record<string | symbol, unknown>)[prop] });
  // Every Alice table is missing: the store's own answer for that.
  const brokenStore = new Proxy(
    {},
    {
      get: () => async () => {
        throw notReadyError();
      },
    },
  );
  const notReady = createAliceService({ ...alice.deps, store: brokenStore as never });
  h = await startRouteHarness({ env: {}, mounts: [[BASE, createAliceRouter({ seekerAuth: auth, env: {} }, { service: lazy as never })]] });
  const envOff = { FLAG_ROBOAPPLY_ALICE: 'false' };
  off = await startRouteHarness({ env: envOff, mounts: [[BASE, createAliceRouter({ seekerAuth: auth, env: envOff }, { service: lazy as never })]] });
  missing = await startRouteHarness({ env: {}, mounts: [[BASE, createAliceRouter({ seekerAuth: auth, env: {} }, { service: notReady })]] });
});
afterAll(async () => {
  setFlagOverrideLoader(null);
  await Promise.all([h.close(), off.close(), missing.close()]);
});
beforeEach(() => {
  alice = makeAlice();
  state.userId = 'u_alice';
});

const ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/thread'],
  ['POST', '/turn', { kind: 'skip_resume' }],
  ['GET', '/profiles'],
  ['PATCH', '/profiles/jp1', { name: 'x' }],
  ['DELETE', '/profiles/jp1'],
  ['GET', '/profiles/jp1/matches'],
  ['GET', '/applications'],
  ['PUT', '/reminders/e1', { date: '2026-11-27' }],
  ['DELETE', '/reminders/e1'],
];

describe('alice router: auth and capability', () => {
  it.each(ROUTES)('401 without a session: %s %s', async (method, path, body) => {
    state.userId = null;
    expect((await h.request(method, `${BASE}${path}`, { host: RA, body })).status).toBe(401);
  });

  it.each(ROUTES)('404 feature_disabled with the capability off: %s %s', async (method, path, body) => {
    const res = await off.request<{ code: string }>(method, `${BASE}${path}`, { host: RA, body });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('feature_disabled');
  });
});

describe('alice router: the thread and the turn stream', () => {
  it('GET /thread answers the envelope with the greeting', async () => {
    const res = await h.request<{ success: boolean; data: { stage: string; messages: Array<{ blocks: Array<{ type: string }> }> } }>('GET', `${BASE}/thread`, { host: RA });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.stage).toBe('intake');
    expect(res.body.data.messages[0].blocks[0].type).toBe('greeting');
  });

  it('POST /turn streams progress, messages, the thread and done', async () => {
    alice.scripted.intake.mockResolvedValueOnce(intakeOut({ question: 'What kind of job do you want next?' }));
    const res = await h.request('POST', `${BASE}/turn`, { host: RA, body: { kind: 'skip_resume' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const events = parseSse(res.text).map((e) => e.event);
    expect(events).toEqual(['message', 'progress', 'progress', 'message', 'thread', 'done']);
  });

  it('answers a refusal before the stream as plain JSON (no half turn)', async () => {
    const res = await h.request<{ code: string; details: { reason: string } }>('POST', `${BASE}/turn`, { host: RA, body: { kind: 'save' } });
    expect(res.status).toBe(409);
    expect(res.body.details.reason).toBe('alice_wrong_stage');
  });

  it('validates the action', async () => {
    expect((await h.request('POST', `${BASE}/turn`, { host: RA, body: { kind: 'dance' } })).status).toBe(422);
    expect((await h.request('PUT', `${BASE}/reminders/e1`, { host: RA, body: { date: 'Friday' } })).status).toBe(422);
  });

  it('a failure after the stream opened ends with an error event', async () => {
    alice.scripted.intake.mockRejectedValueOnce(new Error('model down'));
    const res = await h.request('POST', `${BASE}/turn`, { host: RA, body: { kind: 'message', text: 'designer' } });
    const events = parseSse(res.text);
    expect(events.map((e) => e.event)).toEqual(['message', 'progress', 'progress', 'message', 'thread', 'error']);
    expect(events.at(-1)?.data).toMatchObject({ code: 'ai_unavailable', reason: 'alice_agent_failed' });
  });

  it('answers 503 alice_not_ready when the database has no Alice tables', async () => {
    const res = await missing.request<{ code: string; details: { reason: string } }>('GET', `${BASE}/thread`, { host: RA });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'ai_unavailable', details: { reason: 'alice_not_ready' } });
  });
});
