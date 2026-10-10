'use client';

// TailorSetup — the guided steps before Generate (WP-36a; F-RES-09):
//   1. sections to change;
//   2. an optional instruction (≤ 1000 characters);
//   3. the posting's skills the resume does not show — the user ticks only
//      the ones they really have (nothing else is added);
//   4. Generate (one `tailor` credit, spent only when it finishes).
// Repeat users get "Fast tailor" with their last sections.

import { useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, CreditNotice } from '../../v3/primitives';
import { useKeywordReport } from '../../../hooks/resume/useKeywordReport';
import { DEFAULT_TAILOR_SECTIONS, TAILOR_SECTION_KEYS, type TailorSectionKey } from '../../../hooks/tailor';
import type { BucketSummary } from '../../../hooks/shared/useCredits';
import styles from './Tailor.module.css';

export const INSTRUCTION_MAX = 1000;

export interface TailorSetupValue {
  sections: TailorSectionKey[];
  experienceDepth: 'quick' | 'full';
  customPrompt?: string;
  keywords: string[];
  mode: 'fast' | 'guided';
}

export interface TailorSetupProps {
  resumeId: string;
  /** Null for a pasted posting (no skill list to offer). */
  jobId: string | null;
  /** The last settings used on this device (Fast tailor), or null. */
  fast: { sections: TailorSectionKey[]; experienceDepth: 'quick' | 'full' } | null;
  pending: boolean;
  credit: BucketSummary | null;
  onGenerate: (value: TailorSetupValue) => void;
}

function dedupe(list: string[]): string[] {
  return [...new Map(list.filter(Boolean).map((x) => [x.toLowerCase(), x])).values()];
}

export function TailorSetup({ resumeId, jobId, fast, pending, credit, onGenerate }: TailorSetupProps) {
  const t = useTranslations('tailor.setup');
  const [sections, setSections] = useState<TailorSectionKey[]>([...(fast?.sections ?? DEFAULT_TAILOR_SECTIONS)]);
  const [depth, setDepth] = useState<'quick' | 'full'>(fast?.experienceDepth ?? 'quick');
  const depthName = useId();
  const [instruction, setInstruction] = useState('');
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const instructionId = useId();
  const report = useKeywordReport(resumeId, jobId);
  const missing = useMemo(
    () => (report.data ? dedupe([...report.data.hardSkills.missing, ...report.data.keywords.missing]).slice(0, 20) : []),
    [report.data],
  );

  const toggle = <T,>(list: T[], value: T): T[] => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
  const ordered = TAILOR_SECTION_KEYS.filter((s) => sections.includes(s));
  const canGenerate = ordered.length > 0 && !pending;

  return (
    <div className={styles.flow}>
      {fast ? (
        <div className={`${styles.cardSoft} ${styles.fast}`}>
          <div>
            <p className={styles.label}>{t('fastTitle')}</p>
            <p className={styles.sub}>{t('fastSub', { sections: fast.sections.map((s) => t(`section.${s}`)).join(', ') })}</p>
          </div>
          <Btn
            variant="primary"
            disabled={pending}
            onClick={() => onGenerate({ sections: fast.sections, experienceDepth: fast.experienceDepth, keywords: [], mode: 'fast' })}
          >
            {t('fastAction')}
          </Btn>
        </div>
      ) : null}

      <fieldset className={`${styles.section} ${styles.fieldset}`}>
        <legend className={styles.heading}>{t('sectionsTitle')}</legend>
        <p className={styles.sub}>{t('sectionsSub')}</p>
        <div className={styles.checks}>
          {TAILOR_SECTION_KEYS.map((s) => (
            <label key={s} className={styles.check}>
              <input type="checkbox" checked={sections.includes(s)} onChange={() => setSections((prev) => toggle(prev, s))} />
              {t(`section.${s}`)}
            </label>
          ))}
        </div>
        {ordered.length === 0 ? (
          <p className={styles.sub} role="status">
            {t('sectionsNone')}
          </p>
        ) : null}
      </fieldset>

      {sections.includes('experience') ? (
        <fieldset className={`${styles.section} ${styles.fieldset}`}>
          <legend className={styles.label}>{t('depthLabel')}</legend>
          <div className={styles.checks}>
            {(['quick', 'full'] as const).map((d) => (
              <label key={d} className={styles.check}>
                <input type="radio" name={depthName} value={d} checked={depth === d} onChange={() => setDepth(d)} />
                {t(`depth.${d}`)}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      <div className={styles.section}>
        <label className={styles.label} htmlFor={instructionId}>
          {t('instructionLabel')}
        </label>
        <textarea
          id={instructionId}
          className={styles.textarea}
          value={instruction}
          maxLength={INSTRUCTION_MAX}
          placeholder={t('instructionHint')}
          onChange={(e) => setInstruction(e.target.value.slice(0, INSTRUCTION_MAX))}
        />
        <span className={styles.counter} aria-live="polite">
          {t('instructionCount', { count: instruction.length, max: INSTRUCTION_MAX })}
        </span>
      </div>

      {jobId ? (
        <fieldset className={`${styles.section} ${styles.fieldset}`}>
          <legend className={styles.heading}>{t('keywordsTitle')}</legend>
          <p className={styles.sub}>{t('keywordsSub')}</p>
          {report.isLoading ? (
            <p className={styles.sub} role="status">
              {t('keywordsLoading')}
            </p>
          ) : report.isError ? (
            <p className={styles.sub}>{t('keywordsUnavailable')}</p>
          ) : missing.length === 0 ? (
            <p className={styles.sub}>{t('keywordsNone')}</p>
          ) : (
            <div className={styles.checks}>
              {missing.map((k) => (
                <label key={k} className={styles.check}>
                  <input type="checkbox" checked={confirmed.includes(k)} onChange={() => setConfirmed((prev) => toggle(prev, k))} />
                  {k}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      ) : null}

      <div className={styles.section}>
        <CreditNotice bucket={credit} />
        <p className={styles.sub}>{t('cost')}</p>
        <div className={styles.actions}>
          <Btn
            variant="primary"
            disabled={!canGenerate}
            onClick={() =>
              onGenerate({
                sections: ordered,
                experienceDepth: depth,
                customPrompt: instruction.trim() || undefined,
                keywords: confirmed,
                mode: 'guided',
              })
            }
          >
            {pending ? t('generating') : t('generate')}
          </Btn>
        </div>
      </div>
    </div>
  );
}
