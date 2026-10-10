// @vitest-environment node
//
// INT-09 (WP-66 wiring) — the written practice (RAMockService) on GoApply:
//   - the cn catalog lists the AI-interview practice format first; RoboApply's
//     catalog is unchanged;
//   - start passes the job post, the market and the session id (the
//     question-selection seed) to the prompt generator, writes the job on the
//     row's own column, and returns the format's timing per question;
//   - score attaches the `cn` report block on GoApply only, naming the format
//     only when the session ran it.
// The real prompt service runs (so the plan, the seed and the timing are the
// real ones); the search and every model agent are spies. No database.
// Run: npx vitest run server/src/features/cn/interview/__tests__/mockServiceCn.test.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const m = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  return {
    rows,
    search: vi.fn(),
    requirements: vi.fn(),
    strategy: vi.fn(),
    tactics: vi.fn(),
    questions: vi.fn(),
    interviewer: vi.fn(),
    prisma: {
      rAMockSession: {
        create: vi.fn(async ({ data }: { data: Row }) => {
          const row = { startedAt: new Date(), createdAt: new Date(), ...data };
          rows.set(row.id, row);
          return { id: row.id };
        }),
        findFirst: vi.fn(async ({ where }: { where: Row }) => {
          if (where.id && typeof where.id === 'string') {
            const row = rows.get(where.id);
            return row && row.userId === where.userId ? structuredClone(row) : null;
          }
          return null; // "previous completed session" lookup
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
          Object.assign(rows.get(where.id)!, data);
          return rows.get(where.id);
        }),
      },
      rAResumeVariant: { findFirst: vi.fn(async () => null) },
    },
  };
});

vi.mock('../../../../lib/prisma.js', () => ({ default: m.prisma }));
vi.mock('../../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../../roboapply/v2/lib/raWebSearch.js', () => ({
  raSearchWeb: m.search,
  formatWebEvidence: (resp: { results?: Array<{ title: string }> } | null) => (resp?.results ?? []).map((r) => r.title).join('\n'),
}));
vi.mock('../../../../services/llm/LLMService.js', () => ({ llmService: { getModel: () => 'test-model' } }));
vi.mock('../../../../roboapply/v2/lib/interviewGenShared.js', () => ({ interviewGenModel: () => 'test-model' }));
vi.mock('../../../../roboapply/v2/agents/RAInterviewJobRequirementsAgent.js', () => ({ raInterviewJobRequirementsAgent: { run: m.requirements } }));
vi.mock('../../../../roboapply/v2/agents/RAInterviewStrategyAgent.js', () => ({ raInterviewStrategyAgent: { run: m.strategy } }));
vi.mock('../../../../roboapply/v2/agents/RAInterviewTacticsAgent.js', () => ({ raInterviewTacticsAgent: { run: m.tactics } }));
vi.mock('../../../../roboapply/v2/agents/RAInterviewQuestionsAgent.js', () => ({
  RAInterviewQuestionsAgent: class {
    run = m.questions;
  },
}));
vi.mock('../../../../roboapply/v2/agents/RAMockInterviewerAgent.js', () => ({
  RAMockInterviewerAgent: class {
    run = m.interviewer;
  },
}));

import { runWithBrand } from '../../../../lib/requestContext.js';
import { formatsAsTypes } from '../../../../interview-engine/catalog/interviewFormats.js';
import { getCatalog, typesForMarket as engineTypesForMarket } from '../../../../interview-engine/catalog/interviewCatalog.js';
import {
  RA_MOCK_CATALOG,
  RA_MOCK_CN_TYPE,
  RA_MOCK_TYPES,
  catalogForMarket,
  findAnyType,
  findType,
  typeLabelFor,
  typesForMarket,
} from '../../../../roboapply/v2/lib/raMockCatalog.js';
import { raInterviewPromptService } from '../../../../roboapply/v2/services/RAInterviewPromptService.js';
import { MockValidationError, raMockService } from '../../../../roboapply/v2/services/RAMockService.js';
import { CN_AI_INTERVIEW_FORMAT_ID, CN_SCRIPT_SECTIONS, storyQuestionCount } from '../index.js';

const REQUIREMENTS = {
  roleSummary: 'Product role', seniorityBar: 'Junior', mustHaveSkills: ['Analysis'], niceToHaveSkills: [],
  coreResponsibilities: ['Ship'], successSignals: ['Results'], commonInterviewFocus: ['Stories'], domainContext: '',
};
const STRATEGY = {
  overview: 'o', phases: [{ name: 'Core', minutes: 20, goal: 'Probe' }], focusAreas: ['Impact'], signalsToElicit: ['Metrics'],
  redFlagsToProbe: ['Vague'], openingApproach: 'Open', closingApproach: 'Close',
};
const TACTICS = { tactics: ['Press'], probingTactics: ['Ladder'], adaptationRules: ['IF vague THEN probe'] };
const AGENT_Q = { phase: 'Core', q: 'Agent question?', intent: 'i', idealSignal: 's', probeIfWeak: 'p', hint: 'h', coachTip: { kind: 'good' as const, text: 't' } };

const generate = vi.spyOn(raInterviewPromptService, 'generate');

beforeEach(() => {
  vi.clearAllMocks();
  m.rows.clear();
  m.search.mockResolvedValue({ results: [{ title: 'Web evidence', url: 'https://example.com/a' }] });
  m.requirements.mockResolvedValue(REQUIREMENTS);
  m.strategy.mockResolvedValue(STRATEGY);
  m.tactics.mockResolvedValue(TACTICS);
  m.questions.mockResolvedValue([AGENT_Q]);
  m.interviewer.mockResolvedValue({ turns: [{ who: 'them', text: '好的，下一题。' }], coachTip: null });
});

const START = { role: '产品经理', interviewerId: 'maya', typeId: 'behavioral', format: 'voice' as const, language: 'zh' };

describe('catalog per market', () => {
  it('RoboApply: the catalog is the same object as before, with no GoApply format', () => {
    expect(raMockService.catalog('intl').catalog).toBe(RA_MOCK_CATALOG);
    expect(catalogForMarket()).toBe(RA_MOCK_CATALOG);
    expect(typesForMarket('intl')).toBe(RA_MOCK_TYPES);
    expect(RA_MOCK_TYPES.map((t) => t.id)).not.toContain(CN_AI_INTERVIEW_FORMAT_ID);
    expect(findType(CN_AI_INTERVIEW_FORMAT_ID)).toBeUndefined();
    expect(findType(CN_AI_INTERVIEW_FORMAT_ID, 'intl')).toBeUndefined();
  });

  it('GoApply: the AI-interview practice format is listed first, then the shared list unchanged', () => {
    const cn = raMockService.catalog('cn').catalog;
    expect(cn.types[0]).toEqual(RA_MOCK_CN_TYPE);
    expect(cn.types.slice(1)).toEqual(RA_MOCK_TYPES);
    expect(cn.interviewers).toBe(RA_MOCK_CATALOG.interviewers);
    expect(cn.roleCategories).toBe(RA_MOCK_CATALOG.roleCategories);
    expect(findType(CN_AI_INTERVIEW_FORMAT_ID, 'cn')).toEqual(RA_MOCK_CN_TYPE);
    // A stored session of the format resolves for labels and follow-up turns on any host.
    expect(findAnyType(CN_AI_INTERVIEW_FORMAT_ID)).toEqual(RA_MOCK_CN_TYPE);
    expect(typeLabelFor(CN_AI_INTERVIEW_FORMAT_ID)).toBe(RA_MOCK_CN_TYPE.label);
  });

  it('the literal twin equals the engine’s registered market format (formatsAsTypes("cn"))', () => {
    expect(RA_MOCK_CN_TYPE).toEqual(formatsAsTypes('cn')[0]);
    expect(RA_MOCK_CN_TYPE.id).toBe(CN_AI_INTERVIEW_FORMAT_ID);
    // …and the engine's own catalog read is market-aware the same way.
    expect(getCatalog('cn').types).toEqual(formatsAsTypes('cn'));
    expect(getCatalog('cn').types.map((t) => t.id)).toEqual(raMockService.catalog('cn').catalog.types.map((t) => t.id));
    expect(engineTypesForMarket('intl')).toBe(getCatalog().types);
  });

  it('the market defaults to the request’s brand', () => {
    expect(runWithBrand('goapply', () => raMockService.catalog()).catalog.types[0]!.id).toBe(CN_AI_INTERVIEW_FORMAT_ID);
    expect(runWithBrand('roboapply', () => raMockService.catalog()).catalog).toBe(RA_MOCK_CATALOG);
    expect(raMockService.catalog().catalog).toBe(RA_MOCK_CATALOG); // no brand context
  });
});

describe('start on GoApply', () => {
  it('seeds the generator with the job post, the market and the session id, and returns the timing per question', async () => {
    const out = await raMockService.start('u1', { ...START, durationMinutes: 25, jdText: '  负责用户增长与数据分析。  ', market: 'cn', jobId: 'job_cn_1' });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toMatchObject({ jdText: '负责用户增长与数据分析。', market: 'cn', seed: out.sessionId, durationMinutes: 25 });
    // The row carries the id that seeded the plan, and the job on its own column.
    const row = m.rows.get(out.sessionId)!;
    expect(m.prisma.rAMockSession.create.mock.calls[0]![0].data).toMatchObject({ id: out.sessionId, userId: 'u1', jobId: 'job_cn_1', typeId: 'behavioral', plannedDurationMinutes: 25 });
    expect(row.blueprint.cnFormat).toMatchObject({ formatId: CN_AI_INTERVIEW_FORMAT_ID, minutes: 25, language: 'zh' });

    // The job post reached the requirements agent as evidence; no web search on GoApply.
    expect(m.requirements.mock.calls[0]![0].webEvidence).toBe('Job post (saved by the candidate):\n负责用户增长与数据分析。');
    expect(m.search).not.toHaveBeenCalled();

    // One timing entry per question, from the format's script.
    const expected = CN_SCRIPT_SECTIONS.flatMap((s) =>
      Array.from({ length: s.id === 'behavioral' ? storyQuestionCount(25) : s.questions }, () => ({ prepSeconds: s.prepSeconds, answerSeconds: s.answerSeconds })),
    );
    expect(out.questions).toHaveLength(expected.length);
    expect(out.cnFormat).toMatchObject({ formatId: CN_AI_INTERVIEW_FORMAT_ID, minutes: 25 });
    expect(out.cnFormat!.questions.map(({ prepSeconds, answerSeconds }) => ({ prepSeconds, answerSeconds }))).toEqual(expected);
    expect(out.cnFormat!.questions.filter((q) => q.story).length).toBeGreaterThanOrEqual(storyQuestionCount(25));
    // The questions are the zh script (the role question is the one written for the job).
    expect(out.questions.map((q) => q.q)).toContain('Agent question?');
    expect(out.questions[0]!.q).toMatch(/自我|介绍|三个词/);
  });

  it('each session is its own seed: ids differ, and the same seed gives the same questions', async () => {
    const a = await raMockService.start('u1', { ...START, durationMinutes: 25, market: 'cn' });
    const b = await raMockService.start('u1', { ...START, durationMinutes: 25, market: 'cn' });
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(generate.mock.calls.map((c) => c[0].seed)).toEqual([a.sessionId, b.sessionId]);
    const replay = await raInterviewPromptService.generate({ ...generate.mock.calls[0]![0] });
    expect(replay.seedQuestions.map((q) => q.q)).toEqual(a.questions.map((q) => q.q));
  });

  it('the format picked by name is valid on GoApply only', async () => {
    const out = await raMockService.start('u1', { ...START, typeId: CN_AI_INTERVIEW_FORMAT_ID, market: 'cn' });
    expect(m.rows.get(out.sessionId)).toMatchObject({ typeId: CN_AI_INTERVIEW_FORMAT_ID, plannedDurationMinutes: 25 });
    expect(out.cnFormat?.questions.length).toBe(out.questions.length);
    await expect(raMockService.start('u1', { ...START, typeId: CN_AI_INTERVIEW_FORMAT_ID, market: 'intl' })).rejects.toBeInstanceOf(MockValidationError);
    await expect(raMockService.start('u1', { ...START, typeId: CN_AI_INTERVIEW_FORMAT_ID })).rejects.toBeInstanceOf(MockValidationError);
  });

  it('a general practice of another length, or a skill exercise, has no format timing', async () => {
    const long = await raMockService.start('u1', { ...START, durationMinutes: 45, market: 'cn', jdText: '负责后端' });
    expect(long.cnFormat).toBeUndefined();
    expect(m.rows.get(long.sessionId)!.blueprint).not.toHaveProperty('cnFormat');
    const coding = await raMockService.start('u1', { ...START, typeId: 'technical', durationMinutes: 25, market: 'cn' });
    expect(coding.cnFormat).toBeUndefined();
    // Still no offshore search for any GoApply practice.
    expect(m.search).not.toHaveBeenCalled();
  });

  it('the market defaults to the request’s brand', async () => {
    const out = await runWithBrand('goapply', () => raMockService.start('u1', { ...START, durationMinutes: 20 }));
    expect(generate.mock.calls[0]![0]).toMatchObject({ market: 'cn', seed: out.sessionId });
    expect(out.cnFormat).toBeDefined();
  });

  it('a long job post is clipped and a missing one is not sent', async () => {
    await raMockService.start('u1', { ...START, durationMinutes: 25, market: 'cn', jdText: '岗'.repeat(9000) });
    expect(generate.mock.calls[0]![0].jdText).toHaveLength(8000);
    await raMockService.start('u1', { ...START, durationMinutes: 25, market: 'cn', jdText: '   ' });
    expect(generate.mock.calls[1]![0].jdText).toBeUndefined();
    expect(m.prisma.rAMockSession.create.mock.calls[1]![0].data).not.toHaveProperty('jobId');
  });
});

describe('start on RoboApply (unchanged)', () => {
  it('runs the general pipeline with the web search, no format plan and no timing', async () => {
    const out = await raMockService.start('u1', { role: 'Product Manager', interviewerId: 'maya', typeId: 'behavioral', format: 'voice', durationMinutes: 25 });
    expect(generate.mock.calls[0]![0]).toMatchObject({ market: 'intl', seed: out.sessionId });
    expect(m.search).toHaveBeenCalledOnce();
    expect(out).toEqual({ sessionId: out.sessionId, questions: [{ q: 'Agent question?', hint: 'h', coachTip: { kind: 'good', text: 't' } }] });
    expect(out).not.toHaveProperty('cnFormat');
    expect(m.rows.get(out.sessionId)!.blueprint).not.toHaveProperty('cnFormat');
  });
});

describe('score', () => {
  async function answered(start: Parameters<typeof raMockService.start>[1]) {
    const { sessionId, questions } = await raMockService.start('u1', start);
    await raMockService.nextTurn('u1', { sessionId, questionIndex: 0, answer: '当时我们的项目延期了，我负责重新排期。我首先和每位同学确认进度，然后调整了分工，结果提前两天交付。' });
    await raMockService.nextTurn('u1', { sessionId, questionIndex: 1, answer: '嗯，我觉得这个岗位很适合我，因为我做过用户调研。' });
    return { sessionId, questions };
  }

  it('GoApply, in the format: the result carries report.cn for the AI-interview format, from text checks', async () => {
    const { sessionId } = await answered({ ...START, durationMinutes: 25, market: 'cn' });
    const result = await raMockService.score('u1', sessionId, { market: 'cn' });
    expect(result.cn).toBeDefined();
    expect(result.cn).toMatchObject({ version: 1, formatId: CN_AI_INTERVIEW_FORMAT_ID, language: 'zh' });
    expect(result.cn!.answers).toHaveLength(2);
    // The breakdown here is the text-check scorer, and the block says so (never "AI review").
    expect(result.cn!.areas.map((a) => a.basis)).toEqual(['text_checks', 'text_checks', 'star_check']);
    expect(result.cn!.fillers.total).toBeGreaterThanOrEqual(1);
    expect(result.cn!.fillers.unit).toBe('chars');
    // The plain score fields are what they always were.
    expect(result).toMatchObject({ overall: expect.any(Number), delta: null, durationMinutes: expect.any(Number) });
    expect(result.breakdown).toHaveLength(5);
  });

  it('GoApply, not in the format: report.cn names the session’s own type, never a format it did not follow', async () => {
    const { sessionId } = await answered({ ...START, durationMinutes: 45, market: 'cn' });
    const result = await raMockService.score('u1', sessionId, { market: 'cn' });
    expect(result.cn?.formatId).toBe('behavioral');
  });

  it('the market defaults to the request’s brand', async () => {
    const { sessionId } = await runWithBrand('goapply', () => answered({ ...START, durationMinutes: 25 }));
    expect((await runWithBrand('goapply', () => raMockService.score('u1', sessionId))).cn).toBeDefined();
  });

  it('RoboApply: no cn block, whatever the session looks like', async () => {
    const intl = await answered({ role: 'Product Manager', interviewerId: 'maya', typeId: 'behavioral', format: 'voice', durationMinutes: 25 });
    const result = await raMockService.score('u1', intl.sessionId);
    expect(result).not.toHaveProperty('cn');
    expect(Object.keys(result).sort()).toEqual(['breakdown', 'delta', 'durationMinutes', 'gaps', 'overall', 'strengths']);
    // Even a session that ran the format is scored without the block on the RoboApply host.
    const cn = await answered({ ...START, durationMinutes: 25, market: 'cn' });
    expect(await raMockService.score('u1', cn.sessionId, { market: 'intl' })).not.toHaveProperty('cn');
    expect(await runWithBrand('roboapply', () => raMockService.score('u1', cn.sessionId))).not.toHaveProperty('cn');
  });
});
