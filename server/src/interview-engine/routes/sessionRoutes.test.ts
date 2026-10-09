// @vitest-environment node
//
// Route wiring for the create → prepare split: the RoboApply app always
// creates 'roboapply' sessions (admins exempt explicitly), POST /prepare
// forwards {retry}, and the external X-API-Key surface still returns a ready
// session synchronously (create + lenient prepare inline).
// Run: npx vitest run server/src/interview-engine/routes/sessionRoutes.test.ts

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  create: vi.fn(),
  prepare: vi.fn(),
  user: { id: 'u1', role: 'user', roles: ['user'] } as Record<string, unknown>,
  apiKeyId: undefined as string | undefined,
}));

vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { ...m.user, email: 'u@example.test', createdAt: new Date(), updatedAt: new Date() };
    req.apiKeyId = m.apiKeyId;
    next();
  },
}));
vi.mock('../../lib/requestContext.js', () => ({ getCurrentRequestId: () => 'req-1' }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../sessions/InterviewSessionService.js', async () => {
  class E extends Error {}
  return {
    interviewSessionService: { createSession: m.create, prepareSession: m.prepare },
    InterviewValidationError: E, InterviewNotFoundError: E, InterviewAuthError: E,
    InterviewInsufficientCreditsError: E, InterviewNotReadyError: E, InterviewSessionFailedError: E,
    InterviewSessionEndedError: E, InterviewPrepareFailedError: E,
  };
});
vi.mock('../coaching/interviewCoachService.js', () => ({ interviewCoachService: {} }));
vi.mock('../billing/sessionCost.js', () => ({ recordCoachCost: vi.fn() }));

function row(status: string) {
  return { id: 's1', status, error: null, source: 'roboapply', role: 'x', interviewType: 't', personaId: null, mode: 'voice',
    language: 'en', plannedDurationMinutes: 15, overall: null, externalRef: null, createdAt: new Date(), startedAt: null,
    endedAt: null, blueprint: null, report: null, transcript: null, questions: [], webSources: [] };
}

let server: Server;
let base: string;

beforeAll(async () => {
  const express = (await import('express')).default;
  const internal = (await import('./internalRoutes.js')).default;
  const external = (await import('./externalRoutes.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/ie/v1', external);
  app.use('/ie', internal);
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(() => {
  vi.clearAllMocks();
  m.user = { id: 'u1', role: 'user', roles: ['user'] };
  m.apiKeyId = undefined;
  m.create.mockResolvedValue(row('preparing'));
  m.prepare.mockResolvedValue(row('created'));
});

const post = (path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('internal routes', () => {
  it('creates seeker sessions on the credit-gated roboapply source without preparing inline', async () => {
    m.user = { id: 'u1', role: 'seeker', roles: ['seeker'] };
    const res = await post('/ie/sessions', { role: 'Engineer' });
    expect(res.status).toBe(200);
    expect((await res.json()).session.status).toBe('preparing');
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ source: 'roboapply', creditExempt: false }));
    expect(m.prepare).not.toHaveBeenCalled();
  });

  it("keeps legacy role-'user' accounts on the ungated recruiter source", async () => {
    await post('/ie/sessions', { role: 'Engineer' });
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ source: 'recruiter', creditExempt: false }));
  });

  it('marks admins credit-exempt on the roboapply source', async () => {
    m.user = { id: 'u1', role: 'admin', roles: ['admin'] };
    await post('/ie/sessions', { role: 'Engineer' });
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ source: 'roboapply', creditExempt: true }));
  });

  it('POST /prepare forwards retry', async () => {
    const res = await post('/ie/sessions/s1/prepare', { retry: true });
    expect(res.status).toBe(200);
    expect(m.prepare).toHaveBeenCalledWith({ sessionId: 's1', userId: 'u1', retry: true, requestId: 'req-1' });
  });
});

describe('external routes', () => {
  it('keeps synchronous creation: create then lenient prepare', async () => {
    m.apiKeyId = 'key1';
    const res = await post('/ie/v1/sessions', { role: 'Engineer' });
    expect(res.status).toBe(200);
    expect((await res.json()).session.status).toBe('created');
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ source: 'external', apiKeyId: 'key1' }));
    expect(m.prepare).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', apiKeyId: 'key1', strictLlm: false }));
  });
});
