import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export interface MetricItem {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}

/** Summarizes measured data. Callers keep pending values distinct from zero. */
export function MetricGrid({ items, label, className }: {
  items: readonly MetricItem[];
  label: string;
  className?: string;
}) {
  return (
    <dl className={cn('workspace-metrics', className)} aria-label={label}>
      {items.map((item) => (
        <div className="workspace-metric" key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
          {item.detail ? <p>{item.detail}</p> : null}
        </div>
      ))}
    </dl>
  );
}
