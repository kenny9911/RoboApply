'use client';

// Resume hub pieces (WP-36b; PRODUCT_PLAN.md F-RES-02):
//   <ResumeHubTabs active="resumes" />     Resumes · Cover letters (/resume/letters)
//   <BaseSlots used={n} />                 "{n} of 5 resumes" (tailored versions not counted)
//   <ResumeHubMeta resume … />             Primary badge / Make primary + target title
//   <TailoredVersions items … />           tailored versions grouped per job
//
// Data comes from the page (useResumeList); mutations are passed in, so these
// stay presentational and testable. Counts are real list lengths (D3).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { BASE_RESUME_LIMIT, BASE_SLOT_KINDS, type ResumeSummary } from '../../../lib/api/resumes';
import styles from './ResumeHub.module.css';

export type HubTab = 'resumes' | 'letters';

export function ResumeHubTabs({ active }: { active: HubTab }) {
  const t = useTranslations('resume.hub');
  return (
    <nav className={styles.tabs} aria-label={t('tabs.label')}>
      <Link href="/resume" className={styles.tab} aria-current={active === 'resumes' ? 'page' : undefined}>
        {t('tabs.resumes')}
      </Link>
      <Link href="/resume/letters" className={styles.tab} aria-current={active === 'letters' ? 'page' : undefined}>
        {t('tabs.letters')}
      </Link>
    </nav>
  );
}

/** Base resumes take a slot; tailored versions do not. */
export function isBaseSlot(r: Pick<ResumeSummary, 'kind'>): boolean {
  return BASE_SLOT_KINDS.includes(r.kind);
}

export function BaseSlots({ used }: { used: number }) {
  const t = useTranslations('resume.hub');
  const full = used >= BASE_RESUME_LIMIT;
  return (
    <p className={styles.slots} data-full={full || undefined}>
      {t('slots.used', { used, limit: BASE_RESUME_LIMIT })}
      {full ? <span className={styles.slotsFull}> · {t('slots.full')}</span> : null}
    </p>
  );
}

export interface ResumeHubMetaProps {
  resume: ResumeSummary;
  onMakePrimary: () => void;
  onSaveTargetTitle: (title: string) => Promise<unknown>;
  primaryBusy?: boolean;
}

/** Primary badge or "Make primary", and the editable target title. */
export function ResumeHubMeta({ resume, onMakePrimary, onSaveTargetTitle, primaryBusy }: ResumeHubMetaProps) {
  const t = useTranslations('resume.hub');
  const [title, setTitle] = useState(resume.targetTitle ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  useEffect(() => setTitle(resume.targetTitle ?? ''), [resume.targetTitle]);
  const inputId = `target-${resume.id}`;

  async function save() {
    const next = title.trim();
    if (next === (resume.targetTitle ?? '')) return;
    setState('saving');
    try {
      await onSaveTargetTitle(next);
      setState('saved');
    } catch {
      setState('error');
    }
  }

  return (
    <div className={styles.meta}>
      <div className={styles.metaRow}>
        {resume.isPrimary ? (
          <span className={styles.primaryBadge}>{t('primary.badge')}</span>
        ) : (
          <button type="button" className={styles.linkButton} onClick={onMakePrimary} disabled={primaryBusy}>
            {t('primary.make')}
          </button>
        )}
      </div>
      <label className={styles.targetLabel} htmlFor={inputId}>
        {t('target.label')}
      </label>
      <input
        id={inputId}
        className={styles.targetInput}
        value={title}
        maxLength={120}
        placeholder={t('target.placeholder')}
        onChange={(e) => {
          setTitle(e.target.value);
          setState('idle');
        }}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          }
        }}
      />
      <span className={styles.targetStatus} role="status" aria-live="polite">
        {state === 'saving' ? t('target.saving') : state === 'saved' ? t('target.saved') : state === 'error' ? t('target.error') : ''}
      </span>
    </div>
  );
}

export interface TailoredGroup {
  key: string;
  company: string | null;
  title: string | null;
  versions: ResumeSummary[];
}

/** Group tailored versions by the job they were made for (newest edit first). */
export function groupTailored(resumes: readonly ResumeSummary[]): TailoredGroup[] {
  const groups = new Map<string, TailoredGroup>();
  for (const r of resumes) {
    if (isBaseSlot(r)) continue;
    const key = r.targetJobId ?? `${r.targetJobCompany ?? ''}|${r.targetJobTitle ?? ''}|${r.targetJobId ? '' : r.id}`;
    const g = groups.get(key) ?? { key, company: r.targetJobCompany ?? null, title: r.targetJobTitle ?? null, versions: [] };
    g.versions.push(r);
    groups.set(key, g);
  }
  const out = [...groups.values()];
  for (const g of out) g.versions.sort((a, b) => b.lastEditedAt.localeCompare(a.lastEditedAt));
  out.sort((a, b) => b.versions[0]!.lastEditedAt.localeCompare(a.versions[0]!.lastEditedAt));
  return out;
}

export interface TailoredVersionsProps {
  resumes: readonly ResumeSummary[];
  /** Name of the base resume a version came from, by id. */
  baseNames: ReadonlyMap<string, string>;
  formatDate: (iso: string) => string;
}

export function TailoredVersions({ resumes, baseNames, formatDate }: TailoredVersionsProps) {
  const t = useTranslations('resume.hub');
  const groups = groupTailored(resumes);
  if (groups.length === 0) {
    return <p className={styles.muted}>{t('tailored.empty')}</p>;
  }
  return (
    <ul className={styles.tailoredList}>
      {groups.map((g) => (
        <li key={g.key} className={styles.tailoredGroup}>
          <h3 className={styles.tailoredJob}>
            {g.company || g.title ? [g.company, g.title].filter(Boolean).join(' · ') : t('tailored.no_job')}
          </h3>
          <ul className={styles.versionList}>
            {g.versions.map((v) => (
              <li key={v.id} className={styles.versionRow}>
                <Link href={`/resume/${v.id}`} className={styles.versionLink}>
                  {v.name}
                </Link>
                <span className={styles.muted}>
                  {v.basedOnVariantId && baseNames.get(v.basedOnVariantId)
                    ? t('tailored.from', { name: baseNames.get(v.basedOnVariantId)! })
                    : null}
                  {v.basedOnVariantId && baseNames.get(v.basedOnVariantId) ? ' · ' : null}
                  {t('tailored.edited', { when: formatDate(v.lastEditedAt) })}
                </span>
                {v.unverifiedClaims && v.unverifiedClaims > 0 ? (
                  <span className={styles.verifyTag}>{t('tailored.verify', { count: v.unverifiedClaims })}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
