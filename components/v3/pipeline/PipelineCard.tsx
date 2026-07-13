'use client';

// PipelineCard — one tracker entry as a draggable kanban card (.pipe-card).
//
// Shows company · role · a derived "when" line (follow-up date → applied date →
// a note snippet → saved date). Two ways to move it between columns:
//   • Drag (native HTML5 DnD) — desktop pointer affordance (the CSS gives it
//     `cursor: grab`); sets the entry id on the dataTransfer.
//   • A status <select> — the accessible / keyboard / touch fallback, visually
//     a small control in the card corner. Both call the same `onMove`.
//
// The whole card is also a clickable link to the job's apply URL when one
// exists, but the <select> stops propagation so changing status never navigates.

import { useTranslations } from 'next-intl';
import type { RATrackerEntryView, RATrackerStatus } from '../../../lib/api/v2';
import { PIPELINE_COLUMNS } from './columns';
import { IconTrash } from '../primitives/Iconset';

export const PIPELINE_DND_MIME = 'application/x-roboapply-tracker-id';

interface Props {
  entry: RATrackerEntryView;
  /** Move this entry to a new column/status (drag drop or select change). */
  onMove: (id: string, status: RATrackerStatus) => void;
  /** Soft-delete this entry (removes the card from the board). */
  onDelete: (id: string) => void;
  /** Marks the card visually while it's the drag source. */
  dragging: boolean;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
}

/** Pull the display fields from either the hydrated job or the external snapshot. */
function resolveDisplay(entry: RATrackerEntryView): {
  company: string;
  role: string;
  applyUrl: string | null;
} {
  if (entry.job) {
    return {
      company: entry.job.companyName,
      role: entry.job.title,
      applyUrl: entry.job.applyUrl ?? null,
    };
  }
  if (entry.externalSnapshot) {
    return {
      company: entry.externalSnapshot.companyName,
      role: entry.externalSnapshot.title,
      applyUrl: entry.externalSnapshot.applyUrl ?? null,
    };
  }
  return { company: '', role: '', applyUrl: null };
}

export function PipelineCard({
  entry,
  onMove,
  onDelete,
  dragging,
  onDragStart,
  onDragEnd,
}: Props) {
  const t = useTranslations('pipeline');
  const { company, role, applyUrl } = resolveDisplay(entry);
  const when = useWhenLabel(entry);

  return (
    <div
      className="pipe-card"
      draggable
      aria-roledescription={t('card.drag_hint')}
      style={dragging ? { opacity: 0.45, borderColor: 'var(--accent-text)' } : undefined}
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
        {applyUrl ? (
          <a
            href={applyUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'inherit', textDecoration: 'none' }}
            // Don't let a stray click during a drag open the tab.
            draggable={false}
          >
            {company || t('card.untitled_company')}
          </a>
        ) : (
          company || t('card.untitled_company')
        )}
      </div>
      <div className="role">{role || t('card.untitled_role')}</div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
        }}
      >
        <span className="when">{when}</span>

        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          {/* Accessible status control — the keyboard/touch path to move a card.
              Styled compactly; click/keyboard never navigates (stopPropagation). */}
          <label
            style={{ display: 'inline-flex', alignItems: 'center' }}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="sr-only">
              {t('card.move_label', { role: role || company })}
            </span>
            <select
              value={entry.status}
              onChange={(e) => onMove(entry.id, e.target.value as RATrackerStatus)}
              onPointerDown={(e) => e.stopPropagation()}
              style={{
                fontFamily: 'var(--mono)',
                fontSize: '9.5px',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                fontWeight: 600,
                color: 'var(--muted)',
                background: 'var(--surface-2)',
                border: '1px solid var(--rule)',
                borderRadius: '6px',
                padding: '3px 5px',
                cursor: 'pointer',
              }}
            >
              {PIPELINE_COLUMNS.map((col) => (
                <option key={col.status} value={col.status}>
                  {t(`columns.${col.labelKey}`)}
                </option>
              ))}
            </select>
          </label>

          {/* Delete (soft) — never triggers drag or the apply-URL link. */}
          <button
            type="button"
            className="pipe-card-del"
            aria-label={t('card.delete_label', { role: role || company })}
            title={t('card.delete_label', { role: role || company })}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onDelete(entry.id);
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '24px',
              height: '24px',
              color: 'var(--muted)',
              background: 'var(--surface-2)',
              border: '1px solid var(--rule)',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            <IconTrash size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Human "when" sub-line: follow-up > applied > note snippet > saved. */
function useWhenLabel(entry: RATrackerEntryView): string {
  const t = useTranslations('pipeline');
  if (entry.followUpAt) {
    return t('when.follow_up', { date: formatShort(entry.followUpAt) });
  }
  if (entry.dateApplied) {
    return t('when.applied', { ago: relativeAgo(entry.dateApplied, t) });
  }
  if (entry.notesMarkdown && entry.notesMarkdown.trim()) {
    const snippet = entry.notesMarkdown.trim().replace(/\s+/g, ' ').slice(0, 28);
    return snippet;
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
