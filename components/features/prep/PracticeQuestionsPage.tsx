'use client';

// PracticeQuestionsPage — /practice/questions (F-INT-01; WP-59).
//
//   ?job=<id>   the job's practice set first (AI from the job post + user reports)
//   Companies   companies with questions %BRAND% users shared, each with its count
//   General     staff-written practice questions by group (GoApply adds the HR round)
//   Share       "Share a question you were asked" (moderated)
//
// Hidden (no entry, plain notice) while the `interviewBank` capability is off.
// Counts are counts of moderated rows; nothing is estimated or scraped. Each
// count carries the shared source line (<SourceNote>, D3).

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { EmptyState } from '../../v3/primitives/EmptyState';
import { PageHeader } from '../../v3/primitives/PageHeader';
import { useBrand } from '../../../lib/brand';
import { useFlag } from '../../../lib/flags';
import { SourceNote, isPublishable } from '../common/SourceNote';
import type { QuestionCategory } from '../../../lib/api/contracts/prep';
import { useCuratedQuestions, usePrepCompanies } from '../../../hooks/prep/usePrep';
import { ContributeQuestion } from './ContributeQuestion';
import { JobQuestionSet, companyHref } from './JobQuestionSet';
import { QuestionCard, usePeriodLabel } from './QuestionCard';
import styles from './prep.module.css';

const INTL_GROUPS: readonly QuestionCategory[] = ['behavioral', 'role_specific', 'coding', 'system_design', 'domain_design'];
const CN_GROUPS: readonly QuestionCategory[] = ['hr', 'behavioral', 'role_specific', 'coding', 'system_design', 'domain_design'];

export function CategoryChips({ value, onChange, groups }: { value: QuestionCategory | null; onChange: (v: QuestionCategory | null) => void; groups: readonly QuestionCategory[] }) {
  const t = useTranslations('practiceQuestions');
  return (
    <div className={styles.chips} role="group" aria-label={t('categories.label')}>
      {[null, ...groups].map((g) => (
        <button key={g ?? 'all'} type="button" className={styles.chip} aria-pressed={value === g} onClick={() => onChange(g)}>
          {g ? t(`categories.${g}`) : t('categories.all')}
        </button>
      ))}
    </div>
  );
}

function Companies() {
  const t = useTranslations('practiceQuestions.companies');
  const periodLabel = usePeriodLabel();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const list = usePrepCompanies(query);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setQuery(draft.trim());
  };

  return (
    <section className={styles.section} aria-labelledby="prep-companies">
      <h2 className={styles.h2} id="prep-companies">
        {t('heading')}
      </h2>
      <p className={styles.muted}>{t('sub')}</p>
      <form className={styles.actions} role="search" onSubmit={submit}>
        <label className={styles.srOnly} htmlFor="prep-company-search">
          {t('searchLabel')}
        </label>
        <input
          id="prep-company-search"
          className={styles.input}
          type="search"
          value={draft}
          maxLength={80}
          placeholder={t('searchPlaceholder')}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Btn type="submit">{t('search')}</Btn>
      </form>
      {list.isLoading ? (
        <p className={styles.muted} aria-busy="true">
          {t('loading')}
        </p>
      ) : list.isError ? (
        <p className={styles.error} role="alert">
          {t('loadError')}
        </p>
      ) : items.length === 0 ? (
        <p className={styles.muted}>{query ? t('emptySearch', { q: query }) : t('empty')}</p>
      ) : (
        <ul className={styles.list}>
          {items.map((c) => {
            const latest = periodLabel(c.latestPeriod);
            return (
              <li key={c.slug}>
                <a className={styles.companyRow} href={companyHref(c.slug)}>
                  <span className={styles.companyName}>{c.name}</span>
                  <span className={styles.muted}>
                    {/* Unknown is "—", never 0 (D3). */}
                    {isPublishable(c.questionCount) ? t('count', { count: c.questionCount.value }) : '—'}
                    {latest ? ` · ${t('latest', { period: latest })}` : ''}
                  </span>
                  <SourceNote sourced={c.questionCount} className={styles.muted} />
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {list.hasNextPage ? (
        <div className={styles.actions}>
          <Btn onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
            {t('more')}
          </Btn>
        </div>
      ) : null}
    </section>
  );
}

function General() {
  const t = useTranslations('practiceQuestions.curated');
  const brand = useBrand();
  const groups = brand.market === 'cn' ? CN_GROUPS : INTL_GROUPS;
  const [category, setCategory] = useState<QuestionCategory | null>(null);
  const list = useCuratedQuestions(category);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section className={styles.section} aria-labelledby="prep-general">
      <h2 className={styles.h2} id="prep-general">
        {t('heading')}
      </h2>
      <p className={styles.muted}>{t('sub')}</p>
      <CategoryChips value={category} onChange={setCategory} groups={groups} />
      {list.isLoading ? (
        <p className={styles.muted} aria-busy="true">
          {t('loading')}
        </p>
      ) : list.isError ? (
        <p className={styles.error} role="alert">
          {t('loadError')}
        </p>
      ) : items.length === 0 ? (
        <p className={styles.muted}>{t('empty')}</p>
      ) : (
        <ul className={styles.list}>
          {items.map((q) => (
            <li key={q.id}>
              <QuestionCard question={q} />
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage ? (
        <div className={styles.actions}>
          <Btn onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
            {t('more')}
          </Btn>
        </div>
      ) : null}
    </section>
  );
}

export interface PracticeQuestionsPageProps {
  /** `?job=<id>`: show that job's practice set first. */
  jobId?: string | null;
}

export function PracticeQuestionsPage({ jobId = null }: PracticeQuestionsPageProps) {
  const t = useTranslations('practiceQuestions');
  const enabled = useFlag('interviewBank');
  if (!enabled) {
    return <EmptyState title={t('off.title')} sub={t('off.sub')} action={<Btn as="a" href="/practice">{t('off.back')}</Btn>} />;
  }
  return (
    <div className={styles.page} data-testid="practice-questions">
      <PageHeader title={t('title')} sub={t('sub')} actions={<ContributeQuestion />} />
      {jobId ? <JobQuestionSet jobId={jobId} /> : null}
      <div className={styles.columns}>
        <General />
        <Companies />
      </div>
    </div>
  );
}
