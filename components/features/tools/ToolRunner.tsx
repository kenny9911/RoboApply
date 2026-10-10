'use client';

// One free tool page body (WP-57): the form (file, posting fields for the
// resume–job check, the GoApply notice), today's allowance for this tool, the
// privacy line, then the report and the next step. Back from signing up or in
// (`next=/tools/<slug>`), the result the visitor asked to keep in this tab
// (./pendingResult.ts — never a URL parameter) is shown again instead of the
// form; the server answers it only to the browser that ran the check.

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useState, type FormEvent } from 'react';

import { apiErrorReason } from '../../../lib/api/contracts/wire';
import type { ClaimToolResultResponse, ToolKind, ToolReport } from '../../../lib/api/contracts/tools';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { Btn, PageHeader } from '../../v3/primitives';
import { CLIENT_CONSENT_VERSION, CLIENT_LIMITS, toolByKind } from './catalog';
import { toolErrorText } from './errors';
import { AllowanceLine, ConsentField, FileField, type FileCheck } from './fields';
import { useRunResumeCheck, useRunResumeJobMatch, useToolResult, useToolsConfig } from './hooks';
import { NextStep } from './NextStep';
import { clearPendingResult, readPendingResult } from './pendingResult';
import { ToolReportView } from './reports';
import styles from './tools.module.css';

/** A pasted value that is only a link (the free tool does not fetch pages). */
export function isBareLink(text: string): boolean {
  return /^(?:https?:\/\/|www\.)\S+$/i.test(text.trim());
}

export interface ToolRunnerProps {
  kind: ToolKind;
}

export function ToolRunner({ kind }: ToolRunnerProps) {
  const t = useTranslations('tools');
  const brand = useBrand();
  const entry = toolByKind(kind);
  const isCheck = kind === 'resume_check';
  const config = useToolsConfig();
  // The result this tab asked to keep (clicked signup / sign-in under it), read after mount.
  const [resultId, setResultId] = useState<string | null>(null);
  useEffect(() => {
    const pending = readPendingResult();
    if (pending && pending.kind === kind) setResultId(pending.id);
  }, [kind]);
  const existing = useToolResult(resultId);
  const runCheck = useRunResumeCheck();
  const runMatch = useRunResumeJobMatch();
  const run = isCheck ? runCheck : runMatch;

  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState<FileCheck>('ok');
  const [consent, setConsent] = useState(false);
  const [postingTitle, setPostingTitle] = useState('');
  const [postingText, setPostingText] = useState('');
  const [report, setReport] = useState<ToolReport | null>(null);
  const [claimed, setClaimed] = useState<ClaimToolResultResponse | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // "Check another file" on a reopened result: don't put the reopened report back.
  const [dismissed, setDismissed] = useState(false);
  const titleId = useId();
  const textId = useId();
  const textHintId = useId();

  useEffect(() => {
    if (existing.data && existing.data.kind === kind && !report && !dismissed) setReport(existing.data);
  }, [existing.data, kind, report, dismissed]);
  // Gone, kept or not this browser's: nothing left to carry.
  useEffect(() => {
    if (existing.isError) clearPendingResult();
  }, [existing.isError]);

  const cfg = config.data ?? null;
  const hours = cfg?.cacheHours ?? CLIENT_LIMITS.cacheHours;
  const mb = Math.round((cfg?.maxFileBytes ?? CLIENT_LIMITS.maxFileBytes) / (1024 * 1024));
  const linkOnly = !isCheck && isBareLink(postingText);
  const busy = run.isPending;
  // GoApply needs the notice ticked even when /config did not answer (the server refuses without it).
  const consentRequired = cfg ? cfg.consentRequired : brand.market === 'cn';
  const consentVersion = cfg?.consentVersion ?? CLIENT_CONSENT_VERSION;
  const existingReason = existing.isError ? apiErrorReason(existing.error) : null;
  const existingNotice: 'claimed' | 'expired' | 'missing' | null = !existing.isError
    ? null
    : existingReason === 'result_claimed'
      ? 'claimed'
      : existingReason === 'result_expired'
        ? 'expired'
        : 'missing';
  // Should the server say the tools are off here (`available: false`): no form.
  const unavailable = cfg?.available === false;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!file) return setFormError(t('errors.file_missing'));
    if (fileProblem !== 'ok') return setFormError(t(`errors.${fileProblem}`, { mb }));
    if (consentRequired && !consent) return setFormError(t('errors.consent_required'));
    const consentValue = consentRequired ? consentVersion : null;
    const onError = (err: unknown) => setFormError(toolErrorText(t, err, cfg?.perIpPerDay));
    if (isCheck) {
      runCheck.mutate({ resume: file, consent: consentValue }, { onSuccess: setReport, onError });
      return;
    }
    if (!postingTitle.trim()) return setFormError(t('errors.posting_title_missing'));
    if (linkOnly) return setFormError(t('match.linkNotice'));
    if (postingText.trim().length < CLIENT_LIMITS.postingMinChars) {
      return setFormError(t('errors.posting_too_short', { min: CLIENT_LIMITS.postingMinChars }));
    }
    runMatch.mutate({ resume: file, consent: consentValue, postingTitle: postingTitle.trim(), postingText: postingText.trim() }, { onSuccess: setReport, onError });
  };

  const reset = () => {
    setDismissed(true);
    setReport(null);
    setClaimed(null);
    setFile(null);
    setFileProblem('ok');
    setFormError(null);
    run.reset();
  };

  const ns = isCheck ? 'check' : 'match';
  const shown = claimed?.report ?? report;

  return (
    <div className={styles.page} data-tool={entry.slug}>
      <Link href="/tools" className={styles.back}>
        {t('back')}
      </Link>
      <PageHeader eyebrow={t(`${ns}.eyebrow`)} title={t(`${ns}.title`)} sub={t(`${ns}.sub`)} />

      {resultId && existingNotice && !report && !dismissed ? (
        existingNotice === 'claimed' ? (
          <p className={styles.notice} role="status" data-notice="claimed">
            {t('claim.alreadySaved')}{' '}
            <Link href="/resume">{t('claim.openResumes')}</Link>
          </p>
        ) : (
          <p className={styles.notice} role="status" data-notice={existingNotice}>
            {existingNotice === 'expired' ? t('errors.result_expired') : t('errors.result_missing')}
          </p>
        )
      ) : null}

      {unavailable && !shown ? (
        <p className={styles.notice} role="status" data-notice="unavailable">
          {t('unavailable')}
        </p>
      ) : shown ? (
        <>
          <ToolReportView report={shown} />
          <NextStep report={shown} claimed={claimed} onClaimed={setClaimed} />
          <div className={styles.actions}>
            <Btn onClick={reset}>{t('report.again')}</Btn>
          </div>
        </>
      ) : (
        <form className={styles.card} onSubmit={submit} noValidate aria-busy={busy}>
          <FileField
            file={file}
            config={cfg}
            disabled={busy}
            onChange={(f, problem) => {
              setFile(f);
              setFileProblem(problem);
              setFormError(problem !== 'ok' ? t(`errors.${problem}`, { mb }) : null);
            }}
          />

          {!isCheck ? (
            <>
              <div className={styles.field}>
                <label className={styles.label} htmlFor={titleId}>
                  {t('match.postingTitle')}
                </label>
                <input
                  id={titleId}
                  className={styles.input}
                  value={postingTitle}
                  onChange={(e) => setPostingTitle(e.target.value)}
                  maxLength={200}
                  disabled={busy}
                  autoComplete="off"
                />
                <p className={styles.muted}>{t('match.postingTitleHint')}</p>
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor={textId}>
                  {t('match.postingText')}
                </label>
                <textarea
                  id={textId}
                  className={styles.textarea}
                  value={postingText}
                  onChange={(e) => setPostingText(e.target.value)}
                  maxLength={CLIENT_LIMITS.postingMaxChars}
                  disabled={busy}
                  aria-describedby={textHintId}
                />
                <p className={styles.muted} id={textHintId}>
                  {t('match.postingTextHint', { min: CLIENT_LIMITS.postingMinChars })}
                </p>
                {linkOnly ? (
                  <p className={styles.notice} role="status" data-notice="link">
                    {t('match.linkNotice')}
                  </p>
                ) : null}
              </div>
            </>
          ) : null}

          {consentRequired ? (
            <ConsentField checked={consent} onChange={setConsent} config={cfg} hours={hours} disabled={busy} />
          ) : null}

          {formError ? (
            <p className={styles.error} role="alert">
              {formError}
            </p>
          ) : null}

          <div className={styles.actions}>
            <Btn type="submit" variant="primary" disabled={busy}>
              {t(`${ns}.submit`)}
            </Btn>
            <AllowanceLine config={cfg} kind={kind} />
          </div>
          {busy ? (
            <p className={styles.muted} role="status">
              {t(`${ns}.running`)}
            </p>
          ) : null}
          <p className={styles.muted} data-privacy="tools">
            {t('privacy', { hours })}
          </p>
        </form>
      )}
    </div>
  );
}
