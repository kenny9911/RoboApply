'use client';

// O5 — Your resume (PRODUCT §4.3). Four doors, all visible at once
// (harvested from components/v3/setup/ResumeStep.tsx): upload a file (with a
// real drop target), paste the text, the user's own LinkedIn "Save to PDF"
// file (a how-to, never a LinkedIn URL import), or reuse a resume already in
// the account. Privacy line under the doors. CTA "Find my jobs"; secondary
// "Skip — use my answers only".
//
// GoHire parsing for RoboApply (OD-3, off by default): when the compliance
// API offers the in-context `intl_cross_border_cn_parse` consent, it is asked
// BEFORE any file upload, unticked, with its served prose and version.
//   - Privacy fails closed: while the consent list is loading, or when it
//     could not be loaded, the file and LinkedIn-PDF doors stay closed; paste
//     (always read locally) and a retry stay open.
//   - When declined, Word and text files can still be uploaded (the GoHire
//     parser only takes PDFs, so they are read locally); PDFs and the
//     LinkedIn PDF stay closed until the upload route can force the local
//     parser for PDFs (WP-36b request in the WP-30 handoff). The user can
//     also paste the text or skip and fill the profile by hand later.
//
//   - A PDF is judged against the consent answer as it IS, never against a
//     guess: when the answer has not arrived yet the upload waits for it;
//     when it cannot be loaded, or the question is still unanswered, the
//     message says that. "The reading option you turned off" is said only to
//     a user who did decline (it used to be said to anyone whose PDF arrived
//     before the consent request finished).
//
// The per-day limit (10, persisted server-side) comes back as a 429 from
// POST /onboarding/resume and is explained in plain words.

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useResumeList, useUploadResumeMutation } from '../../../../hooks/useResumes';
import { useOnboardingResumeSeed } from '../../../../hooks/onboarding/useOnboarding';
import { getConsents, recordConsent } from '../../../../lib/api/compliance';
import { apiErrorCode } from '../../../../lib/api/contracts/wire';
import { useBrand } from '../../../../lib/brand/BrandProvider';
import { Btn } from '../../../v3/primitives/Btn';
import { IconCheck, IconUpload } from '../../../v3/primitives/Iconset';
import { LIMITS, RESUME_ACCEPT, RESUME_EXTENSIONS } from '../options';
import { StepFrame } from '../StepFrame';
import { answersOf, type StepScreenProps } from '../types';
import styles from '../onboarding.module.css';

export const CN_PARSE_CONSENT = 'intl_cross_border_cn_parse';

type ErrorKey = 'unreadable' | 'tooLarge' | 'wrongType' | 'dailyLimit' | 'failed' | 'pdfNeedsConsent' | 'consentUnknown' | 'consentUnanswered';

/** Extensions read locally whatever the consent answer (the GoHire parser takes PDFs only). */
export const LOCAL_ONLY_EXTENSIONS = ['.doc', '.docx', '.txt'] as const;
const LOCAL_ONLY_ACCEPT = LOCAL_ONLY_EXTENSIONS.join(',');

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

/** Map an upload/seed failure to a plain-language message key. */
export function resumeErrorKeyOf(err: unknown): ErrorKey {
  const e = err as { payload?: { code?: unknown; details?: { reason?: unknown } }; code?: unknown } | null;
  const payloadCode = typeof e?.payload?.code === 'string' ? e.payload.code : undefined;
  const code = apiErrorCode(err) ?? payloadCode ?? (typeof e?.code === 'string' ? e.code : undefined);
  const reason = e?.payload?.details?.reason;
  if (code === 'rate_limited' || reason === 'onboarding_resume_daily_limit') return 'dailyLimit';
  if (code === 'file_too_large') return 'tooLarge';
  if (code === 'unsupported_format') return 'wrongType';
  if (code === 'empty_text' || reason === 'onboarding_resume_unusable') return 'unreadable';
  return 'failed';
}

export function pastedTextToFile(text: string): File {
  return new File([text], 'pasted-resume.txt', { type: 'text/plain' });
}

function localFileProblem(file: File): ErrorKey | null {
  const lower = file.name.toLowerCase();
  if (!RESUME_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'wrongType';
  if (file.size > LIMITS.resumeMaxBytes) return 'tooLarge';
  return null;
}

/** The in-context parse consent of this user: the item when the API offers it, null when it does not. */
const PARSE_CONSENT_QUERY = {
  queryKey: ['compliance', 'consents', 'onboarding'] as const,
  queryFn: async ({ signal }: { signal?: AbortSignal }) => {
    const res = await getConsents(undefined, { signal });
    return res.items.find((i) => i.type === CN_PARSE_CONSENT) ?? null;
  },
  staleTime: 5 * 60_000,
  retry: false as const,
};

function useParseConsent() {
  return useQuery(PARSE_CONSENT_QUERY);
}

export function ResumeStep({ state, save, onBack, onLeave, busy, error, position }: StepScreenProps) {
  const t = useTranslations('onboarding.resume');
  const brand = useBrand();
  const qc = useQueryClient();
  const prev = answersOf<{ resumeVariantId: string }>(state, 'resume');
  const list = useResumeList();
  const upload = useUploadResumeMutation();
  const seed = useOnboardingResumeSeed();
  const consent = useParseConsent();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pasteRef = useRef<HTMLTextAreaElement | null>(null);
  const depth = useRef(0);

  const variants = list.data?.resumes ?? [];
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [reuseId, setReuseId] = useState<string>('');
  const [dragging, setDragging] = useState(false);
  const [paste, setPaste] = useState('');
  const [problem, setProblem] = useState<ErrorKey | 'pasteShort' | null>(null);
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [consentBusy, setConsentBusy] = useState(false);

  useEffect(() => {
    if (!picked && prev.resumeVariantId) {
      const v = variants.find((x) => x.id === prev.resumeVariantId);
      if (v) setPicked({ id: v.id, name: v.name });
    }
  }, [picked, prev.resumeVariantId, variants]);

  useEffect(() => {
    if (problem === 'unreadable') pasteRef.current?.focus();
  }, [problem]);

  const parseConsent = consent.data ?? null;
  // Fail closed: no file door opens until the consent answer is known.
  const consentKnown = consent.isSuccess;
  const consentPending = !!parseConsent && parseConsent.granted === null;
  const consentDeclined = !!parseConsent && parseConsent.granted === false;
  /** Word / text uploads (always read locally): open once the consent is known and not awaiting an answer. */
  const filesOpen = consentKnown && !consentPending;
  /** PDFs (may be parsed by GoHire): only when the consent is not offered or was granted. */
  const pdfOpen = filesOpen && !consentDeclined;
  const working = busy || upload.isPending || seed.isPending || consentBusy;

  async function answerConsent(granted: boolean) {
    if (!parseConsent) return;
    setConsentBusy(true);
    try {
      await recordConsent({ type: CN_PARSE_CONSENT, granted, proseVersion: parseConsent.proseVersion });
      await qc.invalidateQueries({ queryKey: ['compliance', 'consents', 'onboarding'] });
    } catch {
      setProblem('failed');
    } finally {
      setConsentBusy(false);
    }
  }

  /** The consent answer as of now; waits for a request that has not finished. 'unknown' when it cannot be loaded. */
  async function parseConsentNow() {
    if (consent.isSuccess) return consent.data ?? null;
    try {
      // Joins the request already in flight (or tries again after a failure).
      return (await qc.fetchQuery(PARSE_CONSENT_QUERY)) ?? null;
    } catch {
      return 'unknown' as const;
    }
  }

  async function uploadFile(file: File) {
    const local = localFileProblem(file);
    if (local) return setProblem(local);
    if (isPdfFile(file)) {
      // A PDF may be read by the outside parser: decide on the real answer, and say which case it is.
      setProblem(null);
      const answer = await parseConsentNow();
      if (answer === 'unknown') return setProblem('consentUnknown');
      if (answer && answer.granted === null) return setProblem('consentUnanswered');
      if (answer && answer.granted === false) return setProblem('pdfNeedsConsent');
    }
    setProblem(null);
    setUploadingName(file.name);
    try {
      const v = await upload.mutateAsync({ file });
      setPicked({ id: v.id, name: v.name });
    } catch (err) {
      setProblem(resumeErrorKeyOf(err));
    } finally {
      setUploadingName(null);
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    if (!filesOpen || working) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void uploadFile(file);
  }

  async function findJobs() {
    if (!picked) return;
    try {
      await seed.mutateAsync(picked.id);
      save({ resumeVariantId: picked.id });
    } catch (err) {
      setProblem(resumeErrorKeyOf(err));
    }
  }

  const privacyHref = brand.legal?.privacyPath ?? '/legal/privacy';

  return (
    <StepFrame
      title={t('title')}
      position={position}
      busy={working}
      error={error}
      onBack={onBack}
      onLeave={onLeave}
      onSkip={() => save({ skip: true })}
      skipLabel={t('skip')}
      onNext={() => void findJobs()}
      nextLabel={t('submit')}
      nextDisabled={!picked}
    >
      {parseConsent && consentPending ? (
        <section className={styles.consent} aria-labelledby="ob-consent-title">
          <h2 id="ob-consent-title" className={styles.doorTitle}>
            {t('consent.title')}
          </h2>
          <p className={styles.privacy}>{parseConsent.prose}</p>
          <div className={styles.row}>
            <Btn type="button" onClick={() => void answerConsent(true)} disabled={working} className={styles.touch}>
              {t('consent.agree')}
            </Btn>
            <Btn type="button" onClick={() => void answerConsent(false)} disabled={working} className={styles.touch}>
              {t('consent.decline')}
            </Btn>
          </div>
        </section>
      ) : null}
      {consent.isLoading ? (
        <p className={styles.hint} role="status">
          {t('consent.checking')}
        </p>
      ) : null}
      {consent.isError ? (
        <div className={styles.notice} role="alert">
          <p>{t('consent.loadError')}</p>
          <Btn type="button" onClick={() => void consent.refetch()} disabled={consent.isFetching} className={styles.touch}>
            {t('consent.retry')}
          </Btn>
        </div>
      ) : null}
      {consentDeclined ? (
        <p className={styles.notice} role="status">
          {t('consent.declined')}
        </p>
      ) : null}

      <div className={styles.doors}>
        <div
          className={`${styles.door} ${styles.drop} ${dragging ? styles.dropActive : ''}`}
          onDragEnter={(e) => {
            e.preventDefault();
            depth.current += 1;
            setDragging(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => {
            depth.current = Math.max(0, depth.current - 1);
            if (depth.current === 0) setDragging(false);
          }}
          onDrop={onDrop}
        >
          <h2 className={styles.doorTitle}>{t('upload.title')}</h2>
          <p className={styles.hint}>{pdfOpen || !filesOpen ? t('upload.hint') : t('upload.hintNoPdf')}</p>
          <input
            ref={fileRef}
            type="file"
            accept={pdfOpen ? RESUME_ACCEPT : LOCAL_ONLY_ACCEPT}
            className={styles.srOnly}
            aria-label={t('upload.choose')}
            data-testid="resume-file"
            disabled={!filesOpen || working}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void uploadFile(f);
            }}
          />
          <Btn type="button" icon={<IconUpload size={16} />} onClick={() => fileRef.current?.click()} disabled={!filesOpen || working} className={styles.touch}>
            {t('upload.choose')}
          </Btn>
          <p className={styles.hint}>{t('upload.drop')}</p>
          {uploadingName ? (
            <p className={styles.hint} role="status">
              {t('upload.uploading', { name: uploadingName })}
            </p>
          ) : null}
        </div>

        <div className={styles.door}>
          <h2 className={styles.doorTitle}>{t('linkedin.title')}</h2>
          <p className={styles.hint}>{t('linkedin.body')}</p>
          <Btn type="button" onClick={() => fileRef.current?.click()} disabled={!pdfOpen || working} className={styles.touch}>
            {t('linkedin.choose')}
          </Btn>
        </div>

        <div className={styles.door}>
          <h2 className={styles.doorTitle}>{t('paste.title')}</h2>
          <label className={styles.srOnly} htmlFor="ob-paste">
            {t('paste.label')}
          </label>
          <textarea id="ob-paste" ref={pasteRef} className={styles.textarea} value={paste} onChange={(e) => setPaste(e.target.value)} disabled={working} />
          <p className={styles.hint}>{t('paste.hint')}</p>
          <Btn
            type="button"
            onClick={() => {
              if (paste.trim().length < LIMITS.pasteMinChars) return setProblem('pasteShort');
              void uploadFile(pastedTextToFile(paste.trim()));
            }}
            disabled={working}
            className={styles.touch}
          >
            {t('paste.submit')}
          </Btn>
        </div>

        {variants.length ? (
          <div className={styles.door}>
            <h2 className={styles.doorTitle}>{t('reuse.title')}</h2>
            <label className={styles.srOnly} htmlFor="ob-reuse">
              {t('reuse.label')}
            </label>
            <select id="ob-reuse" className={styles.select} value={reuseId} onChange={(e) => setReuseId(e.target.value)} disabled={working}>
              <option value="">{t('reuse.label')}</option>
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <Btn
              type="button"
              disabled={!reuseId || working}
              onClick={() => {
                const v = variants.find((x) => x.id === reuseId);
                if (v) setPicked({ id: v.id, name: v.name });
              }}
              className={styles.touch}
            >
              {t('reuse.submit')}
            </Btn>
          </div>
        ) : null}
      </div>

      {picked ? (
        <p className={styles.panelStat} role="status">
          <IconCheck size={16} /> {t('ready', { name: picked.name })}
        </p>
      ) : null}
      {problem ? (
        <p className={styles.fieldError} role="alert">
          {problem === 'pasteShort' ? t('paste.tooShort') : problem === 'consentUnknown' ? t('consent.loadError') : t(`errors.${problem}`)}
        </p>
      ) : null}
      <p className={styles.privacy}>
        {t('privacy')}{' '}
        <a className={styles.link} href={privacyHref}>
          {t('privacyLink')}
        </a>
      </p>
    </StepFrame>
  );
}
