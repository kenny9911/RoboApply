'use client';

// ResumeForApplication — "Download the resume for this application" in the
// tracker drawer (WP-93: wave3 #21). Opens the resume download dialog with
// this application's id, so the exact file the user takes is recorded on the
// application (RAApplicationArtifact) and shows up under "Files you used".
//
// Which resume: the version tailored for this job when there is one, else the
// user's main resume. No resume → nothing is rendered. Nothing is sent to
// anyone: the file is saved to the user's device and they attach it themselves.

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { DownloadModal } from '../../v3/resume-editor/DownloadModal';
import { useResume, useResumeList } from '../../../hooks/useResumes';
import type { ResumeVariant } from '../../../lib/api/resumes';

export interface ResumeForApplicationProps {
  trackerEntryId: string;
  /** The resume tailored for this job, when the entry has one. */
  tailoredVariantId: string | null;
  /** Called after the dialog closes (the files list is read again). */
  onRecorded?: () => void;
}

export function ResumeForApplication({ trackerEntryId, tailoredVariantId, onRecorded }: ResumeForApplicationProps) {
  const t = useTranslations('applications');
  const list = useResumeList();
  const [open, setOpen] = useState(false);
  const resumes = list.data?.resumes ?? [];
  const resumeId = tailoredVariantId ?? resumes.find((r) => r.isPrimary)?.id ?? resumes[0]?.id ?? null;
  const resume = useResume(open ? resumeId : null);
  if (!resumeId) return null;
  const data = resume.data as ResumeVariant | undefined;

  return (
    <>
      <Btn variant="default" onClick={() => setOpen(true)} disabled={open && resume.isLoading} data-testid="download-resume" data-resume={resumeId}>
        {t('drawer.download_resume')}
      </Btn>
      {open && resume.isError ? (
        <span role="alert" data-testid="download-resume-error">
          {t('drawer.load_error')}
        </span>
      ) : null}
      {open && data ? (
        <DownloadModal
          resumeId={data.id}
          resumeName={data.name}
          resumeMarkdown={data.resumeMarkdown ?? ''}
          unverifiedClaims={data.unverifiedClaims ?? 0}
          aiAssisted={data.aiAssisted === true}
          trackerEntryId={trackerEntryId}
          onClose={() => {
            setOpen(false);
            onRecorded?.();
          }}
        />
      ) : null}
    </>
  );
}

export default ResumeForApplication;
