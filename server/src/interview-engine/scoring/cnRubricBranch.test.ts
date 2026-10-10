// WP-66 — the cn rubric branch of the report evaluation: GoApply practices get
// the `cn` block (and the format lens when run in the format); RoboApply
// sessions are evaluated exactly as before (regression).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const agents = vi.hoisted(() => ({
  holistic: vi.fn(),
  deepDive: vi.fn(),
  recs: vi.fn(),
}));

vi.mock('./HolisticScorecardAgent.js', () => ({ holisticScorecardAgent: { run: agents.holistic } }));
vi.mock('./QuestionDeepDiveAgent.js', () => ({ questionDeepDiveAgent: { run: agents.deepDive } }));
vi.mock('./RecommendationsAgent.js', () => ({ recommendationsAgent: { run: agents.recs } }));

import type { InterviewSession } from '../../generated/prisma/client.js';
import { setUserBrandLookup } from '../../platform/brand/index.js';
import { CN_AI_INTERVIEW_FORMAT_ID, CN_FORMAT_EVALUATION_LENS } from '../../features/cn/interview/index.js';
import { ZH_BREAKDOWN, ZH_ENGINE_TRANSCRIPT, ZH_EXPECTED } from '../../features/cn/interview/__tests__/fixtures.js';
import type { TranscriptTurn } from '../types.js';
import { scoreTranscript } from './interviewScorer.js';
import { runInterviewEvaluation } from './interviewEvaluationService.js';
import { attachCnReport, breakdownBasis, cnEvaluationLens, isCnPracticeSession, ranCnFormat } from './cnRubricBranch.js';
import type { RichInterviewReport } from './reportTypes.js';

const turns = ZH_ENGINE_TRANSCRIPT as unknown as TranscriptTurn[];

function session(extra: Partial<InterviewSession> = {}): InterviewSession {
  return {
    id: 's1',
    userId: 'u1',
    source: 'roboapply',
    interviewType: 'behavioral',
    language: 'zh',
    role: '产品经理',
    personaId: 'priya',
    candidateName: null,
    blueprint: {},
    ...extra,
  } as unknown as InterviewSession;
}

const brands: Record<string, string> = { u1: 'goapply', u2: 'roboapply' };

beforeEach(() => {
  setUserBrandLookup(async (id) => brands[id] ?? null);
  agents.holistic.mockResolvedValue({
    overall: 64,
    breakdown: ZH_BREAKDOWN,
    strengths: ['a'],
    gaps: ['b'],
    summary: 's',
  });
  agents.deepDive.mockResolvedValue([]);
  agents.recs.mockResolvedValue([]);
});

afterEach(() => {
  setUserBrandLookup(null);
  vi.clearAllMocks();
});

describe('isCnPracticeSession', () => {
  it('is true for a GoApply candidate practice and any session in the cn format', async () => {
    expect(await isCnPracticeSession(session())).toBe(true);
    expect(await isCnPracticeSession(session({ userId: 'u2', interviewType: 'cn_ai_interview' }))).toBe(true);
  });

  it('is false for RoboApply users, external/recruiter sessions and unknown users', async () => {
    expect(await isCnPracticeSession(session({ userId: 'u2' }))).toBe(false);
    expect(await isCnPracticeSession(session({ source: 'robohire' }))).toBe(false);
    expect(await isCnPracticeSession(session({ userId: 'nobody' }))).toBe(false);
  });

  it('treats a failed brand lookup as intl and does not throw', async () => {
    setUserBrandLookup(async () => {
      throw new Error('db down');
    });
    await expect(isCnPracticeSession(session())).resolves.toBe(false);
  });
});

describe('lens and basis', () => {
  it('adds the format lens only to cn sessions that ran the format', () => {
    const planned = { blueprint: { cnFormat: { formatId: CN_AI_INTERVIEW_FORMAT_ID, minutes: 25, questions: [] } } } as Partial<InterviewSession>;
    // A plain GoApply behavioural session did not follow the format: no lens.
    expect(cnEvaluationLens(session(), true)).toBeNull();
    expect(cnEvaluationLens(session({ interviewType: 'technical' }), true)).toBeNull();
    // Run in the format: created with the format id, or built with the plan.
    expect(cnEvaluationLens(session({ interviewType: CN_AI_INTERVIEW_FORMAT_ID }), true)).toBe(CN_FORMAT_EVALUATION_LENS);
    expect(cnEvaluationLens(session(planned), true)).toBe(CN_FORMAT_EVALUATION_LENS);
    expect(cnEvaluationLens(session(planned), false)).toBeNull();
  });

  it('ranCnFormat reads the type id or the blueprint plan only', () => {
    expect(ranCnFormat({ interviewType: CN_AI_INTERVIEW_FORMAT_ID })).toBe(true);
    expect(ranCnFormat({ interviewType: 'behavioral', blueprint: { cnFormat: { minutes: 20 } } as never })).toBe(true);
    expect(ranCnFormat({ interviewType: 'behavioral', blueprint: {} })).toBe(false);
    expect(ranCnFormat({ interviewType: 'behavioral', blueprint: null })).toBe(false);
    expect(ranCnFormat({ interviewType: 'behavioral', blueprint: { cnFormat: 'x' } as never })).toBe(false);
    expect(ranCnFormat({ interviewType: null })).toBe(false);
  });

  it('formatId names the format only when the session ran it', () => {
    const base = () => ({ breakdown: ZH_BREAKDOWN, generatedAt: '2026-10-10T00:00:00Z' }) as unknown as RichInterviewReport;
    expect(attachCnReport(session(), turns, base(), true).cn!.formatId).toBe('behavioral');
    expect(attachCnReport(session({ interviewType: null }), turns, base(), true).cn!.formatId).toBe('general');
    expect(attachCnReport(session({ interviewType: CN_AI_INTERVIEW_FORMAT_ID }), turns, base(), true).cn!.formatId)
      .toBe(CN_AI_INTERVIEW_FORMAT_ID);
    expect(attachCnReport(session({ blueprint: { cnFormat: { minutes: 25 } } as never }), turns, base(), true).cn!.formatId)
      .toBe(CN_AI_INTERVIEW_FORMAT_ID);
  });

  it('reads where the breakdown came from', () => {
    expect(breakdownBasis({})).toBe('ai_review');
    expect(breakdownBasis({ tooShort: true })).toBe('text_checks');
    expect(breakdownBasis({ failedSections: ['holistic'] })).toBe('text_checks');
    expect(breakdownBasis({ failedSections: ['recommendations'] })).toBe('ai_review');
  });

  it('attachCnReport never throws and leaves intl reports alone', () => {
    const report = { breakdown: ZH_BREAKDOWN, generatedAt: '2026-10-10T00:00:00Z' } as unknown as RichInterviewReport;
    expect(attachCnReport(session(), turns, report, false).cn).toBeUndefined();
    const broken = { get breakdown() { throw new Error('boom'); } } as unknown as RichInterviewReport;
    expect(() => attachCnReport(session(), turns, broken, true)).not.toThrow();
  });
});

describe('runInterviewEvaluation', () => {
  const score = () => scoreTranscript(turns, 2, 'zh');

  it('GoApply in the format: attaches the cn block built from the AI review and adds the format lens', async () => {
    const { richReport } = await runInterviewEvaluation(session({ interviewType: CN_AI_INTERVIEW_FORMAT_ID }), turns, score(), 600, 'req-1');
    expect(richReport.cn).toBeDefined();
    expect(richReport.cn!.areas).toEqual([
      { key: 'communication', value: ZH_EXPECTED.communication, basis: 'ai_review' },
      { key: 'logic', value: ZH_EXPECTED.logic, basis: 'ai_review' },
      { key: 'behaviour', value: ZH_EXPECTED.behaviour, basis: 'star_check' },
    ]);
    expect(richReport.cn!.fillers.total).toBe(ZH_EXPECTED.fillerTotal);
    expect(richReport.cn!.generatedAt).toBe(richReport.generatedAt);
    expect(agents.holistic.mock.calls[0]![0].evaluationLens).toContain(CN_FORMAT_EVALUATION_LENS);
    expect(richReport.cn!.formatId).toBe(CN_AI_INTERVIEW_FORMAT_ID);
  });

  it('GoApply outside the format: still attaches the cn block, but no format lens', async () => {
    const { richReport } = await runInterviewEvaluation(session(), turns, score(), 600, 'req-1b');
    expect(richReport.cn).toBeDefined();
    expect(richReport.cn!.formatId).toBe('behavioral');
    expect(agents.holistic.mock.calls[0]![0].evaluationLens).not.toContain('Format lens');
  });

  it('GoApply: a failed AI review marks the areas as text checks', async () => {
    agents.holistic.mockRejectedValue(new Error('model down'));
    const { richReport } = await runInterviewEvaluation(session(), turns, score(), 600, 'req-2');
    expect(richReport.cn!.areas[0]!.basis).toBe('text_checks');
  });

  it('GoApply: a too-short practice still gets the block, with text-check areas', async () => {
    const short = [{ role: 'interviewer', text: '请做一个自我介绍。', ts: 1 }, { role: 'candidate', text: '你好', ts: 2 }] as TranscriptTurn[];
    const { richReport } = await runInterviewEvaluation(session(), short, scoreTranscript(short, 2, 'zh'), 10, 'req-3');
    expect(richReport.tooShort).toBe(true);
    expect(richReport.cn!.areas[0]!.basis).toBe('text_checks');
    expect(agents.holistic).not.toHaveBeenCalled();
  });

  it('RoboApply (regression): no cn block, no format lens', async () => {
    const { richReport, flat } = await runInterviewEvaluation(session({ userId: 'u2', language: 'en' }), turns, score(), 600, 'req-4');
    expect(richReport.cn).toBeUndefined();
    expect('cn' in richReport).toBe(false);
    expect(agents.holistic.mock.calls[0]![0].evaluationLens).not.toContain('Format lens');
    expect(flat.breakdown).toEqual(ZH_BREAKDOWN);
  });
});
