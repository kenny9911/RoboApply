'use client';

// OnboardingJobCard — one recommended job inside the onboarding chat.
// Shows the match score, the in-locale "why matched" blurb (markdown-inline,
// rendered ONLY through the sanitized Markdown primitive), a truthful
// "via {publisher}" attribution line for external (jsearch) jobs, and
// Save / Pass actions. External apply links open `_blank` with
// `rel="noopener nofollow"` — never bare anchors.

import { useTranslations } from 'next-intl';

import { Markdown } from '../primitives/Markdown';
import type { OnboardingJobCard as OnboardingJobCardData } from '../../../lib/api/v2/types';

interface Props {
  job: OnboardingJobCardData;
  saved: boolean;
  passed: boolean;
  onSave: (job: OnboardingJobCardData) => void;
  onPass: (job: OnboardingJobCardData) => void;
}

function formatSalary(job: OnboardingJobCardData): string | null {
  if (job.salaryMin == null && job.salaryMax == null) return null;
  const fmt = (n: number) => n.toLocaleString();
  const range =
    job.salaryMin != null && job.salaryMax != null
      ? `${fmt(job.salaryMin)}–${fmt(job.salaryMax)}`
      : job.salaryMin != null
        ? `${fmt(job.salaryMin)}+`
        : `≤${fmt(job.salaryMax as number)}`;
  return job.salaryCurrency ? `${job.salaryCurrency} ${range}` : range;
}

export function OnboardingJobCard({ job, saved, passed, onSave, onPass }: Props) {
  const t = useTranslations('onboarding.chat');
  const salary = formatSalary(job);

  return (
    <div
      data-testid="onboarding-job-card"
      style={{
        border: '1px solid var(--rule)',
        borderRadius: 12,
        padding: '14px 16px',
        background: 'var(--surface-2)',
        minWidth: 240,
        maxWidth: 300,
        flex: '0 0 auto',
        textAlign: 'left',
        opacity: passed ? 0.45 : 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              fontSize: 14.5,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {job.title}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
            {job.companyName}
            {job.location ? ` · ${job.location}` : ''}
          </div>
        </div>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11.5,
            fontWeight: 700,
            color: 'var(--accent-text)',
            whiteSpace: 'nowrap',
          }}
        >
          {t('card_match', { score: job.matchScore })}
        </span>
      </div>

      {salary ? (
        <div style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text-2)' }}>
          {salary}
        </div>
      ) : null}

      <p style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5, margin: 0 }}>
        <Markdown>{job.whyMatched}</Markdown>
      </p>

      {job.isExternal && job.sourcePublisher ? (
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {t('card_via', { publisher: job.sourcePublisher })}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, marginTop: 'auto', alignItems: 'center' }}>
        <button
          type="button"
          className="btn primary"
          style={{ fontSize: 12.5, padding: '6px 12px' }}
          disabled={saved || passed}
          onClick={() => onSave(job)}
        >
          {saved ? t('card_saved') : t('card_save')}
        </button>
        <button
          type="button"
          className="btn ghost"
          style={{ fontSize: 12.5, padding: '6px 12px' }}
          disabled={saved || passed}
          onClick={() => onPass(job)}
        >
          {passed ? t('card_passed') : t('card_pass')}
        </button>
        {job.isExternal && job.applyUrl ? (
          <a
            href={job.applyUrl}
            target="_blank"
            rel="noopener nofollow"
            style={{
              fontSize: 12,
              color: 'var(--accent-text)',
              textDecoration: 'underline',
              marginLeft: 'auto',
            }}
          >
            {t('card_apply')}
          </a>
        ) : null}
      </div>
    </div>
  );
}
