'use client';

// TailorSheet — the tailor flow in a sheet (bottom sheet on phones, a centred
// card on wide screens). When no resume is given, the user first picks the
// base resume to copy (their main resume first). Re-opening a session
// (`sessionId`) never asks for a base: the session already has one, so the
// sheet loads it and goes straight to Verify details.

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, Sheet } from '../../v3/primitives';
import { useResumeList } from '../../../hooks/useResumes';
import { useTailorSession } from '../../../hooks/tailor';
import type { TailorSessionView } from '../../../lib/api/contracts/resume';
import { TailorError } from './TailorError';
import { TailorFlow } from './TailorFlow';
import styles from './Tailor.module.css';

export interface TailorSheetProps {
  open: boolean;
  onClose: () => void;
  /** The job to tailor for. May be omitted when re-opening a session (a pasted posting has none). */
  jobId?: string | null;
  /** Base resume; omitted → the picker (or the session's base when `sessionId` is set). */
  resumeId?: string | null;
  /** Re-open an existing session. */
  sessionId?: string | null;
  /** Job title for the sheet heading, when the caller has it. */
  jobTitle?: string | null;
  onFinalized?: (session: TailorSessionView) => void;
  onOpenResume?: (resultVariantId: string) => void;
}

export function TailorSheet({ open, onClose, jobId = null, resumeId = null, sessionId = null, jobTitle = null, onFinalized, onOpenResume }: TailorSheetProps) {
  const t = useTranslations('tailor.sheet');
  const [picked, setPicked] = useState<string | null>(null);
  const base = resumeId ?? picked;
  const handlers = { onClose, onFinalized, onOpenResume };
  let body: ReactNode;
  if (sessionId && !base) body = <SessionFlow sessionId={sessionId} jobId={jobId} {...handlers} />;
  else if (base) body = <TailorFlow resumeId={base} jobId={jobId} sessionId={sessionId} {...handlers} />;
  else body = <BasePicker onPick={setPicked} />;
  return (
    <Sheet open={open} onClose={onClose} title={jobTitle ? t('titleFor', { title: jobTitle }) : t('title')}>
      {body}
    </Sheet>
  );
}

/** Re-open a session without a resume id: load it, then use its own base resume and job. */
function SessionFlow({
  sessionId,
  jobId,
  onClose,
  onFinalized,
  onOpenResume,
}: {
  sessionId: string;
  jobId: string | null;
  onClose: () => void;
  onFinalized?: (session: TailorSessionView) => void;
  onOpenResume?: (resultVariantId: string) => void;
}) {
  const t = useTranslations('tailor');
  const session = useTailorSession(sessionId);
  if (session.isLoading) {
    return (
      <p className={styles.sub} role="status">
        {t('sheet.loading')}
      </p>
    );
  }
  if (session.isError || !session.data) {
    return (
      <div className={styles.flow}>
        <TailorError error={session.error} />
        <div className={styles.actions}>
          <Btn onClick={() => void session.refetch()}>{t('error.reload')}</Btn>
        </div>
      </div>
    );
  }
  return (
    <TailorFlow
      resumeId={session.data.baseVariantId}
      jobId={jobId ?? session.data.jobId}
      sessionId={sessionId}
      onClose={onClose}
      onFinalized={onFinalized}
      onOpenResume={onOpenResume}
    />
  );
}

/** Pick the base resume to copy. Tailored versions are not offered as a base. */
export function BasePicker({ onPick }: { onPick: (resumeId: string) => void }) {
  const t = useTranslations('tailor.picker');
  const tErr = useTranslations('tailor.error');
  const list = useResumeList();
  if (list.isLoading) {
    return (
      <p className={styles.sub} role="status">
        {t('loading')}
      </p>
    );
  }
  if (list.isError) {
    return (
      <div className={styles.flow}>
        <p className={styles.error} role="alert">
          {t('error')}
        </p>
        <div className={styles.actions}>
          <Btn onClick={() => void list.refetch()}>{tErr('retry')}</Btn>
        </div>
      </div>
    );
  }
  const bases = (list.data?.resumes ?? [])
    .filter((r) => r.kind !== 'tailored_for_jd')
    .sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)));
  if (bases.length === 0) return <p className={styles.sub}>{t('empty')}</p>;
  return (
    <div className={styles.flow}>
      <div>
        <p className={styles.heading}>{t('title')}</p>
        <p className={styles.sub}>{t('sub')}</p>
      </div>
      <ul className={styles.picks}>
        {bases.map((r) => (
          <li key={r.id}>
            <button type="button" className={styles.pick} onClick={() => onPick(r.id)}>
              <span>{r.name}</span>
              {r.isPrimary ? <span className={styles.sub}>{t('primary')}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
