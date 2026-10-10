'use client';

// components/features/feed/Explore.tsx — /jobs/explore (PRODUCT F-FEED-13,
// F-FEED-17; replaces the /job-search workspace).
//
//   • A sentence → filters: `POST /feed/nl-query` turns "remote data jobs in
//     Berlin paying over €70k" into a filter change, shown field by field
//     (FilterDiff) and saved to the active search only when the user confirms.
//     The explanation is AI output: GoApply labels it (AiGeneratedBadge).
//   • Kinds of work: the function categories with live counts from our index
//     (`GET /feed/explore`, public canonical rows of this market). Picking one
//     lists its jobs (`?category=<taxonomyId>`): a browse of that category
//     (no saved search, so the list matches the tile's count), never saved.

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Btn, toast } from '../../v3/primitives';
import { SourceNote } from '../common';
import { FilterDiff } from '../filters';
import { AiGeneratedBadge } from '../market';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { useFlag } from '../../../lib/flags';
import { apiErrorCode } from '../../../lib/api/contracts/wire';
import type { NlQueryResponse } from '../../../lib/api/contracts/feed';
import { useExplore, useNlQuery } from '../../../hooks/feed/useExplore';
import { useFeed } from '../../../hooks/feed/useFeed';
import { applyPatchPreview, isNoopPatch, opsToPatch } from '../../../hooks/feed/filterOps';
import { FeedList } from './FeedList';
import { FeedTabs, feedTabPanelProps } from './FeedTabs';
import { useProposalApply } from './useProposalApply';
import styles from './feed.module.css';

const UNAVAILABLE = new Set(['ai_unavailable', 'ai_off', 'feature_disabled', 'content_blocked']);

function CategoryJobs({ categoryId, label, market }: { categoryId: string; label: string; market: 'intl' | 'cn' }) {
  const t = useTranslations('jobs.explore');
  // Browse, not search: the tile's count is the whole index for this kind of
  // work, so the list is asked for the same set — the category alone, without
  // the saved search (no searchProfileId). Never saved anywhere.
  const feed = useFeed({
    searchProfileId: null,
    version: null,
    sort: 'recommended',
    fitTier: 'all',
    overrides: { taxonomyIds: [categoryId] },
  });
  return (
    <section className={styles.workspace} aria-label={t('categoryResults', { category: label })}>
      <h2 className={styles.promptTitle}>{t('categoryResults', { category: label })}</h2>
      <FeedList feed={feed} market={market} label={t('categoryResults', { category: label })} empty={<p className={styles.notice}>{t('categoryEmpty')}</p>} />
    </section>
  );
}

export function Explore() {
  const t = useTranslations('jobs.explore');
  const tw = useTranslations('jobs.workspace');
  const brand = useBrand();
  const feedOn = useFlag('jobs.feed');
  const router = useRouter();
  const params = useSearchParams();
  const categoryId = params?.get('category') ?? null;
  const explore = useExplore(feedOn);
  const nl = useNlQuery();
  const proposal = useProposalApply();
  const [text, setText] = useState('');
  const [result, setResult] = useState<NlQueryResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const categories = explore.data?.categories ?? [];
  const selected = categoryId ? categories.find((c) => c.taxonomyId === categoryId) ?? null : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const q = text.trim();
    if (q.length < 2) return;
    setMessage(null);
    setResult(null);
    try {
      const res = await nl.mutateAsync(proposal.profile ? { text: q, searchProfileId: proposal.profile.id } : { text: q });
      const ops = res.diff && Array.isArray(res.diff.ops) ? res.diff.ops : [];
      const base = proposal.target(res.diff?.searchProfileId)?.filters ?? {};
      if (ops.length === 0 || isNoopPatch(base, opsToPatch(base, ops))) setMessage(t('nlNoChange'));
      else setResult(res);
    } catch (err) {
      const code = apiErrorCode(err);
      setMessage(code && UNAVAILABLE.has(code) ? t('nlUnavailable') : t('nlFailed'));
    }
  };

  const target = result ? proposal.target(result.diff.searchProfileId) : null;
  const before = target?.filters ?? {};
  const patch = result ? opsToPatch(before, result.diff.ops) : {};
  const after = applyPatchPreview(before, patch);

  const confirm = async () => {
    if (!result) return;
    const res = await proposal.save(patch, result.diff.searchProfileId);
    if (res === 'saved') {
      toast({ message: t('nlSaved'), tone: 'ok' });
      router.push('/jobs');
    } else {
      toast({ message: t('nlFailed'), tone: 'warn' });
    }
  };

  return (
    <div className={styles.workspace}>
      <header className={styles.head}>
        <h1 className={styles.title}>{t('title')}</h1>
        <p className={styles.intro}>{t('intro')}</p>
      </header>

      <FeedTabs active={feedOn ? 'explore' : 'added'} feedOn={feedOn} />

      <div {...feedTabPanelProps(feedOn ? 'explore' : 'added')} className={styles.workspace}>
        {!feedOn ? (
          <div className={styles.prompt}>
            <p className={styles.help}>{tw('feedOff')}</p>
            <div className={styles.row}>
              <Link href="/jobs/added" className={styles.link}>
                {tw('addJob')}
              </Link>
            </div>
          </div>
        ) : (
          <>
            <form className={styles.nl} onSubmit={(e) => void submit(e)}>
              <label className={styles.nlField}>
                <span className={styles.label}>{t('nlLabel')}</span>
                <input
                  className={styles.input}
                  type="search"
                  value={text}
                  maxLength={500}
                  placeholder={t('nlPlaceholder')}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
              <Btn type="submit" variant="primary" className={styles.actionBtn} disabled={nl.isPending || text.trim().length < 2}>
                {nl.isPending ? t('nlWorking') : t('nlSubmit')}
              </Btn>
            </form>
            {message ? (
              <p className={styles.notice} role="status">
                {message}
              </p>
            ) : null}
            {result ? (
              <section className={styles.prompt} aria-label={t('nlProposal')} data-testid="nl-proposal">
                <h2 className={styles.promptTitle}>{t('nlProposal')}</h2>
                {result.explanation ? (
                  <p className={styles.help}>
                    {result.explanation} {brand.market === 'cn' ? <AiGeneratedBadge kind="text" /> : null}
                  </p>
                ) : null}
                <FilterDiff before={before} after={after} filters={after} />
                <div className={styles.row}>
                  <Btn variant="primary" className={styles.actionBtn} onClick={() => void confirm()} disabled={proposal.isPending || !target}>
                    {t('nlConfirm')}
                  </Btn>
                  <Btn className={styles.actionBtn} onClick={() => setResult(null)}>
                    {t('nlCancel')}
                  </Btn>
                </div>
              </section>
            ) : null}

            {selected ? (
              <>
                <div>
                  <Link href="/jobs/explore" className={styles.link}>
                    {t('back')}
                  </Link>
                </div>
                <CategoryJobs categoryId={selected.taxonomyId} label={selected.label} market={brand.market} />
              </>
            ) : (
              <section aria-label={t('categoriesLabel')} className={styles.workspace}>
                <h2 className={styles.promptTitle}>{t('categoriesLabel')}</h2>
                {explore.isPending ? (
                  <ul className={styles.categories} aria-busy="true">
                    {Array.from({ length: 8 }, (_, i) => (
                      <li key={i} className={styles.skeleton} aria-hidden="true" />
                    ))}
                  </ul>
                ) : explore.isError ? (
                  <div className={styles.row}>
                    <p className={styles.notice} role="alert">
                      {t('loadFailed')}
                    </p>
                    <Btn className={styles.actionBtn} onClick={() => void explore.refetch()}>
                      {tw('retry')}
                    </Btn>
                  </div>
                ) : categories.length === 0 ? (
                  <p className={styles.notice}>{t('noCategories')}</p>
                ) : (
                  <>
                    <ul className={styles.categories}>
                      {categories.map((c) => (
                        <li key={c.taxonomyId}>
                          <button
                            type="button"
                            className={styles.category}
                            aria-pressed={c.taxonomyId === categoryId}
                            onClick={() => router.replace(`/jobs/explore?category=${encodeURIComponent(c.taxonomyId)}`, { scroll: false })}
                          >
                            <span className={styles.categoryName}>{c.label}</span>
                            <span className={styles.categoryCount}>
                              {Number.isFinite(c.count) && c.count > 0 ? t('count', { count: c.count }) : t('categoryEmpty')}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    <SourceNote sourced={{ value: true, source: 'index', asOf: explore.data?.asOf ?? '' }} className={styles.help} />
                  </>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
