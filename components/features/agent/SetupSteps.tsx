'use client';

// The five setup steps of Ready to apply (PRODUCT F-AGENT-02, ruling C13):
//
//   1 SetupProfileStep     Confirm profile: the fields application forms ask
//                          for, with "Missing" flags and ProfileCompletionCard
//   2 SetupCalibrateStep   Check your search: rate 3 picked jobs (with a reason
//                          for "Not right"), "Show 3 more"; the search card
//   3 AnswersEditor        Application answers (the answer bank, F-AGENT-03)
//   4 WeeklySettingsForm   Weekly settings (WeeklySettingsForm.tsx)
//   5 SetupExtensionStep   Get the extension (flag `extension`; skippable)
//
// Every rating, answer and setting is the user's own; nothing is inferred.

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Btn, FitTierLabel, HonestyLine } from '../../v3/primitives';
import { ProfileCompletionCard } from '../profile';
import { InstallPrompt } from '../extension';
import { useAgentSetup, useCalibrate, useSuggestions } from '../../../hooks/agent';
import type { FeedItem } from '../../../lib/api/contracts/feed';
import { cn } from '../../../lib/utils';
import { ReadySearchCard } from './ReadySearchCard';
import styles from './ready.module.css';

/** Calibration needs this many verdicts (contract: "3 verdicts required"). */
export const CALIBRATION_NEEDED = 3;
/** Jobs shown at a time; "Show 3 more" moves on by the same amount. */
export const CALIBRATION_PAGE = 3;
/** Jobs asked for at once (four pages; the server allows up to 20). */
export const CALIBRATION_FETCH = 12;

export const DOWN_REASONS = ['wrong_title', 'wrong_level', 'wrong_location', 'missing_skills', 'company', 'pay', 'other'] as const;
export type DownReason = (typeof DOWN_REASONS)[number];

// ── 1. Confirm profile ──────────────────────────────────────────────────────

export function SetupProfileStep() {
  const t = useTranslations('ready');
  const setup = useAgentSetup();
  const missing = setup.data?.checks.profileMissing ?? [];
  return (
    <div className={styles.stack} data-testid="setup-profile">
      <p className={styles.body}>{t('setup.profile.lead')}</p>
      <ProfileCompletionCard linkBase="/profile" showWhenComplete />
      {setup.data ? (
        missing.length > 0 ? (
          <section className={styles.card} aria-labelledby="setup-missing-title">
            <h3 id="setup-missing-title" className={styles.sectionTitle}>
              {t('setup.profile.missingTitle', { count: missing.length })}
            </h3>
            <ul className={styles.plainList}>
              {missing.map((m) => (
                <li key={m.key} className={styles.spread}>
                  <MissingLabel label={m.label} />
                  <span className={styles.missingTag}>{t('setup.profile.missing')}</span>
                </li>
              ))}
            </ul>
            <p className={styles.muted}>{t('setup.profile.missingNote')}</p>
            <div className={styles.row}>
              <Link href="/profile" className="btn">
                {t('setup.profile.complete')}
              </Link>
            </div>
          </section>
        ) : (
          <p className={styles.status}>{t('setup.profile.allSet')}</p>
        )
      ) : null}
    </div>
  );
}

/** A missing field's label: an i18n key from the server when it is one, else its text. */
function MissingLabel({ label }: { label: string }) {
  const t = useTranslations();
  const text = /^[\w-]+(\.[\w-]+)+$/.test(label) && t.has(label) ? t(label) : label;
  return <span className={styles.body}>{text}</span>;
}

// ── 2. Check your search ────────────────────────────────────────────────────

export function SetupCalibrateStep() {
  const t = useTranslations('ready');
  const setup = useAgentSetup();
  const suggestions = useSuggestions({ limit: CALIBRATION_FETCH });
  const [offset, setOffset] = useState(0);
  const [rated, setRated] = useState<Record<string, 'up' | 'down'>>({});
  const all = suggestions.data?.items ?? [];
  const page = all.slice(offset, offset + CALIBRATION_PAGE);
  // The server's count (verdicts already saved, e.g. on an earlier visit)
  // wins; this visit's ratings cover the moment before it answers.
  const serverCount = (setup.data?.checks as { calibrationCount?: unknown } | undefined)?.calibrationCount;
  const ratedCount = Math.max(typeof serverCount === 'number' && Number.isFinite(serverCount) ? serverCount : 0, Object.keys(rated).length);
  const done = setup.data?.checks.calibrationDone === true || ratedCount >= CALIBRATION_NEEDED;

  return (
    <div className={styles.stack} data-testid="setup-calibrate">
      <p className={styles.body}>{t('setup.calibrate.lead')}</p>
      <ReadySearchCard mode="setup" />
      <p className={done ? styles.status : styles.muted} role="status">
        {done ? t('setup.calibrate.done') : t('setup.calibrate.progress', { count: Math.min(ratedCount, CALIBRATION_NEEDED), needed: CALIBRATION_NEEDED })}
      </p>
      {suggestions.isLoading ? <p className={styles.muted}>{t('loading')}</p> : null}
      {suggestions.isError ? <p className={styles.error}>{t('setup.calibrate.loadFailed')}</p> : null}
      {suggestions.data && all.length === 0 ? <p className={styles.muted}>{t('setup.calibrate.none')}</p> : null}
      {page.length > 0 ? (
        <ul className={styles.plainList}>
          {page.map((job) => (
            <CalibrationJob key={job.jobId} job={job} verdict={rated[job.jobId] ?? null} onRated={(v) => setRated((r) => ({ ...r, [job.jobId]: v }))} />
          ))}
        </ul>
      ) : null}
      {page.length > 0 ? <HonestyLine kind="fit" /> : null}
      {offset + CALIBRATION_PAGE < all.length ? (
        <div className={styles.row}>
          <Btn variant="ghost" onClick={() => setOffset((o) => o + CALIBRATION_PAGE)}>
            {t('setup.calibrate.more')}
          </Btn>
        </div>
      ) : null}
    </div>
  );
}

function CalibrationJob({ job, verdict, onRated }: { job: FeedItem; verdict: 'up' | 'down' | null; onRated: (v: 'up' | 'down') => void }) {
  const t = useTranslations('ready');
  const calibrate = useCalibrate();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState<DownReason | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState(false);

  // "Not right" needs a reason; "Something else" needs a few words too.
  const downReady = reason !== null && (reason !== 'other' || note.trim().length > 0);

  const send = async (v: 'up' | 'down') => {
    if (v === 'down' && !downReady) return;
    setError(false);
    try {
      await calibrate.mutateAsync({ jobId: job.jobId, verdict: v, ...(v === 'down' && reason ? { reason } : {}), ...(v === 'down' && note.trim() ? { note: note.trim() } : {}) });
      setAsking(false);
      onRated(v);
    } catch {
      setError(true);
    }
  };

  return (
    <li className={styles.card} data-testid="calibration-job">
      <div className={styles.kitMain}>
        <p className={styles.kitTitle}>{job.title}</p>
        <p className={styles.kitMeta}>
          <span>{job.company.name}</span>
          {job.location ? <span>{job.location}</span> : null}
          {job.fit ? <FitTierLabel tier={job.fit.tier} score={job.fit.score} /> : null}
        </p>
      </div>
      <div className={styles.verdicts} role="group" aria-label={t('setup.calibrate.verdictLabel', { title: job.title })}>
        <Btn className={cn(verdict === 'up' && styles.verdictOn)} aria-pressed={verdict === 'up'} onClick={() => void send('up')} disabled={calibrate.isPending}>
          {t('setup.calibrate.up')}
        </Btn>
        <Btn className={cn(verdict === 'down' && styles.verdictOn)} aria-pressed={verdict === 'down' || asking} onClick={() => setAsking(true)} disabled={calibrate.isPending}>
          {t('setup.calibrate.down')}
        </Btn>
      </div>
      {asking ? (
        <div className={styles.stack}>
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>{t('setup.calibrate.why')}</legend>
            <div className={styles.choices}>
              {DOWN_REASONS.map((r) => (
                <label key={r} className={cn(styles.choice, reason === r && styles.choiceOn)}>
                  <input type="radio" name={`reason-${job.jobId}`} value={r} checked={reason === r} onChange={() => setReason(r)} />
                  {t(`setup.calibrate.reasons.${r}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <label className={styles.label}>
            {reason === 'other' ? t('setup.calibrate.noteLabelOther') : t('setup.calibrate.noteLabel')}
            <textarea className={styles.textarea} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          {!downReady ? <p className={styles.muted}>{reason === 'other' ? t('setup.calibrate.needNote') : t('setup.calibrate.needReason')}</p> : null}
          <div className={styles.row}>
            <Btn variant="primary" onClick={() => void send('down')} disabled={calibrate.isPending || !downReady}>
              {t('setup.calibrate.sendDown')}
            </Btn>
            <Btn variant="ghost" onClick={() => setAsking(false)}>
              {t('setup.calibrate.cancel')}
            </Btn>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {t('setup.calibrate.failed')}
        </p>
      ) : null}
    </li>
  );
}

// ── 5. Get the extension ────────────────────────────────────────────────────

export function SetupExtensionStep() {
  const t = useTranslations('ready');
  return (
    <div className={styles.stack} data-testid="setup-extension">
      <p className={styles.body}>{t('setup.extension.lead')}</p>
      <InstallPrompt mode="inline" />
      <p className={styles.muted}>{t('setup.extension.skipNote')}</p>
    </div>
  );
}
