'use client';

// PipelineColumn — one kanban column (.pipe-col): a toned header (name + count)
// and a vertical stack of PipelineCards, or an italic empty state. The column
// is a drop target: dragging a card over it highlights the border, and dropping
// moves the card to this column's canonical status.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { RATrackerEntryView, RATrackerStatus } from '../../../lib/api/v2';
import type { PipelineColumnDef } from './columns';
import { PipelineCard, PIPELINE_DND_MIME } from './PipelineCard';
import { cn } from '../../../lib/utils';

interface Props {
  column: PipelineColumnDef;
  entries: RATrackerEntryView[];
  count: number;
  draggingId: string | null;
  onMove: (id: string, status: RATrackerStatus) => void;
  onDelete: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
}

export function PipelineColumn({
  column,
  entries,
  count,
  draggingId,
  onMove,
  onDelete,
  onDragStart,
  onDragEnd,
}: Props) {
  const t = useTranslations('pipeline');
  const [isOver, setIsOver] = useState(false);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsOver(false);
    const id =
      e.dataTransfer.getData(PIPELINE_DND_MIME) ||
      e.dataTransfer.getData('text/plain');
    if (id) onMove(id, column.status);
  }

  return (
    <div
      className="pipe-col"
      onDragOver={(e) => {
        // Only react if a card is actually being dragged.
        if (!draggingId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!isOver) setIsOver(true);
      }}
      onDragLeave={(e) => {
        // Ignore leaves into child nodes — only clear when leaving the column.
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setIsOver(false);
      }}
      onDrop={handleDrop}
      style={
        isOver
          ? { borderColor: 'var(--accent-text)', boxShadow: 'var(--shadow-lift)' }
          : undefined
      }
      aria-label={t('column.aria', {
        name: t(`columns.${column.labelKey}`),
        count,
      })}
    >
      <div className={cn('pipe-head', column.tone || undefined)}>
        <div className="name">{t(`columns.${column.labelKey}`)}</div>
        <div className="count">{count}</div>
      </div>

      {entries.length === 0 ? (
        <div className="pipe-empty">{t(`empty.${column.labelKey}`)}</div>
      ) : (
        entries.map((entry) => (
          <PipelineCard
            key={entry.id}
            entry={entry}
            onMove={onMove}
            onDelete={onDelete}
            dragging={draggingId === entry.id}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))
      )}
    </div>
  );
}
