'use client';

// AutoPrepareSetting — "Prepare my weekly list automatically"
// (docs/agent-driven/REDESIGN.md §9), in the weekly settings (/ready/setup#weekly).
//
// Off by default. It spends credits without a tap, so the user's own opt-in is
// the confirmation, and it is given only after the cost is stated:
//   - ticking the box opens a sheet first; nothing is saved until "Turn on";
//   - the sheet says what each job it prepares uses, exactly as a tapped
//     Prepare would: one application from the weekly allowance; a tailoring
//     credit when AI is available and "Tailor my resume for each job" is on; a
//     cover letter credit when the post asks for one (or always, or never, by
//     the settings) — each with what is left (the server's numbers, "—" when
//     not known; applications: the week's allowance, since a run never uses
//     bonus ones); that it goes in list order and stops when anything runs
//     out; and that the user still checks, opens and submits each application (D1);
//   - "Turn on" stays disabled until the settings and the option are known,
//     so the statement on screen is complete before anything can be turned on.
// Unticking turns it off at once (it stops spending; nothing prepared is undone).
// It saves on its own (PUT /agent/auto-prepare), never with "Save settings".

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, HonestyLine, Sheet } from '../../v3/primitives';
import { isUnavailable, useAgentSettings, useAutoPrepare, useSetAutoPrepare } from '../../../hooks/agent';
import { bucketSummary, creditsLeft, useCredits, type BucketSummary } from '../../../hooks/shared/useCredits';
import type { AutoPrepareView } from '../../../lib/api/agent';
import type { AgentSettings } from '../../../lib/api/contracts/agent';
import { useFlag } from '../../../lib/flags';
import styles from './ready.module.css';

type CostBucket = 'ready_kits' | 'tailor' | 'cover_letter';

/**
 * The lines the sheet states for one job, from the saved settings and AI
 * availability (the brand's `ai.text` and the account's own answer; an
 * answer that is not known states the settings' credits, never fewer). Pure.
 */
export function autoPrepareCostLines(
  settings: Pick<AgentSettings, 'tailorEach' | 'coverLetterMode'>,
  ai: { brand: boolean; account: boolean | null },
): Array<{ key: string; bucket: CostBucket | null }> {
  const lines: Array<{ key: string; bucket: CostBucket | null }> = [{ key: 'auto.sheet.kit', bucket: 'ready_kits' }];
  if (!ai.brand || ai.account === false) return [...lines, { key: 'auto.sheet.noAi', bucket: null }];
  lines.push(settings.tailorEach ? { key: 'auto.sheet.tailor', bucket: 'tailor' } : { key: 'auto.sheet.noTailor', bucket: null });
  lines.push(
    settings.coverLetterMode === 'never'
      ? { key: 'auto.sheet.letter.never', bucket: null }
      : { key: `auto.sheet.letter.${settings.coverLetterMode}`, bucket: 'cover_letter' },
  );
  return lines;
}

/**
 * What is left for an automatic run in one bucket: applications from the
 * week's allowance only (it never uses bonus ones), tailoring and letters
 * with bonus credits (as a tapped Prepare may). Null when not known. Pure.
 */
export function autoPrepareLeft(bucket: CostBucket, summary: BucketSummary | null): number | null {
  if (!summary) return null;
  if (bucket !== 'ready_kits') return creditsLeft(summary);
  return Number.isFinite(summary.remaining) && Number.isFinite(summary.cap) ? Math.min(Math.max(0, summary.remaining), Math.max(0, summary.cap)) : null;
}

/** One cost of the sheet, with what is left of its bucket (the server's number, "—" when not known). */
function CostItem({ text, bucket }: { text: string; bucket: CostBucket | null }) {
  const t = useTranslations('ready');
  const { data } = useCredits();
  const summary = bucket ? bucketSummary(data?.summary, bucket) : null;
  const left = bucket ? autoPrepareLeft(bucket, summary) : null;
  return (
    <li data-testid={bucket ? `auto-cost-${bucket}` : undefined}>
      {text}
      {bucket ? (
        <>
          <br />
          <span className={styles.muted}>{left === null || !summary ? t('auto.sheet.leftUnknown') : t('auto.sheet.left', { left, window: summary.window })}</span>
        </>
      ) : null}
    </li>
  );
}

interface AutoPrepareSheetProps {
  open: boolean;
  view: AutoPrepareView | undefined;
  busy: boolean;
  /** "Turn on" was refused: said here, where the user is looking. */
  failed: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

/** The cost, stated before the option can be turned on. */
function AutoPrepareSheet({ open, view, busy, failed, onClose, onConfirm }: AutoPrepareSheetProps) {
  const t = useTranslations('ready');
  const settings = useAgentSettings({ enabled: open });
  const aiText = useFlag('ai.text');
  const ready = Boolean(settings.data) && Boolean(view);
  const lines = settings.data && view ? autoPrepareCostLines(settings.data, { brand: aiText, account: view.aiAvailable }) : [];

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('auto.sheet.title')}
      description={t('auto.sheet.description')}
      footer={
        <div className={styles.footer}>
          <Btn variant="ghost" onClick={onClose}>
            {t('auto.sheet.cancel')}
          </Btn>
          <Btn variant="primary" onClick={onConfirm} disabled={!ready || busy} aria-busy={busy}>
            {busy ? t('auto.sheet.saving') : t('auto.sheet.confirm')}
          </Btn>
        </div>
      }
    >
      <div className={styles.stack} data-testid="auto-prepare-sheet">
        <p className={styles.body}>{t('auto.sheet.when')}</p>
        {settings.isError && !settings.data ? (
          <p className={styles.error} role="alert">
            {t('auto.sheet.settingsFailed')}
          </p>
        ) : !ready ? (
          <p className={styles.muted} role="status">
            {t('auto.sheet.loading')}
          </p>
        ) : (
          <>
            <p className={styles.body}>{t('auto.sheet.each')}</p>
            <ul className={styles.bullets} data-testid="auto-prepare-costs">
              {lines.map((line) => (
                <CostItem key={line.key} text={t(line.key)} bucket={line.bucket} />
              ))}
            </ul>
          </>
        )}
        <p className={styles.body}>{t('auto.sheet.stops')}</p>
        <p className={styles.body}>{t('auto.sheet.check')}</p>
        <p className={styles.muted}>{t('auto.sheet.off')}</p>
        <HonestyLine kind="you_submit" />
        {failed ? (
          <p className={styles.error} role="alert">
            {t('auto.failed')}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

export function AutoPrepareSetting() {
  const t = useTranslations('ready');
  const titleId = useId();
  const auto = useAutoPrepare();
  const set = useSetAutoPrepare();
  const [asking, setAsking] = useState(false);
  const [status, setStatus] = useState<'idle' | 'on' | 'off' | 'failed'>('idle');

  // Not offered where the area is not served (flag off, API not live).
  if (isUnavailable(auto.error)) return null;
  const on = auto.data?.on === true;

  const turn = async (next: boolean): Promise<boolean> => {
    setStatus('idle');
    try {
      await set.mutateAsync(next);
      setStatus(next ? 'on' : 'off');
      return true;
    } catch {
      setStatus('failed');
      return false;
    }
  };

  return (
    <section className={styles.cardSoft} aria-labelledby={titleId} data-testid="auto-prepare-setting" data-on={on ? 'true' : 'false'}>
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={on}
          disabled={!auto.data || set.isPending}
          onChange={(e) => {
            // On only through the sheet that states the cost; off at once.
            if (e.target.checked) {
              setStatus('idle');
              setAsking(true);
            } else void turn(false);
          }}
        />
        <span>
          <span id={titleId} className={styles.strong}>
            {t('auto.title')}
          </span>
          <br />
          <span className={styles.muted}>{on ? t('auto.onNote') : t('auto.offNote')}</span>
        </span>
      </label>
      {status === 'on' ? (
        <p className={styles.status} role="status">
          {t('auto.savedOn')}
        </p>
      ) : null}
      {status === 'off' ? (
        <p className={styles.status} role="status">
          {t('auto.savedOff')}
        </p>
      ) : null}
      {status === 'failed' && !asking ? (
        <p className={styles.error} role="alert">
          {t('auto.failed')}
        </p>
      ) : null}
      {auto.isError && !auto.data ? <p className={styles.error}>{t('auto.loadFailed')}</p> : null}
      <AutoPrepareSheet
        open={asking}
        view={auto.data}
        busy={set.isPending}
        failed={status === 'failed'}
        onClose={() => {
          setAsking(false);
          setStatus('idle');
        }}
        onConfirm={() => {
          void turn(true).then((ok) => {
            if (ok) setAsking(false);
          });
        }}
      />
    </section>
  );
}
