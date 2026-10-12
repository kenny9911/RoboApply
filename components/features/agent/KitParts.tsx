'use client';

// The parts of one kit's review screen (PRODUCT F-AGENT-05, 06, 11):
//
//   KitResumePart   a tailored resume with Verify details (mandatory: the kit
//                   cannot use it while a detail is unchecked), or the resume
//                   as it is when nothing was tailored
//   KitLetterPart   the cover letter, copy / edit / use / ask for changes
//   KitAnswersPart  the user's own answers with copy buttons
//   KitFilesPart    the file name and downloads (recorded on the application).
//                   The name shown is the server's (`kit.fileName`, the export's
//                   own rules): never a second guess made here, which used to
//                   show one name while the page loaded and another after
//   KitOpenPart     "Open application" → Applied at once + "Undo · I didn't apply"
//   KitHistoryPart  what was prepared, used, opened and undone (audit rows,
//                   GET /agent/queue/:id/history or the kit detail)
//
// D1: nothing here submits. "Open application" opens the application page; the
// user fills and submits it there. The extension only fills when asked. The
// page is called "the company's" only when it is (`isEmployerApplyPage`): a
// link to a job board is named by its host instead.

import { useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn, HonestyLine, Markdown } from '../../v3/primitives';
import { AiGeneratedBadge } from '../market';
import { TailorButton, TailorResult } from '../tailor';
import { FillWithExtensionButton } from '../extension';
import { useTailorSession } from '../../../hooks/tailor';
import { useCoverLetter } from '../../../hooks/coverletter/useCoverLetters';
import { useLaunchPractice } from '../../../hooks/shared/useLaunchPractice';
import {
  isUnavailable,
  kitEventsOf,
  recordedFileNameOf,
  tailorSessionIdOf,
  useAnswerBank,
  useKitActions,
  useKitHistory,
  type KitEventView,
  type ReadyQueueItem,
} from '../../../hooks/agent';
import { coverLetterExportUrl } from '../../../lib/api/coverLetters';
import { downloadResumeExport } from '../../../lib/api/resumes';
import type { QueueItemDetail } from '../../../lib/api/agent';
import { apiErrorCode, apiErrorDetails } from '../../../lib/api/contracts/wire';
import { useFlag } from '../../../lib/flags';
import type { AgentSettings } from '../../../lib/api/contracts/agent';
import { MissingLabel } from './MissingLabel';
import { applicationHref, setupStepHref } from './states';
import styles from './ready.module.css';

/** Copy text; true when the browser accepted it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // denied or unavailable
  }
  return false;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useTranslations('ready');
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <span className={styles.row}>
      <Btn
        variant="ghost"
        aria-label={label}
        onClick={async () => {
          setState((await copyText(text)) ? 'copied' : 'failed');
        }}
      >
        {t('review.copy')}
      </Btn>
      {state !== 'idle' ? (
        <span className={state === 'copied' ? styles.status : styles.error} role="status">
          {state === 'copied' ? t('review.copied') : t('review.copyFailed')}
        </span>
      ) : null}
    </span>
  );
}

/** Revise box shared by the resume and the letter ("Ask for changes"). */
function ReviseBox({ part, onSend, busy }: { part: 'resume' | 'letter'; onSend: (instruction: string) => void; busy: boolean }) {
  const t = useTranslations('ready');
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  if (!open) {
    return (
      <Btn variant="ghost" onClick={() => setOpen(true)} disabled={busy}>
        {t('review.revise')}
      </Btn>
    );
  }
  return (
    <div className={styles.stack}>
      <label className={styles.label}>
        {t(`review.reviseLabel.${part}`)}
        <textarea className={styles.textarea} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className={styles.row}>
        <Btn
          onClick={() => {
            onSend(text.trim());
            setOpen(false);
            setText('');
          }}
          disabled={busy || !text.trim()}
        >
          {t('review.reviseSend')}
        </Btn>
        <Btn variant="ghost" onClick={() => setOpen(false)}>
          {t('review.cancel')}
        </Btn>
      </div>
    </div>
  );
}

/**
 * The most specific reason of a failed call: the area's `details.reason`
 * (WP-52: `kit_unverified_claims`, `kit_not_ready`, …), a delegated
 * `details.code` (jobs: `no_apply_link`, `job_closed`), else the platform code.
 */
export function kitErrorReason(err: unknown): string | null {
  const d = apiErrorDetails<{ reason?: unknown; code?: unknown }>(err);
  if (typeof d?.reason === 'string') return d.reason;
  if (typeof d?.code === 'string') return d.code;
  return apiErrorCode(err);
}

const ERROR_KEYS: Record<string, string> = {
  kit_unverified_claims: 'review.errors.unverified',
  unverified_claims: 'review.errors.unverified',
  queue_invalid_transition: 'review.errors.changed',
  kit_not_ready: 'review.errors.changed',
  kit_preparing: 'review.errors.preparing',
  job_closed: 'review.errors.closed',
  ai_unavailable: 'review.errors.aiUnavailable',
  queue_full: 'review.errors.full',
};

/**
 * The `ready.*` i18n key of the plain message for a failed kit action. Pure.
 * `kit_undo_expired` (the tracker move can no longer be reverted) is handled
 * where Undo is offered, because it needs a link to Applications.
 */
export function kitErrorKey(err: unknown): string {
  return ERROR_KEYS[kitErrorReason(err) ?? ''] ?? 'review.errors.generic';
}

/** Plain message for a failed kit action. */
function useActionError() {
  const t = useTranslations('ready');
  const [error, setError] = useState<string | null>(null);
  const report = (err: unknown) => setError(t(kitErrorKey(err)));
  return { error, setError, report };
}

/** Only web links are opened (never `javascript:` or other schemes from third-party posts). */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}

/** The host of a web link without `www.`, or null. Pure. */
export function hostOf(url: string | null | undefined): string | null {
  const safe = safeHttpUrl(url);
  if (!safe) return null;
  try {
    return new URL(safe).hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/**
 * True only when the application link is known to be the employer's own page:
 * the post came from the company's own job board (`ats_public`), or the link's
 * host is the company's domain (or under it). A job board, an aggregator or a
 * link the user pasted is not called "the company's page". Pure.
 */
export function isEmployerApplyPage(input: { applyUrl: string | null | undefined; sourceKind?: string | null; companyDomain?: string | null }): boolean {
  const host = hostOf(input.applyUrl);
  if (!host) return false;
  if (input.sourceKind === 'ats_public') return true;
  const domain = (input.companyDomain ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
  return !!domain && (host === domain || host.endsWith(`.${domain}`));
}

// ── Resume ──────────────────────────────────────────────────────────────────

export interface KitResumePartProps {
  item: ReadyQueueItem;
  jobId: string;
  /** GET /agent/queue/:id, when the server sends it. */
  detail?: QueueItemDetail | null;
  /** AI actions are allowed for this account (useKitAiAvailable). */
  aiOk: boolean;
}

export function KitResumePart({ item, jobId, detail = null, aiOk }: KitResumePartProps) {
  const t = useTranslations('ready');
  const actions = useKitActions(item.id);
  const sessionId = detail?.kit.resume.tailorSessionId ?? tailorSessionIdOf(item);
  const variantId = detail?.kit.resume.variantId ?? item.resumeVariantId;
  const session = useTailorSession(sessionId);
  const { error, setError, report } = useActionError();
  const reviewing = item.state === 'ready_for_review';

  const confirm = async (decision: 'use' | 'revise', instruction?: string) => {
    setError(null);
    try {
      await actions.confirm({ part: 'resume', decision, ...(instruction ? { instruction } : {}) });
    } catch (err) {
      report(err);
    }
  };

  // Verify details is mandatory for a tailored resume: nothing unchecked and
  // the checked copy saved. A kit without a tailoring session uses the resume
  // as it is; the server still refuses a resume with unchecked details
  // (`pendingClaims` on the detail read).
  const pending = sessionId ? (session.data?.pendingClaims ?? 0) : (detail?.kit.resume.pendingClaims ?? 0);
  const finalized = session.data?.status === 'finalized';
  const blocked = sessionId ? !session.data || pending > 0 || !finalized : pending > 0;

  return (
    <section className={styles.card} aria-labelledby="kit-resume-title" data-testid="kit-resume" data-tailored={sessionId ? 'true' : 'false'}>
      <h2 id="kit-resume-title" className={styles.cardTitle}>
        {t('review.resume.title')}
      </h2>
      {sessionId && session.data ? (
        <>
          {/* Two fits can be on this page: this one is a record of the tailoring, the header's is today's. */}
          <p className={styles.muted} data-testid="kit-fit-note">
            {t('review.resume.fitNote')}
          </p>
          <TailorResult session={session.data} />
        </>
      ) : null}
      {sessionId && session.isLoading ? <p className={styles.muted}>{t('loading')}</p> : null}
      {sessionId && session.isError ? <p className={styles.error}>{t('review.resume.loadFailed')}</p> : null}
      {!sessionId ? (
        <div className={styles.stack}>
          <p className={styles.body}>{t('review.resume.asIs')}</p>
          {!aiOk ? <p className={styles.muted}>{t('review.aiOff')}</p> : null}
          <div className={styles.row}>
            {variantId ? (
              <Link href={`/resume/${encodeURIComponent(variantId)}`} className="btn ghost">
                {t('review.resume.openAsIs')}
              </Link>
            ) : null}
            {aiOk ? <TailorButton jobId={jobId} resumeId={variantId} from="ready" variant="ghost" /> : null}
          </div>
        </div>
      ) : null}

      {reviewing && blocked && (!sessionId || session.data) ? (
        <p className={styles.blocker} role="note" data-testid="verify-block">
          {pending > 0 ? t('review.resume.verifyBlock', { count: pending }) : t('review.resume.finishBlock')}
        </p>
      ) : null}
      {reviewing ? (
        <div className={styles.row}>
          <Btn variant="primary" onClick={() => void confirm('use')} disabled={blocked || actions.pending !== null}>
            {t('review.resume.use')}
          </Btn>
          {aiOk ? <ReviseBox part="resume" busy={actions.pending !== null} onSend={(i) => void confirm('revise', i)} /> : null}
        </div>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

// ── Cover letter ────────────────────────────────────────────────────────────

export function KitLetterPart({ item, coverLetterMode, aiOk }: { item: ReadyQueueItem; coverLetterMode: AgentSettings['coverLetterMode'] | null; aiOk: boolean }) {
  const t = useTranslations('ready');
  const actions = useKitActions(item.id);
  const letter = useCoverLetter(item.coverLetterId);
  const { error, setError, report } = useActionError();
  const reviewing = item.state === 'ready_for_review';

  const confirm = async (decision: 'use' | 'revise', instruction?: string) => {
    setError(null);
    try {
      await actions.confirm({ part: 'letter', decision, ...(instruction ? { instruction } : {}) });
    } catch (err) {
      report(err);
    }
  };

  if (!item.coverLetterId) {
    return (
      <section className={styles.card} aria-labelledby="kit-letter-title" data-testid="kit-letter">
        <h2 id="kit-letter-title" className={styles.cardTitle}>
          {t('review.letter.title')}
        </h2>
        <p className={styles.muted}>{coverLetterMode === 'never' ? t('review.letter.off') : t('review.letter.none')}</p>
      </section>
    );
  }

  const body = letter.data?.bodyMarkdown ?? '';
  return (
    <section className={styles.card} aria-labelledby="kit-letter-title" data-testid="kit-letter">
      <div className={styles.spread}>
        <h2 id="kit-letter-title" className={styles.cardTitle}>
          {t('review.letter.title')}
        </h2>
        <AiGeneratedBadge kind="document" />
      </div>
      {letter.isLoading ? <p className={styles.muted}>{t('loading')}</p> : null}
      {letter.isError ? <p className={styles.error}>{t('review.letter.loadFailed')}</p> : null}
      {letter.data ? (
        <>
          <HonestyLine kind="ai_written" />
          <div className={styles.letter}>
            <Markdown block>{body}</Markdown>
          </div>
          <div className={styles.row}>
            <CopyButton text={body} label={t('review.letter.copyAria')} />
            <Link href={`/resume/letters/${encodeURIComponent(item.coverLetterId)}`} className="btn ghost">
              {t('review.letter.edit')}
            </Link>
          </div>
        </>
      ) : null}
      {reviewing && letter.data ? (
        <div className={styles.row}>
          <Btn variant="primary" onClick={() => void confirm('use')} disabled={actions.pending !== null}>
            {t('review.letter.use')}
          </Btn>
          {aiOk ? <ReviseBox part="letter" busy={actions.pending !== null} onSend={(i) => void confirm('revise', i)} /> : null}
        </div>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

// ── Answers ─────────────────────────────────────────────────────────────────

export function KitAnswersPart({ item }: { item: ReadyQueueItem }) {
  const t = useTranslations('ready');
  const bank = useAnswerBank();
  const answers = (bank.data?.items ?? []).filter((a) => a.answer.trim());
  return (
    <section className={styles.card} aria-labelledby="kit-answers-title" data-testid="kit-answers">
      <h2 id="kit-answers-title" className={styles.cardTitle}>
        {t('review.answers.title')}
      </h2>
      {item.missingFields.length > 0 ? (
        <div className={styles.cardWarn} data-testid="kit-missing">
          <p className={styles.strong}>{t('review.answers.missingTitle', { count: item.missingFields.length })}</p>
          <ul className={styles.plainList}>
            {item.missingFields.map((m) => (
              <li key={m.key} className={styles.spread}>
                <MissingLabel label={m.label} className={styles.body} />
                <span className={styles.missingTag}>{t('setup.profile.missing')}</span>
              </li>
            ))}
          </ul>
          <div className={styles.row}>
            <Link href="/profile" className="btn">
              {t('review.answers.addToProfile')}
            </Link>
          </div>
        </div>
      ) : null}
      {bank.isLoading ? <p className={styles.muted}>{t('loading')}</p> : null}
      {bank.data && answers.length === 0 ? (
        <p className={styles.muted}>
          {t('review.answers.none')}{' '}
          <Link href={setupStepHref('answers')} className={styles.linkButton}>
            {t('review.answers.add')}
          </Link>
        </p>
      ) : null}
      {answers.length > 0 ? (
        <ul className={styles.plainList}>
          {answers.map((a) => (
            <li key={a.id} className={styles.answer}>
              <p className={styles.strong}>{a.questionText}</p>
              <p className={styles.answerText}>{a.answer}</p>
              <CopyButton text={a.answer} label={t('review.answers.copyAria', { question: a.questionText })} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ── Files ───────────────────────────────────────────────────────────────────

export function KitFilesPart({
  item,
  style,
  detail = null,
  detailLoading = false,
}: {
  item: ReadyQueueItem;
  /** The chosen file name style (sent with the download; the server names the file). */
  style: AgentSettings['fileNameStyle'] | null;
  /** GET /agent/queue/:id: the name the resume downloads as, and the kit's resume. */
  detail?: QueueItemDetail | null;
  /** The kit read is still on its way: no name is shown yet (never a guess that changes a moment later). */
  detailLoading?: boolean;
}) {
  const t = useTranslations('ready');
  const [busy, setBusy] = useState<'pdf' | 'docx' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const history = useKitHistory(item.id, { enabled: !detail });
  const recorded = recordedFileNameOf(kitEventsOf(detail?.history ?? history.data?.items));
  // One source for the name: the server, which uses the export's own rules.
  const preview = detail?.kit.fileName ?? null;
  const shown = recorded ?? (preview ? `${preview}.pdf` : null);
  const variantId = detail?.kit.resume.variantId ?? item.resumeVariantId;

  const download = async (format: 'pdf' | 'docx') => {
    if (!variantId) return;
    setBusy(format);
    setError(null);
    try {
      const r = await downloadResumeExport(variantId, { format, nameStyle: style, trackerEntryId: item.trackerEntryId }, preview || 'resume');
      setSaved(r.fileName);
    } catch (err) {
      setError(apiErrorCode(err) === 'unverified_claims' ? t('review.errors.unverified') : t('review.files.failed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={styles.card} aria-labelledby="kit-files-title" data-testid="kit-files">
      <h2 id="kit-files-title" className={styles.cardTitle}>
        {t('review.files.title')}
      </h2>
      {shown ? (
        <>
          <p className={styles.muted}>{recorded ? t('review.files.recorded') : t('review.files.willBe')}</p>
          <p className={styles.fileName} data-testid="kit-file-name">
            {shown}
          </p>
        </>
      ) : detailLoading ? (
        <p className={styles.muted} role="status">
          {t('loading')}
        </p>
      ) : null}
      {variantId ? (
        <div className={styles.row}>
          <Btn onClick={() => void download('pdf')} disabled={busy !== null}>
            {t('review.files.pdf')}
          </Btn>
          <Btn variant="ghost" onClick={() => void download('docx')} disabled={busy !== null}>
            {t('review.files.docx')}
          </Btn>
        </div>
      ) : null}
      {item.coverLetterId ? (
        <div className={styles.row}>
          <a className="btn ghost" href={coverLetterExportUrl(item.coverLetterId, { format: 'pdf', ...(item.trackerEntryId ? { trackerEntryId: item.trackerEntryId } : {}) })}>
            {t('review.files.letterPdf')}
          </a>
        </div>
      ) : null}
      {saved ? (
        <p className={styles.status} role="status">
          {t('review.files.saved', { name: saved })}
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

// ── Open application ────────────────────────────────────────────────────────

/**
 * A blank tab opened inside the click (so it is not blocked), pointed at the
 * employer's page only after the server has moved the job to Applied, and
 * closed again when it refuses. `noopener` cannot be passed here (the handle
 * would be null), so the opener is cut by hand.
 */
function openPendingTab(): Window | null {
  if (typeof window === 'undefined') return null;
  const w = window.open('', '_blank');
  if (w) {
    try {
      w.opener = null;
    } catch {
      // cross-origin or locked: nothing to cut
    }
  }
  return w;
}

export interface KitOpenPartProps {
  item: ReadyQueueItem;
  /** The job's application link from the job read (null when it has none). */
  jobApplyUrl: string | null;
  /** The job read is still loading: Open waits for it. */
  jobLoading?: boolean;
  /** Where the post came from (`job.source.kind`) and the company's domain: only they can make the link "the company's page". */
  sourceKind?: string | null;
  companyDomain?: string | null;
}

export function KitOpenPart({ item, jobApplyUrl, jobLoading = false, sourceKind = null, companyDomain = null }: KitOpenPartProps) {
  const t = useTranslations('ready');
  const format = useFormatter();
  const extensionOn = useFlag('extension');
  const actions = useKitActions(item.id);
  // Only the server-served link is state; the job's own link is read each render.
  const [served, setServed] = useState<string | null>(null);
  const url = safeHttpUrl(served ?? jobApplyUrl);
  const [justOpened, setJustOpened] = useState<{ undoable: boolean } | null>(null);
  const [noLink, setNoLink] = useState(false);
  const [undone, setUndone] = useState(false);
  const [undoExpired, setUndoExpired] = useState(false);
  const { error, setError, report } = useActionError();

  // Called "the company's page" only when it is; otherwise the page is named by its host.
  const employerPage = isEmployerApplyPage({ applyUrl: url, sourceKind, companyDomain });
  const applyHost = employerPage ? null : hostOf(url);

  const opened = item.state === 'opened' || item.state === 'applied';
  if (!opened && item.state !== 'approved' && !justOpened) return null;

  const onOpen = async () => {
    setError(null);
    setUndone(false);
    const tab = openPendingTab();
    try {
      const r = await actions.open();
      const link = safeHttpUrl(r.applyUrl ?? jobApplyUrl);
      if (link) {
        if (tab) tab.location.href = link;
        else window.open(link, '_blank', 'noopener,noreferrer');
      } else {
        tab?.close();
      }
      setServed(link);
      const already = (r as { alreadyApplied?: unknown }).alreadyApplied === true;
      setJustOpened({ undoable: !already });
    } catch (err) {
      tab?.close();
      if (kitErrorReason(err) === 'no_apply_link') setNoLink(true);
      else report(err);
    }
  };

  const onUndo = async () => {
    setError(null);
    setUndoExpired(false);
    try {
      await actions.undo();
      setJustOpened(null);
      setUndone(true);
    } catch (err) {
      // Too old, or moved since: retrying cannot help; the status is changed in Applications.
      if (kitErrorReason(err) === 'kit_undo_expired') {
        setJustOpened((j) => (j ? { undoable: false } : j));
        setUndoExpired(true);
      } else report(err);
    }
  };

  const onMarkApplied = async () => {
    setError(null);
    try {
      await actions.markApplied();
      setNoLink(false);
      setJustOpened({ undoable: true });
    } catch (err) {
      report(err);
    }
  };

  const openedAt = item.openedAt ? new Date(item.openedAt) : null;
  const showUndoBox = justOpened !== null || (opened && !undone);

  return (
    <section className={styles.card} aria-labelledby="kit-open-title" data-testid="kit-open">
      <h2 id="kit-open-title" className={styles.cardTitle}>
        {t('review.open.title')}
      </h2>
      <HonestyLine kind="you_submit" />
      {!showUndoBox ? (
        <>
          <p className={styles.muted} data-testid="kit-open-lead" data-page={employerPage ? 'employer' : 'other'}>
            {employerPage ? t('review.open.lead') : t('review.open.leadNeutral')}
            {applyHost ? ` ${t('review.open.host', { host: applyHost })}` : ''}
          </p>
          <div className={styles.row}>
            <Btn variant="primary" onClick={() => void onOpen()} disabled={jobLoading || actions.pending !== null} aria-busy={jobLoading}>
              {t('review.open.button')}
            </Btn>
            {extensionOn ? <FillWithExtensionButton jobId={item.jobId} applyUrl={url} /> : null}
          </div>
        </>
      ) : (
        <div className={styles.undo} data-testid="kit-undo">
          <span>
            {justOpened && !justOpened.undoable
              ? t('review.open.alreadyApplied')
              : openedAt && !justOpened
                ? t('review.open.movedOn', { date: format.dateTime(openedAt, { month: 'short', day: 'numeric' }) })
                : t('review.open.moved')}
          </span>
          {justOpened?.undoable !== false && !undoExpired ? (
            <button type="button" className={styles.linkButton} onClick={() => void onUndo()} disabled={actions.pending !== null}>
              {t('review.open.undo')}
            </button>
          ) : null}
        </div>
      )}
      {showUndoBox && url ? (
        <p className={styles.muted}>
          <a href={url} target="_blank" rel="noopener noreferrer" className={styles.linkButton}>
            {t('review.open.again')}
          </a>
        </p>
      ) : null}
      {showUndoBox ? (
        <p className={styles.muted}>
          <Link href={applicationHref(item.trackerEntryId)} className={styles.linkButton}>
            {t('review.open.seeApplication')}
          </Link>
        </p>
      ) : null}
      {undone ? (
        <p className={styles.status} role="status">
          {t('review.open.undone')}
        </p>
      ) : null}
      {undoExpired ? (
        <p className={styles.error} role="alert" data-testid="kit-undo-expired">
          {t('review.errors.undoExpired')}{' '}
          <Link href={applicationHref(item.trackerEntryId)} className={styles.linkButton}>
            {t('review.open.changeInApplications')}
          </Link>
        </p>
      ) : null}
      {noLink ? (
        <div className={styles.cardWarn} data-testid="kit-no-link">
          <p className={styles.body}>{t('review.open.noLink')}</p>
          <div className={styles.row}>
            <Btn onClick={() => void onMarkApplied()} disabled={actions.pending !== null}>
              {t('review.open.iApplied')}
            </Btn>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

// ── History ─────────────────────────────────────────────────────────────────

type Translate = (key: string, values?: Record<string, string | number | Date>) => string;

/** One plain line per history row, naming only what the row's own details show. Pure. */
export function eventLine(e: KitEventView, t: Translate): string {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  const part = d.part === 'resume' || d.part === 'letter' ? d.part : null;
  if (typeof d.fileName === 'string' && d.fileName.trim()) return t('review.history.file', { name: d.fileName });
  if (part && d.decision === 'use') return t(`review.history.used.${part}`);
  if (part && d.decision === 'revise') return t(`review.history.revised.${part}`);
  if (typeof d.notice === 'string') return t('review.history.notice');
  if (d.via === 'undo') return t('review.history.undone');
  if (e.toState === 'ready_for_review') {
    const resume = typeof d.tailorSessionId === 'string' && d.tailorSessionId.length > 0;
    const letter = typeof d.coverLetterId === 'string' && d.coverLetterId.length > 0;
    if (resume && letter) return t('review.history.generated.both');
    if (resume) return t('review.history.generated.resume');
    if (letter) return t('review.history.generated.letter');
  }
  if (e.toState === 'opened') return t('review.history.opened');
  if (e.toState === 'applied') return t('review.history.applied');
  return t('review.history.moved', { state: t(`state.${e.toState}`) });
}

export function KitHistoryPart({ item, detail = null }: { item: ReadyQueueItem; detail?: QueueItemDetail | null }) {
  const t = useTranslations('ready');
  const format = useFormatter();
  const history = useKitHistory(item.id, { enabled: !detail });
  const events = kitEventsOf(detail?.history ?? history.data?.items);
  if (events === undefined) {
    // Not served here yet (501/flag off): no section rather than a claim.
    if (history.isError && !detail && !isUnavailable(history.error)) {
      return (
        <section className={styles.card} aria-labelledby="kit-history-title" data-testid="kit-history">
          <h2 id="kit-history-title" className={styles.cardTitle}>
            {t('review.history.title')}
          </h2>
          <p className={styles.muted}>{t('review.history.loadFailed')}</p>
        </section>
      );
    }
    return null;
  }
  return (
    <section className={styles.card} aria-labelledby="kit-history-title" data-testid="kit-history">
      <h2 id="kit-history-title" className={styles.cardTitle}>
        {t('review.history.title')}
      </h2>
      {events.length === 0 ? (
        <p className={styles.muted}>{t('review.history.none')}</p>
      ) : (
        <ol className={styles.history}>
          {events.map((e) => (
            <li key={e.id} className={styles.historyItem}>
              <span className={styles.body}>{eventLine(e, t)}</span>
              <span className={styles.muted}>
                {t(`review.history.actor.${e.actor}`)} · {format.dateTime(new Date(e.createdAt), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ── Practice ────────────────────────────────────────────────────────────────

export function KitPracticePart({ item }: { item: ReadyQueueItem }) {
  const t = useTranslations('ready');
  const launch = useLaunchPractice();
  return (
    <section className={styles.card} aria-labelledby="kit-practice-title" data-testid="kit-practice">
      <h2 id="kit-practice-title" className={styles.sectionTitle}>
        {t('review.practice.title')}
      </h2>
      <p className={styles.muted}>{t('review.practice.sub')}</p>
      <div className={styles.row}>
        <Btn onClick={() => launch({ jobId: item.jobId, resumeId: item.resumeVariantId, from: 'ready' })}>{t('review.practice.button')}</Btn>
      </div>
    </section>
  );
}
