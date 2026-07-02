'use client';

// DeleteResumeConfirm — typed-confirm modal for destructive resume deletes.
// Wraps the shared `Modal` (literal #fff panel) and gates the destructive CTA
// behind the user typing the resume name verbatim — mirrors the
// `DangerConfirm` pattern from CLAUDE.md (typed-confirm variant).
//
// Behavior:
//   - Required input shows the resume name as placeholder.
//   - "Delete" button is disabled until the user types the name exactly.
//   - On confirm, calls `onConfirm()` and the parent closes / clears state.
//   - ESC and backdrop close just like any `Modal`.

import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import { RoboButton } from '../ui/RoboButton';
import { RoboInput } from '../ui/RoboInput';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The resume name the user must type verbatim. */
  resumeName: string;
  /** Strings provided by the caller (i18n). */
  labels: {
    title: string;
    body: string;
    /** Input label, e.g. "Type the resume name to confirm" */
    inputLabel: string;
    /** Mismatch hint shown when the typed text is non-empty but wrong. */
    mismatchHint: string;
    cancel: string;
    confirm: string;
    confirming: string;
  };
  onConfirm: () => Promise<void> | void;
}

export function DeleteResumeConfirm({
  open,
  onClose,
  resumeName,
  labels,
  onConfirm,
}: Props) {
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Reset the typed value whenever the modal opens / closes.
  useEffect(() => {
    if (open) {
      setTyped('');
      setSubmitting(false);
    }
  }, [open]);

  const matches = typed.trim() === resumeName.trim();
  const showMismatchHint = typed.length > 0 && !matches;

  async function handleConfirm() {
    if (!matches || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title={labels.title}
      description={labels.body}
      footer={
        <>
          <RoboButton
            variant="ghost"
            onClick={onClose}
            disabled={submitting}
          >
            {labels.cancel}
          </RoboButton>
          <RoboButton
            variant="danger"
            disabled={!matches || submitting}
            loading={submitting}
            onClick={handleConfirm}
          >
            {submitting ? labels.confirming : labels.confirm}
          </RoboButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <RoboInput
          label={labels.inputLabel}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={resumeName}
          autoFocus
          error={showMismatchHint ? labels.mismatchHint : undefined}
        />
      </div>
    </Modal>
  );
}
