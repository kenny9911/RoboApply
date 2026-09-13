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
import { postedAge } from './lib';
import { CompanyIdentity, JobFacts } from './JobFacts';

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
  const t = useTranslations('jobs');

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
      className="discovery-posting-modal"
      title={job?.title ?? t('thinking')}
      description={postedLabel || undefined}
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
                {applying ? t('actions.applying') : t('actions.applyOnSite')}
              </Btn>
            )}
          </>
        ) : null
      }
    >
      {!job ? (
        <div style={{ color: 'var(--text-muted)', padding: '24px 0' }}>
          {loading ? t('thinking') : t('noReasoning')}
        </div>
      ) : (
        <div className="discovery-posting">
          <div className="discovery-employer">
            <CompanyIdentity name={job.companyName} logoUrl={job.companyLogoUrl} />
            <div><span>{t('discovery.company')}</span><strong>{job.companyName}</strong></div>
          </div>
          <JobFacts job={job} />
          <div className="discovery-posting-layout">
            <nav className="discovery-posting-nav" aria-label={t('discovery.essentials')}>
              {sections.map((section, i) => <a key={section.label} href={`#posting-${job.id}-${i}`}>{section.label}</a>)}
            </nav>
            <div className="discovery-posting-content">
              {sections.map((s, i) => (
                <section key={s.label} id={`posting-${job.id}-${i}`}>
                  <h3>{s.label}</h3>
                  <Markdown block>{s.body as string}</Markdown>
                </section>
              ))}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
