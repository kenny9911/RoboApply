'use client';

// /applications — "where did I apply, and what happened?" (WP-38; PRODUCT
// F-TRK-01…03, F-NOTIF-08 facts, F-JOB-07).
//
//   PageHeader      "{n} in progress" + headline + how to move cards
//   toolbar         Add a job · Download as CSV
//   FollowUpBanner  facts that need attention (no reply in 10 days, …; C11)
//   Tabs            By stage · By date · List · Offers (flag `offers`)
//   view            board (C1 / GoApply ladder) · weekly card + by week (C40)
//                   · search + stage filter (saved: open vs closed) · offers
//   TrackerDrawer   one application's details (`?entry=<id>`; fetched by id when
//                   it is not among the loaded entries)
//
// URL: `?view=stage|date|list|offers`, `?status=saved` (opens the List view on
// Saved), `?entry=<id>` (opens the details). The user-facing names avoid
// "board", "kanban", "pipeline" and "funnel" (ruling C15); code keeps the
// `pipeline` prefix.

import { Suspense, useCallback, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { PageHeader, Tabs, tabPanelProps } from '../../../components/v3/primitives';
import { MetricGrid } from '../../../components/v3/primitives/MetricGrid';
import { PipelineBoard, columnsFor, columnIndexForStatus, isInProgress, type TrackerMarket } from '../../../components/v3/pipeline';
import { AddJobSheet, ApplicationsToolbar, ByDateView, FollowUpBanner, ListView, OffersView, TrackerDrawer } from '../../../components/features/tracker';
import { usePipelineBoard } from '../../../hooks/usePipelineBoard';
import { useTrackerEntry } from '../../../hooks/tracker/useTracker';
import { useBrand } from '../../../lib/brand';
import { useFlag } from '../../../lib/flags';

type View = 'stage' | 'date' | 'list' | 'offers';
const VIEWS: readonly View[] = ['stage', 'date', 'list', 'offers'];
const TABS_ID = 'applications-views';

export default function ApplicationsPage() {
  return (
    <Suspense fallback={null}>
      <Applications />
    </Suspense>
  );
}

function Applications() {
  const t = useTranslations('applications');
  const router = useRouter();
  const pathname = usePathname() ?? '/applications';
  const params = useSearchParams();
  const offersOn = useFlag('offers');
  const columns = columnsFor(useBrand().market as TrackerMarket);
  const { data } = usePipelineBoard();
  const [adding, setAdding] = useState(false);

  const statusParam = params?.get('status') ?? null;
  const requested = (params?.get('view') ?? (statusParam ? 'list' : 'stage')) as View;
  const view: View = VIEWS.includes(requested) && (requested !== 'offers' || offersOn) ? requested : 'stage';
  const entryId = params?.get('entry') ?? null;

  const setParams = useCallback(
    (next: Record<string, string | null>) => {
      const qs = new URLSearchParams(params?.toString() ?? '');
      for (const [k, v] of Object.entries(next)) {
        if (v === null) qs.delete(k);
        else qs.set(k, v);
      }
      const s = qs.toString();
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
  const openEntry = useCallback((id: string) => setParams({ entry: id }), [setParams]);
  const closeEntry = useCallback(() => setParams({ entry: null }), [setParams]);

  const entries = useMemo(() => data?.entries ?? [], [data]);
  const activeCount = entries.filter((e) => isInProgress(e.status) && columnIndexForStatus(e.status, columns) !== null).length;
  const cached = entryId ? (entries.find((e) => e.id === entryId) ?? null) : null;
  // A link can point past the entries loaded here (the page loads the 200 most
  // recently changed): fetch that one entry by id.
  const linked = useTrackerEntry(entryId && data && !cached ? entryId : null);
  const open = cached ?? (entryId && linked.data?.id === entryId ? linked.data : null);
  const notFound = Boolean(entryId && !open && linked.isError);
  const total = data?.total ?? 0;

  const tabs = [
    { id: 'stage' as const, label: t('views.stage') },
    { id: 'date' as const, label: t('views.date') },
    { id: 'list' as const, label: t('views.list'), count: data ? total : null },
    ...(offersOn ? [{ id: 'offers' as const, label: t('views.offers') }] : []),
  ];

  return (
    <>
      <PageHeader
        eyebrow={data ? t('eyebrow', { count: activeCount }) : t('loading')}
        eyebrowLive={Boolean(data)}
        title={t('headline')}
        sub={t('subtitle')}
      />

      <MetricGrid
        label={t('page_title')}
        items={columns
          .filter((c) => !c.terminal)
          .map((column) => ({
            label: t(`columns.${column.labelKey}`),
            value: data ? column.members.reduce((n, m) => n + (data.statusCounts[m] ?? 0), 0) : '—',
          }))}
      />

      <FollowUpBanner onOpen={openEntry} />

      <ApplicationsToolbar
        onAdd={() => setAdding(true)}
        tabs={
          <Tabs
            ariaLabel={t('views.aria')}
            idBase={TABS_ID}
            value={view}
            onChange={(id) => setParams({ view: id === 'stage' ? null : id, status: null })}
            tabs={tabs}
          />
        }
      />

      <div {...tabPanelProps(TABS_ID, view)}>
        {view === 'stage' ? <PipelineBoard onOpen={openEntry} /> : null}
        {view === 'date' ? <ByDateView entries={entries} onOpen={openEntry} /> : null}
        {view === 'list' ? (
          <ListView
            entries={entries}
            statusCounts={data?.statusCounts}
            total={data ? total : undefined}
            onOpen={openEntry}
            initialStage={statusParam === 'saved' ? 'bookmarked' : ''}
          />
        ) : null}
        {view === 'offers' ? <OffersView entries={entries} onOpen={openEntry} /> : null}
      </div>

      <TrackerDrawer entry={open} notFound={notFound} onClose={closeEntry} />
      <AddJobSheet open={adding} onClose={() => setAdding(false)} onAdded={openEntry} />
    </>
  );
}
