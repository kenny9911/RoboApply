'use client';

// MarketRequirementsPanel — the pre-launch "Market Job Requirements" preview.
// Makes the market-grounding VISIBLE: it shows the role spec + sample opening
// questions the interview will actually be built from, sourced from live
// job-board postings (or the candidate's pasted JD). Purely informational — it
// NEVER gates Launch; any failure collapses to a reassuring line.
//
// All LLM-generated text renders through the sanitized <Markdown> primitive
// (react-markdown + rehype-sanitize + remark-gfm) per the project markdown rule.

import { useTranslations } from 'next-intl';
import { Markdown } from '../primitives/Markdown';
import { Btn } from '../primitives/Btn';
import type { IERequirements } from '../../../lib/api/interviewEngine';

export type PreviewState = 'idle' | 'loading' | 'ready' | 'error';

interface Props {
  state: PreviewState;
  requirements: IERequirements | null;
  webSources: Array<{ title: string; url: string }>;
  sampleQuestions: string[];
  groundedOn?: 'jd' | 'market' | 'role';
  /** False when no role/JD + interviewer + type is chosen yet. */
  canPreview: boolean;
  onPreview: () => void;
  onRetry: () => void;
}

export function MarketRequirementsPanel({
  state,
  requirements,
  webSources,
  sampleQuestions,
  groundedOn,
  canPreview,
  onPreview,
  onRetry,
}: Props) {
  const t = useTranslations('mock');

  return (
    <section className="iv-step">
      <div className="iv-step-head">
        <span className="iv-step-num" aria-hidden>✦</span>
        <div>
          <div className="iv-step-title">{t('setup.preview.title')}</div>
          <div className="iv-step-sub">{t('setup.preview.sub')}</div>
        </div>
        <Btn
          variant="ghost"
          className="iv-preview-btn"
          onClick={onPreview}
          disabled={!canPreview || state === 'loading'}
        >
          {state === 'loading' ? t('setup.preview.loading') : t('setup.preview.previewBtn')}
        </Btn>
      </div>

      {state === 'idle' ? (
        <div className="iv-preview-empty">{t('setup.preview.empty')}</div>
      ) : state === 'loading' ? (
        <div className="iv-preview-loading" role="status" aria-live="polite">
          <span className="iv-preview-bar" />
          <span className="iv-preview-bar" />
          <span className="iv-preview-bar" />
          <span className="iv-preview-loading-text">{t('setup.preview.loading')}</span>
        </div>
      ) : state === 'error' ? (
        <div className="iv-preview-error" role="status">
          <span>{t('setup.preview.error')}</span>
          <Btn variant="ghost" className="iv-preview-retry" onClick={onRetry}>
            {t('setup.preview.retry')}
          </Btn>
        </div>
      ) : requirements ? (
        <div className="iv-preview-grid">
          {groundedOn === 'jd' ? (
            <div className="iv-preview-grounded">{t('setup.preview.fromJd')}</div>
          ) : null}

          {requirements.roleSummary ? (
            <div className="iv-preview-block">
              <div className="iv-preview-label">{t('setup.preview.summaryLabel')}</div>
              <p className="iv-preview-text">
                <Markdown>{requirements.roleSummary}</Markdown>
              </p>
            </div>
          ) : null}

          {requirements.mustHaveSkills.length ? (
            <div className="iv-preview-block">
              <div className="iv-preview-label">{t('setup.preview.skillsLabel')}</div>
              <div className="iv-preview-chips">
                {requirements.mustHaveSkills.map((s, i) => (
                  <span key={i} className="iv-preview-chip">
                    <Markdown>{s}</Markdown>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {requirements.coreResponsibilities.length ? (
            <div className="iv-preview-block">
              <div className="iv-preview-label">{t('setup.preview.respLabel')}</div>
              <ul className="iv-preview-list">
                {requirements.coreResponsibilities.map((r, i) => (
                  <li key={i}>
                    <Markdown>{r}</Markdown>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {requirements.successSignals.length ? (
            <div className="iv-preview-block">
              <div className="iv-preview-label">{t('setup.preview.signalsLabel')}</div>
              <ul className="iv-preview-list">
                {requirements.successSignals.map((r, i) => (
                  <li key={i}>
                    <Markdown>{r}</Markdown>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {sampleQuestions.length ? (
            <div className="iv-preview-block">
              <div className="iv-preview-label">{t('setup.preview.questionsLabel')}</div>
              <ol className="iv-preview-questions">
                {sampleQuestions.slice(0, 3).map((q, i) => (
                  <li key={i}>
                    <Markdown>{q}</Markdown>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          <div className="iv-preview-sources">
            {webSources.length ? (
              <>
                <span className="iv-preview-sources-label">{t('setup.preview.sourcesLabel')}</span>
                {webSources.map((s, i) => (
                  <a
                    key={i}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="iv-preview-src"
                  >
                    {s.title || s.url}
                  </a>
                ))}
              </>
            ) : (
              <span className="iv-preview-sources-label">{t('setup.preview.sourcesGeneric')}</span>
            )}
          </div>
        </div>
      ) : (
        <div className="iv-preview-empty">{t('setup.preview.empty')}</div>
      )}
    </section>
  );
}
