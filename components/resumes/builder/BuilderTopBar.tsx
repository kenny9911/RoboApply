'use client';

// BuilderTopBar — sticky header for the resume builder. Three rows:
//   1) Back arrow + resume name (editable) + right-side action group
//      (Export PDF, kebab Menu).
//   2) Horizontal tab bar — Content Editor / Designer / Analyzer (badge) /
//      Job Matcher / Cover Letter.
//   3) Optional save-state row (saved · last saved 2s ago).
//
// Visual reference: Teal app/tealhq.com builder header.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ArrowLeftIcon,
  ArrowDownTrayIcon,
  CheckCircleIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline';
import { cn } from '../../../lib/utils';

export type BuilderTab =
  | 'content'
  | 'designer'
  | 'analyzer'
  | 'job_matcher'
  | 'cover_letter';

interface Props {
  resumeName: string;
  onRename: (next: string) => void;
  tab: BuilderTab;
  onTabChange: (tab: BuilderTab) => void;
  analyzerCount: number;
  onExport: () => void;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  lastSavedAt: string | null;
  /** Right-side menu (renders a <MenuDropdown> or other affordance). */
  menu?: ReactNode;
}

const TABS: { id: BuilderTab; label: string }[] = [
  { id: 'content', label: 'Content Editor' },
  { id: 'designer', label: 'Designer' },
  { id: 'analyzer', label: 'Analyzer' },
  { id: 'job_matcher', label: 'Job Matcher' },
  { id: 'cover_letter', label: 'Cover Letter' },
];

function formatRelative(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function BuilderTopBar({
  resumeName,
  onRename,
  tab,
  onTabChange,
  analyzerCount,
  onExport,
  saveState,
  lastSavedAt,
  menu,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(resumeName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraftName(resumeName);
  }, [resumeName]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function commitName() {
    setEditing(false);
    const next = draftName.trim();
    if (next && next !== resumeName) onRename(next);
    else setDraftName(resumeName);
  }

  return (
    <div className="sticky top-0 z-20 flex flex-col border-b border-ink-line-soft bg-white">
      {/* Row 1: back / title / actions */}
      <div className="flex items-center gap-3 px-4 py-3 md:px-6">
        <Link
          href="/resumes"
          aria-label="Back to Resume Builder"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-ink-line bg-white text-ink-700 transition-colors hover:bg-bg-muted"
        >
          <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
        </Link>
        <div className="flex flex-1 items-center gap-2 min-w-0">
          {editing ? (
            <input
              ref={inputRef}
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName();
                if (e.key === 'Escape') {
                  setDraftName(resumeName);
                  setEditing(false);
                }
              }}
              className="w-full max-w-[480px] truncate rounded-md border border-accent-text bg-white px-2 py-1 text-sm font-semibold text-ink-900 focus:outline-none focus:shadow-focus"
              aria-label="Resume name"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="truncate rounded-md px-2 py-1 text-left text-sm font-semibold text-ink-900 transition-colors hover:bg-bg-muted"
              title="Click to rename"
            >
              {resumeName}
            </button>
          )}
          <SaveBadge state={saveState} lastSavedAt={lastSavedAt} />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onExport}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-ink-line bg-white px-3 text-sm font-semibold text-ink-900 transition-colors hover:bg-bg-muted"
          >
            <ArrowDownTrayIcon className="h-4 w-4" aria-hidden="true" />
            <span>Export PDF</span>
          </button>
          {menu}
        </div>
      </div>

      {/* Row 2: tabs */}
      <div className="flex items-end gap-1 overflow-x-auto px-4 md:px-6" role="tablist">
        {TABS.map((t) => {
          const active = t.id === tab;
          const showBadge = t.id === 'analyzer' && analyzerCount > 0;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onTabChange(t.id)}
              className={cn(
                'relative inline-flex h-10 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors',
                active
                  ? 'border-accent-text text-ink-900'
                  : 'border-transparent text-ink-500 hover:text-ink-900',
              )}
            >
              <span>{t.label}</span>
              {showBadge ? (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-100 px-1.5 text-[10px] font-bold text-amber-700">
                  {analyzerCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SaveBadge({
  state,
  lastSavedAt,
}: {
  state: Props['saveState'];
  lastSavedAt: string | null;
}) {
  if (state === 'saving') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-ink-500">
        <ArrowPathIcon className="h-3 w-3 animate-spin" aria-hidden="true" />
        Saving…
      </span>
    );
  }
  if (state === 'saved') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-success">
        <CheckCircleIcon className="h-3 w-3" aria-hidden="true" />
        Saved {formatRelative(lastSavedAt)}
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-danger">
        Save failed — try again
      </span>
    );
  }
  return null;
}
