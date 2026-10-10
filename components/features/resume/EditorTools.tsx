'use client';

// components/features/resume/EditorTools.tsx — WP-65 editor additions:
//   FitToPageControl    fit on one page (GoApply: 1–2 pages); spacing, margins and
//                       text size only, with Undo (PRODUCT_PLAN.md F-RES-14)
//   AskAssistantButton  "Ask the Assistant about this resume" (F-RES-11 entry)
//   SectionOrderPanel   move sections up / down (F-RES-12); text unchanged
//   ResumeDetailsPanel  GoApply 籍贯 / 政治面貌 and the device photo (cn, TW-04):
//                       printed by the export renderer only, never in the text,
//                       never sent to a model or used for ranking
//   personalLineFor     the preview's copy of the line the export prints
//   docLanguageOf       which labels that line uses (en / zh / zh-TW)

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { useOpenAssistant, type AssistantOpenRequest } from '../../../hooks/shared/useOpenAssistant';
import { useFlag } from '../../../lib/flags';
import { useFitToPage } from '../../../hooks/resume/useFitToPage';
import type { useResumePhoto } from '../../../hooks/resume/useResumePhoto';
import { moveSection, sectionSequence, type SectionRef, type StructuredResume } from '../../../lib/resumeStructure';
import type { ResumeLayout } from '../../../lib/api/resumes';
import styles from './builder/Builder.module.css';

// ── Fit to page ──────────────────────────────────────────────────────────

export function FitToPageControl({ resumeId, maxPages = 1, photo = false }: { resumeId: string; maxPages?: 1 | 2; photo?: boolean }) {
  const t = useTranslations('resumeBuilder.fit');
  const { fit, undo, last } = useFitToPage(resumeId);
  const [undone, setUndone] = useState(false);
  const run = (pages: 1 | 2) => {
    setUndone(false);
    // A placed device photo takes header room: the server reserves its box.
    fit.mutate({ pages, photo });
  };
  let status: string | null = null;
  if (fit.isError) status = t('error');
  else if (undone) status = t('undone');
  else if (last?.status === 'fitted') status = t('fitted', { pages: last.pages.after });
  else if (last?.status === 'already_fits') status = t('already', { pages: last.pages.before });
  else if (last?.status === 'too_long') status = t('tooLong', { target: last.pages.target });
  return (
    <div className={styles.fitBar} data-tour="fit">
      <Btn type="button" onClick={() => run(1)} disabled={fit.isPending} aria-busy={fit.isPending || undefined}>
        {fit.isPending ? t('busy') : t('one')}
      </Btn>
      {maxPages === 2 ? (
        <Btn type="button" variant="ghost" onClick={() => run(2)} disabled={fit.isPending}>
          {t('two')}
        </Btn>
      ) : null}
      {last?.applied ? (
        <Btn
          type="button"
          variant="ghost"
          disabled={undo.isPending}
          onClick={() =>
            undo.mutate(undefined, {
              onSuccess: () => setUndone(true),
            })
          }
        >
          {t('undo')}
        </Btn>
      ) : null}
      <p className={styles.fitStatus} role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}

// ── Assistant entry ──────────────────────────────────────────────────────

/**
 * The Assistant open request from the resume editor: the shared request plus
 * the resume it is about. The rail stores the whole request, so `resumeId`
 * reaches it today; the fields move into AssistantOpenRequest when WP-51 adds
 * the resume scope.
 */
export type ResumeAssistantRequest = AssistantOpenRequest & { resumeId: string; scope: 'resume' };

/**
 * Opens the Assistant from the editor with a prefilled request about this
 * resume (never sent until the user presses Send). Renders nothing when the
 * Assistant is off for this brand or AI is unavailable for this user.
 */
export function AskAssistantButton({ resumeId, enabled = true }: { resumeId: string; enabled?: boolean }) {
  const t = useTranslations('resumeBuilder.assistant');
  const assistantOn = useFlag('copilot');
  const open = useOpenAssistant();
  if (!enabled || !assistantOn) return null;
  return (
    <Btn
      type="button"
      variant="ghost"
      data-resume-id={resumeId}
      onClick={() => {
        // The request carries the resume id (ResumeAssistantRequest) so the
        // rail can open the resume-scoped thread; until the rail and the
        // copilot thread read `resumeId` (request to WP-51 / INT) the prompt
        // still names the resume the user is looking at.
        const request: ResumeAssistantRequest = { source: 'resume', resumeId, scope: 'resume', prompt: t('prompt') };
        open(request);
      }}
    >
      {t('ask')}
    </Btn>
  );
}

// ── Section order ────────────────────────────────────────────────────────

const KNOWN_LABEL = { summary: 'summary', experiences: 'experience', education: 'education', skills: 'skills' } as const;

export function SectionOrderPanel({ resume, onChange }: { resume: StructuredResume; onChange: (next: StructuredResume) => void }) {
  const t = useTranslations('resumeBuilder.order');
  const seq = sectionSequence(resume);
  const nameOf = (ref: SectionRef) =>
    ref.kind === 'known'
      ? resume.headings?.[ref.key] ?? t(`known.${KNOWN_LABEL[ref.key]}`)
      : resume.extraSections.find((x) => x.id === ref.id)?.heading || t('untitled');
  if (seq.length < 2) return <p className={styles.hint}>{t('tooFew')}</p>;
  return (
    <div className={styles.panel}>
      <p className={styles.hint}>{t('hint')}</p>
      <ol className={styles.orderList}>
        {seq.map((ref, i) => {
          const name = nameOf(ref);
          return (
            <li key={ref.kind === 'known' ? ref.key : ref.id} className={styles.orderItem}>
              <span>{name}</span>
              <span className={styles.orderBtns}>
                <button type="button" className={styles.iconBtn} aria-label={t('up', { section: name })} disabled={i === 0} onClick={() => onChange(moveSection(resume, ref, -1))}>
                  ↑
                </button>
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label={t('down', { section: name })}
                  disabled={i === seq.length - 1}
                  onClick={() => onChange(moveSection(resume, ref, 1))}
                >
                  ↓
                </button>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ── Personal details + photo ─────────────────────────────────────────────

const PERSONAL_LABELS = {
  en: { nativePlace: 'Native place', politicalStatus: 'Political status', colon: ': ', sep: ' · ' },
  zh: { nativePlace: '籍贯', politicalStatus: '政治面貌', colon: '：', sep: ' ｜ ' },
  'zh-TW': { nativePlace: '籍貫', politicalStatus: '政治面貌', colon: '：', sep: ' ｜ ' },
} as const;

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

/** The labels' language for the details line (the export's rule: chosen titles, else the text). */
export function docLanguageOf(headingLanguage: 'as_written' | 'en' | 'zh' | 'zh-TW', text: string): 'en' | 'zh' | 'zh-TW' {
  if (headingLanguage !== 'as_written') return headingLanguage;
  if (!CJK_RE.test(text)) return 'en';
  return /[個學實經專證歷]/.test(text) ? 'zh-TW' : 'zh';
}

/** The personal details line as the export prints it (same labels as the server). */
export function personalLineFor(personal: ResumeLayout['personal'] | null | undefined, language: 'en' | 'zh' | 'zh-TW'): string | null {
  if (!personal) return null;
  const L = PERSONAL_LABELS[language];
  const parts: string[] = [];
  if (personal.nativePlace?.trim()) parts.push(`${L.nativePlace}${L.colon}${personal.nativePlace.trim()}`);
  if (personal.politicalStatus?.trim()) parts.push(`${L.politicalStatus}${L.colon}${personal.politicalStatus.trim()}`);
  return parts.length ? parts.join(L.sep) : null;
}

export function ResumeDetailsPanel({
  layout,
  personalFields,
  photoOffered,
  photo,
  onPatch,
  saving,
}: {
  layout: ResumeLayout | null | undefined;
  personalFields: Array<'nativePlace' | 'politicalStatus'>;
  photoOffered: boolean;
  photo: ReturnType<typeof useResumePhoto>;
  onPatch: (patch: Partial<ResumeLayout>) => void;
  saving?: boolean;
}) {
  const t = useTranslations('resumeBuilder');
  const [nativePlace, setNativePlace] = useState(layout?.personal?.nativePlace ?? '');
  const [politicalStatus, setPoliticalStatus] = useState(layout?.personal?.politicalStatus ?? '');
  const [photoError, setPhotoError] = useState<string | null>(null);
  useEffect(() => {
    setNativePlace(layout?.personal?.nativePlace ?? '');
    setPoliticalStatus(layout?.personal?.politicalStatus ?? '');
  }, [layout?.personal?.nativePlace, layout?.personal?.politicalStatus]);
  const placePhoto = layout?.photo !== false;
  const savePersonal = () => {
    const np = nativePlace.trim();
    const ps = politicalStatus.trim();
    if (np === (layout?.personal?.nativePlace ?? '') && ps === (layout?.personal?.politicalStatus ?? '')) return;
    onPatch({ personal: np || ps ? { ...(np ? { nativePlace: np } : {}), ...(ps ? { politicalStatus: ps } : {}) } : null });
  };
  return (
    <div className={styles.panel} aria-busy={saving || undefined}>
      <p className={styles.hint}>{t('personal.intro')}</p>
      {personalFields.includes('nativePlace') ? (
        <label className={styles.field}>
          <span className={styles.label}>{t('field.nativePlace')}</span>
          <input className={styles.input} value={nativePlace} maxLength={40} onChange={(e) => setNativePlace(e.target.value)} onBlur={savePersonal} />
        </label>
      ) : null}
      {personalFields.includes('politicalStatus') ? (
        <label className={styles.field}>
          <span className={styles.label}>{t('field.politicalStatus')}</span>
          <input className={styles.input} value={politicalStatus} maxLength={20} onChange={(e) => setPoliticalStatus(e.target.value)} onBlur={savePersonal} />
        </label>
      ) : null}
      {photoOffered ? (
        <div>
          <label className={styles.check}>
            <input type="checkbox" checked={placePhoto} onChange={(e) => onPatch({ photo: e.target.checked })} />
            <span>{t('photo.label')}</span>
          </label>
          <p className={styles.fieldHint}>{t('photo.hint')}</p>
          <div className={styles.photoRow}>
            {photo.photo ? (
              // A data: URL from this device; next/image adds nothing here.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photo.photo} alt={t('photo.alt')} className={styles.photo} />
            ) : null}
            <label className={styles.btnText}>
              {photo.photo ? t('photo.replace') : t('photo.choose')}
              <input
                type="file"
                accept="image/jpeg,image/png"
                className={styles.visuallyHidden}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  setPhotoError(null);
                  try {
                    await photo.save(file);
                  } catch (err) {
                    setPhotoError(err instanceof Error && err.message === 'unsupported_photo' ? t('photo.errors.unsupported') : t('photo.errors.tooLarge'));
                  }
                }}
              />
            </label>
            {photo.photo ? (
              <button type="button" className={styles.btnText} onClick={photo.remove}>
                {t('photo.remove')}
              </button>
            ) : null}
          </div>
          {photoError ? (
            <p className={styles.error} role="alert">
              {photoError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
