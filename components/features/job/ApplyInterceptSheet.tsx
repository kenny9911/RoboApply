'use client';

// ApplyInterceptSheet — the one-time choice before "Apply on company site"
// when no resume is tailored for this job (PRODUCT F-JOB-06). Three choices,
// none of which sends anything: tailor first, apply with the current resume
// (opens the employer's page), or don't ask again.

import { useTranslations } from 'next-intl';

import { Btn, Sheet } from '../../v3/primitives';
import styles from './job.module.css';

export interface ApplyInterceptSheetProps {
  open: boolean;
  onClose: () => void;
  onTailor: () => void;
  onApplyNow: () => void;
  onNever: () => void;
}

export function ApplyInterceptSheet({ open, onClose, onTailor, onApplyNow, onNever }: ApplyInterceptSheetProps) {
  const t = useTranslations('jobDetail.intercept');
  return (
    <Sheet open={open} onClose={onClose} title={t('title')} description={t('body')}>
      <div className={styles.sheetActions} data-testid="apply-intercept">
        <Btn variant="primary" onClick={onTailor}>
          {t('tailor')}
        </Btn>
        <Btn onClick={onApplyNow}>{t('applyNow')}</Btn>
        <Btn variant="ghost" onClick={onNever}>
          {t('never')}
        </Btn>
      </div>
    </Sheet>
  );
}
