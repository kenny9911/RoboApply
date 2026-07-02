'use client';

// BuilderAnalyzer — the "Analyzer" tab content. Shows a circular score,
// severity-bucketed counts, and a click-to-anchor list of issues so the
// user can jump to the relevant section in the editor.

import {
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  CheckCircleIcon,
} from '@heroicons/react/24/outline';
import type {
  AnalyzerReport,
  AnalyzerSeverity,
} from '../../../lib/resumeAnalyzer';
import { cn } from '../../../lib/utils';

const SEVERITY: Record<
  AnalyzerSeverity,
  { label: string; chip: string; Icon: typeof ExclamationCircleIcon }
> = {
  critical: {
    label: 'Critical',
    chip: 'bg-danger/10 text-danger border-danger/20',
    Icon: ExclamationCircleIcon,
  },
  recommended: {
    label: 'Recommended',
    chip: 'bg-amber-50 text-amber-700 border-amber-200',
    Icon: ExclamationTriangleIcon,
  },
  optional: {
    label: 'Optional',
    chip: 'bg-accent-50 text-accent-text border-accent-200',
    Icon: InformationCircleIcon,
  },
};

interface Props {
  report: AnalyzerReport;
  onJumpTo?: (anchor: string) => void;
}

export function BuilderAnalyzer({ report, onJumpTo }: Props) {
  const { score, issues, counts } = report;

  const grade =
    score >= 90 ? 'Excellent' : score >= 75 ? 'Strong' : score >= 60 ? 'Decent' : score >= 40 ? 'Needs work' : 'Critical';
  const ringClass =
    score >= 90
      ? 'text-success'
      : score >= 75
        ? 'text-accent-text'
        : score >= 60
          ? 'text-amber-600'
          : 'text-danger';

  // SVG ring geometry
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;

  return (
    <div className="mx-auto flex w-full max-w-[820px] flex-col gap-6">
      <div className="rounded-md border border-ink-line-soft bg-white p-6 shadow-card">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
          <div className="relative h-24 w-24 shrink-0">
            <svg className="h-24 w-24 -rotate-90" viewBox="0 0 100 100" aria-hidden="true">
              <circle
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                strokeWidth="8"
                className="stroke-ink-line-soft"
              />
              <circle
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={offset}
                className={cn('stroke-current transition-all duration-500', ringClass)}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className={cn('text-2xl font-bold', ringClass)}>{score}</span>
            </div>
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold uppercase tracking-wide text-ink-500">
              Resume score
            </p>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-ink-900">
              {grade}
              {counts.total > 0 ? (
                <span className="ml-2 text-base font-medium text-ink-500">
                  · {counts.total} issue{counts.total === 1 ? '' : 's'} to address
                </span>
              ) : null}
            </h2>
            <div className="mt-3 flex flex-wrap gap-2">
              <SeverityChip kind="critical" count={counts.critical} />
              <SeverityChip kind="recommended" count={counts.recommended} />
              <SeverityChip kind="optional" count={counts.optional} />
            </div>
          </div>
        </div>
      </div>

      {issues.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-success/30 bg-success/5 p-8 text-center">
          <CheckCircleIcon className="h-10 w-10 text-success" aria-hidden="true" />
          <p className="text-base font-semibold text-ink-900">
            Your resume passes every check.
          </p>
          <p className="text-sm text-ink-500">
            Re-run the analyzer after you change anything substantial.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-ink-line-soft bg-white shadow-card">
          <ul className="divide-y divide-ink-line-soft">
            {issues.map((issue) => {
              const sev = SEVERITY[issue.severity];
              const SevIcon = sev.Icon;
              return (
                <li
                  key={issue.id}
                  className="flex items-start gap-3 p-4 transition-colors hover:bg-bg-muted/40"
                >
                  <SevIcon
                    className={cn(
                      'mt-0.5 h-5 w-5 shrink-0',
                      issue.severity === 'critical'
                        ? 'text-danger'
                        : issue.severity === 'recommended'
                          ? 'text-amber-600'
                          : 'text-accent-text',
                    )}
                    aria-hidden="true"
                  />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'inline-flex h-5 items-center rounded-full border px-2 text-[10px] font-semibold uppercase tracking-wide',
                          sev.chip,
                        )}
                      >
                        {sev.label}
                      </span>
                      <span className="text-xs uppercase tracking-wide text-ink-500">
                        {issue.category}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-ink-900">{issue.message}</p>
                  </div>
                  {issue.anchor && onJumpTo ? (
                    <button
                      type="button"
                      onClick={() => onJumpTo(issue.anchor!)}
                      className="shrink-0 self-center text-xs font-semibold text-accent-text hover:underline"
                    >
                      Fix →
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function SeverityChip({
  kind,
  count,
}: {
  kind: AnalyzerSeverity;
  count: number;
}) {
  const s = SEVERITY[kind];
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold',
        s.chip,
      )}
    >
      <s.Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{count}</span>
      <span className="font-medium opacity-80">{s.label}</span>
    </span>
  );
}
