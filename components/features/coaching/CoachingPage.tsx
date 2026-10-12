'use client';

// CoachingPage — /coaching (WP-72; PRODUCT_PLAN.md §5.14 F-COACH-01).
//
// The current site's coach list. Every coach is a real person staff added
// after they agreed to be listed; every field shown comes from that roster
// row. Booking is the coach's own booking page or a request we email to the
// coach (and staff). The user pays the coach directly; there is no checkout.
// No ratings are shown unless real post-session ratings exist (none in V2).
//
// States: capability off → "not available here" (the nav entry is hidden
// too); loading; error with retry; empty roster → plain empty state (no
// upsell); filters on the loaded list (specialty, language).

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { EmptyState } from '../../v3/primitives/EmptyState';
import { PageHeader } from '../../v3/primitives/PageHeader';
import { Btn } from '../../v3/primitives/Btn';
import { useFlag } from '../../../lib/flags';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { LEGAL_DOC_FILES } from '../compliance';
import { useCoaches } from '../../../hooks/coaching/useCoaching';
import type { CoachView } from '../../../lib/api/contracts/coaching';
import { CoachCard } from './CoachCard';
import { CoachRequestDialog } from './CoachRequestDialog';
import { useLanguageName } from './format';
import styles from './coaching.module.css';

export function CoachingPage() {
  const t = useTranslations('coaching.page');
  const enabled = useFlag('coaching');
  const q = useCoaches({}, enabled);
  const [requesting, setRequesting] = useState<CoachView | null>(null);
  // Link the coaching policy only where this site's market publishes it (else /legal/coaching 404s).
  const market = useBrand().market;
  const hasPolicy = Boolean(LEGAL_DOC_FILES[market]?.coaching);

  if (!enabled) {
    return (
      <div className={styles.page} data-testid="coaching-page">
        <PageHeader title={t('title')} />
        <EmptyState title={t('offTitle')} sub={t('offSub')} />
      </div>
    );
  }

  const coaches = q.data?.items ?? [];

  return (
    <div className={styles.page} data-testid="coaching-page">
      <PageHeader title={t('title')} sub={t('sub')} />

      {q.isLoading ? (
        <p className={styles.muted} aria-busy="true">
          {t('loading')}
        </p>
      ) : q.isError ? (
        <div className={styles.section} role="alert">
          <p className={styles.error}>{t('loadError')}</p>
          <div className={styles.actions}>
            <Btn onClick={() => void q.refetch()}>{t('retry')}</Btn>
          </div>
        </div>
      ) : coaches.length === 0 ? (
        <EmptyState
          title={t('emptyTitle')}
          sub={t('emptySub')}
          action={
            <Btn as="a" href="/practice">
              {t('emptyAction')}
            </Btn>
          }
        />
      ) : (
        <>
          <section className={`${styles.section} ${styles.intro}`} aria-labelledby="coaching-how">
            <p className={styles.text} id="coaching-how">
              {t('howItWorks')}
            </p>
            {hasPolicy ? (
              <Link className={styles.link} href="/legal/coaching">
                {t('policyLink')}
              </Link>
            ) : null}
          </section>
          <CoachList coaches={coaches} onRequest={setRequesting} />
        </>
      )}

      {requesting ? <CoachRequestDialog coach={requesting} open onClose={() => setRequesting(null)} /> : null}
    </div>
  );
}

function CoachList({ coaches, onRequest }: { coaches: CoachView[]; onRequest: (c: CoachView) => void }) {
  const t = useTranslations('coaching');
  const languageName = useLanguageName();
  const [specialty, setSpecialty] = useState('');
  const [language, setLanguage] = useState('');

  const specialties = useMemo(
    () => [...new Set(coaches.flatMap((c) => c.specialties))].sort((a, b) => a.localeCompare(b)),
    [coaches],
  );
  const languages = useMemo(
    () => [...new Set(coaches.flatMap((c) => c.languages.map((l) => l.toLowerCase().split('-')[0]!)))].sort(),
    [coaches],
  );

  const shown = coaches.filter(
    (c) =>
      (!specialty || c.specialties.includes(specialty)) &&
      (!language || c.languages.some((l) => l.toLowerCase().split('-')[0] === language)),
  );

  const showFilters = specialties.length > 1 || languages.length > 1;

  return (
    <section className={styles.form} aria-labelledby="coaching-count">
      <p className={styles.muted} id="coaching-count" aria-live="polite">
        {t('page.count', { count: shown.length })}
      </p>
      {showFilters ? (
        <fieldset className={styles.filters}>
          <legend className={styles.muted}>{t('filters.label')}</legend>
          {specialties.length > 1 ? (
            <label className={styles.field}>
              <span className={styles.label}>{t('filters.specialty')}</span>
              <select className={styles.select} value={specialty} onChange={(e) => setSpecialty(e.target.value)}>
                <option value="">{t('filters.any')}</option>
                {specialties.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {languages.length > 1 ? (
            <label className={styles.field}>
              <span className={styles.label}>{t('filters.language')}</span>
              <select className={styles.select} value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="">{t('filters.any')}</option>
                {languages.map((l) => (
                  <option key={l} value={l}>
                    {languageName(l)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </fieldset>
      ) : null}

      {shown.length === 0 ? (
        <div className={styles.actions}>
          <p className={styles.muted}>{t('filters.noResults')}</p>
          <Btn
            variant="ghost"
            onClick={() => {
              setSpecialty('');
              setLanguage('');
            }}
          >
            {t('filters.clear')}
          </Btn>
        </div>
      ) : (
        <ul className={styles.list}>
          {shown.map((c) => (
            <li key={c.id}>
              <CoachCard coach={c} onRequest={() => onRequest(c)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default CoachingPage;
