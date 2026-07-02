'use client';

// PipelineBoard — the kanban grid (.pipeline-grid). Owns:
//   • the data read (usePipelineBoard) + the move mutation (usePatchPipelineStatus),
//   • bucketing entries into columns via the shared column model,
//   • drag state (which card is the source) shared across columns,
//   • loading / empty / error states.
//
// Each column's count comes from `statusCounts` (server-derived) summed over the
// column's member statuses, so `count(visible) = Σ column counts` holds. Cards
// within a column are ordered by most-recent activity (updatedAt desc).

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { RATrackerEntryView, RATrackerStatus } from '../../../lib/api/v2';
import {
  usePipelineBoard,
  usePatchPipelineStatus,
} from '../../../hooks/usePipelineBoard';
import { PIPELINE_COLUMNS, columnIndexForStatus } from './columns';
import { PipelineColumn } from './PipelineColumn';
import { Btn } from '../primitives';

export function PipelineBoard() {
  const t = useTranslations('pipeline');
  const { data, isLoading, isError, refetch, isFetching } = usePipelineBoard();
  const patchStatus = usePatchPipelineStatus();
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // Bucket the visible (non-hidden) entries into their columns.
  const buckets = useMemo(() => {
    const cols: RATrackerEntryView[][] = PIPELINE_COLUMNS.map(() => []);
    if (data) {
      for (const e of data.entries) {
        const idx = columnIndexForStatus(e.status);
        if (idx !== null) cols[idx].push(e);
      }
      for (const list of cols) {
        list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      }
    }
    return cols;
  }, [data]);

  // Per-column counts from the server statusCounts (summed over members).
  const counts = useMemo(() => {
    return PIPELINE_COLUMNS.map((col) =>
      data
        ? col.members.reduce((sum, m) => sum + (data.statusCounts[m] ?? 0), 0)
        : 0,
    );
  }, [data]);

  function handleMove(id: string, status: RATrackerStatus) {
    setDraggingId(null);
    // No-op if the card is already in that exact status.
    const current = data?.entries.find((e) => e.id === id);
    if (current && current.status === status) return;
    patchStatus.mutate({ id, status });
  }

  // ── Loading ────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="pipeline-grid" aria-busy="true">
        {PIPELINE_COLUMNS.map((col) => (
          <div key={col.status} className="pipe-col">
            <div className="pipe-head">
              <div
                className="name"
                style={{ opacity: 0.5 }}
              >
                {t(`columns.${col.labelKey}`)}
              </div>
              <div className="count" style={{ opacity: 0.3 }}>
                —
              </div>
            </div>
            <PipelineCardSkeleton />
            <PipelineCardSkeleton />
          </div>
        ))}
        <span className="sr-only">{t('loading')}</span>
      </div>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────
  if (isError || !data) {
    return (
      <div
        role="alert"
        style={{
          border: '1px solid var(--rule)',
          background: 'var(--surface)',
          borderRadius: 'var(--r-xl)',
          padding: '40px 32px',
          textAlign: 'center',
        }}
      >
        <p style={{ color: 'var(--text)', fontWeight: 600, margin: 0 }}>
          {t('error.title')}
        </p>
        <p style={{ color: 'var(--text-2)', fontSize: 14, margin: '8px 0 18px' }}>
          {t('error.body')}
        </p>
        <Btn variant="default" onClick={() => refetch()} disabled={isFetching}>
          {t('error.retry')}
        </Btn>
      </div>
    );
  }

  // ── Fully empty board (no active conversations at all) ────────────────────
  const totalVisible = counts.reduce((a, b) => a + b, 0);
  if (totalVisible === 0) {
    return (
      <div
        style={{
          border: '1px solid var(--rule)',
          background: 'var(--surface)',
          borderRadius: 'var(--r-xl)',
          padding: '52px 32px',
          textAlign: 'center',
        }}
      >
        <h3
          style={{
            fontFamily: 'var(--sans)',
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: '-0.025em',
            color: 'var(--text)',
            margin: 0,
          }}
        >
          {t('empty_board.title')}
          <em
            style={{
              fontFamily: 'var(--serif)',
              fontStyle: 'italic',
              fontWeight: 400,
              color: 'var(--accent-text)',
              padding: '0 4px',
            }}
          >
            {t('empty_board.accent')}
          </em>
        </h3>
        <p style={{ color: 'var(--text-2)', fontSize: 14, margin: '12px auto 0', maxWidth: 420 }}>
          {t('empty_board.body')}
        </p>
      </div>
    );
  }

  // ── Board ────────────────────────────────────────────────────────────────
  return (
    <div className="pipeline-grid">
      {PIPELINE_COLUMNS.map((col, idx) => (
        <PipelineColumn
          key={col.status}
          column={col}
          entries={buckets[idx]}
          count={counts[idx]}
          draggingId={draggingId}
          onMove={handleMove}
          onDragStart={setDraggingId}
          onDragEnd={() => setDraggingId(null)}
        />
      ))}
    </div>
  );
}

function PipelineCardSkeleton() {
  return (
    <div
      className="pipe-card"
      aria-hidden="true"
      style={{ cursor: 'default', opacity: 0.5 }}
    >
      <div
        style={{
          height: 14,
          width: '60%',
          background: 'var(--surface-2)',
          borderRadius: 4,
          marginBottom: 8,
        }}
      />
      <div
        style={{
          height: 11,
          width: '80%',
          background: 'var(--surface-2)',
          borderRadius: 4,
          marginBottom: 10,
        }}
      />
      <div
        style={{
          height: 9,
          width: '35%',
          background: 'var(--surface-2)',
          borderRadius: 4,
        }}
      />
    </div>
  );
}
