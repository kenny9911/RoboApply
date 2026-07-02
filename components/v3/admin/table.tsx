'use client';

// components/v3/admin/table.tsx
//
// DataTable<Row> — the shared sortable / paginated dark table used by Users,
// Sessions, and the drill-down ledgers. Real <table> semantics with
// <th scope="col">, aria-sort on sortable headers (which are <button>s), and a
// mono tabular body. Row click is an enhancement (the row is given a pointer +
// onClick); a focusable cell remains the canonical path.
//
// States mirror activity/page.tsx: error → retry panel, loading → shimmer
// rows, empty → inline mono message, else the rows.

import type { ReactNode } from 'react';
import { Btn } from '../primitives/Btn';

export type SortDir = 'asc' | 'desc';

export interface SortState<K extends string = string> {
  key: K;
  dir: SortDir;
}

export interface Column<Row, K extends string = string> {
  key: K;
  header: ReactNode;
  align?: 'left' | 'right';
  sortable?: boolean;
  render: (row: Row) => ReactNode;
  /** Lower-priority columns can be hidden on narrow screens via CSS later. */
  width?: number | string;
}

export interface DataTableProps<Row, K extends string = string> {
  columns: Column<Row, K>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  loading?: boolean;
  error?: boolean;
  onRowClick?: (row: Row) => void;
  /** Adds a faint red wash to a row (unprofitable users). */
  rowDanger?: (row: Row) => boolean;
  sort?: SortState<K>;
  onSortChange?: (s: SortState<K>) => void;
  // Pagination (optional)
  page?: number;
  pageSize?: number;
  total?: number;
  onPageChange?: (page: number) => void;
  paginationLabel?: (from: number, to: number, total: number) => string;
  prevLabel?: string;
  nextLabel?: string;
  // Zero-states
  emptyMessage?: ReactNode;
  errorTitle?: ReactNode;
  errorBody?: ReactNode;
  retryLabel?: ReactNode;
  onRetry?: () => void;
  loadingLabel?: string;
}

export function DataTable<Row, K extends string = string>({
  columns,
  rows,
  rowKey,
  loading,
  error,
  onRowClick,
  rowDanger,
  sort,
  onSortChange,
  page,
  pageSize,
  total,
  onPageChange,
  paginationLabel,
  prevLabel = 'Prev',
  nextLabel = 'Next',
  emptyMessage,
  errorTitle,
  errorBody,
  retryLabel,
  onRetry,
  loadingLabel,
}: DataTableProps<Row, K>) {
  // Error
  if (error) {
    return (
      <div
        role="alert"
        style={{
          border: '1px solid var(--rule)',
          background: 'var(--surface)',
          borderRadius: 14,
          padding: '40px 32px',
          textAlign: 'center',
        }}
      >
        <p style={{ fontFamily: 'var(--sans)', fontSize: 16, fontWeight: 600, color: 'var(--text)', margin: '0 0 8px' }}>
          {errorTitle}
        </p>
        {errorBody ? (
          <p style={{ color: 'var(--text-2)', fontSize: 14, margin: '0 auto 16px', maxWidth: 420 }}>{errorBody}</p>
        ) : null}
        {onRetry ? (
          <Btn variant="primary" onClick={onRetry}>
            {retryLabel}
          </Btn>
        ) : null}
      </div>
    );
  }

  function toggleSort(col: Column<Row, K>) {
    if (!col.sortable || !onSortChange) return;
    if (sort?.key === col.key) {
      onSortChange({ key: col.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' });
    } else {
      onSortChange({ key: col.key, dir: 'asc' });
    }
  }

  const showPagination =
    typeof page === 'number' &&
    typeof pageSize === 'number' &&
    typeof total === 'number' &&
    !!onPageChange;

  const from = showPagination ? (page! - 1) * pageSize! + 1 : 0;
  const to = showPagination ? Math.min(page! * pageSize!, total!) : 0;

  return (
    <div>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          border: '1px solid var(--rule)',
          borderRadius: 14,
          overflow: 'hidden',
          background: 'var(--surface)',
        }}
      >
        <thead>
          <tr>
            {columns.map((col) => {
              const isSorted = sort?.key === col.key;
              const ariaSort = col.sortable
                ? isSorted
                  ? sort!.dir === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none'
                : undefined;
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={ariaSort}
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: 'var(--muted)',
                    fontWeight: 600,
                    textAlign: col.align === 'right' ? 'right' : 'left',
                    padding: '13px 16px',
                    borderBottom: '1px solid var(--rule)',
                    background: 'var(--bg-2)',
                    whiteSpace: 'nowrap',
                    width: col.width,
                  }}
                >
                  {col.sortable && onSortChange ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(col)}
                      style={{
                        background: 'transparent',
                        border: 0,
                        font: 'inherit',
                        color: 'inherit',
                        cursor: 'pointer',
                        padding: 0,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        flexDirection: col.align === 'right' ? 'row-reverse' : 'row',
                        textTransform: 'inherit',
                        letterSpacing: 'inherit',
                      }}
                    >
                      {col.header}
                      {isSorted ? (
                        <span aria-hidden="true" style={{ color: 'var(--accent-text)' }}>
                          {sort!.dir === 'asc' ? '▲' : '▼'}
                        </span>
                      ) : null}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <SkeletonRows colCount={columns.length} label={loadingLabel} />
          ) : rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                style={{
                  padding: '40px 16px',
                  textAlign: 'center',
                  fontFamily: 'var(--mono)',
                  fontSize: 13,
                  color: 'var(--muted)',
                }}
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const danger = rowDanger?.(row);
              return (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  style={{
                    cursor: onRowClick ? 'pointer' : 'default',
                    background: danger ? 'rgba(239,68,68,0.05)' : undefined,
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background = danger
                      ? 'rgba(239,68,68,0.09)'
                      : 'var(--surface-2)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = danger
                      ? 'rgba(239,68,68,0.05)'
                      : '';
                  }}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      style={{
                        padding: '13px 16px',
                        borderBottom: '1px solid var(--rule-soft)',
                        fontSize: 13,
                        verticalAlign: 'middle',
                        textAlign: col.align === 'right' ? 'right' : 'left',
                        fontFamily: col.align === 'right' ? 'var(--mono)' : undefined,
                        fontVariantNumeric: col.align === 'right' ? 'tabular-nums' : undefined,
                        color: 'var(--text)',
                      }}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      {showPagination && !loading && rows.length > 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 14,
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--muted)',
          }}
        >
          <span>
            {paginationLabel ? paginationLabel(from, to, total!) : `${from}–${to} of ${total}`}
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <Btn variant="ghost" onClick={() => onPageChange!(Math.max(1, page! - 1))} disabled={page! <= 1}>
              ‹ {prevLabel}
            </Btn>
            <Btn variant="ghost" onClick={() => onPageChange!(page! + 1)} disabled={to >= total!}>
              {nextLabel} ›
            </Btn>
          </span>
        </div>
      ) : null}
    </div>
  );
}

function SkeletonRows({ colCount, label }: { colCount: number; label?: string }) {
  return (
    <>
      {Array.from({ length: 8 }).map((_, r) => (
        <tr key={r} className="animate-pulse" aria-busy="true" aria-label={r === 0 ? label : undefined}>
          {Array.from({ length: colCount }).map((__, c) => (
            <td key={c} style={{ padding: '13px 16px', borderBottom: '1px solid var(--rule-soft)' }}>
              <div style={{ height: 12, borderRadius: 4, background: 'var(--surface-2)', width: c === 0 ? '70%' : '50%', marginLeft: c === 0 ? 0 : 'auto' }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ── UserCell ─────────────────────────────────────────────────────────────
//
// The avatar-initial + email + mono "member …" sub used in the Users table.

export function UserCell({
  email,
  name,
  sub,
}: {
  email: string;
  name?: string | null;
  sub?: ReactNode;
}) {
  const initial = (name?.trim()?.[0] || email?.[0] || '?').toUpperCase();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
      <div
        aria-hidden="true"
        style={{
          width: 30,
          height: 30,
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'var(--mono)',
          fontSize: 11,
          fontWeight: 700,
          flexShrink: 0,
          background: 'var(--grad-brand)',
          color: 'var(--accent-ink)',
        }}
      >
        {initial}
      </div>
      <div>
        <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{email}</div>
        {sub ? <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>{sub}</div> : null}
      </div>
    </div>
  );
}
