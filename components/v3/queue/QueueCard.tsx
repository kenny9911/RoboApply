'use client';

// QueueCard — one pending auto-apply in the Review queue. Mirrors the
// prototype's `.queue-card` (views.jsx QueueView):
//
//   queue-head : logo · title · "{score} fit" pill · live CountdownBadge
//   draft      : "Draft cover · written by RoboApply" + Edit · markdown cover
//   qcheck     : Resume / Cover / Questions / Portfolio strip
//   queue-actions: Send now · Edit & send · Skip
//
// The card owns its three per-item mutations (send / skip / updateCover) via
// the useQueue hooks. Send + Skip optimistically disable the card (busy) and
// the item drops out of the list on the parent's query invalidation. The
// generated cover body renders through the Markdown primitive (sanitized) per
// the project markdown rule. Edit opens EditCoverModal.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { RAQueueItem } from '../../../lib/api/v2';
import {
  useSendQueueItem,
  useSkipQueueItem,
  useUpdateQueueCover,
} from '../../../hooks/useQueue';
import { Markdown } from '../primitives/Markdown';
import { IconBolt, IconCheck, IconEdit, IconSparkle } from '../primitives/Iconset';
import { CountdownBadge } from './CountdownBadge';
import { EditCoverModal } from './EditCoverModal';

interface Props {
  item: RAQueueItem;
  /** Index → one of the 5 logo gradient palettes (data-color 0..4). */
  index: number;
}

/** First grapheme of the company name, uppercased — the logo monogram when no
 *  logo image is present (fixtures carry no logo URL). */
function monogram(name: string): string {
  const ch = name.trim().charAt(0);
  return ch ? ch.toUpperCase() : '?';
}

export function QueueCard({ item, index }: Props) {
  const t = useTranslations('queue');
  const [editOpen, setEditOpen] = useState(false);

  const sendMutation = useSendQueueItem();
  const skipMutation = useSkipQueueItem();
  const updateCover = useUpdateQueueCover(item.id);

  const busy = sendMutation.isPending || skipMutation.isPending;

  const handleSend = () => {
    if (busy) return;
    sendMutation.mutate(item.id);
  };
  const handleSkip = () => {
    if (busy) return;
    skipMutation.mutate(item.id);
  };
  const handleSaveCover = async (markdown: string) => {
    await updateCover.mutateAsync({ coverLetterMarkdown: markdown });
  };

  const actionError = sendMutation.isError || skipMutation.isError;

  return (
    <div className="queue-card" aria-busy={busy}>
      {/* Head */}
      <div className="queue-head">
        <div className="left">
          <div className="logo" data-color={index % 5} aria-hidden="true">
            {monogram(item.companyName)}
          </div>
          <div>
            <h3>{item.title}</h3>
            <div className="co">
              <b>{item.companyName}</b>
              <span className="pill">{t('fitPill', { score: item.matchScore })}</span>
              {item.location ? (
                <span style={{ color: 'var(--muted)' }}>· {item.location}</span>
              ) : null}
            </div>
          </div>
        </div>
        <CountdownBadge plannedSubmitAt={item.plannedSubmitAt} />
      </div>

      {/* Draft cover */}
      <div className="draft">
        <div className="lbl">
          <span className="by">
            <IconSparkle size={11} />
            {t('draftBy')}
          </span>
          <button
            type="button"
            className="edit"
            onClick={() => setEditOpen(true)}
            disabled={busy}
          >
            <IconEdit size={12} />
            {t('edit')}
          </button>
        </div>
        <div className="cover">
          <Markdown block>{item.coverLetterMarkdown}</Markdown>
        </div>
      </div>

      {/* Checks */}
      {item.checks.length > 0 ? (
        <div className="qcheck">
          {item.checks.map((c, i) => (
            <div key={`${c.key}-${i}`}>
              <div className="check">
                <IconCheck size={11} strokeWidthValue={3} />
              </div>
              <div>
                <div className="key">{c.key}</div>
                <div className="val">{c.value}</div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* Actions */}
      <div className="queue-actions">
        <div className="left">
          <button
            type="button"
            className="btn primary"
            onClick={handleSend}
            disabled={busy}
          >
            <IconBolt size={14} />
            {sendMutation.isPending ? t('sending') : t('sendNow')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setEditOpen(true)}
            disabled={busy}
          >
            {t('editAndSend')}
          </button>
        </div>
        <div className="left">
          <button
            type="button"
            className="btn ghost"
            onClick={handleSkip}
            disabled={busy}
          >
            {skipMutation.isPending ? t('skipping') : t('skip')}
          </button>
        </div>
      </div>

      {actionError ? (
        <p
          role="alert"
          style={{ marginTop: 12, fontSize: '12.5px', color: 'var(--warn)' }}
        >
          {t('actionError')}
        </p>
      ) : null}

      <EditCoverModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={item.title}
        companyName={item.companyName}
        initialMarkdown={item.coverLetterMarkdown}
        onSave={handleSaveCover}
      />
    </div>
  );
}
