'use client';

// TargetTitleField — the job title a base resume is aimed at, read as a line on
// its card and edited in place: Enter or leaving the field saves, Escape puts
// the old title back. Saving reports itself in a live region (WP-36b).

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { IconEdit, IconTarget } from '../../../v3/primitives';
import styles from './Hub.module.css';

export interface TargetTitleFieldProps {
  value: string | null | undefined;
  /** Saves the trimmed title ('' clears it). */
  onSave: (title: string) => Promise<unknown>;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function TargetTitleField({ value, onSave }: TargetTitleFieldProps) {
  const t = useTranslations('resume.hub.target');
  const current = value ?? '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(current);
  const [state, setState] = useState<SaveState>('idle');
  // A title that did not save: opening the field again brings it back.
  const [unsaved, setUnsaved] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Enter and Escape unmount the input; a blur that may follow must not act
  // a second time (save twice, or save after Escape).
  const closed = useRef(false);
  const returnFocus = useRef(false);
  const inputId = useId();

  useEffect(() => {
    if (!editing) setDraft(current);
  }, [current, editing]);

  useEffect(() => {
    if (editing) {
      closed.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      buttonRef.current?.focus();
    }
  }, [editing]);

  async function commit(fromKeyboard: boolean) {
    if (closed.current) return;
    closed.current = true;
    returnFocus.current = fromKeyboard;
    setEditing(false);
    const next = draft.trim();
    if (next === current) return;
    setState('saving');
    try {
      await onSave(next);
      setUnsaved(null);
      setState('saved');
    } catch {
      setUnsaved(next);
      setState('error');
    }
  }

  function cancel() {
    closed.current = true;
    returnFocus.current = true;
    setDraft(current);
    setEditing(false);
  }

  return (
    <div className={styles.target}>
      {editing ? (
        <>
          <label className={styles.targetLabel} htmlFor={inputId}>
            {t('label')}
          </label>
          <input
            ref={inputRef}
            id={inputId}
            className={styles.targetInput}
            value={draft}
            maxLength={120}
            placeholder={t('placeholder')}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void commit(true);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancel();
              }
            }}
          />
        </>
      ) : (
        <button
          ref={buttonRef}
          type="button"
          className={styles.targetButton}
          data-empty={current ? undefined : true}
          aria-label={current ? t('edit_aria', { title: current }) : undefined}
          onClick={() => {
            if (unsaved !== null) setDraft(unsaved);
            setState('idle');
            setEditing(true);
          }}
        >
          <IconTarget size={14} aria-hidden="true" />
          <span className={styles.targetText}>{current ? t('for', { title: current }) : t('add')}</span>
          {current ? <IconEdit size={12} aria-hidden="true" /> : null}
        </button>
      )}
      <span className={styles.targetStatus} role="status" aria-live="polite">
        {state === 'saving' ? t('saving') : state === 'saved' ? t('saved') : state === 'error' ? t('error') : ''}
      </span>
    </div>
  );
}
