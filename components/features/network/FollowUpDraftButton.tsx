'use client';

// FollowUpDraftButton — the tracker drawer's "Write a follow-up" (WP-38 →
// WP-54 seam; F-NET-06). Opens a sheet with the message composer set to a
// follow-up for this application; the draft is saved on the tracker entry
// and the user copies it or opens it in their own email app. Renders nothing
// for an application with no job (drafts are written from the job post).
//
//   <FollowUpDraftButton jobId={entry.jobId} trackerEntryId={entry.id} companyName={entry.company} />

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, Sheet } from '../../v3/primitives';
import { useConnectionsForJob, useOutreachDrafts } from '../../../hooks/network';
import { OutreachComposer } from './OutreachComposer';
import styles from './network.module.css';

export interface FollowUpDraftButtonProps {
  jobId: string | null | undefined;
  trackerEntryId: string;
  companyName: string;
  className?: string;
}

export function FollowUpDraftButton({ jobId, trackerEntryId, companyName, className }: FollowUpDraftButtonProps) {
  const t = useTranslations('applications.follow_up');
  const [open, setOpen] = useState(false);
  const people = useConnectionsForJob(jobId, { enabled: open });
  const drafts = useOutreachDrafts({ trackerEntryId }, { enabled: open });
  if (!jobId) return null;
  return (
    <>
      <Btn className={className} onClick={() => setOpen(true)} data-testid="follow-up-draft">
        {t('write_cta')}
      </Btn>
      <Sheet open={open} onClose={() => setOpen(false)} title={t('write_cta')} description={t('grounding')}>
        {people.isLoading ? null : people.data ? (
          <OutreachComposer
            bare
            jobId={jobId}
            companyName={companyName}
            trackerEntryId={trackerEntryId}
            channels={['follow_up', 'email']}
            initialChannel="follow_up"
            drafts={drafts.data?.items ?? []}
            aiAvailable={people.data.aiAvailable}
          />
        ) : (
          <p className={styles.muted}>{t('grounding')}</p>
        )}
      </Sheet>
    </>
  );
}

export default FollowUpDraftButton;
