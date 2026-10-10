'use client';

// PipelineCard — one application as a draggable card (.pipe-card).
//
// Shows company · role · a derived "when" line (follow-up date → applied date →
// a note snippet → saved date). Cards in the last column say who ended it
// (ruling C1). Two ways to move it between columns:
//   • Drag (native HTML5 DnD) — desktop pointer affordance;
//   • the stage <select> — the accessible / keyboard / touch path.
// Both call the same `onMove`. The company name is a button that opens the
// application's details (the job post link lives in the details).

import { useTranslations } from 'next-intl';
import type { TrackerEntryView, TrackerStatus } from '../../../lib/api/contracts/tracker';
import { columnIndexForStatus, type PipelineColumnDef } from './columns';
import styles from './pipeline.module.css';

export const PIPELINE_DND_MIME = 'application/x-roboapply-tracker-id';

interface Props {
  entry: TrackerEntryView;
  /** The brand's columns (the stage menu lists them). */
  columns: PipelineColumnDef[];
  /** Move this entry to a new column/status (drag drop or select change). */
  onMove: (id: string, status: TrackerStatus) => void;
  /** Open the details drawer. */
  onOpen?: (id: string) => void;
  /** Marks the card visually while it's the drag source. */
  dragging: boolean;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
}

/** Pull the display fields from either the hydrated job or the external snapshot. */
function resolveDisplay(entry: TrackerEntryView): { company: string; role: string } {
  if (entry.job) return { company: entry.job.companyName, role: entry.job.title };
  if (entry.externalSnapshot) return { company: entry.externalSnapshot.companyName, role: entry.externalSnapshot.title };
  return { company: '', role: '' };
}

export function PipelineCard({ entry, columns, onMove, onOpen, dragging, onDragStart, onDragEnd }: Props) {
  const t = useTranslations('applications');
  const { company, role } = resolveDisplay(entry);
  const when = useWhenLabel(entry);
  const columnIdx = columnIndexForStatus(entry.status, columns);
  const selectValue = columnIdx === null ? entry.status : columns[columnIdx]!.status;
  const name = company || t('card.untitled_company');

  return (
    <div
      className="pipe-card"
      draggable
      aria-roledescription={t('card.drag_hint')}
      style={dragging ? { opacity: 0.45, borderColor: 'var(--action)' } : undefined}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(PIPELINE_DND_MIME, entry.id);
        // text/plain fallback so the drag image/ghost is sane in all browsers.
        e.dataTransfer.setData('text/plain', entry.id);
        onDragStart(entry.id);
      }}
      onDragEnd={onDragEnd}
    >
      <div className="co">
        {onOpen ? (
          <button type="button" className={styles.open} draggable={false} onClick={() => onOpen(entry.id)} aria-label={t('card.open', { name: `${name}, ${role || t('card.untitled_role')}` })}>
            {name}
          </button>
        ) : (
          name
        )}
      </div>
      <div className="role">{role || t('card.untitled_role')}</div>
      {entry.outcome ? <div className={styles.ended}>{t('card.ended_by', { outcome: t(`outcome.${entry.outcome}`) })}</div> : null}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
        <span className="when">{when}</span>

        <label style={{ display: 'inline-flex', alignItems: 'center', maxWidth: '100%' }} onClick={(e) => e.stopPropagation()}>
          <span className="sr-only">{t('card.move_label', { role: role || company })}</span>
          <select
            className={styles.stageSelect}
            value={selectValue}
            onChange={(e) => onMove(entry.id, e.target.value as TrackerStatus)}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {columns.map((col) => (
              <option key={col.status} value={col.status}>
                {t(`columns.${col.labelKey}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

/** Human "when" sub-line: follow-up > applied > note snippet > saved. */
function useWhenLabel(entry: TrackerEntryView): string {
  const t = useTranslations('applications');
  if (entry.followUpAt) {
    return t('when.follow_up', { date: formatShort(entry.followUpAt) });
  }
  if (entry.dateApplied) {
    return t('when.applied', { ago: relativeAgo(entry.dateApplied, t) });
  }
  if (entry.notesMarkdown && entry.notesMarkdown.trim()) {
    return entry.notesMarkdown.trim().replace(/\s+/g, ' ').slice(0, 28);
  }
  return t('when.saved', { ago: relativeAgo(entry.dateSaved, t) });
}

function formatShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "2h" / "1d" / "3w" style relative label (uses t() for the unit suffixes). */
function relativeAgo(iso: string, t: ReturnType<typeof useTranslations>): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return t('ago.now');
  if (mins < 60) return t('ago.minutes', { n: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t('ago.hours', { n: hours });
  const days = Math.round(hours / 24);
  if (days < 7) return t('ago.days', { n: days });
  const weeks = Math.round(days / 7);
  return t('ago.weeks', { n: weeks });
}
