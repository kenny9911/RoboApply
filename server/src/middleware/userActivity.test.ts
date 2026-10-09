import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), warn: vi.fn() }));
vi.mock('../lib/prisma.js', () => ({ default: { userActivity: { create: mocks.create } } }));
vi.mock('../services/LoggerService.js', () => ({ logger: { warn: mocks.warn } }));

describe('server-recorded functional activity', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const express = (await import('express')).default;
    const { trackFeatureActivity } = await import('./userActivity.js');
    const app = express();
    app.use(express.json());
    app.use(trackFeatureActivity);
    app.use((req, _res, next) => {
      if (req.get('x-test-auth') !== 'anonymous') {
        req.user = { id: 'user1', email: 'u@example.test', createdAt: new Date(), updatedAt: new Date() };
        req.sessionToken = 'private-session-token';
      }
      req.requestId = 'request1';
      next();
    });
    app.use((req, res) => {
      if (req.get('x-test-result') === 'failed') return res.status(400).json({ error: 'invalid_input' });
      if (req.get('x-test-status')) return res.status(Number(req.get('x-test-status'))).json({ error: 'request_failed' });
      if (req.get('x-test-result') === 'soft-failed') return res.json({ success: false });
      if (req.get('x-test-result') === 'coach-unavailable') return res.json({ coach: null });
      if (req.get('x-test-result') === 'coach-delivered') return res.json({ coach: { text: 'Try a concrete example.' } });
      return res.status(201).json({ success: true, data: { saved: true } });
    });
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({ id: 'activity1' });
  });

  it('persists one event before success, without payload, credential, query, or resource ID', async () => {
    const response = await fetch(`${baseUrl}/api/v1/roboapply/v2/jobs/sensitive-job-id/score?token=secret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resumeText: 'private resume' }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ success: true, data: { saved: true } });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith({ data: {
      userId: 'user1',
      sessionId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      eventType: 'feature_use',
      path: '/api/v1/roboapply/v2/jobs/:id/score',
      element: 'job_match',
      timestamp: expect.any(Date),
      metadata: { source: 'server', method: 'POST', statusCode: 201 },
    } });
    expect(JSON.stringify(mocks.create.mock.calls)).not.toMatch(/private|secret|sensitive-job-id/);
  });

  it.each([
    ['POST', '/api/v1/roboapply/v2/jobs/job1/score', { 'x-test-result': 'failed' }],
    ['POST', '/api/v1/roboapply/v2/jobs/job1/score', { 'x-test-result': 'soft-failed' }],
    ['POST', '/api/v1/roboapply/v2/jobs/job1/score', { 'x-test-status': '401' }],
    ['POST', '/api/v1/roboapply/v2/jobs/job1/score', { 'x-test-status': '403' }],
    ['POST', '/api/v1/roboapply/v2/jobs/job1/score', { 'x-test-status': '429' }],
    ['POST', '/api/v1/roboapply/v2/jobs/job1/score', { 'x-test-status': '500' }],
    ['POST', '/api/v1/interview-engine/sessions/session1/coach', { 'x-test-result': 'coach-unavailable' }],
    ['POST', '/api/v1/roboapply/v2/jobs/job1/score', { 'x-test-auth': 'anonymous' }],
    ['GET', '/api/v1/roboapply/auth/me', {}],
    ['GET', '/api/v1/roboapply/v2/activity/orb-stats', {}],
    ['POST', '/api/v1/roboapply/v2/admin/rates', {}],
    ['POST', '/api/v1/roboapply/billing/checkout', {}],
    ['POST', '/api/v1/interview-engine/callbacks/sessions/session1/usage', {}],
  ])('excludes failed, unauthenticated, polling, billing, admin, and worker requests: %s %s %j', async (method, path, headers) => {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: headers as Record<string, string> });
    await response.json();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('returns the successful action if the telemetry database write fails', async () => {
    mocks.create.mockRejectedValueOnce(new Error('database unavailable'));
    const response = await fetch(`${baseUrl}/api/v1/roboapply/v2/resumes`, { method: 'POST' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ success: true, data: { saved: true } });
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it('records a delivered coach response', async () => {
    const response = await fetch(`${baseUrl}/api/v1/interview-engine/sessions/session1/coach`, {
      method: 'POST', headers: { 'x-test-result': 'coach-delivered' },
    });
    expect(await response.json()).toEqual({ coach: { text: 'Try a concrete example.' } });
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({ element: 'interview_coach' }) });
  });

  it('keeps the request alive until the activity write settles', async () => {
    let finishWrite!: () => void;
    mocks.create.mockImplementationOnce(() => new Promise<void>((resolve) => { finishWrite = resolve; }));
    let responseReceived = false;
    const pending = fetch(`${baseUrl}/api/v1/roboapply/v2/resumes`, { method: 'POST' }).then((response) => {
      responseReceived = true;
      return response;
    });
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    expect(responseReceived).toBe(false);
    finishWrite();
    expect((await pending).status).toBe(201);
  });
});
