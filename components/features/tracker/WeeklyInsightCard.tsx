'use client';

// WeeklyInsightCard — the top card of /applications?view=date (ruling C40).
//
// The counts are real counts from the user's own applications. The summary
// below them exists only when an AI model wrote it; it is labelled as AI
// (GoApply also renders AiGeneratedBadge) and the button to write it shows
// only when the account may use AI (consent + a model, `aiAvailable`).

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, Markdown } from '../../v3/primitives';
import { MetricGrid } from '../../v3/primitives/MetricGrid';
import { AiGeneratedBadge } from '../market';
import { PhoneBindingNotice } from '../auth-cn';
import { useRefreshWeeklyInsight, useWeeklyInsight } from '../../../hooks/tracker/useTracker';
import { apiErrorCode } from '../../../lib/api/contracts/wire';
import type { TrackerEntryView } from '../../../lib/api/contracts/tracker';
import { entryCompany, entryRole, localWeekStart, useDateFormat, weekStartOfDay } from './shared';
import styles from './tracker.module.css';

export interface WeeklyInsightCardProps {
  /** Entries used to name the applications the summary cites. */
  entries: readonly TrackerEntryView[];
  /** The moment "this week" is read from (tests pin it); the clock by default. */
  now?: Date;
}

/**
 * The week the card shows and whether the server's current (UTC) week is that
 * same week. Pure, for tests.
 */
export function shownWeek(now: Date): { week: string; sameAsServerWeek: boolean } {
  const week = localWeekStart(now);
  return { week, sameAsServerWeek: week === weekStartOfDay(now.toISOString().slice(0, 10)) };
}

/** The model cites applications by id; show their names instead. */
export function nameCitations(markdown: string, ids: readonly string[], entries: readonly TrackerEntryView[]): string {
  let out = markdown;
  for (const id of ids) {
    const e = entries.find((x) => x.id === id);
    const name = e ? [entryCompany(e), entryRole(e)].filter(Boolean).join(', ') : '';
    out = out.split(id).join(name);
  }
  return out;
}

export function WeeklyInsightCard({ entries, now }: WeeklyInsightCardProps) {
  const t = useTranslations('applications');
  const { day } = useDateFormat();
  // "This week" is the reader's week (their own Sunday), not the UTC one: on a
  // Sunday morning in Taipei the UTC week has not turned yet.
  // A summary is written for the server's current week (UTC). For the few hours
  // a week in which that is not the week on screen, none is offered rather than
  // one about a different week.
  const { week, sameAsServerWeek: sameWeek } = useMemo(() => shownWeek(now ?? new Date()), [now]);
  const { data, isLoading, isError } = useWeeklyInsight(week);
  const refresh = useRefreshWeeklyInsight(week);
  const facts = data?.facts;
  const value = (n: number | undefined) => (facts && typeof n === 'number' ? n : '—');
  const summary = useMemo(
    () => (data?.insight ? nameCitations(data.insight.summaryMarkdown, data.insight.citedTrackerIds, entries) : ''),
    [data, entries],
  );

  const errorCode = refresh.isError ? apiErrorCode(refresh.error) : null;
  const errorKey =
    errorCode === 'ai_unavailable'
      ? 'weekly.error_ai_unavailable'
      : errorCode === 'content_blocked'
        ? 'weekly.error_content_blocked'
        : errorCode === 'rate_limited'
          ? 'weekly.error_rate_limited'
          : 'weekly.error_generic';

  return (
    <section className={styles.weekly} aria-labelledby="applications-weekly">
      <div className={styles.weeklyHead}>
        <h2 id="applications-weekly" className={styles.weeklyTitle}>
          {t('weekly.title')}
        </h2>
        {data ? <span className={styles.muted}>{t('weekly.range', { start: day(data.week.startUtc), end: day(data.week.endUtc) })}</span> : null}
      </div>
      {isLoading ? <p className={styles.muted}>{t('weekly.loading')}</p> : null}
      {isError ? <p className={styles.muted}>{t('weekly.load_error')}</p> : null}
      <MetricGrid
        label={t('weekly.label')}
        items={[
          { label: t('weekly.applied'), value: value(facts?.applied) },
          { label: t('weekly.interviews'), value: value(facts?.interviews) },
          { label: t('weekly.offers'), value: value(facts?.offers) },
          { label: t('weekly.ended'), value: value(facts?.ended) },
          { label: t('weekly.no_reply'), value: value(facts?.noReply10d) },
        ]}
      />
      {facts ? <p className={styles.hint}>{t('weekly.counts_note')}</p> : null}

      {data?.insight ? (
        <div className={styles.summary}>
          <div className={styles.aiLine}>
            <AiGeneratedBadge />
            <p className={styles.hint}>{t('weekly.ai_label')}</p>
          </div>
          <Markdown block>{summary}</Markdown>
        </div>
      ) : null}

      {data?.aiAvailable && sameWeek ? (
        <div className={styles.weeklyActions}>
          <Btn variant="default" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? t('weekly.writing') : data.insight ? t('weekly.rewrite') : t('weekly.write')}
          </Btn>
          {refresh.isError && errorCode !== 'phone_binding_required' ? (
            <p role="alert" className={styles.error}>
              {t(errorKey)}
            </p>
          ) : null}
          {refresh.isError ? <PhoneBindingNotice error={refresh.error} /> : null}
        </div>
      ) : null}
    </section>
  );
}
