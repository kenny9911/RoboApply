'use client';

// TailorFlow — tailor one resume for one job (WP-36a; F-RES-09/10/15).
//
//   <TailorFlow resumeId="rv_1" jobId="job_1" onClose={…} />
//
// setup (sections → optional instruction → skills you confirm) → Generate
// (one `tailor` credit, spent only when it finishes) → result (before/after
// fit score, change cards, compare, Verify details) → Use this resume.
// The AI path has no entry when AI is off for the user or the brand
// (TASK_PLAN.md §2.2): the flow then shows one line and calls nothing.
// Nothing here applies to a job: D1 — the user applies on the company site.

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { useCreateTailorSession, useTailorAvailability, useTailorPrefs, useTailorSession } from '../../../hooks/tailor';
import type { TailorSessionView } from '../../../lib/api/contracts/resume';
import { TailorError } from './TailorError';
import { TailorResult } from './TailorResult';
import { TailorSetup, type TailorSetupValue } from './TailorSetup';
import styles from './Tailor.module.css';

export interface TailorFlowProps {
  resumeId: string;
  /** The job to tailor for; or pass `jd` for a pasted posting. */
  jobId?: string | null;
  jd?: { title: string; company: string; text: string } | null;
  /** Re-open an existing session (e.g. from the resume hub's "Verify details"). */
  sessionId?: string | null;
  onClose?: () => void;
  onFinalized?: (session: TailorSessionView) => void;
  onOpenResume?: (resultVariantId: string) => void;
}

export function TailorFlow({ resumeId, jobId = null, jd = null, sessionId: initialSessionId = null, onClose, onFinalized, onOpenResume }: TailorFlowProps) {
  const t = useTranslations('tailor');
  const availability = useTailorAvailability(resumeId);
  const { prefs, remember } = useTailorPrefs();
  const create = useCreateTailorSession();
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId);
  const session = useTailorSession(sessionId);

  if (sessionId) {
    if (session.isLoading) {
      return (
        <p className={styles.sub} role="status">
          {t('running.title')}
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
    const s = session.data;
    if (s.status === 'generating') return <Running />;
    if (s.status === 'failed') {
      return (
        <div className={styles.flow}>
          <p className={styles.error} role="alert">
            {s.failure === 'stopped' ? t('error.stopped') : t('error.aiFailed')}
          </p>
          <div className={styles.actions}>
            {/* A fresh start needs the job or the posting; a re-opened pasted-posting session has neither here. */}
            {jobId || jd ? (
              <Btn variant="primary" onClick={() => setSessionId(null)}>
                {t('error.retry')}
              </Btn>
            ) : onClose ? (
              <Btn onClick={onClose}>{t('result.close')}</Btn>
            ) : null}
          </div>
        </div>
      );
    }
    return <TailorResult session={s} onFinalized={onFinalized} onOpenResume={onOpenResume} onClose={onClose} />;
  }

  if (availability.loading) {
    return (
      <p className={styles.sub} role="status">
        {t('checking')}
      </p>
    );
  }
  if (!availability.available) {
    return (
      <p className={styles.error} role="alert" data-testid="tailor-ai-off">
        {t('error.aiUnavailable')}
      </p>
    );
  }
  if (create.pending) return <Running />;

  const generate = async (value: TailorSetupValue) => {
    const r = await create.run({
      baseVariantId: resumeId,
      ...(jobId ? { jobId } : jd ? { jd } : {}),
      mode: value.mode,
      sections: value.sections,
      ...(value.sections.includes('experience') ? { experienceDepth: value.experienceDepth } : {}),
      ...(value.customPrompt ? { customPrompt: value.customPrompt } : {}),
      keywords: value.keywords,
    });
    if (r?.ok) {
      remember(value.sections, value.experienceDepth);
      setSessionId(r.value.id);
    }
  };

  return (
    <div className={styles.flow}>
      <TailorSetup
        resumeId={resumeId}
        jobId={jobId}
        fast={prefs && prefs.runs > 0 ? { sections: prefs.sections, experienceDepth: prefs.experienceDepth } : null}
        pending={create.pending}
        credit={create.gate.summary}
        onGenerate={(v) => void generate(v)}
      />
      <TailorError error={create.error} />
    </div>
  );
}

function Running() {
  const t = useTranslations('tailor.running');
  return (
    <div className={styles.running} role="status" aria-live="polite">
      <p className={styles.heading}>{t('title')}</p>
      <p className={styles.sub}>{t('sub')}</p>
      <div className={styles.progress} aria-hidden="true">
        <div className={styles.progressBar} />
      </div>
    </div>
  );
}
