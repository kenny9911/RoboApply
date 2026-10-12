// components/features/practice-cn/fromSession.ts — the GoApply report block
// for an interview-engine session (WP-66).
//
// Prefers the block the server stored (`report.cn`, sent as
// `session.cnReport`). For a session that carries none (scored before the
// block existed) it builds the same block here from the transcript and the
// session's breakdown with the client mirror of the rubric.

import type { IEReport } from '../../../lib/api/interviewEngine';
import { asCnPracticeReport } from './format';
import {
  buildCnPracticeReport,
  normalizeCnTurns,
  type CnAreaBasis,
  type CnPracticeReport,
} from './rubric';

type SessionExtras = {
  cnReport?: unknown;
  reportTooShort?: boolean;
};

/** Where the session's breakdown came from, as far as the client can tell. */
export function sessionBasis(session: IEReport['session'] & SessionExtras): Exclude<CnAreaBasis, 'star_check'> {
  if (session.status !== 'completed' || session.reportPending || session.reportTooShort) return 'text_checks';
  if (session.reportDegraded) return 'mixed';
  return 'ai_review';
}

/** True while the AI review may still change the block (the page keeps polling). */
export function reviewPending(report: IEReport): boolean {
  const s = report.session;
  return s.status === 'live' || s.status === 'finalizing' || s.status === 'created' || s.status === 'preparing' || !!s.reportPending;
}

export function cnReportFromEngine(report: IEReport): CnPracticeReport {
  const session = report.session as IEReport['session'] & SessionExtras;
  const stored = asCnPracticeReport(session.cnReport);
  if (stored) return stored;
  return buildCnPracticeReport({
    turns: normalizeCnTurns(report.transcript),
    breakdown: Array.isArray(session.breakdown) ? session.breakdown : null,
    basis: sessionBasis(session),
    language: session.language || 'zh',
    formatId: session.interviewType,
    now: session.endedAt ?? session.createdAt,
  });
}
