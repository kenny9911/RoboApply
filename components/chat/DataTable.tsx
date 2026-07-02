'use client';

// DataTable — borderless table with --robo-line-soft row dividers. Lives
// inside MessageBubble (Teal §3.8 — "structured data inside conversational
// flow"). Used for match scores, tech stack, claim-checker results, etc.

import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export interface DataTableRow {
  /** Left column — label, dimension name, claim text, etc. */
  label: ReactNode;
  /** Right column — value, badge, percentage, etc. */
  value: ReactNode;
  /** Optional muted helper paragraph under the label. */
  hint?: ReactNode;
}

interface Props {
  rows: DataTableRow[];
  className?: string;
  /** Optional table caption rendered as a small title above the table. */
  caption?: string;
}

export function DataTable({ rows, className, caption }: Props) {
  return (
    <div className={cn('w-full', className)}>
      {caption ? (
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-500">
          {caption}
        </p>
      ) : null}
      <table className="w-full border-collapse text-sm">
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              className={cn(
                'align-top',
                i > 0 && 'border-t border-ink-line-soft',
              )}
            >
              <td className="py-3 pr-4 text-ink-700">
                <div className="font-medium text-ink-900">{row.label}</div>
                {row.hint ? (
                  <div className="mt-0.5 text-xs text-ink-500">{row.hint}</div>
                ) : null}
              </td>
              <td className="py-3 pl-4 text-right text-ink-900">
                {row.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
