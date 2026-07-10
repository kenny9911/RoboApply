// backend/src/interview-engine/scoring/interviewEvaluationService.ts
//
// Orchestrates the multi-agent LLM evaluation that turns a finished interview
// transcript into a RICH, LOCALIZED report. Three angles:
//   Phase 1 (parallel): HolisticScorecardAgent + QuestionDeepDiveAgent
//   Phase 2 (sequential): RecommendationsAgent (needs the gaps + weak questions)
//
// CONTRACT: runInterviewEvaluation NEVER THROWS. Every agent failure degrades
// just that section — Holistic falls back to the deterministic score (mapped to
// canonical keys), DeepDive and Recommendations fall back to []. The
// deterministic numeric grounding (already persisted by finalize()) guarantees
// every session has a usable report even with zero working LLM.

import type { InterviewSession } from '../../generated/prisma/client.js';
import { logger } from '../../services/LoggerService.js';
import type { TranscriptTurn } from '../types.js';
import type { BlueprintQuestion } from '../prompt/InterviewBlueprintAgent.js';
import { countWordEquivalents, normalizeScorerLocale, type InterviewScore, type ScorerLocale } from './interviewScorer.js';
import { renderTranscriptForLLM } from './evalShared.js';
import {
  DIMENSION_KEYS,
  toCanonicalDimKey,
  type ReportSection,
  type RichBreakdownItem,
  type RichInterviewReport,
} from './reportTypes.js';
import { holisticScorecardAgent, type HolisticOutput } from './HolisticScorecardAgent.js';
import { questionDeepDiveAgent } from './QuestionDeepDiveAgent.js';
import { recommendationsAgent } from './RecommendationsAgent.js';
import { findPersona } from '../catalog/interviewCatalog.js';
import { getArchetype } from '../catalog/interviewArchetypes.js';
import { getDomainExpert } from '../catalog/domainExperts.js';

export interface EvaluationResult {
  richReport: RichInterviewReport;
  flat: {
    overall: number;
    breakdown: RichBreakdownItem[];
    strengths: string[];
    gaps: string[];
    summary: string;
  };
}

/**
 * Localized one-liner for sessions with too few answers to evaluate. The
 * deterministic scorer already localizes its notes; this summary replaces the
 * LLM narrative we deliberately skip. Keep the locale set in sync with
 * interviewScorer's ScorerLocale.
 */
const TOO_SHORT_SUMMARY: Record<ScorerLocale, string> = {
  en: 'This session was too short to evaluate — complete a few full answers to get a graded report.',
  zh: '本次面试时长过短，无法进行评估——完整回答几个问题后即可获得评分报告。',
  'zh-TW': '本次面試時長過短，無法進行評估——完整回答幾個問題後即可獲得評分報告。',
  ja: 'このセッションは短すぎて評価できませんでした。いくつかの質問にしっかり回答すると採点レポートが得られます。',
  ko: '이 세션은 너무 짧아 평가할 수 없습니다. 몇 개의 질문에 충실히 답하면 채점 리포트를 받을 수 있습니다.',
  es: 'La sesión fue demasiado corta para evaluarla: completa algunas respuestas para obtener un informe calificado.',
  fr: 'Cette session était trop courte pour être évaluée — répondez à quelques questions pour obtenir un rapport noté.',
  pt: 'A sessão foi curta demais para ser avaliada — responda a algumas perguntas para receber um relatório avaliado.',
  de: 'Diese Session war zu kurz für eine Bewertung — beantworten Sie einige Fragen vollständig, um einen bewerteten Bericht zu erhalten.',
};

/** Map the English-keyed deterministic score into the canonical HolisticOutput shape. */
function deterministicToHolistic(score: InterviewScore): HolisticOutput {
  const byKey = new Map<string, { value: number; note: string }>();
  for (const b of score.breakdown) {
    const ck = toCanonicalDimKey(b.key);
    if (ck) byKey.set(ck, { value: b.value, note: b.note });
  }
  const breakdown: RichBreakdownItem[] = DIMENSION_KEYS.map((key) => {
    const hit = byKey.get(key);
    return { key, value: hit?.value ?? 0, note: hit?.note ?? '' };
  });
  return {
    overall: score.overall,
    breakdown,
    strengths: score.strengths ?? [],
    gaps: score.gaps ?? [],
    summary: score.summary ?? '',
  };
}

function extractBlueprint(session: InterviewSession): {
  questions: BlueprintQuestion[];
  requirementsSummary: string;
  focusAreas: string[];
  domainKey: string | null;
} {
  const bp = (session.blueprint ?? {}) as Record<string, unknown>;
  const questions = Array.isArray(bp.questions) ? (bp.questions as BlueprintQuestion[]) : [];
  // The domain lens rides inside the blueprint JSON (written at create time by
  // interviewPromptService) — read it back so grading matches question design.
  const domainRaw = (bp.domain ?? null) as { key?: unknown } | null;
  const domainKey = domainRaw && typeof domainRaw.key === 'string' ? domainRaw.key : null;

  const req = (bp.requirements ?? {}) as Record<string, unknown>;
  const reqBits: string[] = [];
  if (typeof req.roleSummary === 'string' && req.roleSummary.trim()) reqBits.push(req.roleSummary.trim());
  if (typeof req.seniorityBar === 'string' && req.seniorityBar.trim()) reqBits.push(`Seniority: ${req.seniorityBar.trim()}`);
  if (Array.isArray(req.mustHaveSkills) && req.mustHaveSkills.length) {
    reqBits.push(`Must-have skills: ${req.mustHaveSkills.filter((s) => typeof s === 'string').join(', ')}`);
  }
  const requirementsSummary = reqBits.join('\n');

  const strat = (bp.strategy ?? {}) as Record<string, unknown>;
  const focusAreas = Array.isArray(strat.focusAreas)
    ? (strat.focusAreas.filter((s) => typeof s === 'string') as string[])
    : [];

  return { questions, requirementsSummary, focusAreas, domainKey };
}

/** NEVER THROWS. */
export async function runInterviewEvaluation(
  session: InterviewSession,
  turns: TranscriptTurn[],
  deterministicScore: InterviewScore,
  durationSec: number | null,
  requestId: string,
): Promise<EvaluationResult> {
  const locale = session.language || 'en';
  const candidateName = session.candidateName ?? '';
  const role = session.role ?? '';
  const interviewType = session.interviewType ?? 'behavioral';
  const { questions, requirementsSummary, focusAreas, domainKey } = extractBlueprint(session);

  // Resolve the interviewer archetype from the persona so the report grades and
  // frames feedback through the SAME lens the interview was conducted in (e.g. a
  // 'depth' interview penalizes high-level answers; a 'potential' one grades
  // reasoning quality over correctness). Defaults safely when persona is unknown.
  const playbook = getArchetype(findPersona(session.personaId ?? '')?.archetype);
  // Domain lens: the same field-expert playbook that shaped the questions also
  // shapes the grading — appended so the archetype lens keeps precedence on
  // style while the domain lens adds field-authenticity judgment.
  const domainExpert = getDomainExpert(domainKey);
  const evaluationLens = domainExpert
    ? `${playbook.evaluationLens}\n\nDomain lens (${domainExpert.labelEn}): ${domainExpert.evaluationLens}`
    : playbook.evaluationLens;
  const archetypeLabel = playbook.labelEn;
  const primaryDimensions = playbook.primaryDimensions;

  // ── Too-short guard: don't spend 3 LLM calls evaluating nothing ──
  // An abandoned/no-show session reaches finalize with zero (or near-zero)
  // candidate answers. The agents have no rule for scoring an empty transcript
  // and the prompt even licenses overriding the deterministic 0 — so skip the
  // LLM stage entirely and report honestly from the deterministic baseline.
  const substantiveAnswers = turns.filter(
    (t) => t.role === 'candidate' && !t.interim && countWordEquivalents(t.text ?? '', locale) >= 3,
  ).length;
  if (substantiveAnswers < 2) {
    logger.info('INTERVIEW_EVAL', 'Transcript too short — skipping LLM evaluation', {
      sessionId: session.id,
      substantiveAnswers,
      turns: turns.length,
    });
    const holistic = deterministicToHolistic(deterministicScore);
    const summary = TOO_SHORT_SUMMARY[normalizeScorerLocale(locale)];
    const richReport: RichInterviewReport = {
      version: '2',
      generatedAt: new Date().toISOString(),
      language: locale,
      durationSec,
      overall: holistic.overall,
      breakdown: holistic.breakdown,
      strengths: holistic.strengths,
      gaps: holistic.gaps,
      summary,
      recommendations: [],
      questionAnalysis: [],
      deterministicBaseline: { overall: deterministicScore.overall, breakdown: deterministicScore.breakdown },
      degraded: false,
      tooShort: true,
    };
    return {
      richReport,
      flat: { overall: holistic.overall, breakdown: holistic.breakdown, strengths: holistic.strengths, gaps: holistic.gaps, summary },
    };
  }

  let degraded = false;
  const failedSections: ReportSection[] = [];

  // ── Phase 1: holistic + per-question, in parallel ──
  const [holistic, questionAnalysis] = await Promise.all([
    holisticScorecardAgent
      .run(
        { role, interviewType, candidateName, requirementsSummary, focusAreas, transcript: turns, deterministicScore, evaluationLens, archetypeLabel, primaryDimensions },
        { requestId, locale },
      )
      .catch((err) => {
        degraded = true;
        failedSections.push('holistic');
        logger.warn('INTERVIEW_EVAL', 'HolisticScorecardAgent fallback', {
          sessionId: session.id, error: err instanceof Error ? err.message : String(err),
        });
        return deterministicToHolistic(deterministicScore);
      }),
    questionDeepDiveAgent
      .run(
        { role, interviewType, candidateName, blueprintQuestions: questions, transcript: turns, evaluationLens, archetypeLabel },
        { requestId, locale },
      )
      .catch((err) => {
        degraded = true;
        failedSections.push('questionAnalysis');
        logger.warn('INTERVIEW_EVAL', 'QuestionDeepDiveAgent fallback', {
          sessionId: session.id, error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }),
  ]);

  // Re-assert sequential questionIndex (defensive — parseOutput already assigns).
  questionAnalysis.forEach((q, i) => { q.questionIndex = i; });

  // Archetype-weighted headline: the agent's parse-time reconcile guards the
  // overall against the EQUAL-weight breakdown mean, which silently neutralizes
  // the archetype's primaryDimensions (a depth interview should weight
  // specificity). Recompute the headline here — primary dimensions count
  // double — so the lens the interview was conducted in actually moves the
  // number. Per-dimension values (the LLM's judgment) are untouched.
  if (holistic.breakdown.length === DIMENSION_KEYS.length && primaryDimensions.length) {
    let weightSum = 0;
    let acc = 0;
    for (const b of holistic.breakdown) {
      const w = primaryDimensions.includes(b.key) ? 2 : 1;
      weightSum += w;
      acc += b.value * w;
    }
    if (weightSum > 0) holistic.overall = Math.round(acc / weightSum);
  }

  // ── Phase 2: concrete recommendations, grounded in weak/missed questions ──
  const weakOrMissed = questionAnalysis.filter((q) => q.missed || q.score < 60);
  const recommendations = await recommendationsAgent
    .run(
      {
        role,
        interviewType,
        candidateName,
        overall: holistic.overall,
        gaps: holistic.gaps,
        weakOrMissed,
        breakdown: holistic.breakdown,
        evaluationLens,
        archetypeLabel,
        // The "before" side of every example must quote the candidate verbatim
        // — the transcript is the only legitimate source for those quotes.
        transcriptRendered: renderTranscriptForLLM(turns, candidateName),
      },
      { requestId, locale },
    )
    .catch((err) => {
      degraded = true;
      failedSections.push('recommendations');
      logger.warn('INTERVIEW_EVAL', 'RecommendationsAgent fallback', {
        sessionId: session.id, error: err instanceof Error ? err.message : String(err),
      });
      return [];
    });

  const richReport: RichInterviewReport = {
    version: '2',
    generatedAt: new Date().toISOString(),
    language: locale,
    durationSec,
    overall: holistic.overall,
    breakdown: holistic.breakdown,
    strengths: holistic.strengths,
    gaps: holistic.gaps,
    summary: holistic.summary,
    recommendations,
    questionAnalysis,
    deterministicBaseline: { overall: deterministicScore.overall, breakdown: deterministicScore.breakdown },
    degraded,
    ...(failedSections.length ? { failedSections } : {}),
  };

  return {
    richReport,
    flat: {
      overall: holistic.overall,
      breakdown: holistic.breakdown,
      strengths: holistic.strengths,
      gaps: holistic.gaps,
      summary: holistic.summary,
    },
  };
}
