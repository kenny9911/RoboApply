'use client';

// components/features/feed/RatingCard.tsx — "How good is today's list?"
// (PRODUCT §4.3 O8 item 3, F-FEED-09, F-GROW-07 adapted: no gift-card offer).
//
// 0–10. Below 8 the reasons open; a reason that maps to a filter offers a
// one-tap change afterwards (shown before it is saved), the others open the
// matching filter section. One rating a day (the server answers 409
// `feed_rating_already_today` for a second). The card is an unprompted
// prompt: the workspace mounts it only when lib/ui/popupGate granted the slot.

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, toast } from '../../v3/primitives';
import { FiltersDrawer, type DrawerSection } from '../filters';
import { rateFeed } from '../../../lib/api/feed';
import { apiErrorReason } from '../../../lib/api/contracts/wire';
import { track } from '../../../lib/analytics';
import type { FilterSetPatch } from '../../../lib/api/contracts/search';
import { useProposalApply } from './useProposalApply';
import styles from './feed.module.css';

export const RATING_REASONS_ORDER = ['wrong_titles', 'wrong_level', 'wrong_location', 'missing_skills', 'jobs_old', 'unwanted_companies'] as const;
export type RatingReason = (typeof RATING_REASONS_ORDER)[number];

/** Ratings below this open the reasons. */
export const RATING_REASONS_BELOW = 8;

export type RatingFix = { reason: RatingReason; kind: 'patch'; patch: FilterSetPatch } | { reason: RatingReason; kind: 'drawer'; section: DrawerSection };

/** The filter change each reason offers. Pure, for tests. */
export function ratingFixes(reasons: readonly RatingReason[], filters: { postedWithinDays?: number | null }): RatingFix[] {
  const out: RatingFix[] = [];
  for (const r of reasons) {
    switch (r) {
      case 'jobs_old':
        if (!filters.postedWithinDays || filters.postedWithinDays > 7) out.push({ reason: r, kind: 'patch', patch: { postedWithinDays: 7 } });
        break;
      case 'wrong_level':
      case 'wrong_location':
      case 'wrong_titles':
        out.push({ reason: r, kind: 'drawer', section: 'basic' });
        break;
      case 'unwanted_companies':
        out.push({ reason: r, kind: 'drawer', section: 'companies' });
        break;
      case 'missing_skills':
        out.push({ reason: r, kind: 'drawer', section: 'interests' });
        break;
    }
  }
  return out;
}

export interface RatingCardProps {
  sessionId: string | null;
  /** "Not now", or the server says today's list was already rated. Records the dismissal. */
  onClose: () => void;
  /**
   * The rating was saved. Called at once, before any fix is offered, so the
   * "rated today" mark is written even if the list reloads and this card
   * unmounts. `fixes` is what to offer next (empty → nothing).
   */
  onRated: (fixes: RatingFix[]) => void;
}

export function RatingCard({ sessionId, onClose, onRated }: RatingCardProps) {
  const t = useTranslations('jobs.rating');
  const proposal = useProposalApply();
  const [score, setScore] = useState<number | null>(null);
  const [reasons, setReasons] = useState<RatingReason[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const low = score !== null && score < RATING_REASONS_BELOW;

  const toggle = (r: RatingReason) => setReasons((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]));

  const submit = async () => {
    if (score === null) return;
    setBusy(true);
    const sent = low ? reasons : [];
    try {
      const text = note.trim();
      await rateFeed({ score, reasons: sent, ...(low && text ? { note: text } : {}) });
      track('feed_rating_submitted', { rating: score, reasons: sent.join(','), reasonCount: sent.length, feedSessionId: sessionId });
      toast({ message: t('thanks'), tone: 'ok' });
      onRated(proposal.profile ? ratingFixes(sent, proposal.profile.filters ?? {}) : []);
    } catch (err) {
      if (apiErrorReason(err) === 'feed_rating_already_today') {
        toast({ message: t('already'), tone: 'info' });
        onClose();
      } else {
        toast({ message: t('failed'), tone: 'warn' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.prompt} aria-label={t('title')} data-testid="rating-card">
      <h2 className={styles.promptTitle}>{t('title')}</h2>
      <div role="group" aria-label={t('scaleLabel')}>
        <div className={styles.scale}>
          {Array.from({ length: 11 }, (_, n) => (
            <button key={n} type="button" className={styles.scoreBtn} aria-pressed={score === n} onClick={() => setScore(n)}>
              {n}
            </button>
          ))}
        </div>
        <div className={styles.scaleEnds} aria-hidden="true">
          <span>{t('low')}</span>
          <span>{t('high')}</span>
        </div>
      </div>
      {low ? (
        <>
          <h3 className={styles.label}>{t('reasonsTitle')}</h3>
          <ul className={styles.chips}>
            {RATING_REASONS_ORDER.map((r) => (
              <li key={r}>
                <button type="button" className={styles.chipBtn} aria-pressed={reasons.includes(r)} onClick={() => toggle(r)}>
                  {t(`reason.${r}`)}
                </button>
              </li>
            ))}
          </ul>
          <label className={styles.fieldset}>
            <span className={styles.label}>{t('noteLabel')}</span>
            <textarea className={styles.textarea} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          </label>
        </>
      ) : null}
      <div className={styles.row}>
        <Btn variant="primary" className={styles.actionBtn} disabled={score === null || busy} onClick={() => void submit()}>
          {t('submit')}
        </Btn>
        <Btn variant="ghost" className={styles.actionBtn} onClick={onClose}>
          {t('skip')}
        </Btn>
      </div>
    </section>
  );
}

export interface RatingFixesProps {
  fixes: RatingFix[];
  /** A one-tap fix was saved: drop it from the list. */
  onApplied: (reason: RatingReason) => void;
  /** "Not now": stop offering the fixes. */
  onClose: () => void;
}

/**
 * The filter changes a low rating offers, after it was saved. Its state lives
 * in the workspace (not in the list), so a list reload after a saved fix does
 * not bring back the 0–10 question.
 */
export function RatingFixes({ fixes, onApplied, onClose }: RatingFixesProps) {
  const t = useTranslations('jobs.rating');
  const proposal = useProposalApply();
  const [drawer, setDrawer] = useState<DrawerSection | null>(null);

  return (
    <section className={styles.prompt} aria-label={t('fixTitle')} data-testid="rating-fixes">
      <h2 className={styles.promptTitle}>{t('fixTitle')}</h2>
      <div className={styles.row}>
        {fixes.map((fix) => (
          <Btn
            key={fix.reason}
            className={styles.actionBtn}
            disabled={proposal.isPending}
            onClick={async () => {
              if (fix.kind === 'drawer') {
                setDrawer(fix.section);
                return;
              }
              const res = await proposal.save(fix.patch);
              if (res === 'saved') onApplied(fix.reason);
              else toast({ message: t('fixFailed'), tone: 'warn' });
            }}
          >
            {t(`fix.${fix.reason}`)}
          </Btn>
        ))}
        <Btn variant="ghost" className={styles.actionBtn} onClick={onClose}>
          {t('skip')}
        </Btn>
      </div>
      <FiltersDrawer open={drawer !== null} onClose={() => setDrawer(null)} profile={proposal.profile} sections={drawer ? [drawer] : undefined} />
    </section>
  );
}
