// WP-66 — the cn branch of the written-practice prompt generator
// (server/src/roboapply/v2/services/RAInterviewPromptService.ts): a GoApply
// practice in a general type runs the AI-interview script with the zh question
// sets (a fixed script: nothing to research); every other GoApply practice runs
// the same general pipeline as RoboApply, web research included (D5; G9, G57),
// with a role query that carries no personal information. RoboApply runs the
// pipeline unchanged (regression).
// No network, no model: the search and every agent are mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  search: vi.fn(),
  requirements: vi.fn(),
  strategy: vi.fn(),
  tactics: vi.fn(),
  questions: vi.fn(),
}));

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

import { runWithBrand } from '../../../../lib/requestContext.js';
import { CN_QUESTION_SETS, questionTip, storyQuestionCount } from '../index.js';
import { RAInterviewPromptService, withSearchKnownValues, type RAInterviewPromptInput } from '../../../../roboapply/v2/services/RAInterviewPromptService.js';

const REQUIREMENTS = {
  roleSummary: 'Product role',
  seniorityBar: 'Junior',
  mustHaveSkills: ['Analysis'],
  niceToHaveSkills: [],
  coreResponsibilities: ['Ship'],
  successSignals: ['Results'],
  commonInterviewFocus: ['Stories'],
  domainContext: '',
};
const STRATEGY = {
  overview: 'Intl overview',
  phases: [{ name: 'Core', minutes: 20, goal: 'Probe' }],
  focusAreas: ['Impact'],
  signalsToElicit: ['Metrics'],
  redFlagsToProbe: ['Vague'],
  openingApproach: 'Open',
  closingApproach: 'Close',
};
const TACTICS = { tactics: ['Press'], probingTactics: ['Ladder'], adaptationRules: ['IF vague THEN probe'] };
const AGENT_Q = {
  phase: 'Core', q: 'Agent question?', intent: 'i', idealSignal: 's', probeIfWeak: 'p', hint: 'h',
  coachTip: { kind: 'good' as const, text: 't' },
};

function input(extra: Partial<RAInterviewPromptInput> = {}): RAInterviewPromptInput {
  return {
    role: '产品经理',
    persona: { id: 'priya', name: 'Priya', role: 'The Behavioral Probe', style: 'STAR', blurb: 'b', difficulty: 2 },
    type: { id: 'behavioral', label: 'Behavioral (STAR)', sub: 'Stories' },
    durationMinutes: 40,
    language: 'zh',
    requestId: 'req-1',
    ...extra,
  };
}

const service = new RAInterviewPromptService();

beforeEach(() => {
  m.search.mockResolvedValue({ results: [{ title: 'Web evidence', url: 'https://example.com/a' }] });
  m.requirements.mockResolvedValue(REQUIREMENTS);
  m.strategy.mockResolvedValue(STRATEGY);
  m.tactics.mockResolvedValue(TACTICS);
  m.questions.mockResolvedValue([AGENT_Q]);
});

afterEach(() => vi.clearAllMocks());

describe('RoboApply / intl (regression)', () => {
  it('runs the full pipeline: web search, four agents, agent questions', async () => {
    const out = await service.generate(input({ market: 'intl' }));
    expect(m.search).toHaveBeenCalledOnce();
    expect(m.strategy).toHaveBeenCalledOnce();
    expect(m.tactics).toHaveBeenCalledOnce();
    expect(m.questions.mock.calls[0]![0].count).toBe(6);
    expect(out.seedQuestions).toEqual([{ q: 'Agent question?', hint: 'h', coachTip: { kind: 'good', text: 't' } }]);
    expect(out.webSources).toEqual([{ title: 'Web evidence', url: 'https://example.com/a' }]);
    expect(out.blueprint.strategy).toEqual(STRATEGY);
    expect(out.blueprint).not.toHaveProperty('cnFormat');
    expect(m.requirements.mock.calls[0]![0].webEvidence).toBe('Web evidence');
  });

  it('a role text carrying personal information is never sent to the web search (INT-09)', async () => {
    for (const role of ['Product Manager jane.doe@example.com', 'Product Manager +1 415 555 0134']) {
      const out = await service.generate(input({ market: 'intl', role }));
      expect(out.webSources).toEqual([]);
    }
    expect(m.search).not.toHaveBeenCalled();
    // The pipeline still runs on the role alone.
    expect(m.requirements).toHaveBeenCalledTimes(2);
    expect(m.requirements.mock.calls[0]![0].webEvidence).toBe('');
  });

  it('defaults to the request brand: RoboApply runs the intl pipeline', async () => {
    await runWithBrand('roboapply', () => service.generate(input()));
    expect(m.search).toHaveBeenCalledOnce();
  });

  it('puts a given job post ahead of the web evidence', async () => {
    await service.generate(input({ market: 'intl', jdText: 'We need a PM who ships.' }));
    expect(m.requirements.mock.calls[0]![0].webEvidence).toBe('Job post (saved by the candidate):\nWe need a PM who ships.\n\nWeb evidence');
  });

  it('a skill exercise on GoApply runs the general pipeline with the web search, the job post first', async () => {
    const out = await service.generate(
      input({ market: 'cn', jdText: '负责用户增长', type: { id: 'technical', label: 'Live Coding', sub: 'x' } }),
    );
    expect(m.search).toHaveBeenCalledOnce();
    expect(m.strategy).toHaveBeenCalledOnce();
    expect(out.blueprint).not.toHaveProperty('cnFormat');
    expect(out.webSources).toEqual([{ title: 'Web evidence', url: 'https://example.com/a' }]);
    expect(out.blueprint.webSources).toEqual([{ title: 'Web evidence', url: 'https://example.com/a' }]);
    expect(m.requirements.mock.calls[0]![0].webEvidence).toBe('Job post (saved by the candidate):\n负责用户增长\n\nWeb evidence');
  });

  it('a GoApply case practice with no job post is planned with web evidence, from a query that is the role alone', async () => {
    await runWithBrand('goapply', () => service.generate(input({ type: { id: 'case', label: 'Case', sub: 'x' } })));
    expect(m.search).toHaveBeenCalledOnce();
    expect(m.search.mock.calls[0]![0]).toBe('产品经理 role requirements, key skills, and interview focus');
    expect(m.requirements.mock.calls[0]![0].webEvidence).toBe('Web evidence');
  });

  it('GoApply: a role text carrying personal information is never sent to the web search', async () => {
    for (const role of ['产品经理 zhangwei@example.com', '产品经理 13800138000']) {
      const out = await runWithBrand('goapply', () => service.generate(input({ role, type: { id: 'case', label: 'Case', sub: 'x' } })));
      expect(out.webSources).toEqual([]);
    }
    expect(m.search).not.toHaveBeenCalled();
    expect(m.requirements).toHaveBeenCalledTimes(2);
  });

  it('a role text carrying the account name is not searched, and the practice is still planned (both brands)', async () => {
    const cases: Array<['goapply' | 'roboapply', string, string]> = [
      ['goapply', '张伟的产品经理面试', '张伟'],
      ['goapply', 'Product Manager for Zhang Wei', 'Zhang Wei'],
      ['roboapply', 'Product Manager (Jane Doe)', 'Jane Doe'],
    ];
    for (const [brand, role, name] of cases) {
      const out = await runWithBrand(brand, () =>
        service.generate(input({ role, type: { id: 'case', label: 'Case', sub: 'x' }, knownValues: [name] })),
      );
      expect(out.webSources, role).toEqual([]);
      expect(out.seedQuestions.length, role).toBeGreaterThan(0);
    }
    expect(m.search).not.toHaveBeenCalled();
    expect(m.requirements).toHaveBeenCalledTimes(3);
    expect(m.requirements.mock.calls[0]![0].webEvidence).toBe('');
    // The name is matched as a word: a role that merely contains its letters is searched.
    await runWithBrand('goapply', () =>
      service.generate(input({ role: 'Linux engineer', type: { id: 'case', label: 'Case', sub: 'x' }, knownValues: ['Li', '', null] })),
    );
    expect(m.search).toHaveBeenCalledOnce();
  });

  it('known values set around a start that does not forward them (RAMockService.start) are checked the same way', async () => {
    const run = (role: string) =>
      runWithBrand('goapply', () =>
        withSearchKnownValues(['张伟'], () => service.generate(input({ role, type: { id: 'case', label: 'Case', sub: 'x' } }))),
      );
    expect((await run('张伟的产品经理面试')).webSources).toEqual([]);
    expect(m.search).not.toHaveBeenCalled();
    expect((await run('产品经理')).webSources).toEqual([{ title: 'Web evidence', url: 'https://example.com/a' }]);
    expect(m.search).toHaveBeenCalledOnce();
    // Outside the scope nothing lingers.
    await runWithBrand('goapply', () => service.generate(input({ role: '张伟的产品经理面试', type: { id: 'case', label: 'Case', sub: 'x' } })));
    expect(m.search).toHaveBeenCalledTimes(2);
    // No values = no scope: the call is passed through.
    expect(withSearchKnownValues(undefined, () => 'x')).toBe('x');
    expect(withSearchKnownValues(['', null], () => 'y')).toBe('y');
  });

  it('GoApply: a failing search degrades to no evidence, never an error', async () => {
    m.search.mockRejectedValue(new Error('search down'));
    const out = await runWithBrand('goapply', () => service.generate(input({ type: { id: 'case', label: 'Case', sub: 'x' } })));
    expect(out.webSources).toEqual([]);
    expect(m.requirements.mock.calls[0]![0].webEvidence).toBe('');
    expect(m.strategy).toHaveBeenCalledOnce();
  });
});

describe('GoApply: the AI-interview format', () => {
  it('runs the zh script (fixed, so nothing is researched), timing per question and one role question for the job', async () => {
    const out = await runWithBrand('goapply', () => service.generate(input({ jdText: '负责用户增长', durationMinutes: 30 })));
    expect(m.search).not.toHaveBeenCalled();
    expect(m.strategy).not.toHaveBeenCalled();
    expect(m.tactics).not.toHaveBeenCalled();
    expect(m.questions).toHaveBeenCalledOnce();
    expect(m.questions.mock.calls[0]![0].count).toBe(1);
    expect(m.requirements.mock.calls[0]![0].webEvidence).toContain('负责用户增长');

    const plan = out.blueprint.cnFormat!;
    expect(plan.minutes).toBe(30);
    expect(plan.language).toBe('zh');
    expect(plan.questions.filter((q) => q.section === 'behavioral')).toHaveLength(storyQuestionCount(30));
    expect(out.webSources).toEqual([]);

    const bank = new Set(Object.values(CN_QUESTION_SETS).flat().map((q) => q.zh));
    const qs = out.seedQuestions.map((q) => q.q);
    expect(qs[0]).toMatch(/自我介绍|介绍/);
    expect(qs).toContain('Agent question?');
    expect(qs.filter((q) => q !== 'Agent question?').every((q) => bank.has(q))).toBe(true);
    // Timing travels as numbers in the plan; the tip is question-set content.
    expect(plan.questions[0]!.prepSeconds).toBeGreaterThan(0);
    expect(out.seedQuestions[0]!.coachTip.text).toBe(questionTip({ story: false }, 'zh'));
    expect(out.seedQuestions.every((q) => !/思考时间|秒|分钟|Thinking time/.test(q.coachTip.text))).toBe(true);
    expect(out.interviewPrompt).toContain('## Format: AI-interview practice (30 min)');
    expect(out.interviewerBrief).toContain('Format: AI-interview practice');
  });

  it('is deterministic per seed', async () => {
    const a = await service.generate(input({ market: 'cn', seed: 'session-1', durationMinutes: 25 }));
    const b = await service.generate(input({ market: 'cn', seed: 'session-1', durationMinutes: 25 }));
    expect(a.blueprint.cnFormat).toBeDefined();
    expect(b.seedQuestions).toEqual(a.seedQuestions);
  });

  it('runs English questions for an English session', async () => {
    const out = await service.generate(input({ market: 'cn', language: 'en', seed: 's', durationMinutes: 25 }));
    expect(out.blueprint.cnFormat!.language).toBe('en');
    expect(out.seedQuestions[0]!.q).toMatch(/introduce/i);
  });

  it('still starts with no model: fixed requirements and the generic role set', async () => {
    m.requirements.mockRejectedValue(new Error('no model'));
    m.questions.mockRejectedValue(new Error('no model'));
    const out = await service.generate(input({ market: 'cn', seed: 's', durationMinutes: 20 }));
    expect(out.blueprint.requirements.roleSummary).toContain('产品经理');
    const roleSet = new Set(CN_QUESTION_SETS.role.map((q) => q.zh));
    expect(out.seedQuestions.some((q) => roleSet.has(q.q))).toBe(true);
    expect(out.blueprint.cnFormat!.minutes).toBe(20);
  });

  it.each([10, 15, 19, 31, 40, 45])(
    'a %i-minute GoApply behavioural practice keeps its length and runs the general pipeline',
    async (minutes) => {
      const out = await runWithBrand('goapply', () => service.generate(input({ durationMinutes: minutes })));
      expect(out.blueprint).not.toHaveProperty('cnFormat');
      // The general pipeline, as on RoboApply: web research included.
      expect(m.search).toHaveBeenCalledOnce();
      expect(out.webSources).toEqual([{ title: 'Web evidence', url: 'https://example.com/a' }]);
      expect(m.strategy.mock.calls[0]![0].durationMinutes).toBe(minutes);
      expect(out.interviewPrompt).not.toContain('## Format: AI-interview practice');
    },
  );

  it.each([20, 25, 30])('a %i-minute GoApply behavioural practice runs the format at that length', async (minutes) => {
    const out = await service.generate(input({ market: 'cn', seed: 's', durationMinutes: minutes }));
    expect(out.blueprint.cnFormat!.minutes).toBe(minutes);
    expect(out.interviewPrompt).toContain(`## Format: AI-interview practice (${minutes} min)`);
  });

  it('the cn format id runs the format on any market', async () => {
    const out = await service.generate(input({ market: 'intl', type: { id: 'cn_ai_interview', label: 'AI', sub: '' } }));
    expect(out.blueprint.cnFormat).toBeDefined();
    expect(m.search).not.toHaveBeenCalled();
  });
});
