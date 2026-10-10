// @vitest-environment node
//
// WP-43 — practice from a job, recording consent (H8), first free practice
// (C42), the "Practiced" checklist step and the written practice (metering,
// job, checklist once), against an in-memory Prisma double. LiveKit, egress,
// the prompt pipeline, scoring, billing and the text interview are mocked.
// Run: npx vitest run components/features/practice/__tests__/server/InterviewSessionService.practice.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const h = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  let seq = 0;
  const clone = (r: Row | undefined) => (r ? structuredClone(r) : null);
  const at = (obj: unknown, path: string[]) =>
    path.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Row)[k] : undefined), obj);

  function matchValue(actual: unknown, cond: unknown): boolean {
    if (cond === null) return actual === null || actual === undefined;
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Row;
      if ('in' in c) return (c.in as unknown[]).includes(actual);
      if ('notIn' in c) return !(c.notIn as unknown[]).includes(actual);
      if ('path' in c) return at(actual, c.path) === c.equals;
    }
    return actual === cond;
  }
  function matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([k, v]) =>
      k === 'OR' ? (v as Row[]).some((w) => matches(row, w)) : matchValue(row[k], v),
    );
  }
  function apply(row: Row, data: Row): void {
    for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
    row.updatedAt = new Date();
  }

  const interviewSession = {
    create: async ({ data }: { data: Row }) => {
      const now = new Date();
      const row: Row = {
        id: `s${++seq}`, status: 'created', error: null, transcript: null, liveMetrics: null, blueprint: null,
        interviewPrompt: null, questions: null, webSources: null, startedAt: null, endedAt: null,
        livekitRoomSid: null, agentDispatchId: null, egressId: null, recordingKey: null, transcriptKey: null,
        report: null, durationSec: null, candidateName: null, personaId: null, apiKeyId: null,
        createdAt: now, updatedAt: now, ...data,
      };
      rows.set(row.id, row);
      return clone(row);
    },
    findUnique: async ({ where }: { where: { id: string } }) => clone(rows.get(where.id)),
    findFirst: async ({ where }: { where: Row }) => clone([...rows.values()].find((r) => matches(r, where))),
    findMany: async ({ where }: { where?: Row }) => [...rows.values()].filter((r) => matches(r, where)).map((r) => clone(r)!),
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      let count = 0;
      for (const r of rows.values()) if (matches(r, where)) { apply(r, data); count += 1; }
      return { count };
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const r = rows.get(where.id);
      if (!r) throw new Error('P2025');
      apply(r, data);
      return clone(r);
    },
  };

  return {
    rows,
    prisma: { interviewSession, $executeRawUnsafe: async () => 0, $queryRawUnsafe: async () => [] },
    reset() { rows.clear(); },
    gate: vi.fn(),
    generate: vi.fn(),
    startRecording: vi.fn(),
    evaluate: vi.fn(),
    r2Configured: { value: true },
  };
});

vi.mock('../../../../../server/src/lib/prisma.js', () => ({ default: h.prisma }));
vi.mock('../../../../../server/src/services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), getRequestSnapshot: vi.fn(() => null) },
  generateRequestId: () => 'req-test',
}));
vi.mock('../../../../../server/src/interview-engine/livekit/liveKitClient.js', () => ({
  createInterviewRoom: vi.fn(async () => ({ sid: 'RM_1' })),
  dispatchAgent: vi.fn(async () => 'AD_1'),
  mintJoinToken: vi.fn(async () => ({ token: 'jwt', url: 'wss://x', expiresAt: new Date(Date.now() + 3600_000) })),
  deleteInterviewRoom: vi.fn(async () => undefined),
  sendInterviewEndSignal: vi.fn(async () => true),
}));
vi.mock('../../../../../server/src/interview-engine/livekit/egress.js', () => ({ startRoomRecording: h.startRecording, stopRecording: vi.fn(async () => {}) }));
vi.mock('../../../../../server/src/interview-engine/storage/r2Storage.js', () => ({
  interviewR2Storage: {
    isConfigured: () => h.r2Configured.value,
    recordingKey: (id: string) => `rec/${id}.mp4`,
    transcriptKey: (id: string) => `tr/${id}.json`,
    reportKey: (id: string) => `rp/${id}.json`,
    putObject: vi.fn(async () => undefined),
    uploadTranscript: vi.fn(async () => null),
  },
}));
vi.mock('../../../../../server/src/interview-engine/prompt/interviewPromptService.js', () => ({ interviewPromptService: { generate: h.generate } }));
vi.mock('../../../../../server/src/interview-engine/prompt/InterviewBlueprintAgent.js', () => ({ inferRoleFromJd: () => 'Inferred Role' }));
vi.mock('../../../../../server/src/lib/mockCreditService.js', () => ({ gateMockInterview: h.gate }));
vi.mock('../../../../../server/src/interview-engine/scoring/interviewEvaluationService.js', () => ({ runInterviewEvaluation: h.evaluate }));
vi.mock('../../../../../server/src/interview-engine/billing/sessionCost.js', () => ({
  describeSessionModels: () => ({}),
  tokenCostFromSnapshot: () => null,
  recordBlueprintCost: vi.fn(async () => {}),
  recordEvaluationCost: vi.fn(async () => {}),
  recordLiveUsage: vi.fn(async () => {}),
  recordRecordingCost: vi.fn(async () => {}),
  writeMockInterviewLedger: vi.fn(async () => {}),
}));

const ENV: Record<string, string | undefined> = {
  LLM_SETTINGS_DB_DISABLED: 'true',
  LLM_INTERVIEW_MODEL: 'openai/gpt-5.4',
  LIVEKIT_URL: 'wss://example.livekit.test',
  LIVEKIT_API_KEY: 'test-key',
  LIVEKIT_API_SECRET: 'test-secret-test-secret-test-secret',
  LIVEKIT_AGENT_CALLBACK_SECRET: 'cb-secret',
  INTERVIEW_ENGINE_RECORDING_ENABLED: 'true',
};
const saved: Record<string, string | undefined> = {};

const mod = await import('../../../../../server/src/interview-engine/sessions/InterviewSessionService.js');
const {
  interviewSessionService: svc,
  setPracticeDeps,
  ensureFirstPracticeGrant,
  loadPracticeResume,
  readPracticeMeta,
  readTextPracticeMeta,
  resolvePracticeRecording,
  PracticeJobNotFoundError,
} = mod;
const { handleEngineError } = await import('../../../../../server/src/interview-engine/routes/errors.js');

const JOBS: Record<string, any> = {
  j_intl: {
    id: 'j_intl', title: 'Backend Engineer', companyName: 'Acme', location: 'Berlin',
    description: '<p>Build APIs</p>', descriptionPlain: 'Build APIs in Go. 5 years.', market: 'intl',
    visibility: 'public', ownerUserId: null, archivedAt: null, closedAt: null,
  },
  j_cn: {
    id: 'j_cn', title: '后端工程师', companyName: '某公司', location: '上海', description: 'x', descriptionPlain: '负责后端',
    market: 'cn', visibility: 'public', ownerUserId: null, archivedAt: null, closedAt: null,
  },
  j_private_other: {
    id: 'j_private_other', title: 'Imported', companyName: 'Other Co', location: null, description: 'x',
    descriptionPlain: 'x', market: 'intl', visibility: 'private', ownerUserId: 'someone-else', archivedAt: null, closedAt: null,
  },
  j_private_mine: {
    id: 'j_private_mine', title: 'My import', companyName: 'Mine Co', location: null, description: 'x',
    descriptionPlain: 'Pasted posting', market: 'intl', visibility: 'private', ownerUserId: 'u1', archivedAt: null, closedAt: new Date(),
  },
};

/** In-memory RAMockSession rows for the written practice. */
const textRows = new Map<string, Record<string, any>>();

/** The atomic jsonb merge, on the in-memory rows (live: liveMetrics, text: blueprint). */
async function mergePracticeMeta(target: 'live' | 'text', id: string, patch: Record<string, unknown>, unlessSet?: string) {
  const row = target === 'live' ? h.rows.get(id) : textRows.get(id);
  if (!row) return false;
  const column = target === 'live' ? 'liveMetrics' : 'blueprint';
  const current = (row[column] ?? {}) as Record<string, any>;
  const practice = (current.practice ?? {}) as Record<string, unknown>;
  if (unlessSet && practice[unlessSet] != null) return false;
  row[column] = { ...current, practice: { ...practice, ...patch } };
  return true;
}

const deps = {
  consents: new Set<string>(),
  merge: vi.fn(mergePracticeMeta),
  gatePractice: vi.fn(async () => ({ ok: true, balance: 3, required: 1, tier: 'free' })),
  debitPractice: vi.fn(async () => ({ debited: 1, balanceAfter: 2 })),
  textStart: vi.fn(async (userId: string, input: Record<string, any>) => {
    const id = `t${textRows.size + 1}`;
    textRows.set(id, {
      id, userId, role: input.role, blueprint: { interviewerBrief: 'b' }, transcript: [],
      plannedDurationMinutes: input.durationMinutes, status: 'in_progress',
    });
    return { sessionId: id, questions: [{ q: 'Q1', hint: '', coachTip: null }] };
  }),
  textTurn: vi.fn(async (_u: string, input: { sessionId: string; answer: string }) => {
    textRows.get(input.sessionId)!.transcript.push({ who: 'them', text: 'Q1' }, { who: 'you', text: input.answer });
    return { nextIndex: null, turns: [], coachTip: null };
  }),
  textScore: vi.fn(async (_u: string, id: string) => {
    textRows.get(id)!.status = 'complete';
    return { overall: 60, delta: null, breakdown: [], strengths: [], gaps: [], durationMinutes: 6 };
  }),
  findTextPractice: vi.fn(async (userId: string, id: string) => {
    const row = textRows.get(id);
    return row && row.userId === userId ? structuredClone(row) as any : null;
  }),
  findTextPracticesForJobs: vi.fn(async (userId: string, ids: string[]) =>
    [...textRows.values()].filter((r) => r.userId === userId && r.status === 'complete' && ids.includes(r.blueprint?.practice?.jobId)) as any[]),
  findJob: vi.fn(async (id: string) => JOBS[id] ?? null),
  hasConsent: vi.fn(async (_u: string, type: string) => deps.consents.has(type)),
  markChecklistStep: vi.fn(async () => ({})),
  grantPracticeCredit: vi.fn(async () => ({ status: 'granted' as const })),
  findUser: vi.fn(async () => null as any),
  findResume: vi.fn(async () => null as any),
};

function genResult() {
  return {
    systemPrompt: 'You are the interviewer.', openingInstruction: 'Greet.', openingLine: 'Hello.', masterBrief: 'b',
    blueprint: { requirements: { roleSummary: 'x' }, strategy: {}, tactics: {}, questions: [{ q: 'Q1' }] },
    seedQuestions: [{ q: 'Q1', hint: 'h', coachTip: { kind: 'good', text: 't' } }], webSources: [],
  };
}

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

async function liveSession(extra: Record<string, unknown> = {}) {
  const s = await svc.createSession({ userId: 'u1', role: 'Engineer', market: 'intl', ...extra });
  await svc.prepareSession({ sessionId: s.id, userId: 'u1' });
  const conn = await svc.getConnection({ sessionId: s.id, userId: 'u1' });
  return { id: s.id, conn };
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
  setPracticeDeps(null);
});

beforeEach(() => {
  h.reset();
  textRows.clear();
  vi.clearAllMocks();
  deps.markChecklistStep.mockResolvedValue({});
  deps.gatePractice.mockResolvedValue({ ok: true, balance: 3, required: 1, tier: 'free' });
  h.r2Configured.value = true;
  deps.consents = new Set();
  h.gate.mockResolvedValue({ ok: true, balance: 3, required: 1, tier: 'free' });
  h.generate.mockResolvedValue(genResult());
  h.startRecording.mockImplementation(async ({ filepath }: { filepath: string }) => ({ egressId: 'EG_1', filepath }));
  h.evaluate.mockResolvedValue({
    richReport: { version: '2', questionAnalysis: [], recommendations: [], degraded: false },
    flat: { overall: 70, breakdown: {}, strengths: [], gaps: [], summary: 's' },
  });
  setPracticeDeps({
    findJob: deps.findJob,
    hasConsent: deps.hasConsent,
    markChecklistStep: deps.markChecklistStep,
    grantPracticeCredit: deps.grantPracticeCredit,
    findUser: deps.findUser,
    findResume: deps.findResume,
    currentMarket: () => 'intl',
    mergePracticeMeta: deps.merge,
    gatePractice: deps.gatePractice,
    debitPractice: deps.debitPractice,
    textStart: deps.textStart as any,
    textTurn: deps.textTurn as any,
    textScore: deps.textScore as any,
    findTextPractice: deps.findTextPractice,
    findTextPracticesForJobs: deps.findTextPracticesForJobs,
  });
});

describe('practice from a job (jobId)', () => {
  it('loads the job server-side and fills role and posting', async () => {
    const s = await svc.createSession({ userId: 'u1', role: '', jobId: 'j_intl', market: 'intl' });
    expect(s.role).toBe('Backend Engineer');
    expect(s.jdText).toBe('Build APIs in Go. 5 years.');
    expect(readPracticeMeta(s.liveMetrics)).toMatchObject({ jobId: 'j_intl', jobTitle: 'Backend Engineer', companyName: 'Acme' });
  });

  it('keeps an explicit role and pasted posting over the job values', async () => {
    const s = await svc.createSession({ userId: 'u1', role: 'Staff Engineer', jdText: 'Edited post', jobId: 'j_intl', market: 'intl' });
    expect(s.role).toBe('Staff Engineer');
    expect(s.jdText).toBe('Edited post');
  });

  it('a job from the other market is a 404, before the credit gate and with nothing written', async () => {
    const err = await svc.createSession({ userId: 'u1', role: '', jobId: 'j_cn', market: 'intl' }).catch((e) => e);
    expect(err).toBeInstanceOf(PracticeJobNotFoundError);
    expect(err.code).toBe('job_not_found');
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.rows.size).toBe(0);
    // The shared engine error map answers 404 for it.
    const res = fakeRes();
    handleEngineError(res, 'create', err);
    expect(res.statusCode).toBe(404);
  });

  it('defaults the market to the current brand (a GoApply request cannot load a RoboApply job)', async () => {
    setPracticeDeps({ findJob: deps.findJob, currentMarket: () => 'cn', hasConsent: deps.hasConsent });
    await expect(svc.createSession({ userId: 'u1', role: '', jobId: 'j_intl' })).rejects.toBeInstanceOf(PracticeJobNotFoundError);
    const ok = await svc.createSession({ userId: 'u1', role: '', jobId: 'j_cn' });
    expect(ok.role).toBe('后端工程师');
  });

  it('another user\'s private import is a 404; your own import works (closed or not)', async () => {
    await expect(svc.createSession({ userId: 'u1', role: '', jobId: 'j_private_other', market: 'intl' })).rejects.toBeInstanceOf(
      PracticeJobNotFoundError,
    );
    await expect(svc.createSession({ userId: 'u1', role: '', jobId: 'missing', market: 'intl' })).rejects.toBeInstanceOf(
      PracticeJobNotFoundError,
    );
    const mine = await svc.createSession({ userId: 'u1', role: '', jobId: 'j_private_mine', market: 'intl' });
    expect(mine.role).toBe('My import');
  });

  it('a session without a job and without recording writes no practice metadata', async () => {
    const s = await svc.createSession({ userId: 'u1', role: 'Engineer', market: 'intl' });
    expect(s.liveMetrics ?? null).toBeNull();
    expect(deps.hasConsent).not.toHaveBeenCalled();
  });
});

describe('recording consent (H8)', () => {
  it('a session created without interview_recording never starts egress, even when asked and enabled', async () => {
    const { id, conn } = await liveSession({ mode: 'video', recording: { audio: true, video: true } });
    expect(deps.hasConsent).toHaveBeenCalledWith('u1', 'interview_recording');
    expect(conn.recording).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.startRecording).not.toHaveBeenCalled();
    expect(h.rows.get(id)!.egressId ?? null).toBeNull();
  });

  it('a session that did not ask to record never starts egress, even with a standing consent', async () => {
    deps.consents = new Set(['interview_recording', 'interview_video']);
    const { conn } = await liveSession({ mode: 'video' });
    expect(conn.recording).toBe(false);
    expect(h.startRecording).not.toHaveBeenCalled();
  });

  it('with interview_recording only, a video session records audio only', async () => {
    deps.consents = new Set(['interview_recording']);
    const { id, conn } = await liveSession({ mode: 'video', recording: { audio: true, video: true } });
    expect(conn.recording).toBe(true);
    await vi.waitFor(() => expect(h.startRecording).toHaveBeenCalledTimes(1));
    expect(h.startRecording).toHaveBeenCalledWith(expect.objectContaining({ audioOnly: true }));
    await vi.waitFor(() => expect(h.rows.get(id)!.recordingMimeType).toBe('audio/mp4'));
  });

  it('video egress needs interview_video as well', async () => {
    deps.consents = new Set(['interview_recording', 'interview_video']);
    const { id } = await liveSession({ mode: 'video', recording: { audio: true, video: true } });
    await vi.waitFor(() => expect(h.startRecording).toHaveBeenCalledWith(expect.objectContaining({ audioOnly: false })));
    await vi.waitFor(() => expect(h.rows.get(id)!.recordingMimeType).toBe('video/mp4'));
  });

  it('consent without the env switch or storage still records nothing', async () => {
    deps.consents = new Set(['interview_recording']);
    h.r2Configured.value = false;
    const { conn } = await liveSession({ recording: { audio: true } });
    expect(conn.recording).toBe(false);
    expect(h.startRecording).not.toHaveBeenCalled();
  });

  it('a failed consent lookup fails closed', async () => {
    deps.hasConsent.mockRejectedValueOnce(new Error('db down'));
    const rec = await resolvePracticeRecording({ userId: 'u1', source: 'roboapply', mode: 'voice', requested: { audio: true } });
    expect(rec).toEqual({ audio: false, video: false });
  });

  it('external API sessions record only on the tenant flag; recruiter sessions never', async () => {
    expect(await resolvePracticeRecording({ userId: 'u1', source: 'external', mode: 'video', requested: { audio: true, video: true } }))
      .toEqual({ audio: true, video: true });
    expect(await resolvePracticeRecording({ userId: 'u1', source: 'external', mode: 'video', requested: undefined }))
      .toEqual({ audio: false, video: false });
    deps.consents = new Set(['interview_recording']);
    expect(await resolvePracticeRecording({ userId: 'u1', source: 'recruiter', mode: 'voice', requested: { audio: true } }))
      .toEqual({ audio: false, video: false });
  });

  it('the report says whether recording was consented', async () => {
    const { id } = await liveSession({ jobId: 'j_intl' });
    const info = await svc.getPracticeInfo({ sessionId: id, userId: 'u1' });
    expect(info).toMatchObject({
      job: { id: 'j_intl', title: 'Backend Engineer', companyName: 'Acme' },
      recording: { consented: false, video: false, available: false },
    });
    await expect(svc.getPracticeInfo({ sessionId: id, userId: 'someone-else' })).rejects.toThrow();
  });
});

describe('completion: checklist and the job\'s Practiced step', () => {
  async function complete(id: string) {
    h.rows.get(id)!.transcript = [
      { role: 'interviewer', text: 'Tell me about a project.', ts: 1000 },
      { role: 'candidate', text: 'I led the migration and cut latency by 40 percent.', ts: 9000 },
    ];
    await svc.workerLifecycle({ sessionId: id, secret: 'cb-secret', event: 'ended' });
  }

  it('fires markChecklistStep("practice") once per completed session', async () => {
    const { id } = await liveSession({ jobId: 'j_intl' });
    await complete(id);
    expect(h.rows.get(id)!.status).toBe('completed');
    await vi.waitFor(() => expect(deps.markChecklistStep).toHaveBeenCalledTimes(1));
    expect(deps.markChecklistStep).toHaveBeenCalledWith('u1', 'practice');

    // Late triggers (a second lifecycle, a direct re-run) do not fire it again.
    await svc.workerLifecycle({ sessionId: id, secret: 'cb-secret', event: 'ended' });
    const again = await svc.markPracticeCompleted(h.rows.get(id)! as any);
    expect(again).toBe(false);
    expect(deps.markChecklistStep).toHaveBeenCalledTimes(1);
    expect(readPracticeMeta(h.rows.get(id)!.liveMetrics)?.checklistMarkedAt).toBeTruthy();
  });

  it('a session with no answer is not a practice (no checklist step)', async () => {
    const { id } = await liveSession({ jobId: 'j_intl' });
    h.rows.get(id)!.transcript = [{ role: 'interviewer', text: 'Hello.', ts: 1 }];
    await svc.workerLifecycle({ sessionId: id, secret: 'cb-secret', event: 'ended' });
    expect(h.rows.get(id)!.status).toBe('failed');
    expect(deps.markChecklistStep).not.toHaveBeenCalled();
  });

  it('recruiter-source sessions do not touch the seeker checklist', async () => {
    const s = await svc.createSession({ userId: 'u1', role: 'Engineer', source: 'recruiter' });
    h.rows.get(s.id)!.status = 'completed';
    expect(await svc.markPracticeCompleted(h.rows.get(s.id)! as any)).toBe(false);
    expect(deps.markChecklistStep).not.toHaveBeenCalled();
  });

  it('practicedJobs maps each practised job to its latest completion', async () => {
    const { id } = await liveSession({ jobId: 'j_intl' });
    await complete(id);
    await liveSession({ jobId: 'j_private_mine' }); // live, not completed
    const map = await svc.practicedJobs('u1', ['j_intl', 'j_private_mine', '']);
    expect(Object.keys(map)).toEqual(['j_intl']);
    expect(await svc.practicedJobs('u1', [])).toEqual({});
    expect(await svc.practicedJobs('someone-else', ['j_intl'])).toEqual({});
  });

  it('a checklist failure never breaks finalize, and leaves no claim so a later run retries it', async () => {
    deps.markChecklistStep.mockRejectedValueOnce(new Error('growth down'));
    const { id } = await liveSession({ jobId: 'j_intl' });
    await complete(id);
    expect(h.rows.get(id)!.status).toBe('completed');
    await vi.waitFor(() => expect(deps.markChecklistStep).toHaveBeenCalledTimes(1));
    const meta = readPracticeMeta(h.rows.get(id)!.liveMetrics);
    expect(meta?.checklistMarkedAt).toBeUndefined();
    expect(meta?.completedAt).toBeTruthy(); // the job still counts as practised
    expect(meta?.jobId).toBe('j_intl');

    expect(await svc.markPracticeCompleted(h.rows.get(id)! as any)).toBe(true);
    expect(deps.markChecklistStep).toHaveBeenCalledTimes(2);
    expect(readPracticeMeta(h.rows.get(id)!.liveMetrics)?.checklistMarkedAt).toBeTruthy();
  });

  it('stamps through the atomic merge (never a read-modify-write of liveMetrics), and the claim is conditional', async () => {
    const { id } = await liveSession({ jobId: 'j_intl' });
    await complete(id);
    await vi.waitFor(() => expect(deps.markChecklistStep).toHaveBeenCalledTimes(1));
    const update = vi.spyOn(h.prisma.interviewSession, 'update');
    h.rows.get(id)!.liveMetrics.practice.checklistMarkedAt = undefined;
    expect(await svc.markPracticeCompleted(h.rows.get(id)! as any)).toBe(true);
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
    expect(deps.merge).toHaveBeenCalledWith('live', id, { completedAt: expect.any(String) });
    expect(deps.merge).toHaveBeenCalledWith('live', id, { checklistMarkedAt: expect.any(String) }, 'checklistMarkedAt');
    // A concurrent second claim loses.
    expect(await mergePracticeMeta('live', id, { checklistMarkedAt: 'x' }, 'checklistMarkedAt')).toBe(false);
  });
});

describe('the default stamp is one conditional UPDATE', () => {
  it('merges into liveMetrics.practice with jsonb_set and claims only while checklistMarkedAt is absent', async () => {
    const raw = vi.spyOn(h.prisma, '$executeRawUnsafe').mockResolvedValue(1 as never);
    setPracticeDeps({ markChecklistStep: deps.markChecklistStep }); // real mergePracticeMeta
    try {
      const s = await svc.createSession({ userId: 'u1', role: 'Engineer', market: 'intl' });
      h.rows.get(s.id)!.status = 'completed';
      expect(await svc.markPracticeCompleted(h.rows.get(s.id)! as any)).toBe(true);
      const calls = (raw.mock.calls as unknown as unknown[][]).map((c) => [String(c[0]).replace(/\s+/g, ' '), ...c.slice(1)]);
      const [stamp, claim] = calls.filter((c) => (c[0] as string).includes("'{practice}'"));
      expect(stamp[0]).toContain('UPDATE "InterviewSession" SET "liveMetrics" = jsonb_set(');
      expect(stamp[0]).not.toContain('IS NULL');
      expect(JSON.parse(stamp[2] as string)).toHaveProperty('completedAt');
      expect(claim[0]).toContain(`WHERE id = $1 AND ("liveMetrics" -> 'practice' ->> 'checklistMarkedAt') IS NULL`);
      expect(claim[1]).toBe(s.id);
      expect(JSON.parse(claim[2] as string)).toHaveProperty('checklistMarkedAt');
      // Growth is told before the claim.
      expect(deps.markChecklistStep.mock.invocationCallOrder[0]).toBeLessThan(raw.mock.invocationCallOrder.at(-1)!);
    } finally {
      raw.mockRestore();
    }
  });
});

describe('written practice (GoApply without voice)', () => {
  const JOB = { id: 'j_cn', title: '后端工程师', companyName: '某公司', location: null, jdText: '负责后端', closed: false };

  it('starts metered, seeded with the job, and tags the row for the job', async () => {
    const started = await svc.startTextPractice({
      userId: 'u1', role: 'ignored', interviewerId: 'maya', typeId: 'behavioral', language: 'zh', durationMinutes: 15, job: JOB,
    });
    expect(started).toMatchObject({ sessionId: 't1', jobId: 'j_cn' });
    expect(deps.gatePractice).toHaveBeenCalledWith('u1', 15);
    expect(deps.textStart).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ role: '后端工程师 (某公司)', interviewerId: 'maya', typeId: 'behavioral', durationMinutes: 15 }),
      undefined,
    );
    expect(readTextPracticeMeta(textRows.get('t1')!.blueprint)).toMatchObject({ kind: 'text', jobId: 'j_cn', creditExempt: false });
    expect(textRows.get('t1')!.blueprint.interviewerBrief).toBe('b'); // the generator's brief is kept
  });

  it('out of credits: no text interview starts', async () => {
    deps.gatePractice.mockResolvedValue({ ok: false, balance: 0, required: 1, tier: 'free' });
    await expect(svc.startTextPractice({ userId: 'u1', interviewerId: 'maya', typeId: 'behavioral', job: null }))
      .rejects.toBeInstanceOf(mod.InterviewInsufficientCreditsError);
    expect(deps.textStart).not.toHaveBeenCalled();
  });

  it('admins are not gated or debited', async () => {
    const { sessionId } = await svc.startTextPractice({ userId: 'u1', role: 'Engineer', interviewerId: 'maya', typeId: 'behavioral', job: null, creditExempt: true });
    expect(deps.gatePractice).not.toHaveBeenCalled();
    await svc.textPracticeTurn({ userId: 'u1', sessionId, answer: 'An answer', questionIndex: 0 });
    await svc.scoreTextPractice({ userId: 'u1', sessionId });
    expect(deps.debitPractice).not.toHaveBeenCalled();
  });

  it('an answered, scored practice is debited, ticks the checklist once and marks the job practised', async () => {
    const { sessionId } = await svc.startTextPractice({ userId: 'u1', interviewerId: 'maya', typeId: 'behavioral', durationMinutes: 15, job: JOB });
    await svc.textPracticeTurn({ userId: 'u1', sessionId, answer: 'I built the payments API.', questionIndex: 0 });
    const scored = await svc.scoreTextPractice({ userId: 'u1', sessionId });
    expect(scored).toMatchObject({ overall: 60, practiceCounted: true, jobId: 'j_cn' });
    expect(deps.debitPractice).toHaveBeenCalledWith({ userId: 'u1', sessionId, durationSec: 360, plannedDurationMinutes: 15 });
    expect(deps.markChecklistStep).toHaveBeenCalledTimes(1);
    expect(deps.markChecklistStep).toHaveBeenCalledWith('u1', 'practice');

    // Scoring again re-scores but never ticks the checklist a second time.
    await svc.scoreTextPractice({ userId: 'u1', sessionId });
    expect(deps.markChecklistStep).toHaveBeenCalledTimes(1);

    const map = await svc.practicedJobs('u1', ['j_cn', 'j_intl']);
    expect(Object.keys(map)).toEqual(['j_cn']);
  });

  it('an unanswered practice is not debited and does not count', async () => {
    const { sessionId } = await svc.startTextPractice({ userId: 'u1', interviewerId: 'maya', typeId: 'behavioral', job: JOB });
    await svc.textPracticeTurn({ userId: 'u1', sessionId, answer: '   ', questionIndex: 0 });
    const scored = await svc.scoreTextPractice({ userId: 'u1', sessionId });
    expect(scored.practiceCounted).toBe(false);
    expect(deps.debitPractice).not.toHaveBeenCalled();
    expect(deps.markChecklistStep).not.toHaveBeenCalled();
    expect(await svc.practicedJobs('u1', ['j_cn'])).toEqual({});
  });

  it('a checklist failure leaves no claim; the next score ticks it', async () => {
    const { sessionId } = await svc.startTextPractice({ userId: 'u1', interviewerId: 'maya', typeId: 'behavioral', job: null });
    await svc.textPracticeTurn({ userId: 'u1', sessionId, answer: 'An answer', questionIndex: 0 });
    deps.markChecklistStep.mockRejectedValueOnce(new Error('growth down'));
    await svc.scoreTextPractice({ userId: 'u1', sessionId });
    expect(readTextPracticeMeta(textRows.get(sessionId)!.blueprint)?.checklistMarkedAt).toBeUndefined();
    await svc.scoreTextPractice({ userId: 'u1', sessionId });
    expect(deps.markChecklistStep).toHaveBeenCalledTimes(2);
    expect(readTextPracticeMeta(textRows.get(sessionId)!.blueprint)?.checklistMarkedAt).toBeTruthy();
  });

  it('another user\'s session, or a text interview that is not a first-party practice, is 404', async () => {
    const { sessionId } = await svc.startTextPractice({ userId: 'u1', interviewerId: 'maya', typeId: 'behavioral', job: null });
    await expect(svc.scoreTextPractice({ userId: 'someone-else', sessionId })).rejects.toBeInstanceOf(mod.InterviewNotFoundError);
    textRows.set('legacy', { id: 'legacy', userId: 'u1', blueprint: null, transcript: [], plannedDurationMinutes: 20, status: 'in_progress' });
    await expect(svc.textPracticeTurn({ userId: 'u1', sessionId: 'legacy', answer: 'x', questionIndex: 0 }))
      .rejects.toBeInstanceOf(mod.InterviewNotFoundError);
    expect(deps.textScore).not.toHaveBeenCalled();
  });
});

describe('first free practice (C42)', () => {
  it('RoboApply: grants once the email was verified, with the WP-10 key', async () => {
    deps.findUser.mockResolvedValueOnce({
      brand: 'roboapply', name: 'A', emailVerified: true, emailVerifiedAt: new Date(), emailIsPlaceholder: false,
      phoneE164: null, phoneVerifiedAt: null,
    });
    const s = await ensureFirstPracticeGrant('u1');
    expect(s).toEqual({ method: 'email', verified: true, grant: 'granted' });
    expect(deps.grantPracticeCredit).toHaveBeenCalledWith('u1', 'email_verified', 'email_verified');
  });

  it('RoboApply: no grant before verification (grandfathered rows without a verification date included)', async () => {
    deps.findUser.mockResolvedValueOnce({
      brand: 'roboapply', name: 'A', emailVerified: false, emailVerifiedAt: null, emailIsPlaceholder: false,
      phoneE164: null, phoneVerifiedAt: null,
    });
    expect(await ensureFirstPracticeGrant('u1')).toEqual({ method: 'email', verified: false, grant: null });
    deps.findUser.mockResolvedValueOnce({
      brand: 'roboapply', name: 'A', emailVerified: true, emailVerifiedAt: null, emailIsPlaceholder: false,
      phoneE164: null, phoneVerifiedAt: null,
    });
    expect((await ensureFirstPracticeGrant('u1')).verified).toBe(false);
    expect(deps.grantPracticeCredit).not.toHaveBeenCalled();
  });

  it('GoApply: grants after phone verification', async () => {
    deps.findUser.mockResolvedValueOnce({
      brand: 'goapply', name: null, emailVerified: true, emailVerifiedAt: null, emailIsPlaceholder: true,
      phoneE164: '+8613800000000', phoneVerifiedAt: new Date(),
    });
    deps.grantPracticeCredit.mockResolvedValueOnce({ status: 'already_granted' } as any);
    expect(await ensureFirstPracticeGrant('u1')).toEqual({ method: 'phone', verified: true, grant: 'already_granted' });
    expect(deps.grantPracticeCredit).toHaveBeenCalledWith('u1', 'phone_verified', 'phone_verified');
  });

  it('GoApply without a phone, or an unknown user, gets nothing; a failing grant reports failed', async () => {
    deps.findUser.mockResolvedValueOnce({
      brand: 'goapply', name: null, emailVerified: true, emailVerifiedAt: new Date(), emailIsPlaceholder: false,
      phoneE164: null, phoneVerifiedAt: null,
    });
    expect(await ensureFirstPracticeGrant('u1')).toEqual({ method: 'phone', verified: false, grant: null });
    expect(await ensureFirstPracticeGrant('u1')).toEqual({ method: 'email', verified: false, grant: null });
    deps.findUser.mockResolvedValueOnce({
      brand: 'roboapply', name: 'A', emailVerified: true, emailVerifiedAt: new Date(), emailIsPlaceholder: false,
      phoneE164: null, phoneVerifiedAt: null,
    });
    deps.grantPracticeCredit.mockRejectedValueOnce(new Error('ledger down'));
    expect((await ensureFirstPracticeGrant('u1')).grant).toBe('failed');
  });
});

describe('resume prefill', () => {
  it('redacts PII and clips the resume context', async () => {
    deps.findResume.mockResolvedValueOnce({
      id: 'r1', name: 'Tailored for Acme', kind: 'tailored',
      resumeMarkdown: `Jane Doe\njane.doe@example.com · +1 415 555 0100\n${'Built things. '.repeat(400)}`,
    });
    const r = await loadPracticeResume('u1', { jobId: 'j_intl', knownValues: ['Jane Doe'] });
    expect(r).toMatchObject({ id: 'r1', kind: 'tailored' });
    expect(r!.context).not.toContain('jane.doe@example.com');
    expect(r!.context).not.toContain('Jane Doe');
    expect(r!.context.length).toBeLessThanOrEqual(2000);
    expect(deps.findResume).toHaveBeenCalledWith('u1', { resumeId: null, jobId: 'j_intl' });
  });

  it('returns null when the user has no resume', async () => {
    expect(await loadPracticeResume('u1', {})).toBeNull();
  });
});
