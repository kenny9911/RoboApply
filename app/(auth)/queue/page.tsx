'use client';

// /queue — Review queue (V3 Route 2).
//
// The auto-apply staging area: every match that crossed the user's threshold
// lands here as a drafted application the agent will auto-submit when its timer
// runs out. The recruiter (here, the seeker) reviews each one — read the
// AI-written cover, check the tailoring, then Send now / Edit & send / Skip.
//
// Component tree (00-design-system §6 / 01-ia-and-routes Route 2):
//   PageHeader (eyebrow "{n} pending review")
//   loading → skeleton cards
//   error   → retry panel
//   empty   → EmptyState "Queue clear …"
//   else    → QueueCard ×N
//
// All data flows through useQueue() → raV2Api.queue.* (real backend by
// default; stub only in tests). The shell (Sidebar + Topbar + .main-inner
// wrapper) is provided by (auth)/layout.tsx — this page renders the inner
// content only.
//
// HIDDEN FOR LAUNCH: QUEUE_REVIEW_ENABLED (lib/jobApplying.ts) is false — nav
// entries are filtered out and JobApplyingGate redirects /queue → /home, so
// this page is unreachable until the flag flips back.

import { useTranslations } from 'next-intl';
import { useQueue } from '../../../hooks/useQueue';
import { QueueCard } from '../../../components/v3/queue';
import { PageHeader } from '../../../components/v3/primitives/PageHeader';
import { EmptyState } from '../../../components/v3/primitives/EmptyState';
import { Btn } from '../../../components/v3/primitives/Btn';

export default function QueuePage() {
  const t = useTranslations('queue');
  const query = useQueue();

  const items = query.data?.items ?? [];
  const pendingCount = query.data?.pendingCount ?? items.length;

  // ── Header (always shown so the page has a stable frame across states) ──
  const header = (
    <PageHeader
      eyebrow={t('eyebrow', { count: pendingCount })}
      eyebrowLive
      title={t('title')}
      accentWord={t('titleAccent')}
      titleAfter={t('titleAfter')}
      sub={t('sub')}
    />
  );

  // ── Error ──
  if (query.isError) {
    return (
      <>
        {header}
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
          <Btn variant="primary" onClick={() => void query.refetch()}>
            {t('error.retry')}
          </Btn>
        </div>
      </>
    );
  }

  // ── Loading ──
  if (query.isLoading) {
    return (
      <>
        {header}
        <div aria-busy="true" aria-label={t('loading')}>
          {[0, 1].map((i) => (
            <QueueCardSkeleton key={i} />
          ))}
        </div>
      </>
    );
  }

  // ── Empty ──
  if (items.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          icon={<span style={{ fontSize: 34 }}>🎉</span>}
          title={t('empty.title')}
          accentWord={t('empty.titleAccent')}
          sub={t('empty.sub')}
        />
      </>
    );
  }

  // ── List ──
  return (
    <>
      {header}
      {items.map((item, i) => (
        <QueueCard key={item.id} item={item} index={i} />
      ))}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Skeleton — a quiet shimmer placeholder matching the queue-card frame so
// the layout doesn't reflow when the real cards land.
// ─────────────────────────────────────────────────────────────────────

function shimmer(): React.CSSProperties {
  return { background: 'var(--surface-2)', borderRadius: 6 };
}

function QueueCardSkeleton() {
  return (
    <div className="queue-card animate-pulse" aria-hidden="true">
      <div className="queue-head">
        <div className="left">
          <div style={{ ...shimmer(), width: 44, height: 44, borderRadius: 11 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ ...shimmer(), width: 280, height: 18 }} />
            <div style={{ ...shimmer(), width: 160, height: 13 }} />
          </div>
        </div>
        <div style={{ ...shimmer(), width: 150, height: 34, borderRadius: 9 }} />
      </div>
      <div
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--rule)',
          borderRadius: 11,
          padding: '18px 20px',
          margin: '0 0 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ ...shimmer(), width: 200, height: 12 }} />
        <div style={{ ...shimmer(), width: '100%', height: 12 }} />
        <div style={{ ...shimmer(), width: '92%', height: 12 }} />
        <div style={{ ...shimmer(), width: '78%', height: 12 }} />
      </div>
      <div className="qcheck">
        {[0, 1, 2, 3].map((i) => (
          <div key={i}>
            <div style={{ ...shimmer(), width: 18, height: 18, borderRadius: '50%' }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 1 }}>
              <div style={{ ...shimmer(), width: 50, height: 9 }} />
              <div style={{ ...shimmer(), width: '70%', height: 12 }} />
            </div>
          </div>
        ))}
      </div>
      <div className="queue-actions">
        <div className="left">
          <div style={{ ...shimmer(), width: 110, height: 36, borderRadius: 9 }} />
          <div style={{ ...shimmer(), width: 100, height: 36, borderRadius: 9 }} />
        </div>
        <div style={{ ...shimmer(), width: 60, height: 36, borderRadius: 9 }} />
      </div>
    </div>
  );
}
