'use client';

// CoverLetterHub — /resume/letters (WP-37; F-RES-02 "Cover letters" tab, F-CL-01).
// The user's letters, newest first, and the "Write a cover letter" form. A
// job page links here with `?jobId=` (and the tracker drawer with `&entry=`)
// so the form opens for that job.

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { Btn, EmptyState, PageHeader } from '../../v3/primitives';
import { AiGeneratedBadge } from '../market';
import { useCoverLetterList } from '../../../hooks/coverletter/useCoverLetters';
import type { CoverLetterView } from '../../../lib/api/contracts/coverletter';
import { NewLetterForm } from './NewLetterForm';
import { coverLetterHref } from './links';
import styles from './CoverLetter.module.css';

export interface CoverLetterHubProps {
  /** Open the form for this job (from `?jobId=`). */
  jobId?: string | null;
  /** Attach the new letter to this application (from `?entry=`). */
  trackerEntryId?: string | null;
}

export function CoverLetterHub({ jobId, trackerEntryId }: CoverLetterHubProps) {
  const t = useTranslations('coverLetter');
  const format = useFormatter();
  const router = useRouter();
  const list = useCoverLetterList();
  const [formOpen, setFormOpen] = useState(Boolean(jobId));

  const pages = list.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  // Until the list answers, the AI state is unknown: show the form but let the server decide.
  const aiAvailable = pages[0]?.aiAvailable ?? true;

  const onCreated = (letter: CoverLetterView) => {
    router.push(coverLetterHref(letter.id, trackerEntryId));
  };

  return (
    <div className={styles.page}>
      <a href="/resume" className={styles.backLink}>
        {t('hub.backToResumes')}
      </a>
      <PageHeader
        eyebrow={t('hub.eyebrow')}
        title={t('hub.title')}
        sub={formOpen ? t('hub.sub') : undefined}
        actions={
          formOpen ? undefined : (
            <Btn variant="primary" onClick={() => setFormOpen(true)}>
              {t('hub.new')}
            </Btn>
          )
        }
      />
      {!formOpen ? <p className={styles.body}>{t('hub.sub')}</p> : null}

      {formOpen ? (
        <NewLetterForm jobId={jobId} trackerEntryId={trackerEntryId} aiAvailable={aiAvailable} onCreated={onCreated} onCancel={() => setFormOpen(false)} />
      ) : null}

      <section aria-labelledby="cl-list-title" className={styles.stack}>
        <h2 id="cl-list-title" className={styles.cardTitle}>
          {t('hub.listLabel')}
        </h2>
        {list.isLoading ? (
          <p className={styles.muted} role="status">
            {t('hub.loading')}
          </p>
        ) : list.isError ? (
          <div className={styles.row}>
            <p className={styles.error} role="alert">
              {t('hub.loadError')}
            </p>
            <Btn onClick={() => void list.refetch()}>{t('hub.retry')}</Btn>
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title={t('hub.emptyTitle')}
            sub={t('hub.emptySub')}
            action={
              formOpen ? undefined : (
                <Btn variant="primary" onClick={() => setFormOpen(true)}>
                  {t('hub.new')}
                </Btn>
              )
            }
          />
        ) : (
          <ul className={styles.list}>
            {items.map((l) => {
              const title = l.title || t('hub.untitled');
              return (
                <li key={l.id}>
                  <a className={styles.letterLink} href={coverLetterHref(l.id)} aria-label={t('hub.open', { title })}>
                    <span className={styles.letterTitle}>
                      {title} <AiGeneratedBadge kind="document" />
                    </span>
                    <span className={styles.muted}>
                      {t('hub.updated', { when: format.dateTime(new Date(l.updatedAt), { dateStyle: 'medium' }) })} · {t(`tone.${l.tone}`)} · {t(`length.${l.length}`)}
                    </span>
                    <p className={styles.preview}>{l.preview}</p>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
        {list.hasNextPage ? (
          <div>
            <Btn onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
              {t('hub.loadMore')}
            </Btn>
          </div>
        ) : null}
      </section>
    </div>
  );
}
