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
//   <CnResumeGate onManual={() => router.push('/profile')}><ResumeDoors/></CnResumeGate>

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import type { ConsentCatalogItem } from '../../../lib/api/contracts/compliance';
import { Btn } from '../../v3/primitives/Btn';
import { useCnOnboardingApi } from './api';
import { proseLocale } from './ConsentStep';
import styles from './OnboardingCn.module.css';

export interface CnResumeGateProps {
  /** The upload screen, rendered only with AI consent. */
  children: ReactNode;
  /** Manual mode: fill the profile by hand (and skip the upload). */
  onManual: () => void;
}

export function CnResumeGate({ children, onManual }: CnResumeGateProps) {
  const t = useTranslations('onboardingCn');
  const locale = useLocale();
  const api = useCnOnboardingApi();
  const [item, setItem] = useState<ConsentCatalogItem | null | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

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
          <Btn variant="primary" onClick={onManual}>
            {t('resume.manual')}
          </Btn>
          {item ? (
            <Btn onClick={() => void enable()} disabled={busy}>
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
      </div>
      {reminder}
    </section>
  );
}
