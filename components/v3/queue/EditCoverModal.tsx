'use client';

// EditCoverModal — edit a queue item's draft cover letter. The textarea holds
// the raw markdown source (this IS an editor surface, so per the markdown rule
// we show the source, not a rendered preview); the card renders the saved
// result through the Markdown primitive.
//
// Wraps the shared V3 Modal primitive (solid #181923 panel — CLAUDE.md modal
// standard). Save calls `queue.updateCover` via the `useUpdateQueueCover` hook
// passed down from the card; the modal owns only its local draft + busy/error
// UI state. ≤ 6000 chars is the contract cap on QueueUpdateCoverBody.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '../primitives/Modal';
import { Btn } from '../primitives/Btn';

const MAX_LEN = 6000;

interface Props {
  open: boolean;
  onClose: () => void;
  /** Job title — shown in the modal subtitle for context. */
  title: string;
  companyName: string;
  /** Current cover markdown to seed the editor. */
  initialMarkdown: string;
  /** Persist. Resolves on success; rejects on failure (modal shows the error). */
  onSave: (markdown: string) => Promise<void>;
}

export function EditCoverModal({
  open,
  onClose,
  title,
  companyName,
  initialMarkdown,
  onSave,
}: Props) {
  const t = useTranslations('queue');
  const [draft, setDraft] = useState(initialMarkdown);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  // Reseed whenever the modal (re)opens or the source changes — so reopening
  // after a discard shows the last *saved* value, not the abandoned edit.
  useEffect(() => {
    if (open) {
      setDraft(initialMarkdown);
      setError(false);
      setSaving(false);
    }
  }, [open, initialMarkdown]);

  const trimmed = draft.trim();
  const tooLong = draft.length > MAX_LEN;
  const dirty = draft !== initialMarkdown;
  const canSave = dirty && trimmed.length > 0 && !tooLong && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(false);
    try {
      await onSave(draft);
      onClose();
    } catch {
      setError(true);
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={saving ? () => {} : onClose}
      title={t('editCover.title')}
      description={t('editCover.subtitle', { title, company: companyName })}
      maxWidth="lg"
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={saving}>
            {t('editCover.cancel')}
          </Btn>
          <Btn variant="primary" onClick={handleSave} disabled={!canSave}>
            {saving ? t('editCover.saving') : t('editCover.save')}
          </Btn>
        </>
      }
    >
      <label
        htmlFor="queue-edit-cover"
        style={{
          fontFamily: 'var(--mono)',
          fontSize: '10px',
          textTransform: 'uppercase',
          letterSpacing: '0.14em',
          color: 'var(--muted)',
          fontWeight: 600,
          display: 'block',
          marginBottom: 8,
        }}
      >
        {t('editCover.fieldLabel')}
      </label>
      <textarea
        id="queue-edit-cover"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={12}
        spellCheck
        autoFocus
        style={{
          width: '100%',
          resize: 'vertical',
          background: 'var(--bg)',
          border: `1px solid ${tooLong ? 'var(--warn)' : 'var(--rule)'}`,
          borderRadius: 'var(--r-sm)',
          color: 'var(--text)',
          fontFamily: 'var(--sans)',
          fontSize: '14px',
          lineHeight: 1.65,
          padding: '14px 16px',
          outline: 'none',
        }}
      />
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: 8,
          fontSize: '12px',
        }}
      >
        <span style={{ color: error ? 'var(--warn)' : 'var(--muted)' }}>
          {error
            ? t('editCover.error')
            : tooLong
              ? t('editCover.tooLong', { max: MAX_LEN })
              : t('editCover.hint')}
        </span>
        <span
          style={{
            fontFamily: 'var(--mono)',
            color: tooLong ? 'var(--warn)' : 'var(--muted)',
          }}
        >
          {draft.length} / {MAX_LEN}
        </span>
      </div>
    </Modal>
  );
}
