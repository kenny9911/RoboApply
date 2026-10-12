'use client';

// G6 上传简历 on GoApply — the AI-consent gate around WP-30's shared resume
// screen (PRODUCT_PLAN.md §4.5 G6; TASK_PLAN.md WP-31).
//
// Reading a resume uses AI, so the upload doors appear only with the
// `ai_resume_parsing` consent. Without it the screen offers 手动填写资料
// (manual mode: no upload, no parse call, no LLM call) and a way to turn AI
// processing on, which records the consent with the prose the user just read.
// The optional-field reminder is always shown. Images are parsed by the
// GoHire parse API only (server routing, WP-15); there is no local OCR.
//
// 手动填写资料 opens the manual form (`ManualProfileForm`: name, education,
// one experience, skills — typed by the user, saved through the profile
// routes). Only when that form is saved, or the user chooses 稍后填写 on it,
// does the gate call `onManual`; the onboarding page then saves the resume
// step as skipped, because there is no resume:
//
//   <CnResumeGate onManual={() => save({}, { skip: true })} busy={busy} error={error}><ResumeStep …/></CnResumeGate>
//
// `busy` and `error` belong to the caller's save: while it runs the buttons
// are off, and when it fails the message shows here — the upload screen,
// which would otherwise show it, is not on the page in manual mode.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import type { ConsentCatalogItem } from '../../../lib/api/contracts/compliance';
import { Btn } from '../../v3/primitives/Btn';
import { useCnOnboardingApi } from './api';
import { proseLocale } from './ConsentStep';
import { ManualProfileForm } from './ManualProfileForm';
import { StepProgress } from './parts';
import styles from './OnboardingCn.module.css';

export interface CnResumeGateProps {
  /** The upload screen, rendered only with AI consent. */
  children: ReactNode;
  /** Manual mode is finished (the form was saved, or left for later): continue without a resume. */
  onManual: () => void;
  /** The caller is saving (手动填写 was pressed): both buttons are off. */
  busy?: boolean;
  /** The caller's save failed: a plain message, already in the user's language. */
  error?: string | null;
}

export function CnResumeGate({ children, onManual, busy: saving = false, error = null }: CnResumeGateProps) {
  const t = useTranslations('onboardingCn');
  const locale = useLocale();
  const api = useCnOnboardingApi();
  const [item, setItem] = useState<ConsentCatalogItem | null | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // 手动填写资料 was pressed: the manual form is open.
  const [manual, setManual] = useState(false);

  const load = useCallback(() => {
    api
      .getMyConsents(proseLocale(locale))
      .then((items) => setItem(items.find((i) => i.type === 'ai_resume_parsing') ?? null))
      .catch(() => setItem(null));
  }, [api, locale]);
  useEffect(load, [load]);

  const reminder = <p className={styles.note}>{t('resume.optionalFields')}</p>;
  if (item === 'loading') return <p className={styles.note}>{t('common.loading')}</p>;
  if (item && item.granted === true) {
    return (
      <>
        {children}
        {reminder}
      </>
    );
  }

  if (manual) {
    return <ManualProfileForm onContinue={onManual} onBack={() => setManual(false)} busy={saving} error={error} />;
  }

  async function enable() {
    if (!item || item === 'loading') return;
    setBusy(true);
    setFailed(false);
    try {
      await api.recordConsent({ type: 'ai_resume_parsing', granted: true, proseVersion: item.proseVersion, locale: proseLocale(locale) });
      setItem({ ...item, granted: true });
    } catch {
      setFailed(true);
      load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.step} aria-labelledby="cn-resume-gate">
      <StepProgress step="resume" />
      <div className={styles.notice}>
        <h2 id="cn-resume-gate" className={styles.panelTitle}>
          {t('resume.offTitle')}
        </h2>
        <p className={styles.subtitle}>{t('resume.offBody')}</p>
        <ul className={styles.list}>
          <li>{t('resume.unavailable.parse')}</li>
          <li>{t('resume.unavailable.tailor')}</li>
          <li>{t('resume.unavailable.assistant')}</li>
        </ul>
        <div className={styles.chips}>
          <Btn variant="primary" onClick={() => setManual(true)} disabled={saving || busy}>
            {t('resume.manual')}
          </Btn>
          {item ? (
            <Btn onClick={() => void enable()} disabled={saving || busy}>
              {t('resume.enable')}
            </Btn>
          ) : null}
        </div>
        {item ? <p className={styles.note}>{item.prose}</p> : null}
        {failed ? (
          <p className={styles.error} role="alert">
            {t('errors.save')}
          </p>
        ) : null}
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </div>
      {reminder}
    </section>
  );
}
