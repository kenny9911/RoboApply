'use client';

// JobDetailModal — the full job posting behind a match card, in a V3 modal.
// Opened from a card's "View detail" action. Shows the REAL posting the agent
// surfaced (jsearch / gohire rows): description / responsibilities /
// qualifications / benefits (all markdown, block-rendered + sanitized), a meta
// line (company · location · salary · work type · posted), a link out to the
// original posting (job.applyUrl), and the same Apply action as the card.
//
// Purely presentational: it receives the RAJob the expanded card already loaded
// via useJobDetail, so opening the modal costs no extra request.

import { useTranslations } from 'next-intl';

import { Btn, Markdown, Modal, IconBolt, IconCheck } from '../primitives';
import type { RAJob } from '../../../lib/api/v2';
import { formatSalary, postedAge } from './lib';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The full job (from useJobDetail). Null while it's still loading. */
  job: RAJob | null;
  loading: boolean;
  /** True once this job has been applied to (hides the Apply action). */
  applied: boolean;
  applying: boolean;
  onApply: () => void;
}

export function JobDetailModal({
  open,
  onClose,
  job,
  loading,
  applied,
  applying,
  onApply,
}: Props) {
  const t = useTranslations('today');

  const salary = job
    ? formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency)
    : null;

  const workLabel = job
    ? job.workType === 'remote'
      ? t('work.remote')
      : job.workType === 'hybrid'
        ? t('work.hybrid')
        : t('work.onsite')
    : null;

  let postedLabel: string | null = null;
  if (job) {
    const age = postedAge(job.postedAt);
    postedLabel =
      age.key === 'unknown'
        ? null
        : age.key === 'justNow'
          ? t('posted.justNow')
          : age.key === 'hoursAgo'
            ? t('posted.hoursAgo', { count: age.count })
            : t('posted.daysAgo', { count: age.count });
  }

  const meta = job
    ? [job.companyName, job.location, salary, workLabel, postedLabel]
        .filter(Boolean)
        .join('  ·  ')
    : '';

  const sections = job
    ? [
        { label: t('detail.description'), body: job.description },
        { label: t('detail.responsibilities'), body: job.responsibilities },
        { label: t('detail.qualifications'), body: job.qualifications },
        { label: t('detail.benefits'), body: job.benefits },
      ].filter((s) => s.body && s.body.trim())
    : [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      maxWidth="xl"
      title={job?.title ?? t('thinking')}
      description={meta || undefined}
      footer={
        job ? (
          <>
            <Btn
              as="a"
              variant="ghost"
              href={job.applyUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('detail.viewOriginal')}
            </Btn>
            {applied ? (
              <span className="match-status applied" style={{ padding: '0 4px' }}>
                <IconCheck size={12} strokeWidthValue={3} /> {t('status.applied')}
              </span>
            ) : (
              <Btn
                variant="primary"
                icon={<IconBolt size={14} />}
                disabled={applying}
                onClick={onApply}
              >
                {applying ? t('actions.applying') : t('actions.applyNow')}
              </Btn>
            )}
          </>
        ) : null
      }
    >
      {!job ? (
        <div style={{ color: 'var(--muted)', padding: '24px 0' }}>
          {loading ? t('thinking') : t('noReasoning')}
        </div>
      ) : (
        <div
          style={{
            maxHeight: 'min(56vh, 540px)',
            overflowY: 'auto',
            paddingRight: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 22,
            color: 'var(--text)',
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          {sections.map((s, i) => (
            <section key={i}>
              <h3
                style={{
                  fontFamily: 'var(--sans)',
                  fontSize: 11.5,
                  fontWeight: 700,
                  letterSpacing: '0.09em',
                  textTransform: 'uppercase',
                  color: 'var(--muted)',
                  margin: '0 0 8px',
                }}
              >
                {s.label}
              </h3>
              <Markdown block>{s.body as string}</Markdown>
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
}
