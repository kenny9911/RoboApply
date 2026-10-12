'use client';

// ReadyIntro — what Ready to apply does, before setup (PRODUCT F-AGENT-01).
// No waitlist, no persona. It says in one line that the user submits each
// application themselves (D1), and shows the plan's weekly kit allowance
// from the server.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { HonestyLine, PageHeader } from '../../v3/primitives';
import { KitAllowance } from './KitAllowance';
import { SETUP_HREF } from './states';
import styles from './ready.module.css';

export interface ReadyIntroProps {
  /** Setup was started earlier: the button says "Continue setup". */
  started?: boolean;
}

export function ReadyIntro({ started = false }: ReadyIntroProps) {
  const t = useTranslations('ready');
  return (
    <div className={styles.page} data-testid="ready-intro">
      <PageHeader title={t('title')} sub={<HonestyLine kind="you_submit" />} />
      <section className={styles.cardSoft} aria-labelledby="ready-intro-title">
        <h2 id="ready-intro-title" className={styles.cardTitle}>
          {t('intro.title')}
        </h2>
        <p className={styles.body}>{t('intro.lead')}</p>
        <ul className={styles.bullets}>
          <li>{t('intro.point_list')}</li>
          <li>{t('intro.point_kit')}</li>
          <li>{t('intro.point_review')}</li>
          <li>{t('intro.point_open')}</li>
        </ul>
        <KitAllowance />
        <div className={styles.row}>
          <Link href={SETUP_HREF} className="btn primary">
            {started ? t('intro.continue') : t('intro.start')}
          </Link>
        </div>
      </section>
    </div>
  );
}
