'use client';

// CreditsUsage — /settings#credits: today's credits per bucket with caps and
// refill times, practice interviews left, and recent use (PRODUCT_PLAN.md
// §6.1–§6.2; TASK_PLAN.md WP-21b). Caps print as "10 a day" (Free) or
// "Up to 50 a day" (Pro) — never "unlimited". Unknown values render "—",
// never 0; nothing is computed on the client beyond reading the summary.
//
// Refill times are shown in the account's time zone (`summary.timezone`, the
// zone the server used to place the windows) and say which day they mean:
// "Refills tomorrow 12:00 AM", or the weekday with its date for a later
// refill — never a bare weekday, which read like a weekly reset on a daily
// row. "Recent use" is timed in that same zone, so one card never shows two
// clocks; it lists credit uses only (the server leaves grants out) and
// includes practice interviews.

import { useFormatter, useLocale, useTimeZone, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { useCredits, type BucketSummary } from '../../../hooks/shared/useCredits';
import { useCreditHistory } from '../../../hooks/credits/useCreditHistory';
import { BUCKET_ORDER, bucketLabelKey, knownTimeZone, parseDate, refillLabel } from './labels';
import styles from './credits.module.css';

export interface CreditsUsageProps {
  /** Hide the recent-use list (compact surfaces). */
  hideHistory?: boolean;
}

export function CreditsUsage({ hideHistory = false }: CreditsUsageProps) {
  const t = useTranslations('credits');
  const locale = useLocale();
  const appTimeZone = useTimeZone();
  const creditsQ = useCredits();
  const summary = creditsQ.data?.summary;
  const practice = creditsQ.data?.practice ?? null;

  if (creditsQ.isError && !summary) {
    return (
      <div className={styles.notice} role="alert">
        <p className={styles.body}>{t('usage.error')}</p>
        <div className={styles.actions}>
          <Btn onClick={() => void creditsQ.refetch()}>{t('retry')}</Btn>
        </div>
      </div>
    );
  }

  const isPro = summary?.planProfile === 'pro';
  const buckets = summary ? (summary.buckets as Record<string, BucketSummary | undefined>) : null;
  const rows = buckets
    ? BUCKET_ORDER.filter((b) => buckets[b] && buckets[b]!.cap > 0).map((b) => [b, buckets[b]!] as const)
    : [];

  const now = new Date();
  const timeZone = knownTimeZone(summary?.timezone, appTimeZone);
  const refill = (b: BucketSummary) => {
    const at = parseDate(b.resetsAt);
    return at ? refillLabel({ at, now, locale, timeZone }) : '—';
  };

  return (
    <div className={styles.stack} data-testid="credits-usage">
      <section className={styles.card} aria-labelledby="credits-today">
        <div className={styles.cardHead}>
          <h2 className={styles.h2} id="credits-today">
            {t('usage.title')}
          </h2>
        </div>
        <p className={styles.muted}>{t('usage.sub')}</p>
        {!summary ? (
          <p className={styles.muted} aria-busy="true">
            {t('usage.loading')}
          </p>
        ) : (
          <ul className={styles.list}>
            {rows.map(([bucket, b]) => {
              const left = Math.max(0, b.remaining);
              const pct = b.cap > 0 ? Math.max(0, Math.min(100, (left / b.cap) * 100)) : 0;
              return (
                <li key={bucket} className={styles.row} data-bucket={bucket}>
                  <span className={styles.rowLabel}>{t(bucketLabelKey(bucket))}</span>
                  <span className={styles.rowValue}>
                    {t('usage.left', { left, cap: b.cap })}
                    {b.grantRemaining > 0 ? ` ${t('usage.bonus', { n: b.grantRemaining })}` : ''}
                  </span>
                  <span className={styles.meter} aria-hidden="true">
                    <span className={styles.meterFill} style={{ display: 'block', width: `${pct}%` }} />
                  </span>
                  <span className={styles.rowMeta}>
                    {t(isPro ? 'cap.pro' : 'cap.free', { cap: b.cap, window: b.window })} · {t('usage.resets', { when: refill(b) })}
                  </span>
                </li>
              );
            })}
            <li className={styles.row} data-bucket="practice">
              <span className={styles.rowLabel}>{t('buckets.practice')}</span>
              <span className={styles.rowValue}>{practice ? t('usage.practiceLeft', { n: practice.balance }) : '—'}</span>
            </li>
          </ul>
        )}
      </section>
      {hideHistory ? null : <CreditHistory timeZone={timeZone} zoneKnown={Boolean(summary)} />}
    </div>
  );
}

/**
 * `timeZone` is the account's zone (the one the refill times use). Rows wait
 * for it (`zoneKnown`), so a time is never shown in one zone and then moved
 * to another when the summary arrives.
 */
function CreditHistory({ timeZone, zoneKnown }: { timeZone: string | undefined; zoneKnown: boolean }) {
  const t = useTranslations('credits');
  const format = useFormatter();
  const q = useCreditHistory(20);
  const hasRows = Boolean(q.data && q.data.items.length > 0);
  const waitingForZone = hasRows && !zoneKnown;
  return (
    <section className={styles.card} aria-labelledby="credits-history">
      <h2 className={styles.h2} id="credits-history">
        {t('usage.historyTitle')}
      </h2>
      {q.isLoading || waitingForZone ? <p className={styles.muted} aria-busy="true">{t('usage.loading')}</p> : null}
      {q.isError ? <p className={styles.muted}>{t('usage.historyUnavailable')}</p> : null}
      {q.data && q.data.items.length === 0 ? <p className={styles.muted}>{t('usage.historyEmpty')}</p> : null}
      {q.data && hasRows && zoneKnown ? (
        <ul className={styles.list}>
          {q.data.items.map((row) => {
            const at = parseDate(row.at);
            return (
              <li key={row.id} className={styles.row}>
                <span className={styles.rowLabel}>{t(bucketLabelKey(row.bucket))}</span>
                <span className={styles.rowValue}>{t('usage.used', { n: row.amount })}</span>
                <span className={styles.rowMeta}>{at ? format.dateTime(at, { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }) : '—'}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

export default CreditsUsage;
