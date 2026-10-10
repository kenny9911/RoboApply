'use client';

// PrepareSheet — the cost of "Prepare kits", shown before anything is spent
// (PRODUCT F-AGENT-10: "Uses 5 tailoring credits; you have 2 left today").
//
// 1. On open it asks the server for each kit's credit proposal
//    (POST /prepare without `confirm`) and sums them; the client never
//    computes a cost.
// 2. "Prepare N kits" runs each kit through the `ready_kits` credit gate.
//    A 402 stops the run and opens the out-of-credits sheet (three honest
//    options, mounted once in the app layout).
//
// Nothing here applies anywhere: preparing a kit tailors the resume and
// writes the letter; the user opens the application and submits it (D1).

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, HonestyLine, Sheet } from '../../v3/primitives';
import { useAgentSettings, usePrepareKits, type PrepareQuote, type PrepareRunResult } from '../../../hooks/agent';
import { useFlag } from '../../../lib/flags';
import { bucketSummary, creditsLeft, useCredits } from '../../../hooks/shared/useCredits';
import styles from './ready.module.css';

export interface PrepareSheetProps {
  open: boolean;
  /** Queue item ids to prepare. */
  ids: string[];
  onClose: () => void;
  onDone?: (result: PrepareRunResult) => void;
}

type CostBucket = 'ready_kits' | 'tailor' | 'cover_letter';

/** One "Uses N … ; you have M left" line from the server's summary. */
export function CostLine({ bucket, cost }: { bucket: CostBucket; cost: number }) {
  const t = useTranslations('ready');
  const { data } = useCredits();
  const summary = bucketSummary(data?.summary, bucket);
  const left = creditsLeft(summary);
  const what = t(`prepare.bucket.${bucket}`, { count: cost });
  if (left === null || !summary) {
    return <p className={styles.body} data-testid={`cost-${bucket}`}>{t('prepare.costUnknown', { what })}</p>;
  }
  return (
    <p className={styles.body} data-testid={`cost-${bucket}`} data-left={left}>
      {t('prepare.cost', { what, left, window: summary.window })}
      {cost > left ? <span className={styles.strong}> {t('prepare.notEnough', { left })}</span> : null}
    </p>
  );
}

/**
 * Why no tailoring credit is used, from what the server and settings say:
 * AI unavailable for the account (the server's `aiAvailable: false`, or the
 * brand has no AI text), tailoring switched off in Settings, or neither
 * known. Pure.
 */
export function noTailorKey(q: Pick<PrepareQuote, 'aiAvailable'>, aiText: boolean, tailorEach: boolean | undefined): string {
  if (q.aiAvailable === false || !aiText) return 'prepare.noTailorAi';
  if (tailorEach === false) return 'prepare.noTailor';
  return 'prepare.noTailorAsIs';
}

export function PrepareSheet({ open, ids, onClose, onDone }: PrepareSheetProps) {
  const t = useTranslations('ready');
  const { quote, run, busy } = usePrepareKits();
  const settings = useAgentSettings({ enabled: open });
  const aiText = useFlag('ai.text');
  const [q, setQ] = useState<PrepareQuote | null>(null);
  const [error, setError] = useState(false);
  const key = ids.join(',');

  useEffect(() => {
    if (!open || ids.length === 0) return;
    let live = true;
    setQ(null);
    setError(false);
    quote(ids)
      .then((r) => {
        if (live) setQ(r);
      })
      .catch(() => {
        if (live) setError(true);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);

  const count = q?.ids.length ?? 0;
  const onConfirm = async () => {
    if (!q || count === 0) return;
    const result = await run(q.ids);
    onDone?.(result);
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('prepare.title', { count: ids.length })}
      description={t('prepare.description')}
      footer={
        <div className={styles.footer}>
          <Btn variant="ghost" onClick={onClose}>
            {t('prepare.cancel')}
          </Btn>
          <Btn variant="primary" onClick={() => void onConfirm()} disabled={!q || count === 0 || busy !== null} aria-busy={busy !== null}>
            {busy === 'run' ? t('prepare.running') : t('prepare.confirm', { count })}
          </Btn>
        </div>
      }
    >
      <div className={styles.stack} data-testid="prepare-sheet">
        {busy === 'quote' || (!q && !error) ? <p className={styles.muted} role="status">{t('prepare.quoting')}</p> : null}
        {error ? <p className={styles.error} role="alert">{t('prepare.quoteFailed')}</p> : null}
        {q ? (
          <>
            <CostLine bucket="ready_kits" cost={q.kits} />
            {q.totals.tailor > 0 ? <CostLine bucket="tailor" cost={q.totals.tailor} /> : <p className={styles.body}>{t(noTailorKey(q, aiText, settings.data?.tailorEach))}</p>}
            {q.totals.cover_letter > 0 ? <CostLine bucket="cover_letter" cost={q.totals.cover_letter} /> : null}
            {q.failed.length > 0 ? <p className={styles.error}>{t('prepare.someFailed', { count: q.failed.length })}</p> : null}
            <p className={styles.muted}>{t('prepare.whatHappens')}</p>
          </>
        ) : null}
        <HonestyLine kind="you_submit" />
      </div>
    </Sheet>
  );
}
