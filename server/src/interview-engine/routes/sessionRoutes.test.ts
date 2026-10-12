// @vitest-environment node
//
// Route wiring for the create → prepare split.
//
// INT-09 (wave4 WP-93 #8, R7): the old browser `POST /sessions` is gone — it
// could not record and dropped the job. The one first-party create left
// (`POST /v1/practice/sessions`) keeps the job, the market, the resume and the
// recording choice; the external X-API-Key surface still returns a ready
// session synchronously (create + lenient prepare inline). The session routes
// that call a model (prepare, coach) check the brand's AI gate first, and the
// catalog lists GoApply's own format on GoApply only.
// Run: npx vitest run server/src/interview-engine/routes/sessionRoutes.test.ts

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  create: vi.fn(),
  prepare: vi.fn(),
  coach: vi.fn(),
  coachCost: vi.fn(),
  loadResume: vi.fn(),
  ensureGrant: vi.fn(),
  user: { id: 'u1', role: 'user', roles: ['user'] } as Record<string, unknown>,
  apiKeyId: undefined as string | undefined,
  brand: { id: 'roboapply', market: 'intl', name: 'RoboApply' } as Record<string, unknown>,
  phoneRequired: vi.fn(),
  aiAllowed: vi.fn(),
  voiceOn: vi.fn(),
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
vi.mock('../parley/parleyConfig.js', () => ({ shouldUseParley: () => false }));
vi.mock('../../platform/brand/brandContext.js', () => ({ getCurrentBrandOrDefault: () => m.brand }));
vi.mock('../../features/auth-cn/index.js', () => ({ phoneBindingRequired: m.phoneRequired }));
vi.mock('../../platform/consent/index.js', () => ({ aiAllowed: m.aiAllowed, hasLiveConsent: vi.fn(async () => false) }));
vi.mock('../../platform/flags.js', () => ({ isEnabledForBrand: m.voiceOn }));
vi.mock('../sessions/InterviewSessionService.js', async () => {
  class E extends Error {}
  return {
    interviewSessionService: { createSession: m.create, prepareSession: m.prepare },
    InterviewValidationError: E, InterviewNotFoundError: E, InterviewAuthError: E,
    InterviewInsufficientCreditsError: E, InterviewNotReadyError: E, InterviewSessionFailedError: E,
    InterviewSessionEndedError: E, InterviewPrepareFailedError: E,
    loadPracticeJob: vi.fn(),
    loadPracticeResume: m.loadResume,
    ensureFirstPracticeGrant: m.ensureGrant,
    readPracticeMeta: (lm: any) => lm?.practice ?? null,
  };
});
vi.mock('../coaching/interviewCoachService.js', () => ({ interviewCoachService: { coach: m.coach } }));
vi.mock('../billing/sessionCost.js', () => ({ recordCoachCost: m.coachCost }));

function row(status: string, extra: Record<string, unknown> = {}) {
  return { id: 's1', status, error: null, source: 'roboapply', role: 'x', interviewType: 't', personaId: null, mode: 'voice',
    language: 'en', plannedDurationMinutes: 15, overall: null, externalRef: null, createdAt: new Date(), startedAt: null,
    endedAt: null, blueprint: null, report: null, transcript: null, questions: [], webSources: [], liveMetrics: null, ...extra };
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
  m.brand = { id: 'roboapply', market: 'intl', name: 'RoboApply' };
  m.create.mockResolvedValue(row('preparing'));
  m.prepare.mockResolvedValue(row('created'));
  m.coach.mockResolvedValue({ kind: 'good', text: 'Name the metric.' });
  m.loadResume.mockResolvedValue({ id: 'r1', name: 'Main', kind: 'primary', context: 'redacted resume' });
  m.ensureGrant.mockResolvedValue({ method: 'email', verified: true, grant: 'already_granted' });
  m.phoneRequired.mockResolvedValue(false);
  m.aiAllowed.mockResolvedValue(true);
  m.voiceOn.mockReturnValue(true);
});

const post = (path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (path: string) => fetch(`${base}${path}`);

describe('internal routes', () => {
  it('the browser POST /sessions is gone for every kind of account: 404 and nothing is created', async () => {
    for (const user of [
      { id: 'u1', role: 'seeker', roles: ['seeker'] },
      { id: 'u1', role: 'user', roles: ['user'] },
      { id: 'u1', role: 'admin', roles: ['admin'] },
    ]) {
      m.user = user;
      const res = await post('/ie/sessions', { role: 'Engineer', jdText: 'Build APIs' });
      expect(res.status).toBe(404);
    }
    expect(m.create).not.toHaveBeenCalled();
    expect(m.prepare).not.toHaveBeenCalled();
  });

  it('the remaining first-party create keeps the job, the market, the resume and the recording choice', async () => {
    m.user = { id: 'u1', role: 'seeker', roles: ['seeker'], name: 'Jane Doe' };
    m.create.mockResolvedValue(row('preparing', {
      jobId: 'j1',
      liveMetrics: { practice: { v: 1, jobId: 'j1', jobTitle: 'Backend Engineer', companyName: 'Acme', recording: { audio: true, video: false } } },
    }));
    const res = await post('/ie/v1/practice/sessions', {
      role: 'Engineer', jobId: 'j1', resumeId: 'r1', mode: 'voice', recording: { audio: true, video: false },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.status).toBe('preparing');
    // A session created through the remaining route keeps its jobId.
    expect(body.practice).toEqual({ jobId: 'j1', resumeId: 'r1', recording: { audio: true, video: false } });
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', source: 'roboapply', creditExempt: false,
      jobId: 'j1', market: 'intl', resumeContext: 'redacted resume', recording: { audio: true, video: false },
    }));
    expect(m.loadResume).toHaveBeenCalledWith('u1', expect.objectContaining({ resumeId: 'r1', jobId: 'j1' }));
    expect(m.prepare).not.toHaveBeenCalled();
  });

  it("the source rules moved with it: legacy role-'user' stays on the ungated recruiter source, admins are exempt on roboapply", async () => {
    await post('/ie/v1/practice/sessions', { role: 'Engineer' });
    expect(m.create).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'recruiter', creditExempt: false }));
    m.user = { id: 'u1', role: 'admin', roles: ['admin'] };
    await post('/ie/v1/practice/sessions', { role: 'Engineer' });
    expect(m.create).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'roboapply', creditExempt: true }));
  });

  it('POST /prepare forwards retry', async () => {
    const res = await post('/ie/sessions/s1/prepare', { retry: true });
    expect(res.status).toBe(200);
    expect(m.prepare).toHaveBeenCalledWith({ sessionId: 's1', userId: 'u1', retry: true, requestId: 'req-1' });
  });

  it('GoApply: prepare and the coach call no model once the AI consent is off', async () => {
    m.brand = { id: 'goapply', market: 'cn', name: 'GoApply' };
    m.aiAllowed.mockResolvedValue(false);
    const res = await post('/ie/sessions/s1/prepare', {});
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ai_unavailable', reason: 'ai_consent_required' });
    expect(m.prepare).not.toHaveBeenCalled();
    // The coach is an aid, never an error: it just has nothing to say.
    const coach = await post('/ie/sessions/s1/coach', { mode: 'hint', question: 'Why us?' });
    expect(coach.status).toBe(200);
    expect(await coach.json()).toEqual({ coach: null });
    expect(m.coach).not.toHaveBeenCalled();
    expect(m.coachCost).not.toHaveBeenCalled();

    m.aiAllowed.mockResolvedValue(true);
    expect((await post('/ie/sessions/s1/prepare', {})).status).toBe(200);
    expect(await (await post('/ie/sessions/s1/coach', { mode: 'hint', question: 'Why us?' })).json()).toEqual({ coach: { kind: 'good', text: 'Name the metric.' } });
    expect(m.prepare).toHaveBeenCalledTimes(1);
    expect(m.coach).toHaveBeenCalledTimes(1);
  });

  it('RoboApply: prepare and the coach are not gated', async () => {
    m.aiAllowed.mockResolvedValue(false);
    expect((await post('/ie/sessions/s1/prepare', {})).status).toBe(200);
    expect(await (await post('/ie/sessions/s1/coach', { mode: 'nudge', question: 'Why us?', answer: 'Because.' })).json()).toEqual({ coach: { kind: 'good', text: 'Name the metric.' } });
    expect(m.aiAllowed).not.toHaveBeenCalled();
  });

  it('GET /catalog lists the AI-interview practice format first on GoApply and never on RoboApply', async () => {
    const intl = await (await get('/ie/catalog')).json();
    expect(intl.types.map((t: { id: string }) => t.id)).not.toContain('cn_ai_interview');
    expect(intl.types[0].id).toBe('screening');
    m.brand = { id: 'goapply', market: 'cn', name: 'GoApply' };
    const cn = await (await get('/ie/catalog')).json();
    expect(cn.types[0]).toMatchObject({ id: 'cn_ai_interview', minutes: 25 });
    // The shared list follows, unchanged; the directive never goes over the wire.
    expect(cn.types.slice(1)).toEqual(intl.types);
    expect(JSON.stringify(cn.types[0])).not.toContain('blueprintDirective');
    expect(cn.personas).toEqual(intl.personas);
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
