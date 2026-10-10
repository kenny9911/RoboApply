// @vitest-environment node
//
// Control plane acceptance for the session's media plane (WP-63a; D5,
// GOAPPLY_PARITY_PLAN §3.5).
//
// GoApply with its OWN plane (CN_LIVEKIT_*, the default env of this file): the
// session runs on CN_LIVEKIT_* with the 'GoApply-Interview' worker, DashScope
// speech and CN_S3_* — even when later calls arrive from a RoboApply context
// (a webhook on the other host, a cron). GoApply with only the shared
// credentials: the shared LiveKit project, the shared worker and its agent
// name, the shared voice catalog and bucket. Either way the session stays on
// the plane it was created on. Camera and video recording follow one policy on
// both brands. RoboApply sessions behave as in Wave 0 (no seam stored, same
// worker, camera and recording rules).
//
// INT-09 (WP-63a-S1): every create writes `InterviewSession.brand` and
// `voiceProvider`; readers take the column, else `liveMetrics.voiceSeam`, else
// the owner's `User.brand` — a legacy row with neither still resolves its real
// brand for LiveKit, storage, the webhook signer and the worker secret.
// Run: npx vitest run server/src/interview-engine/providers/__tests__/sessionSeam.service.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const h = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  let seq = 0;
  const calls: Array<{ fn: string; brand: string | undefined; args: unknown[] }> = [];
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('in' in v) return (v.in as unknown[]).includes(row[k]);
        if ('notIn' in v) return !(v.notIn as unknown[]).includes(row[k]);
      }
      if (v === null) return row[k] === null || row[k] === undefined;
      return row[k] === v;
    });
  const clone = (r: Row | undefined) => (r ? structuredClone(r) : null);
  const apply = (r: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) if (v !== undefined) r[k] = v;
  };
  const interviewSession = {
    create: async ({ data }: { data: Row }) => {
      const row: Row = {
        id: `s${++seq}`, status: 'created', error: null, transcript: [], liveMetrics: null, blueprint: null,
        startedAt: null, endedAt: null, livekitRoomSid: null, agentDispatchId: null, egressId: null,
        recordingKey: null, transcriptKey: null, report: null, candidateName: null, apiKeyId: null,
        createdAt: new Date(), updatedAt: new Date(), ...data,
      };
      rows.set(row.id, row);
      return clone(row);
    },
    findUnique: async ({ where }: { where: { id: string } }) => clone(rows.get(where.id)),
    findFirst: async ({ where }: { where: Row }) => clone([...rows.values()].find((r) => matches(r, where))),
    findMany: async ({ where }: { where?: Row }) => [...rows.values()].filter((r) => matches(r, where)).map((r) => clone(r)),
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
    calls,
    prisma: { interviewSession, $executeRawUnsafe: async () => 0, $queryRawUnsafe: async () => [] },
    reset() { rows.clear(); calls.length = 0; },
    generate: vi.fn(),
  };
});

vi.mock('../../../lib/prisma.js', () => ({ default: h.prisma }));
vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  generateRequestId: () => 'req-test',
}));
vi.mock('../../livekit/liveKitClient.js', async () => {
  const { getCurrentBrandId } = await import('../../../lib/requestContext.js');
  const { getLiveKitCreds } = await import('../../config.js');
  const rec = (fn: string, ret: (...a: unknown[]) => unknown) => async (...args: unknown[]) => {
    // What the real client would sign with: the creds of the current brand.
    h.calls.push({ fn, brand: getCurrentBrandId(), args: [...args, getLiveKitCreds().apiKey] });
    return ret(...args);
  };
  return {
    createInterviewRoom: rec('createRoom', () => ({ sid: 'RM_1' })),
    dispatchAgent: rec('dispatch', () => 'AD_1'),
    mintJoinToken: rec('mint', () => ({ token: 'jwt', url: 'wss://x', expiresAt: new Date(Date.now() + 3600_000) })),
    sendInterviewEndSignal: rec('end', () => true),
    deleteInterviewRoom: rec('deleteRoom', () => undefined),
  };
});
vi.mock('../../livekit/egress.js', async () => {
  const { getCurrentBrandId } = await import('../../../lib/requestContext.js');
  const { getR2Creds } = await import('../../config.js');
  return {
    startRoomRecording: async (p: { roomName: string; filepath: string; audioOnly: boolean }) => {
      h.calls.push({ fn: 'record', brand: getCurrentBrandId(), args: [p, getR2Creds()?.bucket] });
      return { egressId: 'EG_1', filepath: p.filepath };
    },
    stopRecording: async (id: string) => {
      h.calls.push({ fn: 'stopRecord', brand: getCurrentBrandId(), args: [id] });
    },
  };
});
vi.mock('../../storage/r2Storage.js', async () => {
  const { getR2Creds, getR2WriteCreds } = await import('../../config.js');
  return {
    interviewR2Storage: {
      isConfigured: () => getR2Creds() !== null,
      canStore: () => getR2WriteCreds() !== null,
      recordingKey: (id: string) => `interviews/${id}/recording.mp4`,
      // What the real client would read from: the bucket of the current brand.
      headObject: async (key: string) => {
        h.calls.push({ fn: 'head', brand: undefined, args: [key, getR2Creds()?.bucket] });
        return { size: 1, contentType: 'audio/mp4', lastModified: new Date() };
      },
      presignGet: async (p: { key: string }) => {
        h.calls.push({ fn: 'presign', brand: undefined, args: [p.key, getR2Creds()?.bucket] });
        return `https://${getR2Creds()?.bucket}.example/${p.key}`;
      },
    },
  };
});
vi.mock('../../prompt/interviewPromptService.js', () => ({ interviewPromptService: { generate: h.generate } }));
vi.mock('../../prompt/InterviewBlueprintAgent.js', () => ({ inferRoleFromJd: () => 'Role' }));
vi.mock('../../../lib/mockCreditService.js', () => ({ gateMockInterview: async () => ({ ok: true, balance: 5, required: 1, tier: 'free' }) }));
vi.mock('../../billing/sessionCost.js', () => ({
  describeSessionModels: () => ({}),
  tokenCostFromSnapshot: () => null,
  recordBlueprintCost: vi.fn(async () => {}),
  recordEvaluationCost: vi.fn(async () => {}),
  recordLiveUsage: vi.fn(async () => {}),
  recordRecordingCost: vi.fn(async () => {}),
  writeMockInterviewLedger: vi.fn(async () => {}),
}));

const ENV: Record<string, string> = {
  LLM_SETTINGS_DB_DISABLED: 'true',
  LLM_INTERVIEW_MODEL: 'openai/gpt-5.4',
  CN_LLM_INTERVIEW_MODEL: 'deepseek/deepseek-v4-pro',
  LIVEKIT_URL: 'wss://intl.livekit.test',
  LIVEKIT_API_KEY: 'intl-key',
  LIVEKIT_API_SECRET: 'intl-secret',
  CN_LIVEKIT_URL: 'wss://cn.livekit.test',
  CN_LIVEKIT_API_KEY: 'cn-key',
  CN_LIVEKIT_API_SECRET: 'cn-secret',
  LIVEKIT_AGENT_CALLBACK_SECRET: 'intl-cb',
  CN_LIVEKIT_AGENT_CALLBACK_SECRET: 'cn-cb',
  INTERVIEW_ENGINE_RECORDING_ENABLED: 'true',
  CN_INTERVIEW_ENGINE_RECORDING_ENABLED: 'true',
  S3_BUCKET: 'intl-bucket', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b',
  CN_S3_BUCKET: 'cn-bucket', CN_S3_ACCESS_KEY_ID: 'c', CN_S3_SECRET_ACCESS_KEY: 'd',
  CN_INTERVIEW_ENGINE_STT_MODEL: 'dashscope/paraformer-realtime-v2',
  CN_INTERVIEW_ENGINE_TTS_MODEL: 'dashscope/cosyvoice-v2',
  // The shared speech set: never mixed into GoApply's own DashScope set.
  INTERVIEW_ENGINE_STT_MODEL: 'deepgram/nova-3',
  INTERVIEW_ENGINE_TTS_MODEL: 'cartesia/sonic-3',
};
const CLEARED = [
  'INTERVIEW_ENGINE_CALLBACK_BASE_URL', 'BACKEND_PUBLIC_URL', 'PUBLIC_BACKEND_URL', 'VOICE_PROVIDER', 'CN_VOICE_PROVIDER',
  'LLM_INTERVIEW_LIVE_MODEL', 'CN_LLM_INTERVIEW_LIVE_MODEL', 'INTERVIEW_ENGINE_AGENT_NAME', 'CN_INTERVIEW_ENGINE_AGENT_NAME',
  'CN_INTERVIEW_CAMERA_PUBLISH', 'CN_LLM_DOMESTIC_ONLY', 'CN_RESIDENCY_STRICT', 'LLM_INTERVIEW_LIVE_REASONING_EFFORT',
  'CN_INTERVIEW_ENGINE_CALLBACK_BASE_URL', 'CN_INTERVIEW_ENGINE_STT_FALLBACK_MODELS', 'INTERVIEW_ENGINE_STT_FALLBACK_MODELS',
  'INTERVIEW_ENGINE_TTS_PROVIDER',
];
/** Every GoApply override of this file's env: without them GoApply runs on the shared stack. */
const CN_OVERRIDES = Object.keys(ENV).filter((k) => k.startsWith('CN_'));
/** The two LiveKit projects, as `receiveBrandWebhook` reports the signer. */
const SHARED_PROJECT = { apiKey: 'intl-key', brands: ['roboapply'] as Array<'roboapply' | 'goapply'> };
const CN_PROJECT = { apiKey: 'cn-key', brands: ['goapply'] as Array<'roboapply' | 'goapply'> };
const SHARED_BY_BOTH = { apiKey: 'intl-key', brands: ['roboapply', 'goapply'] as Array<'roboapply' | 'goapply'> };
const saved: Record<string, string | undefined> = {};

const { interviewSessionService: svc, setPracticeDeps } = await import('../../sessions/InterviewSessionService.js');
const { runWithBrand } = await import('../../../lib/requestContext.js');
const { setUserBrandLookup } = await import('../../../platform/brand/userBrand.js');

beforeAll(() => {
  for (const k of [...Object.keys(ENV), ...CLEARED]) saved[k] = process.env[k];
  Object.assign(process.env, ENV);
  for (const k of CLEARED) delete process.env[k];
  setPracticeDeps({ hasConsent: async () => true });
});
afterAll(() => {
  setUserBrandLookup(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const owners = vi.fn(async (userId: string): Promise<string | null> => (userId.startsWith('cn-') ? 'goapply' : userId.startsWith('gone-') ? null : 'roboapply'));

beforeEach(() => {
  h.reset();
  owners.mockClear();
  setUserBrandLookup(owners);
  h.generate.mockResolvedValue({
    systemPrompt: 'p', openingInstruction: 'g', openingLine: 'Hello', masterBrief: 'b',
    blueprint: { requirements: {}, questions: [] }, seedQuestions: [], webSources: [],
  });
});

/** Run with some variables set or removed (undefined), then put the environment back. */
async function withEnv<T>(changes: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(changes).map((k) => [k, process.env[k]]));
  const put = (table: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(table)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  put(changes);
  try {
    return await fn();
  } finally {
    put(before);
  }
}
/** GoApply with only the shared credentials (no CN_ override at all). */
const sharedOnly = <T>(fn: () => Promise<T>) => withEnv(Object.fromEntries(CN_OVERRIDES.map((k) => [k, undefined])), fn);

async function liveSession(brand: 'roboapply' | 'goapply', mode: 'voice' | 'video' = 'video', language?: string) {
  const created = await runWithBrand(brand, () =>
    svc.createSession({ userId: 'u1', role: 'Engineer', mode, language, recording: { audio: true, video: true } }),
  );
  await runWithBrand(brand, () => svc.prepareSession({ sessionId: created.id, userId: 'u1' }));
  // The connection request may come in on either host: the session's own brand rules.
  const conn = await runWithBrand('roboapply', () => svc.getConnection({ sessionId: created.id, userId: 'u1' }));
  await vi.waitFor(() => expect(h.calls.some((c) => c.fn === 'record') || !conn.recording).toBe(true));
  return { id: created.id, conn };
}

const call = (fn: string) => h.calls.find((c) => c.fn === fn)!;

describe('GoApply session on its own media plane', () => {
  it('stores the GoApply seam with its plane, and the same recording choice RoboApply would store', async () => {
    const s = await runWithBrand('goapply', () =>
      svc.createSession({ userId: 'u1', role: 'Engineer', mode: 'video', recording: { audio: true, video: true } }),
    );
    expect(s.liveMetrics.voiceSeam).toEqual({ v: 1, brand: 'goapply', provider: 'livekit_cloud', stack: 'own' });
    // Both consents are live in this file: video is recorded, as on RoboApply (G8).
    expect(s.recordingConsent).toEqual({ audio: true, video: true });
    expect(s.liveMetrics.practice.recording).toEqual({ audio: true, video: true });
  });

  it('uses CN_LIVEKIT_* and GoApply-Interview, publishes the camera, records into CN_S3', async () => {
    const { conn } = await liveSession('goapply', 'video');
    for (const fn of ['createRoom', 'dispatch', 'mint']) {
      expect(call(fn).brand).toBe('goapply');
      expect(call(fn).args.at(-1)).toBe('cn-key');
    }
    expect(call('dispatch').args[0]).toMatchObject({ agentName: 'GoApply-Interview' });
    expect(call('mint').args[0]).toMatchObject({ allowVideo: true });
    expect(conn.cameraPublish).toBe(true);
    expect(call('record').args).toEqual([expect.objectContaining({ audioOnly: false }), 'cn-bucket']);
    const meta = JSON.parse((call('createRoom').args[0] as { metadata: string }).metadata);
    expect(meta.llm.model).toBe('deepseek/deepseek-v4-pro');
  });

  it('without the video consent a GoApply video practice still publishes the camera and records audio only', async () => {
    setPracticeDeps({ hasConsent: async (_userId, type) => type === 'interview_recording' });
    try {
      const { id, conn } = await liveSession('goapply', 'video');
      expect(h.rows.get(id)!.recordingConsent).toEqual({ audio: true, video: false });
      expect(conn.cameraPublish).toBe(true);
      expect(call('mint').args[0]).toMatchObject({ allowVideo: true });
      expect(call('record').args).toEqual([expect.objectContaining({ audioOnly: true }), 'cn-bucket']);
      await svc.handleEgressEnded({ egressId: 'EG_1', sizeBytes: 10, durationSec: 5, signer: CN_PROJECT });
      expect(h.rows.get(id)!.recordingMimeType).toBe('audio/mp4');
    } finally {
      setPracticeDeps({ hasConsent: async () => true });
    }
  });

  it('CN_INTERVIEW_CAMERA_PUBLISH=false (operator opt-out): local preview only, audio only, whatever was consented', async () => {
    await withEnv({ CN_INTERVIEW_CAMERA_PUBLISH: 'false' }, async () => {
      const { id, conn } = await liveSession('goapply', 'video');
      expect(h.rows.get(id)!.recordingConsent).toEqual({ audio: true, video: false });
      expect(call('mint').args[0]).toMatchObject({ allowVideo: false });
      expect(conn.cameraPublish).toBe(false);
      expect(call('record').args).toEqual([expect.objectContaining({ audioOnly: true }), 'cn-bucket']);
      // RoboApply is not touched by GoApply's switch.
      h.calls.length = 0;
      const intl = await liveSession('roboapply', 'video');
      expect(intl.conn.cameraPublish).toBe(true);
      expect(call('record').args).toEqual([expect.objectContaining({ audioOnly: false }), 'intl-bucket']);
    });
  });

  it('CN_RESIDENCY_STRICT without a bucket of its own: the practice runs, and nothing is recorded into the shared bucket', async () => {
    await withEnv(
      { CN_RESIDENCY_STRICT: 'true', CN_S3_BUCKET: undefined, CN_S3_ACCESS_KEY_ID: undefined, CN_S3_SECRET_ACCESS_KEY: undefined },
      async () => {
        const { conn } = await liveSession('goapply', 'video');
        expect(call('dispatch').args[0]).toMatchObject({ agentName: 'GoApply-Interview' });
        expect(conn.recording).toBe(false);
        expect(h.calls.some((c) => c.fn === 'record')).toBe(false);
        // RoboApply is not touched by GoApply's switch.
        h.calls.length = 0;
        const intl = await liveSession('roboapply', 'video');
        expect(intl.conn.recording).toBe(true);
        expect(call('record').args).toEqual([expect.objectContaining({ audioOnly: false }), 'intl-bucket']);
      },
    );
    // Without the strict switch the shared bucket is the fallback (D5).
    await withEnv({ CN_S3_BUCKET: undefined, CN_S3_ACCESS_KEY_ID: undefined, CN_S3_SECRET_ACCESS_KEY: undefined }, async () => {
      h.calls.length = 0;
      const { conn } = await liveSession('goapply', 'video');
      expect(conn.recording).toBe(true);
      expect(call('record').args).toEqual([expect.objectContaining({ audioOnly: false }), 'intl-bucket']);
    });
  });

  it('tears the room down on the GoApply plane even from a RoboApply context', async () => {
    const { id } = await liveSession('goapply');
    h.calls.length = 0;
    await runWithBrand('roboapply', () => svc.handleEgressEnded({ egressId: 'EG_1', sizeBytes: 10, durationSec: 5 }));
    expect(h.rows.get(id)!.recordingMimeType).toBe('video/mp4');
    await runWithBrand('roboapply', () => svc.deleteByOwner({ sessionId: id, userId: 'u1' })).catch(() => undefined);
    expect(call('deleteRoom')).toMatchObject({ brand: 'goapply' });
    expect(call('deleteRoom').args.at(-1)).toBe('cn-key');
  });

  it('ignores LiveKit webhooks signed by another LiveKit project', async () => {
    const { id } = await liveSession('goapply');
    const roomName = h.rows.get(id)!.roomName as string;
    expect(roomName).toBeTruthy();
    const before = h.rows.get(id)!.recordingBytes ?? null;
    await svc.handleEgressEnded({ egressId: 'EG_1', sizeBytes: 10, durationSec: 5, signer: SHARED_PROJECT });
    expect(h.rows.get(id)!.recordingBytes ?? null).toBe(before);
    await svc.handleRoomFinished(roomName, SHARED_PROJECT);
    expect(h.rows.get(id)!.status).toBe('live');
    // Naming the brand is not enough: the KEY must be the key of the session's plane.
    await svc.handleRoomFinished(roomName, { apiKey: 'intl-key', brands: ['roboapply', 'goapply'] });
    expect(h.rows.get(id)!.status).toBe('live');
    // The session's own project is accepted.
    await svc.handleEgressEnded({ egressId: 'EG_1', sizeBytes: 10, durationSec: 5, signer: CN_PROJECT });
    expect(h.rows.get(id)!.recordingBytes).toBe(10);
  });

  it('accepts only the GoApply worker’s callback secret for a GoApply session', async () => {
    const { id } = await liveSession('goapply');
    await expect(svc.ingestMetrics({ sessionId: id, secret: 'cn-cb', events: [] })).resolves.toBeTruthy();
    for (const secret of ['intl-cb', 'nope', undefined]) {
      await expect(svc.ingestMetrics({ sessionId: id, secret, events: [] })).rejects.toMatchObject({ name: 'InterviewAuthError' });
      await expect(svc.ingestTranscript({ sessionId: id, secret, turns: [] })).rejects.toMatchObject({ name: 'InterviewAuthError' });
      await expect(svc.workerLifecycle({ sessionId: id, secret, event: 'ended' })).rejects.toMatchObject({ name: 'InterviewAuthError' });
      await expect(svc.ingestUsage({ sessionId: id, secret, modelUsage: [] })).rejects.toMatchObject({ name: 'InterviewAuthError' });
    }
    expect(h.rows.get(id)!.status).toBe('live');
  });

  it('a RoboApply session refuses the GoApply worker’s secret', async () => {
    const { id } = await liveSession('roboapply');
    await expect(svc.ingestMetrics({ sessionId: id, secret: 'intl-cb', events: [] })).resolves.toBeTruthy();
    await expect(svc.ingestMetrics({ sessionId: id, secret: 'cn-cb', events: [] })).rejects.toMatchObject({ name: 'InterviewAuthError' });
    await expect(svc.workerLifecycle({ sessionId: id, secret: 'cn-cb', event: 'ended' })).rejects.toMatchObject({ name: 'InterviewAuthError' });
  });

  it('names only domestic STT/TTS in the GoApply worker metadata (never deepgram/cartesia/elevenlabs)', async () => {
    const { conn } = await liveSession('goapply', 'voice');
    const raw = (call('createRoom').args[0] as { metadata: string }).metadata;
    expect(raw).not.toMatch(/deepgram\/|cartesia\/|elevenlabs\//);
    const meta = JSON.parse(raw);
    expect(meta.stt).toMatchObject({ provider: 'dashscope', model: 'dashscope/paraformer-realtime-v2', language: 'en', fallbackModels: [] });
    expect(meta.voice).toMatchObject({ provider: 'dashscope', model: 'dashscope/cosyvoice-v2' });
    expect(conn.voice.model).toBe('dashscope/cosyvoice-v2');
    expect(JSON.stringify(h.rows.get(conn.sessionId)!.voice)).not.toMatch(/cartesia|elevenlabs/);
  });

  it('a foreign model inside GoApply’s own speech pair is refused (503, nothing persisted); half a pair is the shared set', async () => {
    await withEnv({ CN_INTERVIEW_ENGINE_TTS_MODEL: 'cartesia/sonic-3' }, async () => {
      await expect(runWithBrand('goapply', () => svc.createSession({ userId: 'u1', role: 'x' })))
        .rejects.toThrow(/not a domestic provider/);
      expect(h.rows.size).toBe(0);
    });
    // One model of the pair is not a set: the session is created on the shared speech set (G53).
    await withEnv({ CN_INTERVIEW_ENGINE_TTS_MODEL: undefined }, async () => {
      const s = await runWithBrand('goapply', () => svc.createSession({ userId: 'u1', role: 'x', language: 'zh' }));
      expect(s.voice.model).not.toMatch(/^dashscope\//);
      expect(s.voice.languageCode).toMatch(/^(zh|cmn)/);
    });
  });

  it('refuses to connect a GoApply session whose stored speech config turned international', async () => {
    const created = await runWithBrand('goapply', () => svc.createSession({ userId: 'u1', role: 'Engineer', mode: 'voice' }));
    await runWithBrand('goapply', () => svc.prepareSession({ sessionId: created.id, userId: 'u1' }));
    const saved = process.env.CN_INTERVIEW_ENGINE_STT_FALLBACK_MODELS;
    try {
      process.env.CN_INTERVIEW_ENGINE_STT_FALLBACK_MODELS = 'deepgram/nova-2';
      await expect(runWithBrand('goapply', () => svc.getConnection({ sessionId: created.id, userId: 'u1' })))
        .rejects.toMatchObject({ code: 'interview_engine_not_configured' });
      expect(h.calls.some((c) => c.fn === 'createRoom' || c.fn === 'dispatch')).toBe(false);
      expect(h.rows.get(created.id)!.status).toBe('created');
    } finally {
      if (saved === undefined) delete process.env.CN_INTERVIEW_ENGINE_STT_FALLBACK_MODELS;
      else process.env.CN_INTERVIEW_ENGINE_STT_FALLBACK_MODELS = saved;
    }
  });

  it('runs a GoApply session on the Parley transport when the caller chose it, like RoboApply (G57)', async () => {
    const s = await runWithBrand('goapply', () =>
      svc.createSession({ userId: 'u1', role: 'Engineer', mode: 'voice', transport: 'parley' }),
    );
    expect(s.liveMetrics.control?.transport).toBe('parley');
    const intl = await runWithBrand('roboapply', () =>
      svc.createSession({ userId: 'u1', role: 'Engineer', mode: 'voice', transport: 'parley' }),
    );
    expect(intl.liveMetrics.control?.transport).toBe('parley');
    // Not chosen: LiveKit, on both brands.
    const plain = await runWithBrand('goapply', () => svc.createSession({ userId: 'u1', role: 'Engineer', mode: 'voice' }));
    expect(plain.liveMetrics.control?.transport).toBeUndefined();
  });
});

describe('GoApply session on the shared media plane (no CN_ override at all)', () => {
  it('creates (not 503) with the shared plane stored, a zh voice from the shared catalog and the shared STT (G7, G53, G54)', async () => {
    await sharedOnly(async () => {
      const s = await runWithBrand('goapply', () =>
        svc.createSession({ userId: 'cn-u1', role: '工程师', mode: 'voice', language: 'zh' }),
      );
      expect(s).toMatchObject({ brand: 'goapply', voiceProvider: 'livekit_cloud', status: 'preparing' });
      expect(s.liveMetrics.voiceSeam).toEqual({ v: 1, brand: 'goapply', provider: 'livekit_cloud', stack: 'shared' });
      expect(s.voice.model).toBe('cartesia/sonic-3');
      expect(s.voice.languageCode).toMatch(/^(zh|cmn)/);
      // Exactly the voice a RoboApply zh session gets.
      const intl = await runWithBrand('roboapply', () => svc.createSession({ userId: 'u1', role: 'Engineer', mode: 'voice', language: 'zh' }));
      expect(s.voice).toEqual(intl.voice);
    });
  });

  it('dispatches the worker registered on the shared project, with the shared credentials, models and bucket (G51, G55)', async () => {
    await sharedOnly(async () => {
      const { conn } = await liveSession('goapply', 'video', 'zh');
      for (const fn of ['createRoom', 'dispatch', 'mint']) {
        expect(call(fn).brand).toBe('goapply');
        expect(call(fn).args.at(-1)).toBe('intl-key');
      }
      // Never 'GoApply-Interview' there: nobody registers it on the shared project.
      expect(call('dispatch').args[0]).toMatchObject({ agentName: 'RoboApply-Interview' });
      expect(call('mint').args[0]).toMatchObject({ allowVideo: true });
      expect(conn.cameraPublish).toBe(true);
      expect(call('record').args).toEqual([expect.objectContaining({ audioOnly: false }), 'intl-bucket']);
      const meta = JSON.parse((call('createRoom').args[0] as { metadata: string }).metadata);
      expect(meta.llm.model).toBe('openai/gpt-5.4');
      expect(meta.stt).toMatchObject({ provider: 'deepgram', model: 'deepgram/nova-3', language: 'zh' });
      expect(meta.voice.model).toBe('cartesia/sonic-3');
      expect(JSON.stringify(meta)).not.toMatch(/dashscope/);
    });
  });

  it('the clone dev stack: both brands dispatch the name its worker registers', async () => {
    await sharedOnly(() =>
      withEnv({ INTERVIEW_ENGINE_AGENT_NAME: 'RoboApply-Interview-Clone' }, async () => {
        await liveSession('goapply', 'voice');
        expect(call('dispatch').args[0]).toMatchObject({ agentName: 'RoboApply-Interview-Clone' });
        h.calls.length = 0;
        await liveSession('roboapply', 'voice');
        expect(call('dispatch').args[0]).toMatchObject({ agentName: 'RoboApply-Interview-Clone' });
      }),
    );
  });

  it('accepts the shared worker’s callbacks and the shared project’s webhooks for a GoApply session (G52, G58)', async () => {
    await sharedOnly(async () => {
      const { id } = await liveSession('goapply', 'voice');
      const roomName = h.rows.get(id)!.roomName as string;
      // room_finished finalizes (scoring, uploads): watched here, not run.
      const finalize = vi.spyOn(svc, 'finalize').mockResolvedValue(undefined as never);
      // Transcript, metrics and lifecycle callbacks carry the shared worker's secret.
      await expect(svc.ingestMetrics({ sessionId: id, secret: 'intl-cb', events: [] })).resolves.toBeTruthy();
      await expect(svc.ingestTranscript({ sessionId: id, secret: 'intl-cb', turns: [] })).resolves.toMatchObject({ ok: true });
      await expect(svc.ingestUsage({ sessionId: id, secret: 'intl-cb', modelUsage: [] })).resolves.toEqual({ ok: true });
      for (const secret of ['cn-cb', 'nope', undefined]) {
        await expect(svc.ingestMetrics({ sessionId: id, secret, events: [] })).rejects.toMatchObject({ name: 'InterviewAuthError' });
      }
      // A webhook signed with another key is rejected...
      await svc.handleEgressEnded({ egressId: 'EG_1', sizeBytes: 10, durationSec: 5, signer: { apiKey: 'other-key', brands: [] } });
      expect(h.rows.get(id)!.recordingBytes ?? null).toBeNull();
      await svc.handleRoomFinished(roomName, { apiKey: 'other-key', brands: ['goapply'] });
      expect(finalize).not.toHaveBeenCalled();
      // ...the shared project's egress_ended and room_finished are processed.
      await svc.handleEgressEnded({ egressId: 'EG_1', sizeBytes: 10, durationSec: 5, signer: SHARED_BY_BOTH });
      expect(h.rows.get(id)!.recordingBytes).toBe(10);
      await svc.handleRoomFinished(roomName, SHARED_BY_BOTH);
      expect(finalize).toHaveBeenCalledWith(id);
      finalize.mockRestore();
    });
  });

  it('a RoboApply session on the same project is served by the same key and secret', async () => {
    await sharedOnly(async () => {
      const { id } = await liveSession('roboapply', 'voice');
      await expect(svc.ingestMetrics({ sessionId: id, secret: 'intl-cb', events: [] })).resolves.toBeTruthy();
      await svc.handleEgressEnded({ egressId: 'EG_1', sizeBytes: 10, durationSec: 5, signer: SHARED_BY_BOTH });
      expect(h.rows.get(id)!.recordingBytes).toBe(10);
    });
  });

  it('with no LiveKit at all a GoApply connect is a config error naming the shared variables', async () => {
    await sharedOnly(() =>
      withEnv({ LIVEKIT_URL: undefined, LIVEKIT_API_KEY: undefined, LIVEKIT_API_SECRET: undefined }, async () => {
        const created = await runWithBrand('goapply', () => svc.createSession({ userId: 'u1', role: 'Engineer', mode: 'voice' }));
        await runWithBrand('goapply', () => svc.prepareSession({ sessionId: created.id, userId: 'u1' }));
        await expect(runWithBrand('goapply', () => svc.getConnection({ sessionId: created.id, userId: 'u1' })))
          .rejects.toMatchObject({ code: 'interview_engine_not_configured' });
        expect(h.calls.some((c) => c.fn === 'createRoom')).toBe(false);
      }),
    );
  });
});

describe('a session stays on the plane it was created on', () => {
  it('created on the shared plane: CN_LIVEKIT_* added while it is live does not move it', async () => {
    const live = await sharedOnly(() => liveSession('goapply', 'voice'));
    // The file's env is back: GoApply now has its own plane, worker, secret and speech.
    const id = live.id;
    const roomName = h.rows.get(id)!.roomName as string;
    expect(h.rows.get(id)!.liveMetrics.voiceSeam.stack).toBe('shared');
    h.calls.length = 0;
    // A reconnect re-mints on the shared project.
    await runWithBrand('goapply', () => svc.getConnection({ sessionId: id, userId: 'u1' }));
    expect(call('mint').args.at(-1)).toBe('intl-key');
    // The shared worker's secret is still the one accepted; GoApply's new one is not.
    await expect(svc.ingestMetrics({ sessionId: id, secret: 'intl-cb', events: [] })).resolves.toBeTruthy();
    await expect(svc.ingestMetrics({ sessionId: id, secret: 'cn-cb', events: [] })).rejects.toMatchObject({ name: 'InterviewAuthError' });
    // Webhooks: the shared project's key is accepted although GoApply's NEW sessions use another key.
    await svc.handleEgressEnded({ egressId: 'EG_1', sizeBytes: 10, durationSec: 5, signer: CN_PROJECT });
    expect(h.rows.get(id)!.recordingBytes ?? null).toBeNull();
    await svc.handleEgressEnded({ egressId: 'EG_1', sizeBytes: 10, durationSec: 5, signer: SHARED_PROJECT });
    expect(h.rows.get(id)!.recordingBytes).toBe(10);
    // room_finished from the shared project is processed, GoApply's new project's is not.
    const finalize = vi.spyOn(svc, 'finalize').mockResolvedValue(undefined as never);
    await svc.handleRoomFinished(roomName, CN_PROJECT);
    expect(finalize).not.toHaveBeenCalled();
    await svc.handleRoomFinished(roomName, SHARED_PROJECT);
    expect(finalize).toHaveBeenCalledWith(id);
    finalize.mockRestore();
    // Teardown reaches the room on the shared project.
    h.calls.length = 0;
    await runWithBrand('goapply', () => svc.deleteByOwner({ sessionId: id, userId: 'u1' })).catch(() => undefined);
    expect(call('deleteRoom').args.at(-1)).toBe('intl-key');
    // A session created now is on GoApply's own plane.
    h.calls.length = 0;
    const fresh = await liveSession('goapply', 'voice');
    expect(h.rows.get(fresh.id)!.liveMetrics.voiceSeam.stack).toBe('own');
    expect(call('dispatch').args[0]).toMatchObject({ agentName: 'GoApply-Interview' });
    expect(call('dispatch').args.at(-1)).toBe('cn-key');
  });

  it('prepared on the shared plane, connected after CN_LIVEKIT_* arrived: the shared worker, a gateway model and one speech set', async () => {
    const created = await sharedOnly(async () => {
      const s = await runWithBrand('goapply', () => svc.createSession({ userId: 'u1', role: 'Engineer', mode: 'voice', language: 'zh' }));
      await runWithBrand('goapply', () => svc.prepareSession({ sessionId: s.id, userId: 'u1' }));
      return s;
    });
    await runWithBrand('goapply', () => svc.getConnection({ sessionId: created.id, userId: 'u1' }));
    expect(call('dispatch').args[0]).toMatchObject({ agentName: 'RoboApply-Interview' });
    expect(call('dispatch').args.at(-1)).toBe('intl-key');
    const meta = JSON.parse((call('createRoom').args[0] as { metadata: string }).metadata);
    // The shared (gateway) worker never gets a raw domestic id.
    expect(meta.llm.model).toBe('deepseek-ai/deepseek-v4-pro');
    // Voice and STT come from one set (here: the pair that is configured now).
    expect([meta.voice.model, meta.stt.model].every((m: string) => m.startsWith('dashscope/'))).toBe(true);
  });

  it('created on its own plane: with CN_LIVEKIT_* gone it is not configured, never moved to the shared keys', async () => {
    const created = await runWithBrand('goapply', () => svc.createSession({ userId: 'u1', role: 'Engineer', mode: 'voice' }));
    await runWithBrand('goapply', () => svc.prepareSession({ sessionId: created.id, userId: 'u1' }));
    await withEnv({ CN_LIVEKIT_URL: undefined, CN_LIVEKIT_API_KEY: undefined, CN_LIVEKIT_API_SECRET: undefined }, async () => {
      await expect(runWithBrand('goapply', () => svc.getConnection({ sessionId: created.id, userId: 'u1' })))
        .rejects.toMatchObject({ code: 'interview_engine_not_configured' });
      expect(h.calls.some((c) => c.fn === 'createRoom' || c.fn === 'dispatch')).toBe(false);
      // The shared worker's secret cannot touch it either.
      await expect(svc.ingestMetrics({ sessionId: created.id, secret: 'intl-cb', events: [] })).rejects.toMatchObject({ name: 'InterviewAuthError' });
    });
  });
});

describe('RoboApply regression (Wave 0 behaviour)', () => {
  it('stores no seam, dispatches RoboApply-Interview on LIVEKIT_*, keeps the camera and video recording', async () => {
    const created = await runWithBrand('roboapply', () =>
      svc.createSession({ userId: 'u1', role: 'Engineer', mode: 'video', recording: { audio: true, video: true } }),
    );
    expect(created.liveMetrics.voiceSeam).toBeUndefined();
    const { conn } = await liveSession('roboapply', 'video');
    expect(call('dispatch').args[0]).toMatchObject({ agentName: 'RoboApply-Interview' });
    expect(call('dispatch').args.at(-1)).toBe('intl-key');
    expect(call('mint').args[0]).toMatchObject({ allowVideo: true });
    expect(conn.cameraPublish).toBe(true);
    expect(call('record').args).toEqual([expect.objectContaining({ audioOnly: false }), 'intl-bucket']);
  });

  it('voice mode reports no camera to publish', async () => {
    const { conn } = await liveSession('roboapply', 'voice');
    expect(conn.cameraPublish).toBe(false);
    expect(call('mint').args[0]).toMatchObject({ allowVideo: false });
  });
});

describe('reserved provider', () => {
  it('refuses to create a session on volcano (503 config error, nothing persisted)', async () => {
    process.env.CN_VOICE_PROVIDER = 'volcano';
    try {
      await expect(runWithBrand('goapply', () => svc.createSession({ userId: 'u1', role: 'x' })))
        .rejects.toMatchObject({ code: 'interview_engine_not_configured' });
      expect(h.rows.size).toBe(0);
    } finally {
      delete process.env.CN_VOICE_PROVIDER;
    }
  });
});

// ─── INT-09: the brand and provider columns (SCHEMA-4, WP-63a-S1) ──────────

/** A row as it was written before the column writer (and before WP-63a): no column, no JSON seam. */
function makeLegacy(id: string) {
  const row = h.rows.get(id)!;
  row.brand = null;
  row.voiceProvider = null;
  if (row.liveMetrics && typeof row.liveMetrics === 'object') delete row.liveMetrics.voiceSeam;
}

describe('brand and voiceProvider columns', () => {
  it('a new row has both columns on either brand', async () => {
    const intl = await runWithBrand('roboapply', () => svc.createSession({ userId: 'u1', role: 'Engineer' }));
    expect(intl).toMatchObject({ brand: 'roboapply', voiceProvider: 'livekit_cloud' });
    const cn = await runWithBrand('goapply', () => svc.createSession({ userId: 'cn-u1', role: '工程师' }));
    expect(cn).toMatchObject({ brand: 'goapply', voiceProvider: 'livekit_cloud' });
    // The JSON seam stays for non-default seams during the transition.
    expect(cn.liveMetrics.voiceSeam).toEqual({ v: 1, brand: 'goapply', provider: 'livekit_cloud', stack: 'own' });
    // No owner lookup was needed to create or to read these rows back.
    await runWithBrand('roboapply', () => svc.prepareSession({ sessionId: cn.id, userId: 'cn-u1' }));
    expect(owners).not.toHaveBeenCalled();
  });

  it('stores the provider the brand was configured with at create', async () => {
    process.env.CN_VOICE_PROVIDER = 'livekit_selfhosted';
    try {
      const cn = await runWithBrand('goapply', () => svc.createSession({ userId: 'cn-u1', role: '工程师' }));
      expect(cn).toMatchObject({ brand: 'goapply', voiceProvider: 'livekit_selfhosted' });
    } finally {
      delete process.env.CN_VOICE_PROVIDER;
    }
  });

  it('the column wins over a JSON seam that disagrees', async () => {
    const { id } = await liveSession('goapply', 'voice');
    h.rows.get(id)!.liveMetrics.voiceSeam = { v: 1, brand: 'roboapply', provider: 'livekit_cloud', stack: 'shared' };
    // The JSON seam of ANOTHER brand supplies nothing, its plane included.
    await expect(svc.ingestMetrics({ sessionId: id, secret: 'cn-cb', events: [] })).resolves.toBeTruthy();
    await expect(svc.ingestMetrics({ sessionId: id, secret: 'intl-cb', events: [] })).rejects.toMatchObject({ name: 'InterviewAuthError' });
  });

  it('a row with a JSON seam and no column (written before the column writer) still reads its seam, with no owner lookup', async () => {
    const created = await runWithBrand('goapply', () => svc.createSession({ userId: 'u1', role: 'Engineer', mode: 'voice' }));
    Object.assign(h.rows.get(created.id)!, { brand: null, voiceProvider: null });
    await runWithBrand('roboapply', () => svc.prepareSession({ sessionId: created.id, userId: 'u1' }));
    await runWithBrand('roboapply', () => svc.getConnection({ sessionId: created.id, userId: 'u1' }));
    expect(call('createRoom')).toMatchObject({ brand: 'goapply' });
    expect(owners).not.toHaveBeenCalled();
  });
});

describe('a legacy row with no column and no JSON seam resolves the owner’s brand', () => {
  async function legacyGoApply(mode: 'voice' | 'video' = 'voice') {
    const created = await runWithBrand('goapply', () =>
      svc.createSession({ userId: 'cn-u1', role: '工程师', mode, recording: { audio: true, video: true } }),
    );
    makeLegacy(created.id);
    return created.id;
  }

  it('GoApply owner: prepare, LiveKit, the worker and the recording all run on the GoApply plane, from any host', async () => {
    const id = await legacyGoApply('video');
    // Requests arrive on the RoboApply host (or with no brand context at all).
    await runWithBrand('roboapply', () => svc.prepareSession({ sessionId: id, userId: 'cn-u1' }));
    const conn = await runWithBrand('roboapply', () => svc.getConnection({ sessionId: id, userId: 'cn-u1' }));
    await vi.waitFor(() => expect(h.calls.some((c) => c.fn === 'record')).toBe(true));
    for (const fn of ['createRoom', 'dispatch', 'mint']) {
      expect(call(fn).brand).toBe('goapply');
      expect(call(fn).args.at(-1)).toBe('cn-key');
    }
    expect(call('dispatch').args[0]).toMatchObject({ agentName: 'GoApply-Interview' });
    expect(conn.cameraPublish).toBe(true);
    // Storage: GoApply has its own bucket here, so the recording goes there.
    expect(call('record').args).toEqual([expect.objectContaining({ audioOnly: false }), 'cn-bucket']);
    // The LLM chain is GoApply's.
    const meta = JSON.parse((call('createRoom').args[0] as { metadata: string }).metadata);
    expect(meta.llm.model).toBe('deepseek/deepseek-v4-pro');
    expect(owners).toHaveBeenCalledWith('cn-u1');
  });

  it('GoApply owner: report links are signed against CN_S3', async () => {
    const id = await legacyGoApply();
    Object.assign(h.rows.get(id)!, { status: 'completed', recordingKey: `interviews/${id}/recording.mp4`, recordingMimeType: 'audio/mp4', endedAt: new Date() });
    const report = await runWithBrand('roboapply', () => svc.getReport({ sessionId: id, userId: 'cn-u1' }));
    expect(report.recordingUrl).toContain('cn-bucket.example');
    expect(call('head').args.at(-1)).toBe('cn-bucket');
    expect(h.calls.some((c) => c.fn === 'presign' && c.args.at(-1) === 'intl-bucket')).toBe(false);
  });

  it('GoApply owner: webhooks from another LiveKit project are ignored, the project it runs on is accepted', async () => {
    const id = await legacyGoApply();
    await runWithBrand('goapply', () => svc.prepareSession({ sessionId: id, userId: 'cn-u1' }));
    await runWithBrand('goapply', () => svc.getConnection({ sessionId: id, userId: 'cn-u1' }));
    await vi.waitFor(() => expect(h.calls.some((c) => c.fn === 'record')).toBe(true));
    makeLegacy(id);
    const roomName = h.rows.get(id)!.roomName as string;
    await svc.handleEgressEnded({ egressId: 'EG_1', sizeBytes: 10, durationSec: 5, signer: SHARED_PROJECT });
    expect(h.rows.get(id)!.recordingBytes ?? null).toBeNull();
    await svc.handleRoomFinished(roomName, SHARED_PROJECT);
    expect(h.rows.get(id)!.status).toBe('live');
    await svc.handleEgressEnded({ egressId: 'EG_1', sizeBytes: 10, durationSec: 5, signer: CN_PROJECT });
    expect(h.rows.get(id)!.recordingBytes).toBe(10);
    expect(h.rows.get(id)!.recordingMimeType).toBe('audio/mp4');
  });

  it('GoApply owner: only the GoApply worker’s callback secret is accepted', async () => {
    const id = await legacyGoApply();
    await expect(svc.ingestMetrics({ sessionId: id, secret: 'cn-cb', events: [] })).resolves.toBeTruthy();
    await expect(svc.ingestMetrics({ sessionId: id, secret: 'intl-cb', events: [] })).rejects.toMatchObject({ name: 'InterviewAuthError' });
    await expect(svc.workerLifecycle({ sessionId: id, secret: 'intl-cb', event: 'ended' })).rejects.toMatchObject({ name: 'InterviewAuthError' });
  });

  it('GoApply owner: delete tears the room down on the GoApply plane', async () => {
    const id = await legacyGoApply();
    await runWithBrand('goapply', () => svc.prepareSession({ sessionId: id, userId: 'cn-u1' }));
    await runWithBrand('goapply', () => svc.getConnection({ sessionId: id, userId: 'cn-u1' }));
    makeLegacy(id);
    h.calls.length = 0;
    await runWithBrand('roboapply', () => svc.deleteByOwner({ sessionId: id, userId: 'cn-u1' })).catch(() => undefined);
    expect(call('deleteRoom')).toMatchObject({ brand: 'goapply' });
    expect(call('deleteRoom').args.at(-1)).toBe('cn-key');
  });

  it('RoboApply owner: a Wave 0 row keeps running on the RoboApply plane, even from the GoApply host', async () => {
    const created = await runWithBrand('roboapply', () => svc.createSession({ userId: 'u1', role: 'Engineer', mode: 'voice' }));
    makeLegacy(created.id);
    await runWithBrand('goapply', () => svc.prepareSession({ sessionId: created.id, userId: 'u1' }));
    await runWithBrand('goapply', () => svc.getConnection({ sessionId: created.id, userId: 'u1' }));
    expect(call('createRoom')).toMatchObject({ brand: 'roboapply' });
    expect(call('dispatch').args[0]).toMatchObject({ agentName: 'RoboApply-Interview' });
    await expect(svc.ingestMetrics({ sessionId: created.id, secret: 'intl-cb', events: [] })).resolves.toBeTruthy();
    await expect(svc.ingestMetrics({ sessionId: created.id, secret: 'cn-cb', events: [] })).rejects.toMatchObject({ name: 'InterviewAuthError' });
  });

  it('a failed owner lookup is an error, never a silent RoboApply', async () => {
    const id = await legacyGoApply();
    owners.mockRejectedValueOnce(new Error('db down'));
    await expect(runWithBrand('roboapply', () => svc.getConnection({ sessionId: id, userId: 'cn-u1' }))).rejects.toThrow('db down');
    expect(h.calls.some((c) => c.fn === 'createRoom')).toBe(false);
  });
});
