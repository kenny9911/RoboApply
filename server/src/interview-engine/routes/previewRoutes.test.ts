// @vitest-environment node
//
// INT-09 (wave4 WP-93 #8, R7): POST /requirements/preview behind the brand's
// AI gate, and the web search behind the no-personal-information check.
//   - GoApply, AI consent off (or no bound phone): the refusal, ZERO
//     LLMService calls and ZERO Tavily requests;
//   - GoApply, consent on: the same preview as RoboApply (D5; G9, G105):
//     grounded on the job post, else on a web search of the role, and a
//     failed search degrades to a role-based preview, never an error;
//   - both brands: the search query never carries the user's name, an email
//     or a phone number.
// The real prompt service and web search run; the model (blueprint agent +
// LLMService) and `fetch` are spies. No network.
// Run: npx vitest run server/src/interview-engine/routes/previewRoutes.test.ts

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  brand: { id: 'roboapply', market: 'intl', name: 'RoboApply' } as Record<string, unknown>,
  user: { id: 'u1', role: 'seeker', roles: ['seeker'], name: 'Jane Doe' } as Record<string, unknown>,
  phoneRequired: vi.fn(),
  aiAllowed: vi.fn(),
  voiceOn: vi.fn(),
  llmCalls: [] as string[],
  agentRun: vi.fn(),
}));

vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { ...m.user, email: 'jane@example.test' };
    next();
  },
}));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../platform/brand/brandContext.js', () => ({ getCurrentBrandOrDefault: () => m.brand }));
vi.mock('../../features/auth-cn/index.js', () => ({ phoneBindingRequired: m.phoneRequired }));
vi.mock('../../platform/consent/index.js', () => ({ aiAllowed: m.aiAllowed, hasLiveConsent: vi.fn(async () => false) }));
vi.mock('../../platform/flags.js', () => ({ isEnabledForBrand: m.voiceOn }));
// Every LLMService method call is recorded: the preview must make none when the gate is closed.
vi.mock('../../services/llm/LLMService.js', () => ({
  llmService: new Proxy({}, {
    get: (_t, prop) => (..._args: unknown[]) => {
      m.llmCalls.push(String(prop));
      return Promise.resolve({ content: '{}' });
    },
  }),
}));
// The blueprint agent is the preview's one model caller: a run is an LLMService call.
vi.mock('../prompt/InterviewBlueprintAgent.js', async () => {
  const { llmService } = await import('../../services/llm/LLMService.js');
  return {
    interviewBlueprintAgent: {
      run: async (...args: unknown[]) => {
        await (llmService as unknown as { chat: (...a: unknown[]) => Promise<unknown> }).chat(...args);
        return m.agentRun(...args);
      },
    },
    inferRoleFromJd: () => 'Inferred Role',
  };
});
vi.mock('../sessions/InterviewSessionService.js', () => {
  class E extends Error {}
  return {
    interviewSessionService: {},
    InterviewValidationError: E, InterviewNotFoundError: E, InterviewAuthError: E,
    InterviewInsufficientCreditsError: E, InterviewNotReadyError: E, InterviewSessionFailedError: E,
    InterviewSessionEndedError: E, InterviewPrepareFailedError: E,
  };
});
vi.mock('../parley/parleySessions.js', () => ({ ParleyUnavailableError: class extends Error {} }));

const BLUEPRINT = {
  requirements: { roleSummary: 'Builds APIs', seniorityBar: 'Mid', mustHaveSkills: ['SQL'], coreResponsibilities: ['Ship'], successSignals: ['Metrics'], domainContext: '' },
  questions: [
    { q: 'Tell me about a hard bug.', hint: 'h', coachTip: { kind: 'good', text: 't' } },
    { q: 'How do you test?', hint: 'h', coachTip: { kind: 'good', text: 't' } },
  ],
};

let server: Server;
let base: string;
const fetchSpy = vi.fn();
const realFetch = globalThis.fetch;
const saved = { key: process.env.TAVILY_API_KEY, region: process.env.DEPLOY_REGION };

beforeAll(async () => {
  process.env.TAVILY_API_KEY = 'tvly-test';
  delete process.env.DEPLOY_REGION;
  const express = (await import('express')).default;
  const preview = (await import('./previewRoutes.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/ie', preview);
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Requests to our own test server pass through; anything else (Tavily) is the spy.
  globalThis.fetch = ((input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    if (url.startsWith(base)) return realFetch(input, init);
    return fetchSpy(url, init);
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  if (saved.key === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = saved.key;
  if (saved.region !== undefined) process.env.DEPLOY_REGION = saved.region;
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  vi.clearAllMocks();
  m.llmCalls.length = 0;
  m.brand = { id: 'roboapply', market: 'intl', name: 'RoboApply' };
  m.user = { id: 'u1', role: 'seeker', roles: ['seeker'], name: 'Jane Doe' };
  m.phoneRequired.mockResolvedValue(false);
  m.aiAllowed.mockResolvedValue(true);
  m.voiceOn.mockReturnValue(true);
  m.agentRun.mockResolvedValue(structuredClone(BLUEPRINT));
  fetchSpy.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ answer: 'A summary', results: [{ title: 'Backend Engineer at Acme', url: 'https://boards.example/1', content: 'Requirements…', score: 0.9 }] }),
    text: async () => '',
  });
});

const preview = (body: unknown) =>
  realFetch(`${base}/ie/requirements/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const tavilyBodies = () => fetchSpy.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body) as { query: string });

describe('GoApply: the AI gate comes first', () => {
  beforeEach(() => {
    m.brand = { id: 'goapply', market: 'cn', name: 'GoApply' };
  });

  it('consent off → 503 ai_unavailable with zero LLMService calls and zero Tavily calls', async () => {
    m.aiAllowed.mockResolvedValue(false);
    const res = await preview({ role: '后端工程师', interviewType: 'behavioral', personaId: 'maya', language: 'zh' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ai_unavailable', reason: 'ai_consent_required' });
    expect(m.aiAllowed).toHaveBeenCalledWith({ id: 'u1', brand: 'goapply' });
    expect(m.llmCalls).toEqual([]);
    expect(m.agentRun).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a failed consent lookup counts as off (fails closed)', async () => {
    m.aiAllowed.mockRejectedValue(new Error('db down'));
    const res = await preview({ role: '后端工程师' });
    expect(res.status).toBe(503);
    expect(m.llmCalls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('no bound phone → 403 phone_binding_required, nothing called', async () => {
    m.phoneRequired.mockResolvedValue(true);
    const res = await preview({ role: '后端工程师' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'phone_binding_required', bindRoute: '/bind-phone' });
    expect(m.llmCalls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('consent on → the blueprint is built with web evidence, as on RoboApply (G9)', async () => {
    const res = await preview({ role: '后端工程师', interviewType: 'behavioral', personaId: 'maya', language: 'zh' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requirements.roleSummary).toBe('Builds APIs');
    expect(body.sampleQuestions).toEqual(['Tell me about a hard bug.', 'How do you test?']);
    expect(body.groundedOn).toBe('market');
    expect(body.webSources).toEqual([{ title: 'Backend Engineer at Acme', url: 'https://boards.example/1' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.tavily.com/search');
    // The query is the role text only.
    expect(tavilyBodies()[0]?.query).toBe('后端工程师 job description requirements responsibilities qualifications');
    expect(m.agentRun).toHaveBeenCalledTimes(1);
    expect(String(m.agentRun.mock.calls[0]?.[0]?.webEvidence)).toContain('A summary');
  });

  it('consent on, a short job post: the search runs and the preview stays grounded on the post', async () => {
    const res = await preview({ jdText: '负责后端服务开发，熟悉 Go 或 Java。', language: 'zh' });
    expect(res.status).toBe(200);
    expect((await res.json()).groundedOn).toBe('jd');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the user’s own name', '张伟 后端工程师', { name: '张伟' }],
    ['an email address', '后端工程师 zhangwei@example.com', {}],
    ['a mainland phone number', '后端工程师 13800138000', {}],
  ])('a role carrying %s is never sent to the search; the preview still works', async (_what, role, user) => {
    m.user = { ...m.user, ...user };
    const res = await preview({ role, language: 'zh' });
    expect(res.status).toBe(200);
    expect((await res.json()).groundedOn).toBe('role');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(m.agentRun).toHaveBeenCalledTimes(1);
  });

  it('a search failure degrades to no evidence, never an error', async () => {
    fetchSpy.mockRejectedValue(new Error('search down'));
    const res = await preview({ role: '后端工程师', language: 'zh' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groundedOn).toBe('role');
    expect(body.webSources).toEqual([]);
    expect(m.agentRun.mock.calls[0]?.[0]).toMatchObject({ webEvidence: '' });
  });

  it('a general type whose length fits 20–30 minutes previews in the AI-interview practice format the session will run', async () => {
    // Phone screen: 20 minutes by default → the format. Behavioural: 40 → its own format.
    await preview({ role: '产品经理', interviewType: 'screening', language: 'zh' });
    expect(m.agentRun.mock.calls[0]?.[0]).toMatchObject({ typeLabel: 'AI Interview Practice' });
    expect(String(m.agentRun.mock.calls[0]?.[0]?.typeFormatDirective)).toContain('one-way, timed AI video interview');
    await preview({ role: '产品经理', interviewType: 'behavioral', language: 'zh' });
    expect(m.agentRun.mock.calls[1]?.[0]).toMatchObject({ typeLabel: 'Behavioral (STAR)' });
    // The format picked by name is found on the cn catalog.
    await preview({ role: '产品经理', interviewType: 'cn_ai_interview', language: 'zh' });
    expect(m.agentRun.mock.calls[2]?.[0]).toMatchObject({ typeLabel: 'AI Interview Practice' });
  });
});

describe('RoboApply: unchanged, with a no-personal-information search', () => {
  it('searches job boards for the role and feeds the evidence to the model', async () => {
    const res = await preview({ role: 'Backend Engineer', interviewType: 'behavioral', personaId: 'maya' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groundedOn).toBe('market');
    expect(body.webSources).toEqual([{ title: 'Backend Engineer at Acme', url: 'https://boards.example/1' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.tavily.com/search');
    expect(tavilyBodies()[0]?.query).toBe('Backend Engineer job description requirements responsibilities qualifications');
    expect(m.agentRun).toHaveBeenCalledTimes(1);
    // The AI gate has nothing to check on RoboApply.
    expect(m.aiAllowed).not.toHaveBeenCalled();
    expect(m.phoneRequired).not.toHaveBeenCalled();
    // The intl catalog is unchanged: a behavioural preview stays behavioural.
    expect(m.agentRun.mock.calls[0]?.[0]).toMatchObject({ typeLabel: 'Behavioral (STAR)' });
  });

  it('never runs the GoApply format: a phone screen stays a phone screen, the cn format id is unknown', async () => {
    await preview({ role: 'Analyst', interviewType: 'screening' });
    expect(m.agentRun.mock.calls[0]?.[0]).toMatchObject({ typeLabel: 'Phone Screen' });
    await preview({ role: 'Analyst', interviewType: 'cn_ai_interview' });
    expect(m.agentRun.mock.calls[1]?.[0]).toMatchObject({ typeLabel: 'Behavioral (STAR)' });
  });

  it.each([
    ['the user’s own name', 'Jane Doe Backend Engineer'],
    ['an email address', 'Backend Engineer jane.doe@example.com'],
    ['a phone number', 'Backend Engineer +1 415 555 0134'],
  ])('a role carrying %s is never sent to the search; the preview still works', async (_what, role) => {
    const res = await preview({ role });
    expect(res.status).toBe(200);
    expect((await res.json()).groundedOn).toBe('role');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(m.agentRun).toHaveBeenCalledTimes(1);
  });

  it('a long pasted job post is authoritative: no search at all', async () => {
    const res = await preview({ jdText: 'Responsibilities: build and run payment APIs. '.repeat(20) });
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
