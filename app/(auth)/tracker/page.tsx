'use client';

// /tracker — V3 "Pipeline" screen (IA Route 8).
//
// A four-column kanban of the user's active job conversations, synced from the
// tracker. Layout (the (auth) shell already provides the .main-inner wrapper,
// so we render only the body):
//
//   PageHeader     eyebrow "{n} active conversations" + headline + sub
//   PipelineBoard  the kanban grid (columns: Saved / Applied / Interview / Offer)
//
// Status changes persist via `tracker.patch` — either by dragging a card to
// another column or via the per-card status <select> (the accessible fallback).
//
// Column model + bucketing live in components/v3/pipeline/* (the board owns the
// data read so the count here shares the same TanStack cache entry — no double
// fetch).

import { useTranslations } from 'next-intl';

import { PageHeader } from '../../../components/v3/primitives';
import { PipelineBoard } from '../../../components/v3/pipeline';
import {
  PIPELINE_COLUMNS,
  columnIndexForStatus,
} from '../../../components/v3/pipeline';
import { usePipelineBoard } from '../../../hooks/usePipelineBoard';

/**
 * The copy register. This used to fork three ways off the `tone` knob in
 * lib/dcTheme (formal | casual | witty); the knob is deleted, so the page now
 * always renders what the default (`casual` → `direct`) always rendered.
 * Collapsing `pipeline.headline.*` / `pipeline.sub.*` down to a single string
 * across all nine locales belongs to the i18n pass — see OVERHAUL_SPEC.md
 * §"Delete within surviving namespaces".
 */
const COPY_VARIANT = 'direct';

export default function PipelinePage() {
  const t = useTranslations('pipeline');
  const { data } = usePipelineBoard();

  // Active conversations = entries that land on a (non-terminal) column.
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
        title={t(`headline.${COPY_VARIANT}`)}
        sub={t(`sub.${COPY_VARIANT}`, { columns: PIPELINE_COLUMNS.length })}
      />

      <PipelineBoard />
    </>
  );
}
