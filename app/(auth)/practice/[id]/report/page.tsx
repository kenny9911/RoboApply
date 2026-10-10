'use client';

// /practice/[id]/report — a guided debrief from the Interview Engine.
//
// The report is deliberately ordered like a coach's handoff: one concrete
// homework assignment first, the clearest keep/change signals second, compact
// scores third, and the supporting evidence behind optional disclosures. The
// data lifecycle is unchanged: deterministic scores arrive immediately while
// the richer LLM review and recording continue to poll in the background.
//
// WP-43: the report ends with one line — "Practice again for this job" and
// the credit path (PracticeReportEnd) — shows "Recording off" when the user
// did not consent to a recording (H8), renders WP-72's coach line, WP-66's
// GoApply blocks (CnReport) and the AI-generated label on GoApply. Scores are
// described as scores of this practice, never as a prediction (C16).

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRightIcon } from '@heroicons/react/24/outline';
import { useTranslations } from 'next-intl';

import { Btn } from '../../../../../components/v3/primitives/Btn';
import { Markdown } from '../../../../../components/v3/primitives/Markdown';
import { useMockRoleLabels } from '../../../../../lib/mockRoleLabels';
import {
  QuestionBreakdownSection,
  TranscriptViewer,
} from '../../../../../components/v3/mock';
import {
  interviewEngineApi,
  type IEDimensionKey,
  type IERecommendation,
  type IERecommendationPriority,
  type IEReport,
} from '../../../../../lib/api/interviewEngine';
import { canonicalDimKey } from '../../../../../lib/mock/dimensionLabels';
import * as interviewEngineModule from '../../../../../lib/api/interviewEngine';
import type { PracticeSessionInfo } from '../../../../../lib/api/interviewEngine';
import { PracticeReportEnd } from '../../../../../components/features/practice';
import { CnReport } from '../../../../../components/features/practice-cn';
import { AiGeneratedBadge } from '../../../../../components/features/market';
import { useBrand } from '../../../../../lib/brand';
import styles from './report.module.css';

// Poll with exponential backoff while the server finalizes and the review is
// written: quick at first (the score usually lands within seconds of End),
// then slower, for about three minutes in total. After that the page settles
// into a manual Refresh.
const POLL_FIRST_MS = 2_000;
const POLL_MAX_MS = 20_000;
const POLL_BUDGET_MS = 3 * 60_000;

function nextPollDelay(attempt: number): number {
  return Math.min(POLL_MAX_MS, Math.round(POLL_FIRST_MS * 1.5 ** attempt));
}

const PRIORITY_ORDER: Record<IERecommendationPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function orderedRecommendations(recommendations: IERecommendation[] | null) {
  if (recommendations === null) return null;
  return recommendations
    .map((recommendation, index) => ({ recommendation, index }))
    .sort((a, b) => {
      const priorityDelta =
        PRIORITY_ORDER[a.recommendation.priority] - PRIORITY_ORDER[b.recommendation.priority];
      return priorityDelta || a.index - b.index;
    })
    .map(({ recommendation }) => recommendation);
}

/** The practice extras for a session (job, recording consent); null when unavailable. */
async function loadPracticeInfo(sessionId: string): Promise<PracticeSessionInfo | null> {
  try {
    const res = await interviewEngineModule.practiceApi.info(sessionId);
    return res.practice ?? null;
  } catch {
    // Extras are optional: the report renders without them.
    return null;
  }
}

export default function MockReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('practice');
  const { localizeRole } = useMockRoleLabels();
  const brand = useBrand();
  const [practiceInfo, setPracticeInfo] = useState<PracticeSessionInfo | null>(null);

  const [report, setReport] = useState<IEReport | null>(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  // Named rather than indexed: which sections exist depends on what the
  // enrichment produced, and it can grow while the page is open.
  const [tab, setTab] = useState<string | null>(null);
  const pollsRef = useRef(0);
  const pollStartRef = useRef(Date.now());
  // Bumped after every load (success or failure) so the poll effect re-arms
  // even when the payload did not change.
  const [loadTick, setLoadTick] = useState(0);
  const reportRef = useRef<IEReport | null>(null);

  const load = useCallback(async () => {
    try {
      const nextReport = await interviewEngineApi.report(id);
      reportRef.current = nextReport;
      setReport(nextReport);
      setError(false);
      return nextReport;
    } catch {
      // A failed poll keeps what is already on screen; only a page with
      // nothing to show turns into the error state.
      if (!reportRef.current) setError(true);
      return null;
    } finally {
      setLoadTick((n) => n + 1);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Practice extras: once, and again when the session reaches 'completed'.
  const sessionStatus = report?.session.status ?? null;
  useEffect(() => {
    if (!sessionStatus) return;
    let cancelled = false;
    void loadPracticeInfo(id).then((info) => {
      if (!cancelled && info) setPracticeInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, [id, sessionStatus]);

  // Right after End the session is still finalizing; the recording (egress
  // webhook) and the written review arrive later still. Keep polling while
  // any of them is pending, backing off, then settle into manual Refresh.
  useEffect(() => {
    if (gaveUp) return;
    if (!report && !error) return; // the first load is still in flight
    const session = report?.session;
    const needMore = !session
      ? true
      : (session.status !== 'completed' && session.status !== 'failed' && session.status !== 'expired') ||
        (session.status === 'completed' && session.overall == null && !('reportTooShort' in session && session.reportTooShort)) ||
        !!session.reportPending ||
        (!report!.recordingUrl && session.recordingAvailable);
    if (!needMore) return;
    if (Date.now() - pollStartRef.current >= POLL_BUDGET_MS) {
      setGaveUp(true);
      return;
    }
    const timer = window.setTimeout(() => {
      pollsRef.current += 1;
      void load();
    }, nextPollDelay(pollsRef.current));
    return () => window.clearTimeout(timer);
  }, [report, error, load, gaveUp, loadTick]);

  const refresh = async () => {
    setGaveUp(false);
    pollsRef.current = 0;
    pollStartRef.current = Date.now();
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (error && !report) {
    return (
      <div className={styles.report}>
        <header className={styles.head}>
          <h1>{t('report.title')}</h1>
        </header>
        <section className={styles.messageCard} role="alert">
          <p>{t('report.error')}</p>
          <div className={styles.messageActions}>
            <Btn variant="primary" onClick={() => void refresh()} disabled={refreshing}>
              {refreshing ? t('report.refreshing') : t('report.retry')}
            </Btn>
            <Btn as="a" href="/practice">
              {t('report.newInterview')}
            </Btn>
          </div>
        </section>
      </div>
    );
  }

  if (!report) {
    return (
      <div className={styles.report} aria-busy="true" aria-live="polite">
        <header className={styles.head}>
          <h1>{t('report.title')}</h1>
        </header>
        <section className={styles.loadingCard}>
          <span className={styles.loadingMark} aria-hidden="true" />
          <p>{t('report.loading')}</p>
        </section>
      </div>
    );
  }

  const session = report.session;
  const enrichPending = !!session.reportPending && !gaveUp;
  const stalled =
    gaveUp &&
    session.status === 'completed' &&
    (!!session.reportPending ||
      (session.recordingAvailable && !report.recordingUrl));
  const recommendations = orderedRecommendations(session.recommendations);
  const homework = recommendations?.[0] ?? null;
  const reviewPending = session.status !== 'completed' || enrichPending;
  const hasCandidateAnswer = report.transcript.some(
    (turn) =>
      turn.role === 'candidate' &&
      !turn.interim &&
      turn.text.trim().length > 0,
  );
  const reportTooShort =
    'reportTooShort' in session && Boolean(session.reportTooShort);
  // New reports carry the server's substantive-answer guard. The transcript
  // fallback keeps abandoned legacy sessions honest without briefly showing an
  // empty state while a current report is still being finalized.
  const isNoAnswerReport =
    reportTooShort ||
    (session.status === 'completed' && !reviewPending && !hasCandidateAnswer);
  const overall = Math.max(0, Math.min(100, session.overall ?? 0));
  // No verdict until the session is completed AND scored: a "0/100" while
  // the server is still finalizing reads as a real (terrible) score.
  const scorePending = session.status !== 'completed' || session.overall == null;
  const breakdown = (session.breakdown ?? []).map((item) => {
    const canonicalKey = canonicalDimKey(item.key);
    return {
      key: canonicalKey ? t(`report.dim.${canonicalKey}`) : item.key,
      value: Math.max(0, Math.min(100, item.value)),
      note: item.note,
    };
  });
  const coachingMoment = [...(session.questionAnalysis ?? [])]
    .filter((item) => !item.missed && (item.keyQuote || item.answerSummary))
    .sort((a, b) => a.score - b.score)[0] ?? null;
  const coachingQuote = coachingMoment?.keyQuote || coachingMoment?.answerSummary || '';
  const managerTakeaway = coachingMoment?.correction || coachingMoment?.analysis || '';
  const strongerRewrite = coachingMoment?.modelAnswer || coachingMoment?.suggestion || '';
  const showCoachingPath = Boolean(coachingQuote && managerTakeaway && strongerRewrite);
  const hasQuestionAnalysis = Boolean(session.questionAnalysis?.length);
  const hasRecommendations = Boolean(recommendations?.length);
  const hasTranscript = Boolean(
    report.transcriptUrl ||
    report.transcript.some(
      (turn) =>
        !turn.interim &&
        turn.role !== 'system' &&
        turn.text.trim().length > 0,
    ),
  );
  const outcomeDiagnosis =
    session.gaps[0] ||
    breakdown[0]?.note ||
    session.summary ||
    t('reportEnd.scoreNote');
  const practiceAgainParams = new URLSearchParams({
    role: session.role,
    type: session.interviewType,
    mode: session.mode,
    language: session.language,
    duration: String(session.durationMinutes),
  });
  if (session.personaId) {
    practiceAgainParams.set('interviewer', session.personaId);
  }
  const practiceAgainHref = `/practice?${practiceAgainParams.toString()}`;

  // Contract C10: a session that ended with no recorded answer is 'failed'
  // with error 'no_answer' — never evaluated, never charged.
  if (session.status === 'failed' && session.error === 'no_answer') {
    return (
      <div className={styles.report}>
        <header className={styles.head}>
          <h1>{t('report.title')}</h1>
          <p>
            {localizeRole(session.role)}
            <span aria-hidden> · </span>
            {t(`setup.modeShort.${session.mode}`)}
          </p>
        </header>
        <section className={styles.noAnswerState} aria-labelledby="report-no-answer-title">
          <span className={styles.noAnswerMark} aria-hidden="true">—</span>
          <div className={styles.noAnswerCopy}>
            <h2 id="report-no-answer-title">{t('report.noAnswer.title')}</h2>
            <p>{t('report.noAnswer.body')}</p>
          </div>
          <Btn variant="primary" as="a" href={practiceAgainHref}>
            {t('report.noAnswer.cta')}
          </Btn>
        </section>
      </div>
    );
  }

  if (session.status === 'failed' || session.status === 'expired') {
    return (
      <div className={styles.report}>
        <header className={styles.head}>
          <h1>{t('report.title')}</h1>
          <p>
            {localizeRole(session.role)}
            <span aria-hidden> · </span>
            {t(`setup.modeShort.${session.mode}`)}
          </p>
        </header>
        <section className={styles.noAnswerState} aria-labelledby="report-failed-title">
          <span className={styles.noAnswerMark} aria-hidden="true">—</span>
          <div className={styles.noAnswerCopy}>
            <h2 id="report-failed-title">{t('report.failed.title')}</h2>
            <p>{t('report.failed.body')}</p>
          </div>
          <Btn variant="primary" as="a" href={practiceAgainHref}>
            {t('report.noAnswer.cta')}
          </Btn>
        </section>
      </div>
    );
  }

  if (isNoAnswerReport) {
    return (
      <div className={styles.report}>
        <header className={styles.head}>
          <h1>{t('report.title')}</h1>
          <p>
            {localizeRole(session.role)}
            <span aria-hidden> · </span>
            {t(`setup.modeShort.${session.mode}`)}
          </p>
        </header>
        <section className={styles.noAnswerState} aria-labelledby="report-no-answer-title">
          <span className={styles.noAnswerMark} aria-hidden="true">—</span>
          <div className={styles.noAnswerCopy}>
            <h2 id="report-no-answer-title">{t('report.noScore')}</h2>
            <div>
              {session.summary ? (
                <Markdown block>{session.summary}</Markdown>
              ) : (
                t('report.recommendations.unavailable')
              )}
            </div>
          </div>
          <Btn variant="primary" as="a" href="/practice">
            {t('report.actions.pickSetup')}
          </Btn>
        </section>
      </div>
    );
  }

  const evidenceTabs: Array<{ id: string; label: string; count?: string }> = [
    hasRecommendations
      ? { id: 'steps', label: t('report.recommendations.title'), count: String(recommendations!.length) }
      : null,
    hasQuestionAnalysis
      ? {
        id: 'questions',
        label: t('report.questionBreakdown.title'),
        count: String(session.questionAnalysis!.length),
      }
      : null,
    report.recordingUrl ? { id: 'recording', label: t('report.recording') } : null,
    hasTranscript ? { id: 'transcript', label: t('report.transcript') } : null,
  ].filter(Boolean) as Array<{ id: string; label: string; count?: string }>;

  // H8: a video practice recorded without the camera opt-in is audio only.
  // Sessions from before per-session consent keep their mode.
  const videoRecorded = practiceInfo?.recording.consented
    ? practiceInfo.recording.video
    : session.mode === 'video';

  const activeTab = tab && evidenceTabs.some((item) => item.id === tab)
    ? tab
    : evidenceTabs[0]?.id ?? '';

  return (
    <div className={styles.report}>
      <header className={styles.head}>
        <h1>{t('report.title')}</h1>
        <p>
          {localizeRole(session.role)}
          <span aria-hidden> · </span>
          {t(`setup.modeShort.${session.mode}`)}
          <span aria-hidden> · </span>
          {t('setup.type.minutes', { minutes: session.durationMinutes })}
        </p>
      </header>
      {session.status !== 'completed' ? (
        <div className={styles.statusBanner} role="status">
          <span>{t('report.processing')}</span>
          <Btn variant="default" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? t('report.refreshing') : t('report.refresh')}
          </Btn>
        </div>
      ) : null}

      {session.status === 'completed' && enrichPending ? (
        <div className={styles.pendingBanner} role="status" aria-live="polite">
          <span className={styles.statusDot} aria-hidden="true" />
          <span aria-busy="true">{t('report.analysisPending')}</span>
        </div>
      ) : null}

      {stalled ? (
        <div className={styles.statusBanner} role="status">
          <span>{t('report.analysisStalled')}</span>
          <Btn variant="default" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? t('report.refreshing') : t('report.refreshAnalysis')}
          </Btn>
        </div>
      ) : null}

      {scorePending ? (
        <section
          className={`${styles.verdict} ${styles.verdictPending}`}
          aria-labelledby="report-verdict-title"
          aria-busy={!gaveUp}
        >
          <span className={styles.verdictSkeleton} aria-hidden="true" />
          <div className={styles.verdictCopy}>
            <h2 id="report-verdict-title">{t('report.overall')}</h2>
            <p>{gaveUp ? t('report.analysisStalled') : t('report.scorePending')}</p>
          </div>
        </section>
      ) : (
        <section className={styles.verdict} aria-labelledby="report-verdict-title" data-ai-block="verdict">
          <p
            className={styles.verdictScore}
            role="progressbar"
            aria-labelledby="report-verdict-title"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={overall}
          >
            <strong>{overall}</strong>
            <span>/100</span>
          </p>
          <div className={styles.verdictCopy}>
            <h2 id="report-verdict-title">{t('report.overall')}</h2>
            <Markdown block>{outcomeDiagnosis}</Markdown>
            <AiGeneratedBadge />
          </div>
        </section>
      )}

      <section className={styles.homework} aria-labelledby="report-homework-title" {...(homework ? { 'data-ai-block': 'homework' } : {})}>
        <div className={styles.homeworkCopy}>
          {homework ? (
            <span className={`${styles.priority} ${styles[homework.priority]}`}>
              {t(`report.recommendations.priority.${homework.priority}`)}
            </span>
          ) : null}
          <h2 id="report-homework-title" className={styles.homeworkTitle}>
            {homework ? (
              <Markdown>{homework.title}</Markdown>
            ) : recommendations?.length === 0 ? (
              t('report.recommendations.empty')
            ) : reviewPending ? (
              t('report.recommendations.pending')
            ) : (
              t('report.recommendations.unavailable')
            )}
          </h2>
          {homework ? (
            <div className={styles.homeworkDetail}>
              <Markdown block>{homework.detail}</Markdown>
            </div>
          ) : null}
          {homework ? <AiGeneratedBadge /> : null}
          {homework?.drill ? (
            <div className={styles.drill}>
              <span>{t('report.recommendations.drill')}</span>
              <Markdown block>{homework.drill}</Markdown>
            </div>
          ) : null}
        </div>
        <div className={styles.homeworkAction}>
          <Btn
            variant="primary"
            as="a"
            href={practiceAgainHref}
            icon={<ArrowRightIcon aria-hidden="true" />}
          >
            {t('report.actions.runAgain')}
          </Btn>
        </div>
      </section>

      {(session.strengths.length > 0 || session.gaps.length > 0 || showCoachingPath) ? (
        <section className={styles.signalGrid} aria-label={t('report.title')}>
          {session.strengths.length > 0 ? (
            <article className={`${styles.signalCard} ${styles.signalGood}`} data-ai-block="strengths">
              <header>
                <h2>{t('report.strengths')}</h2>
                <p>{t('report.keepThese')}</p>
              </header>
              <AiGeneratedBadge />
              <div className={styles.signalLead}>
                <Markdown block>{session.strengths[0]}</Markdown>
              </div>
              {session.strengths.length > 1 ? (
                <details className={styles.signalMore}>
                  <summary>{t('report.topN', { count: session.strengths.length })}</summary>
                  <ul>
                    {session.strengths.slice(1).map((strength, index) => (
                      <li key={index}><Markdown>{strength}</Markdown></li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </article>
          ) : null}

          {(session.gaps.length > 0 || showCoachingPath) ? (
            <article className={`${styles.signalCard} ${styles.signalImprove}`} data-ai-block="gaps">
              <header>
                <h2>{t('report.sharpen')}</h2>
                {session.gaps.length > 0 ? (
                  <p>{t('report.topN', { count: session.gaps.length })}</p>
                ) : null}
              </header>
              <AiGeneratedBadge />
              {session.gaps[0] ? (
                <div className={styles.signalLead}>
                  <Markdown block>{session.gaps[0]}</Markdown>
                </div>
              ) : null}
              {showCoachingPath ? (
                <div className={styles.coachingPath} data-ai-block="coaching">
                  <AiGeneratedBadge />
                  <div className={styles.coachingStep}>
                    <span>{t('report.questionBreakdown.keyQuoteLabel')}</span>
                    <blockquote><Markdown block>{coachingQuote}</Markdown></blockquote>
                  </div>
                  <ArrowRightIcon className={styles.coachingArrow} aria-hidden="true" />
                  <div className={styles.coachingStep}>
                    <span>{t('report.questionBreakdown.analysisLabel')}</span>
                    <div><Markdown block>{managerTakeaway}</Markdown></div>
                  </div>
                  <ArrowRightIcon className={styles.coachingArrow} aria-hidden="true" />
                  <div className={styles.coachingStep}>
                    <span>{t('report.questionBreakdown.modelAnswerLabel')}</span>
                    <div><Markdown block>{strongerRewrite}</Markdown></div>
                  </div>
                </div>
              ) : null}
              {session.gaps.length > 1 ? (
                <details className={styles.signalMore}>
                  <summary>{t('report.topN', { count: session.gaps.length })}</summary>
                  <ul>
                    {session.gaps.slice(1).map((gap, index) => (
                      <li key={index}><Markdown>{gap}</Markdown></li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </article>
          ) : null}
        </section>
      ) : null}

      {breakdown.length > 0 ? (
        <section className={styles.scoreSection} aria-labelledby="report-score-title" data-ai-block="scores">
          <div>
            <h2 id="report-score-title">{t('reportEnd.scoresTitle')}</h2>
            <AiGeneratedBadge />
          </div>
          <div className={styles.scoreRows}>
            {breakdown.map((item) => (
              <div className={styles.scoreRow} key={item.key}>
                <div className={styles.scoreQuestion}>
                  <span>{item.key}</span>
                  {item.note ? <Markdown>{item.note}</Markdown> : null}
                </div>
                <div
                  className={styles.scoreMeter}
                  role="progressbar"
                  aria-label={item.key}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={item.value}
                >
                  <span className={styles.scoreTrack} aria-hidden>
                    <span className={styles.scoreFill} style={{ width: `${item.value}%` }} />
                  </span>
                  <span className={styles.scoreValue}>{item.value}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {evidenceTabs.length > 0 ? (
        <section className={styles.evidence} aria-labelledby="report-evidence-title">
          <h2 id="report-evidence-title" className="sr-only">{t('report.evidence')}</h2>

          {/* One tab strip instead of four stacked disclosures: the reader can
              see every piece of evidence that exists before choosing one. */}
          <div className={styles.tabs} role="tablist" aria-labelledby="report-evidence-title">
            {evidenceTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`report-tab-${tab.id}`}
                aria-selected={activeTab === tab.id}
                aria-controls="report-tabpanel"
                tabIndex={activeTab === tab.id ? 0 : -1}
                className={activeTab === tab.id ? styles.tabOn : undefined}
                onClick={() => setTab(tab.id)}
                onKeyDown={(event) => {
                  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
                  if (!keys.includes(event.key)) return;
                  event.preventDefault();
                  const ids = evidenceTabs.map((item) => item.id);
                  const at = ids.indexOf(activeTab);
                  const next = event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? ids.length - 1
                      : event.key === 'ArrowLeft'
                        ? (at - 1 + ids.length) % ids.length
                        : (at + 1) % ids.length;
                  setTab(ids[next]);
                  requestAnimationFrame(() => document.getElementById(`report-tab-${ids[next]}`)?.focus());
                }}
              >
                {tab.label}
                {tab.count ? <span aria-hidden>{tab.count}</span> : null}
              </button>
            ))}
          </div>

          <div
            className={styles.tabPanel}
            id="report-tabpanel"
            role="tabpanel"
            aria-labelledby={`report-tab-${activeTab}`}
            tabIndex={0}
          >
            {activeTab === 'steps' && hasRecommendations ? (
              <div data-ai-block="steps">
                <AiGeneratedBadge />
                <ol className={styles.recommendationList}>
                  {recommendations!.map((recommendation, index) => (
                    <li key={`${recommendation.priority}-${index}`}>
                      <div className={styles.recommendationHead}>
                        <span className={`${styles.priority} ${styles[recommendation.priority]}`}>
                          {t(`report.recommendations.priority.${recommendation.priority}`)}
                        </span>
                        {recommendation.linkedDimension ? (
                          <span className={styles.dimensionTag}>
                            {t(`report.dim.${recommendation.linkedDimension as IEDimensionKey}`)}
                          </span>
                        ) : null}
                      </div>
                      <h3><Markdown>{recommendation.title}</Markdown></h3>
                      <div className={styles.recommendationDetail}>
                        <Markdown block>{recommendation.detail}</Markdown>
                      </div>
                      <div className={styles.example}>
                        <span>{t('report.recommendations.exampleLabel')}</span>
                        <Markdown block>{recommendation.example}</Markdown>
                      </div>
                      {recommendation.drill ? (
                        <div className={styles.recommendationDrill}>
                          <span>{t('report.recommendations.drill')}</span>
                          <Markdown block>{recommendation.drill}</Markdown>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}

            {activeTab === 'questions' && hasQuestionAnalysis ? (
              <div data-ai-block="questions">
                <AiGeneratedBadge />
                <QuestionBreakdownSection
                  items={session.questionAnalysis}
                  enrichmentPending={reviewPending}
                  showHeading={false}
                  defaultOpenFirst
                />
              </div>
            ) : null}

            {activeTab === 'recording' && report.recordingUrl ? (
              <div className={styles.mediaBody}>
                {videoRecorded ? (
                  <video controls preload="metadata" src={report.recordingUrl} />
                ) : (
                  <audio controls preload="metadata" src={report.recordingUrl} />
                )}
              </div>
            ) : null}

            {activeTab === 'transcript' && hasTranscript ? (
              // The interviewer's lines are AI output.
              <div data-ai-block="transcript">
                <AiGeneratedBadge />
                <TranscriptViewer
                  embedded
                  turns={report.transcript}
                  transcriptUrl={report.transcriptUrl}
                />
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {brand.market === 'cn' ? <CnReport sessionId={session.id} /> : null}

      {practiceInfo ? (
        <PracticeReportEnd info={practiceInfo} practiceAgainHref={practiceAgainHref} />
      ) : null}
    </div>
  );
}
