'use client';

// BuilderBulletEditor — one bullet row with an inline AI Rewrite button.
// Multi-line textarea (auto-grows), a trash button to delete, and a
// sparkle-icon button that calls aiRewriteBullet.

import { useState } from 'react';
import {
  TrashIcon,
  SparklesIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline';
import { aiRewriteBullet } from '../../../lib/resumeAI';
import { cn } from '../../../lib/utils';

interface Props {
  value: string;
  onChange: (next: string) => void;
  onRemove: () => void;
  placeholder?: string;
}

export function BuilderBulletEditor({
  value,
  onChange,
  onRemove,
  placeholder,
}: Props) {
  const [busy, setBusy] = useState(false);

  async function handleRewrite() {
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      const next = await aiRewriteBullet(value);
      onChange(next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="group relative flex items-start gap-2">
      <div className="mt-3 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-300" aria-hidden="true" />
      <textarea
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? 'Describe a specific outcome you drove.'}
        className={cn(
          'min-h-[44px] w-full resize-none rounded-md border border-transparent bg-bg-muted/40 px-3 py-2 text-sm text-ink-900 placeholder:text-ink-300 transition-colors',
          'hover:border-ink-line-soft focus:border-accent-text focus:bg-white focus:outline-none focus:shadow-focus',
        )}
      />
      <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          onClick={handleRewrite}
          disabled={!value.trim() || busy}
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-accent-text transition-colors',
            'hover:border-accent-text hover:bg-accent-50 disabled:cursor-not-allowed disabled:text-ink-300 disabled:hover:bg-transparent disabled:hover:border-transparent',
          )}
          title="AI Rewrite"
          aria-label="AI Rewrite bullet"
        >
          {busy ? (
            <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <SparklesIcon className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-ink-500 transition-colors hover:border-danger hover:bg-danger/5 hover:text-danger"
          title="Delete bullet"
          aria-label="Delete bullet"
        >
          <TrashIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
