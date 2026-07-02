'use client';

// RecentSessionsStrip — the "Pick up where you left off" section on the setup
// screen. Shows the 3 most recent sessions as full cards; any older sessions
// collapse into a compact, denser list that expands on demand so the history
// never dominates the page. Each card/row can be replayed (→ that session's
// report) or deleted via a two-step inline confirm → onDelete, which removes
// the session and its recording/transcript server-side.
//
// Data: useMockRecentSessions() / interviewEngineApi.recent() mapped into
// RAMockSessionSummary by the parent setup page.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { TrashIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import type { RAMockSessionSummary } from '../../../lib/api/v2/types';

interface Props {
  sessions: RAMockSessionSummary[];
  onReplay: (session: RAMockSessionSummary) => void;
  onDelete: (session: RAMockSessionSummary) => void;
}

// How many of the most-recent sessions stay expanded as full cards.
const VISIBLE_LIMIT = 3;

export function RecentSessionsStrip({ sessions, onReplay, onDelete }: Props) {
  const t = useTranslations('mock');
  const [expanded, setExpanded] = useState(false);
  // The session currently asking "Delete this recording?" (one at a time).
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const primary = sessions.slice(0, VISIBLE_LIMIT);
  const overflow = sessions.slice(VISIBLE_LIMIT);
  const hasOverflow = overflow.length > 0;

  // If deleting drains the overflow list, drop back to collapsed so a later
  // re-grow (e.g. a failed-delete rollback) doesn't render pre-expanded.
  // Declared before the early return so hook order stays stable.
  useEffect(() => {
    if (!hasOverflow && expanded) setExpanded(false);
  }, [hasOverflow, expanded]);

  if (sessions.length === 0) return null;

  function commitDelete(s: RAMockSessionSummary) {
    setConfirmId(null);
    onDelete(s);
  }

  function deleteButton(s: RAMockSessionSummary, extraClass = '') {
    return (
      <button
        type="button"
        className={`iv-recent-del${extraClass ? ` ${extraClass}` : ''}`}
        aria-label={t('setup.recent.deleteAria')}
        title={t('setup.recent.deleteAria')}
        onClick={() => setConfirmId((id) => (id === s.id ? null : s.id))}
      >
        <TrashIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    );
  }

  function confirmActions(s: RAMockSessionSummary) {
    return (
      <>
        <button type="button" className="iv-recent-confirm-yes" onClick={() => commitDelete(s)}>
          {t('setup.recent.delete')}
        </button>
        <button type="button" className="iv-recent-confirm-no" onClick={() => setConfirmId(null)}>
          {t('setup.recent.cancel')}
        </button>
      </>
    );
  }

  return (
    <div className="iv-recent">
      <div className="iv-section-label">
        <span>{t('setup.recent.label')}</span>
        <span style={{ color: 'var(--muted)' }}>
          {t('setup.recent.count', { count: sessions.length })}
        </span>
      </div>

      {/* Most recent 3 — full cards */}
      <div className="iv-recent-grid">
        {primary.map((s) => (
          <div key={s.id} className="iv-recent-card">
            <div className="iv-recent-top">
              <span className="iv-recent-score">{s.score}</span>
              <div className="iv-recent-top-right">
                <span className="iv-recent-meta">{s.when}</span>
                {deleteButton(s)}
              </div>
            </div>
            <div className="iv-recent-title">
              {s.role} · {s.typeLabel}
            </div>
            <div className="iv-recent-sub">
              {t('setup.recent.with', { name: s.interviewerName })}
            </div>
            {s.note ? <div className="iv-recent-note">&ldquo;{s.note}&rdquo;</div> : null}

            {confirmId === s.id ? (
              <div className="iv-recent-confirm">
                <span className="iv-recent-confirm-q">{t('setup.recent.deleteConfirm')}</span>
                <div className="iv-recent-confirm-actions">{confirmActions(s)}</div>
              </div>
            ) : (
              <button
                type="button"
                className="btn ghost"
                style={{ padding: '5px 0', fontSize: 11.5 }}
                onClick={() => onReplay(s)}
              >
                {t('setup.recent.replay')}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Older sessions — collapsed compact list */}
      {hasOverflow ? (
        <>
          <button
            type="button"
            className="iv-recent-more"
            aria-expanded={expanded}
            onClick={() => {
              setExpanded((v) => !v);
              setConfirmId(null);
            }}
          >
            <ChevronDownIcon
              className="h-4 w-4"
              aria-hidden="true"
              style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}
            />
            {expanded ? t('setup.recent.showLess') : t('setup.recent.showMore', { count: overflow.length })}
          </button>

          {expanded ? (
            <div className="iv-recent-overflow">
              {overflow.map((s) => (
                <div key={s.id} className="iv-recent-row">
                  <span className="iv-recent-row-score">{s.score}</span>
                  <div className="iv-recent-row-main">
                    <div className="iv-recent-row-title">
                      {s.role} · {s.typeLabel}
                    </div>
                    <div className="iv-recent-row-sub">
                      {t('setup.recent.with', { name: s.interviewerName })} · {s.when}
                    </div>
                  </div>

                  {confirmId === s.id ? (
                    <div className="iv-recent-row-confirm">
                      <span className="iv-recent-confirm-q">{t('setup.recent.deleteConfirm')}</span>
                      {confirmActions(s)}
                    </div>
                  ) : (
                    <div className="iv-recent-row-actions">
                      <button type="button" className="iv-recent-row-replay" onClick={() => onReplay(s)}>
                        {t('setup.recent.replay')}
                      </button>
                      {deleteButton(s, 'iv-recent-del--inline')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
