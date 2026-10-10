// @vitest-environment node
//
// WP-43 first-party practice routes on the interview-engine router
// (/api/v1/interview-engine/v1/practice/*): cookie-only, job prefill with the
// market check, 402 → practice upsell payload, GoApply gates (phone, AI
// consent, voice capability), recording consent forwarded to the service, and
// the written practice wrappers (gate on every call, job, metering).
// Run: npx vitest run components/features/practice/__tests__/server/externalRoutes.practice.test.ts

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  class InsufficientCredits extends Error {
    balance = 0;
    required = 2;
    tier = 'free';
  }
  class NotFound extends Error {}
  class Other extends Error {}
  return {
    InsufficientCredits,
    NotFound,
    Other,
    create: vi.fn(),
    prepare: vi.fn(),
    info: vi.fn(),
    practiced: vi.fn(),
    textStart: vi.fn(),
    textTurn: vi.fn(),
    textScore: vi.fn(),
    loadJob: vi.fn(),
    loadResume: vi.fn(),
    ensureGrant: vi.fn(),
    brand: { id: 'roboapply', market: 'intl', name: 'RoboApply' } as Record<string, unknown>,
    phoneRequired: vi.fn(),
    aiAllowed: vi.fn(),
    voiceOn: vi.fn(),
    hasLiveConsent: vi.fn(),
    user: { id: 'u1', role: 'seeker', roles: ['seeker'], name: 'Jane Doe' } as Record<string, unknown>,
    apiKeyId: undefined as string | undefined,
  };
});

vi.mock('../../../../../server/src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { ...m.user, email: 'u@example.test' };
    req.apiKeyId = m.apiKeyId;
    next();
  },
}));
vi.mock('../../../../../server/src/lib/requestContext.js', () => ({ getCurrentRequestId: () => 'req-1' }));
vi.mock('../../../../../server/src/services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../../../server/src/interview-engine/parley/parleyConfig.js', () => ({ shouldUseParley: () => false }));
vi.mock('../../../../../server/src/platform/brand/brandContext.js', () => ({ getCurrentBrandOrDefault: () => m.brand }));
vi.mock('../../../../../server/src/features/auth-cn/index.js', () => ({ phoneBindingRequired: m.phoneRequired }));
vi.mock('../../../../../server/src/platform/consent/index.js', () => ({ aiAllowed: m.aiAllowed, hasLiveConsent: m.hasLiveConsent }));
vi.mock('../../../../../server/src/platform/flags.js', () => ({ isEnabledForBrand: m.voiceOn }));
vi.mock('../../../../../server/src/interview-engine/storage/r2Storage.js', () => ({ interviewR2Storage: { isConfigured: () => true } }));
vi.mock('../../../../../server/src/interview-engine/sessions/InterviewSessionService.js', () => ({
  interviewSessionService: {
    createSession: m.create,
    prepareSession: m.prepare,
    getPracticeInfo: m.info,
    practicedJobs: m.practiced,
    startTextPractice: m.textStart,
    textPracticeTurn: m.textTurn,
    scoreTextPractice: m.textScore,
  },
  InterviewValidationError: m.Other, InterviewNotFoundError: m.NotFound, InterviewAuthError: m.Other,
  InterviewInsufficientCreditsError: m.InsufficientCredits, InterviewNotReadyError: m.Other,
  InterviewSessionFailedError: m.Other, InterviewSessionEndedError: m.Other, InterviewPrepareFailedError: m.Other,
  loadPracticeJob: m.loadJob,
  loadPracticeResume: m.loadResume,
  ensureFirstPracticeGrant: m.ensureGrant,
  readPracticeMeta: (lm: any) => lm?.practice ?? null,
}));

function row(extra: Record<string, unknown> = {}) {
  return {
    id: 's1', status: 'preparing', error: null, source: 'roboapply', role: 'Backend Engineer', interviewType: 'behavioral',
    personaId: null, mode: 'voice', language: 'en', plannedDurationMinutes: 15, overall: null, externalRef: null,
    createdAt: new Date(), startedAt: null, endedAt: null, blueprint: null, report: null, transcript: null, questions: [],
    webSources: [], liveMetrics: null, ...extra,
  };
}

let server: Server;
let base: string;
const savedRec = process.env.INTERVIEW_ENGINE_RECORDING_ENABLED;

beforeAll(async () => {
  process.env.INTERVIEW_ENGINE_RECORDING_ENABLED = 'true';
  const express = (await import('express')).default;
  const external = (await import('../../../../../server/src/interview-engine/routes/externalRoutes.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/ie/v1', external);
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (savedRec === undefined) delete process.env.INTERVIEW_ENGINE_RECORDING_ENABLED;
  else process.env.INTERVIEW_ENGINE_RECORDING_ENABLED = savedRec;
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  vi.clearAllMocks();
  m.user = { id: 'u1', role: 'seeker', roles: ['seeker'], name: 'Jane Doe' };
  m.apiKeyId = undefined;
  m.brand = { id: 'roboapply', market: 'intl', name: 'RoboApply' };
  m.create.mockResolvedValue(row());
  m.prepare.mockResolvedValue(row({ status: 'created' }));
  m.loadJob.mockResolvedValue({
    id: 'j1', title: 'Backend Engineer', companyName: 'Acme', location: 'Berlin', jdText: 'Build APIs', closed: false,
  });
  m.loadResume.mockResolvedValue({ id: 'r1', name: 'Tailored for Acme', kind: 'tailored', context: 'redacted resume' });
  m.ensureGrant.mockResolvedValue({ method: 'email', verified: true, grant: 'already_granted' });
  m.phoneRequired.mockResolvedValue(false);
  m.aiAllowed.mockResolvedValue(true);
  m.voiceOn.mockReturnValue(true);
  m.hasLiveConsent.mockResolvedValue(false);
  m.textStart.mockResolvedValue({ sessionId: 't1', questions: [{ q: 'Q1', hint: '', coachTip: null }], jobId: null });
  m.textTurn.mockResolvedValue({ nextIndex: null, turns: [], coachTip: null });
  m.textScore.mockResolvedValue({ overall: 60, delta: null, breakdown: [], strengths: [], gaps: [], durationMinutes: 4, practiceCounted: true, jobId: null });
});

const post = (path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (path: string) => fetch(`${base}${path}`);

describe('POST /practice/sessions', () => {
  it('creates a job practice with the server-chosen resume and the recording request', async () => {
    m.create.mockResolvedValue(row({ liveMetrics: { practice: { jobId: 'j1', recording: { audio: false, video: false } } } }));
    const res = await post('/ie/v1/practice/sessions', {
      role: '', jobId: 'j1', mode: 'video', resumeContext: 'client text is ignored',
      recording: { audio: true, video: true },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.id).toBe('s1');
    expect(body.practice).toEqual({ jobId: 'j1', resumeId: 'r1', recording: { audio: false, video: false } });
    expect(m.loadResume).toHaveBeenCalledWith('u1', { resumeId: null, jobId: 'j1', knownValues: ['Jane Doe'] });
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', source: 'roboapply', creditExempt: false, jobId: 'j1', market: 'intl', mode: 'video',
      resumeContext: 'redacted resume', recording: { audio: true, video: true }, candidateName: 'Jane Doe',
    }));
    // The first free practice is topped up before the credit gate inside createSession.
    expect(m.ensureGrant.mock.invocationCallOrder[0]).toBeLessThan(m.create.mock.invocationCallOrder[0]);
  });

  it('never records unless asked', async () => {
    await post('/ie/v1/practice/sessions', { role: 'Engineer' });
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ recording: { audio: false, video: false }, jobId: null }));
  });

  it('a job from another market answers 404 job_not_found', async () => {
    m.create.mockRejectedValue(Object.assign(new m.NotFound('x'), { code: 'job_not_found' }));
    const res = await post('/ie/v1/practice/sessions', { jobId: 'j_cn' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'job_not_found' });
  });

  it('402 carries the practice bucket and the first-practice state for the upsell sheet', async () => {
    m.ensureGrant.mockResolvedValue({ method: 'email', verified: false, grant: null });
    m.create.mockRejectedValue(new m.InsufficientCredits('Insufficient mock-interview credits'));
    const res = await post('/ie/v1/practice/sessions', { role: 'Engineer' });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      error: 'insufficient_credits', bucket: 'practice', balance: 0, required: 2,
      firstPractice: { method: 'email', verified: false, grant: null },
    });
  });

  it('admins are exempt and skip the grant; legacy role-user stays on the recruiter source', async () => {
    m.user = { id: 'u1', role: 'admin', roles: ['admin'] };
    await post('/ie/v1/practice/sessions', { role: 'Engineer' });
    expect(m.create).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'roboapply', creditExempt: true }));
    expect(m.ensureGrant).not.toHaveBeenCalled();
    m.user = { id: 'u1', role: 'user', roles: ['user'] };
    await post('/ie/v1/practice/sessions', { role: 'Engineer' });
    expect(m.create).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'recruiter' }));
  });

  it('refuses API keys (first-party only)', async () => {
    m.apiKeyId = 'key1';
    const res = await post('/ie/v1/practice/sessions', { role: 'Engineer' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('cookie_session_required');
    expect(m.create).not.toHaveBeenCalled();
  });
});

describe('GoApply gates', () => {
  beforeEach(() => {
    m.brand = { id: 'goapply', market: 'cn', name: 'GoApply' };
  });

  it('a WeChat account without a phone gets 403 phone_binding_required', async () => {
    m.phoneRequired.mockResolvedValue(true);
    const res = await post('/ie/v1/practice/sessions', { role: '工程师' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'phone_binding_required', bindRoute: '/bind-phone' });
    expect(m.create).not.toHaveBeenCalled();
  });

  it('without the AI consent: 503 ai_unavailable, zero sessions', async () => {
    m.aiAllowed.mockResolvedValue(false);
    const res = await post('/ie/v1/practice/sessions', { role: '工程师' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ai_unavailable', reason: 'ai_consent_required' });
    expect(m.aiAllowed).toHaveBeenCalledWith({ id: 'u1', brand: 'goapply' });
    expect(m.create).not.toHaveBeenCalled();
  });

  it('without the voice capability: 503 voice_unavailable (the setup offers text practice)', async () => {
    m.voiceOn.mockReturnValue(false);
    const res = await post('/ie/v1/practice/sessions', { role: '工程师' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ai_unavailable', reason: 'voice_unavailable' });
    expect(m.voiceOn).toHaveBeenCalledWith('ai.interviewVoice', m.brand, process.env);
  });

  it('with everything in place it creates on the cn market', async () => {
    const res = await post('/ie/v1/practice/sessions', { role: '工程师', jobId: 'j_cn' });
    expect(res.status).toBe(200);
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ market: 'cn', jobId: 'j_cn' }));
  });

  it('RoboApply never runs the GoApply checks', async () => {
    m.brand = { id: 'roboapply', market: 'intl', name: 'RoboApply' };
    m.voiceOn.mockReturnValue(false);
    const res = await post('/ie/v1/practice/sessions', { role: 'Engineer' });
    expect(res.status).toBe(200);
    expect(m.phoneRequired).not.toHaveBeenCalled();
    expect(m.aiAllowed).not.toHaveBeenCalled();
  });
});

describe('GET /practice/setup', () => {
  it('prefills job and resume and reports first-practice, voice and recording state', async () => {
    m.hasLiveConsent.mockImplementation(async (_u: string, t: string) => t === 'interview_recording');
    const res = await get('/ie/v1/practice/setup?job=j1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      market: 'intl',
      job: { id: 'j1', title: 'Backend Engineer', companyName: 'Acme', location: 'Berlin', jdText: 'Build APIs', closed: false },
      resume: { id: 'r1', name: 'Tailored for Acme', kind: 'tailored' },
      firstPractice: { method: 'email', verified: true, grant: 'already_granted' },
      voice: { available: true, reason: null },
      ai: { allowed: true, reason: null },
      recording: { available: true, consent: { audio: true, video: false } },
    });
    expect(m.loadJob).toHaveBeenCalledWith('u1', 'j1', 'intl');
  });

  it('a job that is not there (or in the other market) is 404', async () => {
    m.loadJob.mockResolvedValue(null);
    const res = await get('/ie/v1/practice/setup?job=j_other');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'job_not_found' });
  });

  it('works without a job (no resume either) and reports GoApply voice off', async () => {
    m.brand = { id: 'goapply', market: 'cn', name: 'GoApply' };
    m.voiceOn.mockReturnValue(false);
    m.loadResume.mockResolvedValue(null);
    const body = await (await get('/ie/v1/practice/setup')).json();
    expect(body).toMatchObject({
      market: 'cn', job: null, resume: null,
      voice: { available: false, reason: 'voice_unavailable' },
      ai: { allowed: true, reason: null },
    });
    expect(m.loadJob).not.toHaveBeenCalled();
  });
});

describe('report extras and the Practiced step', () => {
  it('GET /practice/sessions/:id returns the practice info', async () => {
    m.info.mockResolvedValue({ sessionId: 's1', status: 'completed', job: null, recording: { consented: false, video: false, available: false }, completedAt: null });
    const res = await get('/ie/v1/practice/sessions/s1');
    expect(res.status).toBe(200);
    expect((await res.json()).practice.recording.consented).toBe(false);
    expect(m.info).toHaveBeenCalledWith({ sessionId: 's1', userId: 'u1' });
  });

  it('GET /practice/sessions/:id maps a foreign session to 404', async () => {
    m.info.mockRejectedValue(new m.NotFound());
    const res = await get('/ie/v1/practice/sessions/other');
    expect(res.status).toBe(404);
  });

  it('GET /practice/jobs parses ids', async () => {
    m.practiced.mockResolvedValue({ j1: '2026-10-10T00:00:00.000Z' });
    const res = await get('/ie/v1/practice/jobs?ids=j1,%20j2,,');
    expect(await res.json()).toEqual({ practiced: { j1: '2026-10-10T00:00:00.000Z' } });
    expect(m.practiced).toHaveBeenCalledWith('u1', ['j1', 'j2']);
  });
});

describe('written practice (/practice/text/*)', () => {
  beforeEach(() => {
    m.brand = { id: 'goapply', market: 'cn', name: 'GoApply' };
    m.voiceOn.mockReturnValue(false); // the reason it exists
    m.ensureGrant.mockResolvedValue({ method: 'phone', verified: true, grant: 'already_granted' });
  });

  it('starts for the job: loaded server-side on the cn market, first practice topped up before the metered start', async () => {
    m.loadJob.mockResolvedValue({ id: 'j_cn', title: '后端工程师', companyName: '某公司', location: null, jdText: '负责后端', closed: false });
    const res = await post('/ie/v1/practice/text/start', {
      role: 'ignored', interviewerId: 'maya', typeId: 'behavioral', language: 'zh', durationMinutes: 15, jobId: 'j_cn',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).sessionId).toBe('t1');
    expect(m.loadJob).toHaveBeenCalledWith('u1', 'j_cn', 'cn');
    expect(m.textStart).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', interviewerId: 'maya', typeId: 'behavioral', language: 'zh', durationMinutes: 15,
      job: expect.objectContaining({ id: 'j_cn' }), creditExempt: false,
    }));
    expect(m.ensureGrant.mock.invocationCallOrder[0]).toBeLessThan(m.textStart.mock.invocationCallOrder[0]);
  });

  it('a job from the other market is 404 and nothing starts', async () => {
    m.loadJob.mockResolvedValue(null);
    const res = await post('/ie/v1/practice/text/start', { interviewerId: 'maya', typeId: 'behavioral', jobId: 'j_intl' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'job_not_found' });
    expect(m.textStart).not.toHaveBeenCalled();
  });

  it('out of credits: 402 with the practice bucket', async () => {
    m.textStart.mockRejectedValue(new m.InsufficientCredits('Insufficient mock-interview credits'));
    const res = await post('/ie/v1/practice/text/start', { interviewerId: 'maya', typeId: 'behavioral' });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: 'insufficient_credits', bucket: 'practice', firstPractice: { method: 'phone' } });
  });

  it('every call checks the GoApply gate: no phone → 403, no AI consent → 503, and no LLM call either way', async () => {
    m.phoneRequired.mockResolvedValue(true);
    for (const [path, body] of [
      ['/ie/v1/practice/text/start', { interviewerId: 'maya', typeId: 'behavioral' }],
      ['/ie/v1/practice/text/next-turn', { sessionId: 't1', answer: 'x', questionIndex: 0 }],
      ['/ie/v1/practice/text/t1/score', {}],
    ] as const) {
      const res = await post(path, body);
      expect(res.status, path).toBe(403);
      expect(await res.json()).toEqual({ error: 'phone_binding_required', bindRoute: '/bind-phone' });
    }
    m.phoneRequired.mockResolvedValue(false);
    m.aiAllowed.mockResolvedValue(false);
    for (const path of ['/ie/v1/practice/text/start', '/ie/v1/practice/text/next-turn', '/ie/v1/practice/text/t1/score']) {
      const res = await post(path, { sessionId: 't1', interviewerId: 'maya', typeId: 'behavioral' });
      expect(res.status, path).toBe(503);
      expect(await res.json()).toEqual({ error: 'ai_unavailable', reason: 'ai_consent_required' });
    }
    expect(m.textStart).not.toHaveBeenCalled();
    expect(m.textTurn).not.toHaveBeenCalled();
    expect(m.textScore).not.toHaveBeenCalled();
    expect(m.ensureGrant).not.toHaveBeenCalled();
  });

  it('forwards answers and scores for the signed-in user; a foreign session is 404', async () => {
    const turn = await post('/ie/v1/practice/text/next-turn', { sessionId: 't1', answer: 'I build APIs.', questionIndex: 2 });
    expect(turn.status).toBe(200);
    expect(m.textTurn).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', sessionId: 't1', answer: 'I build APIs.', questionIndex: 2 }));
    const score = await post('/ie/v1/practice/text/t1/score');
    expect((await score.json()).practiceCounted).toBe(true);
    expect(m.textScore).toHaveBeenCalledWith({ userId: 'u1', sessionId: 't1' });
    m.textScore.mockRejectedValue(new m.NotFound());
    expect((await post('/ie/v1/practice/text/other/score')).status).toBe(404);
  });

  it('admins are not metered; API keys are refused', async () => {
    m.user = { id: 'u1', role: 'admin', roles: ['admin'] };
    await post('/ie/v1/practice/text/start', { interviewerId: 'maya', typeId: 'behavioral' });
    expect(m.textStart).toHaveBeenLastCalledWith(expect.objectContaining({ creditExempt: true }));
    expect(m.ensureGrant).not.toHaveBeenCalled();
    m.apiKeyId = 'key1';
    const res = await post('/ie/v1/practice/text/start', { interviewerId: 'maya', typeId: 'behavioral' });
    expect(res.status).toBe(403);
  });
});

describe('external API recording flag', () => {
  it('records only when the tenant says so', async () => {
    m.apiKeyId = 'key1';
    await post('/ie/v1/sessions', { role: 'Engineer' });
    expect(m.create).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'external', recording: undefined }));
    await post('/ie/v1/sessions', { role: 'Engineer', recording: true, recordVideo: true });
    expect(m.create).toHaveBeenLastCalledWith(expect.objectContaining({ recording: { audio: true, video: true } }));
  });
});
