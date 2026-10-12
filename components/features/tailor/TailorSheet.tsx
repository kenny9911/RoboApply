'use client';

// TailorSheet — the tailor flow in a sheet (bottom sheet on phones, a centred
// card on wide screens). When no resume is given, the user first picks the
// base resume to copy (their main resume first). When no job is given (the
// editor's Tailor button), the user then says which job it is for: one of
// their saved jobs, or a posting they paste (TailorTarget). Re-opening a
// session (`sessionId`) never asks for either: the session already has both,
// so the sheet loads it and goes straight to Verify details.

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, Sheet } from '../../v3/primitives';
import { useResumeList } from '../../../hooks/useResumes';
import { useTailorSession } from '../../../hooks/tailor';
import type { TailorSessionView } from '../../../lib/api/contracts/resume';
import { TailorError } from './TailorError';
import { TailorFlow } from './TailorFlow';
import { TailorTarget, type TailorTargetValue } from './TailorTarget';
import styles from './Tailor.module.css';

export interface TailorSheetProps {
  open: boolean;
  onClose: () => void;
  /**
   * The job to tailor for. Omitted with no `sessionId` → the user picks a saved
   * job or pastes the posting first. Omitted with a `sessionId` → the
   * session's own job or pasted posting.
   */
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
  const tTarget = useTranslations('tailor.target');
  const [picked, setPicked] = useState<string | null>(null);
  const [target, setTarget] = useState<TailorTargetValue | null>(null);
  const base = resumeId ?? picked;
  const handlers = { onClose, onFinalized, onOpenResume };
  // No job and no session to re-open: ask which job this is for.
  const needsTarget = !jobId && !sessionId;
  const targetTitle = target ? (target.kind === 'job' ? target.title : target.jd.title) : null;
  const targetCompany = target ? (target.kind === 'job' ? target.company : target.jd.company || null) : null;
  let body: ReactNode;
  if (sessionId && !base) body = <SessionFlow sessionId={sessionId} jobId={jobId} {...handlers} />;
  else if (!base) body = <BasePicker onPick={setPicked} />;
  else if (needsTarget && !target) body = <TailorTarget onPick={setTarget} />;
  else {
    body = (
      <TailorFlow
        resumeId={base}
        jobId={jobId ?? (target?.kind === 'job' ? target.jobId : null)}
        jd={target?.kind === 'posting' ? target.jd : null}
        sessionId={sessionId}
        targetLabel={targetTitle ? (targetCompany ? tTarget('chosenWithCompany', { title: targetTitle, company: targetCompany }) : targetTitle) : null}
        onChangeTarget={needsTarget ? () => setTarget(null) : undefined}
        {...handlers}
      />
    );
  }
  const heading = jobTitle ?? targetTitle;
  return (
    <Sheet open={open} onClose={onClose} title={heading ? t('titleFor', { title: heading }) : t('title')}>
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
