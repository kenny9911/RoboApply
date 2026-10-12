// server/src/features/cn/interview/report.ts — builds the GoApply practice
// report block (TASK_PLAN.md WP-66): pairs each answer with the question
// before it, runs the rubric checks and sums them up.
//
// Pure and deterministic (no model, no I/O). The interview engine stores the
// result as `report.cn` on a GoApply session (scoring/interviewEvaluationService);
// the text practice can attach it to its score (see the WP-66 handoff).
// MIRRORED on the client in components/features/practice-cn/rubric.ts (with the
// rubric); components/features/practice-cn/__tests__/rubricParity.test.ts fails on drift.

import type {
  CnAnswerCheck,
  CnAreaBasis,
  CnBreakdownRow,
  CnPracticeReport,
  CnTurn,
} from './contract.js';
import { CN_AI_INTERVIEW_FORMAT_ID } from './contract.js';
import {
  answerLength,
  checkStar,
  countFillers,
  isChineseText,
  isFollowUp,
  isStoryQuestion,
  mergeFillers,
  scoreAreas,
  summarizeStar,
} from './rubric.js';

/**
 * Normalise stored transcript rows from either practice path:
 *   interview engine  { role: 'interviewer' | 'candidate' | 'system', text, interim? }
 *   text practice     { who: 'them' | 'you', text }
 * System lines, interim segments and empty text are dropped.
 */
export function normalizeCnTurns(rows: unknown): CnTurn[] {
  if (!Array.isArray(rows)) return [];
  const out: CnTurn[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (r.interim === true) continue;
    const text = typeof r.text === 'string' ? r.text.trim() : '';
    if (!text) continue;
    const who = r.role ?? r.who ?? r.speaker;
    if (who === 'candidate' || who === 'you' || who === 'user') out.push({ role: 'candidate', text });
    else if (who === 'interviewer' || who === 'them' || who === 'ai' || who === 'assistant') out.push({ role: 'interviewer', text });
  }
  return out;
}

interface Answer {
  question: string | null;
  story: boolean;
  text: string;
}

/**
 * Group the transcript into answers: consecutive candidate turns are one
 * answer to the latest interviewer line; a short follow-up after a story
 * answer ("结果呢？") folds its answer into that story.
 */
export function groupAnswers(turns: readonly CnTurn[]): Answer[] {
  const answers: Answer[] = [];
  let question: string | null = null;
  let followUp = false;
  let lastRole: CnTurn['role'] | null = null;
  for (const turn of turns) {
    const prev = answers[answers.length - 1];
    if (turn.role === 'interviewer') {
      question = turn.text;
      followUp = !!prev && prev.story && isFollowUp(turn.text) && !isStoryQuestion(turn.text);
    } else if (prev && (lastRole === 'candidate' || followUp)) {
      prev.text = `${prev.text}\n${turn.text}`;
      followUp = false;
    } else {
      answers.push({ question, story: isStoryQuestion(question), text: turn.text });
    }
    lastRole = turn.role;
  }
  return answers;
}

export interface BuildCnReportInput {
  turns: readonly CnTurn[];
  /** The session's breakdown (rich canonical rows, or the scorer's English keys). */
  breakdown: readonly CnBreakdownRow[] | null | undefined;
  /** Where the breakdown came from. */
  basis: Exclude<CnAreaBasis, 'star_check'>;
  language: string;
  formatId?: string;
  /** ISO timestamp; injectable for tests. */
  now?: string;
}

export function buildCnPracticeReport(input: BuildCnReportInput): CnPracticeReport {
  const answers = groupAnswers(input.turns);
  const allText = answers.map((a) => a.text).join('\n');
  const unit: 'chars' | 'words' = isChineseText(allText) ? 'chars' : 'words';

  const checks: CnAnswerCheck[] = answers.map((a, index) => ({
    index,
    question: a.question,
    length: answerLength(a.text, unit),
    star: a.story ? checkStar(a.text) : null,
    fillers: countFillers(a.text),
  }));

  const totalLength = checks.reduce((s, c) => s + c.length, 0);
  const totalFillers = checks.reduce((s, c) => s + c.fillers.total, 0);
  const stars = checks.map((c) => c.star);

  return {
    version: 1,
    formatId: input.formatId ?? CN_AI_INTERVIEW_FORMAT_ID,
    language: input.language,
    generatedAt: input.now ?? new Date().toISOString(),
    areas: scoreAreas({ breakdown: input.breakdown, basis: input.basis, star: stars, answered: checks.length }),
    star: summarizeStar(stars),
    fillers: {
      total: totalFillers,
      per100: totalLength > 0 ? Math.round((totalFillers / totalLength) * 1000) / 10 : null,
      unit,
      top: mergeFillers(checks.map((c) => c.fillers)),
    },
    answers: checks,
  };
}
