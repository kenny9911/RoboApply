// @vitest-environment node
//
// INT-10 (wave3 WP-93 #3): the legacy `POST /v2/resumes { kind:
// 'tailored_for_jd' }` runs on tailor sessions. It used to skip the `tailor`
// credit, the claim check and `unverifiedClaims`; now it:
//   - debits exactly one `tailor` credit (kept only when the version is saved);
//   - runs the claim check and stores `unverifiedClaims` on the new version;
//   - keeps the GoApply phone gate and the AI-consent gate, with zero model
//     calls when either says no;
//   - answers 402 without a credit, and never reaches a job the user may not
//     read (another market's job; the GoApply mode-off rule is the tailor
//     store's and is tested with it).
// End to end through the real route, RAResumeService, the resume area's real
// wiring (`defaultTailorDeps`) and the real TailorService. Faked: the tailor
// store (the in-memory twin), credits (the platform test kit), the tailor
// agent, consent/flags and the neighbouring areas' seams. No network beyond
// 127.0.0.1, no database.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const m = vi.hoisted(() => ({
  store: null as any,
  kit: null as any,
  userId: 'u1',
  brand: 'roboapply' as 'roboapply' | 'goapply',
  aiAllowed: true,
  aiText: true,
  phoneBound: true,
  agentRun: vi.fn(),
  chat: vi.fn(),
  score: vi.fn(),
  labelLog: vi.fn(),
}));

/** RAResumeService reads the tailored version through Prisma: serve it from the tailor store's rows. */
vi.mock('../../../lib/prisma.js', () => {
  const view = (v: Row | undefined) =>
    v && !v.deleted
      ? { ...v, resumeMarkdown: v.resumeMarkdown, deletedAt: null, isPrimary: false, lastEditedAt: new Date('2026-10-10T00:00:00Z'), createdAt: new Date('2026-10-10T00:00:00Z') }
      : null;
  return {
    default: {
      rAResumeVariant: {
        findUnique: async ({ where }: Row) => view(m.store.variants.get(where.id)),
        updateMany: async ({ where, data }: Row) => {
          const v = m.store.variants.get(where.id);
          if (!v || v.userId !== where.userId || v.deleted) return { count: 0 };
          Object.assign(v, data);
          return { count: 1 };
        },
      },
    },
  };
});
vi.mock('../lib/raAuth.js', () => ({
  requireAuth: (req: Row, _res: unknown, next: () => void) => {
    req.user = { id: m.userId, subscriptionTier: 'free' };
    next();
  },
}));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../services/llm/LLMService.js', () => ({ llmService: { chat: m.chat, getModel: () => 'test-model' }, LLMService: class {} }));
vi.mock('../agents/RAResumeTailorAgent.js', () => ({
  RAResumeTailorAgent: class {
    run = m.agentRun;
  },
}));
vi.mock('../../../features/resume/tailor/store.js', () => ({ createPrismaTailorStore: () => m.store }));
vi.mock('../../../platform/credits/index.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    get creditService() {
      return m.kit.credits;
    },
  };
});
vi.mock('../../../platform/consent/aiAllowed.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), aiAllowed: async () => m.aiAllowed }));
vi.mock('../../../platform/flags.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isEnabled: async (key: string) => (key === 'ai.text' ? m.aiText : false),
}));
vi.mock('../../../features/auth-cn/index.js', async (orig) => {
  const actual = await orig<{ AuthCnError: new (code: string) => Error }>();
  return {
    ...actual,
    assertPhoneBound: async () => {
      if (!m.phoneBound) throw new actual.AuthCnError('phone_binding_required');
    },
    requirePhoneBound: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});
vi.mock('../../../features/profile/index.js', () => ({ profileSnapshotForLlm: async () => ({ text: '' }) }));
vi.mock('../../../features/match/index.js', () => ({ matchService: { scoreJob: (...args: unknown[]) => m.score(...args) } }));
vi.mock('../../../features/growth/index.js', () => ({ markChecklistStep: vi.fn(async () => undefined) }));
vi.mock('../../../features/compliance/index.js', () => ({
  registerArtifactStorageDeleter: vi.fn(),
  complianceService: { logAiContentLabel: (...args: unknown[]) => m.labelLog(...args) },
}));
vi.mock('../../services/SeekerAccountPurgeService.js', () => ({ setArtifactStorageDeleter: vi.fn() }));
vi.mock('../../../lib/candidateResumeIngest.js', () => ({
  isAcceptedResumeUpload: () => true,
  readCandidateResumeOriginal: vi.fn(),
  ingestCandidateResume: vi.fn(),
  CandidateResumeIngestError: class extends Error {},
}));

import { runWithBrand } from '../../../lib/requestContext.js';
import { createCreditTestKit } from '../../../platform/credits/testkit.js';
import { CreditsExhaustedError } from '../../../platform/credits/index.js';
import { createMemoryTailorStore, memoryTailorJob, memoryTailorVariant } from '../../../features/resume/tailor/memoryStore.js';

const BASE_MD = '# Sam\n*sam@example.test*\n## Experience\n- Built weekly sales reports in SQL.\n## Skills\nSQL\n';
/** Adds a number and a skill the base resume does not show: both must become claims to verify. */
const TAILORED = '## Experience\n- Built weekly sales reports in SQL.\n- Cut report time by 40%.\n## Skills\nSQL, Tableau\n';

let server: Server;
let base: string;

beforeAll(async () => {
  m.store = createMemoryTailorStore();
  m.kit = createCreditTestKit();
  const express = (await import('express')).default;
  const router = ((await import('./resumes.js')) as { default: import('express').Router }).default;
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runWithBrand(m.brand, next));
  app.use('/resumes', router);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/resumes`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  m.store.variants.clear();
  m.store.jobs.clear();
  m.store.sessions.clear();
  m.store.keywordTerms.clear();
  m.kit.store.ledger.length = 0;
  m.kit.store.windows.length = 0;
  m.userId = 'u1';
  m.brand = 'roboapply';
  m.aiAllowed = true;
  m.aiText = true;
  m.phoneBound = true;
  m.agentRun.mockReset().mockResolvedValue({ tailoredResumeMarkdown: TAILORED, changeSummary: '', citationsByLine: {}, citationGuardPassed: true, citationGuardViolations: [] });
  m.chat.mockReset();
  m.score.mockReset().mockResolvedValue(null);
  m.labelLog.mockReset().mockResolvedValue(undefined);
  // A reset only. Unset = GoApply postings are shown (the default, D5); no test here
  // depends on the mode (the in-memory tailor store does not model it), so none sets `off`.
  delete process.env.CN_RECRUITMENT_INFO_MODE;
  m.store.variants.set('rv_1', memoryTailorVariant('u1', 'rv_1', BASE_MD, 'Main'));
  m.store.jobs.set('job_1', memoryTailorJob('job_1', { descriptionPlain: 'Analyst role. Tableau dashboards for the sales team.', skills: ['Tableau'] }));
});

const post = async (body: Row, headers: Record<string, string> = {}) => {
  const res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : null };
};
const BODY = { kind: 'tailored_for_jd', name: 'For Acme', basedOnVariantId: 'rv_1', targetJobId: 'job_1' };
const committed = () => (m.kit.store.ledger as Row[]).filter((r) => r.bucket === 'tailor' && r.status === 'committed');
const tailorRows = () => (m.kit.store.ledger as Row[]).filter((r) => r.bucket === 'tailor');

describe('POST /v2/resumes kind=tailored_for_jd (legacy) → a tailor session', () => {
  it('debits one tailor credit, runs the claim check and stores unverifiedClaims on the new version', async () => {
    const res = await post(BODY, { 'Idempotency-Key': 'k1' });
    expect(res.status).toBe(201);

    // One credit, committed against the session.
    expect(committed()).toHaveLength(1);
    expect(committed()[0]).toMatchObject({ userId: 'u1', amount: 1, refType: 'tailor_session', refId: res.body!.tailorSessionId, idempotencyKey: expect.stringContaining('k1') });
    expect(m.agentRun).toHaveBeenCalledTimes(1);

    // The claim check ran: the invented number and the unshown skill are pending.
    const session = m.store.sessions.get(res.body!.tailorSessionId)!;
    expect(session.status).toBe('review');
    const claims = session.claims as Array<{ status: string; reasons?: string[] }>;
    const pending = claims.filter((c) => c.status === 'pending');
    expect(pending.length).toBeGreaterThanOrEqual(2);
    expect(pending.flatMap((c) => c.reasons ?? [])).toEqual(expect.arrayContaining(['new_number', 'new_keyword']));

    // …and the count is stored on the version, which is what blocks export (ruling C12).
    const made = m.store.variants.get(res.body!.resume.id)!;
    expect(made.unverifiedClaims).toBe(pending.length);
    expect(res.body).toMatchObject({
      pendingClaims: pending.length,
      resume: { kind: 'tailored_for_jd', sourceKind: 'tailored', basedOnVariantId: 'rv_1', targetJobId: 'job_1', unverifiedClaims: pending.length, aiAssisted: true, name: 'For Acme' },
    });
    // The contact header never went to the model and was put back after.
    expect((m.agentRun.mock.calls[0]![0] as { baseResumeMarkdown: string }).baseResumeMarkdown).not.toContain('sam@example.test');
    expect(made.resumeMarkdown.startsWith('# Sam\n*sam@example.test*')).toBe(true);
  });

  it('a replay with the same Idempotency-Key returns the same version: no second credit, no second model run', async () => {
    const first = await post(BODY, { 'Idempotency-Key': 'k-replay' });
    const again = await post(BODY, { 'Idempotency-Key': 'k-replay' });
    expect(again.status).toBe(201);
    expect(again.body!.tailorSessionId).toBe(first.body!.tailorSessionId);
    expect(again.body!.resume.id).toBe(first.body!.resume.id);
    expect(committed()).toHaveLength(1);
    expect(m.agentRun).toHaveBeenCalledTimes(1);
  });

  it('two separate requests are two tailors: two credits', async () => {
    await post(BODY);
    await post(BODY);
    expect(committed()).toHaveLength(2);
    expect(m.agentRun).toHaveBeenCalledTimes(2);
  });

  it('a tailor that fails costs nothing', async () => {
    m.agentRun.mockRejectedValueOnce(new Error('model down'));
    const res = await post(BODY);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'ai_unavailable', error: 'ai_unavailable', details: { reason: 'ai_failed' } });
    expect(committed()).toHaveLength(0);
    expect(tailorRows().every((r) => r.status === 'released')).toBe(true);
    expect([...m.store.variants.keys()]).toEqual(['rv_1']);
  });

  it('402 credits_exhausted with no credit left: zero model calls, nothing written', async () => {
    const spy = vi
      .spyOn(m.kit.credits, 'reserve')
      .mockRejectedValueOnce(new CreditsExhaustedError({ bucket: 'tailor', resetsAt: new Date('2026-10-11T00:00:00Z'), upgradable: true, cap: 3, window: 'day' }));
    const res = await post(BODY);
    spy.mockRestore();
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: 'credits_exhausted', details: { bucket: 'tailor', upgradable: true } });
    expect(m.agentRun).not.toHaveBeenCalled();
    expect([...m.store.variants.keys()]).toEqual(['rv_1']);
  });

  it('404 for a resume that is not the user\'s, and for an unknown job: no credit, no model call', async () => {
    m.store.variants.set('rv_theirs', memoryTailorVariant('someone-else', 'rv_theirs', BASE_MD));
    expect((await post({ ...BODY, basedOnVariantId: 'rv_theirs' })).status).toBe(404);
    expect((await post({ ...BODY, targetJobId: 'nope' })).status).toBe(404);
    expect(tailorRows()).toHaveLength(0);
    expect(m.agentRun).not.toHaveBeenCalled();
  });
});

describe('gates on the legacy path', () => {
  it.each(['roboapply', 'goapply'] as const)('%s: AI consent off → 503 ai_unavailable, zero LLM calls, no credit reserved', async (brand) => {
    m.brand = brand;
    if (brand === 'goapply') m.store.jobs.set('job_1', memoryTailorJob('job_1', { market: 'cn', visibility: 'private', ownerUserId: 'u1' }));
    m.aiAllowed = false;
    const res = await post(BODY);
    expect(res.status).toBe(503);
    expect(res.body!.code).toBe('ai_unavailable');
    expect(m.agentRun).not.toHaveBeenCalled();
    expect(m.chat).not.toHaveBeenCalled();
    expect(tailorRows()).toHaveLength(0);
    expect([...m.store.variants.keys()]).toEqual(['rv_1']);
  });

  it('GoApply with no text model configured → 503 ai_unavailable, zero LLM calls', async () => {
    m.brand = 'goapply';
    m.store.jobs.set('job_1', memoryTailorJob('job_1', { market: 'cn', visibility: 'private', ownerUserId: 'u1' }));
    m.aiText = false;
    const res = await post(BODY);
    expect(res.status).toBe(503);
    expect(m.agentRun).not.toHaveBeenCalled();
    expect(m.chat).not.toHaveBeenCalled();
  });

  it('GoApply WeChat account without a phone → 403 phone_binding_required, zero LLM calls, no credit reserved', async () => {
    m.brand = 'goapply';
    m.store.jobs.set('job_1', memoryTailorJob('job_1', { market: 'cn', visibility: 'private', ownerUserId: 'u1' }));
    m.phoneBound = false;
    const res = await post(BODY);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: 'phone_binding_required' });
    expect(m.agentRun).not.toHaveBeenCalled();
    expect(m.chat).not.toHaveBeenCalled();
    expect(tailorRows()).toHaveLength(0);
  });

  it('GoApply with consent and a phone: tailors, and writes the AI label log', async () => {
    m.brand = 'goapply';
    m.store.jobs.set('job_1', memoryTailorJob('job_1', { market: 'cn', visibility: 'private', ownerUserId: 'u1', descriptionPlain: '数据分析岗位。' }));
    const res = await post(BODY);
    expect(res.status).toBe(201);
    expect(committed()).toHaveLength(1);
    expect(m.labelLog).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', kind: 'resume_tailor', contentId: `resume_tailor:${res.body!.tailorSessionId}` }));
  });

  it('a job from the other market is not found (its text never reaches the model)', async () => {
    m.store.jobs.set('job_cn', memoryTailorJob('job_cn', { market: 'cn' }));
    const res = await post({ ...BODY, targetJobId: 'job_cn' });
    expect(res.status).toBe(404);
    expect(m.agentRun).not.toHaveBeenCalled();
  });
});
