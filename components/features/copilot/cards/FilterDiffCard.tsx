'use client';

// filter_diff — a proposed change to the saved search (F-ORION-04, F-FEED-09).
//
// Shows added / changed / removed per field against the search AS IT IS NOW
// (FilterDiff, WP-20) and how many jobs it would show. Nothing changes until
// "Apply changes": the proposal is applied server-side with the version the
// user saw (`baseVersion`); a 409 means the search changed meanwhile, so the
// card re-reads it and shows the fresh diff. After applying, "Looks better /
// Not quite" asks once (also on the next /jobs view via
// noteAssistantFilterChange); "Not quite" puts the previous filters back.
//
// The card only ever previews and applies against the saved search the
// proposal names: if that search is not in the user's list (deleted, stale
// list) it says so and offers no Apply — never another search's filters.
//
// Version honesty (D3): the proposal's job count describes the filters at
// `baseVersion`. When the search on screen is at any other version (changed on
// /jobs, in another tab, or by a conflict re-read) the card says the search
// changed and shows no number, unless the server's 409 reply carried a fresh
// count for the version now on screen. Apply always sends the version the user
// last saw described: `baseVersion` first, so a stale card gets the server's
// conflict reply (fresh diff + count); the re-read version only after that.

import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { applyPatchPreview, clearAssistantFilterChange, noteAssistantFilterChange, opsToPatch } from '../../../../hooks/feed';
import { isExpired, useProposal } from '../../../../hooks/copilot';
import { searchKeys, useActiveSearchProfile, useApplyFilters, type FilterSet, type SearchProfile, type SearchProfileList } from '../../../../hooks/search';
import { useBrand } from '../../../../lib/brand';
import { Btn } from '../../../v3/primitives';
import { FilterDiff } from '../../filters';
import { CardFrame } from './CardFrame';
import { parseFilterDiff } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

type After = 'ask' | 'better' | 'reverted' | 'revertFailed';

export function FilterDiffCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards');
  const data = parseFilterDiff(card.data);
  const brand = useBrand();
  const qc = useQueryClient();
  const { data: list } = useActiveSearchProfile();
  const { apply: applyFilters, isPending: reverting } = useApplyFilters();
  const proposal = useProposal(data?.proposalId ?? card.id, {
    initial: data?.status === 'applied' ? 'applied' : data?.status === 'dismissed' ? 'dismissed' : data && (data.status === 'expired' || isExpired(data.expiresAt)) ? 'expired' : 'pending',
  });
  const [before, setBefore] = useState<FilterSet | null>(null);
  const [after, setAfter] = useState<After | null>(null);
  // The version the user was last shown after a conflict, with the fresh count
  // the server sent for it (null: none came back). Null until a 409.
  const [ack, setAck] = useState<{ version: number; count: number | null } | null>(null);
  // The count the "Show jobs" link carries, frozen at the moment of applying.
  const [appliedCount, setAppliedCount] = useState<number | null>(null);

  if (!data) return null;
  const target = list?.profiles.find((p) => p.id === data.searchProfileId) ?? null;
  const preview = target ? applyPatchPreview(target.filters, opsToPatch(target.filters, data.ops)) : null;
  // The version whose count (if any) the card knows.
  const knownVersion = ack ? ack.version : data.baseVersion;
  const stale = !!target && target.version !== knownVersion;
  const count = stale ? null : ack ? ack.count : (data.countAfter ?? null);
  const showLabel = appliedCount !== null ? t('filterDiff.show', { count: appliedCount }) : t('filterDiff.showJobs');

  const readProfile = (): SearchProfile | null =>
    qc.getQueryData<SearchProfileList>(searchKeys.profiles())?.profiles.find((p) => p.id === data.searchProfileId) ?? null;

  const apply = async () => {
    if (!target) return;
    const shownFilters = target.filters;
    const shownCount = count;
    const outcome = await proposal.apply({ baseVersion: knownVersion });
    if (outcome.kind === 'applied') {
      setBefore(shownFilters);
      setAppliedCount(shownCount);
      setAfter('ask');
      noteAssistantFilterChange({ searchProfileId: target.id, before: shownFilters });
      void qc.invalidateQueries({ queryKey: searchKeys.profiles() });
      void qc.invalidateQueries({ queryKey: ['feed'] });
    } else if (outcome.kind === 'conflict') {
      const fresh = outcome.details?.countAfter;
      const freshCount = typeof fresh === 'number' && Number.isInteger(fresh) && fresh >= 0 ? fresh : null;
      try {
        await qc.refetchQueries({ queryKey: searchKeys.profiles() });
      } catch {
        // The list keeps what it had; the version check below still holds.
      }
      const now = readProfile() ?? target;
      setAck({ version: now.version, count: freshCount });
    }
  };

  const better = () => {
    clearAssistantFilterChange();
    setAfter('better');
  };

  const notQuite = async () => {
    if (!before) return;
    // Revert against the search as the server has it now: re-read it first
    // (the post-apply refetch may not have landed), and if the version still
    // moved underneath, retry once with the profile the 409 returned —
    // `replace` sets absolute filters, so that is safe.
    try {
      await qc.refetchQueries({ queryKey: searchKeys.profiles() });
    } catch {
      // Fall through with whatever is cached; the conflict retry covers it.
    }
    const fresh = readProfile() ?? target;
    if (!fresh) return;
    let res = await applyFilters({ profile: fresh, replace: before, defaultCountry: brand.defaultCountry });
    if (!res.ok && res.conflict) res = await applyFilters({ profile: res.conflict, replace: before, defaultCountry: brand.defaultCountry });
    clearAssistantFilterChange();
    setAfter(res.ok ? 'reverted' : 'revertFailed');
  };

  const { status } = proposal;
  return (
    <CardFrame card={card} title={t('filterDiff.title')}>
      {status === 'expired' ? <p className={styles.cardText}>{t('proposalExpired')}</p> : null}
      {status === 'dismissed' ? <p className={styles.cardText}>{t('filterDiff.dismissed')}</p> : null}
      {status === 'pending' || status === 'applying' || status === 'conflict' || status === 'failed' ? (
        target && preview ? (
          <>
            {status === 'conflict' || stale ? (
              <p className={styles.cardText} role="status" data-testid="filter-diff-conflict">
                {t('filterDiff.conflict')}
              </p>
            ) : null}
            <FilterDiff before={target.filters} after={preview} />
            {count !== null ? <p className={styles.cardText}>{t('filterDiff.count', { count })}</p> : null}
            {status === 'failed' ? (
              <p className={styles.alert} role="alert">
                {t('failed')}
              </p>
            ) : null}
            <div className={styles.cardActions}>
              <Btn variant="primary" disabled={status === 'applying'} onClick={() => void apply()}>
                {t('filterDiff.apply')}
              </Btn>
              <Btn variant="ghost" disabled={status === 'applying'} onClick={() => void proposal.dismiss()}>
                {t('notNow')}
              </Btn>
            </div>
          </>
        ) : list ? (
          <p className={styles.cardText} data-testid="filter-diff-no-target">
            {list.profiles.length === 0 ? t('filterDiff.noProfile') : t('filterDiff.missingProfile')}
          </p>
        ) : null
      ) : null}
      {status === 'applied' ? (
        <>
          <p className={styles.cardText} role="status">
            {t('filterDiff.applied')}
          </p>
          <div className={styles.cardActions}>
            <Link href="/jobs" className={styles.link} onClick={ctx.onNavigate}>
              {showLabel}
            </Link>
          </div>
          {after === 'ask' ? (
            <div className={styles.cardActions}>
              <Btn onClick={better}>{t('filterDiff.better')}</Btn>
              <Btn disabled={reverting} onClick={() => void notQuite()}>
                {t('filterDiff.notQuite')}
              </Btn>
            </div>
          ) : null}
          {after === 'better' ? <p className={styles.cardText}>{t('filterDiff.thanks')}</p> : null}
          {after === 'reverted' ? <p className={styles.cardText}>{t('filterDiff.reverted')}</p> : null}
          {after === 'revertFailed' ? (
            <p className={styles.alert} role="alert">
              {t('filterDiff.revertFailed')}
            </p>
          ) : null}
        </>
      ) : null}
    </CardFrame>
  );
}
