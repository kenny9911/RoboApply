// backend/src/interview-engine/scoring/cnRubricBranch.ts
//
// The GoApply branch of the report evaluation (TASK_PLAN.md WP-66): a practice
// by a GoApply user (or any session in the cn AI-interview format) gets
//   - the format's grading lens added to the evaluation lens, ONLY when the
//     session actually ran the format (interviewType `cn_ai_interview`, or a
//     blueprint carrying the `cnFormat` plan) — a plain GoApply behavioural
//     session is graded with its own lens, never against a format it did not
//     follow, and
//   - the `cn` block on the rich report: communication / logic / behaviour,
//     STAR completeness and filler-word counts (features/cn/interview).
// RoboApply sessions are untouched: no lens change, no `cn` block.
//
// NEVER THROWS: a failed brand lookup or check leaves the report as it was.

import type { InterviewSession } from '../../generated/prisma/client.js';
import { logger } from '../../services/LoggerService.js';
import { brandOfUser, getBrand } from '../../platform/brand/index.js';
import { readRowSeam } from '../providers/sessionSeam.js';
import {
  CN_AI_INTERVIEW_FORMAT_ID,
  CN_FORMAT_EVALUATION_LENS,
  buildCnPracticeReport,
  normalizeCnTurns,
  type CnAreaBasis,
} from '../../features/cn/interview/index.js';
import type { TranscriptTurn } from '../types.js';
import type { RichInterviewReport } from './reportTypes.js';

type SessionLike = Pick<InterviewSession, 'id' | 'userId' | 'source' | 'interviewType' | 'language'> &
  Partial<Pick<InterviewSession, 'blueprint' | 'brand' | 'voiceProvider' | 'liveMetrics'>>;

/**
 * True when the session ran the AI-interview format: created with the cn
 * format id, or its blueprint carries the format plan (`cnFormat`, written by
 * the format's script builder). The type id alone (e.g. `behavioral`) is not
 * enough: a general session only follows the format when it was built with it.
 */
export function ranCnFormat(session: Pick<SessionLike, 'interviewType' | 'blueprint'>): boolean {
  if (session.interviewType === CN_AI_INTERVIEW_FORMAT_ID) return true;
  const bp = session.blueprint;
  if (!bp || typeof bp !== 'object' || Array.isArray(bp)) return false;
  const plan = (bp as Record<string, unknown>).cnFormat;
  return !!plan && typeof plan === 'object' && !Array.isArray(plan);
}

/**
 * True when the session is a GoApply practice: in the cn format, or a
 * candidate practice (`source: 'roboapply'`, the first-party flow on both
 * brands) created under a brand on the cn market (`InterviewSession.brand`;
 * for older rows the JSON seam, else the owner's brand). External API and
 * recruiter sessions are never cn unless they asked for the format.
 */
export async function isCnPracticeSession(session: SessionLike): Promise<boolean> {
  if (session.interviewType === CN_AI_INTERVIEW_FORMAT_ID) return true;
  if (session.source !== 'roboapply' || !session.userId) return false;
  try {
    // The brand the session was created under (column, else liveMetrics), else the owner's.
    const brand = readRowSeam(session)?.brand ?? (await brandOfUser(session.userId));
    return brand !== null && getBrand(brand).market === 'cn';
  } catch (err) {
    logger.warn('INTERVIEW_EVAL', 'cn branch: brand lookup failed; treating as intl', {
      sessionId: session.id, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** The extra grading lens for a cn practice that ran the AI-interview format, else null. */
export function cnEvaluationLens(session: Pick<SessionLike, 'interviewType' | 'blueprint'>, isCn: boolean): string | null {
  return isCn && ranCnFormat(session) ? CN_FORMAT_EVALUATION_LENS : null;
}

/** Where the report's breakdown came from. */
export function breakdownBasis(report: Pick<RichInterviewReport, 'tooShort' | 'failedSections'>): Exclude<CnAreaBasis, 'star_check' | 'mixed'> {
  if (report.tooShort) return 'text_checks';
  if (report.failedSections?.includes('holistic')) return 'text_checks';
  return 'ai_review';
}

/** Attach `report.cn` (in place) when the session is a cn practice. Never throws. */
export function attachCnReport(
  session: SessionLike,
  turns: TranscriptTurn[],
  report: RichInterviewReport,
  isCn: boolean,
): RichInterviewReport {
  if (!isCn) return report;
  try {
    report.cn = buildCnPracticeReport({
      turns: normalizeCnTurns(turns),
      breakdown: report.breakdown,
      basis: breakdownBasis(report),
      language: session.language || 'zh',
      // The format id only when the session ran the format; otherwise its own
      // type ('general' when none was recorded), never a format it did not follow.
      formatId: ranCnFormat(session) ? CN_AI_INTERVIEW_FORMAT_ID : session.interviewType || 'general',
      now: report.generatedAt,
    });
  } catch (err) {
    logger.warn('INTERVIEW_EVAL', 'cn branch: report block failed; report kept without it', {
      sessionId: session.id, error: err instanceof Error ? err.message : String(err),
    });
  }
  return report;
}
