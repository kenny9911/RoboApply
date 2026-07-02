'use client';

// TodayStatStrip — the 4-up hero metric row on the Today screen
// (Auto-applied / Scanned overnight / Matched ≥80 / In queue). Driven by the
// `useAgentStats` aggregate (activity.orbStats). Renders the shared StatStrip
// + Stat primitives; shows a shimmer skeleton until the aggregate lands.
//
// All captions/deltas are i18n strings under the `today` namespace.

import { useTranslations } from 'next-intl';
import { StatStrip, Stat } from '../primitives';
import { QUEUE_REVIEW_ENABLED } from '../../../lib/jobApplying';
import type { RAAgentStats } from '../../../lib/api/v2';

interface Props {
  stats: RAAgentStats | undefined;
  loading: boolean;
}

export function TodayStatStrip({ stats, loading }: Props) {
  const t = useTranslations('today');

  if (loading || !stats) {
    return (
      <div className="stat-strip" aria-busy="true">
        {Array.from({ length: QUEUE_REVIEW_ENABLED ? 4 : 3 }).map((_, i) => (
          <div className="stat" key={i}>
            <div
              className="animate-pulse"
              style={{
                height: 11,
                width: '52%',
                borderRadius: 6,
                background: 'var(--surface-2)',
                marginBottom: 12,
              }}
            />
            <div
              className="animate-pulse"
              style={{
                height: 26,
                width: '40%',
                borderRadius: 6,
                background: 'var(--surface-2)',
              }}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <StatStrip>
      <Stat
        hero
        label={t('stats.autoApplied')}
        value={stats.autoAppliedToday}
        delta={t('stats.whileYouSlept')}
      />
      <Stat label={t('stats.scanned')} value={stats.scannedOvernight} />
      <Stat
        label={t('stats.matched')}
        value={stats.matchedAboveThreshold}
        delta={
          stats.matchedAboveThreshold > 0
            ? t('stats.matchedDelta', { count: stats.matchedAboveThreshold })
            : undefined
        }
      />
      {QUEUE_REVIEW_ENABLED ? (
        <Stat label={t('stats.inQueue')} value={stats.inQueue} />
      ) : null}
    </StatStrip>
  );
}
