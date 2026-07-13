'use client';

// /account/usage — Usage report tab.
//
// A value-framed view of activity (counts only, never cost): a by-day heatmap,
// per-feature allowance meters against the tier cap, and a short recent-activity
// list derived from the feature counts. Data: GET /account/usage (aggregated
// UsageDeductionLog + RoboApplyMission cap). The shared layout owns the header
// and tabs.

import { useTranslations } from 'next-intl';

import { Btn } from '../../../../components/v3/primitives/Btn';
import {
  ActivityHeatmap,
  UsageMeter,
  RecentActivityList,
  tierLabel,
  type RecentActivityItem,
} from '../../../../components/v3/account';
import { useAccountUsage } from '../../../../hooks/useAccount';

// Local UTC tz so the heatmap day buckets line up with the "Resets daily at
// midnight UTC" copy. (Provider pins next-intl timeZone=UTC.)
const USAGE_TZ = 'UTC';

export default function AccountUsagePage() {
  const t = useTranslations('account');
  const usageQ = useAccountUsage({ tz: USAGE_TZ });

  if (usageQ.isError) {
    return (
      <div
        role="alert"
        className="flex flex-col items-center gap-4 text-center"
        style={{ border: '1px solid var(--rule)', background: 'var(--surface)', borderRadius: 'var(--r-xl)', padding: '52px 32px' }}
      >
        <p style={{ fontFamily: 'var(--sans)', fontSize: '18px', fontWeight: 600, color: 'var(--text)', margin: 0 }}>
          {t('error.title')}
        </p>
        <p style={{ color: 'var(--text-2)', fontSize: '14px', maxWidth: 420, margin: 0 }}>{t('error.body')}</p>
        <Btn variant="primary" onClick={() => void usageQ.refetch()}>{t('error.retry')}</Btn>
      </div>
    );
  }

  if (usageQ.isLoading || !usageQ.data) {
    return <UsageSkeleton label={t('loading')} />;
  }

  const usage = usageQ.data;
  const tierLabelText = tierLabel(t, usage.tier);
  const recentItems = buildRecentItems(usage.byFeature, t);

  return (
    <>
      <div className="ra-usage-grid">
        <ActivityHeatmap days={usage.byDay} totalActions={usage.totalActions} />
        <UsageMeter
          features={usage.byFeature}
          cap={usage.dailyCap}
          tier={usage.tier}
          tierLabelText={tierLabelText}
        />
      </div>
      {recentItems.length > 0 ? <RecentActivityList items={recentItems} /> : null}
    </>
  );
}

/** Derive a short, positively-framed recent-activity list from the feature
 *  counts (the usage contract has no per-action feed). Top features first. */
function buildRecentItems(
  byFeature: { key: string; label: string; count: number }[],
  t: (k: string, v?: Record<string, string>) => string,
): RecentActivityItem[] {
  return byFeature
    .filter((f) => f.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((f) => ({
      id: f.key,
      time: String(f.count),
      body: <span>{t('usage.recentItem', { count: String(f.count), feature: f.label })}</span>,
    }));
}

function UsageSkeleton({ label }: { label: string }) {
  const shimmer = (): React.CSSProperties => ({ background: 'var(--surface-2)', borderRadius: 8 });
  return (
    <div className="animate-pulse" aria-busy="true" aria-label={label}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={{ ...shimmer(), height: 220 }} />
        <div style={{ ...shimmer(), height: 220 }} />
      </div>
    </div>
  );
}
