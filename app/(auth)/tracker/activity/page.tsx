'use client';

// /tracker/activity — Activity log tab (was the standalone /activity route).
//
// The agent's receipts: a day-grouped timeline of everything it did on the
// seeker's behalf — applications sent, covers drafted, resumes tailored,
// auto-applies skipped, recruiter messages declined, integrations connected.
// "No black box." Above it, a 4-up hero strip of the week's aggregate
// (Hours saved / Apps sent / Replies / Drafts written).
//
// Component tree (00-design-system §6 / 01-ia-and-routes Route 9):
//   PageHeader (eyebrow "Last 7 days")
//   ActivityStatStrip            ← activity.orbStats (shared aggregate)
//   loading → skeleton timeline
//   error   → retry panel
//   empty   → EmptyState "Nothing logged yet …"
//   else    → ActivityTimeline (day-grouped .log)
//
// Data flows through useActivityFeed() + useAgentStats() → raV2Api.activity.*
// (stub today). The (auth) shell + tracker/layout.tsx (the tab strip) wrap this
// — the page renders the inner content only.

import { useTranslations } from 'next-intl';

import { useActivityFeed, useAgentStats } from '../../../../hooks/useActivity';
import { ActivityStatStrip, ActivityTimeline } from '../../../../components/v3/activity';
import { PageHeader } from '../../../../components/v3/primitives/PageHeader';
import { EmptyState } from '../../../../components/v3/primitives/EmptyState';
import { Btn } from '../../../../components/v3/primitives/Btn';

export default function ActivityPage() {
  const t = useTranslations('activity');
  const feed = useActivityFeed();
  const stats = useAgentStats();

  const days = feed.data?.days ?? [];

  // ── Header (always shown so the page has a stable frame across states) ──
  const header = (
    <PageHeader
      eyebrow={t('eyebrow')}
      eyebrowLive
      title={t('title')}
      accentWord={t('titleAccent')}
      titleAfter={t('titleAfter')}
      sub={t('sub')}
    />
  );

  // The hero strip rides its own (cheap) query — render it across all feed
  // states, with its own loading shimmer, so it never blocks the timeline.
  const strip = (
    <ActivityStatStrip stats={stats.data?.stats} loading={stats.isLoading} />
  );

  // ── Error ──
  if (feed.isError) {
    return (
      <>
        {header}
        {strip}
        <div
          role="alert"
          className="flex flex-col items-center gap-4 text-center"
          style={{
            border: '1px solid var(--rule)',
            background: 'var(--surface)',
            borderRadius: 'var(--r-xl)',
            padding: '52px 32px',
          }}
        >
          <p
            style={{
              fontFamily: 'var(--sans)',
              fontSize: '18px',
              fontWeight: 600,
              color: 'var(--text)',
              margin: 0,
            }}
          >
            {t('error.title')}
          </p>
          <p style={{ color: 'var(--text-2)', fontSize: '14px', maxWidth: 420, margin: 0 }}>
            {t('error.body')}
          </p>
          <Btn variant="primary" onClick={() => void feed.refetch()}>
            {t('error.retry')}
          </Btn>
        </div>
      </>
    );
  }

  // ── Loading ──
  if (feed.isLoading) {
    return (
      <>
        {header}
        {strip}
        <ActivityTimelineSkeleton label={t('loading')} />
      </>
    );
  }

  // ── Empty ──
  if (days.length === 0) {
    return (
      <>
        {header}
        {strip}
        <EmptyState
          icon={<span style={{ fontSize: 34 }}>🗒️</span>}
          title={t('empty.title')}
          accentWord={t('empty.titleAccent')}
          sub={t('empty.sub')}
        />
      </>
    );
  }

  // ── Timeline ──
  return (
    <>
      {header}
      {strip}
      <ActivityTimeline days={days} />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Skeleton — a quiet shimmer matching the .log timeline (one day pill + a
// few entry rows) so the layout doesn't reflow when the real feed lands.
// ─────────────────────────────────────────────────────────────────────

function shimmer(): React.CSSProperties {
  return { background: 'var(--surface-2)', borderRadius: 6 };
}

function ActivityTimelineSkeleton({ label }: { label: string }) {
  return (
    <div className="log animate-pulse" aria-busy="true" aria-label={label}>
      <div className="log-day">
        <span className="pill" style={{ ...shimmer(), width: 150, height: 18, border: 'none' }} />
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div className="log-entry note" key={i} aria-hidden="true">
          <div className="log-time">
            <div style={{ ...shimmer(), width: 42, height: 11 }} />
          </div>
          <div className="log-content" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ ...shimmer(), width: '94%', height: 12 }} />
            <div style={{ ...shimmer(), width: '70%', height: 12 }} />
          </div>
          <div className="log-meta">
            <div style={{ ...shimmer(), width: 56, height: 11, marginLeft: 'auto' }} />
          </div>
        </div>
      ))}
    </div>
  );
}
