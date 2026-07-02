'use client';

// BuilderAddBullet — inline bullet composer mirroring the Teal "add bullet"
// flow. Renders below the existing bullets of a Work Experience entry while
// the composer is active.
//
// Affordances:
//   • Multi-line textarea, autofocused
//   • "Write with AI ✨ N"  — drafts (or rewrites) the bullet via aiDraftBullet
//   • "Cancel"              — discards the draft, closes the composer
//   • "Save"                — commits the bullet text to the parent
//
// While the composer is open, the parent page swaps the right pane from the
// resume preview to <BulletGuidancePanel> so the user can pull in examples
// / prompts / dropdown-built phrases without leaving the editor.

import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import {
  SparklesIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline';
import { aiDraftBullet, type BulletDraftContext } from '../../../lib/resumeAI';
import { cn } from '../../../lib/utils';

interface Props {
  context: BulletDraftContext;
  onSave: (text: string) => void;
  onCancel: () => void;
  /** How many AI drafts remain on the current plan. Shown in the badge. */
  aiCreditsRemaining?: number;
}

export interface BulletComposerHandle {
  /** Inject text into the textarea (used by Guidance → Insert). */
  insertText: (text: string) => void;
}

export const BuilderAddBullet = forwardRef<BulletComposerHandle, Props>(
  function BuilderAddBullet(
    { context, onSave, onCancel, aiCreditsRemaining = 5 },
    ref,
  ) {
    const [value, setValue] = useState(context.seed ?? '');
    const [busy, setBusy] = useState(false);
    const taRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
      taRef.current?.focus();
    }, []);

    useImperativeHandle(ref, () => ({
      insertText: (text: string) => {
        setValue((prev) => {
          const joined = prev.trim() ? `${prev.trim()} ${text}` : text;
          // Focus + move caret to end after the next render.
          setTimeout(() => {
            const el = taRef.current;
            if (el) {
              el.focus();
              const end = el.value.length;
              el.setSelectionRange(end, end);
            }
          }, 0);
          return joined;
        });
      },
    }));

    async function handleWriteWithAi() {
      if (busy) return;
      setBusy(true);
      try {
        const next = await aiDraftBullet({ ...context, seed: value });
        setValue(next);
      } finally {
        setBusy(false);
      }
    }

    function handleSave() {
      const trimmed = value.trim();
      if (!trimmed) return;
      onSave(trimmed);
    }

    return (
      <div className="rounded-md border-2 border-accent-text bg-white p-3 shadow-focus">
        <textarea
          ref={taRef}
          rows={3}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSave();
            }
          }}
          placeholder="Type a bullet or use AI to write a draft for you."
          className="w-full resize-y rounded-md border border-transparent bg-transparent px-1 py-1 text-sm text-ink-900 placeholder:text-ink-300 focus:outline-none"
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={handleWriteWithAi}
            disabled={busy}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-md border border-amber-300 bg-amber-300 px-3 text-sm font-semibold text-amber-900 transition-colors hover:bg-amber-400',
              'disabled:cursor-not-allowed disabled:opacity-70',
            )}
          >
            {busy ? (
              <ArrowPathIcon className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <SparklesIcon className="h-4 w-4" aria-hidden="true" />
            )}
            <span>{busy ? 'Drafting…' : 'Write with AI'}</span>
            <span
              className="ml-0.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-amber-900/15 px-1.5 text-[11px] font-bold text-amber-900"
              aria-label={`${aiCreditsRemaining} AI credits left`}
            >
              {aiCreditsRemaining}
            </span>
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex h-9 items-center rounded-md border border-ink-line bg-white px-3 text-sm font-semibold text-ink-700 transition-colors hover:bg-bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!value.trim()}
              className="inline-flex h-9 items-center rounded-md border border-accent-700 bg-accent-700 px-3 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-600 disabled:cursor-not-allowed disabled:bg-ink-line disabled:border-ink-line"
            >
              Save
            </button>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-ink-500">
          ⌘+Enter to save · Esc to cancel
        </p>
      </div>
    );
  },
);
