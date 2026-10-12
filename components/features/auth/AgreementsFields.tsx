'use client';

// AgreementsFields — the signup agreements (PRODUCT_PLAN.md O0 rows 7 and 9;
// CN plan §4 intl signup): "Send me product news and tips" (UNCHECKED by
// default, everywhere), the required "I'm 16 or older" (both brands), and on
// RoboApply for zh-TW visitors or visitors from Taiwan the PDPA notice with
// its own consent row. Nothing is pre-ticked.

import { useTranslations } from 'next-intl';
import type { SignupAgreements } from '../../auth/agreements';
import { useBrand } from '../../../lib/brand/BrandProvider';
import styles from './auth.module.css';

export interface AgreementsFieldsProps {
  value: SignupAgreements;
  onChange: (next: SignupAgreements) => void;
  /** Show the marketing opt-in (signup page; not on the OAuth completion step when already answered). */
  showMarketing?: boolean;
}

export function AgreementsFields({ value, onChange, showMarketing = true }: AgreementsFieldsProps) {
  const t = useTranslations('auth');
  const brand = useBrand();
  const legal = brand.legal ?? { termsPath: '/legal/terms', privacyPath: '/legal/privacy' };
  return (
    <div className={styles.agreements}>
      {showMarketing ? (
        <label className={styles.check}>
          <input
            type="checkbox"
            name="marketingOptIn"
            checked={value.marketing}
            onChange={(e) => onChange({ ...value, marketing: e.target.checked })}
          />
          <span>{t('agreements.marketing')}</span>
        </label>
      ) : null}
      <label className={styles.check}>
        <input
          type="checkbox"
          name="age16"
          required
          checked={value.age}
          onChange={(e) => onChange({ ...value, age: e.target.checked })}
        />
        <span>{t('agreements.age')}</span>
      </label>
      {value.pdpaRequired ? (
        <label className={styles.check}>
          <input
            type="checkbox"
            name="twPdpaNotice"
            required
            checked={value.pdpa}
            onChange={(e) => onChange({ ...value, pdpa: e.target.checked })}
          />
          <span>
            {t.rich('agreements.pdpa', {
              notice: (chunks) => (
                <a href="/legal/tw-pdpa-notice" target="_blank" rel="noreferrer">
                  {chunks}
                </a>
              ),
            })}
          </span>
        </label>
      ) : null}
      <p className={styles.legal}>
        {t.rich('agreements.legal', {
          terms: (chunks) => (
            <a href={legal.termsPath} target="_blank" rel="noreferrer">
              {chunks}
            </a>
          ),
          privacy: (chunks) => (
            <a href={legal.privacyPath} target="_blank" rel="noreferrer">
              {chunks}
            </a>
          ),
        })}
      </p>
    </div>
  );
}
