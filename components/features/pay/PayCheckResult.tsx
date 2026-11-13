'use client';

// PayCheckResult — the answer of one pay check (GET /feed/pay-check), in the
// order a reader needs it: what was matched (the title rule, the place), the
// counts and the window in words, the line that this is what posts state and
// not a prediction of an offer, then one range per currency that has enough
// posts stating pay. A currency below the sample rule shows its count only;
// with none above it the page says there is not enough yet and offers a
// broader check (the role the title names, or no location). Every number is
// the server's (D3); a count is never padded and a figure never invented.

import { useLocale, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import type { PayCheckResponse } from '../../../lib/api/contracts/feed';
import type { PayCheckAsk } from '../../../hooks/feed';
import { regionName } from './format';
import { PayRange, hasFigures } from './PayRange';
import styles from './pay.module.css';

export interface PayCheckResultProps {
  data: PayCheckResponse;
  /** What was asked (the form's values when it was sent). */
  asked: PayCheckAsk;
  /** Run another check (a broader one from the "not enough" block). */
  onAsk: (ask: PayCheckAsk) => void;
}

const fold = (s: string) => s.normalize('NFKC').trim().toLowerCase();

export function PayCheckResult({ data, asked, onAsk }: PayCheckResultProps) {
  const t = useTranslations('payCheck');
  const locale = useLocale();
  const days = data.window.days;
  const country = (code: string | null) => (code ? regionName(code, locale) : null);

  const matchLine =
    data.titleMatch.method === 'role' && data.titleMatch.roleLabel
      ? t('result.matchRole', { role: data.titleMatch.roleLabel, text: data.titleMatch.text })
      : t('result.matchText', { text: data.titleMatch.text });

  const place = data.place;
  const placeLine = !place
    ? t('result.placeAny')
    : place.kind === 'remote'
      ? place.country
        ? t('result.placeRemoteIn', { country: country(place.country)! })
        : t('result.placeRemote')
      : place.kind === 'text'
        ? t('result.placeText', { place: place.input })
        : t('result.placeIn', { place: [place.name, country(place.country)].filter(Boolean).join(', ') || place.input });

  const ranges = data.currencies.filter(hasFigures);
  const few = data.currencies.filter((c) => !hasFigures(c));
  const enough = data.status === 'ok' && ranges.length > 0;

  // A broader check: the role the title names (when it is not what was typed), and the title without its place.
  const role = data.titleMatch.method === 'role' ? data.titleMatch.roleLabel : null;
  const offerRole = !!role && fold(role) !== fold(data.title);
  const offerNoPlace = !!asked.location.trim();

  return (
    <div className={styles.result} data-testid="pay-result" data-status={enough ? 'ok' : 'not_enough'}>
      <div className={styles.resultHead}>
        <h2 className={styles.heading}>{t('result.heading', { title: data.title })}</h2>
        <p className={styles.muted} data-testid="pay-match">
          {matchLine} {placeLine}
        </p>
      </div>

      <p className={styles.counts} data-testid="pay-counts">
        {data.capped ? t('result.matchedCapped', { count: data.rowCap, days }) : t('result.matched', { count: data.matchedCount, days })}{' '}
        {data.matchedCount > 0 ? t('result.withPay', { count: data.withPayCount }) : null}
      </p>
      <p className={styles.honesty} data-testid="pay-honesty">
        {t('result.honesty')}
      </p>

      {enough ? (
        <div className={styles.ranges}>
          {ranges.map((entry) => (
            <PayRange key={entry.currency} entry={entry} />
          ))}
        </div>
      ) : (
        <section className={styles.notEnough} data-testid="pay-not-enough" aria-labelledby="pay-not-enough-title">
          <h3 className={styles.rangeTitle} id="pay-not-enough-title">
            {t('notEnough.title')}
          </h3>
          <p className={styles.text}>{t('notEnough.sub', { min: data.minSample })}</p>
          {offerRole || offerNoPlace ? (
            <div className={styles.actions}>
              {offerRole ? (
                <Btn onClick={() => onAsk({ title: role!, location: asked.location })} data-testid="pay-try-role">
                  {t('notEnough.tryRole', { role: role! })}
                </Btn>
              ) : null}
              {offerNoPlace ? (
                <Btn onClick={() => onAsk({ title: asked.title, location: '' })} data-testid="pay-without-place">
                  {t('notEnough.withoutPlace')}
                </Btn>
              ) : null}
            </div>
          ) : null}
        </section>
      )}

      {few.length ? (
        <ul className={styles.few} data-testid="pay-few">
          {few.map((c) => (
            <li key={c.currency}>{t('few', { currency: c.currency, count: c.sampleSize, min: data.minSample })}</li>
          ))}
        </ul>
      ) : null}

      {enough ? <p className={styles.muted}>{t('result.yearly')}</p> : null}
    </div>
  );
}
