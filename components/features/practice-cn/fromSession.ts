// components/features/practice-cn/fromSession.ts — the GoApply report block
// for an interview-engine session (WP-66).
//
// Prefers the block the server stored (`report.cn`, exposed as
// `session.cnReport` once the serializer passes it through — see the WP-66
// handoff). Until then it builds the same block here from the transcript and
// the session's breakdown with the client mirror of the rubric.

import type { IEReport } from '../../../lib/api/interviewEngine';
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

function isStoredReport(value: unknown): value is CnPracticeReport {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<CnPracticeReport>;
  return v.version === 1 && Array.isArray(v.areas) && Array.isArray(v.answers) && !!v.star && !!v.fillers;
}

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
  if (isStoredReport(session.cnReport)) return session.cnReport;
  return buildCnPracticeReport({
    turns: normalizeCnTurns(report.transcript),
    breakdown: Array.isArray(session.breakdown) ? session.breakdown : null,
    basis: sessionBasis(session),
    language: session.language || 'zh',
    formatId: session.interviewType,
    now: session.endedAt ?? session.createdAt,
  });
}
