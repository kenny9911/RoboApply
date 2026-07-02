'use client';

// Scorecard — the Results page surface. Big donut score + delta vs last run,
// 5-axis breakdown with per-axis notes, strengths / sharpen split, and a
// "Run it again" CTA. Lives inside the dark-canvas scope.

import { ArrowDownIcon, ArrowUpIcon, MinusIcon, ArrowPathIcon, CheckIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import Link from 'next/link';
import type { MockReport, QuestionScore } from '../../../lib/mockInterview/types';
import { cn } from '../../../lib/utils';

interface Props {
  report: MockReport;
  mockId: string;
  delta: number | null;
  axes: AxisRow[];
  /** Aggregated strength / sharpen lists. */
  strengths: string[];
  sharpen: string[];
}

export interface AxisRow {
  id: 'structure' | 'specificity' | 'self_awareness' | 'conviction' | 'brevity';
  label: string;
  score: number;
  note: string;
}

export function Scorecard({ report, mockId, delta, axes, strengths, sharpen }: Props) {
  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-5 px-4 pb-16 md:px-8">
      {/* Headline */}
      <section
        className="grid gap-6 rounded-3xl border p-6 lg:grid-cols-[280px_1fr] lg:p-8"
        style={{ borderColor: 'var(--dc-edge)', background: 'var(--dc-surface, #11111c)' }}
      >
        <ScoreDonut score={report.score} delta={delta} />
        <div className="flex flex-col justify-center">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: 'var(--dc-accent, #c6ff3a)' }}>
            That run · scorecard
          </p>
          <h1 className="dc-display dc-display-lg mt-2" style={{ color: 'var(--dc-ink, #f5f5fa)' }}>
            {gradeFor(report.score)}{' '}
            <span className="dc-serif italic" style={{ color: 'var(--dc-ink-2, #c9c9d4)' }}>
              {report.score >= 75 ? "— don't change a thing." : 'with room to push.'}
            </span>
          </h1>
          <p className="mt-3 max-w-[55ch] text-[14.5px]" style={{ color: 'var(--dc-ink-2,#c9c9d4)' }}>
            Five axes below. Notes are the specific lines from your transcript that
            moved each one.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Link
              href={`/mock-interview/${mockId}`}
              className="inline-flex h-11 items-center gap-2 rounded-full px-5 text-sm font-bold transition-transform hover:scale-[1.02]"
              style={{
                background:
                  'linear-gradient(135deg, var(--dc-accent), var(--dc-secondary))',
                color: 'var(--dc-accent-ink, #0a0a0f)',
                boxShadow:
                  '0 0 0 1px color-mix(in srgb, var(--dc-accent) 25%, transparent), 0 14px 30px -10px color-mix(in srgb, var(--dc-accent) 50%, transparent)',
              }}
            >
              <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
              Run it again
            </Link>
            <Link
              href="/mock-interview"
              className="inline-flex h-11 items-center rounded-full border border-white/15 px-5 text-sm font-semibold transition-colors hover:bg-white/5"
              style={{ color: 'var(--dc-ink, #f5f5fa)' }}
            >
              Pick a different run
            </Link>
          </div>
        </div>
      </section>

      {/* 5-axis breakdown */}
      <section
        className="rounded-3xl border p-6"
        style={{ borderColor: 'var(--dc-edge)', background: 'var(--dc-surface, #11111c)' }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: 'var(--dc-accent, #c6ff3a)' }}>
          Breakdown
        </p>
        <h2 className="dc-display text-2xl" style={{ color: 'var(--dc-ink, #f5f5fa)' }}>
          Five axes.
        </h2>
        <div className="mt-5 flex flex-col gap-4">
          {axes.map((a) => (
            <AxisBar key={a.id} axis={a} />
          ))}
        </div>
      </section>

      {/* Strengths / Sharpen */}
      <section className="grid gap-4 sm:grid-cols-2">
        <SplitCard kind="strengths" items={strengths} />
        <SplitCard kind="sharpen" items={sharpen} />
      </section>

      {/* Per-question */}
      <section>
        <h2 className="dc-display text-2xl" style={{ color: 'var(--dc-ink, #f5f5fa)' }}>
          Question by question
        </h2>
        <div className="mt-4 flex flex-col gap-3">
          {report.perQuestion.map((q, i) => (
            <PerQuestion key={q.questionId} index={i} q={q} />
          ))}
        </div>
      </section>
    </div>
  );
}

function gradeFor(score: number): string {
  if (score >= 90) return 'Top 1%';
  if (score >= 80) return 'Strong';
  if (score >= 70) return 'Solid';
  if (score >= 55) return 'Promising';
  return 'Needs work';
}

function ScoreDonut({ score, delta }: { score: number; delta: number | null }) {
  const radius = 64;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  return (
    <div className="relative mx-auto h-44 w-44">
      <svg className="h-44 w-44 -rotate-90" viewBox="0 0 160 160" aria-hidden="true">
        <defs>
          <linearGradient id="donut-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--dc-accent, #c6ff3a)" />
            <stop offset="100%" stopColor="var(--dc-secondary, #b691ff)" />
          </linearGradient>
        </defs>
        <circle cx="80" cy="80" r={radius} fill="none" strokeWidth="14" stroke="rgba(255,255,255,0.08)" />
        <circle
          cx="80"
          cy="80"
          r={radius}
          fill="none"
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          stroke="url(#donut-grad)"
          style={{ filter: 'drop-shadow(0 0 12px color-mix(in srgb, var(--dc-accent) 60%, transparent))' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <p className="dc-display text-6xl" style={{ color: 'var(--dc-ink, #f5f5fa)' }}>
          {score}
        </p>
        {delta !== null ? <DeltaChip delta={delta} /> : (
          <p className="dc-serif italic text-[12px]" style={{ color: 'var(--dc-ink-3,#8a8a9c)' }}>
            first run
          </p>
        )}
      </div>
    </div>
  );
}

function DeltaChip({ delta }: { delta: number }) {
  const positive = delta > 0;
  const flat = delta === 0;
  return (
    <span
      className="mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{
        background: positive
          ? 'color-mix(in srgb, var(--dc-accent) 15%, transparent)'
          : flat
            ? 'rgba(255,255,255,0.08)'
            : 'rgba(239,68,68,0.15)',
        color: positive ? 'var(--dc-accent)' : flat ? 'var(--dc-ink-3)' : '#ff8a8a',
      }}
    >
      {positive ? <ArrowUpIcon className="h-3 w-3" /> : flat ? <MinusIcon className="h-3 w-3" /> : <ArrowDownIcon className="h-3 w-3" />}
      {positive ? '+' : ''}{delta} vs last
    </span>
  );
}

function AxisBar({ axis }: { axis: AxisRow }) {
  const colorClass =
    axis.score >= 75
      ? 'var(--dc-accent)'
      : axis.score >= 60
        ? '#f59e0b'
        : '#ef4444';
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[14px] font-semibold" style={{ color: 'var(--dc-ink, #f5f5fa)' }}>
          {axis.label}
        </p>
        <p className="dc-mono text-[14px] font-bold" style={{ color: colorClass }}>
          {axis.score}
        </p>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }}>
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${axis.score}%`,
            background: `linear-gradient(90deg, ${colorClass}, color-mix(in srgb, ${colorClass} 50%, var(--dc-secondary)))`,
            boxShadow: `0 0 12px -2px ${colorClass}`,
          }}
        />
      </div>
      <p className="dc-serif italic mt-1.5 text-[12.5px]" style={{ color: 'var(--dc-ink-3,#8a8a9c)' }}>
        {axis.note}
      </p>
    </div>
  );
}

function SplitCard({
  kind,
  items,
}: {
  kind: 'strengths' | 'sharpen';
  items: string[];
}) {
  const Icon = kind === 'strengths' ? CheckIcon : ExclamationTriangleIcon;
  const tint = kind === 'strengths' ? 'var(--dc-accent, #c6ff3a)' : '#ff9d4d';
  return (
    <div
      className="rounded-3xl border p-5"
      style={{ borderColor: 'var(--dc-edge)', background: 'var(--dc-surface, #11111c)' }}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full"
          style={{ background: `color-mix(in srgb, ${tint} 14%, transparent)`, color: tint }}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: tint }}>
          {kind === 'strengths' ? 'Strengths' : 'Sharpen these'}
        </p>
      </div>
      <h3 className="dc-display mt-1 text-xl" style={{ color: 'var(--dc-ink, #f5f5fa)' }}>
        {kind === 'strengths' ? "What's working" : "What's leaking"}
      </h3>
      <ul className="mt-3 flex flex-col gap-2">
        {items.length === 0 ? (
          <li className="dc-serif italic text-sm" style={{ color: 'var(--dc-ink-3,#8a8a9c)' }}>
            Nothing here this run.
          </li>
        ) : null}
        {items.map((it, i) => (
          <li
            key={i}
            className="flex items-start gap-2 text-[14px] leading-relaxed"
            style={{ color: 'var(--dc-ink-2,#c9c9d4)' }}
          >
            <span
              aria-hidden="true"
              className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: tint }}
            />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PerQuestion({ index, q }: { index: number; q: QuestionScore }) {
  const star = q.starStructure;
  return (
    <details
      className="group overflow-hidden rounded-2xl border"
      style={{ borderColor: 'var(--dc-edge)', background: 'var(--dc-surface, #11111c)' }}
    >
      <summary className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.04]">
        <span
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] font-bold"
          style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--dc-ink-2,#c9c9d4)' }}
        >
          {index + 1}
        </span>
        <p className="flex-1 truncate text-[13.5px] font-semibold" style={{ color: 'var(--dc-ink, #f5f5fa)' }}>
          {q.prompt}
        </p>
        <span
          className="dc-mono text-[12px] font-bold"
          style={{
            color:
              q.score >= 75
                ? 'var(--dc-accent)'
                : q.score >= 60
                  ? '#f59e0b'
                  : '#ef4444',
          }}
        >
          {q.score}
        </span>
      </summary>
      <div className="space-y-3 border-t px-4 py-4" style={{ borderColor: 'var(--dc-edge)' }}>
        <div className="flex flex-wrap gap-2">
          {(['situation', 'task', 'action', 'result'] as const).map((k) => (
            <span
              key={k}
              className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide')}
              style={{
                background: star[k] ? 'color-mix(in srgb, var(--dc-accent) 14%, transparent)' : 'rgba(255,255,255,0.04)',
                color: star[k] ? 'var(--dc-accent)' : 'var(--dc-ink-4,#5a5a6e)',
              }}
            >
              {k[0].toUpperCase()} · {star[k] ? 'hit' : 'miss'}
            </span>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--dc-ink-3,#8a8a9c)' }}>
              Your answer
            </p>
            <p className="mt-1.5 text-[13.5px]" style={{ color: 'var(--dc-ink, #f5f5fa)' }}>
              {q.answer || <span className="dc-serif italic" style={{ color: 'var(--dc-ink-3,#8a8a9c)' }}>(no answer)</span>}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--dc-ink-3,#8a8a9c)' }}>
              Sample answer
            </p>
            <p className="dc-serif italic mt-1.5 text-[13.5px]" style={{ color: 'var(--dc-ink-2,#c9c9d4)' }}>
              {q.sampleAnswer ?? 'No reference for this one.'}
            </p>
          </div>
        </div>
      </div>
    </details>
  );
}
