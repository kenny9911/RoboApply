'use client';

// GoalLine — "Looking for Product designer · Senior · Remote or London", under
// the title of /today, with `Change` (docs/agent-driven/REDESIGN.md §5.1).
//
// The line is the search Jobs uses now (the active saved search), and prints
// only values that search really holds: job titles (the search words, or the
// job functions, when there is no title), level, and where (work models and
// places). An empty search says it is open to any job; nothing is assumed.
//
// `Change` opens the same editor as "All filters" on /jobs and "Edit filters"
// in Settings (FiltersDrawer): one PATCH with `baseVersion`, nothing new to
// keep in step. It is imported on the first tap rather than with the page.
// An account with no saved search is sent to Settings → Your search, where
// one is made.

import Link from 'next/link';
import { Suspense, lazy, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';

import { agentKeys } from '../../../hooks/agent';
import { readableTaxonomyId, useTaxonomyLabelState } from '../../../hooks/search/useFilterQueries';
import type { SearchProfile } from '../../../hooks/search';
import type { Loadable } from '../../../hooks/today';
import { FailedNote } from './parts';
import { GOAL_GROUP_LIMIT, goalFacts, goalIsEmpty } from './todayModel';
import styles from './today.module.css';

const FiltersDrawer = lazy(() => import('../filters').then((m) => ({ default: m.FiltersDrawer })));

/** Where saved searches are made and edited when there is none to open here. */
export const SEARCH_SETTINGS_HREF = '/settings#search';

function listOf(locale: string, items: string[], type: 'disjunction' | 'unit'): string {
  if (items.length <= 1) return items[0] ?? '';
  try {
    return new Intl.ListFormat(locale, type === 'unit' ? { style: 'short', type: 'unit' } : { style: 'long', type: 'disjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

export interface GoalLineProps {
  search: Loadable<SearchProfile | null>;
}

export function GoalLine({ search }: GoalLineProps) {
  const t = useTranslations('today');
  const tAny = useTranslations();
  const locale = useLocale();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);

  const profile = search.status === 'ready' ? search.data : null;
  const facts = useMemo(() => goalFacts(profile?.filters), [profile]);
  // Job functions are named only when the search has no title of its own (one cached read, asked only then).
  const taxonomy = useTaxonomyLabelState({ enabled: facts.roleIds.length > 0 });

  if (search.status === 'loading' || search.status === 'off') {
    return (
      <p className={styles.goal} role="status" data-testid="today-goal">
        <span className={styles.srOnly}>{t('goal.loading')}</span>
        <span className={styles.skeletonLine} aria-hidden="true" />
      </p>
    );
  }
  if (search.status === 'error') {
    return <FailedNote message={t('goal.failed')} onRetry={search.retry} />;
  }
  if (!profile) {
    return (
      <p className={styles.goal} data-testid="today-goal">
        <span className={styles.goalText}>{t('goal.none')}</span>
        <Link href={SEARCH_SETTINGS_HREF} className={styles.link}>
          {t('goal.setUp')}
        </Link>
      </p>
    );
  }

  const option = (group: 'seniority' | 'workModels', value: string): string => {
    const key = `filters.options.${group}.${value}`;
    return tAny.has(key) ? tAny(key) : '';
  };
  /** One group of the line: its first values, and "and N more" when there are more. */
  const group = (values: string[], limit = GOAL_GROUP_LIMIT): string => {
    const named = values.filter(Boolean);
    if (named.length <= limit) return listOf(locale, named, 'disjunction');
    return t('goal.more', { list: listOf(locale, named.slice(0, limit), 'unit'), count: named.length - limit });
  };

  const roles = facts.roles.length
    ? facts.roles
    : // A job function whose name has not loaded yet is held back rather than shown as an id.
      facts.roleIds.map((id) => taxonomy.labels.get(id) ?? (taxonomy.ready ? readableTaxonomyId(id) : ''));
  const where = [...facts.workModels.map((v) => option('workModels', v)), ...facts.places];
  const what = [group(roles), group(facts.seniority.map((v) => option('seniority', v))), group(where, GOAL_GROUP_LIMIT + 1)].filter(Boolean).join(' · ');

  return (
    <>
      <p className={styles.goal} data-testid="today-goal">
        <span className={styles.goalText}>{goalIsEmpty(facts) || !what ? t('goal.any') : t('goal.line', { what })}</span>
        <button type="button" className={styles.textButton} onClick={() => setEditing(true)} aria-label={t('goal.changeLabel')} aria-haspopup="dialog">
          {t('goal.change')}
        </button>
      </p>
      {editing ? (
        <Suspense fallback={null}>
          <FiltersDrawer
            open
            onClose={() => setEditing(false)}
            profile={profile}
            // A changed search changes the picks. The Jobs reads refresh with the save itself; the suggestions are
            // asked for afresh here (reset, not refreshed in place: the lane keeps the rows it shows until then).
            onApplied={() => void qc.resetQueries({ queryKey: agentKeys.suggestions() })}
          />
        </Suspense>
      ) : null}
    </>
  );
}
