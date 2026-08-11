'use client';

// /practice/[id]/report — a guided debrief from the Interview Engine.
//
// The report is deliberately ordered like a coach's handoff: one concrete
// homework assignment first, the clearest keep/change signals second, compact
// scores third, and the supporting evidence behind optional disclosures. The
// data lifecycle is unchanged: deterministic scores arrive immediately while
// the richer LLM review and recording continue to poll in the background.

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRightIcon } from '@heroicons/react/24/outline';
import { useTranslations } from 'next-intl';

import { Btn } from '../../../../../components/v3/primitives/Btn';
import { Markdown } from '../../../../../components/v3/primitives/Markdown';
import { PageHeader } from '../../../../../components/v3/primitives/PageHeader';
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
import styles from './report.module.css';

const MAX_POLLS = 15;
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

export default function MockReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('practice');

  const [report, setReport] = useState<IEReport | null>(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const pollsRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const nextReport = await interviewEngineApi.report(id);
      setReport(nextReport);
      setError(false);
      return nextReport;
    } catch {
      setError(true);
      return null;
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // The recording (egress webhook) and LLM enrichment both arrive shortly
  // after the interview. Retry while either is pending, but cap the polling so
  // legacy or failed sessions settle into a recoverable manual-refresh state.
  useEffect(() => {
    if (!report || gaveUp) return;
    const session = report.session;
    const needMore =
      session.status !== 'completed' ||
      !!session.reportPending ||
      (!report.recordingUrl && session.recordingAvailable);
    if (!needMore) return;
    if (pollsRef.current >= MAX_POLLS) {
      setGaveUp(true);
      return;
    }
    const delay = session.status !== 'completed' ? 3000 : 4000;
    const timer = window.setTimeout(() => {
      pollsRef.current += 1;
      void load();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [report, load, gaveUp]);

  const refresh = async () => {
    setGaveUp(false);
    pollsRef.current = 0;
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (error) {
    return (
      <div className={styles.report}>
        <PageHeader title={t('report.title')} />
        <section className={styles.messageCard} role="alert">
          <p>{t('report.error')}</p>
          <Btn variant="primary" as="a" href="/practice">
            {t('report.newInterview')}
          </Btn>
        </section>
      </div>
    );
  }

  if (!report) {
    return (
      <div className={styles.report} aria-busy="true" aria-live="polite">
        <PageHeader eyebrowLive title={t('report.title')} />
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
  const hasDeepDive =
    hasRecommendations ||
    hasQuestionAnalysis ||
    Boolean(report.recordingUrl) ||
    hasTranscript;
  const outcomeDiagnosis =
    session.gaps[0] ||
    breakdown[0]?.note ||
    session.summary ||
    t('report.sub');
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

  if (isNoAnswerReport) {
    return (
      <div className={styles.report}>
        <PageHeader
          eyebrow={`${session.role} · ${t(`setup.modeShort.${session.mode}`)}`}
          title={t('report.title')}
        />
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

  return (
    <div className={styles.report}>
      <PageHeader
        eyebrow={`${session.role} · ${t(`setup.modeShort.${session.mode}`)}`}
        title={t('report.title')}
      />

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

      <section
        className={styles.outcomeLine}
        aria-label={`${t('report.overall')}: ${overall}/100`}
      >
        <span>{overall}<small>/100</small></span>
        <div>
          <Markdown>{outcomeDiagnosis}</Markdown>
        </div>
      </section>

      <section className={styles.homework} aria-labelledby="report-homework-title">
        <div className={styles.homeworkCopy}>
          <div className={styles.homeworkKicker}>
            <span aria-hidden="true">01</span>
            {homework
              ? t(`report.recommendations.priority.${homework.priority}`)
              : t('report.recommendations.title')}
          </div>
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
            <article className={`${styles.signalCard} ${styles.signalGood}`}>
              <header>
                <span className={styles.signalIndex} aria-hidden="true">02</span>
                <div>
                  <h2>{t('report.strengths')}</h2>
                  <p>{t('report.keepThese')}</p>
                </div>
              </header>
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
            <article className={`${styles.signalCard} ${styles.signalImprove}`}>
              <header>
                <span className={styles.signalIndex} aria-hidden="true">03</span>
                <div>
                  <h2>{t('report.sharpen')}</h2>
                  {session.gaps.length > 0 ? (
                    <p>{t('report.topN', { count: session.gaps.length })}</p>
                  ) : null}
                </div>
              </header>
              {session.gaps[0] ? (
                <div className={styles.signalLead}>
                  <Markdown block>{session.gaps[0]}</Markdown>
                </div>
              ) : null}
              {showCoachingPath ? (
                <div className={styles.coachingPath}>
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

      <section className={styles.scoreSection} aria-labelledby="report-score-title">
        <div className={styles.scoreIntro}>
          <span
            className={styles.scoreNumber}
            role="progressbar"
            aria-label={t('report.overall')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={overall}
          >
            {overall}
          </span>
          <div>
            <h2 id="report-score-title">{t('report.overall')}</h2>
            <p>{t('report.sub')}</p>
          </div>
        </div>
        {breakdown.length > 0 ? (
          <div className={styles.scoreRows}>
            {breakdown.map((item) => (
              <div className={styles.scoreRow} key={item.key}>
                <div className={styles.scoreQuestion}>
                  <span>{item.key}</span>
                  {item.note ? <Markdown>{item.note}</Markdown> : null}
                </div>
                <span
                  className={styles.scoreValue}
                  role="progressbar"
                  aria-label={item.key}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={item.value}
                >
                  {item.value}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {hasDeepDive ? (
        <section className={styles.deepDive} aria-label={t('report.recommendations.title')}>
        {hasRecommendations ? <details className={styles.disclosure}>
          <summary>
            <span className={styles.disclosureTitle}>
              <span>{t('report.recommendations.title')}</span>
              <small>{t('report.recommendations.sub')}</small>
            </span>
          </summary>
          <div className={styles.disclosureBody}>
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
        </details> : null}

        {hasQuestionAnalysis ? (
          <details className={styles.disclosure}>
            <summary>
              <span className={styles.disclosureTitle}>
                <span>{t('report.questionBreakdown.title')}</span>
                <small>
                  {t('report.questionBreakdown.count', {
                    count: session.questionAnalysis!.length,
                  })}
                </small>
              </span>
            </summary>
            <div className={styles.disclosureBody}>
              <QuestionBreakdownSection
                items={session.questionAnalysis}
                enrichmentPending={reviewPending}
                showHeading={false}
                defaultOpenFirst={false}
              />
            </div>
          </details>
        ) : null}

        {report.recordingUrl ? (
          <details className={styles.disclosure}>
            <summary>
              <span className={styles.disclosureTitle}>
                <span>{t('report.recording')}</span>
                <small>{t(`setup.modeShort.${session.mode}`)}</small>
              </span>
            </summary>
            <div className={styles.mediaBody}>
              {session.mode === 'video' ? (
                <video controls preload="metadata" src={report.recordingUrl} />
              ) : (
                <audio controls preload="metadata" src={report.recordingUrl} />
              )}
            </div>
          </details>
        ) : null}

        {hasTranscript ? <div className={styles.transcriptShell}>
          <TranscriptViewer
            turns={report.transcript}
            transcriptUrl={report.transcriptUrl}
          />
        </div> : null}
      </section>
      ) : null}
    </div>
  );
}
