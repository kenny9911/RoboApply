'use client';

// CoachCard — one coach on /coaching (WP-72). Everything shown comes from the
// roster row staff entered with the coach's agreement: name, photo, one-line
// description, bio, languages, what they help with, session lengths and the
// coach's own prices. Unknown facts say "Not listed"; a missing price is never
// shown as 0. A rating appears only when real post-session ratings exist,
// always with their count (none exist in V2).

import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import type { CoachView } from '../../../lib/api/contracts/coaching';
import { initials, useLanguageName, useMoney } from './format';
import styles from './coaching.module.css';

export interface CoachCardProps {
  coach: CoachView;
  /** Opens the request form (coaches without their own booking page). */
  onRequest: () => void;
}

export function CoachCard({ coach, onRequest }: CoachCardProps) {
  const t = useTranslations('coaching.card');
  const languageName = useLanguageName();
  const money = useMoney();
  const headingId = `coach-${coach.id}`;
  const anyPrice = coach.sessions.some((s) => s.amountMinor !== null);

  return (
    <article className={styles.card} aria-labelledby={headingId} data-testid="coach-card">
      <div className={styles.cardHead}>
        {coach.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- staff-entered external photo; no remote pattern to allow-list.
          <img className={styles.avatar} src={coach.photoUrl} alt={t('photoAlt', { name: coach.displayName })} width={56} height={56} loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <span className={styles.initials} aria-hidden="true">
            {initials(coach.displayName)}
          </span>
        )}
        <div className={styles.who}>
          <h2 className={styles.h2} id={headingId}>
            {coach.displayName}
          </h2>
          <p className={styles.muted}>{coach.headline}</p>
          {coach.rating && coach.rating.count > 0 ? (
            <p className={styles.muted}>{t('rating', { average: coach.rating.average.toFixed(1), count: coach.rating.count })}</p>
          ) : null}
        </div>
      </div>

      <p className={styles.text}>{coach.bio}</p>

      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>{t('languages')}</dt>
          <dd>{coach.languages.length ? coach.languages.map(languageName).join(', ') : t('notListed')}</dd>
        </div>
        <div className={styles.fact}>
          <dt>{t('helpsWith')}</dt>
          <dd>
            {coach.specialties.length ? (
              <ul className={styles.tags}>
                {coach.specialties.map((s) => (
                  <li key={s} className={styles.tag}>
                    {s}
                  </li>
                ))}
              </ul>
            ) : (
              t('notListed')
            )}
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>{t('sessions')}</dt>
          <dd>
            {coach.sessions.length ? (
              <ul className={styles.sessions}>
                {coach.sessions.map((s) => (
                  <li key={s.minutes}>
                    {s.amountMinor !== null && s.currency
                      ? t('sessionPrice', { minutes: s.minutes, price: money(s.amountMinor, s.currency) })
                      : t('sessionNoPrice', { minutes: s.minutes })}
                  </li>
                ))}
              </ul>
            ) : (
              t('notListed')
            )}
          </dd>
        </div>
      </dl>
      {/* Every card says who sets the price and that the user pays the coach directly. */}
      <p className={styles.muted}>{t(anyPrice ? 'priceNote' : 'priceNoteNone', { name: coach.displayName })}</p>

      <div className={styles.cardFoot}>
        {coach.introVideoUrl ? (
          <a className={styles.link} href={coach.introVideoUrl} target="_blank" rel="noopener noreferrer">
            {t('intro', { name: coach.displayName })}
          </a>
        ) : null}
        {coach.booking === 'link' && coach.bookingUrl ? (
          <>
            <div className={styles.actions}>
              <Btn as="a" variant="primary" href={coach.bookingUrl} target="_blank" rel="noopener noreferrer">
                {t('book', { name: coach.displayName })}
              </Btn>
            </div>
            <p className={styles.muted}>{t('bookNote')}</p>
          </>
        ) : (
          <>
            <div className={styles.actions}>
              <Btn variant="primary" onClick={onRequest}>
                {t('request')}
              </Btn>
            </div>
            <p className={styles.muted}>{t('requestNote', { name: coach.displayName })}</p>
          </>
        )}
      </div>
    </article>
  );
}
