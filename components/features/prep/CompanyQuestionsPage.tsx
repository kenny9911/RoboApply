'use client';

// CompanyQuestionsPage — /practice/questions/[company] (F-INT-01; WP-59).
// ONLY moderated user reports about the company, each with its month, and the
// count of them (rows we hold, as of today). AI-written and staff-written
// questions never appear here: they are not attributed to any company.
// `[company]` is the company slug, or the URL-encoded company name when there
// is no company record (WP-34's job page link). With `?job=<id>` the job's
// own practice set is shown first.

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { EmptyState } from '../../v3/primitives/EmptyState';
import { PageHeader } from '../../v3/primitives/PageHeader';
import { useBrand } from '../../../lib/brand';
import { useFlag } from '../../../lib/flags';
import type { QuestionCategory } from '../../../lib/api/contracts/prep';
import { useCompanyQuestions } from '../../../hooks/prep/usePrep';
import { ContributeQuestion } from './ContributeQuestion';
import { prepErrorKey } from './errors';
import { JobQuestionSet } from './JobQuestionSet';
import { CategoryChips } from './PracticeQuestionsPage';
import { QuestionCard, usePeriodLabel } from './QuestionCard';
import styles from './prep.module.css';

const GROUPS: readonly QuestionCategory[] = ['behavioral', 'role_specific', 'coding', 'system_design', 'domain_design'];

export interface CompanyQuestionsPageProps {
  /** The route segment, decoded. */
  company: string;
  jobId?: string | null;
}

export function CompanyQuestionsPage({ company, jobId = null }: CompanyQuestionsPageProps) {
  const t = useTranslations('practiceQuestions.company');
  const tRoot = useTranslations('practiceQuestions');
  const format = useFormatter();
  const periodLabel = usePeriodLabel();
  const brand = useBrand();
  const enabled = useFlag('interviewBank');
  const [category, setCategory] = useState<QuestionCategory | null>(null);
  const list = useCompanyQuestions(enabled ? company : '', category);

  if (!enabled) {
    return <EmptyState title={tRoot('off.title')} sub={tRoot('off.sub')} action={<Btn as="a" href="/practice">{tRoot('off.back')}</Btn>} />;
  }

  const first = list.data?.pages[0];
  const name = first?.company.name ?? company;
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const count = first?.count ?? null;
  const latest = periodLabel(first?.latestPeriod);
  // Prefill "Share a question" with the resolved name only: the route segment may be
  // a slug ('acme-inc'), and a contribution stored under it would not match the company.
  const shareCompany = first?.company.name ?? '';
  const asOf = count ? new Date(count.asOf) : null;
  const groups: readonly QuestionCategory[] = brand.market === 'cn' ? ['hr', ...GROUPS] : GROUPS;

  return (
    <div className={styles.page} data-testid="company-questions">
      <PageHeader
        eyebrow={
          <a className={styles.link} href="/practice/questions">
            {t('back')}
          </a>
        }
        title={t('title', { company: name })}
        sub={t('sub')}
        actions={<ContributeQuestion company={shareCompany} />}
      />
      {jobId ? <JobQuestionSet jobId={jobId} /> : null}
      <section className={styles.section} aria-labelledby="prep-company-list">
        <h2 className={styles.h2} id="prep-company-list">
          {t('heading')}
        </h2>
        {count ? (
          <p className={styles.muted} data-source-note="sourced">
            {t('count', { count: count.value })}
            {latest ? ` · ${t('latest', { period: latest })}` : ''}
            {asOf && !Number.isNaN(asOf.getTime()) ? ` · ${t('asOf', { date: format.dateTime(asOf, { dateStyle: 'medium' }) })}` : ''}
          </p>
        ) : null}
        <CategoryChips value={category} onChange={setCategory} groups={groups} />
        {list.isLoading ? (
          <p className={styles.muted} aria-busy="true">
            {t('loading')}
          </p>
        ) : list.isError ? (
          <p className={styles.error} role="alert">
            {prepErrorKey(list.error) === 'notFound' ? t('notFound') : t('loadError')}
          </p>
        ) : items.length === 0 ? (
          <p className={styles.muted}>{category ? t('emptyGroup') : t('empty', { company: name })}</p>
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
    </div>
  );
}
