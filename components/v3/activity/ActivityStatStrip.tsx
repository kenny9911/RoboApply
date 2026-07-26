'use client';

// ActivityStatStrip — the hero metric row on the Activity log screen. Driven by
// the `useAgentStats` aggregate (activity.orbStats). Renders the shared
// StatStrip + Stat primitives; shows a shimmer skeleton until the aggregate
// lands.
//
// It was a 4-up: Hours saved / Apps sent / Replies / Drafts written. Three of
// those four were not measurements (ruling D9): `hoursSaved` is `sent × 9 / 60`
// — the same number in a flattering unit — and `replies` (with the reply-rate
// delta hanging off it) is hardcoded to 0 server-side because nothing in the
// product reads a mailbox. What survives is the two counts backed by real rows,
// which is why the props narrow to `RAMeasuredStats`.
//
// All captions are i18n strings under the `activity` namespace.

import { useTranslations } from 'next-intl';
import { StatStrip, Stat } from '../primitives';
import type { RAMeasuredStats } from '../../../hooks/useActivity';

interface Props {
  stats: RAMeasuredStats | undefined;
  loading: boolean;
}

export function ActivityStatStrip({ stats, loading }: Props) {
  const t = useTranslations('activity');

  if (loading || !stats) {
    return (
      <div className="stat-strip" aria-busy="true">
        {Array.from({ length: 2 }).map((_, i) => (
          <div className="stat" key={i}>
            <div
              className="animate-pulse"
              style={{
                height: 12,
                width: '52%',
                borderRadius: 'var(--r-sm)',
                background: 'var(--surface-2)',
                marginBottom: 'var(--sp-3)',
              }}
            />
            <div
              className="animate-pulse"
              style={{
                height: 24,
                width: '40%',
                borderRadius: 'var(--r-sm)',
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
      <Stat hero label={t('stats.appsSent')} value={stats.sent} />
      <Stat label={t('stats.draftsWritten')} value={stats.draftsWritten} />
    </StatStrip>
  );
}
