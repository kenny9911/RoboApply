'use client';

// PrepareApplicationButton — one tap from a job to an application being
// prepared (docs/agent-driven/REDESIGN.md §5).
//
// Before this, the same result took three pages: add the job to Ready to
// apply, open /ready, select it, "Prepare kits". The button does the same
// server calls in the same order and keeps every rule of that path:
//
//   1. POST /agent/queue            the job joins the user's list (or the
//                                   server returns the item it already has)
//   2. PrepareSheet                 the cost is on screen before anything is
//                                   spent (F-AGENT-10); the user confirms
//   3. POST /agent/queue/:id/prepare { confirm: true }, through the credit gate
//
// A job that is already past "picked" is not prepared twice: the button
// becomes a link to where that application is now. When the caller knows the
// job's list state (the Jobs card's and the Dashboard pick's `application`,
// docs/agent-driven/REDESIGN.md §9) the link is there before any tap: "Being
// prepared" and "Check and open" lead to the application's page (`kitHref`).
// A job on the list that can still be prepared (picked, failed), and one the
// caller knows nothing about, keep the button and its tap flow.
//
// D1: nothing here applies or submits. Preparing tailors the resume and writes
// the letter; the user opens the application and submits it themselves.
//
// Flag `agent` off → renders nothing (R-04: a disabled feature has no entry).

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Btn, toast, type BtnVariant } from '../../v3/primitives';
import { useFlag } from '../../../lib/flags';
import { apiErrorCode, apiErrorReason } from '../../../lib/api/contracts/wire';
import type { QueueItemView, QueueState } from '../../../lib/api/contracts/agent';
import { useAddToList, type PrepareRunResult } from '../../../hooks/agent';
import { PrepareSheet } from './PrepareSheet';
import { applicationHref, kitHref } from './states';

/** Where an application that already exists is, by state. `null` = it can still be prepared here. */
export type PreparedPlace = 'preparing' | 'review' | 'sent' | 'listed';

/** Pure: what the button is for a job whose queue state is known. */
export function placeOf(state: QueueState | null | undefined): PreparedPlace | null {
  switch (state) {
    case 'preparing':
      return 'preparing';
    case 'ready_for_review':
    case 'approved':
      return 'review';
    case 'opened':
    case 'applied':
      return 'sent';
    case 'skipped':
    case 'expired':
      return 'listed';
    default:
      // picked, failed, or not on the list yet: preparable.
      return null;
  }
}

export interface PrepareApplicationButtonProps {
  jobId: string;
  /** The job's state on the user's list, when the caller already knows it. */
  queueState?: QueueState | null;
  /** The tracker entry, when the caller knows it (for the "Sent" link). */
  trackerEntryId?: string | null;
  variant?: BtnVariant;
  className?: string;
  /** Where the tap came from, stored with the list item. */
  addedVia?: 'feed' | 'suggestions' | 'search' | 'manual';
  /** Called once the preparation has started. */
  onStarted?: (item: QueueItemView) => void;
}

export function PrepareApplicationButton({
  jobId,
  queueState,
  trackerEntryId = null,
  variant = 'primary',
  className,
  addedVia = 'feed',
  onStarted,
}: PrepareApplicationButtonProps) {
  const t = useTranslations('ready');
  const on = useFlag('agent');
  const add = useAddToList();
  const [item, setItem] = useState<QueueItemView | null>(null);
  const [sheet, setSheet] = useState(false);
  const [started, setStarted] = useState(false);

  const onClick = useCallback(async () => {
    try {
      const res = await add.mutateAsync({ jobIds: [jobId], addedVia });
      const mine = res.items.find((i) => i.jobId === jobId) ?? res.items[0] ?? null;
      if (!mine) {
        toast({ tone: 'danger', message: t('oneTap.failed') });
        return;
      }
      setItem(mine);
      // Already past "picked": the links below take over; nothing is prepared twice.
      if (placeOf(mine.state) === null) setSheet(true);
    } catch (err) {
      const closed = apiErrorReason(err) === 'job_closed';
      const full = apiErrorCode(err) === 'conflict';
      toast({ tone: closed || full ? 'warn' : 'danger', message: t(closed ? 'oneTap.closed' : full ? 'oneTap.full' : 'oneTap.failed') });
    }
  }, [add, addedVia, jobId, t]);

  const onDone = useCallback(
    (result: PrepareRunResult) => {
      if (!item) return;
      // Out of credits: the gate has opened its own sheet; nothing started.
      if (!result.ok) return;
      if (result.prepared.includes(item.id)) {
        setStarted(true);
        toast({ tone: 'ok', message: t('oneTap.started') });
        onStarted?.(item);
      } else {
        toast({ tone: 'danger', message: t('oneTap.failed') });
      }
    },
    [item, onStarted, t],
  );

  if (!on) return null;

  const place: PreparedPlace | null = started ? 'preparing' : placeOf(item?.state ?? queueState);
  if (place) {
    const href =
      place === 'sent'
        ? applicationHref(item?.trackerEntryId ?? trackerEntryId)
        : place === 'listed'
          ? '/ready?tab=done'
          : kitHref(jobId);
    // "Check and open" is the user's next move, so it keeps the caller's emphasis; the
    // other places are status links and stay quiet.
    const emphasis = place === 'review' && variant !== 'default' ? variant : null;
    return (
      <Link href={href} className={['btn', emphasis, className].filter(Boolean).join(' ')} data-testid="prepare-application" data-place={place}>
        {t(`oneTap.place.${place}`)}
      </Link>
    );
  }

  return (
    <>
      <Btn
        variant={variant}
        className={className}
        onClick={() => void onClick()}
        disabled={add.isPending}
        aria-busy={add.isPending}
        data-testid="prepare-application"
      >
        {add.isPending ? t('oneTap.adding') : t('oneTap.action')}
      </Btn>
      <PrepareSheet open={sheet} ids={item ? [item.id] : []} onClose={() => setSheet(false)} onDone={onDone} />
    </>
  );
}
