'use client';

// /applications — destination 3 of 4: "where did I apply, and what happened?"
//
// Route, nav label, page H1 and i18n namespace all share the name
// `applications` (ruling D2/D3). This was `/tracker`; "tracker" names the
// filing cabinet, not the question.
//
// A stage view of the user's live applications, synced from the tracker.
// Layout (the (auth) shell already provides the .main-inner wrapper, so we
// render only the body):
//
//   PageHeader     eyebrow "{n} in progress" + headline + sub
//   PipelineBoard  the stage columns (Saved / Applied / Interviewing / Offer)
//
// The user-facing name for this arrangement is "By stage" (ruling C15 —
// "board", "kanban", "pipeline" and "funnel" are banned from UI copy). The
// component and CSS keep the `pipeline` prefix; that is code, not copy.
//
// Status changes persist via `tracker.patch` — either by dragging a card to
// another column or via the per-card stage <select> (the accessible fallback).
//
// Column model + bucketing live in components/v3/pipeline/* (the board owns the
// data read so the count here shares the same TanStack cache entry — no double
// fetch). Only four of the seven C1 rungs render today; columns.ts explains
// which data change unlocks the other three.

import { useTranslations } from 'next-intl';

import { PageHeader } from '../../../components/v3/primitives';
import { PipelineBoard } from '../../../components/v3/pipeline';
import {
  PIPELINE_COLUMNS,
  columnIndexForStatus,
} from '../../../components/v3/pipeline';
import { usePipelineBoard } from '../../../hooks/usePipelineBoard';

export default function ApplicationsPage() {
  const t = useTranslations('applications');
  const { data } = usePipelineBoard();

  // In progress = entries that land on a (non-terminal) column.
  const activeCount = data
    ? data.entries.reduce(
        (n, e) => (columnIndexForStatus(e.status) !== null ? n + 1 : n),
        0,
      )
    : 0;

  return (
    <>
      <PageHeader
        eyebrow={t('eyebrow', { count: activeCount })}
        eyebrowLive
        title={t('headline')}
        sub={t('sub', { columns: PIPELINE_COLUMNS.length })}
      />

      <PipelineBoard />
    </>
  );
}
