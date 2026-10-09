'use client';

// CreditsUsage — /settings#credits: today's credits per bucket with caps and
// refill times, practice interviews left, and recent use (PRODUCT_PLAN.md
// §6.1–§6.2; TASK_PLAN.md WP-21b). Caps print as "10 a day" (Free) or
// "Up to 50 a day" (Pro) — never "unlimited". Unknown values render "—",
// never 0; nothing is computed on the client beyond reading the summary.

import { useFormatter, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { useCredits, type BucketSummary } from '../../../hooks/shared/useCredits';
import { useCreditHistory } from '../../../hooks/credits/useCreditHistory';
import { BUCKET_ORDER, bucketLabelKey, parseDate } from './labels';
import styles from './credits.module.css';

export interface CreditsUsageProps {
  /** Hide the recent-use list (compact surfaces). */
  hideHistory?: boolean;
}

export function CreditsUsage({ hideHistory = false }: CreditsUsageProps) {
  const t = useTranslations('credits');
  const format = useFormatter();
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

  const refill = (b: BucketSummary) => {
    const d = parseDate(b.resetsAt);
    return d ? format.dateTime(d, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
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
      {hideHistory ? null : <CreditHistory />}
    </div>
  );
}

function CreditHistory() {
  const t = useTranslations('credits');
  const format = useFormatter();
  const q = useCreditHistory(20);
  return (
    <section className={styles.card} aria-labelledby="credits-history">
      <h2 className={styles.h2} id="credits-history">
        {t('usage.historyTitle')}
      </h2>
      {q.isLoading ? <p className={styles.muted} aria-busy="true">{t('usage.loading')}</p> : null}
      {q.isError ? <p className={styles.muted}>{t('usage.historyUnavailable')}</p> : null}
      {q.data && q.data.items.length === 0 ? <p className={styles.muted}>{t('usage.historyEmpty')}</p> : null}
      {q.data && q.data.items.length > 0 ? (
        <ul className={styles.list}>
          {q.data.items.map((row) => {
            const at = parseDate(row.at);
            return (
              <li key={row.id} className={styles.row}>
                <span className={styles.rowLabel}>{t(bucketLabelKey(row.bucket))}</span>
                <span className={styles.rowValue}>{t('usage.used', { n: row.amount })}</span>
                <span className={styles.rowMeta}>{at ? format.dateTime(at, { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

export default CreditsUsage;
