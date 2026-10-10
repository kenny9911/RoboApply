'use client';

// SensitiveFillConsent — the in-context `autofill_sensitive` consent (WP-13
// catalog, wave-2 carry-over): unticked unless the user granted it, prose
// shown exactly as served (its version is recorded with the answer), and
// withdrawable here or in Settings → Consents. Without it the extension never
// receives the stored sensitive answers.

import { useLocale, useTranslations } from 'next-intl';

import { useSensitiveFillConsent } from '../../../hooks/extension';
import s from './extension.module.css';

export function SensitiveFillConsent() {
  const t = useTranslations('extensionWeb');
  const locale = useLocale();
  const { item, save } = useSensitiveFillConsent({ locale });
  if (!item) return null;

  const checked = item.granted === true;
  return (
    <section className={s.card} aria-labelledby="ext-sensitive-title">
      <h2 className={s.cardSub} id="ext-sensitive-title">
        {t('sensitive.title')}
      </h2>
      <p className={s.body}>{t('sensitive.intro')}</p>
      <label className={s.check}>
        <input type="checkbox" checked={checked} disabled={save.isPending} onChange={(e) => save.mutate(e.currentTarget.checked)} />
        <span>{t('sensitive.label')}</span>
      </label>
      <p className={s.prose} lang={item.proseLocale}>
        {item.prose}
      </p>
      {save.isPending ? (
        <p className={s.meta} role="status">
          {t('sensitive.saving')}
        </p>
      ) : null}
      {save.isError ? (
        <p className={s.error} role="alert">
          {t('sensitive.error')}
        </p>
      ) : null}
    </section>
  );
}

export default SensitiveFillConsent;
