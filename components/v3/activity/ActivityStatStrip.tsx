'use client';

// ActivityStatStrip — the 4-up hero metric row on the Activity log screen
// (Hours saved / Apps sent / Replies / Drafts written). Driven by the
// `useAgentStats` aggregate (activity.orbStats) — the same cheap call that
// feeds the Today strip and the sidebar orb. Renders the shared StatStrip +
// Stat primitives; shows a shimmer skeleton until the aggregate lands.
//
// All captions/deltas are i18n strings under the `activity` namespace.

import { useTranslations } from 'next-intl';
import { StatStrip, Stat } from '../primitives';
import type { RAAgentStats } from '../../../lib/api/v2';

interface Props {
  stats: RAAgentStats | undefined;
  loading: boolean;
}

export function ActivityStatStrip({ stats, loading }: Props) {
  const t = useTranslations('activity');

  if (loading || !stats) {
    return (
      <div className="stat-strip" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
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

  // Reply rate as a whole-percent delta (0.14 → "14%").
  const replyPct = Math.round(stats.replyRate * 100);

  return (
    <StatStrip>
      <Stat
        hero
        label={t('stats.hoursSaved')}
        value={stats.hoursSaved}
        delta={t('stats.thisWeek')}
      />
      <Stat label={t('stats.appsSent')} value={stats.sent} />
      <Stat
        label={t('stats.replies')}
        value={stats.replies}
        delta={replyPct > 0 ? t('stats.replyRate', { percent: replyPct }) : undefined}
      />
      <Stat label={t('stats.draftsWritten')} value={stats.draftsWritten} />
    </StatStrip>
  );
}
