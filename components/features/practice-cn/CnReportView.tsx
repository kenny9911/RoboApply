'use client';

// CnReportView — the GoApply AI-interview practice blocks (WP-66), from a
// report block (`CnPracticeReport`):
//   1. three areas: communication, logic and structure, story answers —
//      each with its value ("—" when unknown, never 0) and its source line;
//   2. the STAR check on story answers, per answer, with the part missing
//      most and one tip for it;
//   3. filler-word counts (total, rate, the words used most);
//   4. "How these checks work".
// Presentational. CnReport loads the block for an interview-engine session;
// the written practice can render this view with the block its score returns.
// AiGeneratedBadge (GoApply only) marks every block that shows AI output:
//   - the areas block, when its values came from the AI review;
//   - the STAR block, when it shows recorded question lines — the AI
//     interviewer (voice) or the questions agent (text practice) may have
//     written them; a note says the checks themselves are keyword checks.
// The STAR marks, the filler counts and their summaries are plain keyword
// checks on the user's own words, so the filler block carries no AI label.
// `typed` (the written practice): the answers were typed, so the filler note
// says so and does not mention speech-to-text.

import { useTranslations } from 'next-intl';

import { AiGeneratedBadge } from '../market';
import type { CnAreaScore, CnPracticeReport, StarPart } from './rubric';
import styles from './practiceCn.module.css';

const STAR_ORDER: readonly StarPart[] = ['situation', 'task', 'action', 'result'];

export interface CnReportViewProps {
  report: CnPracticeReport;
  /** The answers were typed (the written practice), not transcribed from speech. Default false. */
  typed?: boolean;
}

function AreaCard({ area }: { area: CnAreaScore }) {
  const t = useTranslations('practiceCn.report.areas');
  const value = typeof area.value === 'number' && Number.isFinite(area.value)
    ? Math.max(0, Math.min(100, Math.round(area.value)))
    : null;
  return (
    <li className={styles.area} data-cn-area={area.key}>
      <p className={styles.areaLabel}>{t(area.key)}</p>
      <p className={styles.areaValue} data-testid={`cn-area-${area.key}`}>
        {value === null ? '—' : t('value', { value })}
      </p>
      <div className={styles.meter} aria-hidden="true">
        {value === null ? null : <span className={styles.meterFill} style={{ width: `${value}%` }} />}
      </div>
      <p className={styles.areaHint}>{t(`${area.key}Hint`)}</p>
      <p className={styles.source}>{t(`basis.${area.basis}`)}</p>
    </li>
  );
}

export function CnReportView({ report, typed = false }: CnReportViewProps) {
  const t = useTranslations('practiceCn.report');
  const answered = report.answers.length > 0;
  const aiAreas = report.areas.some((a) => a.basis === 'ai_review' || a.basis === 'mixed');
  const stories = report.answers.filter((a) => a.star !== null);
  const aiQuestions = stories.some((a) => !!a.question);
  const rate = report.fillers.per100;

  return (
    <section className={styles.report} aria-labelledby="cn-report-title" data-testid="cn-report">
      <header className={styles.head}>
        <h2 id="cn-report-title" className={styles.title}>{t('title')}</h2>
        <p className={styles.format}>{t('format')}</p>
      </header>

      {!answered ? <p className={styles.empty} data-testid="cn-report-empty">{t('noAnswers')}</p> : null}

      <div className={styles.block} {...(aiAreas ? { 'data-ai-block': 'cn-areas' } : {})}>
        <div className={styles.blockHead}>
          <h3 className={styles.blockTitle}>{t('areas.title')}</h3>
          {aiAreas ? <AiGeneratedBadge /> : null}
        </div>
        <ul className={styles.areas}>
          {report.areas.map((area) => <AreaCard key={area.key} area={area} />)}
        </ul>
      </div>

      <div className={styles.block} {...(aiQuestions ? { 'data-ai-block': 'cn-star-questions' } : {})}>
        <div className={styles.blockHead}>
          <h3 className={styles.blockTitle}>{t('star.title')}</h3>
          {aiQuestions ? <AiGeneratedBadge /> : null}
        </div>
        <p className={styles.text}>{t('star.explain')}</p>
        {aiQuestions ? <p className={styles.source} data-testid="cn-star-question-source">{t('star.questionSource')}</p> : null}
        {report.star.storyAnswers === 0 ? (
          <p className={styles.text} data-testid="cn-star-none">{t('star.none')}</p>
        ) : (
          <>
            <p className={styles.summary} data-testid="cn-star-summary">
              {t('star.summary', { complete: report.star.complete, total: report.star.storyAnswers })}
            </p>
            {report.star.missingMost ? (
              <p className={styles.text} data-testid="cn-star-missing">
                {t('star.missingMost', { part: t(`star.part.${report.star.missingMost}`) })}{' '}
                {t(`star.tip.${report.star.missingMost}`)}
              </p>
            ) : null}
            <ol className={styles.answers}>
              {stories.map((a) => (
                <li key={a.index} className={styles.answer}>
                  <p className={styles.answerLabel}>{t('star.answer', { n: a.index + 1 })}</p>
                  <p className={styles.question}>
                    {a.question ? t('star.question', { question: a.question }) : t('star.noQuestion')}
                  </p>
                  <ul className={styles.parts} aria-label={t('star.title')}>
                    {STAR_ORDER.map((part) => {
                      const found = a.star![part];
                      const label = t(`star.part.${part}`);
                      return (
                        <li
                          key={part}
                          className={found ? styles.partFound : styles.partMissing}
                          data-star-part={part}
                          data-found={found ? 'true' : 'false'}
                        >
                          <span aria-hidden="true">{found ? '✓' : '–'}</span>
                          {found ? t('star.found', { part: label }) : t('star.missing', { part: label })}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>

      <div className={styles.block}>
        <h3 className={styles.blockTitle}>{t('fillers.title')}</h3>
        <p className={styles.summary} data-testid="cn-fillers-total">
          {t('fillers.total', { count: report.fillers.total })}
          {report.fillers.total > 0 && rate !== null ? (
            <span className={styles.rate}>
              {' · '}
              {report.fillers.unit === 'chars' ? t('fillers.rateChars', { rate }) : t('fillers.rateWords', { rate })}
            </span>
          ) : null}
        </p>
        {report.fillers.top.length ? (
          <div className={styles.fillerRow}>
            <span className={styles.text}>{t('fillers.top')}</span>
            <ul className={styles.chips}>
              {report.fillers.top.slice(0, 6).map((hit) => (
                <li key={hit.word} className={styles.chip} data-filler={hit.word}>
                  {t('fillers.item', { word: hit.word, count: hit.count })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className={styles.source} data-testid="cn-fillers-note">{t(typed ? 'fillers.noteTyped' : 'fillers.note')}</p>
      </div>

      <details className={styles.how}>
        <summary className={styles.howSummary}>{t('how.summary')}</summary>
        <p className={styles.text}>{t(aiAreas ? 'how.areasAi' : 'how.areasText')}</p>
        <p className={styles.text}>{t('how.star')}</p>
        <p className={styles.text}>{t('how.fillers')}</p>
      </details>
    </section>
  );
}

export default CnReportView;
