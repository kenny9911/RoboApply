'use client';

// The first step under Alice's greeting: start from a resume already in the
// account, upload one, or go on without. Shown until the person has said
// anything.
//
// The upload keeps the onboarding resume step's privacy rules exactly
// (components/features/onboarding/steps/ResumeStep.tsx): when the compliance
// API offers the in-context `intl_cross_border_cn_parse` consent, it is asked
// before a PDF is read (a PDF may go to the outside parser), unticked, with
// its served prose; while the answer is unknown the PDF waits for it; Word and
// text files are always read locally. The consent's words are the onboarding
// step's own (`onboarding.resume.consent`), so the question reads the same
// everywhere it is asked.

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useResumeList, useUploadResumeMutation } from '../../../hooks/useResumes';
import { getConsents, recordConsent } from '../../../lib/api/compliance';
import { CN_PARSE_CONSENT, isPdfFile, resumeErrorKeyOf } from '../onboarding/steps/ResumeStep';
import { LIMITS, RESUME_ACCEPT, RESUME_EXTENSIONS } from '../onboarding/options';
import { IconUpload } from '../../v3/primitives/Iconset';
import s from './alice.module.css';

const LOCAL_ONLY_ACCEPT = '.doc,.docx,.txt';

const PARSE_CONSENT_QUERY = {
  queryKey: ['compliance', 'consents', 'onboarding'] as const,
  queryFn: async ({ signal }: { signal?: AbortSignal }) => {
    const res = await getConsents(undefined, { signal });
    return res.items.find((i) => i.type === CN_PARSE_CONSENT) ?? null;
  },
  staleTime: 5 * 60_000,
  retry: false as const,
};

type Problem = ReturnType<typeof resumeErrorKeyOf> | 'consentUnknown' | 'consentUnanswered' | 'pdfNeedsConsent';

export interface ResumeStartProps {
  busy: boolean;
  onResume: (resumeVariantId: string) => void;
  onSkip: () => void;
}

export function ResumeStart({ busy, onResume, onSkip }: ResumeStartProps) {
  const t = useTranslations('alice.resume');
  const tc = useTranslations('onboarding.resume.consent');
  const qc = useQueryClient();
  const list = useResumeList();
  const upload = useUploadResumeMutation();
  const consent = useQuery(PARSE_CONSENT_QUERY);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [consentBusy, setConsentBusy] = useState(false);

  const resumes = useMemo(() => (list.data?.resumes ?? []).filter((r) => r.kind === 'base'), [list.data]);
  const primary = resumes.find((r) => r.isPrimary) ?? resumes[0] ?? null;
  const parseConsent = consent.data ?? null;
  const consentPending = !!parseConsent && parseConsent.granted === null;
  const consentDeclined = !!parseConsent && parseConsent.granted === false;
  const filesOpen = consent.isSuccess && !consentPending;
  const working = busy || upload.isPending || consentBusy;

  async function answerConsent(granted: boolean) {
    if (!parseConsent) return;
    setConsentBusy(true);
    try {
      await recordConsent({ type: CN_PARSE_CONSENT, granted, proseVersion: parseConsent.proseVersion });
      await qc.invalidateQueries({ queryKey: PARSE_CONSENT_QUERY.queryKey });
    } catch {
      setProblem('failed');
    } finally {
      setConsentBusy(false);
    }
  }

  async function uploadFile(file: File) {
    const lower = file.name.toLowerCase();
    if (!RESUME_EXTENSIONS.some((ext) => lower.endsWith(ext))) return setProblem('wrongType');
    if (file.size > LIMITS.resumeMaxBytes) return setProblem('tooLarge');
    if (isPdfFile(file)) {
      let answer: typeof parseConsent | 'unknown';
      try {
        answer = consent.isSuccess ? parseConsent : ((await qc.fetchQuery(PARSE_CONSENT_QUERY)) ?? null);
      } catch {
        answer = 'unknown';
      }
      if (answer === 'unknown') return setProblem('consentUnknown');
      if (answer && answer.granted === null) return setProblem('consentUnanswered');
      if (answer && answer.granted === false) return setProblem('pdfNeedsConsent');
    }
    setProblem(null);
    setUploading(file.name);
    try {
      const v = await upload.mutateAsync({ file });
      onResume(v.id);
    } catch (err) {
      setProblem(resumeErrorKeyOf(err));
    } finally {
      setUploading(null);
    }
  }

  return (
    <div className={s.section}>
      <div className={s.startActions}>
        {primary ? (
          <button type="button" className={`${s.btn} ${s.primary}`} disabled={working} onClick={() => onResume(primary.id)}>
            {t('use', { name: primary.name })}
          </button>
        ) : null}
        <button type="button" className={primary ? s.btn : `${s.btn} ${s.primary}`} disabled={working || !filesOpen} onClick={() => fileRef.current?.click()}>
          <IconUpload size={16} />
          {t('upload')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={consentDeclined ? LOCAL_ONLY_ACCEPT : RESUME_ACCEPT}
          className={s.srOnly}
          tabIndex={-1}
          aria-label={t('upload')}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void uploadFile(file);
          }}
        />
        <button type="button" className={s.btn} disabled={working} onClick={onSkip}>
          {t('skip')}
        </button>
      </div>
      {resumes.length > 1 ? (
        showAll ? (
          <div className={s.section}>
            <span className={s.fieldLabel}>{t('pickLabel')}</span>
            <ul className={s.resumeList}>
              {resumes.map((r) => (
                <li key={r.id}>
                  <button type="button" className={s.chip} disabled={working} onClick={() => onResume(r.id)}>
                    {r.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <button type="button" className={s.textBtn} onClick={() => setShowAll(true)}>
            {t('other')}
          </button>
        )
      ) : null}
      <p className={s.meta}>{consentDeclined ? t('hintNoPdf') : t('hint')}</p>
      {uploading ? <p className={s.meta}>{t('uploading', { name: uploading })}</p> : null}
      {parseConsent && consentPending ? (
        <section className={s.consent} aria-labelledby="alice-consent-title">
          <h3 id="alice-consent-title" className={s.h3}>
            {tc('title')}
          </h3>
          <p className={s.meta}>{parseConsent.prose}</p>
          <div className={s.actions}>
            <button type="button" className={`${s.btn} ${s.btnSmall}`} disabled={consentBusy} onClick={() => void answerConsent(true)}>
              {tc('agree')}
            </button>
            <button type="button" className={`${s.btn} ${s.btnSmall}`} disabled={consentBusy} onClick={() => void answerConsent(false)}>
              {tc('decline')}
            </button>
          </div>
        </section>
      ) : null}
      {consent.isLoading ? <p className={s.meta}>{tc('checking')}</p> : null}
      {consent.isError ? (
        <div className={s.actions}>
          <p className={s.problem}>{tc('loadError')}</p>
          <button type="button" className={s.textBtn} onClick={() => void consent.refetch()}>
            {tc('retry')}
          </button>
        </div>
      ) : null}
      {problem ? (
        <p className={s.problem} role="alert">
          {t(`errors.${problem}` as never)}
        </p>
      ) : null}
    </div>
  );
}
