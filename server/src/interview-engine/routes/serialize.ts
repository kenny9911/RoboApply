// backend/src/interview-engine/routes/serialize.ts
//
// DTO mappers — never leak the full system prompt to API responses by default;
// expose the human-readable master brief + seed questions instead.

import type { InterviewSession } from '../../generated/prisma/client.js';

function sectionFailed(report: Record<string, unknown>, section: string): boolean {
  return Array.isArray(report.failedSections) && report.failedSections.includes(section);
}

export function toSessionSummary(s: InterviewSession) {
  return {
    id: s.id,
    status: s.status,
    source: s.source,
    role: s.role,
    interviewType: s.interviewType,
    personaId: s.personaId,
    mode: s.mode,
    language: s.language,
    durationMinutes: s.plannedDurationMinutes,
    overall: s.overall,
    externalRef: s.externalRef,
    createdAt: s.createdAt,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
  };
}

export function toSessionDetail(s: InterviewSession) {
  const blueprint = (s.blueprint ?? {}) as Record<string, unknown>;
  // Rich LLM report (null until Phase-B enrichment writes version '2').
  const report = (s.report ?? {}) as Record<string, unknown>;
  const isRich = report.version === '2';
  return {
    ...toSessionSummary(s),
    candidateName: s.candidateName,
    characteristics: s.characteristics ?? null,
    voice: s.voice ?? null,
    questions: Array.isArray(s.questions) ? s.questions : [],
    webSources: Array.isArray(s.webSources) ? s.webSources : [],
    interviewerBrief: typeof blueprint.interviewerBrief === 'string' ? blueprint.interviewerBrief : null,
    // The role spec the interview is grounded in (safe to show the candidate).
    // strategy/tactics/probeIfWeak stay server-side — interviewer playbook only.
    requirements:
      blueprint.requirements && typeof blueprint.requirements === 'object' ? blueprint.requirements : null,
    groundedOn: typeof s.jdText === 'string' && s.jdText
      ? 'jd'
      : Array.isArray(s.webSources) && s.webSources.length
        ? 'market'
        : 'role',
    // Report fields (null until completed). breakdown/strengths/gaps/summary are
    // overwritten with localized LLM prose once enrichment lands.
    breakdown: s.breakdown ?? null,
    strengths: s.strengths ?? [],
    gaps: s.gaps ?? [],
    summary: s.summary ?? null,
    // Rich report sections (null until LLM enrichment writes version '2').
    // A section listed in failedSections is nulled even when the stored value
    // is [] — the UI renders null as an honest "unavailable" state, whereas []
    // renders as "nothing to flag" (unearned praise for an agent failure).
    recommendations:
      isRich && Array.isArray(report.recommendations) && !sectionFailed(report, 'recommendations')
        ? report.recommendations
        : null,
    questionAnalysis:
      isRich && Array.isArray(report.questionAnalysis) && !sectionFailed(report, 'questionAnalysis')
        ? report.questionAnalysis
        : null,
    reportDegraded: isRich ? Boolean(report.degraded) : false,
    // True when the session had too few answers for LLM evaluation — the empty
    // sections are genuine, not a failure.
    reportTooShort: isRich ? Boolean(report.tooShort) : false,
    // True while LLM enrichment hasn't landed yet (or this is a legacy session).
    reportPending: s.status === 'completed' && !isRich,
    recordingAvailable: !!s.recordingKey,
    transcriptAvailable: !!s.transcriptKey || (Array.isArray(s.transcript) && s.transcript.length > 0),
  };
}
