'use client';

// filter_diff — a proposed change to the saved search (F-ORION-04, F-FEED-09).
//
// Shows added / changed / removed per field against the search AS IT IS NOW
// (FilterDiff, WP-20) and how many jobs it shows now and would show. Nothing
// changes until "Apply changes": the proposal is applied server-side with the
// version the user saw (`baseVersion`). After applying, "Looks better / Not
// quite" asks once (also on the next /jobs view via noteAssistantFilterChange);
// "Not quite" puts the previous filters back.
//
// Counts (D3): `countBefore` / `countAfter` arrive as CountView
// `{ count: Sourced<number> | null, capped }`. The number is the index's count
// for the user's own search: unknown renders "—" (never 0), a capped count
// renders "N+", and the line under it is the SourceNote of that count (source
// and date). A count is exact, so it is not held back by the sample rule that
// applies to medians; the note names where it comes from without repeating N.
//
// Conflict: when the search changed since the suggestion, the server closes
// this proposal and answers 409 version_conflict with `details.card`: a fresh
// filter_diff card (a new proposal against the search as it is now, with its
// own counts). That card REPLACES this one in place. With no fresh card there
// is nothing left to change, and the card says so. No count is ever carried
// over from the old proposal.
//
// Closed: a proposal that was already used or dismissed somewhere else (another
// tab) answers 409 `proposal_closed`. The card then says only that the
// suggestion was already used or dismissed: it does not claim the search
// changed, or that nothing was applied, because it may have been applied there.
//
// The card only ever previews and applies against the saved search the
// proposal names: if that search is not in the user's list (deleted, stale
// list) it says so and offers no Apply — never another search's filters.
//
// Version honesty: the proposal's counts describe the filters at `baseVersion`.
// When the search on screen is at any other version the card says the search
// changed and shows no number; Apply then gets the server's conflict reply.

import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { applyPatchPreview, clearAssistantFilterChange, noteAssistantFilterChange, opsToPatch } from '../../../../hooks/feed';
import { isExpired, useProposal } from '../../../../hooks/copilot';
import { searchKeys, useActiveSearchProfile, useApplyFilters, type FilterSet, type SearchProfile, type SearchProfileList } from '../../../../hooks/search';
import { useBrand } from '../../../../lib/brand';
import type { CopilotCard } from '../../../../lib/api/contracts/copilot';
import { Btn } from '../../../v3/primitives';
import { SourceNote } from '../../common';
import { FilterDiff } from '../../filters';
import { CardFrame } from './CardFrame';
import { conflictCard, initialProposalStatus, parseFilterDiff, type CountData } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

type After = 'ask' | 'better' | 'reverted' | 'revertFailed';

/** "12", "500+" or "—" (unknown is never 0). Pure. */
export function countText(count: CountData): string {
  if (count.value === null) return '—';
  return count.capped ? `${count.value}+` : String(count.value);
}

/**
 * One count line with its source. The SourceNote names the source and date;
 * the count is its own N, so the sample size is not repeated (and the sample
 * rule for aggregates does not hide an exact count).
 */
function CountLine({ label, count, testId }: { label: string; count: CountData; testId: string }) {
  const note = count.sourced ? { value: count.sourced.value, source: count.sourced.source, asOf: count.sourced.asOf, ...(count.sourced.method ? { method: count.sourced.method } : {}) } : null;
  return (
    <div data-testid={testId} data-count={count.value === null ? 'unknown' : count.capped ? 'capped' : 'exact'}>
      <p className={styles.cardText}>{label}</p>
      <SourceNote sourced={note} className={styles.muted} />
    </div>
  );
}

export function FilterDiffCard({ card, ctx }: CardProps) {
  // A 409 carries a fresh card for the search as it is now: it takes this card's place.
  const [fresh, setFresh] = useState<CopilotCard | null>(null);
  if (fresh) return <FilterDiffBody key={fresh.id} card={fresh} ctx={ctx} replaced onReplace={setFresh} />;
  return <FilterDiffBody card={card} ctx={ctx} onReplace={setFresh} />;
}

function FilterDiffBody({ card, ctx, replaced = false, onReplace }: CardProps & { replaced?: boolean; onReplace: (card: CopilotCard) => void }) {
  const t = useTranslations('assistant.cards');
  const data = parseFilterDiff(card.data);
  const brand = useBrand();
  const qc = useQueryClient();
  const { data: list } = useActiveSearchProfile();
  const { apply: applyFilters, isPending: reverting } = useApplyFilters();
  const proposal = useProposal(data?.proposalId ?? card.id, {
    initial: data ? initialProposalStatus(data.status, isExpired(data.expiresAt)) : 'pending',
  });
  const [before, setBefore] = useState<FilterSet | null>(null);
  const [after, setAfter] = useState<After | null>(null);
  // The count the "Show jobs" link carries, frozen at the moment of applying.
  const [appliedCount, setAppliedCount] = useState<CountData | null>(null);
  // The server said this proposal was already used or dismissed (not a version conflict).
  const [closedElsewhere, setClosedElsewhere] = useState(false);

  if (!data) return null;
  const target = list?.profiles.find((p) => p.id === data.searchProfileId) ?? null;
  const preview = target ? applyPatchPreview(target.filters, opsToPatch(target.filters, data.ops)) : null;
  // The proposal's counts describe the search at `baseVersion` only.
  const stale = !!target && target.version !== data.baseVersion;
  const showLabel =
    appliedCount && appliedCount.value !== null
      ? appliedCount.capped
        ? t('filterDiff.showCapped', { count: appliedCount.value })
        : t('filterDiff.show', { count: appliedCount.value })
      : t('filterDiff.showJobs');

  const readProfile = (): SearchProfile | null =>
    qc.getQueryData<SearchProfileList>(searchKeys.profiles())?.profiles.find((p) => p.id === data.searchProfileId) ?? null;

  const apply = async () => {
    if (!target) return;
    const shownFilters = target.filters;
    const outcome = await proposal.apply({ baseVersion: data.baseVersion });
    if (outcome.kind === 'applied') {
      setBefore(shownFilters);
      setAppliedCount(stale ? null : data.countAfter);
      setAfter('ask');
      noteAssistantFilterChange({ searchProfileId: target.id, before: shownFilters });
      void qc.invalidateQueries({ queryKey: searchKeys.profiles() });
      void qc.invalidateQueries({ queryKey: ['feed'] });
    } else if (outcome.kind === 'conflict') {
      // The server closed this proposal. Re-read the search, then show the
      // fresh card it sent (if any) in this card's place.
      try {
        await qc.refetchQueries({ queryKey: searchKeys.profiles() });
      } catch {
        // The list keeps what it had; the fresh card names its own version.
      }
      const next = conflictCard(outcome.details);
      if (next) onReplace(next as CopilotCard);
    } else if (outcome.kind === 'closed') {
      setClosedElsewhere(true);
      // It may have been applied in another tab: show the search as it is now.
      void qc.invalidateQueries({ queryKey: searchKeys.profiles() });
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
    const current = readProfile() ?? target;
    if (!current) return;
    let res = await applyFilters({ profile: current, replace: before, defaultCountry: brand.defaultCountry });
    if (!res.ok && res.conflict) res = await applyFilters({ profile: res.conflict, replace: before, defaultCountry: brand.defaultCountry });
    clearAssistantFilterChange();
    setAfter(res.ok ? 'reverted' : 'revertFailed');
  };

  const { status } = proposal;
  const open = status === 'pending' || status === 'applying' || status === 'failed';
  return (
    <CardFrame card={card} title={t('filterDiff.title')}>
      {status === 'expired' ? <p className={styles.cardText}>{t('proposalExpired')}</p> : null}
      {status === 'dismissed' ? <p className={styles.cardText}>{t('filterDiff.dismissed')}</p> : null}
      {status === 'conflict' ? (
        // Closed by the server. Either the search changed and no fresh suggestion took this card's
        // place, or the suggestion was already used or dismissed elsewhere (which may have applied it).
        <p className={styles.cardText} role="status" data-testid="filter-diff-closed" data-reason={closedElsewhere ? 'closed' : 'conflict'}>
          {closedElsewhere ? t('proposalClosed') : t('filterDiff.conflictClosed')}
        </p>
      ) : null}
      {open ? (
        target && preview ? (
          <>
            {replaced || stale ? (
              <p className={styles.cardText} role="status" data-testid="filter-diff-conflict">
                {t('filterDiff.conflict')}
              </p>
            ) : null}
            <FilterDiff before={target.filters} after={preview} />
            {stale ? null : (
              <>
                <CountLine testId="filter-diff-count-before" count={data.countBefore} label={t('filterDiff.countNow', { count: countText(data.countBefore) })} />
                <CountLine testId="filter-diff-count-after" count={data.countAfter} label={t('filterDiff.countAfter', { count: countText(data.countAfter) })} />
              </>
            )}
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
