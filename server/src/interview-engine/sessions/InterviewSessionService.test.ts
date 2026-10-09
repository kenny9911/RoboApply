// @vitest-environment node
//
// server/src/interview-engine/sessions/InterviewSessionService.test.ts
//
// Control-plane contract tests (create → prepare → connect → end/finalize)
// against an in-memory Prisma double. LiveKit, the prompt pipeline, scoring
// LLMs and billing are mocked; the transcript-dedupe SQL is executed for real
// on an in-process Postgres (pglite).
// Run: npx vitest run server/src/interview-engine/sessions/InterviewSessionService.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const h = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  let seq = 0;
  const lastRawSql: { sql: string; params: unknown[] }[] = [];

  function matchValue(actual: unknown, cond: unknown): boolean {
    if (cond === null) return actual === null || actual === undefined;
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ('in' in c) return (c.in as unknown[]).includes(actual);
      if ('notIn' in c) return !(c.notIn as unknown[]).includes(actual);
      if ('lt' in c) return actual instanceof Date && actual.getTime() < (c.lt as Date).getTime();
    }
    return actual === cond;
  }
  function matches(row: Row, where: Record<string, unknown> = {}): boolean {
    return Object.entries(where).every(([k, v]) => matchValue(row[k], v));
  }
  function apply(row: Row, data: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) row[k] = v;
    }
    row.updatedAt = new Date();
  }
  const clone = (r: Row | undefined) => (r ? structuredClone(r) : null);

  const interviewSession = {
    create: async ({ data }: { data: Row }) => {
      const now = new Date();
      const row: Row = {
        id: `s${++seq}`,
        status: 'created',
        error: null,
        transcript: null,
        liveMetrics: null,
        blueprint: null,
        interviewPrompt: null,
        questions: null,
        webSources: null,
        startedAt: null,
        endedAt: null,
        livekitRoomSid: null,
        agentDispatchId: null,
        egressId: null,
        recordingKey: null,
        transcriptKey: null,
        report: null,
        durationSec: null,
        candidateName: null,
        personaId: null,
        apiKeyId: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      rows.set(row.id, row);
      return clone(row);
    },
    findUnique: async ({ where }: { where: { id: string } }) => clone(rows.get(where.id)),
    findFirst: async ({ where }: { where: Row }) => clone([...rows.values()].find((r) => matches(r, where))),
    findMany: async ({ where, take }: { where?: Row; take?: number }) =>
      [...rows.values()].filter((r) => matches(r, where)).slice(0, take ?? 1000).map((r) => clone(r)),
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      let count = 0;
      for (const r of rows.values()) {
        if (matches(r, where)) { apply(r, data); count += 1; }
      }
      return { count };
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const r = rows.get(where.id);
      if (!r) throw new Error('P2025 record not found');
      apply(r, data);
      return clone(r);
    },
    deleteMany: async ({ where }: { where: Row }) => {
      let count = 0;
      for (const [id, r] of rows) if (matches(r, where)) { rows.delete(id); count += 1; }
      return { count };
    },
  };

  const prisma = {
    interviewSession,
    // ingestTranscript's atomic append — emulated here (role,ts dedupe +
    // status guard); the real SQL is executed on pglite in its own test.
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      lastRawSql.push({ sql, params });
      const [json, id] = params as [string, string];
      const r = rows.get(id);
      if (!r || !['created', 'live', 'finalizing'].includes(r.status)) return [];
      const existing: Row[] = Array.isArray(r.transcript) ? r.transcript : [];
      const add = (JSON.parse(json) as Row[]).filter(
        (t) => !existing.some((o) => o.role === t.role && o.ts === t.ts),
      );
      r.transcript = [...existing, ...add];
      r.updatedAt = new Date();
      return [{ total: r.transcript.length }];
    },
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      lastRawSql.push({ sql, params });
      if (sql.includes('workerEndedAt')) {
        const r = rows.get(params[0] as string);
        if (!r) return 0;
        r.liveMetrics = { ...(r.liveMetrics ?? {}), workerEndedAt: params[1] };
        return 1;
      }
      return 0;
    },
  };

  return {
    rows,
    lastRawSql,
    prisma,
    reset() { rows.clear(); lastRawSql.length = 0; },
    generate: vi.fn(),
    gate: vi.fn(),
    sendEnd: vi.fn(),
    deleteRoom: vi.fn(),
    createRoom: vi.fn(),
    dispatch: vi.fn(),
    mint: vi.fn(),
    evaluate: vi.fn(),
    ledger: vi.fn(),
  };
});

vi.mock('../../lib/prisma.js', () => ({ default: h.prisma }));
vi.mock('../../services/LoggerService.js', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    getRequestSnapshot: vi.fn(() => null), startRequest: vi.fn(), endRequest: vi.fn(),
  },
  generateRequestId: () => 'req-test',
}));
vi.mock('../livekit/liveKitClient.js', () => ({
  createInterviewRoom: h.createRoom,
  dispatchAgent: h.dispatch,
  mintJoinToken: h.mint,
  deleteInterviewRoom: h.deleteRoom,
  sendInterviewEndSignal: h.sendEnd,
}));
vi.mock('../livekit/egress.js', () => ({ startRoomRecording: vi.fn(async () => null), stopRecording: vi.fn(async () => {}) }));
vi.mock('../storage/r2Storage.js', () => ({
  interviewR2Storage: { isConfigured: () => false, recordingKey: (id: string) => `rec/${id}.mp4` },
}));
vi.mock('../prompt/interviewPromptService.js', () => ({ interviewPromptService: { generate: h.generate } }));
vi.mock('../prompt/InterviewBlueprintAgent.js', () => ({ inferRoleFromJd: () => 'Inferred Role' }));
vi.mock('../../lib/mockCreditService.js', () => ({ gateMockInterview: h.gate }));
vi.mock('../scoring/interviewEvaluationService.js', () => ({ runInterviewEvaluation: h.evaluate }));
vi.mock('../billing/sessionCost.js', () => ({
  describeSessionModels: () => ({}),
  tokenCostFromSnapshot: () => null,
  recordBlueprintCost: vi.fn(async () => {}),
  recordEvaluationCost: vi.fn(async () => {}),
  recordLiveUsage: vi.fn(async () => {}),
  recordRecordingCost: vi.fn(async () => {}),
  writeMockInterviewLedger: h.ledger,
}));

const ENV: Record<string, string | undefined> = {
  LLM_SETTINGS_DB_DISABLED: 'true',
  LLM_INTERVIEW_MODEL: 'openai/gpt-5.4',
  LIVEKIT_URL: 'wss://example.livekit.test',
  LIVEKIT_API_KEY: 'test-key',
  LIVEKIT_API_SECRET: 'test-secret-test-secret-test-secret',
  LIVEKIT_AGENT_CALLBACK_SECRET: 'cb-secret',
  INTERVIEW_ENGINE_RECORDING_ENABLED: 'false',
  INTERVIEW_ENGINE_CALLBACK_BASE_URL: undefined,
  BACKEND_PUBLIC_URL: undefined,
  PUBLIC_BACKEND_URL: undefined,
  LLM_INTERVIEW_LIVE_MODEL: undefined,
  LLM_INTERVIEW_LIVE_REASONING_EFFORT: undefined,
};
const saved: Record<string, string | undefined> = {};

const { interviewSessionService: svc, InterviewNotReadyError, InterviewSessionFailedError, InterviewSessionEndedError, InterviewPrepareFailedError } =
  await import('./InterviewSessionService.js');
const { handleEngineError } = await import('../routes/errors.js');

function genResult() {
  return {
    systemPrompt: 'You are the interviewer.',
    openingInstruction: 'Greet.',
    openingLine: 'Hello there.',
    masterBrief: 'brief',
    blueprint: { requirements: { roleSummary: 'x' }, strategy: {}, tactics: {}, questions: [{ q: 'Q1' }] },
    seedQuestions: [{ q: 'Q1', hint: 'h', coachTip: { kind: 'good', text: 't' } }],
    webSources: [],
  };
}

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

async function createPrepared(extra: Record<string, unknown> = {}) {
  const s = await svc.createSession({ userId: 'u1', role: 'Software Engineer', ...extra });
  return svc.prepareSession({ sessionId: s.id, userId: 'u1' });
}

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

beforeEach(() => {
  h.reset();
  vi.clearAllMocks();
  h.gate.mockResolvedValue({ ok: true, balance: 10, required: 1, tier: 'free' });
  h.generate.mockResolvedValue(genResult());
  h.deleteRoom.mockResolvedValue(undefined);
  h.createRoom.mockResolvedValue({ sid: 'RM_1' });
  h.dispatch.mockResolvedValue('AD_1');
  h.mint.mockResolvedValue({ token: 'jwt', url: 'wss://example', expiresAt: new Date(Date.now() + 3600_000) });
  h.sendEnd.mockResolvedValue(true);
  h.evaluate.mockResolvedValue({
    richReport: { version: '2', questionAnalysis: [], recommendations: [], degraded: false },
    flat: { overall: 70, breakdown: {}, strengths: [], gaps: [], summary: 's' },
  });
  h.ledger.mockResolvedValue(undefined);
});

describe('create → prepare → created (C1/C2)', () => {
  it('creates a preparing row without running generation, then prepares it', async () => {
    const s = await svc.createSession({ userId: 'u1', role: 'Software Engineer', mode: 'video', language: 'en' });
    expect(s.status).toBe('preparing');
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.gate).toHaveBeenCalledWith('u1', expect.any(Number));

    const prepared = await svc.prepareSession({ sessionId: s.id, userId: 'u1' });
    expect(prepared.status).toBe('created');
    expect(prepared.interviewPrompt).toBe('You are the interviewer.');
    expect(prepared.blueprint.openingLine).toBe('Hello there.');
    expect(prepared.blueprint.liveLlm).toMatchObject({ model: 'openai/gpt-5.4', reasoningEffort: 'low' });
    expect(h.generate).toHaveBeenCalledWith(expect.objectContaining({ strictLlm: true, role: 'Software Engineer' }));
  });

  it('returns a non-preparing session unchanged (no second generation)', async () => {
    const prepared = await createPrepared();
    h.generate.mockClear();
    const again = await svc.prepareSession({ sessionId: prepared.id, userId: 'u1' });
    expect(again.status).toBe('created');
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('dedupes concurrent prepare calls in-process', async () => {
    let release!: () => void;
    h.generate.mockImplementation(() => new Promise((r) => { release = () => r(genResult()); }));
    const s = await svc.createSession({ userId: 'u1', role: 'PM' });
    const a = svc.prepareSession({ sessionId: s.id, userId: 'u1' });
    const b = svc.prepareSession({ sessionId: s.id, userId: 'u1' });
    await new Promise((r) => setTimeout(r, 10));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(ra.status).toBe('created');
    expect(rb.status).toBe('created');
  });

  it('throws 402 before persisting when credits are insufficient', async () => {
    h.gate.mockResolvedValue({ ok: false, balance: 0, required: 1, tier: 'free' });
    await expect(svc.createSession({ userId: 'u1', role: 'x' })).rejects.toMatchObject({ name: 'InterviewInsufficientCreditsError' });
    expect(h.rows.size).toBe(0);
  });

  it('exempts admins from the credit gate explicitly and records it', async () => {
    const s = await svc.createSession({ userId: 'u1', role: 'x', source: 'roboapply', creditExempt: true });
    expect(h.gate).not.toHaveBeenCalled();
    expect(s.source).toBe('roboapply');
    expect(s.liveMetrics).toEqual({ control: { creditExempt: true } });
  });

  it('persists the derived callback origin and puts it in room metadata', async () => {
    const s = await svc.createSession({ userId: 'u1', role: 'x', callbackBaseUrl: 'https://www.roboapply.io' });
    await svc.prepareSession({ sessionId: s.id, userId: 'u1' });
    await svc.getConnection({ sessionId: s.id, userId: 'u1' });
    const meta = JSON.parse(h.createRoom.mock.calls[0][0].metadata);
    expect(meta.callbackBaseUrl).toBe('https://www.roboapply.io');
    expect(meta.llm).toEqual({ model: 'openai/gpt-5.4', reasoningEffort: 'low' });
  });
});

describe('prepare failure → failed → retry (C2)', () => {
  it('marks llm_unavailable on a dead provider key and retries on request', async () => {
    h.generate.mockRejectedValueOnce(new Error('401 User not found.'));
    const s = await svc.createSession({ userId: 'u1', role: 'x' });

    const err = await svc.prepareSession({ sessionId: s.id, userId: 'u1' }).catch((e) => e);
    expect(err).toBeInstanceOf(InterviewPrepareFailedError);
    expect(err.code).toBe('llm_unavailable');
    expect(h.rows.get(s.id)).toMatchObject({ status: 'failed', error: 'llm_unavailable' });

    const res = fakeRes();
    handleEngineError(res, 'prepare', err);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'llm_unavailable', session: { id: s.id, status: 'failed', error: 'llm_unavailable' } });

    // Without retry: still failed, no new generation.
    await expect(svc.prepareSession({ sessionId: s.id, userId: 'u1' })).rejects.toBeInstanceOf(InterviewPrepareFailedError);
    expect(h.generate).toHaveBeenCalledTimes(1);

    // Retry re-runs and succeeds.
    const ok = await svc.prepareSession({ sessionId: s.id, userId: 'u1', retry: true });
    expect(ok.status).toBe('created');
    expect(ok.error).toBeNull();
    expect(h.generate).toHaveBeenCalledTimes(2);
  });

  it('marks prepare_failed (500) for non-LLM errors', async () => {
    h.generate.mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'q')"));
    const s = await svc.createSession({ userId: 'u1', role: 'x' });
    const err = await svc.prepareSession({ sessionId: s.id, userId: 'u1' }).catch((e) => e);
    expect(err.code).toBe('prepare_failed');
    const res = fakeRes();
    handleEngineError(res, 'prepare', err);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('prepare_failed');
  });

  it('does not retry a session that failed for another reason', async () => {
    const s = await svc.createSession({ userId: 'u1', role: 'x' });
    h.rows.get(s.id)!.status = 'failed';
    h.rows.get(s.id)!.error = 'no_answer';
    await expect(svc.prepareSession({ sessionId: s.id, userId: 'u1', retry: true }))
      .rejects.toBeInstanceOf(InterviewSessionFailedError);
    expect(h.generate).not.toHaveBeenCalled();
  });
});

describe('connection 409s (C4)', () => {
  it('maps preparing / failed / ended to typed 409s', async () => {
    const s = await svc.createSession({ userId: 'u1', role: 'x' });
    const notReady = await svc.getConnection({ sessionId: s.id, userId: 'u1' }).catch((e) => e);
    expect(notReady).toBeInstanceOf(InterviewNotReadyError);
    let res = fakeRes();
    handleEngineError(res, 'connection', notReady);
    expect([res.statusCode, res.body.error]).toEqual([409, 'not_ready']);

    h.rows.get(s.id)!.status = 'failed';
    h.rows.get(s.id)!.error = 'llm_unavailable';
    const failed = await svc.getConnection({ sessionId: s.id, userId: 'u1' }).catch((e) => e);
    expect(failed).toBeInstanceOf(InterviewSessionFailedError);
    res = fakeRes();
    handleEngineError(res, 'connection', failed);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'session_failed', reason: 'llm_unavailable' });

    h.rows.get(s.id)!.status = 'completed';
    const ended = await svc.getConnection({ sessionId: s.id, userId: 'u1' }).catch((e) => e);
    expect(ended).toBeInstanceOf(InterviewSessionEndedError);
    res = fakeRes();
    handleEngineError(res, 'connection', ended);
    expect([res.statusCode, res.body.error]).toEqual([409, 'session_ended']);
    expect(h.createRoom).not.toHaveBeenCalled();
  });

  it('goes live once prepared', async () => {
    const s = await createPrepared();
    const conn = await svc.getConnection({ sessionId: s.id, userId: 'u1' });
    expect(conn.agentDispatched).toBe(true);
    expect(h.rows.get(s.id)!.status).toBe('live');
  });
});

describe('worker error callback (C9)', () => {
  async function liveSession() {
    const s = await createPrepared();
    await svc.getConnection({ sessionId: s.id, userId: 'u1' });
    return s.id;
  }

  it('fails a session with zero candidate turns and tears the room down', async () => {
    const id = await liveSession();
    await svc.workerLifecycle({ sessionId: id, secret: 'cb-secret', event: 'error', reason: 'greeting_no_audio', message: 'TTS produced no audio' });
    const row = h.rows.get(id)!;
    expect(row.status).toBe('failed');
    expect(row.error).toBe('greeting_no_audio');
    expect(row.liveMetrics.worker.errors).toEqual([
      expect.objectContaining({ reason: 'greeting_no_audio', message: 'TTS produced no audio' }),
    ]);
    expect(h.deleteRoom).toHaveBeenCalled();

    // A late 'ended' must not resurrect it into a completed, charged session.
    await svc.workerLifecycle({ sessionId: id, secret: 'cb-secret', event: 'ended' });
    expect(h.rows.get(id)!.status).toBe('failed');
    expect(h.ledger).not.toHaveBeenCalled();
  });

  it('only records the error once the candidate has answered', async () => {
    const id = await liveSession();
    h.rows.get(id)!.transcript = [{ role: 'candidate', text: 'My answer', ts: 1 }];
    await svc.workerLifecycle({ sessionId: id, secret: 'cb-secret', event: 'error', reason: 'llm_error' });
    expect(h.rows.get(id)).toMatchObject({ status: 'live', error: 'llm_error' });
  });

  it('rejects a bad callback secret', async () => {
    const id = await liveSession();
    await expect(svc.workerLifecycle({ sessionId: id, secret: 'nope', event: 'error' })).rejects.toMatchObject({ name: 'InterviewAuthError' });
  });
});

describe('finalize (C10) and candidate end (C8)', () => {
  async function liveSession() {
    const s = await createPrepared();
    await svc.getConnection({ sessionId: s.id, userId: 'u1' });
    return s.id;
  }

  it('a session with no candidate turns ends failed/no_answer: no evaluation, no charge', async () => {
    const id = await liveSession();
    h.rows.get(id)!.transcript = [{ role: 'interviewer', text: 'Hello there.', ts: 1 }];
    await svc.workerLifecycle({ sessionId: id, secret: 'cb-secret', event: 'ended' });
    expect(h.rows.get(id)).toMatchObject({ status: 'failed', error: 'no_answer', durationSec: 0 });
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(h.ledger).not.toHaveBeenCalled();
  });

  it('a session with answers completes and is evaluated', async () => {
    const id = await liveSession();
    h.rows.get(id)!.transcript = [
      { role: 'interviewer', text: 'Tell me about a project.', ts: 1000 },
      { role: 'candidate', text: 'I led the migration and cut latency by 40 percent.', ts: 9000 },
    ];
    await svc.workerLifecycle({ sessionId: id, secret: 'cb-secret', event: 'ended' });
    expect(h.rows.get(id)!.status).toBe('completed');
    await vi.waitFor(() => expect(h.ledger).toHaveBeenCalledWith(id));
  });

  it('endByOwner signals the worker, waits for its drain, then finalizes', async () => {
    const id = await liveSession();
    h.sendEnd.mockImplementation(async () => {
      // The worker flushes its last answer and posts 'ended' shortly after.
      setTimeout(() => {
        void svc.ingestTranscript({ sessionId: id, secret: 'cb-secret', turns: [{ role: 'candidate', text: 'Final answer', ts: 5000 }] as any })
          .then(() => svc.workerLifecycle({ sessionId: id, secret: 'cb-secret', event: 'ended' }));
      }, 50);
      return true;
    });
    const t0 = Date.now();
    const done = await svc.endByOwner({ sessionId: id, userId: 'u1' });
    expect(h.sendEnd).toHaveBeenCalledWith(h.rows.get(id)!.roomName);
    expect(done.status).toBe('completed');
    expect(h.deleteRoom).toHaveBeenCalled();
    // Drained → no 4 s flush grace.
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('ending a session that never went live fails it without touching LiveKit', async () => {
    const s = await svc.createSession({ userId: 'u1', role: 'x' });
    const done = await svc.endByOwner({ sessionId: s.id, userId: 'u1' });
    expect(done).toMatchObject({ status: 'failed', error: 'no_answer' });
    expect(h.deleteRoom).not.toHaveBeenCalled();
  });
});

describe('transcript dedupe (C11)', () => {
  it('drops duplicates within a batch and against stored turns', async () => {
    const s = await createPrepared();
    await svc.getConnection({ sessionId: s.id, userId: 'u1' });
    const turn = { role: 'candidate', text: 'Hi', ts: 100, key: 'candidate:100' };
    await svc.ingestTranscript({ sessionId: s.id, secret: 'cb-secret', turns: [turn, turn] as any });
    const sent = JSON.parse(h.lastRawSql.at(-1)!.params[0] as string);
    expect(sent).toHaveLength(1);
    const r = await svc.ingestTranscript({ sessionId: s.id, secret: 'cb-secret', turns: [turn, { ...turn, ts: 200 }] as any });
    expect(r.total).toBe(2);
  });

  it('the real append SQL dedupes on (role, ts) and honours the status guard', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite();
    await db.exec(`CREATE TABLE "InterviewSession" (id text primary key, status text, transcript jsonb, "updatedAt" timestamptz)`);
    await db.exec(`INSERT INTO "InterviewSession" VALUES ('a', 'live', NULL, now()), ('done', 'completed', NULL, now())`);

    const s = await createPrepared();
    await svc.getConnection({ sessionId: s.id, userId: 'u1' });
    await svc.ingestTranscript({ sessionId: s.id, secret: 'cb-secret', turns: [{ role: 'candidate', text: 'x', ts: 1 }] as any });
    const sql = h.lastRawSql.at(-1)!.sql;

    const run = async (id: string, turns: unknown[]) =>
      (await db.query<{ total: number }>(sql, [JSON.stringify(turns), id])).rows;

    expect(await run('a', [{ role: 'interviewer', text: 'Q', ts: 1 }, { role: 'candidate', text: 'A', ts: 2 }])).toEqual([{ total: 2 }]);
    // Retried batch overlapping the stored turns: only the new one lands.
    expect(await run('a', [{ role: 'candidate', text: 'A', ts: 2 }, { role: 'candidate', text: 'B', ts: 3 }])).toEqual([{ total: 3 }]);
    // Same ts, different role is a different turn.
    expect(await run('a', [{ role: 'interviewer', text: 'Q2', ts: 3 }])).toEqual([{ total: 4 }]);
    // Fully duplicate batch is a no-op append.
    expect(await run('a', [{ role: 'candidate', text: 'B', ts: 3 }])).toEqual([{ total: 4 }]);
    // Completed sessions drop turns.
    expect(await run('done', [{ role: 'candidate', text: 'late', ts: 9 }])).toEqual([]);
    await db.close();
  });
});

describe('cleanup sweep (C3)', () => {
  it('expires stale preparing rows and leaves fresh ones', async () => {
    const stale = await svc.createSession({ userId: 'u1', role: 'x' });
    const fresh = await svc.createSession({ userId: 'u1', role: 'y' });
    h.rows.get(stale.id)!.updatedAt = new Date(Date.now() - 31 * 60_000);
    const r = await svc.reconcileExpiredSessions();
    expect(r.expired).toBe(1);
    expect(h.rows.get(stale.id)!.status).toBe('expired');
    expect(h.rows.get(fresh.id)!.status).toBe('preparing');
  });
});
