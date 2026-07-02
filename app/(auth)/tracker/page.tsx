'use client';

// /tracker — V3 "Pipeline" screen (IA Route 8).
//
// A four-column kanban of the user's active job conversations, synced from the
// tracker. Layout (the (auth) shell already provides the .main-inner wrapper,
// so we render only the body):
//
//   PageHeader     eyebrow "{n} active conversations" + tone-aware headline + sub
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
import { useDcTheme, toneFor, type ToneKey } from '../../../lib/dcTheme';

/** Map the dcTheme tone enum → the proto's copy register key. */
function toneVariant(tone: ToneKey): 'direct' | 'playful' | 'formal' {
  return toneFor(tone, {
    formal: 'formal',
    casual: 'direct',
    witty: 'playful',
  });
}

export default function PipelinePage() {
  const t = useTranslations('pipeline');
  const theme = useDcTheme();
  const { data } = usePipelineBoard();

  // Active conversations = entries that land on a (non-terminal) column.
  const activeCount = data
    ? data.entries.reduce(
        (n, e) => (columnIndexForStatus(e.status) !== null ? n + 1 : n),
        0,
      )
    : 0;

  const variant = toneVariant(theme.tone);

  // Headline: the accent word sits mid-sentence, so build the node with its own
  // <em> and pass it as PageHeader's `title` (matches the Home page pattern).
  const headline =
    variant === 'playful' ? (
      <>
        {t('headline.playful.before')}{' '}
        <em>{t('headline.playful.accent')}</em>{' '}
        {t('headline.playful.after')}
      </>
    ) : variant === 'formal' ? (
      <>
        {t('headline.formal.before')}{' '}
        <em>{t('headline.formal.accent')}</em>
        {t('headline.formal.after')}
      </>
    ) : (
      <>
        {t('headline.direct.before')}{' '}
        <em>{t('headline.direct.accent')}</em>{' '}
        {t('headline.direct.after')}
      </>
    );

  return (
    <>
      <PageHeader
        eyebrow={t('eyebrow', { count: activeCount })}
        eyebrowLive
        title={headline}
        sub={t(`sub.${variant}`, { columns: PIPELINE_COLUMNS.length })}
      />

      <PipelineBoard />
    </>
  );
}
