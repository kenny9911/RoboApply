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
  const { localizeRole } = useMockRoleLabels();

  const [report, setReport] = useState<IEReport | null>(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  // Named rather than indexed: which sections exist depends on what the
  // enrichment produced, and it can grow while the page is open.
  const [tab, setTab] = useState<string | null>(null);
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
        <header className={styles.head}>
          <h1>{t('report.title')}</h1>
        </header>
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

      <section className={styles.verdict} aria-labelledby="report-verdict-title">
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
        </div>
      </section>

      <section className={styles.homework} aria-labelledby="report-homework-title">
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
                <h2>{t('report.strengths')}</h2>
                <p>{t('report.keepThese')}</p>
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
                <h2>{t('report.sharpen')}</h2>
                {session.gaps.length > 0 ? (
                  <p>{t('report.topN', { count: session.gaps.length })}</p>
                ) : null}
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

      {breakdown.length > 0 ? (
        <section className={styles.scoreSection} aria-labelledby="report-score-title">
          <h2 id="report-score-title">{t('report.sub')}</h2>
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
            ) : null}

            {activeTab === 'questions' && hasQuestionAnalysis ? (
              <QuestionBreakdownSection
                items={session.questionAnalysis}
                enrichmentPending={reviewPending}
                showHeading={false}
                defaultOpenFirst
              />
            ) : null}

            {activeTab === 'recording' && report.recordingUrl ? (
              <div className={styles.mediaBody}>
                {session.mode === 'video' ? (
                  <video controls preload="metadata" src={report.recordingUrl} />
                ) : (
                  <audio controls preload="metadata" src={report.recordingUrl} />
                )}
              </div>
            ) : null}

            {activeTab === 'transcript' && hasTranscript ? (
              <TranscriptViewer
                embedded
                turns={report.transcript}
                transcriptUrl={report.transcriptUrl}
              />
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
