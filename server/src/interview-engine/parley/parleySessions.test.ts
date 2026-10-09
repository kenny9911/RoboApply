// @vitest-environment node
// Parley pilot transport: transcript mapping, per-session input, the connect
// claim (and its rollback), the End drain, and webhook routing.
// Run: npx vitest run server/src/interview-engine/parley/parleySessions.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  executeRaw: vi.fn(),
  create: vi.fn(),
  end: vi.fn(),
  get: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  default: {
    interviewSession: { findUnique: m.findUnique, updateMany: m.updateMany },
    $executeRawUnsafe: m.executeRaw,
  },
}));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./parleyClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./parleyClient.js')>()),
  createParleySession: m.create,
  endParleySession: m.end,
  getParleySession: m.get,
}));

const {
  buildParleySessionInput,
  closingLineFor,
  drainParleySession,
  getParleyConnection,
  handleParleyWebhook,
  isParleySession,
  ParleyUnavailableError,
  parleyUsageItems,
  toTranscriptTurns,
} = await import('./parleySessions.js');
const { ParleyApiError } = await import('./parleyClient.js');

const ENV = {
  PARLEY_URL: 'http://parley.test',
  PARLEY_API_KEY: 'pk_test',
  PARLEY_WEBHOOK_SECRET: 'whsec_test',
  PARLEY_AGENT_ID: 'agt_1',
  PARLEY_TTS_PROFILES: 'en:tts_en,zh:tts_zh',
  LIVEKIT_AGENT_CALLBACK_SECRET: 'cb_secret',
  INTERVIEW_ENGINE_CALLBACK_BASE_URL: 'http://api.test',
};

const HANDLE = { sessionId: 'ses_1', clientToken: 'ct_1', expiresAt: '2026-10-10T12:00:00Z', iceServers: [{ urls: ['stun:x'] }] };

function session(over: Record<string, unknown> = {}) {
  return {
    id: 'iv_1',
    status: 'created',
    mode: 'voice',
    language: 'zh',
    roomName: 'ie-1',
    plannedDurationMinutes: 10,
    interviewPrompt: '你是面试官。请使用简体中文（普通话）。',
    blueprint: { openingLine: '你好，我们开始吧。', openingInstruction: 'Greet.' },
    startedAt: null,
    participantIdentity: null,
    liveMetrics: { control: { transport: 'parley' } },
    ...over,
  } as never;
}

function sink() {
  return {
    ingestTranscript: vi.fn(async () => ({ ok: true as const, total: 0 })),
    ingestMetrics: vi.fn(async () => ({ ok: true })),
    ingestUsage: vi.fn(async () => ({ ok: true as const })),
    workerLifecycle: vi.fn(async () => undefined),
  };
}

const VOICE = { provider: 'p', model: 'm', voiceId: 'v', languageCode: 'zh' };

describe('parley sessions', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
    Object.assign(process.env, ENV);
    for (const fn of Object.values(m)) fn.mockReset();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('recognizes the transport from liveMetrics.control', () => {
    expect(isParleySession({ liveMetrics: { control: { transport: 'parley' } } })).toBe(true);
    expect(isParleySession({ liveMetrics: { control: { callbackBaseUrl: 'x' } } })).toBe(false);
    expect(isParleySession({ liveMetrics: null })).toBe(false);
  });

  it('maps Parley turns to RoboApply turns with unique per-role timestamps', () => {
    const turns = toTranscriptTurns([
      { turnId: 'a', role: 'agent', text: ' 你好 ', atMs: 0 },
      { turnId: 'b', role: 'user', text: '我叫李明', atMs: 4000 },
      { turnId: 'c', role: 'user', text: '补充一点', atMs: 4000 },
      { turnId: 'd', role: 'agent', text: '   ', atMs: 5000 },
      { turnId: 'e', role: 'agent', text: '请继续', atMs: 6000 },
    ], 1_000_000);
    expect(turns).toEqual([
      { role: 'interviewer', text: '你好', ts: 1_000_000 },
      { role: 'candidate', text: '我叫李明', ts: 1_004_000 },
      { role: 'candidate', text: '补充一点', ts: 1_004_001 },
      { role: 'interviewer', text: '请继续', ts: 1_006_000 },
    ]);
  });

  it('localizes the closing line (exact locale, primary subtag, English fallback)', () => {
    expect(closingLineFor('zh-TW')).toContain('面試');
    expect(closingLineFor('de-AT')).toContain('Interviews');
    expect(closingLineFor('xx')).toContain('Goodbye');
  });

  it('builds the per-session Parley input from the prepared session', () => {
    const input = buildParleySessionInput(session());
    expect(input).toMatchObject({
      language: 'zh',
      systemPrompt: '你是面试官。请使用简体中文（普通话）。',
      openingLine: '你好，我们开始吧。',
      maxDurationSec: 660,
      recording: false,
      externalRef: 'iv_1',
      ttsProfileId: 'tts_zh',
    });
    expect(input.closingLine).toContain('面试');
    // A legacy row without a deterministic opening leaves Parley's own.
    expect(buildParleySessionInput(session({ blueprint: {} }))).not.toHaveProperty('openingLine');
  });

  it('estimates audio usage from the transcript and duration', () => {
    expect(parleyUsageItems([{ turnId: 'a', role: 'agent', text: 'abcd', atMs: 0 }, { turnId: 'b', role: 'user', text: 'xy', atMs: 1 }], 60_000)).toEqual([
      { type: 'stt_usage', provider: 'parley', model: 'parley-stt', audioDurationMs: 60_000 },
      { type: 'tts_usage', provider: 'parley', model: 'parley-tts', charactersCount: 4 },
    ]);
  });

  describe('connect', () => {
    it('the claim winner creates the Parley session and stores the handle', async () => {
      m.updateMany.mockResolvedValueOnce({ count: 1 });
      m.create.mockResolvedValueOnce({ id: 'ses_1', clientToken: 'ct_1', expiresAt: HANDLE.expiresAt, rtc: { offerUrl: 'u', iceServers: HANDLE.iceServers } });
      m.executeRaw.mockResolvedValueOnce(1);
      const conn = await getParleyConnection(session(), VOICE);
      expect(m.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'iv_1', status: 'created' }, data: { status: 'live' } });
      expect(m.create.mock.calls[0][1]).toMatchObject({ webhookUrl: 'http://api.test/api/v1/interview-engine/webhooks/parley', externalRef: 'iv_1' });
      expect(JSON.parse(m.executeRaw.mock.calls[0][2])).toEqual(HANDLE);
      expect(conn).toMatchObject({ transport: 'parley', agentDispatched: true, recording: false, parley: { ...HANDLE, baseUrl: 'http://parley.test' } });
    });

    it('PARLEY_WEBHOOK_BASE_URL overrides the webhook origin (Parley in Docker on a laptop)', async () => {
      process.env.PARLEY_WEBHOOK_BASE_URL = 'http://host.docker.internal:4611/';
      try {
        m.updateMany.mockResolvedValueOnce({ count: 1 });
        m.create.mockResolvedValueOnce({ id: 'ses_1', clientToken: 'ct_1', expiresAt: HANDLE.expiresAt, rtc: { offerUrl: 'u', iceServers: [] } });
        m.executeRaw.mockResolvedValueOnce(1);
        await getParleyConnection(session(), VOICE);
        expect(m.create.mock.calls[0][1].webhookUrl).toBe('http://host.docker.internal:4611/api/v1/interview-engine/webhooks/parley');
      } finally {
        delete process.env.PARLEY_WEBHOOK_BASE_URL;
      }
    });

    it('a reconnect reuses the stored handle without creating anything', async () => {
      const conn = await getParleyConnection(session({ status: 'live', liveMetrics: { control: { transport: 'parley' }, parley: HANDLE } }), VOICE);
      expect(m.updateMany).not.toHaveBeenCalled();
      expect(m.create).not.toHaveBeenCalled();
      expect(conn.parley.sessionId).toBe('ses_1');
    });

    it('a claim loser waits for the winner’s handle', async () => {
      m.updateMany.mockResolvedValueOnce({ count: 0 });
      m.findUnique
        .mockResolvedValueOnce({ status: 'live', liveMetrics: { control: { transport: 'parley' } } })
        .mockResolvedValueOnce({ status: 'live', liveMetrics: { control: { transport: 'parley' }, parley: HANDLE } });
      const conn = await getParleyConnection(session(), VOICE);
      expect(m.create).not.toHaveBeenCalled();
      expect(conn.parley.clientToken).toBe('ct_1');
    });

    it('gives the claim back and reports worker_unavailable when Parley refuses', async () => {
      m.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
      m.create.mockRejectedValueOnce(new ParleyApiError(0, 'unreachable', 'Parley unreachable'));
      const err = await getParleyConnection(session(), VOICE).catch((e) => e);
      expect(err).toBeInstanceOf(ParleyUnavailableError);
      expect(err.code).toBe('worker_unavailable');
      expect(m.updateMany.mock.calls[1][0]).toMatchObject({ where: { id: 'iv_1', status: 'live' }, data: { status: 'created', startedAt: null } });
    });

    it('is unavailable when Parley is not configured', async () => {
      delete process.env.PARLEY_URL;
      await expect(getParleyConnection(session(), VOICE)).rejects.toBeInstanceOf(ParleyUnavailableError);
    });
  });

  describe('end (candidate pressed End)', () => {
    const live = () => session({ status: 'finalizing', startedAt: new Date('2026-10-10T00:00:00Z'), liveMetrics: { control: { transport: 'parley' }, parley: HANDLE } });

    it('ends quietly, reads the final transcript and ingests it', async () => {
      m.end.mockResolvedValueOnce(true);
      m.get.mockResolvedValueOnce({
        id: 'ses_1', status: 'ended', startedAt: '2026-10-10T00:00:05.000Z', durationMs: 90_000, endReason: 'ended_by_caller',
        transcript: [
          { turnId: 'g', role: 'agent', text: '你好', atMs: 0 },
          { turnId: 'u', role: 'user', text: '你好，我是李明', atMs: 3000 },
          { turnId: 'r', role: 'agent', text: '请介绍项目', atMs: 4200, metrics: { voiceToVoiceMs: 800 } },
        ],
      });
      const s = sink();
      expect(await drainParleySession(s, live())).toBe(true);
      expect(m.end).toHaveBeenCalledWith(expect.anything(), 'ses_1', { closing: false });
      const base = Date.parse('2026-10-10T00:00:05.000Z');
      expect(s.ingestTranscript).toHaveBeenCalledWith({
        sessionId: 'iv_1', secret: 'cb_secret',
        turns: [
          { role: 'interviewer', text: '你好', ts: base },
          { role: 'candidate', text: '你好，我是李明', ts: base + 3000 },
          { role: 'interviewer', text: '请介绍项目', ts: base + 4200 },
        ],
      });
      expect(s.ingestMetrics.mock.calls[0][0].events).toEqual([{ type: 'parley_turn', ts: base + 4200, voiceToVoiceMs: 800 }]);
      expect(s.ingestUsage).toHaveBeenCalledTimes(1);
      expect(s.workerLifecycle).not.toHaveBeenCalled();
    });

    it('still reads the transcript when Parley already ended the session', async () => {
      m.end.mockRejectedValueOnce(new ParleyApiError(404, 'not_found', 'gone'));
      m.get.mockResolvedValueOnce({ id: 'ses_1', status: 'ended', transcript: [], durationMs: 0 });
      expect(await drainParleySession(sink(), live())).toBe(true);
    });

    it('reports not drained when Parley is unreachable', async () => {
      m.end.mockRejectedValueOnce(new ParleyApiError(0, 'unreachable', 'down'));
      expect(await drainParleySession(sink(), live())).toBe(false);
    });
  });

  describe('webhook', () => {
    const ended = {
      event: 'session.ended',
      createdAt: '2026-10-10T00:02:00.000Z',
      data: {
        sessionId: 'ses_1', externalRef: 'iv_1', reason: 'time_up', startedAt: '2026-10-10T00:00:05.000Z', durationMs: 115_000,
        transcript: [{ turnId: 'g', role: 'agent' as const, text: 'Hi', atMs: 10 }],
      },
    };

    it('ingests the outcome, then finalizes through the worker "ended" lifecycle', async () => {
      m.findUnique.mockResolvedValueOnce({ id: 'iv_1', status: 'live', startedAt: null, liveMetrics: { control: { transport: 'parley' }, parley: HANDLE } });
      const s = sink();
      expect(await handleParleyWebhook(s, ended)).toBe('handled');
      expect(s.ingestTranscript.mock.calls[0][0].turns).toEqual([{ role: 'interviewer', text: 'Hi', ts: Date.parse('2026-10-10T00:00:05.000Z') + 10 }]);
      expect(s.workerLifecycle).toHaveBeenCalledWith({ sessionId: 'iv_1', secret: 'cb_secret', event: 'ended', reason: 'time_up' });
      expect(s.ingestTranscript.mock.invocationCallOrder[0]).toBeLessThan(s.workerLifecycle.mock.invocationCallOrder[0]);
    });

    it('leaves a session RoboApply is already finalizing to that path', async () => {
      const s = sink();
      for (const status of ['finalizing', 'completed', 'failed']) {
        m.findUnique.mockResolvedValueOnce({ id: 'iv_1', status, startedAt: null, liveMetrics: { control: { transport: 'parley' }, parley: HANDLE } });
        expect(await handleParleyWebhook(s, ended)).toBe('ignored');
      }
      expect(s.ingestTranscript).not.toHaveBeenCalled();
      expect(s.ingestMetrics).not.toHaveBeenCalled();
      expect(s.workerLifecycle).not.toHaveBeenCalled();
    });

    it('records session.started as worker telemetry', async () => {
      m.findUnique.mockResolvedValueOnce({ id: 'iv_1', status: 'live', startedAt: null, liveMetrics: { control: { transport: 'parley' }, parley: HANDLE } });
      const s = sink();
      expect(await handleParleyWebhook(s, { event: 'session.started', data: { sessionId: 'ses_1', externalRef: 'iv_1' } })).toBe('handled');
      expect(s.workerLifecycle).toHaveBeenCalledWith({ sessionId: 'iv_1', secret: 'cb_secret', event: 'started' });
    });

    it('ignores events for another Parley session, a LiveKit session or no session', async () => {
      const s = sink();
      m.findUnique.mockResolvedValueOnce({ id: 'iv_1', status: 'live', startedAt: null, liveMetrics: { control: { transport: 'parley' }, parley: { ...HANDLE, sessionId: 'ses_other' } } });
      expect(await handleParleyWebhook(s, ended)).toBe('ignored');
      m.findUnique.mockResolvedValueOnce({ id: 'iv_1', status: 'live', startedAt: null, liveMetrics: {} });
      expect(await handleParleyWebhook(s, ended)).toBe('ignored');
      m.findUnique.mockResolvedValueOnce(null);
      expect(await handleParleyWebhook(s, ended)).toBe('ignored');
      expect(await handleParleyWebhook(s, { event: 'session.ended', data: {} })).toBe('ignored');
      expect(s.ingestTranscript).not.toHaveBeenCalled();
      expect(s.workerLifecycle).not.toHaveBeenCalled();
    });
  });
});
