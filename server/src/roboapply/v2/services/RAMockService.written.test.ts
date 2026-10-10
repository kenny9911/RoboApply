// @vitest-environment node
//
// FIX-6 — the written practice (RAMockService) reports what happened, in the
// session language, and tells the model it is a written practice:
//   - the QA run: a Chinese session, question 1 answered, 2–5 skipped. The
//     result is Chinese, counts the four skipped questions, and never says
//     every question was answered;
//   - the question plan and every interviewer turn are told the answers are
//     typed (no microphone, no "stay off the keyboard");
//   - when the interviewer model fails in a non-English session, the canned
//     turn is not an English sentence;
//   - questions are counted, not answer turns: a re-sent answer (the room
//     retries the same question after a failed request) is one answer;
//   - the written-practice notes fit inside what the interviewer agent keeps.
// The prompt service and the interviewer agent are spies. No database.
// Run: npx vitest run server/src/roboapply/v2/services/RAMockService.written.test.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const m = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  return {
    rows,
    generate: vi.fn(),
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
          return null; // the "previous completed session" lookup
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

vi.mock('../../../lib/prisma.js', () => ({ default: m.prisma }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./RAInterviewPromptService.js', () => ({ raInterviewPromptService: { generate: m.generate } }));
vi.mock('../agents/RAMockInterviewerAgent.js', () => ({
  RAMockInterviewerAgent: class {
    run = m.interviewer;
  },
}));

import {
  AGENT_BRIEF_MAX_CHARS,
  AGENT_TYPE_LINE_MAX_CHARS,
  WRITTEN_PRACTICE_BRIEF,
  WRITTEN_PRACTICE_TYPE_NOTE,
  raMockService,
} from './RAMockService.js';
import { typesForMarket } from '../lib/raMockCatalog.js';

const ZH_QUESTIONS = ['第一题：海量日志里怎么做实时 Top-K？', '第二题', '第三题', '第四题', '第五题'];
const ZH_ANSWER =
  '我会先确认几个约束：日志的规模和每秒条数、取值域有多大、K 的大小、可用内存。' +
  '如果允许近似，我会用 Count-Min Sketch 加一个大小为 K 的小顶堆，因为内存只有 256MB；结果在实习中每日约两千万条日志的清洗任务里验证过。';

const START_ZH = { role: '后端工程师', interviewerId: 'kai', typeId: 'technical', format: 'voice' as const, language: 'zh', durationMinutes: 15, market: 'cn' as const };

function seedQuestions(texts: string[]) {
  return texts.map((q) => ({ q, hint: '', coachTip: { kind: 'good' as const, text: '' } }));
}

beforeEach(() => {
  vi.clearAllMocks();
  m.rows.clear();
  m.generate.mockResolvedValue({
    interviewPrompt: 'prompt',
    interviewerBrief: 'Persona: Kai. Strategy: probe.',
    blueprint: { questions: [] },
    seedQuestions: seedQuestions(ZH_QUESTIONS),
    webSources: [],
  });
  m.interviewer.mockResolvedValue({ turns: [{ who: 'them', text: '好的，下一题。' }], coachTip: null });
});

/** The QA run: answer question 1, skip 2–5. */
async function answerFirstSkipRest(start: Parameters<typeof raMockService.start>[1], answer: string) {
  const { sessionId, questions } = await raMockService.start('u1', start);
  await raMockService.nextTurn('u1', { sessionId, questionIndex: 0, answer });
  for (let i = 1; i < questions.length; i++) await raMockService.nextTurn('u1', { sessionId, questionIndex: i, answer: '' });
  return sessionId;
}

describe('score: a Chinese session with one answer and four skips', () => {
  it('is written in Chinese, counts the skipped questions and never says every question was answered', async () => {
    const sessionId = await answerFirstSkipRest(START_ZH, ZH_ANSWER);
    const result = await raMockService.score('u1', sessionId, { market: 'cn' });

    const roleFit = result.breakdown.find((b) => b.key === 'Role fit')!;
    expect(roleFit.note).toBe('5 道题中有 4 道没有作答——每道题都作答，结果才完整。');
    expect(result.gaps.some((g) => g.includes('4 道没有作答'))).toBe(true);

    const prose = [...result.strengths, ...result.gaps, ...result.breakdown.map((b) => b.note)];
    expect(result.strengths.length).toBeGreaterThan(0);
    for (const line of prose) {
      expect(line).toMatch(/[一-鿿]/);
      expect(line).not.toMatch(/Engaged with every prompt|Answers were very short|Role fit:|Communication:|每个问题都有认真回应/);
    }
    // A full Chinese answer is not "very short" (it is not one whitespace-delimited word).
    expect(result.breakdown.find((b) => b.key === 'Communication')!.note).not.toBe('回答过于简短——信息量要足够支撑评估。');
    // The stored report is the same text.
    expect(m.rows.get(sessionId)).toMatchObject({ status: 'complete', strengths: result.strengths, gaps: result.gaps });
    // The wire shape is unchanged; breakdown keys stay the stable English identifiers.
    expect(result.breakdown.map((b) => b.key)).toEqual(['Structure', 'Specificity', 'Communication', 'Confidence', 'Role fit']);
    // The GoApply block still reads the breakdown.
    expect(result.cn?.areas.map((a) => a.basis)).toEqual(['text_checks', 'text_checks', 'star_check']);
    expect(result.cn?.answers).toHaveLength(1);
  });

  it('an English session gets English, with the same honest count', async () => {
    m.generate.mockResolvedValue({
      interviewPrompt: 'p', interviewerBrief: 'b', blueprint: {}, webSources: [],
      seedQuestions: seedQuestions(['Q1?', 'Q2?', 'Q3?', 'Q4?', 'Q5?']),
    });
    const sessionId = await answerFirstSkipRest(
      { role: 'Backend Engineer', interviewerId: 'maya', typeId: 'behavioral', format: 'voice', language: 'en', durationMinutes: 15 },
      'We had a checkout bug that dropped 3% of orders. I traced it to a race in the cart service, then shipped a fix, which cut failures to 0.2%.',
    );
    const result = await raMockService.score('u1', sessionId);
    expect(result.breakdown.find((b) => b.key === 'Role fit')!.note).toBe(
      '4 of 5 questions went unanswered. Answer every question for a complete result.',
    );
    expect(result.strengths.join(' ')).not.toContain('Engaged with every prompt');
    expect(Object.keys(result).sort()).toEqual(['breakdown', 'delta', 'durationMinutes', 'gaps', 'overall', 'strengths']);
  });

  it('every question answered: nothing is reported as skipped', async () => {
    const { sessionId, questions } = await raMockService.start('u1', START_ZH);
    for (let i = 0; i < questions.length; i++) await raMockService.nextTurn('u1', { sessionId, questionIndex: i, answer: ZH_ANSWER });
    const result = await raMockService.score('u1', sessionId, { market: 'cn' });
    expect(result.breakdown.find((b) => b.key === 'Role fit')!.note).toBe('每个问题都有认真回应。');
    expect(result.gaps.join(' ')).not.toContain('没有作答');
  });

  it('nothing answered: no score is made up', async () => {
    const { sessionId, questions } = await raMockService.start('u1', START_ZH);
    for (let i = 0; i < questions.length; i++) await raMockService.nextTurn('u1', { sessionId, questionIndex: i, answer: '   ' });
    const result = await raMockService.score('u1', sessionId, { market: 'cn' });
    expect(result.overall).toBe(0);
    expect(result.gaps).toEqual(['没有记录到任何回答。请完整进行一次面试以获得真实评分。']);
  });
});

describe('score: questions are counted, not answer turns', () => {
  const EN_START = { role: 'Backend Engineer', interviewerId: 'maya', typeId: 'behavioral', format: 'voice' as const, language: 'en', durationMinutes: 15 };
  const EN_ANSWER =
    'We had a checkout bug that dropped 3% of orders. I traced it to a race in the cart service, then shipped a fix, which cut failures to 0.2%.';

  beforeEach(() => {
    m.generate.mockResolvedValue({
      interviewPrompt: 'p', interviewerBrief: 'b', blueprint: {}, webSources: [],
      seedQuestions: seedQuestions(['Q1?', 'Q2?', 'Q3?', 'Q4?', 'Q5?']),
    });
    m.interviewer.mockResolvedValue({ turns: [{ who: 'them', text: 'Thanks. Next one.' }], coachTip: null });
  });

  // The server stored the turn, the client saw the request fail, and the room
  // re-sent the same question with the same text.
  it('a re-sent answer does not hide a skipped question', async () => {
    const { sessionId } = await raMockService.start('u1', EN_START);
    await raMockService.nextTurn('u1', { sessionId, questionIndex: 0, answer: EN_ANSWER });
    await raMockService.nextTurn('u1', { sessionId, questionIndex: 0, answer: EN_ANSWER });
    for (const i of [1, 2, 3]) await raMockService.nextTurn('u1', { sessionId, questionIndex: i, answer: `${EN_ANSWER} (${i})` });
    await raMockService.nextTurn('u1', { sessionId, questionIndex: 4, answer: '' });

    const result = await raMockService.score('u1', sessionId);
    const roleFit = result.breakdown.find((b) => b.key === 'Role fit')!;
    expect(roleFit.note).toBe('1 of 5 questions went unanswered. Answer every question for a complete result.');
    expect([...result.strengths, ...result.gaps, roleFit.note].join(' ')).not.toContain('Engaged with every prompt');
  });

  it('a re-sent answer and four skips is 4 of 5 unanswered, not 3 of 5', async () => {
    const { sessionId } = await raMockService.start('u1', EN_START);
    await raMockService.nextTurn('u1', { sessionId, questionIndex: 0, answer: EN_ANSWER });
    await raMockService.nextTurn('u1', { sessionId, questionIndex: 0, answer: EN_ANSWER });
    for (const i of [1, 2, 3, 4]) await raMockService.nextTurn('u1', { sessionId, questionIndex: i, answer: '' });

    const result = await raMockService.score('u1', sessionId);
    expect(result.breakdown.find((b) => b.key === 'Role fit')!.note).toBe(
      '4 of 5 questions went unanswered. Answer every question for a complete result.',
    );
  });

  it('a re-send scores the same as a single send', async () => {
    const run = async (resend: boolean) => {
      const { sessionId } = await raMockService.start('u1', EN_START);
      await raMockService.nextTurn('u1', { sessionId, questionIndex: 0, answer: EN_ANSWER });
      if (resend) await raMockService.nextTurn('u1', { sessionId, questionIndex: 0, answer: EN_ANSWER });
      for (const i of [1, 2, 3, 4]) await raMockService.nextTurn('u1', { sessionId, questionIndex: i, answer: i < 3 ? 'Yes, I did that once.' : '' });
      const { durationMinutes: _minutes, ...rest } = await raMockService.score('u1', sessionId);
      return rest;
    };
    expect(await run(true)).toEqual(await run(false));
  });

  it('an edited re-send is still one answered question', async () => {
    const { sessionId } = await raMockService.start('u1', EN_START);
    await raMockService.nextTurn('u1', { sessionId, questionIndex: 0, answer: EN_ANSWER });
    await raMockService.nextTurn('u1', { sessionId, questionIndex: 0, answer: `${EN_ANSWER} I also added a regression test.` });
    for (const i of [1, 2, 3, 4]) await raMockService.nextTurn('u1', { sessionId, questionIndex: i, answer: '' });
    const result = await raMockService.score('u1', sessionId);
    expect(result.breakdown.find((b) => b.key === 'Role fit')!.note).toContain('4 of 5 questions went unanswered');
  });

  it('on GoApply a re-sent answer is reported once', async () => {
    m.generate.mockResolvedValue({
      interviewPrompt: 'p', interviewerBrief: 'b', blueprint: {}, webSources: [],
      seedQuestions: seedQuestions(ZH_QUESTIONS),
    });
    const { sessionId } = await raMockService.start('u1', START_ZH);
    await raMockService.nextTurn('u1', { sessionId, questionIndex: 0, answer: ZH_ANSWER });
    await raMockService.nextTurn('u1', { sessionId, questionIndex: 0, answer: ZH_ANSWER });
    for (const i of [1, 2, 3, 4]) await raMockService.nextTurn('u1', { sessionId, questionIndex: i, answer: '' });
    const result = await raMockService.score('u1', sessionId, { market: 'cn' });
    expect(result.cn?.answers).toHaveLength(1);
    expect(result.breakdown.find((b) => b.key === 'Role fit')!.note).toBe('5 道题中有 4 道没有作答——每道题都作答，结果才完整。');
  });
});

describe('score: the overall reflects how much of the practice was answered', () => {
  it('one answer out of five scores far below five answers, and the note says why', async () => {
    const sessionId = await answerFirstSkipRest(START_ZH, ZH_ANSWER);
    const skipped = await raMockService.score('u1', sessionId, { market: 'cn' });

    const { sessionId: fullId, questions } = await raMockService.start('u1', START_ZH);
    for (let i = 0; i < questions.length; i++) await raMockService.nextTurn('u1', { sessionId: fullId, questionIndex: i, answer: `${ZH_ANSWER}（第 ${i + 1} 题）` });
    const full = await raMockService.score('u1', fullId, { market: 'cn' });

    expect(full.overall).toBeGreaterThanOrEqual(75);
    expect(skipped.overall).toBeLessThan(50);
    expect(skipped.strengths.join('')).not.toContain('大多数回答');
    // The session note (shown on the recent-sessions card) names the skips.
    expect(m.rows.get(sessionId)!.note).toBe('5 道题中有 4 道没有作答——每道题都作答，结果才完整。');
  });
});

describe('the model is told the practice is written', () => {
  it('the question plan gets the written-practice note inside the part of the type line the agents keep', async () => {
    await raMockService.start('u1', START_ZH);
    const type = m.generate.mock.calls[0]![0].type as { id: string; label: string; sub: string };
    expect(type.id).toBe('technical');
    expect(type.sub.startsWith(WRITTEN_PRACTICE_TYPE_NOTE)).toBe(true);
    // The agents clip the type line at 200 characters: the note must survive it.
    expect(WRITTEN_PRACTICE_TYPE_NOTE.length).toBeLessThan(120);
    expect(type.sub.slice(0, 200)).toContain('typed');
    expect(type.sub).toContain('data structures');
  });

  it('every interviewer turn gets the written-practice brief first, then the session brief', async () => {
    const { sessionId } = await raMockService.start('u1', START_ZH);
    await raMockService.nextTurn('u1', { sessionId, questionIndex: 0, answer: ZH_ANSWER });
    const input = m.interviewer.mock.calls[0]![0] as { mode: string; interviewerBrief: string; type: { sub: string } };
    expect(input.mode).toBe('turn');
    expect(input.interviewerBrief.startsWith(WRITTEN_PRACTICE_BRIEF)).toBe(true);
    expect(input.interviewerBrief).toContain('Persona: Kai. Strategy: probe.');
    expect(input.type.sub.startsWith(WRITTEN_PRACTICE_TYPE_NOTE)).toBe(true);
    expect(WRITTEN_PRACTICE_BRIEF).toMatch(/types every answer/);
    expect(WRITTEN_PRACTICE_BRIEF).toMatch(/microphone/);
    expect(WRITTEN_PRACTICE_BRIEF).toMatch(/waiting before typing/);
  });

  // The agent keeps 200 characters of the type line and 2,000 of the brief.
  it('the note leaves room for every type description, on both markets', () => {
    for (const market of ['intl', 'cn'] as const) {
      for (const type of typesForMarket(market)) {
        const line = `${WRITTEN_PRACTICE_TYPE_NOTE} ${type.sub}`;
        expect(line.length, `${market}/${type.id}`).toBeLessThanOrEqual(AGENT_TYPE_LINE_MAX_CHARS);
      }
    }
  });

  it('the brief prefix is one short sentence, so the end of the session brief survives the agent’s cut', async () => {
    expect(WRITTEN_PRACTICE_BRIEF.length).toBeLessThanOrEqual(160);
    // A generated brief of 1,800 characters that ends with its format line.
    const tail = 'Format: AI-interview practice, timed questions, at most one short follow-up.';
    const sessionBrief = `${'Adaptation rule. '.repeat(120)}`.slice(0, 1800 - tail.length) + tail;
    m.generate.mockResolvedValue({
      interviewPrompt: 'prompt', interviewerBrief: sessionBrief, blueprint: {}, webSources: [],
      seedQuestions: seedQuestions(ZH_QUESTIONS),
    });
    const { sessionId } = await raMockService.start('u1', START_ZH);
    await raMockService.nextTurn('u1', { sessionId, questionIndex: 0, answer: ZH_ANSWER });
    const brief = (m.interviewer.mock.calls[0]![0] as { interviewerBrief: string }).interviewerBrief;
    expect(brief.slice(0, AGENT_BRIEF_MAX_CHARS).endsWith(tail)).toBe(true);
  });

  it('a session with no stored brief still gets the written-practice brief', async () => {
    m.generate.mockRejectedValue(new Error('generator down'));
    m.interviewer.mockResolvedValueOnce({ questions: seedQuestions(ZH_QUESTIONS) });
    const { sessionId } = await raMockService.start('u1', START_ZH);
    // The fallback plan call is told too.
    expect((m.interviewer.mock.calls[0]![0] as { type: { sub: string } }).type.sub.startsWith(WRITTEN_PRACTICE_TYPE_NOTE)).toBe(true);
    await raMockService.nextTurn('u1', { sessionId, questionIndex: 0, answer: ZH_ANSWER });
    expect((m.interviewer.mock.calls[1]![0] as { interviewerBrief: string }).interviewerBrief).toBe(WRITTEN_PRACTICE_BRIEF);
  });
});

describe('the canned turn when the interviewer model fails', () => {
  it('in a Chinese session it is the next question, not an English sentence', async () => {
    const { sessionId } = await raMockService.start('u1', START_ZH);
    m.interviewer.mockRejectedValue(new Error('model down'));
    const mid = await raMockService.nextTurn('u1', { sessionId, questionIndex: 0, answer: ZH_ANSWER });
    expect(mid.turns).toEqual([{ who: 'them', text: ZH_QUESTIONS[1] }]);
    expect(mid.coachTip).toBeNull();
    const skipped = await raMockService.nextTurn('u1', { sessionId, questionIndex: 1, answer: '' });
    expect(skipped.coachTip).toBeNull();
    const last = await raMockService.nextTurn('u1', { sessionId, questionIndex: 4, answer: '' });
    expect(last).toEqual({ nextIndex: null, turns: [], coachTip: null });
  });

  it('in an English session the English lines are kept', async () => {
    const { sessionId } = await raMockService.start('u1', { ...START_ZH, language: 'en', market: 'intl' });
    m.interviewer.mockRejectedValue(new Error('model down'));
    const mid = await raMockService.nextTurn('u1', { sessionId, questionIndex: 0, answer: 'An answer.' });
    expect(mid.turns[0]!.text).toContain('Let me move us on');
  });
});
